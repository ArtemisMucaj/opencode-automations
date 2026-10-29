// opencode v2 TUI plugin for automations.
//
// Reads the same jobs.json / history.jsonl the server plugin writes, and writes *intents*
// back (pause, edit, delete, run-now). The server leader executes them on its next tick,
// so there is still exactly one firer and one run history.
//
//  - /automations (or the palette) opens a page: job list, full config, recent runs, actions.
//  - The session sidebar shows upcoming jobs, and flags sessions created by an automation run.
//  - Finished runs raise a toast, plus an OS notification when the terminal isn't focused.

import { Plugin } from "@opencode/plugin/tui"
import { watch, type FSWatcher } from "node:fs"
import { createMemo, createSignal, For, Show } from "solid-js"
import { describe, nextRun } from "./cron.ts"
import { defaultDataDir, isActive, mutateRaw, parseScheduleText, relative, uniqueID } from "./jobs.ts"
import { Store, type Job, type Run, type RunStatus, type SessionMode } from "./store.ts"

type Context = Plugin.Context

const PAGE = "automations"

const glyph: Record<RunStatus, string> = { running: "◐", succeeded: "✓", failed: "✗", timeout: "⧗", skipped: "↷" }
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

  const notifyMode = (ctx.options.notify ?? "blurred") as "always" | "blurred" | "off"
  const seen = new Set(runs().filter((r) => r.status !== "running").map((r) => r.runID))

  function refresh() {
    setJobs(store.loadJobs())
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

  /** Write an intent and re-read. Returns an error message instead of throwing (callers toast it). */
  function act(fn: (jobs: Job[]) => void): string | undefined {
    try {
      mutateRaw(store, fn)
      refresh()
    } catch (e) {
      return (e as Error).message
    }
  }

  return { store, jobs, runs, now, refresh, act }
}

type State = ReturnType<typeof createState>

function AutomationsPage(props: { ctx: Context; state: State }) {
  const { ctx, state } = props
  const t = ctx.theme
  const sorted = createMemo(() =>
    [...state.jobs()].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)),
  )
  // Selection follows the job, not the row: pausing re-sorts the list and must not move the cursor to another job.
  const [selectedID, setSelectedID] = createSignal<string>()
  const index = createMemo(() => Math.max(0, sorted().findIndex((j) => j.id === selectedID())))
  const selected = createMemo(() => sorted()[index()])
  const jobRuns = createMemo(() => state.runs().filter((r) => r.jobID === selected()?.id).slice(0, 8))
  const running = createMemo(() => new Set(state.runs().filter((r) => r.status === "running").map((r) => r.jobID)))

  const toastErr = (msg?: string) => {
    if (msg) ctx.ui.toast.show({ title: "Automations", message: msg, variant: "error" })
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

  const actions = {
    togglePause: withJob((j) =>
      update(j.id, (x) => {
        x.paused = !x.paused
        // Resuming re-anchors to now, so a long pause doesn't trigger a catch-up run.
        if (!x.paused) x.nextRunAt = nextRun(x.schedule, Date.now(), x.createdAt)
      }),
    ),
    runNow: withJob((j) => {
      update(j.id, (x) => void (x.runRequestedAt = Date.now()))
      ctx.ui.toast.show({ message: `Queued “${j.name}” — fires on the automations plugin's next tick`, variant: "info" })
    }),
    editPrompt: withJob(async (j) => {
      if (!editable(j)) return
      const v = await ctx.ui.dialog.prompt({ title: `Prompt · ${j.name}`, value: j.prompt })
      if (v?.trim()) update(j.id, (x) => void (x.prompt = v.trim()))
    }),
    editSchedule: withJob(async (j) => {
      if (!editable(j)) return
      const v = await ctx.ui.dialog.prompt({
        title: `Schedule · ${j.name}`,
        description: 'Cron ("0 9 * * 1-5", "@daily", optionally followed by a time zone), "every 15m", or an ISO date',
        value: j.schedule.kind === "cron" ? `${j.schedule.expr}${j.schedule.tz ? ` ${j.schedule.tz}` : ""}` : "",
      })
      if (!v?.trim()) return
      update(j.id, (x) => {
        x.schedule = parseScheduleText(v)
        x.createdAt = Date.now()
        x.done = undefined
        x.nextRunAt = nextRun(x.schedule, Date.now(), x.createdAt)
      })
    }),
    pickModel: withJob(async (j) => {
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
      if (choice !== undefined) update(j.id, (x) => void (x.model = choice || undefined))
    }),
    remove: withJob(async (j) => {
      if (!editable(j)) return
      const ok = await ctx.ui.dialog.confirm({ title: "Delete automation", message: `Delete “${j.name}”? Its history is kept.` })
      if (ok) toastErr(state.act((jobs) => void jobs.splice(jobs.findIndex((x) => x.id === j.id), 1)))
    }),
    openSession: withJob((j) => {
      const sid = jobRuns().find((r) => r.sessionID)?.sessionID ?? j.sessionID
      if (!sid) return toastErr("No session yet — this job hasn't run.")
      if (ctx.ui.tabs.enabled()) ctx.ui.tabs.open(sid)
      ctx.ui.router.navigate({ type: "session", sessionID: sid })
    }),
    create: async () => {
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
          { title: "Reuse one session", value: "reuse", description: "Accumulates context between runs" },
        ],
      })
      if (!session) return
      const directory = ctx.location?.directory ?? process.cwd()
      toastErr(
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
            catchUp: true,
            enabled: true,
            source: "tool",
            createdAt: now,
            nextRunAt: nextRun(schedule, now, now),
          })
        }),
      )
    },
  }

  ctx.keymap.layer(() => ({
    commands: [
      { title: "up", bind: "up", run: () => move(-1) },
      { title: "down", bind: "down", run: () => move(1) },
      { bind: "k", run: () => move(-1) },
      { bind: "j", run: () => move(1) },
      { title: "pause/resume", bind: "space", run: actions.togglePause },
      { title: "run now", bind: "r", run: actions.runNow },
      { title: "new", bind: "n", run: actions.create },
      { title: "prompt", bind: "e", run: actions.editPrompt },
      { title: "schedule", bind: "s", run: actions.editSchedule },
      { title: "model", bind: "m", run: actions.pickModel },
      { title: "delete", bind: "d", run: actions.remove },
      { title: "open session", bind: "return", run: actions.openSession },
      { title: "back", bind: "escape", run: () => ctx.ui.router.navigate({ type: "home" }) },
    ],
  }))

  const muted = t.text.subdued
  const ok = t.text.feedback.success.default
  const bad = t.text.feedback.error.default
  const warn = t.text.feedback.warning.default
  const statusColor = (s?: RunStatus) => (s === "succeeded" ? ok : s === "running" ? warn : s ? bad : muted)

  const Field = (p: { label: string; value: string }) => (
    <text>
      <span style={{ fg: muted }}>{p.label.padEnd(11)}</span>
      {p.value}
    </text>
  )

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text>
          <b>⏰ Automations</b>
        </text>
        <text fg={muted}>
          {state.jobs().length} jobs · {running().size} running
        </text>
      </box>

      <Show
        when={sorted().length}
        fallback={
          <box paddingTop={2} flexDirection="column" gap={1}>
            <text fg={muted}>No automations yet.</text>
            <text fg={muted}>Press n to create one, or ask in chat: “every weekday at 8:45, triage my open MRs”.</text>
          </box>
        }
      >
        <box flexDirection="row" flexGrow={1} paddingTop={1} gap={2}>
          {/* list */}
          <box flexDirection="column" width={36} border borderColor={t.border.default} paddingLeft={1} paddingRight={1}>
            <For each={sorted()}>
              {(j, i) => {
                const isSel = () => i() === index()
                const dot = () => (running().has(j.id) ? "◐" : isActive(j) ? "●" : "○")
                const when = () => (running().has(j.id) ? "running" : isActive(j) ? relative(j.nextRunAt, state.now()) : stateOf(j))
                return (
                  <box
                    flexDirection="row"
                    justifyContent="space-between"
                    backgroundColor={isSel() ? t.background.action.primary.default : undefined}
                  >
                    <text fg={isSel() ? t.text.action.primary.default : undefined}>
                      <span style={{ fg: running().has(j.id) ? warn : isActive(j) ? ok : muted }}>{dot()}</span> {j.name.slice(0, 22)}
                    </text>
                    <text fg={isSel() ? t.text.action.primary.default : muted}>{when()}</text>
                  </box>
                )
              }}
            </For>
          </box>

          {/* detail */}
          <Show when={selected()}>
            {(j) => (
              <scrollbox flexGrow={1}>
                <box flexDirection="column" gap={1}>
                  <box flexDirection="column">
                    <text>
                      <b>{j().name}</b>
                      <span style={{ fg: muted }}>
                        {"  "}
                        {j().id} · {stateOf(j())}
                        {j().source === "config" ? " · from config" : ""}
                      </span>
                    </text>
                    <Field label="schedule" value={describe(j().schedule)} />
                    <Field label="next" value={isActive(j()) ? `${clock(j().nextRunAt)}  (${relative(j().nextRunAt, state.now())})` : "—"} />
                    <Field label="last" value={j().lastRunAt ? `${clock(j().lastRunAt)}  ${j().lastStatus ?? ""}` : "never"} />
                    <Field label="session" value={j().session + (j().sessionID ? `  ${j().sessionID}` : "")} />
                    <Field label="agent" value={j().agent ?? "default"} />
                    <Field label="model" value={j().session === "current" ? "chat's model" : (j().model ?? "agent default")} />
                    <Field label="directory" value={ctx.ui.format.path(j().directory)} />
                    <Field label="timeout" value={`${j().timeoutMinutes}m · catch-up ${j().catchUp ? "on" : "off"}`} />
                  </box>

                  <box flexDirection="column">
                    <text fg={muted}>prompt</text>
                    <box border borderColor={t.border.default} paddingLeft={1} paddingRight={1}>
                      <text>{j().prompt}</text>
                    </box>
                  </box>

                  <box flexDirection="column">
                    <text fg={muted}>recent runs</text>
                    <Show when={jobRuns().length} fallback={<text fg={muted}>none yet</text>}>
                      <For each={jobRuns()}>
                        {(r) => (
                          <box flexDirection="column">
                            <text>
                              <span style={{ fg: statusColor(r.status) }}>{glyph[r.status]}</span> {clock(r.startedAt)}
                              <span style={{ fg: muted }}>
                                {"  "}
                                {r.status} {duration(r)}
                              </span>
                            </text>
                            <Show when={r.error ?? firstLine(r.output)}>
                              {(line) => <text fg={r.error ? bad : muted}>{"  " + line().slice(0, 100)}</text>}
                            </Show>
                          </box>
                        )}
                      </For>
                    </Show>
                  </box>
                </box>
              </scrollbox>
            )}
          </Show>
        </box>
      </Show>

      <text fg={muted} paddingTop={1}>
        ↑↓ select · space pause · r run now · n new · e prompt · s schedule · m model · d delete · ⏎ open session · esc back
      </text>
    </box>
  )
}

function SidebarSection(props: { ctx: Context; state: State; sessionID: string }) {
  const { ctx, state } = props
  const muted = ctx.theme.text.subdued
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
      <box flexDirection="column" paddingTop={1}>
        <text>
          <b>Automations</b>
          <span style={{ fg: muted }}> /automations</span>
        </text>
        <Show when={thisRun()}>
          {(r) => (
            <text fg={ctx.theme.text.feedback.info.default}>
              this session: {r().jobID} {glyph[r().status]}
            </text>
          )}
        </Show>
        <For each={upcoming()}>
          {(j) => (
            <box flexDirection="row" justifyContent="space-between">
              <text>{j.name.slice(0, 18)}</text>
              <text fg={muted}>{relative(j.nextRunAt, state.now())}</text>
            </box>
          )}
        </For>
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
      watcher = watch(dataDir, () => {
        clearTimeout(debounce)
        debounce = setTimeout(state.refresh, 150)
      })
    } catch {}
    const ticker = setInterval(state.refresh, 15_000)

    const unregister = [
      ctx.ui.router.register({ name: PAGE, render: () => <AutomationsPage ctx={ctx} state={state} /> }),
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
          run: () => ctx.ui.router.navigate({ type: "plugin", name: PAGE }),
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
