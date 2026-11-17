import { parseDuration } from "./cron.ts"

const DEFAULT_CACHE_MS = 5 * 60_000

/** The field `key` of `value`, if `value` is an object. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined

/** The prompt-cache lifetime a request's options ask for, else the providers' default. */
export function cacheLifetime(options: Record<string, unknown> | undefined): number {
  if (options?.cache === "none") return 0
  const asked = [
    field(options?.cache, "ttl"),
    field(options?.prompt_cache_options, "ttl"),
    options?.prompt_cache_retention,
    field(options?.cache_control, "ttl"),
  ].map((v) => parseDuration(v)).find((ms) => ms !== undefined)
  return asked ?? DEFAULT_CACHE_MS
}
