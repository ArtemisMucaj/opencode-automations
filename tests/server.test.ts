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
  const call = (name: string, input = {}) => tools.get(name).execute(input, { sessionID: "caller" })
  return { store, tools, commands, prompts, sessions, events, call, dataDir }
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "morning", name: "Morning", prompt: "Check things", schedule: { kind: "every", ms: 60_000 },
    directory: process.cwd(), session: "new", timeoutMinutes: 30, catchUp: true, enabled: true,
    source: "tool", createdAt: Date.now() - 120_000, nextRunAt: Date.now() + 60_000, ...overrides,
  }
}

test("server loads with current command API and exposes working CRUD tools", async () => {
  const app = await start()
  expect(app.tools.size).toBe(6)
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

test("finished runs send configured Pushover notifications", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
  try {
    const app = await start({ notify: { pushover: { token: "test-token", user: "test-user" } } }, [job()])
    await app.call("automation_run", { id: "morning" })
    app.events.emit("event", { type: "session.text.ended", data: { sessionID: "session-1", text: "All clear" } })
    app.events.emit("event", { type: "session.idle", data: { sessionID: "session-1" } })
    for (let i = 0; i < 50 && !fetch.mock.calls.length; i++) await flush()
    expect(fetch.mock.calls).toHaveLength(1)
    const [url, input] = fetch.mock.calls[0]
    expect(url).toBe("https://api.pushover.net/1/messages.json")
    expect(JSON.parse(input?.body as string)).toMatchObject({ token: "test-token", user: "test-user", message: "All clear", priority: 0 })
  } finally { fetch.mockRestore() }
})
