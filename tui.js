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
//  - The session sidebar shows upcoming jobs, and flags sessions created by an automation run.
//  - Finished runs raise a toast, plus an OS notification when the terminal isn't focused.

import { Plugin } from "@opencode/plugin/tui";
import { watch } from "node:fs";
import { createMemo, createSignal, For, Show } from "solid-js";
import { describe, nextRun } from "./cron.ts";
import { defaultDataDir, isActive, mutateRaw, parseScheduleText, relative, uniqueID } from "./jobs.ts";
import { Store } from "./store.ts";
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
const keyHints = [["↑↓", "select"], ["space", "pause"], ["r", "run now"], ["n", "new"], ["e", "prompt"], ["s", "schedule"], ["m", "model"], ["d", "delete"], ["⏎", "open session"], ["esc", "close"]];
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
  // Kept here, not in the view: the dialog is re-created after nested prompts and must reopen on the same job.
  const [selectedID, setSelectedID] = createSignal();
  const notifyMode = ctx.options.notify ?? "blurred";
  const seen = new Set(runs().filter(r => r.status !== "running").map(r => r.runID));
  function refresh() {
    setJobs(store.loadJobs());
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

  /** Write an intent and re-read. Returns an error message instead of throwing (callers toast it). */
  function act(fn) {
    try {
      mutateRaw(store, fn);
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
    setSelectedID
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
  const running = createMemo(() => new Set(state.runs().filter(r => r.status === "running").map(r => r.jobID)));
  const toastErr = msg => {
    if (msg) ctx.ui.toast.show({
      title: "Automations",
      message: msg,
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
  const actions = {
    togglePause: withJob(j => update(j.id, x => {
      x.paused = !x.paused;
      // Resuming re-anchors to now, so a long pause doesn't fire a missed run right away.
      if (!x.paused) x.nextRunAt = nextRun(x.schedule, Date.now(), x.createdAt);
    })),
    runNow: withJob(j => {
      update(j.id, x => void (x.runRequestedAt = Date.now()));
      ctx.ui.toast.show({
        message: `Queued “${j.name}” — fires on the automations plugin's next tick`,
        variant: "info"
      });
    }),
    editPrompt: nested(withJob(async j => {
      if (!editable(j)) return;
      const v = await ctx.ui.dialog.prompt({
        title: `Prompt · ${j.name}`,
        value: j.prompt
      });
      if (v?.trim()) update(j.id, x => void (x.prompt = v.trim()));
    })),
    editSchedule: nested(withJob(async j => {
      if (!editable(j)) return;
      const v = await ctx.ui.dialog.prompt({
        title: `Schedule · ${j.name}`,
        description: 'Cron ("0 9 * * 1-5", "@daily", optionally followed by a time zone), "every 15m", or an ISO date',
        value: j.schedule.kind === "cron" ? `${j.schedule.expr}${j.schedule.tz ? ` ${j.schedule.tz}` : ""}` : ""
      });
      if (!v?.trim()) return;
      update(j.id, x => {
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
      if (choice !== undefined) update(j.id, x => void (x.model = choice || undefined));
    })),
    remove: nested(withJob(async j => {
      if (!editable(j)) return;
      const ok = await ctx.ui.dialog.confirm({
        title: "Delete automation",
        message: `Delete “${j.name}”? Its history is kept.`
      });
      if (ok) toastErr(state.act(jobs => void jobs.splice(jobs.findIndex(x => x.id === j.id), 1)));
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
          title: "Reuse one session",
          value: "reuse",
          description: "Accumulates context between runs"
        }]
      });
      if (!session) return;
      const directory = ctx.location?.directory ?? process.cwd();
      toastErr(state.act(jobs => {
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
      run: () => move(-1)
    }, {
      title: "down",
      bind: "down",
      run: () => move(1)
    }, {
      bind: "k",
      run: () => move(-1)
    }, {
      bind: "j",
      run: () => move(1)
    }, {
      title: "pause/resume",
      bind: "space",
      run: actions.togglePause
    }, {
      title: "run now",
      bind: "r",
      run: actions.runNow
    }, {
      title: "new",
      bind: "n",
      run: actions.create
    }, {
      title: "prompt",
      bind: "e",
      run: actions.editPrompt
    }, {
      title: "schedule",
      bind: "s",
      run: actions.editSchedule
    }, {
      title: "model",
      bind: "m",
      run: actions.pickModel
    }, {
      title: "delete",
      bind: "d",
      run: actions.remove
    }, {
      title: "open session",
      bind: "return",
      run: actions.openSession
    }]
  }));
  const L = createMemo(() => look(ctx, "dialog"));
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
          _el$0 = _$createElement("text"),
          _el$1 = _$createElement("b"),
          _el$11 = _$createElement("text"),
          _el$12 = _$createTextNode(` `),
          _el$13 = _$createTextNode(` · `),
          _el$14 = _$createTextNode(` active · `),
          _el$16 = _$createElement("span"),
          _el$17 = _$createTextNode(` running`),
          _el$24 = _$createElement("box");
        _$insertNode(_el$8, _el$9);
        _$insertNode(_el$8, _el$24);
        _$setProp(_el$8, "position", "absolute");
        _$setProp(_el$8, "zIndex", 10);
        _$setProp(_el$8, "flexDirection", "column");
        _$setProp(_el$8, "paddingLeft", 2);
        _$setProp(_el$8, "paddingRight", 2);
        _$setProp(_el$8, "paddingTop", 1);
        _$insertNode(_el$9, _el$0);
        _$insertNode(_el$9, _el$11);
        _$setProp(_el$9, "flexDirection", "row");
        _$setProp(_el$9, "justifyContent", "space-between");
        _$setProp(_el$9, "paddingBottom", 1);
        _$insertNode(_el$0, _el$1);
        _$insertNode(_el$1, _$createTextNode(`⏰ Automations`));
        _$insertNode(_el$11, _el$12);
        _$insertNode(_el$11, _el$13);
        _$insertNode(_el$11, _el$14);
        _$insertNode(_el$11, _el$16);
        _$insert(_el$11, () => state.jobs().length, _el$12);
        _$insert(_el$11, () => state.jobs().length === 1 ? "job" : "jobs", _el$13);
        _$insert(_el$11, activeCount, _el$14);
        _$insertNode(_el$16, _el$17);
        _$insert(_el$16, () => running().size, _el$17);
        _$insert(_el$8, _$createComponent(Show, {
          get when() {
            return sorted().length;
          },
          get fallback() {
            return (() => {
              var _el$25 = _$createElement("box"),
                _el$26 = _$createElement("text"),
                _el$28 = _$createElement("text");
              _$insertNode(_el$25, _el$26);
              _$insertNode(_el$25, _el$28);
              _$setProp(_el$25, "padding", 2);
              _$setProp(_el$25, "flexDirection", "column");
              _$setProp(_el$25, "gap", 1);
              _$insertNode(_el$26, _$createTextNode(`No automations yet.`));
              _$insertNode(_el$28, _$createTextNode(`Press n to create one, or ask in chat: “every weekday at 8:45, triage my open MRs”.`));
              _$effect(_p$ => {
                var _v$11 = L().panel,
                  _v$12 = L().text,
                  _v$13 = L().muted;
                _v$11 !== _p$.e && (_p$.e = _$setProp(_el$25, "backgroundColor", _v$11, _p$.e));
                _v$12 !== _p$.t && (_p$.t = _$setProp(_el$26, "fg", _v$12, _p$.t));
                _v$13 !== _p$.a && (_p$.a = _$setProp(_el$28, "fg", _v$13, _p$.a));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined
              });
              return _el$25;
            })();
          },
          get children() {
            var _el$18 = _$createElement("box"),
              _el$19 = _$createElement("box"),
              _el$20 = _$createElement("box"),
              _el$21 = _$createElement("text"),
              _el$22 = _$createElement("b");
            _$insertNode(_el$18, _el$19);
            _$setProp(_el$18, "flexDirection", "row");
            _$setProp(_el$18, "flexGrow", 1);
            _$setProp(_el$18, "gap", 2);
            _$insertNode(_el$19, _el$20);
            _$setProp(_el$19, "flexDirection", "column");
            _$setProp(_el$19, "width", 38);
            _$setProp(_el$19, "paddingTop", 1);
            _$setProp(_el$19, "paddingBottom", 1);
            _$insertNode(_el$20, _el$21);
            _$setProp(_el$20, "paddingLeft", 2);
            _$setProp(_el$20, "paddingBottom", 1);
            _$insertNode(_el$21, _el$22);
            _$insertNode(_el$22, _$createTextNode(`JOBS`));
            _$insert(_el$19, _$createComponent(For, {
              get each() {
                return sorted();
              },
              children: (j, i) => {
                const isSel = () => i() === index();
                const dot = () => running().has(j.id) ? "◐" : isActive(j) ? "●" : "○";
                const when = () => running().has(j.id) ? "running" : isActive(j) ? relative(j.nextRunAt, state.now()) : stateOf(j);
                const fg = () => isSel() ? t.text.action.primary.focused : undefined;
                return (() => {
                  var _el$30 = _$createElement("box"),
                    _el$31 = _$createElement("text"),
                    _el$32 = _$createElement("span"),
                    _el$33 = _$createTextNode(` `),
                    _el$34 = _$createElement("text");
                  _$insertNode(_el$30, _el$31);
                  _$insertNode(_el$30, _el$34);
                  _$setProp(_el$30, "flexDirection", "row");
                  _$setProp(_el$30, "justifyContent", "space-between");
                  _$setProp(_el$30, "paddingLeft", 2);
                  _$setProp(_el$30, "paddingRight", 2);
                  _$insertNode(_el$31, _el$32);
                  _$insertNode(_el$31, _el$33);
                  _$insert(_el$32, dot);
                  _$insert(_el$31, () => j.name.slice(0, 22), null);
                  _$insert(_el$34, when);
                  _$effect(_p$ => {
                    var _v$14 = isSel() ? t.background.action.primary.focused : undefined,
                      _v$15 = fg() ?? L().text,
                      _v$16 = {
                        fg: isSel() ? L().ok : running().has(j.id) ? L().warn : L().muted
                      },
                      _v$17 = fg() ?? L().muted;
                    _v$14 !== _p$.e && (_p$.e = _$setProp(_el$30, "backgroundColor", _v$14, _p$.e));
                    _v$15 !== _p$.t && (_p$.t = _$setProp(_el$31, "fg", _v$15, _p$.t));
                    _v$16 !== _p$.a && (_p$.a = _$setProp(_el$32, "style", _v$16, _p$.a));
                    _v$17 !== _p$.o && (_p$.o = _$setProp(_el$34, "fg", _v$17, _p$.o));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined,
                    o: undefined
                  });
                  return _el$30;
                })();
              }
            }), null);
            _$insert(_el$18, _$createComponent(Show, {
              get when() {
                return selected();
              },
              children: j => (() => {
                var _el$35 = _$createElement("scrollbox"),
                  _el$36 = _$createElement("box");
                _$insertNode(_el$35, _el$36);
                _$setProp(_el$35, "flexGrow", 1);
                _$setProp(_el$36, "flexDirection", "column");
                _$setProp(_el$36, "gap", 1);
                _$insert(_el$36, _$createComponent(Block, {
                  title: "Details",
                  hue: 0,
                  get children() {
                    return [(() => {
                      var _el$37 = _$createElement("text"),
                        _el$38 = _$createElement("span"),
                        _el$39 = _$createElement("b"),
                        _el$40 = _$createTextNode(`  `),
                        _el$41 = _$createElement("span"),
                        _el$42 = _$createElement("span"),
                        _el$43 = _$createTextNode(`  `);
                      _$insertNode(_el$37, _el$38);
                      _$insertNode(_el$37, _el$40);
                      _$insertNode(_el$37, _el$41);
                      _$insertNode(_el$37, _el$42);
                      _$insertNode(_el$38, _el$39);
                      _$insert(_el$39, () => j().name);
                      _$insert(_el$41, () => badge(j()).label);
                      _$insertNode(_el$42, _el$43);
                      _$insert(_el$42, () => j().id, null);
                      _$insert(_el$42, () => j().source === "config" ? " · from config" : "", null);
                      _$effect(_p$ => {
                        var _v$18 = {
                            fg: L().text
                          },
                          _v$19 = {
                            fg: badge(j()).fg,
                            bg: badge(j()).bg
                          },
                          _v$20 = {
                            fg: L().muted
                          };
                        _v$18 !== _p$.e && (_p$.e = _$setProp(_el$38, "style", _v$18, _p$.e));
                        _v$19 !== _p$.t && (_p$.t = _$setProp(_el$41, "style", _v$19, _p$.t));
                        _v$20 !== _p$.a && (_p$.a = _$setProp(_el$42, "style", _v$20, _p$.a));
                        return _p$;
                      }, {
                        e: undefined,
                        t: undefined,
                        a: undefined
                      });
                      return _el$37;
                    })(), (() => {
                      var _el$44 = _$createElement("box");
                      _$setProp(_el$44, "flexDirection", "column");
                      _$insert(_el$44, _$createComponent(Field, {
                        label: "schedule",
                        get value() {
                          return describe(j().schedule);
                        }
                      }), null);
                      _$insert(_el$44, _$createComponent(Field, {
                        label: "next",
                        get value() {
                          return _$memo(() => !!isActive(j()))() ? `${clock(j().nextRunAt)}  (${relative(j().nextRunAt, state.now())})` : "—";
                        }
                      }), null);
                      _$insert(_el$44, _$createComponent(Field, {
                        label: "last",
                        get value() {
                          return _$memo(() => !!j().lastRunAt)() ? `${clock(j().lastRunAt)}  ${j().lastStatus ?? ""}` : "never";
                        },
                        get fg() {
                          return _$memo(() => !!j().lastStatus)() ? statusColor(j().lastStatus) : undefined;
                        }
                      }), null);
                      _$insert(_el$44, _$createComponent(Field, {
                        label: "session",
                        get value() {
                          return j().session + (j().sessionID ? `  ${j().sessionID}` : "");
                        }
                      }), null);
                      _$insert(_el$44, _$createComponent(Field, {
                        label: "agent",
                        get value() {
                          return j().agent ?? "default";
                        }
                      }), null);
                      _$insert(_el$44, _$createComponent(Field, {
                        label: "model",
                        get value() {
                          return _$memo(() => j().session === "current")() ? "chat's model" : j().model ?? "agent default";
                        }
                      }), null);
                      _$insert(_el$44, _$createComponent(Field, {
                        label: "directory",
                        get value() {
                          return ctx.ui.format.path(j().directory);
                        }
                      }), null);
                      _$insert(_el$44, _$createComponent(Field, {
                        label: "timeout",
                        get value() {
                          return `${j().timeoutMinutes}m · run missed ${j().runMissed ? "on" : "off"}`;
                        }
                      }), null);
                      return _el$44;
                    })()];
                  }
                }), null);
                _$insert(_el$36, _$createComponent(Block, {
                  title: "Prompt",
                  hue: 1,
                  get children() {
                    var _el$45 = _$createElement("text");
                    _$insert(_el$45, () => j().prompt);
                    _$effect(_$p => _$setProp(_el$45, "fg", L().text, _$p));
                    return _el$45;
                  }
                }), null);
                _$insert(_el$36, _$createComponent(Block, {
                  title: "Recent runs",
                  hue: 2,
                  get children() {
                    return _$createComponent(Show, {
                      get when() {
                        return jobRuns().length;
                      },
                      get fallback() {
                        return (() => {
                          var _el$47 = _$createElement("text");
                          _$insertNode(_el$47, _$createTextNode(`none yet`));
                          _$effect(_$p => _$setProp(_el$47, "fg", L().muted, _$p));
                          return _el$47;
                        })();
                      },
                      get children() {
                        var _el$46 = _$createElement("box");
                        _$setProp(_el$46, "flexDirection", "column");
                        _$insert(_el$46, _$createComponent(For, {
                          get each() {
                            return jobRuns();
                          },
                          children: r => (() => {
                            var _el$49 = _$createElement("box"),
                              _el$50 = _$createElement("text"),
                              _el$51 = _$createElement("span"),
                              _el$52 = _$createTextNode(` `),
                              _el$53 = _$createElement("span"),
                              _el$54 = _$createTextNode(`  `),
                              _el$55 = _$createTextNode(` `);
                            _$insertNode(_el$49, _el$50);
                            _$setProp(_el$49, "flexDirection", "column");
                            _$insertNode(_el$50, _el$51);
                            _$insertNode(_el$50, _el$52);
                            _$insertNode(_el$50, _el$53);
                            _$insert(_el$51, () => glyph[r.status]);
                            _$insert(_el$50, () => clock(r.startedAt), _el$53);
                            _$insertNode(_el$53, _el$54);
                            _$insertNode(_el$53, _el$55);
                            _$insert(_el$53, () => r.status, _el$55);
                            _$insert(_el$53, () => duration(r), null);
                            _$insert(_el$49, _$createComponent(Show, {
                              get when() {
                                return r.error ?? firstLine(r.output);
                              },
                              children: line => (() => {
                                var _el$56 = _$createElement("text");
                                _$insert(_el$56, () => "  " + line().slice(0, 100));
                                _$effect(_$p => _$setProp(_el$56, "fg", r.error ? L().bad : L().muted, _$p));
                                return _el$56;
                              })()
                            }), null);
                            _$effect(_p$ => {
                              var _v$21 = L().text,
                                _v$22 = {
                                  fg: statusColor(r.status)
                                },
                                _v$23 = {
                                  fg: L().muted
                                };
                              _v$21 !== _p$.e && (_p$.e = _$setProp(_el$50, "fg", _v$21, _p$.e));
                              _v$22 !== _p$.t && (_p$.t = _$setProp(_el$51, "style", _v$22, _p$.t));
                              _v$23 !== _p$.a && (_p$.a = _$setProp(_el$53, "style", _v$23, _p$.a));
                              return _p$;
                            }, {
                              e: undefined,
                              t: undefined,
                              a: undefined
                            });
                            return _el$49;
                          })()
                        }));
                        return _el$46;
                      }
                    });
                  }
                }), null);
                return _el$35;
              })()
            }), null);
            _$effect(_p$ => {
              var _v$3 = L().panel,
                _v$4 = L().muted;
              _v$3 !== _p$.e && (_p$.e = _$setProp(_el$19, "backgroundColor", _v$3, _p$.e));
              _v$4 !== _p$.t && (_p$.t = _$setProp(_el$21, "fg", _v$4, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$18;
          }
        }), _el$24);
        _$setProp(_el$24, "flexDirection", "row");
        _$setProp(_el$24, "flexWrap", "wrap");
        _$setProp(_el$24, "paddingTop", 1);
        _$setProp(_el$24, "paddingBottom", 1);
        _$setProp(_el$24, "columnGap", 2);
        _$insert(_el$24, _$createComponent(For, {
          each: keyHints,
          children: ([key, label]) => (() => {
            var _el$57 = _$createElement("text"),
              _el$58 = _$createElement("span"),
              _el$59 = _$createTextNode(` `),
              _el$60 = _$createTextNode(` `),
              _el$61 = _$createElement("span"),
              _el$62 = _$createTextNode(` `);
            _$insertNode(_el$57, _el$58);
            _$insertNode(_el$57, _el$61);
            _$insertNode(_el$58, _el$59);
            _$insertNode(_el$58, _el$60);
            _$insert(_el$58, key, _el$60);
            _$insertNode(_el$61, _el$62);
            _$insert(_el$61, label, null);
            _$effect(_p$ => {
              var _v$24 = {
                  fg: L().text,
                  bg: L().cap
                },
                _v$25 = {
                  fg: L().muted
                };
              _v$24 !== _p$.e && (_p$.e = _$setProp(_el$58, "style", _v$24, _p$.e));
              _v$25 !== _p$.t && (_p$.t = _$setProp(_el$61, "style", _v$25, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$57;
          })()
        }));
        _$effect(_p$ => {
          var _v$5 = p().left,
            _v$6 = p().top,
            _v$7 = p().width,
            _v$8 = p().height,
            _v$9 = t.background.base,
            _v$0 = L().text,
            _v$1 = L().muted,
            _v$10 = {
              fg: running().size ? L().warn : L().muted
            };
          _v$5 !== _p$.e && (_p$.e = _$setProp(_el$8, "left", _v$5, _p$.e));
          _v$6 !== _p$.t && (_p$.t = _$setProp(_el$8, "top", _v$6, _p$.t));
          _v$7 !== _p$.a && (_p$.a = _$setProp(_el$8, "width", _v$7, _p$.a));
          _v$8 !== _p$.o && (_p$.o = _$setProp(_el$8, "height", _v$8, _p$.o));
          _v$9 !== _p$.i && (_p$.i = _$setProp(_el$8, "backgroundColor", _v$9, _p$.i));
          _v$0 !== _p$.n && (_p$.n = _$setProp(_el$0, "fg", _v$0, _p$.n));
          _v$1 !== _p$.s && (_p$.s = _$setProp(_el$11, "fg", _v$1, _p$.s));
          _v$10 !== _p$.h && (_p$.h = _$setProp(_el$16, "style", _v$10, _p$.h));
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
      var _el$63 = _$createElement("box"),
        _el$64 = _$createElement("text"),
        _el$65 = _$createElement("b"),
        _el$67 = _$createElement("text");
      _$insertNode(_el$63, _el$64);
      _$insertNode(_el$63, _el$67);
      _$setProp(_el$63, "flexDirection", "column");
      _$setProp(_el$63, "marginTop", 1);
      _$setProp(_el$63, "paddingLeft", 1);
      _$setProp(_el$63, "paddingRight", 1);
      _$setProp(_el$63, "paddingTop", 1);
      _$setProp(_el$63, "paddingBottom", 1);
      _$insertNode(_el$64, _el$65);
      _$insertNode(_el$65, _$createTextNode(`⏰ Automations`));
      _$insert(_el$63, _$createComponent(Show, {
        get when() {
          return thisRun();
        },
        children: r => (() => {
          var _el$69 = _$createElement("text"),
            _el$70 = _$createTextNode(`this session: `),
            _el$71 = _$createTextNode(` `);
          _$insertNode(_el$69, _el$70);
          _$insertNode(_el$69, _el$71);
          _$insert(_el$69, () => r().jobID, _el$71);
          _$insert(_el$69, () => glyph[r().status], null);
          _$effect(_$p => _$setProp(_el$69, "fg", L().info, _$p));
          return _el$69;
        })()
      }), _el$67);
      _$insert(_el$63, _$createComponent(For, {
        get each() {
          return upcoming();
        },
        children: j => (() => {
          var _el$72 = _$createElement("box"),
            _el$73 = _$createElement("text"),
            _el$74 = _$createElement("text");
          _$insertNode(_el$72, _el$73);
          _$insertNode(_el$72, _el$74);
          _$setProp(_el$72, "flexDirection", "row");
          _$setProp(_el$72, "justifyContent", "space-between");
          _$insert(_el$73, () => j.name.slice(0, 18));
          _$insert(_el$74, () => relative(j.nextRunAt, state.now()));
          _$effect(_p$ => {
            var _v$29 = L().text,
              _v$30 = L().muted;
            _v$29 !== _p$.e && (_p$.e = _$setProp(_el$73, "fg", _v$29, _p$.e));
            _v$30 !== _p$.t && (_p$.t = _$setProp(_el$74, "fg", _v$30, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$72;
        })()
      }), _el$67);
      _$insertNode(_el$67, _$createTextNode(`/automations`));
      _$effect(_p$ => {
        var _v$26 = L().panel,
          _v$27 = L().ink(0),
          _v$28 = L().faint;
        _v$26 !== _p$.e && (_p$.e = _$setProp(_el$63, "backgroundColor", _v$26, _p$.e));
        _v$27 !== _p$.t && (_p$.t = _$setProp(_el$64, "fg", _v$27, _p$.t));
        _v$28 !== _p$.a && (_p$.a = _$setProp(_el$67, "fg", _v$28, _p$.a));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined
      });
      return _el$63;
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
      watcher = watch(dataDir, () => {
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
