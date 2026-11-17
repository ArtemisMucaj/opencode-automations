import { get } from "./channels.ts"
import { parseDuration } from "./cron.ts"

const DEFAULT_CACHE_MS = 5 * 60_000

/** The prompt-cache lifetime a request's options ask for, else the providers' default. */
export function cacheLifetime(options: Record<string, unknown> | undefined): number {
  if (options?.cache === "none") return 0
  const asked = ["cache.ttl", "prompt_cache_options.ttl", "prompt_cache_retention", "cache_control.ttl"]
    .map((path) => get(options, path)).map((v) => parseDuration(v)).find((ms) => ms !== undefined)
  return asked ?? DEFAULT_CACHE_MS
}
