import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { render } from "@opentui/solid"
import { createTestRenderer } from "@opentui/core/testing"
import plugin from "../tui.tsx"
import { runningJobs } from "../jobs.ts"
import { Store, type Job } from "../store.ts"

type TuiContext = Parameters<typeof plugin.setup>[0]
type Layer = ReturnType<Parameters<TuiContext["keymap"]["layer"]>[0]>
type Command = NonNullable<Layer["commands"]>[number]
type Render = Parameters<TuiContext["ui"]["dialog"]["show"]>[0]
type ToastOptions = Parameters<TuiContext["ui"]["toast"]["show"]>[0]

/** A stand-in for the opencode TUI: what tui.tsx uses of it, and what the plugin did with it. */
function fakeHost(dataDir: string, renderer: unknown) {
  const layers: Layer[] = []
  const toasts: string[] = []
  const host = { dialog: undefined as Render | undefined, toasts, ctx: {} as TuiContext, command }
  // Minimal stand-in for @opencode/theme's ResolvedTheme (only the tokens tui.tsx reads).
  const color = "#aaaaaa"
  const feedback = Object.fromEntries(["success", "error", "warning", "info"].map((name) => [name, { base: color, muted: color }]))
  const scale = Object.fromEntries([100, 200, 300, 400, 500, 600, 700, 800, 900].map((step) => [step, color]))
  const theme = {
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
    surface: (): unknown => theme,
  }
  const ctx = {
    renderer,
    options: { dataDir, notify: "off" },
    location: { directory: dataDir },
    themeMode: "dark",
    theme,
    keymap: { layer: (factory: () => Layer) => { layers.push(factory()) } },
    ui: {
      toast: { show: (t: ToastOptions) => { toasts.push(t.message) } },
      router: { navigate: () => {} },
      dialog: {
        show: (render: Render) => { host.dialog = render }, set: () => {}, clear: () => { host.dialog = undefined }, confirm: async () => true,
      },
      slot: () => () => {},
      format: { path: (path: string) => path },
    },
  }
  // Only the parts tui.tsx reads: the rest of the TUI's context isn't there.
  host.ctx = ctx as unknown as TuiContext
  /** The first registered command that matches. */
  function command(match: (command: Command) => boolean): Command {
    const found = layers.flatMap((layer) => layer.commands ?? []).find(match)
    if (!found) throw new Error("no such command")
    return found
  }
  return host
}

test("TUI renders automations page and persists pause/run-now actions", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "automations-tui-"))
  const store = new Store(dataDir)
  store.saveJobs([{
    id: "morning", name: "Morning triage", prompt: "Check merge requests", schedule: { kind: "every", ms: 60_000 },
    directory: dataDir, session: "new", timeoutMinutes: 30, runMissed: true, enabled: true,
    source: "tool", createdAt: Date.now(), nextRunAt: Date.now() + 60_000,
  } satisfies Job])
  store.enqueue({ job: "morning", title: "3 MRs need you", body: "!12 blocked", priority: "normal" }, ["phone"])
  const testRenderer = await createTestRenderer({ width: 120, height: 45 })
  const host = fakeHost(dataDir, testRenderer.renderer)
  let stop: Awaited<ReturnType<typeof plugin.setup>> | undefined
  try {
    stop = await plugin.setup(host.ctx)
    const open = host.command((command) => command.id === "automations.open")
    expect(open.slash?.name).toBe("automations")
    expect(open.slash?.aliases ?? []).toEqual([])
    await open.run()
    expect(host.dialog).toBeFunction()
    // Stand-in for opencode's dialog container: full screen, centered, fixed 116-column box.
    await render(
      () => (
        <box position="absolute" left={0} top={0} width={120} height={45} alignItems="center" justifyContent="center">
          <box width={116} paddingTop={1}>
            {host.dialog!()}
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
    // What it told the user, and where that stands.
    expect(frame).toContain("3 MRs need you")
    expect(frame).toMatch(/phone\s+pending/)
    await host.command((command) => command.title === "pause/resume").run()
    expect(store.loadJobs()[0].paused).toBe(true)
    await host.command((command) => command.title === "run now").run()
    expect(store.loadJobs()[0].runRequestedAt).toBeNumber()
    expect(store.loadJobs()[0].paused).toBe(true)
    await testRenderer.renderOnce()
    expect(testRenderer.captureCharFrame()).toContain("paused")
  } finally {
    if (typeof stop === "function") stop()
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
  const polled = Date.now() - 30_000
  await store.mutateChannels((s) => {
    s.config.datadog = {
      name: "Datadog", url: "https://api.example.test/api/v1/monitor", everyMs: 60_000, items: "",
      filter: { overall_state: ["Alert"] }, event: { id: "{id}:{overall_state_modified}", sessionKey: "{id}", title: "{name}" }, env: ["DD_API_KEY"],
    }
    s.defs.sentry = { id: "sentry", name: "Sentry", every: "5m", request: { url: "https://sentry.example.test/issues?token={env:T}" }, event: { id: "{id}" } }
    s.sources.datadog = { lastPollAt: polled, lastOkAt: polled }
    s.sources.sentry = { lastPollAt: Date.now(), lastError: "HTTP 403: bad token", failures: 3 }
  })
  // The latest poll's event waits for the automation attached to the channel.
  store.ingest("datadog", [{ channel: "datadog", id: "1:t", title: "CPU high on web-1" }], polled)
  store.subscribe(store.loadJobs(), { datadog: polled })
  store.setNote("triage", "datadog:42", "Monitor 42 flapping since 09:10.")
  const testRenderer = await createTestRenderer({ width: 140, height: 50 })
  const host = fakeHost(dataDir, testRenderer.renderer)
  let stop: Awaited<ReturnType<typeof plugin.setup>> | undefined
  try {
    stop = await plugin.setup(host.ctx)
    await host.command((command) => command.id === "automations.open").run()
    await render(
      () => (
        <box position="absolute" left={0} top={0} width={140} height={50} alignItems="center" justifyContent="center">
          <box width={116} paddingTop={1}>
            {host.dialog!()}
          </box>
        </box>
      ),
      testRenderer.renderer,
    )
    await testRenderer.renderOnce()
    await testRenderer.renderOnce()
    // Automations tab: the job lists its channels.
    expect(testRenderer.captureCharFrame()).toContain("datadog, sentry")
    // Its memory, per session key.
    expect(testRenderer.captureCharFrame()).toContain("datadog:42 · updated")
    expect(testRenderer.captureCharFrame()).toContain("Monitor 42 flapping since 09:10.")

    await host.command((command) => command.bind === "c").run()
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
    await host.command((command) => command.title === "down").run()
    await testRenderer.renderOnce()
    frame = testRenderer.captureCharFrame()
    expect(frame).toContain("created from chat")
    expect(frame).toContain("HTTP 403: bad token")
    expect(frame).toContain("https://sentry.example.test/issues")
    expect(frame).not.toContain("token={env:T}")

    await host.command((command) => command.title === "poll now").run()
    expect(store.loadChannels().sources.sentry.pollRequestedAt).toBeNumber()
    // In use by an automation: delete refuses and says how to detach.
    await host.command((command) => command.title === "delete").run()
    expect(store.loadChannels().defs.sentry).toBeDefined()
    expect(host.toasts.some((m) => m.includes("channel_delete with detach"))).toBe(true)
    // Automation keys do nothing on this tab.
    await host.command((command) => command.title === "pause/resume").run()
    expect(store.loadJobs()[0].paused).toBeUndefined()
  } finally {
    if (typeof stop === "function") stop()
    await testRenderer.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test("a run left running by a crash stops counting as running once its timeout has passed", () => {
  const jobs: Job[] = [{
    id: "a", name: "A", prompt: "p", schedule: { kind: "every", ms: 60_000 }, directory: "/project", session: "new",
    timeoutMinutes: 10, runMissed: true, enabled: true, source: "tool", createdAt: 0,
  }]
  const run = { jobID: "a", runID: "r", startedAt: 0, status: "running" as const }
  expect([...runningJobs(jobs, [run], 5 * 60_000)]).toEqual(["a"])
  expect([...runningJobs(jobs, [run], 12 * 60_000)]).toEqual([])
  expect([...runningJobs(jobs, [{ ...run, status: "succeeded" }], 60_000)]).toEqual([])
})
