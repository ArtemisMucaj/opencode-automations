// What the agent is told: tool names, namespaces, and the guides for commands and runs.

import type { Job, SessionMode } from "./store.ts"

export const NOTIFY_TOOL = "automation_notify"
/** What a run ends its reply with when it deliberately sends nothing. */
const NOTHING_TO_NOTIFY = "Nothing worth notifying the user about in this run."
export const saidNothing = (reply?: string) => !!reply && /nothing worth notifying the user about/i.test(reply)
export const UPDATE_TOOL = "automation_memory_update"
export const MAX_NOTE = 4000

/**
 * Every tool goes through opencode's code mode: they're grouped in these namespaces and exposed as
 * `automation_*` / `channel_*`, without their schemas riding along on every request.
 */
export const CODE_MODE = { codemode: true } as const
export const NAMESPACES = [
  { name: "automation", description: "Run prompts on a schedule or on channel events: create, list, update, delete, run, history; notify (inside runs); memory_update (inside sticky runs)." },
  { name: "channel", description: "Event sources polled from HTTP APIs (Datadog, Sentry, GitHub…): list, poll, create, update, delete." },
] as const

export const AUTOMATIONS_GUIDE =
  "Automations run a prompt on a schedule (cron, every, or a one-shot at), or on events from channels. " +
  "automation_create/list/update/delete/run/history manage them. Write the prompt self-contained: runs start with no " +
  "conversation context unless session is \"current\". Sessions: \"new\" (default) is a fresh session per run, " +
  "\"sticky\" carries context across runs (with channels that set event.sessionKey: per key): it continues its session " +
  "while the model's prompt cache is warm, and otherwise compacts it to the memory each run hands the next " +
  "through automation_memory_update, so old history isn't re-read at full price. \"current\" is this chat.\n" +
  "On channels: with no schedule an automation runs as events arrive (up to maxEvents, default 10, per run); with a " +
  "schedule it is a digest of everything since the last run (default 50). Its first poll of a channel gets everything " +
  "already there. automation_update channels replaces the list; [] removes them, only if it has a schedule.\n" +
  "channel_poll polls now and starts runs for automations that take events as they arrive; digests get them on schedule. " +
  "channel_update fields replace the current ones; changing event.id makes seen items look new, so they are delivered " +
  "again. channel_delete fails while automations use the channel unless detach is true, which removes it from them; " +
  "an automation left with no channel and no schedule is paused. Config channels and jobs are edited in opencode.json(c).\n\n"

export const CHANNEL_GUIDE =
  "Set up event sources (channels) and the automations that run on them.\n" +
  "1. channel_list: if a channel already polls what is needed, reuse it instead of creating another.\n" +
  "2. For a new one, find the API endpoint that lists the items: from its docs, an example the user gives, or a connected tool.\n" +
  "3. Keys: never write a secret into the definition. Use {env:NAME} (e.g. header \"DD-API-KEY\": \"{env:DD_API_KEY}\") " +
  "and tell the user to set NAME where the opencode server runs; channel_create says if it is missing.\n" +
  "4. Write the definition from the API's documented response: items (the array), filter, " +
  "event.id (must change when something happens again, e.g. \"{id}:{updated_at}\"), event.sessionKey (which events share a " +
  "conversation, e.g. one per monitor), and a title/body/url the agent can act on. Pick an interval that respects rate limits.\n" +
  "5. channel_create it, then channel_poll it once: an error means the request or the items path is wrong; " +
  "fix it with channel_update and poll again.\n" +
  "6. Agree with the user on what to do with the events, then automation_create (or automation_update to add channels to an " +
  "existing automation) with channels: [...]. No schedule runs as events arrive; a schedule makes a digest. " +
  "session \"sticky\" with a sessionKey keeps one conversation per key. Write a self-contained prompt that says when to notify.\n" +
  "An automation can use several channels, and a channel can feed several automations."

export const RUN_GUIDE =
  `You are running unattended as an automation. Nobody is watching this session: ` +
  `your final reply stays here and is not sent anywhere. To reach the user, call ${NOTIFY_TOOL} ` +
  `with what they need to know or act on, once you know it. If nothing is worth their attention, don't notify, ` +
  `and end your final reply with the line "${NOTHING_TO_NOTIFY}" ` +
  `Write it as a notification, not a chat reply: plain text, no markdown (no **, #, backticks, tables or [text](url)). ` +
  `Lead with what matters most: a lock screen shows only the title and the first lines. ` +
  `Short lines, one item per line, a blank line between groups; paste links directly as full URLs. ` +
  `Send few notifications, within the limit given below; group related items into one. ` +
  `Failures and timeouts are reported to the user automatically.`
export const RUN_GUIDE_SHORT =
  `This run is ending and you haven't called ${NOTIFY_TOOL}, so the user has heard nothing: ` +
  `your reply above is not sent anywhere. If it holds anything the user should know or act on, ` +
  `send it now with ${NOTIFY_TOOL}. If there is really nothing, reply "${NOTHING_TO_NOTIFY}"`

export const MEMORY_GUIDE =
  `This automation carries its results from run to run, but not through this conversation: once it ` +
  `goes idle for a while, the next run sees none of it. The only thing that reaches the next run is the memory you ` +
  `write with ${UPDATE_TOOL}. Build on what the previous runs found (in this conversation, or in their memory): ` +
  `don't redo their work, and don't tell the user again what they were already told. ` +
  `End every run with ${UPDATE_TOOL}, before your final reply, with the result of this run for the next one: the current ` +
  `state, what changed, open items and what to watch for, what you told the user, and anything learned that saves ` +
  `work (IDs, links, commands). Facts, not a story of the run. It replaces the previous memory, so carry over what ` +
  `still matters from it. At most ${MAX_NOTE} characters. ` +
  `Skipping ${UPDATE_TOOL} drops the memory, so the next run may have to redo this one's work.`
export const MEMORY_GUIDE_SHORT =
  `You haven't called ${UPDATE_TOOL}, so the next run won't know the result of this one: it may not see ` +
  `this conversation. Call ${UPDATE_TOOL} now with this run's result and what the next run needs to pick up from here.`

// After the constant guides, so they stay one cached prefix. Only values fixed for the whole run.
const SESSION_MODES: Record<SessionMode, string> = {
  new: "Each run starts in a new session.",
  sticky: "Its runs share this session.",
  current: "It runs in the chat it was created from.",
}
export const runContext = (job: Job, maxNotifications?: number) =>
  `This run is for the automation "${job.name}" (id: ${job.id}). ${SESSION_MODES[job.session]}` +
  (maxNotifications !== undefined ? ` You can send up to ${maxNotifications} notifications in this run.` : "")

