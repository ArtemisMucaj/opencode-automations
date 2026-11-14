// Notifications, sent from the server plugin so they work with no TUI open.
// Channels: native desktop notifications (macOS/Linux) and Pushover.
// During a run, the agent decides what to send with the automation_notify tool.
// The plugin itself only sends a notice when a run fails or times out (`on`);
// a successful run is never notified automatically.

import { spawn } from "node:child_process"
import type { Job, Run, RunStatus } from "./store.ts"
import { log } from "./log.ts"
import { elapsed, httpError, type Fetch } from "./util.ts"

export interface NotifyConfig {
  /** Run outcomes that get an automatic notice. Default: failed, timeout. Successful runs never do. */
  on?: RunStatus[]
  /** Most automation_notify calls one run may make. Default 5. */
  maxPerRun?: number
  /** Desktop notifications. Sound customization applies to macOS only. */
  native?: boolean | { sound?: string }
  pushover?: { token: string; user: string }
}

/** Per job: false = never notify, true = plugin defaults, array = these outcomes get an automatic notice. */
export type JobNotify = boolean | RunStatus[]

export type Priority = "low" | "normal" | "high"

export interface Message {
  title: string
  /** Plain text. Light markdown (bullets, **bold**, links, headings) is cleaned up per channel. */
  body: string
  priority?: Priority
  url?: string
  urlTitle?: string
}

export interface Deps {
  fetch: Fetch
  exec: (command: string, args: string[]) => Promise<void>
  platform: NodeJS.Platform
}

const DEFAULT_ON: RunStatus[] = ["failed", "timeout"]
export const DEFAULT_MAX_PER_RUN = 5

const defaultDeps: Deps = {
  fetch: (input, init) => fetch(input, init),
  platform: process.platform,
  exec: (command, args) =>
    new Promise((resolve, reject) => {
      // argv, not string interpolation: job output can contain anything.
      const p = spawn(command, args, { stdio: "ignore" })
      p.on("error", reject)
      p.on("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${signal ?? code}`))))
    }),
}

/** Whether a job may notify at all (the automation_notify tool is offered only then). */
export function canNotify(cfg: NotifyConfig | undefined, job: Job): cfg is NotifyConfig {
  return !!cfg && job.notify !== false && !!(cfg.native || cfg.pushover)
}

export function shouldNotify(cfg: NotifyConfig | undefined, job: Job, status: RunStatus) {
  // On success the agent notifies if something needs it; silence means nothing did.
  if (status === "succeeded" || !canNotify(cfg, job)) return false
  const on = Array.isArray(job.notify) ? job.notify : (cfg.on ?? DEFAULT_ON)
  return on.includes(status)
}

/** The automatic end-of-run notice. Agent output is not included: the agent notifies itself. */
export function compose(job: Job, run: Run): Message {
  const error = run.error?.trim()
  switch (run.status) {
    case "failed":
      return { title: `${job.name} failed`, body: error || `Failed after ${elapsed(run)}.`, priority: "high" }
    case "timeout":
      return { title: `${job.name} timed out`, body: error ? `Stopped: ${error}.` : `Stopped after ${elapsed(run)}.`, priority: "high" }
    default:
      return { title: `${job.name} ${run.status}`, body: error || `After ${elapsed(run)}.`, priority: "normal" }
  }
}

// ---------- formatting ----------

/** Pushover's documented limits. https://pushover.net/api#limits */
export const PUSHOVER = { message: 1024, title: 250, url: 512, urlTitle: 100 } as const
/** Most messages one notification may be split into. */
export const MAX_PARTS = 4

const escapeHTML = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

type Style = "plain" | "html"

/** Turn one source line into the channel's format. Models drift into markdown; clean it up. */
function line(src: string, style: Style): string {
  let s = src.replace(/\s+$/, "")
  const html = style === "html"
  const bold = (t: string) => (html ? `<b>${t}</b>` : t)
  if (html) s = escapeHTML(s)
  // Table rows: "| a | b |" -> "a · b".
  if (/^\s*\|.*\|\s*$/.test(s)) s = s.trim().slice(1, -1).split("|").map((c) => c.trim()).join(" · ")
  // Headings read as a bold line.
  const heading = s.match(/^\s*#{1,6}\s+(.*)$/)
  if (heading) s = bold(heading[1].replace(/\*\*/g, ""))
  // Bullets: the lock screen has no list rendering.
  s = s.replace(/^(\s*)[-*+]\s+/, (_, indent: string) => `${indent.length >= 2 ? "  " : ""}• `)
  s = s.replace(/^\s*(&gt;|>)\s?/, "")
  s = s.replace(/\[([^\]]+)\]\((\S+?)\)/g, (_, t: string, u: string) => (html ? `<a href="${u.replace(/"/g, "&quot;")}">${t}</a>` : `${t} (${u})`))
  // **bold** / __bold__ (not snake_case or lone asterisks).
  s = s.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, (_, t: string) => bold(t))
  s = s.replace(/(^|[^\w])__(?=\S)(.+?)(?<=\S)__(?!\w)/g, (_, p: string, t: string) => p + bold(t))
  s = s.replace(/`([^`]+)`/g, "$1")
  // Leftover unpaired markers (e.g. a bold phrase split across parts).
  return s.replace(/\*\*/g, "")
}

/** Source lines, with code fences and table rules dropped and blank runs collapsed. */
function sourceLines(text: string): string[] {
  const out: string[] = []
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) continue
    // Table separator rows and horizontal rules carry no content.
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(raw)) continue
    if (!raw.trim() && (!out.length || !out[out.length - 1].trim())) continue
    out.push(raw)
  }
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out
}

export function format(text: string, style: Style): string {
  return sourceLines(text).map((l) => line(l, style)).join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

/** Longest a line may run, links aside, before it reads as a wall of text on a phone. */
export const MAX_LINE = 200

export function longLine(text: string): string | undefined {
  return format(text, "plain").split("\n").find((l) => l.replace(/\bhttps?:\/\/\S+/g, "").trim().length > MAX_LINE)
}

/** Cut a source line into pieces that each render within `max`, preferring word breaks. */
function cutLine(src: string, max: number, style: Style): string[] {
  if (line(src, style).length <= max) return [src]
  const pieces: string[] = []
  let cur = ""
  for (const word of src.split(/(?<=\s)/)) {
    if (line(cur + word, style).length <= max) { cur += word; continue }
    if (cur) pieces.push(cur)
    cur = word
    // One word longer than the budget (a huge URL): hard-cut it.
    while (line(cur, style).length > max) {
      let n = Math.min(cur.length - 1, max)
      while (n > 1 && line(cur.slice(0, n), style).length > max) n--
      // Don't split an emoji or other surrogate pair in half.
      const code = cur.charCodeAt(n - 1)
      if (code >= 0xd800 && code <= 0xdbff) n--
      pieces.push(cur.slice(0, n))
      cur = cur.slice(n)
    }
  }
  if (cur) pieces.push(cur)
  return pieces
}

/**
 * Split text into rendered messages of at most `max` characters, breaking between
 * paragraphs first, then lines, then words. Lines are rendered independently, so a
 * cut never lands inside an HTML tag.
 */
export function split(text: string, max: number, style: Style): string[] {
  const parts: string[][] = [[]]
  const size = (p: string[]) => p.join("\n").length
  const lines = sourceLines(text).flatMap((l) => cutLine(l, max, style)).map((l) => line(l, style))
  for (let i = 0; i < lines.length; i++) {
    let cur = parts[parts.length - 1]
    const l = lines[i]
    if (cur.length && size([...cur, l]) > max) {
      // Prefer to break at the last paragraph boundary if it's not too far back.
      const blank = cur.lastIndexOf("")
      if (blank > 0 && size(cur.slice(0, blank)) >= max / 2) {
        const moved = cur.splice(blank)
        parts.push(moved.slice(1))
      } else parts.push([])
      cur = parts[parts.length - 1]
      if (cur.length && size([...cur, l]) > max) { parts.push([]); cur = parts[parts.length - 1] }
    }
    if (!cur.length && !l.trim()) continue // no leading blank lines in a part
    cur.push(l)
  }
  return parts.map((p) => p.join("\n").trim()).filter(Boolean)
}

const clip = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…")

/** Pushover payloads for one notification: several numbered parts when it's long. */
export function pushoverParts(m: Message): Array<Record<string, string | number>> {
  const bodies = split(m.body, PUSHOVER.message, "html")
  if (!bodies.length) bodies.push(escapeHTML(m.title))
  const priority = m.priority === "high" ? 1 : m.priority === "low" ? -1 : 0
  return bodies.map((message, i) => {
    const suffix = bodies.length > 1 ? ` (${i + 1}/${bodies.length})` : ""
    const p: Record<string, string | number> = {
      title: clip(m.title, PUSHOVER.title - suffix.length) + suffix,
      message,
      html: 1,
      priority,
    }
    // The link button goes on the last part, after the user has read everything.
    if (m.url && i === bodies.length - 1) {
      p.url = m.url.slice(0, PUSHOVER.url)
      if (m.urlTitle) p.url_title = clip(m.urlTitle, PUSHOVER.urlTitle)
    }
    return p
  })
}

// ---------- delivery ----------

const ok = async (r: Response) => {
  if (!r.ok) throw httpError(r.status, await r.text().catch(() => ""))
}
const timeout = () => AbortSignal.timeout(10_000)

export interface Delivery {
  /** Channels that delivered, e.g. "pushover (2 messages)". */
  sent: string[]
  failed: string[]
}

export async function send(cfg: NotifyConfig, m: Message, deps: Deps = defaultDeps): Promise<Delivery> {
  const tasks: Array<[string, () => Promise<string | void>]> = []
  const plain = format(m.body, "plain") || m.title

  if (cfg.native) {
    const native = cfg.native
    const high = m.priority === "high"
    tasks.push([
      "native",
      async () => {
        const body = m.url ? `${plain}\n${m.url}` : plain
        if (deps.platform === "darwin") {
          const sound = typeof native === "object" ? native.sound : high ? "Basso" : "Glass"
          await deps.exec("osascript", [
            "-e", "on run argv",
            "-e", `display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)${sound ? ` sound name "${sound.replace(/"/g, "")}"` : ""}`,
            "-e", "end run",
            m.title, body.slice(0, 240), "opencode automations",
          ])
        } else if (deps.platform === "linux") {
          await deps.exec("notify-send", [
            "--app-name", "opencode automations",
            "--urgency", high ? "critical" : m.priority === "low" ? "low" : "normal",
            "--", m.title, body,
          ])
        } else {
          throw new Error(`native notifications are not supported on ${deps.platform}`)
        }
      },
    ])
  }

  if (cfg.pushover) {
    const creds = cfg.pushover
    tasks.push([
      "pushover",
      async () => {
        const parts = pushoverParts(m)
        // In order, so parts arrive 1/n … n/n.
        for (const part of parts) {
          await deps
            .fetch("https://api.pushover.net/1/messages.json", {
              method: "POST",
              signal: timeout(),
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...creds, ...part }),
            })
            .then(ok)
        }
        if (parts.length > 1) return `${parts.length} messages`
      },
    ])
  }

  const results = await Promise.allSettled(tasks.map(([, t]) => t()))
  const out: Delivery = { sent: [], failed: [] }
  results.forEach((r, i) => {
    const name = tasks[i][0]
    if (r.status === "fulfilled") out.sent.push(r.value ? `${name} (${r.value})` : name)
    else {
      out.failed.push(name)
      log.error({ via: name, err: r.reason }, "notification failed")
    }
  })
  return out
}
