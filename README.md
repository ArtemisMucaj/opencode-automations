# opencode automations

Let [opencode](https://opencode.ai) work for you while you're away.

An automation is a prompt that runs on its own: every morning, every 30 minutes, once at a given time, or whenever something happens in a system you watch (a Datadog alert, a new Sentry issue, a GitHub event). Each run is a normal opencode session, with your agents, tools and MCP servers, and it reaches you on your phone or desktop when it finds something worth telling you.

Some things people use it for:

- **Morning brief.** At 8:45 on weekdays, read your open merge requests and Jira tickets and send a short plan for the day.
- **Alert triage.** When a Datadog monitor fires, look at recent deploys and logs, find the likely cause, and notify you only if it needs a human.
- **Weekly audit.** Every Monday, run the dependency audit and report only what changed since last week.
- **Reminders with context.** "At 16:00, check whether the release pipeline passed and tell me."

## Requirements

- opencode 2 (the plugin uses the V2 plugin API)
- Git (opencode installs the plugin straight from the repository)

No build step, no clone, no Bun unless you want to hack on the plugin itself.

## Install

```sh
opencode plugin add github:ArtemisMucaj/opencode-automations
```

That adds the plugin to your global opencode configuration, so it's available in every project. Open opencode anywhere and type `/automations`: if a dialog opens, you're set.

To check from the terminal:

```sh
opencode plugin list
```

**Updating and removing**

```sh
opencode plugin update github:ArtemisMucaj/opencode-automations
opencode plugin remove github:ArtemisMucaj/opencode-automations
```

Removing the plugin keeps your automations and their history on disk (see [Where things are stored](#where-things-are-stored)).

**Other install forms**

- Over SSH: `opencode plugin add git+ssh://git@github.com/ArtemisMucaj/opencode-automations.git`
- A specific version: append `#<tag>`, `#<branch>` or `#<commit>` to the package name, e.g. `github:ArtemisMucaj/opencode-automations#v0.1.0`.

## Your first automation

Everything can be done from chat. In any opencode session:

```
/automation every weekday at 8:45, list the merge requests waiting for my review and send me a summary
```

The agent creates it and tells you when it will next run. Other things you can ask for:

```
/automation show my automations
/automation run the morning brief now
/automation pause the dependency audit
/automation change the morning brief to 9:00
/automation delete the test reminder
```

Plain language works too; `/automation` just makes sure the agent reaches for the right tools.

Or use the dialog: `/automations` opens a list of your automations over the current screen. From there you can run one now (**r**), create one with a small wizard (**n**), change its model (**m**), open its latest run (**⏎**), or pause and delete. The session sidebar also shows what runs next.

A few things to know when writing the prompt:

- **Runs start from nothing.** Unless you choose otherwise (see [Sessions](#sessions-fresh-sticky-or-current)), a run is a new session with no memory of your chat. Put everything the agent needs in the prompt, as if briefing a colleague who wasn't in the room.
- **Say when to notify.** The agent decides whether to notify you based on what it finds. Tell it what counts: "notify me only if a pipeline is red", "always send the summary".
- **Pick the agent and permissions.** Nobody is there to approve a permission prompt, so a run that hits one stalls until its timeout. Point unattended automations at an agent whose rules fit the job.

## Schedules

| You write | It means |
|---|---|
| `0 9 * * 1-5` | cron, 9:00 on weekdays. Add a timezone: `0 9 * * 1-5 Europe/Paris` |
| `@daily`, `@hourly`, `@weekly` | cron shortcuts |
| `every 30m`, `every 2h` | a fixed interval |
| `2026-12-01T09:00` | once, at that time |

Cron schedules respect daylight-saving changes in their timezone. If opencode wasn't running when an automation was due (laptop closed), the missed run fires at the next start, unless you turn that off for the job.

## Notifications

Notifications are sent by the server side of the plugin, so they work with no opencode window open. Two destinations, use either or both:

| Destination | Setup | Notes |
|---|---|---|
| Desktop | `"native": true` | macOS notification center (optional `{ "sound": "Ping" }`), or `notify-send` on Linux. Shows on the machine running opencode. |
| Phone | `"pushover": { "token": "…", "user": "…" }` | Through [Pushover](https://pushover.net). Phone and desktop apps. |

Put them under `notify` in the plugin options (see [Configuration](#configuration)).

**What you receive.** The agent running the automation writes the notification itself: a title and a short, plain-text message with the most important thing first, since a lock screen only shows the first lines. It sends at most 5 per run by default. If a run finds nothing worth your attention, it stays quiet.

**What you always receive.** When a run fails or times out, you get a notice automatically, even if the agent never got to say anything. Per automation you can turn notifications off entirely or change which outcomes get the automatic notice.

The dialog also shows a toast when a run finishes, if you happen to have opencode open.

## Sessions: fresh, sticky or current

Each automation picks where its runs happen:

- **`new`** (default): every run is a fresh session. Simple and predictable; runs appear in your session list as `⏰ name · time`.
- **`sticky`**: runs share one conversation, so the agent builds on what earlier runs found instead of redoing their work, and doesn't repeat what it already told you. Good for "report only what changed" automations and for following an incident over several runs.
- **`current`**: runs are queued into the chat you created the automation from. Only available when creating from chat.

**How sticky sessions stay cheap.** Re-sending a long conversation to the model on every run would cost a lot, and providers only keep it cached for a few minutes. So each sticky run ends by writing a short memory, the result of this run for the next one, and the plugin picks the cheapest way to continue:

- If the previous run ended recently enough that the model's cache is still warm, the next run continues the conversation as is.
- Otherwise the conversation is compacted down to that memory first, so the model reads a few hundred characters instead of every earlier run. The session stays one entry in your list, with its whole history still viewable.

You don't have to do anything for this: the agent is told how to keep its memory, and reminded once if it forgets.

## Channels: run on events

A channel is something to watch: an HTTP API the plugin polls every so often, turning new items into events. Automations attached to a channel run when events arrive. Polling means nothing has to reach your machine from outside, so it works on a laptop behind a firewall.

```
Datadog API ──poll every 1m──▶ new alerts ──▶ "alert-triage"  (runs as alerts arrive, one session per monitor)
                                          └─▶ "alert-digest"  (18:00: everything that fired today)
```

**Setting one up from chat**

```
/channel alert me about Datadog monitors for my-team
```

The agent walks through it with you: it reuses a channel if one already watches what you need, finds the API endpoint (from docs, an example you paste, or a connected tool), dry-runs the request and shows you the first events as an automation would see them, adjusts until they look right, then saves the channel and asks what you want done with the events. Channels can also be defined in configuration; see the Datadog example in `examples/opencode.jsonc`.

**Your API keys never go in the chat.** Channel definitions reference secrets as `{env:NAME}`, e.g. `"DD-API-KEY": "{env:DD_API_KEY}"`, and the plugin refuses a definition with a written-out credential. Set the variables where opencode runs; the agent tells you which ones are missing.

**Two ways to react**

- **As events arrive.** An automation with a channel and no schedule runs each time something new comes in, with up to 10 events per run. With a sticky session and a per-item key (one per monitor, one per issue), a flapping alert stays in a single conversation with its history and memory.
- **As a digest.** An automation with a channel *and* a schedule collects events and runs on schedule with everything since the last run (up to 50). Nothing new, no run.

One channel can feed several automations, and one automation can listen to several channels. The first time an automation is attached to a channel it receives everything currently there (what's alerting right now), then only new items. Paused automations keep their events for when they resume.

**Watching channels.** The **c** key in `/automations` shows each channel's status: polling or failing, what it polls and how often, the last poll and error, and which automations it feeds with how many events waiting. If a channel fails three polls in a row (expired key, API down) you get one notification.

**A note on trust.** Whatever is in the polled system ends up in the prompt: an alert's message, an issue's title. The plugin marks it as data, not instructions, but someone who can write into that system can still try to steer the agent. Use an agent whose permissions fit unattended work on untrusted input.

## Configuration

Automations created from chat or the dialog need no configuration at all. The options below let you set defaults, notifications, and automations or channels you'd rather keep in a file. Edit the plugin entry in your global `~/.config/opencode/opencode.json` (or `opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:ArtemisMucaj/opencode-automations",
      "options": {
        "defaultTimeoutMinutes": 30,
        "defaultModel": "anthropic/claude-sonnet-4-5",
        "notify": {
          "native": true,
          "pushover": { "token": "<app token>", "user": "<user key>" }
        },
        "jobs": [
          {
            "id": "morning-brief",
            "prompt": "List open merge requests where I'm a reviewer and summarize what each needs from me. Notify me with the summary.",
            "cron": "45 8 * * 1-5",
            "tz": "Europe/Paris",
            "directory": "/path/to/your/project"
          }
        ]
      }
    }
  ]
}
```

Configuration reloads on save; `/reload` if opencode is already open. `examples/opencode.jsonc` has a fuller example with sticky sessions, a Datadog channel and the automations on it.

**Plugin options**

| Option | Default | |
|---|---|---|
| `defaultTimeoutMinutes` | 30 | A run longer than this is stopped and reported as a timeout |
| `defaultModel` | the agent's | `provider/model`, applied when a run's session is created |
| `defaultAgent` | | Agent for runs that don't name one |
| `tickSeconds` | 30 | How often the plugin checks schedules and polls channels |
| `notify` | | `native`, `pushover`, `on` (outcomes that get an automatic notice, default `["failed", "timeout"]`), `maxPerRun` (default 5) |
| `jobs` | | Automations defined in config (below) |
| `channels` | | Channels defined in config; see `examples/opencode.jsonc` |
| `dataDir` | see below | Where automations and history are stored |

**Automation fields** (`jobs`, and the same names when creating from chat)

| Field | |
|---|---|
| `id`, `prompt` | Required |
| `cron`, `every`, `at`, `tz` | The schedule; one of the first three, or none for an event-only automation |
| `on` | `{ "channels": ["datadog"] }` to run on a channel's events |
| `directory` | Working directory for the run. Required in config, since the server isn't in your project |
| `session` | `new` (default) or `sticky` |
| `agent`, `model`, `timeoutMinutes` | Per-automation overrides |
| `maxEvents` | Events per run: default 10 when running as events arrive, 50 for a digest |
| `runMissed` | `true`: a run that was due while opencode was off fires at the next start |
| `notify` | `false` for silence; an array of outcomes for that automation's automatic notices |
| `enabled` | `false` pauses it |

Automations from config can be paused and run from the dialog but not edited there; their definition lives in the file.

## Where things are stored

`~/.local/share/opencode/plugins/automations/` (or under `$XDG_DATA_HOME`):

- `jobs.json`: automations created from chat or the dialog, plus the state of config ones (paused, last run, sticky session and memory)
- `history.jsonl`: every run, with its outcome, output and how many notifications it sent. `automation_history` and the dialog read from it
- `channels.json`: channels created from chat, which items have been seen, and events waiting for each automation

## Under the hood

Two parts ship in one package. A **server** part runs inside opencode's background server: it keeps time, starts runs, polls channels, follows each run to its end and sends notifications. A **TUI** part runs in each opencode window: the `/automations` dialog and the sidebar. Only the server ever starts a run, so with several windows open you still get exactly one run per schedule and one shared history.

Automations are ordinary opencode sessions, so anything your agents can do in chat they can do in a run. The agent gets a handful of extra tools (`automation_*`, `channel_*`) and short guidance on notifying and remembering; the `/automation` and `/channel` commands hand it that guidance up front.

## Developing

```sh
bun install
bun test
bun run typecheck
```

To run opencode against your checkout, open it in this directory: the included `opencode.jsonc` loads the plugin from `./`. Don't keep the Git-installed copy active at the same time; opencode refuses two plugins with the same id, and the global one wins, so your local changes wouldn't load. If you pin the global install to your branch instead (`#my-branch`), push before testing.

After changing `tui.tsx`, run `bun run compile` and commit the regenerated `tui.js`. See `AGENTS.md` for why.
