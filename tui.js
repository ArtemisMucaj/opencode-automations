// Generated from tui.tsx by `bun run compile`. Do not edit. Committed on purpose: see AGENTS.md.
import { memo as _$memo } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
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

import { Plugin } from "@opencode/plugin/tui";
import { watch } from "node:fs";
import { createMemo, createSignal, For, Index, Show } from "solid-js";
import { describe, nextRun } from "./cron.ts";
import { defaultDataDir, isActive, listens, mutateRaw, parseScheduleText, relative, runnable, uniqueID } from "./jobs.ts";
import { Store } from "./store.ts";
import { emptyChannels, removeChannel, requestPoll, summarize } from "./channels.ts";
const glyph = {
  running: "◐",
  succeeded: "✓",
  failed: "✗",
  timeout: "⧗",
  skipped: "↷"
};

// Everything is drawn as filled blocks in the host theme's colors (no borders), so the page
// follows whichever theme is selected. Tinted blocks use the theme's categorical hues.
function look(ctx, surface) {
  const t = surface ? ctx.theme.surface(surface) : ctx.theme;
  const dark = ctx.themeMode !== "light";
  const hue = i => t.categorical[i % Math.max(1, t.categorical.length)] ?? t.hue.accent;
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
    tint: i => hue(i)[dark ? 900 : 100],
    /** Readable heading color on that tint. */
    ink: i => hue(i)[dark ? 300 : 700]
  };
}
const keyHints = [["c", "channels"], ["↑↓", "select"], ["space", "pause"], ["r", "run now"], ["n", "new"], ["e", "prompt"], ["s", "schedule"], ["m", "model"], ["d", "delete"], ["⏎", "open session"], ["esc", "close"]];
const channelHints = [["c", "automations"], ["↑↓", "select"], ["p", "poll now"], ["d", "delete"], ["esc", "close"]];
/** Config channels (as the server published them) and channels created from chat, by ID. */
export function channelRows(s) {
  const rows = Object.entries(s.config).map(([id, sum]) => ({
    id,
    source: "config",
    ...sum
  }));
  for (const [id, def] of Object.entries(s.defs)) {
    if (!s.config[id]) rows.push({
      id,
      source: "created",
      ...summarize({
        ...def,
        id
      })
    });
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

/** The TUI waits only briefly for the channels lock (the server may hold it), so the screen never freezes for long. */
const LOCK_WAIT_MS = 200;
const stateOf = j => j.done ? "done" : j.paused ? "paused" : !j.enabled ? "disabled" : "active";
const firstLine = s => (s ?? "").split("\n").find(l => l.trim()) ?? "";
const duration = r => r.endedAt ? `${Math.max(1, Math.round((r.endedAt - r.startedAt) / 1000))}s` : "";
const clock = t => t ? new Date(t).toLocaleString(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit"
}) : "—";
export function createState(ctx, dataDir) {
  const store = new Store(dataDir);
  const [jobs, setJobs] = createSignal(store.loadJobs());
  const [runs, setRuns] = createSignal(store.history(undefined, 300));
  const [now, setNow] = createSignal(Date.now());
  const loadChannels = () => {
    try {
      return store.loadChannels();
    } catch {
      return emptyChannels();
    }
  };
  const [channels, setChannels] = createSignal(loadChannels());
  // Kept here, not in the view: the dialog is re-created after nested prompts and must reopen on the same job and tab.
  const [selectedID, setSelectedID] = createSignal();
  const [selectedChannel, setSelectedChannel] = createSignal();
  const [tab, setTab] = createSignal("jobs");
  const notifyMode = ctx.options.notify ?? "blurred";
  const seen = new Set(runs().filter(r => r.status !== "running").map(r => r.runID));
  function refresh() {
    setJobs(store.loadJobs());
    setChannels(loadChannels());
    const next = store.history(undefined, 300);
    setRuns(next);
    setNow(Date.now());
    for (const r of next) {
      if (r.status === "running" || seen.has(r.runID)) continue;
      seen.add(r.runID);
      if (r.status === "skipped") continue;
      const job = jobs().find(j => j.id === r.jobID);
      const title = `⏰ ${job?.name ?? r.jobID} ${r.status}`;
      const message = r.error ?? (firstLine(r.output).slice(0, 140) || duration(r));
      ctx.ui.toast.show({
        title,
        message,
        variant: r.status === "succeeded" ? "success" : "error",
        duration: 6000
      });
      if (notifyMode !== "off") {
        void ctx.attention.notify({
          title,
          message,
          notification: {
            when: notifyMode === "always" ? "always" : "blurred"
          },
          sound: false
        }).catch(() => {});
      }
    }
  }

  /** Write an intent and re-read. Resolves to an error message instead of throwing (callers toast it). */
  async function act(fn) {
    try {
      await mutateRaw(store, fn);
      refresh();
    } catch (e) {
      return e.message;
    }
  }

  /** Write channel state (a poll intent, a delete) and re-read. Resolves to an error message instead of throwing. */
  async function actChannels(fn) {
    try {
      await store.mutateChannels(fn, LOCK_WAIT_MS);
      refresh();
    } catch (e) {
      return e.message;
    }
  }
  return {
    store,
    jobs,
    runs,
    now,
    refresh,
    act,
    selectedID,
    setSelectedID,
    channels,
    actChannels,
    selectedChannel,
    setSelectedChannel,
    tab,
    setTab
  };
}
function AutomationsView(props) {
  const {
    ctx,
    state
  } = props;
  const {
    selectedID,
    setSelectedID
  } = state;
  const t = ctx.theme.surface("dialog");
  const sorted = createMemo(() => [...state.jobs()].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)));
  // Selection follows the job, not the row: pausing re-sorts the list and must not move the cursor to another job.
  const index = createMemo(() => Math.max(0, sorted().findIndex(j => j.id === selectedID())));
  const selected = createMemo(() => sorted()[index()]);
  const jobRuns = createMemo(() => state.runs().filter(r => r.jobID === selected()?.id).slice(0, 8));

  // ---- channels tab ----
  const onChannels = () => state.tab() === "channels";
  const chRows = createMemo(() => channelRows(state.channels()));
  const chIndex = createMemo(() => Math.max(0, chRows().findIndex(c => c.id === state.selectedChannel())));
  const chSelected = createMemo(() => chRows()[chIndex()]);
  /** Per channel, computed once per refresh: the automations on it, and "failing", "polling" (an active one uses it) or "idle". */
  const chInfo = createMemo(() => {
    const info = new Map();
    for (const c of chRows()) {
      const users = state.jobs().filter(j => listens(j, c.id));
      info.set(c.id, {
        users,
        status: state.channels().sources[c.id]?.failures ? "failing" : users.some(isActive) ? "polling" : "idle"
      });
    }
    return info;
  });
  const listeners = id => chInfo().get(id)?.users ?? [];
  const chStatus = c => chInfo().get(c.id)?.status ?? "idle";
  const moveChannel = d => {
    const next = chRows()[Math.max(0, Math.min(chRows().length - 1, chIndex() + d))];
    if (next) state.setSelectedChannel(next.id);
  };
  const running = createMemo(() => new Set(state.runs().filter(r => r.status === "running").map(r => r.jobID)));

  /** Toast an error message; also takes the promise act() returns, and resolves once it has settled. */
  const toastErr = async msg => {
    const m = await msg;
    if (m) ctx.ui.toast.show({
      title: "Automations",
      message: m,
      variant: "error"
    });
  };
  const move = d => {
    const next = sorted()[Math.max(0, Math.min(sorted().length - 1, index() + d))];
    if (next) setSelectedID(next.id);
  };
  const withJob = fn => () => {
    const j = selected();
    if (!j) return;
    setSelectedID(j.id); // pin, so a re-sort caused by this action keeps the cursor on it
    return fn(j);
  };
  // opencode shows one dialog at a time, so a prompt replaces this view. Bring it back afterwards.
  const nested = fn => async (...args) => {
    try {
      await fn(...args);
    } finally {
      props.reopen();
    }
  };
  const editable = j => {
    if (j.source === "config") toastErr("Config jobs are edited in opencode.json(c) — only pause/run here.");
    return j.source !== "config";
  };
  const update = (id, fn) => toastErr(state.act(jobs => {
    const j = jobs.find(x => x.id === id);
    if (!j) throw new Error("job no longer exists");
    fn(j);
  }));
  const channelActions = {
    poll: () => {
      const c = chSelected();
      if (!c) return;
      const done = toastErr(state.actChannels(s => requestPoll(s, c.id)));
      ctx.ui.toast.show({
        message: `Polling “${c.name}” on the automations plugin's next tick`,
        variant: "info"
      });
      return done;
    },
    remove: nested(async () => {
      const c = chSelected();
      if (!c) return;
      if (c.source === "config") return toastErr("Config channels are removed in opencode.json(c).");
      const users = listeners(c.id);
      if (users.length) {
        return toastErr(`Used by ${users.map(j => j.name).join(", ")}. Detach it from chat: channel_delete with detach.`);
      }
      const ok = await ctx.ui.dialog.confirm({
        title: "Delete channel",
        message: `Delete the channel “${c.name}”? No automation uses it.`
      });
      if (!ok) return;
      // Checked again under the jobs lock: this list may be up to 15 s old, and chat may have attached it since.
      await toastErr(state.act(async jobs => {
        const now = jobs.filter(j => listens(j, c.id));
        if (now.length) throw new Error(`Used by ${now.map(j => j.name).join(", ")} now. Detach it from chat: channel_delete with detach.`);
        await state.store.mutateChannels(s => removeChannel(s, c.id), LOCK_WAIT_MS);
      }));
    })
  };
  /** Keys that only mean something on one tab. */
  const jobsOnly = fn => () => onChannels() ? undefined : fn();
  const channelsOnly = fn => () => onChannels() ? fn() : undefined;
  const step = d => onChannels() ? moveChannel(d) : move(d);
  const actions = {
    togglePause: withJob(j => update(j.id, x => {
      if (x.paused && !runnable(x)) {
        throw new Error("It has no channels and no schedule, so it would never run. Add channels from chat, or a schedule with s.");
      }
      x.paused = !x.paused;
      // Resuming re-anchors to now, so a long pause doesn't fire a missed run right away.
      if (!x.paused) x.nextRunAt = nextRun(x.schedule, Date.now(), x.createdAt);
    })),
    runNow: withJob(j => {
      const done = update(j.id, x => void (x.runRequestedAt = Date.now()));
      ctx.ui.toast.show({
        message: `Queued “${j.name}” — fires on the automations plugin's next tick`,
        variant: "info"
      });
      return done;
    }),
    editPrompt: nested(withJob(async j => {
      if (!editable(j)) return;
      const v = await ctx.ui.dialog.prompt({
        title: `Prompt · ${j.name}`,
        value: j.prompt
      });
      if (v?.trim()) await update(j.id, x => void (x.prompt = v.trim()));
    })),
    editSchedule: nested(withJob(async j => {
      if (!editable(j)) return;
      const v = await ctx.ui.dialog.prompt({
        title: `Schedule · ${j.name}`,
        description: 'Cron ("0 9 * * 1-5", "@daily", optionally followed by a time zone), "every 15m", or an ISO date',
        value: j.schedule.kind === "cron" ? `${j.schedule.expr}${j.schedule.tz ? ` ${j.schedule.tz}` : ""}` : ""
      });
      if (!v?.trim()) return;
      await update(j.id, x => {
        x.schedule = parseScheduleText(v);
        x.createdAt = Date.now();
        x.done = undefined;
        x.nextRunAt = nextRun(x.schedule, Date.now(), x.createdAt);
      });
    })),
    pickModel: nested(withJob(async j => {
      if (!editable(j)) return;
      const models = ctx.data.location.model.list(ctx.location) ?? [];
      const choice = await ctx.ui.dialog.select({
        title: `Model · ${j.name}`,
        placeholder: "Search models",
        current: j.model ?? "",
        options: [{
          title: "Agent / session default",
          value: ""
        }, ...models.map(m => ({
          title: m.name,
          value: `${m.providerID}/${m.modelID}`,
          category: m.providerID
        }))]
      });
      if (choice !== undefined) await update(j.id, x => void (x.model = choice || undefined));
    })),
    remove: nested(withJob(async j => {
      if (!editable(j)) return;
      const ok = await ctx.ui.dialog.confirm({
        title: "Delete automation",
        message: `Delete “${j.name}”? Its history is kept.`
      });
      if (ok) await toastErr(state.act(jobs => void jobs.splice(jobs.findIndex(x => x.id === j.id), 1)));
    })),
    openSession: withJob(j => {
      const sid = jobRuns().find(r => r.sessionID)?.sessionID ?? j.sessionID;
      if (!sid) return toastErr("No session yet — this job hasn't run.");
      ctx.ui.dialog.clear();
      if (!ctx.ui.tabs.focus(sid)) ctx.ui.router.navigate({
        type: "session",
        sessionID: sid
      });
    }),
    create: nested(async () => {
      const name = await ctx.ui.dialog.prompt({
        title: "New automation",
        placeholder: "Name, e.g. Morning MR triage"
      });
      if (!name?.trim()) return;
      const prompt = await ctx.ui.dialog.prompt({
        title: "Prompt",
        description: "Make it self-contained: new sessions start with no context.",
        placeholder: "List open merge requests where I'm reviewer…"
      });
      if (!prompt?.trim()) return;
      const when = await ctx.ui.dialog.prompt({
        title: "When",
        description: 'Cron ("45 8 * * 1-5 Europe/Paris", "@daily"), "every 30m", or an ISO date for a one-shot'
      });
      if (!when?.trim()) return;
      let schedule;
      try {
        schedule = parseScheduleText(when);
      } catch (e) {
        return toastErr(e.message);
      }
      const session = await ctx.ui.dialog.select({
        title: "Session",
        options: [{
          title: "New session per run",
          value: "new",
          description: "Reports, checks, anything stateless"
        }, {
          title: "Sticky session",
          value: "sticky",
          description: "Every run goes to the same session; accumulates context"
        }]
      });
      if (!session) return;
      const directory = ctx.location?.directory ?? process.cwd();
      await toastErr(state.act(jobs => {
        const now = Date.now();
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
          nextRunAt: nextRun(schedule, now, now)
        });
      }));
    })
  };

  // Dialogs run in opencode's "modal" input mode; the dialog itself handles esc.
  ctx.keymap.layer(() => ({
    mode: "modal",
    commands: [{
      title: "up",
      bind: "up",
      run: () => step(-1)
    }, {
      title: "down",
      bind: "down",
      run: () => step(1)
    }, {
      bind: "k",
      run: () => step(-1)
    }, {
      bind: "j",
      run: () => step(1)
    }, {
      title: "channels/automations",
      bind: "c",
      run: () => state.setTab(onChannels() ? "jobs" : "channels")
    }, {
      title: "pause/resume",
      bind: "space",
      run: jobsOnly(actions.togglePause)
    }, {
      title: "run now",
      bind: "r",
      run: jobsOnly(actions.runNow)
    }, {
      title: "poll now",
      bind: "p",
      run: channelsOnly(channelActions.poll)
    }, {
      title: "new",
      bind: "n",
      run: jobsOnly(actions.create)
    }, {
      title: "prompt",
      bind: "e",
      run: jobsOnly(actions.editPrompt)
    }, {
      title: "schedule",
      bind: "s",
      run: jobsOnly(actions.editSchedule)
    }, {
      title: "model",
      bind: "m",
      run: jobsOnly(actions.pickModel)
    }, {
      title: "delete",
      bind: "d",
      run: () => onChannels() ? channelActions.remove() : actions.remove()
    }, {
      title: "open session",
      bind: "return",
      run: jobsOnly(actions.openSession)
    }]
  }));
  const L = createMemo(() => look(ctx, "dialog"));
  const statusLook = st => ({
    failing: {
      fg: L().bad,
      bg: t.background.feedback.error.base,
      dot: "✗"
    },
    polling: {
      fg: L().ok,
      bg: t.background.feedback.success.base,
      dot: "●"
    },
    idle: {
      fg: L().muted,
      bg: L().cap,
      dot: "○"
    }
  })[st];
  const statusColor = s => s === "succeeded" ? L().ok : s === "running" ? L().warn : s === "skipped" || !s ? L().muted : L().bad;
  const badge = j => {
    const s = stateOf(j);
    const kind = s === "active" ? "success" : s === "paused" ? "warning" : s === "done" ? "info" : undefined;
    return {
      label: ` ${s} `,
      fg: kind ? t.text.feedback[kind].base : L().muted,
      bg: kind ? t.background.feedback[kind].base : L().cap
    };
  };
  // opencode dialogs have fixed widths (xlarge = 116 cols). To cover 80% of the terminal instead, the
  // view leaves an empty anchor in the dialog and draws an absolute panel positioned from it. The
  // anchor's screen position is only final at paint time, so it is read there and corrected next frame.
  const [origin, setOrigin] = createSignal();
  function track() {
    const next = {
      x: this.screenX,
      y: this.screenY,
      w: ctx.renderer.width,
      h: ctx.renderer.height
    };
    const o = origin();
    if (!o || o.x !== next.x || o.y !== next.y || o.w !== next.w || o.h !== next.h) setOrigin(next);
  }
  const panel = createMemo(() => {
    const o = origin();
    if (!o) return;
    const width = Math.round(o.w * 0.8);
    const height = Math.round(o.h * 0.8);
    return {
      left: Math.floor((o.w - width) / 2) - o.x,
      top: Math.floor((o.h - height) / 2) - o.y,
      width,
      height
    };
  });
  const activeCount = createMemo(() => state.jobs().filter(isActive).length);
  const Heading = p => (() => {
    var _el$ = _$createElement("text"),
      _el$2 = _$createElement("b");
    _$insertNode(_el$, _el$2);
    _$insert(_el$2, () => p.title.toUpperCase());
    _$effect(_$p => _$setProp(_el$, "fg", L().ink(p.hue), _$p));
    return _el$;
  })();
  const Block = p => (() => {
    var _el$3 = _$createElement("box");
    _$setProp(_el$3, "flexDirection", "column");
    _$setProp(_el$3, "paddingLeft", 2);
    _$setProp(_el$3, "paddingRight", 2);
    _$setProp(_el$3, "paddingTop", 1);
    _$setProp(_el$3, "paddingBottom", 1);
    _$setProp(_el$3, "gap", 1);
    _$insert(_el$3, _$createComponent(Heading, {
      get title() {
        return p.title;
      },
      get hue() {
        return p.hue;
      }
    }), null);
    _$insert(_el$3, () => p.children, null);
    _$effect(_$p => _$setProp(_el$3, "backgroundColor", L().tint(p.hue), _$p));
    return _el$3;
  })();
  const Field = p => (() => {
    var _el$4 = _$createElement("text"),
      _el$5 = _$createElement("span"),
      _el$6 = _$createElement("span");
    _$insertNode(_el$4, _el$5);
    _$insertNode(_el$4, _el$6);
    _$insert(_el$5, () => p.label.padEnd(11));
    _$insert(_el$6, () => p.value);
    _$effect(_p$ => {
      var _v$ = {
          fg: L().muted
        },
        _v$2 = {
          fg: p.fg ?? L().text
        };
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$5, "style", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$6, "style", _v$2, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$4;
  })();
  return (() => {
    var _el$7 = _$createElement("box");
    _$setProp(_el$7, "renderBefore", track);
    _$insert(_el$7, _$createComponent(Show, {
      get when() {
        return panel();
      },
      children: p => (() => {
        var _el$8 = _$createElement("box"),
          _el$9 = _$createElement("box"),
          _el$0 = _$createElement("box"),
          _el$1 = _$createElement("text"),
          _el$10 = _$createElement("b"),
          _el$12 = _$createElement("text"),
          _el$13 = _$createElement("text"),
          _el$34 = _$createElement("box");
        _$insertNode(_el$8, _el$9);
        _$insertNode(_el$8, _el$34);
        _$setProp(_el$8, "position", "absolute");
        _$setProp(_el$8, "zIndex", 10);
        _$setProp(_el$8, "flexDirection", "column");
        _$setProp(_el$8, "paddingLeft", 2);
        _$setProp(_el$8, "paddingRight", 2);
        _$setProp(_el$8, "paddingTop", 1);
        _$insertNode(_el$9, _el$0);
        _$setProp(_el$9, "flexDirection", "row");
        _$setProp(_el$9, "justifyContent", "space-between");
        _$setProp(_el$9, "paddingBottom", 1);
        _$setProp(_el$9, "flexShrink", 0);
        _$insertNode(_el$0, _el$1);
        _$insertNode(_el$0, _el$12);
        _$insertNode(_el$0, _el$13);
        _$setProp(_el$0, "flexDirection", "row");
        _$setProp(_el$0, "gap", 2);
        _$insertNode(_el$1, _el$10);
        _$insertNode(_el$10, _$createTextNode(`⏰ Automations`));
        _$insert(_el$12, () => onChannels() ? " jobs " : "[jobs]");
        _$insert(_el$13, () => onChannels() ? "[channels]" : " channels ");
        _$insert(_el$9, _$createComponent(Show, {
          get when() {
            return onChannels();
          },
          get fallback() {
            return (() => {
              var _el$35 = _$createElement("text"),
                _el$36 = _$createTextNode(` `),
                _el$37 = _$createTextNode(` · `),
                _el$38 = _$createTextNode(` active · `),
                _el$40 = _$createElement("span"),
                _el$41 = _$createTextNode(` running`);
              _$insertNode(_el$35, _el$36);
              _$insertNode(_el$35, _el$37);
              _$insertNode(_el$35, _el$38);
              _$insertNode(_el$35, _el$40);
              _$insert(_el$35, () => state.jobs().length, _el$36);
              _$insert(_el$35, () => state.jobs().length === 1 ? "job" : "jobs", _el$37);
              _$insert(_el$35, activeCount, _el$38);
              _$insertNode(_el$40, _el$41);
              _$insert(_el$40, () => running().size, _el$41);
              _$effect(_p$ => {
                var _v$15 = L().muted,
                  _v$16 = {
                    fg: running().size ? L().warn : L().muted
                  };
                _v$15 !== _p$.e && (_p$.e = _$setProp(_el$35, "fg", _v$15, _p$.e));
                _v$16 !== _p$.t && (_p$.t = _$setProp(_el$40, "style", _v$16, _p$.t));
                return _p$;
              }, {
                e: undefined,
                t: undefined
              });
              return _el$35;
            })();
          },
          get children() {
            var _el$14 = _$createElement("text"),
              _el$15 = _$createTextNode(` `),
              _el$16 = _$createTextNode(` · `),
              _el$18 = _$createTextNode(` polled · `),
              _el$20 = _$createElement("span"),
              _el$21 = _$createTextNode(` failing`);
            _$insertNode(_el$14, _el$15);
            _$insertNode(_el$14, _el$16);
            _$insertNode(_el$14, _el$18);
            _$insertNode(_el$14, _el$20);
            _$insert(_el$14, () => chRows().length, _el$15);
            _$insert(_el$14, () => chRows().length === 1 ? "channel" : "channels", _el$16);
            _$insert(_el$14, () => chRows().filter(c => chStatus(c) !== "idle").length, _el$18);
            _$insertNode(_el$20, _el$21);
            _$insert(_el$20, () => chRows().filter(c => chStatus(c) === "failing").length, _el$21);
            _$effect(_p$ => {
              var _v$3 = L().muted,
                _v$4 = {
                  fg: chRows().some(c => chStatus(c) === "failing") ? L().bad : L().muted
                };
              _v$3 !== _p$.e && (_p$.e = _$setProp(_el$14, "fg", _v$3, _p$.e));
              _v$4 !== _p$.t && (_p$.t = _$setProp(_el$20, "style", _v$4, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$14;
          }
        }), null);
        _$insert(_el$8, _$createComponent(Show, {
          get when() {
            return onChannels();
          },
          get children() {
            return _$createComponent(Show, {
              get when() {
                return chRows().length;
              },
              get fallback() {
                return (() => {
                  var _el$42 = _$createElement("box"),
                    _el$43 = _$createElement("text"),
                    _el$45 = _$createElement("text");
                  _$insertNode(_el$42, _el$43);
                  _$insertNode(_el$42, _el$45);
                  _$setProp(_el$42, "padding", 2);
                  _$setProp(_el$42, "flexDirection", "column");
                  _$setProp(_el$42, "gap", 1);
                  _$insertNode(_el$43, _$createTextNode(`No channels yet.`));
                  _$insertNode(_el$45, _$createTextNode(`Ask in chat: “/channel alert me about Datadog monitors that start alerting”.`));
                  _$effect(_p$ => {
                    var _v$17 = L().panel,
                      _v$18 = L().text,
                      _v$19 = L().muted;
                    _v$17 !== _p$.e && (_p$.e = _$setProp(_el$42, "backgroundColor", _v$17, _p$.e));
                    _v$18 !== _p$.t && (_p$.t = _$setProp(_el$43, "fg", _v$18, _p$.t));
                    _v$19 !== _p$.a && (_p$.a = _$setProp(_el$45, "fg", _v$19, _p$.a));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined
                  });
                  return _el$42;
                })();
              },
              get children() {
                var _el$22 = _$createElement("box"),
                  _el$23 = _$createElement("box"),
                  _el$24 = _$createElement("box"),
                  _el$25 = _$createElement("text"),
                  _el$26 = _$createElement("b");
                _$insertNode(_el$22, _el$23);
                _$setProp(_el$22, "flexDirection", "row");
                _$setProp(_el$22, "flexGrow", 1);
                _$setProp(_el$22, "flexShrink", 1);
                _$setProp(_el$22, "flexBasis", 0);
                _$setProp(_el$22, "minHeight", 0);
                _$setProp(_el$22, "gap", 2);
                _$insertNode(_el$23, _el$24);
                _$setProp(_el$23, "flexDirection", "column");
                _$setProp(_el$23, "width", 38);
                _$setProp(_el$23, "paddingTop", 1);
                _$setProp(_el$23, "paddingBottom", 1);
                _$insertNode(_el$24, _el$25);
                _$setProp(_el$24, "paddingLeft", 2);
                _$setProp(_el$24, "paddingBottom", 1);
                _$insertNode(_el$25, _el$26);
                _$insertNode(_el$26, _$createTextNode(`CHANNELS`));
                _$insert(_el$23, _$createComponent(Index, {
                  get each() {
                    return chRows();
                  },
                  children: (c, i) => {
                    const isSel = () => i === chIndex();
                    const status = () => chStatus(c());
                    const src = () => state.channels().sources[c().id];
                    const when = () => status() === "idle" ? "idle" : src()?.lastPollAt ? relative(src().lastPollAt, state.now()) : "soon";
                    const fg = () => isSel() ? t.text.action.primary.focused : undefined;
                    return (() => {
                      var _el$47 = _$createElement("box"),
                        _el$48 = _$createElement("box"),
                        _el$49 = _$createElement("text"),
                        _el$50 = _$createElement("text"),
                        _el$51 = _$createElement("text");
                      _$insertNode(_el$47, _el$48);
                      _$insertNode(_el$47, _el$51);
                      _$setProp(_el$47, "flexDirection", "row");
                      _$setProp(_el$47, "justifyContent", "space-between");
                      _$setProp(_el$47, "paddingLeft", 2);
                      _$setProp(_el$47, "paddingRight", 2);
                      _$insertNode(_el$48, _el$49);
                      _$insertNode(_el$48, _el$50);
                      _$setProp(_el$48, "flexDirection", "row");
                      _$setProp(_el$48, "gap", 1);
                      _$insert(_el$49, () => statusLook(status()).dot);
                      _$insert(_el$50, () => c().name.slice(0, 22));
                      _$insert(_el$51, when);
                      _$effect(_p$ => {
                        var _v$20 = isSel() ? t.background.action.primary.focused : undefined,
                          _v$21 = statusLook(status()).fg,
                          _v$22 = fg() ?? L().text,
                          _v$23 = fg() ?? L().muted;
                        _v$20 !== _p$.e && (_p$.e = _$setProp(_el$47, "backgroundColor", _v$20, _p$.e));
                        _v$21 !== _p$.t && (_p$.t = _$setProp(_el$49, "fg", _v$21, _p$.t));
                        _v$22 !== _p$.a && (_p$.a = _$setProp(_el$50, "fg", _v$22, _p$.a));
                        _v$23 !== _p$.o && (_p$.o = _$setProp(_el$51, "fg", _v$23, _p$.o));
                        return _p$;
                      }, {
                        e: undefined,
                        t: undefined,
                        a: undefined,
                        o: undefined
                      });
                      return _el$47;
                    })();
                  }
                }), null);
                _$insert(_el$22, _$createComponent(Show, {
                  get when() {
                    return chSelected();
                  },
                  children: c => {
                    const src = () => state.channels().sources[c().id];
                    const users = () => listeners(c().id);
                    // Each listener's waiting events from this channel, filtered once per refresh.
                    const waiting = createMemo(() => {
                      const out = new Map();
                      for (const j of users()) out.set(j.id, state.channels().queues[j.id]?.pending.filter(e => e.channel === c().id) ?? []);
                      return out;
                    });
                    const queue = id => waiting().get(id) ?? [];
                    const status = () => chStatus(c());
                    return (() => {
                      var _el$52 = _$createElement("scrollbox"),
                        _el$53 = _$createElement("box");
                      _$insertNode(_el$52, _el$53);
                      _$setProp(_el$52, "flexGrow", 1);
                      _$setProp(_el$52, "minHeight", 0);
                      _$setProp(_el$53, "flexDirection", "column");
                      _$setProp(_el$53, "gap", 1);
                      _$insert(_el$53, _$createComponent(Block, {
                        title: "Channel",
                        hue: 0,
                        get children() {
                          return [(() => {
                            var _el$54 = _$createElement("text"),
                              _el$55 = _$createElement("span"),
                              _el$56 = _$createElement("b"),
                              _el$57 = _$createTextNode(`  `),
                              _el$58 = _$createElement("span"),
                              _el$59 = _$createElement("span"),
                              _el$60 = _$createTextNode(`  `),
                              _el$61 = _$createTextNode(` · `);
                            _$insertNode(_el$54, _el$55);
                            _$insertNode(_el$54, _el$57);
                            _$insertNode(_el$54, _el$58);
                            _$insertNode(_el$54, _el$59);
                            _$insertNode(_el$55, _el$56);
                            _$insert(_el$56, () => c().name);
                            _$insert(_el$58, () => ` ${status()} `);
                            _$insertNode(_el$59, _el$60);
                            _$insertNode(_el$59, _el$61);
                            _$insert(_el$59, () => c().id, _el$61);
                            _$insert(_el$59, () => c().source === "config" ? "from config" : "created from chat", null);
                            _$effect(_p$ => {
                              var _v$24 = {
                                  fg: L().text
                                },
                                _v$25 = {
                                  fg: statusLook(status()).fg,
                                  bg: statusLook(status()).bg
                                },
                                _v$26 = {
                                  fg: L().muted
                                };
                              _v$24 !== _p$.e && (_p$.e = _$setProp(_el$55, "style", _v$24, _p$.e));
                              _v$25 !== _p$.t && (_p$.t = _$setProp(_el$58, "style", _v$25, _p$.t));
                              _v$26 !== _p$.a && (_p$.a = _$setProp(_el$59, "style", _v$26, _p$.a));
                              return _p$;
                            }, {
                              e: undefined,
                              t: undefined,
                              a: undefined
                            });
                            return _el$54;
                          })(), (() => {
                            var _el$62 = _$createElement("box");
                            _$setProp(_el$62, "flexDirection", "column");
                            _$insert(_el$62, _$createComponent(Field, {
                              label: "polls",
                              get value() {
                                return c().url;
                              }
                            }), null);
                            _$insert(_el$62, _$createComponent(Field, {
                              label: "every",
                              get value() {
                                return describe({
                                  kind: "every",
                                  ms: c().everyMs || 60_000
                                }).replace(/^every /, "");
                              }
                            }), null);
                            _$insert(_el$62, _$createComponent(Field, {
                              label: "last poll",
                              get value() {
                                return _$memo(() => !!src()?.lastPollAt)() ? `${clock(src().lastPollAt)}  (${relative(src().lastPollAt, state.now())})` : "never";
                              }
                            }), null);
                            _$insert(_el$62, _$createComponent(Field, {
                              label: "last ok",
                              get value() {
                                return _$memo(() => !!src()?.lastOkAt)() ? clock(src().lastOkAt) : "never";
                              }
                            }), null);
                            _$insert(_el$62, _$createComponent(Show, {
                              get when() {
                                return src()?.lastError;
                              },
                              children: err => _$createComponent(Field, {
                                label: "error",
                                get value() {
                                  return `${err()}  (${src().failures}× in a row)`;
                                },
                                get fg() {
                                  return L().bad;
                                }
                              })
                            }), null);
                            _$insert(_el$62, _$createComponent(Field, {
                              label: "env",
                              get value() {
                                return _$memo(() => !!c().env.length)() ? c().env.join(", ") : "none";
                              }
                            }), null);
                            return _el$62;
                          })()];
                        }
                      }), null);
                      _$insert(_el$53, _$createComponent(Block, {
                        title: "Mapping",
                        hue: 1,
                        get children() {
                          var _el$63 = _$createElement("box");
                          _$setProp(_el$63, "flexDirection", "column");
                          _$insert(_el$63, _$createComponent(Field, {
                            label: "items",
                            get value() {
                              return c().items || "(the response)";
                            }
                          }), null);
                          _$insert(_el$63, _$createComponent(Field, {
                            label: "filter",
                            get value() {
                              return _$memo(() => !!Object.keys(c().filter).length)() ? JSON.stringify(c().filter) : "none";
                            }
                          }), null);
                          _$insert(_el$63, _$createComponent(Field, {
                            label: "event id",
                            get value() {
                              return c().event.id;
                            }
                          }), null);
                          _$insert(_el$63, _$createComponent(Field, {
                            label: "sessionKey",
                            get value() {
                              return c().event.sessionKey ?? "none";
                            }
                          }), null);
                          _$insert(_el$63, _$createComponent(Field, {
                            label: "title",
                            get value() {
                              return c().event.title ?? "(event id)";
                            }
                          }), null);
                          _$insert(_el$63, _$createComponent(Show, {
                            get when() {
                              return c().event.body;
                            },
                            children: b => _$createComponent(Field, {
                              label: "body",
                              get value() {
                                return b();
                              }
                            })
                          }), null);
                          _$insert(_el$63, _$createComponent(Show, {
                            get when() {
                              return c().event.url;
                            },
                            children: u => _$createComponent(Field, {
                              label: "url",
                              get value() {
                                return u();
                              }
                            })
                          }), null);
                          return _el$63;
                        }
                      }), null);
                      _$insert(_el$53, _$createComponent(Block, {
                        title: "Automations",
                        hue: 2,
                        get children() {
                          return _$createComponent(Show, {
                            get when() {
                              return users().length;
                            },
                            get fallback() {
                              return (() => {
                                var _el$65 = _$createElement("text");
                                _$insertNode(_el$65, _$createTextNode(`none use it, so it isn't polled`));
                                _$effect(_$p => _$setProp(_el$65, "fg", L().muted, _$p));
                                return _el$65;
                              })();
                            },
                            get children() {
                              var _el$64 = _$createElement("box");
                              _$setProp(_el$64, "flexDirection", "column");
                              _$setProp(_el$64, "gap", 1);
                              _$insert(_el$64, _$createComponent(For, {
                                get each() {
                                  return users();
                                },
                                children: j => (() => {
                                  var _el$67 = _$createElement("box"),
                                    _el$68 = _$createElement("text"),
                                    _el$69 = _$createElement("span"),
                                    _el$70 = _$createTextNode(` `),
                                    _el$71 = _$createElement("span"),
                                    _el$72 = _$createTextNode(`  `),
                                    _el$73 = _$createTextNode(` · `),
                                    _el$74 = _$createTextNode(` waiting`);
                                  _$insertNode(_el$67, _el$68);
                                  _$setProp(_el$67, "flexDirection", "column");
                                  _$insertNode(_el$68, _el$69);
                                  _$insertNode(_el$68, _el$70);
                                  _$insertNode(_el$68, _el$71);
                                  _$insert(_el$69, () => isActive(j) ? "●" : "○");
                                  _$insert(_el$68, () => j.name, _el$71);
                                  _$insertNode(_el$71, _el$72);
                                  _$insertNode(_el$71, _el$73);
                                  _$insertNode(_el$71, _el$74);
                                  _$insert(_el$71, (() => {
                                    var _c$ = _$memo(() => j.schedule.kind === "event");
                                    return () => _c$() ? "as events arrive" : describe(j.schedule);
                                  })(), _el$73);
                                  _$insert(_el$71, () => queue(j.id).length, _el$74);
                                  _$insert(_el$67, _$createComponent(For, {
                                    get each() {
                                      return queue(j.id).slice(0, 3);
                                    },
                                    children: e => (() => {
                                      var _el$75 = _$createElement("text");
                                      _$insert(_el$75, () => "  " + e.title.slice(0, 90));
                                      _$effect(_$p => _$setProp(_el$75, "fg", L().muted, _$p));
                                      return _el$75;
                                    })()
                                  }), null);
                                  _$effect(_p$ => {
                                    var _v$27 = L().text,
                                      _v$28 = {
                                        fg: isActive(j) ? L().ok : L().muted
                                      },
                                      _v$29 = {
                                        fg: L().muted
                                      };
                                    _v$27 !== _p$.e && (_p$.e = _$setProp(_el$68, "fg", _v$27, _p$.e));
                                    _v$28 !== _p$.t && (_p$.t = _$setProp(_el$69, "style", _v$28, _p$.t));
                                    _v$29 !== _p$.a && (_p$.a = _$setProp(_el$71, "style", _v$29, _p$.a));
                                    return _p$;
                                  }, {
                                    e: undefined,
                                    t: undefined,
                                    a: undefined
                                  });
                                  return _el$67;
                                })()
                              }));
                              return _el$64;
                            }
                          });
                        }
                      }), null);
                      return _el$52;
                    })();
                  }
                }), null);
                _$effect(_p$ => {
                  var _v$5 = L().panel,
                    _v$6 = L().muted;
                  _v$5 !== _p$.e && (_p$.e = _$setProp(_el$23, "backgroundColor", _v$5, _p$.e));
                  _v$6 !== _p$.t && (_p$.t = _$setProp(_el$25, "fg", _v$6, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$22;
              }
            });
          }
        }), _el$34);
        _$insert(_el$8, _$createComponent(Show, {
          get when() {
            return !onChannels();
          },
          get children() {
            return _$createComponent(Show, {
              get when() {
                return sorted().length;
              },
              get fallback() {
                return (() => {
                  var _el$76 = _$createElement("box"),
                    _el$77 = _$createElement("text"),
                    _el$79 = _$createElement("text");
                  _$insertNode(_el$76, _el$77);
                  _$insertNode(_el$76, _el$79);
                  _$setProp(_el$76, "padding", 2);
                  _$setProp(_el$76, "flexDirection", "column");
                  _$setProp(_el$76, "gap", 1);
                  _$insertNode(_el$77, _$createTextNode(`No automations yet.`));
                  _$insertNode(_el$79, _$createTextNode(`Press n to create one, or ask in chat: “every weekday at 8:45, triage my open MRs”.`));
                  _$effect(_p$ => {
                    var _v$30 = L().panel,
                      _v$31 = L().text,
                      _v$32 = L().muted;
                    _v$30 !== _p$.e && (_p$.e = _$setProp(_el$76, "backgroundColor", _v$30, _p$.e));
                    _v$31 !== _p$.t && (_p$.t = _$setProp(_el$77, "fg", _v$31, _p$.t));
                    _v$32 !== _p$.a && (_p$.a = _$setProp(_el$79, "fg", _v$32, _p$.a));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined
                  });
                  return _el$76;
                })();
              },
              get children() {
                var _el$28 = _$createElement("box"),
                  _el$29 = _$createElement("box"),
                  _el$30 = _$createElement("box"),
                  _el$31 = _$createElement("text"),
                  _el$32 = _$createElement("b");
                _$insertNode(_el$28, _el$29);
                _$setProp(_el$28, "flexDirection", "row");
                _$setProp(_el$28, "flexGrow", 1);
                _$setProp(_el$28, "flexShrink", 1);
                _$setProp(_el$28, "flexBasis", 0);
                _$setProp(_el$28, "minHeight", 0);
                _$setProp(_el$28, "gap", 2);
                _$insertNode(_el$29, _el$30);
                _$setProp(_el$29, "flexDirection", "column");
                _$setProp(_el$29, "width", 38);
                _$setProp(_el$29, "paddingTop", 1);
                _$setProp(_el$29, "paddingBottom", 1);
                _$insertNode(_el$30, _el$31);
                _$setProp(_el$30, "paddingLeft", 2);
                _$setProp(_el$30, "paddingBottom", 1);
                _$insertNode(_el$31, _el$32);
                _$insertNode(_el$32, _$createTextNode(`JOBS`));
                _$insert(_el$29, _$createComponent(For, {
                  get each() {
                    return sorted();
                  },
                  children: (j, i) => {
                    const isSel = () => i() === index();
                    const dot = () => running().has(j.id) ? "◐" : isActive(j) ? "●" : "○";
                    const when = () => running().has(j.id) ? "running" : isActive(j) ? relative(j.nextRunAt, state.now()) : stateOf(j);
                    const fg = () => isSel() ? t.text.action.primary.focused : undefined;
                    return (() => {
                      var _el$81 = _$createElement("box"),
                        _el$82 = _$createElement("box"),
                        _el$83 = _$createElement("text"),
                        _el$84 = _$createElement("text"),
                        _el$85 = _$createElement("text");
                      _$insertNode(_el$81, _el$82);
                      _$insertNode(_el$81, _el$85);
                      _$setProp(_el$81, "flexDirection", "row");
                      _$setProp(_el$81, "justifyContent", "space-between");
                      _$setProp(_el$81, "paddingLeft", 2);
                      _$setProp(_el$81, "paddingRight", 2);
                      _$insertNode(_el$82, _el$83);
                      _$insertNode(_el$82, _el$84);
                      _$setProp(_el$82, "flexDirection", "row");
                      _$setProp(_el$82, "gap", 1);
                      _$insert(_el$83, dot);
                      _$insert(_el$84, () => j.name.slice(0, 22));
                      _$insert(_el$85, when);
                      _$effect(_p$ => {
                        var _v$33 = isSel() ? t.background.action.primary.focused : undefined,
                          _v$34 = isSel() ? L().ok : running().has(j.id) ? L().warn : L().muted,
                          _v$35 = fg() ?? L().text,
                          _v$36 = fg() ?? L().muted;
                        _v$33 !== _p$.e && (_p$.e = _$setProp(_el$81, "backgroundColor", _v$33, _p$.e));
                        _v$34 !== _p$.t && (_p$.t = _$setProp(_el$83, "fg", _v$34, _p$.t));
                        _v$35 !== _p$.a && (_p$.a = _$setProp(_el$84, "fg", _v$35, _p$.a));
                        _v$36 !== _p$.o && (_p$.o = _$setProp(_el$85, "fg", _v$36, _p$.o));
                        return _p$;
                      }, {
                        e: undefined,
                        t: undefined,
                        a: undefined,
                        o: undefined
                      });
                      return _el$81;
                    })();
                  }
                }), null);
                _$insert(_el$28, _$createComponent(Show, {
                  get when() {
                    return selected();
                  },
                  children: j => (() => {
                    var _el$86 = _$createElement("scrollbox"),
                      _el$87 = _$createElement("box");
                    _$insertNode(_el$86, _el$87);
                    _$setProp(_el$86, "flexGrow", 1);
                    _$setProp(_el$86, "minHeight", 0);
                    _$setProp(_el$87, "flexDirection", "column");
                    _$setProp(_el$87, "gap", 1);
                    _$insert(_el$87, _$createComponent(Block, {
                      title: "Details",
                      hue: 0,
                      get children() {
                        return [(() => {
                          var _el$88 = _$createElement("text"),
                            _el$89 = _$createElement("span"),
                            _el$90 = _$createElement("b"),
                            _el$91 = _$createTextNode(`  `),
                            _el$92 = _$createElement("span"),
                            _el$93 = _$createElement("span"),
                            _el$94 = _$createTextNode(`  `);
                          _$insertNode(_el$88, _el$89);
                          _$insertNode(_el$88, _el$91);
                          _$insertNode(_el$88, _el$92);
                          _$insertNode(_el$88, _el$93);
                          _$insertNode(_el$89, _el$90);
                          _$insert(_el$90, () => j().name);
                          _$insert(_el$92, () => badge(j()).label);
                          _$insertNode(_el$93, _el$94);
                          _$insert(_el$93, () => j().id, null);
                          _$insert(_el$93, () => j().source === "config" ? " · from config" : "", null);
                          _$effect(_p$ => {
                            var _v$37 = {
                                fg: L().text
                              },
                              _v$38 = {
                                fg: badge(j()).fg,
                                bg: badge(j()).bg
                              },
                              _v$39 = {
                                fg: L().muted
                              };
                            _v$37 !== _p$.e && (_p$.e = _$setProp(_el$89, "style", _v$37, _p$.e));
                            _v$38 !== _p$.t && (_p$.t = _$setProp(_el$92, "style", _v$38, _p$.t));
                            _v$39 !== _p$.a && (_p$.a = _$setProp(_el$93, "style", _v$39, _p$.a));
                            return _p$;
                          }, {
                            e: undefined,
                            t: undefined,
                            a: undefined
                          });
                          return _el$88;
                        })(), (() => {
                          var _el$95 = _$createElement("box");
                          _$setProp(_el$95, "flexDirection", "column");
                          _$insert(_el$95, _$createComponent(Field, {
                            label: "schedule",
                            get value() {
                              return describe(j().schedule);
                            }
                          }), null);
                          _$insert(_el$95, _$createComponent(Show, {
                            get when() {
                              return j().on;
                            },
                            children: on => _$createComponent(Field, {
                              label: "channels",
                              get value() {
                                return on().channels.join(", ");
                              }
                            })
                          }), null);
                          _$insert(_el$95, _$createComponent(Field, {
                            label: "next",
                            get value() {
                              return _$memo(() => !!isActive(j()))() ? `${clock(j().nextRunAt)}  (${relative(j().nextRunAt, state.now())})` : "—";
                            }
                          }), null);
                          _$insert(_el$95, _$createComponent(Field, {
                            label: "last",
                            get value() {
                              return _$memo(() => !!j().lastRunAt)() ? `${clock(j().lastRunAt)}  ${j().lastStatus ?? ""}` : "never";
                            },
                            get fg() {
                              return _$memo(() => !!j().lastStatus)() ? statusColor(j().lastStatus) : undefined;
                            }
                          }), null);
                          _$insert(_el$95, _$createComponent(Field, {
                            label: "session",
                            get value() {
                              return j().session + (j().sessionID ? `  ${j().sessionID}` : "");
                            }
                          }), null);
                          _$insert(_el$95, _$createComponent(Field, {
                            label: "agent",
                            get value() {
                              return j().agent ?? "default";
                            }
                          }), null);
                          _$insert(_el$95, _$createComponent(Field, {
                            label: "model",
                            get value() {
                              return _$memo(() => j().session === "current")() ? "chat's model" : j().model ?? "agent default";
                            }
                          }), null);
                          _$insert(_el$95, _$createComponent(Field, {
                            label: "directory",
                            get value() {
                              return ctx.ui.format.path(j().directory);
                            }
                          }), null);
                          _$insert(_el$95, _$createComponent(Field, {
                            label: "timeout",
                            get value() {
                              return `${j().timeoutMinutes}m · run missed ${j().runMissed ? "on" : "off"}`;
                            }
                          }), null);
                          return _el$95;
                        })()];
                      }
                    }), null);
                    _$insert(_el$87, _$createComponent(Block, {
                      title: "Prompt",
                      hue: 1,
                      get children() {
                        var _el$96 = _$createElement("text");
                        _$insert(_el$96, () => j().prompt);
                        _$effect(_$p => _$setProp(_el$96, "fg", L().text, _$p));
                        return _el$96;
                      }
                    }), null);
                    _$insert(_el$87, _$createComponent(Block, {
                      title: "Recent runs",
                      hue: 2,
                      get children() {
                        return _$createComponent(Show, {
                          get when() {
                            return jobRuns().length;
                          },
                          get fallback() {
                            return (() => {
                              var _el$98 = _$createElement("text");
                              _$insertNode(_el$98, _$createTextNode(`none yet`));
                              _$effect(_$p => _$setProp(_el$98, "fg", L().muted, _$p));
                              return _el$98;
                            })();
                          },
                          get children() {
                            var _el$97 = _$createElement("box");
                            _$setProp(_el$97, "flexDirection", "column");
                            _$insert(_el$97, _$createComponent(For, {
                              get each() {
                                return jobRuns();
                              },
                              children: r => (() => {
                                var _el$100 = _$createElement("box"),
                                  _el$101 = _$createElement("text"),
                                  _el$102 = _$createElement("span"),
                                  _el$103 = _$createTextNode(` `),
                                  _el$104 = _$createElement("span"),
                                  _el$105 = _$createTextNode(`  `),
                                  _el$106 = _$createTextNode(` `);
                                _$insertNode(_el$100, _el$101);
                                _$setProp(_el$100, "flexDirection", "column");
                                _$insertNode(_el$101, _el$102);
                                _$insertNode(_el$101, _el$103);
                                _$insertNode(_el$101, _el$104);
                                _$insert(_el$102, () => glyph[r.status]);
                                _$insert(_el$101, () => clock(r.startedAt), _el$104);
                                _$insertNode(_el$104, _el$105);
                                _$insertNode(_el$104, _el$106);
                                _$insert(_el$104, () => r.status, _el$106);
                                _$insert(_el$104, () => duration(r), null);
                                _$insert(_el$100, _$createComponent(Show, {
                                  get when() {
                                    return r.error ?? firstLine(r.output);
                                  },
                                  children: line => (() => {
                                    var _el$107 = _$createElement("text");
                                    _$insert(_el$107, () => "  " + line().slice(0, 100));
                                    _$effect(_$p => _$setProp(_el$107, "fg", r.error ? L().bad : L().muted, _$p));
                                    return _el$107;
                                  })()
                                }), null);
                                _$effect(_p$ => {
                                  var _v$40 = L().text,
                                    _v$41 = {
                                      fg: statusColor(r.status)
                                    },
                                    _v$42 = {
                                      fg: L().muted
                                    };
                                  _v$40 !== _p$.e && (_p$.e = _$setProp(_el$101, "fg", _v$40, _p$.e));
                                  _v$41 !== _p$.t && (_p$.t = _$setProp(_el$102, "style", _v$41, _p$.t));
                                  _v$42 !== _p$.a && (_p$.a = _$setProp(_el$104, "style", _v$42, _p$.a));
                                  return _p$;
                                }, {
                                  e: undefined,
                                  t: undefined,
                                  a: undefined
                                });
                                return _el$100;
                              })()
                            }));
                            return _el$97;
                          }
                        });
                      }
                    }), null);
                    return _el$86;
                  })()
                }), null);
                _$effect(_p$ => {
                  var _v$7 = L().panel,
                    _v$8 = L().muted;
                  _v$7 !== _p$.e && (_p$.e = _$setProp(_el$29, "backgroundColor", _v$7, _p$.e));
                  _v$8 !== _p$.t && (_p$.t = _$setProp(_el$31, "fg", _v$8, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$28;
              }
            });
          }
        }), _el$34);
        _$setProp(_el$34, "flexDirection", "row");
        _$setProp(_el$34, "flexWrap", "wrap");
        _$setProp(_el$34, "paddingTop", 1);
        _$setProp(_el$34, "paddingBottom", 1);
        _$setProp(_el$34, "columnGap", 2);
        _$setProp(_el$34, "flexShrink", 0);
        _$insert(_el$34, _$createComponent(For, {
          get each() {
            return onChannels() ? channelHints : keyHints;
          },
          children: ([key, label]) => (() => {
            var _el$108 = _$createElement("text"),
              _el$109 = _$createElement("span"),
              _el$110 = _$createTextNode(` `),
              _el$111 = _$createTextNode(` `),
              _el$112 = _$createElement("span"),
              _el$113 = _$createTextNode(` `);
            _$insertNode(_el$108, _el$109);
            _$insertNode(_el$108, _el$112);
            _$insertNode(_el$109, _el$110);
            _$insertNode(_el$109, _el$111);
            _$insert(_el$109, key, _el$111);
            _$insertNode(_el$112, _el$113);
            _$insert(_el$112, label, null);
            _$effect(_p$ => {
              var _v$43 = {
                  fg: L().text,
                  bg: L().cap
                },
                _v$44 = {
                  fg: L().muted
                };
              _v$43 !== _p$.e && (_p$.e = _$setProp(_el$109, "style", _v$43, _p$.e));
              _v$44 !== _p$.t && (_p$.t = _$setProp(_el$112, "style", _v$44, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$108;
          })()
        }));
        _$effect(_p$ => {
          var _v$9 = p().left,
            _v$0 = p().top,
            _v$1 = p().width,
            _v$10 = p().height,
            _v$11 = t.background.base,
            _v$12 = L().text,
            _v$13 = onChannels() ? L().muted : L().ink(0),
            _v$14 = onChannels() ? L().ink(0) : L().muted;
          _v$9 !== _p$.e && (_p$.e = _$setProp(_el$8, "left", _v$9, _p$.e));
          _v$0 !== _p$.t && (_p$.t = _$setProp(_el$8, "top", _v$0, _p$.t));
          _v$1 !== _p$.a && (_p$.a = _$setProp(_el$8, "width", _v$1, _p$.a));
          _v$10 !== _p$.o && (_p$.o = _$setProp(_el$8, "height", _v$10, _p$.o));
          _v$11 !== _p$.i && (_p$.i = _$setProp(_el$8, "backgroundColor", _v$11, _p$.i));
          _v$12 !== _p$.n && (_p$.n = _$setProp(_el$1, "fg", _v$12, _p$.n));
          _v$13 !== _p$.s && (_p$.s = _$setProp(_el$12, "fg", _v$13, _p$.s));
          _v$14 !== _p$.h && (_p$.h = _$setProp(_el$13, "fg", _v$14, _p$.h));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined,
          i: undefined,
          n: undefined,
          s: undefined,
          h: undefined
        });
        return _el$8;
      })()
    }));
    return _el$7;
  })();
}
function SidebarSection(props) {
  const {
    ctx,
    state
  } = props;
  const L = createMemo(() => look(ctx));
  const upcoming = createMemo(() => state.jobs().filter(isActive).sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)).slice(0, 4));
  const thisRun = createMemo(() => state.runs().find(r => r.sessionID === props.sessionID));
  return _$createComponent(Show, {
    get when() {
      return state.jobs().length || thisRun();
    },
    get children() {
      var _el$114 = _$createElement("box"),
        _el$115 = _$createElement("text"),
        _el$116 = _$createElement("b"),
        _el$118 = _$createElement("text");
      _$insertNode(_el$114, _el$115);
      _$insertNode(_el$114, _el$118);
      _$setProp(_el$114, "flexDirection", "column");
      _$setProp(_el$114, "marginTop", 1);
      _$setProp(_el$114, "paddingLeft", 1);
      _$setProp(_el$114, "paddingRight", 1);
      _$setProp(_el$114, "paddingTop", 1);
      _$setProp(_el$114, "paddingBottom", 1);
      _$insertNode(_el$115, _el$116);
      _$insertNode(_el$116, _$createTextNode(`⏰ Automations`));
      _$insert(_el$114, _$createComponent(Show, {
        get when() {
          return thisRun();
        },
        children: r => (() => {
          var _el$120 = _$createElement("text"),
            _el$121 = _$createTextNode(`this session: `),
            _el$122 = _$createTextNode(` `);
          _$insertNode(_el$120, _el$121);
          _$insertNode(_el$120, _el$122);
          _$insert(_el$120, () => r().jobID, _el$122);
          _$insert(_el$120, () => glyph[r().status], null);
          _$effect(_$p => _$setProp(_el$120, "fg", L().info, _$p));
          return _el$120;
        })()
      }), _el$118);
      _$insert(_el$114, _$createComponent(For, {
        get each() {
          return upcoming();
        },
        children: j => (() => {
          var _el$123 = _$createElement("box"),
            _el$124 = _$createElement("text"),
            _el$125 = _$createElement("text");
          _$insertNode(_el$123, _el$124);
          _$insertNode(_el$123, _el$125);
          _$setProp(_el$123, "flexDirection", "row");
          _$setProp(_el$123, "justifyContent", "space-between");
          _$insert(_el$124, () => j.name.slice(0, 18));
          _$insert(_el$125, () => relative(j.nextRunAt, state.now()));
          _$effect(_p$ => {
            var _v$48 = L().text,
              _v$49 = L().muted;
            _v$48 !== _p$.e && (_p$.e = _$setProp(_el$124, "fg", _v$48, _p$.e));
            _v$49 !== _p$.t && (_p$.t = _$setProp(_el$125, "fg", _v$49, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$123;
        })()
      }), _el$118);
      _$insertNode(_el$118, _$createTextNode(`/automations`));
      _$effect(_p$ => {
        var _v$45 = L().panel,
          _v$46 = L().ink(0),
          _v$47 = L().faint;
        _v$45 !== _p$.e && (_p$.e = _$setProp(_el$114, "backgroundColor", _v$45, _p$.e));
        _v$46 !== _p$.t && (_p$.t = _$setProp(_el$115, "fg", _v$46, _p$.t));
        _v$47 !== _p$.a && (_p$.a = _$setProp(_el$118, "fg", _v$47, _p$.a));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined
      });
      return _el$114;
    }
  });
}
export default Plugin.define({
  id: "automations.tui",
  setup: ctx => {
    const dataDir = typeof ctx.options.dataDir === "string" ? ctx.options.dataDir : defaultDataDir();
    const state = createState(ctx, dataDir);

    // Live updates: atomic renames + appends in the data dir, plus a slow tick for "in 12m" labels.
    let debounce;
    let watcher;
    try {
      watcher = watch(dataDir, (_event, file) => {
        // Lock directories and temp files come and go around every write; the rename that follows is what counts.
        if (file && /\.(lock|tmp)$/.test(String(file))) return;
        clearTimeout(debounce);
        debounce = setTimeout(state.refresh, 150);
      });
    } catch {}
    const ticker = setInterval(state.refresh, 15_000);

    // Shown as a dialog over the current screen rather than a routed page, which opencode puts in its own tab.
    const open = () => {
      ctx.ui.dialog.show(() => _$createComponent(AutomationsView, {
        ctx: ctx,
        state: state,
        reopen: open
      }));
      ctx.ui.dialog.set({
        size: "xlarge",
        centered: true
      });
    };
    const unregister = [ctx.ui.slot({
      append: "sidebar.content",
      render: input => _$createComponent(SidebarSection, {
        ctx: ctx,
        state: state,
        get sessionID() {
          return input.sessionID;
        }
      })
    })];

    // Register directly in setup: a detached Solid root masks the host's keymap provider.
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "automations.open",
        title: "Automations",
        description: "View and manage automations",
        group: "Automations",
        palette: true,
        slash: {
          name: "automations"
        },
        run: open
      }]
    }));
    return () => {
      watcher?.close();
      clearTimeout(debounce);
      clearInterval(ticker);
      for (const u of unregister) u();
    };
  }
});
