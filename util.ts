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

/**
 * Why a run failed, as a sentence for the user. opencode reports it as { type, message, status, … }:
 * the message is what reads, the rest is for logs.
 */
export function failureText(error: unknown): string {
  if (typeof error === "string") return error
  if (typeof error !== "object" || error === null) return JSON.stringify(error) ?? "unknown error"
  const { type, message, status } = error as { type?: unknown; message?: unknown; status?: unknown }
  if (typeof message !== "string" || !message.trim()) return JSON.stringify(error).slice(0, 500)
  const said = `${message.trim().replace(/\.$/, "")}${typeof status === "number" ? ` (HTTP ${status})` : ""}.`
  if (type === "provider.quota") return `Model quota used up: ${said}`
  if (typeof type === "string" && type.startsWith("provider.")) return `Model provider error: ${said}`
  return said
}

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

/**
 * A map of this instance's entries, mirrored into a map shared with other instances in the process. Reads see
 * only this instance's entries, except `find`, which falls back to the other instances' entries.
 */
export class Owned<V> {
  private readonly mine = new Map<string, V>()
  constructor(private readonly all: Map<string, V>) {}
  get(id: string) { return this.mine.get(id) }
  has(id: string) { return this.mine.has(id) }
  set(id: string, value: V) { this.mine.set(id, value); this.all.set(id, value); return this }
  delete(id: string) {
    if (this.mine.has(id) && this.all.get(id) === this.mine.get(id)) this.all.delete(id)
    return this.mine.delete(id)
  }
  clear() { for (const id of [...this.mine.keys()]) this.delete(id) }
  values() { return this.mine.values() }
  [Symbol.iterator]() { return this.mine[Symbol.iterator]() }
  /** This instance's entry, else another instance's. */
  find(id: string) { return this.mine.get(id) ?? this.all.get(id) }
}

export const ENV_REF = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g

/** Fill every {env:NAME}, deeply; throws on one that isn't set. */
export function withEnv<T>(value: T, env: Record<string, string | undefined> = process.env): T {
  if (typeof value === "string") {
    return value.replace(ENV_REF, (_, name: string) => {
      const v = env[name]
      if (v === undefined) throw new Error(`environment variable ${name} is not set`)
      return v
    }) as T
  }
  if (Array.isArray(value)) return value.map((v) => withEnv(v, env)) as T
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withEnv(v, env)])) as T
  }
  return value
}
