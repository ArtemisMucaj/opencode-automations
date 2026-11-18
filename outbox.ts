// The outbox: everything the plugin tells the user, delivered to the configured senders with retries.

import { deliver, defaultDeps, type Deps, type Message, type Priority, type Sender } from "./notify.ts"
import { log } from "./log.ts"
import type { Job, Run, RunStatus, Store } from "./store.ts"
import { elapsed, errorMessage } from "./util.ts"

export type { Priority, Sender }

export interface OutboxConfig {
  /** Run outcomes that get an automatic notice. Default: failed, timeout. */
  on?: RunStatus[]
  /** Default 5. */
  maxPerRun?: number
  senders?: Sender[]
}

/** Per job: false = never notify, true = defaults, array = these outcomes get an automatic notice. */
export type JobNotify = boolean | RunStatus[]

const DEFAULT_ON: RunStatus[] = ["failed", "timeout"]
export const DEFAULT_MAX_PER_RUN = 5
export const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000]
const RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2 }
const TYPES = new Set(["native", "pushover"])

export function parseSenders(cfg: OutboxConfig | undefined): Sender[] {
  const senders = cfg?.senders ?? []
  const ids = new Set<string>()
  for (const s of senders) {
    const where = `[automations] outbox sender "${s?.id ?? "?"}"`
    if (!s?.id) throw new Error("[automations] every outbox sender needs an id")
    if (ids.has(s.id)) throw new Error(`${where}: ids must be unique`)
    ids.add(s.id)
    if (!TYPES.has(s.type)) throw new Error(`${where}: type must be one of ${[...TYPES].join(", ")}`)
    if (s.type === "pushover" && (!s.token || !s.user)) throw new Error(`${where} needs token and user`)
    if (s.minPriority !== undefined && !(s.minPriority in RANK)) throw new Error(`${where}: minPriority must be low, normal or high`)
  }
  return senders
}

/** The automatic notice for a failed or timed-out run. */
export function compose(job: Job, run: Run): Message {
  const error = run.error?.trim()
  switch (run.status) {
    case "failed":
      return { title: `${job.name} failed`, body: error || `Failed after ${elapsed(run)}.`, priority: "high" }
    case "timeout":
      return { title: `${job.name} timed out`, body: error ? `Stopped: ${error}.` : `Stopped after ${elapsed(run)}.`, priority: "high" }
    default:
      return { title: `${job.name} ${run.status}`, body: error || `After ${elapsed(run)}.`, priority: "normal" }
  }
}

export class Outbox {
  readonly senders: Sender[]
  readonly maxPerRun: number
  private readonly on: RunStatus[]
  private dispatching?: Promise<void>
  private again = false

  /** `sends`: whether this process sends (only the leader does). */
  constructor(
    private readonly store: Store,
    cfg: OutboxConfig | undefined,
    private readonly sends: () => boolean = () => true,
    private readonly deps: Deps = defaultDeps,
  ) {
    this.senders = parseSenders(cfg)
    this.maxPerRun = cfg?.maxPerRun ?? DEFAULT_MAX_PER_RUN
    this.on = cfg?.on ?? DEFAULT_ON
  }

  /** Whether a job may notify at all. */
  canNotify(job: Job): boolean {
    return job.notify !== false && this.senders.length > 0
  }

  /** Whether a run's outcome gets an automatic notice (never success). */
  noticeFor(job: Job, status: RunStatus): boolean {
    if (status === "succeeded" || !this.canNotify(job)) return false
    return (Array.isArray(job.notify) ? job.notify : this.on).includes(status)
  }

  /** Queue a message for every sender that takes its priority; returns how many do. */
  add(m: Message, from: { job?: string; run?: string } = {}): number {
    const priority = m.priority ?? "normal"
    const to = this.senders.filter((s) => RANK[priority] >= RANK[s.minPriority ?? "low"]).map((s) => s.id)
    this.store.enqueue({ ...from, title: m.title, body: m.body, priority, url: m.url, urlTitle: m.urlTitle }, to)
    if (to.length) this.kick()
    return to.length
  }

  /** Start sending what is due, without waiting. */
  kick(): void {
    if (this.sends()) void this.dispatch().catch((err) => log.error({ err }, "outbox dispatch failed"))
  }

  /** The pass in progress, for shutdown to wait on. */
  idle(): Promise<void> {
    return this.dispatching ?? Promise.resolve()
  }

  /** Send what is due. A call during a pass makes it go round once more. */
  dispatch(): Promise<void> {
    if (this.dispatching) { this.again = true; return this.dispatching }
    this.dispatching = (async () => {
      try {
        do {
          this.again = false
          await Promise.all(this.store.due().map((s) => this.attempt(s.message, s.sender, s.attempts)))
        } while (this.again)
      } finally { this.dispatching = undefined }
    })()
    return this.dispatching
  }

  private async attempt(m: Message & { id: number }, senderID: string, attempts: number) {
    const sender = this.senders.find((s) => s.id === senderID)
    const tries = attempts + 1
    if (!sender) {
      this.store.updateSend(m.id, senderID, "failed", tries, Date.now(), "no such sender any more")
      return
    }
    try {
      await deliver(sender, m, this.deps)
      this.store.updateSend(m.id, senderID, "sent", tries, Date.now())
    } catch (err) {
      const error = errorMessage(err).slice(0, 500)
      const wait = RETRY_MS[attempts]
      if (wait === undefined) log.error({ via: senderID, message: m.id, err }, "notification failed, giving up")
      else log.warn({ via: senderID, message: m.id, err }, "notification failed, will retry")
      this.store.updateSend(m.id, senderID, wait === undefined ? "failed" : "pending", tries, Date.now() + (wait ?? 0), error)
    }
  }
}
