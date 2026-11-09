import { afterEach, expect, spyOn, test } from "bun:test"
import { EventEmitter, on } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../index.ts"
import { Store, type Job } from "../store.ts"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

async function start(options: Record<string, unknown> = {}, jobs: Job[] = []) {
  const dataDir = mkdtempSync(join(tmpdir(), "automations-server-"))
  const store = new Store(dataDir)
  store.saveJobs(jobs)
  const tools = new Map<string, any>()
  const commands = new Map<string, any>()
  const prompts: any[] = []
  const sessions: any[] = []
  const events = new EventEmitter()
  const hooks = new Map<string, (input: any) => void>()
  const ctx = {
    options: { dataDir, ...options },
    location: { directory: dataDir },
    tool: { transform: async (fn: any) => fn({ add: (tool: any) => tools.set(tool.name, tool) }) },
    command: { transform: async (fn: any) => fn({ add: (command: any) => commands.set(command.name, command) }) },
    session: {
      get: async ({ sessionID }: any) => ({ id: sessionID, time: {}, location: { directory: dataDir } }),
      create: async (input: any) => {
        sessions.push(input)
        return { id: `session-${sessions.length}` }
      },
      prompt: async (input: any) => { prompts.push(input) },
      interrupt: async () => {},
      hook: async (name: string, fn: any) => { hooks.set(name, fn); return { dispose: async () => {} } },
    },
    event: {
      async *subscribe({ signal }: { signal: AbortSignal }) {
        try {
          for await (const [event] of on(events, "event", { signal })) yield event
        } catch (error) { if (!signal.aborted) throw error }
      },
    },
  }
  cleanups.push(async () => { store.release(); rmSync(dataDir, { recursive: true, force: true }) })
  const stop = await plugin.setup(ctx as any)
  if (typeof stop === "function") cleanups.push(async () => { await stop() })
  await flush()
  const call = (name: string, input = {}, sessionID = "caller") => tools.get(name).execute(input, { sessionID })
  /** What the model would see for a session: system prompt additions and tool names. */
  const context = (sessionID: string) => {
    const c = { sessionID, system: [] as any[], tools: Object.fromEntries([...tools.keys()].map((k) => [k, {}])) }
    hooks.get("context")!(c)
    return { system: c.system.map((p) => p.text).join("\n"), tools: Object.keys(c.tools) }
  }
  return { store, tools, commands, prompts, sessions, events, call, context, dataDir }
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "morning", name: "Morning", prompt: "Check things", schedule: { kind: "every", ms: 60_000 },
    directory: process.cwd(), session: "new", timeoutMinutes: 30, runMissed: true, enabled: true,
    source: "tool", createdAt: Date.now() - 120_000, nextRunAt: Date.now() + 60_000, ...overrides,
  }
}

test("server loads with current command API and exposes working CRUD tools", async () => {
  const app = await start()
  expect(app.tools.size).toBe(7)
  const created = await app.call("automation_create", { name: "Audit", prompt: "Check dependencies", every: "1h" })
  expect(created.content).toContain("Audit")
  expect(app.store.loadJobs()[0].directory).toBe(app.dataDir)
  expect((await app.call("automation_list")).content).toContain("audit")
  await app.call("automation_update", { id: "audit", enabled: false })
  expect(app.store.loadJobs()[0].enabled).toBe(false)
  await app.call("automation_delete", { id: "audit" })
  expect(app.store.loadJobs()).toEqual([])
  expect(app.commands.has("automation")).toBe(true)
  await app.commands.get("automation").execute({ sessionID: "caller", prompt: { text: "list" }, delivery: "queue" })
  expect(app.prompts[0].text).toContain("automation_*")
  expect(app.prompts[0].text).toContain("list")
})

test("paused TUI jobs never fire automatically", async () => {
  const app = await start({}, [job({ paused: true, nextRunAt: Date.now() - 1000 })])
  expect(app.prompts).toEqual([])
  expect(app.store.loadJobs()[0].paused).toBe(true)
})

test("TUI run-now intent fires once even when paused without moving schedule", async () => {
  const nextRunAt = Date.now() + 60_000
  const app = await start({}, [job({ paused: true, runRequestedAt: Date.now(), nextRunAt })])
  expect(app.prompts).toHaveLength(1)
  expect(app.prompts[0].metadata.automation.reason).toBe("manual")
  expect(app.store.loadJobs()[0].runRequestedAt).toBeUndefined()
  expect(app.store.loadJobs()[0].nextRunAt).toBe(nextRunAt)
})

test("config jobs preserve TUI pause and manual run intent", async () => {
  const saved = job({ source: "config", paused: true, runRequestedAt: Date.now() })
  const app = await start({ jobs: [{ id: "morning", prompt: "Check things", every: "1m", directory: process.cwd() }] }, [saved])
  expect(app.prompts).toHaveLength(1)
  expect(app.store.loadJobs()[0].paused).toBe(true)
})

test("one-shot completion survives reload and run output reaches history", async () => {
  const app = await start({}, [job({ schedule: { kind: "at", time: Date.now() - 1000 }, nextRunAt: Date.now() - 1000 })])
  expect(app.prompts).toHaveLength(1)
  app.events.emit("event", { type: "session.text.ended", data: { sessionID: "session-1", text: "All clear" } })
  app.events.emit("event", { type: "session.idle", data: { sessionID: "session-1" } })
  await flush()
  expect(app.store.history()[0].status).toBe("succeeded")
  expect(app.store.history()[0].output).toBe("All clear")
  expect(app.store.loadJobs()[0].done).toBe(true)
})

test("V2 execution success completes the run without waiting for legacy idle", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
  try {
    const app = await start({ notify: { on: ["succeeded"], pushover: { token: "test-token", user: "test-user" } } }, [job({ timeoutMinutes: 0.001 })])
    await app.call("automation_run", { id: "morning" })
    app.events.emit("event", { type: "session.text.ended", data: { sessionID: "session-1", text: "Ok" } })
    app.events.emit("event", {
      id: "evt-success", type: "session.execution.succeeded", created: Date.now(),
      durable: { aggregateID: "session-1", seq: 3, version: 1 },
      location: { directory: app.dataDir }, data: { sessionID: "session-1" },
    })
    await flush()
    expect(app.store.history()[0]).toMatchObject({ status: "succeeded", output: "Ok" })
    expect(app.store.loadJobs()[0].lastStatus).toBe("succeeded")
    // A compatibility idle event must not produce another notification.
    app.events.emit("event", { type: "session.idle", data: { sessionID: "session-1" } })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(app.store.history()[0].status).toBe("succeeded")
    expect(fetch.mock.calls).toHaveLength(1)
    expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toMatchObject({ title: "Morning", priority: 0 })
  } finally { fetch.mockRestore() }
})

test("defaultModel reaches newly created sessions", async () => {
  const app = await start({ defaultModel: "anthropic/test-model" })
  await app.call("automation_create", { name: "Audit", prompt: "Check", every: "1h" })
  await app.call("automation_run", { id: "audit" })
  expect(app.sessions[0].model).toEqual({ providerID: "anthropic", id: "test-model" })
})

test("config definitions require an explicit working directory", async () => {
  await expect(start({ jobs: [{ id: "bad", prompt: "Check", every: "1m" }] })).rejects.toThrow("directory")
})

test("config pause through tools persists across reloads", async () => {
  const app = await start({ jobs: [{ id: "morning", prompt: "Check", every: "1m", directory: process.cwd() }] })
  await app.call("automation_update", { id: "morning", enabled: false })
  expect(app.store.loadJobs()[0].paused).toBe(true)
  expect((await app.call("automation_list")).content).toContain("[off, config]")
})

test("editing a completed one-shot schedule reactivates it", async () => {
  const app = await start({}, [job({ done: true, nextRunAt: undefined })])
  await app.call("automation_update", { id: "morning", every: "2h" })
  expect(app.store.loadJobs()[0].done).not.toBe(true)
  expect(app.store.loadJobs()[0].nextRunAt).toBeGreaterThan(Date.now())
})

const pushover = { pushover: { token: "test-token", user: "test-user" } }
const bodies = (fetch: any) => fetch.mock.calls.map((c: any) => JSON.parse(c[1]?.body as string))

test("the run's agent sends notifications itself; a successful run then sends nothing else", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
  try {
    const app = await start({ notify: { on: ["succeeded", "failed"], ...pushover } }, [job()])
    await app.call("automation_run", { id: "morning" })
    const sent = await app.call("automation_notify", {
      title: "2 MRs need you", message: "- **!12** blocked\n- !15 approved", priority: "high", url: "https://mr.test", url_title: "Open",
    }, "session-1")
    expect(sent.content).toContain("Sent via pushover")
    expect(bodies(fetch)).toEqual([{
      token: "test-token", user: "test-user", title: "2 MRs need you", message: "• <b>!12</b> blocked\n• !15 approved",
      html: 1, priority: 1, url: "https://mr.test", url_title: "Open",
    }])
    app.events.emit("event", { type: "session.text.ended", data: { sessionID: "session-1", text: "Done, notified." } })
    app.events.emit("event", { type: "session.idle", data: { sessionID: "session-1" } })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(fetch.mock.calls).toHaveLength(1) // the final reply is not sent
    expect(app.store.history()[0]).toMatchObject({ status: "succeeded", output: "Done, notified.", notifications: 1 })
    expect((await app.call("automation_history")).content).toContain("1 notified")
  } finally { fetch.mockRestore() }
})

test("failed runs notify automatically even after the agent notified", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
  try {
    const app = await start({ notify: pushover }, [job()])
    await app.call("automation_run", { id: "morning" })
    await app.call("automation_notify", { title: "Started", message: "Looking" }, "session-1")
    app.events.emit("event", { type: "session.execution.failed", data: { sessionID: "session-1", error: "model overloaded" } })
    for (let i = 0; i < 50 && fetch.mock.calls.length < 2; i++) await flush()
    expect(bodies(fetch)[1]).toMatchObject({ title: "Morning failed", message: '"model overloaded"', priority: 1 })
  } finally { fetch.mockRestore() }
})

test("a successful run without notifications is silent by default", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
  try {
    const app = await start({ notify: pushover }, [job()])
    await app.call("automation_run", { id: "morning" })
    app.events.emit("event", { type: "session.text.ended", data: { sessionID: "session-1", text: "All clear" } })
    app.events.emit("event", { type: "session.idle", data: { sessionID: "session-1" } })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(fetch.mock.calls).toHaveLength(0)
  } finally { fetch.mockRestore() }
})

test("automation_notify is limited per run and rejects text too long to split", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
  try {
    const app = await start({ notify: { maxPerRun: 2, ...pushover } }, [job()])
    await app.call("automation_run", { id: "morning" })
    const long = await app.call("automation_notify", { title: "Dump", message: "word ".repeat(1200) }, "session-1")
    expect(long.content).toContain("error: message is")
    expect(fetch.mock.calls).toHaveLength(0)
    expect((await app.call("automation_notify", { title: "A", message: "one" }, "session-1")).content).toContain("1 notifications left")
    expect((await app.call("automation_notify", { title: "B", message: "two" }, "session-1")).content).toContain("0 notifications left")
    expect((await app.call("automation_notify", { title: "C", message: "three" }, "session-1")).content).toContain("limit 2")
    expect(fetch.mock.calls).toHaveLength(2)
  } finally { fetch.mockRestore() }
})

test("automation_notify is offered, with guidance, only to runs that may notify", async () => {
  const app = await start({ notify: { native: true } }, [job(), job({ id: "quiet", name: "Quiet", notify: false })])
  await app.call("automation_run", { id: "morning" })
  await app.call("automation_run", { id: "quiet" })

  const run = app.context("session-1")
  expect(run.tools).toContain("automation_notify")
  expect(run.system).toContain('automation "Morning"')
  expect(run.system).toContain("not sent anywhere")
  expect(run.system).toContain("no markdown")
  expect(app.tools.get("automation_notify").description).toContain("full URLs")

  for (const sid of ["session-2", "caller"]) {
    const c = app.context(sid)
    expect(c.tools).not.toContain("automation_notify")
    expect(c.tools).toContain("automation_list")
    expect(c.system).toBe("")
  }
  expect((await app.call("automation_notify", { title: "x", message: "y" })).content).toContain("only available inside an automation run")
  expect((await app.call("automation_notify", { title: "x", message: "y" }, "session-2")).content).toContain("error")
})
