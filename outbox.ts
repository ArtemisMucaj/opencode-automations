// The outbox: everything the plugin tells the user, delivered to the configured destinations with retries.

import { deliver, defaultDeps, type Deps, type Message, type Priority, type Destination } from "./notify.ts"
import { log } from "./log.ts"
import type { Job, Run, RunStatus, Store } from "./store.ts"
import { elapsed, errorMessage } from "./util.ts"

export type { Priority, Destination }

export interface OutboxConfig {
  /** Run outcomes that get an automatic notice. Default: failed, timeout. */
  on?: RunStatus[]
  destinations?: Destination[]
}

/** Per job: false = never notify, true = defaults, array = these outcomes get an automatic notice. */
export type JobNotify = boolean | RunStatus[]

const DEFAULT_ON: RunStatus[] = ["failed", "timeout"]
export const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000]
const RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2 }
const TYPES = new Set(["Notification.Native", "Notification.PushOver"])

export function parseDestinations(cfg: OutboxConfig | undefined): Destination[] {
  const destinations = cfg?.destinations ?? []
  const ids = new Set<string>()
  for (const s of destinations) {
    const where = `[automations] outbox destination "${s?.id ?? "?"}"`
    if (!s?.id) throw new Error("[automations] every outbox destination needs an id")
    if (ids.has(s.id)) throw new Error(`${where}: ids must be unique`)
    ids.add(s.id)
    if (!TYPES.has(s.type)) throw new Error(`${where}: type must be one of ${[...TYPES].join(", ")}`)
    if (s.type === "Notification.PushOver" && (!s.options?.token || !s.options?.user)) throw new Error(`${where} needs options.token and options.user`)
    if (s.minPriority !== undefined && !(s.minPriority in RANK)) throw new Error(`${where}: minPriority must be low, normal or high`)
  }
  return destinations
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
  readonly destinations: Destination[]
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
    this.destinations = parseDestinations(cfg)
    this.on = cfg?.on ?? DEFAULT_ON
  }

  /** Whether a job may notify at all. Destinations only decide where its messages go. */
  canNotify(job: Job): boolean {
    return job.notify !== false
  }

  /** Whether a run's outcome gets an automatic notice (never success). */
  noticeFor(job: Job, status: RunStatus): boolean {
    if (status === "succeeded" || !this.canNotify(job)) return false
    return (Array.isArray(job.notify) ? job.notify : this.on).includes(status)
  }

  /** Queue a message for every destination that takes its priority. */
  add(m: Message, from: { job?: string; run?: string } = {}): void {
    const priority = m.priority ?? "normal"
    const to = this.destinations.filter((d) => RANK[priority] >= RANK[d.minPriority ?? "low"]).map((d) => d.id)
    this.store.enqueue({ ...from, title: m.title, body: m.body, priority, url: m.url, urlTitle: m.urlTitle }, to)
    if (to.length) this.kick()
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
          await Promise.all(this.store.due().map((s) => this.attempt(s.message, s.destination, s.attempts)))
        } while (this.again)
      } finally { this.dispatching = undefined }
    })()
    return this.dispatching
  }

  private async attempt(m: Message & { id: number }, destinationID: string, attempts: number) {
    const destination = this.destinations.find((d) => d.id === destinationID)
    const tries = attempts + 1
    if (!destination) {
      this.store.updateSend(m.id, destinationID, "failed", tries, Date.now(), "no such destination any more")
      return
    }
    try {
      await deliver(destination, m, this.deps)
      this.store.updateSend(m.id, destinationID, "sent", tries, Date.now())
    } catch (err) {
      const error = errorMessage(err).slice(0, 500)
      const wait = RETRY_MS[attempts]
      if (wait === undefined) log.error({ via: destinationID, message: m.id, err }, "notification failed, giving up")
      else log.warn({ via: destinationID, message: m.id, err }, "notification failed, will retry")
      this.store.updateSend(m.id, destinationID, wait === undefined ? "failed" : "pending", tries, Date.now() + (wait ?? 0), error)
    }
  }
}
