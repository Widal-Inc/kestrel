// The accounts that Kestrel has seen, their names, and the labels that the person gave them.
//
// A person can use more than one account: a work and a personal Claude account, two
// organisations, Codex on a ChatGPT plan. The parsers give each call the key of its account (see
// parse-claude.mjs, parse-codex.mjs and parse-cowork.mjs). This file keeps what is known about
// each key in ~/.kestrel/accounts.json:
//
// {
//   accounts: {
//     "<key>": {
//       org: "Widal, Inc.",          the organisation's name, from Claude Code's file .claude.json
//       orgId: "<organisation id>",
//       billingType, seatTier, organizationType,   as Claude Code names them
//       maxTier: "5x" | "20x",       the size of a Max plan, from the rate limit tier that Claude Code names (see plans.mjs)
//       firstSeen, lastSeen,         the times of the first and the last model call Kestrel saw, in milliseconds
//       label: "Work",               the person's own label, when they set one
//       price: 100,                  the price of the plan in dollars a month, when the person set one (see plans.mjs)
//     }
//   },
//   signedIn: { "<config folder>": "<key>" }   the account signed in now in each config folder of Claude Code
// }
//
// The keys: "claude:<account id>", "cowork:<account folder>", "codex:<plan type>", "cloud" and
// "unknown". "api" is the key of a session that the status line saw with an API key.
//
// The name of the account that is signed in now comes from Claude Code's file .claude.json
// (~/.claude.json, or .claude.json in another config folder). That file can be large, so it is
// read by "kestrel refresh-today", "kestrel accounts" and "kestrel status", never by the status
// line. An account that is not signed in now keeps the name from the last time it was.
//
// Privacy: .claude.json also holds the person's email address, full name and display name. They
// are never stored, printed or sent. An organisation's name that holds one of them (Claude names
// a personal organisation after its person) is not kept either. The organisation's name and the
// ids are kept.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { allLimits, isKey } from './billing.mjs'
import { config, readJson, writeJson } from './config.mjs'
import { plain } from './format.mjs'
import { claudeDir, claudeDirs, claudeJsonOf, home, realPath } from './paths.mjs'

export const accountsFile = () => join(home(), 'accounts.json')

// The value of a field such as billingType: a plain word.
const WORD = /^[A-Za-z0-9_.-]{1,60}$/
const ID = /^[A-Za-z0-9-]{1,64}$/
/** How long a label may be. */
export const LABEL_MAX = 60

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const word = (v) => (typeof v === 'string' && WORD.test(v) ? v : undefined)
const time = (v) => (Number.isFinite(v) ? v : undefined)
/** The highest price a month that "kestrel accounts price" takes, in dollars. */
export const PRICE_MAX = 100_000
const price = (v) => (Number.isFinite(v) && v >= 0 && v <= PRICE_MAX ? v : undefined)
const tier = (v) => (v === '5x' || v === '20x' ? v : undefined)

/**
 * The size of a Max plan, from the rate limit tiers that .claude.json names, such as
 * "default_claude_max_5x" or "default_claude_max_20x": "5x", "20x", or undefined. The tier of the
 * person comes first, then that of the organisation. Only this short word is kept, never the tier
 * itself.
 */
export function maxTierOf(userTier, orgTier) {
  for (const t of [userTier, orgTier]) {
    const m = typeof t === 'string' ? /(?:^|_)max_(5|20)x$/.exec(t) : null
    if (m) return `${m[1]}x`
  }
  return undefined
}
const text = (v, max) => {
  const t = typeof v === 'string' ? plain(v).trim() : ''
  return t && t.length <= max ? t : undefined
}

/** One account as the file may hold it: only the known fields, each of its own type. */
function cleanEntry(e) {
  if (!isObject(e)) return {}
  const out = {
    org: text(e.org, 100), orgId: typeof e.orgId === 'string' && ID.test(e.orgId) ? e.orgId : undefined,
    billingType: word(e.billingType), seatTier: word(e.seatTier), organizationType: word(e.organizationType), maxTier: tier(e.maxTier),
    firstSeen: time(e.firstSeen), lastSeen: time(e.lastSeen), label: text(e.label, LABEL_MAX), price: price(e.price),
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined))
}

/**
 * What the file holds: `{ accounts, signedIn }`. Keys are kept in Maps while they are worked
 * with, so that a key can never change an object of this program. A file that is missing or
 * broken gives empty ones.
 */
export function readAccounts() {
  const raw = readJson(accountsFile(), {})
  const accounts = new Map()
  for (const [key, e] of Object.entries(isObject(raw?.accounts) ? raw.accounts : {})) if (isKey(key)) accounts.set(key, cleanEntry(e))
  const signedIn = new Map()
  for (const [folder, key] of Object.entries(isObject(raw?.signedIn) ? raw.signedIn : {})) if (isKey(key)) signedIn.set(folder, key)
  return { accounts, signedIn }
}

/** The file's text for a state: each Map as an object, with own keys only. */
const fileValue = ({ accounts, signedIn }) => ({ accounts: Object.fromEntries(accounts), signedIn: Object.fromEntries(signedIn) })

function saveAccounts(state) {
  mkdirSync(home(), { recursive: true })
  writeJson(accountsFile(), fileValue(state))
}

/**
 * What a .claude.json says about the account signed in: `{ key, orgId, org, billingType,
 * seatTier, organizationType, maxTier }`, or undefined when no account is signed in or the file cannot be
 * read. The email address, the full name and the display name are read only to see that the
 * organisation's name does not hold one of them, and are not given back.
 */
export function signedInAccount(file) {
  const o = readJson(file, undefined)?.oauthAccount
  if (!isObject(o) || typeof o.accountUuid !== 'string' || !ID.test(o.accountUuid)) return undefined
  let org = text(o.organizationName, 100)
  const personal = [o.emailAddress, o.fullName, o.displayName, typeof o.emailAddress === 'string' ? o.emailAddress.split('@')[0] : undefined]
  if (org && (org.includes('@') || personal.some((v) => typeof v === 'string' && v.trim().length >= 2 && org.toLowerCase().includes(v.trim().toLowerCase())))) org = undefined
  const info = {
    key: `claude:${o.accountUuid}`, orgId: typeof o.organizationUuid === 'string' && ID.test(o.organizationUuid) ? o.organizationUuid : undefined,
    org, billingType: word(o.billingType), seatTier: word(o.seatTier), organizationType: word(o.organizationType),
    maxTier: maxTierOf(o.userRateLimitTier, o.organizationRateLimitTier),
  }
  return Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined))
}

/**
 * Brings accounts.json up to date and gives the new state.
 *   - `records`: model calls, each with its account in `acct`. They set when each account was
 *     first and last seen.
 *   - `metas`: what `load()` gives next to the calls. It holds the organisation id of each
 *     Claude Code account in the logs.
 *   - `signedIn`: true to read .claude.json of every config folder, for the name of the account
 *     signed in there now. Never true in the status line.
 * The file is written only when something changed.
 */
export function updateAccounts({ records = [], metas, signedIn = false } = {}) {
  const state = readAccounts()
  const before = JSON.stringify(fileValue(state))
  const entry = (key) => {
    if (!state.accounts.has(key)) state.accounts.set(key, {})
    return state.accounts.get(key)
  }
  for (const r of records) {
    if (!isKey(r.acct) || !Number.isFinite(r.ts) || r.ts <= 0) continue
    const e = entry(r.acct)
    e.firstSeen = Math.min(e.firstSeen ?? r.ts, r.ts)
    e.lastSeen = Math.max(e.lastSeen ?? r.ts, r.ts)
  }
  for (const meta of metas?.values?.() ?? []) {
    for (const [key, orgId] of Object.entries(isObject(meta?.orgs) ? meta.orgs : {})) {
      if (isKey(key) && typeof orgId === 'string' && ID.test(orgId) && state.accounts.has(key)) state.accounts.get(key).orgId ??= orgId
    }
  }
  if (signedIn) {
    for (const folder of claudeDirs({ more: config().claudeDirs })) {
      const info = signedInAccount(claudeJsonOf(folder))
      const real = realPath(folder)
      if (!info) {
        state.signedIn.delete(real)
        continue
      }
      const { key, ...fields } = info
      Object.assign(entry(key), fields)
      state.signedIn.set(real, key)
    }
  }
  if (JSON.stringify(fileValue(state)) !== before) saveAccounts(state)
  return state
}

// The status line names the account of its session when more than one account was used in this time.
const USED_WITHIN = 7 * 86400e3

/**
 * The keys of the accounts used in the last 7 days: those with tokens in today's numbers
 * (`today`, what readToday gives), and those whose last call in accounts.json is at most 7 days
 * old. The status line reads only these two small files.
 */
export function accountsUsed(now, today, state = readAccounts()) {
  const keys = new Set(Object.keys(isObject(today?.accounts) ? today.accounts : {}).filter(isKey))
  for (const [key, e] of state.accounts) if (Number.isFinite(e.lastSeen) && now - e.lastSeen <= USED_WITHIN) keys.add(key)
  return keys
}

/** The key of the account signed in now in Claude Code's config folder of this environment, from accounts.json. */
export const currentAccount = (state = readAccounts()) => state.signedIn.get(realPath(claudeDir())) ?? null

/**
 * The account whose plan's limits a view of the whole computer shows, such as the first line of
 * "kestrel top": the account signed in now when it has a reading of a window that is open, else
 * the account with the newest such reading.
 */
export function accountToShow(now = Date.now(), state = readAccounts()) {
  const all = allLimits(now)
  const current = currentAccount(state)
  if (current && all.has(current)) return current
  let best
  let newest = -Infinity
  for (const [key, readings] of all) {
    const at = Math.max(...Object.values(readings).map((r) => r.at))
    if (at > newest) {
      newest = at
      best = key
    }
  }
  return best ?? current ?? 'unknown'
}

/** The id part of a key: what comes after "claude:", or the whole key when it has no such part. */
const idOf = (key) => (key.includes(':') ? key.slice(key.indexOf(':') + 1) : key)

/** A short form of a key, as "kestrel accounts" prints it: the tool and the first 8 characters of the id. */
export const shortKey = (key) => (key.includes(':') && idOf(key).length > 8 ? `${key.slice(0, key.indexOf(':'))}:${idOf(key).slice(0, 8)}` : key)

/**
 * The name of an account: the person's own label, else the organisation's name, else a short
 * form of the key. Cowork keeps its logs in a folder named after the Claude account, so a Cowork
 * account without a name of its own takes the name of the Claude account with the same id.
 */
export function labelOf(key, state = readAccounts()) {
  const e = state.accounts.get(key) ?? {}
  const same = key.startsWith('cowork:') ? state.accounts.get(`claude:${idOf(key)}`) : undefined
  return e.label ?? e.org ?? same?.label ?? same?.org ?? shortKey(key)
}

/**
 * The key that a person means: the key itself, its short form, or the start of its id ("aaaaaaaa"
 * for "claude:aaaaaaaa-1111-..."). `keys` are the keys to choose from. It throws one plain
 * sentence when no key or more than one fits.
 */
export function findKey(given, keys) {
  const list = [...keys]
  if (typeof given !== 'string' || !given) throw new Error('Name the account by its key, as "kestrel accounts" prints it.')
  if (list.includes(given)) return given
  const fits = list.filter((key) => shortKey(key) === given || (given.includes(':') ? key.startsWith(given) : idOf(key).startsWith(given)))
  if (fits.length === 1) return fits[0]
  if (fits.length > 1) throw new Error(`"${plain(given)}" fits more than one account: ${fits.sort().map(shortKey).join(', ')}. Give more of the key.`)
  if (!list.length) throw new Error('Kestrel knows no account yet. Run "kestrel accounts" first.')
  throw new Error(`There is no account "${plain(given)}". The accounts are: ${list.sort().map(shortKey).join(', ')}.`)
}

/**
 * Sets the label of an account, or takes it away when `label` is undefined. Returns one sentence
 * that says what changed. It throws one plain sentence for a wrong key or label.
 */
export function setLabel(given, label) {
  const state = readAccounts()
  const key = findKey(given, state.accounts.keys())
  const e = state.accounts.get(key)
  if (label === undefined) {
    delete e.label
    saveAccounts(state)
    return `The account ${shortKey(key)} has no label now. It shows as "${labelOf(key, state)}".`
  }
  const clean = text(label, LABEL_MAX)
  if (!clean) throw new Error(`A label has 1 to ${LABEL_MAX} characters.`)
  e.label = clean
  saveAccounts(state)
  return `The account ${shortKey(key)} is now called "${clean}".`
}

/**
 * Sets the price of an account's plan in dollars a month, or takes it away when `dollars` is
 * undefined. `dollars` is the text the person typed: a number such as 100 or 19.99, with or
 * without a "$" in front, from 0 to 100,000. A price the person set wins over the table of plans
 * (see plans.mjs). Returns one sentence that says what changed. It throws one plain sentence for a
 * wrong key or price.
 */
export function setPrice(given, dollars) {
  const state = readAccounts()
  const key = findKey(given, state.accounts.keys())
  const e = state.accounts.get(key)
  if (dollars === undefined) {
    delete e.price
    saveAccounts(state)
    return `The account ${shortKey(key)} has no price of yours now.`
  }
  const typed = String(dollars).trim().replace(/^\$/, '')
  const value = /^\d{1,6}(\.\d{1,2})?$/.test(typed) ? Number(typed) : NaN
  if (price(value) === undefined) throw new Error(`A price is a number of dollars a month from 0 to ${PRICE_MAX.toLocaleString('en-US')}, such as 100 or 19.99.`)
  e.price = value
  saveAccounts(state)
  return `The plan of the account ${shortKey(key)} costs ${Number.isInteger(value) ? `$${value.toLocaleString('en-US')}` : `$${value.toFixed(2)}`} a month now.`
}
