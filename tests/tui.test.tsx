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
    directory: dataDir, session: "new", timeoutMinutes: 30, runMissed: true, enabled: true,
    source: "tool", createdAt: Date.now(), nextRunAt: Date.now() + 60_000,
  } satisfies Job])
  const testRenderer = await createTestRenderer({ width: 120, height: 45 })
  const layers: any[] = []
  let dialog: any
  // Minimal stand-in for @opencode/theme's ResolvedTheme (only the tokens tui.tsx reads).
  const color = "#aaaaaa"
  const feedback = Object.fromEntries(["success", "error", "warning", "info"].map((name) => [name, { base: color, muted: color }]))
  const scale = Object.fromEntries([100, 200, 300, 400, 500, 600, 700, 800, 900].map((step) => [step, color]))
  const ctx: any = {
    renderer: testRenderer.renderer,
    options: { dataDir, notify: "off" },
    location: { directory: dataDir },
    themeMode: "dark",
    theme: {
      hue: { accent: scale },
      categorical: [scale, scale, scale],
      text: { base: color, muted: color, faint: color, action: { primary: { base: color, focused: color } }, feedback },
      background: {
        base: "#111111",
        raised: { base: "#1a1a1a", high: "#222222", max: "#2a2a2a" },
        action: { primary: { base: "#333333", focused: "#333333" } },
        feedback,
      },
      border: { base: color },
      surface: () => ctx.theme,
    },
    keymap: { layer: (fn: any) => { layers.push(fn()) } },
    ui: {
      toast: { show: () => {} },
      router: { navigate: () => {} },
      dialog: { show: (render: any) => { dialog = render }, set: () => {}, clear: () => { dialog = undefined } },
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
    await open.run()
    expect(dialog).toBeFunction()
    // Stand-in for opencode's dialog container: full screen, centered, fixed 116-column box.
    await render(
      () => (
        <box position="absolute" left={0} top={0} width={120} height={45} alignItems="center" justifyContent="center">
          <box width={116} paddingTop={1}>
            {dialog()}
          </box>
        </box>
      ),
      testRenderer.renderer,
    )
    await testRenderer.renderOnce()
    await testRenderer.renderOnce() // the 80% panel is positioned from the anchor measured in this frame
    const frame = testRenderer.captureCharFrame()
    // 80% of 120x45 is 96x36, so the panel starts at column 12, row 4; the title sits inside its padding.
    const rows = frame.split("\n")
    expect(rows[5].indexOf("⏰ Automations")).toBe(14)
    expect(rows.slice(0, 4).join("").trim()).toBe("")
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

test("TUI channels tab shows status, mapping and listeners, and queues a poll", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "automations-tui-"))
  const store = new Store(dataDir)
  store.saveJobs([{
    id: "triage", name: "Alert triage", prompt: "Investigate", schedule: { kind: "event" },
    directory: dataDir, session: "sticky", timeoutMinutes: 30, runMissed: true, enabled: true,
    on: { channels: ["datadog", "sentry"] }, source: "tool", createdAt: Date.now(),
  } satisfies Job])
  store.mutateChannels((s) => {
    s.config.datadog = {
      name: "Datadog", url: "https://api.example.test/api/v1/monitor", everyMs: 60_000, items: "",
      filter: { overall_state: ["Alert"] }, event: { id: "{id}:{overall_state_modified}", sessionKey: "{id}", title: "{name}" }, env: ["DD_API_KEY"],
    }
    s.defs.sentry = { id: "sentry", name: "Sentry", every: "5m", request: { url: "https://sentry.example.test/issues?token={env:T}" }, event: { id: "{id}" }, createdAt: 1 }
    s.sources.datadog = { seen: [], lastPollAt: Date.now() - 30_000, lastOkAt: Date.now() - 30_000 }
    s.sources.sentry = { seen: [], lastPollAt: Date.now(), lastError: "HTTP 403: bad token", failures: 3 }
    s.queues.triage = { pending: [{ channel: "datadog", id: "1:t", title: "CPU high on web-1" }], sessions: {} }
  })
  const testRenderer = await createTestRenderer({ width: 140, height: 50 })
  const layers: any[] = []
  let dialog: any
  const toasts: string[] = []
  const color = "#aaaaaa"
  const feedback = Object.fromEntries(["success", "error", "warning", "info"].map((name) => [name, { base: color, muted: color }]))
  const scale = Object.fromEntries([100, 200, 300, 400, 500, 600, 700, 800, 900].map((step) => [step, color]))
  const ctx: any = {
    renderer: testRenderer.renderer,
    options: { dataDir, notify: "off" },
    location: { directory: dataDir },
    themeMode: "dark",
    theme: {
      hue: { accent: scale },
      categorical: [scale, scale, scale],
      text: { base: color, muted: color, faint: color, action: { primary: { base: color, focused: color } }, feedback },
      background: {
        base: "#111111",
        raised: { base: "#1a1a1a", high: "#222222", max: "#2a2a2a" },
        action: { primary: { base: "#333333", focused: "#333333" } },
        feedback,
      },
      border: { base: color },
      surface: () => ctx.theme,
    },
    keymap: { layer: (fn: any) => { layers.push(fn()) } },
    ui: {
      toast: { show: (t: any) => { toasts.push(t.message) } },
      router: { navigate: () => {} },
      dialog: { show: (render: any) => { dialog = render }, set: () => {}, clear: () => { dialog = undefined }, confirm: async () => true },
      slot: () => () => {},
      format: { path: (path: string) => path },
    },
  }
  let stop: any
  try {
    stop = await plugin.setup(ctx as any)
    const commands = () => layers.flatMap((layer) => layer.commands)
    await commands().find((command) => command.id === "automations.open").run()
    await render(
      () => (
        <box position="absolute" left={0} top={0} width={140} height={50} alignItems="center" justifyContent="center">
          <box width={116} paddingTop={1}>
            {dialog()}
          </box>
        </box>
      ),
      testRenderer.renderer,
    )
    await testRenderer.renderOnce()
    await testRenderer.renderOnce()
    // Automations tab: the job lists its channels.
    expect(testRenderer.captureCharFrame()).toContain("datadog, sentry")

    await commands().find((command) => command.bind === "c").run()
    await testRenderer.renderOnce()
    let frame = testRenderer.captureCharFrame()
    expect(frame).toContain("[channels]")
    expect(frame).toContain("2 channels · 2 polled · 1 failing")
    expect(frame).toContain("Datadog")
    expect(frame).toContain("Sentry")
    // First channel (datadog) is selected: its detail, mapping and listeners.
    expect(frame).toContain("https://api.example.test/api/v1/monitor")
    expect(frame).toContain("from config")
    expect(frame).toContain("{id}:{overall_state_modified}")
    expect(frame).toContain("DD_API_KEY")
    expect(frame).toContain("Alert triage")
    expect(frame).toContain("1 waiting")
    expect(frame).toContain("CPU high on web-1")
    expect(frame).toContain("p  poll now")

    // Next channel: the created one, failing, with no query string (and so no token) shown.
    await commands().find((command) => command.title === "down").run()
    await testRenderer.renderOnce()
    frame = testRenderer.captureCharFrame()
    expect(frame).toContain("created from chat")
    expect(frame).toContain("HTTP 403: bad token")
    expect(frame).toContain("https://sentry.example.test/issues")
    expect(frame).not.toContain("token={env:T}")

    await commands().find((command) => command.title === "poll now").run()
    expect(store.loadChannels().sources.sentry.pollRequestedAt).toBeNumber()
    // In use by an automation: delete refuses and says how to detach.
    await commands().find((command) => command.title === "delete").run()
    expect(store.loadChannels().defs.sentry).toBeDefined()
    expect(toasts.some((m) => m.includes("channel_delete with detach"))).toBe(true)
    // Automation keys do nothing on this tab.
    await commands().find((command) => command.title === "pause/resume").run()
    expect(store.loadJobs()[0].paused).toBeUndefined()
  } finally {
    stop?.()
    await testRenderer.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
