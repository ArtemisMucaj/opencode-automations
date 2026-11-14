// The automation_* tools: create, list, update, delete, run, history; notify and memory_update inside runs.

import { describe, nextRun } from "./cron.ts"
import { forget } from "./channels.ts"
import { CODE_MODE, MAX_NOTE } from "./guides.ts"
import { checkTimeout, find, isActive, newJob, parseModel, runnable, toSchedule } from "./jobs.ts"
import { canNotify, longLine, MAX_LINE, MAX_PARTS, PUSHOVER, send, split, type Priority } from "./notify.ts"
import { sessionMode } from "./store.ts"
import type { Runtime, ToolEditor } from "./types.ts"
import { elapsed, errorMessage, fmt, leaderLine, orError, text } from "./util.ts"

const scheduleProps = {
  cron: { type: "string", description: 'e.g. "0 9 * * 1-5", "@daily"; local time unless tz' },
  every: { type: "string", description: 'e.g. "15m", "2h" (min 1m)' },
  at: { type: "string", description: "ISO 8601, one-shot" },
  tz: { type: "string", description: "IANA zone for cron" },
} as const

export function automationTools(tools: ToolEditor, rt: Runtime) {
  const { ctx, opts, store, defaultTimeout, maxPerRun, load, mutate, checkChannels, remember, runAutomation } = rt
  tools.add({
    name: "notify",
    options: { namespace: "automation", ...CODE_MODE },
    description:
      "Send a notification to the user's phone and desktop from this automation run. " +
      "It is read on a lock screen, so write for a glance: a title that states the outcome " +
      '(e.g. "3 MRs need your review", not "Report"), then the details that support it, most important first: ' +
      "the lock screen shows only the first lines. " +
      "Format it as a notification, not markdown: plain text, short lines, one item per line, a blank line " +
      `between groups, links pasted directly as full URLs. Lines over ${MAX_LINE} characters (links aside) are refused. ` +
      "No **bold**, headings, backticks, tables or [text](url) links. " +
      `Keep the message under ${PUSHOVER.message} characters (Pushover's limit); longer text arrives as ` +
      `numbered parts, at most ${MAX_PARTS}. One notification per topic: send several only for ` +
      "separate findings that each deserve attention, not one per item.",
    input: {
      type: "object",
      properties: {
        title: { type: "string", description: "Headline stating the outcome. Under 60 characters reads best." },
        message: { type: "string", description: `Plain text, no markdown. One item per line, blank lines between groups, full URLs for links. Ideally under ${PUSHOVER.message} characters.` },
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
      const f = rt.runOf(tc.sessionID)
      if (!f || !canNotify(opts.notify, f.job)) return text("error: notifications are only available inside an automation run that has them enabled.")
      if (f.sent >= maxPerRun) return text(`error: this run already sent ${f.sent} notifications (limit ${maxPerRun}). Don't send more.`)
      const title = String(input.title ?? "").trim()
      const message = String(input.message ?? "").trim()
      if (!title || !message) return text("error: title and message are required.")
      const long = longLine(message)
      if (long) {
        return text(
          `error: a line is ${long.length} characters ("${long.slice(0, 60)}…"), too long to read on a phone. ` +
          `Break it up: one item per line, at most ${MAX_LINE} characters each, a blank line between groups. Nothing was sent.`,
        )
      }
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
    name: "memory_update",
    options: { namespace: "automation", ...CODE_MODE },
    description:
      "Hand the result of this run to the next run of this sticky automation; it replaces the previous memory. " +
      "The next run may see only this, not this conversation. Write the current " +
      "state, what changed, open items, what the user was already told, useful IDs and links. " +
      `At most ${MAX_NOTE} characters. Call it before your final reply.`,
    input: {
      type: "object",
      properties: { note: { type: "string", description: `The whole memory, at most ${MAX_NOTE} characters.` } },
      required: ["note"],
      additionalProperties: false,
    },
    execute: async (input: any, tc) => {
      const f = rt.runOf(tc.sessionID)
      if (f?.job.session !== "sticky") return text("error: memory is only kept for runs of sticky automations.")
      const note = String(input.note ?? "").trim()
      if (!note) return text("error: the note is empty.")
      if (note.length > MAX_NOTE) {
        return text(`error: the note is ${note.length} characters; the limit is ${MAX_NOTE}. Keep what the next run needs. Nothing was saved.`)
      }
      try {
        await remember(f.job.id, f.key, tc.sessionID, { note })
      } catch (e) { return text(`error: couldn't save the memory (${errorMessage(e)}). Try once more.`) }
      f.memoryUpdated = true
      return text(`Saved (${note.length} characters). The next run that doesn't see this conversation starts from it.`)
    },
  })

  tools.add({
    name: "create",
    options: { namespace: "automation", ...CODE_MODE },
    description:
      "Create an automation: one of cron/every/at, and/or channels. With channels and no schedule it runs as events arrive; " +
      "with a schedule it is a digest of what arrived since the last run. session: new (default, fresh per run), sticky " +
      "(context carries across runs: the session while its cache is warm, else compacted to the last run's memory; " +
      "with channels that set event.sessionKey, per key), current (this chat). The prompt must be self-contained.",
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
    execute: (input: any, tc) => orError(async () => {
      const ids = checkChannels({ on: input.channels?.length ? { channels: input.channels } : undefined, maxEvents: input.maxEvents })
      const on = ids ? { channels: ids } : undefined
      const schedule = toSchedule(input, { channels: !!on })
      parseModel(input.model)
      const timeoutMinutes = checkTimeout(input.timeoutMinutes) ?? defaultTimeout
      const session = sessionMode(input.session) ?? "new"
      let directory = process.cwd()
      try {
        directory = (await ctx.session.get({ sessionID: tc.sessionID })).location.directory ?? directory
      } catch {}
      const job = await mutate((jobs) => {
        // Again under the jobs lock: channel deletes check for users under it too.
        if (on) checkChannels({ on })
        const j = newJob(jobs, {
          name: input.name,
          prompt: input.prompt,
          schedule,
          directory,
          session,
          sessionID: session === "current" ? tc.sessionID : undefined,
          agent: input.agent ?? opts.defaultAgent,
          model: input.model ?? opts.defaultModel,
          timeoutMinutes,
          ...(on ? { on } : {}),
          ...(input.maxEvents ? { maxEvents: Math.floor(input.maxEvents) } : {}),
        })
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
    }),
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
      const running = rt.runningJobs()
      return text(lines.join("\n") + (running.length ? `\nRunning now: ${running.join(", ")}` : "") + `\n${leaderLine(rt.leader())}`)
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
    execute: (input: any) => orError(async () => {
      let dropQueue: { all: boolean; channels: string[] } | undefined
      const msg = await mutate(async (jobs) => {
        const j = find(jobs, input.id)
        if (!j) throw new Error(`no job "${input.id}"`)
        const edits = input.prompt || input.cron || input.every || input.at || input.timeoutMinutes !== undefined || input.channels
        if (j.source === "config" && edits) throw new Error("config jobs are edited in opencode.json(c)")
        if (input.prompt) j.prompt = input.prompt
        if (input.timeoutMinutes !== undefined) j.timeoutMinutes = checkTimeout(input.timeoutMinutes) ?? j.timeoutMinutes
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
          j.schedule = toSchedule(input, { channels: !!j.on })
          j.createdAt = Date.now()
          j.done = undefined
          j.nextRunAt = undefined
        }
        if (typeof input.enabled === "boolean") {
          // Paused, not disabled: its channels' events keep waiting for it, as when paused from the TUI.
          // Resuming re-anchors to now, as in the TUI: a long pause doesn't fire a missed run right away.
          if (input.enabled && !isActive(j)) j.nextRunAt = undefined
          j.paused = !input.enabled
          if (input.enabled) j.enabled = true
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
    }),
  })

  tools.add({
    name: "delete",
    options: { namespace: "automation", ...CODE_MODE },
    description: "Delete an automation.",
    input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    execute: (input: any) => orError(async () => {
      const name = await mutate(async (jobs) => {
        const j = find(jobs, input.id)
        if (!j) throw new Error(`no job "${input.id}"`)
        if (j.source === "config") throw new Error("config jobs are removed from opencode.json(c); use automation_update enabled=false to pause")
        jobs.splice(jobs.indexOf(j), 1)
        await store.mutateChannels((s) => { delete s.queues[j.id] })
        return j.name
      })
      return text(`Deleted "${name}".`)
    }),
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
    description: "Recent runs, optionally for one automation: outcome and session. What a run said is in its session.",
    input: {
      type: "object",
      properties: { id: { type: "string" }, limit: { type: "number" } },
      additionalProperties: false,
    },
    execute: async (input: any) => {
      const runs = store.history(input.id ? (find(load(), input.id)?.id ?? input.id) : undefined, input.limit ?? 10)
      if (!runs.length) return text("No runs yet.")
      return text(
        runs
          .map((r) => {
            const dur = elapsed(r) && ` ${elapsed(r)}`
            const tail = r.error ? `\n  error: ${r.error}` : ""
            const sent = r.notifications ? ` · ${r.notifications} notified` : ""
            return `- ${fmt(r.startedAt)} ${r.jobID} ${r.status}${dur}${sent}${r.sessionID ? ` (${r.sessionID})` : ""}${tail}`
          })
          .join("\n"),
      )
    },
  })
}
