import { afterEach, expect, spyOn, test } from "bun:test"
import { EventEmitter, on } from "node:events"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../index.ts"
import { cacheLifetime } from "../cache.ts"
import { Store, type Job, type Memory } from "../store.ts"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

async function start(options: Record<string, unknown> = {}, jobs: Job[] = [], seed?: (store: Store) => Promise<void>) {
  const dataDir = mkdtempSync(join(tmpdir(), "automations-server-"))
  const store = new Store(dataDir)
  store.saveJobs(jobs)
  await seed?.(store)
  const tools = new Map<string, any>()
  const namespaces: any[] = []
  const removed: string[] = []
  const commands = new Map<string, any>()
  const prompts: any[] = []
  const sessions: any[] = []
  /** Compactions asked for, with the summary the plugin's compaction hook gave. */
  const compactions: Array<{ sessionID: string; summary?: string }> = []
  /** Whether compact() rejects the call. */
  const compactMode = { value: "ok" as "ok" | "throw" }
  const events = new EventEmitter()
  const hooks = new Map<string, (input: any) => void>()
  const ctx = {
    options: { dataDir, ...options },
    location: { directory: dataDir },
    // Keyed by the exposed name: namespace_name for namespaced tools, as opencode exposes them.
    tool: {
      transform: async (fn: any) => fn({
        add: (tool: any) => tools.set(tool.options?.namespace ? `${tool.options.namespace}_${tool.name}` : tool.name, tool),
        namespace: (ns: any) => namespaces.push(ns),
      }),
    },
    command: { transform: async (fn: any) => fn({ add: (command: any) => commands.set(command.name, command) }) },
    session: {
      get: async ({ sessionID }: any) => ({ id: sessionID, time: {}, location: { directory: dataDir } }),
      create: async (input: any) => {
        sessions.push(input)
        return { id: `session-${sessions.length}` }
      },
      prompt: async (input: any) => { prompts.push(input) },
      // Like opencode: the compaction hook may supply the summary, and the compaction's end event comes after it returns.
      compact: async ({ sessionID }: any) => {
        if (compactMode.value === "throw") throw new Error("no compact endpoint")
        const c: any = { sessionID, system: [], messages: [], tools: {}, options: {} }
        hooks.get("compaction")?.(c)
        compactions.push({ sessionID, summary: c.result?.summary })
        setTimeout(() => events.emit("event", { type: "session.execution.succeeded", data: { sessionID } }), 0)
        return { id: "msg_compaction", sessionID, type: "compaction" }
      },
      wait: async () => {},
      remove: async ({ sessionID }: any) => { removed.push(sessionID) },
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
  const teardown = await plugin.setup(ctx as any)
  let stopped = false
  const stop = async () => { if (!stopped && typeof teardown === "function") { stopped = true; await teardown() } }
  cleanups.push(stop)
  await flush()
  const call = (name: string, input = {}, sessionID = "caller") => tools.get(name).execute(input, { sessionID })
  /** What the model would see for a session: system prompt additions and tool names. */
  const context = (sessionID: string, options: Record<string, unknown> = {}) => {
    const c = { sessionID, options, system: [] as any[], tools: Object.fromEntries([...tools.keys()].map((k) => [k, {}])) }
    hooks.get("context")!(c)
    return { system: c.system.map((p) => p.text).join("\n"), tools: Object.keys(c.tools) }
  }
  /** The summary the plugin's compaction hook would give a compaction of this session now. */
  const compactionSummary = (sessionID: string) => {
    const c: any = { sessionID }
    hooks.get("compaction")?.(c)
    return c.result?.summary as string | undefined
  }
  return { store, tools, namespaces, commands, prompts, sessions, compactions, compactMode, removed, events, call, context, compactionSummary, dataDir, stop, ctx }
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
  expect(app.tools.size).toBe(13)
  const created = await app.call("automation_create", { name: "Audit", prompt: "Check dependencies", every: "1h" })
  expect(created.content).toContain("Audit")
  expect(app.store.loadJobs()[0].directory).toBe(app.dataDir)
  expect((await app.call("automation_list")).content).toContain("audit")
  await app.call("automation_update", { id: "audit", enabled: false })
  expect(app.store.loadJobs()[0]).toMatchObject({ paused: true, enabled: true })
  await app.call("automation_delete", { id: "audit" })
  expect(app.store.loadJobs()).toEqual([])
  expect(app.commands.has("automation")).toBe(true)
  await app.commands.get("automation").execute({ sessionID: "caller", prompt: { text: "list" }, delivery: "queue" })
  expect(app.prompts[0].text).toContain("automation_create")
  expect(app.prompts[0].text).toContain("list")
  expect(app.commands.has("channel")).toBe(true)
  await app.commands.get("channel").execute({ sessionID: "caller", prompt: { text: "datadog alerts" }, delivery: "queue" })
  expect(app.prompts.at(-1).text).toContain("channel_create")
  expect(app.prompts.at(-1).text).toContain("Request: datadog alerts")
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

test("one-shot completion survives reload; the history keeps the outcome, not what the run said", async () => {
  const app = await start({}, [job({ schedule: { kind: "at", time: Date.now() - 1000 }, nextRunAt: Date.now() - 1000 })])
  expect(app.prompts).toHaveLength(1)
  app.events.emit("event", { type: "session.text.ended", data: { sessionID: "session-1", text: "All clear" } })
  app.events.emit("event", { type: "session.idle", data: { sessionID: "session-1" } })
  await flush()
  expect(app.store.history()[0].status).toBe("succeeded")
  expect(app.store.history()[0]).not.toHaveProperty("output")
  expect(app.store.loadJobs()[0].done).toBe(true)
})

test("V2 execution success completes the run without waiting for legacy idle", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
  try {
    const app = await start({ notify: { on: ["succeeded"], pushover: { token: "test-token", user: "test-user" } } }, [job({ timeoutMinutes: 0.001 })])
    await app.call("automation_run", { id: "morning" })
    app.events.emit("event", { type: "session.text.ended", data: { sessionID: "session-1", text: "Ok\nNothing worth notifying the user about in this run." } })
    app.events.emit("event", {
      id: "evt-success", type: "session.execution.succeeded", created: Date.now(),
      durable: { aggregateID: "session-1", seq: 3, version: 1 },
      location: { directory: app.dataDir }, data: { sessionID: "session-1" },
    })
    await flush()
    expect(app.store.history()[0]).toMatchObject({ status: "succeeded" })
    expect(app.store.loadJobs()[0].lastStatus).toBe("succeeded")
    // A compatibility idle event must not finish the run again.
    app.events.emit("event", { type: "session.idle", data: { sessionID: "session-1" } })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(app.store.history()[0].status).toBe("succeeded")
    // Success is never notified automatically, even with "succeeded" in `on`.
    expect(fetch.mock.calls).toHaveLength(0)
  } finally { fetch.mockRestore() }
})

test("the old session name reuse still loads, as sticky", async () => {
  const app = await start(
    { jobs: [{ id: "cfg", prompt: "p", every: "1h", directory: process.cwd(), session: "reuse" }] },
    [job({ session: "reuse" as any })],
  )
  const jobs = app.store.loadJobs()
  expect(jobs.find((j) => j.id === "morning")?.session).toBe("sticky")
  expect(jobs.find((j) => j.id === "cfg")?.session).toBe("sticky")
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
    const app = await start({ notify: pushover }, [job()])
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
    expect(app.store.history()[0]).toMatchObject({ status: "succeeded", notifications: 1 })
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

test("a successful run that says there is nothing to report is silent", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
  try {
    const app = await start({ notify: pushover }, [job()])
    await app.call("automation_run", { id: "morning" })
    app.events.emit("event", { type: "session.text.ended", data: { sessionID: "session-1", text: "All clear.\nnothing worth notifying the user about in this run" } })
    app.events.emit("event", { type: "session.idle", data: { sessionID: "session-1" } })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(fetch.mock.calls).toHaveLength(0)
    expect(app.prompts).toHaveLength(1) // no check turn
    expect(app.store.history()[0].status).toBe("succeeded")
  } finally { fetch.mockRestore() }
})

test("a run that ends silently without saying why is asked once whether to notify", async () => {
  const app = await start({ notify: pushover }, [job()])
  await app.call("automation_run", { id: "morning" })
  app.events.emit("event", { type: "session.text.ended", data: { sessionID: "session-1", text: "MR !12 is blocked." } })
  app.events.emit("event", { type: "session.execution.succeeded", data: { sessionID: "session-1" } })
  await flush()
  expect(app.prompts).toHaveLength(2)
  expect(app.prompts[1]).toMatchObject({ sessionID: "session-1", delivery: "queue" })
  expect(app.prompts[1].text).toContain("automation_notify")
  expect(app.prompts[1].metadata.automation).toMatchObject({ jobID: "morning", reason: "check" })
  expect(app.store.history()[0].status).toBe("running")
  // A legacy idle after the V2 event doesn't end the check turn early.
  app.events.emit("event", { type: "session.idle", data: { sessionID: "session-1" } })
  await flush()
  expect(app.store.history()[0].status).toBe("running")
  // The check turn ends the run, whatever it answered, and isn't asked again.
  app.events.emit("event", { type: "session.text.ended", data: { sessionID: "session-1", text: "Sent." } })
  app.events.emit("event", { type: "session.execution.succeeded", data: { sessionID: "session-1" } })
  await flush()
  expect(app.prompts).toHaveLength(2)
  expect(app.store.history()[0]).toMatchObject({ status: "succeeded" })
})

test("runs that can't notify are never asked", async () => {
  const app = await start({ notify: pushover }, [job({ notify: false })])
  await app.call("automation_run", { id: "morning" })
  app.events.emit("event", { type: "session.text.ended", data: { sessionID: "session-1", text: "Done" } })
  app.events.emit("event", { type: "session.idle", data: { sessionID: "session-1" } })
  await flush()
  expect(app.prompts).toHaveLength(1)
  expect(app.store.history()[0].status).toBe("succeeded")
})

test("automation_notify is limited per run and rejects text too long to split", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
  try {
    const app = await start({ notify: { maxPerRun: 2, ...pushover } }, [job()])
    await app.call("automation_run", { id: "morning" })
    const long = await app.call("automation_notify", { title: "Dump", message: ("word ".repeat(30) + "\n").repeat(40) }, "session-1")
    expect(long.content).toContain("error: message is")
    const wall = await app.call("automation_notify", { title: "Brief", message: "This sentence goes on. ".repeat(10) + "https://x.test/" + "a".repeat(300) }, "session-1")
    expect(wall.content).toContain("too long to read on a phone")
    expect(fetch.mock.calls).toHaveLength(0)
    // Long links alone don't make a line too long.
    expect((await app.call("automation_notify", { title: "Link", message: "MR ready:\nhttps://x.test/" + "a".repeat(300) }, "session-1")).content).toContain("1 notifications left")
    expect((await app.call("automation_notify", { title: "B", message: "two" }, "session-1")).content).toContain("0 notifications left")
    expect((await app.call("automation_notify", { title: "C", message: "three" }, "session-1")).content).toContain("limit 2")
    expect(fetch.mock.calls).toHaveLength(2)
  } finally { fetch.mockRestore() }
})

// ---------- channels ----------

const channel = (overrides: Record<string, unknown> = {}) => ({
  id: "dd", name: "Datadog", every: "1m",
  request: { url: "https://api.dd.test/api/v1/monitor" },
  filter: { overall_state: "Alert" },
  event: { id: "{id}:{overall_state_modified}", sessionKey: "{id}", title: "{name}", body: "{message}" },
  ...overrides,
})
const triage = (overrides: Record<string, unknown> = {}) => ({
  id: "triage", name: "Alert triage", prompt: "Investigate these alerts.", directory: process.cwd(), on: { channel: "dd" }, ...overrides,
})
const monitor = (id: number, modified = "t1", state = "Alert") =>
  ({ id, name: `Monitor ${id}`, overall_state: state, overall_state_modified: modified, message: `details ${id}` })
/** A fetch that answers channel polls with `monitors()` and anything else (Pushover) with ok. */
const api = (monitors: () => unknown[]) => spyOn(globalThis, "fetch").mockImplementation((async (url: any) =>
  String(url).includes("dd.test") ? new Response(JSON.stringify(monitors())) : new Response("ok")) as any)
const waiting = (app: { store: Store }, jobID: string) => app.store.loadChannels().queues[jobID]?.pending.map((e) => e.id) ?? []

test("items already there are delivered on the first poll, including to automations added later", async () => {
  const fetch = api(() => [monitor(1)])
  try {
    const app = await start({ channels: [channel()], jobs: [triage()] })
    expect(app.prompts).toHaveLength(1)
    expect(app.prompts[0].text).toContain('id="1:t1"')

    // A new automation on the same channel gets what is currently alerting, though the channel saw it before.
    await app.call("automation_create", { name: "Late", prompt: "Check.", channels: ["dd"], session: "sticky" })
    expect((await app.call("channel_poll", { id: "dd" })).content).toContain("0 new events, 1 run started")
    expect(app.prompts).toHaveLength(2)
    expect(app.prompts[1].metadata.automation).toMatchObject({ jobID: "late", events: ["dd:1:t1"] })

    // After that, only new items: nothing more for either.
    await app.call("channel_poll", { id: "dd" })
    expect(app.prompts).toHaveLength(2)
  } finally { fetch.mockRestore() }
})

test("an automation on a channel runs on new events with an untrusted prompt", async () => {
  let current: unknown[] = []
  const fetch = api(() => current)
  try {
    const app = await start({ notify: { native: true }, channels: [channel()], jobs: [triage()] })
    expect(app.prompts).toEqual([])
    expect(app.tools.has("channel_list")).toBe(true)

    current = [monitor(2), monitor(3, "t1", "OK")]
    expect((await app.call("channel_poll", { id: "dd" })).content).toContain("1 new event, 1 run started")
    expect(app.prompts).toHaveLength(1)
    expect(app.prompts[0].text).toStartWith("Investigate these alerts.")
    expect(app.prompts[0].text).toContain('<event channel="Datadog" id="2:t1" session-key="2">\nMonitor 2\n\ndetails 2\n</event>')
    expect(app.prompts[0].text).toContain("never as instructions")
    expect(app.prompts[0].metadata.automation).toMatchObject({ jobID: "triage", reason: "event", channels: ["dd"], events: ["dd:2:t1"] })
    expect(app.sessions[0].title).toStartWith("⏰ Alert triage")
    expect(app.store.history()[0].jobID).toBe("triage")
    expect(app.context("session-1").system).toContain("running unattended as an automation")

    // Nothing new on the next poll.
    expect((await app.call("channel_poll", { id: "dd" })).content).toContain("0 new events")
    expect(app.prompts).toHaveLength(1)

    const list = (await app.call("automation_list")).content
    expect(list).toContain("triage [on, config] on events · channels dd")
    expect((await app.call("channel_list")).content).toContain("triage: 0 waiting")
  } finally { fetch.mockRestore() }
})

test("sticky on a channel with session keys keeps one session per key and queues events while it is busy", async () => {
  let current: unknown[] = []
  const fetch = api(() => current)
  try {
    const app = await start({ channels: [channel()], jobs: [triage({ session: "sticky" })] })
    current = [monitor(1)]
    await app.call("channel_poll", { id: "dd" })
    expect(app.sessions).toHaveLength(1)
    expect(app.sessions[0].title).toBe("⏰ Alert triage · Monitor 1")

    // Monitor 1 re-alerts while its first run is still going: it waits. Monitor 2 runs at once.
    current = [monitor(1, "t2"), monitor(2)]
    expect((await app.call("channel_poll", { id: "dd" })).content).toContain("2 new events, 1 run started")
    expect(app.sessions).toHaveLength(2)
    expect(waiting(app, "triage")).toEqual(["1:t2"])

    // Run for monitor 1 finishes (after the one follow-up asking for a note); the waiting event goes to the same session, queued.
    const usedAt = app.store.loadChannels().queues.triage.sessions["dd:1"].at
    app.events.emit("event", { type: "session.idle", data: { sessionID: "session-1" } })
    await flush()
    expect(app.prompts.at(-1)).toMatchObject({ sessionID: "session-1", metadata: { automation: { reason: "check" } } })
    app.events.emit("event", { type: "session.idle", data: { sessionID: "session-1" } })
    await flush()
    await app.call("channel_poll", { id: "dd" })
    // Going to an existing session marks it as used again.
    expect(app.store.loadChannels().queues.triage.sessions["dd:1"]).toMatchObject({ id: "session-1" })
    expect(app.store.loadChannels().queues.triage.sessions["dd:1"].at).toBeGreaterThan(usedAt)
    expect(app.sessions).toHaveLength(2)
    const last = app.prompts.at(-1)
    expect(last.sessionID).toBe("session-1")
    expect(last.delivery).toBe("queue")
    expect(last.text).toContain('id="1:t2"')
    expect(waiting(app, "triage")).toEqual([])
  } finally { fetch.mockRestore() }
})

test("sticky without session keys keeps one session; new ignores session keys", async () => {
  let current: unknown[] = []
  const fetch = api(() => current)
  try {
    const app = await start({
      channels: [channel(), channel({ id: "plain", event: { id: "{id}:{overall_state_modified}", title: "{name}" } })],
      jobs: [triage({ id: "one", on: { channel: "plain" }, session: "sticky" }), triage({ id: "fresh", session: "new" })],
    })
    current = [monitor(1), monitor(2)]
    await app.call("channel_poll", { id: "plain" })
    await app.call("channel_poll", { id: "dd" })
    // "one" gets both monitors in its single session; "fresh" gets both in one new session, not one per key.
    expect(app.prompts.map((p) => p.metadata.automation.jobID)).toEqual(["one", "fresh"])
    expect(app.prompts.every((p) => p.text.includes('id="1:t1"') && p.text.includes('id="2:t1"'))).toBe(true)
    expect(app.store.loadJobs().find((j) => j.id === "one")?.sessionID).toBe(app.prompts[0].sessionID)
  } finally { fetch.mockRestore() }
})

test("one automation runs on several channels; same IDs and keys from different channels stay apart", async () => {
  let dd: unknown[] = []
  let sentry: unknown[] = []
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (url: any) => {
    const u = String(url)
    if (u.includes("dd.test")) return new Response(JSON.stringify(dd))
    if (u.includes("sentry.test")) return new Response(JSON.stringify(sentry))
    return new Response("ok")
  }) as any)
  try {
    const app = await start({
      channels: [channel(), channel({ id: "sentry", name: "Sentry", request: { url: "https://sentry.test/issues" } })],
      jobs: [triage({ on: { channels: ["dd", "sentry"] }, session: "sticky" })],
    })
    // Monitor 1 and Sentry issue 1: same id and session key, different channels.
    dd = [monitor(1)]
    sentry = [monitor(1)]
    await app.call("channel_poll", { id: "dd" })
    await app.call("channel_poll", { id: "sentry" })
    expect(app.sessions).toHaveLength(2) // one per channel:key, not one shared "1"
    expect(app.prompts[0].text).toContain('<event channel="Datadog" id="1:t1"')
    expect(app.prompts[1].text).toContain('<event channel="Sentry" id="1:t1"')
    expect(Object.keys(app.store.loadChannels().queues.triage.sessions).sort()).toEqual(["dd:1", "sentry:1"])
    expect((await app.call("channel_list")).content).toContain("triage: 0 waiting")
    expect((await app.call("automation_list")).content).toContain("channels dd, sentry")
  } finally { fetch.mockRestore() }
})

test("automation_update changes the channels of a chat-created automation", async () => {
  const fetch = api(() => [])
  try {
    const app = await start({ channels: [channel(), channel({ id: "sentry", request: { url: "https://dd.test/sentry" } })] })
    await app.call("automation_create", { name: "Watch", prompt: "p", channels: ["dd"] })
    expect((await app.call("automation_update", { id: "watch", channels: ["dd", "sentry"] })).content).toContain("channels dd, sentry")
    expect(app.store.loadJobs()[0].on).toEqual({ channels: ["dd", "sentry"] })
    expect((await app.call("automation_update", { id: "watch", channels: ["nope"] })).content).toContain('no channel "nope"')
    // Event-only: can't drop all channels without giving it a schedule.
    expect((await app.call("automation_update", { id: "watch", channels: [] })).content).toContain("give it a schedule")
    expect((await app.call("automation_update", { id: "watch", channels: [], every: "1h" })).content).toContain("every 1h")
    expect(app.store.loadJobs()[0].on).toBeUndefined()
  } finally { fetch.mockRestore() }
})

test("one channel feeds several automations; a digest waits for its schedule", async () => {
  let current: unknown[] = []
  const fetch = api(() => current)
  try {
    const app = await start({
      channels: [channel()],
      jobs: [triage(), triage({ id: "digest", name: "Digest", prompt: "Summarise today's alerts.", every: "1h" })],
    })
    current = [monitor(1), monitor(2)]
    await app.call("channel_poll", { id: "dd" })
    expect(app.prompts).toHaveLength(1) // triage only
    expect(app.prompts[0].metadata.automation.jobID).toBe("triage")
    expect(waiting(app, "digest")).toEqual(["1:t1", "2:t1"])

    // The digest's run takes everything that waited, in one prompt.
    await app.call("automation_run", { id: "digest" })
    expect(app.prompts).toHaveLength(2)
    expect(app.prompts[1].text).toStartWith("Summarise today's alerts.")
    expect(app.prompts[1].text).toContain("2 new events")
    expect(waiting(app, "digest")).toEqual([])

    // Run again with nothing waiting: it says so instead of skipping.
    app.events.emit("event", { type: "session.idle", data: { sessionID: app.prompts[1].sessionID } })
    await flush()
    await app.call("automation_run", { id: "digest" })
    expect(app.prompts[2].text).toContain("No new events")
  } finally { fetch.mockRestore() }
})

test("channels nobody listens to aren't polled, and paused automations get no events", async () => {
  let polls = 0
  let current: unknown[] = []
  const fetch = api(() => { polls++; return current })
  try {
    const app = await start({ channels: [channel()], jobs: [triage({ enabled: false })] })
    expect(polls).toBe(0)
    expect((await app.call("channel_list")).content).toContain("triage (off): 0 waiting")
    // A manual poll still works, and queues nothing for the disabled automation.
    await app.call("channel_poll", { id: "dd" })
    current = [monitor(1)]
    await app.call("channel_poll", { id: "dd" })
    expect(polls).toBe(2)
    expect(waiting(app, "triage")).toEqual([])
    expect(app.prompts).toEqual([])
  } finally { fetch.mockRestore() }
})

test("a channel that keeps failing notifies once and shows its error", async () => {
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (url: any) =>
    String(url).includes("dd.test") ? new Response("bad key", { status: 403 }) : new Response("ok")) as any)
  try {
    const app = await start({ notify: pushover, channels: [channel()], jobs: [triage()] })
    for (let i = 0; i < 4; i++) await app.call("channel_poll", { id: "dd" })
    await flush()
    const notices = fetch.mock.calls.filter((c: any) => String(c[0]).includes("pushover")).map((c: any) => JSON.parse(c[1].body))
    expect(notices).toHaveLength(1)
    expect(notices[0].title).toBe("Channel Datadog can't poll")
    expect(notices[0].message).toContain("HTTP 403: bad key")
    expect((await app.call("channel_list")).content).toContain("FAILED (5x): HTTP 403")
  } finally { fetch.mockRestore() }
})

test("a poll still running at shutdown starts nothing and is waited for", async () => {
  let release!: () => void
  let polled = 0
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (_url: any, init: any) => {
    polled++
    if (polled === 1) return new Response("[]") // first poll primes
    // Second poll hangs until shutdown aborts it.
    await new Promise<void>((resolve) => { release = resolve; init.signal.addEventListener("abort", () => resolve()) })
    return new Response(JSON.stringify([monitor(1)]))
  }) as any)
  try {
    const app = await start({ channels: [channel()], jobs: [triage()] })
    const pending = app.call("channel_poll", { id: "dd" })
    await flush()
    await app.stop()
    release()
    expect((await pending).content).toContain("plugin is stopping")
    expect(app.prompts).toEqual([])
    expect(app.sessions).toEqual([])
  } finally { fetch.mockRestore() }
})

test("channel state starts in an empty data dir without a pre-made file", async () => {
  const app = await start()
  expect(await app.store.mutateChannels((s) => { s.sources.x = { seen: ["a"] }; return 1 })).toBe(1)
  expect(app.store.loadChannels().sources.x.seen).toEqual(["a"])
})

test("channel settings are validated for config and chat-created automations", async () => {
  const app = await start()
  expect((await app.call("channel_list")).content).toContain("No channels")
  await expect(start({ channels: [channel({ request: {} })] })).rejects.toThrow("request.url")
  await expect(start({ jobs: [triage()] })).rejects.toThrow('no channel "dd"')
  // No schedule is only allowed with a channel.
  await expect(start({ jobs: [{ id: "x", prompt: "p", directory: process.cwd() }] })).rejects.toThrow("exactly one")

  const withChannel = await start({ channels: [channel()] })
  expect((await withChannel.call("automation_create", { name: "Triage", prompt: "p", channels: ["nope"] })).content).toContain('error: no channel "nope"')
  const created = await withChannel.call("automation_create", { name: "Triage", prompt: "p", channels: ["dd"], session: "sticky" })
  expect(created.content).toContain("runs on events from dd, session=sticky")
  expect(withChannel.store.loadJobs()[0]).toMatchObject({ on: { channels: ["dd"] }, schedule: { kind: "event" }, session: "sticky" })
})

test("automation_notify is offered, with guidance, only to runs that may notify", async () => {
  const app = await start({ notify: { native: true } }, [job(), job({ id: "quiet", name: "Quiet", notify: false })])
  await app.call("automation_run", { id: "morning" })
  await app.call("automation_run", { id: "quiet" })

  const run = app.context("session-1")
  expect(run.tools).toContain("automation_notify")
  expect(run.system).toContain("running unattended as an automation")
  expect(run.system).toEndWith('This run is for the automation "Morning" (id: morning). Each run starts in a new session. You can send up to 5 notifications in this run.')
  expect(run.system).toContain("not sent anywhere")
  expect(run.system).toContain("no markdown")
  expect(app.tools.get("automation_notify").description).toContain("full URLs")

  for (const sid of ["session-2", "caller"]) {
    const c = app.context(sid)
    expect(c.tools).not.toContain("automation_notify")
    expect(c.tools).toContain("automation_list")
  }
  // A run that can't notify gets only its run context; a chat that isn't a run gets nothing.
  expect(app.context("session-2").system).toBe('This run is for the automation "Quiet" (id: quiet). Each run starts in a new session.')
  expect(app.context("caller").system).toBe("")
  expect((await app.call("automation_notify", { title: "x", message: "y" })).content).toContain("only available inside an automation run")
  expect((await app.call("automation_notify", { title: "x", message: "y" }, "session-2")).content).toContain("error")
})

// ---------- sticky memory ----------

/** The memory of a job's sticky session, or of one of its session keys. */
const memory = (store: Store, jobID: string, key?: string) =>
  key === undefined ? store.loadJobs().find((j) => j.id === jobID)?.memory : store.loadChannels().queues[jobID]?.sessions[key]
/** Change it in place: on the job, or on the key's entry in the channel queue. */
const setMemory = (store: Store, jobID: string, key: string | undefined, fn: (m: Memory) => void) =>
  key === undefined
    ? store.mutate((jobs) => { fn(jobs.find((j) => j.id === jobID)!.memory!) })
    : store.mutateChannels((s) => { fn(s.queues[jobID].sessions[key]) })
/** Make a job's (or key's) sticky session look cold: its cache went cold a while ago. */
const chill = (store: Store, jobID: string, key?: string) => setMemory(store, jobID, key, (m) => { m.warmUntil = Date.now() - 60_000 })
const end = async (app: { events: EventEmitter }, sessionID: string) => {
  app.events.emit("event", { type: "session.execution.succeeded", data: { sessionID } })
  await flush()
}

test("a sticky session is continued while warm, and compacted to its memory once cold", async () => {
  const app = await start({}, [job({ session: "sticky" })])
  await app.call("automation_run", { id: "morning" })
  expect(app.prompts[0]).toMatchObject({ sessionID: "session-1", text: "Check things" })
  // Sticky runs are offered the memory tool and told to use it; it saves a note for the job.
  const ctx = app.context("session-1")
  expect(ctx.tools).toContain("automation_memory_update")
  expect(ctx.system).toContain("End every run with automation_memory_update")
  expect(ctx.tools).not.toContain("automation_memory_recall")
  expect((await app.call("automation_memory_update", { note: "MR !12 reported. Watching !13." }, "session-1")).content).toContain("Saved")
  await end(app, "session-1")
  expect(app.prompts).toHaveLength(1) // it saved a note: no follow-up
  expect(app.store.history()[0].status).toBe("succeeded")

  // Right after: the cache is warm, so the same session goes on, without the note.
  await app.call("automation_run", { id: "morning" })
  expect(app.prompts[1]).toMatchObject({ sessionID: "session-1", text: "Check things" })
  await app.call("automation_memory_update", { note: "MR !12, !13 reported." }, "session-1")
  await end(app, "session-1")

  // Cold: the same session, compacted first with the latest memory as its summary (no model call).
  await chill(app.store, "morning")
  await app.call("automation_run", { id: "morning" })
  expect(app.compactions).toEqual([{ sessionID: "session-1", summary: "MR !12, !13 reported." }])
  const run = app.prompts[2]
  expect(run).toMatchObject({ sessionID: "session-1", text: "Check things" })
  expect(app.sessions).toHaveLength(1)
  expect(app.store.loadJobs()[0].sessionID).toBe("session-1")
})

test("the compaction's end, even delivered after it returns, doesn't end the run or check it before its turn", async () => {
  const app = await start({}, [job({ session: "sticky" })])
  await app.call("automation_run", { id: "morning" })
  await app.call("automation_memory_update", { note: "state" }, "session-1")
  await end(app, "session-1")
  await chill(app.store, "morning")
  await app.call("automation_run", { id: "morning" })
  await flush()
  expect(app.compactions).toHaveLength(1)
  expect(app.prompts.map((p) => p.metadata.automation.reason)).toEqual(["manual", "manual"]) // no check queued
  expect(app.store.history()[0].status).toBe("running")
  await app.call("automation_memory_update", { note: "state 2" }, "session-1")
  await end(app, "session-1")
  expect(app.store.history()[0].status).toBe("succeeded")
  expect(memory(app.store, "morning")).toMatchObject({ note: "state 2" })
})

test("a run that saves no memory drops the old one, and one that sent the model nothing doesn't warm the session", async () => {
  const app = await start({}, [job({ session: "sticky" })])
  await app.call("automation_run", { id: "morning" })
  app.context("session-1") // the run sent the model a request
  await app.call("automation_memory_update", { note: "run 1" }, "session-1")
  await end(app, "session-1")
  expect(memory(app.store, "morning")).toMatchObject({ note: "run 1" })
  const warm = memory(app.store, "morning")!.warmUntil
  expect(warm).toBeGreaterThan(Date.now())

  // Run 2 sends nothing to the model (it failed at once) and saves no memory, even when asked.
  await app.call("automation_run", { id: "morning" })
  await end(app, "session-1")
  await end(app, "session-1")
  expect(memory(app.store, "morning")!.note).toBeUndefined()
  expect(memory(app.store, "morning")!.warmUntil).toBe(warm)

  // Cold, with no memory: the next run continues the whole session rather than compacting to run 1's note.
  await chill(app.store, "morning")
  await app.call("automation_run", { id: "morning" })
  expect(app.compactions).toEqual([])
  expect(app.prompts.at(-1).sessionID).toBe("session-1")
})

test("if compaction can't be done, the cold run goes on in its whole session", async () => {
  const app = await start({}, [job({ session: "sticky" })])
  await app.call("automation_run", { id: "morning" })
  await app.call("automation_memory_update", { note: "state" }, "session-1")
  await end(app, "session-1")
  await chill(app.store, "morning")
  app.compactMode.value = "throw"
  await app.call("automation_run", { id: "morning" })
  expect(app.prompts[1]).toMatchObject({ sessionID: "session-1", text: "Check things" })
  expect(app.compactions).toEqual([])
  expect(app.store.history()[0].status).toBe("running")
})

test("a sticky run that saves no note is asked once, with the notify check in the same turn; without a note the session goes on", async () => {
  const app = await start({ notify: pushover }, [job({ session: "sticky" })])
  await app.call("automation_run", { id: "morning" })
  app.events.emit("event", { type: "session.text.ended", data: { sessionID: "session-1", text: "MR !12 is blocked." } })
  await end(app, "session-1")
  expect(app.prompts).toHaveLength(2)
  expect(app.prompts[1].text).toContain("automation_notify")
  expect(app.prompts[1].text).toContain("automation_memory_update")
  await end(app, "session-1")
  expect(app.prompts).toHaveLength(2)
  expect(app.store.history()[0]).toMatchObject({ status: "succeeded" })

  // No note was saved, so even a cold session is continued: nothing to start a fresh one from.
  await chill(app.store, "morning")
  await app.call("automation_run", { id: "morning" })
  expect(app.prompts[2]).toMatchObject({ sessionID: "session-1", text: "Check things" })
  expect(app.sessions).toHaveLength(1)
})

test("with session keys, each key's session goes cold and is compacted to its own memory", async () => {
  let current: unknown[] = []
  const fetch = api(() => current)
  try {
    const app = await start({ channels: [channel()], jobs: [triage({ session: "sticky" })] })
    current = [monitor(1), monitor(2)]
    await app.call("channel_poll", { id: "dd" })
    const sid = (key: string) => app.store.loadChannels().queues.triage.sessions[key].id
    const one = sid("dd:1"), two = sid("dd:2")
    app.context(one) // each run sent the model a request
    app.context(two)
    await app.call("automation_memory_update", { note: "Monitor 1: disk full on db-3." }, one)
    await app.call("automation_memory_update", { note: "Monitor 2: flaky." }, two)
    await end(app, one)
    await end(app, two)

    // Monitor 1 fires again after its cache went cold: its session is compacted to its own memory. Monitor 2 is still warm.
    await chill(app.store, "triage", "dd:1")
    current = [monitor(1, "t2"), monitor(2, "t2")]
    await app.call("channel_poll", { id: "dd" })
    const for1 = app.prompts.find((p) => p.text.includes('id="1:t2"'))
    const for2 = app.prompts.find((p) => p.text.includes('id="2:t2"'))
    expect(for1.sessionID).toBe(one)
    expect(sid("dd:1")).toBe(one)
    expect(app.compactions).toEqual([{ sessionID: one, summary: "Monitor 1: disk full on db-3." }])
    expect(for2.sessionID).toBe(two)
  } finally { fetch.mockRestore() }
})

test("the cache lifetime is read from the run's requests, 5 minutes when they don't say", () => {
  expect(cacheLifetime(undefined)).toBe(5 * 60_000)
  expect(cacheLifetime({ temperature: 0 })).toBe(5 * 60_000)
  expect(cacheLifetime({ cache: { ttl: "1h" } })).toBe(3_600_000)
  expect(cacheLifetime({ prompt_cache_retention: "24h" })).toBe(86_400_000)
  expect(cacheLifetime({ prompt_cache_retention: "in_memory" })).toBe(5 * 60_000)
  expect(cacheLifetime({ prompt_cache_options: { ttl: "30m" } })).toBe(30 * 60_000)
  expect(cacheLifetime({ cache_control: { type: "ephemeral", ttl: "1h" } })).toBe(3_600_000)
  expect(cacheLifetime({ cache: "none" })).toBe(0)
})

test("a session with a one-hour cache stays warm for a gap a default cache wouldn't survive", async () => {
  const app = await start({}, [job({ session: "sticky" }), job({ id: "short", name: "Short", session: "sticky" })])
  await app.call("automation_run", { id: "morning" })
  await app.call("automation_run", { id: "short" })
  app.context("session-1", { cache: { ttl: "1h" } })
  app.context("session-2")
  await app.call("automation_memory_update", { note: "a" }, "session-1")
  await app.call("automation_memory_update", { note: "b" }, "session-2")
  await end(app, "session-1")
  await end(app, "session-2")
  // Warm for 90% of the cache lifetime after the run ended.
  expect(memory(app.store, "morning")!.warmUntil! - Date.now()).toBeGreaterThan(53 * 60_000)
  expect(memory(app.store, "short")!.warmUntil! - Date.now()).toBeLessThan(5 * 60_000)
  // 20 minutes later: the one-hour cache is still warm, the 5-minute one isn't.
  for (const id of ["morning", "short"]) await setMemory(app.store, id, undefined, (m) => { m.warmUntil! -= 20 * 60_000 })
  await app.call("automation_run", { id: "morning" })
  await app.call("automation_run", { id: "short" })
  expect(app.prompts.at(-2)).toMatchObject({ sessionID: "session-1", text: "Check things" })
  expect(app.prompts.at(-1).sessionID).toBe("session-2")
  expect(app.compactions.map((c) => c.sessionID)).toEqual(["session-2"])
})

test("with caching off, a sticky session is compacted whenever there is memory", async () => {
  const app = await start({}, [job({ session: "sticky" })])
  await app.call("automation_run", { id: "morning" })
  app.context("session-1", { cache: "none" })
  await app.call("automation_memory_update", { note: "state" }, "session-1")
  await end(app, "session-1")
  await app.call("automation_run", { id: "morning" })
  expect(app.prompts[1].sessionID).toBe("session-1")
  expect(app.compactions).toEqual([{ sessionID: "session-1", summary: "state" }])
})

test("automation_memory_update is for sticky runs only, and refuses empty or long notes", async () => {
  const app = await start({}, [job(), job({ id: "s", name: "S", session: "sticky" })])
  await app.call("automation_run", { id: "morning" })
  await app.call("automation_run", { id: "s" })
  expect(app.context("session-1").tools).not.toContain("automation_memory_update")
  expect(app.context("caller").tools).not.toContain("automation_memory_update")
  expect((await app.call("automation_memory_update", { note: "x" }, "session-1")).content).toContain("only kept for runs of sticky")
  expect((await app.call("automation_memory_update", { note: "x" })).content).toContain("only kept for runs of sticky")
  expect((await app.call("automation_memory_update", { note: "  " }, "session-2")).content).toContain("empty")
  expect((await app.call("automation_memory_update", { note: "x".repeat(4001) }, "session-2")).content).toContain("limit is 4000")
  expect(memory(app.store, "s")?.note).toBeUndefined()
  expect(app.context("session-2").tools).toContain("automation_memory_update")
})

test("the memory lives on the session's record: a new session starts fresh, and so does a new key session", async () => {
  const app = await start({}, [job({ session: "sticky" })])
  await app.call("automation_run", { id: "morning" })
  await app.call("automation_memory_update", { note: "state" }, "session-1")
  await end(app, "session-1")
  expect(memory(app.store, "morning")).toMatchObject({ note: "state" })
  // The session is gone: the new one starts without the old session's memory, and nothing is compacted.
  app.ctx.session.get = async ({ sessionID }: any) => ({ id: sessionID, time: { archived: Date.now() }, location: { directory: app.dataDir } })
  await app.call("automation_run", { id: "morning" })
  expect(app.prompts[1]).toMatchObject({ sessionID: "session-2", text: "Check things" })
  expect(memory(app.store, "morning")).toBeUndefined()
  expect(app.compactions).toEqual([])
})

// ---------- creating channels from chat ----------

const draftChannel = (overrides: Record<string, unknown> = {}) => ({
  name: "Datadog", every: "1m",
  request: { url: "https://api.dd.test/api/v1/monitor", headers: { "DD-API-KEY": "{env:TEST_DD_KEY}" } },
  filter: { overall_state: "Alert" },
  event: { id: "{id}:{overall_state_modified}", sessionKey: "{id}", title: "{name}", body: "{message}" },
  ...overrides,
})

test("channel_create refuses secrets written out and says what env is missing", async () => {
  const fetch = api(() => [])
  try {
    const app = await start()
    const literal = draftChannel({ request: { url: "https://api.dd.test/m?api_key=abc123", headers: { Authorization: "Bearer xyz" } } })
    const refused = (await app.call("channel_create", { id: "dd", ...literal })).content
    expect(refused).toContain("header Authorization, query parameter api_key look like a secret")
    expect(refused).toContain("{env:NAME}")
    expect((await app.call("channel_create", { id: "dd", ...draftChannel() })).content).toContain("Not set yet in the server's environment: TEST_DD_KEY")
    expect(fetch.mock.calls).toHaveLength(0)
    expect((await app.call("channel_create", { id: "Bad Id", ...draftChannel() })).content).toContain("lowercase")
  } finally { fetch.mockRestore() }
})

test("a created channel feeds automations like a config one, and can be updated and deleted", async () => {
  process.env.TEST_DD_KEY = "k"
  let current: unknown[] = []
  const fetch = api(() => current)
  try {
    const app = await start()
    expect((await app.call("channel_create", { id: "dd", ...draftChannel() })).content).toContain("Created channel dd")
    expect((await app.call("channel_create", { id: "dd", ...draftChannel() })).content).toContain("exists")
    expect((await app.call("channel_list")).content).toContain("dd (Datadog) [created]")

    await app.call("automation_create", { name: "Triage", prompt: "Investigate.", channels: ["dd"], session: "sticky" })
    current = [monitor(1)]
    expect((await app.call("channel_poll", { id: "dd" })).content).toContain("1 new event, 1 run started")
    expect(app.prompts[0].text).toContain('<event channel="Datadog" id="1:t1"')

    expect((await app.call("channel_update", { id: "dd", name: "DD alerts", every: "2m" })).content).toContain("Updated channel dd")
    expect(app.store.loadChannels().defs.dd).toMatchObject({ name: "DD alerts", every: "2m", event: { sessionKey: "{id}" } })
    expect((await app.call("channel_update", { id: "dd", request: { url: "https://x.test/?token=raw" } })).content).toContain("like a secret")

    // In use: deleting needs detach. The event-only automation is paused once it has no channel left.
    expect((await app.call("channel_delete", { id: "dd" })).content).toContain("Pass detach: true")
    const deleted = (await app.call("channel_delete", { id: "dd", detach: true })).content
    expect(deleted).toContain("Removed from triage")
    expect(deleted).toContain("Paused (no channels or schedule left): triage")
    const triageJob = app.store.loadJobs()[0]
    expect(triageJob.on).toBeUndefined()
    expect(triageJob.paused).toBe(true)
    const state = app.store.loadChannels()
    expect(state.defs.dd).toBeUndefined()
    expect(state.sources.dd).toBeUndefined()
    expect(state.queues.triage.sessions).toEqual({})
  } finally { fetch.mockRestore(); delete process.env.TEST_DD_KEY }
})

test("config channels can't be changed or shadowed from chat, and are published without secrets", async () => {
  const app = await start({ channels: [channel({ request: { url: "https://api.dd.test/api/v1/monitor?api_key=raw", headers: { "DD-API-KEY": "raw" } } })] })
  expect(app.store.loadChannels().config.dd).toEqual({
    name: "Datadog", url: "https://api.dd.test/api/v1/monitor", everyMs: 60_000, items: "", filter: { overall_state: "Alert" },
    event: { id: "{id}:{overall_state_modified}", sessionKey: "{id}", title: "{name}", body: "{message}" }, env: [],
  })
  expect(JSON.stringify(app.store.loadChannels())).not.toContain("raw")
  expect((await app.call("channel_create", { id: "dd", ...draftChannel() })).content).toContain("is a config channel")
  expect((await app.call("channel_update", { id: "dd", every: "5m" })).content).toContain("edit it there")
  expect((await app.call("channel_delete", { id: "dd" })).content).toContain("remove it there")
  expect((await app.call("channel_list")).content).toContain("dd (Datadog) [config]")
})

// ---------- review fixes: delivery, cleanup, messages ----------

test("events from a run that failed to start go back to the queue, up to 3 attempts", async () => {
  let current: unknown[] = []
  const fetch = api(() => current)
  try {
    const app = await start({ channels: [channel()], jobs: [triage()] })
    let failing = true
    const prompt = app.ctx.session.prompt
    app.ctx.session.prompt = async (input: any) => { if (failing) throw new Error("server busy"); return prompt(input) }
    current = [monitor(1)]
    await app.call("channel_poll", { id: "dd" })
    expect(app.store.loadChannels().queues.triage.pending).toMatchObject([{ id: "1:t1", attempts: 1 }])
    // It starts once the server is back: nothing was lost.
    failing = false
    await app.call("automation_run", { id: "triage" })
    expect(app.prompts.at(-1).text).toContain('id="1:t1"')
    expect(app.store.loadChannels().queues.triage.pending).toEqual([])

    // A start that keeps failing gives up after 3 attempts.
    app.events.emit("event", { type: "session.idle", data: { sessionID: app.prompts.at(-1).sessionID } })
    await flush()
    failing = true
    current = [monitor(2)]
    await app.call("channel_poll", { id: "dd" }) // attempt 1
    expect(app.store.loadChannels().queues.triage.pending).toMatchObject([{ id: "2:t1", attempts: 1 }])
    await app.call("automation_run", { id: "triage" }) // attempt 2
    await app.call("automation_run", { id: "triage" }) // attempt 3: dropped
    expect(app.store.loadChannels().queues.triage.pending).toEqual([])
    expect(app.store.history().filter((r) => r.status === "failed").length).toBe(4)
  } finally { fetch.mockRestore() }
})

test("two deliveries at once hand a chunk over only once", async () => {
  let current: unknown[] = []
  const fetch = api(() => current)
  try {
    const app = await start({ channels: [channel()], jobs: [triage({ session: "sticky", cron: "0 0 1 1 *" })] })
    current = [monitor(1)]
    await app.call("channel_poll", { id: "dd" }) // a digest: events wait
    expect(app.prompts).toEqual([])
    const runs = await Promise.all([app.call("automation_run", { id: "triage" }), app.call("automation_run", { id: "triage" })])
    expect(app.prompts).toHaveLength(1)
    expect(runs.map((r: any) => r.content).join("\n")).toContain("still busy")
    expect(app.store.history().filter((r) => r.status === "skipped")).toEqual([])
  } finally { fetch.mockRestore() }
})

test("channel polls in a tick run in parallel", async () => {
  const started: number[] = []
  const ended: number[] = []
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async () => {
    started.push(Date.now())
    await new Promise((r) => setTimeout(r, 150))
    ended.push(Date.now())
    return new Response("[]")
  }) as any)
  try {
    await start({
      channels: [channel(), channel({ id: "two", request: { url: "https://api.dd.test/two" } })],
      jobs: [triage({ on: { channels: ["dd", "two"] } })],
    })
    for (let i = 0; i < 30 && ended.length < 2; i++) await flush()
    expect(started).toHaveLength(2)
    expect(started[1]).toBeLessThan(ended[0]) // the second began before the first finished
  } finally { fetch.mockRestore() }
})

test("a first poll doesn't queue an item twice when its id repeats", async () => {
  const fetch = api(() => [monitor(1), monitor(1)])
  try {
    const app = await start({ channels: [channel()], jobs: [triage({ cron: "0 0 1 1 *" })] })
    expect(app.store.loadChannels().queues.triage.pending.map((e) => e.id)).toEqual(["1:t1"])
  } finally { fetch.mockRestore() }
})

test("changing or deleting an automation cleans its queue", async () => {
  let current: unknown[] = []
  const fetch = api(() => current)
  try {
    const app = await start({ channels: [channel(), channel({ id: "two", request: { url: "https://api.dd.test/two" } })] })
    await app.call("automation_create", { name: "Digest", prompt: "p", channels: ["dd", "two"], every: "1h", session: "sticky" })
    current = [monitor(1)]
    await app.call("channel_poll", { id: "dd" })
    await app.call("channel_poll", { id: "two" })
    expect(app.store.loadChannels().queues.digest.pending.map((e) => e.channel)).toEqual(["dd", "two"])

    // Dropping a channel drops what it held: its events and its first-poll mark.
    await app.call("automation_update", { id: "digest", channels: ["two"] })
    const q = app.store.loadChannels().queues.digest
    expect(q.pending.map((e) => e.channel)).toEqual(["two"])
    expect(q.started).toEqual(["two"])
    // No channels left: no queue.
    await app.call("automation_update", { id: "digest", channels: [] })
    expect(app.store.loadChannels().queues.digest).toBeUndefined()

    await app.call("automation_update", { id: "digest", channels: ["dd"] })
    await app.call("channel_poll", { id: "dd" })
    expect(app.store.loadChannels().queues.digest).toBeDefined()
    await app.call("automation_delete", { id: "digest" })
    expect(app.store.loadChannels().queues.digest).toBeUndefined()
  } finally { fetch.mockRestore() }
})

test("automation_run says when an automation's channels are gone, and such an automation can't be resumed", async () => {
  process.env.TEST_DD_KEY = "k"
  const fetch = api(() => [monitor(1)])
  try {
    const app = await start()
    await app.call("channel_create", { id: "dd", ...draftChannel() })
    await app.call("automation_create", { name: "Watch", prompt: "p", channels: ["dd"], every: "1h" })
    await app.call("channel_poll", { id: "dd" })
    // The channel disappears without a detach (e.g. it was a config channel that got removed).
    await app.store.mutateChannels((s) => { delete s.defs.dd })
    expect((await app.call("automation_run", { id: "watch" })).content).toContain("Nothing started: none of its channels exist any more (dd).")

    // An event-only automation paused by channel_delete can't be resumed without channels or a schedule.
    await app.call("channel_create", { id: "dd", ...draftChannel() })
    await app.call("automation_create", { name: "Live", prompt: "p", channels: ["dd"] })
    await app.call("channel_delete", { id: "dd", detach: true })
    expect((await app.call("automation_update", { id: "live", enabled: true })).content).toContain("would never run")
    expect((await app.call("automation_update", { id: "live", enabled: true, every: "1h" })).content).toContain("enabled")
  } finally { fetch.mockRestore(); delete process.env.TEST_DD_KEY }
})

test("a tick drops queues of automations that no longer exist", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "automations-orphans-"))
  try {
    // An automation deleted elsewhere (the TUI, or removed from config) left its queue behind.
    await new Store(dataDir).mutateChannels((s) => { s.queues.ghost = { pending: [{ channel: "dd", id: "1", title: "x" }], sessions: {} } })
    const app = await start({ dataDir })
    expect(app.store.loadChannels().queues.ghost).toBeUndefined()
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

test("every tool goes through code mode, in two namespaces", async () => {
  const app = await start()
  expect(app.namespaces.map((n: any) => n.name)).toEqual(["automation", "channel"])
  for (const [name, tool] of app.tools) {
    expect(tool.options).toEqual({ namespace: name.split("_")[0], codemode: true })
    expect(`${tool.options.namespace}_${tool.name}`).toBe(name) // exposed names stay automation_* / channel_* 
  }
  expect([...app.tools.keys()]).toContain("automation_notify")
  expect([...app.tools.keys()]).not.toContain("channel_test")
})

// ---------- review fixes: update ordering, pause, sessions, saves ----------

test("a rejected automation_update leaves the job's queue untouched", async () => {
  let current: unknown[] = []
  const fetch = api(() => current)
  try {
    const app = await start({ channels: [channel(), channel({ id: "two", request: { url: "https://api.dd.test/two" } })] })
    await app.call("automation_create", { name: "Digest", prompt: "p", channels: ["dd"], every: "1h" })
    current = [monitor(1)]
    await app.call("channel_poll", { id: "dd" })
    const before = app.store.loadChannels().queues.digest
    expect((await app.call("automation_update", { id: "digest", channels: ["two"], cron: "bogus" })).content).toContain("error")
    expect(app.store.loadChannels().queues.digest).toEqual(before)
    expect(app.store.loadJobs()[0].on).toEqual({ channels: ["dd"] })
  } finally { fetch.mockRestore() }
})

test("events wait for a paused automation and go in when it resumes", async () => {
  let current: unknown[] = []
  const fetch = api(() => current)
  try {
    const app = await start({ channels: [channel()], jobs: [triage(), triage({ id: "other", name: "Other" })] })
    await app.call("automation_update", { id: "other", enabled: false })
    current = [monitor(1)]
    await app.call("channel_poll", { id: "dd" }) // triage runs; other is paused
    expect(app.prompts.map((p) => p.metadata.automation.jobID)).toEqual(["triage"])
    expect(app.store.loadChannels().queues.other.pending.map((e) => e.id)).toEqual(["1:t1"])
    await app.call("automation_update", { id: "other", enabled: true })
    await app.call("channel_poll", { id: "dd" })
    expect(app.prompts.map((p) => p.metadata.automation.jobID)).toEqual(["triage", "other"])
  } finally { fetch.mockRestore() }
})

test("detaching an event-only automation's last channel pauses it, and the pause alone can be lifted", async () => {
  process.env.TEST_DD_KEY = "k"
  const fetch = api(() => [])
  try {
    const app = await start()
    await app.call("channel_create", { id: "dd", ...draftChannel() })
    await app.call("automation_create", { name: "Live", prompt: "p", channels: ["dd"] })
    await app.call("channel_delete", { id: "dd", detach: true })
    expect(app.store.loadJobs()[0]).toMatchObject({ paused: true, enabled: true })
  } finally { fetch.mockRestore(); delete process.env.TEST_DD_KEY }
})

test("a session made for a chunk that someone else took is removed again", async () => {
  const fetch = api(() => [monitor(1)])
  try {
    const app = await start({ channels: [channel()], jobs: [triage({ session: "sticky", cron: "0 0 1 1 *" })] })
    // Another process takes the events while this one creates the key's session.
    const create = app.ctx.session.create
    app.ctx.session.create = async (input: any) => {
      await app.store.mutateChannels((s) => { s.queues.triage.pending = [] })
      return create(input)
    }
    expect((await app.call("automation_run", { id: "triage" })).content).toContain("another process already took these events")
    expect(app.removed).toEqual(["session-1"])
    expect(app.prompts).toEqual([])
  } finally { fetch.mockRestore() }
})

test("a poll whose results can't be saved isn't counted as a failed poll", async () => {
  const fetch = api(() => [monitor(1)])
  try {
    const app = await start({ channels: [channel()], jobs: [triage({ cron: "0 0 1 1 *" })] })
    const holder = Bun.spawn(["bun", "-e", `
      const lockfile = require("proper-lockfile")
      const release = lockfile.lockSync(${JSON.stringify(join(app.dataDir, "channels.json"))}, { realpath: false })
      console.log("locked")
      setTimeout(() => { release(); process.exit(0) }, 2600)
    `], { cwd: join(import.meta.dir, ".."), stdout: "pipe" })
    await holder.stdout.getReader().read()
    const out = (await app.call("channel_poll", { id: "dd" })).content
    await holder.exited
    expect(out).toContain("couldn't save the poll")
    expect(app.store.loadChannels().sources.dd.failures ?? 0).toBe(0)
  } finally { fetch.mockRestore() }
}, 10_000)

test("a key's session that can't be created is a failed run, counted and given up after 3 attempts", async () => {
  const fetch = api(() => [monitor(1)])
  try {
    const app = await start({ channels: [channel()], jobs: [triage({ session: "sticky", cron: "0 0 1 1 *" })] })
    app.ctx.session.create = async () => { throw new Error("model not found") }
    for (let i = 1; i <= 3; i++) {
      expect((await app.call("automation_run", { id: "triage" })).content).toContain("failed — model not found")
      expect(app.store.loadChannels().queues.triage.pending.map((e) => e.attempts)).toEqual(i < 3 ? [i] : [])
    }
    expect(app.store.history("triage").map((r) => r.status)).toEqual(["failed", "failed", "failed"])
    expect(app.store.loadJobs()[0].lastStatus).toBe("failed")
  } finally { fetch.mockRestore() }
})

test("a session made for a chunk is removed when its events can't be taken", async () => {
  const fetch = api(() => [monitor(1)])
  try {
    const app = await start({ channels: [channel()], jobs: [triage({ session: "sticky", cron: "0 0 1 1 *" })] })
    const mutateChannels = Store.prototype.mutateChannels
    const create = app.ctx.session.create
    app.ctx.session.create = async (input: any) => {
      Store.prototype.mutateChannels = async () => { throw new Error("Lock file is already being held") }
      return create(input)
    }
    try {
      expect((await app.call("automation_run", { id: "triage" })).content).toContain("retried on the next tick")
    } finally { Store.prototype.mutateChannels = mutateChannels }
    expect(app.removed).toEqual(["session-1"])
    expect(waiting(app, "triage")).toEqual(["1:t1"])
  } finally { fetch.mockRestore() }
})

test("runs on events set the last run time; a digest with nothing waiting doesn't", async () => {
  let current: unknown[] = []
  const fetch = api(() => current)
  try {
    const app = await start({ tickSeconds: 5, channels: [channel()], jobs: [triage(), triage({ id: "digest", every: "1m" })] })
    const jobs = app.store.loadJobs().map((j) => (j.id === "digest" ? { ...j, nextRunAt: Date.now() - 1000 } : j))
    app.store.saveJobs(jobs)
    current = [monitor(1)]
    await app.call("channel_poll", { id: "dd" })
    const byID = Object.fromEntries(app.store.loadJobs().map((j) => [j.id, j]))
    expect(byID.triage.lastRunAt).toBeGreaterThan(0)
    expect(byID.digest.lastRunAt).toBeUndefined()
  } finally { fetch.mockRestore() }
})

test("an automation run can't create or change channels", async () => {
  process.env.TEST_DD_KEY = "s3cret-value"
  // An API that echoes the key back.
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (_: any, init: any) =>
    new Response(JSON.stringify([{ ...monitor(1), echoed: init.headers["DD-API-KEY"] }]))) as any)
  try {
    const app = await start({}, [job()])
    expect((await app.call("channel_create", { id: "dd", ...draftChannel() })).content).toContain("Created channel dd")

    await app.call("automation_run", { id: "morning" })
    const run = app.prompts[0].sessionID
    const calls = fetch.mock.calls.length
    for (const [tool, input] of [["channel_create", { id: "x", ...draftChannel() }], ["channel_update", { id: "dd", every: "2m" }]] as const) {
      expect((await app.call(tool, input, run)).content).toContain("from inside an automation run")
    }
    expect(fetch.mock.calls.length).toBe(calls)
    expect(Object.keys(app.store.loadChannels().defs)).toEqual(["dd"])
  } finally { fetch.mockRestore(); delete process.env.TEST_DD_KEY }
})

test("only the leader publishes its config channels", async () => {
  const fetch = api(() => [])
  try {
    const dataDir = mkdtempSync(join(tmpdir(), "automations-shared-"))
    cleanups.push(async () => rmSync(dataDir, { recursive: true, force: true }))
    await start({ dataDir, channels: [channel()] })
    await start({ dataDir }) // another project, no channels, not the leader
    expect(Object.keys(new Store(dataDir).loadChannels().config)).toEqual(["dd"])
  } finally { fetch.mockRestore() }
})

test("an API that leaves the items out when there is nothing is an empty poll, not a failure", async () => {
  let body: unknown = { data: {} }
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async () => new Response(JSON.stringify(body))) as any)
  try {
    const app = await start({ channels: [channel({ items: "data.issues" })], jobs: [triage({ cron: "0 0 1 1 *" })] })
    expect((await app.call("channel_poll", { id: "dd" })).content).toContain("0 new events")
    body = { data: { issues: null } }
    expect((await app.call("channel_poll", { id: "dd" })).content).toContain("0 new events")
    expect(app.store.loadChannels().sources.dd.failures).toBe(0)
    body = { data: { issues: "nope" } }
    expect((await app.call("channel_poll", { id: "dd" })).content).toContain("is not an array")
  } finally { fetch.mockRestore() }
})

test("a run the user interrupts ends at once, as failed, instead of waiting for its timeout", async () => {
  const app = await start({}, [job()])
  await app.call("automation_run", { id: "morning" })
  app.events.emit("event", { type: "session.execution.interrupted", data: { sessionID: "session-1" } })
  await flush()
  expect(app.store.history()[0]).toMatchObject({ status: "failed", error: "interrupted" })
  // The job is free again.
  expect((await app.call("automation_run", { id: "morning" })).content).toContain("running")
})

test("a config one-shot whose time has passed doesn't stop the plugin from loading, and is done", async () => {
  const app = await start({ jobs: [{ id: "once", prompt: "Ship it", at: "2020-01-01T09:00:00Z", directory: process.cwd() }] })
  expect(app.prompts).toEqual([])
  expect(app.store.loadJobs()[0]).toMatchObject({ id: "once", done: true })
  // From chat, a past time is still refused.
  expect((await app.call("automation_create", { name: "Late", prompt: "x", at: "2020-01-01T09:00:00Z" })).content).toContain("in the past")
})

test("resuming from chat after a long pause doesn't fire a missed run right away", async () => {
  const app = await start({}, [job({ paused: true, nextRunAt: Date.now() - 3_600_000 })])
  await app.call("automation_update", { id: "morning", enabled: true })
  const saved = app.store.loadJobs()[0]
  expect(saved.paused).toBe(false)
  expect(saved.nextRunAt).toBeGreaterThan(Date.now())
})

test("timeouts a timer can't hold are refused", async () => {
  const app = await start({}, [job()])
  expect((await app.call("automation_create", { name: "Bad", prompt: "x", every: "1h", timeoutMinutes: -5 })).content).toContain("timeoutMinutes")
  expect((await app.call("automation_update", { id: "morning", timeoutMinutes: 1e9 })).content).toContain("timeoutMinutes")
  expect((await app.call("automation_update", { id: "morning", timeoutMinutes: 0 })).content).toContain("timeoutMinutes")
  expect(app.store.loadJobs()).toHaveLength(1)
  expect(app.store.loadJobs()[0].timeoutMinutes).toBe(30)
  await expect(start({ jobs: [{ id: "c", prompt: "x", every: "1h", directory: process.cwd(), timeoutMinutes: 0 }] })).rejects.toThrow("timeoutMinutes")
  await expect(start({ defaultTimeoutMinutes: -1 })).rejects.toThrow("timeoutMinutes")
})

test("two starts of one automation at once make one run, not two in the same session", async () => {
  const app = await start({}, [job({ session: "sticky" })])
  const create = app.ctx.session.create
  app.ctx.session.create = async (input: any) => { await flush(); return create(input) }
  const [a, b] = await Promise.all([app.call("automation_run", { id: "morning" }), app.call("automation_run", { id: "morning" })])
  expect([a.content, b.content].filter((c: string) => c.includes("skipped"))).toHaveLength(1)
  expect(app.prompts).toHaveLength(1)
  expect(app.sessions).toHaveLength(1)
})

test("runs still in progress when the plugin stops are closed in the history", async () => {
  const app = await start({}, [job()])
  await app.call("automation_run", { id: "morning" })
  expect(app.store.history()[0].status).toBe("running")
  await app.stop()
  expect(app.store.history()[0]).toMatchObject({ status: "failed", error: "opencode stopped before the run ended" })
  expect(app.store.loadJobs()[0].lastStatus).toBe("failed")
})

test("a compaction that never finishes doesn't hold the run when the plugin stops", async () => {
  const app = await start({}, [job({ session: "sticky", sessionID: "session-9", memory: { note: "state" } })])
  app.ctx.session.wait = () => new Promise(() => {})
  const run = app.call("automation_run", { id: "morning" })
  await flush()
  await app.stop()
  expect((await run).content).toContain("skipped")
  expect(app.prompts).toEqual([])
})

test("a compaction given up on still gets its summary, and its late end doesn't end the run", async () => {
  // The 30 s the plugin gives a compaction, cut short.
  const real = globalThis.setTimeout
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((fn: any, ms?: number, ...args: any[]) => real(fn, ms === 30_000 ? 10 : ms, ...args)) as any)
  try {
    const app = await start({}, [job({ session: "sticky", sessionID: "session-9", memory: { note: "state" } })])
    // The compaction is accepted but only happens later (the session is busy).
    app.ctx.session.compact = async ({ sessionID }: any) => ({ id: "msg_compaction", sessionID, type: "compaction" })
    app.ctx.session.wait = () => new Promise<void>(() => {})
    expect((await app.call("automation_run", { id: "morning" })).content).toContain("running")
    expect(app.prompts).toHaveLength(1)
    // The compaction happens now: it finds its summary, and its end event is not the run's.
    expect(app.compactionSummary("session-9")).toBe("state")
    await end(app, "session-9")
    expect(app.store.history()[0].status).toBe("running")
    expect(app.compactionSummary("session-9")).toBeUndefined()
    // The run's own end still ends it.
    await app.call("automation_memory_update", { note: "state 2" }, "session-9")
    await end(app, "session-9")
    expect(app.store.history()[0].status).toBe("succeeded")
  } finally { timers.mockRestore() }
})

test("a poll error never carries a key the API echoed back", async () => {
  process.env.TEST_DD_KEY = "s3cret-value"
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (_: any, init: any) =>
    new Response(`forbidden for key ${init.headers["DD-API-KEY"]}`, { status: 403 })) as any)
  try {
    const app = await start()
    await app.call("channel_create", { id: "dd", ...draftChannel() })
    const out = (await app.call("channel_poll", { id: "dd" })).content
    expect(out).toContain("HTTP 403: forbidden for key {env:TEST_DD_KEY}")
    expect(JSON.stringify(app.store.loadChannels())).not.toContain("s3cret-value")
  } finally { fetch.mockRestore(); delete process.env.TEST_DD_KEY }
})

test("automation_history takes an automation's name as well as its id", async () => {
  const app = await start({}, [job()])
  await app.call("automation_run", { id: "morning" })
  expect((await app.call("automation_history", { id: "Morning" })).content).toContain("morning running")
  expect((await app.call("automation_history", { id: "nope" })).content).toBe("No runs yet.")
})

test("a tick that changes nothing doesn't rewrite jobs.json", async () => {
  const app = await start({ tickSeconds: 5 }, [job()])
  const path = join(app.dataDir, "jobs.json")
  const before = statSync(path).mtimeMs
  await new Promise((r) => setTimeout(r, 30))
  await app.call("automation_update", { id: "morning" }) // goes through the same locked save as a tick
  expect(statSync(path).mtimeMs).toBe(before)
  await app.call("automation_update", { id: "morning", prompt: "Changed" })
  expect(statSync(path).mtimeMs).toBeGreaterThan(before)
})
