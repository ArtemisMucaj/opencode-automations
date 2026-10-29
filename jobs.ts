import { homedir } from "node:os"
import { join } from "node:path"
import { parseCron, parseInterval, type Schedule } from "./cron.ts"
import { type Job, type Store } from "./store.ts"

export const defaultDataDir = () =>
  join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "plugins", "automations")

export const isActive = (job: Job) => job.enabled && !job.paused && !job.done
export const mutateRaw = <T>(store: Store, fn: (jobs: Job[]) => T): T => store.mutate(fn)

export function uniqueID(jobs: Job[], name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "automation"
  let id = base
  for (let n = 2; jobs.some((job) => job.id === id); n++) id = `${base}-${n}`
  return id
}

export function parseScheduleText(text: string): Schedule {
  const value = text.trim()
  if (value.startsWith("every ")) return { kind: "every", ms: parseInterval(value.slice(6)) }
  const fields = value.split(/\s+/)
  if (value.startsWith("@") || fields.length >= 5) {
    const length = value.startsWith("@") ? 1 : 5
    if (fields.length > length + 1) throw new Error("expected cron and optional time zone")
    const expr = fields.slice(0, length).join(" ")
    const tz = fields[length]
    parseCron(expr, tz)
    return { kind: "cron", expr, ...(tz ? { tz } : {}) }
  }
  const time = Date.parse(value)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(time)) throw new Error("use cron, every 30m, or an ISO timestamp")
  if (time <= Date.now()) throw new Error("timestamp is in the past")
  return { kind: "at", time }
}

export function relative(time: number | undefined, now = Date.now()): string {
  if (time === undefined) return "—"
  const delta = time - now
  const minutes = Math.max(1, Math.round(Math.abs(delta) / 60_000))
  const value = minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`
  return delta >= 0 ? `in ${value}` : `${value} ago`
}
