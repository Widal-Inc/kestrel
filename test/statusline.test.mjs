// Tests for the status line and what it shares with the hooks. Run: node --test
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs, { chmodSync, closeSync, existsSync, ftruncateSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'kestrel-test-'))
// Kestrel also reads the config folders of Claude Code in the home folder, so the home folder is a
// made-up one too.
process.env.HOME = join(dir, 'person')
process.env.KESTREL_HOME = join(dir, 'home')
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
process.env.CODEX_HOME = join(dir, 'codex')
// Cowork's folder too: without this a test would read the real Cowork logs of whoever runs it.
process.env.KESTREL_COWORK_DIR = join(dir, 'cowork')
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })

const { coldStartHook, limitHook, modelSwitchHook, saveConfig, statusLine } = await import('../src/claude-code.mjs')
const { billing, readLimits, saveLimits } = await import('../src/billing.mjs')
const { installStatusLine, installed, setHook, uninstall } = await import('../src/install.mjs')
const { apply: applyAction, undo: undoAction, applied: appliedActions } = await import('../src/actions.mjs')
const { notify, nudgeConfig, nudgeDue, nudgeText } = await import('../src/nudge.mjs')

// The notifications that the status lines of a test wanted to show, each as [title, body].
const sent = []
// Each test gets its own empty folder for this tool's files, so that no test sees another's.
let homes = 0
const freshHome = () => {
  process.env.KESTREL_HOME = join(dir, `home-${++homes}`)
  sent.length = 0
}

const NOW = Date.parse('2026-11-12T12:00:00')
const MIN = 60e3
const HOUR = 3600e3
const DAY = 86400e3
/** A time as Claude Code gives it: in seconds. */
const sec = (ms) => Math.round(ms / 1000)

/**
 * Runs the command with this test's folders, and with no other variable of the real environment.
 * `input` is what the command gets on stdin. The command does not get the time zone of this run
 * either. A test that expects a clock time from the command gives it one, as `TZ` in `env`.
 * `more` are further options for the start of the command, such as a time after which it is ended.
 */
const BIN = fileURLToPath(new URL('../cli/kestrel.mjs', import.meta.url))
const exec = (args, env = {}, input, more = {}) => spawnSync(process.execPath, [BIN, ...args], {
  encoding: 'utf8', input, ...more,
  env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, KESTREL_HOME: process.env.KESTREL_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, ...env },
})
/** The same, as everything the command printed. */
function run(args, env, input) {
  const r = exec(args, env, input)
  return r.stdout + r.stderr
}
/**
 * What Claude Code gives the status line, with the fields of the capture of 13 Nov 2026 and made-up
 * values: a session of 4 hours with 527,119 tokens of context. A test changes the fields it is about.
 */
const session = (extra = {}) => ({
  session_id: 'one', cwd: '/work/repo',
  model: { id: 'claude-fable-5-2', display_name: 'Fable 5.2' },
  effort: { level: 'high' },
  cost: { total_cost_usd: 12.4, total_duration_ms: 4 * HOUR },
  context_window: {
    context_window_size: 1000000, used_percentage: 53,
    current_usage: { input_tokens: 2, output_tokens: 5502, cache_creation_input_tokens: 14608, cache_read_input_tokens: 512509 },
  },
  prompt_cache: { warm: true, ttl: '1h', expires_at: sec(NOW + 52 * MIN), recache_tokens_if_cold: 527119 },
  ...extra,
})
// Three of the five hours have gone, and 44% of the week.
const FIVE_HOUR = { used_percentage: 42, resets_at: sec(NOW + 2 * HOUR) }
const WEEK = { used_percentage: 36, resets_at: sec(NOW + 0.56 * 7 * DAY) }
const REST = 'cache warm, 52 min left | context 527k (53%) | effort high'

/**
 * The status line without colours and with an empty environment, so that no variable of the real
 * one decides how the person pays or whether there are colours. A notification is not shown: it
 * is added to `sent`.
 */
const line = (input, now = NOW, opts = {}) => statusLine(input, now, { env: {}, color: false, notify: (title, body) => sent.push([title, body]), layout: 'one', ...opts })
/** What the status line keeps about one session. */
const kept = (id) => JSON.parse(readFileSync(join(process.env.KESTREL_HOME, 'sessions', `${id}.json`), 'utf8'))

const TONES = { 32: 'good', 33: 'warn', 31: 'bad', 2: 'dim' }
/** The parts of a line with colours, each as [text, tone]. A part without a colour has no tone. */
const partsOf = (shown) => shown.split(' | ').map((part) => {
  const m = part.match(/^\x1b\[(\d+)m(.*)\x1b\[0m$/)
  return m ? [m[2], TONES[m[1]]] : [part, undefined]
})
/** The status line with colours, as its parts. */
const coloured = (input, now = NOW, opts = {}) => partsOf(line(input, now, { color: true, ...opts }))
/** A reading of a limit at NOW: the percent used, and the share of the window's time that has gone. */
const weekAt = (pct, gone) => ({ seven_day: { used_percentage: pct, resets_at: sec(NOW + (1 - gone) * 7 * DAY) } })
const fiveAt = (pct, gone) => ({ five_hour: { used_percentage: pct, resets_at: sec(NOW + (1 - gone) * 5 * HOUR) } })
/** The part for a limit, on its own: [text, tone]. */
const limitPart = (rate_limits) => {
  freshHome()
  return coloured(session({ rate_limits }))[0]
}

/** The text of every file in this tool's folder. */
const filesText = () => readdirSync(process.env.KESTREL_HOME, { recursive: true, withFileTypes: true })
  .filter((f) => f.isFile())
  .map((f) => readFileSync(join(f.parentPath ?? f.path, f.name), 'utf8'))
  .join('\n')

test('the hook asks once, and stays silent after the status line has run again', () => {
  freshHome()
  saveConfig({ limits: { session: 10, action: 'ask' } })
  const input = { session_id: 'asked', cost: { total_cost_usd: 12.5, total_duration_ms: 60000 } }
  statusLine(input, NOW, { layout: 'one' })
  assert.equal(limitHook({ session_id: 'asked' }, NOW).hookSpecificOutput.permissionDecision, 'ask')
  // The next answer costs 10 cents. The hook asks again only from $13.50 on (a tenth of the limit more).
  statusLine({ ...input, cost: { total_cost_usd: 12.6, total_duration_ms: 90000 } }, NOW + 30e3, { layout: 'one' })
  assert.equal(limitHook({ session_id: 'asked' }, NOW + 31e3), undefined)
  statusLine({ ...input, cost: { total_cost_usd: 13.6, total_duration_ms: 120000 } }, NOW + 60e3, { layout: 'one' })
  assert.equal(limitHook({ session_id: 'asked' }, NOW + 61e3).hookSpecificOutput.permissionDecision, 'ask')
})

test('a cost that is not a number does not break the day\'s total: the day\'s limit still stops the agent, and the line shows the amount', () => {
  freshHome()
  saveConfig({ plan: 'usage', limits: { day: 1, action: 'stop' } })
  // Claude Code gives numbers. An input that has changed gives text for one session.
  assert.equal(line({ session_id: 'p', cost: { total_cost_usd: 'abc', total_duration_ms: 'long' } }), '$0.00 session | today $0.00 of $1')
  assert.deepEqual([kept('p').cost, kept('p').dayStart], [0, 0])
  // Another session then spends $50. The day's total is that amount, not "not a number".
  const spender = { session_id: 'q', cost: { total_cost_usd: 50, total_duration_ms: MIN } }
  assert.equal(line(spender), '$50.00 session | today $50.00 of $1')
  const stop = limitHook({ session_id: 'q' }, NOW)
  assert.equal(stop.continue, false)
  assert.equal(stop.stopReason, 'Kestrel stopped the agent: today\'s spend is $50.00, and the day\'s limit is $1.00. Raise it with "kestrel limit", or turn it off with "kestrel limit --off".')
  // The same for a session's file that is broken: text, nothing, or a list where a number belongs.
  const sessions = join(process.env.KESTREL_HOME, 'sessions')
  for (const [id, broken] of [['r', { cost: '50', dayStart: 0 }], ['s', { cost: 3, dayStart: 'abc' }], ['t', { cost: null, dayStart: [] }], ['u', {}]]) {
    writeFileSync(join(sessions, `${id}.json`), JSON.stringify({ day: '2026-11-12', at: NOW, ...broken }))
  }
  // The session "s" counts with its $3: a start of the day that is not a number counts as 0.
  assert.equal(line(spender), '$50.00 session | today $53.00 of $1')
  assert.equal(limitHook({ session_id: 'q' }, NOW).continue, false)
  // The hook of a session whose own file is broken stops too, and does not fail.
  assert.equal(limitHook({ session_id: 'r' }, NOW).continue, false)
  // A limit per session: a cost that is text is no spend, also when the text is "50".
  saveConfig({ plan: 'usage', limits: { session: 10, action: 'ask' } })
  assert.equal(limitHook({ session_id: 'r' }, NOW), undefined)
  assert.equal(limitHook({ session_id: 'q' }, NOW).hookSpecificOutput.permissionDecision, 'ask')
  // A session's file that holds text or a list is broken as a whole. The next run writes a clean
  // one: no letter and no item of it becomes a field.
  for (const [id, broken] of [['v', '"abc"'], ['w', '[1,2]']]) {
    writeFileSync(join(sessions, `${id}.json`), broken)
    line({ session_id: id, cost: { total_cost_usd: 1, total_duration_ms: MIN } })
    assert.deepEqual(kept(id), { day: '2026-11-12', cost: 1, dayStart: 0, at: NOW, billing: 'usage' })
  }
  // The next day begins for the session with the broken cost: its start of the day is 0, and the line still works.
  assert.equal(line({ session_id: 'r', cost: { total_cost_usd: 2, total_duration_ms: 2 * DAY } }, NOW + DAY), '$2.00 session, $0.04 per hour | today $2.00 | limit $10')
})

test('the status line prints no control characters from Claude Code\'s input: the effort level, the cause of a lost cache and the folder', () => {
  freshHome()
  saveConfig({ nudge: { on: true } })
  // An escape code that sets the title of the terminal, a colour code, a line break, and the 8 bit start of an escape code.
  const input = session({
    cwd: '/a/\x1b[31mRED\x1b]0;PWN\x07/pr\noj',
    effort: { level: 'hi\x1b]0;PWN\x07gh\nmore' },
    rate_limits: { seven_day: WEEK },
    prompt_cache: { warm: true, ttl: '1h', expires_at: sec(NOW + 4 * MIN), recache_tokens_if_cold: 527119, last_miss_at: sec(NOW - MIN), last_miss_cause: { causes: ['odd\x1b[31m_cause\x9b'] } },
  })
  assert.equal(line(input), 'week 36% used, 44% of the week gone | cache warm, 4 min left | cache lost: odd[31m cause | context 527k (53%) | effort hi]0;PWNghmore')
  // With colours on, the only escape codes on the line are this tool's own colours.
  const inColour = line(input, NOW, { color: true })
  assert.match(inColour, /\x1b\[33mcache lost: odd\[31m cause\x1b\[0m/)
  assert.doesNotMatch(inColour.replace(/\x1b\[(0|2|31|32|33)m/g, ''), /[\x00-\x1f\x7f-\x9f]/)
  // The short name of the folder is kept without them, and so it is in the title of the notification.
  assert.equal(kept('one').project, '[31mRED]0;PWN/proj')
  assert.deepEqual(sent.map(([title]) => title), ['kestrel: [31mRED]0;PWN/proj cache ends at 12:04'])
  // An effort level that is not text does not break the line.
  assert.match(line(session({ effort: { level: 3 } })), / \| effort 3$/)
  // The hook before a change of model names the two models in its message, without them too.
  const switched = modelSwitchHook({ estimated_cache_write_usd: 2.5, from_model: 'claude-opus\x1b[2J-5-5', to_model: 'claude-fable\n\x9b31m-5-2', context_tokens: 400000, pricing: 'catalog' }, {})
  assert.equal(switched.systemMessage, 'kestrel: a switch from opus[2J-5-5 to fable31m-5-2 sends the whole context (400k tokens) to the new model again. That costs about $2.50 (at list prices).')
  // A model that is not text is "?" in that message.
  assert.match(modelSwitchHook({ estimated_cache_write_usd: 2.5, from_model: 5, to_model: { id: 'x' } }, {}).systemMessage, /^kestrel: a switch from \? to \? sends the whole context /)
})

test('billing: a plan set by hand wins over every other sign', () => {
  freshHome()
  const subscriber = { rate_limits: { seven_day: { used_percentage: 56, resets_at: sec(NOW + 3 * DAY) } } }
  assert.deepEqual(billing(subscriber, { env: {}, cfg: { plan: 'usage' }, now: NOW }), { mode: 'usage', sure: true, why: 'set by hand' })
  assert.deepEqual(billing({}, { env: { ANTHROPIC_API_KEY: 'a-key' }, cfg: { plan: 'subscription' }, now: NOW }), { mode: 'subscription', sure: true, why: 'set by hand' })
  // Any other value is not a plan: the next rules decide.
  assert.equal(billing(subscriber, { env: {}, cfg: { plan: 'auto' }, now: NOW }).why, "Claude Code reports the plan's limits")
})

test('billing: a session that is given the plan\'s limits is on a subscription', () => {
  freshHome()
  const expected = { mode: 'subscription', sure: true, why: "Claude Code reports the plan's limits" }
  assert.deepEqual(billing({ rate_limits: { seven_day: { used_percentage: 56, resets_at: sec(NOW + 3 * DAY) } } }, { env: {}, cfg: {}, now: NOW }), expected)
  assert.deepEqual(billing({ rate_limits: { five_hour: { used_percentage: 3, resets_at: sec(NOW + HOUR) } } }, { env: {}, cfg: {}, now: NOW }), expected)
  // The limits say more than an API key that is also set.
  assert.deepEqual(billing({ rate_limits: { five_hour: { used_percentage: 3, resets_at: sec(NOW + HOUR) } } }, { env: { ANTHROPIC_API_KEY: 'a-key' }, cfg: {}, now: NOW }), expected)
  // An empty "rate_limits" is no sign of a plan.
  assert.equal(billing({ rate_limits: {} }, { env: {}, cfg: {}, now: NOW }).sure, false)
})

test('billing: a cloud provider or an API key in the environment means paying by the token', () => {
  freshHome()
  for (const name of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE']) {
    assert.deepEqual(billing({}, { env: { [name]: '1' }, cfg: {}, now: NOW }), { mode: 'usage', sure: true, why: 'a cloud provider is set in the environment' }, name)
  }
  assert.deepEqual(billing({}, { env: { ANTHROPIC_API_KEY: 'a-key' }, cfg: {}, now: NOW }), { mode: 'usage', sure: true, why: 'an API key is set in the environment' })
  // A variable that is set but empty does not count.
  assert.equal(billing({}, { env: { ANTHROPIC_API_KEY: '', CLAUDE_CODE_USE_BEDROCK: '' }, cfg: {}, now: NOW }).sure, false)
  // These signs say more than limits that another session saved earlier.
  saveLimits({ seven_day: { used_percentage: 56, resets_at: sec(NOW + 3 * DAY) } }, NOW - HOUR)
  assert.equal(billing({}, { env: { ANTHROPIC_API_KEY: 'a-key' }, cfg: {}, now: NOW }).mode, 'usage')
})

test('billing: limits seen on this machine in the last 24 hours mean a subscription', () => {
  freshHome()
  saveLimits({ seven_day: { used_percentage: 56, resets_at: sec(NOW + 3 * DAY) } }, NOW)
  const expected = { mode: 'subscription', sure: true, why: "the plan's limits were seen on this machine today" }
  assert.deepEqual(billing({}, { env: {}, cfg: {}, now: NOW + 23 * HOUR }), expected)
  // A day later the reading is too old to say how the person pays now.
  assert.equal(billing({}, { env: {}, cfg: {}, now: NOW + 25 * HOUR }).sure, false)
  // A reading of a window that has ended does not count either.
  freshHome()
  saveLimits({ five_hour: { used_percentage: 20, resets_at: sec(NOW + HOUR) } }, NOW)
  assert.deepEqual(billing({}, { env: {}, cfg: {}, now: NOW + 30 * MIN }), expected)
  assert.equal(billing({}, { env: {}, cfg: {}, now: NOW + 2 * HOUR }).sure, false)
})

test('billing: with no sign of a plan it is paying by the token, and not sure', () => {
  freshHome()
  assert.deepEqual(billing({}, { env: {}, cfg: {}, now: NOW }), { mode: 'usage', sure: false, why: 'no sign of a plan, so figures are list prices' })
  assert.deepEqual(billing(undefined, { env: {}, cfg: {}, now: NOW }).mode, 'usage')
})

test('the plan\'s limits: the first reading is saved, and so is one that comes after the saved window has ended', () => {
  freshHome()
  assert.deepEqual(readLimits(NOW), {})
  // With nothing saved, a reading of a window that has ended writes no file.
  saveLimits({ five_hour: { used_percentage: 99, resets_at: sec(NOW - HOUR) } }, NOW)
  assert.equal(existsSync(join(process.env.KESTREL_HOME, 'limits.json')), false)
  saveLimits({ five_hour: { used_percentage: 42, resets_at: sec(NOW + 2 * HOUR) }, seven_day: { used_percentage: 56, resets_at: sec(NOW + 3 * DAY) } }, NOW)
  assert.deepEqual(readLimits(NOW), {
    five: { pct: 42, resetsAt: NOW + 2 * HOUR, at: NOW },
    week: { pct: 56, resetsAt: NOW + 3 * DAY, at: NOW },
  })
  // Three hours later the 5 hour window has ended: it is no longer given.
  const later = NOW + 3 * HOUR
  assert.deepEqual(Object.keys(readLimits(later)), ['week'])
  // An idle session still gives a reading of that ended window. It says nothing about now, so it
  // is not saved: the file stays as it was.
  const file = join(process.env.KESTREL_HOME, 'limits.json')
  const before = readFileSync(file, 'utf8')
  saveLimits({ five_hour: { used_percentage: 99, resets_at: sec(NOW + 2 * HOUR - 30e3) } }, later)
  assert.deepEqual(Object.keys(readLimits(later)), ['week'])
  assert.equal(readFileSync(file, 'utf8'), before)
  // A reading of the window that runs now is saved, although its percent is lower.
  saveLimits({ five_hour: { used_percentage: 5, resets_at: sec(later + 4 * HOUR) } }, later)
  assert.deepEqual(readLimits(later).five, { pct: 5, resetsAt: later + 4 * HOUR, at: later })
})

test('the plan\'s limits: a reading of a later window replaces the saved one', () => {
  freshHome()
  saveLimits({ seven_day: { used_percentage: 90, resets_at: sec(NOW + 5 * MIN) } }, NOW)
  // Another session already has the next week's reading, before this window has ended.
  saveLimits({ seven_day: { used_percentage: 2, resets_at: sec(NOW + 5 * MIN + 7 * DAY) } }, NOW + MIN)
  assert.deepEqual(readLimits(NOW + MIN).week, { pct: 2, resetsAt: NOW + 5 * MIN + 7 * DAY, at: NOW + MIN })
  // 61 seconds later is a later window, 60 seconds is the same one.
  freshHome()
  saveLimits({ five_hour: { used_percentage: 50, resets_at: sec(NOW + HOUR) } }, NOW)
  saveLimits({ five_hour: { used_percentage: 40, resets_at: sec(NOW + HOUR + 60e3) } }, NOW + MIN)
  assert.equal(readLimits(NOW + MIN).five.pct, 50)
  saveLimits({ five_hour: { used_percentage: 40, resets_at: sec(NOW + HOUR + 61e3) } }, NOW + MIN)
  assert.equal(readLimits(NOW + MIN).five.pct, 40)
})

test('the plan\'s limits: in the same window a higher percent replaces the saved one', () => {
  freshHome()
  saveLimits({ seven_day: { used_percentage: 36, resets_at: sec(NOW + 3 * DAY) } }, NOW)
  // The end time of the same window can differ by a few seconds between two sessions.
  saveLimits({ seven_day: { used_percentage: 57, resets_at: sec(NOW + 3 * DAY - 20e3) } }, NOW + MIN)
  assert.deepEqual(readLimits(NOW + MIN).week, { pct: 57, resetsAt: NOW + 3 * DAY - 20e3, at: NOW + MIN })
})

test('the plan\'s limits: an old reading from an idle session does not replace the saved one', () => {
  freshHome()
  saveLimits({ five_hour: { used_percentage: 30, resets_at: sec(NOW + 2 * HOUR) }, seven_day: { used_percentage: 57, resets_at: sec(NOW + 3 * DAY) } }, NOW)
  const saved = readLimits(NOW)
  // The same window with a lower percent, and with the same percent: "at" stays the first sight.
  saveLimits({ seven_day: { used_percentage: 36, resets_at: sec(NOW + 3 * DAY) } }, NOW + MIN)
  saveLimits({ seven_day: { used_percentage: 57, resets_at: sec(NOW + 3 * DAY) } }, NOW + 2 * MIN)
  // An earlier window, with a higher percent.
  saveLimits({ five_hour: { used_percentage: 99, resets_at: sec(NOW + 2 * HOUR - 5 * HOUR) } }, NOW + 3 * MIN)
  assert.deepEqual(readLimits(NOW + 3 * MIN), saved)
  // A reading without a percent or without an end time cannot be placed in a window: it is left out.
  saveLimits({ five_hour: { used_percentage: 99 }, seven_day: { resets_at: sec(NOW + 9 * DAY) } }, NOW + 4 * MIN)
  saveLimits(undefined, NOW + 4 * MIN)
  assert.deepEqual(readLimits(NOW + 4 * MIN), saved)
})

test('the value of an environment variable never appears in an answer, in the output or in a file', () => {
  freshHome()
  const secret = 'sk-test-0123456789-never-shown'
  const env = { ANTHROPIC_API_KEY: secret, CLAUDE_CODE_USE_BEDROCK: `${secret}-2` }
  saveLimits({ seven_day: { used_percentage: 56, resets_at: sec(NOW + 3 * DAY) } }, NOW)
  assert.doesNotMatch(JSON.stringify(billing({}, { env, cfg: {}, now: NOW })), /sk-test/)
  assert.doesNotMatch(JSON.stringify(billing({}, { env: { ANTHROPIC_API_KEY: secret }, cfg: {}, now: NOW })), /sk-test/)
  const shown = line(session(), NOW, { env }) + line(session({ rate_limits: { seven_day: WEEK } }), NOW, { env })
  assert.match(shown, /^\$12\.40 session/)
  assert.doesNotMatch(shown, /sk-test/)
  const plan = run(['plan'], env)
  assert.match(plan, /usage, paid by the token \(a cloud provider is set in the environment\)/)
  const out = plan + run(['status'], env) + run(['plan', 'usage'], env) + run(['plan', 'auto'], env)
  assert.doesNotMatch(out, /sk-test/)
  assert.doesNotMatch(filesText(), /sk-test/)
})

test('"kestrel plan" shows how the person pays, sets it by hand and takes that back, and "status" has a row for it', () => {
  freshHome()
  assert.match(run(['plan']), /^Billing: usage, paid by the token, not sure \(no sign of a plan, so figures are list prices\)\n/)
  assert.match(run(['plan'], { ANTHROPIC_API_KEY: 'a-key' }), /^Billing: usage, paid by the token \(an API key is set in the environment\)\n/)
  assert.match(run(['plan', 'subscription']), /Billing: subscription \(set by hand\)/)
  assert.equal(JSON.parse(readFileSync(join(process.env.KESTREL_HOME, 'config.json'), 'utf8')).plan, 'subscription')
  assert.match(run(['plan']), /^Billing: subscription \(set by hand\)\n/)
  assert.match(run(['status']), /^Billing +subscription \(set by hand\)$/m)
  assert.match(run(['plan', 'usage']), /Billing: usage, paid by the token \(set by hand\)/)
  // "auto" removes the choice. Other settings stay.
  saveConfig({ plan: 'usage', limits: { day: 200, action: 'warn' } })
  assert.match(run(['plan', 'auto']), /no longer set by hand\. Billing: usage, paid by the token, not sure/)
  assert.deepEqual(JSON.parse(readFileSync(join(process.env.KESTREL_HOME, 'config.json'), 'utf8')), { limits: { day: 200, action: 'warn' } })
  assert.match(run(['plan', 'monthly']), /The plan is one of subscription, usage, auto\./)
})

test('on a subscription the line shows both limits, the cache, the context and the effort, and no dollars', () => {
  freshHome()
  const shown = line(session({ rate_limits: { five_hour: FIVE_HOUR, seven_day: WEEK } }))
  assert.equal(shown, `5 hour limit 42% used, 60% of its time gone | week 36% used, 44% of the week gone | ${REST}`)
  assert.doesNotMatch(shown, /\$/)
  // The share of time gone stays between 0 and 100, also for an end time that is a little further
  // away than the window is long.
  freshHome()
  assert.match(line(session({ rate_limits: { five_hour: { used_percentage: 1, resets_at: sec(NOW + 5 * HOUR + 5 * MIN) } } })), /^5 hour limit 1% used, 0% of its time gone \|/)
  assert.match(line(session({ rate_limits: { seven_day: { used_percentage: 99.6, resets_at: sec(NOW + 1e3) } } })), /\| week 100% used, 100% of the week gone \|/)
})

test('a session that was idle until its limits\' windows ended does not show its old percent', () => {
  freshHome()
  const idle = session({ rate_limits: { five_hour: { used_percentage: 97, resets_at: sec(NOW - HOUR) }, seven_day: { used_percentage: 80, resets_at: sec(NOW) } } })
  assert.equal(line(idle), `plan limits not reported yet | ${REST}`)
  // Another session has a reading of the week that runs now.
  line(session({ session_id: 'busy', rate_limits: { seven_day: { used_percentage: 3, resets_at: sec(NOW + 6.5 * DAY) } } }))
  assert.equal(line(idle), `week 3% used, 7% of the week gone | ${REST}`)
})

test('with the weekly limit only, the line has one part for the limits', () => {
  freshHome()
  const shown = line(session({ rate_limits: { seven_day: WEEK } }))
  assert.equal(shown, `week 36% used, 44% of the week gone | ${REST}`)
  assert.doesNotMatch(shown, /\$/)
})

test('a session with no limits of its own shows the reading that another session saved today', () => {
  freshHome()
  // Nothing was seen yet, and the person says it is a subscription.
  saveConfig({ plan: 'subscription' })
  assert.equal(line(session({ session_id: 'new' })), `plan limits not reported yet | ${REST}`)
  saveConfig({})
  line(session({ rate_limits: { five_hour: FIVE_HOUR, seven_day: WEEK } }))
  // A new session has no "rate_limits" before its first answer.
  const shown = line(session({ session_id: 'new' }), NOW + MIN)
  assert.equal(shown, `5 hour limit 42% used, 60% of its time gone | week 36% used, 44% of the week gone | cache warm, 51 min left | context 527k (53%) | effort high`)
  assert.doesNotMatch(shown, /\$/)
})

test('a percent that comes without an end time is shown as it is, and is not saved', () => {
  freshHome()
  assert.equal(line(session({ rate_limits: { seven_day: { used_percentage: 56 } } })), `week 56% used | ${REST}`)
  assert.deepEqual(readLimits(NOW), {})
  // A saved reading of the same limit is shown instead.
  line(session({ rate_limits: { seven_day: WEEK } }))
  assert.match(line(session({ rate_limits: { seven_day: { used_percentage: 56 } } })), /^week 36% used, 44% of the week gone \|/)
})

test('with an API key the line shows dollars: the session, its spend per hour, the cache and today', () => {
  freshHome()
  const env = { ANTHROPIC_API_KEY: 'a-key' }
  assert.equal(line(session(), NOW, { env }), '$12.40 session, $3.10 per hour | cache warm, 52 min left, then $8.43 | context 527k (53%) | effort high | today $12.40')
  // A session of under 10 minutes has no spend per hour.
  const young = session({ session_id: 'young', cost: { total_cost_usd: 0.5, total_duration_ms: 10 * MIN - 1 } })
  assert.match(line(young, NOW, { env }), /^\$0\.50 session \| cache warm/)
  assert.match(line({ ...young, cost: { total_cost_usd: 0.5, total_duration_ms: 10 * MIN } }, NOW, { env }), /^\$0\.50 session, \$3\.00 per hour \| cache warm/)
})

test('when nothing says how the person pays, the line shows dollars and says that they are list prices', () => {
  freshHome()
  assert.equal(line(session()), '$12.40 session, $3.10 per hour (list prices) | cache warm, 52 min left, then $8.43 | context 527k (53%) | effort high | today $12.40')
  assert.match(line(session({ session_id: 'young', cost: { total_cost_usd: 0.5, total_duration_ms: MIN } })), /^\$0\.50 session \(list prices\) \|/)
  // An input with nothing in it still gives a line.
  freshHome()
  assert.equal(line({}), '$0.00 session (list prices) | today $0.00')
})

test('a plan set by hand decides what the line shows', () => {
  freshHome()
  saveConfig({ plan: 'usage' })
  const shown = line(session({ rate_limits: { seven_day: WEEK } }))
  assert.match(shown, /^\$12\.40 session, \$3\.10 per hour \| /)
  assert.doesNotMatch(shown, /% used/)
  // The reading is still saved, for the sessions that show it.
  assert.equal(readLimits(NOW).week.pct, 36)
  saveConfig({ plan: 'subscription' })
  assert.equal(line(session(), NOW, { env: { ANTHROPIC_API_KEY: 'a-key' } }), `week 36% used, 44% of the week gone | ${REST}`)
})

test('on a subscription a limit set in dollars is the only dollar amount on the line', () => {
  freshHome()
  const input = session({ rate_limits: { seven_day: WEEK } })
  line(session({ session_id: 'other', cost: { total_cost_usd: 7.73, total_duration_ms: HOUR } }))
  saveConfig({ limits: { session: 50, action: 'ask' } })
  assert.equal(line(input), `week 36% used, 44% of the week gone | ${REST} | limit $50 per session at list prices, $12.40 so far`)
  saveConfig({ limits: { day: 200, action: 'ask' } })
  assert.equal(line(input), `week 36% used, 44% of the week gone | ${REST} | limit $200 per day at list prices, $20.13 so far`)
  saveConfig({ limits: { session: 7.5, day: 1500, action: 'ask' } })
  const both = line(input)
  assert.equal(both, `week 36% used, 44% of the week gone | ${REST} | limit $7.50 per session at list prices, $12.40 so far | limit $1,500 per day at list prices, $20.13 so far`)
  // Without the two parts for the limits in dollars there is no dollar sign.
  assert.doesNotMatch(both.split(' | ').filter((part) => !part.startsWith('limit $')).join(' | '), /\$/)
})

test('by the token the line ends with today\'s spend, the day\'s limit and the session\'s limit', () => {
  freshHome()
  const env = { ANTHROPIC_API_KEY: 'a-key' }
  line(session({ session_id: 'other', cost: { total_cost_usd: 7.73, total_duration_ms: HOUR } }), NOW, { env })
  assert.match(line(session(), NOW, { env }), /\| effort high \| today \$20\.13$/)
  saveConfig({ limits: { day: 200, action: 'ask' } })
  assert.match(line(session(), NOW, { env }), /\| effort high \| today \$20\.13 of \$200$/)
  saveConfig({ limits: { session: 50, day: 200, action: 'ask' } })
  assert.match(line(session(), NOW, { env }), /\| effort high \| today \$20\.13 of \$200 \| limit \$50$/)
})

test('the cache part on a subscription: the time left, warm, or gone with the tokens to send again', () => {
  freshHome()
  const cache = (prompt_cache) => line(session({ rate_limits: { seven_day: WEEK }, prompt_cache })).split(' | ')[1]
  // Minutes are rounded up. From 90 minutes on the time is in hours.
  assert.equal(cache({ warm: true, expires_at: sec(NOW + 51 * MIN + 10e3) }), 'cache warm, 52 min left')
  assert.equal(cache({ warm: true, expires_at: sec(NOW + 1e3) }), 'cache warm, 1 min left')
  assert.equal(cache({ warm: true, expires_at: sec(NOW + 89 * MIN) }), 'cache warm, 89 min left')
  assert.equal(cache({ warm: true, expires_at: sec(NOW + 90 * MIN) }), 'cache warm, 1.5 hours left')
  assert.equal(cache({ warm: true, expires_at: sec(NOW + 3 * HOUR) }), 'cache warm, 3.0 hours left')
  assert.equal(cache({ warm: true }), 'cache warm')
  // Gone: the end has passed, or Claude Code says that the cache is not warm.
  assert.equal(cache({ warm: true, expires_at: sec(NOW), recache_tokens_if_cold: 527119 }), 'cache gone: the next call re-sends 527k')
  assert.equal(cache({ warm: true, expires_at: sec(NOW - HOUR), recache_tokens_if_cold: 300000 }), 'cache gone: the next call re-sends 300k')
  assert.equal(cache({ warm: false, expires_at: sec(NOW + 30 * MIN), recache_tokens_if_cold: 300000 }), 'cache gone: the next call re-sends 300k')
  // Without the number of tokens to send again, it is the size of the context.
  assert.equal(cache({ warm: false }), 'cache gone: the next call re-sends 527k')
  // When Claude Code says nothing about the cache, the line says nothing about it either.
  assert.equal(cache(undefined), 'context 527k (53%)')
  assert.equal(cache({ ttl: '1h' }), 'context 527k (53%)')
  // Without a context size there is no part for the cache and none for the context.
  assert.equal(line(session({ rate_limits: { seven_day: WEEK }, context_window: {} })), 'week 36% used, 44% of the week gone | effort high')
})

test('the cache part by the token: the time left and the price after it, the least the next call costs, or gone with its price', () => {
  freshHome()
  // 400,000 tokens of context on Claude Opus 5.5: $0.20 per million read from the cache, $8 written for 1 hour, $5 for 5 minutes.
  const input = {
    session_id: 'opus', model: { id: 'claude-opus-5-5' },
    cost: { total_cost_usd: 12.5, total_duration_ms: 60000 },
    context_window: { used_percentage: 40, current_usage: { input_tokens: 10, cache_creation_input_tokens: 990, cache_read_input_tokens: 399000 } },
  }
  const env = { ANTHROPIC_API_KEY: 'a-key' }
  assert.equal(line(input, NOW, { env }), '$12.50 session | next call at least $0.08 | context 400k (40%) | today $12.50')
  const cache = (prompt_cache, extra = {}) => line({ ...input, ...extra, prompt_cache }, NOW, { env }).split(' | ')[1]
  assert.equal(cache({ warm: true }), 'next call at least $0.08')
  assert.equal(cache({ warm: true, ttl: '1h', expires_at: sec(NOW + 30 * MIN) }), 'cache warm, 30 min left, then $3.20')
  assert.equal(cache({ warm: true, ttl: '5m', expires_at: sec(NOW + 4 * MIN) }), 'cache warm, 4 min left, then $2.00')
  assert.equal(cache({ warm: false, ttl: '5m', expires_at: sec(NOW - MIN) }), 'cache gone, next call about $2.00')
  assert.equal(cache({ warm: false, ttl: '1h' }), 'cache gone, next call about $3.20')
  // A model with no price has no dollar figure. The part then gives the time and the tokens.
  const unknown = { model: { id: 'some-new-model' } }
  assert.equal(cache({ warm: true, expires_at: sec(NOW + 30 * MIN) }, unknown), 'cache warm, 30 min left')
  assert.equal(cache({ warm: false }, unknown), 'cache gone: the next call re-sends 400k')
  assert.equal(cache(undefined, unknown), 'context 400k (40%)')
})

test('the session\'s file keeps the day\'s figures, and a session that began yesterday counts from its first sight', () => {
  freshHome()
  const env = { ANTHROPIC_API_KEY: 'a-key' }
  // The state of the cache is in the file too, and the two sizes of the context that the hint
  // to compact goes by. They are the same in every run of this test.
  const cache = { cacheUntil: NOW + 52 * MIN, ttl: '1h', recache: 527119, ctx: 527119, project: 'work/repo', model: 'claude-fable-5-2', compactBase: 527119, ctxSeen: 527119 }
  // The session began 20 hours before noon: what it had spent by now is not today's spend.
  const long = (cost, minutes) => session({ session_id: 'long', cost: { total_cost_usd: cost, total_duration_ms: 20 * HOUR + minutes * MIN } })
  assert.match(line(long(40, 0), NOW, { env }), /\| today \$0\.00$/)
  assert.deepEqual(kept('long'), { day: '2026-11-12', cost: 40, dayStart: 40, at: NOW, billing: 'usage', ...cache })
  assert.match(line(long(41.5, 5), NOW + 5 * MIN, { env }), /\| today \$1\.50$/)
  assert.deepEqual(kept('long'), { day: '2026-11-12', cost: 41.5, dayStart: 40, at: NOW + 5 * MIN, billing: 'usage', ...cache })
  // The next day starts from what the session had spent by then. The same holds on a subscription.
  line({ ...long(45, 24 * 60), rate_limits: { seven_day: WEEK } }, NOW + DAY)
  assert.deepEqual(kept('long'), { day: '2026-11-13', cost: 45, dayStart: 41.5, at: NOW + DAY, billing: 'subscription', ...cache })
})

test('the session\'s file keeps how the person pays and the state of the cache, and no text of the session but the folder\'s short name', () => {
  freshHome()
  const input = session({
    session_name: 'a private name', transcript_path: '/private/place/one.jsonl', cwd: '/home/someone/work/repo',
    prompt_cache: { warm: true, ttl: '5m', expires_at: sec(NOW + 4 * MIN), recache_tokens_if_cold: 300000 },
  })
  line(input)
  // This input names a log, so the first run looked at it for the hint about the effort level.
  // The time of that look is kept. The log does not exist, so there is no text of a hint.
  const hint = { at: NOW }
  // The two sizes of the context that the hint to compact goes by are kept too.
  const sizes = { compactBase: 527119, ctxSeen: 527119 }
  assert.deepEqual(kept('one'), { day: '2026-11-12', cost: 12.4, dayStart: 0, at: NOW, billing: 'usage', cacheUntil: NOW + 4 * MIN, ttl: '5m', recache: 300000, ctx: 527119, project: 'work/repo', model: 'claude-fable-5-2', hint, ...sizes })
  assert.doesNotMatch(filesText(), /private|someone/)
  // The tokens to send again, the size of the context, the folder and the model are what Claude
  // Code says now: one that the next input does not have is taken out, so that no hook works
  // with an old one. The end of the cache stays, and with it how long the cache lasts. The two
  // sizes for the hint to compact stay as well: no hook works with them.
  line({ ...input, cwd: undefined, model: undefined, context_window: {}, prompt_cache: { warm: true } }, NOW + MIN)
  assert.deepEqual(kept('one'), { day: '2026-11-12', cost: 12.4, dayStart: 0, at: NOW + MIN, billing: 'usage', cacheUntil: NOW + 4 * MIN, ttl: '5m', hint, ...sizes })
  // Another end takes the place of the saved one. How long that cache lasts is then what the input says.
  line({ ...input, cwd: undefined, model: undefined, context_window: {}, prompt_cache: { warm: true, expires_at: sec(NOW + HOUR) } }, NOW + MIN)
  assert.deepEqual(kept('one'), { day: '2026-11-12', cost: 12.4, dayStart: 0, at: NOW + MIN, billing: 'usage', cacheUntil: NOW + HOUR, hint, ...sizes })
  // How the person pays is what the line shows.
  line({ ...input, rate_limits: { seven_day: WEEK } }, NOW + MIN)
  assert.equal(kept('one').billing, 'subscription')
  saveConfig({ plan: 'usage' })
  line({ ...input, rate_limits: { seven_day: WEEK } }, NOW + MIN)
  assert.equal(kept('one').billing, 'usage')
  // What the hooks keep in the same file stays.
  saveConfig({ limits: { session: 10, action: 'ask' } })
  assert.ok(limitHook({ session_id: 'one' }, NOW + MIN))
  line(input, NOW + 2 * MIN)
  assert.equal(kept('one').askedAt, 12.4)
  assert.equal(kept('one').cacheUntil, NOW + 4 * MIN)
})

test('a limit is green, yellow from 75% used, and red from 90% used', () => {
  assert.deepEqual(limitPart(weekAt(74, 0.9)), ['week 74% used, 90% of the week gone', 'good'])
  assert.deepEqual(limitPart(weekAt(75, 0.9)), ['week 75% used, 90% of the week gone', 'warn'])
  assert.deepEqual(limitPart(weekAt(89, 0.95)), ['week 89% used, 95% of the week gone', 'warn'])
  assert.deepEqual(limitPart(weekAt(90, 0.95)), ['week 90% used, 95% of the week gone', 'bad'])
  assert.deepEqual(limitPart(fiveAt(74, 0.9)), ['5 hour limit 74% used, 90% of its time gone', 'good'])
  assert.deepEqual(limitPart(fiveAt(75, 0.9)), ['5 hour limit 75% used, 90% of its time gone', 'warn'])
  assert.deepEqual(limitPart(fiveAt(90, 0.95)), ['5 hour limit 90% used, 95% of its time gone', 'bad'])
  // A percent without an end time has the tone of the percent alone.
  assert.deepEqual(limitPart({ seven_day: { used_percentage: 92 } }), ['week 92% used', 'bad'])
  // The note that no limit is known has no colour.
  freshHome()
  saveConfig({ plan: 'subscription' })
  assert.deepEqual(coloured(session())[0], ['plan limits not reported yet', undefined])
})

test('the weekly limit on pace to be full before its reset: how much earlier, yellow, and red when that is within a day', () => {
  // 56% used after 44% of the week: at this pace the week is full after 5.5 of its 7 days.
  assert.deepEqual(limitPart(weekAt(56, 0.44)), ['week 56% used, 44% of the week gone: full about 1.5 days early', 'warn'])
  // Under one day it is said in hours: full after 163 of the 168 hours, after 167, and after 145.
  assert.deepEqual(limitPart(weekAt(60, 97.8 / 168)), ['week 60% used, 58% of the week gone: full about 5 hours early', 'warn'])
  assert.deepEqual(limitPart(weekAt(50, 83.5 / 168)), ['week 50% used, 50% of the week gone: full about 1 hour early', 'warn'])
  assert.deepEqual(limitPart(weekAt(50, 72.5 / 168)), ['week 50% used, 43% of the week gone: full about 23 hours early', 'warn'])
  // From one day on it is said in days, with one decimal, and without a ".0".
  // 70% used after 2.1 days: full after 3 days, which is 0.9 days from now.
  assert.deepEqual(limitPart(weekAt(70, 0.3)), ['week 70% used, 30% of the week gone: full about 4 days early', 'bad'])
  // 70% used after 4.2 days: full after 6 days, which is 1.8 days from now.
  assert.deepEqual(limitPart(weekAt(70, 0.6)), ['week 70% used, 60% of the week gone: full about 1 day early', 'warn'])
  // 50% used after 2.5 days: full after 5 days.
  assert.deepEqual(limitPart(weekAt(50, 2.5 / 7)), ['week 50% used, 36% of the week gone: full about 2 days early', 'warn'])
  // 23.6 hours early is 1.0 days when it is rounded: "1 day", not "24 hours".
  assert.deepEqual(limitPart(weekAt(50, 72.2 / 168)), ['week 50% used, 43% of the week gone: full about 1 day early', 'warn'])
  // Use that keeps below the pace of the week says nothing more.
  assert.deepEqual(limitPart(weekAt(44, 0.44)), ['week 44% used, 44% of the week gone', 'good'])
})

test('the 5 hour limit on pace to be full before its reset: how much earlier, yellow, and red when that is within 30 minutes', () => {
  // 50% used after 130 minutes: full after 260 of the 300 minutes.
  assert.deepEqual(limitPart(fiveAt(50, 130 / 300)), ['5 hour limit 50% used, 43% of its time gone: full about 40 min early', 'warn'])
  // Under 90 minutes it is said in minutes, from 90 minutes on in hours with one decimal.
  // 50% used after 105.5 minutes: full after 211 minutes. After 105 minutes: full after 210.
  assert.deepEqual(limitPart(fiveAt(50, 105.5 / 300)), ['5 hour limit 50% used, 35% of its time gone: full about 89 min early', 'warn'])
  assert.deepEqual(limitPart(fiveAt(50, 105 / 300)), ['5 hour limit 50% used, 35% of its time gone: full about 1.5 hours early', 'warn'])
  // 70% used after 60 minutes: full after 86 minutes, which is 26 minutes from now and 214 minutes early.
  assert.deepEqual(limitPart(fiveAt(70, 0.2)), ['5 hour limit 70% used, 20% of its time gone: full about 3.6 hours early', 'bad'])
  // 60% used after 100 minutes: full after 167 minutes, which is 67 minutes from now and 133 minutes early.
  assert.deepEqual(limitPart(fiveAt(60, 100 / 300)), ['5 hour limit 60% used, 33% of its time gone: full about 2.2 hours early', 'warn'])
  // 50% used after 60 minutes: full after 120 minutes, which is 180 minutes early.
  assert.deepEqual(limitPart(fiveAt(50, 0.2)), ['5 hour limit 50% used, 20% of its time gone: full about 3.0 hours early', 'warn'])
})

test('the pace is left out in the first tenth of a window', () => {
  assert.deepEqual(limitPart(fiveAt(20, 0.05)), ['5 hour limit 20% used, 5% of its time gone', 'good'])
  assert.deepEqual(limitPart(weekAt(30, 0.09)), ['week 30% used, 9% of the week gone', 'good'])
  // From a tenth on it is there: 30% used after 0.7 days is full after 2.33 days.
  assert.deepEqual(limitPart(weekAt(30, 0.1)), ['week 30% used, 10% of the week gone: full about 4.7 days early', 'warn'])
  assert.deepEqual(limitPart(fiveAt(20, 0.1)), ['5 hour limit 20% used, 10% of its time gone: full about 2.5 hours early', 'warn'])
})

test('one reading for all sessions: a session with an older percent shows the newer one of another session, and its age', () => {
  freshHome()
  const window = sec(NOW + 0.56 * 7 * DAY)
  // Session one had an answer 12 minutes ago. Session two has been idle since the week stood at 36%.
  line(session({ session_id: 'one', rate_limits: { seven_day: { used_percentage: 57, resets_at: window } } }), NOW - 12 * MIN)
  const two = session({ session_id: 'two', rate_limits: { seven_day: { used_percentage: 36, resets_at: window } } })
  assert.equal(line(two).split(' | ')[0], 'week 57% used (read 12 min ago), 44% of the week gone: full about 1.6 days early')
  assert.equal(readLimits(NOW).week.pct, 57)
})

test('a reading says how old it is from 5 minutes on', () => {
  freshHome()
  const window = sec(NOW + 6.5 * DAY)
  line(session({ rate_limits: { seven_day: { used_percentage: 3, resets_at: window } } }))
  const idle = session({ session_id: 'idle' })
  const first = (now) => line(idle, now).split(' | ')[0]
  assert.equal(first(NOW + 5 * MIN - 1), 'week 3% used, 7% of the week gone')
  assert.equal(first(NOW + 5 * MIN), 'week 3% used (read 5 min ago), 7% of the week gone')
  assert.equal(first(NOW + 89 * MIN + 59e3), 'week 3% used (read 89 min ago), 8% of the week gone')
  assert.equal(first(NOW + 3 * HOUR), 'week 3% used (read 3 hours ago), 9% of the week gone')
  // The plan was set by hand here, because a reading of over 24 hours ago no longer says how the person pays.
  saveConfig({ plan: 'subscription' })
  assert.equal(first(NOW + 3 * DAY), 'week 3% used (read 3 days ago), 50% of the week gone')
})

test('the cache part is green while warm, yellow close to its end, red when gone with 100,000 tokens or more, and dim when gone with fewer', () => {
  freshHome()
  const cache = (prompt_cache) => coloured(session({ rate_limits: weekAt(36, 0.44), prompt_cache }))[1]
  assert.deepEqual(cache({ warm: true, ttl: '1h', expires_at: sec(NOW + 52 * MIN) }), ['cache warm, 52 min left', 'good'])
  assert.deepEqual(cache({ warm: true, ttl: '1h', expires_at: sec(NOW + 10 * MIN + 1e3) }), ['cache warm, 11 min left', 'good'])
  assert.deepEqual(cache({ warm: true, ttl: '1h', expires_at: sec(NOW + 10 * MIN) }), ['cache warm, 10 min left', 'warn'])
  // A 5 minute cache warns in its last minute only.
  assert.deepEqual(cache({ warm: true, ttl: '5m', expires_at: sec(NOW + 4 * MIN) }), ['cache warm, 4 min left', 'good'])
  assert.deepEqual(cache({ warm: true, ttl: '5m', expires_at: sec(NOW + MIN) }), ['cache warm, 1 min left', 'warn'])
  assert.deepEqual(cache({ warm: true }), ['cache warm', 'good'])
  assert.deepEqual(cache({ warm: false, recache_tokens_if_cold: 527119 }), ['cache gone: the next call re-sends 527k', 'bad'])
  assert.deepEqual(cache({ warm: false, recache_tokens_if_cold: 100000 }), ['cache gone: the next call re-sends 100k', 'bad'])
  assert.deepEqual(cache({ warm: false, recache_tokens_if_cold: 99999 }), ['cache gone: the next call re-sends 100k', 'dim'])
  // The same tones by the token.
  saveConfig({ plan: 'usage' })
  assert.deepEqual(cache({ warm: true, ttl: '1h', expires_at: sec(NOW + 52 * MIN) }), ['cache warm, 52 min left, then $8.43', 'good'])
  assert.deepEqual(cache({ warm: true, ttl: '1h', expires_at: sec(NOW + 9 * MIN) }), ['cache warm, 9 min left, then $8.43', 'warn'])
  assert.deepEqual(cache({ warm: true }), ['next call at least $0.11', 'good'])
  assert.deepEqual(cache({ warm: false }), ['cache gone, next call about $8.43', 'bad'])
  assert.deepEqual(cache({ warm: false, recache_tokens_if_cold: 5000 }), ['cache gone, next call about $8.43', 'dim'])
  // When Claude Code says nothing about the cache, the least cost of the next call has no colour.
  assert.deepEqual(cache(undefined), ['next call at least $0.11', undefined])
})

test('the context part is yellow from 80%, or above the size from which the model costs more, and red from 95%', () => {
  freshHome()
  const context = (used_percentage, extra = {}) => coloured(session({
    rate_limits: weekAt(36, 0.44), ...extra,
    context_window: { used_percentage, current_usage: { input_tokens: 2, cache_creation_input_tokens: 14608, cache_read_input_tokens: 512509, ...extra.usage } },
  }))[2]
  assert.deepEqual(context(53), ['context 527k (53%)', undefined])
  assert.deepEqual(context(79), ['context 527k (79%)', undefined])
  assert.deepEqual(context(80), ['context 527k (80%)', 'warn'])
  assert.deepEqual(context(94), ['context 527k (94%)', 'warn'])
  assert.deepEqual(context(95), ['context 527k (95%)', 'bad'])
  assert.deepEqual(context(undefined), ['context 527k', undefined])
  // Claude Haiku 5.5 costs five times as much above 100,000 tokens of prompt.
  const haiku = { model: { id: 'claude-haiku-5-5' } }
  assert.deepEqual(context(15, { ...haiku, usage: { cache_read_input_tokens: 135390 } }), ['context 150k (15%)', 'warn'])
  assert.deepEqual(context(10, { ...haiku, usage: { cache_read_input_tokens: 85390 } }), ['context 100k (10%)', undefined])
  assert.deepEqual(context(96, { ...haiku, usage: { cache_read_input_tokens: 135390 } }), ['context 150k (96%)', 'bad'])
  // The effort has no colour.
  assert.deepEqual(coloured(session({ rate_limits: weekAt(36, 0.44) }))[3], ['effort high', undefined])
})

test('a limit in dollars is yellow from 80% of it and red when it is reached', () => {
  const spent = (cost) => session({ rate_limits: weekAt(36, 0.44), cost: { total_cost_usd: cost, total_duration_ms: 4 * HOUR } })
  freshHome()
  saveConfig({ limits: { session: 50, day: 200, action: 'warn' } })
  assert.deepEqual(coloured(spent(39.99)).slice(4), [['limit $50 per session at list prices, $39.99 so far', undefined], ['limit $200 per day at list prices, $39.99 so far', undefined]])
  assert.deepEqual(coloured(spent(40)).slice(4), [['limit $50 per session at list prices, $40.00 so far', 'warn'], ['limit $200 per day at list prices, $40.00 so far', undefined]])
  assert.deepEqual(coloured(spent(50)).slice(4), [['limit $50 per session at list prices, $50.00 so far', 'bad'], ['limit $200 per day at list prices, $50.00 so far', undefined]])
  assert.deepEqual(coloured(spent(160)).slice(5), [['limit $200 per day at list prices, $160 so far', 'warn']])
  assert.deepEqual(coloured(spent(200)).slice(5), [['limit $200 per day at list prices, $200 so far', 'bad']])
  // By the token: the day's limit colours the part for today, the session's limit its own part.
  freshHome()
  saveConfig({ plan: 'usage', limits: { session: 50, day: 200, action: 'warn' } })
  assert.deepEqual(coloured(spent(39.99)).slice(4), [['today $39.99 of $200', undefined], ['limit $50', undefined]])
  assert.deepEqual(coloured(spent(45)).slice(4), [['today $45.00 of $200', undefined], ['limit $50', 'warn']])
  assert.deepEqual(coloured(spent(160)).slice(4), [['today $160 of $200', 'warn'], ['limit $50', 'bad']])
  assert.deepEqual(coloured(spent(200)).slice(4), [['today $200 of $200', 'bad'], ['limit $50', 'bad']])
  // Without a limit, the spend of the session and of today has no colour.
  saveConfig({ plan: 'usage' })
  assert.deepEqual(coloured(spent(900)).filter(([text]) => /session|today/.test(text)), [['$900 session, $225 per hour', undefined], ['today $900', undefined]])
})

test('colours are on by default, and off with NO_COLOR, with "color: false" in the settings, or when the caller says so', () => {
  freshHome()
  const input = session({ rate_limits: { five_hour: fiveAt(92, 0.5).five_hour, ...weekAt(56, 0.44) }, prompt_cache: { warm: false } })
  const plain = line(input)
  assert.equal(plain, '5 hour limit 92% used, 50% of its time gone: full about 2.3 hours early | week 56% used, 44% of the week gone: full about 1.5 days early | cache gone: the next call re-sends 527k | context 527k (53%) | effort high')
  const withColours = statusLine(input, NOW, { env: {}, layout: 'one' })
  assert.equal(withColours, `\x1b[31m5 hour limit 92% used, 50% of its time gone: full about 2.3 hours early\x1b[0m | \x1b[33mweek 56% used, 44% of the week gone: full about 1.5 days early\x1b[0m | \x1b[31mcache gone: the next call re-sends 527k\x1b[0m | context 527k (53%) | effort high`)
  // Only the parts are coloured: each " | " stands between a reset and the next part.
  assert.equal(withColours.replace(/\x1b\[\d+m/g, ''), plain)
  assert.equal(statusLine(input, NOW, { env: { NO_COLOR: '1' }, layout: 'one' }), plain)
  assert.equal(statusLine(input, NOW, { env: { NO_COLOR: '' }, layout: 'one' }), withColours) // Set but empty does not count.
  assert.equal(statusLine(input, NOW, { env: { NO_COLOR: '1' }, color: true, layout: 'one' }), withColours)
  assert.equal(statusLine(input, NOW, { env: {}, color: false, layout: 'one' }), plain)
  saveConfig({ color: false })
  assert.equal(statusLine(input, NOW, { env: {}, layout: 'one' }), plain)
  assert.equal(statusLine(input, NOW, { env: {}, color: true, layout: 'one' }), withColours)
  // A dim part, for a small context that is gone from the cache.
  assert.match(statusLine({ ...input, prompt_cache: { warm: false, recache_tokens_if_cold: 20000 } }, NOW, { env: {}, color: true, layout: 'one' }), / \| \x1b\[2mcache gone: the next call re-sends 20k\x1b\[0m \| /)
})

const SETTINGS = join(process.env.CLAUDE_CONFIG_DIR, 'settings.json')
const settings = () => JSON.parse(readFileSync(SETTINGS, 'utf8'))
const OTHER = { theme: 'dark', hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: '/x/auto-allow.sh' }] }] } }
/** The hooks after "kestrel install": these hooks, and the three hooks of the security checks that the install adds, calling `link`. */
const SECURITY_HOOKS = (hooks, link) => ({
  ...hooks,
  SessionStart: [...(hooks.SessionStart ?? []), { hooks: [{ type: 'command', command: `${link} hook check-settings`, timeout: 5 }] }],
  Stop: [...(hooks.Stop ?? []), { hooks: [{ type: 'command', command: `${link} hook check-turn`, timeout: 5 }] }],
  PreToolUse: [...(hooks.PreToolUse ?? []), { matcher: 'Bash', hooks: [{ type: 'command', command: `${link} hook push-gate`, timeout: 5 }] }],
})

test('install sets the refresh timer of the status line, changes it, and removes it, and leaves the other settings alone', () => {
  freshHome()
  writeFileSync(SETTINGS, JSON.stringify(OTHER))
  assert.equal(installStatusLine('/bin/kestrel'), 'The status line is set, with a refresh every 30 seconds. Open sessions show it after their next answer.')
  assert.deepEqual(settings(), { ...OTHER, statusLine: { type: 'command', command: '/bin/kestrel statusline', refreshInterval: 30 } })
  assert.equal(installed().refresh, 30)
  assert.equal(installStatusLine('/bin/kestrel'), 'The status line was already set, with a refresh every 30 seconds.')
  // The same command with another number of seconds is a change, not "already set".
  assert.equal(installStatusLine('/bin/kestrel', { refresh: 10 }), 'The status line now has a refresh every 10 seconds (before: a refresh every 30 seconds).')
  assert.deepEqual(settings(), { ...OTHER, statusLine: { type: 'command', command: '/bin/kestrel statusline', refreshInterval: 10 } })
  assert.equal(installStatusLine('/bin/kestrel', { refresh: 0 }), 'The status line now has no refresh timer (before: a refresh every 10 seconds).')
  assert.deepEqual(settings(), { ...OTHER, statusLine: { type: 'command', command: '/bin/kestrel statusline' } })
  assert.equal(installed().refresh, 0)
  assert.equal(installStatusLine('/bin/kestrel', { refresh: 0 }), 'The status line was already set, with no refresh timer.')
  assert.equal(installStatusLine('/bin/kestrel', { refresh: 1 }), 'The status line now has a refresh every 1 second (before: no refresh timer).')
})

test('install gives an older install its timer, keeps what the person added to the status line, and keeps another tool\'s status line', () => {
  freshHome()
  // An install from before the timer, to which the person added a padding.
  writeFileSync(SETTINGS, JSON.stringify({ statusLine: { type: 'command', command: '/bin/kestrel statusline', padding: 0 } }))
  assert.match(installStatusLine('/bin/kestrel'), /now has a refresh every 30 seconds \(before: no refresh timer\)/)
  assert.deepEqual(settings().statusLine, { type: 'command', command: '/bin/kestrel statusline', padding: 0, refreshInterval: 30 })
  // Another tool's status line stays as it is, with its own timer.
  const other = { type: 'command', command: 'other-tool', refreshInterval: 5, padding: 2 }
  writeFileSync(SETTINGS, JSON.stringify({ statusLine: other }))
  assert.match(installStatusLine('/bin/kestrel'), /already has a status line \(other-tool\)/)
  assert.deepEqual(settings().statusLine, other)
  assert.equal(installed().refresh, 0)
  // With "force" it is replaced, and nothing of it is carried over.
  assert.match(installStatusLine('/bin/kestrel', { force: true, refresh: 20 }), /is set, with a refresh every 20 seconds/)
  assert.deepEqual(settings().statusLine, { type: 'command', command: '/bin/kestrel statusline', refreshInterval: 20 })
})

test('"kestrel install --refresh" passes the seconds on, and "status" shows them', () => {
  freshHome()
  // The command puts a link into the home folder. This test must only ever reach its own temp folder.
  const env = { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir }
  assert.equal(spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], { encoding: 'utf8', env }).stdout, dir)
  writeFileSync(SETTINGS, JSON.stringify(OTHER))
  assert.match(run(['install', '--refresh', '45']), /The status line is set, with a refresh every 45 seconds\./)
  // The settings call the link in this tool's own folder, not the one on the PATH.
  const link = join(process.env.KESTREL_HOME, 'bin', 'kestrel')
  const command = `${link} statusline`
  const hooks = SECURITY_HOOKS(OTHER.hooks, link)
  assert.deepEqual(settings(), { ...OTHER, hooks, statusLine: { type: 'command', command, refreshInterval: 45 } })
  assert.match(run(['status']), /^Claude Code status line +set, with a refresh every 45 seconds$/m)
  // Without the flag it is 30 seconds.
  assert.match(run(['install']), /now has a refresh every 30 seconds \(before: a refresh every 45 seconds\)/)
  assert.match(run(['install', '--refresh', '0']), /now has no refresh timer \(before: a refresh every 30 seconds\)/)
  assert.deepEqual(settings(), { ...OTHER, hooks, statusLine: { type: 'command', command } })
  assert.match(run(['status']), /^Claude Code status line +set, with no refresh timer$/m)
  // A value that is not a number of seconds changes nothing.
  for (const bad of [['--refresh'], ['--refresh', 'often'], ['--refresh', '-5'], ['--refresh', '1.5']]) {
    assert.match(run(['install', ...bad]), /--refresh is a whole number of seconds, or 0 for no timer\./)
  }
  assert.deepEqual(settings(), { ...OTHER, hooks, statusLine: { type: 'command', command } })
})

const NUDGE_BODY = 'After that the next call sends 527k tokens again. To keep it, send any message before then. Done for now? Run /compact first.'
/**
 * The body for a session that Claude Code compacts on its own while it is idle: its cache lasts
 * 1 hour, and 200,000 tokens or more are to send again. `before` is the end of the cache as a
 * clock time. The session of these tests is such a one, with its 527,119 tokens.
 */
const IDLE_BODY = (before, tokens = '527k') => `Soon Claude Code compacts this idle session on its own (${tokens} tokens). To keep the full context, send a message before ${before}. To choose what stays, run /compact with your own words now.`

test('the notification is due when it is on, the end is near and not past, the context is large, and this end had none yet', () => {
  const until = NOW + 5 * MIN
  const cfg = { on: true, before: 5, min: 100000 }
  const due = (change = {}) => nudgeDue({ until, ttl: '1h', recache: 100000, nudgedFor: undefined, now: NOW, cfg, ...change })
  assert.equal(due(), true)
  assert.equal(due({ cfg: { ...cfg, on: false } }), false)
  // Near: from 5 minutes before the end, until the end.
  assert.equal(due({ now: NOW - 1 }), false)
  assert.equal(due({ now: until - 1 }), true)
  assert.equal(due({ now: until }), false)
  assert.equal(due({ now: until + MIN }), false)
  assert.equal(due({ until: undefined }), false)
  // Large: the tokens to send again are at least "min".
  assert.equal(due({ recache: 99999 }), false)
  assert.equal(due({ recache: undefined }), false)
  assert.equal(due({ recache: 20000, cfg: { ...cfg, min: 20000 } }), true)
  // Once per end.
  assert.equal(due({ nudgedFor: until }), false)
  assert.equal(due({ nudgedFor: until - HOUR }), true)
  // "before" is a number of minutes.
  assert.equal(due({ now: NOW - 5 * MIN, cfg: { ...cfg, before: 10 } }), true)
  assert.equal(due({ cfg: { ...cfg, before: 2 } }), false)
  // A 5 minute cache gets it in its last minute, whatever "before" says.
  assert.equal(due({ ttl: '5m' }), false)
  assert.equal(due({ ttl: '5m', now: until - MIN - 1 }), false)
  assert.equal(due({ ttl: '5m', now: until - MIN }), true)
})

test('the notification is off until the person turns it on, with 5 minutes and 100,000 tokens when nothing else is set', () => {
  assert.deepEqual(nudgeConfig({}), { on: false, before: 5, min: 100000 })
  assert.deepEqual(nudgeConfig({ nudge: { on: true, before: 3 } }), { on: true, before: 3, min: 100000 })
  freshHome()
  assert.deepEqual(nudgeConfig(), { on: false, before: 5, min: 100000 })
  saveConfig({ nudge: { on: true, min: 50000 } })
  assert.deepEqual(nudgeConfig(), { on: true, before: 5, min: 50000 })
})

test('near the end of a large cache the status line shows one notification, and not a second one for the same end', () => {
  freshHome()
  saveConfig({ nudge: { on: true } })
  // The cache ends 52 minutes after noon. The line itself is the same with and without the notification.
  const input = session({ rate_limits: { seven_day: WEEK } })
  assert.equal(line(input, NOW + 46 * MIN), 'week 36% used, 44% of the week gone | cache warm, 6 min left | context 527k (53%) | effort high')
  assert.deepEqual(sent, [])
  assert.equal(kept('one').nudgedFor, undefined)
  assert.equal(line(input, NOW + 47 * MIN), 'week 36% used, 44% of the week gone | cache warm, 5 min left | context 527k (53%) | effort high')
  assert.deepEqual(sent, [['kestrel: work/repo cache ends at 12:52', IDLE_BODY('12:52')]])
  assert.equal(kept('one').nudgedFor, NOW + 52 * MIN)
  // The status line runs again every 30 seconds until the end, and after it.
  for (const later of [47.5, 48, 51, 51.99, 52, 53]) line(input, NOW + later * MIN)
  assert.equal(sent.length, 1)
  // An answer moves the end. Near the new end there is a notification again.
  const next = { ...input, prompt_cache: { warm: true, ttl: '1h', expires_at: sec(NOW + 2 * HOUR), recache_tokens_if_cold: 610000 } }
  line(next, NOW + HOUR)
  assert.equal(sent.length, 1)
  line(next, NOW + 2 * HOUR - 3 * MIN)
  assert.deepEqual(sent[1], ['kestrel: work/repo cache ends at 14:00', IDLE_BODY('14:00', '610k')])
  line(next, NOW + 2 * HOUR - 2 * MIN)
  assert.equal(sent.length, 2)
  // Another session has its own end and its own notification.
  line({ ...next, session_id: 'two', cwd: '/work/other' }, NOW + 2 * HOUR - 2 * MIN)
  assert.deepEqual(sent[2], ['kestrel: work/other cache ends at 14:00', IDLE_BODY('14:00', '610k')])
})

test('no notification when it is off, the context is small, the end is not near, or the cache is already gone', () => {
  const cache = (change = {}) => session({ rate_limits: { seven_day: WEEK }, prompt_cache: { warm: true, ttl: '1h', expires_at: sec(NOW + 3 * MIN), recache_tokens_if_cold: 527119, ...change } })
  // Off: nothing is set, or it is turned off.
  freshHome()
  line(cache())
  saveConfig({ nudge: { on: false, before: 5, min: 100000 } })
  line(cache())
  assert.deepEqual(sent, [])
  assert.equal(kept('one').nudgedFor, undefined)
  // On, and everything holds.
  saveConfig({ nudge: { on: true } })
  line(cache())
  assert.equal(sent.length, 1)
  // Small: under 100,000 tokens to send again.
  freshHome()
  saveConfig({ nudge: { on: true } })
  line(cache({ recache_tokens_if_cold: 99999 }))
  // Without that number it is the size of the context.
  line({ ...cache({ recache_tokens_if_cold: undefined }), context_window: { current_usage: { input_tokens: 2, cache_read_input_tokens: 99000 } } })
  // Not near: more than 5 minutes left, or no end time at all.
  line(cache({ expires_at: sec(NOW + 5 * MIN + 1e3) }))
  line(cache({ expires_at: undefined }))
  line(session({ rate_limits: { seven_day: WEEK }, prompt_cache: undefined }))
  // Already past, or lost before its end (after a change of model, for example).
  line(cache({ expires_at: sec(NOW) }))
  line(cache({ expires_at: sec(NOW - HOUR) }))
  line(cache({ warm: false }))
  // A 5 minute cache with more than 1 minute left.
  line(cache({ ttl: '5m', expires_at: sec(NOW + 2 * MIN) }))
  assert.deepEqual(sent, [])
  assert.equal(kept('one').nudgedFor, undefined)
  // The settings decide what is near and what is small.
  saveConfig({ nudge: { on: true, before: 2, min: 600000 } })
  line(cache())
  line(cache({ expires_at: sec(NOW + 2 * MIN) }))
  assert.deepEqual(sent, [])
  saveConfig({ nudge: { on: true, before: 2, min: 50000 } })
  line(cache({ expires_at: sec(NOW + 2 * MIN), recache_tokens_if_cold: 50000 }))
  assert.deepEqual(sent, [['kestrel: work/repo cache ends at 12:02', NUDGE_BODY.replace('527k', '50k')]])
  // A 5 minute cache in its last minute, and a context whose size stands in for the missing number.
  freshHome()
  saveConfig({ nudge: { on: true } })
  line(cache({ ttl: '5m', expires_at: sec(NOW + MIN), recache_tokens_if_cold: undefined }))
  assert.deepEqual(sent, [['kestrel: work/repo cache ends at 12:01', NUDGE_BODY]])
})

test('the words of the notification: the tokens on a subscription, the dollars by the token, and no text of the session but its folder', () => {
  const until = Date.parse('2026-11-12T15:02:00')
  assert.deepEqual(nudgeText({ project: 'work/repo', until, recache: 527119, mode: 'subscription', coldCost: 2.47 }), { title: 'kestrel: work/repo cache ends at 15:02', body: NUDGE_BODY })
  assert.deepEqual(nudgeText({ project: 'work/repo', until, recache: 527119, mode: 'usage', coldCost: 2.47 }), {
    title: 'kestrel: work/repo cache ends at 15:02',
    body: 'After that the next call costs about $2.47. To keep it, send any message before then. Done for now? Run /compact first.',
  })
  // By the token, a model with no price has no dollar figure: the body gives the tokens.
  assert.equal(nudgeText({ project: 'work/repo', until, recache: 527119, mode: 'usage', coldCost: undefined }).body, NUDGE_BODY)
  // A session with no folder has none in the title.
  assert.equal(nudgeText({ until, recache: 527119, mode: 'subscription' }).title, 'kestrel: cache ends at 15:02')

  // The status line gives the notification the billing mode and the price it shows itself.
  freshHome()
  saveConfig({ nudge: { on: true } })
  const input = session({ session_name: 'a private name', transcript_path: '/private/place/one.jsonl' })
  const env = { ANTHROPIC_API_KEY: 'a-key' }
  assert.match(line(input, NOW + 49 * MIN, { env }), /\| cache warm, 3 min left, then \$8\.43 \|/)
  // This session is one that Claude Code compacts on its own while it is idle, so the body
  // says that, with the tokens. The dollars of a smaller session are tested in compact.test.mjs.
  assert.deepEqual(sent, [['kestrel: work/repo cache ends at 12:52', IDLE_BODY('12:52')]])
  line({ ...input, session_id: 'no-price', model: { id: 'some-new-model' } }, NOW + 49 * MIN, { env })
  assert.deepEqual(sent[1], ['kestrel: work/repo cache ends at 12:52', IDLE_BODY('12:52')])
  line({ ...input, session_id: 'subscriber', cwd: undefined, rate_limits: { seven_day: WEEK } }, NOW + 49 * MIN, { env })
  assert.deepEqual(sent[2], ['kestrel: cache ends at 12:52', IDLE_BODY('12:52')])
  assert.doesNotMatch(JSON.stringify(sent), /private/)
})

test('the notification goes to osascript on macOS and to notify-send on Linux, as a list of arguments, and nobody waits for it', () => {
  const calls = []
  let child
  const spawn = (...args) => {
    calls.push(args)
    child = { listens: [], unrefs: 0, on: (event) => child.listens.push(event), unref: () => child.unrefs++ }
    return child
  }
  const alone = { detached: true, stdio: 'ignore' }
  notify('kestrel: work/repo cache ends at 15:02', 'After that.', { platform: 'darwin', spawn })
  assert.deepEqual(calls.pop(), ['osascript', ['-e', 'display notification "After that." with title "kestrel: work/repo cache ends at 15:02"'], alone])
  // The child runs on its own: this process listens for a failed start, and does not wait.
  assert.deepEqual([child.listens, child.unrefs], [['error'], 1])
  // In an AppleScript text, a backslash and a double quote each get a backslash in front.
  notify('a "quoted" \\ folder', 'say "hi" \\ now', { platform: 'darwin', spawn })
  assert.deepEqual(calls.pop()[1], ['-e', 'display notification "say \\"hi\\" \\\\ now" with title "a \\"quoted\\" \\\\ folder"'])
  // A text that tries to end the AppleScript text early stays text.
  notify('t', 'x\\" & (do shell script "id") & "', { platform: 'darwin', spawn })
  assert.deepEqual(calls.pop()[1], ['-e', 'display notification "x\\\\\\" & (do shell script \\"id\\") & \\"" with title "t"'])
  // notify-send gets the title and the body as they are, each as its own argument.
  notify('a "quoted" \\ folder', 'say "hi" \\ now; $(id)', { platform: 'linux', spawn })
  assert.deepEqual(calls.pop(), ['notify-send', ['a "quoted" \\ folder', 'say "hi" \\ now; $(id)'], alone])
  assert.deepEqual([child.listens, child.unrefs], [['error'], 1])
  // Any other system has no notification.
  notify('t', 'b', { platform: 'win32', spawn })
  notify('t', 'b', { platform: 'freebsd', spawn })
  assert.equal(calls.length, 0)
})

test('a notification that cannot be started is not an error', async () => {
  assert.doesNotThrow(() => notify('t', 'b', { platform: 'darwin', spawn: () => { throw new Error('no such program') } }))
  assert.doesNotThrow(() => notify('t', 'b', { platform: 'linux', spawn: () => undefined }))
  // A program that is not installed: the child reports that as an "error" event, a moment later.
  const { EventEmitter } = await import('node:events')
  const child = Object.assign(new EventEmitter(), { unref() {} })
  notify('t', 'b', { platform: 'linux', spawn: () => child })
  assert.doesNotThrow(() => child.emit('error', new Error('spawn notify-send ENOENT')))
})

test('a notification that throws does not break the status line, and is not tried again for the same end', () => {
  freshHome()
  saveConfig({ nudge: { on: true } })
  const input = session({ rate_limits: { seven_day: WEEK } })
  let tries = 0
  const broken = () => {
    tries++
    throw new Error('no notification here')
  }
  const expected = 'week 36% used, 44% of the week gone | cache warm, 3 min left | context 527k (53%) | effort high'
  assert.equal(line(input, NOW + 49 * MIN, { notify: broken }), expected)
  assert.equal(tries, 1)
  assert.equal(kept('one').nudgedFor, NOW + 52 * MIN)
  assert.equal(line(input, NOW + 49.5 * MIN, { notify: broken }), expected)
  assert.equal(tries, 1)
})

test('a cache that was lost in the last 10 minutes: the line says why, in yellow', () => {
  freshHome()
  const lost = (causes, ago = 3 * MIN) => ({ warm: true, ttl: '1h', expires_at: sec(NOW + 52 * MIN), last_miss_at: sec(NOW - ago), last_miss_cause: causes && { causes } })
  const parts = (prompt_cache) => coloured(session({ rate_limits: weekAt(36, 0.44), prompt_cache }))
  // The part stands after the one for the cache.
  assert.deepEqual(parts(lost(['model_changed'])).slice(1), [['cache warm, 52 min left', 'good'], ['cache lost: model changed', 'warn'], ['context 527k (53%)', undefined], ['effort high', undefined]])
  const loss = (causes, ago) => parts(lost(causes, ago))[2]
  assert.deepEqual(loss(['messages_rewritten']), ['cache lost: messages rewritten', 'warn'])
  assert.deepEqual(loss(['ttl_expired_1h']), ['cache lost: timed out', 'warn'])
  assert.deepEqual(loss(['ttl_expired_5m']), ['cache lost: timed out', 'warn'])
  assert.deepEqual(loss(['ttl_expired']), ['cache lost: timed out', 'warn'])
  // A cause without words of its own is shown as it is named, with spaces.
  assert.deepEqual(loss(['system_prompt_changed']), ['cache lost: system prompt changed', 'warn'])
  assert.deepEqual(loss(['constructor']), ['cache lost: constructor', 'warn'])
  // Several causes, each once.
  assert.deepEqual(loss(['model_changed', 'messages_rewritten']), ['cache lost: model changed and messages rewritten', 'warn'])
  assert.deepEqual(loss(['ttl_expired_5m', 'model_changed', 'ttl_expired_1h', 'tools_changed']), ['cache lost: timed out, model changed and tools changed', 'warn'])
  // A loss without a cause gives no part: the context comes right after the cache.
  assert.deepEqual(loss(undefined), ['context 527k (53%)', undefined])
  assert.deepEqual(loss([]), ['context 527k (53%)', undefined])
  // Up to 10 minutes ago, and not after that.
  assert.deepEqual(loss(['model_changed'], 10 * MIN), ['cache lost: model changed', 'warn'])
  assert.deepEqual(loss(['model_changed'], 10 * MIN + 1e3), ['context 527k (53%)', undefined])
  assert.deepEqual(parts({ warm: true, ttl: '1h', expires_at: sec(NOW + 52 * MIN), last_miss_cause: { causes: ['model_changed'] } })[2], ['context 527k (53%)', undefined])
  // By the token the part is the same, and it has no dollars.
  saveConfig({ plan: 'usage' })
  assert.deepEqual(parts(lost(['model_changed'])).slice(1, 4), [['cache warm, 52 min left, then $8.43', 'good'], ['cache lost: model changed', 'warn'], ['context 527k (53%)', undefined]])
  // Without a context size the line still says it.
  freshHome()
  saveConfig({ plan: 'subscription' })
  assert.equal(line(session({ context_window: {}, prompt_cache: lost(['model_changed']) })), 'plan limits not reported yet | cache lost: model changed | effort high')
})

test('"kestrel nudge" shows the settings, turns the notification on and off, and "status" has a row for it', () => {
  freshHome()
  const config = () => JSON.parse(readFileSync(join(process.env.KESTREL_HOME, 'config.json'), 'utf8'))
  const off = 'off (when on: 5 minutes before the end, when the next call would send 100,000 tokens or more again)'
  const on = 'on, 5 minutes before the end, when the next call would send 100,000 tokens or more again'
  // The value of the row of "kestrel status" for the notification.
  const row = () => run(['status']).split('\n').find((l) => l.startsWith('Cache end notification')).replace(/^Cache end notification +/, '')
  const shown = run(['nudge'])
  assert.ok(shown.startsWith(`Notification before a session's cache ends: ${off}.\n`), shown)
  assert.match(shown, /Turn it on with "kestrel nudge on \[--before <minutes>\] \[--min <tokens>\]", and off with "kestrel nudge off"\./)
  assert.equal(row(), off)

  // With a timer on the status line, turning it on says only what is set.
  writeFileSync(SETTINGS, JSON.stringify(OTHER))
  installStatusLine('/bin/kestrel')
  saveConfig({ limits: { day: 200, action: 'warn' } })
  assert.equal(run(['nudge', 'on']), `Notification before a session's cache ends: ${on}.\n`)
  assert.deepEqual(config(), { limits: { day: 200, action: 'warn' }, nudge: { on: true, before: 5, min: 100000 } })
  assert.ok(run(['nudge']).startsWith(`Notification before a session's cache ends: ${on}.\n`))
  assert.equal(row(), on)
  // The two numbers can be set, and they stay when it is turned off and on again.
  assert.equal(run(['nudge', 'on', '--before', '10', '--min', '250000']), `Notification before a session's cache ends: on, 10 minutes before the end, when the next call would send 250,000 tokens or more again.\n`)
  assert.deepEqual(config().nudge, { on: true, before: 10, min: 250000 })
  assert.equal(run(['nudge', 'off']), `Notification before a session's cache ends: off (when on: 10 minutes before the end, when the next call would send 250,000 tokens or more again).\n`)
  assert.deepEqual(config(), { limits: { day: 200, action: 'warn' }, nudge: { on: false, before: 10, min: 250000 } })
  assert.match(run(['nudge', '--before', '1', 'on']), /: on, 1 minute before the end, when the next call would send 250,000 tokens or more again\.\n$/)
  assert.deepEqual(config().nudge, { on: true, before: 1, min: 250000 })

  // What is not a setting changes nothing.
  for (const [args, message] of [
    [['on', '--before'], /--before is a whole number of minutes from 1 to 30\./],
    [['on', '--before', '0'], /--before is a whole number of minutes from 1 to 30\./],
    [['on', '--before', '31'], /--before is a whole number of minutes from 1 to 30\./],
    [['on', '--before', '2.5'], /--before is a whole number of minutes from 1 to 30\./],
    [['on', '--before', '-5'], /--before is a whole number of minutes from 1 to 30\./],
    [['on', '--before', '1e1'], /--before is a whole number of minutes from 1 to 30\./],
    [['on', '--before', 'soon'], /--before is a whole number of minutes from 1 to 30\./],
    [['off', '--before', '99'], /--before is a whole number of minutes from 1 to 30\./],
    [['on', '--min'], /--min is a whole number of tokens, 1 or more\./],
    [['on', '--min', '0'], /--min is a whole number of tokens, 1 or more\./],
    [['on', '--min', '-1'], /--min is a whole number of tokens, 1 or more\./],
    [['on', '--min', '1.5'], /--min is a whole number of tokens, 1 or more\./],
    [['on', '--min', 'many'], /--min is a whole number of tokens, 1 or more\./],
    // A good number next to a bad one is not saved either.
    [['on', '--before', '7', '--min', '0'], /--min is a whole number of tokens, 1 or more\./],
    [['sometimes'], /Use "kestrel nudge on \[--before 5\] \[--min 100000\]" or "kestrel nudge off"\./],
    [['--min', '5'], /Use "kestrel nudge on \[--before 5\] \[--min 100000\]" or "kestrel nudge off"\./],
  ]) assert.match(run(['nudge', ...args]), message)
  assert.deepEqual(config().nudge, { on: true, before: 1, min: 250000 })
  assert.match(run(['help']), /^  kestrel nudge on \[--before 5\] \[--min 100000\]$/m)
})

test('turning the notification on says to run "kestrel install" when the status line has no refresh timer', () => {
  freshHome()
  const note = /\nNote: the notification comes from the status line, and that has to run on a timer\. Run "kestrel install"\.\n$/
  // No status line of this tool at all.
  writeFileSync(SETTINGS, JSON.stringify(OTHER))
  assert.match(run(['nudge', 'on']), note)
  // This tool's status line without a timer.
  installStatusLine('/bin/kestrel', { refresh: 0 })
  assert.match(run(['nudge', 'on']), note)
  // Turning it off needs no timer.
  assert.doesNotMatch(run(['nudge', 'off']), /Note/)
  installStatusLine('/bin/kestrel', { refresh: 30 })
  assert.doesNotMatch(run(['nudge', 'on']), /Note/)
  // The settings of Claude Code are not changed by any of this.
  assert.deepEqual(settings(), { ...OTHER, statusLine: { type: 'command', command: '/bin/kestrel statusline', refreshInterval: 30 } })
})

// What Claude Code gives the hook for a sent prompt. The hook must not read or keep the prompt.
const PROMPT = { session_id: 'one', hook_event_name: 'UserPromptSubmit', cwd: '/work/repo', prompt: 'a private prompt' }
const coldText = (ended, what) => `kestrel: this session's cache ended at ${ended}. ${what} Before a long break next time: /compact, or start a new session.`

test('a prompt to a session whose cache has ended gets one warning with the tokens that were sent again', () => {
  freshHome()
  // The status line ran at noon. The cache ended 52 minutes later, and the person comes back after 3 hours.
  const input = session({ rate_limits: { seven_day: WEEK } })
  line(input)
  const back = NOW + 3 * HOUR
  const answer = coldStartHook(PROMPT, back, {})
  // The answer is a message only: nothing in it blocks the prompt or adds to it.
  assert.deepEqual(answer, { systemMessage: coldText('12:52', 'This prompt sent 527k tokens again.') })
  assert.equal(kept('one').coldWarnedFor, NOW + 52 * MIN)
  // Once per end: not for the next prompt, and not after the status line has run again with the old end.
  assert.equal(coldStartHook(PROMPT, back + MIN, {}), undefined)
  line(input, back + 2 * MIN)
  assert.equal(kept('one').coldWarnedFor, NOW + 52 * MIN)
  assert.equal(coldStartHook(PROMPT, back + 3 * MIN, {}), undefined)
  // The answer to the prompt gives the cache a new end. While that has not passed, the hook is silent.
  const next = { ...input, prompt_cache: { warm: true, ttl: '1h', expires_at: sec(back + HOUR), recache_tokens_if_cold: 610000 } }
  line(next, back + 5 * MIN)
  assert.equal(coldStartHook(PROMPT, back + 30 * MIN, {}), undefined)
  assert.equal(coldStartHook(PROMPT, back + HOUR - 1, {}), undefined)
  // After the new end, the next prompt gets a warning again.
  assert.deepEqual(coldStartHook(PROMPT, back + HOUR, {}), { systemMessage: coldText('16:00', 'This prompt sent 610k tokens again.') })
  assert.equal(coldStartHook(PROMPT, back + 2 * HOUR, {}), undefined)
  // Nothing of the prompt is kept.
  assert.doesNotMatch(filesText(), /private/)
})

test('by the token the warning gives what the prompt cost more, and the tokens for a model with no price', () => {
  freshHome()
  const env = { ANTHROPIC_API_KEY: 'a-key' }
  const back = NOW + 3 * HOUR
  // 527,119 tokens on Claude Fable 5.2: $16 per million written to a 1 hour cache, $10 to a 5 minute cache.
  line(session(), NOW, { env })
  assert.deepEqual(coldStartHook(PROMPT, back, env), { systemMessage: coldText('12:52', 'This prompt cost about $8.43 more.') })
  line(session({ session_id: 'short', prompt_cache: { warm: true, ttl: '5m', expires_at: sec(NOW + 4 * MIN), recache_tokens_if_cold: 527119 } }), NOW, { env })
  assert.deepEqual(coldStartHook({ ...PROMPT, session_id: 'short' }, back, env), { systemMessage: coldText('12:04', 'This prompt cost about $5.27 more.') })
  line(session({ session_id: 'no-price', model: { id: 'some-new-model' } }), NOW, { env })
  assert.deepEqual(coldStartHook({ ...PROMPT, session_id: 'no-price' }, back, env), { systemMessage: coldText('12:52', 'This prompt sent 527k tokens again.') })
  // A plan set by hand decides here too.
  saveConfig({ plan: 'subscription' })
  line(session({ session_id: 'by-hand' }), NOW, { env })
  assert.deepEqual(coldStartHook({ ...PROMPT, session_id: 'by-hand' }, back, env), { systemMessage: coldText('12:52', 'This prompt sent 527k tokens again.') })
  // When nothing says how the person pays, the figures are dollars, as on the status line.
  freshHome()
  line(session())
  assert.deepEqual(coldStartHook(PROMPT, back, {}), { systemMessage: coldText('12:52', 'This prompt cost about $8.43 more.') })
})

test('the hook for a sent prompt is silent for a warm cache, a small context, and a session the status line has not seen', () => {
  freshHome()
  const cached = (id, prompt_cache, extra = {}) => {
    line(session({ session_id: id, rate_limits: { seven_day: WEEK }, prompt_cache, ...extra }))
    return { ...PROMPT, session_id: id }
  }
  const back = NOW + 3 * HOUR
  // Warm: the end has not come. It has passed from the very millisecond of the end.
  const warm = cached('warm', { warm: true, ttl: '1h', expires_at: sec(NOW + 52 * MIN), recache_tokens_if_cold: 527119 })
  assert.equal(coldStartHook(warm, NOW + 52 * MIN - 1, {}), undefined)
  assert.equal(kept('warm').coldWarnedFor, undefined)
  assert.ok(coldStartHook(warm, NOW + 52 * MIN, {}))
  // Small: under 100,000 tokens to send again. Without that number it is the size of the context.
  assert.equal(coldStartHook(cached('small', { warm: true, ttl: '1h', expires_at: sec(NOW + 52 * MIN), recache_tokens_if_cold: 99999 }), back, {}), undefined)
  const context = (tokens) => ({ context_window: { current_usage: { input_tokens: 2, cache_read_input_tokens: tokens - 2 } } })
  assert.equal(coldStartHook(cached('small-context', { warm: true, ttl: '1h', expires_at: sec(NOW + 52 * MIN) }, context(99999)), back, {}), undefined)
  assert.match(coldStartHook(cached('large-context', { warm: true, ttl: '1h', expires_at: sec(NOW + 52 * MIN) }, context(100000)), back, {}).systemMessage, /This prompt sent 100k tokens again\./)
  // No end time, or nothing about the cache at all.
  assert.equal(coldStartHook(cached('no-end', { warm: true, recache_tokens_if_cold: 527119 }), back, {}), undefined)
  assert.equal(coldStartHook(cached('no-cache', undefined), back, {}), undefined)
  // A session the status line has not seen, and an input without a session.
  assert.equal(coldStartHook({ ...PROMPT, session_id: 'never-seen' }, back, {}), undefined)
  assert.equal(existsSync(join(process.env.KESTREL_HOME, 'sessions', 'never-seen.json')), false)
  assert.equal(coldStartHook({}, back, {}), undefined)
  // What counts as small is the "min" of the notification, also while the notification is off.
  saveConfig({ nudge: { on: false, min: 600000 } })
  assert.equal(coldStartHook(cached('min-above', { warm: true, ttl: '1h', expires_at: sec(NOW + 52 * MIN), recache_tokens_if_cold: 527119 }), back, {}), undefined)
  saveConfig({ nudge: { on: false, min: 50000 } })
  assert.match(coldStartHook(cached('min-below', { warm: true, ttl: '1h', expires_at: sec(NOW + 52 * MIN), recache_tokens_if_cold: 60000 }), back, {}).systemMessage, /This prompt sent 60k tokens again\./)
})

test('the hook for a sent prompt says how the person pays as the status line of the session found it, also after more than a day', () => {
  const tokens = { systemMessage: coldText('12:52', 'This prompt sent 527k tokens again.') }
  const dollars = { systemMessage: coldText('12:52', 'This prompt cost about $8.43 more.') }
  // Only the status line is given the plan's limits. After 26 hours the shared reading of them is
  // too old to count, so the hook alone would find no sign of a plan.
  freshHome()
  assert.match(line(session({ rate_limits: { seven_day: { used_percentage: 56, resets_at: sec(NOW + 4 * DAY) } } })), /^week 56% used/)
  assert.equal(kept('one').billing, 'subscription')
  assert.deepEqual(billing(PROMPT, { env: {}, now: NOW + 26 * HOUR }), { mode: 'usage', sure: false, why: 'no sign of a plan, so figures are list prices' })
  assert.deepEqual(coldStartHook(PROMPT, NOW + 26 * HOUR, {}), tokens)
  // The same with a 5 hour limit only, whose window has ended when the person comes back.
  freshHome()
  line(session({ rate_limits: { five_hour: FIVE_HOUR } }))
  assert.deepEqual(readLimits(NOW + 6 * HOUR), {})
  assert.deepEqual(coldStartHook(PROMPT, NOW + 6 * HOUR, {}), tokens)
  // A subscriber with an API key in the shell: the status line goes by the plan's limits, and so does the hook.
  freshHome()
  const env = { ANTHROPIC_API_KEY: 'a-key' }
  assert.match(line(session({ rate_limits: { seven_day: WEEK } }), NOW, { env }), /^week 36% used/)
  assert.deepEqual(coldStartHook(PROMPT, NOW + 3 * HOUR, env), tokens)
  // A plan set by hand after the status line ran decides.
  freshHome()
  line(session({ rate_limits: { seven_day: WEEK } }))
  saveConfig({ plan: 'usage' })
  assert.deepEqual(coldStartHook(PROMPT, NOW + 3 * HOUR, {}), dollars)
  freshHome()
  line(session())
  assert.equal(kept('one').billing, 'usage')
  saveConfig({ plan: 'subscription' })
  assert.deepEqual(coldStartHook(PROMPT, NOW + 3 * HOUR, {}), tokens)
  // A session file from before the status line saved how the person pays, or with something else
  // in that place: the hook decides with what it has.
  freshHome()
  const sessions = join(process.env.KESTREL_HOME, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const old = { day: '2026-11-12', cost: 12.4, dayStart: 0, at: NOW, cacheUntil: NOW + 52 * MIN, ttl: '1h', recache: 527119, ctx: 527119, project: 'work/repo', model: 'claude-fable-5-2' }
  for (const [id, more] of [['old', {}], ['odd', { billing: 5 }], ['old-with-limits', {}]]) writeFileSync(join(sessions, `${id}.json`), JSON.stringify({ ...old, ...more }))
  assert.deepEqual(coldStartHook({ ...PROMPT, session_id: 'old' }, NOW + 3 * HOUR, {}), dollars)
  assert.deepEqual(coldStartHook({ ...PROMPT, session_id: 'odd' }, NOW + 3 * HOUR, {}), dollars)
  saveLimits({ seven_day: WEEK }, NOW)
  assert.deepEqual(coldStartHook({ ...PROMPT, session_id: 'old-with-limits' }, NOW + 3 * HOUR, {}), tokens)
})

test('the hook for a sent prompt keeps every other field of the session\'s file', () => {
  freshHome()
  saveConfig({ limits: { session: 10, action: 'ask' }, nudge: { on: true } })
  // The status line saves its figures and shows the notification, and the limit hook asks.
  line(session({ rate_limits: { seven_day: WEEK } }), NOW + 49 * MIN)
  assert.equal(sent.length, 1)
  assert.equal(limitHook({ session_id: 'one' }, NOW + 50 * MIN).hookSpecificOutput.permissionDecision, 'ask')
  const before = kept('one')
  assert.deepEqual(before, {
    day: '2026-11-12', cost: 12.4, dayStart: 0, at: NOW + 49 * MIN, billing: 'subscription',
    cacheUntil: NOW + 52 * MIN, ttl: '1h', recache: 527119, ctx: 527119, project: 'work/repo', model: 'claude-fable-5-2',
    compactBase: 527119, ctxSeen: 527119, nudgedFor: NOW + 52 * MIN, askedAt: 12.4,
  })
  assert.ok(coldStartHook(PROMPT, NOW + 3 * HOUR, {}))
  assert.deepEqual(kept('one'), { ...before, coldWarnedFor: NOW + 52 * MIN })
  // So the limit hook still knows that it asked, and the day's spend is still there.
  assert.equal(limitHook({ session_id: 'one' }, NOW + 3 * HOUR), undefined)
  saveConfig({ plan: 'usage' })
  assert.match(line(session({ session_id: 'two', cost: { total_cost_usd: 1, total_duration_ms: MIN } }), NOW + 3 * HOUR), /\| today \$13\.40$/)
})

test('when Claude Code no longer gives the end of the cache, the saved end stays and the next prompt gets its warning', () => {
  const input = session({ rate_limits: { seven_day: WEEK } })
  const back = NOW + 3 * HOUR
  // What the status line may be given at 13:00, 8 minutes after the end of the cache. What Claude
  // Code really gives then is not known, so each of these has to work.
  for (const prompt_cache of [
    // The cache is called lost, with no end time.
    { warm: false, ttl: '1h', recache_tokens_if_cold: 527119 },
    { warm: false },
    // Nothing about the cache.
    undefined,
    // No tokens to send again, with the old end and without it.
    { warm: false, ttl: '1h', expires_at: sec(NOW + 52 * MIN), recache_tokens_if_cold: 0 },
    { warm: false, recache_tokens_if_cold: 0 },
  ]) {
    freshHome()
    line(input)
    line({ ...input, prompt_cache }, NOW + HOUR)
    assert.equal(kept('one').cacheUntil, NOW + 52 * MIN, JSON.stringify(prompt_cache))
    assert.deepEqual(coldStartHook(PROMPT, back, {}), { systemMessage: coldText('12:52', 'This prompt sent 527k tokens again.') }, JSON.stringify(prompt_cache))
    // Once per end, also when the status line runs again with the same input.
    line({ ...input, prompt_cache }, back + MIN)
    assert.equal(coldStartHook(PROMPT, back + 2 * MIN, {}), undefined)
  }
  // How long the cache lasts stays with its end: by the token, a 5 minute cache costs less to write again.
  freshHome()
  const env = { ANTHROPIC_API_KEY: 'a-key' }
  const short = session({ prompt_cache: { warm: true, ttl: '5m', expires_at: sec(NOW + 4 * MIN), recache_tokens_if_cold: 527119 } })
  line(short, NOW, { env })
  line({ ...short, prompt_cache: undefined }, NOW + HOUR, { env })
  assert.deepEqual(coldStartHook(PROMPT, back, env), { systemMessage: coldText('12:04', 'This prompt cost about $5.27 more.') })
  // The amount is what Claude Code says now: a context that was emptied or made small after the end gets no warning.
  for (const context_window of [{}, { current_usage: { input_tokens: 2, cache_read_input_tokens: 20000 } }]) {
    freshHome()
    line(input)
    line({ ...input, context_window, prompt_cache: undefined }, NOW + HOUR)
    assert.equal(kept('one').cacheUntil, NOW + 52 * MIN)
    assert.equal(coldStartHook(PROMPT, back, {}), undefined)
    assert.equal(kept('one').coldWarnedFor, undefined)
  }
  // The answer to a prompt gives a new end. It takes the place of the saved one.
  freshHome()
  line(input)
  line({ ...input, prompt_cache: undefined }, NOW + HOUR)
  line({ ...input, prompt_cache: { warm: true, ttl: '1h', expires_at: sec(back + HOUR), recache_tokens_if_cold: 610000 } }, back)
  assert.equal(kept('one').cacheUntil, back + HOUR)
  assert.equal(coldStartHook(PROMPT, back + 30 * MIN, {}), undefined)
})

test('"kestrel hook cold-start" prints the warning once, and never fails or blocks a prompt', () => {
  freshHome()
  // Two session files as the status line writes them. The command takes the time from the clock,
  // so the end is one that has passed on any clock: noon on a day long ago, in UTC.
  const longAgo = Date.UTC(2001, 0, 1, 12)
  mkdirSync(join(process.env.KESTREL_HOME, 'sessions'), { recursive: true })
  for (const id of ['one', 'two']) {
    writeFileSync(join(process.env.KESTREL_HOME, 'sessions', `${id}.json`), JSON.stringify({ day: '2001-01-01', cost: 12.4, dayStart: 0, at: longAgo, billing: 'subscription', cacheUntil: longAgo, ttl: '1h', recache: 527119, ctx: 527119, project: 'work/repo', model: 'claude-fable-5-2' }))
  }
  // The command shows the end as a clock time in its own time zone. The test gives it one, so
  // that the expected time is the same on every machine and with every TZ variable of this run.
  const first = exec(['hook', 'cold-start'], { TZ: 'UTC' }, JSON.stringify(PROMPT))
  assert.deepEqual([first.status, first.stderr], [0, ''])
  assert.deepEqual(JSON.parse(first.stdout), { systemMessage: coldText('12:00', 'This prompt sent 527k tokens again.') })
  const second = exec(['hook', 'cold-start'], { TZ: 'UTC' }, JSON.stringify(PROMPT))
  assert.deepEqual([second.status, second.stdout, second.stderr], [0, '', ''])
  // In India the same moment is half past five in the afternoon.
  const india = exec(['hook', 'cold-start'], { TZ: 'Asia/Kolkata' }, JSON.stringify({ ...PROMPT, session_id: 'two' }))
  assert.deepEqual([india.status, india.stderr], [0, ''])
  assert.deepEqual(JSON.parse(india.stdout), { systemMessage: coldText('17:30', 'This prompt sent 527k tokens again.') })
  // An input that is not JSON, and a session file that is broken: no output, and no failure.
  const garbage = exec(['hook', 'cold-start'], {}, 'not json')
  assert.deepEqual([garbage.status, garbage.stdout, garbage.stderr], [0, '', ''])
  writeFileSync(join(process.env.KESTREL_HOME, 'sessions', 'broken.json'), '{"cacheUntil": 5, "recache"')
  const broken = exec(['hook', 'cold-start'], {}, JSON.stringify({ ...PROMPT, session_id: 'broken' }))
  assert.deepEqual([broken.status, broken.stdout, broken.stderr], [0, '', ''])
  assert.doesNotMatch(filesText(), /private/)
})

test('the change "cold-start-warn" adds the hook for a sent prompt and takes it out again, and keeps the other hooks', () => {
  freshHome()
  const autoAllow = { matcher: '', hooks: [{ type: 'command', command: '/x/auto-allow.sh' }] }
  const addContext = { hooks: [{ type: 'command', command: '/x/add-context.sh' }] }
  const before = { theme: 'dark', hooks: { PreToolUse: [autoAllow], UserPromptSubmit: [addContext] } }
  writeFileSync(SETTINGS, JSON.stringify(before))
  const ours = { hooks: [{ type: 'command', command: '/bin/kestrel hook cold-start', timeout: 5 }] }

  const said = applyAction('cold-start-warn', '/bin/kestrel').join('\n')
  assert.match(said, /It only warns: it never stops or changes a prompt\./)
  assert.match(said, /Take it back with: kestrel undo cold-start-warn/)
  assert.deepEqual(settings(), { theme: 'dark', hooks: { PreToolUse: [autoAllow], UserPromptSubmit: [addContext, ours] } })
  assert.deepEqual(Object.keys(appliedActions()), ['cold-start-warn'])
  // A second apply adds nothing.
  assert.deepEqual(applyAction('cold-start-warn', '/bin/kestrel'), ['cold-start-warn is already applied.'])
  assert.deepEqual(settings().hooks.UserPromptSubmit, [addContext, ours])

  // This tool's other hooks are for other events. They stay when this one is taken back.
  setHook('/bin/kestrel', true)
  applyAction('model-switch-cost', '/bin/kestrel')
  assert.match(undoAction('cold-start-warn', '/bin/kestrel')[0], /cold-start-warn is taken back/)
  assert.deepEqual(settings().hooks.UserPromptSubmit, [addContext])
  assert.deepEqual(settings().hooks.PreToolUse.map((m) => m.hooks[0].command), ['/x/auto-allow.sh', '/bin/kestrel hook'])
  assert.deepEqual(settings().hooks.PreModelSwitch.map((m) => m.hooks[0].command), ['/bin/kestrel hook model-switch'])
  assert.equal(settings().theme, 'dark')
  assert.deepEqual(Object.keys(appliedActions()), ['model-switch-cost'])
  assert.match(undoAction('cold-start-warn', '/bin/kestrel')[0], /was not applied by this tool/)

  // Without another hook for a sent prompt, taking it back leaves no empty list.
  writeFileSync(SETTINGS, JSON.stringify({ theme: 'dark', hooks: { PreToolUse: [autoAllow] } }))
  applyAction('cold-start-warn', '/bin/kestrel')
  assert.deepEqual(settings().hooks, { PreToolUse: [autoAllow], UserPromptSubmit: [ours] })
  undoAction('cold-start-warn', '/bin/kestrel')
  assert.deepEqual(settings(), { theme: 'dark', hooks: { PreToolUse: [autoAllow] } })
  // "uninstall" takes the hook out as well, and keeps the other one.
  writeFileSync(SETTINGS, JSON.stringify(before))
  applyAction('cold-start-warn', '/bin/kestrel')
  assert.equal(uninstall(), true)
  assert.deepEqual(settings(), before)
})

test('"kestrel apply" lists and makes the change "cold-start-warn", and "status" shows it', () => {
  freshHome()
  writeFileSync(SETTINGS, JSON.stringify(OTHER))
  assert.match(run(['apply']), /^  cold-start-warn\n    Adds a hook to Claude Code that runs when you send a prompt\./m)
  assert.match(run(['status']), /^Change: cold-start-warn +not applied$/m)
  assert.match(run(['apply', 'cold-start-warn']), /It only warns: it never stops or changes a prompt\./)
  // The settings call the link in this tool's own folder, not the one on the PATH.
  const command = `${join(process.env.KESTREL_HOME, 'bin', 'kestrel')} hook cold-start`
  assert.deepEqual(settings(), { ...OTHER, hooks: { ...OTHER.hooks, UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 5 }] }] } })
  assert.match(run(['status']), /^Change: cold-start-warn +applied on \d{4}-\d\d-\d\d$/m)
  assert.match(run(['undo', 'cold-start-warn']), /cold-start-warn is taken back/)
  assert.deepEqual(settings(), OTHER)
})

/** A session with the time it has spent on model calls so far, and a reading of the week that ends in 3 days. */
const busy = (apiMs, pct, extra = {}) => session({
  cost: { total_cost_usd: 12.4, total_duration_ms: 4 * HOUR, total_api_duration_ms: apiMs },
  rate_limits: { seven_day: { used_percentage: pct, resets_at: sec(NOW + 3 * DAY) } },
  ...extra,
})

test('a session that made a model call since its last run gives a fresh reading: its time moves to now, also at the same percent', () => {
  freshHome()
  const week = (now) => readLimits(now).week
  // The first run for a session has nothing to compare with, so it is not fresh.
  line(busy(1000, 40))
  assert.deepEqual(week(NOW), { pct: 40, resetsAt: NOW + 3 * DAY, at: NOW })
  assert.equal(kept('one').apiMs, 1000)
  // No model call since then: the same percent is not saved again, and the line says how old it is.
  assert.match(line(busy(1000, 40), NOW + 47 * MIN), /^week 40% used \(read 47 min ago\), /)
  assert.equal(week(NOW + 47 * MIN).at, NOW)
  // A model call since the last run: the same percent is true now, so the line no longer calls it old.
  assert.match(line(busy(2000, 40), NOW + 48 * MIN), /^week 40% used, /)
  assert.deepEqual(week(NOW + 48 * MIN), { pct: 40, resetsAt: NOW + 3 * DAY, at: NOW + 48 * MIN })
  assert.equal(kept('one').apiMs, 2000)
  // A fresh reading with a lower percent takes the place of the kept one.
  line(busy(3000, 38), NOW + 49 * MIN)
  assert.deepEqual(week(NOW + 49 * MIN), { pct: 38, resetsAt: NOW + 3 * DAY, at: NOW + 49 * MIN })
  // A run that is not fresh cannot lower the percent, and does not move the time.
  line(busy(3000, 30), NOW + 50 * MIN)
  assert.deepEqual(week(NOW + 50 * MIN), { pct: 38, resetsAt: NOW + 3 * DAY, at: NOW + 49 * MIN })
  // It can still raise it, as before.
  line(busy(3000, 39), NOW + 51 * MIN)
  assert.deepEqual(week(NOW + 51 * MIN), { pct: 39, resetsAt: NOW + 3 * DAY, at: NOW + 51 * MIN })
  // Another session that is idle does not become fresh by the first one's calls.
  line(busy(500, 20, { session_id: 'idle' }), NOW + 52 * MIN)
  line(busy(500, 20, { session_id: 'idle' }), NOW + 53 * MIN)
  assert.equal(week(NOW + 53 * MIN).pct, 39)
})

test('a run is not fresh without a saved time to compare with, or without a time in the input', () => {
  freshHome()
  // A session file from before the time was saved: the first run that has a time is not fresh.
  line(session({ rate_limits: { seven_day: { used_percentage: 57, resets_at: sec(NOW + 3 * DAY) } } }))
  assert.equal('apiMs' in kept('one'), false)
  line(busy(1000, 36), NOW + MIN)
  assert.deepEqual(readLimits(NOW + MIN).week, { pct: 57, resetsAt: NOW + 3 * DAY, at: NOW })
  assert.equal(kept('one').apiMs, 1000)
  // An input without the time is not fresh, and the saved time is taken out.
  line(session({ rate_limits: { seven_day: { used_percentage: 36, resets_at: sec(NOW + 3 * DAY) } } }), NOW + 2 * MIN)
  assert.equal(readLimits(NOW + 2 * MIN).week.pct, 57)
  assert.equal('apiMs' in kept('one'), false)
  // A time that is not a number does not count either.
  line(busy('soon', 36), NOW + 3 * MIN)
  line(busy('later', 36), NOW + 4 * MIN)
  assert.deepEqual(readLimits(NOW + 4 * MIN).week, { pct: 57, resetsAt: NOW + 3 * DAY, at: NOW })
})

test('a busy session that stays at one percent for more than a day still says that it is a subscription', () => {
  // A new session has no limits of its own. It goes by a reading of the last 24 hours.
  const newSession = (now) => billing({}, { env: {}, cfg: {}, now })
  freshHome()
  line(busy(1000, 40))
  line(busy(2000, 40), NOW + 25 * HOUR)
  assert.deepEqual(newSession(NOW + 26 * HOUR), { mode: 'subscription', sure: true, why: "the plan's limits were seen on this machine today" })
  // Without a model call in between, the reading is from more than a day ago.
  freshHome()
  line(busy(1000, 40))
  line(busy(1000, 40), NOW + 25 * HOUR)
  assert.equal(newSession(NOW + 26 * HOUR).sure, false)
})

test('the plan\'s limits: a fresh reading of the same window is saved as it is, and one that is not fresh only when its percent is higher', () => {
  freshHome()
  const end = NOW + 2 * HOUR
  const five = (pct, resetsAt = end) => ({ five_hour: { used_percentage: pct, resets_at: sec(resetsAt) } })
  saveLimits(five(50), NOW)
  // Not fresh, which is also what a call without the option is: lower and equal are left out.
  saveLimits(five(40), NOW + MIN)
  saveLimits(five(50), NOW + MIN, { fresh: false })
  assert.deepEqual(readLimits(NOW + MIN).five, { pct: 50, resetsAt: end, at: NOW })
  // Fresh: equal moves the time, and lower is taken.
  saveLimits(five(50), NOW + 2 * MIN, { fresh: true })
  assert.deepEqual(readLimits(NOW + 2 * MIN).five, { pct: 50, resetsAt: end, at: NOW + 2 * MIN })
  saveLimits(five(40), NOW + 3 * MIN, { fresh: true })
  assert.deepEqual(readLimits(NOW + 3 * MIN).five, { pct: 40, resetsAt: end, at: NOW + 3 * MIN })
  // The same window is an end time within 60 seconds of the kept one, earlier or later.
  saveLimits(five(30, end - 60e3), NOW + 4 * MIN, { fresh: true })
  assert.deepEqual(readLimits(NOW + 4 * MIN).five, { pct: 30, resetsAt: end - 60e3, at: NOW + 4 * MIN })
  saveLimits(five(20, end), NOW + 5 * MIN, { fresh: true })
  assert.deepEqual(readLimits(NOW + 5 * MIN).five, { pct: 20, resetsAt: end, at: NOW + 5 * MIN })
})

test('the plan\'s limits: a reading of an earlier window that is still open does not replace the saved one', () => {
  freshHome()
  const five = (pct, resetsAt) => ({ five_hour: { used_percentage: pct, resets_at: sec(resetsAt) } })
  saveLimits(five(30, NOW + 4 * HOUR), NOW)
  const saved = readLimits(NOW)
  // The earlier window ends in 2 hours, so it is still open. Its percent is higher.
  saveLimits(five(99, NOW + 2 * HOUR), NOW + MIN)
  assert.deepEqual(readLimits(NOW + MIN), saved)
  // 61 seconds before the kept end is an earlier window. 60 seconds before it is the same window.
  saveLimits(five(99, NOW + 4 * HOUR - 61e3), NOW + MIN)
  assert.deepEqual(readLimits(NOW + MIN), saved)
  saveLimits(five(99, NOW + 4 * HOUR - 60e3), NOW + MIN)
  assert.deepEqual(readLimits(NOW + MIN).five, { pct: 99, resetsAt: NOW + 4 * HOUR - 60e3, at: NOW + MIN })
  // A fresh reading is true now, for the account the session runs on now. So it wins also with an
  // earlier window: after a change of account, the kept reading is the old account's.
  saveLimits(five(12, NOW + 2 * HOUR), NOW + 2 * MIN, { fresh: true })
  assert.deepEqual(readLimits(NOW + 2 * MIN).five, { pct: 12, resetsAt: NOW + 2 * HOUR, at: NOW + 2 * MIN })
})

test('the plan\'s limits: a reading is given until its end time, and not from that millisecond on', () => {
  freshHome()
  const end = NOW + 2 * HOUR
  saveLimits({ five_hour: { used_percentage: 42, resets_at: sec(end) } }, NOW)
  assert.deepEqual(readLimits(end - 1), { five: { pct: 42, resetsAt: end, at: NOW } })
  assert.deepEqual(readLimits(end), {})
  assert.deepEqual(readLimits(end + 1), {})
})

test('the plan\'s limits: a reading whose end time cannot be true is ignored, and does not stand in the way of a true one', () => {
  const file = () => join(process.env.KESTREL_HOME, 'limits.json')
  const both = (pct, five, week) => ({ five_hour: { used_percentage: pct, resets_at: five }, seven_day: { used_percentage: pct, resets_at: week } })
  // An end time in milliseconds, read as seconds, lies thousands of years ahead.
  freshHome()
  saveLimits(both(99, NOW + 2 * HOUR, NOW + 3 * DAY), NOW)
  assert.equal(existsSync(file()), false)
  // The status line shows no such reading either.
  saveConfig({ plan: 'subscription' })
  assert.equal(line(session({ rate_limits: both(99, NOW + 2 * HOUR, NOW + 3 * DAY) })), `plan limits not reported yet | ${REST}`)
  assert.equal(existsSync(file()), false)
  // A true reading after it is saved as usual.
  saveLimits(both(42, sec(NOW + 2 * HOUR), sec(NOW + 3 * DAY)), NOW)
  const saved = { five: { pct: 42, resetsAt: NOW + 2 * HOUR, at: NOW }, week: { pct: 42, resetsAt: NOW + 3 * DAY, at: NOW } }
  assert.deepEqual(readLimits(NOW), saved)
  // An end that cannot be true does not replace a saved reading, also when it comes from a fresh run.
  saveLimits(both(99, NOW + 2 * HOUR, NOW + 3 * DAY), NOW + MIN, { fresh: true })
  saveLimits(both(99, sec(NOW + 9 * HOUR), sec(NOW + 9 * DAY)), NOW + MIN, { fresh: true })
  assert.deepEqual(readLimits(NOW + MIN), saved)

  // The furthest end that is taken is the window's length plus 10 minutes away. These two ends are
  // that far from NOW, so one millisecond before NOW they are too far away.
  const far = both(7, sec(NOW + 5 * HOUR + 10 * MIN), sec(NOW + 7 * DAY + 10 * MIN))
  freshHome()
  saveLimits(far, NOW - 1)
  assert.equal(existsSync(file()), false)
  saveLimits(far, NOW)
  assert.deepEqual(readLimits(NOW), { five: { pct: 7, resetsAt: NOW + 5 * HOUR + 10 * MIN, at: NOW }, week: { pct: 7, resetsAt: NOW + 7 * DAY + 10 * MIN, at: NOW } })
  // One second further away is too far.
  freshHome()
  saveLimits(both(7, sec(NOW + 5 * HOUR + 10 * MIN + 1e3), sec(NOW + 7 * DAY + 10 * MIN + 1e3)), NOW)
  assert.equal(existsSync(file()), false)

  // An end of up to 60 seconds ago is still taken, because two clocks can differ by that much.
  // Its window has ended by this machine's clock, so it is in the file and is not given as a limit.
  const past = both(80, sec(NOW - 60e3), sec(NOW - 60e3))
  freshHome()
  saveLimits(past, NOW + 1)
  assert.equal(existsSync(file()), false)
  saveLimits(past, NOW)
  // The file keeps one reading per account. A session whose account is not known saves it as "unknown".
  assert.deepEqual(JSON.parse(readFileSync(file(), 'utf8')), { unknown: { five: { pct: 80, resetsAt: NOW - 60e3, at: NOW }, week: { pct: 80, resetsAt: NOW - 60e3, at: NOW } } })
  assert.deepEqual(readLimits(NOW), {})
  // An idle session gives the same ended reading on every run. The file is written once, and not
  // again on the next run, which is still inside the 60 seconds.
  freshHome()
  const ended = both(80, sec(NOW - 20e3), sec(NOW - 20e3))
  saveLimits(ended, NOW)
  const before = readFileSync(file(), 'utf8')
  assert.deepEqual(JSON.parse(before).unknown.five, { pct: 80, resetsAt: NOW - 20e3, at: NOW })
  saveLimits(ended, NOW + 30e3)
  saveLimits(both(90, sec(NOW - 20e3), sec(NOW - 20e3)), NOW + 30e3, { fresh: true })
  assert.equal(readFileSync(file(), 'utf8'), before)
  // A reading of the window that runs now takes its place.
  saveLimits(both(3, sec(NOW + 4 * HOUR), sec(NOW + 6 * DAY)), NOW + 30e3)
  assert.deepEqual(readLimits(NOW + 30e3), { five: { pct: 3, resetsAt: NOW + 4 * HOUR, at: NOW + 30e3 }, week: { pct: 3, resetsAt: NOW + 6 * DAY, at: NOW + 30e3 } })
})

test('the 5 hour limit is red when it is on pace to be full within exactly 30 minutes, and yellow one millisecond before that', () => {
  // 60% used after 45 minutes: full after 75 minutes, which is 30 minutes from now.
  const reading = { five_hour: { used_percentage: 60, resets_at: sec(NOW + 255 * MIN) } }
  const part = (now) => {
    freshHome()
    return coloured(session({ rate_limits: reading }), now)[0]
  }
  assert.deepEqual(part(NOW), ['5 hour limit 60% used, 15% of its time gone: full about 3.8 hours early', 'bad'])
  // One millisecond later it is full in 30 minutes and two thirds of a millisecond: yellow.
  assert.equal(part(NOW + 1)[1], 'warn')
  // One millisecond earlier it is full in a little under 30 minutes: red.
  assert.equal(part(NOW - 1)[1], 'bad')
})

test('the week is red when it is on pace to be full within exactly 1 day, and yellow one millisecond before that', () => {
  // 60% used after 1.5 days: full after 2.5 days, which is 1 day from now.
  const reading = { seven_day: { used_percentage: 60, resets_at: sec(NOW + 5.5 * DAY) } }
  const part = (now) => {
    freshHome()
    return coloured(session({ rate_limits: reading }), now)[0]
  }
  assert.deepEqual(part(NOW), ['week 60% used, 21% of the week gone: full about 4.5 days early', 'bad'])
  assert.equal(part(NOW + 1)[1], 'warn')
  assert.equal(part(NOW - 1)[1], 'bad')
})

test('a 5 minute cache warns from exactly 1 minute before its end, and a 1 hour cache from exactly 10 minutes', () => {
  freshHome()
  const cache = (ttl, left, now) => coloured(session({ rate_limits: weekAt(36, 0.44), prompt_cache: { warm: true, ttl, expires_at: sec(NOW + left) } }), now)[1]
  assert.deepEqual(cache('5m', MIN, NOW - 1), ['cache warm, 2 min left', 'good'])
  assert.deepEqual(cache('5m', MIN, NOW), ['cache warm, 1 min left', 'warn'])
  assert.deepEqual(cache('5m', MIN, NOW + 1), ['cache warm, 1 min left', 'warn'])
  assert.deepEqual(cache('1h', 10 * MIN, NOW - 1), ['cache warm, 11 min left', 'good'])
  assert.deepEqual(cache('1h', 10 * MIN, NOW), ['cache warm, 10 min left', 'warn'])
  assert.deepEqual(cache('1h', 10 * MIN, NOW + 1), ['cache warm, 10 min left', 'warn'])
})

test('session files that the status line has not seen for more than 14 days are deleted, at most once a day', () => {
  freshHome()
  const home = process.env.KESTREL_HOME
  const sessions = join(home, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const put = (id, at) => writeFileSync(join(sessions, `${id}.json`), JSON.stringify({ day: '2026-10-29', cost: 3, dayStart: 0, at }))
  const names = () => readdirSync(sessions).sort()
  const lastLook = () => JSON.parse(readFileSync(join(home, 'sweep.json'), 'utf8'))
  put('old', NOW - 14 * DAY - 1)
  put('at-the-bound', NOW - 14 * DAY)
  put('young', NOW - DAY)
  // A file that cannot be read, and one without a time, are left alone.
  writeFileSync(join(sessions, 'broken.json'), '{"at": 5, "cost"')
  writeFileSync(join(sessions, 'no-time.json'), JSON.stringify({ cost: 3 }))
  line(session())
  assert.deepEqual(names(), ['at-the-bound.json', 'broken.json', 'no-time.json', 'one.json', 'young.json'])
  assert.deepEqual(lastLook(), { at: NOW })
  // The next look is a day after the last one, and not a millisecond before.
  put('old-again', NOW - 20 * DAY)
  line(session(), NOW + DAY - 1)
  assert.deepEqual(names(), ['at-the-bound.json', 'broken.json', 'no-time.json', 'old-again.json', 'one.json', 'young.json'])
  assert.deepEqual(lastLook(), { at: NOW })
  line(session(), NOW + DAY)
  // By then the file at the bound is 15 days old.
  assert.deepEqual(names(), ['broken.json', 'no-time.json', 'one.json', 'young.json'])
  assert.deepEqual(lastLook(), { at: NOW + DAY })
  // The session of this run has just been seen, so its own file stays, with what it held: the $3
  // that it had spent before today are still the start of its day.
  put('one', NOW - 30 * DAY)
  line(session(), NOW + 2 * DAY)
  assert.equal(kept('one').at, NOW + 2 * DAY)
  assert.equal(kept('one').dayStart, 3)
})

test('a look for old session files that fails does not break the status line', () => {
  freshHome()
  const home = process.env.KESTREL_HOME
  // A folder stands where the time of the last look is kept, so that time cannot be saved.
  mkdirSync(join(home, 'sweep.json'), { recursive: true })
  mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(join(home, 'sessions', 'old.json'), JSON.stringify({ at: NOW - 30 * DAY }))
  assert.equal(line(session({ rate_limits: { seven_day: WEEK } })), `week 36% used, 44% of the week gone | ${REST}`)
  assert.equal(kept('one').at, NOW)
  // The look stopped before it deleted anything.
  assert.equal(existsSync(join(home, 'sessions', 'old.json')), true)
})

test('a session id that is not a plain name does not become a file name: the file is "unknown.json"', () => {
  freshHome()
  const home = process.env.KESTREL_HOME
  const sessions = join(home, 'sessions')
  saveConfig({ limits: { session: 10, action: 'ask' } })
  // A file one folder up, where "../x" would point. Nothing reads it and nothing writes it.
  const outside = JSON.stringify({ day: '2026-11-12', cost: 99, dayStart: 0, at: NOW, cacheUntil: NOW + MIN, recache: 900000, ctx: 900000 })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'x.json'), outside)
  assert.equal(limitHook({ session_id: '../x' }, NOW), undefined)
  assert.equal(coldStartHook({ ...PROMPT, session_id: '../x' }, NOW + 3 * HOUR, {}), undefined)
  // The status line, the limit hook and the hook for a sent prompt all use the same file.
  line(session({ session_id: '../x', rate_limits: { seven_day: WEEK } }))
  assert.deepEqual(readdirSync(sessions), ['unknown.json'])
  assert.equal(limitHook({ session_id: '../x' }, NOW).hookSpecificOutput.permissionDecision, 'ask')
  assert.equal(kept('unknown').askedAt, 12.4)
  assert.deepEqual(coldStartHook({ ...PROMPT, session_id: '../x' }, NOW + 3 * HOUR, {}), { systemMessage: coldText('12:52', 'This prompt sent 527k tokens again.') })
  assert.equal(kept('unknown').coldWarnedFor, NOW + 52 * MIN)
  assert.deepEqual(readdirSync(sessions), ['unknown.json'])
  assert.equal(readFileSync(join(home, 'x.json'), 'utf8'), outside)
  assert.deepEqual(readdirSync(home).sort(), ['config.json', 'limits.json', 'sessions', 'sweep.json', 'x.json'])

  // Other ids that are not plain names, and an id that is missing or not text.
  freshHome()
  for (const id of ['..', '.', '.hidden', 'a/b', 'a\\b', 'a b', 'a\nb', 'café', '', 'x'.repeat(101), 5, null, undefined, ['a']]) {
    line(session({ session_id: id }))
    assert.deepEqual(readdirSync(join(process.env.KESTREL_HOME, 'sessions')), ['unknown.json'], JSON.stringify(id))
  }
  // A plain name is used as it is: letters, digits, ".", "_" and "-", up to 100 characters.
  const plain = ['7f3a9c1e-22b4-4d0a-9c3e-5a1b2c3d4e5f', 'a.b_c-D9', '-', '_x.', 'x'.repeat(100)]
  for (const id of plain) line(session({ session_id: id }))
  assert.deepEqual(readdirSync(join(process.env.KESTREL_HOME, 'sessions')).sort(), [...plain.map((id) => `${id}.json`), 'unknown.json'].sort())
})

test('the tokens to send again are the size of the context when Claude Code gives none or 0: on the line, in the notification and in the warning for a sent prompt', () => {
  const input = (prompt_cache) => session({ rate_limits: { seven_day: WEEK }, prompt_cache })
  for (const recache_tokens_if_cold of [0, undefined, -5, 'many']) {
    const name = JSON.stringify(recache_tokens_if_cold)
    freshHome()
    saveConfig({ nudge: { on: true } })
    // The line, for a cache that is gone: the context of 527,119 tokens, in red because it is large.
    assert.deepEqual(coloured(input({ warm: false, recache_tokens_if_cold }))[1], ['cache gone: the next call re-sends 527k', 'bad'], name)
    assert.deepEqual(sent, [], name)
    // The notification, 3 minutes before the end of a warm cache.
    line(input({ warm: true, ttl: '1h', expires_at: sec(NOW + 3 * MIN), recache_tokens_if_cold }))
    assert.deepEqual(sent, [['kestrel: work/repo cache ends at 12:03', IDLE_BODY('12:03')]], name)
    // The warning for a prompt that is sent after the end.
    assert.deepEqual(coldStartHook(PROMPT, NOW + HOUR, {}), { systemMessage: coldText('12:03', 'This prompt sent 527k tokens again.') }, name)
  }
  // A number above 0 is used as it is, in all three places.
  freshHome()
  saveConfig({ nudge: { on: true } })
  assert.deepEqual(coloured(input({ warm: false, recache_tokens_if_cold: 300000 }))[1], ['cache gone: the next call re-sends 300k', 'bad'])
  line(input({ warm: true, ttl: '1h', expires_at: sec(NOW + 3 * MIN), recache_tokens_if_cold: 300000 }))
  assert.deepEqual(sent, [['kestrel: work/repo cache ends at 12:03', IDLE_BODY('12:03', '300k')]])
  assert.deepEqual(coldStartHook(PROMPT, NOW + HOUR, {}), { systemMessage: coldText('12:03', 'This prompt sent 300k tokens again.') })
})

test('"kestrel nudge on" takes --before from 1 to 30 and --min from 1, and a bad number fails and changes nothing', () => {
  freshHome()
  const config = () => JSON.parse(readFileSync(join(process.env.KESTREL_HOME, 'config.json'), 'utf8'))
  writeFileSync(SETTINGS, JSON.stringify(OTHER))
  installStatusLine('/bin/kestrel')
  // The lowest and the highest number that are taken.
  assert.equal(exec(['nudge', 'on', '--before', '1', '--min', '1']).status, 0)
  assert.deepEqual(config().nudge, { on: true, before: 1, min: 1 })
  assert.equal(exec(['nudge', 'on', '--before', '30']).status, 0)
  assert.deepEqual(config().nudge, { on: true, before: 30, min: 1 })
  // One step outside: the command fails with one sentence, and the settings stay.
  for (const [args, sentence] of [
    [['--before', '0'], 'kestrel: --before is a whole number of minutes from 1 to 30.\n'],
    [['--before', '31'], 'kestrel: --before is a whole number of minutes from 1 to 30.\n'],
    [['--min', '0'], 'kestrel: --min is a whole number of tokens, 1 or more.\n'],
    [['--min', '99999999999999999999'], 'kestrel: --min is a whole number of tokens, 1 or more.\n'],
  ]) {
    const r = exec(['nudge', 'on', ...args])
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, '', sentence], args.join(' '))
    assert.deepEqual(config().nudge, { on: true, before: 30, min: 1 })
  }
})

test('the hook for a sent prompt saves that it warned only after the text of the warning is built', () => {
  freshHome()
  const env = { ANTHROPIC_API_KEY: 'a-key' }
  line(session(), NOW, { env })
  const file = join(process.env.KESTREL_HOME, 'sessions', 'one.json')
  const good = kept('one')
  // A model id that is not text makes the price lookup throw while the text is built.
  writeFileSync(file, JSON.stringify({ ...good, model: 5 }))
  assert.throws(() => coldStartHook(PROMPT, NOW + 3 * HOUR, env))
  assert.equal(kept('one').coldWarnedFor, undefined)
  // So the warning is not lost: once the text can be built, the next prompt gets it.
  writeFileSync(file, JSON.stringify(good))
  assert.deepEqual(coldStartHook(PROMPT, NOW + 3 * HOUR, env), { systemMessage: coldText('12:52', 'This prompt cost about $8.43 more.') })
  assert.equal(kept('one').coldWarnedFor, NOW + 52 * MIN)
})

test('"kestrel hook cold-start" prints nothing and exits 0 when the hook itself throws', () => {
  freshHome()
  const longAgo = Date.UTC(2001, 0, 1, 12)
  const sessions = join(process.env.KESTREL_HOME, 'sessions')
  mkdirSync(sessions, { recursive: true })
  // The same session file as in the test of the command above, with a model id that is not text.
  const broken = { day: '2001-01-01', cost: 12.4, dayStart: 0, at: longAgo, billing: 'usage', cacheUntil: longAgo, ttl: '1h', recache: 527119, ctx: 527119, project: 'work/repo', model: 5 }
  writeFileSync(join(sessions, 'one.json'), JSON.stringify(broken))
  // The hook throws on it.
  assert.throws(() => coldStartHook(PROMPT, NOW, {}), TypeError)
  const r = exec(['hook', 'cold-start'], { TZ: 'UTC' }, JSON.stringify(PROMPT))
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''])
  assert.deepEqual(kept('one'), broken)
  // With a model id that is text, the same file gives the warning.
  writeFileSync(join(sessions, 'one.json'), JSON.stringify({ ...broken, model: 'claude-fable-5-2' }))
  const fine = exec(['hook', 'cold-start'], { TZ: 'UTC' }, JSON.stringify(PROMPT))
  assert.deepEqual([fine.status, fine.stderr], [0, ''])
  assert.deepEqual(JSON.parse(fine.stdout), { systemMessage: coldText('12:00', 'This prompt cost about $8.43 more.') })
})

test('"status" says that the change "cold-start-warn" is no longer in the settings when its hook was removed by hand', () => {
  freshHome()
  const autoAllow = { matcher: '', hooks: [{ type: 'command', command: '/x/auto-allow.sh' }] }
  writeFileSync(SETTINGS, JSON.stringify({ theme: 'dark', hooks: { PreToolUse: [autoAllow] } }))
  assert.match(run(['apply', 'cold-start-warn']), /It only warns: it never stops or changes a prompt\./)
  assert.match(run(['status']), /^Change: cold-start-warn +applied on \d{4}-\d\d-\d\d$/m)
  // The person takes the hook out of the settings file by hand.
  writeFileSync(SETTINGS, JSON.stringify({ theme: 'dark', hooks: { PreToolUse: [autoAllow] } }))
  assert.match(run(['status']), /^Change: cold-start-warn +applied on \d{4}-\d\d-\d\d, but no longer in the settings$/m)
  // Another tool's hook for the same event does not count as this tool's.
  writeFileSync(SETTINGS, JSON.stringify({ theme: 'dark', hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/x/add-context.sh' }] }] } }))
  assert.match(run(['status']), /^Change: cold-start-warn +applied on \d{4}-\d\d-\d\d, but no longer in the settings$/m)
  // A second apply puts the hook back, and the row is as before.
  assert.match(run(['apply', 'cold-start-warn']), /It only warns: it never stops or changes a prompt\./)
  assert.match(run(['status']), /^Change: cold-start-warn +applied on \d{4}-\d\d-\d\d$/m)
})

test('taking this tool\'s hook out of a group keeps the other tool\'s hook in that group', () => {
  freshHome()
  const other = { type: 'command', command: '/x/auto-allow.sh' }
  const limit = { type: 'command', command: '/bin/kestrel hook', timeout: 5 }
  const cold = { type: 'command', command: '/bin/kestrel hook cold-start', timeout: 5 }
  const addContext = { type: 'command', command: '/x/add-context.sh' }
  // Each event has one group that holds this tool's hook and another tool's hook, and one group of this tool alone.
  const shared = () => ({
    theme: 'dark',
    statusLine: { type: 'command', command: '/bin/kestrel statusline' },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [other, limit] }, { matcher: '', hooks: [limit] }],
      UserPromptSubmit: [{ hooks: [cold, addContext] }, { hooks: [cold] }],
      PreModelSwitch: [{ hooks: [{ type: 'command', command: '/bin/kestrel hook model-switch', timeout: 5 }] }],
    },
  })
  // The hook that holds a limit.
  writeFileSync(SETTINGS, JSON.stringify(shared()))
  assert.equal(setHook('/bin/kestrel', false), true)
  assert.deepEqual(settings().hooks.PreToolUse, [{ matcher: 'Bash', hooks: [other] }])
  assert.deepEqual(settings().hooks.UserPromptSubmit, shared().hooks.UserPromptSubmit)
  // Turned on again, it gets a group of its own, and the other tool's group stays as it is.
  assert.equal(setHook('/bin/kestrel', true), true)
  assert.deepEqual(settings().hooks.PreToolUse, [{ matcher: 'Bash', hooks: [other] }, { matcher: '', hooks: [limit] }])
  assert.equal(setHook('/bin/kestrel', true), false)

  // The hook of a change, taken back with "undo".
  writeFileSync(SETTINGS, JSON.stringify(shared()))
  applyAction('cold-start-warn', '/bin/kestrel')
  assert.match(undoAction('cold-start-warn', '/bin/kestrel')[0], /cold-start-warn is taken back/)
  assert.deepEqual(settings().hooks.UserPromptSubmit, [{ hooks: [addContext] }])
  assert.deepEqual(settings().hooks.PreToolUse, shared().hooks.PreToolUse)

  // "uninstall" takes out every hook of this tool, and only those.
  writeFileSync(SETTINGS, JSON.stringify(shared()))
  assert.equal(uninstall(), true)
  assert.deepEqual(settings(), { theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [other] }], UserPromptSubmit: [{ hooks: [addContext] }] } })
  // With nothing of this tool left, a second run changes nothing.
  assert.equal(uninstall(), false)
})

test('a command of another tool whose name only ends in "kestrel" is not this tool\'s: it stays in its group, and it stays the status line', () => {
  freshHome()
  const theirs = { type: 'command', command: '/usr/bin/other-kestrel hook' }
  const theirsToo = { type: 'command', command: '/usr/bin/my_kestrel hook keep-warm' }
  const theirPrompt = { type: 'command', command: '/usr/bin/other-kestrel hook cold-start' }
  // This tool at another path, from an older install. That one is this tool's, and is replaced.
  const oursElsewhere = { type: 'command', command: '/opt/foo/kestrel hook keep-warm', asyncRewake: true, timeout: 3600 }
  const ours = { type: 'command', command: '/bin/kestrel hook keep-warm', asyncRewake: true, timeout: 3600 }
  const limit = { type: 'command', command: '/bin/kestrel hook', timeout: 5 }
  const before = {
    theme: 'dark',
    statusLine: { type: 'command', command: '/usr/bin/other-kestrel statusline' },
    hooks: { Stop: [{ hooks: [oursElsewhere, theirs, theirsToo] }], PreToolUse: [{ matcher: '', hooks: [theirs] }], UserPromptSubmit: [{ hooks: [theirPrompt] }] },
  }
  writeFileSync(SETTINGS, JSON.stringify(before))

  // A change adds this tool's hook, and takes only this tool's hooks out of a group.
  applyAction('keep-warm', '/bin/kestrel')
  assert.deepEqual(settings().hooks.Stop, [{ hooks: [theirs, theirsToo] }, { hooks: [ours] }])
  undoAction('keep-warm', '/bin/kestrel')
  assert.deepEqual(settings().hooks.Stop, [{ hooks: [theirs, theirsToo] }])
  // The other tool's hook for a sent prompt is not this tool's change either: once this tool's
  // hook is taken out by hand, the change is no longer in the settings.
  applyAction('cold-start-warn', '/bin/kestrel')
  writeFileSync(SETTINGS, JSON.stringify({ ...settings(), hooks: { ...settings().hooks, UserPromptSubmit: [{ hooks: [theirPrompt] }] } }))
  assert.match(run(['status']), /^Change: cold-start-warn +applied on \d{4}-\d\d-\d\d, but no longer in the settings$/m)
  undoAction('cold-start-warn', '/bin/kestrel')
  assert.deepEqual(settings().hooks.UserPromptSubmit, [{ hooks: [theirPrompt] }])

  // The hook that holds a limit.
  assert.equal(installed().hook, false)
  assert.equal(setHook('/bin/kestrel', true), true)
  assert.deepEqual(settings().hooks.PreToolUse, [{ matcher: '', hooks: [theirs] }, { matcher: '', hooks: [limit] }])
  assert.equal(installed().hook, true)
  assert.equal(setHook('/bin/kestrel', false), true)
  assert.deepEqual(settings().hooks.PreToolUse, [{ matcher: '', hooks: [theirs] }])

  // The status line of the other tool is kept, and "uninstall" finds nothing of this tool.
  assert.equal(installStatusLine('/bin/kestrel'), 'Claude Code already has a status line (/usr/bin/other-kestrel statusline). It was kept. Use --force to replace it.')
  assert.deepEqual(installed(), { statusLine: false, otherStatusLine: '/usr/bin/other-kestrel statusline', hook: false, refresh: 0 })
  assert.equal(uninstall(), false)
  assert.deepEqual(settings(), { ...before, hooks: { ...before.hooks, Stop: [{ hooks: [theirs, theirsToo] }] } })
})

test('the settings file is replaced as a whole: a reader that has it open still sees all of the old text, and the file keeps its mode and stays a link', () => {
  freshHome()
  const old = `${JSON.stringify(OTHER, null, 2)}\n`
  writeFileSync(SETTINGS, old)
  chmodSync(SETTINGS, 0o600)
  // A program that has the file open while this tool writes. Written in place, the file would
  // be empty for a moment, and this reader would get the new text or a part of it.
  const reader = openSync(SETTINGS, 'r')
  try {
    installStatusLine('/bin/kestrel')
    assert.equal(readFileSync(reader, 'utf8'), old)
  } finally {
    closeSync(reader)
  }
  assert.deepEqual(settings(), { ...OTHER, statusLine: { type: 'command', command: '/bin/kestrel statusline', refreshInterval: 30 } })
  assert.equal(statSync(SETTINGS).mode & 0o777, 0o600)
  // The new file that took its place has not left anything behind.
  assert.deepEqual(readdirSync(process.env.CLAUDE_CONFIG_DIR).filter((f) => f.startsWith('settings.json.')), [])

  // A settings file that is a link to a file in another folder, as some people keep it.
  const real = join(dir, 'kept-elsewhere.json')
  writeFileSync(real, old)
  rmSync(SETTINGS)
  symlinkSync(real, SETTINGS)
  try {
    setHook('/bin/kestrel', true)
    assert.equal(lstatSync(SETTINGS).isSymbolicLink(), true)
    assert.deepEqual(JSON.parse(readFileSync(real, 'utf8')).hooks.PreToolUse.at(-1), { matcher: '', hooks: [{ type: 'command', command: '/bin/kestrel hook', timeout: 5 }] })
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('kept-elsewhere.json.')), [])
  } finally {
    // The other tests get a plain file again.
    rmSync(SETTINGS)
    writeFileSync(SETTINGS, old)
  }
})

test('settings that are not in the shape Claude Code writes are not changed, and one sentence says why', () => {
  freshHome()
  const text = () => readFileSync(SETTINGS, 'utf8')
  // The file holds a list, text, a number or nothing, where an object is expected.
  for (const odd of ['[]', '[{"theme":"dark"}]', '"text"', '5', 'null']) {
    writeFileSync(SETTINGS, odd)
    for (const change of [() => applyAction('effort-default', '/bin/kestrel'), () => applyAction('subagent-model', '/bin/kestrel'), () => applyAction('keep-warm', '/bin/kestrel'), () => installStatusLine('/bin/kestrel'), () => setHook('/bin/kestrel', true), () => uninstall()]) {
      assert.throws(change, { message: `${SETTINGS} does not hold a JSON object, so this tool does not change it.` }, odd)
    }
    assert.equal(text(), odd)
  }
  // Nothing counts as applied, and keep-warm was not turned on.
  assert.deepEqual(appliedActions(), {})
  assert.equal(existsSync(join(process.env.KESTREL_HOME, 'config.json')), false)
  // The command says the same in one line, and fails.
  writeFileSync(SETTINGS, '[]')
  const failed = exec(['apply', 'effort-default'])
  assert.deepEqual([failed.status, failed.stdout, failed.stderr], [1, '', `kestrel: ${SETTINGS} does not hold a JSON object, so this tool does not change it.\n`])
  assert.equal(text(), '[]')

  // An "env" that is text, a list or a number. Text would become one key per letter.
  for (const env of ['abc', ['a', 'b'], 5]) {
    const odd = JSON.stringify({ theme: 'dark', env })
    writeFileSync(SETTINGS, odd)
    assert.throws(() => applyAction('subagent-model', '/bin/kestrel'), { message: `"env" in ${SETTINGS} is not an object, so "CLAUDE_CODE_SUBAGENT_MODEL" cannot be set in it.` })
    assert.equal(text(), odd)
  }
  // "hooks" that is text, and an event that holds text.
  let odd = JSON.stringify({ theme: 'dark', hooks: 'abc' })
  writeFileSync(SETTINGS, odd)
  assert.throws(() => applyAction('keep-warm', '/bin/kestrel'), { message: `"hooks" in ${SETTINGS} is not an object, so this tool does not change it.` })
  assert.throws(() => setHook('/bin/kestrel', true), { message: `"hooks" in ${SETTINGS} is not an object, so this tool does not change it.` })
  assert.equal(text(), odd)
  odd = JSON.stringify({ theme: 'dark', hooks: { Stop: 'x', PreToolUse: { a: 1 } } })
  writeFileSync(SETTINGS, odd)
  assert.throws(() => applyAction('keep-warm', '/bin/kestrel'), { message: `"hooks.Stop" in ${SETTINGS} is not a list, so this tool does not change it.` })
  assert.throws(() => setHook('/bin/kestrel', true), { message: `"hooks.PreToolUse" in ${SETTINGS} is not a list, so this tool does not change it.` })
  assert.equal(text(), odd)
  assert.deepEqual(appliedActions(), {})
  assert.equal(existsSync(join(process.env.KESTREL_HOME, 'config.json')), false)
  // What is installed can still be looked at, and "uninstall" takes out what is this tool's and leaves the rest.
  const limit = { type: 'command', command: '/bin/kestrel hook', timeout: 5 }
  writeFileSync(SETTINGS, JSON.stringify({ statusLine: { type: 'command', command: '/bin/kestrel statusline', refreshInterval: 'often' }, hooks: { Stop: 'x', PreToolUse: [{ hooks: 'y' }, 7, { hooks: [limit] }] } }))
  assert.deepEqual(installed(), { statusLine: true, otherStatusLine: undefined, hook: true, refresh: 0 })
  assert.equal(uninstall(), true)
  assert.deepEqual(settings(), { hooks: { Stop: 'x', PreToolUse: [{ hooks: 'y' }, 7] } })
  writeFileSync(SETTINGS, JSON.stringify(OTHER))
})

test('a number in the settings that JavaScript cannot hold is written back as it was read', () => {
  freshHome()
  writeFileSync(SETTINGS, '{"theme":"dark","large":12345678901234567890,"list":[-98765432109876543210,1e400,9007199254740991,3,0.5],"env":{"SEED":18446744073709551615}}')
  installStatusLine('/bin/kestrel')
  applyAction('subagent-model', '/bin/kestrel')
  applyAction('keep-warm', '/bin/kestrel')
  undoAction('keep-warm', '/bin/kestrel')
  undoAction('subagent-model', '/bin/kestrel')
  assert.equal(uninstall(), true)
  assert.equal(readFileSync(SETTINGS, 'utf8').replace(/\s/g, ''), '{"theme":"dark","large":12345678901234567890,"list":[-98765432109876543210,1e400,9007199254740991,3,0.5],"env":{"SEED":18446744073709551615},"hooks":{}}')
  writeFileSync(SETTINGS, JSON.stringify(OTHER))
})

test('two changes in the same millisecond keep both copies of the settings file', (t) => {
  freshHome()
  // The clock stands still, so every copy of this test gets the same time in its name.
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  try {
    const first = JSON.stringify({ theme: 'dark' })
    writeFileSync(SETTINGS, first)
    installStatusLine('/bin/kestrel')
    const second = readFileSync(SETTINGS, 'utf8')
    setHook('/bin/kestrel', true)
    const third = readFileSync(SETTINGS, 'utf8')
    setHook('/bin/kestrel', false)
    const backup = join(process.env.KESTREL_HOME, 'backup')
    const time = new Date(NOW).toISOString().replace(/[:.]/g, '-')
    assert.deepEqual(readdirSync(backup).sort(), [`settings.${time}-2.json`, `settings.${time}-3.json`, `settings.${time}.json`])
    assert.deepEqual([`settings.${time}.json`, `settings.${time}-2.json`, `settings.${time}-3.json`].map((name) => readFileSync(join(backup, name), 'utf8')), [first, second, third])
  } finally {
    t.mock.timers.reset()
    writeFileSync(SETTINGS, JSON.stringify(OTHER))
  }
})

const { keepWarmDue, keepWarmHook, keepWarmPlan, keepWarmWait } = await import('../src/claude-code.mjs')
const { keepWarmConfig, keepWarmRecord, keepWarmReport } = await import('../src/keep-warm.mjs')

// What Claude Code gives the hook that runs after an answer. The hook must not read or keep the answer.
const STOP = { session_id: 'one', hook_event_name: 'Stop', cwd: '/work/repo', stop_hook_active: false, last_assistant_message: 'a private answer' }
const WAKE = "kestrel keep-warm: nobody typed for a while and this session's cache was about to end. Reply with the single word: ok"
/** A session on a subscription whose only limit is green. Its cache lasts 1 hour and ends at `end`: 52 minutes after noon unless another end is given. */
const idle = (end = NOW + 52 * MIN, extra = {}) => session({ rate_limits: { seven_day: WEEK }, prompt_cache: { warm: true, ttl: '1h', expires_at: sec(end), recache_tokens_if_cold: 527119 }, ...extra })
/** The plan of the keep-warm hook for an answer that ended at `now`, with an empty environment. */
const planAt = (now, input = STOP) => keepWarmPlan(input, now, { env: {} })
/** A new folder with keep-warm turned on, and the session "one" as the status line saw it at noon. */
const keepWarmOn = (settings = {}) => {
  freshHome()
  saveConfig({ keepWarm: { on: true, ...settings } })
  line(idle())
}
/** Changes what is kept about a session, as the status line or a hook would. */
const keep = (id, change) => writeFileSync(join(process.env.KESTREL_HOME, 'sessions', `${id}.json`), JSON.stringify({ ...kept(id), ...change }))
/** The record of keep-warm for the session "one", for an idle period that began at noon. */
const RECORDED = { session: 'one', project: 'work/repo', model: 'claude-fable-5-2', idleSince: NOW }

test('keep-warm is off until it is turned on, with a cap of 3 hours, 6 minutes before the end and 100,000 tokens when nothing else is set', () => {
  assert.deepEqual(keepWarmConfig({}), { on: false, capHours: 3, before: 6, min: 100000 })
  assert.deepEqual(keepWarmConfig({ keepWarm: { on: true, capHours: 5 } }), { on: true, capHours: 5, before: 6, min: 100000 })
  freshHome()
  assert.deepEqual(keepWarmConfig(), { on: false, capHours: 3, before: 6, min: 100000 })
  saveConfig({ keepWarm: { on: true, before: 8 } })
  assert.deepEqual(keepWarmConfig(), { on: true, capHours: 3, before: 8, min: 100000 })
})

test('keep-warm makes no plan while it is off, and none for a session the status line has not seen', () => {
  // Off: nothing is set, or it is turned off. The session's file stays as it is.
  freshHome()
  line(idle())
  assert.equal(planAt(NOW + MIN), undefined)
  saveConfig({ keepWarm: { on: false, capHours: 3 } })
  assert.equal(planAt(NOW + MIN), undefined)
  assert.equal('keepWarm' in kept('one'), false)
  // On, and everything holds: a wait and a token. The session's file keeps the token.
  saveConfig({ keepWarm: { on: true } })
  const plan = planAt(NOW + MIN)
  assert.deepEqual(Object.keys(plan), ['waitMs', 'token'])
  assert.deepEqual(kept('one').keepWarm, { token: plan.token, idleSince: NOW + MIN, wakes: 0 })
  // What the status line keeps in the same file stays.
  assert.equal(kept('one').cacheUntil, NOW + 52 * MIN)
  assert.equal(kept('one').at, NOW)
  // A session the status line has not seen gets no file, and an input without a session gets nothing.
  assert.equal(planAt(NOW + MIN, { ...STOP, session_id: 'never-seen' }), undefined)
  assert.equal(existsSync(join(process.env.KESTREL_HOME, 'sessions', 'never-seen.json')), false)
  assert.equal(planAt(NOW + MIN, {}), undefined)
  assert.equal(keepWarmPlan(undefined, NOW + MIN, { env: {} }), undefined)
  // Nothing of the answer is kept.
  assert.doesNotMatch(filesText(), /private/)
})

test('keep-warm makes no plan for a 5 minute cache, a small context, a plan limit in yellow or red, or an idle time at the cap', () => {
  /**
   * The plan for an answer 2 minutes after noon, after the status line saw `input` 1 minute after
   * noon. An answer at noon had a plan. So when this one has none, the token of the earlier plan
   * must be gone too, or the hook of the earlier answer would still wake the session.
   */
  const after = (input, settings = {}) => {
    keepWarmOn()
    assert.ok(planAt(NOW).token)
    saveConfig({ keepWarm: { on: true, ...settings } })
    line(input, NOW + MIN)
    const plan = planAt(NOW + 2 * MIN)
    if (!plan) assert.deepEqual(kept('one').keepWarm, { idleSince: NOW + 2 * MIN, wakes: 0 })
    return plan
  }
  const cache = (change) => idle(undefined, { prompt_cache: { warm: true, ttl: '1h', expires_at: sec(NOW + 52 * MIN), recache_tokens_if_cold: 527119, ...change } })
  const week = (pct) => idle(undefined, { rate_limits: { seven_day: { ...WEEK, used_percentage: pct } } })
  assert.ok(after(idle()))
  // A cache that lasts 5 minutes: a wake every few minutes costs more than it saves.
  assert.equal(after(cache({ ttl: '5m', expires_at: sec(NOW + 4 * MIN) })), undefined)
  // Small: under 100,000 tokens to send again, or under the "min" of the settings.
  assert.equal(after(cache({ recache_tokens_if_cold: 99999 })), undefined)
  assert.ok(after(cache({ recache_tokens_if_cold: 100000 })))
  assert.equal(after(idle(), { min: 600000 }), undefined)
  assert.ok(after(cache({ recache_tokens_if_cold: 50000 }), { min: 50000 }))
  // A limit of the plan in yellow or red, by the rule of the status line: from 75% used, and
  // below that when the limit is on pace to be full before its reset (56% used after 44% of the week).
  assert.ok(after(week(40)))
  assert.equal(after(week(75)), undefined)
  assert.equal(after(week(56)), undefined)
  assert.equal(after(idle(undefined, { rate_limits: { seven_day: WEEK, five_hour: { used_percentage: 92, resets_at: sec(NOW + 2 * HOUR) } } })), undefined)
  // The reading is the one that all sessions share: another session saw the week at 80%.
  keepWarmOn()
  assert.ok(planAt(NOW))
  line(idle(undefined, { session_id: 'busy', rate_limits: { seven_day: { ...WEEK, used_percentage: 80 } } }), NOW + MIN)
  assert.equal(planAt(NOW + 2 * MIN), undefined)
  assert.equal(kept('one').keepWarm.token, undefined)
  // By the token there is no plan limit, so an old reading of one does not count.
  saveConfig({ plan: 'usage', keepWarm: { on: true } })
  assert.ok(planAt(NOW + 3 * MIN))

  // The cap: the stop of a wake turn 3 hours after the idle period began gets no plan. One millisecond earlier it gets one.
  const woken = { token: 'earlier', idleSince: NOW, wakes: 3, wokeAt: NOW + 3 * HOUR - MIN }
  keepWarmOn()
  keep('one', { keepWarm: woken })
  assert.ok(planAt(NOW + 3 * HOUR - 1))
  keep('one', { keepWarm: woken })
  assert.equal(planAt(NOW + 3 * HOUR), undefined)
  assert.deepEqual(kept('one').keepWarm, { idleSince: NOW, wakes: 3, wokeAt: NOW + 3 * HOUR - MIN })
  // The cap is the "capHours" of the settings.
  const short = { token: 'earlier', idleSince: NOW, wakes: 1, wokeAt: NOW + 89 * MIN }
  keepWarmOn({ capHours: 1.5 })
  keep('one', { keepWarm: short })
  assert.ok(planAt(NOW + 90 * MIN - 1))
  keep('one', { keepWarm: short })
  assert.equal(planAt(NOW + 90 * MIN), undefined)
})

test('the wait of the keep-warm hook ends 6 minutes before the end of the cache, is at least 30 seconds, and counts from now when no end is saved', () => {
  // The status line saved an end of 52 minutes after noon.
  keepWarmOn()
  assert.equal(planAt(NOW).waitMs, 46 * MIN)
  assert.equal(planAt(NOW + MIN).waitMs, 45 * MIN)
  // "before" is a number of minutes.
  saveConfig({ keepWarm: { on: true, before: 10 } })
  assert.equal(planAt(NOW + MIN).waitMs, 41 * MIN)
  saveConfig({ keepWarm: { on: true } })
  // Never less than 30 seconds, also when the end is closer than 6 minutes.
  assert.equal(planAt(NOW + 46 * MIN - 30e3 - 1).waitMs, 30e3 + 1)
  assert.equal(planAt(NOW + 46 * MIN - 30e3).waitMs, 30e3)
  assert.equal(planAt(NOW + 50 * MIN).waitMs, 30e3)
  assert.equal(planAt(NOW + 52 * MIN - 1).waitMs, 30e3)
  // An end that has passed: the status line has not run yet for this answer. The answer has just
  // used the cache, so its end is taken as 60 minutes from now.
  assert.equal(planAt(NOW + 52 * MIN).waitMs, 54 * MIN)
  assert.equal(planAt(NOW + 2 * HOUR).waitMs, 54 * MIN)
  saveConfig({ keepWarm: { on: true, before: 10 } })
  assert.equal(planAt(NOW + 2 * HOUR).waitMs, 50 * MIN)
  // No end is saved at all.
  keepWarmOn()
  line(idle(undefined, { prompt_cache: { warm: true, ttl: '1h', recache_tokens_if_cold: 527119 } }))
  keep('one', { cacheUntil: undefined })
  assert.equal(planAt(NOW + MIN).waitMs, 54 * MIN)
  // An end of more than 1 hour ahead cannot be true. Here it was given in milliseconds, and read
  // as seconds it lies thousands of years ahead. The hook must not wait for it.
  keepWarmOn()
  line(idle(undefined, { prompt_cache: { warm: true, ttl: '1h', expires_at: NOW + 52 * MIN, recache_tokens_if_cold: 527119 } }))
  assert.ok(kept('one').cacheUntil > NOW + 1000 * 365 * DAY)
  assert.equal(planAt(NOW + MIN).waitMs, 54 * MIN)
  keep('one', { cacheUntil: NOW + HOUR + MIN + 1 })
  assert.equal(planAt(NOW + MIN).waitMs, 54 * MIN)
  keep('one', { cacheUntil: NOW + HOUR + MIN })
  assert.equal(planAt(NOW + MIN).waitMs, 54 * MIN)
  keep('one', { cacheUntil: NOW + HOUR })
  assert.equal(planAt(NOW + MIN).waitMs, 53 * MIN)
  // The setting "minWait" gives another shortest wait, in seconds.
  keepWarmOn({ minWait: 0.05 })
  assert.equal(planAt(NOW + 50 * MIN).waitMs, 50)
  assert.equal(planAt(NOW + MIN).waitMs, 45 * MIN)
})

test('a stop right after a wake goes on with the idle period and counts the wake, and a stop after the person typed starts a new one', () => {
  keepWarmOn()
  // The answer ended one minute after noon.
  const first = planAt(NOW + MIN)
  assert.deepEqual(kept('one').keepWarm, { token: first.token, idleSince: NOW + MIN, wakes: 0 })
  // The status line runs on its timer. 46 minutes after noon the wait is over, and the hook wakes the session.
  line(idle(), NOW + 45.5 * MIN)
  assert.equal(keepWarmDue('one', first.token, NOW + 46 * MIN), true)
  assert.deepEqual(kept('one').keepWarm, { token: first.token, idleSince: NOW + MIN, wakes: 1, wokeAt: NOW + 46 * MIN })
  // The wake turn ends 5 seconds later. Its stop keeps the start of the idle period and the count, and makes the next plan.
  const second = planAt(NOW + 46 * MIN + 5e3)
  assert.notEqual(second.token, first.token)
  assert.deepEqual(kept('one').keepWarm, { token: second.token, idleSince: NOW + MIN, wakes: 1, wokeAt: NOW + 46 * MIN })
  // A stop up to 3 minutes after the wake belongs to the wake turn.
  const third = planAt(NOW + 49 * MIN)
  assert.deepEqual(kept('one').keepWarm, { token: third.token, idleSince: NOW + MIN, wakes: 1, wokeAt: NOW + 46 * MIN })
  // A later stop does not: the person or the agent was active. A new idle period starts, without wakes.
  const typed = planAt(NOW + 49 * MIN + 1)
  assert.deepEqual(kept('one').keepWarm, { token: typed.token, idleSince: NOW + 49 * MIN + 1, wakes: 0 })
  // Two plans made in the same millisecond have two tokens.
  assert.notEqual(planAt(NOW + 50 * MIN).token, planAt(NOW + 50 * MIN).token)
})

test('the wake is due only for the newest plan of an open session, while its cache has not ended, below the cap, and while keep-warm is on', () => {
  const at = NOW + 46 * MIN
  /** The status line on its timer, half a minute before the wait is over. */
  const timer = (now = at - 30e3) => line(idle(), now)
  // All of it holds.
  keepWarmOn()
  let plan = planAt(NOW)
  timer()
  assert.equal(keepWarmDue('one', plan.token, at), true)
  // A newer answer made a newer plan. The hook of the older answer does nothing, and the newest one wakes.
  keepWarmOn()
  plan = planAt(NOW)
  const newer = planAt(NOW + 10 * MIN)
  timer()
  assert.equal(keepWarmDue('one', plan.token, at), false)
  assert.equal(kept('one').keepWarm.wakes, 0)
  assert.deepEqual(keepWarmRecord(), [])
  assert.equal(keepWarmDue('one', newer.token, at), true)
  // A newer answer that got no plan (the week is at 80% by then) stops the older hook too.
  keepWarmOn()
  plan = planAt(NOW)
  line(idle(undefined, { rate_limits: { seven_day: { ...WEEK, used_percentage: 80 } } }), NOW + 9 * MIN)
  assert.equal(planAt(NOW + 10 * MIN), undefined)
  timer()
  assert.equal(keepWarmDue('one', plan.token, at), false)
  // Another session, a session that is not known, and a hook without a token.
  keepWarmOn()
  plan = planAt(NOW)
  line(idle(undefined, { session_id: 'two' }), at - 30e3)
  timer()
  assert.equal(keepWarmDue('two', plan.token, at), false)
  assert.equal(keepWarmDue('never-seen', plan.token, at), false)
  assert.equal(keepWarmDue('one', undefined, at), false)

  // A closed session: the status line has not written its file for more than 5 minutes.
  keepWarmOn()
  plan = planAt(NOW)
  assert.equal(keepWarmDue('one', plan.token, at), false)
  timer(at - 5 * MIN - 1)
  assert.equal(keepWarmDue('one', plan.token, at), false)
  timer(at - 5 * MIN)
  assert.equal(keepWarmDue('one', plan.token, at), true)
  // The cache has already ended: at its end, and not one millisecond before it.
  keepWarmOn()
  plan = planAt(NOW)
  timer(NOW + 51 * MIN)
  assert.equal(keepWarmDue('one', plan.token, NOW + 52 * MIN), false)
  assert.equal(keepWarmDue('one', plan.token, NOW + 52 * MIN - 1), true)
  // No end is saved, so nothing says that the cache is still there.
  keepWarmOn()
  plan = planAt(NOW)
  timer()
  keep('one', { cacheUntil: undefined })
  assert.equal(keepWarmDue('one', plan.token, at), false)
  // The cap: 3 hours after the idle period began, and not one millisecond before that.
  keepWarmOn()
  timer(NOW + 3 * HOUR - MIN)
  keep('one', { cacheUntil: NOW + 3 * HOUR + 5 * MIN, keepWarm: { token: 'newest', idleSince: NOW, wakes: 3, wokeAt: NOW + 162 * MIN } })
  assert.equal(keepWarmDue('one', 'newest', NOW + 3 * HOUR), false)
  assert.equal(kept('one').keepWarm.wakes, 3)
  assert.equal(keepWarmDue('one', 'newest', NOW + 3 * HOUR - 1), true)
  assert.equal(kept('one').keepWarm.wakes, 4)
  // Turned off meanwhile.
  keepWarmOn()
  plan = planAt(NOW)
  timer()
  saveConfig({ keepWarm: { on: false } })
  assert.equal(keepWarmDue('one', plan.token, at), false)
  saveConfig({ keepWarm: { on: true } })
  assert.equal(keepWarmDue('one', plan.token, at), true)
})

test('the record of keep-warm has one entry per idle period with a wake: what the wakes read, and whether the person came back while the cache was kept', () => {
  keepWarmOn()
  // A plan alone is not in the record.
  let plan = planAt(NOW)
  assert.deepEqual(keepWarmRecord(), [])
  // The first wake, 46 minutes after noon, reads the context of 527,119 tokens.
  line(idle(), NOW + 45.5 * MIN)
  assert.equal(keepWarmDue('one', plan.token, NOW + 46 * MIN), true)
  assert.deepEqual(keepWarmRecord(), [{ ...RECORDED, wakes: 1, read: 527119, last: 527119 }])
  // The wake turn adds 265 tokens to the context and gives the cache another hour. The second wake reads the larger context.
  plan = planAt(NOW + 46 * MIN + 5e3)
  const grown = idle(NOW + 106 * MIN, { context_window: { used_percentage: 53, current_usage: { input_tokens: 2, cache_creation_input_tokens: 265, cache_read_input_tokens: 527117 } } })
  line(grown, NOW + 99.5 * MIN)
  assert.equal(keepWarmDue('one', plan.token, NOW + 100 * MIN), true)
  assert.deepEqual(keepWarmRecord(), [{ ...RECORDED, wakes: 2, read: 527119 + 527384, last: 527384 }])
  // The stop of that wake turn changes nothing in the record.
  planAt(NOW + 100 * MIN + 5e3)
  assert.equal(keepWarmRecord()[0].cameBack, undefined)
  // The person comes back 30 minutes after the second wake, while the cache that it kept is still there.
  plan = planAt(NOW + 130 * MIN)
  const first = { ...RECORDED, wakes: 2, read: 1054503, last: 527384, cameBack: true }
  assert.deepEqual(keepWarmRecord(), [first])

  // The next idle period starts with that answer. Its one wake is a second entry.
  line(idle(NOW + 190 * MIN), NOW + 183.5 * MIN)
  assert.equal(keepWarmDue('one', plan.token, NOW + 184 * MIN), true)
  const second = { ...RECORDED, idleSince: NOW + 130 * MIN, wakes: 1, read: 527119, last: 527119 }
  assert.deepEqual(keepWarmRecord(), [first, second])
  // This time the person comes back 60 minutes after the wake. The cache has ended by then, so the entry does not say that they came back.
  planAt(NOW + 244 * MIN)
  assert.deepEqual(keepWarmRecord(), [first, second])
  // One millisecond earlier the cache was still there.
  keep('one', { keepWarm: { token: 'newest', idleSince: NOW + 130 * MIN, wakes: 1, wokeAt: NOW + 184 * MIN } })
  planAt(NOW + 244 * MIN - 1)
  assert.deepEqual(keepWarmRecord(), [first, { ...second, cameBack: true }])
  // Another session has its own entries. A session without a folder or a context size still counts its wake.
  line(idle(undefined, { session_id: 'two', cwd: undefined, context_window: {} }), NOW + 250 * MIN)
  plan = planAt(NOW + 250 * MIN, { ...STOP, session_id: 'two' })
  line(idle(NOW + 305 * MIN, { session_id: 'two', cwd: undefined, context_window: {} }), NOW + 298 * MIN)
  assert.equal(keepWarmDue('two', plan.token, NOW + 299 * MIN), true)
  assert.deepEqual(keepWarmRecord()[2], { session: 'two', model: 'claude-fable-5-2', idleSince: NOW + 250 * MIN, wakes: 1, read: 527119, last: 527119 })
  // No text of a session is in the record: its id, the short name of its folder and its model only.
  assert.doesNotMatch(filesText(), /private/)
})

test('the record of keep-warm keeps the last 200 idle periods', () => {
  keepWarmOn()
  const old = Array.from({ length: 200 }, (_, i) => ({ session: `s${i}`, project: 'work/repo', model: 'claude-fable-5-2', idleSince: NOW - (200 - i) * DAY, wakes: 1, read: 1000, last: 1000 }))
  writeFileSync(join(process.env.KESTREL_HOME, 'keep-warm.json'), JSON.stringify(old))
  const plan = planAt(NOW)
  line(idle(), NOW + 45.5 * MIN)
  assert.equal(keepWarmDue('one', plan.token, NOW + 46 * MIN), true)
  // The oldest entry is gone, and the new one is the last.
  assert.deepEqual(keepWarmRecord(), [...old.slice(1), { ...RECORDED, wakes: 1, read: 527119, last: 527119 }])
  // A second wake of the same idle period adds no entry.
  const next = planAt(NOW + 46 * MIN + 5e3)
  line(idle(NOW + 106 * MIN), NOW + 99.5 * MIN)
  assert.equal(keepWarmDue('one', next.token, NOW + 100 * MIN), true)
  assert.equal(keepWarmRecord().length, 200)
  assert.deepEqual(keepWarmRecord().at(-1), { ...RECORDED, wakes: 2, read: 1054238, last: 527119 })
  // A record that is not a list counts as empty.
  writeFileSync(join(process.env.KESTREL_HOME, 'keep-warm.json'), '{"broken"')
  assert.deepEqual(keepWarmRecord(), [])
})

test('when the end of the cache has moved since the plan was made, the keep-warm hook waits on until 6 minutes before the new end', () => {
  keepWarmOn()
  // An answer ends 40 minutes after noon. The status line has not run for it yet, so the plan
  // goes by the end of the answer before it: 52 minutes after noon.
  const plan = planAt(NOW + 40 * MIN)
  assert.equal(plan.waitMs, 6 * MIN)
  // The end has not moved: no more waiting.
  assert.equal(keepWarmWait('one', plan.token, NOW + 46 * MIN), 0)
  // The status line then saves the end that the answer gave: 100 minutes after noon.
  line(idle(NOW + 100 * MIN), NOW + 40 * MIN + 1e3)
  assert.equal(keepWarmWait('one', plan.token, NOW + 46 * MIN), 48 * MIN)
  // Less than a second is not waited for.
  assert.equal(keepWarmWait('one', plan.token, NOW + 94 * MIN - 1000), 1000)
  assert.equal(keepWarmWait('one', plan.token, NOW + 94 * MIN - 999), 0)
  assert.equal(keepWarmWait('one', plan.token, NOW + 94 * MIN), 0)
  // After the end there is nothing to wait for, and the wake is not due either.
  assert.equal(keepWarmWait('one', plan.token, NOW + 101 * MIN), 0)
  // "before" is the one of the settings.
  saveConfig({ keepWarm: { on: true, before: 10 } })
  assert.equal(keepWarmWait('one', plan.token, NOW + 46 * MIN), 44 * MIN)
  // A hook that is no longer the newest one does not wait on, and neither does one when keep-warm is off.
  saveConfig({ keepWarm: { on: false } })
  assert.equal(keepWarmWait('one', plan.token, NOW + 46 * MIN), 0)
  saveConfig({ keepWarm: { on: true } })
  const newer = planAt(NOW + 45 * MIN)
  assert.equal(keepWarmWait('one', plan.token, NOW + 46 * MIN), 0)
  assert.equal(keepWarmWait('one', newer.token, NOW + 46 * MIN), 48 * MIN)
  assert.equal(keepWarmWait('one', undefined, NOW + 46 * MIN), 0)
  assert.equal(keepWarmWait('never-seen', newer.token, NOW + 46 * MIN), 0)
  // An end that cannot be true is not waited for.
  keep('one', { cacheUntil: NOW + 1000 * DAY })
  assert.equal(keepWarmWait('one', newer.token, NOW + 46 * MIN), 0)

  // A wake gives the cache another hour. The hook of the wake turn makes its plan before the
  // status line has saved that, with the end that the wake was for: a wait of 30 seconds. After
  // those it must not wake the session again. It waits until 6 minutes before the new end.
  keepWarmOn()
  const first = planAt(NOW)
  line(idle(), NOW + 45.5 * MIN)
  assert.equal(keepWarmDue('one', first.token, NOW + 46 * MIN), true)
  const second = planAt(NOW + 46 * MIN + 5e3)
  assert.equal(second.waitMs, 30e3)
  // The status line has not saved the new end by then: the hour counts from the wake.
  assert.equal(keepWarmWait('one', second.token, NOW + 46 * MIN + 35e3), 54 * MIN - 35e3)
  // It has saved it: 60 minutes after the end of the wake turn.
  line(idle(NOW + 106 * MIN + 5e3), NOW + 46 * MIN + 6e3)
  assert.equal(keepWarmWait('one', second.token, NOW + 46 * MIN + 35e3), 54 * MIN - 30e3)
  assert.equal(keepWarmWait('one', second.token, NOW + 100 * MIN + 5e3), 0)
})

test('the keep-warm hook makes its plan, waits, and wakes the session only when no answer came in the meantime', async () => {
  keepWarmOn()
  // A clock that each step of a wait moves on. The status line runs at the end of each step, as on its timer.
  let now = NOW + MIN
  let waits = []
  let during = () => line(idle(), now)
  const sleep = async (ms) => {
    waits.push(ms)
    now += ms
    during()
  }
  const hook = (input = STOP) => keepWarmHook(input, { clock: () => now, sleep, env: {} })
  assert.equal(await hook(), WAKE)
  // The wait of 45 minutes is made in steps of one minute.
  assert.deepEqual(waits, Array(45).fill(MIN))
  assert.equal(now, NOW + 46 * MIN)
  assert.equal(kept('one').keepWarm.wakes, 1)
  assert.equal(kept('one').keepWarm.wokeAt, NOW + 46 * MIN)
  // A wait that is not a whole number of minutes ends with a shorter step.
  keepWarmOn()
  now = NOW + 30e3
  waits = []
  assert.equal(await hook(), WAKE)
  assert.deepEqual(waits, [...Array(45).fill(MIN), 30e3])
  assert.equal(now, NOW + 46 * MIN)
  // No plan: the hook does not wait.
  waits = []
  assert.equal(await hook({ ...STOP, session_id: 'never-seen' }), undefined)
  saveConfig({ keepWarm: { on: false } })
  assert.equal(await hook(), undefined)
  assert.deepEqual(waits, [])

  // The person types during the wait. The answer to them, 20 minutes after noon, makes a newer
  // plan. The hook of the earlier answer ends after that step, and wakes nothing.
  keepWarmOn()
  now = NOW + MIN
  during = () => {
    line(idle(), now)
    if (now === NOW + 20 * MIN) planAt(now)
  }
  assert.equal(await hook(), undefined)
  assert.deepEqual(waits, Array(19).fill(MIN))
  assert.equal(now, NOW + 20 * MIN)
  assert.equal(kept('one').keepWarm.wakes, 0)
  assert.deepEqual(keepWarmRecord(), [])

  // The status line saves the end that the answer gave only after the hook has made its plan.
  // The hook waits its 6 minutes, and then 48 more: until 6 minutes before the end that was saved.
  keepWarmOn()
  now = NOW + 40 * MIN
  waits = []
  during = () => line(idle(NOW + 100 * MIN), now)
  assert.equal(await hook(), WAKE)
  assert.deepEqual(waits, Array(54).fill(MIN))
  assert.equal(kept('one').keepWarm.wokeAt, NOW + 94 * MIN)
})

test('an idle session is woken shortly before each end of its cache until the cap of 3 hours, and then no more', async () => {
  freshHome()
  saveConfig({ keepWarm: { on: true }, nudge: { on: true } })
  // The answer ended at noon, and the cache lasts until 60 minutes after it.
  let now = NOW
  let end = NOW + HOUR
  const shown = () => line(idle(end), now)
  shown()
  const waits = []
  const sleep = async (ms) => {
    waits.push(ms)
    now += ms
    shown()
  }
  const wakes = []
  // Each hook is the one of the answer before it: first the person's answer, then one wake turn after the other.
  for (let turn = 0; turn < 6; turn++) {
    if (!(await keepWarmHook(STOP, { clock: () => now, sleep, env: {} }))) break
    wakes.push(now - NOW)
    // The wake turn takes 5 seconds and gives the cache another hour. The status line saves the
    // new end only after the hook of the wake turn has made its plan.
    now += 5e3
    end = now + HOUR
  }
  // Three wakes, each 6 minutes before the end, and the fourth hook stays silent: its time would be 216 minutes after noon.
  assert.deepEqual(wakes, [54 * MIN, 108 * MIN + 5e3, 162 * MIN + 10e3])
  // The first hook waits 54 minutes. Each hook of a wake turn first waits its 30 seconds, and
  // then 53 and a half minutes: until 6 minutes before the new end. The waits are made in steps
  // of a minute at most, so each of those three hooks has two steps of 30 seconds.
  assert.equal(Math.max(...waits), MIN)
  assert.deepEqual(waits.filter((ms) => ms !== MIN), Array(6).fill(30e3))
  assert.equal(waits.reduce((total, ms) => total + ms), 216 * MIN)
  assert.equal(now, NOW + 216 * MIN + 15e3)
  assert.deepEqual(keepWarmRecord(), [{ ...RECORDED, wakes: 3, read: 3 * 527119, last: 527119 }])
  // No notification came while keep-warm woke the session. The status line says that it has stopped.
  assert.deepEqual(sent, [])
  assert.deepEqual(coloured(idle(end), now).slice(1, 3), [['cache warm, 6 min left', 'warn'], ['keep-warm stopped after 3 hours', 'warn']])
  // 5 minutes before the end, the notification comes, and says why.
  now = end - 5 * MIN
  shown()
  assert.deepEqual(sent, [['kestrel: work/repo cache ends at 15:42', `Keep-warm stopped after 3 hours. ${IDLE_BODY('15:42')}`]])
})

test('"kestrel hook keep-warm" prints nothing and exits 0 without a wake, and wakes the session with its sentence on stderr and exit code 2', () => {
  freshHome()
  const sessions = join(process.env.KESTREL_HOME, 'sessions')
  mkdirSync(sessions, { recursive: true })
  // The command takes the time from the clock. So the session's file is one that the status line
  // wrote just now, for a cache that ends in 5 minutes: the time for the wake has come.
  const now = Date.now()
  const open = { day: '2026-11-12', cost: 12.4, dayStart: 0, at: now, billing: 'subscription', cacheUntil: now + 5 * MIN, ttl: '1h', recache: 527119, ctx: 527119, project: 'work/repo', model: 'claude-fable-5-2' }
  for (const id of ['one', 'closed', 'small']) writeFileSync(join(sessions, `${id}.json`), JSON.stringify({ ...open, ...(id === 'closed' && { at: now - 6 * MIN }), ...(id === 'small' && { recache: 20000, ctx: 20000 }) }))
  const hook = (input) => {
    const r = exec(['hook', 'keep-warm'], {}, typeof input === 'string' ? input : JSON.stringify(input))
    return [r.status, r.stdout, r.stderr]
  }
  // Keep-warm is off.
  assert.deepEqual(hook(STOP), [0, '', ''])
  assert.equal('keepWarm' in kept('one'), false)
  // On. The shortest wait is 30 seconds. The settings of this test make it 50 milliseconds.
  saveConfig({ keepWarm: { on: true, minWait: 0.05 } })
  assert.deepEqual(hook(STOP), [2, '', WAKE])
  assert.equal(kept('one').keepWarm.wakes, 1)
  assert.deepEqual(keepWarmRecord().map((e) => [e.session, e.wakes, e.read]), [['one', 1, 527119]])
  // No plan: a small context, a session the status line has not seen, and an input that is not JSON.
  assert.deepEqual(hook({ ...STOP, session_id: 'small' }), [0, '', ''])
  assert.deepEqual(hook({ ...STOP, session_id: 'never-seen' }), [0, '', ''])
  assert.deepEqual(hook('not json'), [0, '', ''])
  // A plan, and no wake after the wait: the session was closed in the meantime.
  assert.deepEqual(hook({ ...STOP, session_id: 'closed' }), [0, '', ''])
  assert.equal(typeof kept('closed').keepWarm.token, 'string')
  assert.equal(kept('closed').keepWarm.wakes, 0)
  // A session file that is broken: no output, and no failure.
  writeFileSync(join(sessions, 'broken.json'), '{"cacheUntil": 5, "recache"')
  assert.deepEqual(hook({ ...STOP, session_id: 'broken' }), [0, '', ''])
  // Nothing of the answer is kept.
  assert.doesNotMatch(filesText(), /private/)

  // A hook that throws prints nothing and exits 0. Here a folder stands where the record is
  // kept, so the wake cannot be recorded.
  freshHome()
  const home = process.env.KESTREL_HOME
  mkdirSync(join(home, 'sessions'), { recursive: true })
  mkdirSync(join(home, 'keep-warm.json'))
  writeFileSync(join(home, 'sessions', 'one.json'), JSON.stringify(open))
  saveConfig({ keepWarm: { on: true, minWait: 0.05 } })
  const token = planAt(now).token
  assert.throws(() => keepWarmDue('one', token, now + 1000))
  assert.deepEqual(hook(STOP), [0, '', ''])
  // The session was not woken, so its file does not say that it was.
  assert.equal(kept('one').keepWarm.wakes, 0)
  assert.equal(kept('one').keepWarm.wokeAt, undefined)
})

test('a wake that cannot be recorded is not counted: the line does not say "kept warm", and the notification before the end comes', () => {
  freshHome()
  saveConfig({ keepWarm: { on: true }, nudge: { on: true } })
  line(idle())
  const plan = planAt(NOW)
  line(idle(), NOW + 45.5 * MIN)
  // A folder stands where the record is kept, so the wake cannot be recorded. The hook throws,
  // and the command then ends without a wake.
  mkdirSync(join(process.env.KESTREL_HOME, 'keep-warm.json'))
  const before = kept('one')
  assert.throws(() => keepWarmDue('one', plan.token, NOW + 46 * MIN))
  assert.deepEqual(kept('one'), before)
  assert.deepEqual(kept('one').keepWarm, { token: plan.token, idleSince: NOW, wakes: 0 })
  // Four minutes before the end of the cache: nothing was kept warm, and no wake is to come.
  assert.equal(line(idle(), NOW + 48 * MIN), 'week 36% used (read 48 min ago), 44% of the week gone | cache warm, 4 min left | context 527k (53%) | effort high')
  assert.deepEqual(sent, [['kestrel: work/repo cache ends at 12:52', IDLE_BODY('12:52')]])
})

test('no wake while a limit of the plan is yellow or red at the time of the wake, also when it was green when the answer ended', () => {
  // The answer ended at noon, with the week at 36% and no reading of the 5 hour limit.
  const waiting = () => {
    keepWarmOn()
    return planAt(NOW)
  }
  /** Another session saves its reading of the limits 40 minutes after noon, and the idle session's line shows it 5 minutes later. */
  const otherSession = (rate_limits) => {
    line(session({ session_id: 'two', rate_limits }), NOW + 40 * MIN)
    return line(idle(), NOW + 45 * MIN)
  }
  const due = (plan, options = {}) => keepWarmDue('one', plan.token, NOW + 46 * MIN, { env: {}, ...options })
  const week = (pct) => ({ ...WEEK, used_percentage: pct })

  // Both limits are red by the time of the wake.
  let plan = waiting()
  assert.match(otherSession({ five_hour: { used_percentage: 97, resets_at: sec(NOW + 2 * HOUR) }, seven_day: week(93) }), /^5 hour limit 97% used .* \| week 93% used /)
  assert.equal(due(plan), false)
  // The wake is not counted either.
  assert.equal(kept('one').keepWarm.wakes, 0)
  assert.equal(kept('one').keepWarm.wokeAt, undefined)
  assert.deepEqual(keepWarmRecord(), [])
  // The week alone, in yellow: at 50% with 44% of its time gone it is on pace to be full before its reset.
  plan = waiting()
  assert.equal(coloured(idle(), NOW + 45 * MIN)[0][1], 'good')
  otherSession({ seven_day: week(50) })
  assert.equal(coloured(idle(), NOW + 45 * MIN)[0][1], 'warn')
  assert.equal(due(plan), false)
  // A higher reading that is still green does not stop the wake.
  plan = waiting()
  otherSession({ seven_day: week(40) })
  assert.deepEqual(coloured(idle(), NOW + 45 * MIN)[0], ['week 40% used (read 5 min ago), 44% of the week gone', 'good'])
  assert.equal(due(plan), true)
  // By the token the plan's limits do not count: a reading of them is old, or not this person's.
  plan = waiting()
  otherSession({ seven_day: week(93) })
  saveConfig({ keepWarm: { on: true }, plan: 'usage' })
  assert.equal(due(plan), true)
  // The command gives the hook's own environment to this look, as it does for the plan.
  plan = waiting()
  otherSession({ seven_day: week(93) })
  keep('one', { billing: undefined })
  assert.equal(due(plan), false)
  assert.equal(due(plan, { env: { ANTHROPIC_API_KEY: 'a-key' } }), true)
})

test('the status line says "kept warm" and "stopped" only while the session is idle, not once the person is back and a long turn runs', () => {
  freshHome()
  saveConfig({ keepWarm: { on: true }, nudge: { on: true } })
  /** The status line `min` minutes after noon. `apiMs` is the time the session has spent on model calls so far, and `end` the end of its cache. */
  const at = (min, apiMs, end) => line(idle(NOW + end * MIN, { cost: { total_cost_usd: 12.4, total_duration_ms: 4 * HOUR, total_api_duration_ms: apiMs } }), NOW + min * MIN)
  const about = (shown) => shown.split(' | ').find((part) => /^kept warm|^keep-warm/.test(part))
  // The answer ended at noon. The session is idle, and its status line runs on the timer.
  at(0, 1000, 52)
  const plan = planAt(NOW)
  at(45.5, 1000, 52)
  assert.equal(keepWarmDue('one', plan.token, NOW + 46 * MIN), true)
  // The wake turn makes one model call. That call does not end the idle period.
  assert.equal(about(at(46.1, 2000, 106)), 'kept warm, 0.7 of 3 hours used')
  planAt(NOW + 46.1 * MIN)
  assert.equal(about(at(60, 2000, 106)), 'kept warm, 1 of 3 hours used')
  // The person is back 70 minutes after noon, and the agent works on a long turn: model calls,
  // and no stop. The line no longer says that the session is kept warm.
  assert.equal(about(at(70, 3000, 130)), undefined)
  assert.equal(about(at(120, 4000, 180)), undefined)
  // On the timer, while a tool of that turn runs.
  assert.equal(about(at(121, 4000, 180)), undefined)
  // The 3 hours of the cap pass during that turn. Nobody is away and nothing was stopped, so the line does not say so.
  assert.equal(about(at(181, 5000, 241)), undefined)
  assert.equal(about(at(200, 5000, 241)), undefined)
  assert.equal(at(200, 5000, 241), 'week 36% used (read 19 min ago), 46% of the week gone | cache warm, 41 min left | context 527k (53%) | effort high')
  // A tool of that turn runs for most of an hour. The notification before the end of the cache
  // comes as usual, without the sentence that keep-warm has stopped.
  at(237, 5000, 241)
  assert.deepEqual(sent, [['kestrel: work/repo cache ends at 16:01', IDLE_BODY('16:01')]])
  // Without a model call after the wake turn the session is still idle: at the cap the line says that keep-warm has stopped.
  keepWarmOn()
  at(0, 1000, 52)
  keep('one', { keepWarm: { token: 'newest', idleSince: NOW, wakes: 3, wokeAt: NOW + 162 * MIN } })
  at(162.1, 2000, 222)
  assert.equal(about(at(165, 2000, 222)), 'kept warm, 2.7 of 3 hours used')
  assert.equal(about(at(181, 2000, 222)), 'keep-warm stopped after 3 hours')
  // A model call exactly 3 minutes after the wake still belongs to the wake turn, and one a millisecond later does not.
  keep('one', { callAt: NOW + 165 * MIN })
  assert.equal(about(at(181, 2000, 222)), 'keep-warm stopped after 3 hours')
  keep('one', { callAt: NOW + 165 * MIN + 1 })
  assert.equal(about(at(181, 2000, 222)), undefined)
})

/**
 * Runs `inBetween` once, the next time a part of the tool lists a folder. The limit hook lists
 * the folder of the sessions after it has read the session's file and before it writes it.
 */
function atNextFolderRead(inBetween) {
  const real = fs.readdirSync
  fs.readdirSync = (...args) => {
    fs.readdirSync = real
    syncBuiltinESMExports()
    inBetween()
    return real(...args)
  }
  syncBuiltinESMExports()
  return () => {
    fs.readdirSync = real
    syncBuiltinESMExports()
  }
}

test('the status line and the hooks write the same file: each keeps what the other saved in the middle of its run', () => {
  /**
   * The input of the status line, which runs `inBetween` once when the status line asks for the
   * model. That is after the status line has read the session's file, and before it writes it.
   */
  const withHookInBetween = (input, inBetween) => {
    let ran = false
    return Object.defineProperty({ ...input }, 'model', {
      enumerable: true,
      get() {
        if (!ran) {
          ran = true
          inBetween()
        }
        return input.model
      },
    })
  }

  // The keep-warm hook makes its plan in the middle of a run of the status line.
  keepWarmOn()
  let plan
  line(withHookInBetween(idle(), () => (plan = planAt(NOW + MIN))), NOW + MIN)
  assert.equal(typeof plan.token, 'string')
  assert.deepEqual(kept('one').keepWarm, { token: plan.token, idleSince: NOW + MIN, wakes: 0 })
  assert.equal(kept('one').at, NOW + MIN)
  // So the hook that waits still finds its plan, and wakes the session.
  assert.equal(keepWarmWait('one', plan.token, NOW + 2 * MIN), 44 * MIN)
  line(idle(), NOW + 45.5 * MIN)
  // The wake is counted in the middle of a run too.
  line(withHookInBetween(idle(), () => assert.equal(keepWarmDue('one', plan.token, NOW + 46 * MIN), true)), NOW + 46 * MIN)
  assert.deepEqual(kept('one').keepWarm, { token: plan.token, idleSince: NOW + MIN, wakes: 1, wokeAt: NOW + 46 * MIN })

  // The limit hook asks in the middle of a run of the status line.
  freshHome()
  saveConfig({ limits: { session: 10, action: 'ask' } })
  const input = { session_id: 'asked', cost: { total_cost_usd: 12.5, total_duration_ms: 60000 } }
  statusLine(input, NOW, { layout: 'one' })
  let answer
  statusLine(withHookInBetween({ ...input, cost: { total_cost_usd: 12.6, total_duration_ms: 90000 } }, () => (answer = limitHook({ session_id: 'asked' }, NOW + 30e3))), NOW + 30e3, { layout: 'one' })
  assert.equal(answer.hookSpecificOutput.permissionDecision, 'ask')
  assert.deepEqual([kept('asked').askedAt, kept('asked').cost, kept('asked').at], [12.5, 12.6, NOW + 30e3])
  // So it does not ask again at the next tool call.
  assert.equal(limitHook({ session_id: 'asked' }, NOW + 31e3), undefined)

  // The other way round: the status line runs in the middle of a run of the limit hook.
  freshHome()
  saveConfig({ limits: { session: 10, action: 'ask' } })
  statusLine(input, NOW, { layout: 'one' })
  const restore = atNextFolderRead(() => statusLine({ ...input, cost: { total_cost_usd: 12.6, total_duration_ms: 90000 } }, NOW + 30e3, { layout: 'one' }))
  try {
    assert.equal(limitHook({ session_id: 'asked' }, NOW + 30e3).hookSpecificOutput.permissionDecision, 'ask')
  } finally {
    restore()
  }
  assert.deepEqual([kept('asked').askedAt, kept('asked').cost, kept('asked').at], [12.5, 12.6, NOW + 30e3])

  // The hook for a sent prompt warns in the middle of a run of the status line.
  freshHome()
  line(session({ rate_limits: { seven_day: WEEK } }))
  const back = NOW + 3 * HOUR
  let warning
  line(withHookInBetween(session({ rate_limits: { seven_day: WEEK } }), () => (warning = coldStartHook(PROMPT, back, {}))), back)
  assert.deepEqual(warning, { systemMessage: coldText('12:52', 'This prompt sent 527k tokens again.') })
  assert.deepEqual([kept('one').coldWarnedFor, kept('one').at], [NOW + 52 * MIN, back])
  // So the next prompt gets no second warning for the same end.
  assert.equal(coldStartHook(PROMPT, back + MIN, {}), undefined)
})

test('the change "keep-warm" adds the hook that waits in the background and turns keep-warm on, and undo takes the hook out and turns it off', () => {
  freshHome()
  const autoAllow = { matcher: '', hooks: [{ type: 'command', command: '/x/auto-allow.sh' }] }
  const sayDone = { hooks: [{ type: 'command', command: '/x/say-done.sh' }] }
  const before = { theme: 'dark', hooks: { PreToolUse: [autoAllow], Stop: [sayDone] } }
  writeFileSync(SETTINGS, JSON.stringify(before))
  saveConfig({ nudge: { on: true } })
  const config = () => JSON.parse(readFileSync(join(process.env.KESTREL_HOME, 'config.json'), 'utf8'))
  // The hook's entry: it runs in the background, wakes the session with exit code 2, and may wait for an hour.
  const ours = { hooks: [{ type: 'command', command: '/bin/kestrel hook keep-warm', asyncRewake: true, timeout: 3600 }] }

  const said = applyAction('keep-warm', '/bin/kestrel')
  assert.equal(said[0], 'Added a hook to Claude Code that runs after each answer, and turned keep-warm on. It wakes an idle session shortly before its cache ends, for up to 3 hours without you.')
  // The note says plainly what it is: an experiment that spends the plan's limit while the person is away, and that stops after the cap.
  assert.match(said[1], /^It is an experiment, and it spends your plan's limit while you are away: it can cost more than it saves\. It stops after the cap\./)
  assert.match(said[1], /Check the effect with: kestrel measure keep-warm$/)
  assert.equal(said[2], 'Take it back with: kestrel undo keep-warm')
  assert.deepEqual(settings(), { theme: 'dark', hooks: { PreToolUse: [autoAllow], Stop: [sayDone, ours] } })
  assert.deepEqual(config(), { nudge: { on: true }, keepWarm: { on: true, capHours: 3 } })
  assert.deepEqual(Object.keys(appliedActions()), ['keep-warm'])
  // A second apply adds nothing.
  assert.deepEqual(applyAction('keep-warm', '/bin/kestrel'), ['keep-warm is already applied.'])
  assert.deepEqual(settings().hooks.Stop, [sayDone, ours])

  // Another cap. The hook is there once, and the other settings of keep-warm stay.
  saveConfig({ ...config(), keepWarm: { ...config().keepWarm, before: 8 } })
  assert.match(applyAction('keep-warm', '/bin/kestrel', NOW, ['--cap-hours', '1.5'])[0], /for up to 1\.5 hours without you\.$/)
  assert.deepEqual(config().keepWarm, { on: true, capHours: 1.5, before: 8 })
  assert.deepEqual(settings().hooks.Stop, [sayDone, ours])
  assert.deepEqual(applyAction('keep-warm', '/bin/kestrel', NOW, ['--cap-hours', '1.5']), ['keep-warm is already applied.'])
  assert.match(applyAction('keep-warm', '/bin/kestrel', NOW, ['--cap-hours', '1'])[0], /for up to 1 hour without you\.$/)
  // A cap that is not a number of hours changes nothing.
  for (const bad of ['0', '-1', '24.5', 'long', '1e1', '']) {
    assert.throws(() => applyAction('keep-warm', '/bin/kestrel', NOW, ['--cap-hours', bad]), /--cap-hours is a number of hours, above 0 and at most 24\./, bad)
  }
  assert.throws(() => applyAction('keep-warm', '/bin/kestrel', NOW, ['--hours', '2']), /keep-warm does not take "--hours"\. It takes: --cap-hours <value>/)
  assert.deepEqual(config().keepWarm, { on: true, capHours: 1, before: 8 })
  assert.equal(applyAction('keep-warm', '/bin/kestrel', NOW, ['--cap-hours', '24']).length, 3)

  // Undo takes the hook out and turns keep-warm off. The other hooks and settings stay.
  assert.deepEqual(undoAction('keep-warm', '/bin/kestrel'), ['keep-warm is taken back. The hook is out of Claude Code, and keep-warm is off.'])
  assert.deepEqual(settings(), before)
  assert.deepEqual(config(), { nudge: { on: true }, keepWarm: { on: false, capHours: 24, before: 8 } })
  assert.deepEqual(Object.keys(appliedActions()), [])
  assert.match(undoAction('keep-warm', '/bin/kestrel')[0], /was not applied by this tool/)
  // Without another hook for the same event, taking it back leaves no empty list.
  writeFileSync(SETTINGS, JSON.stringify({ theme: 'dark', hooks: { PreToolUse: [autoAllow] } }))
  applyAction('keep-warm', '/bin/kestrel')
  assert.deepEqual(settings(), { theme: 'dark', hooks: { PreToolUse: [autoAllow], Stop: [ours] } })
  undoAction('keep-warm', '/bin/kestrel')
  assert.deepEqual(settings(), { theme: 'dark', hooks: { PreToolUse: [autoAllow] } })
  // "uninstall" takes the hook out as well, and keeps the other one.
  writeFileSync(SETTINGS, JSON.stringify(before))
  applyAction('keep-warm', '/bin/kestrel')
  assert.equal(uninstall(), true)
  assert.deepEqual(settings(), before)
})

test('"kestrel apply" lists and makes the change "keep-warm", "status" shows it, and nothing turns it on before that', () => {
  freshHome()
  writeFileSync(SETTINGS, JSON.stringify(OTHER))
  const config = () => JSON.parse(readFileSync(join(process.env.KESTREL_HOME, 'config.json'), 'utf8'))
  // The list says plainly what it is.
  const list = run(['apply'])
  assert.match(list, /^  keep-warm\n    An experiment\. Adds a hook to Claude Code that runs after each answer\./m)
  assert.match(list, /Each wake spends some of your plan's limit while you are away \(money, when you pay by the token\)\. It stops after 3 hours without you, or after the hours that --cap-hours names\.$/m)
  assert.match(run(['status']), /^Change: keep-warm +not applied$/m)
  // Off until it is applied: an install and the other commands leave it alone.
  run(['install'])
  run(['nudge', 'on'])
  assert.equal(config().keepWarm, undefined)
  // The install adds the hook of the security checks at the end of a turn, and no other.
  const turn = { hooks: [{ type: 'command', command: `${join(process.env.KESTREL_HOME, 'bin', 'kestrel')} hook check-turn`, timeout: 5 }] }
  assert.deepEqual(settings().hooks.Stop, [turn])

  assert.match(run(['apply', 'keep-warm', '--cap-hours', '2']), /^Added a hook to Claude Code that runs after each answer, and turned keep-warm on\. It wakes an idle session shortly before its cache ends, for up to 2 hours without you\.\n/)
  // The settings call the link in this tool's own folder, not the one on the PATH.
  const command = `${join(process.env.KESTREL_HOME, 'bin', 'kestrel')} hook keep-warm`
  // The hook of the security checks stays next to it.
  assert.deepEqual(settings().hooks.Stop, [turn, { hooks: [{ type: 'command', command, asyncRewake: true, timeout: 3600 }] }])
  assert.deepEqual(config().keepWarm, { on: true, capHours: 2 })
  assert.match(run(['status']), /^Change: keep-warm +applied on \d{4}-\d\d-\d\d$/m)
  // Turned off by hand in the settings of this tool, it is no longer in place.
  saveConfig({ ...config(), keepWarm: { on: false, capHours: 2 } })
  assert.match(run(['status']), /^Change: keep-warm +applied on \d{4}-\d\d-\d\d, but no longer in the settings$/m)
  const bad = exec(['apply', 'keep-warm', '--cap-hours', 'forever'])
  assert.deepEqual([bad.status, bad.stdout, bad.stderr], [1, '', 'kestrel: --cap-hours is a number of hours, above 0 and at most 24.\n'])
  assert.match(run(['undo', 'keep-warm']), /^keep-warm is taken back\. The hook is out of Claude Code, and keep-warm is off\.\n$/)
  assert.deepEqual(settings().hooks.Stop, [turn])
  assert.deepEqual(config().keepWarm, { on: false, capHours: 2 })
})

test('the status line says how much of its cap keep-warm has used in this idle period, and in yellow that it has stopped', () => {
  keepWarmOn()
  /** The part about keep-warm at a time when the cache has 52 minutes left, as [text, tone]. */
  const part = (now) => coloured(idle(now + 52 * MIN), now).find(([text]) => /^kept warm|^keep-warm/.test(text))
  // A plan alone shows nothing: the idle period has no wake yet.
  planAt(NOW)
  assert.equal(part(NOW + 30 * MIN), undefined)
  // The idle period began at noon and has one wake.
  keep('one', { keepWarm: { token: 'newest', idleSince: NOW, wakes: 1, wokeAt: NOW + 46 * MIN } })
  assert.deepEqual(part(NOW + 47 * MIN), ['kept warm, 0.7 of 3 hours used', undefined])
  // Hours have one decimal, rounded down, and none when they are whole.
  assert.deepEqual(part(NOW + HOUR - 1), ['kept warm, 0.9 of 3 hours used', undefined])
  assert.deepEqual(part(NOW + HOUR), ['kept warm, 1 of 3 hours used', undefined])
  assert.deepEqual(part(NOW + 2 * HOUR), ['kept warm, 2 of 3 hours used', undefined])
  assert.deepEqual(part(NOW + 3 * HOUR - 1), ['kept warm, 2.9 of 3 hours used', undefined])
  // At the cap it has stopped.
  assert.deepEqual(part(NOW + 3 * HOUR), ['keep-warm stopped after 3 hours', 'warn'])
  assert.deepEqual(part(NOW + 5 * HOUR), ['keep-warm stopped after 3 hours', 'warn'])
  // The part stands after the one for the cache.
  assert.deepEqual(coloured(idle(NOW + 172 * MIN), NOW + 2 * HOUR).slice(1), [['cache warm, 52 min left', 'good'], ['kept warm, 2 of 3 hours used', undefined], ['context 527k (53%)', undefined], ['effort high', undefined]])
  assert.equal(line(idle(NOW + 172 * MIN), NOW + 2 * HOUR), 'week 36% used (read 2 hours ago), 45% of the week gone | cache warm, 52 min left | kept warm, 2 of 3 hours used | context 527k (53%) | effort high')
  // The cap is the one of the settings.
  saveConfig({ keepWarm: { on: true, capHours: 1 } })
  assert.deepEqual(part(NOW + 47 * MIN), ['kept warm, 0.7 of 1 hour used', undefined])
  assert.deepEqual(part(NOW + HOUR), ['keep-warm stopped after 1 hour', 'warn'])
  saveConfig({ keepWarm: { on: true, capHours: 2.5 } })
  assert.deepEqual(part(NOW + 2 * HOUR), ['kept warm, 2 of 2.5 hours used', undefined])
  assert.deepEqual(part(NOW + 2.5 * HOUR), ['keep-warm stopped after 2.5 hours', 'warn'])
  // While keep-warm is off the line says nothing about it.
  saveConfig({ keepWarm: { on: false } })
  assert.equal(part(NOW + 2 * HOUR), undefined)
  // The person typed: the answer to them starts a new idle period, which has no wake.
  saveConfig({ keepWarm: { on: true } })
  assert.ok(part(NOW + 2 * HOUR))
  planAt(NOW + 2 * HOUR + MIN)
  assert.equal(part(NOW + 2 * HOUR + 2 * MIN), undefined)
})

test('while keep-warm wakes a session there is no notification before the end of its cache, and at the cap the notification says that keep-warm has stopped', () => {
  const settings = { nudge: { on: true }, keepWarm: { on: true } }
  const start = () => {
    freshHome()
    saveConfig(settings)
    line(idle())
  }
  /** The status line on its timer, in the last 5 minutes before the end of the cache. */
  const lastMinutes = () => {
    for (const later of [47, 48, 51.5]) line(idle(), NOW + later * MIN)
  }
  const usual = [['kestrel: work/repo cache ends at 12:52', IDLE_BODY('12:52')]]
  // Keep-warm is on, and its hook has not run for this session: the notification comes as usual.
  start()
  lastMinutes()
  assert.deepEqual(sent, usual)
  // The hook of the last answer waits. Its wake is due 6 minutes before the end, which is 46
  // minutes after noon. A notification that is set to come 10 minutes before the end waits for
  // that wake. The end is not marked as one that had its notification.
  const early = () => {
    freshHome()
    saveConfig({ nudge: { on: true, before: 10 }, keepWarm: { on: true } })
    line(idle())
  }
  early()
  let plan = planAt(NOW)
  for (const later of [42, 45, 45.9]) line(idle(), NOW + later * MIN)
  assert.deepEqual(sent, [])
  assert.equal(kept('one').nudgedFor, undefined)
  // The wake comes. Its turn moves the end, so for the 3 minutes of that turn there is no notification either.
  assert.equal(keepWarmDue('one', plan.token, NOW + 46 * MIN), true)
  for (const later of [46.5, 47, 49]) line(idle(), NOW + later * MIN)
  assert.deepEqual(sent, [])
  // The same for the next end, after the answer of the wake turn.
  plan = planAt(NOW + 46 * MIN + 5e3)
  for (const later of [96, 99.5]) line(idle(NOW + 106 * MIN), NOW + later * MIN)
  assert.equal(keepWarmDue('one', plan.token, NOW + 100 * MIN), true)
  for (const later of [101, 102.5]) line(idle(NOW + 106 * MIN), NOW + later * MIN)
  assert.deepEqual(sent, [])
  // A wake whose turn has not moved the end after 3 minutes: the notification comes after all.
  line(idle(NOW + 106 * MIN), NOW + 103 * MIN + 1)
  assert.deepEqual(sent, [['kestrel: work/repo cache ends at 13:46', IDLE_BODY('13:46')]])

  // A wake that does not come. The token of the plan is still in the session's file, but no hook
  // is there to wake the session: it was ended, or it found a reason not to wake. Until one
  // minute after the time of the wake the notification waits for it. Then it comes as usual.
  start()
  planAt(NOW)
  line(idle(), NOW + 47 * MIN - 1)
  assert.deepEqual(sent, [])
  lastMinutes()
  assert.deepEqual(sent, usual)
  assert.equal(kept('one').nudgedFor, NOW + 52 * MIN)
  // The last answer got no plan, because the week is at 80%: no wake will come, so the notification does.
  start()
  planAt(NOW)
  line(idle(undefined, { rate_limits: { seven_day: { ...WEEK, used_percentage: 80 } } }), NOW + MIN)
  assert.equal(planAt(NOW + 2 * MIN), undefined)
  lastMinutes()
  assert.deepEqual(sent, usual)
  // Keep-warm was turned off after the plan was made: the same.
  start()
  planAt(NOW)
  saveConfig({ nudge: { on: true }, keepWarm: { on: false } })
  lastMinutes()
  assert.deepEqual(sent, usual)

  // The cap was reached. The third wake came 162 minutes after noon, and the cache ends 222 minutes after noon.
  const capped = (now) => {
    start()
    line(idle(NOW + 222 * MIN), NOW + 163 * MIN)
    keep('one', { keepWarm: { token: 'newest', idleSince: NOW, wakes: 3, wokeAt: NOW + 162 * MIN } })
    line(idle(NOW + 222 * MIN), now)
  }
  capped(NOW + 217 * MIN)
  assert.deepEqual(sent, [['kestrel: work/repo cache ends at 15:42', `Keep-warm stopped after 3 hours. ${IDLE_BODY('15:42')}`]])
  // Once per end, as before.
  line(idle(NOW + 222 * MIN), NOW + 218 * MIN)
  assert.equal(sent.length, 1)
  assert.equal(kept('one').nudgedFor, NOW + 222 * MIN)
  // More than 5 minutes before the end there is none.
  capped(NOW + 216 * MIN)
  assert.deepEqual(sent, [])
  // The words by the token, and with another cap.
  const until = Date.parse('2026-11-12T15:42:00')
  assert.equal(nudgeText({ project: 'work/repo', until, recache: 527119, mode: 'usage', coldCost: 8.43, keepWarmStopped: '1 hour' }).body, 'Keep-warm stopped after 1 hour. After that the next call costs about $8.43. To keep it, send any message before then. Done for now? Run /compact first.')
  assert.equal(nudgeText({ project: 'work/repo', until, recache: 527119, mode: 'subscription' }).body, NUDGE_BODY)
})

test('the hook for a sent prompt stays silent on a wake turn, because the cache is warm then', () => {
  keepWarmOn()
  const plan = planAt(NOW)
  line(idle(), NOW + 45.5 * MIN)
  assert.equal(keepWarmDue('one', plan.token, NOW + 46 * MIN), true)
  // Claude Code runs the hook for a sent prompt on the wake turn too. The cache has 6 minutes left.
  assert.equal(coldStartHook(PROMPT, NOW + 46 * MIN, {}), undefined)
  assert.equal(kept('one').coldWarnedFor, undefined)
  // The wake turn gives the cache another hour, and the next wake turn is silent as well.
  const next = planAt(NOW + 46 * MIN + 5e3)
  line(idle(NOW + 106 * MIN), NOW + 99.5 * MIN)
  assert.equal(keepWarmDue('one', next.token, NOW + 100 * MIN), true)
  assert.equal(coldStartHook(PROMPT, NOW + 100 * MIN, {}), undefined)
  assert.equal(kept('one').coldWarnedFor, undefined)
  // What keep-warm keeps in the session's file stays when the hook for a sent prompt writes it.
  const state = kept('one').keepWarm
  // Without another wake the cache ends, and the next prompt of the person gets its warning as before.
  assert.deepEqual(coldStartHook(PROMPT, NOW + 107 * MIN, {}), { systemMessage: coldText('13:46', 'This prompt sent 527k tokens again.') })
  assert.equal(kept('one').coldWarnedFor, NOW + 106 * MIN)
  assert.deepEqual(kept('one').keepWarm, state)
})

test('"kestrel measure keep-warm" gives the numbers of the record, and says whether keep-warm saved more than it cost', () => {
  freshHome()
  const home = process.env.KESTREL_HOME
  mkdirSync(home, { recursive: true })
  /** An idle period on Claude Fable 5.2 with 2 wakes, each of a context of 500,000 tokens. */
  const period = (i, more = {}) => ({ session: `s${i}`, project: 'work/repo', model: 'claude-fable-5-2', idleSince: NOW + i * DAY, wakes: 2, read: 1000000, last: 500000, ...more })
  const record = (entries) => writeFileSync(join(home, 'keep-warm.json'), JSON.stringify(entries))
  const row = (text, name) => text.split('\n').find((l) => l.startsWith(name))?.slice(name.length).trim()
  const closing = (text) => text.split('\n\n').at(-1).split('\n')[0]
  // Nothing was woken yet.
  assert.equal(keepWarmReport({ mode: 'subscription' }), 'Keep-warm has not woken a session yet, so there is nothing to measure. It is off. Turn it on with: kestrel apply keep-warm')
  saveConfig({ keepWarm: { on: true } })
  assert.equal(keepWarmReport({ mode: 'subscription' }), 'Keep-warm has not woken a session yet, so there is nothing to measure.')

  // 10 idle periods, and the person came back to 3 of them. By the token: a read from the cache
  // costs $0.20 per million tokens on this model, and a write to the 1 hour cache $16.
  record(Array.from({ length: 10 }, (_, i) => period(i, i < 3 ? { cameBack: true } : {})))
  const usage = keepWarmReport({ mode: 'usage' })
  assert.equal(usage.split('\n')[0], 'keep-warm: the idle periods in which a session was woken to keep its cache.')
  assert.equal(row(usage, 'Idle periods kept warm'), '10')
  assert.equal(row(usage, 'Wake turns'), '20')
  assert.equal(row(usage, 'Tokens the wakes read from the cache'), '10M')
  // 10 million tokens read at $0.20 per million.
  assert.equal(row(usage, 'What the wakes cost, at the price of a read from the cache'), '$2.00')
  assert.equal(row(usage, 'Idle periods you came back to while the cache was kept'), '3')
  assert.equal(row(usage, 'Tokens those would have sent again without keep-warm'), '1.5M')
  // 1.5 million tokens at $16 less $0.20 per million.
  assert.equal(row(usage, 'What sending them again would have cost more than a read'), '$23.70')
  assert.equal(closing(usage), 'Keep-warm saved more than it cost.')
  assert.match(usage, /\nThe two amounts are list prices\. A wake also writes a few hundred tokens\. Those are not counted\.$/)
  // On a subscription the numbers are the same, and there are no dollars.
  const subscription = keepWarmReport({ mode: 'subscription' })
  assert.equal(row(subscription, 'Tokens the wakes read from the cache'), '10M')
  assert.equal(row(subscription, 'Tokens those would have sent again without keep-warm'), '1.5M')
  assert.equal(closing(subscription), 'Keep-warm saved more than it cost.')
  assert.doesNotMatch(subscription, /\$/)
  assert.match(subscription, /\nOn a subscription both count against your plan's limits, so no dollars are shown\./)

  // The person came back to one period only, and its context was small by then: $2.00 for the wakes, and $1.58 saved.
  record(Array.from({ length: 10 }, (_, i) => period(i, i < 1 ? { cameBack: true, last: 100000 } : {})))
  const costly = keepWarmReport({ mode: 'usage' })
  assert.equal(row(costly, 'What the wakes cost, at the price of a read from the cache'), '$2.00')
  assert.equal(row(costly, 'Tokens those would have sent again without keep-warm'), '100k')
  assert.equal(row(costly, 'What sending them again would have cost more than a read'), '$1.58')
  assert.equal(closing(costly), 'Keep-warm cost more than it saved.')
  assert.equal(closing(keepWarmReport({ mode: 'subscription' })), 'Keep-warm cost more than it saved.')
  // Nobody came back at all.
  record(Array.from({ length: 12 }, (_, i) => period(i)))
  const alone = keepWarmReport({ mode: 'usage' })
  assert.equal(row(alone, 'Idle periods you came back to while the cache was kept'), '0')
  assert.equal(row(alone, 'What sending them again would have cost more than a read'), '$0.00')
  assert.equal(closing(alone), 'Keep-warm cost more than it saved.')

  // Under 10 idle periods it is too early, whatever the numbers say.
  record(Array.from({ length: 9 }, (_, i) => period(i, { cameBack: true })))
  assert.equal(closing(keepWarmReport({ mode: 'usage' })), 'Too early to judge: 9 idle periods so far, and it takes 10.')
  assert.equal(row(keepWarmReport({ mode: 'usage' }), 'Idle periods you came back to while the cache was kept'), '9')
  record([period(0)])
  assert.equal(closing(keepWarmReport({ mode: 'subscription' })), 'Too early to judge: 1 idle period so far, and it takes 10.')

  // A period on a model with no price is in the counts, and not in the comparison.
  record([...Array.from({ length: 10 }, (_, i) => period(i, i < 3 ? { cameBack: true } : {})), period(10, { model: 'some-new-model', cameBack: true }), period(11, { model: undefined })])
  const mixed = keepWarmReport({ mode: 'usage' })
  assert.equal(row(mixed, 'Idle periods kept warm'), '12')
  assert.equal(row(mixed, 'Tokens the wakes read from the cache'), '12M')
  assert.equal(row(mixed, 'What the wakes cost, at the price of a read from the cache'), '$2.00')
  assert.equal(row(mixed, 'Idle periods you came back to while the cache was kept'), '4')
  assert.equal(closing(mixed), 'Keep-warm saved more than it cost.')
  assert.match(mixed, /\n2 idle periods ran on a model with no price\. They are in the counts and not in the comparison\.$/)
  record(Array.from({ length: 10 }, (_, i) => period(i, { model: 'some-new-model', cameBack: true })))
  assert.equal(closing(keepWarmReport({ mode: 'usage' })), 'No comparison: the models of these sessions have no price.')

  // The command prints the same, for the way the person pays, also when the change is not applied.
  record(Array.from({ length: 10 }, (_, i) => period(i, i < 3 ? { cameBack: true } : {})))
  saveConfig({ plan: 'usage', keepWarm: { on: true } })
  assert.equal(run(['measure', 'keep-warm']), `${usage}\n`)
  saveConfig({ plan: 'subscription', keepWarm: { on: true } })
  assert.equal(run(['measure', 'keep-warm']), `${subscription}\n`)
})

// The hint about the effort level, at the end of the status line. It comes from the end of the
// session's log, so these tests write made-up logs.
const { hintConfig } = await import('../src/hint.mjs')

let messages = 0
/**
 * The lines that Claude Code writes for one model call: one line per tool that the call used,
 * each with the id of the message, and then one line with the results of those tools. `failed`
 * marks the results as errors. A call without tools is one line with the answer. Every text in
 * these lines has "private" or "someone" in it, because none of it may leave the log.
 */
const callLines = (tools = [], failed = false) => {
  const id = `msg_${++messages}`
  const assistant = (block) => ({
    type: 'assistant', timestamp: '2026-11-12T10:00:00.000Z', cwd: '/home/someone/private-folder', gitBranch: 'private-branch',
    message: { id, model: 'claude-fable-5-2', role: 'assistant', content: [block], usage: { input_tokens: 3, cache_read_input_tokens: 90000, output_tokens: 200 } },
  })
  if (!tools.length) return [assistant({ type: 'text', text: 'a private answer' })]
  const uses = tools.map((name, k) => ({ type: 'tool_use', id: `${id}_tool_${k}`, name, input: { command: 'a private command', file_path: '/home/someone/private-file' } }))
  const results = uses.map((use) => ({ type: 'tool_result', tool_use_id: use.id, content: 'a private result', ...(failed ? { is_error: true } : {}) }))
  return [...uses.map(assistant), { type: 'user', timestamp: '2026-11-12T10:00:01.000Z', cwd: '/home/someone/private-folder', message: { role: 'user', content: results } }]
}
/** The lines of `n` such calls. */
const callsOf = (n, tools, failed) => Array.from({ length: n }, () => callLines(tools, failed)).flat()

let logs = 0
/** Writes a made-up session log and gives its path. A line is an object, or text that is written as it is. */
const logOf = (lines, file = join(dir, `log-${++logs}.jsonl`)) => {
  writeFileSync(file, `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`)
  return file
}

/** What Claude Code gives the status line of a subscriber whose session has its log at this path. */
const logged = (transcript_path, extra = {}) => session({ rate_limits: { seven_day: WEEK }, transcript_path, ...extra })
// The line of that subscriber without a hint.
const SUBSCRIBER = `week 36% used, 44% of the week gone | ${REST}`
const DOWN = 'mostly simple work at high effort: /effort medium keeps the cache'
const UP = 'many failed rounds at medium effort: /effort high keeps the cache'
const MEDIUM = { effort: { level: 'medium' } }
/** The hint of a line: its last part when that is a hint, else undefined. */
const hintPart = (shown) => shown.split(' | ').filter((part) => part.endsWith(' keeps the cache')).at(-1)
/**
 * The hint that a session with these lines in its log gets on its first run. `input` changes
 * what Claude Code gives, `settings` are this tool's settings, and `env` stands in for the
 * environment.
 */
const hintFor = (lines, { input = {}, settings, env = {} } = {}) => {
  freshHome()
  if (settings) saveConfig(settings)
  return hintPart(line(logged(logOf(lines), input), NOW, { env }))
}

test('mostly simple work at high effort gets the hint to go one level down, as the last part of the line and without a colour', () => {
  // 30 calls: 10 read, 8 ran a command, 6 only answered and 6 changed files. 24 of 30 are simple work: 80%.
  const simple = [...callsOf(10, ['Read']), ...callsOf(8, ['Bash']), ...callsOf(6), ...callsOf(6, ['Edit'])]
  freshHome()
  const log = logOf(simple)
  assert.equal(line(logged(log)), `${SUBSCRIBER} | ${DOWN}`)
  // The time of the look and the text of the hint are kept in the session's file.
  assert.deepEqual(kept('one').hint, { at: NOW, text: DOWN })
  freshHome()
  assert.deepEqual(coloured(logged(log)).slice(-2), [['effort high', undefined], [DOWN, undefined]])
  // The hint is the last part also after a limit in dollars, on a subscription and by the token.
  freshHome()
  saveConfig({ limits: { session: 50, action: 'ask' } })
  assert.equal(line(logged(log)), `${SUBSCRIBER} | limit $50 per session at list prices, $12.40 so far | ${DOWN}`)
  freshHome()
  saveConfig({ limits: { session: 50, action: 'ask' } })
  assert.equal(line(session({ transcript_path: log }), NOW, { env: { ANTHROPIC_API_KEY: 'a-key' } }), `$12.40 session, $3.10 per hour | cache warm, 52 min left, then $8.43 | context 527k (53%) | effort high | today $12.40 | limit $50 | ${DOWN}`)

  // Up to 2 of the calls may come after a tool result with an error, and not 3.
  assert.equal(hintFor([...callsOf(2, ['Bash'], true), ...callsOf(28, ['Read'])]), DOWN)
  assert.equal(hintFor([...callsOf(3, ['Bash'], true), ...callsOf(27, ['Read'])]), undefined)
  // Only the last 30 calls count: what the session did before them does not.
  assert.equal(hintFor([...callsOf(40, ['Edit']), ...callsOf(30, ['Read'])]), DOWN)
  assert.equal(hintFor([...callsOf(30, ['Read']), ...callsOf(6, ['Edit'])]), DOWN)
  assert.equal(hintFor([...callsOf(30, ['Read']), ...callsOf(7, ['Edit'])]), undefined)
})

test('many failed rounds at medium effort get the hint to go one level up, in yellow', () => {
  // 5 calls in a row got a tool result with an error. So 5 of the 30 calls came after such a
  // result: the 4 that followed inside the row, and the first one after it.
  const failing = [...callsOf(5, ['Bash'], true), ...callsOf(25, ['Edit'])]
  freshHome()
  const log = logOf(failing)
  const medium = 'week 36% used, 44% of the week gone | cache warm, 52 min left | context 527k (53%) | effort medium'
  assert.equal(line(logged(log, MEDIUM)), `${medium} | ${UP}`)
  assert.deepEqual(kept('one').hint, { at: NOW, text: UP })
  freshHome()
  assert.deepEqual(coloured(logged(log, MEDIUM)).slice(-2), [['effort medium', undefined], [UP, 'warn']])
  // 4 are not enough.
  assert.equal(hintFor([...callsOf(4, ['Bash'], true), ...callsOf(26, ['Edit'])], { input: MEDIUM }), undefined)
  // The kind of the work does not count for this hint: simple work with 5 failed rounds gets it too.
  assert.equal(hintFor([...callsOf(5, ['Bash'], true), ...callsOf(25, ['Read'])], { input: MEDIUM }), UP)
  // A failed result counts with the call that came after it. The last call of a log has none after it.
  assert.equal(hintFor([...callsOf(26, ['Edit']), ...callsOf(5, ['Bash'], true)], { input: MEDIUM }), undefined)
  assert.equal(hintFor([...callsOf(25, ['Edit']), ...callsOf(5, ['Bash'], true), ...callsOf(1, ['Edit'])], { input: MEDIUM }), UP)
  // Several results with an error before one call are one failed round.
  assert.equal(hintFor([...callLines(['Read', 'Read', 'Read', 'Read', 'Read'], true), ...callsOf(29, ['Edit'])], { input: MEDIUM }), undefined)
  // A result without an error flag, or with another value than true, is no error.
  const flagged = (flag) => callsOf(30, ['Bash'], true).map((l) => (l.type === 'user' ? { ...l, message: { ...l.message, content: l.message.content.map((b) => ({ ...b, is_error: flag })) } } : l))
  assert.equal(hintFor(flagged(true), { input: MEDIUM }), UP)
  for (const flag of [false, 'true', 1, null]) assert.equal(hintFor(flagged(flag), { input: MEDIUM }), undefined, String(flag))
})

test('mixed work gets no hint: the kind of a call comes from the tools it used', () => {
  // Half of the calls changed files.
  assert.equal(hintFor([...callsOf(15, ['Read']), ...callsOf(15, ['Edit'])]), undefined)
  // 23 of 30 calls are simple work, which is under 80%. With 24 the hint is there.
  const rest = (tools) => [...callsOf(10, ['Grep']), ...callsOf(8, ['Bash']), ...callsOf(5), ...callsOf(1, tools), ...callsOf(6, ['Write'])]
  assert.equal(hintFor(rest(['Read'])), DOWN)
  assert.equal(hintFor(rest([])), DOWN)
  assert.equal(hintFor(rest(['Glob', 'WebFetch', 'BashOutput'])), DOWN)
  // Changing files, handing work to a subagent and a tool of another kind are not simple work.
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'mcp__some_server__some_tool']) assert.equal(hintFor(rest([tool])), undefined, tool)
  // A call that read and also changed a file changed files.
  assert.equal(hintFor(rest(['Read', 'Edit'])), undefined)
  // Mixed work with few errors gets no hint at a low level either.
  assert.equal(hintFor([...callsOf(15, ['Read']), ...callsOf(15, ['Edit'])], { input: MEDIUM }), undefined)
})

test('fewer than 20 calls in the log give no hint', () => {
  assert.equal(hintFor(callsOf(19, ['Read'])), undefined)
  assert.equal(hintFor(callsOf(20, ['Read'])), DOWN)
  assert.equal(hintFor([...callsOf(5, ['Bash'], true), ...callsOf(14, ['Edit'])], { input: MEDIUM }), undefined)
  assert.equal(hintFor([...callsOf(5, ['Bash'], true), ...callsOf(15, ['Edit'])], { input: MEDIUM }), UP)
  // The lines of one message are one call: 19 calls that each used 3 tools are not 57.
  assert.equal(hintFor(callsOf(19, ['Read', 'Grep', 'Glob'])), undefined)
  // A log without a call, and an empty log.
  assert.equal(hintFor([{ type: 'user', message: { role: 'user', content: 'a private prompt' } }]), undefined)
  assert.equal(hintFor([]), undefined)
  // The look is kept also when it found too few calls.
  assert.deepEqual(kept('one').hint, { at: NOW })
})

test('the settings of the hint: how many calls it looks at, the share of simple work, and the number of tool errors', () => {
  assert.deepEqual(hintConfig({}), { on: true, calls: 30, simple: 0.8, errors: 5 })
  assert.deepEqual(hintConfig({ hint: { on: false, errors: 3 } }), { on: false, calls: 30, simple: 0.8, errors: 3 })
  // A number that was set by hand and cannot be used gives way to its default.
  assert.deepEqual(hintConfig({ hint: { calls: 'many', simple: 80, errors: 0 } }), { on: true, calls: 30, simple: 0.8, errors: 5 })
  assert.deepEqual(hintConfig({ hint: { calls: 2.5, simple: 0, errors: null } }), { on: true, calls: 30, simple: 0.8, errors: 5 })
  // 10 calls that changed files, then 20 that read: 67% of the last 30 are simple work.
  const lines = [...callsOf(10, ['Edit']), ...callsOf(20, ['Read'])]
  assert.equal(hintFor(lines), undefined)
  // The last 20 calls all read.
  assert.equal(hintFor(lines, { settings: { hint: { calls: 20 } } }), DOWN)
  // The last 40 calls of a longer log: 30 of them read, which is 75%.
  assert.equal(hintFor([...callsOf(10, ['Edit']), ...callsOf(30, ['Read'])], { settings: { hint: { calls: 40 } } }), undefined)
  assert.equal(hintFor(lines, { settings: { hint: { simple: 0.6 } } }), DOWN)
  assert.equal(hintFor(lines, { settings: { hint: { simple: 0.7 } } }), undefined)
  const failing = [...callsOf(3, ['Bash'], true), ...callsOf(27, ['Edit'])]
  assert.equal(hintFor(failing, { input: MEDIUM }), undefined)
  assert.equal(hintFor(failing, { input: MEDIUM, settings: { hint: { errors: 3 } } }), UP)
  assert.equal(hintFor(failing, { input: MEDIUM, settings: { hint: { errors: 4 } } }), undefined)
  // Turned off in the settings: no hint, and the log is not looked at.
  assert.equal(hintFor(callsOf(30, ['Read']), { settings: { hint: { on: false } } }), undefined)
  assert.equal(kept('one').hint, undefined)
})

test('no hint when a change of the effort level would lose the cache: on an older model, and through a cloud provider', () => {
  const simple = callsOf(30, ['Read'])
  const on = (id, more = {}) => hintFor(simple, { input: { model: { id } }, ...more })
  for (const id of ['claude-fable-5-1', 'claude-fable-5-2', 'claude-mythos-5-1', 'claude-mythos-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5[1m]', 'claude-haiku-5-5-20261001']) assert.equal(on(id), DOWN, id)
  // Any other model gets no hint, and its log is not looked at.
  for (const id of ['claude-opus-4-5', 'claude-sonnet-4-5-20250929', 'claude-opus-5', 'us.anthropic.claude-opus-5-5', 'some-new-model', '', undefined]) {
    assert.equal(on(id), undefined, String(id))
    assert.equal(kept('one').hint, undefined, String(id))
  }
  assert.equal(hintFor(simple, { input: { model: undefined } }), undefined)

  // By the token, with an API key or with no sign of how the person pays, the hint is there.
  const log = logOf(simple)
  const byToken = (env, settings) => {
    freshHome()
    if (settings) saveConfig(settings)
    return line(session({ transcript_path: log }), NOW, { env })
  }
  assert.match(byToken({ ANTHROPIC_API_KEY: 'a-key' }), /\| today \$12\.40 \| mostly simple work at high effort: \/effort medium keeps the cache$/)
  assert.equal(hintPart(byToken({})), DOWN)
  // Through a cloud provider there is none, and the log is not looked at.
  for (const name of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE']) {
    assert.match(byToken({ [name]: '1' }), /\| effort high \| today \$12\.40$/, name)
    assert.equal(kept('one').hint, undefined, name)
  }
  // A plan set by hand to "usage" does not say whether a cloud provider is behind it. The environment does.
  assert.equal(hintPart(byToken({ CLAUDE_CODE_USE_BEDROCK: '1' }, { plan: 'usage' })), undefined)
  assert.equal(hintPart(byToken({}, { plan: 'usage' })), DOWN)
  // A session that is on a subscription gets the hint, whatever the environment says.
  assert.equal(hintPart(byToken({ CLAUDE_CODE_USE_BEDROCK: '1' }, { plan: 'subscription' })), DOWN)
  assert.equal(hintFor(simple, { env: { CLAUDE_CODE_USE_BEDROCK: '1' } }), DOWN)
})

test('the hint goes one level down from high, xhigh and max, and one level up from low and medium', () => {
  const simple = callsOf(30, ['Read'])
  // Simple work too, and 5 of its calls came after a tool result with an error.
  const failing = [...callsOf(5, ['Bash'], true), ...callsOf(25, ['Read'])]
  const at = (level, lines) => hintFor(lines, { input: { effort: { level } } })
  assert.equal(at('high', simple), 'mostly simple work at high effort: /effort medium keeps the cache')
  assert.equal(at('xhigh', simple), 'mostly simple work at xhigh effort: /effort high keeps the cache')
  assert.equal(at('max', simple), 'mostly simple work at max effort: /effort xhigh keeps the cache')
  assert.equal(at('low', failing), 'many failed rounds at low effort: /effort medium keeps the cache')
  assert.equal(at('medium', failing), 'many failed rounds at medium effort: /effort high keeps the cache')
  // There is no way down from low and medium, and no way up from high and above.
  for (const level of ['low', 'medium']) assert.equal(at(level, simple), undefined, level)
  for (const level of ['high', 'xhigh', 'max']) assert.equal(at(level, failing), undefined, level)
  // A level that is not on the ladder gets no hint, and the log is not looked at.
  for (const level of ['auto', 'ultra', 'none', 'HIGH', 'constructor', '', 7, undefined]) {
    assert.equal(at(level, simple), undefined, String(level))
    assert.equal(at(level, failing), undefined, String(level))
    assert.equal(kept('one').hint, undefined, String(level))
  }
  assert.equal(hintFor(simple, { input: { effort: undefined } }), undefined)
})

test('the log is looked at once in 5 minutes at most, and a hint stays for 30 minutes after it was found and is then looked for again', () => {
  freshHome()
  const mixed = callsOf(30, ['Edit'])
  const simple = callsOf(30, ['Read'])
  const log = logOf(mixed)
  const at = (now, input) => hintPart(line(logged(log, input), now))
  assert.equal(at(NOW), undefined)
  assert.deepEqual(kept('one').hint, { at: NOW })
  // The work turns simple. Until 5 minutes after the last look the log is not read again.
  logOf(simple, log)
  assert.equal(at(NOW + MIN), undefined)
  assert.equal(at(NOW + 5 * MIN - 1), undefined)
  assert.deepEqual(kept('one').hint, { at: NOW })
  assert.equal(at(NOW + 5 * MIN), DOWN)
  assert.deepEqual(kept('one').hint, { at: NOW + 5 * MIN, text: DOWN })
  // The work turns mixed again. The hint stays for 30 minutes after it was found, without another look.
  logOf(mixed, log)
  assert.equal(at(NOW + 6 * MIN), DOWN)
  assert.equal(at(NOW + 11 * MIN), DOWN)
  assert.equal(at(NOW + 35 * MIN - 1), DOWN)
  assert.deepEqual(kept('one').hint, { at: NOW + 5 * MIN, text: DOWN })
  // Then the log is looked at again. The hint is gone, and the next look is 5 minutes later.
  assert.equal(at(NOW + 35 * MIN), undefined)
  assert.deepEqual(kept('one').hint, { at: NOW + 35 * MIN })
  logOf(simple, log)
  assert.equal(at(NOW + 40 * MIN - 1), undefined)
  assert.equal(at(NOW + 40 * MIN), DOWN)
  // A hint that is found again after its 30 minutes stays for another 30.
  assert.equal(at(NOW + 70 * MIN), DOWN)
  assert.deepEqual(kept('one').hint, { at: NOW + 70 * MIN, text: DOWN })
  // Each session has its own time: another session with the same log looks at it at once.
  assert.equal(hintPart(line(logged(log, { session_id: 'two' }), NOW + 71 * MIN)), DOWN)
  assert.deepEqual(kept('two').hint, { at: NOW + 71 * MIN, text: DOWN })
  assert.deepEqual(kept('one').hint, { at: NOW + 70 * MIN, text: DOWN })

  // The person types /effort medium. The saved text names the level "high", so it is no longer
  // shown. The log is not looked at before the 5 minutes are over.
  assert.equal(at(NOW + 72 * MIN, MEDIUM), undefined)
  assert.deepEqual(kept('one').hint, { at: NOW + 70 * MIN, text: DOWN })
  // Back at "high" the saved hint is true again.
  assert.equal(at(NOW + 73 * MIN), DOWN)
  // At "medium", 5 minutes after the last look, the log is looked at for that level: no hint.
  assert.equal(at(NOW + 75 * MIN, MEDIUM), undefined)
  assert.deepEqual(kept('one').hint, { at: NOW + 75 * MIN })
  // While the hint is off, or the model is an older one, a saved hint is not shown either.
  assert.equal(at(NOW + 80 * MIN), DOWN)
  assert.equal(at(NOW + 81 * MIN, { model: { id: 'claude-opus-4-5' } }), undefined)
  saveConfig({ hint: { on: false } })
  assert.equal(at(NOW + 82 * MIN), undefined)
  saveConfig({})
  assert.equal(at(NOW + 83 * MIN), DOWN)
  assert.deepEqual(kept('one').hint, { at: NOW + 80 * MIN, text: DOWN })
  // A saved time that lies ahead comes from a clock that was wrong: the log is looked at again.
  logOf(mixed, log)
  keep('one', { hint: { at: NOW + DAY, text: DOWN } })
  assert.equal(at(NOW + 84 * MIN), undefined)
  assert.deepEqual(kept('one').hint, { at: NOW + 84 * MIN })
  // What is kept for the hint is not a time: the same.
  for (const hint of [{ at: 'soon' }, { text: DOWN }, 'a hint', null]) {
    keep('one', { hint })
    assert.equal(at(NOW + 85 * MIN), undefined, JSON.stringify(hint))
    assert.deepEqual(kept('one').hint, { at: NOW + 85 * MIN })
  }
  // The other fields of the session's file stay when the hint is saved, and the hooks keep the hint.
  saveConfig({ limits: { session: 10, action: 'ask' } })
  assert.ok(limitHook({ session_id: 'one' }, NOW + 86 * MIN))
  logOf(simple, log)
  assert.equal(at(NOW + 90 * MIN), DOWN)
  assert.equal(kept('one').askedAt, 12.4)
  assert.ok(limitHook({ session_id: 'two' }, NOW + 91 * MIN))
  assert.deepEqual(kept('two').hint, { at: NOW + 71 * MIN, text: DOWN })
})

test('only the last 256 KB of a log are read: the first line of that piece is cut and is dropped, and a line that is not JSON is skipped', () => {
  // The line of one call that read, and 19 more calls that read.
  const first = JSON.stringify(callLines(['Read'])[0])
  const rest = callsOf(19, ['Read'])
  // In a log of under 256 KB every line is whole, and all 20 calls count.
  assert.equal(hintFor([first, ...rest]), DOWN)
  assert.equal(hintFor([`${' '.repeat(1000)}${first}`, ...rest]), DOWN)
  // The same lines with 256 KB of spaces in front of the first one. JSON may begin with spaces, so
  // that line is still the line of a call. But the last 256 KB now begin inside the spaces: the
  // line is the one that is cut. It is dropped, and 19 calls are left.
  assert.equal(hintFor([`${' '.repeat(256 * 1024)}${first}`, ...rest]), undefined)
  // What lies before the last 256 KB is not read: 30 calls that changed files, then a line of
  // 256 KB, then 20 calls that read. Of the last 30 calls of the whole log only 67% read.
  const large = { type: 'user', message: { role: 'user', content: 'a private prompt '.repeat(16 * 1024) } }
  assert.equal(hintFor([...callsOf(30, ['Edit']), large, ...callsOf(20, ['Read'])]), DOWN)
  assert.equal(hintFor([...callsOf(30, ['Edit']), ...callsOf(20, ['Read'])]), undefined)

  // Lines that are not JSON, that are no object, or that are no model call are skipped.
  const broken = [
    '{"type":"assistant","message":{"id":"msg_cut","content":[{"type":"tool_use","name":"Edit"',
    'not JSON at all', '', '   ', 'null', '[]', '"a private text"', '42', '{}',
    '{"type":"assistant"}', '{"type":"assistant","message":"a private message"}', '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit"}]}}',
    '{"type":"user"}', '{"type":"user","message":{"content":[null,7,"a private text"]}}',
    JSON.stringify({ type: 'assistant', message: { id: 'made-up', model: '<synthetic>', content: [{ type: 'tool_use', id: 'x', name: 'Edit', input: {} }] } }),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
  ]
  const between = (calls) => calls.flatMap((l, i) => [l, broken[i % broken.length]])
  assert.equal(hintFor(between(callsOf(20, ['Read']))), DOWN)
  // None of them counts as a call.
  assert.equal(hintFor(between(callsOf(19, ['Read']))), undefined)
  // The last line of a log can still be in the middle of being written.
  assert.equal(hintFor([...callsOf(20, ['Read']), JSON.stringify(callLines(['Edit'])[0]).slice(0, 120)]), DOWN)
  // A line break of Windows at the end of each line does no harm.
  assert.equal(hintFor(callsOf(20, ['Read']).map((l) => `${JSON.stringify(l)}\r`)), DOWN)
})

test('a log that is missing or cannot be read gives no hint and no error', () => {
  const simple = callsOf(30, ['Read'])
  /** The line and the kept hint of a session whose log is at `path`. */
  const seen = (path) => {
    freshHome()
    return [line(logged(path)), kept('one').hint]
  }
  // No file at that path. The look is kept, so that it is not tried again on every run.
  assert.deepEqual(seen(join(dir, 'no-such-log.jsonl')), [SUBSCRIBER, { at: NOW }])
  assert.deepEqual(seen(join(dir, 'no-such-folder', 'log.jsonl')), [SUBSCRIBER, { at: NOW }])
  // A folder, an empty file, and a file that is no text.
  assert.deepEqual(seen(dir), [SUBSCRIBER, { at: NOW }])
  assert.deepEqual(seen(logOf([], join(dir, 'empty.jsonl'))), [SUBSCRIBER, { at: NOW }])
  writeFileSync(join(dir, 'bytes.jsonl'), Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 256)))
  assert.deepEqual(seen(join(dir, 'bytes.jsonl')), [SUBSCRIBER, { at: NOW }])
  // A file that this user may not read. The user "root" may read every file, so there it is left out.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = logOf(simple, join(dir, 'locked.jsonl'))
    chmodSync(locked, 0o000)
    assert.deepEqual(seen(locked), [SUBSCRIBER, { at: NOW }])
    chmodSync(locked, 0o644)
    assert.deepEqual(seen(locked), [`${SUBSCRIBER} | ${DOWN}`, { at: NOW, text: DOWN }])
  }
  // A pipe is not opened: that would wait for its other end, and the status line with it. Here
  // the command runs, so that a wait ends after 10 seconds and fails the test.
  const pipe = join(dir, 'pipe.jsonl')
  if (process.platform !== 'win32' && spawnSync('mkfifo', [pipe]).status === 0) {
    // The command reads the layout from the settings: the one line, whose parts this test looks at.
    saveConfig({ hud: { layout: 'one' } })
    const waited = exec(['statusline'], { NO_COLOR: '1' }, JSON.stringify(logged(pipe, { session_id: 'pipe' })), { timeout: 10e3 })
    assert.deepEqual([waited.status, waited.signal, waited.stderr], [0, null, ''])
    assert.ok(waited.stdout.endsWith(' | effort high'), waited.stdout)
  }
  // A path that is no text, or no path at all: nothing is looked at.
  for (const path of [undefined, null, '', 7, { a: 1 }, ['a']]) assert.deepEqual(seen(path), [SUBSCRIBER, undefined], JSON.stringify(path))

  // The command prints the line without a hint, and ends with exit code 0.
  freshHome()
  saveConfig({ hud: { layout: 'one' } })
  const none = exec(['statusline'], { NO_COLOR: '1' }, JSON.stringify(logged(join(dir, 'no-such-log.jsonl'))))
  assert.deepEqual([none.status, none.stderr], [0, ''])
  assert.ok(none.stdout.endsWith(' | effort high'), none.stdout)
  // With a log that it can read, the command prints the hint as the last part.
  const found = exec(['statusline'], { NO_COLOR: '1' }, JSON.stringify(logged(logOf(simple), { session_id: 'two' })))
  assert.deepEqual([found.status, found.stderr], [0, ''])
  assert.ok(found.stdout.endsWith(` | effort high | ${DOWN}`), found.stdout)
})

test('a look at a log of 100 MB takes well under 100 ms, because only its end is read', () => {
  freshHome()
  const size = 100 * 1024 * 1024
  // Only the end of the file is written: 600 calls that read, which is more than 256 KB. The
  // rest of the 100 MB is a hole that takes no room on the disk, so the test itself stays fast.
  const end = Buffer.from(`\n${callsOf(600, ['Read']).map((l) => JSON.stringify(l)).join('\n')}\n`)
  assert.ok(end.length > 256 * 1024 && end.length < 1024 * 1024, `the end has ${end.length} bytes`)
  const file = join(dir, 'large.jsonl')
  const fd = openSync(file, 'w')
  ftruncateSync(fd, size)
  writeSync(fd, end, 0, end.length, size - end.length)
  closeSync(fd)
  assert.equal(statSync(file).size, size)
  // Three sessions look at the log, each for the first time. The fastest run counts, so that a
  // busy machine does not fail the test.
  const took = ['first', 'second', 'third'].map((id) => {
    const start = performance.now()
    const shown = line(logged(file, { session_id: id }))
    const ms = performance.now() - start
    // The run did look at the log: it found the hint, and kept it.
    assert.equal(shown, `${SUBSCRIBER} | ${DOWN}`)
    assert.deepEqual(kept(id).hint, { at: NOW, text: DOWN })
    return ms
  })
  assert.ok(Math.min(...took) < 50, `the fastest of three runs took ${Math.min(...took).toFixed(1)} ms`)
})

test('no text from the log ends up in the session\'s file, in any other file of this tool or on the line', () => {
  // Every text in the made-up lines has "private" or "someone" in it: the folder, the branch,
  // the answers, what the tools were given and what they gave back. One tool has such a name too.
  const own = 'mcp__private_server__private_tool'
  const down = [...callsOf(24, ['Read']), ...callsOf(3, [own]), ...callsOf(3, ['Edit'])]
  const up = [...callsOf(5, [own], true), ...callsOf(25, ['Edit'])]
  assert.match(JSON.stringify([...down, ...up]), /private-folder.*private-branch.*private command.*private-file.*private result/)
  for (const [lines, input, text] of [[down, {}, DOWN], [up, MEDIUM, UP]]) {
    freshHome()
    const log = logOf(lines)
    const shown = line(logged(log, input))
    assert.equal(hintPart(shown), text)
    // The hint is its time and its fixed words, with the level that Claude Code gave.
    assert.deepEqual(kept('one').hint, { at: NOW, text })
    const all = shown + filesText()
    assert.doesNotMatch(all, /private|someone|msg_|_tool_/)
    // The path of the log is not kept either.
    assert.ok(!all.includes(log) && !all.includes('log-'), all)
  }
})

test('"kestrel hint" shows the settings, turns the hint on and off, and "status" has a row for it', () => {
  freshHome()
  const config = () => JSON.parse(readFileSync(join(process.env.KESTREL_HOME, 'config.json'), 'utf8'))
  const when = 'from the last 30 model calls of a session: a lower level when 80% or more of them are simple work, a higher level from 5 tool errors'
  // The same command turns the hint to compact on and off, and says so in a second line.
  const compact = 'at a break in the work: when 100,000 tokens or less are left before Claude Code compacts on its own, when a task just ended and the context has 150,000 tokens or more, or when the context grew by 150,000 tokens'
  const compactOn = `Compaction hint on the status line: on, ${compact}.\n`
  const compactOff = `Compaction hint on the status line: off (when on: ${compact}).\n`
  // The value of the row of "kestrel status" for the hint.
  const row = () => run(['status']).split('\n').find((l) => l.startsWith('Effort hint')).replace(/^Effort hint +/, '')
  // The hint is on until the person turns it off.
  const shown = run(['hint'])
  assert.ok(shown.startsWith(`Effort hint on the status line: on, ${when}.\n`), shown)
  assert.match(shown, /A change of the effort level keeps the cache\. You type the command: nothing changes on its own\.\n/)
  assert.match(shown, /\nTurn both off with "kestrel hint off", and on with "kestrel hint on"\.\n$/)
  assert.equal(row(), `on, ${when}`)
  assert.equal(existsSync(join(process.env.KESTREL_HOME, 'config.json')), false)

  writeFileSync(SETTINGS, JSON.stringify(OTHER))
  installStatusLine('/bin/kestrel')
  saveConfig({ limits: { day: 200, action: 'warn' } })
  assert.equal(run(['hint', 'off']), `Effort hint on the status line: off (when on: ${when}).\n${compactOff}`)
  assert.deepEqual(config(), { limits: { day: 200, action: 'warn' }, hint: { on: false, calls: 30, simple: 0.8, errors: 5 }, compactHint: { on: false, growth: 150000, near: 100000 } })
  assert.ok(run(['hint']).startsWith(`Effort hint on the status line: off (when on: ${when}).\n`))
  assert.equal(row(), `off (when on: ${when})`)
  // While it is off the status line has no hint, and does not look at the log.
  const log = logOf(callsOf(30, ['Read']))
  assert.equal(hintPart(line(logged(log))), undefined)
  assert.equal(kept('one').hint, undefined)
  assert.equal(run(['hint', 'on']), `Effort hint on the status line: on, ${when}.\n${compactOn}`)
  assert.deepEqual(config(), { limits: { day: 200, action: 'warn' }, hint: { on: true, calls: 30, simple: 0.8, errors: 5 }, compactHint: { on: true, growth: 150000, near: 100000 } })
  assert.equal(hintPart(line(logged(log))), DOWN)
  assert.deepEqual(kept('one').hint, { at: NOW, text: DOWN })

  // The numbers that were set by hand in the settings stay, and the words give them.
  saveConfig({ hint: { on: true, calls: 40, simple: 0.9, errors: 8 } })
  assert.equal(run(['hint', 'off']), `Effort hint on the status line: off (when on: from the last 40 model calls of a session: a lower level when 90% or more of them are simple work, a higher level from 8 tool errors).\n${compactOff}`)
  assert.deepEqual(config().hint, { on: false, calls: 40, simple: 0.9, errors: 8 })
  // What is not "on" or "off" fails and changes nothing.
  const bad = exec(['hint', 'sometimes'])
  assert.deepEqual([bad.status, bad.stdout, bad.stderr], [1, '', 'kestrel: Use "kestrel hint on" or "kestrel hint off".\n'])
  assert.deepEqual(config().hint, { on: false, calls: 40, simple: 0.9, errors: 8 })
  // Without this tool's status line there is nowhere to show the hint, and turning it on says so.
  writeFileSync(SETTINGS, JSON.stringify(OTHER))
  assert.match(run(['hint', 'on']), /\nNote: the hint is shown on the status line\. Run "kestrel install" first\.\n$/)
  assert.doesNotMatch(run(['hint', 'off']), /Note/)
  // The settings of Claude Code are not changed by any of this.
  assert.deepEqual(settings(), OTHER)
  assert.match(run(['help']), /^  kestrel hint on\|off +turn those hints on or off$/m)
})

test('after a change of account: a fresh reading wins over a kept one with a later end', () => {
  freshHome()
  // The old account's week, saved by a session 8 hours ago, ends in 3 days.
  line(session({ session_id: 'old', rate_limits: { seven_day: { used_percentage: 85, resets_at: sec(NOW + 3 * DAY) } } }), NOW - 8 * HOUR)
  // This session runs on another account, whose week ends in 1 day.
  const other = (apiMs) => session({ session_id: 'new', cost: { total_cost_usd: 1, total_duration_ms: HOUR, total_api_duration_ms: apiMs }, rate_limits: { seven_day: { used_percentage: 20, resets_at: sec(NOW + DAY) } } })
  // Its first run has nothing to compare with, so it is not fresh, and the kept reading stays.
  line(other(1000), NOW - MIN)
  assert.equal(readLimits(NOW).week.pct, 85)
  // The next run comes after a model call: it is fresh, and its reading wins.
  assert.match(line(other(2000)).split(' | ')[0], /^week 20% used, /)
  assert.equal(readLimits(NOW).week.pct, 20)
})

test('a session that has had answers but gets no plan limits does not show a reading of another account', () => {
  freshHome()
  line(session({ session_id: 'old', rate_limits: { seven_day: { used_percentage: 85, resets_at: sec(NOW + 3 * DAY) } } }), NOW - 8 * HOUR)
  const answered = session({ session_id: 'answered', cost: { total_cost_usd: 1.5, total_duration_ms: HOUR, total_api_duration_ms: 5000 } })
  const shown = line(answered)
  assert.doesNotMatch(shown, /85%/)
  assert.match(shown.split(' | ')[0], /\$1\.50 session.*\(list prices\)$/)
  assert.deepEqual(billing(answered, { env: {}, cfg: {}, now: NOW }), { mode: 'usage', sure: false, why: 'this session has had answers, and Claude Code gives it no plan limits' })
  // A session before its first answer still shows the kept reading: its limits come with that answer.
  const starting = session({ session_id: 'starting', cost: { total_cost_usd: 0, total_duration_ms: MIN, total_api_duration_ms: 0 } })
  assert.match(line(starting).split(' | ')[0], /^week 85% used \(read 8 hours ago\)/)
})
