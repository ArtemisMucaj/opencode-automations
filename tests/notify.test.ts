import { expect, spyOn, test } from "bun:test"
import { compose, format, pushoverParts, send, shouldNotify, split, PUSHOVER, type Deps, type Message } from "../notify.ts"
import type { Job, Run } from "../store.ts"

const job: Job = {
  id: "morning", name: "Morning", prompt: "Check things", schedule: { kind: "every", ms: 60_000 },
  directory: "/project", session: "new", timeoutMinutes: 30, runMissed: true, enabled: true,
  source: "tool", createdAt: 1,
}
const run: Run = { runID: "r1", jobID: "morning", startedAt: 1, endedAt: 2001, status: "succeeded" }
const message: Message = { title: "Morning", body: "All clear", priority: "normal" }

const noNetwork = async (): Promise<Response> => { throw new Error("unexpected network request") }
const noExec = async () => { throw new Error("unexpected native notification") }

test("removed notification channels never send requests", async () => {
  let requests = 0
  await send({
    ntfy: { topic: "old-topic" }, bark: { key: "old-key" }, webhook: { url: "https://example.invalid" },
  } as any, message, { platform: "darwin", fetch: async () => { requests++; return new Response("ok") }, exec: noExec })
  expect(requests).toBe(0)
})

test("native on macOS sends title and body as arguments, not AppleScript source", async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const body = 'Output with "quotes" and \\slashes'
  const result = await send({ native: true }, { ...message, body }, {
    platform: "darwin", fetch: noNetwork, exec: async (command, args) => { calls.push({ command, args }) },
  })
  expect(result).toEqual({ sent: ["native"], failed: [] })
  expect(calls).toHaveLength(1)
  expect(calls[0].command).toBe("osascript")
  expect(calls[0].args.slice(-3)).toEqual(["Morning", body, "opencode automations"])
  expect(calls[0].args[3]).toContain('sound name "Glass"')
})

test.each([
  ["normal", "normal"], ["high", "critical"], ["low", "low"],
] as const)("native on Linux sends %s priority with %s urgency", async (priority, urgency) => {
  const calls: Array<{ command: string; args: string[] }> = []
  await send({ native: true }, { title: "--untrusted-title", body: "$(touch /bad); output", priority }, {
    platform: "linux", fetch: noNetwork, exec: async (command, args) => { calls.push({ command, args }) },
  })
  expect(calls).toEqual([{
    command: "notify-send",
    args: ["--app-name", "opencode automations", "--urgency", urgency, "--", "--untrusted-title", "$(touch /bad); output"],
  }])
})

test("native gets plain text with markdown cleaned up and the link appended", async () => {
  const calls: string[][] = []
  await send({ native: true }, { title: "T", body: "## Summary\n- **two** [MRs](https://x.test/mr)\n- `ci` red", url: "https://x.test" }, {
    platform: "linux", fetch: noNetwork, exec: async (_c, args) => { calls.push(args) },
  })
  expect(calls[0].at(-1)).toBe("Summary\n• two MRs (https://x.test/mr)\n• ci red\nhttps://x.test")
})

test("native disabled never invokes an OS backend", async () => {
  let calls = 0
  await send({ native: false }, message, { platform: "linux", fetch: noNetwork, exec: async () => { calls++ } })
  expect(calls).toBe(0)
})

test("native macOS sound options are preserved", async () => {
  const calls: string[][] = []
  const deps: Deps = { platform: "darwin", fetch: noNetwork, exec: async (_command, args) => { calls.push(args) } }
  await send({ native: { sound: "Ping" } }, message, deps)
  await send({ native: { sound: "" } }, message, deps)
  expect(calls[0][3]).toContain('sound name "Ping"')
  expect(calls[1][3]).not.toContain("sound name")
})

test("missing Linux backend is reported without blocking Pushover", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  const requests: string[] = []
  try {
    const result = await send({ native: true, pushover: { token: "test-token", user: "test-user" } }, message, {
      platform: "linux",
      fetch: async (url) => { requests.push(url); return new Response("ok") },
      exec: async () => { throw new Error("spawn notify-send ENOENT") },
    })
    expect(result).toEqual({ sent: ["pushover"], failed: ["native"] })
    expect(requests).toEqual(["https://api.pushover.net/1/messages.json"])
    expect(errors.mock.calls[0][0]).toContain("notify via native failed")
    expect(errors.mock.calls[0][1]).toContain("ENOENT")
  } finally { errors.mockRestore() }
})

test("unsupported native platform reports failure without spawning a process", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  let calls = 0
  try {
    const result = await send({ native: true }, message, { platform: "win32", fetch: noNetwork, exec: async () => { calls++ } })
    expect(result.failed).toEqual(["native"])
    expect(calls).toBe(0)
    expect(errors.mock.calls[0][1]).toContain("win32")
  } finally { errors.mockRestore() }
})

test("Pushover sends credentials, HTML message, priority and link", async () => {
  const calls: Array<{ url: string; input?: RequestInit }> = []
  const result = await send({ pushover: { token: "test-token", user: "test-user" } }, {
    title: "CI broke", body: "**main** is red: a < b & c", priority: "high", url: "https://ci.test/1", urlTitle: "Open build",
  }, { platform: "linux", fetch: async (url, input) => { calls.push({ url, input }); return new Response("ok") }, exec: noExec })
  expect(result).toEqual({ sent: ["pushover"], failed: [] })
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe("https://api.pushover.net/1/messages.json")
  expect(calls[0].input?.method).toBe("POST")
  expect(JSON.parse(calls[0].input?.body as string)).toEqual({
    token: "test-token", user: "test-user", title: "CI broke", message: "<b>main</b> is red: a &lt; b &amp; c",
    html: 1, priority: 1, url: "https://ci.test/1", url_title: "Open build",
  })
})

test("Pushover failures include the response body in the log", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    const result = await send({ pushover: { token: "t", user: "u" } }, message, {
      platform: "linux", fetch: async () => new Response('{"errors":["user key is invalid"]}', { status: 400 }), exec: noExec,
    })
    expect(result.failed).toEqual(["pushover"])
    expect(errors.mock.calls[0][1]).toContain("user key is invalid")
  } finally { errors.mockRestore() }
})

test("long messages are split into numbered parts at paragraph boundaries, in order", async () => {
  const paragraphs = Array.from({ length: 6 }, (_, i) => `Finding ${i + 1}: ` + "detail ".repeat(40).trim())
  const bodies: any[] = []
  const result = await send({ pushover: { token: "t", user: "u" } }, { title: "Audit", body: paragraphs.join("\n\n"), url: "https://x.test" }, {
    platform: "linux", fetch: async (_url, input) => { bodies.push(JSON.parse(input?.body as string)); return new Response("ok") }, exec: noExec,
  })
  expect(bodies.length).toBeGreaterThan(1)
  expect(result.sent).toEqual([`pushover (${bodies.length} messages)`])
  bodies.forEach((b, i) => {
    expect(b.title).toBe(`Audit (${i + 1}/${bodies.length})`)
    expect(b.message.length).toBeLessThanOrEqual(PUSHOVER.message)
    expect(b.message.startsWith("Finding")).toBe(true) // each part starts on a paragraph
  })
  // Nothing lost, nothing duplicated.
  expect(bodies.map((b) => b.message).join("\n\n")).toBe(paragraphs.join("\n\n"))
  // The link button is on the last part only.
  expect(bodies.map((b) => b.url)).toEqual([...Array(bodies.length - 1).fill(undefined), "https://x.test"])
})

test("splitting never breaks an HTML tag, a word, or an emoji", () => {
  const body = ("**bold** word 🎉 ".repeat(200)).trim()
  const parts = split(body, PUSHOVER.message, "html")
  for (const p of parts) {
    expect(p.length).toBeLessThanOrEqual(PUSHOVER.message)
    expect(p.split("<b>").length).toBe(p.split("</b>").length)
    expect(p).not.toMatch(/[\ud800-\udbff]$/)
  }
  expect(parts.join(" ").split("🎉").length - 1).toBe(200)
})

test("a single oversized word is hard-cut", () => {
  const parts = split("x".repeat(2500), PUSHOVER.message, "html")
  expect(parts.map((p) => p.length)).toEqual([1024, 1024, 452])
})

test("titles are clipped to Pushover's limit, keeping the part suffix", () => {
  const parts = pushoverParts({ title: "t".repeat(400), body: "a\n\n".repeat(1) + "b ".repeat(700) })
  for (const p of parts) expect(String(p.title).length).toBeLessThanOrEqual(PUSHOVER.title)
  expect(String(parts[0].title).endsWith(`(1/${parts.length})`)).toBe(true)
})

test("format cleans up markdown for each channel", () => {
  const md = [
    "# Daily report", "", "", "", "| MR | State |", "|---|:---:|", "| !12 | **blocked** |",
    "```", "npm test", "```", "> quoted", "  - nested", "snake_case_name and 2 * 3 * 4",
  ].join("\n")
  expect(format(md, "plain")).toBe("Daily report\n\nMR · State\n!12 · blocked\nnpm test\nquoted\n  • nested\nsnake_case_name and 2 * 3 * 4")
  expect(format(md, "html")).toBe("<b>Daily report</b>\n\nMR · State\n!12 · <b>blocked</b>\nnpm test\nquoted\n  • nested\nsnake_case_name and 2 * 3 * 4")
  expect(format("[x](https://a.test?q=1&r=2) <script>", "html")).toBe('<a href="https://a.test?q=1&amp;r=2">x</a> &lt;script&gt;')
})

test("automatic notices: failures by default, never for success", () => {
  const cfg = { native: true }
  expect(shouldNotify(cfg, job, "failed")).toBe(true)
  expect(shouldNotify(cfg, job, "timeout")).toBe(true)
  expect(shouldNotify(cfg, job, "succeeded")).toBe(false)
  expect(shouldNotify({ ...cfg, on: ["succeeded"] }, job, "succeeded")).toBe(false)
  expect(shouldNotify(cfg, { ...job, notify: ["succeeded"] }, "succeeded")).toBe(false)
  expect(shouldNotify(cfg, { ...job, notify: false }, "failed")).toBe(false)
  expect(shouldNotify(cfg, { ...job, notify: ["timeout"] }, "failed")).toBe(false)
  expect(shouldNotify({}, job, "failed")).toBe(false)
})

test("compose writes a short notice and never includes the agent's output", () => {
  expect(compose(job, { ...run, status: "failed", output: "y".repeat(3000) }).body).toBe("Failed after 2s.")
  expect(compose(job, { ...run, status: "failed", error: "boom" })).toEqual({ title: "Morning failed", body: "boom", priority: "high" })
  expect(compose(job, { ...run, status: "timeout", error: "exceeded 30m" }).body).toBe("Stopped: exceeded 30m.")
})

test("quotes in link URLs can't break the href", async () => {
  const { format } = await import("../notify.ts")
  expect(format('[dash](https://x.test/?q="a")', "html")).toBe('<a href="https://x.test/?q=&quot;a&quot;">dash</a>')
})
