# opencode automations (v2 plugin)

Run prompts on a schedule inside opencode 2 — cron, fixed intervals, or one-shot — declared in config, created from chat, or managed from a TUI dialog. Or run them on events: channels poll an API (Datadog, Sentry, GitHub…) and hand new items to the automations that listen.

Two halves, one package:

| part | runs in | does |
|---|---|---|
| `index.ts` (server plugin) | the opencode background server | owns the ticker, fires runs, polls channels (`channels.ts`), tracks runs to completion, exposes `automation_*` and `channel_*` tools |
| `tui.tsx` (TUI plugin) | each TUI | `/automations` dialog, sidebar section, toasts + OS notifications when runs finish |

Both share `jobs.json` / `history.jsonl` on disk. The TUI only writes *intents* (pause, edit, delete, run-now); the server's leader executes them, so there's still exactly one firer and one history.

## Install

Requires OpenCode V2 and Git. Local development also needs [Bun](https://bun.sh). No build step is needed.

### Try from this checkout

From this checkout:

```sh
bun install
opencode
```

The included `opencode.jsonc` loads the package from the repository root, with no sample jobs or external notifications enabled. `package.json` exports both `.` (server) and `./tui` (TUI); OpenCode loads both parts from one plugin entry.

### Install globally from Git (all projects)

```sh
opencode plugin add github:ArtemisMucaj/opencode-automations
```

OpenCode installs the Git package and adds it to your global configuration. No manual clone, permanent checkout, or absolute local path is needed. This single entry loads both server and TUI parts; no separate `cli.json` entry is needed for normal use.

**Maintainers:** Git installation requires `package.json`, the plugin sources, and `bun.lock` to be committed and pushed to the repository first. Uncommitted local changes are not installed from Git. After editing `tui.tsx`, run `bun run compile` and commit the regenerated `tui.js`: installs load that precompiled file, because OpenTUI does not compile JSX inside `node_modules`.

For SSH access, use this **instead** of the command above:

```sh
opencode plugin add git+ssh://git@github.com/ArtemisMucaj/opencode-automations.git
```

Private repositories use your existing Git credentials. To pin a revision, append `#<tag>` or `#<full-commit-hash>` to the Git specifier. Full commit hashes stay pinned and are skipped by automatic update checks.

To configure jobs or notifications, edit the entry added to your global `~/.config/opencode/opencode.json(c)` (or `$XDG_CONFIG_HOME/opencode/opencode.json(c)`). Use the object form, preserving other plugins and settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:ArtemisMucaj/opencode-automations",
      "options": {
        "tickSeconds": 30,
        "defaultTimeoutMinutes": 30
      }
    }
  ]
}
```

Replace the existing entry rather than adding a second copy. See `examples/opencode.jsonc` for opt-in jobs/notification settings.

Open OpenCode in any project and use `/automations` to view automations, or `/automation <request>` to manage them from chat. Configuration hot-reloads; use `/reload` if already open. No service restart is needed. When developing in this plugin's own checkout, avoid loading the Git installation and its local `"package": "./"` entry simultaneously if your OpenCode version reports duplicate plugin IDs.

Verify installation:

```sh
opencode plugin list
opencode api get '/api/plugin?location[directory]=/absolute/path/to/your-project'
```

Look for `automations`, `state.status: "active"`, and both `features.server` and `features.tui`. Also open `/automations` in the TUI to check actual TUI setup; server status alone only confirms export detection.

Update or uninstall using the exact Git specifier you installed:

```sh
opencode plugin update github:ArtemisMucaj/opencode-automations
# Or uninstall:
opencode plugin remove github:ArtemisMucaj/opencode-automations
```

Use `/reload` afterward. Uninstalling leaves saved automations/history in the data directory described below.

`cli.json` in this repo is an **example for local development**, not project-local CLI configuration or a required part of Git installation. TUI options: `notify` (`"off"`, `"blurred"`, `"always"`) and `dataDir` (must match the server).

Uses `@opencode/plugin@2.2.1`, OpenTUI `0.7.0`, `cron-parser` for timezone/DST-aware cron, and `proper-lockfile` for cross-process locking. Dependencies are locked in `bun.lock`.

## TUI

`/automations` (or the command palette → "Automations") opens a dialog over the current screen; **esc** closes it.

- **⏎** opens the job's latest run session (in a tab if tabs are on).
- **r** queues a run; the server fires it on its next tick (≤ `tickSeconds`), even if the job is paused, without moving its schedule.
- **m** picks from the models available at the current location.
- **n** is a small wizard; schedules accept `0 9 * * 1-5 Europe/Paris`, `@daily`, `every 30m`, or an ISO date. New jobs use the TUI's current directory.
- Config-defined jobs can be paused and run, not edited — their definition lives in config.
- **c** switches to the **channels** tab: each channel's status (polling, idle, failing), what it polls and how often, its last poll and error, the environment variables it reads, its event mapping, and the automations it feeds with their waiting events. **p** polls the selected channel on the server's next tick; **d** deletes a channel created from chat that no automation uses. Channels are created and changed from chat (`/channel`).

The session sidebar lists upcoming jobs and marks sessions created by an automation run ("this session: mr-triage ✓"). Finished runs raise a toast (OS/phone notifications come from the server — see below).

## Create automations 

`/automation <request>` or plain language. Tools: `automation_create`, `automation_list`, `automation_update`, `automation_delete`, `automation_run`, `automation_history`, plus `automation_notify`, which only automation runs see (below).

**Code mode.** Every tool goes through opencode's code mode, in two namespaces: `automation` (create, list, update, delete, run, history, and notify inside runs) and `channel` (list, poll, test, create, update, delete). Their schemas don't ride along on every request; the model reaches them through code mode when needed. `automation_notify` is offered only inside automation runs. `/automation` and `/channel` also give the agent a short guide.

## Notifications

Sent by the **server** plugin (`notify` in `opencode.jsonc`), so no TUI needs to be open.

| channel | setup | notes |
|---|---|---|
| `native` | `"native": true` | macOS via `osascript` (optional `{ "sound": "Ping" }`), Linux via `notify-send` (needs `libnotify` and a desktop session). Shows on the server machine. |
| `pushover` | `"pushover": { "token", "user" }` | Phone and desktop. |

**The run's agent decides what to send.** Runs get an `automation_notify` tool (`title`, `message`, optional `priority` and `url`) and are told to write plain text with no markdown, newlines for structure and bare links. Their final reply is not sent. Stray markdown is cleaned up anyway.

**Limits.** Pushover takes 1024 characters per message: longer ones are split into numbered parts (`Title (1/3)`), up to 4. At most `maxPerRun` notifications per run (default 5).

**Automatic notices** go out only when a run fails or times out (`on`, default `["failed", "timeout"]`). A successful run is notified only if the agent found something worth sending. Per job, `notify: false` turns everything off; an array picks that job's automatic notices.

A failing channel is logged and never affects the run. The TUI's own OS notification is off by default (`notify` in `cli.json`).

## Channels

A channel is an event source: it polls an HTTP API and turns new items into events. Automations run on those events with `on: { channels: [...] }`, from one channel or several. The agent investigates and, if it's worth it, notifies you with `automation_notify`. Polling needs no public URL, so it works on a laptop.

```
Datadog API ──poll every 1m──▶ new alerts ──▶ automation "alert-triage" ──▶ session ──▶ automation_notify ──▶ phone
                                          └─▶ automation "alert-digest" (6pm: everything since yesterday)
```

Create channels from chat with `/channel <what you want>` (below), or define them under `channels` in the plugin options; see the Datadog example in `examples/opencode.jsonc`. Then point automations at them.

### Creating channels from chat

`/channel alert me about Datadog monitors for my-team` (or plain language) starts a guided loop:

1. `channel_list`: the agent reuses a channel that already polls what's needed.
2. It finds the endpoint (API docs, an example you paste, or a connected tool) and drafts a definition.
3. `channel_test` dry-runs it: the real request, nothing saved or marked seen. It reports the item count before and after the filter, the fields of the first item, and the first events as an automation would get them. The agent adjusts `items`, `filter` and `event` until those look right.
4. `channel_create` saves it in `channels.json`, next to the config channels.
5. With your agreement on what to do with the events, `automation_create` (or `automation_update`) attaches it with `channels: [...]`.

**Keys stay out of chat.** A channel created from chat must reference secrets as `{env:NAME}`. Headers, query parameters and body fields that look like credentials (`Authorization`, `api_key`, `token`, …) with a written-out value are refused. `channel_test` and `channel_list` say which variables aren't set; set them where the opencode server runs and restart it. Such a channel can only read variables whose name starts with `CHANNEL_` (e.g. `{env:CHANNEL_DD_API_KEY}`), or that you list under the plugin option `channelEnv` (e.g. `"channelEnv": ["DD_API_KEY"]`): event text is untrusted, and an agent steered by it mustn't be able to send any variable of the server to any URL. `channel_test` also replaces a key's value with its `{env:NAME}` reference in what it shows. Config channels can read any variable.

`channel_update` changes a created channel (changing `event.id` makes current items look new, so they're delivered again). `channel_delete` removes one; if automations use it, pass `detach: true` to remove it from them, which pauses any event-only automation left with no channel. Config channels are edited in config.

**Channel fields**

| field | |
|---|---|
| `id`, `name` | |
| `every` | poll interval, at least `1m`. Polls happen on the leader's tick, so within `tickSeconds` of it. |
| `request` | `url`, optional `method`, `headers` and JSON `body`. `{env:NAME}` reads an environment variable, so keys stay out of config. |
| `items` | dot path to the array of items in the response (`data`, `result.items`). Empty: the response is the array. |
| `filter` | keep items whose field equals a value or one of several: `{ "overall_state": ["Alert", "Warn"] }` |
| `event` | templates over each item with `{dot.path}`: `id` (required: what counts as a new event), `sessionKey` (which events share a session for automations with `session: "sticky"`, e.g. `{id}` for one per monitor), `title`, `body`, `url` |

**Automations on channels** take `on: { "channels": ["<id>", …] }` (or `on: { "channel": "<id>" }` for one), from config, or `channels` in `automation_create` and `automation_update`. Events from all of an automation's channels go into one queue and are delivered together, each tagged with its channel:

- **No schedule:** runs as events arrive, at most `maxEvents` (default 10) per run.
- **With a schedule** (`cron`/`every`/`at`): a digest. Events wait, and each run gets everything that arrived since the last one (up to `maxEvents`, default 50). A scheduled digest with nothing waiting doesn't run.
- **`session`** picks where runs go:
  - `new` (default): a fresh session per run.
  - `sticky`: one session for all runs, accumulating context. If the channel sets `event.sessionKey`, one session per key instead: with `"sessionKey": "{id}"`, each monitor gets its own session, so a flapping alert stays in one conversation. Keys are per channel: monitor `123` and Sentry issue `123` get different sessions.
  - `current`: the chat that created the automation (chat-created only).

**How events flow.** An automation's first poll of each of its channels gets every item currently there (what's alerting right now), including an automation added later to a channel that's been running. After that, each poll's items are compared with the event IDs already seen (kept in `channels.json`, so restarts don't repeat them), and new events join the queue of every active automation on that channel, so a triage and a digest can share one source. An automation's events wait while its session is busy, then go in as one prompt, queued behind any turn in progress. Put what makes an event new into `id`: `{id}:{overall_state_modified}` delivers a monitor again when it fires again after recovering. A channel no active automation uses isn't polled.

**Untrusted input.** Event text goes inside `<event>` tags, and the prompt tells the agent it is data, not instructions. Still, anyone who can write into the polled system (an alert message, an issue title) writes into the prompt: run these automations with an agent whose permissions fit unattended work on untrusted input.

**Status.** `channel_list` shows each channel's last poll, errors, and the automations on it with their waiting events. `channel_poll` polls now. Pause an automation as usual; its events wait while it is paused (up to 500) and go in when it resumes. An automation disabled in config (`enabled: false`) gets none. A response where the `items` path is missing or null counts as no items. After 3 failed polls in a row (expired key, API down) you get one notification.

## Reference

**Model** — `"provider/model[:variant]"`, per job or via `defaultModel`. Applied at session creation: every run for `new`, first run only for `sticky`; `current` retains the chat's model.

**Output** — in the run's session (`⏰ name · time` in your session list), the last text block in `history.jsonl` (`automation_history`, the TUI, with the number of notifications sent), and a toast/notification from the TUI. Phone/desktop notifications carry what the agent sent with `automation_notify`.

**Working directory** — the session's `location`, the calling session's directory for chat-created jobs, the TUI's directory for TUI-created jobs, `directory` for config jobs.

**Session modes** —
* `new`: fresh per run
* `sticky`: one session across runs (formerly `reuse`, still accepted)
* `current`: queued into the chat that created it

**Reliability** — missed runs fire on restart

## Caveats

- Unattended runs that hit an `ask` permission stall until timeout — point jobs at an agent with explicit rules.
- Targets the current V2 plugin API (`@opencode/plugin`), not the legacy V1 SDK. Re-run tests and typecheck when upgrading OpenCode or OpenTUI.

## Develop

```sh
bun install
bun test            # cron/DST, persistence/leases, server tools, TUI intents, native/Pushover delivery, headless TUI render
bun run typecheck
```

For a manual integration check, open `/automations` in OpenCode. Server plugin status alone only confirms TUI export detection, not successful TUI setup.
