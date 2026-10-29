import { expect, test } from "bun:test"
import { send, type Deps, type Message } from "../notify.ts"

const message: Message = {
  title: "Morning succeeded", body: "All clear", status: "succeeded",
  job: {
    id: "morning", name: "Morning", prompt: "Check things", schedule: { kind: "every", ms: 60_000 },
    directory: "/project", session: "new", timeoutMinutes: 30, catchUp: true, enabled: true,
    source: "tool", createdAt: 1,
  },
  run: { runID: "r1", jobID: "morning", startedAt: 1, endedAt: 2, status: "succeeded" },
}

test("removed notification channels never send requests", async () => {
  let requests = 0
  const deps: Deps = {
    platform: "darwin",
    fetch: async () => { requests++; return new Response("ok") },
    osascript: async () => { throw new Error("unexpected macOS notification") },
  }
  await send({
    ntfy: { topic: "old-topic" }, bark: { key: "old-key" }, webhook: { url: "https://example.invalid" },
  } as any, message, deps)
  expect(requests).toBe(0)
})

test("macOS sends title and body as arguments, not AppleScript source", async () => {
  const calls: string[][] = []
  const body = 'Output with "quotes" and \\slashes'
  const failed = await send({ macos: true }, { ...message, body }, {
    platform: "darwin",
    fetch: async () => { throw new Error("unexpected network request") },
    osascript: async (args) => { calls.push(args) },
  })
  expect(failed).toEqual([])
  expect(calls).toHaveLength(1)
  expect(calls[0].slice(-3)).toEqual(["Morning succeeded", body, "opencode automations"])
  expect(calls[0][3]).toContain('sound name "Glass"')
})

test("macOS channel is skipped outside macOS", async () => {
  let calls = 0
  await send({ macos: true }, message, {
    platform: "linux",
    fetch: async () => { throw new Error("unexpected network request") },
    osascript: async () => { calls++ },
  })
  expect(calls).toBe(0)
})

test("Pushover sends credentials, message and elevated failure priority", async () => {
  const calls: Array<{ url: string; input?: RequestInit }> = []
  const failed = await send({ pushover: { token: "test-token", user: "test-user" } }, { ...message, status: "failed" }, {
    platform: "linux",
    fetch: async (url, input) => { calls.push({ url, input }); return new Response("ok") },
    osascript: async () => { throw new Error("unexpected macOS notification") },
  })
  expect(failed).toEqual([])
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe("https://api.pushover.net/1/messages.json")
  expect(calls[0].input?.method).toBe("POST")
  expect(JSON.parse(calls[0].input?.body as string)).toEqual({
    token: "test-token", user: "test-user", title: "Morning succeeded", message: "All clear", priority: 1,
  })
})
