import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Job } from "../store.ts"

const job = (overrides: Partial<Job>): Job => ({
  id: "job", name: "Job", prompt: "Check things", schedule: { kind: "every", ms: 60_000 },
  directory: "/project", session: "new", timeoutMinutes: 30, runMissed: true, enabled: true,
  source: "tool", createdAt: 1, ...overrides,
})

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
  expect(isActive(job({ paused: true }))).toBe(false)
  expect(isActive(job({ done: true }))).toBe(false)
  expect(isActive(job({}))).toBe(true)
  // Runs only on events but has no channel: it can never run, so it isn't active.
  expect(isActive(job({ schedule: { kind: "event" } }))).toBe(false)
  expect(isActive(job({ schedule: { kind: "event" }, on: { channels: ["dd"] } }))).toBe(true)
  expect(uniqueID([job({ id: "morning" })], "Morning")).toBe("morning-2")
  expect(relative(120_000, 0)).toBe("in 2m")
})

test("store persists edits and keeps latest status per run", async () => {
  const { Store } = await import("../store.ts")
  const dir = temp()
  const a = new Store(dir)
  const b = new Store(dir)
  expect(a.loadJobs()).toEqual([])
  a.saveJobs([job({ id: "one" })])
  await b.mutate((jobs) => { jobs[0].paused = true })
  expect(a.loadJobs()[0].paused).toBe(true)
  a.appendRun({ runID: "r1", jobID: "one", startedAt: 1, status: "running" })
  a.appendRun({ runID: "r1", jobID: "one", startedAt: 1, endedAt: 2, status: "succeeded" })
  a.appendRun({ runID: "r2", jobID: "two", startedAt: 3, status: "running" })
  expect(b.history("one", 10)).toHaveLength(1)
  expect(b.history("one", 10)[0].status).toBe("succeeded")
  expect(b.history(undefined, 1)[0].runID).toBe("r2")
  expect(b.history(undefined, 0)).toEqual([])
  a.appendRun({ runID: "r4", jobID: "two", startedAt: 4, status: "succeeded" })
  expect(b.history().map((r) => r.runID)).toEqual(["r4", "r2", "r1"])
  // A write that changes nothing isn't one: the TUI, which watches for writes, isn't woken.
  const version = b.version()
  a.saveJobs(a.loadJobs())
  expect(b.version()).toBe(version)
  a.saveJobs([])
  expect(b.version()).not.toBe(version)
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

test("a write waits for one in progress in another process instead of failing", async () => {
  const { Store } = await import("../store.ts")
  const dir = temp()
  const store = new Store(dir)
  const holder = Bun.spawn(["bun", "-e", `
    const { Database } = require("bun:sqlite")
    const db = new Database(${JSON.stringify(join(dir, "state.db"))})
    db.exec("BEGIN IMMEDIATE")
    console.log("locked")
    setTimeout(() => { db.exec("COMMIT"); process.exit(0) }, 300)
  `], { stdout: "pipe" })
  await holder.stdout.getReader().read() // "locked"
  const started = Date.now()
  await store.mutateChannels((s) => { s.sources.x = { failures: 1 } })
  expect(Date.now() - started).toBeGreaterThanOrEqual(100)
  expect(store.loadChannels().sources.x).toEqual({ failures: 1 })
  await holder.exited
  store.close()
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

test("history gives the latest record of each run, newest first, per automation", async () => {
  const { Store } = await import("../store.ts")
  const s = new Store(temp())
  for (let i = 0; i < 20; i++) {
    s.appendRun({ runID: `r${i}`, jobID: i % 2 ? "odd" : "even", startedAt: i, status: "running" })
    s.appendRun({ runID: `r${i}`, jobID: i % 2 ? "odd" : "even", startedAt: i, endedAt: i + 1, status: "failed", error: "délai dépassé ⧗" })
  }
  expect(s.history(undefined, 3).map((r) => r.runID)).toEqual(["r19", "r18", "r17"])
  expect(s.history("even", 2).map((r) => r.runID)).toEqual(["r18", "r16"])
  const all = s.history(undefined, 5000)
  expect(all).toHaveLength(20)
  expect(all.every((r) => r.status === "failed" && r.error === "délai dépassé ⧗")).toBe(true)
  s.close()
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

test("failureText says why a run failed in words, not JSON", async () => {
  const { failureText } = await import("../util.ts")
  const quota = { type: "provider.quota", message: "You have exceeded your monthly quota", status: 402, response: { body: "{\"error\":{}}" }, retryAfterMs: 10 }
  expect(failureText(quota)).toBe(
    "The model provider's quota is used up: You have exceeded your monthly quota (HTTP 402). Runs fail until it resets or the automation uses another model.",
  )
  expect(failureText({ type: "provider.auth", message: "Invalid API key.", status: 401 })).toBe("The model provider refused the request: Invalid API key (HTTP 401).")
  expect(failureText({ type: "tool.crash", message: "boom" })).toBe("boom.")
  expect(failureText("model overloaded")).toBe("model overloaded")
  expect(failureText({ code: 7 })).toBe('{"code":7}')
})
