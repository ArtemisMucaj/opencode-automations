import { homedir } from "node:os"
import { join } from "node:path"
import { nextRun, parseCron, parseInterval, type Schedule } from "./cron.ts"
import type { Job, Run } from "./store.ts"

export const defaultDataDir = () =>
  join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "plugins", "automations")

export const listens = (job: Job, channelID: string) => !!job.on?.channels.includes(channelID)
/** A job that only runs on events needs a channel; otherwise nothing would ever start it. */
export const runnable = (job: Job) => job.schedule.kind !== "event" || !!job.on?.channels.length
export const isActive = (job: Job) => job.enabled && !job.paused && !job.done && runnable(job)

export const stateOf = (j: Job) => (j.done ? "done" : j.paused ? "paused" : !j.enabled ? "disabled" : "active")

/**
 * Jobs with a run in progress. A run still "running" past its timeout was never closed (the server
 * crashed or was killed), so it doesn't count.
 */
export function runningJobs(jobs: Job[], runs: Run[], now = Date.now()): Set<string> {
  const timeout = new Map(jobs.map((j) => [j.id, j.timeoutMinutes]))
  return new Set(
    runs.filter((r) => r.status === "running" && now - r.startedAt < ((timeout.get(r.jobID) ?? DEFAULT_TIMEOUT_MINUTES) + 1) * 60_000).map((r) => r.jobID),
  )
}

export function uniqueID(jobs: Job[], name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "automation"
  let id = base
  for (let n = 2; jobs.some((job) => job.id === id); n++) id = `${base}-${n}`
  return id
}

/** A schedule typed in the TUI: "every 30m", a cron line with an optional time zone, or an ISO timestamp. */
export function parseScheduleText(text: string): Schedule {
  const value = text.trim()
  if (value.startsWith("every ")) return toSchedule({ every: value.slice(6).trim() })
  const fields = value.split(/\s+/)
  if (value.startsWith("@") || fields.length >= 5) {
    const length = value.startsWith("@") ? 1 : 5
    if (fields.length > length + 1) throw new Error("expected cron and optional time zone")
    return toSchedule({ cron: fields.slice(0, length).join(" "), tz: fields[length] })
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new Error("use cron, every 30m, or an ISO timestamp")
  return toSchedule({ at: value })
}

export function newJob(
  jobs: Job[],
  def: Pick<Job, "name" | "prompt" | "schedule" | "directory" | "session" | "timeoutMinutes"> & Partial<Job>,
  now = Date.now(),
): Job {
  return {
    runMissed: true, enabled: true, source: "tool", createdAt: now, nextRunAt: nextRun(def.schedule, now, now),
    ...def,
    id: uniqueID(jobs, def.name),
  }
}

export const DEFAULT_TIMEOUT_MINUTES = 30
/** Longest timeout a timer can hold: past 2^31 ms, setTimeout fires at once. */
const MAX_TIMEOUT_MINUTES = 35_000
export function checkTimeout(minutes: unknown): number | undefined {
  if (minutes === undefined || minutes === null) return undefined
  if (typeof minutes !== "number" || !(minutes > 0) || minutes > MAX_TIMEOUT_MINUTES) {
    throw new Error(`timeoutMinutes must be a number between 0 and ${MAX_TIMEOUT_MINUTES}`)
  }
  return minutes
}

export interface ScheduleInput {
  cron?: string
  every?: string
  at?: string
  tz?: string
}

/**
 * `channels`: the job has channels, so no schedule means "run when events arrive".
 * `allowPast`: a one-shot `at` may be over (config is read again on every start, long after it ran).
 */
export function toSchedule(s: ScheduleInput, { channels = false, allowPast = false } = {}): Schedule {
  const set = [s.cron, s.every, s.at].filter(Boolean).length
  if (set === 0 && channels) return { kind: "event" }
  if (set !== 1) throw new Error(channels ? "provide at most one of cron, every, at" : "provide exactly one of cron, every, at")
  if (s.cron) {
    parseCron(s.cron, s.tz) // validate eagerly; throws on a bad expression or time zone
    return { kind: "cron", expr: s.cron, ...(s.tz ? { tz: s.tz } : {}) }
  }
  if (s.every) return { kind: "every", ms: parseInterval(s.every) }
  const time = Date.parse(s.at!)
  if (Number.isNaN(time)) throw new Error(`invalid timestamp "${s.at}" (use ISO 8601)`)
  if (time <= Date.now() && !allowPast) throw new Error("'at' is in the past")
  return { kind: "at", time }
}

export function parseModel(ref?: string) {
  if (!ref) return undefined
  const [path, variant] = ref.split(":")
  const slash = path.indexOf("/")
  if (slash < 1) throw new Error(`model must be "provider/model[:variant]", got "${ref}"`)
  return { providerID: path.slice(0, slash), id: path.slice(slash + 1), ...(variant ? { variant } : {}) }
}

/** A job by ID, else by name. */
export function find(jobs: Job[], idOrName: string) {
  return jobs.find((j) => j.id === idOrName) ?? jobs.find((j) => j.name === idOrName)
}
