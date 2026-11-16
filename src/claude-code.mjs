// The parts that Claude Code calls: the status line, the hook that holds a limit, two hooks that
// say what a lost cache costs, and the hook that keeps the cache of an idle session warm.
//
// Status line: Claude Code runs a command after each answer and gives it the session's cost, its
// context size and the state of the plan's limits as JSON. The command prints up to four lines,
// or one line when the person chose that (see hud.mjs). When the person turned that on, it also
// shows a notification shortly before the session's cache ends.
// It keeps one small file per session. The hooks read that file, and each keeps its own fields
// in it. The file of a session that the status line has not seen for 14 days is deleted. Every
// few minutes the status line also reads the end of the session's log, for a hint about the
// effort level at the end of the line. At a break in the work it can end with a hint to compact
// the context.
// Hook: Claude Code runs a command before each tool call. The command can ask the person to
// approve, or stop the agent.
// Two more hooks run before a change of model, and when the person sends a prompt.
// The keep-warm hook runs after each answer. It waits in the background, and wakes the session
// shortly before its cache ends when nobody typed in the meantime.
//
// The status line knows the account of its session (see accountOf below), and saves and shows the
// plan's limits of that account only. It also shows how many high or medium security risks are open
// for the settings and the session's repository, from the findings file (see risk.mjs).
//
// All must be quick and must never break a session: on any error they print nothing and exit 0.
// The keep-warm hook is the one that waits, and the one that ends with another exit code on
// purpose: that is how it wakes the session.
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { accountsUsed, currentAccount, labelOf, readAccounts } from './accounts.mjs'
import { UNKNOWN, WINDOWS, apiKeySet, billing, billingMode, cloudProvider, isKey, readLimits, saveLimits } from './billing.mjs'
import { config, readJson, saveConfig, writeJson } from './config.mjs'
import { claudeSetting, compactHint, compactHintConfig } from './compact.mjs'
import { startBoardSync } from './board.mjs'
import { clock, color, colorOn, day, model, money, plain, project, tok } from './format.mjs'
import { effortHint, hintConfig, logLook } from './hint.mjs'
import { hudConfig, hudLines, sessionsAround, startToday } from './hud.mjs'
import { KEEP_WARM_WAKE, WAKE_TURN, keepWarmConfig, keepWarmStatus, recordCameBack, recordWake, shortestWait } from './keep-warm.mjs'
import { notify, nudgeConfig, nudgeDue, nudgeText } from './nudge.mjs'
import { accountInHead } from './parse-claude.mjs'
import { home } from './paths.mjs'
import { priceOf } from './prices.mjs'
import { riskPart } from './risk.mjs'
import { branchOf, ticketOf } from './ticket.mjs'
import { readToday } from './today-file.mjs'

// The settings are in their own file, so that the billing check can read them without loading
// this one. They are also offered from here, where the command and the tests take them from.
export { config, saveConfig }

const sessionsDir = () => join(home(), 'sessions')

/**
 * The name under which a session is kept. The id comes from Claude Code's input and becomes a
 * file name, so it is taken only when it is a plain name: 1 to 100 letters, digits, ".", "_" and
 * "-", and no "." in front. Any other id, and a missing one, gives "unknown".
 */
const sessionName = (id) => (typeof id === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(id) ? id : 'unknown')

/**
 * The file that holds what is kept about one session: its name and ".json". So an id that is not
 * a plain name gives the file "unknown.json", and no id can name a file outside the folder of
 * the sessions.
 */
const sessionFile = (id) => join(sessionsDir(), `${sessionName(id)}.json`)

/**
 * Saves the fields that one part keeps about a session in the session's file. The status line
 * and the hooks all write this file, each its own fields, and they can run at the same time. So
 * the file is read again just before it is written, and only the fields in `own` are set. What
 * another part saved since this part first read the file stays. `was` is what this part read
 * first: it is used when the file is no longer there.
 */
function saveSession(file, own, was) {
  const now = readJson(file) ?? was
  // A file that holds something else than an object is broken. Nothing of it is kept.
  writeJson(file, { ...(typeof now === 'object' && !Array.isArray(now) ? now : undefined), ...own })
}

// A session's file is deleted when the status line has not run for the session for this long.
const KEEP_SESSION = 14 * 86400e3
// The folder of the sessions is looked through for such files at most this often.
const SWEEP_EVERY = 86400e3

/**
 * Deletes the files of sessions that the status line last saw more than 14 days ago, so that they
 * do not pile up. The folder is looked through at most once a day. The time of the last look is
 * kept in sweep.json, so that every other run reads only that one small file. A session file that
 * cannot be read, or that has no time in it, is left alone.
 */
function sweepSessions(now) {
  const mark = join(home(), 'sweep.json')
  const last = readJson(mark)?.at
  // A time that lies a day or more ahead comes from a clock that was wrong. It does not count.
  if (Number.isFinite(last) && Math.abs(now - last) < SWEEP_EVERY) return
  // The time is saved first, so that a look that fails is not tried again on every run.
  writeJson(mark, { at: now })
  for (const name of readdirSync(sessionsDir())) {
    if (!name.endsWith('.json')) continue
    const file = join(sessionsDir(), name)
    const s = readJson(file)
    if (Number.isFinite(s?.at) && now - s.at > KEEP_SESSION) rmSync(file, { force: true })
  }
}

/**
 * The tokens that the next call sends again once the cache is gone. `recache` is the number that
 * Claude Code gives for it. Claude Code may give none, or 0 for a cache that is already gone. That
 * says nothing about what the call sends, so then it is `ctx`, the size of the context.
 */
const resendTokens = (recache, ctx) => (Number.isFinite(recache) && recache > 0 ? recache : ctx)

/**
 * An amount of dollars or a time from Claude Code's input, or from a session's file, as a
 * number. Claude Code gives numbers. A value that is not a number comes from an input that has
 * changed, or from a file that is broken. It counts as 0, so that it cannot turn a sum into
 * "not a number": the day's total would then never reach the day's limit.
 */
const num = (value) => (Number.isFinite(value) ? value : 0)

/** What each session spent today, from the files the status line keeps. */
function spentToday(today) {
  let total = 0
  try {
    for (const f of readdirSync(sessionsDir())) {
      const s = readJson(join(sessionsDir(), f))
      if (s?.day === today) total += Math.max(0, num(s.cost) - num(s.dayStart))
    }
  } catch {
    // No session seen yet.
  }
  return total
}

/** The time that is left, for the cache: minutes rounded up, and hours with one decimal from 90 minutes on. */
function timeLeft(ms) {
  const min = Math.ceil(ms / 60e3)
  return min >= 90 ? `${(min / 60).toFixed(1)} hours` : `${min} min`
}

/** A limit in dollars as the person set it: whole dollars are shown without cents. */
const limitMoney = (x) => (Number.isInteger(x) ? `$${x.toLocaleString('en-US')}` : money(x))

/** The age of a reading: minutes, hours from 90 minutes on, days from 2 days on. */
function age(ms) {
  const min = Math.floor(ms / 60e3)
  if (min < 90) return `${min} min`
  const hours = Math.round(min / 60)
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`
}

/**
 * How much earlier than its reset a limit is full. The 5 hour limit: minutes under 90 minutes,
 * and hours with one decimal from 90 minutes on. The week: hours under one day, and days from
 * then on, with one decimal unless that decimal is 0 ("1 day", "2 days", "1.5 days").
 */
function early(ms, five) {
  if (five) {
    const min = Math.max(1, Math.round(ms / 60e3))
    return min < 90 ? `${min} min` : `${(min / 60).toFixed(1)} hours`
  }
  const hours = Math.max(1, Math.round(ms / 3600e3))
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  const days = (ms / 86400e3).toFixed(1).replace(/\.0$/, '')
  return days === '1' ? '1 day' : `${days} days`
}

/**
 * What is known about each limit of the plan, the 5 hour limit first: `{ five, used, tone, read,
 * gone, early }`. `five` says that it is the 5 hour limit, `used` is the rounded percent and
 * `tone` its colour. `read` is the age of the reading in words, when it is 5 minutes old or more.
 * `gone` is the percent of the window's time that has gone. `early` says in words how much
 * earlier than its reset the limit is full at the pace so far. `limits` is what `readLimits`
 * gives. A reading without `resetsAt` gives `five`, `used` and `tone` only.
 *
 * Both layouts of the status line put these facts in words: the one line in `limitParts`, the
 * lines in hud.mjs.
 */
export function limitFacts(limits, now) {
  return WINDOWS.filter(({ key }) => limits[key]).map(({ key, length }) => {
    const { pct, resetsAt, at } = limits[key]
    const five = key === 'five'
    const used = Math.round(pct)
    const fact = { five, used, tone: used >= 90 ? 'bad' : used >= 75 ? 'warn' : 'good' }
    if (resetsAt === undefined) return fact
    // The reading can come from another session, or from this one's last answer a while ago.
    if (now - at >= 5 * 60e3) fact.read = age(now - at)
    // How much of the window's time has gone, in milliseconds.
    const gone = Math.min(length, Math.max(0, length - (resetsAt - now)))
    fact.gone = Math.round((100 * gone) / length)
    // The pace: when the use goes on as fast as it was so far, the limit is full once the time
    // gone has grown by the factor 100 / pct. If that is before the reset, the fact says how much
    // earlier. In the first tenth of a window a few calls would already look like a fast pace, so
    // there it is left out.
    if (gone * 10 >= length && pct * length > 100 * gone) {
      const fullAt = resetsAt - length + (gone * 100) / pct
      fact.early = early(resetsAt - fullAt, five)
      if (fact.tone !== 'bad') fact.tone = fullAt - now <= (five ? 30 * 60e3 : 86400e3) ? 'bad' : 'warn'
    }
    return fact
  })
}

/**
 * One part per limit of the plan that is known, the 5 hour limit first, each as [text, tone]: how
 * much of it is used, and how much of its window's time has gone. `limits` is what `readLimits`
 * gives. A reading without `resetsAt` gives the percent only.
 */
export function limitParts(limits, now) {
  const parts = limitFacts(limits, now).map(({ five, used, tone, read, gone, early: soon }) => {
    let text = `${five ? '5 hour limit' : 'week'} ${used}% used`
    if (gone === undefined) return [text, tone]
    if (read) text += ` (read ${read} ago)`
    text += `, ${gone}% of ${five ? 'its time' : 'the week'} gone`
    if (soon) text += `: full about ${soon} early`
    return [text, tone]
  })
  return parts.length ? parts : [['plan limits not reported yet']]
}

/**
 * The plan's limits to show: the newest reading of all sessions of this session's account. A
 * percent that this session was given without an end time cannot be saved or compared. It is
 * shown as it is when there is no saved reading for that limit.
 */
function limitsToShow(rateLimits, now, account) {
  const limits = readLimits(now, account)
  for (const { key, field } of WINDOWS) {
    const given = rateLimits?.[field]
    if (!limits[key] && Number.isFinite(given?.used_percentage) && !Number.isFinite(given.resets_at)) limits[key] = { pct: given.used_percentage }
  }
  return limits
}

/**
 * What a call costs that writes the whole context to the cache again, in dollars. `ctx` is the
 * size of the context in tokens, `ttl` how long the cache lasts ("5m" or "1h"). Undefined when
 * the model has no price or the context is not known.
 */
const coldCost = (price, ctx, ttl) => (price && ctx ? (ctx * (ttl === '5m' ? (price.w5 ?? price.in * 1.25) : (price.w1 ?? price.in * 2))) / 1e6 : undefined)

/**
 * The part about the provider's cache of this session's context as [text, tone], or undefined
 * when nothing can be said. Claude Code says until when the cache lasts. After that time the next
 * call sends the whole context again. `price` is the model's price entry when the line shows
 * dollars. Without it the part gives tokens and time only.
 */
function cachePart(cache, ctx, now, price) {
  const until = cache?.expires_at > 0 ? cache.expires_at * 1000 : undefined
  const gone = (until !== undefined && until <= now) || cache?.warm === false
  // What the next call costs when the whole context is written to the cache again.
  const cold = coldCost(price, ctx, cache?.ttl)
  if (gone) {
    const resend = resendTokens(cache?.recache_tokens_if_cold, ctx)
    // A small context costs little to send again.
    return [price ? `cache gone, next call about ${money(cold)}` : `cache gone: the next call re-sends ${tok(resend)}`, resend >= 100_000 ? 'bad' : 'dim']
  }
  if (until !== undefined) {
    // A 5 minute cache is always close to its end, so it warns later.
    const soon = until - now <= (cache?.ttl === '5m' ? 1 : 10) * 60e3
    return [`cache warm, ${timeLeft(until - now)} left${price ? `, then ${money(cold)}` : ''}`, soon ? 'warn' : 'good']
  }
  // Without an end time, the cache is called warm only when Claude Code says that it is.
  const warm = cache?.warm === true ? 'good' : undefined
  // A read of the whole context from the cache is the least the next call costs.
  if (price) return [`next call at least ${money((ctx * price.read) / 1e6)}`, warm]
  return warm ? ['cache warm', warm] : undefined
}

// The names Claude Code gives the causes of a lost cache, in words.
const CAUSES = { model_changed: 'the model changed', messages_rewritten: 'earlier messages were rewritten' }
const causeWords = (cause) => (Object.hasOwn(CAUSES, cause) ? CAUSES[cause] : cause.startsWith('ttl_expired') ? 'the time ran out' : cause.replaceAll('_', ' '))

/**
 * The part about a cache that was lost in the last 10 minutes as [text, tone], or undefined. It
 * says why the last call sent the whole context again, while the person still knows what they did.
 *
 * Without a cause there is no part. Claude Code reports a loss with no cause for the second call of
 * every new session (seen live on 2026-11-13), and a warning the person can do nothing about is noise.
 */
function lossPart(cache, now) {
  const at = cache?.last_miss_at * 1000
  if (!(at > 0) || now - at > 10 * 60e3) return undefined
  const given = cache.last_miss_cause?.causes
  // Two causes can have the same words: a 5 minute and a 1 hour cache both ran out of time.
  const words = [...new Set((Array.isArray(given) ? given : []).filter((cause) => typeof cause === 'string' && cause).map(causeWords))]
  if (!words.length) return undefined
  const why = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0]
  return [`last cache loss: ${why}`, 'warn']
}

/** The tone of a limit in dollars: a warning from 80% of it, bad when it is reached. */
const dollarTone = (spent, limit) => (spent >= limit ? 'bad' : spent >= 0.8 * limit ? 'warn' : undefined)

/** The name of a folder: the last part of its path. Undefined for a path that is not text. */
const folderName = (cwd) => (typeof cwd === 'string' ? cwd.split(/[\\/]/).filter(Boolean).at(-1) : undefined)

/** A value from Claude Code's input as a word for the line: text that is not empty, or a number. Else undefined. */
const word = (v) => ((typeof v === 'string' && v) || Number.isFinite(v) ? String(v) : undefined)

/**
 * The account of a session: `{ key, keep }`. `keep` says that the key is final and is kept in the
 * session's file (field `account`), so that later runs take it from there.
 *
 * The first time, the first 8 KB of the session's log are read: its "session-owner" line names
 * the account, and an answer through a cloud provider means "cloud". A log of 8 KB or more
 * without either can no longer get one there. Then the environment tells a cloud provider
 * ("cloud") or an API key ("api"), else the account is "unknown". While the log is not there or
 * is shorter, nothing is kept and a later run looks again. Until then the session counts to the
 * account signed in now in this config folder, as "kestrel refresh-today" last saw it.
 */
function accountOf(s, path, env) {
  if (isKey(s?.account)) return { key: s.account, keep: true }
  const head = typeof path === 'string' && path ? accountInHead(path) : { complete: false }
  if (head.key && head.key !== UNKNOWN) return { key: head.key, keep: true }
  if (head.complete) return { key: cloudProvider(env) ? 'cloud' : apiKeySet(env) ? 'api' : UNKNOWN, keep: true }
  return { key: currentAccount() ?? UNKNOWN, keep: false }
}

/**
 * The status line. `input` is what Claude Code gives on stdin, `now` the time in milliseconds.
 * `opts.env` stands in for the environment, and `opts.color` (true or false) turns the colours on
 * or off, so that a test does not depend on the real environment. `opts.notify` stands in for the
 * notification of the operating system. `opts.layout` ("lines" or "one") stands in for the layout
 * of the settings, and `opts.spawn` for the start of "kestrel refresh-today" (see hud.mjs) and of
 * "kestrel board sync" (see board.mjs).
 *
 * On a subscription the person does not pay per token. The line then shows how much of the plan's
 * limits is used, and no dollars except for a limit the person set in dollars. When every token
 * is billed, the line shows dollars.
 */
export function statusLine(input, now = Date.now(), opts = {}) {
  const cfg = config()
  const env = opts.env ?? process.env
  const cost = num(input.cost?.total_cost_usd)
  // How long the session has run so far.
  const duration = num(input.cost?.total_duration_ms)
  const today = day(now)
  mkdirSync(sessionsDir(), { recursive: true })
  const file = sessionFile(input.session_id)
  const s = readJson(file)
  let dayStart = num(s?.dayStart)
  if (!s) {
    // First sight of this session. If it began before today, only count what it spends from now.
    dayStart = day(now - duration) === today ? 0 : cost
  } else if (s.day !== today) dayStart = num(s.cost)

  const u = input.context_window?.current_usage
  const ctx = u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : 0
  const cache = input.prompt_cache
  const until = cache?.expires_at > 0 ? cache.expires_at * 1000 : undefined
  const recache = Number.isFinite(cache?.recache_tokens_if_cold) ? cache.recache_tokens_if_cold : undefined
  // What the next call sends again once the cache is gone.
  const resend = resendTokens(recache, ctx)
  // A run is fresh when the session has made a model call since its last run: the time it has
  // spent on model calls is then another one than the saved one. The first run for a session has
  // nothing to compare with, so it is not fresh.
  const apiMs = Number.isFinite(input.cost?.total_api_duration_ms) ? input.cost.total_api_duration_ms : undefined
  const fresh = apiMs !== undefined && Number.isFinite(s?.apiMs) && apiMs !== s.apiMs
  // When the status line last saw that the session had made a model call.
  const callAt = fresh ? now : s?.callAt
  // What keep-warm does for this session, from what its hook keeps in the session's file.
  const warm = keepWarmStatus(s?.keepWarm, now, keepWarmConfig(cfg), { until, callAt })
  // The notification before the cache ends says "send a message to keep it". That would be wrong
  // for a cache that Claude Code already calls lost. And while a wake of keep-warm is still to
  // come before this end, or has just been made, that end gets no notification.
  const nudge = cache?.warm !== false && !warm.waking && nudgeDue({ until, ttl: cache?.ttl, recache: resend, nudgedFor: s?.nudgedFor, now, cfg: nudgeConfig(cfg) })

  // A session knows the plan's limits only from its own last answer. So each run saves what it was
  // given, and the line shows the newest reading of all sessions of the same account. Only a
  // fresh run is known to give limits that are true now.
  const account = accountOf(s, input.transcript_path, env)
  // The limits that Claude Code hands the status line come from the account signed in now. After a
  // sign-in in the middle of a session that is not the account the session started with, which its
  // log keeps naming. So the limits are saved and shown for the account signed in now, as
  // "kestrel refresh-today" last saw it, else for the session's account.
  const limitsAccount = currentAccount() ?? account.key
  if (input.rate_limits) saveLimits(input.rate_limits, now, { fresh, account: limitsAccount })
  const bill = billing(input, { env, cfg, now, account: limitsAccount })
  const subscription = bill.mode === 'subscription'
  const price = priceOf(input.model?.id)
  // The hint about the effort level, from the last calls in the session's log. Through a cloud
  // provider a change of the effort level can lose the cache, so there the hint is left out. A
  // plan that was set by hand to "usage" does not say whether a cloud provider is behind it. So
  // the environment is asked whenever the person pays by the token.
  // Both hints at the end of the line can need the end of the session's log. They share one
  // look, so the log is read once in a run at most.
  const look = logLook(input.transcript_path)
  const hint = effortHint(input, s?.hint, now, { h: hintConfig(cfg), cloud: bill.mode === 'usage' && cloudProvider(env), look })
  // The hint to compact, and what is kept about the size of the context to tell how much it grew.
  const compact = compactHint({ ctx, window: input.context_window?.context_window_size, s, callAt, now, c: compactHintConfig(cfg), path: input.transcript_path, look })

  // The fields that the status line keeps in the session's file. Other parts keep their own
  // fields in this file (the limit hook keeps "askedAt", the keep-warm hook keeps "keepWarm", the
  // hook for a sent prompt keeps "coldWarnedFor"). Those stay as they are in the file at the
  // moment it is written: a hook can have written the file since this run read it.
  // These fields are kept for the hooks, which run without this input.
  // How the person pays is kept because only this input has the plan's limits. A hook cannot
  // find that out alone once the shared reading of the limits is more than a day old.
  // The tokens to send again, the size of the context, the folder and the model are what Claude
  // Code says now: one that this input does not have is taken out of the file.
  // The end of the cache stays until Claude Code gives another one, and with it how long the
  // cache lasts. It is not known whether Claude Code still gives the end once the cache is gone.
  // Without the end, the hook for a sent prompt could not tell that the cache has ended.
  // The time spent on model calls is kept so that the next run can tell whether it is fresh,
  // and the time of the last run that was fresh so that the line can tell an idle session from
  // one that is at work.
  // For the hint to compact: the size of the context right after the last compaction, and the
  // last size that a run was given. Unlike the size of the context above, these two stay when
  // this input has no size, so that a compaction is still seen as a drop at the next run.
  // The git branch of the folder and its ticket are for the other sessions' status lines and for
  // "kestrel top": they say what each session works on. A branch name is no text of a session.
  const branch = branchOf(input.cwd)
  const kept = {
    day: today, cost, dayStart, at: now, billing: bill.mode, apiMs, callAt,
    cacheUntil: until ?? s?.cacheUntil, ttl: cache?.ttl ?? (until === undefined ? s?.ttl : undefined),
    recache, ctx: ctx || undefined,
    project: typeof input.cwd === 'string' && input.cwd ? project(input.cwd) : undefined, model: input.model?.id,
    compactBase: compact.base, ctxSeen: compact.seen,
    branch, ticket: ticketOf(branch),
    account: account.keep ? account.key : undefined,
  }
  // The end that had its notification is saved before the notification is shown. So one that
  // cannot be shown is not tried again on every run.
  if (nudge) kept.nudgedFor = until
  // A run that looked at the log for the hint keeps the time of that look, and the hint it found.
  // The next runs show that hint, and do not look again for a while.
  if (hint.checked) kept.hint = hint.checked
  // The same for the hint to compact: when it came, and the time of a look at the log for a
  // sign that a task ended.
  if (compact.checked) kept.compactHint = compact.checked
  saveSession(file, kept, s)
  try {
    sweepSessions(now)
  } catch {
    // The old files stay for now: a failure here must not break the status line.
  }
  // When this computer is linked to a Kestrel board and the last sync is 10 minutes old, a sync
  // starts in the background. This run reads two small files for that and never waits: the status
  // line itself never uses the network. In both layouts.
  startBoardSync(now, opts.spawn)

  if (nudge) {
    try {
      // Claude Code's settings say whether it compacts an idle session on its own. They are
      // read only now that a notification is due.
      const { title, body } = nudgeText({
        project: kept.project, until, recache: resend, mode: bill.mode, coldCost: coldCost(price, ctx, cache?.ttl), keepWarmStopped: warm.stopped,
        ttl: cache?.ttl, idleCompaction: claudeSetting('idleCompaction'),
      })
      ;(opts.notify ?? notify)(title, body)
    } catch {
      // No notification: a failure here must not break the status line.
    }
  }

  // Each part is [text, tone]. A part without a tone has no colour. Both layouts show the same
  // parts: the one line in a row, the lines each in their place.

  // On a subscription the plan's limits. By the token the dollars of this session.
  const limitsNow = subscription ? limitsToShow(input.rate_limits, now, limitsAccount) : undefined
  // The spend per hour of a session that has just begun would say little.
  const perHour = duration >= 10 * 60e3 ? `, ${money(cost / (duration / 3600e3))} per hour` : ''
  const sessionDollars = subscription ? [] : [[`${money(cost)} session${perHour}${bill.sure ? '' : ' (list prices)'}`]]
  // The cache, how much of its cap keep-warm has used in this idle period (or that it has
  // stopped), and a cache that was just lost.
  const cacheParts = [ctx ? cachePart(cache, ctx, now, subscription ? undefined : price) : undefined, warm.part, lossPart(cache, now)].filter(Boolean)
  const used = input.context_window?.used_percentage != null ? Math.round(input.context_window.used_percentage) : undefined
  // Some models cost more per token above a certain context size.
  const ctxTone = used >= 95 ? 'bad' : used >= 80 || ctx > price?.longOver ? 'warn' : undefined

  const dollars = []
  const limits = cfg.limits
  if (subscription) {
    // A limit the person set is in dollars at list prices. These are the only dollars on this line.
    if (limits?.session) dollars.push([`limit ${limitMoney(limits.session)} per session at list prices, ${money(cost)} so far`, dollarTone(cost, limits.session)])
    if (limits?.day) {
      const spent = spentToday(today)
      dollars.push([`limit ${limitMoney(limits.day)} per day at list prices, ${money(spent)} so far`, dollarTone(spent, limits.day)])
    }
  } else {
    const spent = spentToday(today)
    dollars.push([`today ${money(spent)}${limits?.day ? ` of ${limitMoney(limits.day)}` : ''}`, limits?.day ? dollarTone(spent, limits.day) : undefined])
    if (limits?.session) dollars.push([`limit ${limitMoney(limits.session)}`, dollarTone(cost, limits.session)])
  }
  // The two hints come last: first the one about the effort level, then the one to compact.
  const hints = [hint.part, compact.part].filter(Boolean)
  // The open security findings of the settings and of this folder's repository, from the findings
  // file only. A file that cannot be read gives no part.
  let risk
  try {
    risk = riskPart(input.cwd)
  } catch {
    risk = undefined
  }
  const on = opts.color ?? colorOn(env, cfg)
  const hud = hudConfig(cfg)

  if ((opts.layout ?? hud.layout) === 'lines') {
    return hudLines({
      session: () => {
        // The percent of the context window, from Claude Code, else worked out from the window's size.
        const size = input.context_window?.context_window_size
        const window = Number.isFinite(size) && size > 0 ? size : undefined
        const pct = Number.isFinite(used) ? used : window ? Math.round((100 * ctx) / window) : undefined
        return {
          model: word(input.model?.display_name) ?? word(input.model?.id), effort: word(input.effort?.level),
          folder: folderName(input.cwd), branch, ctx: ctx ? { tokens: ctx, pct, window, tone: ctxTone } : undefined, cache: cacheParts, risk,
        }
      },
      plan: () => {
        // Today's numbers of all agents come from today.json. When that is missing or old, it is
        // made again in the background, and this part waits for the file.
        startToday(now, opts.spawn)
        const t = readToday(now)
        // With more than one account used in the last 7 days, the line starts with the name of
        // this session's account. With one, nothing changes.
        const state = readAccounts()
        const used = accountsUsed(now, t, state)
        if (account.keep) used.add(account.key)
        // The name goes with the limits shown, so it is the account signed in now.
        const name = used.size > 1 ? labelOf(limitsAccount, state) : undefined
        return { account: name, limits: subscription ? limitFacts(limitsNow, now) : undefined, money: [...sessionDollars, ...dollars], today: Number.isFinite(t?.tokens) && t.tokens >= 0 ? t : undefined }
      },
      work: () => {
        // The task list and the agents come from the same look at the log as the hints: the log
        // is read once in a run. Their names stay in memory.
        const seen = look()
        const agents = (seen.agents ?? []).map(({ type, description, at }) => ({ type, description, min: at > 0 ? Math.max(0, Math.floor((now - at) / 60e3)) : undefined }))
        return { tasks: seen.tasks, agents, ...sessionsAround(sessionsDir(), sessionName(input.session_id), kept.ticket, now) }
      },
      hint: () => hints,
    }, hud, on)
  }

  const parts = [...(subscription ? limitParts(limitsNow, now) : sessionDollars), ...cacheParts]
  if (ctx) parts.push([`context ${tok(ctx)}${used != null ? ` (${used}%)` : ''}`, ctxTone])
  if (input.effort?.level) parts.push([`effort ${input.effort.level}`])
  if (risk) parts.push(risk)
  parts.push(...dollars, ...hints)
  // A part can hold text from Claude Code's input: the effort level, the cause of a lost cache.
  // The line goes to the terminal, so every part is shown without control characters. The only
  // escape codes on the line are this tool's own colours.
  // Only the parts are coloured, never the " | " between them.
  return parts.map(([text, tone]) => (on ? color(plain(text), tone) : plain(text))).join(' | ')
}

/**
 * The hook before a tool call. Returns the JSON to print, or undefined for no decision.
 * `input` is what Claude Code gives on stdin.
 */
export function limitHook(input, now = Date.now()) {
  const limits = config().limits
  if (!limits || (!limits.session && !limits.day)) return undefined
  const today = day(now)
  mkdirSync(sessionsDir(), { recursive: true })
  const file = sessionFile(input.session_id)
  // A session the status line has not seen yet has no cost figure of its own. The day's limit
  // still holds for it, from the figures of the other sessions.
  const s = readJson(file) ?? { day: today, cost: 0, dayStart: 0, at: now }
  const cost = num(s.cost)
  const spent = spentToday(today)
  const over =
    limits.session && cost >= limits.session ? `this session has spent ${money(cost)}, and its limit is ${money(limits.session)}`
    : limits.day && spent >= limits.day ? `today's spend is ${money(spent)}, and the day's limit is ${money(limits.day)}`
    : undefined
  if (!over) return undefined
  const how = 'Raise it with "kestrel limit", or turn it off with "kestrel limit --off".'
  // Stop: refuse this tool call and end the agent's turn. Without the refusal, Claude Code runs the
  // tool call first and stops after it (seen in a live test on 2026-11-12).
  if (limits.action === 'stop') {
    const reason = `Kestrel stopped the agent: ${over}. ${how}`
    return { continue: false, stopReason: reason, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
  }
  // Ask or warn once, then again only after the spend has grown by a tenth of the limit.
  const step = Math.max(1, 0.1 * (limits.session || limits.day))
  const measure = limits.session && cost >= limits.session ? cost : spent
  if (Number.isFinite(s.askedAt) && measure < s.askedAt + step) return undefined
  // Only "askedAt" is this hook's own. The other fields belong to the status line and the other
  // hooks, and one of them can have written the file since this hook read it.
  saveSession(file, { askedAt: measure }, s)
  if (limits.action === 'warn') return { systemMessage: `kestrel: ${over}. ${how}` }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `kestrel: ${over}. Approve to continue. ${how}` } }
}

/**
 * The hook before a change of model. A change of model loses the cache: the whole context is
 * written again for the new model. Claude Code gives this hook its own estimate of that cost.
 * Returns the JSON to print, or undefined to say nothing.
 *
 * Claude Code can only ask the person when they typed /model with a name in a terminal session.
 * Anywhere else an "ask" counts as a refusal, so there this hook only shows the cost.
 */
export function modelSwitchHook(input, env = process.env) {
  const cost = input.estimated_cache_write_usd
  // With the cache already gone, the next call writes the context again on either model.
  if (typeof cost !== 'number' || !(cost >= 0.05) || input.prompt_cache_warm === false) return undefined
  const prices = { configured: "at your organization's prices", catalog: 'at list prices', default: 'at a default price, because the price of that model is not known' }[input.pricing] ?? 'an estimate'
  const text = `a switch from ${model(input.from_model)} to ${model(input.to_model)} sends the whole context (${tok(input.context_tokens ?? 0)} tokens) to the new model again. That costs about ${money(cost)} (${prices}).`
  const askFrom = config().modelSwitchAskFrom ?? 0.5
  // A person is there when Claude Code runs in a terminal (its entry point is "cli"). In a run
  // without a person an "ask" would refuse the switch, so there the cost is only shown.
  if (cost >= askFrom && input.source === 'command' && env.CLAUDE_CODE_ENTRYPOINT === 'cli') {
    return { hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: 'ask', permissionDecisionReason: `kestrel: ${text} Switch anyway?` } }
  }
  return { systemMessage: `kestrel: ${text}` }
}

/**
 * The hook that runs when the person sends a prompt. After a long break the session's cache has
 * ended, and this prompt sends the whole context again. The hook says so once per end, so that
 * the person sees what the break cost. Returns the JSON to print, or undefined to say nothing.
 *
 * It works with what the status line saved about the session: the end of its cache, the size of
 * its context, and how the person pays. It only shows a message: it never blocks or changes the
 * prompt, and it does not read it.
 */
export function coldStartHook(input, now = Date.now(), env = process.env) {
  if (!input.session_id) return undefined
  const file = sessionFile(input.session_id)
  const s = readJson(file)
  const until = s?.cacheUntil
  // Nothing is known about this session's cache, or it is still there.
  if (!Number.isFinite(until) || until > now) return undefined
  const cfg = config()
  // What this prompt sends again. A small context costs little, so it gets no message.
  const resend = resendTokens(s.recache, s.ctx)
  if (!(resend >= nudgeConfig(cfg).min) || s.coldWarnedFor === until) return undefined
  // How the person pays: the plan they set by hand, else what the status line of this session
  // found. This hook is not given the plan's limits, and after a long break the shared reading of
  // them is too old to count. So on its own it would show dollars to a subscriber. Only a file
  // from before the status line saved this has nothing: then the hook decides with what it has.
  const mode = billingMode(cfg.plan) ?? billingMode(s.billing) ?? billing(input, { env, cfg, now, account: accountInFile(s) }).mode
  // By the token the message gives dollars, the same figure the status line showed before the end.
  const cold = mode === 'usage' ? coldCost(priceOf(s.model), s.ctx, s.ttl) : undefined
  const what = cold !== undefined ? `This prompt cost about ${money(cold)} more.` : `This prompt sent ${tok(resend)} tokens again.`
  const message = `kestrel: this session's cache ended at ${clock(until)}. ${what} Before a long break next time: /compact, or start a new session.`
  // The warning counts as shown only once its text is there. If building the text fails, nothing
  // is saved, and the next prompt tries again. The other fields of the file belong to the status
  // line and the other hooks. They stay as they are in the file now.
  saveSession(file, { coldWarnedFor: until }, s)
  return { systemMessage: message }
}

// The status line runs on a timer while a session is open. A session whose file it has not
// written for this long is taken as closed.
const SESSION_OPEN = 5 * 60e3
// A cache that does not last 5 minutes lasts 1 hour after its last use.
const HOUR = 3600e3
// Counts the plans of this process, so that two plans made in the same millisecond differ.
let plans = 0

/** Whether a limit of the plan is yellow or red on the status line now, from the reading that all sessions of the account share. */
const limitTight = (now, account) => limitParts(readLimits(now, account), now).some(([, tone]) => tone === 'warn' || tone === 'bad')

/**
 * The account whose limits count for a session in a hook: the account signed in now, as the status
 * line saves the limits for it (see statusLine), else the session's account from its file.
 */
const accountInFile = (s) => currentAccount() ?? (isKey(s?.account) ? s.account : UNKNOWN)

/**
 * Whether the plan's limits hold keep-warm back for a session now: the person is on a
 * subscription, and a limit is yellow or red on the status line. `s` is the session's file, and
 * `input` what Claude Code gave the hook.
 *
 * How the person pays is found as the hook for a sent prompt finds it: the plan they set by
 * hand, else what the status line of this session found. The plan's limits count on a
 * subscription only. By the token an old reading of them says nothing.
 */
const limitHolds = (s, input, now, cfg, env) => {
  const account = accountInFile(s)
  return (billingMode(cfg.plan) ?? billingMode(s.billing) ?? billing(input, { env, cfg, now, account }).mode) === 'subscription' && limitTight(now, account)
}

/**
 * Saves what the keep-warm hook keeps about a session, in the `keepWarm` field of the session's
 * file. The file is read again just before it is written, because the status line writes the
 * same file and may have done so since the hook read it. A file that is gone is not made again:
 * only the status line makes the file of a session.
 */
function saveKeepWarm(file, keepWarm) {
  const s = readJson(file)
  if (s) writeJson(file, { ...s, keepWarm })
}

/**
 * The first half of the keep-warm hook, which Claude Code runs after each answer: whether to
 * wait for the end of this session's cache, and how long. Returns `{ waitMs, token }`, or
 * undefined when the session is not to be woken. `input` is what Claude Code gives the hook, and
 * nothing of the answer in it is read or kept. `env` stands in for the environment.
 *
 * No plan is made while keep-warm is off, for a session the status line has not seen, for a
 * cache that lasts 5 minutes (a wake every few minutes costs more than it saves), for a context
 * below `min` tokens, while a limit of the plan is yellow or red on the status line, and once
 * the session has been idle for the cap.
 *
 * The hook keeps `{ token, idleSince, wakes, wokeAt }` in the session's file. A waiting hook is
 * not cancelled when the person types: every answer starts a new one, and the old ones still
 * wait. The token names the newest plan, so that only its hook can wake the session. When no
 * plan is made, no token is kept, so that an older hook does not wake the session either.
 *
 * The idle period: a stop within 3 minutes after a wake belongs to the turn of that wake, and
 * the idle period goes on. Any other stop means that the person or the agent was active. A new
 * idle period starts then, without wakes.
 */
export function keepWarmPlan(input, now = Date.now(), { cfg = config(), env = process.env } = {}) {
  const k = keepWarmConfig(cfg)
  if (!k.on || !input?.session_id) return undefined
  const file = sessionFile(input.session_id)
  const s = readJson(file)
  // The status line has not seen this session, so nothing is known about its cache.
  if (!s) return undefined
  const was = s.keepWarm
  const wakeTurn = Number.isFinite(was?.idleSince) && now >= was.wokeAt && now - was.wokeAt <= WAKE_TURN
  const state = wakeTurn ? { idleSince: was.idleSince, wakes: was.wakes, wokeAt: was.wokeAt } : { idleSince: now, wakes: 0 }
  // The person came back to an idle period that had wakes. The record notes that when the cache
  // that the last wake kept was still there, because that is what keep-warm is for.
  const cameBack = !wakeTurn && was?.wakes > 0 && now < was.wokeAt + HOUR
  const noPlan = s.ttl === '5m' || !(resendTokens(s.recache, s.ctx) >= k.min) || limitHolds(s, input, now, cfg, env) || now - state.idleSince >= k.capHours * HOUR
  if (!noPlan) state.token = `${now}-${process.pid}-${++plans}`
  saveKeepWarm(file, state)
  if (cameBack) recordCameBack(sessionName(input.session_id), was.idleSince)
  if (noPlan) return undefined
  // The status line may not have run yet for this answer. Then no end is saved, or one that has
  // passed, and the end is taken as 1 hour from now. An end of more than 1 hour ahead cannot be
  // true (it was given in another unit, for example), and counts as not saved. The hook could
  // not wait that long in any case.
  const until = s.cacheUntil > now && s.cacheUntil <= now + HOUR ? s.cacheUntil : now + HOUR
  return { waitMs: Math.max(shortestWait(k), until - k.before * 60e3 - now), token: state.token }
}

/**
 * How long the keep-warm hook has to wait on once its wait is over, in milliseconds. It is 0
 * when the time for the wake has come, and when this hook is no longer the one of the newest
 * plan.
 *
 * The end of the cache can have moved since the plan was made. The status line can run after
 * the hook has started, and it then saves the end that the answer gave. And a wake that just
 * happened gives the cache another hour, also while the status line has not saved that. Without
 * this look, the hook of a wake turn would wake the session again after 30 seconds, because its
 * plan was made with the end that the wake was for. So while the wake would come more than
 * `before` minutes ahead of the end, the hook waits on.
 */
export function keepWarmWait(sessionId, token, now = Date.now(), { cfg = config() } = {}) {
  const k = keepWarmConfig(cfg)
  const s = readJson(sessionFile(sessionId))
  if (!k.on || token === undefined || s?.keepWarm?.token !== token) return 0
  // An end that has passed, or that lies more than 1 hour ahead, says nothing: see keepWarmPlan.
  const ahead = (end) => end > now && end <= now + HOUR
  const until = Math.max(...[s.cacheUntil, s.keepWarm.wokeAt + HOUR].filter(ahead))
  const left = until - k.before * 60e3 - now
  // Less than a second is not worth another wait. Without an end that counts, `left` is no number.
  return left >= 1000 ? left : 0
}

/**
 * The second half of the keep-warm hook, when its wait is over: whether to wake the session now.
 * True only when all of these hold: keep-warm is still on, the plan of this hook is still the
 * newest one of the session (no answer came since), the status line wrote the session's file in
 * the last 5 minutes (the session is still open), the cache has not ended, the idle time is
 * still below the cap, and no limit of the plan is yellow or red on the status line. The plan
 * was made up to an hour ago, when the answer ended, and another session can have used the
 * limit since. So the limit is looked at again here, just before the wake spends some of it.
 * `env` stands in for the environment.
 *
 * When it is true, the wake is counted: in the record for the measure, and in the session's
 * file, where the hook of the wake turn and the status line read it. The record comes first.
 * When it cannot be written, this function throws, and the hook then ends without a wake. The
 * session's file must not say by then that the session was woken.
 */
export function keepWarmDue(sessionId, token, now = Date.now(), { cfg = config(), env = process.env } = {}) {
  const k = keepWarmConfig(cfg)
  if (!k.on || token === undefined) return false
  const file = sessionFile(sessionId)
  const s = readJson(file)
  const state = s?.keepWarm
  if (state?.token !== token) return false
  if (!(now - s.at <= SESSION_OPEN) || !(s.cacheUntil > now) || !(now - state.idleSince < k.capHours * HOUR)) return false
  if (limitHolds(s, {}, now, cfg, env)) return false
  // The wake reads the context as it is now. Without its size, it is the tokens to send again.
  recordWake({ session: sessionName(sessionId), project: s.project, model: s.model, idleSince: state.idleSince, ctx: s.ctx > 0 ? s.ctx : resendTokens(s.recache, s.ctx) })
  saveKeepWarm(file, { ...state, wokeAt: now, wakes: (state.wakes ?? 0) + 1 })
  return true
}

// A waiting hook looks this often whether a newer answer has made a newer plan. If so, it ends.
// Every answer starts a hook that waits for most of an hour, so without this look a busy session
// would leave a waiting process behind for each of its answers.
const LOOK_EVERY = 60e3

/** Waits for a number of milliseconds. */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether the plan with this token is still the newest one of the session. */
const newestPlan = (sessionId, token) => readJson(sessionFile(sessionId))?.keepWarm?.token === token

/**
 * The keep-warm hook as a whole: makes the plan, waits, and says whether to wake the session.
 * Returns the words for the model when the session is to be woken, else undefined. The command
 * writes those words to stderr and ends with exit code 2: that is what makes Claude Code start a
 * new turn in the idle session. `clock` and `sleep` stand in for the time and the wait in a test.
 */
export async function keepWarmHook(input, { clock = Date.now, sleep = pause, env = process.env } = {}) {
  const plan = keepWarmPlan(input, clock(), { env })
  if (!plan) return undefined
  // First the wait of the plan. Then any further wait, when the end of the cache has moved.
  for (let wait = plan.waitMs; wait > 0; wait = keepWarmWait(input.session_id, plan.token, clock())) {
    // A wait is made in steps of a minute at most. A hook that is no longer the newest one ends
    // after its step. It would do nothing at the end of its wait either.
    for (let left = wait; left > 0; left -= LOOK_EVERY) {
      await sleep(Math.min(left, LOOK_EVERY))
      if (!newestPlan(input.session_id, plan.token)) return undefined
    }
  }
  return keepWarmDue(input.session_id, plan.token, clock(), { env }) ? KEEP_WARM_WAKE : undefined
}
