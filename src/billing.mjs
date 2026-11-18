// How the person pays for Claude Code, and the plan's limits as last seen on this machine.
//
// On a subscription (Pro, Max, Ultra) the person pays a fixed price and has a limit per 5 hours
// and per week. Without one, every token is billed. The tool has to know which of the two holds,
// because a dollar figure means something else in each case.
//
// Claude Code gives a session the plan's limits only from that session's own last answer. An idle
// session therefore keeps giving an old percent. So every session saves what it was given in one
// shared file, limits.json, and the reading that is kept is the newest one.
//
// A session that has made a model call since its last run gives a reading that is true now. Such
// a run is called fresh. It sets the time of the reading to now, also when the percent is the
// same, so that the reading of a busy session does not look old.
//
// Each account has limits of its own. So the file keeps one reading per account (see accounts.mjs
// for the keys): { "<account key>": { five: ..., week: ... } }. A session saves and shows the
// reading of its own account only. Every rule here holds per account. A file from before, with
// one reading for the whole computer ({ five: ..., week: ... }), is read as the reading of the
// account "unknown", and is written in the new shape the next time a reading is saved.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { config, readJson, writeJson } from './config.mjs'
import { home } from './paths.mjs'

const limitsFile = () => join(home(), 'limits.json')

/** The account of a reading when none is named: the key of a session whose account is not known. */
export const UNKNOWN = 'unknown'
/**
 * Whether a value is the key of an account, as the parsers and the status line make them:
 * "claude:<id>", "cowork:<folder>", "codex:<plan type>", "api", "cloud" or "unknown". A key of
 * the file's old shape is not one.
 */
export const isKey = (key) => typeof key === 'string' && /^(?:(?:claude|cowork|codex):[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}|api|cloud|unknown)$/.test(key)
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The two windows of a plan: the name in limits.json, the field Claude Code uses, and the length in milliseconds. */
export const WINDOWS = [
  { key: 'five', field: 'five_hour', length: 5 * 3600e3 },
  { key: 'week', field: 'seven_day', length: 7 * 86400e3 },
]

// Two readings of one window can give end times that differ by a few seconds.
const SAME_WINDOW = 60e3
const DAY = 86400e3
// The clock of this machine and the clock behind the end times can differ a little. So an end may
// be up to 60 seconds in the past, and up to 10 minutes further away than the window is long.
const END_BEHIND = 60e3
const END_BEYOND = 10 * 60e3

const complete = (r) => Number.isFinite(r?.pct) && Number.isFinite(r?.resetsAt) && Number.isFinite(r?.at)

/** The complete readings of one account's entry: `{ five, week }`, each only when it is there. */
const readingsOf = (value) => Object.fromEntries(WINDOWS.map(({ key }) => [key, isObject(value) ? value[key] : undefined]).filter(([, r]) => complete(r)))

/**
 * Every reading in the file, also of a window that has ended, per account: a Map from the key of
 * an account to `{ five, week }`. An account without a complete reading is left out. A file in
 * the old shape is the reading of the account "unknown".
 */
export function storedLimits() {
  const all = readJson(limitsFile(), {})
  const out = new Map()
  if (!isObject(all)) return out
  const entries = 'five' in all || 'week' in all ? [[UNKNOWN, all]] : Object.entries(all)
  for (const [account, value] of entries) {
    const readings = readingsOf(value)
    if (isKey(account) && Object.keys(readings).length) out.set(account, readings)
  }
  return out
}

/** The readings of a window that has not ended. */
const open = (readings, now) => Object.fromEntries(Object.entries(readings).filter(([, r]) => r.resetsAt > now))

/**
 * The plan's limits of one account as last seen on this machine: `{ five: { pct, resetsAt, at },
 * week: { ... } }`. `resetsAt` and `at` are in milliseconds. `at` is when this value was first
 * seen, or when a session that had just made a model call last gave it. A window that has ended
 * is left out. `account` is the key of the account, "unknown" when it is not named.
 */
export function readLimits(now = Date.now(), account = UNKNOWN) {
  return open(storedLimits().get(account) ?? {}, now)
}

/** The plan's limits of every account that has a window that has not ended: a Map from the key of the account to `{ five, week }`. */
export function allLimits(now = Date.now()) {
  const out = new Map()
  for (const [account, readings] of storedLimits()) {
    const current = open(readings, now)
    if (Object.keys(current).length) out.set(account, current)
  }
  return out
}

/**
 * Whether the end time of a reading can be true: at most the window's length plus 10 minutes
 * away, and not more than 60 seconds in the past. Any other end is wrong, for example one that
 * was given in milliseconds, which then lies thousands of years ahead. If such a reading were
 * kept, every true reading would look like one of an earlier window, and none would replace it.
 * A window that ended more than 60 seconds ago says nothing about now either.
 */
const possibleEnd = (resetsAt, length, now) => resetsAt >= now - END_BEHIND && resetsAt <= now + length + END_BEYOND

/**
 * Whether `reading` is newer than `old`, the reading that is kept for the same kind of window.
 * `fresh` says that the reading comes from a session that has just made a model call.
 */
function isNewer(reading, old, now, fresh) {
  // Nothing to compare with.
  if (!old) return true
  // The window of the kept reading has ended: only a reading with a later end says more. This
  // also keeps an idle session, whose status line runs on a timer, from writing the file on
  // every run with the same old reading.
  if (old.resetsAt <= now) return reading.resetsAt > old.resetsAt
  // A session that has just made a model call gives limits that are true now, for the account it
  // runs on now. So its reading of a window that is still open wins, also when that window ends
  // earlier than the kept one: after a change of account, the kept reading is the old account's.
  if (fresh && reading.resetsAt > now) return true
  // A later window.
  if (reading.resetsAt > old.resetsAt + SAME_WINDOW) return true
  // The same window. A fresh reading is true now, so it is taken as it is, also when its percent
  // is lower. Any other reading can be old: use only grows inside a window, so only a higher
  // percent is newer.
  if (reading.resetsAt >= old.resetsAt - SAME_WINDOW) return fresh || reading.pct > old.pct
  // An earlier window: this reading comes from a session that has been idle since then.
  return false
}

/**
 * Saves what one session was given as the plan's limits (`rate_limits` of the status line input),
 * as the reading of the session's account, unless a newer reading of that account is already
 * there. `fresh` is true when the session has made a model call since its last run. A fresh
 * reading of the window that is kept takes its place and sets its time to `now`. The readings of
 * the other accounts stay as they are.
 */
export function saveLimits(rateLimits, now = Date.now(), { fresh = false, account = UNKNOWN } = {}) {
  if (!isKey(account)) return
  const all = storedLimits()
  const limits = { ...all.get(account) }
  let changed = false
  for (const { key, field, length } of WINDOWS) {
    const given = rateLimits?.[field]
    // Without a percent and an end time a reading cannot be placed in a window.
    if (!Number.isFinite(given?.used_percentage) || !Number.isFinite(given?.resets_at)) continue
    const reading = { pct: given.used_percentage, resetsAt: given.resets_at * 1000, at: now }
    if (!possibleEnd(reading.resetsAt, length, now) || !isNewer(reading, limits[key], now, fresh)) continue
    limits[key] = reading
    changed = true
  }
  if (!changed) return
  all.set(account, limits)
  mkdirSync(home(), { recursive: true })
  writeJson(limitsFile(), Object.fromEntries(all))
}

const PROVIDER_SWITCHES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE']
// Only whether a variable is set counts. Its value is never kept, printed or stored.
const isSet = (env, name) => env[name] !== undefined && env[name] !== ''

/** Whether the environment names a cloud provider through which Claude Code reaches the model. */
export const cloudProvider = (env = process.env) => PROVIDER_SWITCHES.some((name) => isSet(env, name))

/** Whether ANTHROPIC_API_KEY is set in the environment. Its value is never read. */
export const apiKeySet = (env = process.env) => isSet(env, 'ANTHROPIC_API_KEY')

/**
 * `value` when it names one of the two ways to pay, else undefined. For a value that was read
 * from a file: the plan in the settings, and the mode in a session's file.
 */
export const billingMode = (value) => (value === 'subscription' || value === 'usage' ? value : undefined)

/**
 * How the person pays: `{ mode: 'subscription' | 'usage', sure, why }`. "usage" is paying by the
 * token. `sure` is false when nothing says which one it is. `input` is what Claude Code gives the
 * status line, or an empty object outside a session. `account` is the key of the session's
 * account: then only that account's reading of the limits counts. Outside a session, without
 * `account`, the reading of any account counts.
 */
export function billing(input, { env = process.env, cfg = config(), now = Date.now(), account } = {}) {
  if (billingMode(cfg.plan)) return { mode: cfg.plan, sure: true, why: 'set by hand' }
  // Claude Code gives these two fields to subscribers only.
  if (input?.rate_limits?.five_hour || input?.rate_limits?.seven_day) return { mode: 'subscription', sure: true, why: "Claude Code reports the plan's limits" }
  if (cloudProvider(env)) return { mode: 'usage', sure: true, why: 'a cloud provider is set in the environment' }
  if (apiKeySet(env)) return { mode: 'usage', sure: true, why: 'an API key is set in the environment' }
  // Claude Code gives the plan's limits with a session's first answer. A session that has had
  // answers and still has none runs on an account without them. A reading that another session
  // saved then comes from another account, for example the one used before a change of account.
  if (input?.cost?.total_api_duration_ms > 0) return { mode: 'usage', sure: false, why: 'this session has had answers, and Claude Code gives it no plan limits' }
  // A session has no limits before its first answer. Another session's reading of the same
  // account says the same.
  const readings = account === undefined ? [...allLimits(now).values()].flatMap(Object.values) : Object.values(readLimits(now, account))
  if (readings.some((r) => now - r.at <= DAY)) return { mode: 'subscription', sure: true, why: "the plan's limits were seen on this machine today" }
  return { mode: 'usage', sure: false, why: 'no sign of a plan, so figures are list prices' }
}

/** The answer of `billing` as words, for "widal plan" and "widal doctor". */
export const billingText = (b) => `${b.mode === 'subscription' ? 'subscription' : 'usage, paid by the token'}${b.sure ? '' : ', not sure'} (${b.why})`
