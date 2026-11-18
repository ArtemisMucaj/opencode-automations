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
// Reads state.db and writes intents (pause, edit, delete, run now) that the server's leader carries out.

import { Plugin } from "@opencode/plugin/tui";
import { createMemo, createSignal, For, Index, Match, Show, Switch } from "solid-js";
import { describe, nextRun } from "./cron.ts";
import { DEFAULT_TIMEOUT_MINUTES, defaultDataDir, isActive, listens, newJob, parseScheduleText, runnable, runningJobs, stateOf } from "./jobs.ts";
import { clock, elapsed, errorMessage, plural, relative } from "./util.ts";
import { Store } from "./store.ts";
import { channelRows, emptyChannels, requestPoll } from "./channels.ts";
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
const tabKeys = {
  channels: "c",
  inbox: "i",
  outbox: "o"
};
const tabs = ["jobs", "channels", "inbox", "outbox"];
const tabHints = tab => Object.entries(tabKeys).map(([t, k]) => [k, t === tab ? "automations" : t]);
const keyHints = [["↑↓", "select"], ["space", "pause"], ["r", "run now"], ["n", "new"], ["e", "prompt"], ["s", "schedule"], ["m", "model"], ["d", "delete"], ["⏎", "open session"], ["esc", "close"]];
const channelHints = [["↑↓", "select"], ["p", "poll now"], ["d", "delete"], ["esc", "close"]];
const listHints = [["↑↓", "select"], ["esc", "close"]];
const LIST_LIMIT = 100;
const BUSY_MS = 250;
export function createState(ctx, dataDir) {
  const store = new Store(dataDir, {
    busyMs: BUSY_MS
  });
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
  const loadWaiting = () => {
    try {
      return {
        counts: store.waitingCounts(),
        first: new Map(jobs().filter(j => j.on).map(j => [j.id, store.waiting(j.id, 20)]))
      };
    } catch {
      return {
        counts: new Map(),
        first: new Map()
      };
    }
  };
  const [waiting, setWaiting] = createSignal(loadWaiting());
  const loadSent = () => {
    try {
      return new Map(jobs().map(j => [j.id, store.sent(j.id, 5)]));
    } catch {
      return new Map();
    }
  };
  const [sent, setSent] = createSignal(loadSent());
  // Kept here, not in the view: the dialog is re-created after nested prompts and must reopen on the same job and tab.
  const [selectedID, setSelectedID] = createSignal();
  const [selectedChannel, setSelectedChannel] = createSignal();
  const [selectedEvent, setSelectedEvent] = createSignal();
  const [selectedMessage, setSelectedMessage] = createSignal();
  const [tab, setTab] = createSignal("jobs");
  // For reads made only while shown.
  const [refreshed, setRefreshed] = createSignal(0);
  const notifyMode = ctx.options.notify ?? "blurred";
  const seen = new Set(runs().filter(r => r.status !== "running").map(r => r.runID));
  function refresh() {
    let next;
    // State that can't be read now keeps what is shown.
    try {
      setJobs(store.loadJobs());
      next = store.history(undefined, 300);
    } catch {
      return;
    }
    setChannels(loadChannels());
    setWaiting(loadWaiting());
    setSent(loadSent());
    setRuns(next);
    setNow(Date.now());
    setRefreshed(n => n + 1);
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
  const actChannels = fn => attempt(() => store.mutateChannels(fn));
  const tick = () => setNow(Date.now());
  return {
    store,
    jobs,
    runs,
    now,
    refresh,
    tick,
    act,
    selectedID,
    setSelectedID,
    channels,
    actChannels,
    waiting,
    sent,
    selectedChannel,
    setSelectedChannel,
    tab,
    setTab,
    refreshed,
    selectedEvent,
    setSelectedEvent,
    selectedMessage,
    setSelectedMessage
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
  const jobSent = createMemo(() => state.sent().get(selected()?.id ?? "") ?? []);
  const jobNotes = createMemo(shown => {
    state.refreshed();
    const id = selected()?.id;
    if (!id || state.tab() !== "jobs") return [];
    try {
      return state.store.notes(id);
    } catch {
      return shown;
    }
  }, []);

  // ---- channels tab ----
  const onChannels = () => state.tab() === "channels";
  const onJobs = () => state.tab() === "jobs";
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
  const running = createMemo(() => runningJobs(state.jobs(), state.runs(), state.now()));
  const jobByID = createMemo(() => new Map(state.jobs().map(j => [j.id, j])));
  const jobName = id => id ? jobByID().get(id)?.name ?? id : "chat";
  const idleNote = j => j && stateOf(j) !== "active" ? ` · ${stateOf(j)}, so it waits` : "";

  // ---- inbox and outbox tabs ----
  const inbox = createMemo(shown => {
    state.refreshed();
    if (state.tab() !== "inbox") return [];
    try {
      return state.store.inbox(LIST_LIMIT);
    } catch {
      return shown;
    }
  }, []);
  const evIndex = createMemo(() => Math.max(0, inbox().findIndex(e => e.seq === state.selectedEvent())));
  const evSelected = createMemo(() => inbox()[evIndex()]);
  const outbox = createMemo(shown => {
    state.refreshed();
    if (state.tab() !== "outbox") return [];
    try {
      return state.store.sent(undefined, LIST_LIMIT);
    } catch {
      return shown;
    }
  }, []);
  const msgIndex = createMemo(() => Math.max(0, outbox().findIndex(m => m.id === state.selectedMessage())));
  const msgSelected = createMemo(() => outbox()[msgIndex()]);

  /** Toast an error message; also takes the promise act() returns, and resolves once it has settled. */
  const toastErr = async msg => {
    const m = await msg;
    if (m) ctx.ui.toast.show({
      title: "Automations",
      message: m,
      variant: "error"
    });
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
      // Checked again: chat may have attached it since.
      await toastErr(state.act(jobs => {
        const now = jobs.filter(j => listens(j, c.id));
        if (now.length) throw new Error(`Used by ${now.map(j => j.name).join(", ")} now. Detach it from chat: channel_delete with detach.`);
        state.store.removeChannel(c.id);
      }));
    })
  };
  const jobsOnly = fn => () => onJobs() ? fn() : undefined;
  const channelsOnly = fn => () => onChannels() ? fn() : undefined;
  const stepIn = (list, i, d, pick) => {
    const next = list[Math.max(0, Math.min(list.length - 1, i + d))];
    if (next) pick(next);
  };
  const step = d => {
    const tab = state.tab();
    if (tab === "channels") stepIn(chRows(), chIndex(), d, c => state.setSelectedChannel(c.id));else if (tab === "inbox") stepIn(inbox(), evIndex(), d, e => state.setSelectedEvent(e.seq));else if (tab === "outbox") stepIn(outbox(), msgIndex(), d, m => state.setSelectedMessage(m.id));else stepIn(sorted(), index(), d, j => setSelectedID(j.id));
  };
  const toggleTab = tab => () => state.setTab(state.tab() === tab ? "jobs" : tab);
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
      run: toggleTab("channels")
    }, {
      title: "inbox/automations",
      bind: "i",
      run: toggleTab("inbox")
    }, {
      title: "outbox/automations",
      bind: "o",
      run: toggleTab("outbox")
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
      run: () => onChannels() ? channelActions.remove() : onJobs() ? actions.remove() : undefined
    }, {
      title: "open session",
      bind: "return",
      run: jobsOnly(actions.openSession)
    }]
  }));
  const L = createMemo(() => look(ctx, "dialog"));
  const statusUI = st => ({
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
  const deliveryState = e => e.deliveries.some(d => d.status === "waiting") ? "waiting" : e.deliveries.some(d => d.status === "dropped") ? "dropped" : e.deliveries.length ? "taken" : "unclaimed";
  const deliveryUI = f => ({
    waiting: {
      fg: L().warn,
      dot: "◐"
    },
    taken: {
      fg: L().ok,
      dot: "✓"
    },
    dropped: {
      fg: L().bad,
      dot: "✗"
    },
    unclaimed: {
      fg: L().muted,
      dot: "○"
    }
  })[f];
  const sendState = m => m.sends.some(x => x.status === "failed") ? "failed" : m.sends.some(x => x.status === "pending") ? "pending" : m.sends.length ? "sent" : "none";
  const sendUI = st => ({
    sent: {
      fg: L().ok,
      dot: "✓"
    },
    pending: {
      fg: L().warn,
      dot: "◐"
    },
    failed: {
      fg: L().bad,
      dot: "✗"
    },
    none: {
      fg: L().muted,
      dot: "○"
    }
  })[st];
  const inboxWaiting = createMemo(() => inbox().filter(e => deliveryState(e) === "waiting").length);
  const outboxFailed = createMemo(() => outbox().filter(m => sendState(m) === "failed").length);
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
  const headerAndHintRows = 10;
  const fits = createMemo(() => Math.max(5, (panel()?.height ?? 30) - headerAndHintRows));
  const windowStart = (length, i) => Math.max(0, Math.min(length - fits(), i - Math.floor(fits() / 2)));
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
  const Empty = p => (() => {
    var _el$9 = _$createElement("box"),
      _el$0 = _$createElement("text"),
      _el$1 = _$createElement("text");
    _$insertNode(_el$9, _el$0);
    _$insertNode(_el$9, _el$1);
    _$setProp(_el$9, "padding", 2);
    _$setProp(_el$9, "flexDirection", "column");
    _$setProp(_el$9, "gap", 1);
    _$insert(_el$0, () => p.title);
    _$insert(_el$1, () => p.hint);
    _$effect(_p$ => {
      var _v$5 = L().panel,
        _v$6 = L().text,
        _v$7 = L().muted;
      _v$5 !== _p$.e && (_p$.e = _$setProp(_el$9, "backgroundColor", _v$5, _p$.e));
      _v$6 !== _p$.t && (_p$.t = _$setProp(_el$0, "fg", _v$6, _p$.t));
      _v$7 !== _p$.a && (_p$.a = _$setProp(_el$1, "fg", _v$7, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$9;
  })();
  /** The rows around the cursor that fit. <Index> keeps slots, so a row's position is read reactively: slot + start. */
  const List = p => {
    const start = createMemo(() => windowStart(p.items.length, p.index));
    return (() => {
      var _el$10 = _$createElement("box"),
        _el$11 = _$createElement("box"),
        _el$12 = _$createElement("text"),
        _el$13 = _$createElement("b");
      _$insertNode(_el$10, _el$11);
      _$setProp(_el$10, "flexDirection", "column");
      _$setProp(_el$10, "width", 38);
      _$setProp(_el$10, "paddingTop", 1);
      _$setProp(_el$10, "paddingBottom", 1);
      _$insertNode(_el$11, _el$12);
      _$setProp(_el$11, "paddingLeft", 2);
      _$setProp(_el$11, "paddingBottom", 1);
      _$insertNode(_el$12, _el$13);
      _$insert(_el$13, () => p.title);
      _$insert(_el$10, _$createComponent(Index, {
        get each() {
          return p.items.slice(start(), start() + fits());
        },
        children: (item, slot) => {
          const selected = () => slot + start() === p.index;
          const r = () => p.row(item(), selected());
          return _$createComponent(Row, {
            get selected() {
              return selected();
            },
            get dot() {
              return r().dot;
            },
            get dotFg() {
              return r().fg;
            },
            get name() {
              return r().name;
            },
            get when() {
              return r().when;
            }
          });
        }
      }), null);
      _$effect(_p$ => {
        var _v$8 = L().panel,
          _v$9 = L().muted;
        _v$8 !== _p$.e && (_p$.e = _$setProp(_el$10, "backgroundColor", _v$8, _p$.e));
        _v$9 !== _p$.t && (_p$.t = _$setProp(_el$12, "fg", _v$9, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$10;
    })();
  };
  const Field = p => (() => {
    var _el$14 = _$createElement("text"),
      _el$15 = _$createElement("span"),
      _el$16 = _$createElement("span");
    _$insertNode(_el$14, _el$15);
    _$insertNode(_el$14, _el$16);
    _$insert(_el$15, () => p.label.padEnd(11));
    _$insert(_el$16, () => p.value);
    _$effect(_p$ => {
      var _v$0 = {
          fg: L().muted
        },
        _v$1 = {
          fg: p.fg ?? L().text
        };
      _v$0 !== _p$.e && (_p$.e = _$setProp(_el$15, "style", _v$0, _p$.e));
      _v$1 !== _p$.t && (_p$.t = _$setProp(_el$16, "style", _v$1, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$14;
  })();
  return (() => {
    var _el$17 = _$createElement("box");
    _$setProp(_el$17, "renderBefore", track);
    _$insert(_el$17, _$createComponent(Show, {
      get when() {
        return panel();
      },
      children: p => (() => {
        var _el$18 = _$createElement("box"),
          _el$19 = _$createElement("box"),
          _el$20 = _$createElement("box"),
          _el$21 = _$createElement("text"),
          _el$22 = _$createElement("b"),
          _el$45 = _$createElement("box");
        _$insertNode(_el$18, _el$19);
        _$insertNode(_el$18, _el$45);
        _$setProp(_el$18, "position", "absolute");
        _$setProp(_el$18, "zIndex", 10);
        _$setProp(_el$18, "flexDirection", "column");
        _$setProp(_el$18, "paddingLeft", 2);
        _$setProp(_el$18, "paddingRight", 2);
        _$setProp(_el$18, "paddingTop", 1);
        _$insertNode(_el$19, _el$20);
        _$setProp(_el$19, "flexDirection", "row");
        _$setProp(_el$19, "justifyContent", "space-between");
        _$setProp(_el$19, "paddingBottom", 1);
        _$setProp(_el$19, "flexShrink", 0);
        _$insertNode(_el$20, _el$21);
        _$setProp(_el$20, "flexDirection", "row");
        _$setProp(_el$20, "gap", 2);
        _$insertNode(_el$21, _el$22);
        _$insertNode(_el$22, _$createTextNode(`⏰ Automations`));
        _$insert(_el$20, _$createComponent(For, {
          each: tabs,
          children: tab => (() => {
            var _el$46 = _$createElement("text");
            _$insert(_el$46, () => state.tab() === tab ? `[${tab}]` : ` ${tab} `);
            _$effect(_$p => _$setProp(_el$46, "fg", state.tab() === tab ? L().ink(0) : L().muted, _$p));
            return _el$46;
          })()
        }), null);
        _$insert(_el$19, _$createComponent(Switch, {
          get fallback() {
            return (() => {
              var _el$47 = _$createElement("text"),
                _el$48 = _$createTextNode(` · `),
                _el$49 = _$createTextNode(` active · `),
                _el$51 = _$createElement("span"),
                _el$52 = _$createTextNode(` running`);
              _$insertNode(_el$47, _el$48);
              _$insertNode(_el$47, _el$49);
              _$insertNode(_el$47, _el$51);
              _$insert(_el$47, () => plural(state.jobs().length, "job"), _el$48);
              _$insert(_el$47, activeCount, _el$49);
              _$insertNode(_el$51, _el$52);
              _$insert(_el$51, () => running().size, _el$52);
              _$effect(_p$ => {
                var _v$22 = L().muted,
                  _v$23 = {
                    fg: running().size ? L().warn : L().muted
                  };
                _v$22 !== _p$.e && (_p$.e = _$setProp(_el$47, "fg", _v$22, _p$.e));
                _v$23 !== _p$.t && (_p$.t = _$setProp(_el$51, "style", _v$23, _p$.t));
                return _p$;
              }, {
                e: undefined,
                t: undefined
              });
              return _el$47;
            })();
          },
          get children() {
            return [_$createComponent(Match, {
              get when() {
                return state.tab() === "inbox";
              },
              get children() {
                var _el$24 = _$createElement("text"),
                  _el$25 = _$createTextNode(` · `),
                  _el$27 = _$createElement("span"),
                  _el$28 = _$createTextNode(` waiting`);
                _$insertNode(_el$24, _el$25);
                _$insertNode(_el$24, _el$27);
                _$insert(_el$24, (() => {
                  var _c$ = _$memo(() => inbox().length >= LIST_LIMIT);
                  return () => _c$() ? `latest ${LIST_LIMIT}` : plural(inbox().length, "event");
                })(), _el$25);
                _$insertNode(_el$27, _el$28);
                _$insert(_el$27, inboxWaiting, _el$28);
                _$effect(_p$ => {
                  var _v$10 = L().muted,
                    _v$11 = {
                      fg: L().warn
                    };
                  _v$10 !== _p$.e && (_p$.e = _$setProp(_el$24, "fg", _v$10, _p$.e));
                  _v$11 !== _p$.t && (_p$.t = _$setProp(_el$27, "style", _v$11, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$24;
              }
            }), _$createComponent(Match, {
              get when() {
                return state.tab() === "outbox";
              },
              get children() {
                var _el$29 = _$createElement("text"),
                  _el$30 = _$createTextNode(` · `),
                  _el$32 = _$createElement("span"),
                  _el$33 = _$createTextNode(` failed`);
                _$insertNode(_el$29, _el$30);
                _$insertNode(_el$29, _el$32);
                _$insert(_el$29, (() => {
                  var _c$2 = _$memo(() => outbox().length >= LIST_LIMIT);
                  return () => _c$2() ? `latest ${LIST_LIMIT}` : plural(outbox().length, "message");
                })(), _el$30);
                _$insertNode(_el$32, _el$33);
                _$insert(_el$32, outboxFailed, _el$33);
                _$effect(_p$ => {
                  var _v$12 = L().muted,
                    _v$13 = {
                      fg: outboxFailed() ? L().bad : L().muted
                    };
                  _v$12 !== _p$.e && (_p$.e = _$setProp(_el$29, "fg", _v$12, _p$.e));
                  _v$13 !== _p$.t && (_p$.t = _$setProp(_el$32, "style", _v$13, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$29;
              }
            }), _$createComponent(Match, {
              get when() {
                return onChannels();
              },
              get children() {
                var _el$34 = _$createElement("text"),
                  _el$35 = _$createTextNode(` · `),
                  _el$37 = _$createTextNode(` polled · `),
                  _el$39 = _$createElement("span"),
                  _el$40 = _$createTextNode(` failing`);
                _$insertNode(_el$34, _el$35);
                _$insertNode(_el$34, _el$37);
                _$insertNode(_el$34, _el$39);
                _$insert(_el$34, () => plural(chRows().length, "channel"), _el$35);
                _$insert(_el$34, () => chRows().filter(c => chStatus(c) !== "idle").length, _el$37);
                _$insertNode(_el$39, _el$40);
                _$insert(_el$39, () => chRows().filter(c => chStatus(c) === "failing").length, _el$40);
                _$effect(_p$ => {
                  var _v$14 = L().muted,
                    _v$15 = {
                      fg: chRows().some(c => chStatus(c) === "failing") ? L().bad : L().muted
                    };
                  _v$14 !== _p$.e && (_p$.e = _$setProp(_el$34, "fg", _v$14, _p$.e));
                  _v$15 !== _p$.t && (_p$.t = _$setProp(_el$39, "style", _v$15, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$34;
              }
            })];
          }
        }), null);
        _$insert(_el$18, _$createComponent(Show, {
          get when() {
            return onChannels();
          },
          get children() {
            return _$createComponent(Show, {
              get when() {
                return chRows().length;
              },
              get fallback() {
                return _$createComponent(Empty, {
                  title: "No channels yet.",
                  hint: "Ask in chat: \u201C/channel alert me about Datadog monitors that start alerting\u201D."
                });
              },
              get children() {
                var _el$41 = _$createElement("box");
                _$setProp(_el$41, "flexDirection", "row");
                _$setProp(_el$41, "flexGrow", 1);
                _$setProp(_el$41, "flexShrink", 1);
                _$setProp(_el$41, "flexBasis", 0);
                _$setProp(_el$41, "minHeight", 0);
                _$setProp(_el$41, "gap", 2);
                _$insert(_el$41, _$createComponent(List, {
                  title: "CHANNELS",
                  get items() {
                    return chRows();
                  },
                  get index() {
                    return chIndex();
                  },
                  row: c => {
                    const status = chStatus(c);
                    const src = state.channels().sources[c.id];
                    const when = status === "idle" ? "idle" : src?.lastPollAt ? relative(src.lastPollAt, state.now()) : "soon";
                    return {
                      ...statusUI(status),
                      name: c.name,
                      when
                    };
                  }
                }), null);
                _$insert(_el$41, _$createComponent(Show, {
                  get when() {
                    return chSelected();
                  },
                  children: c => {
                    const src = () => state.channels().sources[c().id];
                    const users = () => listeners(c().id);
                    const count = id => state.waiting().counts.get(id)?.get(c().id) ?? 0;
                    const first = id => (state.waiting().first.get(id) ?? []).filter(e => e.channel === c().id).slice(0, 3);
                    const status = () => chStatus(c());
                    return (() => {
                      var _el$53 = _$createElement("scrollbox"),
                        _el$54 = _$createElement("box");
                      _$insertNode(_el$53, _el$54);
                      _$setProp(_el$53, "flexGrow", 1);
                      _$setProp(_el$53, "minHeight", 0);
                      _$setProp(_el$54, "flexDirection", "column");
                      _$setProp(_el$54, "gap", 1);
                      _$insert(_el$54, _$createComponent(Block, {
                        title: "Channel",
                        hue: 0,
                        get children() {
                          return [(() => {
                            var _el$55 = _$createElement("text"),
                              _el$56 = _$createElement("span"),
                              _el$57 = _$createElement("b"),
                              _el$58 = _$createTextNode(`  `),
                              _el$59 = _$createElement("span"),
                              _el$60 = _$createElement("span"),
                              _el$61 = _$createTextNode(`  `),
                              _el$62 = _$createTextNode(` · `);
                            _$insertNode(_el$55, _el$56);
                            _$insertNode(_el$55, _el$58);
                            _$insertNode(_el$55, _el$59);
                            _$insertNode(_el$55, _el$60);
                            _$insertNode(_el$56, _el$57);
                            _$insert(_el$57, () => c().name);
                            _$insert(_el$59, () => ` ${status()} `);
                            _$insertNode(_el$60, _el$61);
                            _$insertNode(_el$60, _el$62);
                            _$insert(_el$60, () => c().id, _el$62);
                            _$insert(_el$60, () => c().source === "config" ? "from config" : "created from chat", null);
                            _$effect(_p$ => {
                              var _v$24 = {
                                  fg: L().text
                                },
                                _v$25 = {
                                  fg: statusUI(status()).fg,
                                  bg: statusUI(status()).bg
                                },
                                _v$26 = {
                                  fg: L().muted
                                };
                              _v$24 !== _p$.e && (_p$.e = _$setProp(_el$56, "style", _v$24, _p$.e));
                              _v$25 !== _p$.t && (_p$.t = _$setProp(_el$59, "style", _v$25, _p$.t));
                              _v$26 !== _p$.a && (_p$.a = _$setProp(_el$60, "style", _v$26, _p$.a));
                              return _p$;
                            }, {
                              e: undefined,
                              t: undefined,
                              a: undefined
                            });
                            return _el$55;
                          })(), (() => {
                            var _el$63 = _$createElement("box");
                            _$setProp(_el$63, "flexDirection", "column");
                            _$insert(_el$63, _$createComponent(Field, {
                              label: "polls",
                              get value() {
                                return c().url;
                              }
                            }), null);
                            _$insert(_el$63, _$createComponent(Field, {
                              label: "every",
                              get value() {
                                return describe({
                                  kind: "every",
                                  ms: c().everyMs || 60_000
                                }).replace(/^every /, "");
                              }
                            }), null);
                            _$insert(_el$63, _$createComponent(Field, {
                              label: "last poll",
                              get value() {
                                return _$memo(() => !!src()?.lastPollAt)() ? `${clock(src().lastPollAt)}  (${relative(src().lastPollAt, state.now())})` : "never";
                              }
                            }), null);
                            _$insert(_el$63, _$createComponent(Field, {
                              label: "last ok",
                              get value() {
                                return _$memo(() => !!src()?.lastOkAt)() ? clock(src().lastOkAt) : "never";
                              }
                            }), null);
                            _$insert(_el$63, _$createComponent(Show, {
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
                            _$insert(_el$63, _$createComponent(Field, {
                              label: "env",
                              get value() {
                                return _$memo(() => !!c().env.length)() ? c().env.join(", ") : "none";
                              }
                            }), null);
                            return _el$63;
                          })()];
                        }
                      }), null);
                      _$insert(_el$54, _$createComponent(Block, {
                        title: "Mapping",
                        hue: 1,
                        get children() {
                          var _el$64 = _$createElement("box");
                          _$setProp(_el$64, "flexDirection", "column");
                          _$insert(_el$64, _$createComponent(Field, {
                            label: "items",
                            get value() {
                              return c().items || "(the response)";
                            }
                          }), null);
                          _$insert(_el$64, _$createComponent(Field, {
                            label: "filter",
                            get value() {
                              return _$memo(() => !!Object.keys(c().filter).length)() ? JSON.stringify(c().filter) : "none";
                            }
                          }), null);
                          _$insert(_el$64, _$createComponent(Field, {
                            label: "event id",
                            get value() {
                              return c().event.id;
                            }
                          }), null);
                          _$insert(_el$64, _$createComponent(Field, {
                            label: "sessionKey",
                            get value() {
                              return c().event.sessionKey ?? "none";
                            }
                          }), null);
                          _$insert(_el$64, _$createComponent(Field, {
                            label: "title",
                            get value() {
                              return c().event.title ?? "(event id)";
                            }
                          }), null);
                          _$insert(_el$64, _$createComponent(Show, {
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
                          _$insert(_el$64, _$createComponent(Show, {
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
                          return _el$64;
                        }
                      }), null);
                      _$insert(_el$54, _$createComponent(Block, {
                        title: "Automations",
                        hue: 2,
                        get children() {
                          return _$createComponent(Show, {
                            get when() {
                              return users().length;
                            },
                            get fallback() {
                              return (() => {
                                var _el$66 = _$createElement("text");
                                _$insertNode(_el$66, _$createTextNode(`none use it, so it isn't polled`));
                                _$effect(_$p => _$setProp(_el$66, "fg", L().muted, _$p));
                                return _el$66;
                              })();
                            },
                            get children() {
                              var _el$65 = _$createElement("box");
                              _$setProp(_el$65, "flexDirection", "column");
                              _$setProp(_el$65, "gap", 1);
                              _$insert(_el$65, _$createComponent(For, {
                                get each() {
                                  return users();
                                },
                                children: j => (() => {
                                  var _el$68 = _$createElement("box"),
                                    _el$69 = _$createElement("text"),
                                    _el$70 = _$createElement("span"),
                                    _el$71 = _$createTextNode(` `),
                                    _el$72 = _$createElement("span"),
                                    _el$73 = _$createTextNode(`  `),
                                    _el$74 = _$createTextNode(` · `),
                                    _el$75 = _$createTextNode(` waiting`);
                                  _$insertNode(_el$68, _el$69);
                                  _$setProp(_el$68, "flexDirection", "column");
                                  _$insertNode(_el$69, _el$70);
                                  _$insertNode(_el$69, _el$71);
                                  _$insertNode(_el$69, _el$72);
                                  _$insert(_el$70, () => isActive(j) ? "●" : "○");
                                  _$insert(_el$69, () => j.name, _el$72);
                                  _$insertNode(_el$72, _el$73);
                                  _$insertNode(_el$72, _el$74);
                                  _$insertNode(_el$72, _el$75);
                                  _$insert(_el$72, (() => {
                                    var _c$3 = _$memo(() => j.schedule.kind === "event");
                                    return () => _c$3() ? "as events arrive" : describe(j.schedule);
                                  })(), _el$74);
                                  _$insert(_el$72, () => count(j.id), _el$75);
                                  _$insert(_el$68, _$createComponent(For, {
                                    get each() {
                                      return first(j.id);
                                    },
                                    children: e => (() => {
                                      var _el$76 = _$createElement("text");
                                      _$insert(_el$76, () => "  " + e.title.slice(0, 90));
                                      _$effect(_$p => _$setProp(_el$76, "fg", L().muted, _$p));
                                      return _el$76;
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
                                    _v$27 !== _p$.e && (_p$.e = _$setProp(_el$69, "fg", _v$27, _p$.e));
                                    _v$28 !== _p$.t && (_p$.t = _$setProp(_el$70, "style", _v$28, _p$.t));
                                    _v$29 !== _p$.a && (_p$.a = _$setProp(_el$72, "style", _v$29, _p$.a));
                                    return _p$;
                                  }, {
                                    e: undefined,
                                    t: undefined,
                                    a: undefined
                                  });
                                  return _el$68;
                                })()
                              }));
                              return _el$65;
                            }
                          });
                        }
                      }), null);
                      return _el$53;
                    })();
                  }
                }), null);
                return _el$41;
              }
            });
          }
        }), _el$45);
        _$insert(_el$18, _$createComponent(Show, {
          get when() {
            return state.tab() === "inbox";
          },
          get children() {
            return _$createComponent(Show, {
              get when() {
                return inbox().length;
              },
              get fallback() {
                return _$createComponent(Empty, {
                  title: "The inbox is empty.",
                  hint: "Channels write the events they poll here, for the automations attached to them."
                });
              },
              get children() {
                var _el$42 = _$createElement("box");
                _$setProp(_el$42, "flexDirection", "row");
                _$setProp(_el$42, "flexGrow", 1);
                _$setProp(_el$42, "flexShrink", 1);
                _$setProp(_el$42, "flexBasis", 0);
                _$setProp(_el$42, "minHeight", 0);
                _$setProp(_el$42, "gap", 2);
                _$insert(_el$42, _$createComponent(List, {
                  title: "INBOX",
                  get items() {
                    return inbox();
                  },
                  get index() {
                    return evIndex();
                  },
                  row: e => ({
                    ...deliveryUI(deliveryState(e)),
                    name: e.title,
                    when: relative(e.at, state.now())
                  })
                }), null);
                _$insert(_el$42, _$createComponent(Show, {
                  get when() {
                    return evSelected();
                  },
                  children: e => (() => {
                    var _el$77 = _$createElement("scrollbox"),
                      _el$78 = _$createElement("box");
                    _$insertNode(_el$77, _el$78);
                    _$setProp(_el$77, "flexGrow", 1);
                    _$setProp(_el$77, "minHeight", 0);
                    _$setProp(_el$78, "flexDirection", "column");
                    _$setProp(_el$78, "gap", 1);
                    _$insert(_el$78, _$createComponent(Block, {
                      title: "Event",
                      hue: 0,
                      get children() {
                        return [(() => {
                          var _el$79 = _$createElement("text"),
                            _el$80 = _$createElement("b");
                          _$insertNode(_el$79, _el$80);
                          _$insert(_el$80, () => e().title);
                          _$effect(_$p => _$setProp(_el$79, "fg", L().text, _$p));
                          return _el$79;
                        })(), (() => {
                          var _el$81 = _$createElement("box");
                          _$setProp(_el$81, "flexDirection", "column");
                          _$insert(_el$81, _$createComponent(Field, {
                            label: "channel",
                            get value() {
                              return chRows().find(c => c.id === e().channel)?.name ?? e().channel;
                            }
                          }), null);
                          _$insert(_el$81, _$createComponent(Field, {
                            label: "id",
                            get value() {
                              return e().id;
                            }
                          }), null);
                          _$insert(_el$81, _$createComponent(Show, {
                            get when() {
                              return e().sessionKey;
                            },
                            children: k => _$createComponent(Field, {
                              label: "sessionKey",
                              get value() {
                                return k();
                              }
                            })
                          }), null);
                          _$insert(_el$81, _$createComponent(Field, {
                            label: "first seen",
                            get value() {
                              return `${clock(e().at)}  (${relative(e().at, state.now())})`;
                            }
                          }), null);
                          _$insert(_el$81, _$createComponent(Field, {
                            label: "last seen",
                            get value() {
                              return `${clock(e().seenAt)}  (${relative(e().seenAt, state.now())})`;
                            }
                          }), null);
                          _$insert(_el$81, _$createComponent(Show, {
                            get when() {
                              return e().url;
                            },
                            children: u => _$createComponent(Field, {
                              label: "url",
                              get value() {
                                return u();
                              }
                            })
                          }), null);
                          return _el$81;
                        })()];
                      }
                    }), null);
                    _$insert(_el$78, _$createComponent(Show, {
                      get when() {
                        return e().body;
                      },
                      children: b => _$createComponent(Block, {
                        title: "Body",
                        hue: 1,
                        get children() {
                          var _el$83 = _$createElement("text");
                          _$insert(_el$83, b);
                          _$effect(_$p => _$setProp(_el$83, "fg", L().text, _$p));
                          return _el$83;
                        }
                      })
                    }), null);
                    _$insert(_el$78, _$createComponent(Block, {
                      title: "Automations",
                      hue: 2,
                      get children() {
                        return _$createComponent(Show, {
                          get when() {
                            return e().deliveries.length;
                          },
                          get fallback() {
                            return (() => {
                              var _el$84 = _$createElement("text");
                              _$insertNode(_el$84, _$createTextNode(`none took it or waits for it`));
                              _$effect(_$p => _$setProp(_el$84, "fg", L().muted, _$p));
                              return _el$84;
                            })();
                          },
                          get children() {
                            var _el$82 = _$createElement("box");
                            _$setProp(_el$82, "flexDirection", "column");
                            _$insert(_el$82, _$createComponent(For, {
                              get each() {
                                return e().deliveries;
                              },
                              children: d => (() => {
                                var _el$86 = _$createElement("text"),
                                  _el$87 = _$createElement("span"),
                                  _el$88 = _$createTextNode(` `),
                                  _el$89 = _$createElement("span"),
                                  _el$90 = _$createTextNode(`  `);
                                _$insertNode(_el$86, _el$87);
                                _$insertNode(_el$86, _el$88);
                                _$insertNode(_el$86, _el$89);
                                _$insert(_el$87, () => deliveryUI(d.status).dot);
                                _$insert(_el$86, () => jobName(d.job), _el$89);
                                _$insertNode(_el$89, _el$90);
                                _$insert(_el$89, () => d.status, null);
                                _$insert(_el$89, (() => {
                                  var _c$4 = _$memo(() => d.status === "waiting");
                                  return () => _c$4() ? idleNote(jobByID().get(d.job)) : "";
                                })(), null);
                                _$effect(_p$ => {
                                  var _v$30 = L().text,
                                    _v$31 = {
                                      fg: deliveryUI(d.status).fg
                                    },
                                    _v$32 = {
                                      fg: L().muted
                                    };
                                  _v$30 !== _p$.e && (_p$.e = _$setProp(_el$86, "fg", _v$30, _p$.e));
                                  _v$31 !== _p$.t && (_p$.t = _$setProp(_el$87, "style", _v$31, _p$.t));
                                  _v$32 !== _p$.a && (_p$.a = _$setProp(_el$89, "style", _v$32, _p$.a));
                                  return _p$;
                                }, {
                                  e: undefined,
                                  t: undefined,
                                  a: undefined
                                });
                                return _el$86;
                              })()
                            }));
                            return _el$82;
                          }
                        });
                      }
                    }), null);
                    return _el$77;
                  })()
                }), null);
                return _el$42;
              }
            });
          }
        }), _el$45);
        _$insert(_el$18, _$createComponent(Show, {
          get when() {
            return state.tab() === "outbox";
          },
          get children() {
            return _$createComponent(Show, {
              get when() {
                return outbox().length;
              },
              get fallback() {
                return _$createComponent(Empty, {
                  title: "Nothing has been sent yet.",
                  hint: "What automations notify you of is kept here, with how each destination took it."
                });
              },
              get children() {
                var _el$43 = _$createElement("box");
                _$setProp(_el$43, "flexDirection", "row");
                _$setProp(_el$43, "flexGrow", 1);
                _$setProp(_el$43, "flexShrink", 1);
                _$setProp(_el$43, "flexBasis", 0);
                _$setProp(_el$43, "minHeight", 0);
                _$setProp(_el$43, "gap", 2);
                _$insert(_el$43, _$createComponent(List, {
                  title: "OUTBOX",
                  get items() {
                    return outbox();
                  },
                  get index() {
                    return msgIndex();
                  },
                  row: m => ({
                    ...sendUI(sendState(m)),
                    name: m.title,
                    when: relative(m.at, state.now())
                  })
                }), null);
                _$insert(_el$43, _$createComponent(Show, {
                  get when() {
                    return msgSelected();
                  },
                  children: m => (() => {
                    var _el$91 = _$createElement("scrollbox"),
                      _el$92 = _$createElement("box");
                    _$insertNode(_el$91, _el$92);
                    _$setProp(_el$91, "flexGrow", 1);
                    _$setProp(_el$91, "minHeight", 0);
                    _$setProp(_el$92, "flexDirection", "column");
                    _$setProp(_el$92, "gap", 1);
                    _$insert(_el$92, _$createComponent(Block, {
                      title: "Message",
                      hue: 0,
                      get children() {
                        return [(() => {
                          var _el$93 = _$createElement("text"),
                            _el$94 = _$createElement("b");
                          _$insertNode(_el$93, _el$94);
                          _$insert(_el$94, () => m().title);
                          _$effect(_$p => _$setProp(_el$93, "fg", L().text, _$p));
                          return _el$93;
                        })(), (() => {
                          var _el$95 = _$createElement("box");
                          _$setProp(_el$95, "flexDirection", "column");
                          _$insert(_el$95, _$createComponent(Field, {
                            label: "from",
                            get value() {
                              return jobName(m().job);
                            }
                          }), null);
                          _$insert(_el$95, _$createComponent(Field, {
                            label: "sent",
                            get value() {
                              return `${clock(m().at)}  (${relative(m().at, state.now())})`;
                            }
                          }), null);
                          _$insert(_el$95, _$createComponent(Field, {
                            label: "priority",
                            get value() {
                              return m().priority;
                            }
                          }), null);
                          _$insert(_el$95, _$createComponent(Show, {
                            get when() {
                              return m().url;
                            },
                            children: u => _$createComponent(Field, {
                              label: "url",
                              get value() {
                                return _$memo(() => !!m().urlTitle)() ? `${m().urlTitle}  ${u()}` : u();
                              }
                            })
                          }), null);
                          _$insert(_el$95, _$createComponent(Show, {
                            get when() {
                              return m().run;
                            },
                            children: r => _$createComponent(Field, {
                              label: "run",
                              get value() {
                                return r();
                              }
                            })
                          }), null);
                          return _el$95;
                        })()];
                      }
                    }), null);
                    _$insert(_el$92, _$createComponent(Block, {
                      title: "Body",
                      hue: 1,
                      get children() {
                        var _el$96 = _$createElement("text");
                        _$insert(_el$96, () => m().body);
                        _$effect(_$p => _$setProp(_el$96, "fg", L().text, _$p));
                        return _el$96;
                      }
                    }), null);
                    _$insert(_el$92, _$createComponent(Block, {
                      title: "Destinations",
                      hue: 3,
                      get children() {
                        return _$createComponent(Show, {
                          get when() {
                            return m().sends.length;
                          },
                          get fallback() {
                            return (() => {
                              var _el$98 = _$createElement("text");
                              _$insertNode(_el$98, _$createTextNode(`no destination takes it`));
                              _$effect(_$p => _$setProp(_el$98, "fg", L().muted, _$p));
                              return _el$98;
                            })();
                          },
                          get children() {
                            var _el$97 = _$createElement("box");
                            _$setProp(_el$97, "flexDirection", "column");
                            _$insert(_el$97, _$createComponent(For, {
                              get each() {
                                return m().sends;
                              },
                              children: x => (() => {
                                var _el$100 = _$createElement("box"),
                                  _el$101 = _$createElement("text"),
                                  _el$102 = _$createElement("span"),
                                  _el$103 = _$createTextNode(` `),
                                  _el$104 = _$createElement("span"),
                                  _el$105 = _$createTextNode(`  `);
                                _$insertNode(_el$100, _el$101);
                                _$setProp(_el$100, "flexDirection", "column");
                                _$insertNode(_el$101, _el$102);
                                _$insertNode(_el$101, _el$103);
                                _$insertNode(_el$101, _el$104);
                                _$insert(_el$102, () => sendUI(x.status).dot);
                                _$insert(_el$101, () => x.destination, _el$104);
                                _$insertNode(_el$104, _el$105);
                                _$insert(_el$104, () => x.status, null);
                                _$insert(_el$100, _$createComponent(Show, {
                                  get when() {
                                    return x.error;
                                  },
                                  children: err => (() => {
                                    var _el$106 = _$createElement("text");
                                    _$insert(_el$106, () => "  " + err());
                                    _$effect(_$p => _$setProp(_el$106, "fg", L().bad, _$p));
                                    return _el$106;
                                  })()
                                }), null);
                                _$effect(_p$ => {
                                  var _v$33 = L().text,
                                    _v$34 = {
                                      fg: sendUI(x.status).fg
                                    },
                                    _v$35 = {
                                      fg: L().muted
                                    };
                                  _v$33 !== _p$.e && (_p$.e = _$setProp(_el$101, "fg", _v$33, _p$.e));
                                  _v$34 !== _p$.t && (_p$.t = _$setProp(_el$102, "style", _v$34, _p$.t));
                                  _v$35 !== _p$.a && (_p$.a = _$setProp(_el$104, "style", _v$35, _p$.a));
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
                    return _el$91;
                  })()
                }), null);
                return _el$43;
              }
            });
          }
        }), _el$45);
        _$insert(_el$18, _$createComponent(Show, {
          get when() {
            return onJobs();
          },
          get children() {
            return _$createComponent(Show, {
              get when() {
                return sorted().length;
              },
              get fallback() {
                return _$createComponent(Empty, {
                  title: "No automations yet.",
                  hint: "Press n to create one, or ask in chat: \u201Cevery weekday at 8:45, triage my open MRs\u201D."
                });
              },
              get children() {
                var _el$44 = _$createElement("box");
                _$setProp(_el$44, "flexDirection", "row");
                _$setProp(_el$44, "flexGrow", 1);
                _$setProp(_el$44, "flexShrink", 1);
                _$setProp(_el$44, "flexBasis", 0);
                _$setProp(_el$44, "minHeight", 0);
                _$setProp(_el$44, "gap", 2);
                _$insert(_el$44, _$createComponent(List, {
                  title: "JOBS",
                  get items() {
                    return sorted();
                  },
                  get index() {
                    return index();
                  },
                  row: (j, selected) => {
                    const runs = running().has(j.id);
                    return {
                      dot: runs ? "◐" : isActive(j) ? "●" : "○",
                      fg: selected ? L().ok : runs ? L().warn : L().muted,
                      name: j.name,
                      when: runs ? "running" : isActive(j) ? relative(j.nextRunAt, state.now()) : stateOf(j)
                    };
                  }
                }), null);
                _$insert(_el$44, _$createComponent(Show, {
                  get when() {
                    return selected();
                  },
                  children: j => (() => {
                    var _el$107 = _$createElement("scrollbox"),
                      _el$108 = _$createElement("box");
                    _$insertNode(_el$107, _el$108);
                    _$setProp(_el$107, "flexGrow", 1);
                    _$setProp(_el$107, "minHeight", 0);
                    _$setProp(_el$108, "flexDirection", "column");
                    _$setProp(_el$108, "gap", 1);
                    _$insert(_el$108, _$createComponent(Block, {
                      title: "Details",
                      hue: 0,
                      get children() {
                        return [(() => {
                          var _el$109 = _$createElement("text"),
                            _el$110 = _$createElement("span"),
                            _el$111 = _$createElement("b"),
                            _el$112 = _$createTextNode(`  `),
                            _el$113 = _$createElement("span"),
                            _el$114 = _$createElement("span"),
                            _el$115 = _$createTextNode(`  `);
                          _$insertNode(_el$109, _el$110);
                          _$insertNode(_el$109, _el$112);
                          _$insertNode(_el$109, _el$113);
                          _$insertNode(_el$109, _el$114);
                          _$insertNode(_el$110, _el$111);
                          _$insert(_el$111, () => j().name);
                          _$insert(_el$113, () => badge(j()).label);
                          _$insertNode(_el$114, _el$115);
                          _$insert(_el$114, () => j().id, null);
                          _$insert(_el$114, () => j().source === "config" ? " · from config" : "", null);
                          _$effect(_p$ => {
                            var _v$36 = {
                                fg: L().text
                              },
                              _v$37 = {
                                fg: badge(j()).fg,
                                bg: badge(j()).bg
                              },
                              _v$38 = {
                                fg: L().muted
                              };
                            _v$36 !== _p$.e && (_p$.e = _$setProp(_el$110, "style", _v$36, _p$.e));
                            _v$37 !== _p$.t && (_p$.t = _$setProp(_el$113, "style", _v$37, _p$.t));
                            _v$38 !== _p$.a && (_p$.a = _$setProp(_el$114, "style", _v$38, _p$.a));
                            return _p$;
                          }, {
                            e: undefined,
                            t: undefined,
                            a: undefined
                          });
                          return _el$109;
                        })(), (() => {
                          var _el$116 = _$createElement("box");
                          _$setProp(_el$116, "flexDirection", "column");
                          _$insert(_el$116, _$createComponent(Field, {
                            label: "schedule",
                            get value() {
                              return describe(j().schedule);
                            }
                          }), null);
                          _$insert(_el$116, _$createComponent(Show, {
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
                          _$insert(_el$116, _$createComponent(Field, {
                            label: "next",
                            get value() {
                              return _$memo(() => !!isActive(j()))() ? `${clock(j().nextRunAt)}  (${relative(j().nextRunAt, state.now())})` : "—";
                            }
                          }), null);
                          _$insert(_el$116, _$createComponent(Field, {
                            label: "last",
                            get value() {
                              return _$memo(() => !!j().lastRunAt)() ? `${clock(j().lastRunAt)}  ${j().lastStatus ?? ""}` : "never";
                            },
                            get fg() {
                              return _$memo(() => !!j().lastStatus)() ? statusColor(j().lastStatus) : undefined;
                            }
                          }), null);
                          _$insert(_el$116, _$createComponent(Field, {
                            label: "session",
                            get value() {
                              return j().session + (j().sessionID ? `  ${j().sessionID}` : "");
                            }
                          }), null);
                          _$insert(_el$116, _$createComponent(Field, {
                            label: "agent",
                            get value() {
                              return j().agent ?? "default";
                            }
                          }), null);
                          _$insert(_el$116, _$createComponent(Field, {
                            label: "model",
                            get value() {
                              return _$memo(() => j().session === "current")() ? "chat's model" : j().model ?? "agent default";
                            }
                          }), null);
                          _$insert(_el$116, _$createComponent(Field, {
                            label: "directory",
                            get value() {
                              return ctx.ui.format.path(j().directory);
                            }
                          }), null);
                          _$insert(_el$116, _$createComponent(Field, {
                            label: "timeout",
                            get value() {
                              return `${j().timeoutMinutes}m · run missed ${j().runMissed ? "on" : "off"}`;
                            }
                          }), null);
                          return _el$116;
                        })()];
                      }
                    }), null);
                    _$insert(_el$108, _$createComponent(Block, {
                      title: "Prompt",
                      hue: 1,
                      get children() {
                        var _el$117 = _$createElement("text");
                        _$insert(_el$117, () => j().prompt);
                        _$effect(_$p => _$setProp(_el$117, "fg", L().text, _$p));
                        return _el$117;
                      }
                    }), null);
                    _$insert(_el$108, _$createComponent(Show, {
                      get when() {
                        return jobSent().length;
                      },
                      get children() {
                        return _$createComponent(Block, {
                          title: "Notified",
                          hue: 3,
                          get children() {
                            var _el$118 = _$createElement("box");
                            _$setProp(_el$118, "flexDirection", "column");
                            _$insert(_el$118, _$createComponent(For, {
                              get each() {
                                return jobSent();
                              },
                              children: m => (() => {
                                var _el$121 = _$createElement("text"),
                                  _el$122 = _$createTextNode(` `),
                                  _el$123 = _$createElement("span"),
                                  _el$124 = _$createTextNode(`  `);
                                _$insertNode(_el$121, _el$122);
                                _$insertNode(_el$121, _el$123);
                                _$insert(_el$121, () => clock(m.at), _el$122);
                                _$insert(_el$121, () => m.title.slice(0, 60), _el$123);
                                _$insertNode(_el$123, _el$124);
                                _$insert(_el$123, () => m.sends.map(x => `${x.destination} ${x.status}`).join(", ") || "no destination takes it", null);
                                _$effect(_p$ => {
                                  var _v$39 = L().text,
                                    _v$40 = {
                                      fg: sendState(m) === "failed" ? L().bad : L().muted
                                    };
                                  _v$39 !== _p$.e && (_p$.e = _$setProp(_el$121, "fg", _v$39, _p$.e));
                                  _v$40 !== _p$.t && (_p$.t = _$setProp(_el$123, "style", _v$40, _p$.t));
                                  return _p$;
                                }, {
                                  e: undefined,
                                  t: undefined
                                });
                                return _el$121;
                              })()
                            }));
                            return _el$118;
                          }
                        });
                      }
                    }), null);
                    _$insert(_el$108, _$createComponent(Show, {
                      get when() {
                        return jobNotes().length;
                      },
                      get children() {
                        return _$createComponent(Block, {
                          title: "Memory",
                          hue: 4,
                          get children() {
                            var _el$119 = _$createElement("box");
                            _$setProp(_el$119, "flexDirection", "column");
                            _$setProp(_el$119, "gap", 1);
                            _$insert(_el$119, _$createComponent(For, {
                              get each() {
                                return jobNotes();
                              },
                              children: n => (() => {
                                var _el$125 = _$createElement("box"),
                                  _el$126 = _$createElement("text"),
                                  _el$127 = _$createTextNode(`updated `),
                                  _el$128 = _$createTextNode(` (`),
                                  _el$129 = _$createTextNode(`)`),
                                  _el$130 = _$createElement("text");
                                _$insertNode(_el$125, _el$126);
                                _$insertNode(_el$125, _el$130);
                                _$setProp(_el$125, "flexDirection", "column");
                                _$insertNode(_el$126, _el$127);
                                _$insertNode(_el$126, _el$128);
                                _$insertNode(_el$126, _el$129);
                                _$insert(_el$126, (() => {
                                  var _c$5 = _$memo(() => !!n.key);
                                  return () => _c$5() ? `${n.key} · ` : "";
                                })(), _el$127);
                                _$insert(_el$126, () => clock(n.updatedAt), _el$128);
                                _$insert(_el$126, () => relative(n.updatedAt, state.now()), _el$129);
                                _$insert(_el$130, () => n.note);
                                _$effect(_p$ => {
                                  var _v$41 = L().muted,
                                    _v$42 = L().text;
                                  _v$41 !== _p$.e && (_p$.e = _$setProp(_el$126, "fg", _v$41, _p$.e));
                                  _v$42 !== _p$.t && (_p$.t = _$setProp(_el$130, "fg", _v$42, _p$.t));
                                  return _p$;
                                }, {
                                  e: undefined,
                                  t: undefined
                                });
                                return _el$125;
                              })()
                            }));
                            return _el$119;
                          }
                        });
                      }
                    }), null);
                    _$insert(_el$108, _$createComponent(Block, {
                      title: "Recent runs",
                      hue: 2,
                      get children() {
                        return _$createComponent(Show, {
                          get when() {
                            return jobRuns().length;
                          },
                          get fallback() {
                            return (() => {
                              var _el$131 = _$createElement("text");
                              _$insertNode(_el$131, _$createTextNode(`none yet`));
                              _$effect(_$p => _$setProp(_el$131, "fg", L().muted, _$p));
                              return _el$131;
                            })();
                          },
                          get children() {
                            var _el$120 = _$createElement("box");
                            _$setProp(_el$120, "flexDirection", "column");
                            _$insert(_el$120, _$createComponent(For, {
                              get each() {
                                return jobRuns();
                              },
                              children: r => (() => {
                                var _el$133 = _$createElement("box"),
                                  _el$134 = _$createElement("text"),
                                  _el$135 = _$createElement("span"),
                                  _el$136 = _$createTextNode(` `),
                                  _el$137 = _$createElement("span"),
                                  _el$138 = _$createTextNode(`  `),
                                  _el$139 = _$createTextNode(` `);
                                _$insertNode(_el$133, _el$134);
                                _$setProp(_el$133, "flexDirection", "column");
                                _$insertNode(_el$134, _el$135);
                                _$insertNode(_el$134, _el$136);
                                _$insertNode(_el$134, _el$137);
                                _$insert(_el$135, () => glyph[r.status]);
                                _$insert(_el$134, () => clock(r.startedAt), _el$137);
                                _$insertNode(_el$137, _el$138);
                                _$insertNode(_el$137, _el$139);
                                _$insert(_el$137, () => r.status, _el$139);
                                _$insert(_el$137, () => elapsed(r), null);
                                _$insert(_el$133, _$createComponent(Show, {
                                  get when() {
                                    return r.error;
                                  },
                                  children: error => (() => {
                                    var _el$140 = _$createElement("text");
                                    _$insert(_el$140, () => "  " + error().slice(0, 100));
                                    _$effect(_$p => _$setProp(_el$140, "fg", L().bad, _$p));
                                    return _el$140;
                                  })()
                                }), null);
                                _$effect(_p$ => {
                                  var _v$43 = L().text,
                                    _v$44 = {
                                      fg: statusColor(r.status)
                                    },
                                    _v$45 = {
                                      fg: L().muted
                                    };
                                  _v$43 !== _p$.e && (_p$.e = _$setProp(_el$134, "fg", _v$43, _p$.e));
                                  _v$44 !== _p$.t && (_p$.t = _$setProp(_el$135, "style", _v$44, _p$.t));
                                  _v$45 !== _p$.a && (_p$.a = _$setProp(_el$137, "style", _v$45, _p$.a));
                                  return _p$;
                                }, {
                                  e: undefined,
                                  t: undefined,
                                  a: undefined
                                });
                                return _el$133;
                              })()
                            }));
                            return _el$120;
                          }
                        });
                      }
                    }), null);
                    return _el$107;
                  })()
                }), null);
                return _el$44;
              }
            });
          }
        }), _el$45);
        _$setProp(_el$45, "flexDirection", "row");
        _$setProp(_el$45, "flexWrap", "wrap");
        _$setProp(_el$45, "paddingTop", 1);
        _$setProp(_el$45, "paddingBottom", 1);
        _$setProp(_el$45, "columnGap", 2);
        _$setProp(_el$45, "flexShrink", 0);
        _$insert(_el$45, _$createComponent(For, {
          get each() {
            return [...tabHints(state.tab()), ...(onJobs() ? keyHints : onChannels() ? channelHints : listHints)];
          },
          children: ([key, label]) => (() => {
            var _el$141 = _$createElement("text"),
              _el$142 = _$createElement("span"),
              _el$143 = _$createTextNode(` `),
              _el$144 = _$createTextNode(` `),
              _el$145 = _$createElement("span"),
              _el$146 = _$createTextNode(` `);
            _$insertNode(_el$141, _el$142);
            _$insertNode(_el$141, _el$145);
            _$insertNode(_el$142, _el$143);
            _$insertNode(_el$142, _el$144);
            _$insert(_el$142, key, _el$144);
            _$insertNode(_el$145, _el$146);
            _$insert(_el$145, label, null);
            _$effect(_p$ => {
              var _v$46 = {
                  fg: L().text,
                  bg: L().cap
                },
                _v$47 = {
                  fg: L().muted
                };
              _v$46 !== _p$.e && (_p$.e = _$setProp(_el$142, "style", _v$46, _p$.e));
              _v$47 !== _p$.t && (_p$.t = _$setProp(_el$145, "style", _v$47, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$141;
          })()
        }));
        _$effect(_p$ => {
          var _v$16 = p().left,
            _v$17 = p().top,
            _v$18 = p().width,
            _v$19 = p().height,
            _v$20 = t.background.base,
            _v$21 = L().text;
          _v$16 !== _p$.e && (_p$.e = _$setProp(_el$18, "left", _v$16, _p$.e));
          _v$17 !== _p$.t && (_p$.t = _$setProp(_el$18, "top", _v$17, _p$.t));
          _v$18 !== _p$.a && (_p$.a = _$setProp(_el$18, "width", _v$18, _p$.a));
          _v$19 !== _p$.o && (_p$.o = _$setProp(_el$18, "height", _v$19, _p$.o));
          _v$20 !== _p$.i && (_p$.i = _$setProp(_el$18, "backgroundColor", _v$20, _p$.i));
          _v$21 !== _p$.n && (_p$.n = _$setProp(_el$21, "fg", _v$21, _p$.n));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined,
          i: undefined,
          n: undefined
        });
        return _el$18;
      })()
    }));
    return _el$17;
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
      var _el$147 = _$createElement("box"),
        _el$148 = _$createElement("text"),
        _el$149 = _$createElement("b"),
        _el$151 = _$createElement("text");
      _$insertNode(_el$147, _el$148);
      _$insertNode(_el$147, _el$151);
      _$setProp(_el$147, "flexDirection", "column");
      _$setProp(_el$147, "marginTop", 1);
      _$setProp(_el$147, "paddingLeft", 1);
      _$setProp(_el$147, "paddingRight", 1);
      _$setProp(_el$147, "paddingTop", 1);
      _$setProp(_el$147, "paddingBottom", 1);
      _$insertNode(_el$148, _el$149);
      _$insertNode(_el$149, _$createTextNode(`⏰ Automations`));
      _$insert(_el$147, _$createComponent(Show, {
        get when() {
          return thisRun();
        },
        children: r => (() => {
          var _el$153 = _$createElement("text"),
            _el$154 = _$createTextNode(`this session: `),
            _el$155 = _$createTextNode(` `);
          _$insertNode(_el$153, _el$154);
          _$insertNode(_el$153, _el$155);
          _$insert(_el$153, () => r().jobID, _el$155);
          _$insert(_el$153, () => glyph[r().status], null);
          _$effect(_$p => _$setProp(_el$153, "fg", L().info, _$p));
          return _el$153;
        })()
      }), _el$151);
      _$insert(_el$147, _$createComponent(For, {
        get each() {
          return upcoming();
        },
        children: j => (() => {
          var _el$156 = _$createElement("box"),
            _el$157 = _$createElement("text"),
            _el$158 = _$createElement("text");
          _$insertNode(_el$156, _el$157);
          _$insertNode(_el$156, _el$158);
          _$setProp(_el$156, "flexDirection", "row");
          _$setProp(_el$156, "justifyContent", "space-between");
          _$insert(_el$157, () => j.name.slice(0, 18));
          _$insert(_el$158, () => relative(j.nextRunAt, state.now()));
          _$effect(_p$ => {
            var _v$51 = L().text,
              _v$52 = L().muted;
            _v$51 !== _p$.e && (_p$.e = _$setProp(_el$157, "fg", _v$51, _p$.e));
            _v$52 !== _p$.t && (_p$.t = _$setProp(_el$158, "fg", _v$52, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$156;
        })()
      }), _el$151);
      _$insertNode(_el$151, _$createTextNode(`/automations`));
      _$effect(_p$ => {
        var _v$48 = L().panel,
          _v$49 = L().ink(0),
          _v$50 = L().faint;
        _v$48 !== _p$.e && (_p$.e = _$setProp(_el$147, "backgroundColor", _v$48, _p$.e));
        _v$49 !== _p$.t && (_p$.t = _$setProp(_el$148, "fg", _v$49, _p$.t));
        _v$50 !== _p$.a && (_p$.a = _$setProp(_el$151, "fg", _v$50, _p$.a));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined
      });
      return _el$147;
    }
  });
}
export default Plugin.define({
  id: "automations.tui",
  setup: ctx => {
    const dataDir = typeof ctx.options.dataDir === "string" ? ctx.options.dataDir : defaultDataDir();
    const state = createState(ctx, dataDir);

    // Re-read when another process commits; a slow tick moves "in 12m" labels on.
    let version = state.store.version();
    const watcher = setInterval(() => {
      try {
        const v = state.store.version();
        if (v !== version) {
          version = v;
          state.refresh();
        }
      } catch {}
    }, 500);
    const ticker = setInterval(state.tick, 15_000);

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
      clearInterval(watcher);
      clearInterval(ticker);
      state.store.close();
      for (const u of unregister) u();
    };
  }
});
