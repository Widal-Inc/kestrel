// How each account pays, the price of its plan, and the words for the dollars of the reports.
//
// Widal.Code prices every call at list prices: what the same tokens cost by the token. For an
// account that pays by the token (an API key, a cloud provider) that is the real bill, so the
// reports call it spend. For an account on a subscription (Claude Pro, Max or Ultra, a Team or
// Enterprise seat, a ChatGPT plan for Codex) the person pays the plan's price instead. There the
// reports call the same dollars "API value": what the same use would cost by the token.
//
// The price of a plan comes from the person ("widal accounts price <key> <dollars>", kept in
// accounts.json), else from the small table below of plans whose price is public and fixed. Team
// and Enterprise seats and every other plan have no price in the table.
//
// A Cowork account runs on the plan of the Claude account with the same id. So both count as one
// plan here: the "plan key" of "cowork:<id>" is "claude:<id>".
import { labelOf, readAccounts, shortKey } from './accounts.mjs'
import { WINDOWS, billingMode, readLimits, storedLimits } from './billing.mjs'
import { limitParts } from './claude-code.mjs'
import { config } from './config.mjs'
import { money } from './format.mjs'

/** The id part of a key: what comes after the first ":". */
const idOf = (key) => key.slice(key.indexOf(':') + 1)

/**
 * The plans of Claude whose monthly price Widal.Code knows, in dollars a month, as claude.com/pricing
 * gave them on 16 Nov 2026: Pro $20 billed monthly ($17 a month billed yearly), Max $100 ("5x Pro
 * usage") and Ultra $200. Claude Code names Pro and Max by the type of organisation in
 * .claude.json: "claude_pro" and "claude_max". A Max account also has a rate limit tier that ends
 * in "max_5x" or "max_20x" (see maxTierOf in accounts.mjs), and the pricing page links Ultra to
 * "max_20x". So "claude_max" with "5x" is Max, and with "20x" is Ultra. "claude_max" without a
 * tier has no price here: Widal.Code does not guess between the two.
 */
export const CLAUDE_PLANS = {
  claude_pro: { name: 'Claude Pro', monthly: 20 },
}
/** The plans of Claude with the type "claude_max", by the size of their tier. */
export const MAX_PLANS = {
  '5x': { name: 'Claude Max', monthly: 100 },
  '20x': { name: 'Claude Ultra', monthly: 200 },
}
/** The name of a "claude_max" plan whose tier is not known. */
const MAX_OR_ULTRA = 'Claude Max or Ultra'
/** The ChatGPT plans of Codex whose monthly price Widal.Code knows, by the plan type in Codex's log. */
export const CODEX_PLANS = {
  plus: { name: 'ChatGPT Plus', monthly: 20 },
  free: { name: 'ChatGPT Free', monthly: 0 },
}

/** The key of the plan that an account runs on: "claude:<id>" for "cowork:<id>", else the key itself. */
export const planKeyOf = (key) => (typeof key === 'string' && key.startsWith('cowork:') ? `claude:${idOf(key)}` : key)

/** The entry in accounts.json that says what plan an account has: the Claude account's for Cowork. */
const planEntry = (key, state) => state.accounts.get(planKeyOf(key))

/**
 * How an account pays: "subscription", "usage", "cloud" or "unknown". A Claude account is a
 * subscription when Claude Code gave its plan's limits, or when .claude.json names a
 * subscription or a Claude plan. Codex with a plan type is on a ChatGPT plan. Cowork runs on a
 * Claude plan, of the Claude account with the same id when Widal.Code knows it.
 */
export function kindOf(key, state, hasLimits) {
  if (key === 'api') return 'usage'
  if (key === 'cloud') return 'cloud'
  if (key === 'unknown' || key === 'codex:unknown') return 'unknown'
  if (key.startsWith('codex:')) return 'subscription'
  const e = planEntry(key, state) ?? {}
  if (hasLimits || e.billingType?.includes('subscription') || e.organizationType?.startsWith('claude_')) return 'subscription'
  return key.startsWith('cowork:') ? 'subscription' : 'unknown'
}

/** The plan of an account: the seat tier or the organisation's type from .claude.json, or Codex's plan type. */
export function planOf(key, state) {
  if (key.startsWith('codex:')) return key === 'codex:unknown' ? null : idOf(key)
  const e = planEntry(key, state)
  return e?.seatTier ?? e?.organizationType ?? null
}

/** The entry of the price table for an account, or undefined when its plan has no price there. */
function tableEntry(key, state) {
  if (key.startsWith('codex:')) return Object.hasOwn(CODEX_PLANS, idOf(key)) ? CODEX_PLANS[idOf(key)] : undefined
  const e = planEntry(key, state)
  const type = e?.organizationType
  if (type === 'claude_max') return e.maxTier && Object.hasOwn(MAX_PLANS, e.maxTier) ? MAX_PLANS[e.maxTier] : undefined
  return type && Object.hasOwn(CLAUDE_PLANS, type) ? CLAUDE_PLANS[type] : undefined
}

/**
 * The name of an account's plan, as a person reads it: "Claude Max", "ChatGPT Plus", "Claude Max
 * or Ultra" for a Max type whose tier is not known, or the plan as Claude Code names it. Null when
 * not known.
 */
export function planName(key, state) {
  const named = tableEntry(key, state)?.name
  if (named) return named
  if (!key.startsWith('codex:') && planEntry(key, state)?.organizationType === 'claude_max' && !planEntry(key, state)?.seatTier) return MAX_OR_ULTRA
  return planOf(key, state)
}

/**
 * The price of an account's plan: `{ monthly, source }`, in dollars a month. `source` is "set"
 * when the person set it, and "table" when it comes from the table above. Null when neither knows
 * one. A Claude account and the Cowork account with the same id share one price.
 */
export function planPrice(key, state = readAccounts()) {
  if (typeof key !== 'string') return null
  const twin = key.startsWith('cowork:') ? `claude:${idOf(key)}` : key.startsWith('claude:') ? `cowork:${idOf(key)}` : undefined
  const set = state.accounts.get(key)?.price ?? (twin ? state.accounts.get(twin)?.price : undefined)
  if (Number.isFinite(set)) return { monthly: set, source: 'set' }
  const t = tableEntry(key, state)
  return t ? { monthly: t.monthly, source: 'table' } : null
}

/**
 * How the calls of an account are paid, for the words of the dollars: "subscription" (the dollars
 * are API value), "token" (they are spend) or "unknown". `stored` is what `storedLimits` gives:
 * an account with a reading of its plan's limits is on a subscription. An account whose kind is
 * not known follows "widal plan" when the person set it by hand.
 */
export function payingOf(key, state, { stored = storedLimits(), cfg = config() } = {}) {
  const k = typeof key === 'string' ? key : 'unknown'
  const hasLimits = stored.has(planKeyOf(k))
  if (k === 'unknown' && hasLimits) return 'subscription'
  const kind = kindOf(k, state, hasLimits)
  if (kind === 'subscription') return 'subscription'
  if (kind === 'usage' || kind === 'cloud') return 'token'
  const hand = billingMode(cfg.plan)
  return hand === 'subscription' ? 'subscription' : hand === 'usage' ? 'token' : 'unknown'
}

/**
 * A function that gives how an account pays, as `payingOf` does, reading the files once. `state`,
 * `stored` and `cfg` stand in for accounts.json, limits.json and the settings.
 */
export function payer({ state = readAccounts(), stored = storedLimits(), cfg = config() } = {}) {
  const known = new Map()
  return (key) => {
    const k = typeof key === 'string' ? key : 'unknown'
    if (!known.has(k)) known.set(k, payingOf(k, state, { stored, cfg }))
    return known.get(k)
  }
}

/** The words for the dollars of a call, by how it is paid. */
export const DOLLARS = { subscription: 'API value', token: 'spend', unknown: 'list prices' }

/**
 * The dollars of a list of items split by how they are paid: `{ token, subscription, unknown }`.
 * `key` gives an item's account and `cost` its dollars. `pay` is what `payer` gives.
 */
export function paidSplit(items, { key, cost, pay }) {
  const out = { token: 0, subscription: 0, unknown: 0 }
  for (const x of items) out[pay(key(x))] += cost(x)
  return out
}

/**
 * The lines that say what the dollars of a period are. By the token they are spend, on a
 * subscription API value. A period that mixes them shows them apart.
 */
export function paidLines({ token, subscription, unknown }) {
  const has = { token: token > 0, subscription: subscription > 0, unknown: unknown > 0 }
  const kinds = Object.keys(has).filter((k) => has[k])
  if (!kinds.length) return []
  if (kinds.length === 1 && has.token) return [`Spend: ${money(token)}, paid by the token, at list prices.`]
  if (kinds.length === 1 && has.subscription) return [`On subscriptions: ${money(subscription)} of API value. That is what the same use would cost by the token. You pay your plan's price, not this.`]
  if (kinds.length === 1) return [`${money(unknown)} at list prices. Widal.Code does not know how this is paid. Tell it with "widal plan subscription" or "widal plan usage".`]
  const out = []
  if (has.token) out.push(`Paid by the token: ${money(token)} (spend, at list prices)`)
  if (has.subscription) out.push(`On subscriptions: ${money(subscription)} of API value (what the same use would cost by the token)`)
  if (has.unknown) out.push(`Not known how it is paid: ${money(unknown)} at list prices`)
  return out
}

/** A price a month: whole dollars without cents ("$100"), else with them ("$19.99"). */
export const monthly = (x) => (Number.isInteger(x) ? `$${x.toLocaleString('en-US')}` : money(x))

/** The ratio of two amounts in words: "17.7 times", or "less than 0.1 times". */
const times = (x) => (x < 0.05 ? 'less than 0.1 times' : `${x >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(1)} times`)

/** A number of days in words: "1 day", "7 days". */
export const dayWords = (n) => (n === 1 ? '1 day' : `${n} days`)

/**
 * The plans of a period, one block per subscription: the account's name, its plan and the price a
 * month, then the plan's limits now where known (the week first, with the pace), then the API value
 * of the period, the plan's price for the same number of days (price x days / 30), and how many
 * times that price the use was worth. `items` are the calls of the period, `key` gives a call's
 * account and `cost` its dollars. Empty when no call of the period is on a subscription.
 */
export function plansLines(items, { key, cost, days, now = Date.now(), state = readAccounts(), stored = storedLimits(), cfg = config() }) {
  const pay = payer({ state, stored, cfg })
  const plans = new Map()
  for (const x of items) {
    const k = typeof key(x) === 'string' ? key(x) : 'unknown'
    if (pay(k) !== 'subscription') continue
    const pk = planKeyOf(k)
    if (!plans.has(pk)) plans.set(pk, { keys: new Set(), value: 0 })
    const p = plans.get(pk)
    p.keys.add(k)
    p.value += cost(x)
  }
  if (!plans.size) return []
  const out = ['Plans']
  for (const [pk, p] of [...plans].sort((a, b) => b[1].value - a[1].value)) {
    // The account that Widal.Code knows by name: the plan's own key, else the first key of the period.
    const shown = state.accounts.has(pk) ? pk : [...p.keys][0]
    const name = planName(shown, state)
    const price = planPrice(shown, state)
    const priceWords = price ? `${monthly(price.monthly)} a month (${price.source === 'set' ? 'your price' : "the plan's public price"})` : undefined
    const label = labelOf(shown, state)
    const facts = [name, priceWords].filter(Boolean)
    out.push(`  ${label}${label === shortKey(shown) ? '' : ` (${shortKey(shown)})`}${facts.length ? `: ${facts.join(', ')}` : ''}`)
    const limits = readLimits(now, pk)
    if (WINDOWS.some(({ key: w }) => limits[w])) out.push(`    Limits now: ${limitParts(limits, now).map(([text]) => text).reverse().join('; ')}`)
    const value = `API value in ${dayWords(days)}: ${money(p.value)}.`
    if (!price) out.push(`    ${value} Price not set: widal accounts price ${shortKey(shown)} <dollars>`)
    else if (!(price.monthly > 0)) out.push(`    ${value} A free plan, so there is no price to compare with.`)
    else {
      const forDays = (price.monthly * days) / 30
      out.push(`    ${value} The plan's price for ${dayWords(days)}: ${money(forDays)}. That is ${times(p.value / forDays)} the plan's price.`)
    }
  }
  return out
}

// A reading of the week is used for the estimate only from this percent on: below it, a few calls
// would change the dollars per percent by a lot.
const LEAST_PCT = 5
const WEEK = 7 * 86400e3

/**
 * Dollars of API value per 1% of the weekly limit, for each subscription with a reading of its
 * week that is open now and at least 5% used: a Map from the plan key to `{ perPct, pct, label }`.
 * It is the API value of the plan's calls from the start of the week (its end minus 7 days) to the
 * time of the reading, divided by the percent that the reading gives. `items` are the calls, `key` gives a call's account, `ts` its time
 * and `cost` its dollars. `since` is the start of the calls that were read: a week that began
 * before it is left out, because its dollars are not all there.
 *
 * This is an estimate. Anthropic does not publish how the limit counts tokens, so Widal.Code assumes
 * that each dollar of API value uses the same share of the limit.
 */
export function weekRates(items, { key, ts, cost, now = Date.now(), since = -Infinity, state = readAccounts(), stored = storedLimits(), cfg = config() }) {
  const pay = payer({ state, stored, cfg })
  const out = new Map()
  for (const [pk, readings] of stored) {
    const week = readings.week
    if (!week || !(week.resetsAt > now) || !(week.pct >= LEAST_PCT)) continue
    const start = week.resetsAt - WEEK
    if (start < since) continue
    let value = 0
    for (const x of items) {
      const k = typeof key(x) === 'string' ? key(x) : 'unknown'
      if (planKeyOf(k) === pk && ts(x) >= start && ts(x) <= week.at && pay(k) === 'subscription') value += cost(x)
    }
    if (value > 0) out.set(pk, { perPct: value / week.pct, pct: week.pct, label: labelOf(pk, state) })
  }
  return out
}

/**
 * An amount as a share of the weekly limit, in words, or undefined when no plan has a rate.
 * `byPlan` maps a plan key to the dollars of the amount on that plan, and `rates` is what
 * `weekRates` gives.
 */
export function weekShare(byPlan, rates) {
  const parts = []
  for (const [pk, dollars] of byPlan) {
    const r = rates.get(pk)
    if (r && dollars > 0) parts.push({ share: dollars / r.perPct, label: r.label })
  }
  if (!parts.length) return undefined
  const words = (s) => (s >= 10 ? Math.round(s).toLocaleString('en-US') : s.toFixed(1).replace(/\.0$/, ''))
  if (rates.size === 1 && parts.length === 1) return `about ${words(parts[0].share)}% of your weekly limit (estimate from this week's use)`
  return `about ${parts.sort((a, b) => b.share - a.share).map((p) => `${words(p.share)}% of the weekly limit of ${p.label}`).join(', ')} (estimates from this week's use)`
}
