# Design draft: inbox, outbox and senders

Status: draft, for discussion. Nothing here is implemented yet.

This reshapes the plugin around the primitives described in Anthropic's
[Building always-on agents](https://claude.com/resources/articles/building-always-on-agents):
an **event inbox**, **timers** that feed it, a **worker** that starts runs, **memory**, and an **outbox** with a
**dispatcher**. Most of the pieces exist today but are wired point to point. This draft puts a queue on each side
of the run.

```
                       ┌──────────── inbox (table, one, global) ───────────┐
 channel pollers ──▶   │ seq 812  channel:datadog  monitor 123 alerting    │
 scheduler (timers) ─▶ │ seq 813  timer → morning-brief                    │
 manual run / TUI ──▶  │ seq 814  manual → dep-audit                       │
                       └───────────────────────────────────────────────────┘
                                  │  each automation takes what matches
                                  │  its selector
                                  ▼
                          worker (the leader) ── starts runs ──▶ opencode sessions
                                                                    │
                                              automation_notify     │  automatic notices
                                                                    ▼
                       ┌──────────── outbox (table, one, global) ──────────┐
                       │ msg 41  alert-triage  "Checkout 5xx: bad deploy"  │
                       │ msg 42  system        "dep-audit timed out"       │
                       └───────────────────────────────────────────────────┘
                                  │
                                  ▼
                          dispatcher ── routes, paces, retries ──▶ senders
                                                                    ├─ native (desktop)
                                                                    ├─ pushover (phone)
                                                                    └─ webhook / ntfy / … (later)
```

## Why change

Today:

- A poll **fans events out at poll time** into one queue per automation (`channels.json` → `queues[jobID].pending`).
  The channel has to know who listens, every subscriber holds its own copy, and the first-poll rules
  (`started`) and the queue caps are per automation. An automation that isn't attached to a channel can't see its
  events at all, so a morning brief can't say "and overnight, Datadog fired 3 times".
- `automation_notify` **sends synchronously** from inside the tool call. A failed Pushover call is lost ("It was
  logged; don't retry"). There is no pacing across runs, no record of what the user was told beyond a count in
  `history.jsonl`, and destinations are hard-coded (`native`, `pushover`) with no routing.
- Run starts can happen in **any process** (the ticker in the leader, `automation_run` and `channel_poll` in any
  instance), which is why `index.ts` carries `pendingStarts`, "another process already took these events", and the
  take-then-requeue dance in `startChunk`.

## The model

### Inbox

One global, durable log of events, as a table in `state.db` (see [Storage](#storage-bunsqlite)). Every source writes to it, and nothing else starts a run.

```ts
interface InboxEvent {
  seq: number                 // INTEGER PRIMARY KEY AUTOINCREMENT
  at: number                  // when it was written
  source: "channel" | "timer" | "manual"
  channel?: string            // source "channel"
  id: string                  // channel: the rendered event.id; timer/manual: a fresh id
  key?: string                // channel: the rendered event.sessionKey (was ChannelEvent.sessionKey)
  to?: string                 // timer/manual: the one automation it is for
  title: string
  body?: string
  url?: string
}
```

- **Sources (handlers).**
  - Channel polls: `extract` and `ingest` stay as they are. `ingest`'s fresh events are appended to the inbox instead
    of being fanned out to queues. Deduplication becomes `UNIQUE (channel, id)` plus `INSERT OR IGNORE`, which
    replaces `SourceState.seen` and `ingest`'s bookkeeping.
  - The scheduler: when a schedule is due, it appends `{ source: "timer", to: jobID }` and advances `nextRunAt` in the
    same pass, as today. A timer never starts a run itself.
  - Manual runs (`automation_run`, `r` in the TUI): append `{ source: "manual", to: jobID }`. This replaces
    `runRequestedAt`.
- **Retention.** The leader deletes, on a tick, events older than `inbox.retention` (default 7 days) whose item was
  absent from the channel's latest poll. Each poll updates `seen_at` on the items it returns, so an alert that stays
  open for two weeks is never deleted and delivered again.
- **The inbox is the source of truth.** Events are never removed when a run takes them. What each automation has
  taken is recorded beside them (below), so a crash between "took the events" and "the run started" is retried from
  the table, not lost.

### Consumers: each automation decides what it wants

An automation no longer receives a private copy of events. It declares a **selector** over the shared inbox.

```jsonc
{
  "id": "alert-triage",
  "listen": {
    "channels": ["datadog"],        // which channels' events it takes
    "match": { "title": "*P1*" },   // optional: a glob per field (title, body, key, url)
    "from": "now"                   // what it takes when it is created: "now" (default), or "24h", "7d"
  },
  "prompt": "…"
}
```

Per automation, the plugin keeps a `since` seq (set from `from` at creation) and one row per event it has taken, in
`deliveries (job, seq, key, run, status, attempts)`. **Waiting** for an automation means: inbox rows with
`seq > since`, matching its selector, with no delivery row for it. That is one query
(`channel IN (…) AND title GLOB … AND NOT EXISTS (…)`). It needs no cursor bookkeeping, and it handles events taken
out of order because of keys.

How events reach a run:

- **As they arrive** (no schedule): on each tick, the worker queries what is waiting for it, groups it by key (sticky with keys) or into one batch, and starts one run per group, up to `maxEvents`.
  The delivery rows are inserted in the same transaction (`BEGIN IMMEDIATE`) that picks the events. A run that
  fails to start marks its rows `failed` and bumps `attempts`, and they are offered again up to
  `MAX_START_ATTEMPTS`.
- **As a digest** (a schedule and a `listen`): the timer event wakes it, and the run gets every matching event since
  the last run, up to `maxEvents`.
- **Scheduled with no `listen`**: the timer event wakes it, and the prompt is run as today. A morning brief that
  should mention overnight alerts declares `listen: { channels: ["datadog"] }` and becomes a digest.

The selector is the only place where an automation says what it wants. The agent gets no tool to browse the inbox:
the plugin decides from the declaration and hands the matching events in the prompt. That keeps the untrusted text
the agent sees to the events meant for it, and keeps the per-run context small.

What goes away: `QueueState.pending`, `started`, `MAX_QUEUE` per automation, `enqueue`, `requeue`, the first-poll
special case, `forget` on queues, and `seen`. A paused automation simply takes nothing, so its events wait in the
table, within retention. Detaching a channel just changes the selector.

**First attach.** Today a newly attached automation receives everything a channel currently returns. With a shared
inbox, the equivalent is `from`. `"now"` starts clean. `"24h"` replays the last day's events from the log. The current
behaviour ("whatever is alerting right now") is the rows whose `seen_at` is the channel's latest poll, which `seen_at`
makes cheap: see open question 2.

### Worker: one, the leader

Following "an inbox should only have one active worker at a time", **only the leader starts runs**. The leader is the
process holding the existing lease. Other processes only write to the inbox, and nudge the leader by touching
`pollRequestedAt` or an `inbox.wake` file. When the caller is the leader, it processes the inbox at once.

That removes the cross-process start races: `pendingStarts` becomes an in-process set only, and there is no more
"another process already took these events" path. A run's tools and hooks still work from any instance, through the
shared `Running` registry, which is unchanged.

Batching follows the article: several events for the same automation (and key) arriving between two ticks go into
one run. Events that arrive while a key's run is in progress wait for the next tick, as today (queue, don't
interrupt).

### Outbox

`automation_notify` stops sending. The agent only says what to tell the user and how urgent it is. It knows nothing
about sinks. The tool checks what holds for any sink (title and message present, short lines, an overall length cap,
the limit per run), so the agent still gets immediate feedback. Then it **appends to the outbox** and returns
`Queued.`

```ts
interface OutboxMessage {
  id: string
  at: number
  from: { job: string; run: string } | { system: "run-failed" | "channel-failing" }
  title: string
  body: string
  priority: "low" | "normal" | "high"
  url?: string
  urlTitle?: string
}
// One row per (message, sender) in `sends`, updated in place:
interface Send { message: string; sender: string; status: "pending" | "held" | "sent" | "failed" | "dropped"; attempts: number; next_at?: number; error?: string }
```

Everything the plugin tells the user goes through it: the agent's messages, the automatic notice when a run fails or
times out (`compose`), and "channel X can't poll" (`index.ts` `pollChannels`).

**Dispatcher.** It runs in the leader, on every tick, and right away when the leader writes a message. For each
pending (message, sender) pair, it:

1. **Routes.** It checks whether the sender takes this message: the automation's `outbox.to` (in config) and the
   sender's own rules (`minPriority`, `automations`, `quiet`). Routing is configuration only. The agent never picks a
   sender.
2. **Paces.** `maxPerHour` per sender. Low-priority messages during quiet hours are held and folded into one digest
   message when quiet hours end. This is where "start quiet and earn attention" gets a knob.
3. **Delivers** with the sender's adapter (today's `send` split into one function per sender type). The adapter fits
   the message to its sink: Pushover splits it into numbered parts (at most `MAX_PARTS`, then truncates), native
   clips it, and a webhook sends it whole. Each adapter maps `priority` to its sink's urgency.
4. **Records** a status. A failure is retried with backoff (1m, 5m, 30m), then marked `failed` and logged. The run
   is never told: delivery is the dispatcher's problem, not the agent's.

**Senders** replace the `native` and `pushover` keys:

```jsonc
"outbox": {
  "on": ["failed", "timeout"],      // automatic notices
  "maxPerRun": 5,
  "senders": [
    { "id": "desktop", "type": "native", "sound": "Glass" },
    { "id": "phone", "type": "pushover", "token": "{env:PUSHOVER_TOKEN}", "user": "{env:PUSHOVER_USER}",
      "minPriority": "normal", "maxPerHour": 10, "quiet": { "from": "22:00", "to": "07:30", "tz": "Europe/Paris" } },
    { "id": "team", "type": "webhook", "url": "{env:TEAM_HOOK}", "automations": ["alert-triage"] }
  ]
}
```

- `{env:NAME}` works as it does in channels, so tokens leave the config file too.
- Adapters: `native` and `pushover` (existing code, unchanged formatting: `format`, `split`, `pushoverParts`), then
  `webhook` (a POST of the JSON message). `ntfy`, Slack and email are easy additions later.
- `canNotify(job)` becomes "there is at least one sender this job could reach".

**The outbox is also the record of what the user was told**: the article's "past messages". It is for the TUI and
for the dispatcher (pacing, digests), not a tool for the agent. What a run needs to avoid repeating itself goes in
its memory note, as today. If that turns out not to be enough, the plugin can add the automation's last few sent
titles to the run's context, with no new tool.

### Memory: simple

This stays close to today. There is one note per automation (per key, for sticky with keys), replaced by each run with
`automation_memory_update` (4000 characters at most), plus `warmUntil` for the warm and cold continuation logic.

Changes:

- **Its own table.** `memory (job, key, note, warm_until, updated_at)`. Memory moves out of the job record and out of
  `queues[].sessions`.
- **Optional: offered to every automation**, not only sticky ones. A `new` session run that ends with a note gives the
  next run a starting point. The run guide shows the previous note at the top. The warm and cold compaction stays
  sticky only. See open question 3.
- Not now: notes, progress files, an index and "dreaming". The prompt already plays the "user instructions" file,
  and the outbox keeps the record of what was sent.

## What the agent sees

| Tool | Change |
|---|---|
| `automation_notify` | Writes to the outbox and returns `Queued.` Input: title, message, priority, url, url_title. No sender, no sink-specific limits |
| `automation_memory_update` | Unchanged. Possibly offered to every run (open question 3) |
| `automation_create/update` | `listen` replaces `channels`. Routing (`outbox.to`) is config only |
| `channel_*` | Unchanged for the agent. `channel_poll` reports events written to the inbox and the runs it woke |

There are no new agent tools. `guides.ts`: `RUN_GUIDE` stops mentioning phones and Pushover (the user is notified),
and `CHANNEL_GUIDE` step 6 talks about `listen`.

## TUI

- `i`: the inbox. The latest events, a source filter, and per automation how many matching events are waiting. That count replaces the "events waiting" column in the channels view.
- `o`: the outbox. The latest messages with per-sender status (sent, failed, held for quiet hours), and `r` to retry a
  failed one.
- The TUI opens `state.db` read-mostly and refreshes when `PRAGMA data_version` changes (checked every 500 ms), which
  replaces the `fs.watch` on the data directory. `tui.js` is recompiled as usual. It imports `store.ts` at runtime,
  so `bun:sqlite` works there too (OpenTUI runs on Bun).

## Storage: `bun:sqlite`

All state goes in one database, `dataDir/state.db`, through `bun:sqlite`. It is built into Bun, so it adds no
dependency and needs no build step, under `node_modules` too. It replaces `jobs.json`, `channels.json` and
`history.jsonl`, the `proper-lockfile` dependency, and `writeAtomic`.

```sql
jobs       (id PK, def JSON, source, enabled, paused, done, since, next_run_at, last_run_at, last_status, session_id, created_at)
channels   (id PK, def JSON, source)                       -- defs created from chat; config ones are mirrored as summaries
sources    (channel PK, last_poll_at, last_ok_at, last_error, failures, poll_requested_at)
inbox      (seq PK AUTOINCREMENT, at, source, channel, id, key, to_job, title, body, url, seen_at, UNIQUE (channel, id))
deliveries (job, seq REFERENCES inbox ON DELETE CASCADE, key, run, status, attempts, PRIMARY KEY (job, seq))
sessions   (job, key, session_id, used_at, PRIMARY KEY (job, key))   -- sticky session per key
memory     (job, key, note, warm_until, updated_at, PRIMARY KEY (job, key))
outbox     (id PK, at, job, run, system, title, body, priority, url, url_title)
sends      (message REFERENCES outbox ON DELETE CASCADE, sender, status, attempts, next_at, error, PRIMARY KEY (message, sender))
runs       (run PK, job, session_id, started_at, ended_at, status, error, notifications)
lease      (name PK, holder, until)                          -- the leader lease
```

- **Settings.** `journal_mode=WAL` lets readers (the TUI, other instances) read while one process writes.
  `busy_timeout` is 2 s on the server and 250 ms in the TUI. `foreign_keys=ON`. Every write that reads and then
  writes runs in `BEGIN IMMEDIATE`, which replaces each "mutate under the file lock" in `store.ts`. There is no more
  lock order to respect.
- **Short transactions.** `bun:sqlite` is synchronous, so a writer waiting on `busy_timeout` blocks its event loop.
  Nothing slow (HTTP, a session call) happens inside a transaction. Polls fetch first, then write. Run starts pick
  and record events, then call opencode.
- **Leader lease.** A row in `lease`: `UPDATE … SET holder = ?, until = ? WHERE name = 'leader' AND (holder = ? OR until < now)`,
  renewed every tick. It replaces the `leader` lock file.
- **Schema version.** `PRAGMA user_version`. The plugin creates the tables when it is 0, and refuses to start on a
  version newer than it knows.
- **Retention.** On a tick, the leader deletes old inbox rows (above), sent or dropped outbox messages older than 30
  days, and runs beyond the latest 1000 per job.
- **Inspecting.** `sqlite3 state.db` replaces reading JSON by hand. The README gets a few example queries.
- **Tests.** Each test opens a fresh in-memory database (`new Database(":memory:")`), which is faster and simpler
  than temp directories.

## Compatibility: a clean break

There is no migration. Existing config and state are not carried over: automations and channels are recreated
on the new shapes.

- The old config keys (`notify`, `on`) are not accepted as aliases. A config that still uses them fails to load,
  with an error naming the new key (`outbox.senders`, `listen`), so nothing is silently ignored.
- Old state files (`jobs.json`, `channels.json`, `history.jsonl`) are not read. On first start, the plugin moves
  them aside to `legacy-<date>/` and starts with an empty `state.db`. It doesn't delete
  them, so a downgrade is still possible by hand.
- Released as `feat!`, with a `BREAKING CHANGE:` footer that says to recreate automations and channels.

That drops a whole category of code: alias handling, a migration pass, deprecation warnings, and tests for each of
them.

## Rollout, as separate PRs

1. **Storage.** `store.ts` on `bun:sqlite`, with the schema above, the lease, and the TUI's `data_version` refresh.
   For now it keeps today's behaviour on the new tables (jobs, channels, runs), and drops `proper-lockfile`.
2. **Outbox + senders.** `notify.ts` splits into the outbox, the dispatcher and one adapter per sender. The `notify`
   config is replaced by `outbox`. A sink-agnostic `automation_notify`.
3. **Inbox + deliveries.** Channels and timers write to `inbox`, manual runs become inbox events, `listen` replaces
   `on`, and only the leader starts runs. This is where `index.ts` gets simpler: the per-automation queues, `requeue`,
   `seen`, `pendingStarts` across processes, and the first-poll code go.
4. **Memory table** (+ optionally memory for every automation), and the guides.
5. **TUI** inbox and outbox views.

Each PR keeps `bun test` and `bun run typecheck` green. Since there is no migration, each one may change the schema
freely until the release.

## Open questions

1. ~~Storage~~: decided, `bun:sqlite`.
2. **First attach.** Should `from` default to `"now"`, or to "the channel's last poll" (closest to today: you see
   what is alerting right now)? With `seen_at`, the latter is a query, not extra state.
3. **Memory for every automation, or sticky only?** Offering a note to `new` runs makes "report only what changed"
   possible without sticky sessions. It is also one more thing the agent is asked to do every run.
4. **Should manual runs from a non-leader wait for the leader's tick** (≤ `tickSeconds`), or may any process start a
   run when the leader is idle? This draft says wait, for a single worker. The leader could also check for new
   `manual` rows every second (a cheap query on `seq`), so that the wait is short.
5. **Routing granularity.** Is "sender rules + automation `outbox.to`" too much? A smaller start is sender
   `minPriority` only.
6. **Agent-set follow-ups.** The article's other timer kind: `automation_followup({ in: "2h", note })` would append a
   timer event to the same automation (and key) later, for example "check whether the rollback fixed it". It fits
   the inbox naturally. Should it go in this update or the next?
