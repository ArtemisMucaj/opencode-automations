// opencode v2 plugin: run prompts on a schedule, or on events from a channel.
// The tools are in automation-tools.ts and channel-tools.ts, what the agent is told in guides.ts.

import { Plugin } from "@opencode/plugin"
import { randomUUID } from "node:crypto"
import { automationTools } from "./automation-tools.ts"
import { cacheLifetime } from "./cache.ts"
import { channelTools } from "./channel-tools.ts"
import {
  assign, chunks, composeEvents, emptySource, enqueue, ingest, MAX_START_ATTEMPTS, parseChannel, poll, queueOf, requeue,
  summarize, touch, uid,
  type Channel, type ChannelEvent, type ChannelsState,
} from "./channels.ts"
import { nextRun } from "./cron.ts"
import { log } from "./log.ts"
import {
  AUTOMATIONS_GUIDE, CHANNEL_GUIDE, MEMORY_GUIDE, MEMORY_GUIDE_SHORT, NAMESPACES, NOTIFY_TOOL, RUN_GUIDE, RUN_GUIDE_SHORT,
  runContext, saidNothing, UPDATE_TOOL,
} from "./guides.ts"
import { checkTimeout, DEFAULT_TIMEOUT_MINUTES, defaultDataDir, find, isActive, listens, parseModel, toSchedule } from "./jobs.ts"
import { canNotify, compose, DEFAULT_MAX_PER_RUN, send, shouldNotify } from "./notify.ts"
import { sessionMode, Store, type Job, type Memory, type Run } from "./store.ts"
import type { InFlight, Loaded, Options, PollResult, Reason, Runtime } from "./types.ts"
import { errorMessage, within } from "./util.ts"

const MISSED_GRACE_MS = 2 * 60_000
const CHANNEL_FAILURE_NOTICE = 3

const WARM_SHARE = 0.9
/** How long a cold run waits for its compaction's end event, for hosts that send none. */
const COMPACTION_END_MS = 5_000
/**
 * Longest a compaction may take before the run goes on without it: a stuck one mustn't hold up the ticker.
 * Short, since the summary is the saved memory: no model is called.
 */
const COMPACTION_MAX_MS = 30_000
const EXECUTION_ENDS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.idle"])

export default Plugin.define({
  id: "automations",
  setup: async (ctx) => {
    const opts = (ctx.options ?? {}) as Options
    const tickMs = Math.max(5, opts.tickSeconds ?? 30) * 1000
    const defaultTimeout = checkTimeout(opts.defaultTimeoutMinutes) ?? DEFAULT_TIMEOUT_MINUTES
    const dataDir = opts.dataDir ?? defaultDataDir()
    const store = new Store(dataDir)
    const inflight = new Map<string, InFlight>() // sessionID -> run
    const abort = new AbortController()
    let leader = false

    // ---------- channels ----------

    const configChannels = new Map<string, Channel>()
    for (const c of opts.channels ?? []) {
      const ch = parseChannel(c)
      if (configChannels.has(ch.id)) throw new Error(`[automations] channel ids must be unique ("${ch.id}")`)
      configChannels.set(ch.id, ch)
    }
    /**
     * What the config channels look like (no headers or body, so no secrets), for the TUI. Only the leader
     * publishes it, since it is the one that polls: another process with other config mustn't overwrite it.
     */
    let published = false
    async function publishConfig() {
      if (published) return
      try {
        const config = Object.fromEntries((opts.channels ?? []).map((c) => [c.id, summarize(c)]))
        await store.mutateChannels((s) => { s.config = config })
        published = true
      } catch (e) { log.error({ err: e }, "channel state can't be read or saved") }
    }

    /**
     * Config channels plus those created with channel_create, read from disk each time so a channel
     * created in another process is polled by the leader on its next tick. Config wins on an ID clash.
     */
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
        session: sessionMode(c.session) ?? "new",
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

    /** Disk is the source of truth (other processes may write); re-apply config definitions. */
    function load(disk = store.loadJobs()): Job[] {
      const byID = new Map(disk.filter((j) => j.source === "tool").map((j) => [j.id, j]))
      for (const def of configJobs) {
        const prev = disk.find((j) => j.id === def.id && j.source === "config")
        const sameSchedule = prev && JSON.stringify(prev.schedule) === JSON.stringify(def.schedule)
        byID.set(def.id, {
          ...def,
          createdAt: prev?.createdAt ?? def.createdAt,
          sessionID: prev?.sessionID,
          memory: prev?.memory,
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

    function mutate<T>(fn: (jobs: Job[]) => T | Promise<T>): Promise<T> {
      return store.mutate(async (jobs) => {
        const merged = load(jobs)
        const out = await fn(merged)
        jobs.splice(0, jobs.length, ...merged)
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

    // ---------- sticky memory ----------
    // A sticky session is continued while its prompt cache is warm. Once cold, the next run compacts it to the
    // memory the last run saved, so the earlier runs aren't re-read at full price.

    function memoryOf(jobID: string, key: string | undefined, sessionID: string): Memory | undefined {
      try {
        if (key === undefined) {
          const j = find(load(), jobID)
          return j?.sessionID === sessionID ? j.memory : undefined
        }
        const entry = store.loadChannels().queues[jobID]?.sessions[key]
        return entry?.id === sessionID ? entry : undefined
      } catch (e) {
        log.warn({ job: jobID, err: e }, "couldn't read the memory")
        return undefined
      }
    }
    const prevNote = (m: Memory | undefined, now = Date.now()) => m?.note && now >= (m.warmUntil ?? 0) ? m.note : undefined
    async function remember(jobID: string, key: string | undefined, sessionID: string, patch: Memory) {
      if (key === undefined) {
        await mutate((jobs) => { const j = find(jobs, jobID); if (j?.sessionID === sessionID) j.memory = { ...j.memory, ...patch } })
      } else {
        await store.mutateChannels((s) => { const entry = s.queues[jobID]?.sessions[key]; if (entry?.id === sessionID) Object.assign(entry, patch) })
      }
    }

    async function resolveSession(job: Job): Promise<string> {
      if (job.session !== "new" && job.sessionID) {
        const id = await alive(job.sessionID)
        if (id) return id
        if (job.session === "current") throw new Error(`session ${job.sessionID} is gone`)
      }
      const id = await createSession(job, `⏰ ${job.name}${job.session === "new" ? ` · ${new Date().toLocaleString()}` : ""}`)
      if (job.session === "sticky") await mutate((jobs) => { const j = find(jobs, job.id); if (j) { j.sessionID = id; delete j.memory } })
      return id
    }

    /**
     * The sticky session for a session key: the saved one if it still exists, else a new one.
     * Nothing is written here; startChunk() saves the mapping together with taking the events.
     */
    async function keySession(job: Job, key: string, events: ChannelEvent[], saved?: string): Promise<string> {
      return (await alive(saved)) ?? (await createSession(job, `⏰ ${job.name} · ${(events[0]?.title ?? key).slice(0, 60)}`))
    }

    function finish(sessionID: string, status: Run["status"], error?: string) {
      const f = inflight.get(sessionID)
      if (!f) return
      inflight.delete(sessionID)
      clearTimeout(f.timer)
      const run: Run = {
        ...f.run, status, endedAt: Date.now(), error,
        ...(f.sent ? { notifications: f.sent } : {}),
      }
      store.appendRun(run)
      // The run is done in memory already (above, synchronously, so a second end event can't finish it twice);
      // what's saved on disk follows (tracked, so shutdown waits for it).
      const memory: Memory | undefined = f.job.session !== "sticky" ? undefined : {
        ...(f.cacheMs !== undefined ? { warmUntil: run.endedAt! + f.cacheMs * WARM_SHARE } : {}),
        ...(f.memoryUpdated ? {} : { note: undefined }),
      }
      void track((async () => {
        await Promise.all([
          mutate((jobs) => {
            const j = find(jobs, run.jobID)
            if (!j) return
            j.lastStatus = status
            if (memory && f.key === undefined && j.sessionID === sessionID) j.memory = { ...j.memory, ...memory }
          }).catch((e) => log.error({ job: run.jobID, err: e }, "couldn't save the run's outcome on the job")),
          // A key's session counts as used when its run ends, so an active key isn't the one evicted.
          f.key !== undefined && store.mutateChannels((s) => {
            touch(s.queues[f.job.id], f.key!, sessionID)
            const entry = s.queues[f.job.id]?.sessions[f.key!]
            if (memory && entry?.id === sessionID) Object.assign(entry, memory)
          }).catch((e) => log.error({ job: f.job.id, err: e }, "couldn't save channel state after the run")),
        ])
        notify(f.job, run)
      })())
    }

    /** A turn ended: finish the run, unless it may notify, sent nothing and didn't say why (then ask once). */
    function ended(sessionID: string) {
      const f = inflight.get(sessionID)
      if (!f) return
      if (f.checked) return finish(sessionID, "succeeded")
      const notificationSent = !!f.sent || !canNotify(opts.notify, f.job) || saidNothing(f.lastText)
      const memoryUpdated = f.job.session !== "sticky" || !!f.memoryUpdated
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

    function notify(job: Job, run: Run) {
      if (shouldNotify(opts.notify, job, run.status)) {
        void send(opts.notify!, compose(job, run)).catch((err) => log.error({ job: job.id, err }, "notification failed"))
      }
    }

    const running = (jobID: string, key?: string) =>
      [...inflight.values()].some((f) => f.run.jobID === jobID && f.key === key)
    /**
     * Runs being started right now, by job and session key: taking events, picking the session and
     * compacting it all take a while. Reserved before the first await, so a second start (an overlapping
     * tick, a manual run or poll) can't take the same events or run in the same session.
     */
    const pendingStarts = new Set<string>()
    const slotOf = (jobID: string, key?: string) => `${jobID}\u0000${key ?? ""}`
    const busy = (jobID: string, key?: string) => pendingStarts.has(slotOf(jobID, key)) || running(jobID, key)

    function loadAll(): Loaded {
      const state = store.loadChannels()
      return { state, channels: allChannels(state.defs) }
    }

    /**
     * Run a job; returns its run, or why none started. A channel job takes its waiting events: with session
     * keys, several runs may start, and chunks whose session is busy keep waiting. A scheduled digest with
     * nothing waiting doesn't run; a manual run then runs anyway and says there were no new events.
     */
    async function runAutomation(job: Job, reason: Reason, loaded?: Loaded): Promise<Run | string> {
      if (!job.on) return startSession(job, reason, { text: job.prompt, session: () => resolveSession(job) })
      const { runs, why } = await processEvents(job, reason, loaded ?? loadAll())
      if (runs.length) return runs[0]
      if (why !== NOTHING_WAITING || reason !== "manual") return why!
      return startSession(job, reason, { text: composeEvents(job.prompt, [], channelNames(job.on.channels)), session: () => resolveSession(job) })
    }

    const NOTHING_WAITING = "nothing is waiting"
    const STOPPING = "the plugin is stopping"

    async function processEvents(job: Job, reason: Reason, loaded: Loaded): Promise<{ runs: Run[]; why?: string }> {
      const subscribed = (job.on?.channels ?? []).map((id) => loaded.channels.get(id)).filter((c): c is Channel => !!c)
      if (!subscribed.length) return { runs: [], why: `none of its channels exist any more (${job.on?.channels.join(", ")})` }
      const queue = loaded.state.queues[job.id]
      if (!queue?.pending.length) return { runs: [], why: NOTHING_WAITING }
      const names = channelNames(job.on!.channels, loaded.channels)
      const max = job.maxEvents ?? (job.schedule.kind === "event" ? 10 : 50)
      // `sticky` with channels that set session keys: one session per key (per channel).
      const byKey = job.session === "sticky" && subscribed.some((c) => !!c.event.sessionKey)
      const runs: Run[] = []
      let why: string | undefined
      for (const { key, events } of chunks(queue.pending, byKey, max)) {
        if (abort.signal.aborted) { why = STOPPING; break }
        if (busy(job.id, key)) { why ??= "its waiting events are for sessions that are still busy; they go in when those finish"; continue }
        const slot = slotOf(job.id, key)
        pendingStarts.add(slot)
        try {
          const r = await startChunk(job, reason, key, events, names, key !== undefined ? queue.sessions[key]?.id : undefined)
          if (typeof r === "string") why ??= r
          else runs.push(r)
        } finally { pendingStarts.delete(slot) }
      }
      return { runs, why: runs.length ? undefined : why }
    }

    /**
     * Take one chunk off the queue and start its run; returns the run, or why it didn't start.
     * Taking the events and saving the key's session is one locked write, before sending, so a crash
     * can't deliver them twice. If the run doesn't start, the events go back: always when skipped,
     * up to MAX_START_ATTEMPTS when the start failed.
     */
    async function startChunk(
      job: Job, reason: Reason, key: string | undefined, events: ChannelEvent[], names: Record<string, string>, savedSession?: string,
    ): Promise<Run | string> {
      const ids = new Set(events.map(uid))
      let took: { taken: ChannelEvent[]; sessionID?: string }
      let found: string | undefined
      // A key's session that can't be made is a failed start (recorded, notified, counted), not a retry forever.
      let sessionError: unknown
      if (key !== undefined) {
        try { found = await keySession(job, key, events, savedSession) } catch (e) { sessionError = e }
      }
      const discard = (used?: string) => {
        if (found && found !== savedSession && used !== found) void ctx.session.remove?.({ sessionID: found }).catch(() => {})
      }
      if (abort.signal.aborted) { discard(); return STOPPING }
      try {
        took = await store.mutateChannels((s) => {
          const q = queueOf(s, job.id)
          // Only what is still waiting: another process may have taken some in the meantime.
          const taken = q.pending.filter((e) => ids.has(uid(e)))
          q.pending = q.pending.filter((e) => !ids.has(uid(e)))
          if (!taken.length || !found) return { taken }
          // Someone else set this key's session since we read it: keep theirs.
          const current = q.sessions[key!]?.id
          const id = current && current !== savedSession && current !== found ? current : found
          const keep = [...inflight.values()].filter((f) => f.job.id === job.id && f.key !== undefined).map((f) => f.key!)
          assign(q, key!, id, Date.now(), keep)
          return { taken, sessionID: id }
        })
      } catch (e) {
        discard()
        log.warn({ job: job.id, err: e }, "couldn't hand over events, will retry")
        return "the events couldn't be handed over; they're retried on the next tick"
      }
      const { taken, sessionID } = took
      discard(sessionID)
      if (!taken.length) return "another process already took these events"
      const run = await startSession(job, reason, {
        text: composeEvents(job.prompt, taken, names),
        session: sessionError !== undefined ? () => Promise.reject(sessionError) : sessionID ? async () => sessionID : () => resolveSession(job),
        key,
        held: true,
        events: taken.map((e) => `${e.channel}:${e.id}`),
      })
      if (run.status !== "running") {
        const back = run.status === "skipped"
          ? taken
          : taken.map((e) => ({ ...e, attempts: (e.attempts ?? 0) + 1 })).filter((e) => e.attempts < MAX_START_ATTEMPTS)
        if (back.length) {
          try { await store.mutateChannels((s) => requeue(queueOf(s, job.id), back)) }
          catch (e) { log.error({ job: job.id, err: e }, "couldn't put events back") }
        }
      }
      return run
    }

    /**
     * Sessions being compacted before a run: the summary its compaction takes (the saved memory), and
     * what to call once the compaction's end event comes through.
     */
    const compactions = new Map<string, { summary: string; ended: () => void }>()

    /**
     * Start a run: pick the session, record it, send the prompt, and arm the timeout.
     * `held`: the caller reserved the job's slot in pendingStarts already.
     */
    async function startSession(
      job: Job,
      reason: Reason,
      how: { text: string; session: () => Promise<string>; key?: string; events?: string[]; held?: boolean },
    ): Promise<Run> {
      const runID = `${job.id}-${randomUUID()}`
      const base: Run = { jobID: job.id, runID, startedAt: Date.now(), status: "running" }
      const skipped = (error: string): Run => ({ ...base, status: "skipped", endedAt: Date.now(), error })

      // Shutting down: nothing would track the run, and another process may take over.
      if (abort.signal.aborted) return skipped("plugin stopping")
      const slot = slotOf(job.id, how.key)
      if (how.held ? running(job.id, how.key) : busy(job.id, how.key)) {
        const run = skipped("previous run still in progress")
        store.appendRun(run)
        return run
      }
      // Held until the run is tracked: a manual run and a scheduled one mustn't both start in one session.
      if (!how.held) pendingStarts.add(slot)
      try {
        const sessionID = await how.session()
        // Compact before tracking the run, so the compaction's events aren't taken for the run's.
        const note = job.session === "sticky" ? prevNote(memoryOf(job.id, how.key, sessionID)) : undefined
        if (note) {
          // Given up on but still queued ahead of the run: it keeps its entry, so it still gets its summary
          // and its end event, which comes before the run's, isn't taken for the run's.
          let queued = false
          try {
            // Its end event can come through after compact() and wait() return; tracked by then, it would end the run.
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
        // Stopped while it was being prepared: nothing was sent, so events it took go back to their queue.
        if (abort.signal.aborted) return skipped("plugin stopping")
        const run: Run = { ...base, sessionID }
        const entry: InFlight = { job, run, sent: 0, key: how.key }
        inflight.set(sessionID, entry)
        store.appendRun(run)
        await mutate((jobs) => { const j = find(jobs, job.id); if (j) j.lastRunAt = run.startedAt })
          .catch((e) => log.error({ job: job.id, err: e }, "couldn't save the last run time"))
        entry.timer = setTimeout(() => {
          void ctx.session.interrupt({ sessionID }).catch(() => {})
          finish(sessionID, "timeout", `exceeded ${job.timeoutMinutes}m`)
        }, job.timeoutMinutes * 60_000)

        await ctx.session.prompt({
          sessionID,
          text: how.text,
          // Don't barge into a session that's mid-turn; wait our turn.
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
        for (const [sid, f] of inflight) if (f.run.runID === runID) { clearTimeout(f.timer); inflight.delete(sid) }
        store.appendRun(failed)
        await mutate((jobs) => { const j = find(jobs, job.id); if (j) { j.lastStatus = "failed"; j.lastRunAt = base.startedAt } }).catch(() => {})
        notify(job, failed)
        return failed
      } finally { if (!how.held) pendingStarts.delete(slot) }
    }

    // ---------- ticker ----------

    let ticking = false
    async function tick() {
      // A slow tick (polls wait up to 20 s each) mustn't overlap the next one.
      if (abort.signal.aborted || ticking) return
      ticking = true
      try { await tickOnce() } finally { ticking = false }
    }

    async function tickOnce() {
      leader = store.lease(tickMs * 3)
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
          if (job.schedule.kind === "event" || !isActive(job)) continue // event jobs run from tickChannels
          if (job.nextRunAt === undefined) {
            job.nextRunAt = nextRun(job.schedule, now, job.createdAt)
            // Nothing left to run (a one-shot whose time passed before it was ever scheduled): done, not "active".
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
      // Unreadable channel state stops the channels, not the automations that only have a schedule.
      let loaded: Loaded | undefined
      try { loaded = loadAll() } catch (e) { log.error({ err: e }, "channel state can't be read or saved") }
      // The due jobs' next runs are saved already: one that throws mustn't take the others with it.
      for (const [job, reason] of due) {
        try { await runAutomation(job, reason, loaded) } catch (e) { log.error({ job: job.id, err: e }, "run couldn't be started") }
      }
      if (loaded) await tickChannels(now, loaded, due.some(([j]) => j.on))
    }

    // ---------- channel polling ----------

    const polling = new Set<string>()
    /** Ticks and polls in progress; teardown waits for them. */
    const work = new Set<Promise<unknown>>()
    function track<T>(p: Promise<T>): Promise<T> {
      work.add(p)
      void p.finally(() => work.delete(p)).catch(() => {})
      return p
    }
    const subscribers = (channelID: string, jobs = load()) => jobs.filter((j) => listens(j, channelID) && isActive(j))

    type Polled = { ch: Channel; events?: ChannelEvent[]; error?: string }

    /**
     * Poll channels in parallel (one slow API doesn't hold up the others) and save all the results in one
     * write: new events are queued for each subscriber. Returns each channel's result, and the saved state.
     */
    async function pollChannels(list: Channel[], jobs = load()): Promise<{ results: Map<string, PollResult>; state?: ChannelsState }> {
      const results = new Map<string, PollResult>()
      if (!list.length) return { results }
      for (const ch of list) polling.add(ch.id)
      try {
        const polled = await Promise.all(list.map(async (ch): Promise<Polled> => {
          try { return { ch, events: await poll(ch, fetch, abort.signal) } }
          catch (e) { return { ch, error: errorMessage(e).slice(0, 500) } }
        }))
        if (abort.signal.aborted) {
          for (const ch of list) results.set(ch.id, { fresh: 0, error: STOPPING })
          return { results }
        }
        const notices: Array<{ ch: Channel; failures: number; error: string }> = []
        let state: ChannelsState | undefined
        try {
          state = await store.mutateChannels((s) => {
            for (const p of polled) {
              const src = (s.sources[p.ch.id] ??= emptySource())
              src.lastPollAt = Date.now()
              src.pollRequestedAt = undefined
              if (p.events === undefined) {
                src.lastError = p.error
                src.failures = (src.failures ?? 0) + 1
                results.set(p.ch.id, { fresh: 0, error: p.error })
                if (src.failures === CHANNEL_FAILURE_NOTICE) notices.push({ ch: p.ch, failures: src.failures, error: p.error! })
                continue
              }
              src.lastOkAt = src.lastPollAt
              src.lastError = undefined
              src.failures = 0
              const fresh = ingest(src, p.events)
              // Paused automations keep collecting, so nothing is lost while they're paused; finished ones don't.
              for (const j of jobs) {
                if (!listens(j, p.ch.id) || !j.enabled || j.done) continue
                const q = queueOf(s, j.id)
                // An automation's first poll of a channel gets everything currently there; after that, only what's new.
                const first = !q.started?.includes(p.ch.id)
                if (first) q.started = [...(q.started ?? []), p.ch.id]
                enqueue(q, first ? p.events : fresh) // enqueue skips repeated IDs
              }
              results.set(p.ch.id, { fresh: fresh.length })
            }
            return s
          })
        } catch (e) {
          // The APIs answered; only saving failed (the lock stayed busy). Not failed polls: the next ones catch up.
          const error = `couldn't save the poll: ${errorMessage(e)}`
          log.warn({ channels: polled.map((p) => p.ch.id), err: e }, "couldn't save the poll")
          for (const p of polled) results.set(p.ch.id, { fresh: 0, error: p.error ?? error })
          return { results }
        }
        for (const p of polled) if (p.error) log.warn({ channel: p.ch.id, error: p.error }, "poll failed")
        for (const n of notices) {
          if (!subscribers(n.ch.id, jobs).some((j) => canNotify(opts.notify, j))) continue
          void send(opts.notify!, {
            title: `Channel ${n.ch.name} can't poll`,
            body: `${n.failures} failed polls in a row. Last error: ${n.error}`,
            priority: "normal",
          }).catch((err) => log.error({ channel: n.ch.id, err }, "notification failed"))
        }
        return { results, state }
      } finally { for (const ch of list) polling.delete(ch.id) }
    }

    async function processArrivals(jobs = load(), channelID?: string, state = store.loadChannels()): Promise<number> {
      const loaded: Loaded = { state, channels: allChannels(state.defs) }
      let started = 0
      for (const job of jobs) {
        if (job.schedule.kind !== "event" || !isActive(job) || (channelID && !listens(job, channelID))) continue
        started += (await processEvents(job, "event", loaded)).runs.filter((r) => r.status === "running").length
      }
      return started
    }

    /** `changed`: this tick's due runs took events, so `loaded` is stale. */
    async function tickChannels(now: number, loaded: Loaded, changed: boolean) {
      const jobs = load()
      const { sources, queues } = loaded.state
      // Queues of automations that no longer exist (deleted from chat, the TUI, or config). Checked again
      // under the lock against the jobs saved now: an automation created during this tick keeps its queue.
      if (Object.keys(queues).some((id) => !jobs.some((j) => j.id === id))) {
        try {
          await store.mutateChannels((s) => {
            const ids = new Set(load().map((j) => j.id))
            for (const id of Object.keys(s.queues)) if (!ids.has(id)) delete s.queues[id]
          })
          changed = true
        } catch (e) { log.error({ err: e }, "channel state can't be read or saved") }
      }
      const due = [...loaded.channels.values()].filter((ch) => {
        const src = sources[ch.id]
        const requested = src?.pollRequestedAt !== undefined
        if (polling.has(ch.id) || (!requested && !subscribers(ch.id, jobs).length)) return false
        // Half a tick of slack keeps polls close to `every` instead of drifting a whole tick late.
        return requested || !src?.lastPollAt || now - src.lastPollAt >= ch.everyMs - tickMs / 2
      })
      const { state } = await pollChannels(due, jobs)
      await processArrivals(jobs, undefined, state ?? (changed || due.length ? store.loadChannels() : loaded.state))
    }

    // ---------- event pump: track runs to completion ----------

    const pumpEvents = async () => {
      let backoff = 1000
      while (!abort.signal.aborted) {
        try {
          for await (const ev of ctx.event.subscribe({ signal: abort.signal })) {
            backoff = 1000
            const sid = (ev as any).data?.sessionID as string | undefined
            const compaction = sid ? compactions.get(sid) : undefined
            if (compaction && EXECUTION_ENDS.has(ev.type)) {
              compaction.ended()
              compactions.delete(sid!)
              continue
            }
            if (!sid || !inflight.has(sid)) continue
            switch (ev.type) {
              case "session.text.ended":
                inflight.get(sid)!.lastText = (ev as any).data.text
                break
              case "session.execution.failed":
                finish(sid, "failed", JSON.stringify((ev as any).data.error))
                break
              case "session.execution.interrupted": // stopped by the user; a timeout finishes the run before it interrupts
                finish(sid, "failed", "interrupted")
                break
              case "session.execution.succeeded": // V2 execution completed
                inflight.get(sid)!.v2 = true
                ended(sid)
                break
              case "session.idle": // compatibility with hosts emitting legacy idle
                if (!inflight.get(sid)!.v2) ended(sid)
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

    const maxPerRun = opts.notify?.maxPerRun ?? DEFAULT_MAX_PER_RUN

    await ctx.session.hook?.("context", (c) => {
      const f = inflight.get(c.sessionID)
      const notifies = !!f && canNotify(opts.notify, f.job)
      if (notifies) c.system.push({ type: "text", text: RUN_GUIDE })
      else delete c.tools[NOTIFY_TOOL]
      if (f?.job.session === "sticky") {
        c.system.push({ type: "text", text: MEMORY_GUIDE })
        f.cacheMs ??= cacheLifetime(c.options)
      } else delete c.tools[UPDATE_TOOL]
      if (f) c.system.push({ type: "text", text: runContext(f.job, notifies ? maxPerRun : undefined) })
    })

    await ctx.session.hook?.("compaction", (c) => {
      const summary = compactions.get(c.sessionID)?.summary
      if (summary !== undefined) c.result = { summary }
    })

    const rt: Runtime = {
      ctx, opts, store, tickMs, defaultTimeout, maxPerRun, configChannels,
      runOf: (sessionID) => inflight.get(sessionID),
      runningJobs: () => [...inflight.values()].map((f) => f.run.jobID),
      isPolling: (channelID) => polling.has(channelID),
      leader: () => leader,
      load, mutate, checkChannels, allChannels, remember, runAutomation, pollChannels, processArrivals, track,
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
      // Let in-flight ticks and polls (aborted above) settle before another process can take the lease.
      await Promise.allSettled([...work])
      // Nothing tracks these runs any more: close their records, or they'd show as running forever.
      const open = [...inflight.values()]
      inflight.clear()
      for (const f of open) {
        clearTimeout(f.timer)
        try { store.appendRun({ ...f.run, status: "failed", endedAt: Date.now(), error: "opencode stopped before the run ended" }) } catch {}
      }
      if (open.length) {
        await mutate((jobs) => { for (const f of open) { const j = find(jobs, f.job.id); if (j) j.lastStatus = "failed" } })
          .catch((e) => log.error({ err: e }, "couldn't save the stopped runs' outcome"))
      }
      store.release()
      await pump.catch(() => {})
    }
  },
})
