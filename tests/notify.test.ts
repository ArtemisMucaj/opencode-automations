import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { log } from "../log.ts"
import { deliver, format, MAX_PARTS, pushoverParts, split, MAX_LINE, PUSHOVER, wrapLines, type Deps, type Message, type Destination } from "../notify.ts"
import { compose, Outbox, parseDestinations, RETRY_MS } from "../outbox.ts"
import { Store, type Job, type Run } from "../store.ts"

const job: Job = {
  id: "morning", name: "Morning", prompt: "Check things", schedule: { kind: "every", ms: 60_000 },
  directory: "/project", session: "new", timeoutMinutes: 30, runMissed: true, enabled: true,
  source: "tool", createdAt: 1,
}
const run: Run = { runID: "r1", jobID: "morning", startedAt: 1, endedAt: 2001, status: "succeeded" }
const message: Message = { title: "Morning", body: "All clear", priority: "normal" }

const noNetwork = async (): Promise<Response> => { throw new Error("unexpected network request") }
const noExec = async () => { throw new Error("unexpected native notification") }
const native: Destination = { id: "desktop", type: "Notification.Native" }
const pushover: Destination = { id: "phone", type: "Notification.PushOver", options: { token: "test-token", user: "test-user" } }

test("native on macOS sends title and body as arguments, not AppleScript source", async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const body = 'Output with "quotes" and \\slashes'
  await deliver(native, { ...message, body }, {
    platform: "darwin", fetch: noNetwork, exec: async (command, args) => { calls.push({ command, args }) },
  })
  expect(calls).toHaveLength(1)
  expect(calls[0].command).toBe("osascript")
  expect(calls[0].args.slice(-3)).toEqual(["Morning", body, "opencode automations"])
  expect(calls[0].args[3]).toContain('sound name "Glass"')
})

test.each([
  ["normal", "normal"], ["high", "critical"], ["low", "low"],
] as const)("native on Linux sends %s priority with %s urgency", async (priority, urgency) => {
  const calls: Array<{ command: string; args: string[] }> = []
  await deliver(native, { title: "--untrusted-title", body: "$(touch /bad); output", priority }, {
    platform: "linux", fetch: noNetwork, exec: async (command, args) => { calls.push({ command, args }) },
  })
  expect(calls).toEqual([{
    command: "notify-send",
    args: ["--app-name", "opencode automations", "--urgency", urgency, "--", "--untrusted-title", "$(touch /bad); output"],
  }])
})

test("native gets plain text with markdown cleaned up and the link appended", async () => {
  const calls: string[][] = []
  await deliver(native, { title: "T", body: "## Summary\n- **two** [MRs](https://x.test/mr)\n- `ci` red", url: "https://x.test" }, {
    platform: "linux", fetch: noNetwork, exec: async (_c, args) => { calls.push(args) },
  })
  expect(calls[0].at(-1)).toBe("Summary\n• two MRs (https://x.test/mr)\n• ci red\nhttps://x.test")
})

test("native macOS sound option is used, and an empty one is silent", async () => {
  const calls: string[][] = []
  const deps: Deps = { platform: "darwin", fetch: noNetwork, exec: async (_command, args) => { calls.push(args) } }
  await deliver({ ...native, sound: "Ping" }, message, deps)
  await deliver({ ...native, sound: "" }, message, deps)
  expect(calls[0][3]).toContain('sound name "Ping"')
  expect(calls[1][3]).not.toContain("sound name")
})

test("unsupported native platform fails without spawning a process", async () => {
  let calls = 0
  await expect(deliver(native, message, { platform: "win32", fetch: noNetwork, exec: async () => { calls++ } })).rejects.toThrow("win32")
  expect(calls).toBe(0)
})

test("Pushover sends credentials, HTML message, priority and link; credentials may come from the environment", async () => {
  const calls: Array<{ url: string; input?: RequestInit }> = []
  process.env.TEST_PUSHOVER_TOKEN = "env-token"
  try {
    await deliver({ ...pushover, options: { token: "{env:TEST_PUSHOVER_TOKEN}", user: "test-user" } }, {
      title: "CI broke", body: "**main** is red: a < b & c", priority: "high", url: "https://ci.test/1", urlTitle: "Open build",
    }, { platform: "linux", fetch: async (url, input) => { calls.push({ url, input }); return new Response("ok") }, exec: noExec })
  } finally { delete process.env.TEST_PUSHOVER_TOKEN }
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe("https://api.pushover.net/1/messages.json")
  expect(calls[0].input?.method).toBe("POST")
  expect(JSON.parse(calls[0].input?.body as string)).toEqual({
    token: "env-token", user: "test-user", title: "CI broke", message: "<b>main</b> is red: a &lt; b &amp; c",
    html: 1, priority: 1, url: "https://ci.test/1", url_title: "Open build",
  })
})

test("Pushover failures carry the response body", async () => {
  await expect(deliver(pushover, message, {
    platform: "linux", fetch: async () => new Response('{"errors":["user key is invalid"]}', { status: 400 }), exec: noExec,
  })).rejects.toThrow("user key is invalid")
})

test("long messages are split into numbered parts at paragraph boundaries, in order", async () => {
  const paragraphs = Array.from({ length: 4 }, (_, i) => `Finding ${i + 1}: ` + "detail ".repeat(40).trim())
  const bodies: Array<{ title: string; message: string; url?: string }> = []
  await deliver(pushover, { title: "Audit", body: paragraphs.join("\n\n"), url: "https://x.test" }, {
    platform: "linux", fetch: async (_url, input) => { bodies.push(JSON.parse(input?.body as string)); return new Response("ok") }, exec: noExec,
  })
  expect(bodies.length).toBeGreaterThan(1)
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

test("a message too long for Pushover is cut to its part limit", () => {
  const parts = pushoverParts({ title: "Dump", body: ("word ".repeat(30) + "\n").repeat(60) })
  expect(parts).toHaveLength(MAX_PARTS)
  expect(String(parts.at(-1)!.message).endsWith("…")).toBe(true)
  expect(parts.at(-1)!.title).toBe(`Dump (${MAX_PARTS}/${MAX_PARTS})`)
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

test("compose writes a short notice", () => {
  expect(compose(job, { ...run, status: "failed" }).body).toBe("Failed after 2s.")
  expect(compose(job, { ...run, status: "failed", error: "boom" })).toEqual({ title: "Morning failed", body: "boom", priority: "high" })
  expect(compose(job, { ...run, status: "timeout", error: "exceeded 30m" }).body).toBe("Stopped: exceeded 30m.")
})

// ---------- outbox ----------

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
function store() {
  const dir = mkdtempSync(join(tmpdir(), "automations-outbox-"))
  dirs.push(dir)
  return new Store(dir)
}

test("destinations are checked: ids unique, a known type, what Pushover needs", () => {
  expect(parseDestinations(undefined)).toEqual([])
  expect(parseDestinations({ destinations: [native, pushover] })).toHaveLength(2)
  expect(() => parseDestinations({ destinations: [native, native] })).toThrow("unique")
  expect(() => parseDestinations({ destinations: [{ id: "x", type: "sms" } as unknown as Destination] })).toThrow("type must be one of")
  expect(() => parseDestinations({ destinations: [{ id: "p", type: "Notification.PushOver", options: { token: "t" } } as unknown as Destination] })).toThrow("options.token and options.user")
})

test("automatic notices: failures by default, never for success, with or without a destination", () => {
  const outbox = new Outbox(store(), { destinations: [native] })
  expect(outbox.noticeFor(job, "failed")).toBe(true)
  expect(outbox.noticeFor(job, "timeout")).toBe(true)
  expect(outbox.noticeFor(job, "succeeded")).toBe(false)
  expect(new Outbox(store(), { destinations: [native], on: ["succeeded"] }).noticeFor(job, "succeeded")).toBe(false)
  expect(outbox.noticeFor({ ...job, notify: ["succeeded"] }, "succeeded")).toBe(false)
  expect(outbox.noticeFor({ ...job, notify: false }, "failed")).toBe(false)
  expect(outbox.noticeFor({ ...job, notify: ["timeout"] }, "failed")).toBe(false)
  expect(new Outbox(store(), {}).noticeFor(job, "failed")).toBe(true)
})

test("the dispatcher sends each message to every destination that takes its priority, and retries failures", async () => {
  const warn = spyOn(log, "warn").mockImplementation(() => {})
  const error = spyOn(log, "error").mockImplementation(() => {})
  try {
    const s = store()
    let pushoverUp = false
    const execs: string[] = []
    const deps: Deps = {
      platform: "linux",
      exec: async (_c, args) => { execs.push(args.at(-2)!) },
      fetch: async () => (pushoverUp ? new Response("ok") : new Response("down", { status: 503 })),
    }
    // Not sending on its own (as off the leader): the test drives each pass.
    const outbox = new Outbox(s, { destinations: [native, { ...pushover, minPriority: "high" }] }, () => false, deps)
    outbox.add({ title: "FYI", body: "low", priority: "low" }, { job: "morning" })
    outbox.add({ title: "Urgent", body: "now", priority: "high" }, { job: "morning" })
    await outbox.dispatch()
    expect(execs.sort()).toEqual(["FYI", "Urgent"])
    // Pushover only takes high, and failed: it waits for its retry.
    const urgent = s.sent("morning").find((m) => m.title === "Urgent")!
    expect(urgent.sends).toEqual([{ destination: "desktop", status: "sent" }, { destination: "phone", status: "pending", error: "HTTP 503: down" }])
    expect(s.sent("morning").find((m) => m.title === "FYI")!.sends).toEqual([{ destination: "desktop", status: "sent" }])
    expect(s.due()).toEqual([])
    // Once due again, it is sent; nothing already sent goes again.
    pushoverUp = true
    expect(s.due(Date.now() + RETRY_MS[0])).toHaveLength(1)
    s.db.run("UPDATE sends SET next_at = 0 WHERE status = 'pending'")
    await outbox.dispatch()
    expect(s.sent("morning").find((m) => m.title === "Urgent")!.sends.map((x) => x.status)).toEqual(["sent", "sent"])
    expect(execs).toHaveLength(2)
    // A destination that keeps failing is given up on after its retries.
    pushoverUp = false
    outbox.add({ title: "Again", body: "x", priority: "high" })
    for (let i = 0; i <= RETRY_MS.length; i++) {
      s.db.run("UPDATE sends SET next_at = 0 WHERE status = 'pending'")
      await outbox.dispatch()
    }
    expect(s.sent().find((m) => m.title === "Again")!.sends.find((x) => x.destination === "phone")!.status).toBe("failed")
    expect(error.mock.calls[0][1]).toBe("notification failed, giving up")
    s.close()
  } finally { warn.mockRestore(); error.mockRestore() }
})

test("quotes in link URLs can't break the href", async () => {
  const { format } = await import("../notify.ts")
  expect(format('[dash](https://x.test/?q="a")', "html")).toBe('<a href="https://x.test/?q=&quot;a&quot;">dash</a>')
})

test("wrapLines breaks a wall of text at words but leaves links and short lines alone", () => {
  const short = "3 MRs need review\n\n!12 blocked\nhttps://x.test/" + "a".repeat(400)
  expect(wrapLines(short)).toBe(short)
  const wall = "word ".repeat(MAX_LINE / 2).trim()
  const lines = wrapLines(`Fine\n${wall}`).split("\n")
  expect(lines[0]).toBe("Fine")
  expect(lines.length).toBeGreaterThan(2)
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(MAX_LINE)
  expect(lines.slice(1).join(" ")).toBe(wall)
  // A link on a long line doesn't count toward its length and isn't cut.
  const url = "https://x.test/" + "a".repeat(300)
  expect(wrapLines(`${"word ".repeat(30)}${url}`)).toBe(`${"word ".repeat(30)}${url}`)
  // One word longer than the limit is hard-cut.
  expect(wrapLines("x".repeat(MAX_LINE * 2 + 1)).split("\n").map((l) => l.length)).toEqual([MAX_LINE, MAX_LINE, 1])
})
