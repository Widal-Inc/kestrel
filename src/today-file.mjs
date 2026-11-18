// Today's numbers of all agents on this computer, in one small file: ~/.widal/today.json.
//
// Working them out means reading the logs, which takes too long for the status line. So the
// command "widal refresh-today" works them out and writes this file, and the status line and
// "widal top" only read it. The status line starts that command in the background when the
// file is missing or older than REFRESH_EVERY, and never waits for it.
//
// The file holds numbers, session ids, ticket names, project folder names and the keys of
// accounts (see accounts.mjs). Never text from a session.
//
// Its shape:
// {
//   day: "2026-11-14",          the local day the numbers are for
//   at: 1794671775000,          when they were worked out, in milliseconds
//   tokens: 41000000,           all tokens of all model calls today: input, cache writes, cache reads, output
//   cacheRead: 39400000,        of those, the tokens read from the cache
//   coldStarts: 3,              calls that wrote a large context to the cache again after it had ended
//   coldTokens: 1400000,        the tokens those calls wrote again
//   sessions: { "<session id>": { tokens: 18200000, source: "claude" | "codex" | "cowork", project: "my-app", ticket: "ABC-322" } },
//   tickets: { "ABC-322": { tokens: 18200000, sessions: 2 } },
//   accounts: { "claude:<account id>": { tokens: 30000000, cacheRead: 29000000 } }   the tokens of each account today
// }
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson } from './config.mjs'
import { home } from './paths.mjs'

/** How old the file may get before the status line starts a new "widal refresh-today". */
export const REFRESH_EVERY = 5 * 60e3

export const todayFile = () => join(home(), 'today.json')

/** The local day of a time, as "YYYY-MM-DD". */
export function localDay(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Today's numbers, or undefined when the file is missing, cannot be read, or is for another day.
 * `now` is in milliseconds.
 */
export function readToday(now = Date.now()) {
  const t = readJson(todayFile(), undefined)
  if (!t || typeof t !== 'object' || t.day !== localDay(now) || !Number.isFinite(t.at)) return undefined
  return t
}

/** Whether the numbers are missing or older than REFRESH_EVERY, so that a refresh is due. */
export const todayDue = (now = Date.now()) => {
  const t = readToday(now)
  return !t || now - t.at >= REFRESH_EVERY
}

/** Writes today's numbers. The file is written whole and swapped in, so a reader never sees half of it. */
export function writeToday(value) {
  mkdirSync(home(), { recursive: true })
  writeJson(todayFile(), value)
}
