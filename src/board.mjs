// The Kestrel board: linking this computer to a team's board, and sending what Kestrel records.
//
// The board is a web app for a team (its own repository, kestrel-board). "kestrel board login
// <address>" links this computer with a device code, as "gh auth login" does: Kestrel prints an
// address and a code, the person approves the code on the board, and the board gives a machine
// token. From then on Kestrel sends what it records, on its own, with no further question: the
// model calls with their tokens and cost, the sessions, the commits made during a session, the
// security findings, the plan's limits, the accounts, the settings and the proposals. It never
// sends the text of a prompt, an answer, a tool result or a file. Kestrel never keeps that text.
//
// The token is the one secret Kestrel keeps. It is in ~/.kestrel/board.json with mode 600, and it
// is never printed in full.
//
// When Kestrel sends:
//   - right after the link, and on "kestrel board sync";
//   - in the background. The status line, and the hooks at the start of a session and at the end
//     of a turn, start "kestrel board sync --quiet" when the last sync is 10 minutes old or more.
//     They read two small files and never wait: the status line itself never uses the network.
//     A lock file keeps two syncs from running at once.
//
// The format follows the board's design (docs/design.md in kestrel-board, "Linking a machine" and
// "What Kestrel sends"). The board runs on Vercel, which refuses a body over 4.5 MB. So a request
// holds at most 2000 calls, and a body that is still over 3.5 MB once packed is split in half until
// it fits.
//
// This file loads the heavy parts (the logs, the proposals, the settings) only when it sends, so
// that the status line, which loads it for the background start, stays fast.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { version } from './app.mjs'
import { readJson, writeJson } from './config.mjs'
import { count, plain, table, when } from './format.mjs'
import { repoOf } from './git.mjs'
import { home, realPath } from './paths.mjs'
import { cost } from './prices.mjs'
import { ticketOf } from './ticket.mjs'

/** The board's address in the examples. */
export const EXAMPLE = 'https://kestrel.widal.com'

const MIN = 60e3
const DAY = 86400e3
// A background sync starts when the last one is this old, and at most once in this time.
export const SYNC_EVERY = 10 * MIN
// A lock older than this is left over from a sync that ended without taking it away.
export const LOCK_STALE = 10 * MIN
// The first sync sends this many days. Later ones send from one hour before the last sync, to catch
// a call that reached its log a little late. The board keeps calls by their id, so a call sent
// twice changes nothing. One hour, not more: each call sent again still costs the board a lookup.
const FIRST_DAYS = 30
const OVERLAP = 60 * MIN
// The proposals replay 30 days of calls. That can be slow, so they are sent at most this often.
const PROPOSALS_EVERY = 6 * 3600e3
// What one request may hold. Vercel refuses a body over 4.5 MB.
export const MAX_CALLS = 2000
export const MAX_BODY = 3_500_000
const MAX_SESSIONS = 5000
const MAX_COMMITS = 20000
const MAX_FINDINGS = 5000
// The time limits: one request to the board, and one run of git.
const REQUEST_MS = 60e3
const GIT_MS = 10e3
// A commit belongs to a session whose calls ran from before it to at most this long before it.
const COMMIT_SLACK = 5 * MIN
// A machine token, as the board makes it.
const TOKEN = /^kbm_[A-Za-z0-9_-]{20,200}$/
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]'])

// The command's file, started in the background.
const COMMAND = fileURLToPath(new URL('../cli/kestrel.mjs', import.meta.url))

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
/** A time in milliseconds that the board takes: from 2020 to 2100. */
const isTime = (v) => Number.isInteger(v) && v >= 1577836800000 && v <= 4102444800000
/** Text from a file or from the board, without control characters, cut to `max`. Null when there is none. */
const text = (v, max = 200) => (typeof v === 'string' && v ? plain(v).slice(0, max) : null)
/** A whole number of 0 or more. */
const whole = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0)
/** An id that fits the board's 200 characters: as it is, or a hash of it when it is longer. */
const idText = (v) => (v.length <= 200 ? v : `h:${createHash('sha256').update(v).digest('hex')}`)

// ---------------------------------------------------------------------------------------------
// The file board.json, the lock and the mark of the last background start.

export const boardFile = () => join(home(), 'board.json')
const lockFile = () => join(home(), 'board.lock')
const startFile = () => join(home(), 'board.start')

/** What board.json holds, or undefined when the computer is not linked or the file is broken. */
export function readBoard() {
  const b = readJson(boardFile())
  if (!isObject(b) || typeof b.url !== 'string' || !/^https?:\/\//.test(b.url) || typeof b.token !== 'string' || !TOKEN.test(b.token)) return undefined
  return b
}

/** Writes board.json with mode 600: only the person can read it. Through a temp file, so no reader sees half a file. */
function writeBoard(b) {
  mkdirSync(home(), { recursive: true })
  const file = boardFile()
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(b, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

/**
 * Sets fields of board.json, but only while it still holds the same token. A sync that ends after
 * "kestrel board logout" or a new link must not bring the old link back. A field set to undefined
 * is taken out.
 */
function updateBoard(token, fields) {
  const b = readBoard()
  if (!b || b.token !== token) return false
  writeBoard(JSON.parse(JSON.stringify({ ...b, ...fields })))
  return true
}

/** The token as it may be shown: its start and its last 4 characters. */
export const shortToken = (token) => (typeof token === 'string' && token.length > 8 ? `kbm_…${token.slice(-4)}` : 'kbm_…')

/** Whether a time from a file says "less than `ms` ago". A time that lies ahead comes from a wrong clock and does not count. */
const within = (at, now, ms) => Number.isFinite(at) && at <= now && now - at < ms

/** Whether the lock is held by a sync that runs now: there, and not older than 10 minutes. */
function lockHeld(now) {
  const held = readJson(lockFile())
  if (held === undefined) {
    // A lock that is there but cannot be read (a sync wrote it in this very moment) counts by its file time.
    const st = statSync(lockFile(), { throwIfNoEntry: false })
    return !!st && within(st.mtimeMs, now, LOCK_STALE)
  }
  return within(held?.at, now, LOCK_STALE)
}

/** Takes the lock for this process. False when another sync holds it. A stale lock is taken over. */
function takeLock(now) {
  mkdirSync(home(), { recursive: true })
  for (let tries = 0; tries < 2; tries++) {
    try {
      const fd = openSync(lockFile(), 'wx')
      writeSync(fd, JSON.stringify({ pid: process.pid, at: now }))
      closeSync(fd)
      return true
    } catch (e) {
      if (e?.code !== 'EEXIST' || lockHeld(now)) return false
      try {
        unlinkSync(lockFile())
      } catch {
        // Another sync took it away first.
      }
    }
  }
  return false
}

/** Keeps the lock fresh during a long sync, so that it does not look stale. */
function touchLock() {
  try {
    if (readJson(lockFile())?.pid === process.pid) writeJson(lockFile(), { pid: process.pid, at: Date.now() })
  } catch {
    // The lock stays as it is.
  }
}

/** Takes the lock away, if this process holds it. */
function dropLock() {
  try {
    if (readJson(lockFile())?.pid === process.pid) unlinkSync(lockFile())
  } catch {
    // Nothing to take away.
  }
}

/**
 * Whether a background sync is due: the computer is linked, background sync was not stopped (the
 * board refused the token), the last sync is 10 minutes old or more, no background start was made
 * in the last 10 minutes, and no sync runs now.
 */
export function syncDue(now = Date.now(), board = readBoard()) {
  if (!board || board.stopped) return false
  if (within(board.lastSyncAt, now, SYNC_EVERY)) return false
  if (within(readJson(startFile()), now, SYNC_EVERY)) return false
  return !lockHeld(now)
}

/**
 * Starts "kestrel board sync --quiet" in the background when a sync is due, the same way the
 * status line starts "kestrel refresh-today". The time of the start is saved first, so that a sync
 * that fails (no network) is not started again on every run. It reads small files only, never
 * waits and never throws. `spawner` stands in for `spawn` in a test. Returns whether it started one.
 */
export function startBoardSync(now = Date.now(), spawner = spawn) {
  try {
    if (!syncDue(now)) return false
    writeJson(startFile(), now)
    spawner(process.execPath, [COMMAND, 'board', 'sync', '--quiet'], { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------------------------
// Talking to the board.

/** A refusal or a failure of the board, with the HTTP status when there was an answer. */
class BoardError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

/**
 * The board's address from what the person typed: https:// is added when no scheme is given, and a
 * slash at the end is taken away. Plain http:// is refused, except for a board on this computer
 * (localhost, 127.0.0.1), because the token would cross the network unprotected.
 */
export function boardAddress(given) {
  if (typeof given !== 'string' || !given.trim()) throw new Error(`Give the board's address, for example: kestrel board login ${EXAMPLE}`)
  const typed = given.trim()
  let u
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`)
  } catch {
    throw new Error(`"${plain(typed)}" is not a web address. For example: kestrel board login ${EXAMPLE}`)
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`The board's address starts with https://. For example: kestrel board login ${EXAMPLE}`)
  if (u.username || u.password) throw new Error('The address must not hold a name or a password.')
  if (u.protocol === 'http:' && !LOCAL.has(u.hostname)) throw new Error(`The board must use https://, so that the token cannot be read on the way. Plain http:// is allowed only for a test board on this computer (localhost or 127.0.0.1).`)
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
}

/**
 * One request to the board. Gives `{ status, json, location }`. A failure of the network, or no
 * answer within the time limit, throws a BoardError without a status. Redirects are not followed:
 * the token must go to the address the person linked, and nowhere else.
 */
async function request(url, path, { method = 'GET', token, body, gzipped = false, timeout = REQUEST_MS } = {}) {
  const headers = { accept: 'application/json', 'user-agent': `kestrel/${version() ?? 'unknown'}` }
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (gzipped) headers['content-encoding'] = 'gzip'
  let res
  try {
    res = await fetch(`${url}${path}`, { method, headers, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(timeout) })
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? `no answer within ${Math.round(timeout / 1000)} seconds` : plain(e?.cause?.code ?? e?.cause?.message ?? e?.message ?? 'no connection')
    throw new BoardError(`Could not reach the board at ${url} (${why}).`)
  }
  let json
  try {
    json = await res.json()
  } catch {
    json = undefined
  }
  return { status: res.status, json, location: res.headers.get('location') }
}

/** The error for an answer that is not 200, in plain words. */
function refusal(r, url) {
  const said = text(r.json?.error, 300)
  if (r.status === 401 || r.status === 403) {
    return new BoardError(`The board does not take this computer's token any more: the computer was removed on the board, or the link is no longer valid. Background sync is off now. Link it again with: kestrel board login ${url}`, r.status)
  }
  if (r.status >= 300 && r.status < 400) return new BoardError(`The board answered with a move to ${text(r.location, 300) ?? 'another address'}. Link again with the right address: kestrel board login <address>`, r.status)
  if (r.status === 413) return new BoardError('The board refused a request as too big. Nothing was saved. The next sync tries again.', r.status)
  if (r.status === 429) return new BoardError('The board asks Kestrel to wait: too many requests. Nothing was saved. The next sync tries again.', r.status)
  if (r.status === 400) return new BoardError(`The board refused the data${said ? `: ${said}` : ''}. That is a fault in Kestrel. Nothing was saved.`, r.status)
  return new BoardError(`The board answered ${r.status}${said ? `: ${said}` : ''}. Nothing was saved. The next sync tries again.`, r.status)
}

/** The name of this computer, as the board shows it on its Machines page. */
function computerName() {
  return text(hostname().replace(/\.local$/, ''), 80) ?? 'A computer'
}

/** Opens a page in the browser: `open` on macOS, `xdg-open` on Linux. Nothing on another system, or when it fails. */
function openBrowser(url) {
  if (process.env.KESTREL_NO_BROWSER) return false
  const program = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined
  if (!program) return false
  try {
    const child = spawn(program, [url], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/** An address that the board gave, when it is on the board's own site. Undefined for any other. */
function onBoard(given, url) {
  try {
    const u = new URL(given)
    return u.origin === new URL(url).origin ? u.href : undefined
  } catch {
    return undefined
  }
}

/** A number of seconds from the board, kept between `min` and `max`. */
const seconds = (v, fallback, min, max) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : fallback))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * "kestrel board login <address>": links this computer to a board with a device code, saves
 * board.json, and runs the first sync. `out` prints a line, `open` opens a page in the browser,
 * `sleep` waits; tests stand in for them. Returns the result of the first sync, or undefined when
 * it did not work.
 */
export async function login(given, { out = console.log, open = openBrowser, sleep = wait, name = computerName() } = {}) {
  const url = boardAddress(given)
  const start = await request(url, '/api/v1/device/start', { method: 'POST', body: { name, os: process.platform } })
  const code = text(start.json?.user_code, 20)
  if (start.status !== 200 || typeof start.json?.device_code !== 'string' || !code) {
    throw new BoardError(`The board at ${url} did not start a link (answer ${start.status}). Check the address.`, start.status)
  }
  const page = onBoard(start.json.verification_uri, url) ?? `${url}/device`
  out(`To link this computer to the board, open ${page} and enter the code ${code}.`)
  out('Kestrel opens that page in your browser now, and waits until you approve or deny the link there (Ctrl-C stops).')
  open(onBoard(start.json.verification_uri_complete, url) ?? page)
  let interval = seconds(start.json.interval, 5, 1, 60)
  const until = Date.now() + seconds(start.json.expires_in, 900, 60, 3600) * 1000
  let answer
  while (!answer) {
    if (Date.now() > until) throw new BoardError('The code has expired. Nothing was saved. Run "kestrel board login" again for a new one.')
    await sleep(interval * 1000)
    let r
    try {
      r = await request(url, '/api/v1/device/poll', { method: 'POST', body: { device_code: start.json.device_code } })
    } catch {
      continue // The network came and went: ask again at the next turn.
    }
    const error = r.json?.error
    if (r.status === 200 && typeof r.json?.token === 'string' && TOKEN.test(r.json.token)) answer = r.json
    else if (error === 'authorization_pending') continue
    else if (error === 'slow_down') interval = Number.isFinite(r.json.interval) && r.json.interval > interval ? seconds(r.json.interval, interval + 5, 1, 60) : Math.min(60, interval + 5)
    else if (error === 'access_denied') throw new BoardError('The link was denied on the board. Nothing was saved.', r.status)
    else if (error === 'expired_token') throw new BoardError('The code has expired or was used. Nothing was saved. Run "kestrel board login" again for a new one.', r.status)
    else if (r.status === 429 || r.status >= 500) continue
    else throw new BoardError(`The board gave an answer Kestrel does not know (${r.status}). Nothing was saved.`, r.status)
  }
  const old = readBoard()
  const board = {
    url,
    token: answer.token,
    machine: { id: Number.isInteger(answer.machine?.id) ? answer.machine.id : null, name: text(answer.machine?.name, 80) ?? name },
    team: text(answer.team?.login, 100),
    user: text(answer.user?.login, 100),
    linkedAt: Date.now(),
  }
  writeBoard(board)
  try {
    unlinkSync(startFile())
  } catch {
    // No mark of an earlier link.
  }
  out(`Linked this computer (${board.machine.name}) to the team ${board.team ?? '(unknown)'} on ${url}, for ${board.user ?? '(unknown)'}.`)
  // The old link's token is of no more use. The board is told, so that it stops taking it.
  if (old && old.token !== board.token) {
    const told = await request(old.url, '/api/v1/logout', { method: 'POST', token: old.token, timeout: 10e3 }).then((r) => r.status === 200, () => false)
    out(told ? `The earlier link to ${old.url} is removed there.` : `The earlier link to ${old.url} is replaced. Remove that computer there with Revoke, if it is still listed.`)
  }
  out(`From now on Kestrel sends what it records to the board, on its own, about every 10 minutes while you work: the model calls with their tokens and cost, the sessions, the commits, the security findings, the plan's limits, the accounts, the settings and the proposals. It never sends the text of prompts, answers, tool results or files. Stop it with: kestrel board logout`)
  out('The first sync runs now.')
  try {
    const result = await sync()
    out(sentText(result, url))
    return result
  } catch (e) {
    out(`The first sync did not work: ${e.message}`)
    if (!(e.status === 401 || e.status === 403)) out('Kestrel tries again in the background, or run: kestrel board sync')
    return undefined
  }
}

/** One sentence that says what a sync sent. */
export function sentText(r, url) {
  if (r.busy) return 'Another sync runs now. Nothing more was sent.'
  const lists = [`${count(r.calls)} model ${r.calls === 1 ? 'call' : 'calls'}`, `${count(r.sessions)} ${r.sessions === 1 ? 'session' : 'sessions'}`, `${count(r.commits)} ${r.commits === 1 ? 'commit' : 'commits'}`, `${count(r.findings)} ${r.findings === 1 ? 'finding' : 'findings'}`]
  const parts = ["the plan's limits", `${count(r.accounts)} ${r.accounts === 1 ? 'account' : 'accounts'}`, 'the settings', ...(r.proposals ? ['the proposals'] : [])]
  return `Sent to ${url}: ${lists.join(', ')}, with ${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}, in ${r.requests} ${r.requests === 1 ? 'request' : 'requests'}.`
}

// ---------------------------------------------------------------------------------------------
// What is sent.

/** The home folder, as given and through its links, so that both forms are replaced by "~". */
function homes() {
  const h = homedir()
  return [...new Set([h, realPath(h)])].filter((x) => typeof x === 'string' && x.length > 1)
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A folder with "~" for the home folder, so that the computer's user name is not sent. A folder
 * in another person's home folder on this computer gets "~other" for that part.
 */
export function folderOf(path, hs = homes()) {
  if (typeof path !== 'string' || !path) return null
  for (const h of hs) {
    if (path === h) return '~'
    if (path.startsWith(`${h}/`)) return `~${path.slice(h.length)}`.slice(0, 1000)
  }
  return path.replace(/^\/(Users|home)\/[^/]+/, '~other').slice(0, 1000)
}

/** Every text in a value with "~" for the home folder: for findings, settings and proposals, which can name a folder. */
function tildeAll(value, hs = homes()) {
  // The longer form first (/private/var/... before /var/...), and only where a folder name starts and ends.
  const patterns = [...hs].sort((a, b) => b.length - a.length).map((h) => new RegExp(`(?<![A-Za-z0-9._~-])${escape(h)}(?=$|[/\\s:"',;)\\]])`, 'g'))
  const walk = (v) => {
    if (typeof v === 'string') return patterns.reduce((s, p) => s.replace(p, '~'), v)
    if (Array.isArray(v)) return v.map(walk)
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value)
}

/** What git needs to run without a question to the person. */
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' })
const git = (root, args) => execFileSync('git', ['-C', root, '--no-pager', ...args], { encoding: 'utf8', timeout: GIT_MS, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv() })

/**
 * `owner/name` of a remote's address on GitHub, or null. It takes the forms
 * https://github.com/owner/name.git, git@github.com:owner/name.git and ssh://git@github.com/owner/name,
 * and a host alias of ssh such as github-work. A name or a token in the address is never kept.
 */
export function githubName(address) {
  if (typeof address !== 'string') return null
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec(address.trim())
  if (!m) return null
  const host = m[1].toLowerCase()
  if (!(host === 'github.com' || host.endsWith('.github.com') || /^github(\.com)?-[a-z0-9_-]+$/.test(host))) return null
  const name = m[2].split('/').filter(Boolean)
  if (name.length !== 2) return null
  const full = `${name[0]}/${name[1]}`
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(full) ? full : null
}

/** What git says about each repository, read once per sync: its root, its GitHub name, and the person's email for commits. */
function repoReader() {
  const roots = new Map() // folder -> root
  const names = new Map() // root -> owner/name or null
  const emails = new Map() // root -> email or null
  const rootOf = (folder) => {
    if (!roots.has(folder)) roots.set(folder, repoOf(folder) ?? null)
    return roots.get(folder)
  }
  const nameOf = (root) => {
    if (!root) return null
    if (!names.has(root)) {
      let name = null
      try {
        name = githubName(git(root, ['config', '--get', 'remote.origin.url']).trim())
      } catch {
        // No remote origin.
      }
      names.set(root, name)
    }
    return names.get(root)
  }
  // The email is read only to tell the person's own commits from the commits of others that came
  // with a pull. It is never sent or kept.
  const emailOf = (root) => {
    if (!emails.has(root)) {
      let email = null
      try {
        email = git(root, ['config', '--get', 'user.email']).trim().toLowerCase() || null
      } catch {
        // No email set.
      }
      emails.set(root, email)
    }
    return emails.get(root)
  }
  return { rootOf, nameOf, emailOf }
}

/** The session of a call. A subagent's log is a session of its own, named after its parent session. */
const sessionOf = (r) => idText(r.agent ? `${r.ses}:${r.agent}` : r.ses)

/** One call as the board takes it. Undefined for a call the board could not take. */
function callOf(r, where) {
  if (typeof r?.id !== 'string' || !r.id || typeof r.ses !== 'string' || !r.ses || !isTime(r.ts) || !['claude', 'codex', 'cowork'].includes(r.s)) return undefined
  let added = Array.isArray(r.add) ? r.add.filter((a) => Array.isArray(a) && typeof a[0] === 'string').map(([what, size]) => [what.slice(0, 200), whole(size)]) : []
  // The board takes 500 entries. More are added up by what they are.
  if (added.length > 500) {
    const sums = new Map()
    for (const [what, size] of added) sums.set(what, (sums.get(what) ?? 0) + size)
    added = [...sums].slice(0, 500)
  }
  const branch = text(r.br, 250)
  return {
    id: idText(r.id),
    ts: r.ts,
    session: sessionOf(r),
    source: r.s,
    model: text(r.m, 120),
    effort: text(r.ef, 40),
    in: whole(r.in), w5: whole(r.w5), w1: whole(r.w1), cr: whole(r.cr), out: whole(r.out), th: whole(r.th), web: whole(r.web),
    cost: Math.round(cost(r).total * 1e6) / 1e6,
    folder: where.folder,
    repo: where.repo,
    branch,
    ticket: ticketOf(branch ?? undefined) ?? null,
    account: text(r.acct, 120),
    subagent: !!r.agent,
    parent: r.agent ? idText(r.ses) : null,
    tools: (Array.isArray(r.tools) ? r.tools : []).filter((t) => Array.isArray(t) && typeof t[0] === 'string' && typeof t[1] === 'string').slice(0, 200).map(([name, hash]) => [name.slice(0, 200), hash.slice(0, 64)]),
    added,
    err: Math.min(10000, whole(r.err)),
    intr: r.intr ? 1 : 0,
  }
}

/** The state of a live session, in the board's words. */
const STATES = { working: 'working', 'waits for you': 'waiting', idle: 'idle' }
const SOURCES = { Claude: 'claude', Codex: 'codex', Cowork: 'cowork' }

/**
 * The tasks and agents of an open Claude Code session, from the end of its log, as the status line
 * reads them. Only while names are on: they are text of the session.
 */
function tasksAndAgents(look) {
  const seen = look()
  const tasks = (Array.isArray(seen.tasks) ? seen.tasks : []).slice(0, 200).map((t) => ({ name: text(t?.name, 200), done: t?.status === 'completed' }))
  const agents = (Array.isArray(seen.agents) ? seen.agents : []).slice(0, 100).map((a) => ({ kind: text(a?.type, 120), what: text(a?.description, 300), startedAt: isTime(a?.at) ? a.at : null }))
  return { tasks, agents }
}

/** The commits made during the sessions, from local git. Each goes to the session whose calls cover its time best. */
function commitsOf(calls, records, from, repos, now) {
  // The main sessions of each GitHub repository, with the times of their calls. A commit made while
  // a subagent worked goes to its main session: the board finds the subagents by their parent.
  const byRepo = new Map() // owner/name -> { roots, sessions: Map(main session -> times) }
  records.forEach((r, i) => {
    const c = calls[i]
    if (!c?.repo) return
    const root = repos.rootOf(r.cwd)
    if (!root) return
    const entry = byRepo.get(c.repo) ?? { roots: new Set(), sessions: new Map() }
    byRepo.set(c.repo, entry)
    entry.roots.add(root)
    const main = c.parent ?? c.session
    const times = entry.sessions.get(main) ?? []
    times.push(c.ts)
    entry.sessions.set(main, times)
  })
  const out = []
  for (const [repo, { roots, sessions }] of byRepo) {
    const found = new Map() // sha -> time
    for (const root of roots) {
      const email = repos.emailOf(root)
      let lines = ''
      try {
        lines = git(root, ['log', '--all', `--since=${new Date(from).toISOString()}`, '--format=%H %ct %ce'])
      } catch {
        continue // No commits yet, or git took too long.
      }
      for (const line of lines.split('\n')) {
        const [sha, sec, by] = line.trim().split(' ')
        if (!/^[0-9a-f]{7,64}$/.test(sha ?? '') || !/^\d+$/.test(sec ?? '')) continue
        // A commit of another person that came with a pull is not work of this computer.
        if (email && (by ?? '').toLowerCase() !== email) continue
        const ts = Number(sec) * 1000
        if (isTime(ts) && ts >= from && ts <= now + COMMIT_SLACK) found.set(sha, ts)
      }
    }
    for (const [sha, ts] of found) {
      let best
      let gap = Infinity
      for (const [session, times] of sessions) {
        if (ts < times[0] || ts > times.at(-1) + COMMIT_SLACK) continue
        // The call nearest before the commit: the session that was at work then.
        const before = times.filter((t) => t <= ts).at(-1) ?? times[0]
        if (Math.abs(ts - before) < gap) {
          gap = Math.abs(ts - before)
          best = session
        }
      }
      if (best) out.push({ repo, sha, ts, session: best })
    }
  }
  return out.sort((a, b) => a.ts - b.ts)
}

/** One finding as the board takes it: the fields of its design, each cut to the board's size. */
function findingOf(f) {
  const where = isObject(f.where) ? Object.fromEntries(Object.entries(f.where).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 400) : v])) : null
  let controls = Array.isArray(f.controls) ? f.controls.slice(0, 200) : []
  while (controls.length && JSON.stringify(controls).length > 20000) controls = controls.slice(0, Math.floor(controls.length / 2))
  const fix = f.fix && JSON.stringify(f.fix).length <= 5000 ? f.fix : null
  return {
    id: idText(f.id).slice(0, 500), rule: text(f.rule, 200), kind: f.kind, severity: f.severity,
    title: text(f.title, 1000), detail: text(f.detail, 5000), where, controls, fix,
    status: text(f.status, 20), firstSeen: isTime(f.firstSeen) ? f.firstSeen : null, lastSeen: isTime(f.lastSeen) ? f.lastSeen : null,
    scope: text(f.scope, 500), source: text(f.source, 60) ?? 'kestrel',
  }
}

/**
 * Everything one sync sends, as the parts of the board's format. `board` is what board.json holds,
 * `days` the days to send when given. The calls are those since the last sync minus one hour, or of
 * the last 30 days at the first sync.
 */
export async function buildPayload(board, { days, now = Date.now() } = {}) {
  const [{ load }, { namesOn, sessionsNow }, { logLook }, { readFindings, findingsFile }, { storedLimits, isKey }, { readAccounts, labelOf }, { kindOf, planOf, planPrice }, { settingsData, accountsNow }, { adviseData }, { applied }, { config }] = await Promise.all([
    import('./store.mjs'), import('./top.mjs'), import('./hint.mjs'), import('./findings.mjs'), import('./billing.mjs'), import('./accounts.mjs'),
    import('./plans.mjs'), import('./settings.mjs'), import('./advise.mjs'), import('./actions.mjs'), import('./config.mjs'),
  ])
  const from = days ? now - days * DAY : Number.isFinite(board.cursor) && board.cursor <= now ? board.cursor - OVERLAP : now - FIRST_DAYS * DAY
  const proposalsDue = !within(board.proposalsAt, now, PROPOSALS_EVERY)
  const { records: all } = await load({ since: proposalsDue ? Math.min(from, now - 30 * DAY) : from })
  const records = all.filter((r) => r.ts >= from)
  const names = namesOn(config())
  const hs = homes()
  const repos = repoReader()

  // The calls, each with its folder, repository, branch and ticket.
  const calls = records.map((r) => {
    const root = typeof r.cwd === 'string' && r.cwd ? repos.rootOf(r.cwd) : null
    return callOf(r, { folder: folderOf(r.cwd, hs), repo: repos.nameOf(root) })
  })

  // One session per session id seen. The newest call gives its folder and branch.
  const sessions = new Map()
  const mainLog = new Map() // session -> the file of its log, for the tasks of an open session
  records.forEach((r, i) => {
    const c = calls[i]
    if (!c) return
    const s = sessions.get(c.session) ?? { id: c.session, source: c.source, parent: c.parent, kind: r.agent ? text(r.at, 120) : null }
    Object.assign(s, { folder: c.folder, repo: c.repo, branch: c.branch, ticket: c.ticket, state: null })
    sessions.set(c.session, s)
    if (!r.agent && typeof r.f === 'string') mainLog.set(c.session, r.f)
  })
  // The sessions open now, with their state, and their tasks and agents while names are on.
  let live = []
  try {
    live = sessionsNow(now, { names: false })
  } catch {
    // Without the files of the open sessions, no session has a state.
  }
  for (const row of live) {
    if (typeof row.id !== 'string' || !row.id || row.id === 'unknown') continue
    const id = idText(row.id)
    const s = sessions.get(id) ?? { id, source: SOURCES[row.tool] ?? null, folder: null, repo: null, branch: null, ticket: row.ticket ?? null, parent: null, kind: null }
    s.state = STATES[row.state] ?? null
    if (names) {
      const log = mainLog.get(id)
      Object.assign(s, log && row.tool === 'Claude' ? tasksAndAgents(logLook(log)) : { tasks: [], agents: [] })
    }
    sessions.set(id, s)
  }
  const ok = calls.filter(Boolean)

  // The findings: the whole list. It replaces what the board had for this computer.
  const stored = readJson(findingsFile(), {})
  const findings = {
    at: isTime(stored?.at) ? stored.at : now,
    items: tildeAll(readFindings().sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0)).slice(0, MAX_FINDINGS).map(findingOf), hs),
  }

  // The plan's limits and the accounts.
  const limits = Object.fromEntries(storedLimits())
  const state = readAccounts()
  const keys = new Set([...state.accounts.keys(), ...ok.map((c) => c.account).filter(isKey)])
  const hasLimits = (key) => {
    const r = limits[key.startsWith('cowork:') ? `claude:${key.slice(key.indexOf(':') + 1)}` : key]
    return !!(r?.five || r?.week)
  }
  // The price of each account's plan a month: the person's own price ("set"), else the public
  // price of a plan that Kestrel knows ("table"), else null. A Claude account and the Cowork
  // account with the same id run on one plan, so both carry the same price.
  const priceOf = (key) => {
    const p = planPrice(key, state)
    return p ? { monthly: p.monthly, source: p.source } : null
  }
  const accounts = [...keys].sort().map((key) => ({ key, label: text(labelOf(key, state), 100), billing: kindOf(key, state, hasLimits(key)), tier: planOf(key, state), price: priceOf(key) }))

  return {
    from,
    machine: { os: process.platform, kestrel: version() ?? null, names },
    calls: ok,
    sessions: [...sessions.values()],
    commits: commitsOf(calls, records, from, repos, now),
    findings,
    limits,
    accounts,
    settings: tildeAll(settingsData({ accounts: accountsNow() }), hs),
    proposals: proposalsDue ? tildeAll(adviseData(all.filter((r) => r.ts >= now - 30 * DAY), { days: 30, applied: applied() }), hs) : undefined,
  }
}

// ---------------------------------------------------------------------------------------------
// Sending in pieces that the board takes.

const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size))
const packed = (base, parts) => gzipSync(JSON.stringify({ ...base, ...parts }))
/** Two parts in one: lists of the same name are joined. */
const merge = (a, b) => {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = Array.isArray(out[k]) && Array.isArray(v) ? [...out[k], ...v] : v
  return out
}
// The lists that may go in pieces. The findings, the limits, the accounts, the settings and the
// proposals each replace what the board had, so each goes whole.
const LISTS = ['calls', 'sessions', 'commits']

/** The bodies for one set of parts: one, or more when it is over the size and a list can be split in half. */
function fit(base, parts, limits) {
  const body = packed(base, parts)
  if (body.length <= limits.maxBody) return [body]
  const key = LISTS.find((k) => parts[k]?.length > 1)
  if (key) {
    const half = Math.ceil(parts[key].length / 2)
    return [...fit(base, { ...parts, [key]: parts[key].slice(0, half) }, limits), ...fit(base, { [key]: parts[key].slice(half) }, limits)]
  }
  // Several whole parts that are too big together go one by one.
  const names = Object.keys(parts)
  if (names.length > 1) return names.flatMap((k) => fit(base, { [k]: parts[k] }, limits))
  return [body] // One part that cannot be split: the board says whether it takes it.
}

/**
 * The gzipped bodies of a sync. The calls go 2000 at a time. The other parts ride along with the
 * last calls while the body stays under the size, and go in a request of their own when they
 * would push it over.
 */
export function bodies(payload, { maxCalls = MAX_CALLS, maxBody = MAX_BODY } = {}) {
  const base = { v: 1, machine: payload.machine }
  const pieces = [
    ...chunks(payload.calls, maxCalls).map((calls) => ({ calls })),
    ...chunks(payload.sessions, MAX_SESSIONS).map((sessions) => ({ sessions })),
    ...chunks(payload.commits, MAX_COMMITS).map((commits) => ({ commits })),
    ...['findings', 'limits', 'accounts', 'settings', 'proposals'].filter((k) => payload[k] !== undefined).map((k) => ({ [k]: payload[k] })),
  ]
  const limits = { maxBody }
  const out = []
  let current
  for (const piece of pieces) {
    if (!current) {
      current = piece
      continue
    }
    const both = merge(current, piece)
    const fits = (both.calls?.length ?? 0) <= maxCalls && (both.sessions?.length ?? 0) <= MAX_SESSIONS && (both.commits?.length ?? 0) <= MAX_COMMITS && packed(base, both).length <= maxBody
    if (fits) current = both
    else {
      out.push(...fit(base, current, limits))
      current = piece
    }
  }
  out.push(...fit(base, current ?? {}, limits))
  return out
}

/**
 * "kestrel board sync": builds what Kestrel recorded and sends it. The time of the sync, what it
 * sent and the start of the next window are saved only after the board took every request. A
 * failure keeps them: the next sync sends the same again. A refused token (401, 403) turns
 * background sync off. Gives what was sent, or `{ busy: true }` when another sync runs.
 * `maxCalls` and `maxBody` stand in for the sizes in a test.
 */
export async function sync({ days, now = Date.now(), maxCalls, maxBody } = {}) {
  const board = readBoard()
  if (!board) throw new Error(`This computer is not linked to a board. Link it with: kestrel board login ${EXAMPLE}`)
  if (!takeLock(now)) return { busy: true }
  try {
    const payload = await buildPayload(board, { days, now })
    const list = bodies(payload, { maxCalls, maxBody })
    for (const body of list) {
      touchLock()
      const r = await request(board.url, '/api/v1/ingest', { method: 'POST', token: board.token, body, gzipped: true })
      if (r.status !== 200 || r.json?.ok !== true) throw refusal(r, board.url)
    }
    const sent = {
      calls: payload.calls.length, sessions: payload.sessions.length, commits: payload.commits.length, findings: payload.findings.items.length,
      accounts: payload.accounts.length, proposals: payload.proposals !== undefined, requests: list.length,
    }
    updateBoard(board.token, {
      cursor: now, lastSyncAt: Date.now(), lastSent: sent, proposalsAt: payload.proposals !== undefined ? now : board.proposalsAt,
      stopped: undefined, lastTry: undefined,
    })
    return sent
  } catch (e) {
    const refused = e?.status === 401 || e?.status === 403
    updateBoard(board.token, refused ? { stopped: { at: now, status: e.status } } : { lastTry: { at: now, error: plain(e?.message ?? 'failed').slice(0, 300) } })
    throw e
  } finally {
    dropLock()
  }
}

// ---------------------------------------------------------------------------------------------
// "kestrel board status" and "kestrel board logout".

/** "kestrel board status": the link, the last sync, background sync, and what the board says about this computer. */
export async function status() {
  const b = readBoard()
  if (!b) return `This computer is not linked to a Kestrel board. Link it with: kestrel board login ${EXAMPLE}`
  let check
  try {
    const r = await request(b.url, '/api/v1/me', { token: b.token, timeout: 15e3 })
    if (r.status === 200) {
      const seen = isTime(r.json?.machine?.lastSeenAt) ? `, last data at ${when(r.json.machine.lastSeenAt)}` : ''
      check = `the board knows this computer${seen}`
      if (b.stopped) updateBoard(b.token, { stopped: undefined })
      b.stopped = undefined
    } else if (r.status === 401 || r.status === 403) {
      check = `the board removed this computer, or the link is no longer valid. Link it again with: kestrel board login ${b.url}`
      updateBoard(b.token, { stopped: { at: Date.now(), status: r.status } })
      b.stopped = { at: Date.now(), status: r.status }
    } else check = `the board answered ${r.status}`
  } catch (e) {
    check = e.message
  }
  const s = b.lastSent
  const last = isTime(b.lastSyncAt) && isObject(s)
    ? `${when(b.lastSyncAt)}: ${count(s.calls ?? 0)} calls, ${count(s.sessions ?? 0)} sessions, ${count(s.commits ?? 0)} commits, ${count(s.findings ?? 0)} findings, in ${count(s.requests ?? 0)} ${s.requests === 1 ? 'request' : 'requests'}`
    : 'none yet'
  const rows = [
    ['Board', b.url],
    ['Team', b.team ?? '(unknown)'],
    ['User on the board', b.user ?? '(unknown)'],
    ['This computer', `${b.machine?.name ?? '(unknown)'}${Number.isInteger(b.machine?.id) ? ` (machine ${b.machine.id})` : ''}`],
    ['Token', `${shortToken(b.token)}, in ${boardFile()} (only you can read it)`],
    ['Linked', isTime(b.linkedAt) ? when(b.linkedAt) : '(unknown)'],
    ['Last sync', last],
  ]
  if (isObject(b.lastTry) && isTime(b.lastTry.at) && !(b.lastSyncAt > b.lastTry.at)) rows.push(['Last try', `${when(b.lastTry.at)}, failed: ${b.lastTry.error ?? 'no reason given'}`])
  rows.push(['Background sync', b.stopped ? `off: the board refused the token on ${when(b.stopped.at)}. Link again with: kestrel board login ${b.url}` : 'on: the status line and the hooks start a sync when the last one is 10 minutes old or more'])
  rows.push(['Board check', check])
  return [table(rows), '', 'Kestrel sends the model calls, sessions, commits, findings, limits, accounts, settings and proposals. Never the text of prompts, answers, tool results or files.', 'Stop it with: kestrel board logout'].join('\n')
}

/** "kestrel board logout": tells the board, which stops taking the token, and deletes board.json. A board that cannot be reached does not stop it. */
export async function logout() {
  const b = readBoard()
  if (!b) {
    try {
      unlinkSync(boardFile()) // A broken file goes too.
    } catch {
      // There was none.
    }
    return 'This computer is not linked to a board. Nothing to do.'
  }
  let r
  try {
    r = await request(b.url, '/api/v1/logout', { method: 'POST', token: b.token, timeout: 10e3 })
  } catch {
    r = undefined
  }
  for (const file of [boardFile(), startFile()]) {
    try {
      unlinkSync(file)
    } catch {
      // Gone already.
    }
  }
  const after = 'The link on this computer is deleted. Kestrel sends nothing more.'
  if (r?.status === 200) return `The board at ${b.url} removed this computer. ${after}`
  if (r?.status === 401 || r?.status === 403) return `The board at ${b.url} had removed this computer already. ${after}`
  return `${after} The board at ${b.url} could not be told: remove the computer there with Revoke on the Machines page.`
}

const HELP = `kestrel board: send what Kestrel records on this computer to your team's Kestrel board.

  kestrel board login <address>    link this computer, for example: kestrel board login ${EXAMPLE}
  kestrel board status             the board, the team, the last sync, and whether the board still knows this computer
  kestrel board sync [--days N]    send now (it also runs on its own, every 10 minutes while you work)
  kestrel board logout             unlink this computer: Kestrel sends nothing more

Kestrel sends the model calls with their tokens and cost, the sessions, the commits, the security
findings, the plan's limits, the accounts, the settings and the proposals. It never sends the text
of prompts, answers, tool results or files.`

/**
 * The command "kestrel board". `args` are the words after "board". `days` and `quiet` are the
 * options --days and --quiet. With `quiet` a sync prints nothing and never fails: the status line
 * and the hooks start it that way. Returns what to print.
 */
export async function boardCommand(args, { days, quiet = false } = {}) {
  const [word, ...rest] = args
  if (word === undefined || word === 'help') return HELP
  if (word === 'login') {
    if (rest.length !== 1) throw new Error(`Use: kestrel board login <address>, for example: kestrel board login ${EXAMPLE}`)
    await login(rest[0])
    return undefined
  }
  if (rest.length) throw new Error(`"kestrel board ${word}" takes no more words, and "${plain(rest[0])}" was given.`)
  if (word === 'status') return status()
  if (word === 'logout') return logout()
  if (word === 'sync') {
    let n
    if (days !== undefined) {
      n = Number(days)
      if (days === true || !/^\d+$/.test(String(days)) || n < 1 || n > 365) throw new Error('--days is a whole number of days, from 1 to 365.')
    }
    if (quiet) {
      try {
        await sync({ days: n })
      } catch {
        // Nothing: the next start tries again. What failed is in board.json for "kestrel board status".
      }
      return undefined
    }
    const b = readBoard()
    return sentText(await sync({ days: n }), b?.url ?? 'the board')
  }
  throw new Error(`"${plain(word)}" is not one of login, status, sync, logout.\n\n${HELP}`)
}
