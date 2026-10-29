// Precompiles tui.tsx into tui.js with the same Babel setup OpenTUI uses at runtime.
// Needed because OpenTUI skips its JSX transform for files under node_modules,
// which is where a Git/npm install of this plugin lives. See AGENTS.md.

// @ts-expect-error untyped
import { transformAsync } from "@babel/core"
// @ts-expect-error untyped
import ts from "@babel/preset-typescript"
// @ts-expect-error untyped
import solid from "babel-preset-solid"
import { fileURLToPath } from "node:url"

const src = fileURLToPath(new URL("../tui.tsx", import.meta.url))
const out = fileURLToPath(new URL("../tui.js", import.meta.url))

const result = await transformAsync(await Bun.file(src).text(), {
  filename: src,
  configFile: false,
  babelrc: false,
  presets: [[solid, { moduleName: "@opentui/solid", generate: "universal" }], [ts]],
})
if (!result?.code) throw new Error("tui.tsx compiled to nothing")

await Bun.write(out, "// Generated from tui.tsx by `bun run compile`. Do not edit. Committed on purpose: see AGENTS.md.\n" + result.code + "\n")
console.log("wrote tui.js")
