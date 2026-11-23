# opencode automations

Let [opencode](https://opencode.ai) work for you while you're away.

An automation is a prompt that runs by itself. It can run on a schedule (every morning, every 30 minutes, once next Tuesday) or when something happens in a tool you use, such as a Datadog alert or a new Sentry issue. Each run is a normal opencode session, with your agents, tools and MCP servers. When the run finds something you should know about, it sends you a notification on your desktop or phone. When it finds nothing, it stays quiet.

Some examples:

- **Morning brief.** At 8:45 on weekdays, read your open merge requests and tickets and send you a short plan for the day.
- **Alert triage.** When a Datadog monitor fires, look at recent deploys and logs, find the likely cause, and tell you only if a person needs to step in.
- **Weekly audit.** Every Monday, run the dependency audit and tell you only what changed since last week.
- **Reminders with context.** "At 16:00, check whether the release pipeline passed and tell me."

## Install

You need opencode 2 and Git. Then run:

```sh
opencode plugin add github:ArtemisMucaj/opencode-automations
```

The plugin is now available in every project. Open opencode and type `/automations`. If a dialog opens, it worked.

To update or remove it later:

```sh
opencode plugin update github:ArtemisMucaj/opencode-automations
opencode plugin remove github:ArtemisMucaj/opencode-automations
```

Removing the plugin keeps your automations and their history, in case you install it again.

The plugin replaces opencode's built-in automations: the `automation` tools and the `/automation` command are this plugin's.

## Create your first automation

Ask for it in chat, in any opencode session:

```
/automation every weekday at 8:45, list the merge requests waiting for my review and send me a summary
```

The agent creates it and tells you when it will first run. You manage automations the same way:

```
/automation show my automations
/automation run the morning brief now
/automation pause the dependency audit
/automation change the morning brief to 9:00
/automation delete the test reminder
```

You can also use the dialog. Type `/automations` to see your list, then:

| Key | Does |
|---|---|
| `n` | create an automation, step by step |
| `r` | run the selected one now |
| `space` | pause or resume it |
| `m` | change its model |
| `⏎` | open its latest run |
| `d` | delete it |
| `c` | switch to channels (see [Run on events](#run-on-events-channels)) |
| `i` | switch to the inbox: the latest events from every channel, and which automations took them, still wait for them, or dropped them |
| `o` | switch to the outbox: the latest messages sent to you, and whether each destination got them |

Press a tab's key again to go back to your automations. An automation's details also show its memory: the note each run leaves for the next one.

The sidebar also shows what runs next.

### Tips for a good prompt

- **Write it for someone who wasn't there.** A run doesn't see your chat. Put everything it needs in the prompt.
- **Say when you want to hear about it.** For example "notify me only if a pipeline is red", or "always send the summary".
- **Pick an agent that doesn't need approvals.** Nobody is there to click "allow", so a run that asks for permission waits until it times out.

## Schedules

| You write | It means |
|---|---|
| `every 30m`, `every 2h` | at a fixed interval |
| `@hourly`, `@daily`, `@weekly` | once an hour, day or week |
| `0 9 * * 1-5` | a cron schedule: 9:00 on weekdays. Add a timezone if you like: `0 9 * * 1-5 Europe/Paris` |
| `2026-12-01T09:00` | once, at that time |

In chat you can just say "every weekday at 9" and the agent writes the schedule for you.

If your laptop was closed when a run was due, the run happens as soon as opencode starts again. Set `runMissed` to `false` on an automation to skip missed runs instead.

## Notifications

Tell the plugin once where to send things, and every automation uses it. There are two places it can send to:

- **Desktop** notifications on macOS and Linux.
- **Your phone**, through the [Pushover](https://pushover.net) app.

Add them to the plugin's options (see [Configuration](#configuration) for where those go):

```jsonc
"outbox": {
  "destinations": [
    { "id": "desktop", "type": "Notification.Native" },
    { "id": "phone", "type": "Notification.PushOver", "options": { "token": "{env:PUSHOVER_TOKEN}", "user": "{env:PUSHOVER_USER}" }, "minPriority": "high" }
  ]
}
```

- `{env:PUSHOVER_TOKEN}` reads the value from an environment variable, so your keys don't sit in the file.
- `minPriority` filters what reaches that place. With `"high"`, your phone only buzzes for things that need you soon. The choices are `low`, `normal` and `high`.

**What you get.** The agent writes each notification itself: a title, a few short lines with the most important thing first, and how urgent it is. If a run had nothing worth telling you, you get nothing.

**What you always get.** If a run fails or takes too long, you get a notice even if the agent never wrote one. You also hear about it once if a channel stops working. You can turn notifications off for a single automation.

If a notification can't be delivered (no network, Pushover down), it's tried again after 1, 5 and 30 minutes.

The dialog shows what each automation sent you and whether it arrived.

With no destination set up, notifications are still written and shown in the dialog, but nothing is sent. Adding a destination later doesn't send the old ones.

## Memory and sessions

Automations that run more than once remember what they found last time. At the end of each run, the agent writes a short note: what it saw, what it told you, what to keep an eye on. The next run starts from that note. That's how "tell me only what changed" works.

You can also choose where the runs happen:

- **`new`** (the default): each run gets its own session, listed as `⏰ name · time`.
- **`sticky`**: all runs continue one conversation, so the agent can build on earlier runs. Good for following an incident over several hours. The plugin keeps this cheap: when the conversation has gone quiet for a while, it's shrunk down to the memory note instead of sending the whole history to the model again. You can still scroll back through all of it.
- **`current`**: runs are added to the chat you created the automation from. Only when you create it from chat.

## Run on events (channels)

A channel watches a tool you use, such as Datadog or Sentry, by checking its API every minute or so. When something new shows up, the automations attached to that channel run on it. The plugin does the checking, so nothing has to reach your laptop from the internet. It works behind a firewall.

```
Datadog ──checked every minute──▶ new alerts ──▶ "alert-triage"  runs as alerts come in
                                             └─▶ "alert-digest"  runs at 18:00 with everything from today
```

**Set one up from chat:**

```
/channel alert me about Datadog monitors for my-team
```

The agent works out which API to call, tests it, shows you what it found, and asks what you want done with the events. If you already have a channel that watches the same thing, it reuses it.

**Your API keys never go in the chat.** Channels refer to keys as `{env:NAME}`, for example `{env:DD_API_KEY}`, and the plugin refuses a channel with a key written out in full. Set the variables where opencode runs. The agent tells you which ones are missing.

**Two ways to react:**

- **Right away.** An automation with a channel and no schedule runs whenever something new arrives. With a `sticky` session, each alert (or each issue) can keep its own conversation, so an alert that keeps firing stays in one place with its history.
- **As a digest.** An automation with a channel and a schedule collects events and runs once at the scheduled time with everything since last time. If nothing new came in, it doesn't run.

One channel can feed several automations, and one automation can listen to several channels. A paused automation keeps its events until you resume it.

In the `/automations` dialog, press `c` to see your channels: whether each one is working, when it last checked, and which automations it feeds. Press `p` to check one now.

**Be careful with what you watch.** Text from the watched tool, like an alert's message or an issue's title, ends up in the agent's prompt. The plugin tells the agent to treat it as data, not instructions, but someone who can write into that tool could still try to steer it. Use an agent whose permissions suit unattended work.

## Configuration

Automations you create from chat or the dialog need no configuration. Use the options below to set defaults, set up notifications, or keep automations and channels in a file.

The options go in the plugin's entry in `~/.config/opencode/opencode.json` (or `opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:ArtemisMucaj/opencode-automations",
      "options": {
        "defaultModel": "anthropic/claude-sonnet-4-5",
        "outbox": {
          "destinations": [
            { "id": "desktop", "type": "Notification.Native" }
          ]
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

Changes apply when you save. If opencode is already open, run `/reload`. For a fuller example, with a Datadog channel and the automations on it, see [`examples/opencode.jsonc`](examples/opencode.jsonc).

### Plugin options

| Option | Default | What it does |
|---|---|---|
| `defaultModel` | the agent's | Model for runs, as `provider/model` |
| `defaultAgent` | | Agent for runs that don't name one |
| `defaultTimeoutMinutes` | 30 | A run that takes longer is stopped and reported |
| `outbox.destinations` | | Where notifications go (see [Notifications](#notifications)) |
| `outbox.on` | `["failed", "timeout"]` | Which outcomes send an automatic notice |
| `jobs` | | Automations kept in the file (below) |
| `channels` | | Channels kept in the file. See `examples/opencode.jsonc` |
| `tickSeconds` | 30 | How often the plugin checks schedules and channels |
| `dataDir` | see [below](#where-your-data-lives) | Where automations and their history are kept |

### Automation fields

These are the fields for `jobs`. When you create an automation from chat, the agent fills them in for you.

| Field | What it does |
|---|---|
| `id`, `prompt` | Its name and what it should do. Both required |
| `cron`, `every` or `at`, plus `tz` | When it runs. Leave them out for an automation that only runs on events |
| `on` | The channels it listens to, e.g. `{ "channels": ["datadog"] }` |
| `directory` | The project folder it runs in. Required in the file |
| `session` | `new` (default) or `sticky` |
| `agent`, `model`, `timeoutMinutes` | Override the defaults for this automation |
| `maxEvents` | Most events per run: 10 by default when reacting right away, 50 for a digest |
| `runMissed` | `false` to skip a run that was due while opencode was closed (on by default) |
| `notify` | `false` to never notify, or a list of outcomes for its automatic notices |
| `enabled` | `false` to pause it |

You can pause and run automations from the file in the dialog, but to change them, edit the file.

## Where your data lives

Everything is kept in one file, `state.db`, in `~/.local/share/opencode/plugins/automations/`. That includes your automations, their runs, their memory, the events channels brought in, and what was sent to you.

If something goes wrong, such as a channel that can't reach its API or a notification that wasn't delivered, the plugin writes a line about it to opencode's log output. Set `AUTOMATIONS_LOG_LEVEL` to `warn`, `error` or `silent` to see less (default `info`).

## How it works

The plugin has two parts. One runs in opencode's background server: it keeps time, checks channels, starts runs and sends notifications. The other runs in each opencode window and draws the `/automations` dialog and the sidebar. With several windows open, only one of them starts runs, so each automation still runs once and you get each notification once.

A run is an ordinary opencode session. The agent gets a few extra tools for notifying you and saving its memory, and short instructions on when to use them.

## Contributing

```sh
bun install
bun test
bun run typecheck
```

To try your changes, open opencode in this folder: the included `opencode.jsonc` loads the plugin from here. Remove the Git-installed copy first, since opencode won't load two copies of the same plugin and the installed one wins.

After changing `tui.tsx`, run `bun run compile` and commit the new `tui.js`. [`AGENTS.md`](AGENTS.md) explains why, and where the code lives.
