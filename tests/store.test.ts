import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MAX_SESSIONS, MAX_START_ATTEMPTS, Store, type Job } from "../store.ts"
import type { ChannelEvent } from "../channels.ts"

const stores: Array<{ store: Store; dir: string }> = []
function open(): Store {
  const dir = mkdtempSync(join(tmpdir(), "automations-store-"))
  const store = new Store(dir)
  stores.push({ store, dir })
  return store
}
afterEach(() => {
  latest = {}
  for (const { store, dir } of stores.splice(0)) { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

const job = (id: string, channels: string[]): Job => ({
  id, name: id, prompt: "p", schedule: { kind: "event" }, directory: "/", session: "new", timeoutMinutes: 30,
  runMissed: true, enabled: true, source: "tool", createdAt: 1, on: { channels },
})
const ev = (id: string, sessionKey?: string): ChannelEvent => ({ channel: "dd", id, title: `title ${id}`, ...(sessionKey ? { sessionKey } : {}) })
/** Poll `dd` at `at`: its events go to the inbox, and the poll counts as the channel's latest. */
let latest: Record<string, number> = {}
function poll(store: Store, at: number, ...events: ChannelEvent[]) {
  store.ingest("dd", events, at)
  latest = { ...latest, dd: at }
}
const subscribe = (store: Store, jobs: Job[]) => store.subscribe(jobs, latest)
/** How many times runs failed to start with an event. */
const attempts = (store: Store, jobID: string, seq: number) =>
  (store.db.query("SELECT attempts FROM deliveries WHERE job = ? AND seq = ?").get(jobID, seq) as { attempts: number } | null)?.attempts ?? 0
const ids = (store: Store, jobID: string) => store.waiting(jobID).map((e) => e.id)

test("the inbox keeps one event per channel and id; a repeat isn't new", () => {
  const store = open()
  expect(store.ingest("dd", [ev("1"), ev("1"), ev("2")], 10)).toBe(2)
  expect(store.ingest("dd", [ev("1"), ev("3")], 20)).toBe(1)
  // The same id on another channel is another event.
  expect(store.ingest("sentry", [{ ...ev("1"), channel: "sentry" }], 20)).toBe(1)
})

test("an automation attached to a channel gets what its latest poll returned, then only what is new", () => {
  const store = open()
  poll(store, 10, ev("old"))
  poll(store, 20, ev("current"))
  subscribe(store, [job("a", ["dd"])])
  expect(ids(store, "a")).toEqual(["current"])
  poll(store, 30, ev("current"), ev("new"))
  expect(ids(store, "a")).toEqual(["current", "new"])
  // Attaching again changes nothing: the subscription keeps where it started.
  subscribe(store, [job("a", ["dd"])])
  expect(ids(store, "a")).toEqual(["current", "new"])
  // A channel never polled: everything its first poll brings.
  subscribe(store, [job("a", ["dd"]), job("b", ["other"])])
  store.ingest("other", [{ ...ev("x"), channel: "other" }], 40)
  expect(store.waiting("b").map((e) => e.id)).toEqual(["x"])
})

test("events taken by a run wait no more; given back, they wait again, and failed starts are retried a few times", () => {
  const store = open()
  subscribe(store, [job("a", ["dd"]), job("b", ["dd"])])
  poll(store, 10, ev("1"), ev("2"))
  const [one, two] = store.waiting("a")
  store.take("a", [one.seq, two.seq])
  expect(ids(store, "a")).toEqual([])
  // Every automation takes its own: b still has both.
  expect(ids(store, "b")).toEqual(["1", "2"])
  store.giveBack("a", [one.seq], false)
  expect(store.waiting("a")).toEqual([{ ...one }])
  for (let i = 1; i <= MAX_START_ATTEMPTS; i++) {
    store.take("a", [two.seq])
    store.giveBack("a", [two.seq], true)
    expect(ids(store, "a")).toEqual(i < MAX_START_ATTEMPTS ? ["1", "2"] : ["1"])
  }
  expect(attempts(store, "a", one.seq)).toBe(0)
  expect(attempts(store, "a", two.seq)).toBe(MAX_START_ATTEMPTS)
  // Detached, nothing waits; and what an automation that is gone left is dropped by the trim.
  subscribe(store, [job("a", [])])
  expect(ids(store, "a")).toEqual([])
  store.saveJobs([job("a", [])])
  store.trim(latest)
  expect(store.db.query("SELECT COUNT(*) AS n FROM deliveries WHERE job = 'b'").get()).toEqual({ n: 0 })
})

test("trimming drops old events whose item is gone, but never one the channel still returns or someone still has to take", () => {
  const store = open()
  const day = 24 * 60 * 60_000
  subscribe(store, [job("monthly", ["dd"])])
  poll(store, 0, ev("taken"), ev("untaken"), ev("stays"))
  const [taken] = store.waiting("monthly")
  store.take("monthly", [taken.seq])
  poll(store, 10 * day, ev("stays"))
  store.trim(latest, 10 * day)
  expect(store.db.query("SELECT id FROM inbox ORDER BY seq").all()).toEqual([{ id: "untaken" }, { id: "stays" }])
})

test("events are taken once: a second take of the same ones gets none", () => {
  const store = open()
  subscribe(store, [job("a", ["dd"])])
  poll(store, 10, ev("1"))
  const [one] = store.waiting("a")
  expect([...store.take("a", [one.seq])]).toEqual([one.seq])
  expect([...store.take("a", [one.seq])]).toEqual([])
  // Given back for a retry, it can be taken again.
  store.giveBack("a", [one.seq], true)
  expect([...store.take("a", [one.seq])]).toEqual([one.seq])
})

test("a deleted job's state goes with it, and jobs keep their order when saved", async () => {
  const store = open()
  store.saveJobs([job("a", ["dd"]), job("b", [])])
  store.setNote("a", "", "old note")
  store.setSession("a", "", "s1")
  await store.mutate((jobs) => { jobs[0].paused = true })
  expect(store.loadJobs().map((j) => j.id)).toEqual(["a", "b"])
  await store.mutate((jobs) => { jobs.splice(0, 1) })
  expect([store.note("a"), store.session("a")]).toEqual([undefined, undefined])
})

test("a job's notes are listed per key, the most recently updated first", () => {
  const store = open()
  expect(store.notes("a")).toEqual([])
  store.setNote("a", "", "main")
  store.db.run("UPDATE memory SET updated_at = 1 WHERE key = ''")
  store.setNote("a", "dd:42", "monitor 42")
  store.setNote("b", "", "other job")
  expect(store.notes("a").map(({ key, note }) => ({ key, note }))).toEqual([
    { key: "dd:42", note: "monitor 42" },
    { key: "", note: "main" },
  ])
  expect(store.notes("a")[1].updatedAt).toBe(1)
})

test("the inbox lists every channel's events, newest first, with each automation's part in them", () => {
  const store = open()
  expect(store.inbox()).toEqual([])
  subscribe(store, [job("a", ["dd"]), job("b", ["dd"])])
  poll(store, 10, ev("1"), ev("2", "k"))
  store.ingest("other", [{ channel: "other", id: "x", title: "nobody listens" }], 20)
  store.take("a", [store.waiting("a")[0].seq])
  const [x, two, one] = store.inbox()
  expect(x).toMatchObject({ channel: "other", id: "x", at: 20, seenAt: 20, deliveries: [] })
  expect(two).toMatchObject({ id: "2", sessionKey: "k", deliveries: [{ job: "a", status: "waiting" }, { job: "b", status: "waiting" }] })
  expect(one.deliveries).toEqual([{ job: "a", status: "taken" }, { job: "b", status: "waiting" }])
  // Dropped after failed starts; a retry waits again.
  store.giveBack("a", [one.seq], false)
  expect(store.inbox()[2].deliveries[0]).toEqual({ job: "a", status: "waiting" })
  store.take("a", [one.seq])
  for (let n = 0; n < MAX_START_ATTEMPTS; n++) { store.giveBack("a", [one.seq], true); store.take("a", [one.seq]) }
  expect(store.inbox()[2].deliveries[0]).toEqual({ job: "a", status: "dropped" })
  expect(store.inbox(1)).toHaveLength(1)
})

test("detaching a channel drops the sticky sessions and memory of its keys", () => {
  const store = open()
  subscribe(store, [job("a", ["dd", "other"])])
  store.setSession("a", "dd:1", "s1")
  store.setNote("a", "dd:1", "n")
  store.setSession("a", "other:1", "s2")
  subscribe(store, [job("a", ["other"])])
  expect([store.session("a", "dd:1"), store.note("a", "dd:1")]).toEqual([undefined, undefined])
  expect(store.session("a", "other:1")?.id).toBe("s2")
})

test("sticky sessions are capped per automation, dropping the least recently used with their memory", () => {
  const store = open()
  store.setSession("a", "running", "s-run", 0)
  store.setNote("a", "old", "note")
  for (let i = 0; i < MAX_SESSIONS; i++) store.setSession("a", String(1000 + i), `s${i}`, 10 + i, ["running"])
  // A low monitor ID, newest of all: it stays, the oldest go, and the one with a run in progress stays.
  store.setSession("a", "5", "new", 9999, ["running"])
  expect(store.session("a", "5")).toEqual({ id: "new", usedAt: 9999 })
  expect(store.session("a", "running")).toBeDefined()
  expect(store.session("a", "1000")).toBeUndefined()
  expect(store.session("a", "1001")).toBeUndefined()
  expect(store.session("a", "1002")).toBeDefined()
  // Touching it marks it as used and warm, only while the key still points at that session.
  store.touchSession("a", "5", "new", 20_000, 30_000)
  store.touchSession("a", "5", "other", 40_000)
  expect(store.session("a", "5")).toEqual({ id: "new", usedAt: 20_000, warmUntil: 30_000 })
})

test("each automation keeps a note per key", () => {
  const store = open()
  store.setNote("a", "", "found 3 issues")
  store.setNote("a", "dd:1", "monitor 1")
  expect([store.note("a"), store.note("a", "dd:1"), store.note("b")]).toEqual(["found 3 issues", "monitor 1", undefined])
  store.setNote("a", "", undefined)
  expect(store.note("a")).toBeUndefined()
})

test("outbox messages wait per destination until sent, or until a retry is due", () => {
  const store = open()
  const id = store.enqueue({ job: "a", title: "T", body: "B", priority: "high" }, ["phone", "desktop"], 100)
  expect(store.due(100).map((s) => s.destination).sort()).toEqual(["desktop", "phone"])
  store.updateSend(id, "phone", "sent", 1, 100)
  store.updateSend(id, "desktop", "pending", 1, 500, "boom")
  expect(store.due(200)).toEqual([])
  expect(store.due(500)).toEqual([{ message: { id, at: 100, job: "a", title: "T", body: "B", priority: "high" }, destination: "desktop", attempts: 1 }])
  expect(store.sent("a")[0].sends).toEqual([{ destination: "desktop", status: "pending", error: "boom" }, { destination: "phone", status: "sent" }])
})
