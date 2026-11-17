// Shapes shared by the server plugin's files.

import type { Plugin } from "@opencode/plugin"
import type { Channel, ChannelConfig } from "./channels.ts"
import type { ScheduleInput } from "./jobs.ts"
import type { JobNotify, Outbox, OutboxConfig } from "./outbox.ts"
import type { Job, Run, SessionMode, Store } from "./store.ts"

export type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]
export type ToolEditor = Parameters<Parameters<Context["tool"]["transform"]>[0]>[0]

export interface Options {
  dataDir?: string
  tickSeconds?: number
  defaultTimeoutMinutes?: number
  defaultAgent?: string
  defaultModel?: string
  outbox?: OutboxConfig
  jobs?: ConfigJob[]
  channels?: ChannelConfig[]
}

export interface ConfigJob extends ScheduleInput {
  id: string
  name?: string
  prompt: string
  directory?: string
  session?: Exclude<SessionMode, "current">
  /** `channels` for one or more; `channel` is shorthand for one. */
  on?: { channel?: string; channels?: string[] }
  maxEvents?: number
  agent?: string
  model?: string
  timeoutMinutes?: number
  runMissed?: boolean
  enabled?: boolean
  notify?: JobNotify
}

/** A run in progress in this process: its saved record (status "running") and what tracks it until it ends. */
export interface Running {
  job: Job
  run: Run
  lastText?: string
  /** automation_notify calls, each a message in the outbox. */
  sent: number
  timer?: ReturnType<typeof setTimeout>
  /** Session key of a run in its key's session: runs for different keys may overlap. */
  key?: string
  /** The run ended without notifying or saving its memory, and was asked once to do it. */
  checked?: boolean
  memoryUpdated?: boolean
  cacheMs?: number
  /** The host reports V2 execution events, so legacy idle events are redundant. */
  v2?: boolean
}

export type Reason = "schedule" | "manual" | "missed" | "event"

export type PollResult = { fresh: number; error?: string }

/** What the tools use of the running plugin (built in index.ts). */
export interface Runtime {
  ctx: Context
  opts: Options
  store: Store
  outbox: Outbox
  /** The run in progress in a session, if any. */
  runOf(sessionID: string): Running | undefined
  /** IDs of the jobs running in this process. */
  runningJobs(): string[]
  tickMs: number
  defaultTimeout: number
  configChannels: Map<string, Channel>
  isPolling(channelID: string): boolean
  /** Whether this process holds the lease, so runs the ticker. */
  leader(): boolean
  load(disk?: Job[]): Job[]
  /** Change jobs in one transaction; `fn` must be synchronous. Subscriptions follow the jobs' channels. */
  mutate<T>(fn: (jobs: Job[]) => T): Promise<T>
  checkChannels(input: { on?: { channel?: string; channels?: string[] }; maxEvents?: number }): string[] | undefined
  allChannels(defs?: Record<string, ChannelConfig>): Map<string, Channel>
  runAutomation(job: Job, reason: Reason): Promise<Run | string>
  pollChannels(list: Channel[], jobs?: Job[]): Promise<Map<string, PollResult>>
  processArrivals(jobs?: Job[], channelID?: string): Promise<number>
  /** Send what is due in the outbox, if this process is the leader (else the leader does on its tick). */
  dispatch(): void
  /** Count a promise as work that teardown waits for. */
  track<T>(p: Promise<T>): Promise<T>
}
