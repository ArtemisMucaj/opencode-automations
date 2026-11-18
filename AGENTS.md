# Agent notes

## `tui.js` is a committed build artifact (on purpose)

`tui.js` is generated from `tui.tsx` by `bun run compile` (`scripts/build.ts`). Do not edit it by hand. After any change to `tui.tsx`, run `bun run compile` and commit the regenerated `tui.js` in the same commit.

Why it is committed:

- Users install the plugin straight from Git (`opencode plugin add github:ArtemisMucaj/opencode-automations`). That copies the repo as-is into opencode's cache, under `node_modules`. There is no build step we can rely on at install time.
- OpenTUI's runtime Solid JSX transform skips every file under `node_modules`. Shipping `tui.tsx` alone then fails: Bun either compiles the JSX for React (`Cannot find package 'react'`), or, with a JSX pragma, uses a fallback runtime that isn't reactive, so the dialog renders as an empty box.
- So installs load the precompiled `tui.js` (`package.json` exports `./tui` → `./tui.js`). Local development can still point at `tui.tsx` (see `cli.json`), since a checkout is not under `node_modules`.

## Never add `build`, `prepare`, `prepack`, `preinstall`, `install` or `postinstall` scripts

For a Git dependency, npm treats any of those script names (or `workspaces`) as "needs preparation" and tries to run `npm install` in the cloned package. opencode's built-in installer can't do that, so `opencode plugin add/update` fails with `git dep preparation failed`. That is why the build script is named `compile`.

If the plugin is ever published to npm, build `tui.js` in a publish step instead and remove it from Git.

The `.ts` files (the server plugin and everything it and the TUI import) need no build: Bun runs TypeScript directly, even under `node_modules`. Only the JSX in `tui.tsx` needs compiling.

## Where things live

- `index.ts`: the server plugin's setup. Job state, sessions and memory, starting and ending runs, the ticker, channel polling, the event pump, hooks and commands.
- `automation-tools.ts`, `channel-tools.ts`: the `automation_*` and `channel_*` tools. They reach the running plugin through the `Runtime` object built in `index.ts` (`types.ts`).
- `schema.ts`: the tools' input schemas. `tool()` types a tool's input from its JSON schema and checks the input against it before the tool runs (opencode passes JSON-schema input through unchecked).
- `guides.ts`: everything the agent is told (tool names, namespaces, command and run guides).
- `jobs.ts`: job helpers without state (schedule and model parsing, IDs, what counts as active or running). `cron.ts`: schedules.
- `channels.ts`: channel definitions, polling, the event prompt. `store.ts`: all state, in one SQLite database (`bun:sqlite`): jobs, runs, the inbox and what each automation took from it, sticky sessions, memory, the outbox.
- `outbox.ts`: what is sent to the user and the dispatcher that delivers it to the configured destinations. `notify.ts`: formatting a message and delivering it through one destination.
- `log.ts`: the pino logger. It writes JSON lines to stderr, never stdout. Log with fields (`log.warn({ job, err }, "what happened")`), not `console`.
- `util.ts`: small helpers with no knowledge of jobs or channels (bounded waits, error text, time and count formatting, the tools' error wrapper).
- `tui.tsx`: the whole TUI view. It stays one file: only `tui.tsx` is compiled to `tui.js`, so JSX can't live anywhere else. Logic without JSX goes in a `.ts` file.

## State

`bun:sqlite` calls are synchronous, and a write waits (blocking its event loop) while another process writes. Keep transactions (`store.tx`, `mutate`, `mutateChannels`) short and synchronous: never `await` inside one. Fetch first, then write.

## Types

No `any`, in the source or the tests: use `unknown` and narrow it, or a type taken from the SDK. A test fake that stands in for part of an SDK type is cast once, `as unknown as T`, with a comment saying what it leaves out.

## Commits

Use Conventional Commits for commit subjects and PR titles: `fix: …`, `feat: …`, `refactor: …`, `chore: …`, `docs: …`, `test: …`, with `!` and a `BREAKING CHANGE:` footer when behaviour users rely on changes.
