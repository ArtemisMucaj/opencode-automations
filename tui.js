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
/** The keys that switch tabs; pressing the open tab's key goes back to the automations. */
const tabKeys = {
  channels: "c",
  inbox: "i",
  outbox: "o"
};
const tabHints = tab => tab === "jobs" ? [["c", "channels"], ["i", "inbox"], ["o", "outbox"]] : [[tabKeys[tab], "automations"], ...Object.entries(tabKeys).filter(([t]) => t !== tab).map(([t, k]) => [k, t])];
const keyHints = [["↑↓", "select"], ["space", "pause"], ["r", "run now"], ["n", "new"], ["e", "prompt"], ["s", "schedule"], ["m", "model"], ["d", "delete"], ["⏎", "open session"], ["esc", "close"]];
const channelHints = [["↑↓", "select"], ["p", "poll now"], ["d", "delete"], ["esc", "close"]];
const listHints = [["↑↓", "select"], ["esc", "close"]];
/** How many of the latest inbox events and outbox messages the tabs show. */
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
  // Bumped on every refresh, for reads made only while they're shown (a job's memory, the inbox and outbox tabs).
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
  // Only the selected job's notes are read, again on each refresh.
  const jobNotes = createMemo(() => {
    state.refreshed();
    const id = selected()?.id;
    if (!id) return [];
    try {
      return state.store.notes(id);
    } catch {
      return [];
    }
  });

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
  const moveChannel = d => {
    const next = chRows()[Math.max(0, Math.min(chRows().length - 1, chIndex() + d))];
    if (next) state.setSelectedChannel(next.id);
  };
  const running = createMemo(() => runningJobs(state.jobs(), state.runs(), state.now()));
  const jobName = id => id ? state.jobs().find(j => j.id === id)?.name ?? id : "chat";

  // ---- inbox and outbox tabs: read only while open ----
  const inbox = createMemo(() => {
    state.refreshed();
    if (state.tab() !== "inbox") return [];
    try {
      return state.store.inbox(LIST_LIMIT);
    } catch {
      return [];
    }
  });
  const evIndex = createMemo(() => Math.max(0, inbox().findIndex(e => e.seq === state.selectedEvent())));
  const evSelected = createMemo(() => inbox()[evIndex()]);
  const outbox = createMemo(() => {
    state.refreshed();
    if (state.tab() !== "outbox") return [];
    try {
      return state.store.sent(undefined, LIST_LIMIT);
    } catch {
      return [];
    }
  });
  const msgIndex = createMemo(() => Math.max(0, outbox().findIndex(m => m.id === state.selectedMessage())));
  const msgSelected = createMemo(() => outbox()[msgIndex()]);
  // Long lists show the rows around the cursor that fit: the panel less its header, the list's title and the hints.
  const fits = () => Math.max(5, (panel()?.height ?? 30) - 10);
  const windowStart = (length, i) => Math.max(0, Math.min(length - fits(), i - Math.floor(fits() / 2)));
  const visible = (list, i) => list.slice(windowStart(list.length, i), windowStart(list.length, i) + fits());

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
    if (tab === "channels") moveChannel(d);else if (tab === "inbox") stepIn(inbox(), evIndex(), d, e => state.setSelectedEvent(e.seq));else if (tab === "outbox") stepIn(outbox(), msgIndex(), d, m => state.setSelectedMessage(m.id));else move(d);
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
  /** An inbox event's overall fate: waiting if any automation still waits for it. */
  const fate = e => e.deliveries.some(d => d.status === "waiting") ? "waiting" : e.deliveries.some(d => d.status === "dropped") ? "dropped" : e.deliveries.length ? "taken" : "unclaimed";
  const fateLook = f => ({
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
  /** A message's overall delivery: failed if any destination failed, pending while any is still trying. */
  const sendState = m => m.sends.some(x => x.status === "failed") ? "failed" : m.sends.some(x => x.status === "pending") ? "pending" : m.sends.length ? "sent" : "none";
  const sendLook = st => ({
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
          _el$58 = _$createElement("box");
        _$insertNode(_el$11, _el$12);
        _$insertNode(_el$11, _el$58);
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
        _$setProp(_el$13, "flexDirection", "row");
        _$setProp(_el$13, "gap", 2);
        _$insertNode(_el$14, _el$15);
        _$insertNode(_el$15, _$createTextNode(`⏰ Automations`));
        _$insert(_el$13, _$createComponent(For, {
          each: ["jobs", "channels", "inbox", "outbox"],
          children: tab => (() => {
            var _el$59 = _$createElement("text");
            _$insert(_el$59, () => state.tab() === tab ? `[${tab}]` : ` ${tab} `);
            _$effect(_$p => _$setProp(_el$59, "fg", state.tab() === tab ? L().ink(0) : L().muted, _$p));
            return _el$59;
          })()
        }), null);
        _$insert(_el$12, _$createComponent(Switch, {
          get fallback() {
            return (() => {
              var _el$60 = _$createElement("text"),
                _el$61 = _$createTextNode(` · `),
                _el$62 = _$createTextNode(` active · `),
                _el$64 = _$createElement("span"),
                _el$65 = _$createTextNode(` running`);
              _$insertNode(_el$60, _el$61);
              _$insertNode(_el$60, _el$62);
              _$insertNode(_el$60, _el$64);
              _$insert(_el$60, () => plural(state.jobs().length, "job"), _el$61);
              _$insert(_el$60, activeCount, _el$62);
              _$insertNode(_el$64, _el$65);
              _$insert(_el$64, () => running().size, _el$65);
              _$effect(_p$ => {
                var _v$25 = L().muted,
                  _v$26 = {
                    fg: running().size ? L().warn : L().muted
                  };
                _v$25 !== _p$.e && (_p$.e = _$setProp(_el$60, "fg", _v$25, _p$.e));
                _v$26 !== _p$.t && (_p$.t = _$setProp(_el$64, "style", _v$26, _p$.t));
                return _p$;
              }, {
                e: undefined,
                t: undefined
              });
              return _el$60;
            })();
          },
          get children() {
            return [_$createComponent(Match, {
              get when() {
                return state.tab() === "inbox";
              },
              get children() {
                var _el$17 = _$createElement("text"),
                  _el$18 = _$createTextNode(` · `),
                  _el$20 = _$createElement("span"),
                  _el$21 = _$createTextNode(` waiting`);
                _$insertNode(_el$17, _el$18);
                _$insertNode(_el$17, _el$20);
                _$insert(_el$17, (() => {
                  var _c$ = _$memo(() => inbox().length >= LIST_LIMIT);
                  return () => _c$() ? `latest ${LIST_LIMIT}` : plural(inbox().length, "event");
                })(), _el$18);
                _$insertNode(_el$20, _el$21);
                _$insert(_el$20, () => inbox().filter(e => e.deliveries.some(d => d.status === "waiting")).length, _el$21);
                _$effect(_p$ => {
                  var _v$7 = L().muted,
                    _v$8 = {
                      fg: L().warn
                    };
                  _v$7 !== _p$.e && (_p$.e = _$setProp(_el$17, "fg", _v$7, _p$.e));
                  _v$8 !== _p$.t && (_p$.t = _$setProp(_el$20, "style", _v$8, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$17;
              }
            }), _$createComponent(Match, {
              get when() {
                return state.tab() === "outbox";
              },
              get children() {
                var _el$22 = _$createElement("text"),
                  _el$23 = _$createTextNode(` · `),
                  _el$25 = _$createElement("span"),
                  _el$26 = _$createTextNode(` failed`);
                _$insertNode(_el$22, _el$23);
                _$insertNode(_el$22, _el$25);
                _$insert(_el$22, (() => {
                  var _c$2 = _$memo(() => outbox().length >= LIST_LIMIT);
                  return () => _c$2() ? `latest ${LIST_LIMIT}` : plural(outbox().length, "message");
                })(), _el$23);
                _$insertNode(_el$25, _el$26);
                _$insert(_el$25, () => outbox().filter(m => sendState(m) === "failed").length, _el$26);
                _$effect(_p$ => {
                  var _v$9 = L().muted,
                    _v$0 = {
                      fg: outbox().some(m => sendState(m) === "failed") ? L().bad : L().muted
                    };
                  _v$9 !== _p$.e && (_p$.e = _$setProp(_el$22, "fg", _v$9, _p$.e));
                  _v$0 !== _p$.t && (_p$.t = _$setProp(_el$25, "style", _v$0, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$22;
              }
            }), _$createComponent(Match, {
              get when() {
                return onChannels();
              },
              get children() {
                var _el$27 = _$createElement("text"),
                  _el$28 = _$createTextNode(` · `),
                  _el$30 = _$createTextNode(` polled · `),
                  _el$32 = _$createElement("span"),
                  _el$33 = _$createTextNode(` failing`);
                _$insertNode(_el$27, _el$28);
                _$insertNode(_el$27, _el$30);
                _$insertNode(_el$27, _el$32);
                _$insert(_el$27, () => plural(chRows().length, "channel"), _el$28);
                _$insert(_el$27, () => chRows().filter(c => chStatus(c) !== "idle").length, _el$30);
                _$insertNode(_el$32, _el$33);
                _$insert(_el$32, () => chRows().filter(c => chStatus(c) === "failing").length, _el$33);
                _$effect(_p$ => {
                  var _v$1 = L().muted,
                    _v$10 = {
                      fg: chRows().some(c => chStatus(c) === "failing") ? L().bad : L().muted
                    };
                  _v$1 !== _p$.e && (_p$.e = _$setProp(_el$27, "fg", _v$1, _p$.e));
                  _v$10 !== _p$.t && (_p$.t = _$setProp(_el$32, "style", _v$10, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$27;
              }
            })];
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
                  var _el$66 = _$createElement("box"),
                    _el$67 = _$createElement("text"),
                    _el$69 = _$createElement("text");
                  _$insertNode(_el$66, _el$67);
                  _$insertNode(_el$66, _el$69);
                  _$setProp(_el$66, "padding", 2);
                  _$setProp(_el$66, "flexDirection", "column");
                  _$setProp(_el$66, "gap", 1);
                  _$insertNode(_el$67, _$createTextNode(`No channels yet.`));
                  _$insertNode(_el$69, _$createTextNode(`Ask in chat: “/channel alert me about Datadog monitors that start alerting”.`));
                  _$effect(_p$ => {
                    var _v$27 = L().panel,
                      _v$28 = L().text,
                      _v$29 = L().muted;
                    _v$27 !== _p$.e && (_p$.e = _$setProp(_el$66, "backgroundColor", _v$27, _p$.e));
                    _v$28 !== _p$.t && (_p$.t = _$setProp(_el$67, "fg", _v$28, _p$.t));
                    _v$29 !== _p$.a && (_p$.a = _$setProp(_el$69, "fg", _v$29, _p$.a));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined
                  });
                  return _el$66;
                })();
              },
              get children() {
                var _el$34 = _$createElement("box"),
                  _el$35 = _$createElement("box"),
                  _el$36 = _$createElement("box"),
                  _el$37 = _$createElement("text"),
                  _el$38 = _$createElement("b");
                _$insertNode(_el$34, _el$35);
                _$setProp(_el$34, "flexDirection", "row");
                _$setProp(_el$34, "flexGrow", 1);
                _$setProp(_el$34, "flexShrink", 1);
                _$setProp(_el$34, "flexBasis", 0);
                _$setProp(_el$34, "minHeight", 0);
                _$setProp(_el$34, "gap", 2);
                _$insertNode(_el$35, _el$36);
                _$setProp(_el$35, "flexDirection", "column");
                _$setProp(_el$35, "width", 38);
                _$setProp(_el$35, "paddingTop", 1);
                _$setProp(_el$35, "paddingBottom", 1);
                _$insertNode(_el$36, _el$37);
                _$setProp(_el$36, "paddingLeft", 2);
                _$setProp(_el$36, "paddingBottom", 1);
                _$insertNode(_el$37, _el$38);
                _$insertNode(_el$38, _$createTextNode(`CHANNELS`));
                _$insert(_el$35, _$createComponent(Index, {
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
                _$insert(_el$34, _$createComponent(Show, {
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
                      var _el$71 = _$createElement("scrollbox"),
                        _el$72 = _$createElement("box");
                      _$insertNode(_el$71, _el$72);
                      _$setProp(_el$71, "flexGrow", 1);
                      _$setProp(_el$71, "minHeight", 0);
                      _$setProp(_el$72, "flexDirection", "column");
                      _$setProp(_el$72, "gap", 1);
                      _$insert(_el$72, _$createComponent(Block, {
                        title: "Channel",
                        hue: 0,
                        get children() {
                          return [(() => {
                            var _el$73 = _$createElement("text"),
                              _el$74 = _$createElement("span"),
                              _el$75 = _$createElement("b"),
                              _el$76 = _$createTextNode(`  `),
                              _el$77 = _$createElement("span"),
                              _el$78 = _$createElement("span"),
                              _el$79 = _$createTextNode(`  `),
                              _el$80 = _$createTextNode(` · `);
                            _$insertNode(_el$73, _el$74);
                            _$insertNode(_el$73, _el$76);
                            _$insertNode(_el$73, _el$77);
                            _$insertNode(_el$73, _el$78);
                            _$insertNode(_el$74, _el$75);
                            _$insert(_el$75, () => c().name);
                            _$insert(_el$77, () => ` ${status()} `);
                            _$insertNode(_el$78, _el$79);
                            _$insertNode(_el$78, _el$80);
                            _$insert(_el$78, () => c().id, _el$80);
                            _$insert(_el$78, () => c().source === "config" ? "from config" : "created from chat", null);
                            _$effect(_p$ => {
                              var _v$30 = {
                                  fg: L().text
                                },
                                _v$31 = {
                                  fg: statusLook(status()).fg,
                                  bg: statusLook(status()).bg
                                },
                                _v$32 = {
                                  fg: L().muted
                                };
                              _v$30 !== _p$.e && (_p$.e = _$setProp(_el$74, "style", _v$30, _p$.e));
                              _v$31 !== _p$.t && (_p$.t = _$setProp(_el$77, "style", _v$31, _p$.t));
                              _v$32 !== _p$.a && (_p$.a = _$setProp(_el$78, "style", _v$32, _p$.a));
                              return _p$;
                            }, {
                              e: undefined,
                              t: undefined,
                              a: undefined
                            });
                            return _el$73;
                          })(), (() => {
                            var _el$81 = _$createElement("box");
                            _$setProp(_el$81, "flexDirection", "column");
                            _$insert(_el$81, _$createComponent(Field, {
                              label: "polls",
                              get value() {
                                return c().url;
                              }
                            }), null);
                            _$insert(_el$81, _$createComponent(Field, {
                              label: "every",
                              get value() {
                                return describe({
                                  kind: "every",
                                  ms: c().everyMs || 60_000
                                }).replace(/^every /, "");
                              }
                            }), null);
                            _$insert(_el$81, _$createComponent(Field, {
                              label: "last poll",
                              get value() {
                                return _$memo(() => !!src()?.lastPollAt)() ? `${clock(src().lastPollAt)}  (${relative(src().lastPollAt, state.now())})` : "never";
                              }
                            }), null);
                            _$insert(_el$81, _$createComponent(Field, {
                              label: "last ok",
                              get value() {
                                return _$memo(() => !!src()?.lastOkAt)() ? clock(src().lastOkAt) : "never";
                              }
                            }), null);
                            _$insert(_el$81, _$createComponent(Show, {
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
                            _$insert(_el$81, _$createComponent(Field, {
                              label: "env",
                              get value() {
                                return _$memo(() => !!c().env.length)() ? c().env.join(", ") : "none";
                              }
                            }), null);
                            return _el$81;
                          })()];
                        }
                      }), null);
                      _$insert(_el$72, _$createComponent(Block, {
                        title: "Mapping",
                        hue: 1,
                        get children() {
                          var _el$82 = _$createElement("box");
                          _$setProp(_el$82, "flexDirection", "column");
                          _$insert(_el$82, _$createComponent(Field, {
                            label: "items",
                            get value() {
                              return c().items || "(the response)";
                            }
                          }), null);
                          _$insert(_el$82, _$createComponent(Field, {
                            label: "filter",
                            get value() {
                              return _$memo(() => !!Object.keys(c().filter).length)() ? JSON.stringify(c().filter) : "none";
                            }
                          }), null);
                          _$insert(_el$82, _$createComponent(Field, {
                            label: "event id",
                            get value() {
                              return c().event.id;
                            }
                          }), null);
                          _$insert(_el$82, _$createComponent(Field, {
                            label: "sessionKey",
                            get value() {
                              return c().event.sessionKey ?? "none";
                            }
                          }), null);
                          _$insert(_el$82, _$createComponent(Field, {
                            label: "title",
                            get value() {
                              return c().event.title ?? "(event id)";
                            }
                          }), null);
                          _$insert(_el$82, _$createComponent(Show, {
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
                          _$insert(_el$82, _$createComponent(Show, {
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
                          return _el$82;
                        }
                      }), null);
                      _$insert(_el$72, _$createComponent(Block, {
                        title: "Automations",
                        hue: 2,
                        get children() {
                          return _$createComponent(Show, {
                            get when() {
                              return users().length;
                            },
                            get fallback() {
                              return (() => {
                                var _el$84 = _$createElement("text");
                                _$insertNode(_el$84, _$createTextNode(`none use it, so it isn't polled`));
                                _$effect(_$p => _$setProp(_el$84, "fg", L().muted, _$p));
                                return _el$84;
                              })();
                            },
                            get children() {
                              var _el$83 = _$createElement("box");
                              _$setProp(_el$83, "flexDirection", "column");
                              _$setProp(_el$83, "gap", 1);
                              _$insert(_el$83, _$createComponent(For, {
                                get each() {
                                  return users();
                                },
                                children: j => (() => {
                                  var _el$86 = _$createElement("box"),
                                    _el$87 = _$createElement("text"),
                                    _el$88 = _$createElement("span"),
                                    _el$89 = _$createTextNode(` `),
                                    _el$90 = _$createElement("span"),
                                    _el$91 = _$createTextNode(`  `),
                                    _el$92 = _$createTextNode(` · `),
                                    _el$93 = _$createTextNode(` waiting`);
                                  _$insertNode(_el$86, _el$87);
                                  _$setProp(_el$86, "flexDirection", "column");
                                  _$insertNode(_el$87, _el$88);
                                  _$insertNode(_el$87, _el$89);
                                  _$insertNode(_el$87, _el$90);
                                  _$insert(_el$88, () => isActive(j) ? "●" : "○");
                                  _$insert(_el$87, () => j.name, _el$90);
                                  _$insertNode(_el$90, _el$91);
                                  _$insertNode(_el$90, _el$92);
                                  _$insertNode(_el$90, _el$93);
                                  _$insert(_el$90, (() => {
                                    var _c$3 = _$memo(() => j.schedule.kind === "event");
                                    return () => _c$3() ? "as events arrive" : describe(j.schedule);
                                  })(), _el$92);
                                  _$insert(_el$90, () => count(j.id), _el$93);
                                  _$insert(_el$86, _$createComponent(For, {
                                    get each() {
                                      return first(j.id);
                                    },
                                    children: e => (() => {
                                      var _el$94 = _$createElement("text");
                                      _$insert(_el$94, () => "  " + e.title.slice(0, 90));
                                      _$effect(_$p => _$setProp(_el$94, "fg", L().muted, _$p));
                                      return _el$94;
                                    })()
                                  }), null);
                                  _$effect(_p$ => {
                                    var _v$33 = L().text,
                                      _v$34 = {
                                        fg: isActive(j) ? L().ok : L().muted
                                      },
                                      _v$35 = {
                                        fg: L().muted
                                      };
                                    _v$33 !== _p$.e && (_p$.e = _$setProp(_el$87, "fg", _v$33, _p$.e));
                                    _v$34 !== _p$.t && (_p$.t = _$setProp(_el$88, "style", _v$34, _p$.t));
                                    _v$35 !== _p$.a && (_p$.a = _$setProp(_el$90, "style", _v$35, _p$.a));
                                    return _p$;
                                  }, {
                                    e: undefined,
                                    t: undefined,
                                    a: undefined
                                  });
                                  return _el$86;
                                })()
                              }));
                              return _el$83;
                            }
                          });
                        }
                      }), null);
                      return _el$71;
                    })();
                  }
                }), null);
                _$effect(_p$ => {
                  var _v$11 = L().panel,
                    _v$12 = L().muted;
                  _v$11 !== _p$.e && (_p$.e = _$setProp(_el$35, "backgroundColor", _v$11, _p$.e));
                  _v$12 !== _p$.t && (_p$.t = _$setProp(_el$37, "fg", _v$12, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$34;
              }
            });
          }
        }), _el$58);
        _$insert(_el$11, _$createComponent(Show, {
          get when() {
            return state.tab() === "inbox";
          },
          get children() {
            return _$createComponent(Show, {
              get when() {
                return inbox().length;
              },
              get fallback() {
                return (() => {
                  var _el$95 = _$createElement("box"),
                    _el$96 = _$createElement("text"),
                    _el$98 = _$createElement("text");
                  _$insertNode(_el$95, _el$96);
                  _$insertNode(_el$95, _el$98);
                  _$setProp(_el$95, "padding", 2);
                  _$setProp(_el$95, "flexDirection", "column");
                  _$setProp(_el$95, "gap", 1);
                  _$insertNode(_el$96, _$createTextNode(`The inbox is empty.`));
                  _$insertNode(_el$98, _$createTextNode(`Channels write the events they poll here, for the automations attached to them.`));
                  _$effect(_p$ => {
                    var _v$36 = L().panel,
                      _v$37 = L().text,
                      _v$38 = L().muted;
                    _v$36 !== _p$.e && (_p$.e = _$setProp(_el$95, "backgroundColor", _v$36, _p$.e));
                    _v$37 !== _p$.t && (_p$.t = _$setProp(_el$96, "fg", _v$37, _p$.t));
                    _v$38 !== _p$.a && (_p$.a = _$setProp(_el$98, "fg", _v$38, _p$.a));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined
                  });
                  return _el$95;
                })();
              },
              get children() {
                var _el$40 = _$createElement("box"),
                  _el$41 = _$createElement("box"),
                  _el$42 = _$createElement("box"),
                  _el$43 = _$createElement("text"),
                  _el$44 = _$createElement("b");
                _$insertNode(_el$40, _el$41);
                _$setProp(_el$40, "flexDirection", "row");
                _$setProp(_el$40, "flexGrow", 1);
                _$setProp(_el$40, "flexShrink", 1);
                _$setProp(_el$40, "flexBasis", 0);
                _$setProp(_el$40, "minHeight", 0);
                _$setProp(_el$40, "gap", 2);
                _$insertNode(_el$41, _el$42);
                _$setProp(_el$41, "flexDirection", "column");
                _$setProp(_el$41, "width", 38);
                _$setProp(_el$41, "paddingTop", 1);
                _$setProp(_el$41, "paddingBottom", 1);
                _$insertNode(_el$42, _el$43);
                _$setProp(_el$42, "paddingLeft", 2);
                _$setProp(_el$42, "paddingBottom", 1);
                _$insertNode(_el$43, _el$44);
                _$insertNode(_el$44, _$createTextNode(`INBOX`));
                _$insert(_el$41, _$createComponent(Index, {
                  get each() {
                    return visible(inbox(), evIndex());
                  },
                  children: (e, at) => {
                    const i = at + windowStart(inbox().length, evIndex());
                    const look = () => fateLook(fate(e()));
                    return _$createComponent(Row, {
                      get selected() {
                        return i === evIndex();
                      },
                      get dot() {
                        return look().dot;
                      },
                      get dotFg() {
                        return look().fg;
                      },
                      get name() {
                        return e().title;
                      },
                      get when() {
                        return relative(e().at, state.now());
                      }
                    });
                  }
                }), null);
                _$insert(_el$40, _$createComponent(Show, {
                  get when() {
                    return evSelected();
                  },
                  children: e => (() => {
                    var _el$100 = _$createElement("scrollbox"),
                      _el$101 = _$createElement("box");
                    _$insertNode(_el$100, _el$101);
                    _$setProp(_el$100, "flexGrow", 1);
                    _$setProp(_el$100, "minHeight", 0);
                    _$setProp(_el$101, "flexDirection", "column");
                    _$setProp(_el$101, "gap", 1);
                    _$insert(_el$101, _$createComponent(Block, {
                      title: "Event",
                      hue: 0,
                      get children() {
                        return [(() => {
                          var _el$102 = _$createElement("text"),
                            _el$103 = _$createElement("b");
                          _$insertNode(_el$102, _el$103);
                          _$insert(_el$103, () => e().title);
                          _$effect(_$p => _$setProp(_el$102, "fg", L().text, _$p));
                          return _el$102;
                        })(), (() => {
                          var _el$104 = _$createElement("box");
                          _$setProp(_el$104, "flexDirection", "column");
                          _$insert(_el$104, _$createComponent(Field, {
                            label: "channel",
                            get value() {
                              return state.channels().defs[e().channel]?.name ?? state.channels().config[e().channel]?.name ?? e().channel;
                            }
                          }), null);
                          _$insert(_el$104, _$createComponent(Field, {
                            label: "id",
                            get value() {
                              return e().id;
                            }
                          }), null);
                          _$insert(_el$104, _$createComponent(Show, {
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
                          _$insert(_el$104, _$createComponent(Field, {
                            label: "first seen",
                            get value() {
                              return `${clock(e().at)}  (${relative(e().at, state.now())})`;
                            }
                          }), null);
                          _$insert(_el$104, _$createComponent(Field, {
                            label: "last seen",
                            get value() {
                              return `${clock(e().seenAt)}  (${relative(e().seenAt, state.now())})`;
                            }
                          }), null);
                          _$insert(_el$104, _$createComponent(Show, {
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
                          return _el$104;
                        })()];
                      }
                    }), null);
                    _$insert(_el$101, _$createComponent(Show, {
                      get when() {
                        return e().body;
                      },
                      children: b => _$createComponent(Block, {
                        title: "Body",
                        hue: 1,
                        get children() {
                          var _el$106 = _$createElement("text");
                          _$insert(_el$106, b);
                          _$effect(_$p => _$setProp(_el$106, "fg", L().text, _$p));
                          return _el$106;
                        }
                      })
                    }), null);
                    _$insert(_el$101, _$createComponent(Block, {
                      title: "Automations",
                      hue: 2,
                      get children() {
                        return _$createComponent(Show, {
                          get when() {
                            return e().deliveries.length;
                          },
                          get fallback() {
                            return (() => {
                              var _el$107 = _$createElement("text");
                              _$insertNode(_el$107, _$createTextNode(`none took it or waits for it`));
                              _$effect(_$p => _$setProp(_el$107, "fg", L().muted, _$p));
                              return _el$107;
                            })();
                          },
                          get children() {
                            var _el$105 = _$createElement("box");
                            _$setProp(_el$105, "flexDirection", "column");
                            _$insert(_el$105, _$createComponent(For, {
                              get each() {
                                return e().deliveries;
                              },
                              children: d => (() => {
                                var _el$109 = _$createElement("text"),
                                  _el$110 = _$createElement("span"),
                                  _el$111 = _$createTextNode(` `),
                                  _el$112 = _$createElement("span"),
                                  _el$113 = _$createTextNode(`  `);
                                _$insertNode(_el$109, _el$110);
                                _$insertNode(_el$109, _el$111);
                                _$insertNode(_el$109, _el$112);
                                _$insert(_el$110, () => fateLook(d.status).dot);
                                _$insert(_el$109, () => jobName(d.job), _el$112);
                                _$insertNode(_el$112, _el$113);
                                _$insert(_el$112, () => d.status, null);
                                _$effect(_p$ => {
                                  var _v$39 = L().text,
                                    _v$40 = {
                                      fg: fateLook(d.status).fg
                                    },
                                    _v$41 = {
                                      fg: L().muted
                                    };
                                  _v$39 !== _p$.e && (_p$.e = _$setProp(_el$109, "fg", _v$39, _p$.e));
                                  _v$40 !== _p$.t && (_p$.t = _$setProp(_el$110, "style", _v$40, _p$.t));
                                  _v$41 !== _p$.a && (_p$.a = _$setProp(_el$112, "style", _v$41, _p$.a));
                                  return _p$;
                                }, {
                                  e: undefined,
                                  t: undefined,
                                  a: undefined
                                });
                                return _el$109;
                              })()
                            }));
                            return _el$105;
                          }
                        });
                      }
                    }), null);
                    return _el$100;
                  })()
                }), null);
                _$effect(_p$ => {
                  var _v$13 = L().panel,
                    _v$14 = L().muted;
                  _v$13 !== _p$.e && (_p$.e = _$setProp(_el$41, "backgroundColor", _v$13, _p$.e));
                  _v$14 !== _p$.t && (_p$.t = _$setProp(_el$43, "fg", _v$14, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$40;
              }
            });
          }
        }), _el$58);
        _$insert(_el$11, _$createComponent(Show, {
          get when() {
            return state.tab() === "outbox";
          },
          get children() {
            return _$createComponent(Show, {
              get when() {
                return outbox().length;
              },
              get fallback() {
                return (() => {
                  var _el$114 = _$createElement("box"),
                    _el$115 = _$createElement("text"),
                    _el$117 = _$createElement("text");
                  _$insertNode(_el$114, _el$115);
                  _$insertNode(_el$114, _el$117);
                  _$setProp(_el$114, "padding", 2);
                  _$setProp(_el$114, "flexDirection", "column");
                  _$setProp(_el$114, "gap", 1);
                  _$insertNode(_el$115, _$createTextNode(`Nothing has been sent yet.`));
                  _$insertNode(_el$117, _$createTextNode(`What automations notify you of is kept here, with how each destination took it.`));
                  _$effect(_p$ => {
                    var _v$42 = L().panel,
                      _v$43 = L().text,
                      _v$44 = L().muted;
                    _v$42 !== _p$.e && (_p$.e = _$setProp(_el$114, "backgroundColor", _v$42, _p$.e));
                    _v$43 !== _p$.t && (_p$.t = _$setProp(_el$115, "fg", _v$43, _p$.t));
                    _v$44 !== _p$.a && (_p$.a = _$setProp(_el$117, "fg", _v$44, _p$.a));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined
                  });
                  return _el$114;
                })();
              },
              get children() {
                var _el$46 = _$createElement("box"),
                  _el$47 = _$createElement("box"),
                  _el$48 = _$createElement("box"),
                  _el$49 = _$createElement("text"),
                  _el$50 = _$createElement("b");
                _$insertNode(_el$46, _el$47);
                _$setProp(_el$46, "flexDirection", "row");
                _$setProp(_el$46, "flexGrow", 1);
                _$setProp(_el$46, "flexShrink", 1);
                _$setProp(_el$46, "flexBasis", 0);
                _$setProp(_el$46, "minHeight", 0);
                _$setProp(_el$46, "gap", 2);
                _$insertNode(_el$47, _el$48);
                _$setProp(_el$47, "flexDirection", "column");
                _$setProp(_el$47, "width", 38);
                _$setProp(_el$47, "paddingTop", 1);
                _$setProp(_el$47, "paddingBottom", 1);
                _$insertNode(_el$48, _el$49);
                _$setProp(_el$48, "paddingLeft", 2);
                _$setProp(_el$48, "paddingBottom", 1);
                _$insertNode(_el$49, _el$50);
                _$insertNode(_el$50, _$createTextNode(`OUTBOX`));
                _$insert(_el$47, _$createComponent(Index, {
                  get each() {
                    return visible(outbox(), msgIndex());
                  },
                  children: (m, at) => {
                    const i = at + windowStart(outbox().length, msgIndex());
                    const look = () => sendLook(sendState(m()));
                    return _$createComponent(Row, {
                      get selected() {
                        return i === msgIndex();
                      },
                      get dot() {
                        return look().dot;
                      },
                      get dotFg() {
                        return look().fg;
                      },
                      get name() {
                        return m().title;
                      },
                      get when() {
                        return relative(m().at, state.now());
                      }
                    });
                  }
                }), null);
                _$insert(_el$46, _$createComponent(Show, {
                  get when() {
                    return msgSelected();
                  },
                  children: m => (() => {
                    var _el$119 = _$createElement("scrollbox"),
                      _el$120 = _$createElement("box");
                    _$insertNode(_el$119, _el$120);
                    _$setProp(_el$119, "flexGrow", 1);
                    _$setProp(_el$119, "minHeight", 0);
                    _$setProp(_el$120, "flexDirection", "column");
                    _$setProp(_el$120, "gap", 1);
                    _$insert(_el$120, _$createComponent(Block, {
                      title: "Message",
                      hue: 0,
                      get children() {
                        return [(() => {
                          var _el$121 = _$createElement("text"),
                            _el$122 = _$createElement("b");
                          _$insertNode(_el$121, _el$122);
                          _$insert(_el$122, () => m().title);
                          _$effect(_$p => _$setProp(_el$121, "fg", L().text, _$p));
                          return _el$121;
                        })(), (() => {
                          var _el$123 = _$createElement("box");
                          _$setProp(_el$123, "flexDirection", "column");
                          _$insert(_el$123, _$createComponent(Field, {
                            label: "from",
                            get value() {
                              return jobName(m().job);
                            }
                          }), null);
                          _$insert(_el$123, _$createComponent(Field, {
                            label: "sent",
                            get value() {
                              return `${clock(m().at)}  (${relative(m().at, state.now())})`;
                            }
                          }), null);
                          _$insert(_el$123, _$createComponent(Field, {
                            label: "priority",
                            get value() {
                              return m().priority;
                            }
                          }), null);
                          _$insert(_el$123, _$createComponent(Show, {
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
                          _$insert(_el$123, _$createComponent(Show, {
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
                          return _el$123;
                        })()];
                      }
                    }), null);
                    _$insert(_el$120, _$createComponent(Block, {
                      title: "Body",
                      hue: 1,
                      get children() {
                        var _el$124 = _$createElement("text");
                        _$insert(_el$124, () => m().body);
                        _$effect(_$p => _$setProp(_el$124, "fg", L().text, _$p));
                        return _el$124;
                      }
                    }), null);
                    _$insert(_el$120, _$createComponent(Block, {
                      title: "Destinations",
                      hue: 3,
                      get children() {
                        return _$createComponent(Show, {
                          get when() {
                            return m().sends.length;
                          },
                          get fallback() {
                            return (() => {
                              var _el$126 = _$createElement("text");
                              _$insertNode(_el$126, _$createTextNode(`no destination takes it`));
                              _$effect(_$p => _$setProp(_el$126, "fg", L().muted, _$p));
                              return _el$126;
                            })();
                          },
                          get children() {
                            var _el$125 = _$createElement("box");
                            _$setProp(_el$125, "flexDirection", "column");
                            _$insert(_el$125, _$createComponent(For, {
                              get each() {
                                return m().sends;
                              },
                              children: x => (() => {
                                var _el$128 = _$createElement("box"),
                                  _el$129 = _$createElement("text"),
                                  _el$130 = _$createElement("span"),
                                  _el$131 = _$createTextNode(` `),
                                  _el$132 = _$createElement("span"),
                                  _el$133 = _$createTextNode(`  `);
                                _$insertNode(_el$128, _el$129);
                                _$setProp(_el$128, "flexDirection", "column");
                                _$insertNode(_el$129, _el$130);
                                _$insertNode(_el$129, _el$131);
                                _$insertNode(_el$129, _el$132);
                                _$insert(_el$130, () => sendLook(x.status).dot);
                                _$insert(_el$129, () => x.destination, _el$132);
                                _$insertNode(_el$132, _el$133);
                                _$insert(_el$132, () => x.status, null);
                                _$insert(_el$128, _$createComponent(Show, {
                                  get when() {
                                    return x.error;
                                  },
                                  children: err => (() => {
                                    var _el$134 = _$createElement("text");
                                    _$insert(_el$134, () => "  " + err());
                                    _$effect(_$p => _$setProp(_el$134, "fg", L().bad, _$p));
                                    return _el$134;
                                  })()
                                }), null);
                                _$effect(_p$ => {
                                  var _v$45 = L().text,
                                    _v$46 = {
                                      fg: sendLook(x.status).fg
                                    },
                                    _v$47 = {
                                      fg: L().muted
                                    };
                                  _v$45 !== _p$.e && (_p$.e = _$setProp(_el$129, "fg", _v$45, _p$.e));
                                  _v$46 !== _p$.t && (_p$.t = _$setProp(_el$130, "style", _v$46, _p$.t));
                                  _v$47 !== _p$.a && (_p$.a = _$setProp(_el$132, "style", _v$47, _p$.a));
                                  return _p$;
                                }, {
                                  e: undefined,
                                  t: undefined,
                                  a: undefined
                                });
                                return _el$128;
                              })()
                            }));
                            return _el$125;
                          }
                        });
                      }
                    }), null);
                    return _el$119;
                  })()
                }), null);
                _$effect(_p$ => {
                  var _v$15 = L().panel,
                    _v$16 = L().muted;
                  _v$15 !== _p$.e && (_p$.e = _$setProp(_el$47, "backgroundColor", _v$15, _p$.e));
                  _v$16 !== _p$.t && (_p$.t = _$setProp(_el$49, "fg", _v$16, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$46;
              }
            });
          }
        }), _el$58);
        _$insert(_el$11, _$createComponent(Show, {
          get when() {
            return onJobs();
          },
          get children() {
            return _$createComponent(Show, {
              get when() {
                return sorted().length;
              },
              get fallback() {
                return (() => {
                  var _el$135 = _$createElement("box"),
                    _el$136 = _$createElement("text"),
                    _el$138 = _$createElement("text");
                  _$insertNode(_el$135, _el$136);
                  _$insertNode(_el$135, _el$138);
                  _$setProp(_el$135, "padding", 2);
                  _$setProp(_el$135, "flexDirection", "column");
                  _$setProp(_el$135, "gap", 1);
                  _$insertNode(_el$136, _$createTextNode(`No automations yet.`));
                  _$insertNode(_el$138, _$createTextNode(`Press n to create one, or ask in chat: “every weekday at 8:45, triage my open MRs”.`));
                  _$effect(_p$ => {
                    var _v$48 = L().panel,
                      _v$49 = L().text,
                      _v$50 = L().muted;
                    _v$48 !== _p$.e && (_p$.e = _$setProp(_el$135, "backgroundColor", _v$48, _p$.e));
                    _v$49 !== _p$.t && (_p$.t = _$setProp(_el$136, "fg", _v$49, _p$.t));
                    _v$50 !== _p$.a && (_p$.a = _$setProp(_el$138, "fg", _v$50, _p$.a));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined
                  });
                  return _el$135;
                })();
              },
              get children() {
                var _el$52 = _$createElement("box"),
                  _el$53 = _$createElement("box"),
                  _el$54 = _$createElement("box"),
                  _el$55 = _$createElement("text"),
                  _el$56 = _$createElement("b");
                _$insertNode(_el$52, _el$53);
                _$setProp(_el$52, "flexDirection", "row");
                _$setProp(_el$52, "flexGrow", 1);
                _$setProp(_el$52, "flexShrink", 1);
                _$setProp(_el$52, "flexBasis", 0);
                _$setProp(_el$52, "minHeight", 0);
                _$setProp(_el$52, "gap", 2);
                _$insertNode(_el$53, _el$54);
                _$setProp(_el$53, "flexDirection", "column");
                _$setProp(_el$53, "width", 38);
                _$setProp(_el$53, "paddingTop", 1);
                _$setProp(_el$53, "paddingBottom", 1);
                _$insertNode(_el$54, _el$55);
                _$setProp(_el$54, "paddingLeft", 2);
                _$setProp(_el$54, "paddingBottom", 1);
                _$insertNode(_el$55, _el$56);
                _$insertNode(_el$56, _$createTextNode(`JOBS`));
                _$insert(_el$53, _$createComponent(For, {
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
                _$insert(_el$52, _$createComponent(Show, {
                  get when() {
                    return selected();
                  },
                  children: j => (() => {
                    var _el$140 = _$createElement("scrollbox"),
                      _el$141 = _$createElement("box");
                    _$insertNode(_el$140, _el$141);
                    _$setProp(_el$140, "flexGrow", 1);
                    _$setProp(_el$140, "minHeight", 0);
                    _$setProp(_el$141, "flexDirection", "column");
                    _$setProp(_el$141, "gap", 1);
                    _$insert(_el$141, _$createComponent(Block, {
                      title: "Details",
                      hue: 0,
                      get children() {
                        return [(() => {
                          var _el$142 = _$createElement("text"),
                            _el$143 = _$createElement("span"),
                            _el$144 = _$createElement("b"),
                            _el$145 = _$createTextNode(`  `),
                            _el$146 = _$createElement("span"),
                            _el$147 = _$createElement("span"),
                            _el$148 = _$createTextNode(`  `);
                          _$insertNode(_el$142, _el$143);
                          _$insertNode(_el$142, _el$145);
                          _$insertNode(_el$142, _el$146);
                          _$insertNode(_el$142, _el$147);
                          _$insertNode(_el$143, _el$144);
                          _$insert(_el$144, () => j().name);
                          _$insert(_el$146, () => badge(j()).label);
                          _$insertNode(_el$147, _el$148);
                          _$insert(_el$147, () => j().id, null);
                          _$insert(_el$147, () => j().source === "config" ? " · from config" : "", null);
                          _$effect(_p$ => {
                            var _v$51 = {
                                fg: L().text
                              },
                              _v$52 = {
                                fg: badge(j()).fg,
                                bg: badge(j()).bg
                              },
                              _v$53 = {
                                fg: L().muted
                              };
                            _v$51 !== _p$.e && (_p$.e = _$setProp(_el$143, "style", _v$51, _p$.e));
                            _v$52 !== _p$.t && (_p$.t = _$setProp(_el$146, "style", _v$52, _p$.t));
                            _v$53 !== _p$.a && (_p$.a = _$setProp(_el$147, "style", _v$53, _p$.a));
                            return _p$;
                          }, {
                            e: undefined,
                            t: undefined,
                            a: undefined
                          });
                          return _el$142;
                        })(), (() => {
                          var _el$149 = _$createElement("box");
                          _$setProp(_el$149, "flexDirection", "column");
                          _$insert(_el$149, _$createComponent(Field, {
                            label: "schedule",
                            get value() {
                              return describe(j().schedule);
                            }
                          }), null);
                          _$insert(_el$149, _$createComponent(Show, {
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
                          _$insert(_el$149, _$createComponent(Field, {
                            label: "next",
                            get value() {
                              return _$memo(() => !!isActive(j()))() ? `${clock(j().nextRunAt)}  (${relative(j().nextRunAt, state.now())})` : "—";
                            }
                          }), null);
                          _$insert(_el$149, _$createComponent(Field, {
                            label: "last",
                            get value() {
                              return _$memo(() => !!j().lastRunAt)() ? `${clock(j().lastRunAt)}  ${j().lastStatus ?? ""}` : "never";
                            },
                            get fg() {
                              return _$memo(() => !!j().lastStatus)() ? statusColor(j().lastStatus) : undefined;
                            }
                          }), null);
                          _$insert(_el$149, _$createComponent(Field, {
                            label: "session",
                            get value() {
                              return j().session + (j().sessionID ? `  ${j().sessionID}` : "");
                            }
                          }), null);
                          _$insert(_el$149, _$createComponent(Field, {
                            label: "agent",
                            get value() {
                              return j().agent ?? "default";
                            }
                          }), null);
                          _$insert(_el$149, _$createComponent(Field, {
                            label: "model",
                            get value() {
                              return _$memo(() => j().session === "current")() ? "chat's model" : j().model ?? "agent default";
                            }
                          }), null);
                          _$insert(_el$149, _$createComponent(Field, {
                            label: "directory",
                            get value() {
                              return ctx.ui.format.path(j().directory);
                            }
                          }), null);
                          _$insert(_el$149, _$createComponent(Field, {
                            label: "timeout",
                            get value() {
                              return `${j().timeoutMinutes}m · run missed ${j().runMissed ? "on" : "off"}`;
                            }
                          }), null);
                          return _el$149;
                        })()];
                      }
                    }), null);
                    _$insert(_el$141, _$createComponent(Block, {
                      title: "Prompt",
                      hue: 1,
                      get children() {
                        var _el$150 = _$createElement("text");
                        _$insert(_el$150, () => j().prompt);
                        _$effect(_$p => _$setProp(_el$150, "fg", L().text, _$p));
                        return _el$150;
                      }
                    }), null);
                    _$insert(_el$141, _$createComponent(Show, {
                      get when() {
                        return jobSent().length;
                      },
                      get children() {
                        return _$createComponent(Block, {
                          title: "Notified",
                          hue: 3,
                          get children() {
                            var _el$151 = _$createElement("box");
                            _$setProp(_el$151, "flexDirection", "column");
                            _$insert(_el$151, _$createComponent(For, {
                              get each() {
                                return jobSent();
                              },
                              children: m => (() => {
                                var _el$154 = _$createElement("text"),
                                  _el$155 = _$createTextNode(` `),
                                  _el$156 = _$createElement("span"),
                                  _el$157 = _$createTextNode(`  `);
                                _$insertNode(_el$154, _el$155);
                                _$insertNode(_el$154, _el$156);
                                _$insert(_el$154, () => clock(m.at), _el$155);
                                _$insert(_el$154, () => m.title.slice(0, 60), _el$156);
                                _$insertNode(_el$156, _el$157);
                                _$insert(_el$156, () => m.sends.map(x => `${x.destination} ${x.status}`).join(", ") || "no destination takes it", null);
                                _$effect(_p$ => {
                                  var _v$54 = L().text,
                                    _v$55 = {
                                      fg: m.sends.some(x => x.status === "failed") ? L().bad : L().muted
                                    };
                                  _v$54 !== _p$.e && (_p$.e = _$setProp(_el$154, "fg", _v$54, _p$.e));
                                  _v$55 !== _p$.t && (_p$.t = _$setProp(_el$156, "style", _v$55, _p$.t));
                                  return _p$;
                                }, {
                                  e: undefined,
                                  t: undefined
                                });
                                return _el$154;
                              })()
                            }));
                            return _el$151;
                          }
                        });
                      }
                    }), null);
                    _$insert(_el$141, _$createComponent(Show, {
                      get when() {
                        return jobNotes().length;
                      },
                      get children() {
                        return _$createComponent(Block, {
                          title: "Memory",
                          hue: 4,
                          get children() {
                            var _el$152 = _$createElement("box");
                            _$setProp(_el$152, "flexDirection", "column");
                            _$setProp(_el$152, "gap", 1);
                            _$insert(_el$152, _$createComponent(For, {
                              get each() {
                                return jobNotes();
                              },
                              children: n => (() => {
                                var _el$158 = _$createElement("box"),
                                  _el$159 = _$createElement("text"),
                                  _el$160 = _$createTextNode(`updated `),
                                  _el$161 = _$createTextNode(` (`),
                                  _el$162 = _$createTextNode(`)`),
                                  _el$163 = _$createElement("text");
                                _$insertNode(_el$158, _el$159);
                                _$insertNode(_el$158, _el$163);
                                _$setProp(_el$158, "flexDirection", "column");
                                _$insertNode(_el$159, _el$160);
                                _$insertNode(_el$159, _el$161);
                                _$insertNode(_el$159, _el$162);
                                _$insert(_el$159, (() => {
                                  var _c$4 = _$memo(() => !!n.key);
                                  return () => _c$4() ? `${n.key} · ` : "";
                                })(), _el$160);
                                _$insert(_el$159, () => clock(n.updatedAt), _el$161);
                                _$insert(_el$159, () => relative(n.updatedAt, state.now()), _el$162);
                                _$insert(_el$163, () => n.note);
                                _$effect(_p$ => {
                                  var _v$56 = L().muted,
                                    _v$57 = L().text;
                                  _v$56 !== _p$.e && (_p$.e = _$setProp(_el$159, "fg", _v$56, _p$.e));
                                  _v$57 !== _p$.t && (_p$.t = _$setProp(_el$163, "fg", _v$57, _p$.t));
                                  return _p$;
                                }, {
                                  e: undefined,
                                  t: undefined
                                });
                                return _el$158;
                              })()
                            }));
                            return _el$152;
                          }
                        });
                      }
                    }), null);
                    _$insert(_el$141, _$createComponent(Block, {
                      title: "Recent runs",
                      hue: 2,
                      get children() {
                        return _$createComponent(Show, {
                          get when() {
                            return jobRuns().length;
                          },
                          get fallback() {
                            return (() => {
                              var _el$164 = _$createElement("text");
                              _$insertNode(_el$164, _$createTextNode(`none yet`));
                              _$effect(_$p => _$setProp(_el$164, "fg", L().muted, _$p));
                              return _el$164;
                            })();
                          },
                          get children() {
                            var _el$153 = _$createElement("box");
                            _$setProp(_el$153, "flexDirection", "column");
                            _$insert(_el$153, _$createComponent(For, {
                              get each() {
                                return jobRuns();
                              },
                              children: r => (() => {
                                var _el$166 = _$createElement("box"),
                                  _el$167 = _$createElement("text"),
                                  _el$168 = _$createElement("span"),
                                  _el$169 = _$createTextNode(` `),
                                  _el$170 = _$createElement("span"),
                                  _el$171 = _$createTextNode(`  `),
                                  _el$172 = _$createTextNode(` `);
                                _$insertNode(_el$166, _el$167);
                                _$setProp(_el$166, "flexDirection", "column");
                                _$insertNode(_el$167, _el$168);
                                _$insertNode(_el$167, _el$169);
                                _$insertNode(_el$167, _el$170);
                                _$insert(_el$168, () => glyph[r.status]);
                                _$insert(_el$167, () => clock(r.startedAt), _el$170);
                                _$insertNode(_el$170, _el$171);
                                _$insertNode(_el$170, _el$172);
                                _$insert(_el$170, () => r.status, _el$172);
                                _$insert(_el$170, () => elapsed(r), null);
                                _$insert(_el$166, _$createComponent(Show, {
                                  get when() {
                                    return r.error;
                                  },
                                  children: error => (() => {
                                    var _el$173 = _$createElement("text");
                                    _$insert(_el$173, () => "  " + error().slice(0, 100));
                                    _$effect(_$p => _$setProp(_el$173, "fg", L().bad, _$p));
                                    return _el$173;
                                  })()
                                }), null);
                                _$effect(_p$ => {
                                  var _v$58 = L().text,
                                    _v$59 = {
                                      fg: statusColor(r.status)
                                    },
                                    _v$60 = {
                                      fg: L().muted
                                    };
                                  _v$58 !== _p$.e && (_p$.e = _$setProp(_el$167, "fg", _v$58, _p$.e));
                                  _v$59 !== _p$.t && (_p$.t = _$setProp(_el$168, "style", _v$59, _p$.t));
                                  _v$60 !== _p$.a && (_p$.a = _$setProp(_el$170, "style", _v$60, _p$.a));
                                  return _p$;
                                }, {
                                  e: undefined,
                                  t: undefined,
                                  a: undefined
                                });
                                return _el$166;
                              })()
                            }));
                            return _el$153;
                          }
                        });
                      }
                    }), null);
                    return _el$140;
                  })()
                }), null);
                _$effect(_p$ => {
                  var _v$17 = L().panel,
                    _v$18 = L().muted;
                  _v$17 !== _p$.e && (_p$.e = _$setProp(_el$53, "backgroundColor", _v$17, _p$.e));
                  _v$18 !== _p$.t && (_p$.t = _$setProp(_el$55, "fg", _v$18, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$52;
              }
            });
          }
        }), _el$58);
        _$setProp(_el$58, "flexDirection", "row");
        _$setProp(_el$58, "flexWrap", "wrap");
        _$setProp(_el$58, "paddingTop", 1);
        _$setProp(_el$58, "paddingBottom", 1);
        _$setProp(_el$58, "columnGap", 2);
        _$setProp(_el$58, "flexShrink", 0);
        _$insert(_el$58, _$createComponent(For, {
          get each() {
            return [...tabHints(state.tab()), ...(onJobs() ? keyHints : onChannels() ? channelHints : listHints)];
          },
          children: ([key, label]) => (() => {
            var _el$174 = _$createElement("text"),
              _el$175 = _$createElement("span"),
              _el$176 = _$createTextNode(` `),
              _el$177 = _$createTextNode(` `),
              _el$178 = _$createElement("span"),
              _el$179 = _$createTextNode(` `);
            _$insertNode(_el$174, _el$175);
            _$insertNode(_el$174, _el$178);
            _$insertNode(_el$175, _el$176);
            _$insertNode(_el$175, _el$177);
            _$insert(_el$175, key, _el$177);
            _$insertNode(_el$178, _el$179);
            _$insert(_el$178, label, null);
            _$effect(_p$ => {
              var _v$61 = {
                  fg: L().text,
                  bg: L().cap
                },
                _v$62 = {
                  fg: L().muted
                };
              _v$61 !== _p$.e && (_p$.e = _$setProp(_el$175, "style", _v$61, _p$.e));
              _v$62 !== _p$.t && (_p$.t = _$setProp(_el$178, "style", _v$62, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$174;
          })()
        }));
        _$effect(_p$ => {
          var _v$19 = p().left,
            _v$20 = p().top,
            _v$21 = p().width,
            _v$22 = p().height,
            _v$23 = t.background.base,
            _v$24 = L().text;
          _v$19 !== _p$.e && (_p$.e = _$setProp(_el$11, "left", _v$19, _p$.e));
          _v$20 !== _p$.t && (_p$.t = _$setProp(_el$11, "top", _v$20, _p$.t));
          _v$21 !== _p$.a && (_p$.a = _$setProp(_el$11, "width", _v$21, _p$.a));
          _v$22 !== _p$.o && (_p$.o = _$setProp(_el$11, "height", _v$22, _p$.o));
          _v$23 !== _p$.i && (_p$.i = _$setProp(_el$11, "backgroundColor", _v$23, _p$.i));
          _v$24 !== _p$.n && (_p$.n = _$setProp(_el$14, "fg", _v$24, _p$.n));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined,
          i: undefined,
          n: undefined
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
      var _el$180 = _$createElement("box"),
        _el$181 = _$createElement("text"),
        _el$182 = _$createElement("b"),
        _el$184 = _$createElement("text");
      _$insertNode(_el$180, _el$181);
      _$insertNode(_el$180, _el$184);
      _$setProp(_el$180, "flexDirection", "column");
      _$setProp(_el$180, "marginTop", 1);
      _$setProp(_el$180, "paddingLeft", 1);
      _$setProp(_el$180, "paddingRight", 1);
      _$setProp(_el$180, "paddingTop", 1);
      _$setProp(_el$180, "paddingBottom", 1);
      _$insertNode(_el$181, _el$182);
      _$insertNode(_el$182, _$createTextNode(`⏰ Automations`));
      _$insert(_el$180, _$createComponent(Show, {
        get when() {
          return thisRun();
        },
        children: r => (() => {
          var _el$186 = _$createElement("text"),
            _el$187 = _$createTextNode(`this session: `),
            _el$188 = _$createTextNode(` `);
          _$insertNode(_el$186, _el$187);
          _$insertNode(_el$186, _el$188);
          _$insert(_el$186, () => r().jobID, _el$188);
          _$insert(_el$186, () => glyph[r().status], null);
          _$effect(_$p => _$setProp(_el$186, "fg", L().info, _$p));
          return _el$186;
        })()
      }), _el$184);
      _$insert(_el$180, _$createComponent(For, {
        get each() {
          return upcoming();
        },
        children: j => (() => {
          var _el$189 = _$createElement("box"),
            _el$190 = _$createElement("text"),
            _el$191 = _$createElement("text");
          _$insertNode(_el$189, _el$190);
          _$insertNode(_el$189, _el$191);
          _$setProp(_el$189, "flexDirection", "row");
          _$setProp(_el$189, "justifyContent", "space-between");
          _$insert(_el$190, () => j.name.slice(0, 18));
          _$insert(_el$191, () => relative(j.nextRunAt, state.now()));
          _$effect(_p$ => {
            var _v$66 = L().text,
              _v$67 = L().muted;
            _v$66 !== _p$.e && (_p$.e = _$setProp(_el$190, "fg", _v$66, _p$.e));
            _v$67 !== _p$.t && (_p$.t = _$setProp(_el$191, "fg", _v$67, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$189;
        })()
      }), _el$184);
      _$insertNode(_el$184, _$createTextNode(`/automations`));
      _$effect(_p$ => {
        var _v$63 = L().panel,
          _v$64 = L().ink(0),
          _v$65 = L().faint;
        _v$63 !== _p$.e && (_p$.e = _$setProp(_el$180, "backgroundColor", _v$63, _p$.e));
        _v$64 !== _p$.t && (_p$.t = _$setProp(_el$181, "fg", _v$64, _p$.t));
        _v$65 !== _p$.a && (_p$.a = _$setProp(_el$184, "fg", _v$65, _p$.a));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined
      });
      return _el$180;
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
