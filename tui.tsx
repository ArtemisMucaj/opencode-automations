// opencode v2 TUI plugin for automations.
// Reads state.db and writes intents (pause, edit, delete, run now) that the server's leader carries out.

import type { Renderable, RGBA } from "@opentui/core"
import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, For, Index, Match, Show, Switch, type JSX } from "solid-js"
import { describe, nextRun } from "./cron.ts"
import { DEFAULT_TIMEOUT_MINUTES, defaultDataDir, isActive, listens, newJob, parseScheduleText, runnable, runningJobs, stateOf } from "./jobs.ts"
import { clock, elapsed, errorMessage, plural, relative } from "./util.ts"
import {
  Store, type DeliveryStatus, type InboxEntry, type InboxEvent, type Job, type Run, type RunStatus, type SendStatus, type SentMessage, type SessionMode,
} from "./store.ts"
import { channelRows, emptyChannels, requestPoll, type ChannelRow, type ChannelsState } from "./channels.ts"

type Context = Plugin.Context

const glyph: Record<RunStatus, string> = { running: "◐", succeeded: "✓", failed: "✗", timeout: "⧗", skipped: "↷" }

// Everything is drawn as filled blocks in the host theme's colors (no borders), so the page
// follows whichever theme is selected. Tinted blocks use the theme's categorical hues.
function look(ctx: Context, surface?: "dialog") {
  const t = surface ? ctx.theme.surface(surface) : ctx.theme
  const dark = ctx.themeMode !== "light"
  const hue = (i: number) => t.categorical[i % Math.max(1, t.categorical.length)] ?? t.hue.accent
  return {
    t,
    text: t.text.base,
    muted: t.text.muted,
    faint: t.text.faint,
    ok: t.text.feedback.success.base,
    warn: t.text.feedback.warning.base,
    bad: t.text.feedback.error.base,
    info: t.text.feedback.info.base,
    panel: t.background.raised.base,
    cap: t.background.raised.high,
    /** Softly tinted block background for section i. */
    tint: (i: number) => hue(i)[dark ? 900 : 100],
    /** Readable heading color on that tint. */
    ink: (i: number) => hue(i)[dark ? 300 : 700],
  }
}

type Tab = "jobs" | "channels" | "inbox" | "outbox"
/** The keys that switch tabs; pressing the open tab's key goes back to the automations. */
const tabKeys: Record<Exclude<Tab, "jobs">, string> = { channels: "c", inbox: "i", outbox: "o" }
const tabHints = (tab: Tab): [string, string][] => [
  ...(tab === "jobs" ? [] : [[tabKeys[tab], "automations"] as [string, string]]),
  ...Object.entries(tabKeys).filter(([t]) => t !== tab).map(([t, k]): [string, string] => [k, t]),
]
const keyHints: [string, string][] = [
  ["↑↓", "select"],
  ["space", "pause"],
  ["r", "run now"],
  ["n", "new"],
  ["e", "prompt"],
  ["s", "schedule"],
  ["m", "model"],
  ["d", "delete"],
  ["⏎", "open session"],
  ["esc", "close"],
]
const channelHints: [string, string][] = [
  ["↑↓", "select"],
  ["p", "poll now"],
  ["d", "delete"],
  ["esc", "close"],
]
const listHints: [string, string][] = [
  ["↑↓", "select"],
  ["esc", "close"],
]
/** How many of the latest inbox events and outbox messages the tabs show. */
const LIST_LIMIT = 100

const BUSY_MS = 250
export function createState(ctx: Context, dataDir: string) {
  const store = new Store(dataDir, { busyMs: BUSY_MS })
  const [jobs, setJobs] = createSignal<Job[]>(store.loadJobs())
  const [runs, setRuns] = createSignal<Run[]>(store.history(undefined, 300))
  const [now, setNow] = createSignal(Date.now())
  const loadChannels = () => { try { return store.loadChannels() } catch { return emptyChannels() } }
  const [channels, setChannels] = createSignal<ChannelsState>(loadChannels())
  const loadWaiting = () => {
    try {
      return { counts: store.waitingCounts(), first: new Map(jobs().filter((j) => j.on).map((j) => [j.id, store.waiting(j.id, 20)])) }
    } catch { return { counts: new Map<string, Map<string, number>>(), first: new Map<string, InboxEvent[]>() } }
  }
  const [waiting, setWaiting] = createSignal(loadWaiting())
  const loadSent = () => {
    try { return new Map(jobs().map((j) => [j.id, store.sent(j.id, 5)])) } catch { return new Map<string, SentMessage[]>() }
  }
  const [sent, setSent] = createSignal(loadSent())
  // Kept here, not in the view: the dialog is re-created after nested prompts and must reopen on the same job and tab.
  const [selectedID, setSelectedID] = createSignal<string>()
  const [selectedChannel, setSelectedChannel] = createSignal<string>()
  const [selectedEvent, setSelectedEvent] = createSignal<number>()
  const [selectedMessage, setSelectedMessage] = createSignal<number>()
  const [tab, setTab] = createSignal<Tab>("jobs")
  // Bumped on every refresh, for reads made only while they're shown (a job's memory, the inbox and outbox tabs).
  const [refreshed, setRefreshed] = createSignal(0)

  const notifyMode = (ctx.options.notify ?? "blurred") as "always" | "blurred" | "off"
  const seen = new Set(runs().filter((r) => r.status !== "running").map((r) => r.runID))

  function refresh() {
    let next: Run[]
    // State that can't be read now keeps what is shown.
    try {
      setJobs(store.loadJobs())
      next = store.history(undefined, 300)
    } catch { return }
    setChannels(loadChannels())
    setWaiting(loadWaiting())
    setSent(loadSent())
    setRuns(next)
    setNow(Date.now())
    setRefreshed((n) => n + 1)
    for (const r of next) {
      if (r.status === "running" || seen.has(r.runID)) continue
      seen.add(r.runID)
      if (r.status === "skipped") continue
      const job = jobs().find((j) => j.id === r.jobID)
      const title = `⏰ ${job?.name ?? r.jobID} ${r.status}`
      const message = r.error ?? elapsed(r)
      ctx.ui.toast.show({ title, message, variant: r.status === "succeeded" ? "success" : "error", duration: 6000 })
      if (notifyMode !== "off") {
        void ctx.attention
          .notify({ title, message, notification: { when: notifyMode === "always" ? "always" : "blurred" }, sound: false })
          .catch(() => {})
      }
    }
  }

  /** Do a write and re-read. Resolves to an error message instead of throwing (callers toast it). */
  async function attempt(write: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await write()
      refresh()
    } catch (e) {
      return errorMessage(e)
    }
  }
  const act = (fn: (jobs: Job[]) => void) => attempt(() => store.mutate(fn))
  const actChannels = (fn: (s: ChannelsState) => void) => attempt(() => store.mutateChannels(fn))

  const tick = () => setNow(Date.now())

  return {
    store, jobs, runs, now, refresh, tick, act, selectedID, setSelectedID, channels, actChannels, waiting, sent,
    selectedChannel, setSelectedChannel, tab, setTab, refreshed,
    selectedEvent, setSelectedEvent, selectedMessage, setSelectedMessage,
  }
}

type State = ReturnType<typeof createState>

function AutomationsView(props: { ctx: Context; state: State; reopen: () => void }) {
  const { ctx, state } = props
  const { selectedID, setSelectedID } = state
  const t = ctx.theme.surface("dialog")
  const sorted = createMemo(() =>
    [...state.jobs()].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)),
  )
  // Selection follows the job, not the row: pausing re-sorts the list and must not move the cursor to another job.
  const index = createMemo(() => Math.max(0, sorted().findIndex((j) => j.id === selectedID())))
  const selected = createMemo(() => sorted()[index()])
  const jobRuns = createMemo(() => state.runs().filter((r) => r.jobID === selected()?.id).slice(0, 8))
  const jobSent = createMemo(() => state.sent().get(selected()?.id ?? "") ?? [])
  // Only the selected job's notes are read, again on each refresh. A read that fails keeps what is shown, as refresh() does.
  const jobNotes = createMemo<ReturnType<Store["notes"]>>((shown) => {
    state.refreshed()
    const id = selected()?.id
    if (!id) return []
    try { return state.store.notes(id) } catch { return shown }
  }, [])

  // ---- channels tab ----
  const onChannels = () => state.tab() === "channels"
  const onJobs = () => state.tab() === "jobs"
  const chRows = createMemo(() => channelRows(state.channels()))
  const chIndex = createMemo(() => Math.max(0, chRows().findIndex((c) => c.id === state.selectedChannel())))
  const chSelected = createMemo(() => chRows()[chIndex()])
  /** Per channel, computed once per refresh: the automations on it, and "failing", "polling" (an active one uses it) or "idle". */
  const chInfo = createMemo(() => {
    const info = new Map<string, { users: Job[]; status: "failing" | "polling" | "idle" }>()
    for (const c of chRows()) {
      const users = state.jobs().filter((j) => listens(j, c.id))
      info.set(c.id, { users, status: state.channels().sources[c.id]?.failures ? "failing" : users.some(isActive) ? "polling" : "idle" })
    }
    return info
  })
  const listeners = (id: string) => chInfo().get(id)?.users ?? []
  const chStatus = (c: ChannelRow) => chInfo().get(c.id)?.status ?? "idle"
  const moveChannel = (d: number) => {
    const next = chRows()[Math.max(0, Math.min(chRows().length - 1, chIndex() + d))]
    if (next) state.setSelectedChannel(next.id)
  }
  const running = createMemo(() => runningJobs(state.jobs(), state.runs(), state.now()))
  const jobName = (id?: string) => (id ? (state.jobs().find((j) => j.id === id)?.name ?? id) : "chat")

  // ---- inbox and outbox tabs: read only while open ----
  const inbox = createMemo<InboxEntry[]>((shown) => {
    state.refreshed()
    if (state.tab() !== "inbox") return []
    try { return state.store.inbox(LIST_LIMIT) } catch { return shown }
  }, [])
  const evIndex = createMemo(() => Math.max(0, inbox().findIndex((e) => e.seq === state.selectedEvent())))
  const evSelected = createMemo(() => inbox()[evIndex()])
  const outbox = createMemo<SentMessage[]>((shown) => {
    state.refreshed()
    if (state.tab() !== "outbox") return []
    try { return state.store.sent(undefined, LIST_LIMIT) } catch { return shown }
  }, [])
  const msgIndex = createMemo(() => Math.max(0, outbox().findIndex((m) => m.id === state.selectedMessage())))
  const msgSelected = createMemo(() => outbox()[msgIndex()])

  /** Toast an error message; also takes the promise act() returns, and resolves once it has settled. */
  const toastErr = async (msg?: string | Promise<string | undefined>) => {
    const m = await msg
    if (m) ctx.ui.toast.show({ title: "Automations", message: m, variant: "error" })
  }
  const move = (d: number) => {
    const next = sorted()[Math.max(0, Math.min(sorted().length - 1, index() + d))]
    if (next) setSelectedID(next.id)
  }
  const withJob = (fn: (j: Job) => void | Promise<void>) => () => {
    const j = selected()
    if (!j) return
    setSelectedID(j.id) // pin, so a re-sort caused by this action keeps the cursor on it
    return fn(j)
  }
  // opencode shows one dialog at a time, so a prompt replaces this view. Bring it back afterwards.
  const nested =
    <A extends unknown[]>(fn: (...args: A) => unknown) =>
    async (...args: A) => {
      try {
        await fn(...args)
      } finally {
        props.reopen()
      }
    }
  const editable = (j: Job) => {
    if (j.source === "config") toastErr("Config jobs are edited in opencode.json(c) — only pause/run here.")
    return j.source !== "config"
  }
  const update = (id: string, fn: (j: Job) => void) =>
    toastErr(
      state.act((jobs) => {
        const j = jobs.find((x) => x.id === id)
        if (!j) throw new Error("job no longer exists")
        fn(j)
      }),
    )

  const channelActions = {
    poll: () => {
      const c = chSelected()
      if (!c) return
      const done = toastErr(state.actChannels((s) => requestPoll(s, c.id)))
      ctx.ui.toast.show({ message: `Polling “${c.name}” on the automations plugin's next tick`, variant: "info" })
      return done
    },
    remove: nested(async () => {
      const c = chSelected()
      if (!c) return
      if (c.source === "config") return toastErr("Config channels are removed in opencode.json(c).")
      const users = listeners(c.id)
      if (users.length) {
        return toastErr(`Used by ${users.map((j) => j.name).join(", ")}. Detach it from chat: channel_delete with detach.`)
      }
      const ok = await ctx.ui.dialog.confirm({ title: "Delete channel", message: `Delete the channel “${c.name}”? No automation uses it.` })
      if (!ok) return
      // Checked again: chat may have attached it since.
      await toastErr(state.act((jobs) => {
        const now = jobs.filter((j) => listens(j, c.id))
        if (now.length) throw new Error(`Used by ${now.map((j) => j.name).join(", ")} now. Detach it from chat: channel_delete with detach.`)
        state.store.removeChannel(c.id)
      }))
    }),
  }
  const jobsOnly = (fn: () => unknown) => () => (onJobs() ? fn() : undefined)
  const channelsOnly = (fn: () => unknown) => () => (onChannels() ? fn() : undefined)
  const stepIn = <T,>(list: T[], i: number, d: number, pick: (x: T) => void) => {
    const next = list[Math.max(0, Math.min(list.length - 1, i + d))]
    if (next) pick(next)
  }
  const step = (d: number) => {
    const tab = state.tab()
    if (tab === "channels") moveChannel(d)
    else if (tab === "inbox") stepIn(inbox(), evIndex(), d, (e) => state.setSelectedEvent(e.seq))
    else if (tab === "outbox") stepIn(outbox(), msgIndex(), d, (m) => state.setSelectedMessage(m.id))
    else move(d)
  }
  const toggleTab = (tab: Exclude<Tab, "jobs">) => () => state.setTab(state.tab() === tab ? "jobs" : tab)

  const actions = {
    togglePause: withJob((j) =>
      update(j.id, (x) => {
        if (x.paused && !runnable(x)) {
          throw new Error("It has no channels and no schedule, so it would never run. Add channels from chat, or a schedule with s.")
        }
        x.paused = !x.paused
        // Resuming re-anchors to now, so a long pause doesn't fire a missed run right away.
        if (!x.paused) x.nextRunAt = nextRun(x.schedule, Date.now(), x.createdAt)
      }),
    ),
    runNow: withJob((j) => {
      const done = update(j.id, (x) => void (x.runRequestedAt = Date.now()))
      ctx.ui.toast.show({ message: `Queued “${j.name}” — fires on the automations plugin's next tick`, variant: "info" })
      return done
    }),
    editPrompt: nested(withJob(async (j) => {
      if (!editable(j)) return
      const v = await ctx.ui.dialog.prompt({ title: `Prompt · ${j.name}`, value: j.prompt })
      if (v?.trim()) await update(j.id, (x) => void (x.prompt = v.trim()))
    })),
    editSchedule: nested(withJob(async (j) => {
      if (!editable(j)) return
      const v = await ctx.ui.dialog.prompt({
        title: `Schedule · ${j.name}`,
        description: 'Cron ("0 9 * * 1-5", "@daily", optionally followed by a time zone), "every 15m", or an ISO date',
        value: j.schedule.kind === "cron" ? `${j.schedule.expr}${j.schedule.tz ? ` ${j.schedule.tz}` : ""}` : "",
      })
      if (!v?.trim()) return
      await update(j.id, (x) => {
        x.schedule = parseScheduleText(v)
        x.createdAt = Date.now()
        x.done = undefined
        x.nextRunAt = nextRun(x.schedule, Date.now(), x.createdAt)
      })
    })),
    pickModel: nested(withJob(async (j) => {
      if (!editable(j)) return
      const models = ctx.data.location.model.list(ctx.location) ?? []
      const choice = await ctx.ui.dialog.select<string>({
        title: `Model · ${j.name}`,
        placeholder: "Search models",
        current: j.model ?? "",
        options: [
          { title: "Agent / session default", value: "" },
          ...models.map((m) => ({ title: m.name, value: `${m.providerID}/${m.modelID}`, category: m.providerID })),
        ],
      })
      if (choice !== undefined) await update(j.id, (x) => void (x.model = choice || undefined))
    })),
    remove: nested(withJob(async (j) => {
      if (!editable(j)) return
      const ok = await ctx.ui.dialog.confirm({ title: "Delete automation", message: `Delete “${j.name}”? Its history is kept.` })
      if (ok) await toastErr(state.act((jobs) => {
        // Already gone (deleted from chat or another TUI): splice(-1) would remove another automation.
        const i = jobs.findIndex((x) => x.id === j.id)
        if (i >= 0) jobs.splice(i, 1)
      }))
    })),
    openSession: withJob((j) => {
      const sid = jobRuns().find((r) => r.sessionID)?.sessionID ?? j.sessionID
      if (!sid) return toastErr("No session yet — this job hasn't run.")
      ctx.ui.dialog.clear()
      if (!ctx.ui.tabs.focus(sid)) ctx.ui.router.navigate({ type: "session", sessionID: sid })
    }),
    create: nested(async () => {
      const name = await ctx.ui.dialog.prompt({ title: "New automation", placeholder: "Name, e.g. Morning MR triage" })
      if (!name?.trim()) return
      const prompt = await ctx.ui.dialog.prompt({
        title: "Prompt",
        description: "Make it self-contained: new sessions start with no context.",
        placeholder: "List open merge requests where I'm reviewer…",
      })
      if (!prompt?.trim()) return
      const when = await ctx.ui.dialog.prompt({
        title: "When",
        description: 'Cron ("45 8 * * 1-5 Europe/Paris", "@daily"), "every 30m", or an ISO date for a one-shot',
      })
      if (!when?.trim()) return
      let schedule
      try {
        schedule = parseScheduleText(when)
      } catch (e) {
        return toastErr(errorMessage(e))
      }
      const session = await ctx.ui.dialog.select<SessionMode>({
        title: "Session",
        options: [
          { title: "New session per run", value: "new", description: "Reports, checks, anything stateless" },
          { title: "Sticky session", value: "sticky", description: "Every run goes to the same session; accumulates context" },
        ],
      })
      if (!session) return
      const directory = ctx.location?.directory ?? process.cwd()
      await toastErr(
        state.act((jobs) => {
          jobs.push(newJob(jobs, { name: name.trim(), prompt: prompt.trim(), schedule, directory, session, timeoutMinutes: DEFAULT_TIMEOUT_MINUTES }))
        }),
      )
    }),
  }

  // Dialogs run in opencode's "modal" input mode; the dialog itself handles esc.
  ctx.keymap.layer(() => ({
    mode: "modal",
    commands: [
      { title: "up", bind: "up", run: () => step(-1) },
      { title: "down", bind: "down", run: () => step(1) },
      { bind: "k", run: () => step(-1) },
      { bind: "j", run: () => step(1) },
      { title: "channels/automations", bind: "c", run: toggleTab("channels") },
      { title: "inbox/automations", bind: "i", run: toggleTab("inbox") },
      { title: "outbox/automations", bind: "o", run: toggleTab("outbox") },
      { title: "pause/resume", bind: "space", run: jobsOnly(actions.togglePause) },
      { title: "run now", bind: "r", run: jobsOnly(actions.runNow) },
      { title: "poll now", bind: "p", run: channelsOnly(channelActions.poll) },
      { title: "new", bind: "n", run: jobsOnly(actions.create) },
      { title: "prompt", bind: "e", run: jobsOnly(actions.editPrompt) },
      { title: "schedule", bind: "s", run: jobsOnly(actions.editSchedule) },
      { title: "model", bind: "m", run: jobsOnly(actions.pickModel) },
      { title: "delete", bind: "d", run: () => (onChannels() ? channelActions.remove() : onJobs() ? actions.remove() : undefined) },
      { title: "open session", bind: "return", run: jobsOnly(actions.openSession) },
    ],
  }))

  const L = createMemo(() => look(ctx, "dialog"))
  const statusLook = (st: "failing" | "polling" | "idle") =>
    ({
      failing: { fg: L().bad, bg: t.background.feedback.error.base, dot: "✗" },
      polling: { fg: L().ok, bg: t.background.feedback.success.base, dot: "●" },
      idle: { fg: L().muted, bg: L().cap, dot: "○" },
    })[st]
  /** An inbox event's overall fate: waiting if any automation still waits for it. */
  const fate = (e: InboxEntry): DeliveryStatus | "unclaimed" =>
    e.deliveries.some((d) => d.status === "waiting") ? "waiting"
      : e.deliveries.some((d) => d.status === "dropped") ? "dropped"
      : e.deliveries.length ? "taken" : "unclaimed"
  const fateLook = (f: DeliveryStatus | "unclaimed") =>
    ({
      waiting: { fg: L().warn, dot: "◐" },
      taken: { fg: L().ok, dot: "✓" },
      dropped: { fg: L().bad, dot: "✗" },
      unclaimed: { fg: L().muted, dot: "○" },
    })[f]
  /** A message's overall delivery: failed if any destination failed, pending while any is still trying. */
  const sendState = (m: SentMessage): SendStatus | "none" =>
    m.sends.some((x) => x.status === "failed") ? "failed"
      : m.sends.some((x) => x.status === "pending") ? "pending"
      : m.sends.length ? "sent" : "none"
  const sendLook = (st: SendStatus | "none") =>
    ({
      sent: { fg: L().ok, dot: "✓" },
      pending: { fg: L().warn, dot: "◐" },
      failed: { fg: L().bad, dot: "✗" },
      none: { fg: L().muted, dot: "○" },
    })[st]
  const inboxWaiting = createMemo(() => inbox().filter((e) => fate(e) === "waiting").length)
  const outboxFailed = createMemo(() => outbox().filter((m) => sendState(m) === "failed").length)
  const statusColor = (s?: RunStatus) =>
    s === "succeeded" ? L().ok : s === "running" ? L().warn : s === "skipped" || !s ? L().muted : L().bad
  const badge = (j: Job) => {
    const s = stateOf(j)
    const kind = s === "active" ? "success" : s === "paused" ? "warning" : s === "done" ? "info" : undefined
    return {
      label: ` ${s} `,
      fg: kind ? t.text.feedback[kind].base : L().muted,
      bg: kind ? t.background.feedback[kind].base : L().cap,
    }
  }
  // opencode dialogs have fixed widths (xlarge = 116 cols). To cover 80% of the terminal instead, the
  // view leaves an empty anchor in the dialog and draws an absolute panel positioned from it. The
  // anchor's screen position is only final at paint time, so it is read there and corrected next frame.
  const [origin, setOrigin] = createSignal<{ x: number; y: number; w: number; h: number }>()
  function track(this: Renderable) {
    const next = { x: this.screenX, y: this.screenY, w: ctx.renderer.width, h: ctx.renderer.height }
    const o = origin()
    if (!o || o.x !== next.x || o.y !== next.y || o.w !== next.w || o.h !== next.h) setOrigin(next)
  }
  const panel = createMemo(() => {
    const o = origin()
    if (!o) return
    const width = Math.round(o.w * 0.8)
    const height = Math.round(o.h * 0.8)
    return { left: Math.floor((o.w - width) / 2) - o.x, top: Math.floor((o.h - height) / 2) - o.y, width, height }
  })
  const activeCount = createMemo(() => state.jobs().filter(isActive).length)
  // Long lists show the rows around the cursor that fit: the panel less its header, the list's title and the hints.
  // Rows are slots (<Index>): a slot's position in the list is its slot number plus the window's start, read reactively.
  const fits = createMemo(() => Math.max(5, (panel()?.height ?? 30) - 10))
  const windowStart = (length: number, i: number) => Math.max(0, Math.min(length - fits(), i - Math.floor(fits() / 2)))
  const evStart = createMemo(() => windowStart(inbox().length, evIndex()))
  const msgStart = createMemo(() => windowStart(outbox().length, msgIndex()))

  const Heading = (p: { title: string; hue: number }) => (
    <text fg={L().ink(p.hue)}>
      <b>{p.title.toUpperCase()}</b>
    </text>
  )
  const Block = (p: { title: string; hue: number; children: JSX.Element }) => (
    <box flexDirection="column" backgroundColor={L().tint(p.hue)} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1}>
      <Heading title={p.title} hue={p.hue} />
      {p.children}
    </box>
  )
  /** One line of the jobs or channels list: status dot, name, and when it next happens. */
  const Row = (p: { selected: boolean; dot: string; dotFg: RGBA; name: string; when: string }) => {
    const fg = () => (p.selected ? t.text.action.primary.focused : undefined)
    return (
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={p.selected ? t.background.action.primary.focused : undefined}
      >
        {/* The dot is its own <text>: opencode doesn't repaint a <span> whose color changes but whose
            text doesn't, which left the green dot on the previously selected row. */}
        <box flexDirection="row" gap={1}>
          <text fg={p.dotFg}>{p.dot}</text>
          <text fg={fg() ?? L().text}>{p.name.slice(0, 22)}</text>
        </box>
        <text fg={fg() ?? L().muted}>{p.when}</text>
      </box>
    )
  }
  const Field = (p: { label: string; value: string; fg?: RGBA }) => (
    <text>
      <span style={{ fg: L().muted }}>{p.label.padEnd(11)}</span>
      <span style={{ fg: p.fg ?? L().text }}>{p.value}</span>
    </text>
  )

  return (
    <box renderBefore={track}>
      <Show when={panel()}>
        {(p) => (
          <box
            position="absolute"
            zIndex={10}
            left={p().left}
            top={p().top}
            width={p().width}
            height={p().height}
            backgroundColor={t.background.base}
            flexDirection="column"
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
          >
            <box flexDirection="row" justifyContent="space-between" paddingBottom={1} flexShrink={0}>
              <box flexDirection="row" gap={2}>
                <text fg={L().text}>
                  <b>⏰ Automations</b>
                </text>
                {/* Tabs as separate <text>s so a color change repaints (see the dot below). */}
                <For each={["jobs", "channels", "inbox", "outbox"] as Tab[]}>
                  {(tab) => (
                    <text fg={state.tab() === tab ? L().ink(0) : L().muted}>{state.tab() === tab ? `[${tab}]` : ` ${tab} `}</text>
                  )}
                </For>
              </box>
              <Switch
                fallback={
                  <text fg={L().muted}>
                    {plural(state.jobs().length, "job")} · {activeCount()} active ·{" "}
                    <span style={{ fg: running().size ? L().warn : L().muted }}>{running().size} running</span>
                  </text>
                }
              >
                <Match when={state.tab() === "inbox"}>
                  <text fg={L().muted}>
                    {inbox().length >= LIST_LIMIT ? `latest ${LIST_LIMIT}` : plural(inbox().length, "event")} ·{" "}
                    <span style={{ fg: L().warn }}>{inboxWaiting()} waiting</span>
                  </text>
                </Match>
                <Match when={state.tab() === "outbox"}>
                  <text fg={L().muted}>
                    {outbox().length >= LIST_LIMIT ? `latest ${LIST_LIMIT}` : plural(outbox().length, "message")} ·{" "}
                    <span style={{ fg: outboxFailed() ? L().bad : L().muted }}>
                      {outboxFailed()} failed
                    </span>
                  </text>
                </Match>
                <Match when={onChannels()}>
                <text fg={L().muted}>
                  {plural(chRows().length, "channel")} ·{" "}
                  {chRows().filter((c) => chStatus(c) !== "idle").length} polled ·{" "}
                  <span style={{ fg: chRows().some((c) => chStatus(c) === "failing") ? L().bad : L().muted }}>
                    {chRows().filter((c) => chStatus(c) === "failing").length} failing
                  </span>
                </text>
                </Match>
              </Switch>
            </box>

            <Show when={onChannels()}>
              <Show
                when={chRows().length}
                fallback={
                  <box backgroundColor={L().panel} padding={2} flexDirection="column" gap={1}>
                    <text fg={L().text}>No channels yet.</text>
                    <text fg={L().muted}>Ask in chat: “/channel alert me about Datadog monitors that start alerting”.</text>
                  </box>
                }
              >
                <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} minHeight={0} gap={2}>
                  <box flexDirection="column" width={38} backgroundColor={L().panel} paddingTop={1} paddingBottom={1}>
                    <box paddingLeft={2} paddingBottom={1}>
                      <text fg={L().muted}>
                        <b>CHANNELS</b>
                      </text>
                    </box>
                    {/* Index, not For: rows are rebuilt on each refresh, and Index keeps the row components. */}
                    <Index each={chRows()}>
                      {(c, i) => {
                        const isSel = () => i === chIndex()
                        const status = () => chStatus(c())
                        const src = () => state.channels().sources[c().id]
                        const when = () => (status() === "idle" ? "idle" : src()?.lastPollAt ? relative(src()!.lastPollAt, state.now()) : "soon")
                        return <Row selected={isSel()} dot={statusLook(status()).dot} dotFg={statusLook(status()).fg} name={c().name} when={when()} />
                      }}
                    </Index>
                  </box>

                  <Show when={chSelected()}>
                    {(c) => {
                      const src = () => state.channels().sources[c().id]
                      const users = () => listeners(c().id)
                      const count = (id: string) => state.waiting().counts.get(id)?.get(c().id) ?? 0
                      const first = (id: string) => (state.waiting().first.get(id) ?? []).filter((e) => e.channel === c().id).slice(0, 3)
                      const status = () => chStatus(c())
                      return (
                        <scrollbox flexGrow={1} minHeight={0}>
                          <box flexDirection="column" gap={1}>
                            <Block title="Channel" hue={0}>
                              <text>
                                <span style={{ fg: L().text }}>
                                  <b>{c().name}</b>
                                </span>
                                {"  "}
                                <span
                                  style={{ fg: statusLook(status()).fg, bg: statusLook(status()).bg }}
                                >
                                  {` ${status()} `}
                                </span>
                                <span style={{ fg: L().muted }}>
                                  {"  "}
                                  {c().id} · {c().source === "config" ? "from config" : "created from chat"}
                                </span>
                              </text>
                              <box flexDirection="column">
                                <Field label="polls" value={c().url} />
                                <Field label="every" value={describe({ kind: "every", ms: c().everyMs || 60_000 }).replace(/^every /, "")} />
                                <Field label="last poll" value={src()?.lastPollAt ? `${clock(src()!.lastPollAt)}  (${relative(src()!.lastPollAt, state.now())})` : "never"} />
                                <Field label="last ok" value={src()?.lastOkAt ? clock(src()!.lastOkAt) : "never"} />
                                <Show when={src()?.lastError}>
                                  {(err) => <Field label="error" value={`${err()}  (${src()!.failures}× in a row)`} fg={L().bad} />}
                                </Show>
                                <Field label="env" value={c().env.length ? c().env.join(", ") : "none"} />
                              </box>
                            </Block>

                            <Block title="Mapping" hue={1}>
                              <box flexDirection="column">
                                <Field label="items" value={c().items || "(the response)"} />
                                <Field label="filter" value={Object.keys(c().filter).length ? JSON.stringify(c().filter) : "none"} />
                                <Field label="event id" value={c().event.id} />
                                <Field label="sessionKey" value={c().event.sessionKey ?? "none"} />
                                <Field label="title" value={c().event.title ?? "(event id)"} />
                                <Show when={c().event.body}>{(b) => <Field label="body" value={b()} />}</Show>
                                <Show when={c().event.url}>{(u) => <Field label="url" value={u()} />}</Show>
                              </box>
                            </Block>

                            <Block title="Automations" hue={2}>
                              <Show when={users().length} fallback={<text fg={L().muted}>none use it, so it isn't polled</text>}>
                                <box flexDirection="column" gap={1}>
                                  <For each={users()}>
                                    {(j) => (
                                      <box flexDirection="column">
                                        <text fg={L().text}>
                                          <span style={{ fg: isActive(j) ? L().ok : L().muted }}>{isActive(j) ? "●" : "○"}</span> {j.name}
                                          <span style={{ fg: L().muted }}>
                                            {"  "}
                                            {j.schedule.kind === "event" ? "as events arrive" : describe(j.schedule)} · {count(j.id)} waiting
                                          </span>
                                        </text>
                                        <For each={first(j.id)}>
                                          {(e) => <text fg={L().muted}>{"  " + e.title.slice(0, 90)}</text>}
                                        </For>
                                      </box>
                                    )}
                                  </For>
                                </box>
                              </Show>
                            </Block>
                          </box>
                        </scrollbox>
                      )
                    }}
                  </Show>
                </box>
              </Show>
            </Show>


            <Show when={state.tab() === "inbox"}>
              <Show
                when={inbox().length}
                fallback={
                  <box backgroundColor={L().panel} padding={2} flexDirection="column" gap={1}>
                    <text fg={L().text}>The inbox is empty.</text>
                    <text fg={L().muted}>Channels write the events they poll here, for the automations attached to them.</text>
                  </box>
                }
              >
                <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} minHeight={0} gap={2}>
                  <box flexDirection="column" width={38} backgroundColor={L().panel} paddingTop={1} paddingBottom={1}>
                    <box paddingLeft={2} paddingBottom={1}>
                      <text fg={L().muted}>
                        <b>INBOX</b>
                      </text>
                    </box>
                    <Index each={inbox().slice(evStart(), evStart() + fits())}>
                      {(e, slot) => {
                        const look = () => fateLook(fate(e()))
                        return <Row selected={slot + evStart() === evIndex()} dot={look().dot} dotFg={look().fg} name={e().title} when={relative(e().at, state.now())} />
                      }}
                    </Index>
                  </box>

                  <Show when={evSelected()}>
                    {(e) => (
                      <scrollbox flexGrow={1} minHeight={0}>
                        <box flexDirection="column" gap={1}>
                          <Block title="Event" hue={0}>
                            <text fg={L().text}>
                              <b>{e().title}</b>
                            </text>
                            <box flexDirection="column">
                              <Field label="channel" value={state.channels().defs[e().channel]?.name ?? state.channels().config[e().channel]?.name ?? e().channel} />
                              <Field label="id" value={e().id} />
                              <Show when={e().sessionKey}>{(k) => <Field label="sessionKey" value={k()} />}</Show>
                              <Field label="first seen" value={`${clock(e().at)}  (${relative(e().at, state.now())})`} />
                              <Field label="last seen" value={`${clock(e().seenAt)}  (${relative(e().seenAt, state.now())})`} />
                              <Show when={e().url}>{(u) => <Field label="url" value={u()} />}</Show>
                            </box>
                          </Block>

                          <Show when={e().body}>
                            {(b) => (
                              <Block title="Body" hue={1}>
                                <text fg={L().text}>{b()}</text>
                              </Block>
                            )}
                          </Show>

                          <Block title="Automations" hue={2}>
                            <Show when={e().deliveries.length} fallback={<text fg={L().muted}>none took it or waits for it</text>}>
                              <box flexDirection="column">
                                <For each={e().deliveries}>
                                  {(d) => (
                                    <text fg={L().text}>
                                      <span style={{ fg: fateLook(d.status).fg }}>{fateLook(d.status).dot}</span> {jobName(d.job)}
                                      <span style={{ fg: L().muted }}>
                                        {"  "}
                                        {d.status}
                                        {d.status === "waiting" && state.jobs().find((j) => j.id === d.job)?.paused ? " · paused, so it runs once resumed" : ""}
                                      </span>
                                    </text>
                                  )}
                                </For>
                              </box>
                            </Show>
                          </Block>
                        </box>
                      </scrollbox>
                    )}
                  </Show>
                </box>
              </Show>
            </Show>

            <Show when={state.tab() === "outbox"}>
              <Show
                when={outbox().length}
                fallback={
                  <box backgroundColor={L().panel} padding={2} flexDirection="column" gap={1}>
                    <text fg={L().text}>Nothing has been sent yet.</text>
                    <text fg={L().muted}>What automations notify you of is kept here, with how each destination took it.</text>
                  </box>
                }
              >
                <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} minHeight={0} gap={2}>
                  <box flexDirection="column" width={38} backgroundColor={L().panel} paddingTop={1} paddingBottom={1}>
                    <box paddingLeft={2} paddingBottom={1}>
                      <text fg={L().muted}>
                        <b>OUTBOX</b>
                      </text>
                    </box>
                    <Index each={outbox().slice(msgStart(), msgStart() + fits())}>
                      {(m, slot) => {
                        const look = () => sendLook(sendState(m()))
                        return <Row selected={slot + msgStart() === msgIndex()} dot={look().dot} dotFg={look().fg} name={m().title} when={relative(m().at, state.now())} />
                      }}
                    </Index>
                  </box>

                  <Show when={msgSelected()}>
                    {(m) => (
                      <scrollbox flexGrow={1} minHeight={0}>
                        <box flexDirection="column" gap={1}>
                          <Block title="Message" hue={0}>
                            <text fg={L().text}>
                              <b>{m().title}</b>
                            </text>
                            <box flexDirection="column">
                              <Field label="from" value={jobName(m().job)} />
                              <Field label="sent" value={`${clock(m().at)}  (${relative(m().at, state.now())})`} />
                              <Field label="priority" value={m().priority} />
                              <Show when={m().url}>{(u) => <Field label="url" value={m().urlTitle ? `${m().urlTitle}  ${u()}` : u()} />}</Show>
                              <Show when={m().run}>{(r) => <Field label="run" value={r()} />}</Show>
                            </box>
                          </Block>

                          <Block title="Body" hue={1}>
                            <text fg={L().text}>{m().body}</text>
                          </Block>

                          <Block title="Destinations" hue={3}>
                            <Show when={m().sends.length} fallback={<text fg={L().muted}>no destination takes it</text>}>
                              <box flexDirection="column">
                                <For each={m().sends}>
                                  {(x) => (
                                    <box flexDirection="column">
                                      <text fg={L().text}>
                                        <span style={{ fg: sendLook(x.status).fg }}>{sendLook(x.status).dot}</span> {x.destination}
                                        <span style={{ fg: L().muted }}>{"  "}{x.status}</span>
                                      </text>
                                      <Show when={x.error}>{(err) => <text fg={L().bad}>{"  " + err()}</text>}</Show>
                                    </box>
                                  )}
                                </For>
                              </box>
                            </Show>
                          </Block>
                        </box>
                      </scrollbox>
                    )}
                  </Show>
                </box>
              </Show>
            </Show>

            <Show when={onJobs()}>
            <Show
              when={sorted().length}
              fallback={
                <box backgroundColor={L().panel} padding={2} flexDirection="column" gap={1}>
                  <text fg={L().text}>No automations yet.</text>
                  <text fg={L().muted}>Press n to create one, or ask in chat: “every weekday at 8:45, triage my open MRs”.</text>
                </box>
              }
            >
              {/* flexBasis/minHeight 0: a tall detail pane scrolls instead of squeezing the header and hints. */}
              <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} minHeight={0} gap={2}>
                <box flexDirection="column" width={38} backgroundColor={L().panel} paddingTop={1} paddingBottom={1}>
                  <box paddingLeft={2} paddingBottom={1}>
                    <text fg={L().muted}>
                      <b>JOBS</b>
                    </text>
                  </box>
                  <For each={sorted()}>
                    {(j, i) => {
                      const isSel = () => i() === index()
                      const dot = () => (running().has(j.id) ? "◐" : isActive(j) ? "●" : "○")
                      const when = () => (running().has(j.id) ? "running" : isActive(j) ? relative(j.nextRunAt, state.now()) : stateOf(j))
                      const dotFg = () => (isSel() ? L().ok : running().has(j.id) ? L().warn : L().muted)
                      return <Row selected={isSel()} dot={dot()} dotFg={dotFg()} name={j.name} when={when()} />
                    }}
                  </For>
                </box>

                <Show when={selected()}>
                  {(j) => (
                    <scrollbox flexGrow={1} minHeight={0}>
                      <box flexDirection="column" gap={1}>
                        <Block title="Details" hue={0}>
                          <text>
                            <span style={{ fg: L().text }}>
                              <b>{j().name}</b>
                            </span>
                            {"  "}
                            <span style={{ fg: badge(j()).fg, bg: badge(j()).bg }}>{badge(j()).label}</span>
                            <span style={{ fg: L().muted }}>
                              {"  "}
                              {j().id}
                              {j().source === "config" ? " · from config" : ""}
                            </span>
                          </text>
                          <box flexDirection="column">
                            <Field label="schedule" value={describe(j().schedule)} />
                            <Show when={j().on}>{(on) => <Field label="channels" value={on().channels.join(", ")} />}</Show>
                            <Field label="next" value={isActive(j()) ? `${clock(j().nextRunAt)}  (${relative(j().nextRunAt, state.now())})` : "—"} />
                            <Field
                              label="last"
                              value={j().lastRunAt ? `${clock(j().lastRunAt)}  ${j().lastStatus ?? ""}` : "never"}
                              fg={j().lastStatus ? statusColor(j().lastStatus as RunStatus) : undefined}
                            />
                            <Field label="session" value={j().session + (j().sessionID ? `  ${j().sessionID}` : "")} />
                            <Field label="agent" value={j().agent ?? "default"} />
                            <Field label="model" value={j().session === "current" ? "chat's model" : (j().model ?? "agent default")} />
                            <Field label="directory" value={ctx.ui.format.path(j().directory)} />
                            <Field label="timeout" value={`${j().timeoutMinutes}m · run missed ${j().runMissed ? "on" : "off"}`} />
                          </box>
                        </Block>

                        <Block title="Prompt" hue={1}>
                          <text fg={L().text}>{j().prompt}</text>
                        </Block>

                        <Show when={jobSent().length}>
                          <Block title="Notified" hue={3}>
                            <box flexDirection="column">
                              <For each={jobSent()}>
                                {(m) => (
                                  <text fg={L().text}>
                                    {clock(m.at)} {m.title.slice(0, 60)}
                                    <span style={{ fg: m.sends.some((x) => x.status === "failed") ? L().bad : L().muted }}>
                                      {"  "}
                                      {m.sends.map((x) => `${x.destination} ${x.status}`).join(", ") || "no destination takes it"}
                                    </span>
                                  </text>
                                )}
                              </For>
                            </box>
                          </Block>
                        </Show>

                        <Show when={jobNotes().length}>
                          <Block title="Memory" hue={4}>
                            <box flexDirection="column" gap={1}>
                              <For each={jobNotes()}>
                                {(n) => (
                                  <box flexDirection="column">
                                    <text fg={L().muted}>
                                      {n.key ? `${n.key} · ` : ""}updated {clock(n.updatedAt)} ({relative(n.updatedAt, state.now())})
                                    </text>
                                    <text fg={L().text}>{n.note}</text>
                                  </box>
                                )}
                              </For>
                            </box>
                          </Block>
                        </Show>

                        <Block title="Recent runs" hue={2}>
                          <Show when={jobRuns().length} fallback={<text fg={L().muted}>none yet</text>}>
                            <box flexDirection="column">
                              <For each={jobRuns()}>
                                {(r) => (
                                  <box flexDirection="column">
                                    <text fg={L().text}>
                                      <span style={{ fg: statusColor(r.status) }}>{glyph[r.status]}</span> {clock(r.startedAt)}
                                      <span style={{ fg: L().muted }}>
                                        {"  "}
                                        {r.status} {elapsed(r)}
                                      </span>
                                    </text>
                                    <Show when={r.error}>
                                      {(error) => <text fg={L().bad}>{"  " + error().slice(0, 100)}</text>}
                                    </Show>
                                  </box>
                                )}
                              </For>
                            </box>
                          </Show>
                        </Block>
                      </box>
                    </scrollbox>
                  )}
                </Show>
              </box>
            </Show>
            </Show>

            <box flexDirection="row" flexWrap="wrap" paddingTop={1} paddingBottom={1} columnGap={2} flexShrink={0}>
              <For each={[...tabHints(state.tab()), ...(onJobs() ? keyHints : onChannels() ? channelHints : listHints)]}>
                {([key, label]) => (
                  <text>
                    <span style={{ fg: L().text, bg: L().cap }}> {key} </span>
                    <span style={{ fg: L().muted }}> {label}</span>
                  </text>
                )}
              </For>
            </box>
          </box>
        )}
      </Show>
    </box>
  )
}

function SidebarSection(props: { ctx: Context; state: State; sessionID: string }) {
  const { ctx, state } = props
  const L = createMemo(() => look(ctx))
  const upcoming = createMemo(() =>
    state
      .jobs()
      .filter(isActive)
      .sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity))
      .slice(0, 4),
  )
  const thisRun = createMemo(() => state.runs().find((r) => r.sessionID === props.sessionID))
  return (
    <Show when={state.jobs().length || thisRun()}>
      <box flexDirection="column" marginTop={1} backgroundColor={L().panel} paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
        <text fg={L().ink(0)}>
          <b>⏰ Automations</b>
        </text>
        <Show when={thisRun()}>
          {(r) => (
            <text fg={L().info}>
              this session: {r().jobID} {glyph[r().status]}
            </text>
          )}
        </Show>
        <For each={upcoming()}>
          {(j) => (
            <box flexDirection="row" justifyContent="space-between">
              <text fg={L().text}>{j.name.slice(0, 18)}</text>
              <text fg={L().muted}>{relative(j.nextRunAt, state.now())}</text>
            </box>
          )}
        </For>
        <text fg={L().faint}>/automations</text>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "automations.tui",
  setup: (ctx) => {
    const dataDir = typeof ctx.options.dataDir === "string" ? ctx.options.dataDir : defaultDataDir()

    const state = createState(ctx, dataDir)

    // Re-read when another process commits; a slow tick moves "in 12m" labels on.
    let version = state.store.version()
    const watcher = setInterval(() => {
      try {
        const v = state.store.version()
        if (v !== version) { version = v; state.refresh() }
      } catch {}
    }, 500)
    const ticker = setInterval(state.tick, 15_000)

    // Shown as a dialog over the current screen rather than a routed page, which opencode puts in its own tab.
    const open = () => {
      ctx.ui.dialog.show(() => <AutomationsView ctx={ctx} state={state} reopen={open} />)
      ctx.ui.dialog.set({ size: "xlarge", centered: true })
    }

    const unregister = [
      ctx.ui.slot({ append: "sidebar.content", render: (input) => <SidebarSection ctx={ctx} state={state} sessionID={input.sessionID} /> }),
    ]

    // Register directly in setup: a detached Solid root masks the host's keymap provider.
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "automations.open",
          title: "Automations",
          description: "View and manage automations",
          group: "Automations",
          palette: true,
          slash: { name: "automations" },
          run: open,
        },
      ],
    }))

    return () => {
      clearInterval(watcher)
      clearInterval(ticker)
      state.store.close()
      for (const u of unregister) u()
    }
  },
})
