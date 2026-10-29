import { expect, spyOn, test } from "bun:test"
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
    exec: async () => { throw new Error("unexpected native notification") },
  }
  await send({
    ntfy: { topic: "old-topic" }, bark: { key: "old-key" }, webhook: { url: "https://example.invalid" },
  } as any, message, deps)
  expect(requests).toBe(0)
})

test("native on macOS sends title and body as arguments, not AppleScript source", async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const body = 'Output with "quotes" and \\slashes'
  const failed = await send({ native: true }, { ...message, body }, {
    platform: "darwin",
    fetch: async () => { throw new Error("unexpected network request") },
    exec: async (command, args) => { calls.push({ command, args }) },
  })
  expect(failed).toEqual([])
  expect(calls).toHaveLength(1)
  expect(calls[0].command).toBe("osascript")
  expect(calls[0].args.slice(-3)).toEqual(["Morning succeeded", body, "opencode automations"])
  expect(calls[0].args[3]).toContain('sound name "Glass"')
})

test.each([
  ["succeeded", "normal"], ["failed", "critical"], ["timeout", "critical"],
] as const)("native on Linux sends %s with %s urgency", async (status, urgency) => {
  const calls: Array<{ command: string; args: string[] }> = []
  const failed = await send({ native: true }, { ...message, status, title: "--untrusted-title", body: "$(touch /bad); output" }, {
    platform: "linux",
    fetch: async () => { throw new Error("unexpected network request") },
    exec: async (command, args) => { calls.push({ command, args }) },
  })
  expect(failed).toEqual([])
  expect(calls).toEqual([{
    command: "notify-send",
    args: ["--app-name", "opencode automations", "--urgency", urgency, "--", "--untrusted-title", "$(touch /bad); output"],
  }])
})

test("native disabled never invokes an OS backend", async () => {
  let calls = 0
  await send({ native: false }, message, {
    platform: "linux",
    fetch: async () => { throw new Error("unexpected network request") },
    exec: async () => { calls++ },
  })
  expect(calls).toBe(0)
})

test("native macOS sound options are preserved", async () => {
  const calls: string[][] = []
  const deps: Deps = {
    platform: "darwin",
    fetch: async () => { throw new Error("unexpected network request") },
    exec: async (_command, args) => { calls.push(args) },
  }
  await send({ native: { sound: "Ping" } }, message, deps)
  await send({ native: { sound: "" } }, message, deps)
  expect(calls[0][3]).toContain('sound name "Ping"')
  expect(calls[1][3]).not.toContain("sound name")
})

test("missing Linux backend is reported without blocking Pushover", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  const requests: string[] = []
  try {
    const failed = await send({ native: true, pushover: { token: "test-token", user: "test-user" } }, message, {
      platform: "linux",
      fetch: async (url) => { requests.push(url); return new Response("ok") },
      exec: async () => { throw new Error("spawn notify-send ENOENT") },
    })
    expect(failed).toEqual(["native"])
    expect(requests).toEqual(["https://api.pushover.net/1/messages.json"])
    expect(errors.mock.calls[0][0]).toContain("notify via native failed")
    expect(errors.mock.calls[0][1]).toContain("ENOENT")
  } finally { errors.mockRestore() }
})

test("unsupported native platform reports failure without spawning a process", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  let calls = 0
  try {
    const failed = await send({ native: true }, message, {
      platform: "win32",
      fetch: async () => { throw new Error("unexpected network request") },
      exec: async () => { calls++ },
    })
    expect(failed).toEqual(["native"])
    expect(calls).toBe(0)
    expect(errors.mock.calls[0][1]).toContain("win32")
  } finally { errors.mockRestore() }
})

test("Pushover sends credentials, message and elevated failure priority", async () => {
  const calls: Array<{ url: string; input?: RequestInit }> = []
  const failed = await send({ pushover: { token: "test-token", user: "test-user" } }, { ...message, status: "failed" }, {
    platform: "linux",
    fetch: async (url, input) => { calls.push({ url, input }); return new Response("ok") },
    exec: async () => { throw new Error("unexpected native notification") },
  })
  expect(failed).toEqual([])
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe("https://api.pushover.net/1/messages.json")
  expect(calls[0].input?.method).toBe("POST")
  expect(JSON.parse(calls[0].input?.body as string)).toEqual({
    token: "test-token", user: "test-user", title: "Morning succeeded", message: "All clear", priority: 1,
  })
})
