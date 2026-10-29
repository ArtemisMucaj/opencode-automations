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

The `.ts` files (server plugin, `cron.ts`, `jobs.ts`, `store.ts`) need no build: Bun runs TypeScript directly, even under `node_modules`. Only the JSX in `tui.tsx` needs compiling.
