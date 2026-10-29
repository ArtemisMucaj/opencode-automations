// Run-completion notifications, sent from the server plugin so they work with no TUI open.
// Channels: macOS Notification Center and Pushover.
// Failures are logged and never affect the run.

import { spawn } from "node:child_process"
import type { Job, Run, RunStatus } from "./store.ts"

export interface NotifyConfig {
  /** Which outcomes notify. Default: every finished run except skipped. */
  on?: RunStatus[]
  macos?: boolean | { sound?: string }
  pushover?: { token: string; user: string }
}

/** Per job: false = never, true = plugin defaults, array = these statuses only. */
export type JobNotify = boolean | RunStatus[]

export interface Message {
  title: string
  body: string
  status: RunStatus
  job: Job
  run: Run
}

export interface Deps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  osascript: (args: string[]) => Promise<void>
  platform: NodeJS.Platform
}

const DEFAULT_ON: RunStatus[] = ["succeeded", "failed", "timeout"]

const defaultDeps: Deps = {
  fetch: (input, init) => fetch(input, init),
  platform: process.platform,
  osascript: (args) =>
    new Promise((resolve, reject) => {
      // argv, not string interpolation: job output can contain anything.
      const p = spawn("osascript", args, { stdio: "ignore" })
      p.on("error", reject)
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`osascript exited ${code}`))))
    }),
}

export function shouldNotify(cfg: NotifyConfig | undefined, job: Job, status: RunStatus) {
  if (!cfg || job.notify === false) return false
  const on = Array.isArray(job.notify) ? job.notify : (cfg.on ?? DEFAULT_ON)
  return on.includes(status)
}

export function compose(job: Job, run: Run): Message {
  const icon = { succeeded: "✅", failed: "❌", timeout: "⏱", skipped: "↷", running: "◐" }[run.status]
  const secs = run.endedAt ? Math.max(1, Math.round((run.endedAt - run.startedAt) / 1000)) : 0
  const dur = secs >= 60 ? `${Math.round(secs / 60)}m` : `${secs}s`
  const text = (run.error ?? run.output ?? "").trim()
  return {
    title: `${icon} ${job.name} ${run.status}`,
    body: text ? text.slice(0, 500) : `Finished in ${dur}`,
    status: run.status,
    job,
    run,
  }
}

const ok = (r: Response) => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
}
const timeout = () => AbortSignal.timeout(10_000)

export async function send(cfg: NotifyConfig, m: Message, deps: Deps = defaultDeps): Promise<string[]> {
  const bad = m.status !== "succeeded"
  const tasks: Array<[string, () => Promise<unknown>]> = []

  if (cfg.macos && deps.platform === "darwin") {
    const sound = typeof cfg.macos === "object" ? cfg.macos.sound : bad ? "Basso" : "Glass"
    tasks.push([
      "macos",
      () =>
        deps.osascript([
          "-e", "on run argv",
          "-e", `display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)${sound ? ` sound name "${sound.replace(/"/g, "")}"` : ""}`,
          "-e", "end run",
          m.title, m.body.slice(0, 240), "opencode automations",
        ]),
    ])
  }

  if (cfg.pushover) {
    tasks.push([
      "pushover",
      () =>
        deps
          .fetch("https://api.pushover.net/1/messages.json", {
            method: "POST",
            signal: timeout(),
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...cfg.pushover, title: m.title, message: m.body, priority: bad ? 1 : 0 }),
          })
          .then(ok),
    ])
  }

  const results = await Promise.allSettled(tasks.map(([, t]) => t()))
  const failed: string[] = []
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      failed.push(tasks[i][0])
      console.error(`[automations] notify via ${tasks[i][0]} failed:`, (r.reason as Error)?.message ?? r.reason)
    }
  })
  return failed
}
