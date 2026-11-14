// The channel_* tools: list, poll, create, update, delete.

import { describe } from "./cron.ts"
import {
  CHANNEL_ID, envNames, literalSecrets, parseChannel, removeChannel, requestPoll, type Channel, type ChannelConfig,
} from "./channels.ts"
import { CODE_MODE } from "./guides.ts"
import { isActive, listens, runnable } from "./jobs.ts"
import type { Runtime, ToolEditor } from "./types.ts"
import { fmt, leaderLine, orError, plural, text } from "./util.ts"

export function channelTools(tools: ToolEditor, rt: Runtime) {
  const { store, tickMs, configChannels, load, mutate, allChannels, pollChannels, processArrivals, track } = rt

  tools.add({
    name: "list",
    options: { namespace: "channel", ...CODE_MODE },
    description: "List channels, their status and the automations on them. Reuse one before creating another.",
    input: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const jobs = load()
      const { sources, queues, defs } = store.loadChannels()
      const channels = allChannels(defs)
      if (!channels.size) return text("No channels. Create one with channel_create.")
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
      return text(lines.join("\n") + `\n${leaderLine(rt.leader())}`)
    },
  })

  tools.add({
    name: "poll",
    options: { namespace: "channel", ...CODE_MODE },
    description: "Poll a channel now; automations that run as events arrive start at once, digests get the events on schedule.",
    input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    execute: async (input: any) => {
      const channels = allChannels()
      const ch = channels.get(input.id) ?? [...channels.values()].find((c) => c.name === input.id)
      if (!ch) return text(`error: no channel "${input.id}"`)
      if (!rt.leader()) {
        await store.mutateChannels((s) => requestPoll(s, ch.id))
        return text(`Poll of ${ch.id} queued; the leader process runs it within ${tickMs / 1000}s.`)
      }
      if (rt.isPolling(ch.id)) return text(`${ch.id} is already polling.`)
      const polled = await track(pollChannels([ch]))
      const r = polled.results.get(ch.id)!
      if (r.error) return text(`error: poll of ${ch.id} failed: ${r.error}`)
      const started = await track(processArrivals(load(), ch.id, polled.state))
      return text(`Polled ${ch.id}: ${plural(r.fresh, "new event")}, ${plural(started, "run")} started.`)
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

  function draft(input: any, id: string, sessionID: string): { config: ChannelConfig; channel: Channel } {
    // A run reads event text from outside, which may try to steer it: it can't define requests,
    // or it could be made to send any variable of the server's environment to any URL.
    if (rt.runOf(sessionID)) throw new Error("channels can't be created or changed from inside an automation run; the user does that in chat")
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
        `Use {env:NAME} instead (e.g. "DD-API-KEY": "{env:DD_API_KEY}") and ask the user to set NAME where the opencode server runs.`,
      )
    }
    return { config, channel }
  }

  tools.add({
    name: "create",
    options: { namespace: "channel", ...CODE_MODE },
    description:
      "Save a channel definition. It's polled once an automation uses it (automation_create/update channels); channel_poll " +
      'checks it right away. event.id must change when something happens again (e.g. "{id}:{updated_at}"). Secrets only as {env:NAME}.',
    input: {
      type: "object",
      properties: { id: { type: "string", description: "[a-z0-9_-]" }, ...channelProps },
      required: ["id", "request", "event"],
      additionalProperties: false,
    },
    execute: (input: any, tc) => orError(async () => {
      if (!CHANNEL_ID.test(input.id ?? "")) throw new Error('id must be lowercase letters, digits, - and _ (e.g. "datadog-alerts")')
      if (configChannels.has(input.id)) throw new Error(`"${input.id}" is a config channel; pick another id`)
      const { config } = draft(input, input.id, tc.sessionID)
      await store.mutateChannels((s) => {
        if (s.defs[input.id]) throw new Error(`channel "${input.id}" exists; change it with channel_update`)
        s.defs[input.id] = config
      })
      const { names, missing } = envNames(config.request)
      return text(
        `Created channel ${input.id}. Attach it to an automation with automation_create or automation_update (channels) to start polling.` +
        (missing.length ? ` Not set yet in the server's environment: ${missing.join(", ")}.` : names.length ? ` Reads ${names.join(", ")} from the environment.` : ""),
      )
    }),
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
    execute: (input: any, tc) => orError(async () => {
      if (configChannels.has(input.id)) throw new Error(`"${input.id}" is defined in opencode.json(c); edit it there`)
      const updated = await store.mutateChannels((s) => {
        const prev = s.defs[input.id]
        if (!prev) throw new Error(`no channel "${input.id}" created with channel_create`)
        const merged = { ...prev, ...Object.fromEntries(Object.entries(input).filter(([k, v]) => k !== "id" && v !== undefined)) }
        const { config } = draft(merged, input.id, tc.sessionID)
        s.defs[input.id] = config
        return config
      })
      const { missing } = envNames(updated.request)
      return text(`Updated channel ${input.id}.${missing.length ? ` Not set yet in the server's environment: ${missing.join(", ")}.` : ""}`)
    }),
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
    execute: (input: any) => orError(async () => {
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
    }),
  })
}
