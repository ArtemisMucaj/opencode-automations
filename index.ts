// opencode v2 plugin: run prompts on a schedule, or on events from a channel.
//
//  - Jobs come from plugin options (declarative) or from the automation_* tools (conversational).
//  - A ticker fires due jobs into a new, a sticky, or the originating session.
//  - Channels (channels.ts) poll APIs; jobs with `on: { channels }` get their events as they
//    arrive, or on their schedule as a digest.
//  - The event stream tracks each run to completion and records its final text.
//  - A lease lock elects one leader when several opencode processes load the plugin.

import { Plugin } from "@opencode/plugin"
import { randomUUID } from "node:crypto"
import { describe, nextRun, parseCron, parseInterval, type Schedule } from "./cron.ts"
import { sessionMode, Store, type Job, type Run, type SessionMode } from "./store.ts"
import { defaultDataDir, isActive, listens, runnable } from "./jobs.ts"
import {
  canNotify, compose, DEFAULT_MAX_PER_RUN, MAX_PARTS, PUSHOVER, send, shouldNotify, split,
  type JobNotify, type NotifyConfig, type Priority,
} from "./notify.ts"
import {
  arrayPaths, assign, CHANNEL_ID, chunks, composeEvents, emptyQueue, emptySource, enqueue, envNames, extract, fetchJSON,
  fieldPaths, forget, get, ingest, literalSecrets, MAX_START_ATTEMPTS, parseChannel, poll, removeChannel, requeue, requestPoll,
  summarize, touch, uid,
  type Channel, type ChannelConfig, type ChannelEvent, type ChannelsState,
} from "./channels.ts"

interface Options {
  dataDir?: string
  tickSeconds?: number
  defaultTimeoutMinutes?: number
  defaultAgent?: string
  defaultModel?: string
  notify?: NotifyConfig
  jobs?: ConfigJob[]
  channels?: ChannelConfig[]
}

interface ScheduleInput {
  cron?: string
  every?: string
  at?: string
  tz?: string
}

interface ConfigJob extends ScheduleInput {
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

interface InFlight {
  job: Job
  run: Run
  lastText?: string
  /** automation_notify calls that delivered somewhere. */
  sent: number
  timer?: ReturnType<typeof setTimeout>
  /** Session key of a run in its key's session: runs for different keys may overlap. */
  key?: string
}

type Reason = "schedule" | "manual" | "missed" | "event"

const MISSED_GRACE_MS = 2 * 60_000
/** Consecutive failed polls before the user is told a channel is broken. */
const CHANNEL_FAILURE_NOTICE = 3

/** With channels, no schedule means "run when events arrive". */
function toSchedule(s: ScheduleInput, hasChannels = false): Schedule {
  const set = [s.cron, s.every, s.at].filter(Boolean).length
  if (set === 0 && hasChannels) return { kind: "event" }
  if (set !== 1) throw new Error(hasChannels ? "provide at most one of cron, every, at" : "provide exactly one of cron, every, at")
  if (s.cron) {
    parseCron(s.cron) // validate eagerly
    if (s.tz) new Intl.DateTimeFormat("en-US", { timeZone: s.tz }) // throws on bad tz
    return { kind: "cron", expr: s.cron, tz: s.tz }
  }
  if (s.every) return { kind: "every", ms: parseInterval(s.every) }
  const time = Date.parse(s.at!)
  if (Number.isNaN(time)) throw new Error(`invalid timestamp "${s.at}" (use ISO 8601)`)
  if (time <= Date.now()) throw new Error("'at' is in the past")
  return { kind: "at", time }
}

function parseModel(ref?: string) {
  if (!ref) return undefined
  const [path, variant] = ref.split(":")
  const slash = path.indexOf("/")
  if (slash < 1) throw new Error(`model must be "provider/model[:variant]", got "${ref}"`)
  return { providerID: path.slice(0, slash), id: path.slice(slash + 1), ...(variant ? { variant } : {}) }
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "job"
const fmt = (t?: number) => (t ? new Date(t).toLocaleString() : "—")
const text = (content: string) => ({ content })

/** Exposed name of the notify tool (`notify` in the `automation` namespace). */
const NOTIFY_TOOL = "automation_notify"
/**
 * Every tool goes through opencode's code mode: they're grouped in these namespaces and exposed as
 * `automation_*` / `channel_*`, without their schemas riding along on every request.
 */
const CODE_MODE = { codemode: true } as const
const NAMESPACES = [
  { name: "automation", description: "Run prompts on a schedule or on channel events: create, list, update, delete, run, history; notify (inside runs)." },
  { name: "channel", description: "Event sources polled from HTTP APIs (Datadog, Sentry, GitHub…): list, poll, test, create, update, delete." },
] as const

/** How the tools fit together, for /automation and /channel. */
const AUTOMATIONS_GUIDE =
  "Automations run a prompt on a schedule (cron, every, or a one-shot at), or on events from channels. " +
  "automation_create/list/update/delete/run/history manage them. Write the prompt self-contained: runs start with no " +
  "conversation context unless session is \"current\". Sessions: \"new\" (default) is a fresh session per run, " +
  "\"sticky\" keeps one session (with channels that set event.sessionKey: one per key), \"current\" is this chat.\n" +
  "On channels: with no schedule an automation runs as events arrive (up to maxEvents, default 10, per run); with a " +
  "schedule it is a digest of everything since the last run (default 50). Its first poll of a channel gets everything " +
  "already there. automation_update channels replaces the list; [] removes them, only if it has a schedule.\n" +
  "channel_poll polls now and starts runs for automations that take events as they arrive; digests get them on schedule. " +
  "channel_update fields replace the current ones; changing event.id makes seen items look new, so they are delivered " +
  "again. channel_delete fails while automations use the channel unless detach is true, which removes it from them; " +
  "an automation left with no channel and no schedule is paused. Config channels and jobs are edited in opencode.json(c).\n\n"

/** How the agent sets up channels and the automations on them, for /channel. */
const CHANNEL_GUIDE =
  "Set up event sources (channels) and the automations that run on them.\n" +
  "1. channel_list: if a channel already polls what is needed, reuse it instead of creating another.\n" +
  "2. For a new one, find the API endpoint that lists the items: from its docs, an example the user gives, or a connected tool.\n" +
  "3. Keys: never write a secret into the definition. Use {env:NAME} (e.g. header \"DD-API-KEY\": \"{env:DD_API_KEY}\") " +
  "and tell the user to set NAME where the opencode server runs; channel_test says if it is missing.\n" +
  "4. channel_test the draft and iterate until the sample events look right: items (the array), filter, " +
  "event.id (must change when something happens again, e.g. \"{id}:{updated_at}\"), event.sessionKey (which events share a " +
  "conversation, e.g. one per monitor), and a title/body/url the agent can act on. Pick an interval that respects rate limits.\n" +
  "5. channel_create with the tested definition.\n" +
  "6. Agree with the user on what to do with the events, then automation_create (or automation_update to add channels to an " +
  "existing automation) with channels: [...]. No schedule runs as events arrive; a schedule makes a digest. " +
  "session \"sticky\" with a sessionKey keeps one conversation per key. Write a self-contained prompt that says when to notify.\n" +
  "An automation can use several channels, and a channel can feed several automations."

/** Added to the system prompt of automation runs that may notify. */
const runGuide = (job: Job, max: number) =>
  `You are running unattended as the automation "${job.name}". Nobody is watching this session: ` +
  `your final reply stays here and is not sent anywhere. To reach the user, call ${NOTIFY_TOOL} ` +
  `with what they need to know or act on, once you know it. If nothing is worth their attention, don't notify. ` +
  `Write it as a notification, not a chat reply: plain text, no markdown (no **, #, backticks, tables or [text](url)). ` +
  `Use new lines to separate items and paste links directly as full URLs. ` +
  `At most ${max} notifications per run; group related items into one. ` +
  `Failures and timeouts are reported to the user automatically.`

export default Plugin.define({
  id: "automations",
  setup: async (ctx) => {
    const opts = (ctx.options ?? {}) as Options
    const tickMs = Math.max(5, opts.tickSeconds ?? 30) * 1000
    const defaultTimeout = opts.defaultTimeoutMinutes ?? 30
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
    // Publish what the config channels look like (no headers or body, so no secrets) for the TUI.
    try {
      const config = Object.fromEntries((opts.channels ?? []).map((c) => [c.id, summarize(c)]))
      await store.mutateChannels((s) => { s.config = config })
    } catch (e) { console.error("[automations] channel state:", (e as Error)?.message) }

    /**
     * Config channels plus those created with channel_create, read from disk each time so a channel
     * created in another process is polled by the leader on its next tick. Config wins on an ID clash.
     */
    function allChannels(defs = store.loadChannels().defs): Map<string, Channel> {
      const all = new Map(configChannels)
      for (const [id, def] of Object.entries(defs)) {
        if (all.has(id)) continue
        try { all.set(id, parseChannel({ ...def, id })) } catch (e) { console.error(`[automations] channel ${id}:`, (e as Error).message) }
      }
      return all
    }

    /** Check a job's channel settings; returns its channel IDs (deduplicated), or undefined for none. */
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

    /** Channel ID to display name, for a job's channels. */
    const channelNames = (ids: string[], channels = allChannels()) => Object.fromEntries(ids.map((id) => [id, channels.get(id)?.name ?? id]))

    // ---------- job state ----------

    const configJobs = (opts.jobs ?? []).map((c): Job => {
      if (!c.id || !c.prompt || !c.directory) throw new Error("[automations] config jobs need id, prompt and directory")
      parseModel(c.model ?? opts.defaultModel)
      let ids: string[] | undefined
      try { ids = checkChannels(c) } catch (e) { throw new Error(`[automations] job "${c.id}": ${(e as Error).message}`) }
      return {
        id: c.id,
        name: c.name ?? c.id,
        prompt: c.prompt,
        schedule: toSchedule(c, !!ids),
        directory: c.directory ?? process.cwd(),
        session: sessionMode(c.session) ?? "new",
        agent: c.agent ?? opts.defaultAgent,
        model: c.model ?? opts.defaultModel,
        timeoutMinutes: c.timeoutMinutes ?? defaultTimeout,
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

    function find(jobs: Job[], idOrName: string) {
      return jobs.find((j) => j.id === idOrName) ?? jobs.find((j) => j.name === idOrName)
    }

    // ---------- firing ----------

    /** The session if it still exists and isn't archived. */
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

    async function resolveSession(job: Job): Promise<string> {
      if (job.session !== "new" && job.sessionID) {
        const id = await alive(job.sessionID)
        if (id) return id
        if (job.session === "current") throw new Error(`session ${job.sessionID} is gone`)
      }
      const id = await createSession(job, `⏰ ${job.name}${job.session === "new" ? ` · ${new Date().toLocaleString()}` : ""}`)
      if (job.session === "sticky") await mutate((jobs) => { const j = find(jobs, job.id); if (j) j.sessionID = id })
      return id
    }

    /**
     * The sticky session for a session key: the saved one if it still exists, else a new one.
     * Nothing is written here; processEvents() saves the mapping together with taking the events.
     * `read`: the session saved for the key, from the state processEvents() already loaded.
     */
    async function keySession(job: Job, key: string, events: ChannelEvent[], read?: string): Promise<{ id: string; read?: string }> {
      const id = (await alive(read)) ?? (await createSession(job, `⏰ ${job.name} · ${(events[0]?.title ?? key).slice(0, 60)}`))
      return { id, read }
    }

    function finish(sessionID: string, status: Run["status"], error?: string) {
      const f = inflight.get(sessionID)
      if (!f) return
      inflight.delete(sessionID)
      clearTimeout(f.timer)
      const run: Run = {
        ...f.run, status, endedAt: Date.now(), output: f.lastText?.slice(0, 4000), error,
        ...(f.sent ? { notifications: f.sent } : {}),
      }
      store.appendRun(run)
      // The run is done in memory already (above, synchronously, so a second end event can't finish it twice);
      // what's saved on disk follows (tracked, so shutdown waits for it).
      void track((async () => {
        try { await mutate((jobs) => { const j = find(jobs, run.jobID); if (j) j.lastStatus = status }) }
        catch (e) { console.error("[automations] job state:", (e as Error)?.message) }
        // A key's session counts as used when its run ends, so an active key isn't the one evicted.
        if (f.key !== undefined) {
          try { await store.mutateChannels((s) => touch(s.queues[f.job.id], f.key!, sessionID)) }
          catch (e) { console.error("[automations] channel state:", (e as Error)?.message) }
        }
        notify(f.job, run)
      })())
    }

    /** The automatic end-of-run notice; what the agent wanted to say went out via automation_notify. */
    function notify(job: Job, run: Run) {
      if (shouldNotify(opts.notify, job, run.status)) {
        void send(opts.notify!, compose(job, run)).catch((error) => console.error("[automations] notify:", error))
      }
    }

    /** A run in progress for this job and session key. */
    const running = (jobID: string, key?: string) =>
      [...inflight.values()].some((f) => f.run.jobID === jobID && f.key === key)
    /**
     * Chunks being handed over right now, by job and session key. Claimed before the first await,
     * so a second delivery (an overlapping tick, a manual poll) can't take the same events.
     */
    const claimed = new Set<string>()
    const claimOf = (jobID: string, key?: string) => `${jobID}\u0000${key ?? ""}`
    const busy = (jobID: string, key?: string) => claimed.has(claimOf(jobID, key)) || running(jobID, key)

    /** Channels and their state, read once and shared by the deliveries of one tick or call. */
    type Loaded = { channels: Map<string, Channel>; state: ChannelsState }
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

    /** Hand a job its waiting events, one run per chunk. With no run started, `why` says why. */
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
        const claim = claimOf(job.id, key)
        claimed.add(claim)
        try {
          const r = await startChunk(job, reason, key, events, names, key !== undefined ? queue.sessions[key]?.id : undefined)
          if (typeof r === "string") why ??= r
          else runs.push(r)
        } finally { claimed.delete(claim) }
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
      let found: { id: string; read?: string } | undefined
      try {
        found = key !== undefined ? await keySession(job, key, events, savedSession) : undefined
        if (abort.signal.aborted) return STOPPING
        took = await store.mutateChannels((s) => {
          const q = (s.queues[job.id] ??= emptyQueue())
          // Only what is still waiting: another process may have taken some in the meantime.
          const taken = q.pending.filter((e) => ids.has(uid(e)))
          q.pending = q.pending.filter((e) => !ids.has(uid(e)))
          const f = found
          if (!taken.length || !f) return { taken }
          // Someone else set this key's session since we read it: keep theirs.
          const current = q.sessions[key!]?.id
          const id = current && current !== f.read && current !== f.id ? current : f.id
          const keep = [...inflight.values()].filter((f) => f.job.id === job.id && f.key !== undefined).map((f) => f.key!)
          assign(q, key!, id, Date.now(), keep)
          return { taken, sessionID: id }
        })
      } catch (e) {
        console.error(`[automations] ${job.id}: couldn't hand over events, will retry:`, (e as Error)?.message)
        return "the events couldn't be handed over; they're retried on the next tick"
      }
      const { taken, sessionID } = took
      // A session made for this chunk but not used (the events were gone, or the key got another session) goes again.
      if (found && found.id !== found.read && sessionID !== found.id) {
        void ctx.session.remove?.({ sessionID: found.id }).catch(() => {})
      }
      if (!taken.length) return "another process already took these events"
      const run = await startSession(job, reason, {
        text: composeEvents(job.prompt, taken, names),
        session: sessionID ? async () => sessionID : () => resolveSession(job),
        key,
        events: taken.map((e) => `${e.channel}:${e.id}`),
      })
      if (run.status !== "running") {
        const back = run.status === "skipped"
          ? taken
          : taken.map((e) => ({ ...e, attempts: (e.attempts ?? 0) + 1 })).filter((e) => e.attempts < MAX_START_ATTEMPTS)
        if (back.length) {
          try { await store.mutateChannels((s) => requeue((s.queues[job.id] ??= emptyQueue()), back)) }
          catch (e) { console.error(`[automations] ${job.id}: couldn't put events back:`, (e as Error)?.message) }
        }
      }
      return run
    }

    /** Start a run: pick the session, record it, send the prompt, and arm the timeout. */
    async function startSession(
      job: Job,
      reason: Reason,
      how: { text: string; session: () => Promise<string>; key?: string; events?: string[] },
    ): Promise<Run> {
      const runID = `${job.id}-${randomUUID()}`
      const base: Run = { jobID: job.id, runID, startedAt: Date.now(), status: "running" }

      // Shutting down: nothing would track the run, and another process may take over.
      if (abort.signal.aborted) return { ...base, status: "skipped", endedAt: Date.now(), error: "plugin stopping" }
      if (running(job.id, how.key)) {
        const skipped: Run = { ...base, status: "skipped", endedAt: Date.now(), error: "previous run still in progress" }
        store.appendRun(skipped)
        return skipped
      }
      try {
        const sessionID = await how.session()
        const run: Run = { ...base, sessionID }
        const entry: InFlight = { job, run, sent: 0, key: how.key }
        inflight.set(sessionID, entry)
        store.appendRun(run)
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
        const failed: Run = { ...base, status: "failed", endedAt: Date.now(), error: String((e as Error)?.message ?? e) }
        for (const [sid, f] of inflight) if (f.run.runID === runID) { clearTimeout(f.timer); inflight.delete(sid) }
        store.appendRun(failed)
        await mutate((jobs) => { const j = find(jobs, job.id); if (j) j.lastStatus = "failed" }).catch(() => {})
        notify(job, failed)
        return failed
      }
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
      if (!leader) return
      const now = Date.now()
      const due: Array<[Job, "schedule" | "manual" | "missed"]> = []

      await mutate((jobs) => {
        for (const job of jobs) {
          if (job.runRequestedAt !== undefined) {
            job.runRequestedAt = undefined
            job.lastRunAt = now
            due.push([{ ...job }, "manual"])
            continue
          }
          if (job.schedule.kind === "event" || !isActive(job)) continue // event jobs run from tickChannels
          if (job.nextRunAt === undefined) {
            job.nextRunAt = nextRun(job.schedule, now, job.createdAt)
            continue
          }
          if (now < job.nextRunAt) continue
          const missed = now - job.nextRunAt > Math.max(MISSED_GRACE_MS, tickMs * 2)
          const reason = !missed ? "schedule" : job.runMissed ? "missed" : undefined
          if (reason) {
            due.push([job, reason])
            job.lastRunAt = now
          }
          job.nextRunAt = nextRun(job.schedule, now, job.createdAt)
          if (job.nextRunAt === undefined) job.done = true // one-shot done
        }
      })
      const loaded = due.some(([j]) => j.on) ? loadAll() : undefined
      for (const [job, reason] of due) await runAutomation(job, reason, loaded)
      await tickChannels(now)
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

    /** Poll once and queue new events for each active subscriber. */
    async function pollChannel(ch: Channel, jobs = load()): Promise<{ fresh: number; error?: string }> {
      polling.add(ch.id)
      try {
        let events: ChannelEvent[]
        try { events = await poll(ch, fetch, abort.signal) } catch (e) {
          if (abort.signal.aborted) return { fresh: 0, error: STOPPING }
          return await pollFailed(ch, jobs, String((e as Error)?.message ?? e).slice(0, 500))
        }
        if (abort.signal.aborted) return { fresh: 0, error: STOPPING }
        // Paused automations keep collecting, so nothing is lost while they're paused; disabled or finished ones don't.
        const takers = jobs.filter((j) => listens(j, ch.id) && j.enabled && !j.done)
        try {
          const fresh = await store.mutateChannels((s) => {
            const src = (s.sources[ch.id] ??= emptySource())
            src.lastPollAt = src.lastOkAt = Date.now()
            src.lastError = src.pollRequestedAt = undefined
            src.failures = 0
            const fresh = ingest(src, events)
            // An automation's first poll of a channel gets everything currently there; after that, only what's new.
            for (const j of takers) {
              const q = (s.queues[j.id] ??= emptyQueue())
              const first = !q.started?.includes(ch.id)
              if (first) q.started = [...(q.started ?? []), ch.id]
              enqueue(q, first ? events : fresh) // enqueue skips repeated IDs
            }
            return fresh.length
          })
          return { fresh }
        } catch (e) {
          // The API answered; only saving failed (the lock stayed busy). Not a failed poll: the next one catches up.
          const error = `couldn't save the poll: ${(e as Error)?.message}`
          console.error(`[automations] channel ${ch.id}:`, error)
          return { fresh: 0, error }
        }
      } finally { polling.delete(ch.id) }
    }

    /** Record a failed request, and tell the user once when a channel keeps failing (expired key, API down). */
    async function pollFailed(ch: Channel, jobs: Job[], error: string): Promise<{ fresh: number; error: string }> {
      console.error(`[automations] channel ${ch.id} poll failed:`, error)
      let failures = 0
      try {
        failures = await store.mutateChannels((s) => {
          const src = (s.sources[ch.id] ??= emptySource())
          src.lastPollAt = Date.now()
          src.lastError = error
          src.pollRequestedAt = undefined
          return (src.failures = (src.failures ?? 0) + 1)
        })
      } catch (e) { console.error(`[automations] channel ${ch.id}: couldn't record the failure:`, (e as Error)?.message) }
      if (failures === CHANNEL_FAILURE_NOTICE && subscribers(ch.id, jobs).some((j) => canNotify(opts.notify, j))) {
        void send(opts.notify!, {
          title: `Channel ${ch.name} can't poll`,
          body: `${failures} failed polls in a row. Last error: ${error}`,
          priority: "normal",
        }).catch((err) => console.error("[automations] notify:", err))
      }
      return { fresh: 0, error }
    }

    /** Start runs for jobs that take events as they arrive. */
    async function processArrivals(jobs = load(), channelID?: string): Promise<number> {
      const loaded = loadAll()
      let started = 0
      for (const job of jobs) {
        if (job.schedule.kind !== "event" || !isActive(job) || (channelID && !listens(job, channelID))) continue
        started += (await processEvents(job, "event", loaded)).runs.filter((r) => r.status === "running").length
      }
      return started
    }

    async function tickChannels(now: number) {
      const jobs = load()
      const { sources, defs, queues } = store.loadChannels()
      // Queues of automations that no longer exist (deleted from chat, the TUI, or config).
      const orphans = Object.keys(queues).filter((id) => !jobs.some((j) => j.id === id))
      if (orphans.length) await store.mutateChannels((s) => { for (const id of orphans) delete s.queues[id] })
      const due = [...allChannels(defs).values()].filter((ch) => {
        const src = sources[ch.id]
        const requested = src?.pollRequestedAt !== undefined
        // Channels nobody listens to aren't polled.
        if (polling.has(ch.id) || (!requested && !subscribers(ch.id, jobs).length)) return false
        // Half a tick of slack keeps polls close to `every` instead of drifting a whole tick late.
        return requested || !src?.lastPollAt || now - src.lastPollAt >= ch.everyMs - tickMs / 2
      })
      // In parallel: one slow API shouldn't hold up the others.
      await Promise.allSettled(due.map((ch) => pollChannel(ch, jobs)))
      await processArrivals(jobs)
    }

    // ---------- event pump: track runs to completion ----------

    const pumpEvents = async () => {
      let backoff = 1000
      while (!abort.signal.aborted) {
        try {
          for await (const ev of ctx.event.subscribe({ signal: abort.signal })) {
            backoff = 1000
            const sid = (ev as any).data?.sessionID as string | undefined
            if (!sid || !inflight.has(sid)) continue
            switch (ev.type) {
              case "session.text.ended":
                inflight.get(sid)!.lastText = (ev as any).data.text
                break
              case "session.execution.failed":
                finish(sid, "failed", JSON.stringify((ev as any).data.error))
                break
              case "session.execution.succeeded": // V2 execution completed
              case "session.idle": // compatibility with hosts emitting legacy idle
                finish(sid, "succeeded")
                break
            }
          }
        } catch (e) {
          if (abort.signal.aborted) break
          console.error("[automations] event stream dropped, retrying:", (e as Error)?.message)
        }
        if (abort.signal.aborted) break
        await new Promise((r) => setTimeout(r, backoff))
        backoff = Math.min(backoff * 2, 30_000)
      }
    }

    // ---------- tools ----------

    const scheduleProps = {
      cron: { type: "string", description: 'e.g. "0 9 * * 1-5", "@daily"; local time unless tz' },
      every: { type: "string", description: 'e.g. "15m", "2h" (min 1m)' },
      at: { type: "string", description: "ISO 8601, one-shot" },
      tz: { type: "string", description: "IANA zone for cron" },
    } as const

    const maxPerRun = opts.notify?.maxPerRun ?? DEFAULT_MAX_PER_RUN
    /** The run a session is executing, if it may notify. */
    const notifiable = (sessionID: string) => {
      const f = inflight.get(sessionID)
      return f && canNotify(opts.notify, f.job) ? f : undefined
    }

    await ctx.session.hook?.("context", (c) => {
      // Offer automation_notify only to runs that may notify, and tell them how to use it.
      const f = notifiable(c.sessionID)
      if (f) c.system.push({ type: "text", text: runGuide(f.job, maxPerRun) })
      else delete c.tools[NOTIFY_TOOL]
    })

    await ctx.tool.transform((tools) => {
      for (const ns of NAMESPACES) tools.namespace(ns)

      tools.add({
        name: "notify",
        options: { namespace: "automation", ...CODE_MODE },
        description:
          "Send a notification to the user's phone and desktop from this automation run. " +
          "It is read on a lock screen, so write for a glance: a title that states the outcome " +
          '(e.g. "3 MRs need your review", not "Report"), then the details that support it. ' +
          "Format it as a notification, not markdown: plain text, one item per line, new lines (and a blank line " +
          "between groups) for structure, links pasted directly as full URLs. " +
          "No **bold**, headings, backticks, tables or [text](url) links. " +
          `Keep the message under ${PUSHOVER.message} characters (Pushover's limit); longer text arrives as ` +
          `numbered parts, at most ${MAX_PARTS}. One notification per topic: send several only for ` +
          "separate findings that each deserve attention, not one per item.",
        input: {
          type: "object",
          properties: {
            title: { type: "string", description: "Headline stating the outcome. Under 60 characters reads best." },
            message: { type: "string", description: `Plain text, no markdown. New lines for structure, full URLs for links. Ideally under ${PUSHOVER.message} characters.` },
            priority: {
              type: "string", enum: ["low", "normal", "high"],
              description: "high = needs action soon (alerts on the phone); low = FYI, no sound. Default normal.",
            },
            url: { type: "string", description: "One link to open, shown as a button (e.g. the MR or dashboard)." },
            url_title: { type: "string", description: "Button label for url." },
          },
          required: ["title", "message"],
          additionalProperties: false,
        },
        execute: async (input: any, tc) => {
          const f = notifiable(tc.sessionID)
          if (!f) return text("error: notifications are only available inside an automation run that has them enabled.")
          if (f.sent >= maxPerRun) return text(`error: this run already sent ${f.sent} notifications (limit ${maxPerRun}). Don't send more.`)
          const title = String(input.title ?? "").trim()
          const message = String(input.message ?? "").trim()
          if (!title || !message) return text("error: title and message are required.")
          if (opts.notify!.pushover) {
            const parts = split(message, PUSHOVER.message, "html").length
            if (parts > MAX_PARTS) {
              return text(
                `error: message is ${message.length} characters, ${parts} Pushover messages; the limit is ${MAX_PARTS}. ` +
                `Shorten it to the essentials (under ${PUSHOVER.message} characters), or send separate topics as separate notifications.`,
              )
            }
          }
          const priority: Priority = ["low", "normal", "high"].includes(input.priority) ? input.priority : "normal"
          const result = await send(opts.notify!, { title, body: message, priority, url: input.url, urlTitle: input.url_title })
          if (!result.sent.length) return text(`error: delivery failed (${result.failed.join(", ")}). It was logged; don't retry.`)
          f.sent++
          return text(
            `Sent via ${result.sent.join(", ")}${result.failed.length ? `; failed: ${result.failed.join(", ")}` : ""}. ` +
            `${maxPerRun - f.sent} notifications left for this run.`,
          )
        },
      })

      tools.add({
        name: "create",
        options: { namespace: "automation", ...CODE_MODE },
        description:
          "Create an automation: one of cron/every/at, and/or channels. With channels and no schedule it runs as events arrive; " +
          "with a schedule it is a digest of what arrived since the last run. session: new (default, fresh per run), sticky " +
          "(one session; with channels that set event.sessionKey, one per key), current (this chat). The prompt must be self-contained.",
        input: {
          type: "object",
          properties: {
            name: { type: "string" },
            prompt: { type: "string", description: "Self-contained" },
            ...scheduleProps,
            channels: { type: "array", items: { type: "string" } },
            session: { type: "string", enum: ["new", "sticky", "current"] },
            maxEvents: { type: "number" },
            agent: { type: "string" },
            model: { type: "string", description: '"provider/model[:variant]"' },
            timeoutMinutes: { type: "number" },
          },
          required: ["name", "prompt"],
          additionalProperties: false,
        },
        execute: async (input: any, tc) => {
          try {
            const ids = checkChannels({ on: input.channels?.length ? { channels: input.channels } : undefined, maxEvents: input.maxEvents })
            const on = ids ? { channels: ids } : undefined
            const schedule = toSchedule(input, !!on)
            parseModel(input.model)
            const session = sessionMode(input.session) ?? "new"
            let directory = process.cwd()
            try {
              directory = (await ctx.session.get({ sessionID: tc.sessionID })).location.directory ?? directory
            } catch {}
            const job = await mutate((jobs) => {
              // Again under the jobs lock: channel deletes check for users under it too.
              if (on) checkChannels({ on })
              const base = slug(input.name)
              let id = base
              for (let i = 2; jobs.some((j) => j.id === id); i++) id = `${base}-${i}`
              const now = Date.now()
              const j: Job = {
                id,
                name: input.name,
                prompt: input.prompt,
                schedule,
                directory,
                session,
                sessionID: session === "current" ? tc.sessionID : undefined,
                agent: input.agent ?? opts.defaultAgent,
                model: input.model ?? opts.defaultModel,
                timeoutMinutes: input.timeoutMinutes ?? defaultTimeout,
                runMissed: true,
                enabled: true,
                ...(on ? { on } : {}),
                ...(input.maxEvents ? { maxEvents: Math.floor(input.maxEvents) } : {}),
                source: "tool",
                createdAt: now,
                nextRunAt: nextRun(schedule, now, now),
              }
              jobs.push(j)
              return j
            })
            const from = job.on?.channels.join(", ")
            const when = job.on
              ? job.schedule.kind === "event"
                ? `runs on events from ${from}`
                : `${describe(job.schedule)} with events from ${from}, next run ${fmt(job.nextRunAt)}`
              : `${describe(job.schedule)}, next run ${fmt(job.nextRunAt)}`
            return text(`Created automation "${job.name}" (id ${job.id}): ${when}, session=${job.session}.`)
          } catch (e) {
            return text(`error: ${(e as Error).message}`)
          }
        },
      })

      tools.add({
        name: "list",
        options: { namespace: "automation", ...CODE_MODE },
        description: "List automations: schedule, channels, next and last run.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          const jobs = load()
          if (!jobs.length) return text("No automations.")
          const lines = jobs.map(
            (j) =>
              `- ${j.id} [${isActive(j) ? "on" : "off"}${j.source === "config" ? ", config" : ""}] ${describe(j.schedule)}` +
              `${j.on ? ` · channels ${j.on.channels.join(", ")}` : ""} · ` +
              `session=${j.session} · next ${fmt(j.nextRunAt)} · last ${fmt(j.lastRunAt)} ${j.lastStatus ?? ""}\n  ${j.prompt.slice(0, 120)}`,
          )
          const running = [...inflight.values()].map((f) => f.run.jobID)
          return text(lines.join("\n") + (running.length ? `\nRunning now: ${running.join(", ")}` : "") + `\nLeader: ${leader ? "this process" : "another process"}`)
        },
      })

      tools.add({
        name: "update",
        options: { namespace: "automation", ...CODE_MODE },
        description:
          "Pause/resume (enabled) or change an automation's prompt, schedule or channels. channels replaces the list; " +
          "[] removes them, only if it has a schedule. Config automations can only be paused or resumed.",
        input: {
          type: "object",
          properties: {
            id: { type: "string" },
            enabled: { type: "boolean" },
            prompt: { type: "string" },
            ...scheduleProps,
            channels: { type: "array", items: { type: "string" }, description: "Full new list" },
            timeoutMinutes: { type: "number" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        execute: async (input: any) => {
          try {
            let dropQueue: { all: boolean; channels: string[] } | undefined
            const msg = await mutate(async (jobs) => {
              const j = find(jobs, input.id)
              if (!j) throw new Error(`no job "${input.id}"`)
              const edits = input.prompt || input.cron || input.every || input.at || input.timeoutMinutes || input.channels
              if (j.source === "config" && edits) throw new Error("config jobs are edited in opencode.json(c)")
              if (input.prompt) j.prompt = input.prompt
              if (input.timeoutMinutes) j.timeoutMinutes = input.timeoutMinutes
              if (Array.isArray(input.channels)) {
                const ids = input.channels.length ? checkChannels({ on: { channels: input.channels } }) : undefined
                if (!ids && j.schedule.kind === "event" && !(input.cron || input.every || input.at)) {
                  throw new Error("it runs only on events: give it a schedule (cron/every/at) before removing all channels")
                }
                const removed = (j.on?.channels ?? []).filter((c) => !ids?.includes(c))
                if (ids) j.on = { channels: ids }
                else delete j.on
                // What it held from channels it no longer uses is dropped below, once every check has passed.
                if (removed.length || !ids) dropQueue = { all: !ids, channels: removed }
              }
              if (input.cron || input.every || input.at) {
                j.schedule = toSchedule(input, !!j.on)
                j.createdAt = Date.now()
                j.done = undefined
                j.nextRunAt = undefined
              }
              if (typeof input.enabled === "boolean") {
                j.paused = !input.enabled
                if (j.source === "tool") j.enabled = input.enabled
              }
              if (j.enabled && !j.paused && !runnable(j)) {
                throw new Error("it has no channels and no schedule, so it would never run: add channels or a schedule (cron/every/at)")
              }
              if (j.enabled && j.nextRunAt === undefined) j.nextRunAt = nextRun(j.schedule, Date.now(), j.createdAt)
              // Last, after every check: a throw above leaves both the job and its queue as they were.
              if (dropQueue) {
                const drop = dropQueue
                await store.mutateChannels((s) => {
                  if (drop.all) delete s.queues[j.id]
                  else forget(s.queues[j.id], drop.channels)
                })
              }
              return `Updated ${j.id}: ${isActive(j) ? "enabled" : "paused"}, ${describe(j.schedule)}` +
                `${j.on ? `, channels ${j.on.channels.join(", ")}` : ""}, next ${fmt(j.nextRunAt)}.`
            })
            return text(msg)
          } catch (e) {
            return text(`error: ${(e as Error).message}`)
          }
        },
      })

      tools.add({
        name: "delete",
        options: { namespace: "automation", ...CODE_MODE },
        description: "Delete an automation.",
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        execute: async (input: any) => {
          try {
            const name = await mutate(async (jobs) => {
              const j = find(jobs, input.id)
              if (!j) throw new Error(`no job "${input.id}"`)
              if (j.source === "config") throw new Error("config jobs are removed from opencode.json(c); use automation_update enabled=false to pause")
              jobs.splice(jobs.indexOf(j), 1)
              await store.mutateChannels((s) => { delete s.queues[j.id] })
              return j.name
            })
            return text(`Deleted "${name}".`)
          } catch (e) {
            return text(`error: ${(e as Error).message}`)
          }
        },
      })

      tools.add({
        name: "run",
        options: { namespace: "automation", ...CODE_MODE },
        description: "Run an automation now.",
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        execute: async (input: any) => {
          const j = find(load(), input.id)
          if (!j) return text(`error: no job "${input.id}"`)
          const run = await runAutomation(j, "manual")
          if (typeof run === "string") return text(`Nothing started: ${run}.`)
          return text(`Run ${run.runID}: ${run.status}${run.sessionID ? ` in session ${run.sessionID}` : ""}${run.error ? ` — ${run.error}` : ""}`)
        },
      })

      tools.add({
        name: "history",
        options: { namespace: "automation", ...CODE_MODE },
        description: "Recent runs, optionally for one automation.",
        input: {
          type: "object",
          properties: { id: { type: "string" }, limit: { type: "number" } },
          additionalProperties: false,
        },
        execute: async (input: any) => {
          const runs = store.history(input.id, input.limit ?? 10)
          if (!runs.length) return text("No runs yet.")
          return text(
            runs
              .map((r) => {
                const dur = r.endedAt ? ` ${Math.round((r.endedAt - r.startedAt) / 1000)}s` : ""
                const tail = r.error ? `\n  error: ${r.error}` : r.output ? `\n  ${r.output.slice(0, 300).replace(/\n/g, "\n  ")}` : ""
                const sent = r.notifications ? ` · ${r.notifications} notified` : ""
                return `- ${fmt(r.startedAt)} ${r.jobID} ${r.status}${dur}${sent}${r.sessionID ? ` (${r.sessionID})` : ""}${tail}`
              })
              .join("\n"),
          )
        },
      })

      const findChannel = (id: string, channels = allChannels()) =>
        channels.get(id) ?? [...channels.values()].find((c) => c.name === id)

      tools.add({
        name: "list",
        options: { namespace: "channel", ...CODE_MODE },
        description: "List channels, their status and the automations on them. Reuse one before creating another.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          const jobs = load()
          const { sources, queues, defs } = store.loadChannels()
          const channels = allChannels(defs)
          if (!channels.size) return text("No channels. Create one with channel_test, then channel_create.")
          const lines = [...channels.values()].map((ch) => {
            const s = sources[ch.id]
            const host = (() => { try { return new URL(ch.request.url).host } catch { return ch.request.url } })()
            const subs = jobs.filter((j) => listens(j, ch.id))
            const listeners = subs.length
              ? subs.map((j) => `${j.id}${isActive(j) ? "" : " (off)"}: ${queues[j.id]?.pending?.length ?? 0} waiting`).join(", ")
              : "no automations, not polled"
            const { missing } = envNames(ch.request)
            return (
              `- ${ch.id}${ch.name !== ch.id ? ` (${ch.name})` : ""} [${configChannels.has(ch.id) ? "config" : "created"}] ` +
              `polls ${host} ${describe({ kind: "every", ms: ch.everyMs })} · last poll ${fmt(s?.lastPollAt)}` +
              `${s?.lastError ? ` FAILED (${s.failures}x): ${s.lastError}` : ""}` +
              `${missing.length ? ` · missing env: ${missing.join(", ")}` : ""}\n  ${listeners}`
            )
          })
          return text(lines.join("\n") + `\nLeader: ${leader ? "this process" : "another process"}`)
        },
      })

      tools.add({
        name: "poll",
        options: { namespace: "channel", ...CODE_MODE },
        description: "Poll a channel now; automations that run as events arrive start at once, digests get the events on schedule.",
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        execute: async (input: any) => {
          const ch = findChannel(input.id)
          if (!ch) return text(`error: no channel "${input.id}"`)
          if (!leader) {
            await store.mutateChannels((s) => requestPoll(s, ch.id))
            return text(`Poll of ${ch.id} queued; the leader process runs it within ${tickMs / 1000}s.`)
          }
          if (polling.has(ch.id)) return text(`${ch.id} is already polling.`)
          const r = await track(pollChannel(ch))
          if (r.error) return text(`error: poll of ${ch.id} failed: ${r.error}`)
          const started = await track(processArrivals(load(), ch.id))
          return text(`Polled ${ch.id}: ${r.fresh} new event${r.fresh === 1 ? "" : "s"}, ${started} run${started === 1 ? "" : "s"} started.`)
        },
      })

      const channelProps = {
        name: { type: "string" },
        every: { type: "string", description: 'Poll interval, min "1m"' },
        request: {
          type: "object",
          description: "Secrets only as {env:NAME}",
          properties: {
            url: { type: "string" },
            method: { type: "string" },
            headers: { type: "object", additionalProperties: { type: "string" } },
            body: { description: "JSON" },
          },
          required: ["url"],
        },
        items: { type: "string", description: "Dot path to the items array; empty: the response" },
        filter: { type: "object", description: '{ "field": value or [values] }' },
        event: {
          type: "object",
          description: "{dot.path} templates per item",
          properties: {
            id: { type: "string" }, sessionKey: { type: "string" }, title: { type: "string" }, body: { type: "string" }, url: { type: "string" },
          },
          required: ["id"],
        },
      } as const

      /** A channel definition from tool input, validated, with its problems spelled out. */
      function draft(input: any, id: string): { config: ChannelConfig; channel: Channel } {
        const config: ChannelConfig = {
          id, every: input.every ?? "5m", request: input.request, event: input.event,
          ...(input.name ? { name: input.name } : {}),
          ...(input.items !== undefined ? { items: input.items } : {}),
          ...(input.filter ? { filter: input.filter } : {}),
        }
        const channel = parseChannel(config)
        const secrets = literalSecrets(config.request)
        if (secrets.length) {
          throw new Error(
            `${secrets.join(", ")} look${secrets.length === 1 ? "s" : ""} like a secret written out. ` +
            "Use {env:NAME} instead (e.g. \"DD-API-KEY\": \"{env:DD_API_KEY}\") and ask the user to set NAME where the opencode server runs.",
          )
        }
        return { config, channel }
      }

      tools.add({
        name: "test",
        options: { namespace: "channel", ...CODE_MODE },
        description:
          "Dry-run a channel definition: real request, nothing saved or marked seen. Shows item counts, the first item's " +
          "fields and sample events; adjust items/filter/event until they look right, then channel_create it. " +
          'event.id must change when something happens again (e.g. "{id}:{updated_at}"). Secrets only as {env:NAME}.',
        input: { type: "object", properties: channelProps, required: ["request", "event"], additionalProperties: false },
        execute: async (input: any) => {
          let channel: Channel
          try { ({ channel } = draft(input, "test")) } catch (e) { return text(`error: ${(e as Error).message}`) }
          const { names, missing } = envNames(channel.request)
          if (missing.length) {
            return text(
              `error: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set in the opencode server's environment. ` +
              "Ask the user to set it there (then restart opencode) and test again.",
            )
          }
          let json: unknown
          try { json = await fetchJSON(channel, fetch, abort.signal) } catch (e) { return text(`error: request failed: ${(e as Error).message}`) }
          const items = get(json, channel.items)
          if (!Array.isArray(items)) {
            const arrays = arrayPaths(json)
            return text(
              `error: items "${channel.items || "(response)"}" is not an array.` +
              (arrays.length ? ` Arrays in the response: ${arrays.join(", ")}.` : "") +
              `\nResponse fields:\n${fieldPaths(json).join("\n")}`,
            )
          }
          const events = extract(channel, json)
          const sample = events.slice(0, 3).map((e) =>
            `- id=${e.id}${e.sessionKey ? ` sessionKey=${e.sessionKey}` : ""}\n  title: ${e.title}` +
            `${e.url ? `\n  url: ${e.url}` : ""}${e.body ? `\n  body: ${e.body.slice(0, 200).replace(/\n/g, " ")}` : ""}`)
          const blank = (field: "title" | "sessionKey") => input.event?.[field] && events.some((e) => field === "title" ? e.title === e.id : !e.sessionKey)
          const warnings = [
            ...(new Set(events.map((e) => e.id)).size < events.length ? ["Some events share an id: make event.id unique per item."] : []),
            ...(blank("title") ? ["event.title came out empty for some items: check its field paths."] : []),
            ...(blank("sessionKey") ? ["event.sessionKey came out empty for some items: check its field paths."] : []),
          ]
          return text(
            `OK: ${items.length} item${items.length === 1 ? "" : "s"}, ${events.length} after the filter.` +
            `${names.length ? ` Uses ${names.join(", ")} from the environment.` : ""}\n` +
            `Fields of the first item:\n${items.length ? fieldPaths(items[0]).join("\n") : "(no items now; the mapping can't be checked yet)"}\n` +
            `First events:\n${sample.length ? sample.join("\n") : "(none)"}` +
            (warnings.length ? `\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : ""),
          )
        },
      })

      tools.add({
        name: "create",
        options: { namespace: "channel", ...CODE_MODE },
        description: "Save a tested channel definition. It's polled once an automation uses it (automation_create/update channels).",
        input: {
          type: "object",
          properties: { id: { type: "string", description: "[a-z0-9_-]" }, ...channelProps },
          required: ["id", "request", "event"],
          additionalProperties: false,
        },
        execute: async (input: any) => {
          try {
            if (!CHANNEL_ID.test(input.id ?? "")) throw new Error('id must be lowercase letters, digits, - and _ (e.g. "datadog-alerts")')
            if (configChannels.has(input.id)) throw new Error(`"${input.id}" is a config channel; pick another id`)
            const { config } = draft(input, input.id)
            await store.mutateChannels((s) => {
              if (s.defs[input.id]) throw new Error(`channel "${input.id}" exists; change it with channel_update`)
              s.defs[input.id] = config
            })
            const { names, missing } = envNames(config.request)
            return text(
              `Created channel ${input.id}. Attach it to an automation with automation_create or automation_update (channels) to start polling.` +
              (missing.length ? ` Not set yet in the server's environment: ${missing.join(", ")}.` : names.length ? ` Reads ${names.join(", ")} from the environment.` : ""),
            )
          } catch (e) {
            return text(`error: ${(e as Error).message}`)
          }
        },
      })

      tools.add({
        name: "update",
        options: { namespace: "channel", ...CODE_MODE },
        description: "Change a channel created from chat; given fields replace the current ones. Changing event.id re-delivers items already seen.",
        input: {
          type: "object",
          properties: { id: { type: "string" }, ...channelProps },
          required: ["id"],
          additionalProperties: false,
        },
        execute: async (input: any) => {
          try {
            if (configChannels.has(input.id)) throw new Error(`"${input.id}" is defined in opencode.json(c); edit it there`)
            const updated = await store.mutateChannels((s) => {
              const prev = s.defs[input.id]
              if (!prev) throw new Error(`no channel "${input.id}" created with channel_create`)
              const merged = { ...prev, ...Object.fromEntries(Object.entries(input).filter(([k, v]) => k !== "id" && v !== undefined)) }
              const { config } = draft(merged, input.id)
              s.defs[input.id] = config
              return config
            })
            const { missing } = envNames(updated.request)
            return text(`Updated channel ${input.id}.${missing.length ? ` Not set yet in the server's environment: ${missing.join(", ")}.` : ""}`)
          } catch (e) {
            return text(`error: ${(e as Error).message}`)
          }
        },
      })

      tools.add({
        name: "delete",
        options: { namespace: "channel", ...CODE_MODE },
        description:
          "Delete a channel created from chat. Fails while automations use it unless detach is true, which removes it " +
          "from them; an automation left with no channel and no schedule is paused.",
        input: {
          type: "object",
          properties: { id: { type: "string" }, detach: { type: "boolean" } },
          required: ["id"],
          additionalProperties: false,
        },
        execute: async (input: any) => {
          try {
            const id = input.id as string
            if (configChannels.has(id)) throw new Error(`"${id}" is defined in opencode.json(c); remove it there`)
            if (!store.loadChannels().defs[id]) throw new Error(`no channel "${id}" created with channel_create`)
            // Under the jobs lock, so an automation can't attach the channel between the check and the delete.
            const { users, paused } = await mutate(async (jobs) => {
              const users = jobs.filter((j) => listens(j, id))
              const fromConfig = users.filter((j) => j.source === "config")
              if (fromConfig.length) throw new Error(`config automations use it (${fromConfig.map((j) => j.id).join(", ")}); change them in opencode.json(c) first`)
              if (users.length && !input.detach) {
                throw new Error(`automations use it: ${users.map((j) => j.id).join(", ")}. Pass detach: true to remove it from them.`)
              }
              const paused: string[] = []
              for (const j of users) {
                const rest = j.on!.channels.filter((c) => c !== id)
                if (rest.length) j.on = { channels: rest }
                else {
                  delete j.on
                  if (!runnable(j)) { j.paused = true; paused.push(j.id) }
                }
              }
              await store.mutateChannels((s) => removeChannel(s, id))
              return { users, paused }
            })
            return text(
              `Deleted channel ${id}.` +
              (users.length ? ` Removed from ${users.map((j) => j.id).join(", ")}.` : "") +
              (paused.length ? ` Paused (no channels or schedule left): ${paused.join(", ")}.` : ""),
            )
          } catch (e) {
            return text(`error: ${(e as Error).message}`)
          }
        },
      })
    })

    await ctx.command.transform((commands) => {
      commands.add({
        name: "automation",
        description: "Create, list, pause or run automations",
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            delivery,
            text: `${AUTOMATIONS_GUIDE}With no request, list them.\n\nRequest: ${prompt.text ?? ""}`,
          })
        },
      })
      commands.add({
        name: "channel",
        description: "Set up a channel (an API to poll for events) and the automations that run on it",
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            delivery,
            text: `${AUTOMATIONS_GUIDE}${CHANNEL_GUIDE}\n\nWith no request, list the channels and what uses them.\n\nRequest: ${prompt.text ?? ""}`,
          })
        },
      })
    })

    const pump = pumpEvents()
    const runTick = () => void track(tick()).catch((e) => console.error("[automations] tick:", e))
    const ticker = setInterval(runTick, tickMs)
    runTick()

    return async () => {
      abort.abort()
      clearInterval(ticker)
      // Let in-flight ticks and polls (aborted above) settle before another process can take the lease.
      await Promise.allSettled([...work])
      for (const f of inflight.values()) clearTimeout(f.timer)
      store.release()
      await pump.catch(() => {})
    }
  },
})
