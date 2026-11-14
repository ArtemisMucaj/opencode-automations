/**
 * Wait for `p` at most `ms`, or until `signal` aborts. Resolves to whether `p` finished in that time;
 * what `p` rejects with is thrown. `p` itself isn't cancelled.
 */
export async function within(p: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stop: (() => void) | undefined
  const over = new Promise<false>((resolve) => {
    stop = () => resolve(false)
    timer = setTimeout(stop, ms)
    if (signal?.aborted) stop()
    else signal?.addEventListener("abort", stop)
  })
  try {
    // A rejection that comes after the wait is over has nobody left to catch it.
    p.catch(() => {})
    return await Promise.race([p.then(() => true as const), over])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", stop!)
  }
}

export const errorMessage = (e: unknown) => String((e as Error)?.message ?? e)

export const fmt = (t?: number) => (t ? new Date(t).toLocaleString() : "—")
export const clock = (t?: number) =>
  t ? new Date(t).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"

export function relative(time: number | undefined, now = Date.now()): string {
  if (time === undefined) return "—"
  const delta = time - now
  const minutes = Math.max(1, Math.round(Math.abs(delta) / 60_000))
  const value = minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`
  return delta >= 0 ? `in ${value}` : `${value} ago`
}

export const text = (content: string) => ({ content })

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** How long a run took: "45s", "3m", "2m 30s". Empty while it hasn't ended. */
export function elapsed(run: { startedAt: number; endedAt?: number }): string {
  if (run.endedAt === undefined) return ""
  const secs = Math.max(1, Math.round((run.endedAt - run.startedAt) / 1000))
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m${secs % 60 ? ` ${secs % 60}s` : ""}`
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export const httpError = (status: number, body: string) => new Error(`HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`)

/** Run a tool's body; what it throws becomes the tool's "error: …" result, for the agent to read. */
export async function orError(fn: () => Promise<{ content: string }>): Promise<{ content: string }> {
  try { return await fn() } catch (e) { return text(`error: ${errorMessage(e)}`) }
}

export const leaderLine = (leader: boolean) => `Leader: ${leader ? "this process" : "another process"}`
