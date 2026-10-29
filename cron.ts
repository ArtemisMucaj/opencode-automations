import { CronExpressionParser } from "cron-parser"

export type Schedule =
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "every"; ms: number }
  | { kind: "at"; time: number }

export function parseInterval(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(m|h|d|w)$/.exec(value.trim())
  if (!match) throw new Error('invalid interval; use e.g. "15m", "2h", "1d"')
  const ms = Number(match[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]]!)
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
  const units = [[604_800_000, "w"], [86_400_000, "d"], [3_600_000, "h"], [60_000, "m"]] as const
  const [size, unit] = units.find(([ms]) => schedule.ms % ms === 0) ?? units[3]
  return `every ${schedule.ms / size}${unit}`
}
