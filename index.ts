// opencode v2 plugin: run prompts on a schedule, or on channel events taken from the inbox.
// What a run tells the user goes through the outbox (outbox.ts).

import { Plugin } from "@opencode/plugin"
import { randomUUID } from "node:crypto"
import { automationTools } from "./automation-tools.ts"
import { cacheLifetime } from "./cache.ts"
import { channelTools } from "./channel-tools.ts"
import { chunks, composeEvents, parseChannel, poll, summarize, type Channel, type ChannelEvent, type ChannelsState } from "./channels.ts"
import { nextRun } from "./cron.ts"
import { log } from "./log.ts"
import {
  AUTOMATIONS_GUIDE, CHANNEL_GUIDE, MEMORY_GUIDE, MEMORY_GUIDE_SHORT, NAMESPACES, NOTIFY_TOOL, RUN_GUIDE, RUN_GUIDE_SHORT,
  runContext, saidNothing, UPDATE_TOOL, withMemory,
} from "./guides.ts"
import { checkTimeout, DEFAULT_TIMEOUT_MINUTES, defaultDataDir, find, isActive, listens, parseModel, remembers, toSchedule } from "./jobs.ts"
import { compose, Outbox } from "./outbox.ts"
import { Store, type InboxEvent, type Job, type Run } from "./store.ts"
import type { Options, PollResult, Reason, Running, Runtime } from "./types.ts"
import { errorMessage, Owned, within } from "./util.ts"

const MISSED_GRACE_MS = 2 * 60_000
const CHANNEL_FAILURE_NOTICE = 3
const TRIM_EVERY_MS = 10 * 60_000

const WARM_SHARE = 0.9
/** For hosts that send no compaction end event. */
const COMPACTION_END_MS = 5_000
/** A stuck compaction mustn't hold up the ticker. Short: the summary is the saved memory, no model call. */
const COMPACTION_MAX_MS = 30_000
type Compaction = { summary: string; ended: () => void }
/**
 * Runs and compactions in progress, shared by every instance of the plugin in the process: opencode sets one up
 * per directory, and a session's tools and hooks may go through an instance other than the one that owns its run.
 */
type Shared = { running: Map<string, Running>; compactions: Map<string, Compaction> }
const SHARED: unique symbol = Symbol.for("OpencodeAutomations-Running")
const globals: typeof globalThis & { [SHARED]?: Shared } = globalThis
const shared = (globals[SHARED] ??= { running: new Map(), compactions: new Map() })
const EXECUTION_ENDS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.idle"])

export default Plugin.define({
  id: "automations",
  setup: async (ctx) => {
    const opts = (ctx.options ?? {}) as Options
    if ("notify" in opts) throw new Error("[automations] the notify option was replaced by outbox (senders under outbox.senders); see the README")
    const tickMs = Math.max(5, opts.tickSeconds ?? 30) * 1000
    const defaultTimeout = checkTimeout(opts.defaultTimeoutMinutes) ?? DEFAULT_TIMEOUT_MINUTES
    const dataDir = opts.dataDir ?? defaultDataDir()
    const store = new Store(dataDir)
    const outbox = new Outbox(store, opts.outbox, () => leader)
    const running = new Owned<Running>(shared.running)
    const abort = new AbortController()
    let leader = false

    // ---------- channels ----------

    const configChannels = new Map<string, Channel>()
    for (const c of opts.channels ?? []) {
      const ch = parseChannel(c)
      if (configChannels.has(ch.id)) throw new Error(`[automations] channel ids must be unique ("${ch.id}")`)
      configChannels.set(ch.id, ch)
    }
    /** Config channels without secrets, for the TUI. Only the leader publishes them: another process's config may differ. */
    let published = false
    async function publishConfig() {
      if (published) return
      try {
        const config = Object.fromEntries((opts.channels ?? []).map((c) => [c.id, summarize(c)]))
        await store.mutateChannels((s) => { s.config = config })
        published = true
      } catch (e) { log.error({ err: e }, "channel state can't be read or saved") }
    }

    /** Config channels plus created ones (re-read, so another process's are seen). Config wins on a clash. */
    function allChannels(defs = store.loadChannels().defs): Map<string, Channel> {
      const all = new Map(configChannels)
      for (const [id, def] of Object.entries(defs)) {
        if (all.has(id)) continue
        try { all.set(id, parseChannel({ ...def, id })) } catch (e) { log.error({ channel: id, err: e }, "channel definition is invalid") }
      }
      return all
    }

    function checkChannels(input: { on?: { channel?: string; channels?: string[] }; maxEvents?: number }): string[] | undefined {
      if (input.maxEvents !== undefined && !(input.maxEvents >= 1)) throw new Error("maxEvents must be at least 1")
      if (!input.on) return undefined
      const ids = [...new Set([...(input.on.channels ?? []), ...(input.on.channel ? [input.on.channel] : [])])]
      if (!ids.length) throw new Error("on needs at least one channel")
      const channels = allChannels()
      for (const id of ids) {
        if (!channels.has(id)) {
          throw new Error(`no channel "${id}"${channels.size ? ` (have: ${[...channels.keys()].join(", ")})` : "; create one with channel_create or under channels in config"}`)
        }
      }
      return ids
    }

    const channelNames = (ids: string[], channels = allChannels()) => Object.fromEntries(ids.map((id) => [id, channels.get(id)?.name ?? id]))

    // ---------- job state ----------

    const configJobs = (opts.jobs ?? []).map((c): Job => {
      if (!c.id || !c.prompt || !c.directory) throw new Error("[automations] config jobs need id, prompt and directory")
      parseModel(c.model ?? opts.defaultModel)
      const timeoutMinutes = checkTimeout(c.timeoutMinutes) ?? defaultTimeout
      let ids: string[] | undefined
      try { ids = checkChannels(c) } catch (e) { throw new Error(`[automations] job "${c.id}": ${errorMessage(e)}`) }
      return {
        id: c.id,
        name: c.name ?? c.id,
        prompt: c.prompt,
        schedule: toSchedule(c, { channels: !!ids, allowPast: true }),
        directory: c.directory,
        session: c.session ?? "new",
        agent: c.agent ?? opts.defaultAgent,
        model: c.model ?? opts.defaultModel,
        timeoutMinutes,
        runMissed: c.runMissed ?? true,
        enabled: c.enabled ?? true,
        notify: c.notify,
        ...(ids ? { on: { channels: ids } } : {}),
        ...(c.maxEvents ? { maxEvents: Math.floor(c.maxEvents) } : {}),
        source: "config",
        createdAt: Date.now(),
      }
    })

    /** Saved jobs with the config definitions re-applied. */
    function load(disk = store.loadJobs()): Job[] {
      const byID = new Map(disk.filter((j) => j.source === "tool").map((j) => [j.id, j]))
      for (const def of configJobs) {
        const prev = disk.find((j) => j.id === def.id && j.source === "config")
        const sameSchedule = prev && JSON.stringify(prev.schedule) === JSON.stringify(def.schedule)
        byID.set(def.id, {
          ...def,
          createdAt: prev?.createdAt ?? def.createdAt,
          lastRunAt: prev?.lastRunAt,
          lastStatus: prev?.lastStatus,
          paused: prev?.paused,
          done: sameSchedule ? prev?.done : undefined,
          runRequestedAt: prev?.runRequestedAt,
          nextRunAt: sameSchedule ? prev?.nextRunAt : undefined,
        })
      }
      return [...byID.values()]
    }

    const lastOkAt = (sources = store.loadChannels().sources) => Object.fromEntries(Object.entries(sources).map(([id, s]) => [id, s.lastOkAt]))
    const subscribers = (jobs: Job[]) =>
      JSON.stringify(jobs.map((j) => [j.id, j.enabled && !j.done, j.on?.channels ?? []]).sort())

    /** Change jobs in one transaction; `fn` must be synchronous. Subscriptions follow channel changes. */
    function mutate<T>(fn: (jobs: Job[]) => T): Promise<T> {
      return store.mutate((jobs) => {
        const before = subscribers(jobs)
        const merged = load(jobs)
        const out = fn(merged)
        jobs.splice(0, jobs.length, ...merged)
        if (subscribers(merged) !== before) store.subscribe(merged, lastOkAt())
        return out
      })
    }

    // ---------- firing ----------

    async function alive(sessionID: string | undefined): Promise<string | undefined> {
      if (!sessionID) return undefined
      try {
        const s = await ctx.session.get({ sessionID })
        if (!s.time.archived) return s.id
      } catch {}
      return undefined
    }

    async function createSession(job: Job, title: string): Promise<string> {
      const s = await ctx.session.create({
        title,
        agent: job.agent ?? null,
        model: parseModel(job.model) ?? null,
        location: { directory: job.directory },
      })
      return s.id
    }

    const keysRunning = (jobID: string) => [...running.values()].filter((f) => f.job.id === jobID && f.key !== undefined).map((f) => f.key!)

    /** The session a run goes to, and whether it was just made. */
    async function sessionFor(job: Job, key: string | undefined, title: string): Promise<{ id: string; fresh: boolean; warmUntil?: number }> {
      if (job.session === "current") {
        const id = await alive(job.sessionID)
        if (!id) throw new Error(`session ${job.sessionID} is gone`)
        return { id, fresh: false }
      }
      if (job.session === "sticky") {
        const saved = store.session(job.id, key ?? "")
        const id = await alive(saved?.id)
        if (id) return { id, fresh: false, warmUntil: saved?.warmUntil }
      }
      const id = await createSession(job, title)
      if (job.session === "sticky") store.setSession(job.id, key ?? "", id, Date.now(), keysRunning(job.id))
      return { id, fresh: true }
    }

    function finish(sessionID: string, status: Run["status"], error?: string) {
      const f = running.get(sessionID)
      if (!f) return
      running.delete(sessionID)
      clearTimeout(f.timer)
      const run: Run = {
        ...f.run, status, endedAt: Date.now(), error,
        ...(f.sent ? { notifications: f.sent } : {}),
      }
      // Removed from `running` synchronously above, so a second end event can't finish it twice.
      void track((async () => {
        try {
          store.appendRun(run)
          if (f.job.session === "sticky") {
            const key = f.key ?? ""
            store.touchSession(f.job.id, key, sessionID, run.endedAt!, f.cacheMs !== undefined ? run.endedAt! + f.cacheMs * WARM_SHARE : undefined)
            // A stale note would be the next compaction's summary and drop what this run found.
            if (!f.memoryUpdated) store.setNote(f.job.id, key, undefined)
          }
        } catch (e) { log.error({ job: run.jobID, err: e }, "couldn't save the run's end") }
        await mutate((jobs) => { const j = find(jobs, run.jobID); if (j) j.lastStatus = status })
          .catch((e) => log.error({ job: run.jobID, err: e }, "couldn't save the run's outcome on the job"))
        notice(f.job, run)
      })())
    }

    /** A turn ended: finish the run, or ask once if it neither notified nor saved its memory. */
    function ended(sessionID: string) {
      const f = running.get(sessionID)
      if (!f) return
      if (f.checked) return finish(sessionID, "succeeded")
      const notificationSent = !!f.sent || !outbox.canNotify(f.job) || saidNothing(f.lastText)
      const memoryUpdated = !!f.memoryUpdated || !remembers(f.job)
      if (notificationSent && memoryUpdated) return finish(sessionID, "succeeded")
      f.checked = true
      const reminders: string[] = []
      if (!notificationSent) reminders.push(RUN_GUIDE_SHORT)
      if (!memoryUpdated) reminders.push(MEMORY_GUIDE_SHORT)
      void ctx.session.prompt({
        sessionID,
        text: reminders.join("\n\n"),
        delivery: "queue",
        metadata: { automation: { jobID: f.job.id, runID: f.run.runID, reason: "check" } },
      }).catch((e) => {
        log.warn({ job: f.job.id, err: e }, "couldn't ask the run whether to notify")
        finish(sessionID, "succeeded")
      })
    }

    function notice(job: Job, run: Run) {
      if (!outbox.noticeFor(job, run.status)) return
      try { outbox.add(compose(job, run), { job: job.id, run: run.runID }) } catch (e) { log.error({ job: job.id, err: e }, "couldn't write a notice to the outbox") }
    }

    const isRunning = (jobID: string, key?: string) =>
      [...running.values()].some((f) => f.run.jobID === jobID && f.key === key)
    /** Starts in progress, by job and key, reserved before the first await so two can't share a session. */
    const pendingStarts = new Set<string>()
    const slotOf = (jobID: string, key?: string) => `${jobID}\u0000${key ?? ""}`
    const busy = (jobID: string, key?: string) => pendingStarts.has(slotOf(jobID, key)) || isRunning(jobID, key)

    /** Run a job; returns its run, or why none started. A manual run with nothing waiting runs anyway. */
    async function runAutomation(job: Job, reason: Reason, channels?: Map<string, Channel>): Promise<Run | string> {
      if (!job.on) return startSession(job, reason, { text: job.prompt })
      const { runs, why } = await processEvents(job, reason, channels ?? allChannels())
      if (runs.length) return runs[0]
      if (why !== NOTHING_WAITING || reason !== "manual") return why!
      return startSession(job, reason, { text: composeEvents(job.prompt, [], channelNames(job.on.channels)) })
    }

    const NOTHING_WAITING = "nothing is waiting"
    const STOPPING = "the plugin is stopping"

    async function processEvents(job: Job, reason: Reason, channels: Map<string, Channel>): Promise<{ runs: Run[]; why?: string }> {
      const subscribed = (job.on?.channels ?? []).map((id) => channels.get(id)).filter((c): c is Channel => !!c)
      if (!subscribed.length) return { runs: [], why: `none of its channels exist any more (${job.on?.channels.join(", ")})` }
      let waiting: InboxEvent[]
      try { waiting = store.waiting(job.id) } catch (e) {
        log.warn({ job: job.id, err: e }, "couldn't read the inbox, will retry")
        return { runs: [], why: "the inbox couldn't be read; it is retried on the next tick" }
      }
      if (!waiting.length) return { runs: [], why: NOTHING_WAITING }
      const names = channelNames(job.on!.channels, channels)
      const max = job.maxEvents ?? (job.schedule.kind === "event" ? 10 : 50)
      const byKey = job.session === "sticky" && subscribed.some((c) => !!c.event.sessionKey)
      const runs: Run[] = []
      let why: string | undefined
      for (const { key, events } of chunks(waiting, byKey, max)) {
        if (abort.signal.aborted) { why = STOPPING; break }
        if (busy(job.id, key)) { why ??= "its waiting events are for sessions that are still busy; they go in when those finish"; continue }
        const slot = slotOf(job.id, key)
        pendingStarts.add(slot)
        try {
          const r = await startChunk(job, reason, key, events, names)
          if (typeof r === "string") why ??= r
          else runs.push(r)
        } finally { pendingStarts.delete(slot) }
      }
      return { runs, why: runs.length ? undefined : why }
    }

    /** Hand one chunk of events to a run. Taken before the prompt is sent; given back if the run doesn't start. */
    async function startChunk(job: Job, reason: Reason, key: string | undefined, events: InboxEvent[], names: Record<string, string>): Promise<Run | string> {
      let got: Set<number>
      try { got = store.take(job.id, events.map((e) => e.seq)) } catch (e) {
        log.warn({ job: job.id, err: e }, "couldn't hand over events, will retry")
        return "the events couldn't be handed over; they're retried on the next tick"
      }
      // A leader that lost its lease mid-tick may have taken some.
      events = events.filter((e) => got.has(e.seq))
      if (!events.length) return "another process already took these events"
      const seqs = events.map((e) => e.seq)
      const run = await startSession(job, reason, {
        text: composeEvents(job.prompt, events, names),
        key,
        held: true,
        events: events.map((e) => `${e.channel}:${e.id}`),
        ...(key !== undefined ? { title: `⏰ ${job.name} · ${(events[0]?.title ?? key).slice(0, 60)}` } : {}),
      })
      if (run.status !== "running") {
        try { store.giveBack(job.id, seqs, run.status !== "skipped") } catch (e) { log.error({ job: job.id, err: e }, "couldn't put events back") }
      }
      return run
    }

    const compactions = new Owned<Compaction>(shared.compactions)

    /** Start a run. `held`: the caller already reserved the slot in pendingStarts. */
    async function startSession(
      job: Job,
      reason: Reason,
      how: { text: string; key?: string; events?: string[]; held?: boolean; title?: string },
    ): Promise<Run> {
      const runID = `${job.id}-${randomUUID()}`
      const base: Run = { jobID: job.id, runID, startedAt: Date.now(), status: "running" }
      const skipped = (error: string): Run => ({ ...base, status: "skipped", endedAt: Date.now(), error })

      if (abort.signal.aborted) return skipped("plugin stopping")
      const slot = slotOf(job.id, how.key)
      if (how.held ? isRunning(job.id, how.key) : busy(job.id, how.key)) {
        const run = skipped("previous run still in progress")
        store.appendRun(run)
        return run
      }
      if (!how.held) pendingStarts.add(slot)
      try {
        const key = how.key ?? ""
        const title = how.title ?? `⏰ ${job.name}${job.session === "new" ? ` · ${new Date().toLocaleString()}` : ""}`
        const { id: sessionID, fresh, warmUntil } = await sessionFor(job, how.key, title)
        const note = store.note(job.id, key)
        const text = fresh ? withMemory(how.text, note) : how.text
        // Compact before tracking the run, so the compaction's events aren't taken for the run's.
        const cold = job.session === "sticky" && !fresh && Date.now() >= (warmUntil ?? 0)
        if (cold && note) {
          // Given up on but still queued: it keeps its entry, so its late end event isn't taken for the run's.
          let queued = false
          try {
            const ended = new Promise<void>((r) => compactions.set(sessionID, { summary: note, ended: r }))
            const done = await within((async () => {
              await ctx.session.compact({ sessionID, delivery: "queue" })
              await ctx.session.wait({ sessionID })
            })(), COMPACTION_MAX_MS, abort.signal)
            if (done) await within(ended, COMPACTION_END_MS, abort.signal)
            else if (!abort.signal.aborted) {
              queued = true
              log.warn({ job: job.id, session: sessionID }, "the compaction didn't finish in time; the run is queued behind it")
            }
          } catch (e) {
            log.warn({ job: job.id, session: sessionID, err: e }, "couldn't compact the session; the run goes on with its whole history")
          } finally { if (!queued) compactions.delete(sessionID) }
        }
        if (abort.signal.aborted) return skipped("plugin stopping")
        const run: Run = { ...base, sessionID }
        const entry: Running = { job, run, sent: 0, key: how.key }
        running.set(sessionID, entry)
        store.appendRun(run)
        await mutate((jobs) => { const j = find(jobs, job.id); if (j) j.lastRunAt = run.startedAt })
          .catch((e) => log.error({ job: job.id, err: e }, "couldn't save the last run time"))
        entry.timer = setTimeout(() => {
          void ctx.session.interrupt({ sessionID }).catch(() => {})
          finish(sessionID, "timeout", `exceeded ${job.timeoutMinutes}m`)
        }, job.timeoutMinutes * 60_000)

        await ctx.session.prompt({
          sessionID,
          text,
          delivery: job.session === "new" ? null : "queue",
          metadata: {
            automation: {
              jobID: job.id, runID, reason,
              ...(job.on ? { channels: job.on.channels, sessionKey: how.key ?? null, events: how.events ?? [] } : {}),
            },
          },
        })
        return run
      } catch (e) {
        const failed: Run = { ...base, status: "failed", endedAt: Date.now(), error: errorMessage(e) }
        for (const [sid, f] of running) if (f.run.runID === runID) { clearTimeout(f.timer); running.delete(sid) }
        store.appendRun(failed)
        await mutate((jobs) => { const j = find(jobs, job.id); if (j) { j.lastStatus = "failed"; j.lastRunAt = base.startedAt } }).catch(() => {})
        notice(job, failed)
        return failed
      } finally { if (!how.held) pendingStarts.delete(slot) }
    }

    // ---------- ticker ----------

    let ticking = false
    let trimmedAt = 0
    async function tick() {
      if (abort.signal.aborted || ticking) return
      ticking = true
      try { await tickOnce() } finally { ticking = false }
    }

    async function tickOnce() {
      try { leader = store.lease(tickMs * 3) } catch (e) { log.error({ err: e }, "couldn't take the leader lease"); leader = false }
      if (!leader) { published = false; return }
      await publishConfig()
      const now = Date.now()
      const due: Array<[Job, "schedule" | "manual" | "missed"]> = []

      await mutate((jobs) => {
        for (const job of jobs) {
          if (job.runRequestedAt !== undefined) {
            job.runRequestedAt = undefined
            due.push([{ ...job }, "manual"])
            continue
          }
          if (job.schedule.kind === "event" || !isActive(job)) continue
          if (job.nextRunAt === undefined) {
            job.nextRunAt = nextRun(job.schedule, now, job.createdAt)
            if (job.nextRunAt === undefined) job.done = true
            continue
          }
          if (now < job.nextRunAt) continue
          const missed = now - job.nextRunAt > Math.max(MISSED_GRACE_MS, tickMs * 2)
          const reason = !missed ? "schedule" : job.runMissed ? "missed" : undefined
          if (reason) due.push([job, reason])
          job.nextRunAt = nextRun(job.schedule, now, job.createdAt)
          if (job.nextRunAt === undefined) job.done = true
        }
      })
      // Unreadable channel state stops the channels, not the scheduled automations.
      let state: ChannelsState | undefined
      let channels: Map<string, Channel> | undefined
      try {
        state = store.loadChannels()
        channels = allChannels(state.defs)
      } catch (e) { log.error({ err: e }, "channel state can't be read or saved") }
      for (const [job, reason] of due) {
        try { await runAutomation(job, reason, channels) } catch (e) { log.error({ job: job.id, err: e }, "run couldn't be started") }
      }
      if (state && channels) {
        // Catches changes made outside mutate() here (the TUI's).
        try { store.subscribe(load(), lastOkAt(state.sources)) } catch (e) { log.error({ err: e }, "couldn't update the inbox subscriptions") }
        try { await tickChannels(now, state.sources, channels) } catch (e) { log.error({ err: e }, "channel state can't be read or saved") }
      }
      if (now - trimmedAt >= TRIM_EVERY_MS) {
        trimmedAt = now
        try { store.trim(lastOkAt(state?.sources)) } catch (e) { log.warn({ err: e }, "couldn't trim the state") }
      }
      outbox.kick()
    }

    // ---------- channel polling ----------

    const polling = new Set<string>()
    /** Work teardown waits for. */
    const work = new Set<Promise<unknown>>()
    function track<T>(p: Promise<T>): Promise<T> {
      work.add(p)
      void p.finally(() => work.delete(p)).catch(() => {})
      return p
    }
    const listeners = (channelID: string, jobs = load()) => jobs.filter((j) => listens(j, channelID) && isActive(j))

    type Polled = { ch: Channel; events?: ChannelEvent[]; error?: string }

    /** Poll channels in parallel, then write all their events to the inbox in one transaction. */
    async function pollChannels(list: Channel[], jobs = load()): Promise<Map<string, PollResult>> {
      const results = new Map<string, PollResult>()
      if (!list.length) return results
      for (const ch of list) polling.add(ch.id)
      try {
        const polled = await Promise.all(list.map(async (ch): Promise<Polled> => {
          try { return { ch, events: await poll(ch, fetch, abort.signal) } }
          catch (e) { return { ch, error: errorMessage(e).slice(0, 500) } }
        }))
        if (abort.signal.aborted) {
          for (const ch of list) results.set(ch.id, { fresh: 0, error: STOPPING })
          return results
        }
        const notices: Array<{ ch: Channel; failures: number; error: string }> = []
        const at = Date.now()
        try {
          await store.mutateChannels((s) => {
            for (const p of polled) {
              const src = (s.sources[p.ch.id] ??= {})
              src.lastPollAt = at
              src.pollRequestedAt = undefined
              if (p.events === undefined) {
                src.lastError = p.error
                src.failures = (src.failures ?? 0) + 1
                results.set(p.ch.id, { fresh: 0, error: p.error })
                if (src.failures === CHANNEL_FAILURE_NOTICE) notices.push({ ch: p.ch, failures: src.failures, error: p.error! })
                continue
              }
              src.lastOkAt = at
              src.lastError = undefined
              src.failures = 0
              results.set(p.ch.id, { fresh: store.ingest(p.ch.id, p.events, at) })
            }
          })
        } catch (e) {
          // Only saving failed, not the polls: the next ones catch up.
          const error = `couldn't save the poll: ${errorMessage(e)}`
          log.warn({ channels: polled.map((p) => p.ch.id), err: e }, "couldn't save the poll")
          for (const p of polled) results.set(p.ch.id, { fresh: 0, error: p.error ?? error })
          return results
        }
        for (const p of polled) if (p.error) log.warn({ channel: p.ch.id, error: p.error }, "poll failed")
        for (const n of notices) {
          if (!listeners(n.ch.id, jobs).some((j) => outbox.canNotify(j))) continue
          try {
            outbox.add({ title: `Channel ${n.ch.name} can't poll`, body: `${n.failures} failed polls in a row. Last error: ${n.error}`, priority: "normal" })
          } catch (e) { log.error({ channel: n.ch.id, err: e }, "couldn't write a notice to the outbox") }
        }
        return results
      } finally { for (const ch of list) polling.delete(ch.id) }
    }

    /** Start runs for the automations without a schedule. */
    async function processArrivals(jobs = load(), channelID?: string, channels = allChannels()): Promise<number> {
      let started = 0
      for (const job of jobs) {
        if (job.schedule.kind !== "event" || !isActive(job) || (channelID && !listens(job, channelID))) continue
        started += (await processEvents(job, "event", channels)).runs.filter((r) => r.status === "running").length
      }
      return started
    }

    async function tickChannels(now: number, sources: ChannelsState["sources"], channels: Map<string, Channel>) {
      const jobs = load()
      const due = [...channels.values()].filter((ch) => {
        const src = sources[ch.id]
        const requested = src?.pollRequestedAt !== undefined
        if (polling.has(ch.id) || (!requested && !listeners(ch.id, jobs).length)) return false
        // Half a tick of slack, so polls don't drift a whole tick late.
        return requested || !src?.lastPollAt || now - src.lastPollAt >= ch.everyMs - tickMs / 2
      })
      await pollChannels(due, jobs)
      await processArrivals(jobs, undefined, channels)
    }

    // ---------- event pump: track runs to completion ----------

    const pumpEvents = async () => {
      let backoff = 1000
      while (!abort.signal.aborted) {
        try {
          for await (const ev of ctx.event.subscribe({ signal: abort.signal })) {
            backoff = 1000
            const data: unknown = ev.data
            const sid = typeof data === "object" && data !== null && "sessionID" in data && typeof data.sessionID === "string" ? data.sessionID : undefined
            const compaction = sid ? compactions.get(sid) : undefined
            if (compaction && EXECUTION_ENDS.has(ev.type)) {
              compaction.ended()
              compactions.delete(sid!)
              continue
            }
            if (!sid || !running.has(sid)) continue
            switch (ev.type) {
              case "session.text.ended":
                running.get(sid)!.lastText = ev.data.text
                break
              case "session.execution.failed":
                finish(sid, "failed", JSON.stringify(ev.data.error))
                break
              case "session.execution.interrupted": // by the user: a timeout finishes the run first
                finish(sid, "failed", "interrupted")
                break
              case "session.execution.succeeded":
                running.get(sid)!.v2 = true
                ended(sid)
                break
              case "session.idle": // legacy hosts
                if (!running.get(sid)!.v2) ended(sid)
                break
            }
          }
        } catch (e) {
          if (abort.signal.aborted) break
          log.warn({ err: e }, "event stream dropped, retrying")
        }
        if (abort.signal.aborted) break
        await new Promise((r) => setTimeout(r, backoff))
        backoff = Math.min(backoff * 2, 30_000)
      }
    }

    // ---------- hooks, tools, commands ----------

    await ctx.session.hook?.("context", (c) => {
      const f = running.find(c.sessionID)
      const notifies = !!f && outbox.canNotify(f.job)
      // Every instance's hook may see the session: add each text once.
      const add = (text: string) => { if (!c.system.some((p) => p.text === text)) c.system.push({ type: "text", text }) }
      if (notifies) add(RUN_GUIDE)
      else delete c.tools[NOTIFY_TOOL]
      if (f && remembers(f.job)) add(MEMORY_GUIDE)
      else delete c.tools[UPDATE_TOOL]
      if (f?.job.session === "sticky") f.cacheMs ??= cacheLifetime(c.options)
      if (f) add(runContext(f.job, notifies ? outbox.maxPerRun : undefined))
    })

    await ctx.session.hook?.("compaction", (c) => {
      const summary = compactions.find(c.sessionID)?.summary
      if (summary !== undefined) c.result = { summary }
    })

    const rt: Runtime = {
      ctx, opts, store, outbox, tickMs, defaultTimeout, configChannels,
      runOf: (sessionID) => running.find(sessionID),
      runningJobs: () => [...running.values()].map((f) => f.run.jobID),
      isPolling: (channelID) => polling.has(channelID),
      leader: () => leader,
      load, mutate, checkChannels, allChannels, runAutomation, pollChannels, processArrivals, track,
    }
    await ctx.tool.transform((tools) => {
      for (const ns of NAMESPACES) tools.namespace(ns)
      automationTools(tools, rt)
      channelTools(tools, rt)
    })

    await ctx.command.transform((commands) => {
      const guided = [
        { name: "automation", description: "Create, list, pause or run automations", guide: `${AUTOMATIONS_GUIDE}With no request, list them.` },
        {
          name: "channel", description: "Set up a channel (an API to poll for events) and the automations that run on it",
          guide: `${AUTOMATIONS_GUIDE}${CHANNEL_GUIDE}\n\nWith no request, list the channels and what uses them.`,
        },
      ]
      for (const { name, description, guide } of guided) {
        commands.add({
          name,
          description,
          execute: async ({ sessionID, prompt, delivery }) => {
            await ctx.session.prompt({ ...prompt, sessionID, delivery, text: `${guide}\n\nRequest: ${prompt.text ?? ""}` })
          },
        })
      }
    })

    const pump = pumpEvents()
    const runTick = () => void track(tick()).catch((e) => log.error({ err: e }, "tick failed"))
    const ticker = setInterval(runTick, tickMs)
    runTick()

    return async () => {
      abort.abort()
      clearInterval(ticker)
      await Promise.allSettled([...work])
      // Close their records, or they'd show as running forever.
      const open = [...running.values()]
      running.clear()
      for (const f of open) {
        clearTimeout(f.timer)
        try { store.appendRun({ ...f.run, status: "failed", endedAt: Date.now(), error: "opencode stopped before the run ended" }) } catch {}
      }
      if (open.length) {
        await mutate((jobs) => { for (const f of open) { const j = find(jobs, f.job.id); if (j) j.lastStatus = "failed" } })
          .catch((e) => log.error({ err: e }, "couldn't save the stopped runs' outcome"))
      }
      await Promise.allSettled([pump, outbox.idle()])
      store.close()
    }
  },
})
