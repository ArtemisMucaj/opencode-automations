// Formatting a message for each kind of sink, and delivering it through one destination.

import { spawn } from "node:child_process"
import { httpError, withEnv, type Fetch } from "./util.ts"

export type Priority = "low" | "normal" | "high"

/** Configured under `outbox.destinations`. */
export namespace Notification {
  interface Base { id: string; minPriority?: Priority }
  /** Desktop notifications (macOS, Linux). An empty `sound` is silent. */
  export interface Native extends Base { type: "Notification.Native"; sound?: string }
  export interface PushOver extends Base { type: "Notification.PushOver"; options: { token: string; user: string } }
}
export type Destination = Notification.Native | Notification.PushOver

export interface Message {
  title: string
  /** Plain text. Light markdown (bullets, **bold**, links, headings) is cleaned up per sink. */
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

export const defaultDeps: Deps = {
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

// ---------- formatting ----------

/** Pushover's documented limits. https://pushover.net/api#limits */
export const PUSHOVER = { message: 1024, title: 250, url: 512, urlTitle: 100 } as const
export const MAX_PARTS = 4
/** Longest message the agent may send: about MAX_PARTS Pushover messages. */
export const MAX_MESSAGE = 4000

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

/** A line's length as read, links aside: a long URL is one tap, not a wall of text. */
const readLength = (s: string) => s.replace(/\bhttps?:\/\/\S+/g, "").trim().length

/** Break lines longer than MAX_LINE (links aside) at word breaks, so a wall of text reads on a phone. */
export function wrapLines(text: string): string {
  return text.split("\n").map((l) => {
    if (readLength(l) <= MAX_LINE) return l
    const pieces: string[] = []
    let cur = ""
    for (const word of l.split(/(?<=\s)/)) {
      if (!cur || readLength(cur + word) <= MAX_LINE) { cur += word; continue }
      pieces.push(cur.trimEnd())
      cur = word
    }
    pieces.push(cur.trimEnd())
    // One word longer than MAX_LINE (not a link): hard-cut it.
    return pieces.flatMap((p) => (readLength(p) <= MAX_LINE ? [p] : p.match(new RegExp(`.{1,${MAX_LINE}}`, "gu")) ?? [p])).join("\n")
  }).join("\n")
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

/** Split into rendered messages of at most `max` characters, at paragraphs, then lines, then words. */
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

/** Pushover payloads: numbered parts when long, at most MAX_PARTS. */
export function pushoverParts(m: Message): Array<Record<string, string | number>> {
  const bodies = split(m.body, PUSHOVER.message, "html")
  if (!bodies.length) bodies.push(escapeHTML(m.title))
  if (bodies.length > MAX_PARTS) {
    bodies.length = MAX_PARTS
    if (bodies[MAX_PARTS - 1].length + 2 <= PUSHOVER.message) bodies[MAX_PARTS - 1] += "\n…"
  }
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

/** Deliver through one destination; throws on failure. */
export async function deliver(destination: Destination, m: Message, deps: Deps = defaultDeps): Promise<void> {
  const plain = format(m.body, "plain") || m.title
  const high = m.priority === "high"
  switch (destination.type) {
    case "Notification.Native": {
      const body = m.url ? `${plain}\n${m.url}` : plain
      if (deps.platform === "darwin") {
        const sound = destination.sound ?? (high ? "Basso" : "Glass")
        return deps.exec("osascript", [
          "-e", "on run argv",
          "-e", `display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)${sound ? ` sound name "${sound.replace(/"/g, "")}"` : ""}`,
          "-e", "end run",
          m.title, body.slice(0, 240), "opencode automations",
        ])
      }
      if (deps.platform === "linux") {
        return deps.exec("notify-send", [
          "--app-name", "opencode automations",
          "--urgency", high ? "critical" : m.priority === "low" ? "low" : "normal",
          "--", m.title, body,
        ])
      }
      throw new Error(`native notifications are not supported on ${deps.platform}`)
    }
    case "Notification.PushOver": {
      const creds = { token: withEnv(destination.options.token), user: withEnv(destination.options.user) }
      // In order, so parts arrive 1/n … n/n.
      for (const part of pushoverParts(m)) {
        await deps.fetch("https://api.pushover.net/1/messages.json", {
          method: "POST", signal: timeout(), headers: { "content-type": "application/json" }, body: JSON.stringify({ ...creds, ...part }),
        }).then(ok)
      }
      return
    }
  }
}
