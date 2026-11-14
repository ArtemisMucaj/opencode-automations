import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync, unlinkSync } from "node:fs"
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
/** A sticky session's memory: the last run's note, and until when the session's prompt cache is warm. */
export interface Memory {
  note?: string
  warmUntil?: number
}
export type RunStatus = "running" | "succeeded" | "failed" | "timeout" | "skipped"
export interface Job {
  id: string
  name: string
  prompt: string
  schedule: Schedule
  directory: string
  session: SessionMode
  sessionID?: string
  memory?: Memory
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
  /** Why it failed, timed out or was skipped. What the run said isn't kept here: it is in its session. */
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

/**
 * A file's lines, last first, read from its end a block at a time: the caller stops when it has enough,
 * so reading the latest runs doesn't mean reading the whole history.
 */
function* linesFromEnd(path: string, block = 64 * 1024): Generator<string> {
  let fd: number
  try { fd = openSync(path, "r") } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  try {
    let pos = fstatSync(fd).size
    let rest = Buffer.alloc(0) // the start of a line whose beginning is in the block before
    while (pos > 0) {
      const size = Math.min(block, pos)
      pos -= size
      const chunk = Buffer.alloc(size)
      readSync(fd, chunk, 0, size, pos)
      // Cut on the newline byte, which never falls inside a UTF-8 character.
      const buf = Buffer.concat([chunk, rest])
      const first = pos > 0 ? buf.indexOf(10) : -1
      if (pos > 0 && first < 0) { rest = buf; continue }
      rest = buf.subarray(0, first + 1)
      const lines = buf.subarray(first + 1).toString("utf8").split("\n")
      for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) yield lines[i]
    }
  } finally { closeSync(fd) }
}

/**
 * Take a file lock, retrying for up to `waitMs` while another holder has it (another process, or another
 * call in this one). The waits are async, so a busy lock never blocks the server's event loop or the TUI.
 */
async function lock(path: string, waitMs = 2000): Promise<() => Promise<void>> {
  const deadline = Date.now() + waitMs
  for (;;) {
    try { return await lockfile.lock(path, { realpath: false }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error
      await new Promise((r) => setTimeout(r, 10))
    }
  }
}

/** An unchanged file isn't rewritten, so a tick that changes nothing doesn't wake what watches the directory (the TUI). */
function writeAtomic(path: string, content: string): void {
  if (read(path) === content) return
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

  /**
   * Change jobs under the lock. `fn` may be async only to take the channels lock inside it (jobs, then
   * channels: that order everywhere), never to wait on anything slow.
   */
  async mutate<T>(fn: (jobs: Job[]) => T | Promise<T>): Promise<T> {
    // Retried like the channels lock: deletes and edits hold this one while they update channels.json.
    const unlock = await lock(this.jobsPath)
    try {
      const jobs = this.loadJobs()
      const result = await fn(jobs)
      this.saveJobs(jobs)
      return result
    } finally { await unlock() }
  }

  loadChannels(): ChannelsState {
    const raw = read(this.channelsPath)
    if (raw === undefined) return emptyChannels()
    const state = JSON.parse(raw) as Partial<ChannelsState>
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("channels.json must contain an object")
    return { sources: state.sources ?? {}, queues: state.queues ?? {}, defs: state.defs ?? {}, config: state.config ?? {} }
  }

  /** `waitMs`: how long to wait for another holder of the lock (the TUI waits less, so it never feels stuck). */
  async mutateChannels<T>(fn: (state: ChannelsState) => T, waitMs = 2000): Promise<T> {
    // No file is created before locking: the lock doesn't need it, and loadChannels() treats it as empty.
    // Retried: polls, deliveries and finished runs all write here, possibly from several processes.
    const unlock = await lock(this.channelsPath, waitMs)
    try {
      const state = this.loadChannels()
      const result = fn(state)
      writeAtomic(this.channelsPath, JSON.stringify(state) + "\n") // compact: rewritten on every poll
      return result
    } finally { await unlock() }
  }

  appendRun(run: Run): void {
    appendFileSync(this.historyPath, JSON.stringify(run) + "\n", { mode: 0o600 })
  }

  history(jobID?: string, limit = 10): Run[] {
    if (!Number.isFinite(limit) || limit <= 0) return []
    const max = Math.floor(limit)
    const latest = new Map<string, Run>()
    // Last line first, so the first record met for a run is its latest, and reading stops at `limit` runs.
    for (const line of linesFromEnd(this.historyPath)) {
      let run: Run
      // A line cut short (an append in progress, or a crash in the middle of one) is skipped, not fatal.
      try { run = JSON.parse(line) as Run } catch { continue }
      if (latest.has(run.runID) || (jobID && run.jobID !== jobID)) continue
      latest.set(run.runID, run)
      if (latest.size >= max) break
    }
    return [...latest.values()].sort((a, b) => b.startedAt - a.startedAt)
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
