import { afterEach, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dirs: string[] = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "automations-test-"))
  dirs.push(dir)
  return dir
}
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

test("intervals reject invalid or sub-minute values", async () => {
  const { parseInterval } = await import("../cron.ts")
  expect(parseInterval("2h")).toBe(7_200_000)
  for (const value of ["0m", "30s", "-1h", "1m junk", "Infinityh"]) expect(() => parseInterval(value)).toThrow()
})

test("cron advances weekdays in requested timezone across DST", async () => {
  const { nextRun, parseCron } = await import("../cron.ts")
  parseCron("@daily")
  expect(() => parseCron("not cron")).toThrow()
  expect(nextRun({ kind: "cron", expr: "45 8 * * 1-5", tz: "Europe/Paris" }, Date.parse("2026-10-23T07:00:00Z")))
    .toBe(Date.parse("2026-10-26T07:45:00Z"))
})

test("intervals stay anchored and one-shots finish", async () => {
  const { nextRun, describe } = await import("../cron.ts")
  expect(nextRun({ kind: "every", ms: 60_000 }, 150_000, 10_000)).toBe(190_000)
  expect(nextRun({ kind: "at", time: 200_000 }, 150_000)).toBe(200_000)
  expect(nextRun({ kind: "at", time: 200_000 }, 200_000)).toBeUndefined()
  expect(describe({ kind: "every", ms: 1_800_000 })).toContain("30m")
})

test("TUI timing parser accepts cron, intervals, dates and rejects bad timezones", async () => {
  const { parseScheduleText, isActive, uniqueID } = await import("../jobs.ts")
  const { relative } = await import("../util.ts")
  expect(parseScheduleText("every 30m")).toEqual({ kind: "every", ms: 1_800_000 })
  expect(parseScheduleText("45 8 * * 1-5 Europe/Paris")).toEqual({ kind: "cron", expr: "45 8 * * 1-5", tz: "Europe/Paris" })
  expect(parseScheduleText("@daily")).toEqual({ kind: "cron", expr: "@daily" })
  expect(parseScheduleText("2099-11-02T09:00:00Z")).toEqual({ kind: "at", time: Date.parse("2099-11-02T09:00:00Z") })
  expect(() => parseScheduleText("@daily Not/AZone")).toThrow()
  expect(() => parseScheduleText("2000-01-01T00:00:00Z")).toThrow()
  const every = { kind: "every", ms: 60_000 }
  expect(isActive({ enabled: true, paused: true, schedule: every } as any)).toBe(false)
  expect(isActive({ enabled: true, done: true, schedule: every } as any)).toBe(false)
  expect(isActive({ enabled: true, schedule: every } as any)).toBe(true)
  // Runs only on events but has no channel: it can never run, so it isn't active.
  expect(isActive({ enabled: true, schedule: { kind: "event" } } as any)).toBe(false)
  expect(isActive({ enabled: true, schedule: { kind: "event" }, on: { channels: ["dd"] } } as any)).toBe(true)
  expect(uniqueID([{ id: "morning" }] as any, "Morning")).toBe("morning-2")
  expect(relative(120_000, 0)).toBe("in 2m")
})

test("store persists edits and keeps latest status per run", async () => {
  const { Store } = await import("../store.ts")
  const dir = temp()
  const a = new Store(dir)
  const b = new Store(dir)
  expect(a.loadJobs()).toEqual([])
  a.saveJobs([{ id: "one", enabled: true }] as any)
  await b.mutate((jobs) => { jobs[0].paused = true })
  expect(a.loadJobs()[0].paused).toBe(true)
  a.appendRun({ runID: "r1", jobID: "one", startedAt: 1, status: "running" })
  a.appendRun({ runID: "r1", jobID: "one", startedAt: 1, endedAt: 2, status: "succeeded" })
  a.appendRun({ runID: "r2", jobID: "two", startedAt: 3, status: "running" })
  expect(b.history("one", 10)).toHaveLength(1)
  expect(b.history("one", 10)[0].status).toBe("succeeded")
  expect(b.history(undefined, 1)[0].runID).toBe("r2")
  expect(b.history(undefined, 0)).toEqual([])
  // A line cut short by a crash is skipped; the runs around it still load.
  appendFileSync(join(dir, "history.jsonl"), '{"runID":"r3","jobID"\n')
  a.appendRun({ runID: "r4", jobID: "two", startedAt: 4, status: "succeeded" })
  expect(b.history().map((r) => r.runID)).toEqual(["r4", "r2", "r1"])
  writeFileSync(join(dir, "jobs.json"), "broken")
  expect(() => a.loadJobs()).toThrow()
})

test("lease elects one store instance and releases ownership", async () => {
  const { Store } = await import("../store.ts")
  const dir = temp()
  const a = new Store(dir)
  const b = new Store(dir)
  try {
    expect(a.lease(15_000)).toBe(true)
    expect(a.lease(15_000)).toBe(true)
    expect(b.lease(15_000)).toBe(false)
    b.release()
    expect(b.lease(15_000)).toBe(false)
    a.release()
    expect(b.lease(15_000)).toBe(true)
  } finally {
    a.release()
    b.release()
  }
})

test("channel state waits for a lock held by another process instead of failing", async () => {
  const { Store } = await import("../store.ts")
  const dir = temp()
  const store = new Store(dir)
  const holder = Bun.spawn(["bun", "-e", `
    const lockfile = require("proper-lockfile")
    const release = lockfile.lockSync(${JSON.stringify(join(dir, "channels.json"))}, { realpath: false })
    console.log("locked")
    setTimeout(() => { release(); process.exit(0) }, 300)
  `], { cwd: join(import.meta.dir, ".."), stdout: "pipe" })
  const reader = holder.stdout.getReader()
  await reader.read() // "locked"
  const started = Date.now()
  await store.mutateChannels((s) => { s.sources.x = { seen: ["a"] } })
  expect(Date.now() - started).toBeGreaterThanOrEqual(100)
  expect(store.loadChannels().sources.x.seen).toEqual(["a"])
  await holder.exited
})

test("waiting for a busy lock doesn't block the event loop", async () => {
  const { Store } = await import("../store.ts")
  const dir = temp()
  const store = new Store(dir)
  const holder = Bun.spawn(["bun", "-e", `
    const lockfile = require("proper-lockfile")
    const release = lockfile.lockSync(${JSON.stringify(join(dir, "channels.json"))}, { realpath: false })
    console.log("locked")
    setTimeout(() => { release(); process.exit(0) }, 400)
  `], { cwd: join(import.meta.dir, ".."), stdout: "pipe" })
  await holder.stdout.getReader().read()
  // A timer set while the write waits for the lock must fire on time, not after the lock is free.
  let fired = 0
  const started = Date.now()
  const timer = new Promise<void>((r) => setTimeout(() => { fired = Date.now() - started; r() }, 50))
  const write = store.mutateChannels((s) => { s.sources.x = { seen: [] } })
  await timer
  expect(fired).toBeLessThan(250)
  await write
  expect(Date.now() - started).toBeGreaterThanOrEqual(200)
  await holder.exited
})

test("within waits at most its time, or until its signal aborts", async () => {
  const { within } = await import("../util.ts")
  const never = new Promise(() => {})
  expect(await within(Promise.resolve(), 1000)).toBe(true)
  expect(await within(never, 5)).toBe(false)
  const abort = new AbortController()
  setTimeout(() => abort.abort(), 5)
  expect(await within(never, 60_000, abort.signal)).toBe(false)
  await expect(within(Promise.reject(new Error("boom")), 1000)).rejects.toThrow("boom")
})

test("history reads from the end of the file, across blocks, and stops when it has enough", async () => {
  const { Store } = await import("../store.ts")
  const s = new Store(temp())
  // Over 64 KB of records, with multi-byte text, so lines straddle block boundaries.
  for (let i = 0; i < 1500; i++) {
    s.appendRun({ runID: `r${i}`, jobID: i % 2 ? "odd" : "even", startedAt: i, status: "running" })
    s.appendRun({ runID: `r${i}`, jobID: i % 2 ? "odd" : "even", startedAt: i, endedAt: i + 1, status: "failed", error: "délai dépassé ⧗" })
  }
  expect(s.history(undefined, 3).map((r) => r.runID)).toEqual(["r1499", "r1498", "r1497"])
  expect(s.history("even", 2).map((r) => r.runID)).toEqual(["r1498", "r1496"])
  const all = s.history(undefined, 5000)
  expect(all).toHaveLength(1500)
  expect(all.every((r) => r.status === "failed" && r.error === "délai dépassé ⧗")).toBe(true)
})

test("the small helpers format counts, durations and errors", async () => {
  const { elapsed, httpError, orError, plural } = await import("../util.ts")
  expect([plural(1, "run"), plural(0, "run"), plural(3, "new event")]).toEqual(["1 run", "0 runs", "3 new events"])
  expect([elapsed({ startedAt: 0 }), elapsed({ startedAt: 0, endedAt: 200 }), elapsed({ startedAt: 0, endedAt: 45_000 }), elapsed({ startedAt: 0, endedAt: 150_000 }), elapsed({ startedAt: 0, endedAt: 180_000 })])
    .toEqual(["", "1s", "45s", "2m 30s", "3m"])
  expect(httpError(403, "bad key").message).toBe("HTTP 403: bad key")
  expect(httpError(500, "").message).toBe("HTTP 500")
  expect(await orError(async () => ({ content: "ok" }))).toEqual({ content: "ok" })
  expect(await orError(async () => { throw new Error("no job") })).toEqual({ content: "error: no job" })
})

test("a schedule typed in the TUI goes through the same checks as one from chat", async () => {
  const { parseScheduleText } = await import("../jobs.ts")
  expect(parseScheduleText("every 30m")).toEqual({ kind: "every", ms: 1_800_000 })
  expect(parseScheduleText("0 9 * * 1-5 Europe/Paris")).toEqual({ kind: "cron", expr: "0 9 * * 1-5", tz: "Europe/Paris" })
  expect(parseScheduleText("@daily")).toEqual({ kind: "cron", expr: "@daily" })
  expect(() => parseScheduleText("0 9 * * 1-5 Mars/Olympus")).toThrow()
  expect(() => parseScheduleText("2020-01-01T09:00:00Z")).toThrow("in the past")
  expect(() => parseScheduleText("tomorrow")).toThrow("use cron")
})
