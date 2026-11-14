// Structured logs (pino), one JSON object per line.
//
// Written to stderr, never stdout: the plugin runs inside opencode, whose stdout may be a terminal UI or
// a protocol stream. Synchronous, so a line logged right before the process exits isn't lost.
// AUTOMATIONS_LOG_LEVEL sets the level (default "info"; "silent" turns logging off).

import pino from "pino"

export const log = pino(
  {
    name: "automations",
    level: process.env.AUTOMATIONS_LOG_LEVEL ?? "info",
    // The level by name ("warn"), not pino's default number (40).
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination({ fd: 2, sync: true }),
)
