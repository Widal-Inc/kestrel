// "widal refresh-today": works out today's numbers of all agents on this computer, from the logs
// of Claude Code, Codex and Cowork, and writes them to ~/.widal/today.json. The status line and
// "widal top" only read that file: see today-file.mjs for its shape.
//
// The status line starts this command in the background, at most every 5 minutes. So it prints
// nothing. It reads the logs through the store's cache, as the reports do, so a run after the
// first one parses only the logs that changed.
//
// Only numbers, session ids, ticket names and project folder names go into the file. The ticket
// comes from the git branch that a log names, never from text of a session.
//
// It also brings accounts.json up to date (see accounts.mjs): when each account was last seen, and
// the name of the account signed in now, from Claude Code's file .claude.json. The status line
// never reads that file, because it can be large.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { updateAccounts } from './accounts.mjs'
import { analyze } from './analyze.mjs'
import { project } from './format.mjs'
import { home } from './paths.mjs'
import { load } from './store.mjs'
import { ticketOf } from './ticket.mjs'
import { localDay, writeToday } from './today-file.mjs'

// A call counts as a cold start when it wrote this many tokens or more to the cache again, after
// the cache had ended.
export const COLD_FROM = 100_000
// The causes of a lost cache, as analyze.mjs names them, that mean that the cache had ended. The
// other causes (a change of model, a changed start of the prompt) lose a cache that was still there.
const ENDED = new Set(['idle for over 1 hour', 'idle for over 5 minutes'])
// A session's first call of the day is compared with its call before. That call is looked for in
// the last 7 days of the same log, which covers a weekend.
const LOOK_BACK = 7 * 86400e3
// A lock older than this belongs to a run that has died. It is taken over.
const LOCK_STALE = 10 * 60e3

const lockFile = () => join(home(), 'today.lock')

/** The start of the local day of a time, in milliseconds. */
export function dayStart(now) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** All tokens of a call: input, cache writes, cache reads and output. */
const tokensOf = (r) => r.in + r.w5 + r.w1 + r.cr + r.out

/**
 * Today's numbers, from the model calls that `load()` gives. `records` may start before today:
 * the calls before today only show whether the cache had ended before a call of today.
 */
export function todayNumbers(records, now) {
  const from = dayStart(now)
  const calls = analyze(records).calls.filter((e) => e.r.ts >= from)
  const value = { day: localDay(now), at: now, tokens: 0, cacheRead: 0, coldStarts: 0, coldTokens: 0, sessions: {}, tickets: {}, accounts: {} }
  // Session ids come from logs. They are kept in Maps, so that an id such as "__proto__" is a key
  // like any other, and turned into objects with own keys only at the end.
  const sessions = new Map()
  const tickets = new Map()
  const accounts = new Map()
  for (const e of calls) {
    const r = e.r
    const tokens = tokensOf(r)
    value.tokens += tokens
    value.cacheRead += r.cr
    // What the call had to write again: the carried context that was not read from the cache.
    const again = e.carried - Math.min(r.cr, e.carried)
    if (ENDED.has(e.miss) && again >= COLD_FROM) {
      value.coldStarts++
      value.coldTokens += again
    }
    // The tokens of each account, for the status line: it names the account of its session when
    // more than one account was used.
    const key = typeof r.acct === 'string' ? r.acct : 'unknown'
    const a = accounts.get(key) ?? { tokens: 0, cacheRead: 0 }
    a.tokens += tokens
    a.cacheRead += r.cr
    accounts.set(key, a)
    const s = sessions.get(r.ses) ?? { tokens: 0, source: r.s, project: undefined, ticket: undefined }
    s.tokens += tokens
    // The calls are in the order of time: the newest folder and the newest branch count.
    if (typeof r.cwd === 'string' && r.cwd) s.project = project(r.cwd)
    if (typeof r.br === 'string' && r.br) s.ticket = ticketOf(r.br)
    sessions.set(r.ses, s)
    // A call counts to the ticket of the branch it names. So a session that changed its branch
    // during the day counts to both tickets.
    const ticket = ticketOf(r.br)
    if (ticket) {
      const t = tickets.get(ticket) ?? { tokens: 0, sessions: new Set() }
      t.tokens += tokens
      t.sessions.add(r.ses)
      tickets.set(ticket, t)
    }
  }
  value.sessions = Object.fromEntries([...sessions].map(([id, s]) => [id, Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined))]))
  value.tickets = Object.fromEntries([...tickets].map(([ticket, t]) => [ticket, { tokens: t.tokens, sessions: t.sessions.size }]))
  value.accounts = Object.fromEntries(accounts)
  return value
}

/**
 * Takes the lock, which holds the time it was taken. Returns a function that gives it back, or
 * undefined when another run holds it. A lock older than 10 minutes, or one that holds no time,
 * belongs to a run that has died, and is taken over. Two runs that take over the same old lock at
 * the same moment can both run: each then writes the whole file, so nothing breaks.
 */
function takeLock(now) {
  // On a computer without Claude Code's status line, this can be the first file of the tool.
  mkdirSync(home(), { recursive: true })
  const file = lockFile()
  const mine = String(now)
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(file, mine, { flag: 'wx' })
      // A run that is ended with process.exit() gives the lock back too.
      const release = () => {
        process.off('exit', release)
        try {
          // A lock that another run took over after 10 minutes is that run's now.
          if (readFileSync(file, 'utf8') === mine) unlinkSync(file)
        } catch {
          // Already gone.
        }
      }
      process.on('exit', release)
      return release
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
    let at
    try {
      at = Number(readFileSync(file, 'utf8'))
    } catch {
      // Gone since: try again.
      continue
    }
    if (Number.isFinite(at) && now - at < LOCK_STALE) return undefined
    try {
      unlinkSync(file)
    } catch {
      // Another run took it over first.
    }
  }
  return undefined
}

/**
 * Works out today's numbers and writes today.json. Returns true when it wrote the file, and false
 * when another run was at work. It throws on an error, and then the file stays as it was: the
 * command catches that, prints nothing and ends with exit code 0.
 */
export async function refreshToday({ now = Date.now() } = {}) {
  const release = takeLock(now)
  if (!release) return false
  try {
    const from = dayStart(now)
    const { records, metas } = await load({ since: from, callsFrom: from - LOOK_BACK })
    writeToday(todayNumbers(records, now))
    updateAccounts({ records, metas, signedIn: true })
    return true
  } finally {
    release()
  }
}
