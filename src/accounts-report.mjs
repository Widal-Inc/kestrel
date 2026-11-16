// "kestrel accounts": the spend and the plan's limits of each account, one row per account.
//
// The rows come from the calls of the period, each with the key of its account (see
// accounts.mjs), and from accounts.json and limits.json. "--json" gives the same as one object,
// which the Kestrel pane in Claude Code reads:
//
// {
//   days: 7,
//   current: "<key of the account signed in now, or null>",
//   accounts: [
//     { key, label, kind: "subscription" | "usage" | "cloud" | "unknown", tool: "Claude Code" | "Cowork" | "Codex",
//       plan: "<seat tier or plan type, or null>", limits: { five: { pct, resetsAt, at } | null, week: ... | null },
//       today: { tokens, cost }, period: { tokens, cost, sessions }, lastSeen: <ms> }
//   ]
// }
//
// `cost` is dollars at list prices. The rows hold numbers, ids, organisation names and the
// person's own labels. Never an email address or a person's name.
import { currentAccount, labelOf, shortKey, updateAccounts } from './accounts.mjs'
import { readLimits } from './billing.mjs'
import { limitFacts } from './claude-code.mjs'
import { money, table, tok, when } from './format.mjs'
import { limitBars } from './hud.mjs'
import { cost } from './prices.mjs'
import { dayStart } from './refresh-today.mjs'

const TOOLS = { claude: 'Claude Code', cowork: 'Cowork', codex: 'Codex' }
/** The tool of an account. "api", "cloud" and "unknown" come from Claude Code's logs only. */
const toolOf = (key) => TOOLS[key.split(':')[0]] ?? 'Claude Code'
/** The id part of a key. */
const idOf = (key) => key.slice(key.indexOf(':') + 1)
/** All tokens of a call: input, cache writes, cache reads and output. */
const tokensOf = (r) => r.in + r.w5 + r.w1 + r.cr + r.out
/** Dollars rounded to a hundredth of a cent, so that the JSON stays short. */
const round = (x) => Math.round(x * 1e4) / 1e4

/**
 * How an account pays: "subscription", "usage", "cloud" or "unknown". A Claude account is a
 * subscription when Claude Code gave its plan's limits, or when .claude.json names a
 * subscription or a Claude plan. Codex with a plan type is on a ChatGPT plan. Cowork runs on a
 * Claude plan, of the Claude account with the same id when Kestrel knows it.
 */
export function kindOf(key, state, hasLimits) {
  if (key === 'api') return 'usage'
  if (key === 'cloud') return 'cloud'
  if (key === 'unknown' || key === 'codex:unknown') return 'unknown'
  if (key.startsWith('codex:')) return 'subscription'
  const e = state.accounts.get(key.startsWith('cowork:') ? `claude:${idOf(key)}` : key) ?? {}
  if (hasLimits || e.billingType?.includes('subscription') || e.organizationType?.startsWith('claude_')) return 'subscription'
  return key.startsWith('cowork:') ? 'subscription' : 'unknown'
}

/** The plan of an account: the seat tier or the organisation's type from .claude.json, or Codex's plan type. */
export function planOf(key, state) {
  if (key.startsWith('codex:')) return key === 'codex:unknown' ? null : idOf(key)
  const e = state.accounts.get(key.startsWith('cowork:') ? `claude:${idOf(key)}` : key)
  return e?.seatTier ?? e?.organizationType ?? null
}

/**
 * The rows of "kestrel accounts", as the object of "--json". `records` are the calls of the last
 * `days` days, and `metas` what `load()` gives next to them. It first brings accounts.json up to
 * date, with the name of the account signed in now. The newest account comes first.
 */
export function accountsData(records, { days, now = Date.now(), metas } = {}) {
  const state = updateAccounts({ records, metas, signedIn: true })
  const from = dayStart(now)
  const rows = new Map()
  for (const r of records) {
    const key = typeof r.acct === 'string' ? r.acct : 'unknown'
    if (!rows.has(key)) rows.set(key, { tokens: 0, cost: 0, sessions: new Set(), todayTokens: 0, todayCost: 0, lastSeen: 0 })
    const row = rows.get(key)
    const t = tokensOf(r)
    const c = cost(r).total
    row.tokens += t
    row.cost += c
    row.sessions.add(r.ses)
    row.lastSeen = Math.max(row.lastSeen, r.ts)
    if (r.ts >= from) {
      row.todayTokens += t
      row.todayCost += c
    }
  }
  const accounts = [...rows].map(([key, row]) => {
    // A Cowork account shares the plan of the Claude account with the same id.
    const limits = readLimits(now, key.startsWith('cowork:') ? `claude:${idOf(key)}` : key)
    return {
      key, label: labelOf(key, state), kind: kindOf(key, state, !!(limits.five || limits.week)), tool: toolOf(key), plan: planOf(key, state),
      limits: { five: limits.five ?? null, week: limits.week ?? null },
      today: { tokens: row.todayTokens, cost: round(row.todayCost) },
      period: { tokens: row.tokens, cost: round(row.cost), sessions: row.sessions.size },
      lastSeen: row.lastSeen,
    }
  })
  return { days, current: currentAccount(state), accounts: accounts.sort((a, b) => b.lastSeen - a.lastSeen) }
}

/** The plan's limits of one row as the status line words them in its lines, without bars: "week 9%, full 2 days early; 5h 33%". */
function limitsText(a, now) {
  const limits = Object.fromEntries(Object.entries(a.limits).filter(([, r]) => r))
  if (!Object.keys(limits).length) return a.key.startsWith('claude:') || a.key === 'unknown' ? 'none seen' : ''
  return limitBars(limitFacts(limits, now), { bars: false }).map(([text]) => text).join('; ')
}

/** The text of "kestrel accounts": one row per account, with its short key below its name, and which account is signed in now. */
export function accountsText(data, now = Date.now()) {
  const { days, accounts } = data
  if (!accounts.length) return `No model calls in the last ${days} days.`
  const rows = [['  account', 'tool', 'kind and plan', "plan's limits", 'tokens today', 'cost today', 'tokens', 'cost', 'sessions', 'last seen']]
  for (const a of accounts) {
    const current = a.key === data.current ? ' (signed in now)' : ''
    rows.push([
      `  ${a.label}`, a.tool, a.plan ? `${a.kind}, ${a.plan}` : a.kind, limitsText(a, now),
      tok(a.today.tokens), money(a.today.cost), tok(a.period.tokens), money(a.period.cost), String(a.period.sessions), when(a.lastSeen),
    ])
    // The short key below the name, for "kestrel accounts label". A name that is the short key already is not said twice.
    if (current || a.label !== shortKey(a.key)) rows.push([`    ${shortKey(a.key)}${current}`])
  }
  const out = [
    `Accounts, last ${days} days, the newest first. Tokens, cost and sessions are of the ${days} days. Cost is at list prices: on a subscription it is what the same use would cost by the token.`,
    '',
    table(rows, [4, 5, 6, 7, 8]),
    '',
  ]
  if (accounts.length === 1) out.push(`Kestrel found one account in the last ${days} days.`)
  out.push('Give an account your own name with: kestrel accounts label <key> "<label>"')
  return out.join('\n')
}
