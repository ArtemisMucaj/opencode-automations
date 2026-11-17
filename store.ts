// All state, in one SQLite database (bun:sqlite, built into Bun: no dependency, no build step).
// Definitions and small records are JSON documents (jobs, channels, poll status, runs); what is queried by
// field gets columns: the inbox, what each automation took from it, sticky sessions, memory and the outbox.

import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { Schedule } from "./cron.ts"
import type { JobNotify, Priority } from "./outbox.ts"
import type { ChannelEvent, ChannelsState } from "./channels.ts"

/**
 * `sticky`: runs keep going to the same session. With a channel that sets `event.sessionKey`,
 * one sticky session per session key.
 */
export type SessionMode = "new" | "sticky" | "current"
export type RunStatus = "running" | "succeeded" | "failed" | "timeout" | "skipped"
export interface Job {
  id: string
  name: string
  prompt: string
  schedule: Schedule
  directory: string
  session: SessionMode
  /** The chat a `current` automation runs in. */
  sessionID?: string
  agent?: string
  model?: string
  timeoutMinutes: number
  runMissed: boolean
  enabled: boolean
  paused?: boolean
  done?: boolean
  runRequestedAt?: number
  notify?: JobNotify
  /** Takes these channels' events from the inbox: as they arrive (schedule kind "event") or on the schedule, as a digest. */
  on?: { channels: string[] }
  /** Most events in one run. Default 10, or 50 for a digest. */
  maxEvents?: number
  source: "config" | "tool"
  createdAt: number
  nextRunAt?: number
  lastRunAt?: number
  lastStatus?: RunStatus
}
export interface Run {
  jobID: string
  runID: string
  sessionID?: string
  startedAt: number
  endedAt?: number
  status: RunStatus
  /** Why it failed, timed out or was skipped. What the run said isn't kept here: it is in its session. */
  error?: string
  /** automation_notify calls the agent made. */
  notifications?: number
}

/** An inbox event, with its place in the inbox. */
export type InboxEvent = ChannelEvent & { seq: number }

interface StickySession { id: string; usedAt: number; warmUntil?: number }

export interface OutboxMessage {
  id: number
  at: number
  job?: string
  run?: string
  title: string
  body: string
  priority: Priority
  url?: string
  urlTitle?: string
}
export type SendStatus = "pending" | "sent" | "failed"
/** An outbox message with each sender's status. */
export type SentMessage = OutboxMessage & { sends: Array<{ sender: string; status: SendStatus; error?: string }> }

/** How long inbox events are kept once their item is gone from the channel. */
const INBOX_RETENTION_MS = 7 * 24 * 60 * 60_000
const OUTBOX_RETENTION_MS = 30 * 24 * 60 * 60_000
/** Starts that may fail for an event before it is dropped (each failure is recorded and notified). */
export const MAX_START_ATTEMPTS = 3
/** Most events looked at for one automation at once; the rest wait for the next pass. */
const MAX_WAITING = 500
/** Most sticky sessions one automation keeps (one per session key); the least recently used go. */
export const MAX_SESSIONS = 200

const SCHEMA = 1
const TABLES = `
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS channel_defs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS channel_config (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, job TEXT NOT NULL, started_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS runs_by_start ON runs (started_at);
CREATE TABLE IF NOT EXISTS inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, id TEXT NOT NULL, key TEXT,
  title TEXT NOT NULL, body TEXT, url TEXT, at INTEGER NOT NULL, seen_at INTEGER NOT NULL, UNIQUE (channel, id));
CREATE INDEX IF NOT EXISTS inbox_by_channel ON inbox (channel, seq);
CREATE TABLE IF NOT EXISTS subscriptions (
  job TEXT NOT NULL, channel TEXT NOT NULL, since_seq INTEGER NOT NULL, since_poll INTEGER, PRIMARY KEY (job, channel));
CREATE TABLE IF NOT EXISTS deliveries (
  job TEXT NOT NULL, seq INTEGER NOT NULL REFERENCES inbox (seq) ON DELETE CASCADE,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (job, seq));
CREATE INDEX IF NOT EXISTS deliveries_by_seq ON deliveries (seq);
CREATE TABLE IF NOT EXISTS sessions (
  job TEXT NOT NULL, key TEXT NOT NULL, session_id TEXT NOT NULL, used_at INTEGER NOT NULL, warm_until INTEGER,
  PRIMARY KEY (job, key));
CREATE TABLE IF NOT EXISTS memory (job TEXT NOT NULL, key TEXT NOT NULL, note TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (job, key));
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, job TEXT, run TEXT,
  title TEXT NOT NULL, body TEXT NOT NULL, priority TEXT NOT NULL, url TEXT, url_title TEXT);
CREATE INDEX IF NOT EXISTS outbox_by_job ON outbox (job, id);
CREATE TABLE IF NOT EXISTS sends (
  message INTEGER NOT NULL REFERENCES outbox (id) ON DELETE CASCADE, sender TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, error TEXT, PRIMARY KEY (message, sender));
CREATE INDEX IF NOT EXISTS sends_due ON sends (next_at) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS lease (name TEXT PRIMARY KEY, holder TEXT NOT NULL, until INTEGER NOT NULL);
`
/** Tables that hold rows per automation, cleared once it is gone. */
const PER_JOB = ["subscriptions", "deliveries", "sessions", "memory"]

type Row = Record<string, string | number | null>
type Value = string | number | null

export class Store {
  readonly db: Database
  /** Who holds the lease: this store, not this process (the plugin is set up once per directory it serves). */
  private readonly holder = randomUUID()

  /** `busyMs`: how long a write waits for another process's (the TUI waits less, so it never feels stuck). */
  constructor(dataDir: string, { busyMs = 2000 }: { busyMs?: number } = {}) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const path = join(dataDir, "state.db")
    this.db = new Database(path)
    // WAL lets the TUI and the other instances read while one process writes; NORMAL is its usual pairing.
    this.db.exec(`PRAGMA busy_timeout = ${Math.floor(busyMs)}; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`)
    const version = this.get<{ user_version: number }>("PRAGMA user_version")!.user_version
    if (version > SCHEMA) throw new Error(`[automations] ${path} is from a newer version of the plugin`)
    if (version < SCHEMA) this.tx(() => { this.db.exec(TABLES); this.db.exec(`PRAGMA user_version = ${SCHEMA}`) })
  }

  // Statements are cached by their text (db.query), so the ones run on every tick are compiled once.
  private run(sql: string, ...params: Value[]) { return this.db.query(sql).run(...params) }
  private get<T>(sql: string, ...params: Value[]) { return this.db.query(sql).get(...params) as T | null }
  private all<T>(sql: string, ...params: Value[]) { return this.db.query(sql).all(...params) as T[] }

  /**
   * Run `fn` in a write transaction (nested calls join it). `fn` must be synchronous and quick: a writer in
   * another process waits for it, blocking its event loop meanwhile.
   */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate()
  }

  /** Changes when another connection commits: the TUI polls it to know when to re-read. */
  version(): number {
    return this.get<{ data_version: number }>("PRAGMA data_version")!.data_version
  }

  close(): void {
    this.release()
    this.db.close()
  }

  // ---------- documents ----------

  private docs<T>(table: string): Map<string, T> {
    return new Map(this.all<{ id: string; data: string }>(`SELECT id, data FROM ${table}`).map((r) => [r.id, JSON.parse(r.data) as T]))
  }

  /** Make a table hold exactly these documents. Unchanged ones aren't written, so a no-op write wakes nobody. */
  private sync(table: string, docs: Map<string, unknown>): void {
    const saved = new Map(this.all<{ id: string; data: string }>(`SELECT id, data FROM ${table}`).map((r) => [r.id, r.data]))
    for (const [id, doc] of docs) {
      const data = JSON.stringify(doc)
      if (saved.get(id) !== data) this.run(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`, id, data)
    }
    for (const id of saved.keys()) if (!docs.has(id)) this.run(`DELETE FROM ${table} WHERE id = ?`, id)
  }

  loadJobs(): Job[] {
    return [...this.docs<Job>("jobs").values()]
  }

  saveJobs(jobs: Job[]): void {
    this.tx(() => this.sync("jobs", new Map(jobs.map((j) => [j.id, j]))))
  }

  /** Change jobs in one transaction. `fn` must be synchronous (see tx). */
  async mutate<T>(fn: (jobs: Job[]) => T): Promise<T> {
    return this.tx(() => {
      const jobs = this.loadJobs()
      const result = fn(jobs)
      this.saveJobs(jobs)
      return result
    })
  }

  loadChannels(): ChannelsState {
    return {
      sources: Object.fromEntries(this.docs<ChannelsState["sources"][string]>("sources")),
      defs: Object.fromEntries(this.docs<ChannelsState["defs"][string]>("channel_defs")),
      config: Object.fromEntries(this.docs<ChannelsState["config"][string]>("channel_config")),
    }
  }

  saveChannels(s: ChannelsState): void {
    this.tx(() => {
      this.sync("sources", new Map(Object.entries(s.sources)))
      this.sync("channel_defs", new Map(Object.entries(s.defs)))
      this.sync("channel_config", new Map(Object.entries(s.config)))
    })
  }

  /** Change channel definitions and poll state in one transaction. `fn` must be synchronous (see tx). */
  async mutateChannels<T>(fn: (state: ChannelsState) => T): Promise<T> {
    return this.tx(() => {
      const state = this.loadChannels()
      const result = fn(state)
      this.saveChannels(state)
      return result
    })
  }

  /** Delete a channel created from chat: its poll state, its events, and the sessions and memory of its keys. */
  removeChannel(id: string): void {
    this.tx(() => {
      for (const table of ["channel_defs", "sources"]) this.run(`DELETE FROM ${table} WHERE id = ?`, id)
      this.run("DELETE FROM subscriptions WHERE channel = ?", id)
      this.run("DELETE FROM inbox WHERE channel = ?", id)
      // Session keys are "channel:key".
      for (const table of ["sessions", "memory"]) this.run(`DELETE FROM ${table} WHERE substr(key, 1, length(?) + 1) = ? || ':'`, id, id)
    })
  }

  // ---------- runs ----------

  /** Record a run; a later record of the same run replaces it. */
  appendRun(run: Run): void {
    this.run("INSERT OR REPLACE INTO runs (id, job, started_at, data) VALUES (?, ?, ?, ?)", run.runID, run.jobID, run.startedAt, JSON.stringify(run))
  }

  history(jobID?: string, limit = 10): Run[] {
    if (!Number.isFinite(limit) || limit <= 0) return []
    const rows = jobID
      ? this.all<{ data: string }>("SELECT data FROM runs WHERE job = ? ORDER BY started_at DESC LIMIT ?", jobID, Math.floor(limit))
      : this.all<{ data: string }>("SELECT data FROM runs ORDER BY started_at DESC LIMIT ?", Math.floor(limit))
    return rows.map((r) => JSON.parse(r.data) as Run)
  }

  // ---------- inbox ----------

  /**
   * Write a poll's events to the inbox and return how many are new. Every event of the poll is marked as seen
   * at `at`: an item still there isn't dropped by retention, and a new subscriber gets it (see subscribe).
   */
  ingest(channel: string, events: ChannelEvent[], at: number): number {
    return this.tx(() => {
      let fresh = 0
      for (const e of events) {
        fresh += this.run(
          "INSERT OR IGNORE INTO inbox (channel, id, key, title, body, url, at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          channel, e.id, e.sessionKey ?? null, e.title, e.body ?? null, e.url ?? null, at, at).changes
        this.run("UPDATE inbox SET seen_at = ? WHERE channel = ? AND id = ?", at, channel, e.id)
      }
      return fresh
    })
  }

  /**
   * Make each automation's subscriptions match its channels. A new subscription takes what the channel's
   * latest poll returned (`lastOkAt`: what is alerting right now), and everything after. A paused automation
   * keeps its subscription, so its events wait; a disabled or finished one doesn't.
   */
  subscribe(jobs: Job[], lastOkAt: Record<string, number | undefined>): void {
    this.tx(() => {
      const wanted = new Set<string>()
      for (const j of jobs) {
        if (!j.enabled || j.done) continue
        for (const c of j.on?.channels ?? []) {
          wanted.add(`${j.id}\u0000${c}`)
          this.run(
            "INSERT OR IGNORE INTO subscriptions (job, channel, since_seq, since_poll) VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) FROM inbox), ?)",
            j.id, c, lastOkAt[c] ?? null)
        }
      }
      for (const s of this.all<{ job: string; channel: string }>("SELECT job, channel FROM subscriptions")) {
        if (!wanted.has(`${s.job}\u0000${s.channel}`)) this.run("DELETE FROM subscriptions WHERE job = ? AND channel = ?", s.job, s.channel)
      }
    })
  }

  /** Inbox events waiting for an automation, oldest first: on its channels, not taken yet or to be retried. */
  waiting(jobID: string, limit = MAX_WAITING): InboxEvent[] {
    return this.all<Row>(
      "SELECT i.seq, i.channel, i.id, i.key, i.title, i.body, i.url FROM subscriptions s " +
      "JOIN inbox i ON i.channel = s.channel LEFT JOIN deliveries d ON d.job = s.job AND d.seq = i.seq " +
      "WHERE s.job = ? AND (i.seq > s.since_seq OR i.seen_at >= s.since_poll) AND (d.status IS NULL OR d.status = 'retry') " +
      "ORDER BY i.seq LIMIT ?",
      jobID, limit,
    ).map((r) => ({
      seq: r.seq as number,
      channel: r.channel as string,
      id: r.id as string,
      ...(r.key !== null ? { sessionKey: r.key as string } : {}),
      title: r.title as string,
      ...(r.body !== null ? { body: r.body as string } : {}),
      ...(r.url !== null ? { url: r.url as string } : {}),
    }))
  }

  /** How many events wait for each automation, per channel. */
  waitingCounts(): Map<string, Map<string, number>> {
    const rows = this.all<{ job: string; channel: string; n: number }>(
      "SELECT s.job, s.channel, COUNT(*) AS n FROM subscriptions s " +
      "JOIN inbox i ON i.channel = s.channel LEFT JOIN deliveries d ON d.job = s.job AND d.seq = i.seq " +
      "WHERE (i.seq > s.since_seq OR i.seen_at >= s.since_poll) AND (d.status IS NULL OR d.status = 'retry') GROUP BY s.job, s.channel")
    const out = new Map<string, Map<string, number>>()
    for (const r of rows) {
      const perChannel = out.get(r.job) ?? new Map<string, number>()
      perChannel.set(r.channel, r.n)
      out.set(r.job, perChannel)
    }
    return out
  }

  /** Mark events as handed to a run. */
  take(jobID: string, seqs: number[]): void {
    // `WHERE true`: SQLite needs it to tell an upsert's ON CONFLICT from a join's ON after a SELECT.
    this.run(
      "INSERT INTO deliveries (job, seq, status) SELECT ?, value, 'taken' FROM json_each(?) WHERE true " +
      "ON CONFLICT (job, seq) DO UPDATE SET status = 'taken'", jobID, JSON.stringify(seqs))
  }

  /**
   * Events whose run didn't start. Skipped: they wait again. Failed: they are retried, up to
   * MAX_START_ATTEMPTS, then dropped.
   */
  giveBack(jobID: string, seqs: number[], failed: boolean): void {
    const these = "job = ? AND seq IN (SELECT value FROM json_each(?))"
    if (!failed) this.run(`UPDATE deliveries SET status = 'retry' WHERE ${these}`, jobID, JSON.stringify(seqs))
    else {
      this.run(
        `UPDATE deliveries SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= ? THEN 'dropped' ELSE 'retry' END WHERE ${these}`,
        MAX_START_ATTEMPTS, jobID, JSON.stringify(seqs))
    }
  }

  /**
   * Housekeeping: drop old events whose item is gone from its channel (`lastOkAt`: each channel's latest poll),
   * old outbox messages, and what automations that are gone left behind.
   */
  trim(lastOkAt: Record<string, number | undefined>, now = Date.now()): void {
    this.tx(() => {
      for (const c of this.all<{ channel: string }>("SELECT DISTINCT channel FROM inbox")) {
        this.run("DELETE FROM inbox WHERE channel = ? AND at < ? AND seen_at < ?", c.channel, now - INBOX_RETENTION_MS, lastOkAt[c.channel] ?? now)
      }
      this.run("DELETE FROM outbox WHERE at < ?", now - OUTBOX_RETENTION_MS)
      for (const table of PER_JOB) this.run(`DELETE FROM ${table} WHERE job NOT IN (SELECT id FROM jobs)`)
    })
  }

  // ---------- sticky sessions and memory ----------

  session(jobID: string, key = ""): StickySession | undefined {
    const r = this.get<Row>("SELECT session_id, used_at, warm_until FROM sessions WHERE job = ? AND key = ?", jobID, key)
    if (!r) return undefined
    return { id: r.session_id as string, usedAt: r.used_at as number, ...(r.warm_until !== null ? { warmUntil: r.warm_until as number } : {}) }
  }

  /**
   * Set an automation's session for a key. Past MAX_SESSIONS keys, the least recently used go with their
   * memory, except `keep` (keys with a run in progress) and `key` itself.
   */
  setSession(jobID: string, key: string, sessionID: string, now = Date.now(), keep: Iterable<string> = []): void {
    this.tx(() => {
      this.run("INSERT OR REPLACE INTO sessions (job, key, session_id, used_at) VALUES (?, ?, ?, ?)", jobID, key, sessionID, now)
      const old = this.all<{ key: string }>(
        "SELECT key FROM sessions WHERE job = ? AND key NOT IN (SELECT value FROM json_each(?)) ORDER BY used_at " +
        "LIMIT MAX(0, (SELECT COUNT(*) FROM sessions WHERE job = ?) - ?)",
        jobID, JSON.stringify([...keep, key]), jobID, MAX_SESSIONS)
      for (const { key: k } of old) {
        this.run("DELETE FROM sessions WHERE job = ? AND key = ?", jobID, k)
        this.run("DELETE FROM memory WHERE job = ? AND key = ?", jobID, k)
      }
    })
  }

  /** A run in a sticky session ended: it counts as used now, and is warm until `warmUntil` if given. */
  touchSession(jobID: string, key: string, sessionID: string, now: number, warmUntil?: number): void {
    this.run(
      "UPDATE sessions SET used_at = ?, warm_until = COALESCE(?, warm_until) WHERE job = ? AND key = ? AND session_id = ?",
      now, warmUntil ?? null, jobID, key, sessionID)
  }

  note(jobID: string, key = ""): string | undefined {
    return this.get<{ note: string }>("SELECT note FROM memory WHERE job = ? AND key = ?", jobID, key)?.note
  }

  setNote(jobID: string, key: string, note: string | undefined): void {
    if (note === undefined) this.run("DELETE FROM memory WHERE job = ? AND key = ?", jobID, key)
    else this.run("INSERT OR REPLACE INTO memory (job, key, note, updated_at) VALUES (?, ?, ?, ?)", jobID, key, note, Date.now())
  }

  // ---------- outbox ----------

  /** Add a message to the outbox, to be sent through each of `senders`. */
  enqueue(m: Omit<OutboxMessage, "id" | "at">, senders: string[], now = Date.now()): number {
    return this.tx(() => {
      const { id } = this.get<{ id: number }>(
        "INSERT INTO outbox (at, job, run, title, body, priority, url, url_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        now, m.job ?? null, m.run ?? null, m.title, m.body, m.priority, m.url ?? null, m.urlTitle ?? null)!
      for (const s of senders) this.run("INSERT INTO sends (message, sender, status, next_at) VALUES (?, ?, 'pending', ?)", id, s, now)
      return id
    })
  }

  /** Sends due now, oldest first. */
  due(now = Date.now()): Array<{ message: OutboxMessage; sender: string; attempts: number }> {
    return this.all<Row>(
      "SELECT o.*, s.sender, s.attempts FROM sends s JOIN outbox o ON o.id = s.message " +
      "WHERE s.status = 'pending' AND s.next_at <= ? ORDER BY o.id", now,
    ).map((r) => ({ message: message(r), sender: r.sender as string, attempts: r.attempts as number }))
  }

  /** Record a send's outcome. Still pending: tried again at `nextAt`. */
  updateSend(messageID: number, sender: string, status: SendStatus, attempts: number, nextAt: number, error?: string): void {
    this.run("UPDATE sends SET status = ?, attempts = ?, next_at = ?, error = ? WHERE message = ? AND sender = ?",
      status, attempts, nextAt, error ?? null, messageID, sender)
  }

  /** The latest messages, newest first, with each sender's status. */
  sent(jobID?: string, limit = 10): SentMessage[] {
    const rows = this.all<Row>(
      "SELECT o.*, s.sender, s.status, s.error FROM (SELECT * FROM outbox WHERE ?1 IS NULL OR job = ?1 ORDER BY id DESC LIMIT ?2) o " +
      "LEFT JOIN sends s ON s.message = o.id ORDER BY o.id DESC, s.sender", jobID ?? null, limit)
    const out = new Map<number, SentMessage>()
    for (const r of rows) {
      const m = out.get(r.id as number) ?? { ...message(r), sends: [] }
      if (r.sender !== null) m.sends.push({ sender: r.sender as string, status: r.status as SendStatus, ...(r.error !== null ? { error: r.error as string } : {}) })
      out.set(m.id, m)
    }
    return [...out.values()]
  }

  // ---------- leader lease ----------

  /**
   * Take or renew the leader lease; true if this store holds it. Renewed only once half of it is used, so a
   * tick doesn't write (and wake the TUI) every time.
   */
  lease(ttl: number, now = Date.now()): boolean {
    const r = this.get<{ holder: string; until: number }>("SELECT holder, until FROM lease WHERE name = 'leader'")
    if (r?.holder === this.holder && r.until - now > ttl / 2) return true
    return this.tx(() => {
      this.run(
        "INSERT INTO lease (name, holder, until) VALUES ('leader', ?, ?) " +
        "ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, until = excluded.until WHERE lease.holder = excluded.holder OR lease.until < ?",
        this.holder, now + ttl, now)
      return this.get<{ holder: string }>("SELECT holder FROM lease WHERE name = 'leader'")!.holder === this.holder
    })
  }

  release(): void {
    try { this.run("DELETE FROM lease WHERE name = 'leader' AND holder = ?", this.holder) } catch {}
  }
}

function message(r: Row): OutboxMessage {
  return {
    id: r.id as number,
    at: r.at as number,
    ...(r.job !== null ? { job: r.job as string } : {}),
    ...(r.run !== null ? { run: r.run as string } : {}),
    title: r.title as string,
    body: r.body as string,
    priority: r.priority as Priority,
    ...(r.url !== null ? { url: r.url as string } : {}),
    ...(r.url_title !== null ? { urlTitle: r.url_title as string } : {}),
  }
}
