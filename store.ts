import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import lockfile from "proper-lockfile"
import type { Schedule } from "./cron.ts"
import type { JobNotify } from "./notify.ts"
import { emptyChannels, type ChannelsState } from "./channels.ts"

/**
 * `sticky`: runs keep going to the same session. With a channel that sets `event.sessionKey`,
 * one sticky session per session key.
 */
export type SessionMode = "new" | "sticky" | "current"

/** `reuse` is the old name of `sticky`, still accepted in saved jobs and config. */
export const sessionMode = (mode?: string): SessionMode | undefined => (mode === "reuse" ? "sticky" : (mode as SessionMode | undefined))
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
  /** Runs on these channels' events: as they arrive (schedule kind "event") or on the schedule, as a digest. */
  on?: { channels: string[] }
  /** Most events in one run. Default 10, or 50 for a digest. */
  maxEvents?: number
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
  /** automation_notify calls the agent made. */
  notifications?: number
}

function read(path: string): string | undefined {
  try { return readFileSync(path, "utf8") }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/** Sleep without yielding; for the short waits between lock attempts. */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Take a file lock, retrying for up to `waitMs` while another holder has it. */
function lockSync(path: string, waitMs = 2000): () => void {
  const deadline = Date.now() + waitMs
  for (;;) {
    try { return lockfile.lockSync(path, { realpath: false }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error
      pause(10)
    }
  }
}

function writeAtomic(path: string, content: string): void {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, content, { mode: 0o600 })
    renameSync(temp, path)
  } finally {
    try { unlinkSync(temp) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
}

export class Store {
  private readonly jobsPath: string
  private readonly historyPath: string
  private readonly channelsPath: string
  private unlockLeader?: () => void

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    this.jobsPath = join(dataDir, "jobs.json")
    this.historyPath = join(dataDir, "history.jsonl")
    this.channelsPath = join(dataDir, "channels.json")
  }

  loadJobs(): Job[] {
    const raw = read(this.jobsPath)
    if (raw === undefined) return []
    const jobs: unknown = JSON.parse(raw)
    if (!Array.isArray(jobs)) throw new Error("jobs.json must contain an array")
    return (jobs as Job[]).map((j) => ({ ...j, session: sessionMode(j.session)! }))
  }

  saveJobs(jobs: Job[]): void {
    writeAtomic(this.jobsPath, JSON.stringify(jobs, null, 2) + "\n")
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

  loadChannels(): ChannelsState {
    const raw = read(this.channelsPath)
    if (raw === undefined) return emptyChannels()
    const state = JSON.parse(raw) as Partial<ChannelsState>
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("channels.json must contain an object")
    return { sources: state.sources ?? {}, queues: state.queues ?? {}, defs: state.defs ?? {}, config: state.config ?? {} }
  }

  /** Change channel state (poll state, automation queues) under the lock. */
  /** `waitMs`: how long to wait for another holder of the lock (the TUI waits less, so it never feels stuck). */
  mutateChannels<T>(fn: (state: ChannelsState) => T, waitMs = 2000): T {
    // No file is created before locking: the lock doesn't need it, and loadChannels() treats it as empty.
    // Retried: polls, deliveries and finished runs all write here, possibly from several processes.
    const unlock = lockSync(this.channelsPath, waitMs)
    try {
      const state = this.loadChannels()
      const result = fn(state)
      writeAtomic(this.channelsPath, JSON.stringify(state) + "\n") // compact: rewritten on every poll
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
