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
// Reads the same jobs.json / history.jsonl the server plugin writes, and writes *intents*
// back (pause, edit, delete, run-now). The server leader executes them on its next tick,
// so there is still exactly one firer and one run history.

import { Plugin } from "@opencode/plugin/tui";
import { watch } from "node:fs";
import { createMemo, createSignal, For, Index, Show } from "solid-js";
import { describe, nextRun } from "./cron.ts";
import { DEFAULT_TIMEOUT_MINUTES, defaultDataDir, isActive, listens, newJob, parseScheduleText, runnable, runningJobs, stateOf } from "./jobs.ts";
import { clock, elapsed, errorMessage, plural, relative } from "./util.ts";
import { Store } from "./store.ts";
import { channelRows, emptyChannels, removeChannel, requestPoll } from "./channels.ts";
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
    panel: t.background.raised.base,
    cap: t.background.raised.high,
    /** Softly tinted block background for section i. */
    tint: i => hue(i)[dark ? 900 : 100],
    /** Readable heading color on that tint. */
    ink: i => hue(i)[dark ? 300 : 700]
  };
}
const keyHints = [["c", "channels"], ["↑↓", "select"], ["space", "pause"], ["r", "run now"], ["n", "new"], ["e", "prompt"], ["s", "schedule"], ["m", "model"], ["d", "delete"], ["⏎", "open session"], ["esc", "close"]];
const channelHints = [["c", "automations"], ["↑↓", "select"], ["p", "poll now"], ["d", "delete"], ["esc", "close"]];

/** The TUI waits only briefly for the channels lock (the server may hold it), so the screen never freezes for long. */
const LOCK_WAIT_MS = 200;
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
    let next;
    // Runs from a timer and the file watcher: a file that can't be read now keeps what is shown.
    try {
      setJobs(store.loadJobs());
      next = store.history(undefined, 300);
    } catch {
      return;
    }
    setChannels(loadChannels());
    setRuns(next);
    setNow(Date.now());
    for (const r of next) {
      if (r.status === "running" || seen.has(r.runID)) continue;
      seen.add(r.runID);
      if (r.status === "skipped") continue;
      const job = jobs().find(j => j.id === r.jobID);
      const title = `⏰ ${job?.name ?? r.jobID} ${r.status}`;
      const message = r.error ?? elapsed(r);
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

  /** Do a write and re-read. Resolves to an error message instead of throwing (callers toast it). */
  async function attempt(write) {
    try {
      await write();
      refresh();
    } catch (e) {
      return errorMessage(e);
    }
  }
  const act = fn => attempt(() => store.mutate(fn));
  const actChannels = fn => attempt(() => store.mutateChannels(fn, LOCK_WAIT_MS));
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
  const running = createMemo(() => runningJobs(state.jobs(), state.runs(), state.now()));

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
      if (ok) await toastErr(state.act(jobs => {
        // Already gone (deleted from chat or another TUI): splice(-1) would remove another automation.
        const i = jobs.findIndex(x => x.id === j.id);
        if (i >= 0) jobs.splice(i, 1);
      }));
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
        return toastErr(errorMessage(e));
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
        jobs.push(newJob(jobs, {
          name: name.trim(),
          prompt: prompt.trim(),
          schedule,
          directory,
          session,
          timeoutMinutes: DEFAULT_TIMEOUT_MINUTES
        }));
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
  /** One line of the jobs or channels list: status dot, name, and when it next happens. */
  const Row = p => {
    const fg = () => p.selected ? t.text.action.primary.focused : undefined;
    return (() => {
      var _el$4 = _$createElement("box"),
        _el$5 = _$createElement("box"),
        _el$6 = _$createElement("text"),
        _el$7 = _$createElement("text"),
        _el$8 = _$createElement("text");
      _$insertNode(_el$4, _el$5);
      _$insertNode(_el$4, _el$8);
      _$setProp(_el$4, "flexDirection", "row");
      _$setProp(_el$4, "justifyContent", "space-between");
      _$setProp(_el$4, "paddingLeft", 2);
      _$setProp(_el$4, "paddingRight", 2);
      _$insertNode(_el$5, _el$6);
      _$insertNode(_el$5, _el$7);
      _$setProp(_el$5, "flexDirection", "row");
      _$setProp(_el$5, "gap", 1);
      _$insert(_el$6, () => p.dot);
      _$insert(_el$7, () => p.name.slice(0, 22));
      _$insert(_el$8, () => p.when);
      _$effect(_p$ => {
        var _v$ = p.selected ? t.background.action.primary.focused : undefined,
          _v$2 = p.dotFg,
          _v$3 = fg() ?? L().text,
          _v$4 = fg() ?? L().muted;
        _v$ !== _p$.e && (_p$.e = _$setProp(_el$4, "backgroundColor", _v$, _p$.e));
        _v$2 !== _p$.t && (_p$.t = _$setProp(_el$6, "fg", _v$2, _p$.t));
        _v$3 !== _p$.a && (_p$.a = _$setProp(_el$7, "fg", _v$3, _p$.a));
        _v$4 !== _p$.o && (_p$.o = _$setProp(_el$8, "fg", _v$4, _p$.o));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined,
        o: undefined
      });
      return _el$4;
    })();
  };
  const Field = p => (() => {
    var _el$9 = _$createElement("text"),
      _el$0 = _$createElement("span"),
      _el$1 = _$createElement("span");
    _$insertNode(_el$9, _el$0);
    _$insertNode(_el$9, _el$1);
    _$insert(_el$0, () => p.label.padEnd(11));
    _$insert(_el$1, () => p.value);
    _$effect(_p$ => {
      var _v$5 = {
          fg: L().muted
        },
        _v$6 = {
          fg: p.fg ?? L().text
        };
      _v$5 !== _p$.e && (_p$.e = _$setProp(_el$0, "style", _v$5, _p$.e));
      _v$6 !== _p$.t && (_p$.t = _$setProp(_el$1, "style", _v$6, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$9;
  })();
  return (() => {
    var _el$10 = _$createElement("box");
    _$setProp(_el$10, "renderBefore", track);
    _$insert(_el$10, _$createComponent(Show, {
      get when() {
        return panel();
      },
      children: p => (() => {
        var _el$11 = _$createElement("box"),
          _el$12 = _$createElement("box"),
          _el$13 = _$createElement("box"),
          _el$14 = _$createElement("text"),
          _el$15 = _$createElement("b"),
          _el$17 = _$createElement("text"),
          _el$18 = _$createElement("text"),
          _el$38 = _$createElement("box");
        _$insertNode(_el$11, _el$12);
        _$insertNode(_el$11, _el$38);
        _$setProp(_el$11, "position", "absolute");
        _$setProp(_el$11, "zIndex", 10);
        _$setProp(_el$11, "flexDirection", "column");
        _$setProp(_el$11, "paddingLeft", 2);
        _$setProp(_el$11, "paddingRight", 2);
        _$setProp(_el$11, "paddingTop", 1);
        _$insertNode(_el$12, _el$13);
        _$setProp(_el$12, "flexDirection", "row");
        _$setProp(_el$12, "justifyContent", "space-between");
        _$setProp(_el$12, "paddingBottom", 1);
        _$setProp(_el$12, "flexShrink", 0);
        _$insertNode(_el$13, _el$14);
        _$insertNode(_el$13, _el$17);
        _$insertNode(_el$13, _el$18);
        _$setProp(_el$13, "flexDirection", "row");
        _$setProp(_el$13, "gap", 2);
        _$insertNode(_el$14, _el$15);
        _$insertNode(_el$15, _$createTextNode(`⏰ Automations`));
        _$insert(_el$17, () => onChannels() ? " jobs " : "[jobs]");
        _$insert(_el$18, () => onChannels() ? "[channels]" : " channels ");
        _$insert(_el$12, _$createComponent(Show, {
          get when() {
            return onChannels();
          },
          get fallback() {
            return (() => {
              var _el$39 = _$createElement("text"),
                _el$40 = _$createTextNode(` · `),
                _el$41 = _$createTextNode(` active · `),
                _el$43 = _$createElement("span"),
                _el$44 = _$createTextNode(` running`);
              _$insertNode(_el$39, _el$40);
              _$insertNode(_el$39, _el$41);
              _$insertNode(_el$39, _el$43);
              _$insert(_el$39, () => plural(state.jobs().length, "job"), _el$40);
              _$insert(_el$39, activeCount, _el$41);
              _$insertNode(_el$43, _el$44);
              _$insert(_el$43, () => running().size, _el$44);
              _$effect(_p$ => {
                var _v$19 = L().muted,
                  _v$20 = {
                    fg: running().size ? L().warn : L().muted
                  };
                _v$19 !== _p$.e && (_p$.e = _$setProp(_el$39, "fg", _v$19, _p$.e));
                _v$20 !== _p$.t && (_p$.t = _$setProp(_el$43, "style", _v$20, _p$.t));
                return _p$;
              }, {
                e: undefined,
                t: undefined
              });
              return _el$39;
            })();
          },
          get children() {
            var _el$19 = _$createElement("text"),
              _el$20 = _$createTextNode(` · `),
              _el$22 = _$createTextNode(` polled · `),
              _el$24 = _$createElement("span"),
              _el$25 = _$createTextNode(` failing`);
            _$insertNode(_el$19, _el$20);
            _$insertNode(_el$19, _el$22);
            _$insertNode(_el$19, _el$24);
            _$insert(_el$19, () => plural(chRows().length, "channel"), _el$20);
            _$insert(_el$19, () => chRows().filter(c => chStatus(c) !== "idle").length, _el$22);
            _$insertNode(_el$24, _el$25);
            _$insert(_el$24, () => chRows().filter(c => chStatus(c) === "failing").length, _el$25);
            _$effect(_p$ => {
              var _v$7 = L().muted,
                _v$8 = {
                  fg: chRows().some(c => chStatus(c) === "failing") ? L().bad : L().muted
                };
              _v$7 !== _p$.e && (_p$.e = _$setProp(_el$19, "fg", _v$7, _p$.e));
              _v$8 !== _p$.t && (_p$.t = _$setProp(_el$24, "style", _v$8, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$19;
          }
        }), null);
        _$insert(_el$11, _$createComponent(Show, {
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
                  var _el$45 = _$createElement("box"),
                    _el$46 = _$createElement("text"),
                    _el$48 = _$createElement("text");
                  _$insertNode(_el$45, _el$46);
                  _$insertNode(_el$45, _el$48);
                  _$setProp(_el$45, "padding", 2);
                  _$setProp(_el$45, "flexDirection", "column");
                  _$setProp(_el$45, "gap", 1);
                  _$insertNode(_el$46, _$createTextNode(`No channels yet.`));
                  _$insertNode(_el$48, _$createTextNode(`Ask in chat: “/channel alert me about Datadog monitors that start alerting”.`));
                  _$effect(_p$ => {
                    var _v$21 = L().panel,
                      _v$22 = L().text,
                      _v$23 = L().muted;
                    _v$21 !== _p$.e && (_p$.e = _$setProp(_el$45, "backgroundColor", _v$21, _p$.e));
                    _v$22 !== _p$.t && (_p$.t = _$setProp(_el$46, "fg", _v$22, _p$.t));
                    _v$23 !== _p$.a && (_p$.a = _$setProp(_el$48, "fg", _v$23, _p$.a));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined
                  });
                  return _el$45;
                })();
              },
              get children() {
                var _el$26 = _$createElement("box"),
                  _el$27 = _$createElement("box"),
                  _el$28 = _$createElement("box"),
                  _el$29 = _$createElement("text"),
                  _el$30 = _$createElement("b");
                _$insertNode(_el$26, _el$27);
                _$setProp(_el$26, "flexDirection", "row");
                _$setProp(_el$26, "flexGrow", 1);
                _$setProp(_el$26, "flexShrink", 1);
                _$setProp(_el$26, "flexBasis", 0);
                _$setProp(_el$26, "minHeight", 0);
                _$setProp(_el$26, "gap", 2);
                _$insertNode(_el$27, _el$28);
                _$setProp(_el$27, "flexDirection", "column");
                _$setProp(_el$27, "width", 38);
                _$setProp(_el$27, "paddingTop", 1);
                _$setProp(_el$27, "paddingBottom", 1);
                _$insertNode(_el$28, _el$29);
                _$setProp(_el$28, "paddingLeft", 2);
                _$setProp(_el$28, "paddingBottom", 1);
                _$insertNode(_el$29, _el$30);
                _$insertNode(_el$30, _$createTextNode(`CHANNELS`));
                _$insert(_el$27, _$createComponent(Index, {
                  get each() {
                    return chRows();
                  },
                  children: (c, i) => {
                    const isSel = () => i === chIndex();
                    const status = () => chStatus(c());
                    const src = () => state.channels().sources[c().id];
                    const when = () => status() === "idle" ? "idle" : src()?.lastPollAt ? relative(src().lastPollAt, state.now()) : "soon";
                    return _$createComponent(Row, {
                      get selected() {
                        return isSel();
                      },
                      get dot() {
                        return statusLook(status()).dot;
                      },
                      get dotFg() {
                        return statusLook(status()).fg;
                      },
                      get name() {
                        return c().name;
                      },
                      get when() {
                        return when();
                      }
                    });
                  }
                }), null);
                _$insert(_el$26, _$createComponent(Show, {
                  get when() {
                    return chSelected();
                  },
                  children: c => {
                    const src = () => state.channels().sources[c().id];
                    const users = () => listeners(c().id);
                    const waiting = createMemo(() => {
                      const out = new Map();
                      for (const j of users()) out.set(j.id, state.channels().queues[j.id]?.pending.filter(e => e.channel === c().id) ?? []);
                      return out;
                    });
                    const queue = id => waiting().get(id) ?? [];
                    const status = () => chStatus(c());
                    return (() => {
                      var _el$50 = _$createElement("scrollbox"),
                        _el$51 = _$createElement("box");
                      _$insertNode(_el$50, _el$51);
                      _$setProp(_el$50, "flexGrow", 1);
                      _$setProp(_el$50, "minHeight", 0);
                      _$setProp(_el$51, "flexDirection", "column");
                      _$setProp(_el$51, "gap", 1);
                      _$insert(_el$51, _$createComponent(Block, {
                        title: "Channel",
                        hue: 0,
                        get children() {
                          return [(() => {
                            var _el$52 = _$createElement("text"),
                              _el$53 = _$createElement("span"),
                              _el$54 = _$createElement("b"),
                              _el$55 = _$createTextNode(`  `),
                              _el$56 = _$createElement("span"),
                              _el$57 = _$createElement("span"),
                              _el$58 = _$createTextNode(`  `),
                              _el$59 = _$createTextNode(` · `);
                            _$insertNode(_el$52, _el$53);
                            _$insertNode(_el$52, _el$55);
                            _$insertNode(_el$52, _el$56);
                            _$insertNode(_el$52, _el$57);
                            _$insertNode(_el$53, _el$54);
                            _$insert(_el$54, () => c().name);
                            _$insert(_el$56, () => ` ${status()} `);
                            _$insertNode(_el$57, _el$58);
                            _$insertNode(_el$57, _el$59);
                            _$insert(_el$57, () => c().id, _el$59);
                            _$insert(_el$57, () => c().source === "config" ? "from config" : "created from chat", null);
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
                              _v$24 !== _p$.e && (_p$.e = _$setProp(_el$53, "style", _v$24, _p$.e));
                              _v$25 !== _p$.t && (_p$.t = _$setProp(_el$56, "style", _v$25, _p$.t));
                              _v$26 !== _p$.a && (_p$.a = _$setProp(_el$57, "style", _v$26, _p$.a));
                              return _p$;
                            }, {
                              e: undefined,
                              t: undefined,
                              a: undefined
                            });
                            return _el$52;
                          })(), (() => {
                            var _el$60 = _$createElement("box");
                            _$setProp(_el$60, "flexDirection", "column");
                            _$insert(_el$60, _$createComponent(Field, {
                              label: "polls",
                              get value() {
                                return c().url;
                              }
                            }), null);
                            _$insert(_el$60, _$createComponent(Field, {
                              label: "every",
                              get value() {
                                return describe({
                                  kind: "every",
                                  ms: c().everyMs || 60_000
                                }).replace(/^every /, "");
                              }
                            }), null);
                            _$insert(_el$60, _$createComponent(Field, {
                              label: "last poll",
                              get value() {
                                return _$memo(() => !!src()?.lastPollAt)() ? `${clock(src().lastPollAt)}  (${relative(src().lastPollAt, state.now())})` : "never";
                              }
                            }), null);
                            _$insert(_el$60, _$createComponent(Field, {
                              label: "last ok",
                              get value() {
                                return _$memo(() => !!src()?.lastOkAt)() ? clock(src().lastOkAt) : "never";
                              }
                            }), null);
                            _$insert(_el$60, _$createComponent(Show, {
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
                            _$insert(_el$60, _$createComponent(Field, {
                              label: "env",
                              get value() {
                                return _$memo(() => !!c().env.length)() ? c().env.join(", ") : "none";
                              }
                            }), null);
                            return _el$60;
                          })()];
                        }
                      }), null);
                      _$insert(_el$51, _$createComponent(Block, {
                        title: "Mapping",
                        hue: 1,
                        get children() {
                          var _el$61 = _$createElement("box");
                          _$setProp(_el$61, "flexDirection", "column");
                          _$insert(_el$61, _$createComponent(Field, {
                            label: "items",
                            get value() {
                              return c().items || "(the response)";
                            }
                          }), null);
                          _$insert(_el$61, _$createComponent(Field, {
                            label: "filter",
                            get value() {
                              return _$memo(() => !!Object.keys(c().filter).length)() ? JSON.stringify(c().filter) : "none";
                            }
                          }), null);
                          _$insert(_el$61, _$createComponent(Field, {
                            label: "event id",
                            get value() {
                              return c().event.id;
                            }
                          }), null);
                          _$insert(_el$61, _$createComponent(Field, {
                            label: "sessionKey",
                            get value() {
                              return c().event.sessionKey ?? "none";
                            }
                          }), null);
                          _$insert(_el$61, _$createComponent(Field, {
                            label: "title",
                            get value() {
                              return c().event.title ?? "(event id)";
                            }
                          }), null);
                          _$insert(_el$61, _$createComponent(Show, {
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
                          _$insert(_el$61, _$createComponent(Show, {
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
                          return _el$61;
                        }
                      }), null);
                      _$insert(_el$51, _$createComponent(Block, {
                        title: "Automations",
                        hue: 2,
                        get children() {
                          return _$createComponent(Show, {
                            get when() {
                              return users().length;
                            },
                            get fallback() {
                              return (() => {
                                var _el$63 = _$createElement("text");
                                _$insertNode(_el$63, _$createTextNode(`none use it, so it isn't polled`));
                                _$effect(_$p => _$setProp(_el$63, "fg", L().muted, _$p));
                                return _el$63;
                              })();
                            },
                            get children() {
                              var _el$62 = _$createElement("box");
                              _$setProp(_el$62, "flexDirection", "column");
                              _$setProp(_el$62, "gap", 1);
                              _$insert(_el$62, _$createComponent(For, {
                                get each() {
                                  return users();
                                },
                                children: j => (() => {
                                  var _el$65 = _$createElement("box"),
                                    _el$66 = _$createElement("text"),
                                    _el$67 = _$createElement("span"),
                                    _el$68 = _$createTextNode(` `),
                                    _el$69 = _$createElement("span"),
                                    _el$70 = _$createTextNode(`  `),
                                    _el$71 = _$createTextNode(` · `),
                                    _el$72 = _$createTextNode(` waiting`);
                                  _$insertNode(_el$65, _el$66);
                                  _$setProp(_el$65, "flexDirection", "column");
                                  _$insertNode(_el$66, _el$67);
                                  _$insertNode(_el$66, _el$68);
                                  _$insertNode(_el$66, _el$69);
                                  _$insert(_el$67, () => isActive(j) ? "●" : "○");
                                  _$insert(_el$66, () => j.name, _el$69);
                                  _$insertNode(_el$69, _el$70);
                                  _$insertNode(_el$69, _el$71);
                                  _$insertNode(_el$69, _el$72);
                                  _$insert(_el$69, (() => {
                                    var _c$ = _$memo(() => j.schedule.kind === "event");
                                    return () => _c$() ? "as events arrive" : describe(j.schedule);
                                  })(), _el$71);
                                  _$insert(_el$69, () => queue(j.id).length, _el$72);
                                  _$insert(_el$65, _$createComponent(For, {
                                    get each() {
                                      return queue(j.id).slice(0, 3);
                                    },
                                    children: e => (() => {
                                      var _el$73 = _$createElement("text");
                                      _$insert(_el$73, () => "  " + e.title.slice(0, 90));
                                      _$effect(_$p => _$setProp(_el$73, "fg", L().muted, _$p));
                                      return _el$73;
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
                                    _v$27 !== _p$.e && (_p$.e = _$setProp(_el$66, "fg", _v$27, _p$.e));
                                    _v$28 !== _p$.t && (_p$.t = _$setProp(_el$67, "style", _v$28, _p$.t));
                                    _v$29 !== _p$.a && (_p$.a = _$setProp(_el$69, "style", _v$29, _p$.a));
                                    return _p$;
                                  }, {
                                    e: undefined,
                                    t: undefined,
                                    a: undefined
                                  });
                                  return _el$65;
                                })()
                              }));
                              return _el$62;
                            }
                          });
                        }
                      }), null);
                      return _el$50;
                    })();
                  }
                }), null);
                _$effect(_p$ => {
                  var _v$9 = L().panel,
                    _v$0 = L().muted;
                  _v$9 !== _p$.e && (_p$.e = _$setProp(_el$27, "backgroundColor", _v$9, _p$.e));
                  _v$0 !== _p$.t && (_p$.t = _$setProp(_el$29, "fg", _v$0, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$26;
              }
            });
          }
        }), _el$38);
        _$insert(_el$11, _$createComponent(Show, {
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
                  var _el$74 = _$createElement("box"),
                    _el$75 = _$createElement("text"),
                    _el$77 = _$createElement("text");
                  _$insertNode(_el$74, _el$75);
                  _$insertNode(_el$74, _el$77);
                  _$setProp(_el$74, "padding", 2);
                  _$setProp(_el$74, "flexDirection", "column");
                  _$setProp(_el$74, "gap", 1);
                  _$insertNode(_el$75, _$createTextNode(`No automations yet.`));
                  _$insertNode(_el$77, _$createTextNode(`Press n to create one, or ask in chat: “every weekday at 8:45, triage my open MRs”.`));
                  _$effect(_p$ => {
                    var _v$30 = L().panel,
                      _v$31 = L().text,
                      _v$32 = L().muted;
                    _v$30 !== _p$.e && (_p$.e = _$setProp(_el$74, "backgroundColor", _v$30, _p$.e));
                    _v$31 !== _p$.t && (_p$.t = _$setProp(_el$75, "fg", _v$31, _p$.t));
                    _v$32 !== _p$.a && (_p$.a = _$setProp(_el$77, "fg", _v$32, _p$.a));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined
                  });
                  return _el$74;
                })();
              },
              get children() {
                var _el$32 = _$createElement("box"),
                  _el$33 = _$createElement("box"),
                  _el$34 = _$createElement("box"),
                  _el$35 = _$createElement("text"),
                  _el$36 = _$createElement("b");
                _$insertNode(_el$32, _el$33);
                _$setProp(_el$32, "flexDirection", "row");
                _$setProp(_el$32, "flexGrow", 1);
                _$setProp(_el$32, "flexShrink", 1);
                _$setProp(_el$32, "flexBasis", 0);
                _$setProp(_el$32, "minHeight", 0);
                _$setProp(_el$32, "gap", 2);
                _$insertNode(_el$33, _el$34);
                _$setProp(_el$33, "flexDirection", "column");
                _$setProp(_el$33, "width", 38);
                _$setProp(_el$33, "paddingTop", 1);
                _$setProp(_el$33, "paddingBottom", 1);
                _$insertNode(_el$34, _el$35);
                _$setProp(_el$34, "paddingLeft", 2);
                _$setProp(_el$34, "paddingBottom", 1);
                _$insertNode(_el$35, _el$36);
                _$insertNode(_el$36, _$createTextNode(`JOBS`));
                _$insert(_el$33, _$createComponent(For, {
                  get each() {
                    return sorted();
                  },
                  children: (j, i) => {
                    const isSel = () => i() === index();
                    const dot = () => running().has(j.id) ? "◐" : isActive(j) ? "●" : "○";
                    const when = () => running().has(j.id) ? "running" : isActive(j) ? relative(j.nextRunAt, state.now()) : stateOf(j);
                    const dotFg = () => isSel() ? L().ok : running().has(j.id) ? L().warn : L().muted;
                    return _$createComponent(Row, {
                      get selected() {
                        return isSel();
                      },
                      get dot() {
                        return dot();
                      },
                      get dotFg() {
                        return dotFg();
                      },
                      get name() {
                        return j.name;
                      },
                      get when() {
                        return when();
                      }
                    });
                  }
                }), null);
                _$insert(_el$32, _$createComponent(Show, {
                  get when() {
                    return selected();
                  },
                  children: j => (() => {
                    var _el$79 = _$createElement("scrollbox"),
                      _el$80 = _$createElement("box");
                    _$insertNode(_el$79, _el$80);
                    _$setProp(_el$79, "flexGrow", 1);
                    _$setProp(_el$79, "minHeight", 0);
                    _$setProp(_el$80, "flexDirection", "column");
                    _$setProp(_el$80, "gap", 1);
                    _$insert(_el$80, _$createComponent(Block, {
                      title: "Details",
                      hue: 0,
                      get children() {
                        return [(() => {
                          var _el$81 = _$createElement("text"),
                            _el$82 = _$createElement("span"),
                            _el$83 = _$createElement("b"),
                            _el$84 = _$createTextNode(`  `),
                            _el$85 = _$createElement("span"),
                            _el$86 = _$createElement("span"),
                            _el$87 = _$createTextNode(`  `);
                          _$insertNode(_el$81, _el$82);
                          _$insertNode(_el$81, _el$84);
                          _$insertNode(_el$81, _el$85);
                          _$insertNode(_el$81, _el$86);
                          _$insertNode(_el$82, _el$83);
                          _$insert(_el$83, () => j().name);
                          _$insert(_el$85, () => badge(j()).label);
                          _$insertNode(_el$86, _el$87);
                          _$insert(_el$86, () => j().id, null);
                          _$insert(_el$86, () => j().source === "config" ? " · from config" : "", null);
                          _$effect(_p$ => {
                            var _v$33 = {
                                fg: L().text
                              },
                              _v$34 = {
                                fg: badge(j()).fg,
                                bg: badge(j()).bg
                              },
                              _v$35 = {
                                fg: L().muted
                              };
                            _v$33 !== _p$.e && (_p$.e = _$setProp(_el$82, "style", _v$33, _p$.e));
                            _v$34 !== _p$.t && (_p$.t = _$setProp(_el$85, "style", _v$34, _p$.t));
                            _v$35 !== _p$.a && (_p$.a = _$setProp(_el$86, "style", _v$35, _p$.a));
                            return _p$;
                          }, {
                            e: undefined,
                            t: undefined,
                            a: undefined
                          });
                          return _el$81;
                        })(), (() => {
                          var _el$88 = _$createElement("box");
                          _$setProp(_el$88, "flexDirection", "column");
                          _$insert(_el$88, _$createComponent(Field, {
                            label: "schedule",
                            get value() {
                              return describe(j().schedule);
                            }
                          }), null);
                          _$insert(_el$88, _$createComponent(Show, {
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
                          _$insert(_el$88, _$createComponent(Field, {
                            label: "next",
                            get value() {
                              return _$memo(() => !!isActive(j()))() ? `${clock(j().nextRunAt)}  (${relative(j().nextRunAt, state.now())})` : "—";
                            }
                          }), null);
                          _$insert(_el$88, _$createComponent(Field, {
                            label: "last",
                            get value() {
                              return _$memo(() => !!j().lastRunAt)() ? `${clock(j().lastRunAt)}  ${j().lastStatus ?? ""}` : "never";
                            },
                            get fg() {
                              return _$memo(() => !!j().lastStatus)() ? statusColor(j().lastStatus) : undefined;
                            }
                          }), null);
                          _$insert(_el$88, _$createComponent(Field, {
                            label: "session",
                            get value() {
                              return j().session + (j().sessionID ? `  ${j().sessionID}` : "");
                            }
                          }), null);
                          _$insert(_el$88, _$createComponent(Field, {
                            label: "agent",
                            get value() {
                              return j().agent ?? "default";
                            }
                          }), null);
                          _$insert(_el$88, _$createComponent(Field, {
                            label: "model",
                            get value() {
                              return _$memo(() => j().session === "current")() ? "chat's model" : j().model ?? "agent default";
                            }
                          }), null);
                          _$insert(_el$88, _$createComponent(Field, {
                            label: "directory",
                            get value() {
                              return ctx.ui.format.path(j().directory);
                            }
                          }), null);
                          _$insert(_el$88, _$createComponent(Field, {
                            label: "timeout",
                            get value() {
                              return `${j().timeoutMinutes}m · run missed ${j().runMissed ? "on" : "off"}`;
                            }
                          }), null);
                          return _el$88;
                        })()];
                      }
                    }), null);
                    _$insert(_el$80, _$createComponent(Block, {
                      title: "Prompt",
                      hue: 1,
                      get children() {
                        var _el$89 = _$createElement("text");
                        _$insert(_el$89, () => j().prompt);
                        _$effect(_$p => _$setProp(_el$89, "fg", L().text, _$p));
                        return _el$89;
                      }
                    }), null);
                    _$insert(_el$80, _$createComponent(Block, {
                      title: "Recent runs",
                      hue: 2,
                      get children() {
                        return _$createComponent(Show, {
                          get when() {
                            return jobRuns().length;
                          },
                          get fallback() {
                            return (() => {
                              var _el$91 = _$createElement("text");
                              _$insertNode(_el$91, _$createTextNode(`none yet`));
                              _$effect(_$p => _$setProp(_el$91, "fg", L().muted, _$p));
                              return _el$91;
                            })();
                          },
                          get children() {
                            var _el$90 = _$createElement("box");
                            _$setProp(_el$90, "flexDirection", "column");
                            _$insert(_el$90, _$createComponent(For, {
                              get each() {
                                return jobRuns();
                              },
                              children: r => (() => {
                                var _el$93 = _$createElement("box"),
                                  _el$94 = _$createElement("text"),
                                  _el$95 = _$createElement("span"),
                                  _el$96 = _$createTextNode(` `),
                                  _el$97 = _$createElement("span"),
                                  _el$98 = _$createTextNode(`  `),
                                  _el$99 = _$createTextNode(` `);
                                _$insertNode(_el$93, _el$94);
                                _$setProp(_el$93, "flexDirection", "column");
                                _$insertNode(_el$94, _el$95);
                                _$insertNode(_el$94, _el$96);
                                _$insertNode(_el$94, _el$97);
                                _$insert(_el$95, () => glyph[r.status]);
                                _$insert(_el$94, () => clock(r.startedAt), _el$97);
                                _$insertNode(_el$97, _el$98);
                                _$insertNode(_el$97, _el$99);
                                _$insert(_el$97, () => r.status, _el$99);
                                _$insert(_el$97, () => elapsed(r), null);
                                _$insert(_el$93, _$createComponent(Show, {
                                  get when() {
                                    return r.error;
                                  },
                                  children: error => (() => {
                                    var _el$100 = _$createElement("text");
                                    _$insert(_el$100, () => "  " + error().slice(0, 100));
                                    _$effect(_$p => _$setProp(_el$100, "fg", L().bad, _$p));
                                    return _el$100;
                                  })()
                                }), null);
                                _$effect(_p$ => {
                                  var _v$36 = L().text,
                                    _v$37 = {
                                      fg: statusColor(r.status)
                                    },
                                    _v$38 = {
                                      fg: L().muted
                                    };
                                  _v$36 !== _p$.e && (_p$.e = _$setProp(_el$94, "fg", _v$36, _p$.e));
                                  _v$37 !== _p$.t && (_p$.t = _$setProp(_el$95, "style", _v$37, _p$.t));
                                  _v$38 !== _p$.a && (_p$.a = _$setProp(_el$97, "style", _v$38, _p$.a));
                                  return _p$;
                                }, {
                                  e: undefined,
                                  t: undefined,
                                  a: undefined
                                });
                                return _el$93;
                              })()
                            }));
                            return _el$90;
                          }
                        });
                      }
                    }), null);
                    return _el$79;
                  })()
                }), null);
                _$effect(_p$ => {
                  var _v$1 = L().panel,
                    _v$10 = L().muted;
                  _v$1 !== _p$.e && (_p$.e = _$setProp(_el$33, "backgroundColor", _v$1, _p$.e));
                  _v$10 !== _p$.t && (_p$.t = _$setProp(_el$35, "fg", _v$10, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$32;
              }
            });
          }
        }), _el$38);
        _$setProp(_el$38, "flexDirection", "row");
        _$setProp(_el$38, "flexWrap", "wrap");
        _$setProp(_el$38, "paddingTop", 1);
        _$setProp(_el$38, "paddingBottom", 1);
        _$setProp(_el$38, "columnGap", 2);
        _$setProp(_el$38, "flexShrink", 0);
        _$insert(_el$38, _$createComponent(For, {
          get each() {
            return onChannels() ? channelHints : keyHints;
          },
          children: ([key, label]) => (() => {
            var _el$101 = _$createElement("text"),
              _el$102 = _$createElement("span"),
              _el$103 = _$createTextNode(` `),
              _el$104 = _$createTextNode(` `),
              _el$105 = _$createElement("span"),
              _el$106 = _$createTextNode(` `);
            _$insertNode(_el$101, _el$102);
            _$insertNode(_el$101, _el$105);
            _$insertNode(_el$102, _el$103);
            _$insertNode(_el$102, _el$104);
            _$insert(_el$102, key, _el$104);
            _$insertNode(_el$105, _el$106);
            _$insert(_el$105, label, null);
            _$effect(_p$ => {
              var _v$39 = {
                  fg: L().text,
                  bg: L().cap
                },
                _v$40 = {
                  fg: L().muted
                };
              _v$39 !== _p$.e && (_p$.e = _$setProp(_el$102, "style", _v$39, _p$.e));
              _v$40 !== _p$.t && (_p$.t = _$setProp(_el$105, "style", _v$40, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$101;
          })()
        }));
        _$effect(_p$ => {
          var _v$11 = p().left,
            _v$12 = p().top,
            _v$13 = p().width,
            _v$14 = p().height,
            _v$15 = t.background.base,
            _v$16 = L().text,
            _v$17 = onChannels() ? L().muted : L().ink(0),
            _v$18 = onChannels() ? L().ink(0) : L().muted;
          _v$11 !== _p$.e && (_p$.e = _$setProp(_el$11, "left", _v$11, _p$.e));
          _v$12 !== _p$.t && (_p$.t = _$setProp(_el$11, "top", _v$12, _p$.t));
          _v$13 !== _p$.a && (_p$.a = _$setProp(_el$11, "width", _v$13, _p$.a));
          _v$14 !== _p$.o && (_p$.o = _$setProp(_el$11, "height", _v$14, _p$.o));
          _v$15 !== _p$.i && (_p$.i = _$setProp(_el$11, "backgroundColor", _v$15, _p$.i));
          _v$16 !== _p$.n && (_p$.n = _$setProp(_el$14, "fg", _v$16, _p$.n));
          _v$17 !== _p$.s && (_p$.s = _$setProp(_el$17, "fg", _v$17, _p$.s));
          _v$18 !== _p$.h && (_p$.h = _$setProp(_el$18, "fg", _v$18, _p$.h));
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
        return _el$11;
      })()
    }));
    return _el$10;
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
      var _el$107 = _$createElement("box"),
        _el$108 = _$createElement("text"),
        _el$109 = _$createElement("b"),
        _el$111 = _$createElement("text");
      _$insertNode(_el$107, _el$108);
      _$insertNode(_el$107, _el$111);
      _$setProp(_el$107, "flexDirection", "column");
      _$setProp(_el$107, "marginTop", 1);
      _$setProp(_el$107, "paddingLeft", 1);
      _$setProp(_el$107, "paddingRight", 1);
      _$setProp(_el$107, "paddingTop", 1);
      _$setProp(_el$107, "paddingBottom", 1);
      _$insertNode(_el$108, _el$109);
      _$insertNode(_el$109, _$createTextNode(`⏰ Automations`));
      _$insert(_el$107, _$createComponent(Show, {
        get when() {
          return thisRun();
        },
        children: r => (() => {
          var _el$113 = _$createElement("text"),
            _el$114 = _$createTextNode(`this session: `),
            _el$115 = _$createTextNode(` `);
          _$insertNode(_el$113, _el$114);
          _$insertNode(_el$113, _el$115);
          _$insert(_el$113, () => r().jobID, _el$115);
          _$insert(_el$113, () => glyph[r().status], null);
          _$effect(_$p => _$setProp(_el$113, "fg", L().info, _$p));
          return _el$113;
        })()
      }), _el$111);
      _$insert(_el$107, _$createComponent(For, {
        get each() {
          return upcoming();
        },
        children: j => (() => {
          var _el$116 = _$createElement("box"),
            _el$117 = _$createElement("text"),
            _el$118 = _$createElement("text");
          _$insertNode(_el$116, _el$117);
          _$insertNode(_el$116, _el$118);
          _$setProp(_el$116, "flexDirection", "row");
          _$setProp(_el$116, "justifyContent", "space-between");
          _$insert(_el$117, () => j.name.slice(0, 18));
          _$insert(_el$118, () => relative(j.nextRunAt, state.now()));
          _$effect(_p$ => {
            var _v$44 = L().text,
              _v$45 = L().muted;
            _v$44 !== _p$.e && (_p$.e = _$setProp(_el$117, "fg", _v$44, _p$.e));
            _v$45 !== _p$.t && (_p$.t = _$setProp(_el$118, "fg", _v$45, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$116;
        })()
      }), _el$111);
      _$insertNode(_el$111, _$createTextNode(`/automations`));
      _$effect(_p$ => {
        var _v$41 = L().panel,
          _v$42 = L().ink(0),
          _v$43 = L().faint;
        _v$41 !== _p$.e && (_p$.e = _$setProp(_el$107, "backgroundColor", _v$41, _p$.e));
        _v$42 !== _p$.t && (_p$.t = _$setProp(_el$108, "fg", _v$42, _p$.t));
        _v$43 !== _p$.a && (_p$.a = _$setProp(_el$111, "fg", _v$43, _p$.a));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined
      });
      return _el$107;
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
