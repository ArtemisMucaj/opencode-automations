import { parseDuration } from "./cron.ts"

const DEFAULT_CACHE_MS = 5 * 60_000

/** The prompt-cache lifetime a request's options ask for, else the providers' default. */
export function cacheLifetime(options: Record<string, any> | undefined): number {
  if (options?.cache === "none") return 0
  const asked = [options?.cache?.ttl, options?.prompt_cache_options?.ttl, options?.prompt_cache_retention, options?.cache_control?.ttl]
    .map((v) => parseDuration(v)).find((ms) => ms !== undefined)
  return asked ?? DEFAULT_CACHE_MS
}
