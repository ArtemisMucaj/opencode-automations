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

test("trimming drops old events whose item is gone, but never one the channel still returns", () => {
  const store = open()
  const day = 24 * 60 * 60_000
  poll(store, 0, ev("gone"), ev("stays"))
  poll(store, 10 * day, ev("stays"))
  store.trim(latest, 10 * day)
  expect(store.db.query("SELECT id FROM inbox").all()).toEqual([{ id: "stays" }])
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

test("outbox messages wait per sender until sent, or until a retry is due", () => {
  const store = open()
  const id = store.enqueue({ job: "a", title: "T", body: "B", priority: "high" }, ["phone", "desktop"], 100)
  expect(store.due(100).map((s) => s.sender).sort()).toEqual(["desktop", "phone"])
  store.updateSend(id, "phone", "sent", 1, 100)
  store.updateSend(id, "desktop", "pending", 1, 500, "boom")
  expect(store.due(200)).toEqual([])
  expect(store.due(500)).toEqual([{ message: { id, at: 100, job: "a", title: "T", body: "B", priority: "high" }, sender: "desktop", attempts: 1 }])
  expect(store.sent("a")[0].sends).toEqual([{ sender: "desktop", status: "pending", error: "boom" }, { sender: "phone", status: "sent" }])
})
