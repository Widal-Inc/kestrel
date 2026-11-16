// Keep-warm: a short turn in an idle session, shortly before its cache ends.
//
// A provider keeps the context of a session in its cache for one hour after the last call. The
// first call after that sends the whole context again. Claude Code can run a hook after each
// answer that waits in the background and then starts a new turn in the idle session. That turn
// (a wake) reads the context from the cache, and the cache then lasts another hour.
//
// A wake spends some of the person's plan limit while they are away. So keep-warm is off until
// the person applies it, and it stops after a number of hours without them (the cap). It is an
// experiment: a small record keeps what the wakes read and whether the person came back, and
// "kestrel measure keep-warm" says from it whether keep-warm saved more than it cost.
//
// This file holds the settings, the words, the record and the measure. The hook itself is in
// claude-code.mjs, next to the status line, whose figures about the session it reads.
import { join } from 'node:path'
import { config, readJson, writeJson } from './config.mjs'
import { count, money, table, tok } from './format.mjs'
import { home } from './paths.mjs'
import { priceOf } from './prices.mjs'

const HOUR = 3600e3

// Off, at most 3 hours without the person, 6 minutes before the end of the cache, and only for
// 100,000 tokens or more: a smaller context costs little to send again. The 6 minutes are one
// more than the notification before the end has, so that the wake comes first.
const DEFAULTS = { on: false, capHours: 3, before: 6, min: 100_000 }

/** The settings of keep-warm: `{ on, capHours, before, min }`, with the defaults for what is not set. `before` is in minutes. */
export const keepWarmConfig = (cfg = config()) => ({ ...DEFAULTS, ...cfg?.keepWarm })

/**
 * The shortest time the hook waits before a wake, in milliseconds: 30 seconds. By then the status
 * line has run for the answer that started the hook, and two wakes never follow each other at
 * once. The setting "minWait" (in seconds) changes it. A test sets it low, so that it need not wait.
 */
export const shortestWait = (k) => (Number.isFinite(k?.minWait) && k.minWait >= 0 ? k.minWait : 30) * 1000

/** What the hook tells the model when it wakes a session. Claude Code shows it as feedback of the hook. */
export const KEEP_WARM_WAKE = "kestrel keep-warm: nobody typed for a while and this session's cache was about to end. Reply with the single word: ok"

/**
 * A number of hours in words: "3 hours", "1 hour", "2.5 hours". The number comes from the
 * settings, so a value that is not a number must not make the status line fail.
 */
export function hours(n) {
  const x = Number(n)
  return `${Number.isInteger(x) ? x : x.toFixed(1)} ${x === 1 ? 'hour' : 'hours'}`
}

/** The hours of an idle time, rounded down to one decimal, and without the decimal when it is 0: "2", "0.7". */
function hoursUsed(ms) {
  const tenths = Math.floor(ms / (HOUR / 10))
  return tenths % 10 ? (tenths / 10).toFixed(1) : String(tenths / 10)
}

// A wake turn is short: its stop comes within this time after the wake. A stop or a model call
// that comes later belongs to a turn that the person or the agent began.
export const WAKE_TURN = 3 * 60e3
// The hook wakes the session at its time, give or take a second. A wake that has not come this
// long after its time does not come any more: the hook has ended, or it found a reason not to wake.
const WAKE_LATE = 60e3

/**
 * What the status line shows and decides about keep-warm for one session. `state` is the
 * `keepWarm` field of the session's file, and `k` is what `keepWarmConfig` gives. `until` is the
 * end of the session's cache. `callAt` is when the status line last saw that the session had
 * made a model call.
 *   - `waking` is true while a wake is still to come before `until`, or has just been made. The
 *     hook's wake is due `before` minutes ahead of the end. A token in the file alone does not
 *     say that a hook is still there to do it. So the wake counts as coming until 1 minute after
 *     its time. A wake that was made counts for 3 minutes: by then its turn has moved the end.
 *   - `stopped` is the cap in words ("3 hours") once an idle period that had wakes has reached it.
 *   - `part` is the part of the status line as [text, tone], while the idle period has wakes.
 * `stopped` and `part` are for a session that is idle. They are missing once the session has
 * made a model call after the turn of its last wake: the person is back, or the agent is at
 * work. The hook ends the idle period only at the next stop. Without this, the line would say
 * "kept warm" and "stopped" until the end of a long turn, while nobody is away.
 * All three are missing while keep-warm is off, and for a session that had no answer since it was turned on.
 */
export function keepWarmStatus(state, now, k, { until, callAt } = {}) {
  if (!k?.on || !Number.isFinite(state?.idleSince)) return {}
  const idle = now - state.idleSince
  const reached = idle >= k.capHours * HOUR
  const woke = state.wakes > 0
  // A model call later than the turn of the last wake: the session is no longer idle.
  const back = woke && callAt > state.wokeAt + WAKE_TURN
  // The wake for this end can still come. Without an end of the cache this is false, and then
  // no notification is due either.
  const coming = now < until - k.before * 60e3 + WAKE_LATE
  // A wake was made in the last 3 minutes.
  const justWoke = now >= state.wokeAt && now - state.wokeAt <= WAKE_TURN
  return {
    waking: !reached && state.token !== undefined && (coming || justWoke),
    stopped: reached && woke && !back ? hours(k.capHours) : undefined,
    part: !woke || back ? undefined : reached ? [`keep-warm stopped after ${hours(k.capHours)}`, 'warn'] : [`kept warm, ${hoursUsed(idle)} of ${hours(k.capHours)} used`],
  }
}

const recordFile = () => join(home(), 'keep-warm.json')
// The record keeps this many idle periods, the newest ones.
const KEEP = 200

/**
 * The record of keep-warm: one entry per idle period that had a wake, the oldest first. An entry
 * is `{ session, project, model, idleSince, wakes, read, last, cameBack }`. `read` is the tokens
 * that the wakes read from the cache: the size of the context at each wake, added up. `last` is
 * that size at the newest wake. `cameBack` is true once the person sent a prompt while the cache
 * was still kept. No text of a session is in it, only its id, the short name of its folder and
 * the id of its model.
 */
export function keepWarmRecord() {
  const entries = readJson(recordFile())
  return Array.isArray(entries) ? entries : []
}

/** The entry of one idle period of one session, or undefined. */
const entryOf = (entries, session, idleSince) => entries.findLast((e) => e?.session === session && e.idleSince === idleSince)

/** Adds one wake to the record. `ctx` is the size of the context at the wake, in tokens. */
export function recordWake({ session, project, model, idleSince, ctx }) {
  const entries = keepWarmRecord()
  let entry = entryOf(entries, session, idleSince)
  if (!entry) {
    entry = { session, project, model, idleSince, wakes: 0, read: 0 }
    entries.push(entry)
  }
  const tokens = Number.isFinite(ctx) ? ctx : 0
  entry.wakes += 1
  entry.read += tokens
  entry.last = tokens
  writeJson(recordFile(), entries.slice(-KEEP))
}

/** Marks the idle period of a session as one that the person came back to while the cache was still kept. */
export function recordCameBack(session, idleSince) {
  const entries = keepWarmRecord()
  const entry = entryOf(entries, session, idleSince)
  if (!entry || entry.cameBack === true) return
  entry.cameBack = true
  writeJson(recordFile(), entries)
}

// The closing sentence compares only from this many idle periods on.
const ENOUGH = 10

/**
 * The measure of keep-warm as text, from its record: how many idle periods it kept warm, what
 * the wakes read, how many periods the person came back to, and what those would have sent again.
 * `mode` is how the person pays. By the token ("usage") the text also gives dollars.
 *
 * The closing sentence compares two amounts at list prices, also on a subscription, because a
 * token read from the cache costs far less than a token that is written to it again:
 *   - the cost: every token the wakes read, at the price of a read from the cache;
 *   - the saving: for each period the person came back to, the context as it was at the last
 *     wake, at the price of a write to the 1 hour cache less the price of a read. With keep-warm
 *     the prompt of the person read that context. Without it the prompt would have written it.
 */
export function keepWarmReport({ mode } = {}) {
  const entries = keepWarmRecord().filter((e) => Number.isFinite(e?.wakes) && Number.isFinite(e?.read))
  if (!entries.length) return `Keep-warm has not woken a session yet, so there is nothing to measure.${keepWarmConfig().on ? '' : ' It is off. Turn it on with: kestrel apply keep-warm'}`
  const sum = (list, f) => list.reduce((total, e) => total + f(e), 0)
  const last = (e) => (Number.isFinite(e.last) ? e.last : 0)
  const price = (e) => (typeof e.model === 'string' ? priceOf(e.model) : undefined)
  const back = entries.filter((e) => e.cameBack === true)
  // A period on a model with no price is in the counts, and cannot be in the comparison.
  const priced = entries.filter(price)
  const cost = sum(priced, (e) => (e.read * price(e).read) / 1e6)
  const saved = sum(priced.filter((e) => e.cameBack === true), (e) => {
    const p = price(e)
    return (last(e) * ((p.w1 ?? p.in * 2) - p.read)) / 1e6
  })
  const dollars = mode === 'usage'
  const out = ['keep-warm: the idle periods in which a session was woken to keep its cache.', '']
  out.push(table([
    ['Idle periods kept warm', count(entries.length)],
    ['Wake turns', count(sum(entries, (e) => e.wakes))],
    ['Tokens the wakes read from the cache', tok(sum(entries, (e) => e.read))],
    ...(dollars ? [['What the wakes cost, at the price of a read from the cache', money(cost)]] : []),
    ['Idle periods you came back to while the cache was kept', count(back.length)],
    ['Tokens those would have sent again without keep-warm', tok(sum(back, last))],
    ...(dollars ? [['What sending them again would have cost more than a read', money(saved)]] : []),
  ], [1]), '')
  out.push(
    entries.length < ENOUGH ? `Too early to judge: ${count(entries.length)} idle ${entries.length === 1 ? 'period' : 'periods'} so far, and it takes ${ENOUGH}.`
    : !priced.length ? 'No comparison: the models of these sessions have no price.'
    : saved > cost ? 'Keep-warm saved more than it cost.'
    : 'Keep-warm cost more than it saved.',
  )
  out.push(dollars
    ? 'The two amounts are list prices. A wake also writes a few hundred tokens. Those are not counted.'
    : "On a subscription both count against your plan's limits, so no dollars are shown. The closing sentence compares them at list prices: a token read from the cache costs far less than one that is sent again. A wake also writes a few hundred tokens. Those are not counted.")
  if (priced.length && priced.length < entries.length) {
    const without = entries.length - priced.length
    out.push(`${count(without)} idle ${without === 1 ? 'period' : 'periods'} ran on a model with no price. ${without === 1 ? 'It is' : 'They are'} in the counts and not in the comparison.`)
  }
  return out.join('\n')
}
