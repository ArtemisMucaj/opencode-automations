import { CronExpressionParser } from "cron-parser"

export type Schedule =
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "every"; ms: number }
  | { kind: "at"; time: number }
  /** No schedule: runs when its channel has events. */
  | { kind: "event" }

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

export function parseDuration(value: unknown, units?: string[]): number | undefined {
  const match = typeof value === "string" ? /^(\d+(?:\.\d+)?)([a-z]+)$/.exec(value.trim()) : null
  const unit = match?.[2]
  return unit && Object.hasOwn(UNITS, unit) && (!units || units.includes(unit)) ? Number(match![1]) * UNITS[unit] : undefined
}

export function parseInterval(value: string): number {
  const ms = parseDuration(value, ["m", "h", "d", "w"])
  if (ms === undefined) throw new Error('invalid interval; use e.g. "15m", "2h", "1d"')
  if (!Number.isSafeInteger(ms) || ms < 60_000) throw new Error("interval must be at least one minute")
  return ms
}

export function parseCron(expr: string, tz?: string) {
  if (!expr.startsWith("@") && expr.trim().split(/\s+/).length !== 5) throw new Error("cron must have five fields")
  if (tz) new Intl.DateTimeFormat("en-US", { timeZone: tz })
  return CronExpressionParser.parse(expr, { tz })
}

export function nextRun(schedule: Schedule, now: number, anchor = now): number | undefined {
  switch (schedule.kind) {
    case "at": return schedule.time > now ? schedule.time : undefined
    case "event": return undefined
    case "every": {
      if (!Number.isSafeInteger(schedule.ms) || schedule.ms < 60_000) throw new Error("invalid interval")
      return anchor + Math.max(1, Math.floor((now - anchor) / schedule.ms) + 1) * schedule.ms
    }
    case "cron": {
      const cron = CronExpressionParser.parse(schedule.expr, { currentDate: now, tz: schedule.tz })
      return cron.hasNext() ? cron.next().getTime() : undefined
    }
  }
}

export function describe(schedule: Schedule): string {
  if (schedule.kind === "cron") return `cron "${schedule.expr}"${schedule.tz ? ` (${schedule.tz})` : ""}`
  if (schedule.kind === "at") return `at ${new Date(schedule.time).toISOString()}`
  if (schedule.kind === "event") return "on events"
  const units = [[604_800_000, "w"], [86_400_000, "d"], [3_600_000, "h"], [60_000, "m"]] as const
  const [size, unit] = units.find(([ms]) => schedule.ms % ms === 0) ?? units[3]
  return `every ${schedule.ms / size}${unit}`
}
