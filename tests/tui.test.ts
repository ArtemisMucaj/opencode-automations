import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { render } from "@opentui/solid"
import { createTestRenderer } from "@opentui/core/testing"
import plugin from "../tui.tsx"
import { Store, type Job } from "../store.ts"

test("TUI renders automations page and persists pause/run-now actions", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "automations-tui-"))
  const store = new Store(dataDir)
  store.saveJobs([{
    id: "morning", name: "Morning triage", prompt: "Check merge requests", schedule: { kind: "every", ms: 60_000 },
    directory: dataDir, session: "new", timeoutMinutes: 30, catchUp: true, enabled: true,
    source: "tool", createdAt: Date.now(), nextRunAt: Date.now() + 60_000,
  } satisfies Job])
  const testRenderer = await createTestRenderer({ width: 120, height: 35 })
  const layers: any[] = []
  let route: any
  const color = "#aaaaaa"
  const ctx = {
    renderer: testRenderer.renderer,
    options: { dataDir, notify: "off" },
    location: { directory: dataDir },
    theme: {
      text: {
        subdued: color,
        action: { primary: { default: color } },
        feedback: Object.fromEntries(["success", "error", "warning", "info"].map((name) => [name, { default: color }])),
      },
      border: { default: color }, background: { action: { primary: { default: "#222222" } } },
    },
    keymap: { layer: (fn: any) => { layers.push(fn()) } },
    ui: {
      toast: { show: () => {} },
      router: { register: (input: any) => { route = input; return () => {} } },
      slot: () => () => {},
      format: { path: (path: string) => path },
    },
  }
  let stop: any
  try {
    stop = await plugin.setup(ctx as any)
    const open = layers.flatMap((layer) => layer.commands).find((command) => command.id === "automations.open")
    expect(open.slash.name).toBe("automations")
    expect(open.slash.aliases ?? []).toEqual([])
    expect(route.name).toBe("automations")
    await render(() => route.render(), testRenderer.renderer)
    await testRenderer.renderOnce()
    const frame = testRenderer.captureCharFrame()
    expect(frame).toContain("Automations")
    expect(frame).toContain("Morning triage")
    expect(frame).toContain("Check merge requests")
    const commands = layers.flatMap((layer) => layer.commands)
    await commands.find((command) => command.title === "pause/resume").run()
    expect(store.loadJobs()[0].paused).toBe(true)
    await commands.find((command) => command.title === "run now").run()
    expect(store.loadJobs()[0].runRequestedAt).toBeNumber()
    expect(store.loadJobs()[0].paused).toBe(true)
    await testRenderer.renderOnce()
    expect(testRenderer.captureCharFrame()).toContain("paused")
  } finally {
    stop?.()
    await testRenderer.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
