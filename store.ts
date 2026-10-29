import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import lockfile from "proper-lockfile"
import type { Schedule } from "./cron.ts"
import type { JobNotify } from "./notify.ts"

export type SessionMode = "new" | "reuse" | "current"
export type RunStatus = "running" | "succeeded" | "failed" | "timeout" | "skipped"
export interface Job {
  id: string
  name: string
  prompt: string
  schedule: Schedule
  directory: string
  session: SessionMode
  sessionID?: string
  agent?: string
  model?: string
  timeoutMinutes: number
  runMissed: boolean
  enabled: boolean
  paused?: boolean
  done?: boolean
  runRequestedAt?: number
  notify?: JobNotify
  source: "config" | "tool"
  createdAt: number
  nextRunAt?: number
  lastRunAt?: number
  lastStatus?: RunStatus
}
export interface Run {
  jobID: string
  runID: string
  sessionID?: string
  startedAt: number
  endedAt?: number
  status: RunStatus
  output?: string
  error?: string
}

function read(path: string): string | undefined {
  try { return readFileSync(path, "utf8") }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

export class Store {
  private readonly jobsPath: string
  private readonly historyPath: string
  private unlockLeader?: () => void

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    this.jobsPath = join(dataDir, "jobs.json")
    this.historyPath = join(dataDir, "history.jsonl")
  }

  loadJobs(): Job[] {
    const raw = read(this.jobsPath)
    if (raw === undefined) return []
    const jobs: unknown = JSON.parse(raw)
    if (!Array.isArray(jobs)) throw new Error("jobs.json must contain an array")
    return jobs as Job[]
  }

  saveJobs(jobs: Job[]): void {
    const temp = `${this.jobsPath}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(jobs, null, 2) + "\n", { mode: 0o600 })
      renameSync(temp, this.jobsPath)
    } finally {
      try { unlinkSync(temp) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
  }

  mutate<T>(fn: (jobs: Job[]) => T): T {
    const unlock = lockfile.lockSync(this.jobsPath, { realpath: false })
    try {
      const jobs = this.loadJobs()
      const result = fn(jobs)
      this.saveJobs(jobs)
      return result
    } finally { unlock() }
  }

  appendRun(run: Run): void {
    appendFileSync(this.historyPath, JSON.stringify(run) + "\n", { mode: 0o600 })
  }

  history(jobID?: string, limit = 10): Run[] {
    if (!Number.isFinite(limit) || limit <= 0) return []
    const raw = read(this.historyPath)
    if (!raw) return []
    const latest = new Map<string, Run>()
    const lines = raw.split("\n")
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue
      try {
        const run = JSON.parse(lines[i]) as Run
        latest.set(run.runID, run)
      } catch (error) {
        // A concurrent append may expose only the last, incomplete line.
        if (i !== lines.length - 1) throw error
      }
    }
    return [...latest.values()].filter((run) => !jobID || run.jobID === jobID)
      .sort((a, b) => b.startedAt - a.startedAt).slice(0, Math.floor(limit))
  }

  lease(ttl: number): boolean {
    if (this.unlockLeader) return true
    try {
      this.unlockLeader = lockfile.lockSync(join(this.dataDir, "leader"), {
        realpath: false,
        stale: Math.max(2000, ttl),
        onCompromised: () => { this.unlockLeader = undefined },
      })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") return false
      throw error
    }
  }

  release(): void {
    const unlock = this.unlockLeader
    this.unlockLeader = undefined
    unlock?.()
  }
}
