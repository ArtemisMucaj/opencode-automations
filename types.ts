// Shapes shared by the server plugin's files.

import type { Plugin } from "@opencode/plugin"
import type { Channel, ChannelConfig, ChannelsState } from "./channels.ts"
import type { ScheduleInput } from "./jobs.ts"
import type { JobNotify, NotifyConfig } from "./notify.ts"
import type { Job, Memory, Run, SessionMode, Store } from "./store.ts"

export type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]
export type ToolEditor = Parameters<Parameters<Context["tool"]["transform"]>[0]>[0]

export interface Options {
  dataDir?: string
  tickSeconds?: number
  defaultTimeoutMinutes?: number
  defaultAgent?: string
  defaultModel?: string
  notify?: NotifyConfig
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

export interface InFlight {
  job: Job
  run: Run
  lastText?: string
  /** automation_notify calls that delivered somewhere. */
  sent: number
  timer?: ReturnType<typeof setTimeout>
  /** Session key of a run in its key's session: runs for different keys may overlap. */
  key?: string
  /** The run ended without notifying (or saving its memory) and was asked once to do it. */
  checked?: boolean
  memoryUpdated?: boolean
  cacheMs?: number
  /** The host reports V2 execution events, so legacy idle events are redundant. */
  v2?: boolean
}

export type Reason = "schedule" | "manual" | "missed" | "event"

/** Channels and their state, read once and shared by the deliveries of one tick or call. */
export type Loaded = { channels: Map<string, Channel>; state: ChannelsState }
export type PollResult = { fresh: number; error?: string }

/** What the tools use of the running plugin (built in index.ts). */
export interface Runtime {
  ctx: Context
  opts: Options
  store: Store
  /** The run in progress in a session, if any. */
  runOf(sessionID: string): InFlight | undefined
  /** IDs of the jobs running in this process. */
  runningJobs(): string[]
  tickMs: number
  defaultTimeout: number
  maxPerRun: number
  configChannels: Map<string, Channel>
  isPolling(channelID: string): boolean
  /** Whether this process holds the lease, so runs the ticker. */
  leader(): boolean
  load(disk?: Job[]): Job[]
  mutate<T>(fn: (jobs: Job[]) => T | Promise<T>): Promise<T>
  checkChannels(input: { on?: { channel?: string; channels?: string[] }; maxEvents?: number }): string[] | undefined
  allChannels(defs?: Record<string, ChannelConfig>): Map<string, Channel>
  remember(jobID: string, key: string | undefined, sessionID: string, patch: Memory): Promise<void>
  runAutomation(job: Job, reason: Reason, loaded?: Loaded): Promise<Run | string>
  pollChannels(list: Channel[], jobs?: Job[]): Promise<{ results: Map<string, PollResult>; state?: ChannelsState }>
  processArrivals(jobs?: Job[], channelID?: string, state?: ChannelsState): Promise<number>
  /** Count a promise as work that teardown waits for. */
  track<T>(p: Promise<T>): Promise<T>
}
