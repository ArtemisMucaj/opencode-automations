// opencode v2 plugin: run prompts on a schedule.
//
//  - Jobs come from plugin options (declarative) or from the automation_* tools (conversational).
//  - A ticker fires due jobs into a new, reused, or the originating session.
//  - The event stream tracks each run to completion and records its final text.
//  - A lease lock elects one leader when several opencode processes load the plugin.

import { Plugin } from "@opencode/plugin"
import { randomUUID } from "node:crypto"
import { describe, nextRun, parseCron, parseInterval, type Schedule } from "./cron.ts"
import { Store, type Job, type Run, type SessionMode } from "./store.ts"
import { defaultDataDir, isActive } from "./jobs.ts"
import { compose, send, shouldNotify, type JobNotify, type NotifyConfig } from "./notify.ts"

interface Options {
  dataDir?: string
  tickSeconds?: number
  defaultTimeoutMinutes?: number
  defaultAgent?: string
  defaultModel?: string
  notify?: NotifyConfig
  jobs?: ConfigJob[]
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
  timer?: ReturnType<typeof setTimeout>
}

const MISSED_GRACE_MS = 2 * 60_000

function toSchedule(s: ScheduleInput): Schedule {
  const set = [s.cron, s.every, s.at].filter(Boolean).length
  if (set !== 1) throw new Error("provide exactly one of cron, every, at")
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

    // ---------- job state ----------

    const configJobs = (opts.jobs ?? []).map((c): Job => {
      if (!c.id || !c.prompt || !c.directory) throw new Error("[automations] config jobs need id, prompt and directory")
      parseModel(c.model ?? opts.defaultModel)
      return {
        id: c.id,
        name: c.name ?? c.id,
        prompt: c.prompt,
        schedule: toSchedule(c),
        directory: c.directory ?? process.cwd(),
        session: c.session ?? "new",
        agent: c.agent ?? opts.defaultAgent,
        model: c.model ?? opts.defaultModel,
        timeoutMinutes: c.timeoutMinutes ?? defaultTimeout,
        runMissed: c.runMissed ?? true,
        enabled: c.enabled ?? true,
        notify: c.notify,
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

    function mutate<T>(fn: (jobs: Job[]) => T): T {
      return store.mutate((jobs) => {
        const merged = load(jobs)
        const out = fn(merged)
        jobs.splice(0, jobs.length, ...merged)
        return out
      })
    }

    function find(jobs: Job[], idOrName: string) {
      return jobs.find((j) => j.id === idOrName) ?? jobs.find((j) => j.name === idOrName)
    }

    // ---------- firing ----------

    async function resolveSession(job: Job): Promise<string> {
      if (job.session !== "new" && job.sessionID) {
        try {
          const s = await ctx.session.get({ sessionID: job.sessionID })
          if (!s.time.archived) return s.id
        } catch {}
        if (job.session === "current") throw new Error(`session ${job.sessionID} is gone`)
      }
      const s = await ctx.session.create({
        title: `⏰ ${job.name}${job.session === "new" ? ` · ${new Date().toLocaleString()}` : ""}`,
        agent: job.agent ?? null,
        model: parseModel(job.model) ?? null,
        location: { directory: job.directory },
      })
      if (job.session === "reuse") mutate((jobs) => { const j = find(jobs, job.id); if (j) j.sessionID = s.id })
      return s.id
    }

    function finish(sessionID: string, status: Run["status"], error?: string) {
      const f = inflight.get(sessionID)
      if (!f) return
      inflight.delete(sessionID)
      clearTimeout(f.timer)
      const run: Run = { ...f.run, status, endedAt: Date.now(), output: f.lastText?.slice(0, 4000), error }
      store.appendRun(run)
      mutate((jobs) => { const j = find(jobs, run.jobID); if (j) j.lastStatus = status })
      // History keeps a capped copy; the notification gets the full text.
      notify(f.job, { ...run, output: f.lastText })
    }

    function notify(job: Job, run: Run) {
      if (shouldNotify(opts.notify, job, run.status)) {
        void send(opts.notify!, compose(job, run)).catch((error) => console.error("[automations] notify:", error))
      }
    }

    async function fire(job: Job, reason: "schedule" | "manual" | "missed"): Promise<Run> {
      const runID = `${job.id}-${randomUUID()}`
      const base: Run = { jobID: job.id, runID, startedAt: Date.now(), status: "running" }

      const busy = [...inflight.values()].find((f) => f.run.jobID === job.id)
      if (busy) {
        const skipped: Run = { ...base, status: "skipped", endedAt: Date.now(), error: "previous run still in progress" }
        store.appendRun(skipped)
        return skipped
      }
      try {
        const sessionID = await resolveSession(job)
        const run: Run = { ...base, sessionID }
        const entry: InFlight = { job, run }
        inflight.set(sessionID, entry)
        store.appendRun(run)
        entry.timer = setTimeout(() => {
          void ctx.session.interrupt({ sessionID }).catch(() => {})
          finish(sessionID, "timeout", `exceeded ${job.timeoutMinutes}m`)
        }, job.timeoutMinutes * 60_000)

        await ctx.session.prompt({
          sessionID,
          text: job.prompt,
          // Don't barge into a session that's mid-turn; wait our turn.
          delivery: job.session === "new" ? null : "queue",
          metadata: { automation: { jobID: job.id, runID, reason } },
        })
        return run
      } catch (e) {
        const failed: Run = { ...base, status: "failed", endedAt: Date.now(), error: String((e as Error)?.message ?? e) }
        for (const [sid, f] of inflight) if (f.run.runID === runID) { clearTimeout(f.timer); inflight.delete(sid) }
        store.appendRun(failed)
        mutate((jobs) => { const j = find(jobs, job.id); if (j) j.lastStatus = "failed" })
        notify(job, failed)
        return failed
      }
    }

    // ---------- ticker ----------

    async function tick() {
      leader = store.lease(tickMs * 3)
      if (!leader) return
      const now = Date.now()
      const due: Array<[Job, "schedule" | "manual" | "missed"]> = []

      mutate((jobs) => {
        for (const job of jobs) {
          if (job.runRequestedAt !== undefined) {
            job.runRequestedAt = undefined
            job.lastRunAt = now
            due.push([{ ...job }, "manual"])
            continue
          }
          if (!isActive(job)) continue
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
      for (const [job, reason] of due) await fire(job, reason)
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
      cron: { type: "string", description: 'Cron expression, e.g. "0 9 * * 1-5" or "@daily". Local time unless tz is set.' },
      every: { type: "string", description: 'Fixed interval, e.g. "15m", "2h", "1d" (min 1m).' },
      at: { type: "string", description: "One-shot ISO 8601 timestamp, e.g. 2026-11-02T09:00:00+01:00." },
      tz: { type: "string", description: "IANA time zone for cron, e.g. Europe/Paris." },
    } as const

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "automation_create",
        description:
          "Create an automation to run a prompt later or repeatedly. Use exactly one of cron/every/at. " +
          "session: 'new' = fresh session per run (default, best for reports/checks), " +
          "'reuse' = one dedicated session that accumulates context, 'current' = deliver into this conversation.",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short human name." },
            prompt: { type: "string", description: "Self-contained instruction run at each firing." },
            ...scheduleProps,
            session: { type: "string", enum: ["new", "reuse", "current"] },
            agent: { type: "string" },
            model: { type: "string", description: '"provider/model[:variant]"' },
            timeoutMinutes: { type: "number" },
          },
          required: ["name", "prompt"],
          additionalProperties: false,
        },
        execute: async (input: any, tc) => {
          try {
            const schedule = toSchedule(input)
            parseModel(input.model)
            const session: SessionMode = input.session ?? "new"
            let directory = process.cwd()
            try {
              directory = (await ctx.session.get({ sessionID: tc.sessionID })).location.directory ?? directory
            } catch {}
            const job = mutate((jobs) => {
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
                source: "tool",
                createdAt: now,
                nextRunAt: nextRun(schedule, now, now),
              }
              jobs.push(j)
              return j
            })
            return text(`Created automation "${job.name}" (id ${job.id}): ${describe(job.schedule)}, next run ${fmt(job.nextRunAt)}, session=${job.session}.`)
          } catch (e) {
            return text(`error: ${(e as Error).message}`)
          }
        },
      })

      tools.add({
        name: "automation_list",
        description: "List automations with their next run and last status.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          const jobs = load()
          if (!jobs.length) return text("No automations.")
          const lines = jobs.map(
            (j) =>
              `- ${j.id} [${isActive(j) ? "on" : "off"}${j.source === "config" ? ", config" : ""}] ${describe(j.schedule)} · ` +
              `session=${j.session} · next ${fmt(j.nextRunAt)} · last ${fmt(j.lastRunAt)} ${j.lastStatus ?? ""}\n  ${j.prompt.slice(0, 120)}`,
          )
          const running = [...inflight.values()].map((f) => f.run.jobID)
          return text(lines.join("\n") + (running.length ? `\nRunning now: ${running.join(", ")}` : "") + `\nLeader: ${leader ? "this process" : "another process"}`)
        },
      })

      tools.add({
        name: "automation_update",
        description: "Change an automation: pause/resume (enabled), prompt text, or schedule. Config-defined jobs can only be paused/resumed.",
        input: {
          type: "object",
          properties: {
            id: { type: "string" },
            enabled: { type: "boolean" },
            prompt: { type: "string" },
            ...scheduleProps,
            timeoutMinutes: { type: "number" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        execute: async (input: any) => {
          try {
            const msg = mutate((jobs) => {
              const j = find(jobs, input.id)
              if (!j) throw new Error(`no job "${input.id}"`)
              const edits = input.prompt || input.cron || input.every || input.at || input.timeoutMinutes
              if (j.source === "config" && edits) throw new Error("config jobs are edited in opencode.json(c)")
              if (input.prompt) j.prompt = input.prompt
              if (input.timeoutMinutes) j.timeoutMinutes = input.timeoutMinutes
              if (input.cron || input.every || input.at) {
                j.schedule = toSchedule(input)
                j.createdAt = Date.now()
                j.done = undefined
                j.nextRunAt = undefined
              }
              if (typeof input.enabled === "boolean") {
                j.paused = !input.enabled
                if (j.source === "tool") j.enabled = input.enabled
              }
              if (j.enabled && j.nextRunAt === undefined) j.nextRunAt = nextRun(j.schedule, Date.now(), j.createdAt)
              return `Updated ${j.id}: ${isActive(j) ? "enabled" : "paused"}, ${describe(j.schedule)}, next ${fmt(j.nextRunAt)}.`
            })
            return text(msg)
          } catch (e) {
            return text(`error: ${(e as Error).message}`)
          }
        },
      })

      tools.add({
        name: "automation_delete",
        description: "Delete an automation created with automation_create.",
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        execute: async (input: any) => {
          try {
            const name = mutate((jobs) => {
              const j = find(jobs, input.id)
              if (!j) throw new Error(`no job "${input.id}"`)
              if (j.source === "config") throw new Error("config jobs are removed from opencode.json(c); use automation_update enabled=false to pause")
              jobs.splice(jobs.indexOf(j), 1)
              return j.name
            })
            return text(`Deleted "${name}".`)
          } catch (e) {
            return text(`error: ${(e as Error).message}`)
          }
        },
      })

      tools.add({
        name: "automation_run",
        description: "Run an automation immediately (does not change its schedule).",
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        execute: async (input: any) => {
          const j = find(load(), input.id)
          if (!j) return text(`error: no job "${input.id}"`)
          const run = await fire(j, "manual")
          return text(`Run ${run.runID}: ${run.status}${run.sessionID ? ` in session ${run.sessionID}` : ""}${run.error ? ` — ${run.error}` : ""}`)
        },
      })

      tools.add({
        name: "automation_history",
        description: "Show recent runs (status, session, final output excerpt), optionally for one job.",
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
                return `- ${fmt(r.startedAt)} ${r.jobID} ${r.status}${dur}${r.sessionID ? ` (${r.sessionID})` : ""}${tail}`
              })
              .join("\n"),
          )
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
            text: "Manage automations with the automation_* tools. If the request is to create one, " +
              "write the prompt so it is self-contained (it runs later with no conversation context unless session=current). " +
              `With no request, list them.\n\nRequest: ${prompt.text ?? ""}`,
          })
        },
      })
    })

    const pump = pumpEvents()
    const ticker = setInterval(() => void tick().catch((e) => console.error("[automations] tick:", e)), tickMs)
    void tick().catch((e) => console.error("[automations] tick:", e))

    return async () => {
      abort.abort()
      clearInterval(ticker)
      for (const f of inflight.values()) clearTimeout(f.timer)
      store.release()
      await pump.catch(() => {})
    }
  },
})
