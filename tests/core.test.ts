import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
  const { parseScheduleText, isActive, uniqueID, relative } = await import("../jobs.ts")
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
  const { mutateRaw } = await import("../jobs.ts")
  const dir = temp()
  const a = new Store(dir)
  const b = new Store(dir)
  expect(a.loadJobs()).toEqual([])
  a.saveJobs([{ id: "one", enabled: true }] as any)
  await mutateRaw(b, (jobs) => { jobs[0].paused = true })
  expect(a.loadJobs()[0].paused).toBe(true)
  a.appendRun({ runID: "r1", jobID: "one", startedAt: 1, status: "running" })
  a.appendRun({ runID: "r1", jobID: "one", startedAt: 1, endedAt: 2, status: "succeeded", output: "done" })
  a.appendRun({ runID: "r2", jobID: "two", startedAt: 3, status: "running" })
  expect(b.history("one", 10)).toHaveLength(1)
  expect(b.history("one", 10)[0].output).toBe("done")
  expect(b.history(undefined, 1)[0].runID).toBe("r2")
  expect(b.history(undefined, 0)).toEqual([])
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
