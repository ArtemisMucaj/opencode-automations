# opencode automations (v2 plugin)

Run prompts on a schedule inside opencode 2 — cron, fixed intervals, or one-shot — declared in config, created from chat, or managed from a TUI dialog.

Two halves, one package:

| part | runs in | does |
|---|---|---|
| `index.ts` (server plugin) | the opencode background server | owns the ticker, fires runs, tracks them to completion, exposes `automation_*` tools |
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

**Maintainers:** Git installation requires `package.json`, the plugin sources, and `bun.lock` to be committed and pushed to the repository first. Uncommitted local changes are not installed from Git.

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

The session sidebar lists upcoming jobs and marks sessions created by an automation run ("this session: mr-triage ✓"). Finished runs raise a toast (OS/phone notifications come from the server — see below).

## Create automations 

`/automation <request>` or plain language. Tools: `automation_create`, `automation_list`, `automation_update`, `automation_delete`, `automation_run`, `automation_history`.

## Notifications

Configured on the **server** plugin (`notify` in `opencode.jsonc`), so they fire even with no TUI open:

| channel | reaches | setup |
|---|---|---|
| `native` | macOS or Linux desktop | `"native": true` |
| `pushover` | iPhone, Android, desktop | `"pushover": { "token", "user" }` |

`native` picks the server's OS backend automatically:

- **macOS:** `osascript` (AppleScript). Allow notifications for Script Editor in System Settings if prompted. Optional macOS-only sound: `"native": { "sound": "Ping" }` (empty string disables sound).
- **Linux:** `notify-send` (install `libnotify-bin` on Debian/Ubuntu, `libnotify` on Fedora/Arch). Requires a running desktop notification service and access to its user D-Bus session. The OpenCode server must inherit that desktop session environment; a headless server or isolated system service will not display local notifications.

No TUI needs to be open, but native notifications appear on the **server machine**, not a remote client's desktop. Missing utilities, unavailable desktop sessions, or unsupported OSes are logged as `native` delivery failures without failing the automation; Pushover can still deliver. The old `macos` option is no longer supported—replace it with `native`.

Failures get elevated priority in Pushover. `on` picks outcomes (default: succeeded, failed, timeout). Per job, `notify: false` silences it and `notify: ["failed"]` limits it. A failing channel is logged and never affects the run. The TUI's own OS notification is now off by default (`notify` in `cli.json` to turn it back on) to avoid duplicates.

## Reference

**Model** — `"provider/model[:variant]"`, per job or via `defaultModel`. Applied at session creation: every run for `new`, first run only for `reuse`; `current` retains the chat's model.

**Output** — in the run's session (`⏰ name · time` in your session list), the last text block in `history.jsonl` (`automation_history`, the TUI), and a toast/notification from the TUI.

**Working directory** — the session's `location`, the calling session's directory for chat-created jobs, the TUI's directory for TUI-created jobs, `directory` for config jobs.

**Session modes** —
* `new`: fresh per run
* `reuse`: one session across runs
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
