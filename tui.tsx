// opencode v2 TUI plugin for automations.
//
// Reads the same jobs.json / history.jsonl the server plugin writes, and writes *intents*
// back (pause, edit, delete, run-now). The server leader executes them on its next tick,
// so there is still exactly one firer and one run history.
//
//  - /automations (or the palette) opens a large dialog over the current screen: job list, full config, recent runs, actions.
//    `c` switches to the channels tab: each channel's poll status, mapping, and the automations it feeds.
//  - The session sidebar shows upcoming jobs, and flags sessions created by an automation run.
//  - Finished runs raise a toast, plus an OS notification when the terminal isn't focused.

import type { Renderable, RGBA } from "@opentui/core"
import { Plugin } from "@opencode/plugin/tui"
import { watch, type FSWatcher } from "node:fs"
import { createMemo, createSignal, For, Index, Show, type JSX } from "solid-js"
import { describe, nextRun } from "./cron.ts"
import { defaultDataDir, isActive, listens, mutateRaw, parseScheduleText, relative, runnable, uniqueID } from "./jobs.ts"
import { Store, type Job, type Run, type RunStatus, type SessionMode } from "./store.ts"
import { emptyChannels, removeChannel, requestPoll, summarize, type ChannelEvent, type ChannelsState, type ChannelSummary } from "./channels.ts"

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
    /** Neutral raised block (list, sidebar). */
    panel: t.background.raised.base,
    /** Slightly higher block, for key caps. */
    cap: t.background.raised.high,
    /** Softly tinted block background for section i. */
    tint: (i: number) => hue(i)[dark ? 900 : 100],
    /** Readable heading color on that tint. */
    ink: (i: number) => hue(i)[dark ? 300 : 700],
  }
}

const keyHints: [string, string][] = [
  ["c", "channels"],
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
  ["c", "automations"],
  ["↑↓", "select"],
  ["p", "poll now"],
  ["d", "delete"],
  ["esc", "close"],
]

export interface ChannelRow extends ChannelSummary {
  id: string
  source: "config" | "created"
}

/** Config channels (as the server published them) and channels created from chat, by ID. */
export function channelRows(s: ChannelsState): ChannelRow[] {
  const rows: ChannelRow[] = Object.entries(s.config).map(([id, sum]) => ({ id, source: "config", ...sum }))
  for (const [id, def] of Object.entries(s.defs)) {
    if (!s.config[id]) rows.push({ id, source: "created", ...summarize({ ...def, id }) })
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id))
}

/** The TUI waits only briefly for the channels lock (the server may hold it), so the screen never freezes for long. */
const LOCK_WAIT_MS = 200
const stateOf = (j: Job) => (j.done ? "done" : j.paused ? "paused" : !j.enabled ? "disabled" : "active")
const firstLine = (s?: string) => (s ?? "").split("\n").find((l) => l.trim()) ?? ""
const duration = (r: Run) => (r.endedAt ? `${Math.max(1, Math.round((r.endedAt - r.startedAt) / 1000))}s` : "")
const clock = (t?: number) =>
  t ? new Date(t).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"

export function createState(ctx: Context, dataDir: string) {
  const store = new Store(dataDir)
  const [jobs, setJobs] = createSignal<Job[]>(store.loadJobs())
  const [runs, setRuns] = createSignal<Run[]>(store.history(undefined, 300))
  const [now, setNow] = createSignal(Date.now())
  const loadChannels = () => { try { return store.loadChannels() } catch { return emptyChannels() } }
  const [channels, setChannels] = createSignal<ChannelsState>(loadChannels())
  // Kept here, not in the view: the dialog is re-created after nested prompts and must reopen on the same job and tab.
  const [selectedID, setSelectedID] = createSignal<string>()
  const [selectedChannel, setSelectedChannel] = createSignal<string>()
  const [tab, setTab] = createSignal<"jobs" | "channels">("jobs")

  const notifyMode = (ctx.options.notify ?? "blurred") as "always" | "blurred" | "off"
  const seen = new Set(runs().filter((r) => r.status !== "running").map((r) => r.runID))

  function refresh() {
    setJobs(store.loadJobs())
    setChannels(loadChannels())
    const next = store.history(undefined, 300)
    setRuns(next)
    setNow(Date.now())
    for (const r of next) {
      if (r.status === "running" || seen.has(r.runID)) continue
      seen.add(r.runID)
      if (r.status === "skipped") continue
      const job = jobs().find((j) => j.id === r.jobID)
      const title = `⏰ ${job?.name ?? r.jobID} ${r.status}`
      const message = r.error ?? (firstLine(r.output).slice(0, 140) || duration(r))
      ctx.ui.toast.show({ title, message, variant: r.status === "succeeded" ? "success" : "error", duration: 6000 })
      if (notifyMode !== "off") {
        void ctx.attention
          .notify({ title, message, notification: { when: notifyMode === "always" ? "always" : "blurred" }, sound: false })
          .catch(() => {})
      }
    }
  }

  /** Write an intent and re-read. Resolves to an error message instead of throwing (callers toast it). */
  async function act(fn: (jobs: Job[]) => void | Promise<void>): Promise<string | undefined> {
    try {
      await mutateRaw(store, fn)
      refresh()
    } catch (e) {
      return (e as Error).message
    }
  }

  /** Write channel state (a poll intent, a delete) and re-read. Resolves to an error message instead of throwing. */
  async function actChannels(fn: (s: ChannelsState) => void): Promise<string | undefined> {
    try {
      await store.mutateChannels(fn, LOCK_WAIT_MS)
      refresh()
    } catch (e) {
      return (e as Error).message
    }
  }

  return { store, jobs, runs, now, refresh, act, selectedID, setSelectedID, channels, actChannels, selectedChannel, setSelectedChannel, tab, setTab }
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

  // ---- channels tab ----
  const onChannels = () => state.tab() === "channels"
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
  const running = createMemo(() => new Set(state.runs().filter((r) => r.status === "running").map((r) => r.jobID)))

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
      // Checked again under the jobs lock: this list may be up to 15 s old, and chat may have attached it since.
      await toastErr(state.act(async (jobs) => {
        const now = jobs.filter((j) => listens(j, c.id))
        if (now.length) throw new Error(`Used by ${now.map((j) => j.name).join(", ")} now. Detach it from chat: channel_delete with detach.`)
        await state.store.mutateChannels((s) => removeChannel(s, c.id), LOCK_WAIT_MS)
      }))
    }),
  }
  /** Keys that only mean something on one tab. */
  const jobsOnly = (fn: () => unknown) => () => (onChannels() ? undefined : fn())
  const channelsOnly = (fn: () => unknown) => () => (onChannels() ? fn() : undefined)
  const step = (d: number) => (onChannels() ? moveChannel(d) : move(d))

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
      if (ok) await toastErr(state.act((jobs) => void jobs.splice(jobs.findIndex((x) => x.id === j.id), 1)))
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
        return toastErr((e as Error).message)
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
          const now = Date.now()
          jobs.push({
            id: uniqueID(jobs, name),
            name: name.trim(),
            prompt: prompt.trim(),
            schedule,
            directory,
            session,
            timeoutMinutes: 30,
            runMissed: true,
            enabled: true,
            source: "tool",
            createdAt: now,
            nextRunAt: nextRun(schedule, now, now),
          })
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
      { title: "channels/automations", bind: "c", run: () => state.setTab(onChannels() ? "jobs" : "channels") },
      { title: "pause/resume", bind: "space", run: jobsOnly(actions.togglePause) },
      { title: "run now", bind: "r", run: jobsOnly(actions.runNow) },
      { title: "poll now", bind: "p", run: channelsOnly(channelActions.poll) },
      { title: "new", bind: "n", run: jobsOnly(actions.create) },
      { title: "prompt", bind: "e", run: jobsOnly(actions.editPrompt) },
      { title: "schedule", bind: "s", run: jobsOnly(actions.editSchedule) },
      { title: "model", bind: "m", run: jobsOnly(actions.pickModel) },
      { title: "delete", bind: "d", run: () => (onChannels() ? channelActions.remove() : actions.remove()) },
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
                <text fg={onChannels() ? L().muted : L().ink(0)}>{onChannels() ? " jobs " : "[jobs]"}</text>
                <text fg={onChannels() ? L().ink(0) : L().muted}>{onChannels() ? "[channels]" : " channels "}</text>
              </box>
              <Show
                when={onChannels()}
                fallback={
                  <text fg={L().muted}>
                    {state.jobs().length} {state.jobs().length === 1 ? "job" : "jobs"} · {activeCount()} active ·{" "}
                    <span style={{ fg: running().size ? L().warn : L().muted }}>{running().size} running</span>
                  </text>
                }
              >
                <text fg={L().muted}>
                  {chRows().length} {chRows().length === 1 ? "channel" : "channels"} ·{" "}
                  {chRows().filter((c) => chStatus(c) !== "idle").length} polled ·{" "}
                  <span style={{ fg: chRows().some((c) => chStatus(c) === "failing") ? L().bad : L().muted }}>
                    {chRows().filter((c) => chStatus(c) === "failing").length} failing
                  </span>
                </text>
              </Show>
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
                        const fg = () => (isSel() ? t.text.action.primary.focused : undefined)
                        return (
                          <box
                            flexDirection="row"
                            justifyContent="space-between"
                            paddingLeft={2}
                            paddingRight={2}
                            backgroundColor={isSel() ? t.background.action.primary.focused : undefined}
                          >
                            <box flexDirection="row" gap={1}>
                              <text fg={statusLook(status()).fg}>{statusLook(status()).dot}</text>
                              <text fg={fg() ?? L().text}>{c().name.slice(0, 22)}</text>
                            </box>
                            <text fg={fg() ?? L().muted}>{when()}</text>
                          </box>
                        )
                      }}
                    </Index>
                  </box>

                  <Show when={chSelected()}>
                    {(c) => {
                      const src = () => state.channels().sources[c().id]
                      const users = () => listeners(c().id)
                      // Each listener's waiting events from this channel, filtered once per refresh.
                      const waiting = createMemo(() => {
                        const out = new Map<string, ChannelEvent[]>()
                        for (const j of users()) out.set(j.id, state.channels().queues[j.id]?.pending.filter((e) => e.channel === c().id) ?? [])
                        return out
                      })
                      const queue = (id: string) => waiting().get(id) ?? []
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
                                            {j.schedule.kind === "event" ? "as events arrive" : describe(j.schedule)} · {queue(j.id).length} waiting
                                          </span>
                                        </text>
                                        <For each={queue(j.id).slice(0, 3)}>
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

            <Show when={!onChannels()}>
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
                {/* list */}
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
                      const fg = () => (isSel() ? t.text.action.primary.focused : undefined)
                      return (
                        <box
                          flexDirection="row"
                          justifyContent="space-between"
                          paddingLeft={2}
                          paddingRight={2}
                          backgroundColor={isSel() ? t.background.action.primary.focused : undefined}
                        >
                          {/* The dot is its own <text>: opencode doesn't repaint a <span> whose color changes but whose
                              text doesn't, which left the green dot on the previously selected row. */}
                          <box flexDirection="row" gap={1}>
                            <text fg={isSel() ? L().ok : running().has(j.id) ? L().warn : L().muted}>{dot()}</text>
                            <text fg={fg() ?? L().text}>{j.name.slice(0, 22)}</text>
                          </box>
                          <text fg={fg() ?? L().muted}>{when()}</text>
                        </box>
                      )
                    }}
                  </For>
                </box>

                {/* detail */}
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
                                        {r.status} {duration(r)}
                                      </span>
                                    </text>
                                    <Show when={r.error ?? firstLine(r.output)}>
                                      {(line) => <text fg={r.error ? L().bad : L().muted}>{"  " + line().slice(0, 100)}</text>}
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
              <For each={onChannels() ? channelHints : keyHints}>
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

    // Live updates: atomic renames + appends in the data dir, plus a slow tick for "in 12m" labels.
    let debounce: ReturnType<typeof setTimeout> | undefined
    let watcher: FSWatcher | undefined
    try {
      watcher = watch(dataDir, (_event, file) => {
        // Lock directories and temp files come and go around every write; the rename that follows is what counts.
        if (file && /\.(lock|tmp)$/.test(String(file))) return
        clearTimeout(debounce)
        debounce = setTimeout(state.refresh, 150)
      })
    } catch {}
    const ticker = setInterval(state.refresh, 15_000)

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
      watcher?.close()
      clearTimeout(debounce)
      clearInterval(ticker)
      for (const u of unregister) u()
    }
  },
})
