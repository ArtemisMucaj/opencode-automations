# Design draft: inbox, outbox and senders

Status: draft, for discussion. Nothing here is implemented yet.

This reshapes the plugin around the primitives described in Anthropic's
[Building always-on agents](https://claude.com/resources/articles/building-always-on-agents):
an **event inbox**, **timers** that feed it, a **worker** that starts runs, **memory**, and an **outbox** with a
**dispatcher**. Most of the pieces exist today but are wired point to point. This draft puts a queue on each side
of the run.

```
                       ┌──────────── inbox.jsonl (one, global) ────────────┐
 channel pollers ──▶   │ seq 812  channel:datadog  monitor 123 alerting    │
 scheduler (timers) ─▶ │ seq 813  timer → morning-brief                    │
 manual run / TUI ──▶  │ seq 814  manual → dep-audit                       │
                       └───────────────────────────────────────────────────┘
                                  │  each automation reads it with its own
                                  │  selector and cursor
                                  ▼
                          worker (the leader) ── starts runs ──▶ opencode sessions
                                                                    │
                                              automation_notify     │  automatic notices
                                                                    ▼
                       ┌──────────── outbox.jsonl (one, global) ───────────┐
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

One global, durable, append-only log of events. Every source writes to it, and nothing else starts a run.

```ts
interface InboxEvent {
  seq: number                 // assigned under the inbox lock, strictly increasing
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
    of being fanned out to queues. Deduplication stays per channel, in `SourceState.seen`.
  - The scheduler: when a schedule is due, it appends `{ source: "timer", to: jobID }` and advances `nextRunAt` in the
    same pass, as today. A timer never starts a run itself.
  - Manual runs (`automation_run`, `r` in the TUI): append `{ source: "manual", to: jobID }`. This replaces
    `runRequestedAt`.
- **Storage.** `inbox.jsonl`, one event per line, appended under a lock (`store.ts` already has the lock and
  `linesFromEnd`). The leader trims it on a tick: events older than `inbox.retention` (default 7 days) and below every
  automation's cursor are dropped by rewriting the file.
- **The inbox is the source of truth.** Events are never removed when a run takes them. Each automation moves its own
  cursor, so a crash between "took the events" and "the run started" is retried from the log, not lost.

### Consumers: each automation decides what it wants

An automation no longer receives a private copy of events. It holds a **selector** and a **cursor** over the shared
inbox.

```jsonc
{
  "id": "alert-triage",
  "listen": {
    "channels": ["datadog"],        // which channels' events it takes (was `on.channels`)
    "match": { "title": "*P1*" },   // optional: a glob per field (title, body, key, url)
    "from": "now"                   // where its cursor starts when it is created: "now" (default), or "24h", "7d"
  },
  "prompt": "…"
}
```

Per automation, the plugin keeps (in `consumers.json`):

```ts
interface Consumer {
  cursor: number                 // every event with seq <= cursor is handled or not wanted
  taken: number[]                // seqs above the cursor already handed to a run (out of order, because of keys)
  sessions: Record<string, { id: string; at: number }>   // sticky session per key, as today
}
```

How events reach a run:

- **As they arrive** (no schedule): on each tick, the worker reads the inbox from the cursor, keeps what matches the
  selector, groups it by key (sticky with keys) or into one batch, and starts one run per group, up to `maxEvents`.
  The seqs it hands over go into `taken` in the same locked write. The cursor advances while the next seq is taken or
  doesn't match.
- **As a digest** (a schedule and a `listen`): the timer event wakes it, and the run gets every matching event since
  the cursor, up to `maxEvents`.
- **Scheduled with no `listen`**: the timer event wakes it, and the prompt is run as today. A morning brief that
  should mention overnight alerts declares `listen: { channels: ["datadog"] }` and becomes a digest.

The selector is the only place where an automation says what it wants. The agent gets no tool to browse the inbox:
the plugin decides from the declaration and hands the matching events in the prompt. That keeps the untrusted text
the agent sees to the events meant for it, and keeps the per-run context small.

What goes away: `QueueState.pending`, `started`, `MAX_QUEUE` per automation, `enqueue`, `requeue`, the first-poll
special case and `forget` on queues. A paused automation simply doesn't move its cursor, so its events wait in the
log, within retention. Detaching a channel just changes the selector.

**First attach.** Today a newly attached automation receives everything a channel currently returns. With a shared
log, the equivalent is `from`. `"now"` starts clean. `"24h"` replays the last day's events from the log. The current
behaviour ("whatever is alerting right now") is closer to replaying the channel's last poll: see open question 2.

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
// Status records are appended to outbox.jsonl, latest wins (like history.jsonl):
interface OutboxStatus { id: string; sender: string; status: "sent" | "failed" | "dropped"; at: number; error?: string; attempts: number }
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
  "on": ["failed", "timeout"],      // automatic notices (was notify.on)
  "maxPerRun": 5,                   // was notify.maxPerRun
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

- **Its own file.** `memory.json`, keyed by `jobID` or `jobID:key`. Memory moves out of `jobs.json` and out of
  `channels.json` → `queues[].sessions`, so the three concerns (definitions, delivery state, memory) stop sharing
  locks.
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
| `automation_create/update` | `listen` replaces `channels` (still accepted). Routing (`outbox.to`) is config only |
| `channel_*` | Unchanged for the agent. `channel_poll` reports events written to the inbox and the runs it woke |

There are no new agent tools. `guides.ts`: `RUN_GUIDE` stops mentioning phones and Pushover (the user is notified),
and `CHANNEL_GUIDE` step 6 talks about `listen`.

## TUI

- `i`: the inbox. The latest events, a source filter, and per automation its cursor and how many matching events
  are waiting. That count replaces the "events waiting" column in the channels view.
- `o`: the outbox. The latest messages with per-sender status (sent, failed, held for quiet hours), and `r` to retry a
  failed one.
- Both read files the TUI already watches in the data directory. `tui.js` is recompiled as usual.

## Files on disk

```
dataDir/
  jobs.json         automation definitions + timer state (nextRunAt, lastRunAt); no memory, no runRequestedAt
  channels.json     channel defs + SourceState (seen, poll status); no queues
  consumers.json    per automation: cursor, taken, key sessions      (new)
  inbox.jsonl       events                                           (new)
  outbox.jsonl      messages and their delivery status               (new)
  memory.json       notes and warmUntil per automation / key         (new)
  history.jsonl     runs (unchanged; `notifications` counts outbox messages)
```

Lock order is jobs, then consumers, then inbox, then outbox. Inbox and outbox appends take only their own lock.

## Compatibility and migration

On first start with the new version, under the jobs lock:

- Each `queues[jobID].pending` is appended to the inbox, and that automation's cursor is set just below the first one,
  so nothing waiting is lost. `queues[].sessions` → `consumers.json` sessions and `memory.json`.
- `job.memory` → `memory.json`. `runRequestedAt` → a `manual` inbox event.
- Config: `notify.native` and `notify.pushover` are read as the senders `desktop` and `phone`, `notify.on` and
  `maxPerRun` as `outbox.on` and `maxPerRun`, and `on: { channels }` as `listen: { channels }`. The old keys keep
  working with a deprecation warning in the log.
- The old fields are removed from `channels.json` and `jobs.json` once migrated. `channels.json` keeps a
  `version: 2`.

A user who doesn't touch their config gets the same notifications on the same destinations. Delivery may come up to
one tick later when the tool is called in a non-leader process. This is a `feat!` because the files on disk change and
the TUI reads the new ones. Old plugin versions can't read the new state.

## Rollout, as separate PRs

1. **Outbox + senders.** It is self-contained and the biggest win (retries, routing, a record of what was sent).
   `notify.ts` splits into the outbox, the dispatcher and one adapter per sender. Config migration for `notify`.
2. **Inbox + consumers.** Channels write to `inbox.jsonl`, `consumers.json` replaces the queues, and timers and manual
   runs become inbox events. This is where `index.ts` gets simpler: the per-automation queues, `requeue`,
   `pendingStarts` across processes, and the first-poll code go.
3. **Agent-facing changes**: `listen` in `automation_create/update`, a sink-agnostic `automation_notify`, and the
   guides.
4. **Memory file** (+ optionally memory for every automation).
5. **TUI** inbox and outbox views.

Each PR keeps `bun test` and `bun run typecheck` green and ships its migration.

## Open questions

1. **Storage: JSONL or SQLite?** This draft keeps JSON and JSONL files with locks, like today: no new dependency, and
   the TUI's directory watch keeps working. `bun:sqlite` is built in and would give real tables (status columns, a
   unique index for dedup, no rewrite on trim) at the cost of a new storage layer and a different way to refresh the
   TUI. Worth it if inboxes grow past a few thousand events a day.
2. **First attach.** Should `from` default to `"now"`, or to "the channel's last poll" (closest to today: you see
   what is alerting right now)? The latter means keeping each channel's last poll snapshot as a list of seqs.
3. **Memory for every automation, or sticky only?** Offering a note to `new` runs makes "report only what changed"
   possible without sticky sessions. It is also one more thing the agent is asked to do every run.
4. **Should manual runs from a non-leader wait for the leader's tick** (≤ `tickSeconds`), or may any process start a
   run when the leader is idle? This draft says wait, for a single worker.
5. **Routing granularity.** Is "sender rules + automation `outbox.to`" too much? A smaller start is sender
   `minPriority` only.
6. **Agent-set follow-ups.** The article's other timer kind: `automation_followup({ in: "2h", note })` would append a
   timer event to the same automation (and key) later, for example "check whether the rollback fixed it". It fits
   the inbox naturally. Should it go in this update or the next?
