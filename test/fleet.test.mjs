// Tests for today's numbers ("kestrel refresh-today"), the live view of every session
// ("kestrel top"), the spend per ticket ("kestrel tickets"), and the two tools of the desktop
// extension that give the same. With made-up logs of Claude Code, Codex and Cowork, made-up
// session files and made-up home folders. Run: node --test
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'kestrel-fleet-test-'))
process.env.HOME = join(dir, 'home-folder')
process.env.KESTREL_HOME = join(dir, 'home')
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
process.env.CODEX_HOME = join(dir, 'codex')
process.env.KESTREL_COWORK_DIR = join(dir, 'cowork')
// These say that the person pays by the token. The made-up computer is on a subscription.
for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE']) delete process.env[name]

const { refreshToday, todayNumbers } = await import('../src/refresh-today.mjs')
const { load } = await import('../src/store.mjs')
const { tickets } = await import('../src/report.mjs')
const { claudeTail, top, topText } = await import('../src/top.mjs')
const { localDay, readToday } = await import('../src/today-file.mjs')

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[/\\]$/, '')
const KESTREL = join(ROOT, 'cli', 'kestrel.mjs')
const HOUR = 3600e3
const MIN = 60e3
const iso = (ms) => new Date(ms).toISOString()
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// A word in every prompt, answer, tool call, tool result and task of the made-up logs. Only the
// view in the terminal with names on may show it, and no file may hold it.
const MARKER = 'PELICANSECRET'
// Noon today, so that every call of the made-up logs is on the same local day, whenever the test runs.
const NOON = (() => {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  return d.getTime()
})()

let machines = 0
/** A made-up computer: every folder the tool reads or writes is in a new folder. */
function machine() {
  const home = join(dir, `machine-${++machines}`)
  mkdirSync(home, { recursive: true })
  const env = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    KESTREL_HOME: join(home, '.kestrel'), CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), KESTREL_COWORK_DIR: join(home, 'cowork'),
  }
  return { home, env, kestrel: env.KESTREL_HOME }
}

/** Points this process at a made-up computer, for the parts that run in it. */
function use(m) {
  for (const key of ['HOME', 'KESTREL_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'KESTREL_COWORK_DIR']) process.env[key] = m.env[key]
  return m
}

/** Runs the command on a made-up computer. */
const run = (m, args, more = {}) => spawnSync(process.execPath, [KESTREL, ...args], { encoding: 'utf8', env: { ...m.env, ...more } })
const lines = (list) => `${list.join('\n')}\n`
const writeJson = (file, value) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

/**
 * Made-up logs of all three agents, all from today when `now` is noon:
 *   - Claude Code, session c1 in /work/app on the branch user/abc-322-login (ticket ABC-322):
 *       a0, yesterday at now - 20 hours: 300,000 tokens written to the cache, 1,000 out.
 *       a1, at now - 3 hours, after the cache had ended: 310,000 written again, 1,000 out. It
 *         carried the 300,000 tokens of a0 and read none of them from the cache: a cold start
 *         that sent 300,000 tokens again. It updates the task list and starts two subagents.
 *       a2, a minute later: 311,000 read from the cache, 2,000 written, 1,000 out.
 *     Today: 311,000 + 314,000 = 625,000 tokens, 311,000 of them read from the cache.
 *   - Claude Code, session c2 in /work/web on the branch abc-322-ui (ABC-322 as well): one call
 *     at now - 30 minutes with 50,000 in and 5,000 out, 55,000 tokens.
 *   - Codex, session x1 in /work/api on the branch abc-7-api (ticket ABC-7): one call at now - 2
 *     hours with 100,000 in, 40,000 of them from the cache, and 10,000 out: 110,000 tokens. Its
 *     context window is 400,000 tokens. Its log was written 30 seconds ago.
 *   - Cowork, session w1 in /sessions/calm-river, no branch: one call at now - 4 hours with
 *     100,000 in and 1,000 out: 101,000 tokens. Its log was written 10 minutes ago.
 * Today together: 891,000 tokens, 351,000 read from the cache, 1 cold start of 300,000 tokens.
 */
function writeLogs(m, now) {
  const projects = join(m.env.CLAUDE_CONFIG_DIR, 'projects')
  const usage = (input, w1, cr, out) => ({
    input_tokens: input, cache_creation_input_tokens: w1, cache_read_input_tokens: cr, output_tokens: out,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: w1 },
  })
  const claude = (cwd, ses, branch) => (fields) => JSON.stringify({ cwd, sessionId: ses, gitBranch: branch, ...fields })
  const app = claude('/work/app', 'c1', 'user/abc-322-login')
  const answer = (id, ts, use, content = []) => ({ type: 'assistant', timestamp: iso(ts), message: { id, model: 'claude-opus-5-5', role: 'assistant', content, usage: use } })
  mkdirSync(join(projects, '-work-app'), { recursive: true })
  writeFileSync(join(projects, '-work-app', 'c1.jsonl'), lines([
    app({ type: 'user', timestamp: iso(now - 20 * HOUR - 5e3), message: { role: 'user', content: `Fix the ${MARKER} parser` } }),
    app(answer('a0', now - 20 * HOUR, usage(0, 300000, 0, 1000), [{ type: 'text', text: `Looking at ${MARKER}` }])),
    app(answer('a1', now - 3 * HOUR, usage(0, 310000, 0, 1000), [
      { type: 'tool_use', id: 'todo1', name: 'TodoWrite', input: { todos: [
        { content: `Read the ${MARKER} file`, activeForm: `Reading the ${MARKER} file`, status: 'completed' },
        { content: `Write the ${MARKER} notes`, activeForm: `Writing the ${MARKER} notes`, status: 'in_progress' },
      ] } },
      { type: 'tool_use', id: 'ag1', name: 'Agent', input: { description: `Look for ${MARKER}`, prompt: MARKER } },
      { type: 'tool_use', id: 'ag2', name: 'Agent', input: { description: `Check ${MARKER}`, prompt: MARKER } },
    ])),
    app({ type: 'user', timestamp: iso(now - 3 * HOUR + 30e3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ag2', content: `${MARKER} done` }] } }),
    app(answer('a2', now - 3 * HOUR + MIN, usage(0, 2000, 311000, 1000))),
  ]))
  const web = claude('/work/web', 'c2', 'abc-322-ui')
  mkdirSync(join(projects, '-work-web'), { recursive: true })
  writeFileSync(join(projects, '-work-web', 'c2.jsonl'), lines([web(answer('b1', now - 30 * MIN, usage(50000, 0, 0, 5000), [{ type: 'text', text: MARKER }]))]))

  const codex = join(m.env.CODEX_HOME, 'sessions', '2026', '11', '14')
  mkdirSync(codex, { recursive: true })
  const event = (ts, type, payload) => JSON.stringify({ timestamp: iso(ts), type, payload })
  const codexLog = join(codex, 'rollout-x1.jsonl')
  writeFileSync(codexLog, lines([
    event(now - 2 * HOUR - 10e3, 'session_meta', { session_id: 'x1', id: 'x1', cwd: '/work/api', git: { commit_hash: 'abc', branch: 'abc-7-api' }, context_window: 400000 }),
    event(now - 2 * HOUR - 9e3, 'turn_context', { model: 'gpt-6-sol', effort: 'medium', cwd: '/work/api' }),
    event(now - 2 * HOUR - 8e3, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Run the ${MARKER} tests` }] }),
    event(now - 2 * HOUR - 7e3, 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['echo', MARKER] }), call_id: 'k1' }),
    event(now - 2 * HOUR, 'token_usage_record', { response_id: 'r1', usage: { input_tokens: 100000, cached_input_tokens: 40000, output_tokens: 10000, reasoning_output_tokens: 0 } }),
    event(now - 2 * HOUR, 'event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 100000, cached_input_tokens: 40000, output_tokens: 10000 }, total_token_usage: { total_tokens: 110000 }, model_context_window: 400000 } }),
    event(now - 2 * HOUR + 1e3, 'response_item', { type: 'function_call_output', call_id: 'k1', output: MARKER }),
  ]))
  utimesSync(codexLog, (now - 30e3) / 1000, (now - 30e3) / 1000)

  const cowork = join(m.env.KESTREL_COWORK_DIR, 'account-1', 'workspace-1', 'local_w1')
  mkdirSync(cowork, { recursive: true })
  const entry = (fields) => JSON.stringify({ session_id: 'engine-1', _audit_timestamp: iso(now - 4 * HOUR), ...fields })
  const coworkLog = join(cowork, 'audit.jsonl')
  writeFileSync(coworkLog, lines([
    entry({ type: 'system', subtype: 'init', cwd: '/sessions/calm-river' }),
    entry({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: `Write about ${MARKER}` } }),
    entry({ type: 'assistant', parent_tool_use_id: null, message: { id: 'w1', model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'text', text: MARKER }], usage: { input_tokens: 100000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1000 } } }),
  ]))
  utimesSync(coworkLog, (now - 10 * MIN) / 1000, (now - 10 * MIN) / 1000)
}

/**
 * The files that Claude Code's status line keeps per session, and the newest reading of the
 * plan's limits. c1 works, c2 waits for the person (its last call was 12.5 minutes ago, and its
 * cache ends in 20 minutes), and the session "old" was last seen 5 minutes ago, so it is closed.
 * c2's file names no ticket: the view takes it from today's numbers.
 */
function writeSessions(m, now) {
  const sessions = join(m.kestrel, 'sessions')
  writeJson(join(sessions, 'c1.json'), { at: now - 10e3, callAt: now - 20e3, cacheUntil: now + 50 * MIN, ttl: '1h', ctx: 313000, project: 'work/app', model: 'claude-opus-5-5', ticket: 'ABC-322', branch: 'user/abc-322-login' })
  writeJson(join(sessions, 'c2.json'), { at: now - 30e3, callAt: now - 12.5 * MIN, cacheUntil: now + 20 * MIN, ttl: '1h', ctx: 55000, project: 'work/web', model: 'claude-opus-5-5' })
  writeJson(join(sessions, 'old.json'), { at: now - 5 * MIN, callAt: now - 6 * MIN, project: 'work/old' })
  writeJson(join(m.kestrel, 'limits.json'), { five: { pct: 33, resetsAt: now + 2 * HOUR, at: now - 10 * MIN } })
}

/** A made-up computer with the logs and the session files, and this process pointed at it. */
function computer(now = NOON) {
  const m = use(machine())
  writeLogs(m, now)
  writeSessions(m, now)
  return m
}

/** Every file below a folder. */
const filesBelow = (folder) => readdirSync(folder, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name))
const noMarkerIn = (folder) => {
  for (const file of filesBelow(folder)) assert.ok(!readFileSync(file, 'utf8').includes(MARKER), file)
}

test('refresh-today works out the numbers per session and per ticket, as they can be worked out by hand', async () => {
  const m = computer()
  assert.equal(await refreshToday({ now: NOON }), true)
  const today = readToday(NOON)
  assert.deepEqual(today, {
    day: localDay(NOON), at: NOON, tokens: 891000, cacheRead: 351000, coldStarts: 1, coldTokens: 300000,
    sessions: {
      c1: { tokens: 625000, source: 'claude', project: 'work/app', ticket: 'ABC-322' },
      c2: { tokens: 55000, source: 'claude', project: 'work/web', ticket: 'ABC-322' },
      x1: { tokens: 110000, source: 'codex', project: 'work/api', ticket: 'ABC-7' },
      w1: { tokens: 101000, source: 'cowork', project: 'sessions/calm-river' },
    },
    tickets: { 'ABC-322': { tokens: 680000, sessions: 2 }, 'ABC-7': { tokens: 110000, sessions: 1 } },
    // The made-up Claude Code logs name no account, and the Codex log names no plan type.
    accounts: { unknown: { tokens: 680000, cacheRead: 311000 }, 'codex:unknown': { tokens: 110000, cacheRead: 40000 }, 'cowork:account-1': { tokens: 101000, cacheRead: 0 } },
  })
  // The lock is given back.
  assert.equal(existsSync(join(m.kestrel, 'today.lock')), false)
  noMarkerIn(m.kestrel)
})

test('a cold start is only a call after the cache had ended that wrote 100,000 tokens or more again', async () => {
  const m = use(machine())
  const folder = join(m.env.CLAUDE_CONFIG_DIR, 'projects', '-work-small')
  mkdirSync(folder, { recursive: true })
  const call = (id, ts, w1, cr) => JSON.stringify({ type: 'assistant', timestamp: iso(ts), cwd: '/work/small', message: { id, model: 'claude-opus-5-5', content: [], usage: { input_tokens: 0, cache_creation_input_tokens: w1, cache_read_input_tokens: cr, output_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: w1 } } } })
  // After 2 hours, a context of 50,000 tokens is written again: below 100,000. The context then
  // grows to 200,200 tokens, and 9 minutes later all of it is written again. Its cache lasts 1
  // hour, so it had not ended: the start of the prompt changed.
  writeFileSync(join(folder, 's.jsonl'), lines([
    call('k1', NOON - 3 * HOUR, 50000, 0),
    call('k2', NOON - HOUR, 50100, 0),
    call('k3', NOON - 59 * MIN, 150000, 50200),
    call('k4', NOON - 50 * MIN, 201000, 0),
  ]))
  const { records } = await load({ since: NOON - 12 * HOUR })
  const today = todayNumbers(records, NOON)
  assert.equal(today.coldStarts, 0)
  assert.equal(today.coldTokens, 0)
  assert.deepEqual(Object.keys(today.tickets), [])
})

test('refresh-today prints nothing, a second run ends at once while the lock is new, and an old lock is taken over', () => {
  const m = machine()
  writeLogs(m, Date.now())
  // The first run, as the status line starts it: nothing printed, and the file is there.
  let r = run(m, ['refresh-today'])
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''])
  assert.ok(existsSync(join(m.kestrel, 'today.json')))
  assert.equal(existsSync(join(m.kestrel, 'today.lock')), false)

  // Another run holds the lock: this one ends at once, writes nothing and leaves the lock alone.
  rmSync(join(m.kestrel, 'today.json'))
  const held = String(Date.now() - MIN)
  writeFileSync(join(m.kestrel, 'today.lock'), held)
  r = run(m, ['refresh-today'])
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''])
  assert.equal(existsSync(join(m.kestrel, 'today.json')), false)
  assert.equal(readFileSync(join(m.kestrel, 'today.lock'), 'utf8'), held)

  // A lock of 11 minutes ago belongs to a run that died: it is taken over, and given back after.
  writeFileSync(join(m.kestrel, 'today.lock'), String(Date.now() - 11 * MIN))
  r = run(m, ['refresh-today'])
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''])
  assert.ok(existsSync(join(m.kestrel, 'today.json')))
  assert.equal(existsSync(join(m.kestrel, 'today.lock')), false)
  // A lock that holds no time is taken over too.
  writeFileSync(join(m.kestrel, 'today.lock'), 'not a time')
  rmSync(join(m.kestrel, 'today.json'))
  r = run(m, ['refresh-today'])
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''])
  assert.ok(existsSync(join(m.kestrel, 'today.json')))
  noMarkerIn(m.kestrel)
})

test('on an error refresh-today writes nothing, prints nothing and ends with exit code 0', () => {
  const m = machine()
  writeLogs(m, Date.now())
  // The cache of the parsed logs cannot be made: its place is a file.
  mkdirSync(m.kestrel, { recursive: true })
  writeFileSync(join(m.kestrel, 'cache'), '')
  const r = run(m, ['refresh-today'])
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''])
  assert.equal(existsSync(join(m.kestrel, 'today.json')), false)
  assert.equal(existsSync(join(m.kestrel, 'today.lock')), false)
})

// The view of the made-up computer at noon, with names on and without colours.
const VIEW = [
  'Kestrel · 4 sessions on this computer · 5 hour limit 33% used (read 10 min ago), 60% of its time gone · 12:00:00',
  '',
  'SESSION              TOOL    TICKET                    STATE                   CONTEXT     CACHE              TODAY  AGENTS  TASK',
  `work/app             Claude  ABC-322 also in work/web  working                 313k        warm, 50 min left  625k   1       Writing the ${MARKER} notes`,
  'work/api             Codex   ABC-7                     working                 100k (25%)  not known          110k',
  'work/web             Claude  ABC-322 also in work/app  waits for you (12 min)  55k         warm, 20 min left  55k',
  'sessions/calm-river  Cowork                            idle (10 min)           100k        not known          101k',
  '',
  'Waste today: 1 cold start sent 300k tokens again (34% of today).',
  'Next: work/web waits for you, and its cache ends at 12:20. Answer before then, or /compact first.',
].join('\n')

test('top --once: the rows in the order working, waits for you, idle, every column, the overlap of a ticket, and the first "Next" rule', async () => {
  computer()
  await refreshToday({ now: NOON })
  assert.equal(topText(NOON, { names: true }), VIEW)
  // Without names: no TASK column, and nothing else changes.
  const without = topText(NOON, { names: false })
  assert.equal(without, VIEW.split('\n').map((line) => line.replace(/ {2}(TASK|Writing the .+ notes)$/, '').trimEnd()).join('\n'))
  assert.ok(!without.includes(MARKER))
})

test('top: the second "Next" rule, and none when no rule holds', async () => {
  const m = computer()
  await refreshToday({ now: NOON })
  const sessions = join(m.kestrel, 'sessions')
  // c2's cache ends in 45 minutes: no longer within 30. A session waits with 400,000 tokens of context, and its cache is gone.
  writeJson(join(sessions, 'c2.json'), { at: NOON - 30e3, callAt: NOON - 12.5 * MIN, cacheUntil: NOON + 45 * MIN, ttl: '1h', ctx: 55000, project: 'work/web' })
  writeJson(join(sessions, 'big.json'), { at: NOON - 15e3, callAt: NOON - 40 * MIN, cacheUntil: NOON - 5 * MIN, ttl: '1h', ctx: 400000, project: 'work/big' })
  let text = topText(NOON)
  assert.match(text, /\nwork\/big +Claude +waits for you \(40 min\) +400k +gone\n/)
  assert.ok(text.endsWith('\nNext: work/big waits with 400k of context: a good moment to /compact.'), text)
  // Without the large session no rule holds, and there is no "Next" line.
  rmSync(join(sessions, 'big.json'))
  text = topText(NOON)
  assert.ok(text.endsWith('\nWaste today: 1 cold start sent 300k tokens again (34% of today).'), text)
  assert.doesNotMatch(text, /Next:/)
  // Without today's numbers, the view says so.
  rmSync(join(m.kestrel, 'today.json'))
  assert.match(topText(NOON), /\nToday's numbers are not worked out yet\.$/)
})

test('top: colours as the status line has them, and none with NO_COLOR or without a terminal', async () => {
  const m = computer()
  await refreshToday({ now: NOON })
  const colored = topText(NOON, { names: true, colors: true })
  assert.match(colored, /\x1b\[32mworking\x1b\[0m/)
  assert.match(colored, /\x1b\[33mwaits for you \(12 min\)\x1b\[0m/)
  assert.match(colored, /\x1b\[2midle \(10 min\)\x1b\[0m/)
  assert.match(colored, /ABC-322\x1b\[33m also in work\/web\x1b\[0m/)
  assert.match(colored, /\x1b\[32mwarm, 50 min left\x1b\[0m/)
  assert.match(colored, /\x1b\[32m5 hour limit 33% used/)
  // Without the codes, the coloured view is the same text, column for column.
  assert.equal(colored.replace(/\x1b\[[0-9;]*m/g, ''), VIEW)

  // A stand-in terminal with NO_COLOR, and the command with its output in a pipe: no codes.
  const output = { isTTY: true, text: '', write(s) { this.text += s } }
  await top({ once: true, output, env: { NO_COLOR: '1' }, time: () => NOON })
  assert.ok(output.text.includes('SESSION') && !output.text.includes('\x1b'), output.text)
  const r = run(m, ['top', '--once'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^Kestrel · \d+ sessions? on this computer/)
  assert.ok(!r.stdout.includes('\x1b') && !r.stderr.includes('\x1b'))
})

test('top: the TASK column follows the setting hud.names, and --no-names leaves it out whatever the setting says', async () => {
  const m = computer()
  await refreshToday({ now: NOON })
  const view = async () => {
    const output = { isTTY: false, text: '', write(s) { this.text += s } }
    await top({ once: true, output, env: {}, time: () => NOON })
    return output.text
  }
  assert.equal(await view(), `${VIEW}\n`)
  writeJson(join(m.kestrel, 'config.json'), { hud: { names: false } })
  const off = await view()
  assert.doesNotMatch(off, /TASK/)
  assert.ok(!off.includes(MARKER))
  writeJson(join(m.kestrel, 'config.json'), { hud: { names: true } })
  assert.match(await view(), /TASK/)
  const output = { isTTY: false, text: '', write(s) { this.text += s } }
  await top({ once: true, names: false, output, env: {}, time: () => NOON })
  assert.doesNotMatch(output.text, /TASK/)
  noMarkerIn(m.kestrel)
})

test('the end of a Claude Code log: running subagents, and the task in progress of TaskCreate and TaskUpdate', () => {
  const m = use(machine())
  const file = join(m.home, 'tasks.jsonl')
  const tool = (id, name, input) => JSON.stringify({ type: 'assistant', message: { id: `m-${id}`, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }], usage: {} } })
  const result = (id, extra = {}) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, ...extra })
  writeFileSync(file, lines([
    tool('t1', 'TaskCreate', { subject: 'First', activeForm: 'Doing the first' }),
    result('t1', { toolUseResult: { task: { id: '1' } } }),
    tool('t2', 'TaskCreate', { subject: 'Second' }),
    result('t2'),
    tool('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
    tool('u2', 'TaskUpdate', { taskId: '2', status: 'in_progress' }),
    tool('a1', 'Task', { description: 'old name of the tool' }),
    tool('a2', 'Agent', {}),
    result('a2'),
    'not json',
  ]))
  assert.deepEqual(claudeTail(file), { agents: 1, task: 'Second' })
  // A newer TodoWrite list counts over the tasks, and a list without a task in progress has none.
  writeFileSync(file, `${readFileSync(file, 'utf8')}${tool('w1', 'TodoWrite', { todos: [{ content: 'All done', status: 'completed' }] })}\n`)
  assert.deepEqual(claudeTail(file), { agents: 1, task: undefined })
  // Lines that a subagent wrote into the main log are the agent's own: they count neither as an agent nor as the task.
  const side = (line) => JSON.stringify({ ...JSON.parse(line), isSidechain: true })
  writeFileSync(file, `${readFileSync(file, 'utf8')}${side(tool('s1', 'Task', { description: 'inside the agent' }))}\n${side(tool('s2', 'TodoWrite', { todos: [{ content: 'Agent work', status: 'in_progress' }] }))}\n`)
  assert.deepEqual(claudeTail(file), { agents: 1, task: undefined })
})

test('top: a Codex or Cowork session is working up to 60 seconds after its log was written to, and shown up to 30 minutes', () => {
  const m = use(machine())
  const now = Date.now()
  const folder = join(m.env.CODEX_HOME, 'sessions', '2026', '11', '14')
  mkdirSync(folder, { recursive: true })
  const at = (name, age) => {
    const file = join(folder, `rollout-${name}.jsonl`)
    writeFileSync(file, lines([JSON.stringify({ timestamp: iso(now - age), type: 'session_meta', payload: { id: name, cwd: `/work/${name}` } })]))
    utimesSync(file, (now - age) / 1000, (now - age) / 1000)
  }
  at('fresh', 59e3)
  at('quiet', 61e3)
  at('late', 30 * MIN - 2e3)
  at('gone', 30 * MIN + 2e3)
  const text = topText(now, { names: false, colors: false, env: {} })
  // A row starts with its project: the last folders of its "cwd".
  const rowOf = (name) => text.split('\n').find((l) => l.includes(`/${name} `) || l.startsWith(`${name} `))
  assert.ok(text.includes('Codex'), text)
  assert.match(rowOf('fresh') ?? '', /Codex .*working/)
  assert.match(rowOf('quiet') ?? '', /Codex .*idle \(1 min\)/)
  assert.match(rowOf('late') ?? '', /Codex .*idle \(29 min\)/)
  assert.equal(rowOf('gone'), undefined)
})

/** A stand-in for a terminal: standard input in raw mode, and standard output that keeps what is written. */
function terminal() {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true, isRaw: false, modes: [],
    setRawMode(on) {
      this.modes.push(on)
      this.isRaw = on
      return this
    },
    resume() {},
    pause() {},
  })
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 200, writes: [], write(s) { this.writes.push(String(s)) } })
  return { input, output }
}

/** Waits until a condition holds, for at most 5 seconds. */
async function until(condition) {
  for (let i = 0; i < 500 && !condition(); i++) await pause(10)
  assert.ok(condition())
}

test('top live: it says that it reads the logs, redraws, and q ends it and puts the terminal back', async () => {
  const m = computer()
  const { input, output } = terminal()
  let refreshed = 0
  const done = top({
    input, output, env: { NO_COLOR: '1' }, time: () => NOON, every: 20,
    // today.json is missing, so the view works it out first: here a little later, to see the note.
    refresh: async (o) => {
      refreshed++
      await pause(50)
      return refreshToday(o)
    },
  })
  await until(() => output.writes.filter((w) => w.includes('SESSION')).length >= 3)
  input.emit('data', 'q')
  await done
  assert.equal(refreshed, 1)
  const all = output.writes.join('')
  // The other screen of the terminal and a hidden cursor while it runs, both back at the end.
  assert.ok(output.writes[0].startsWith('\x1b[?1049h\x1b[?25l'))
  assert.ok(all.indexOf('Kestrel · reading the logs') < all.indexOf('SESSION'))
  assert.equal(output.writes.at(-1), '\x1b[?25h\x1b[?1049l')
  assert.deepEqual(input.modes, [true, false])
  assert.equal(input.listenerCount('data'), 0)
  // Each draw starts at the top of the screen and clears what is below it.
  const draw = output.writes.find((w) => w.includes('SESSION'))
  assert.ok(draw.startsWith('\x1b[H') && draw.endsWith('\x1b[J'))
  assert.ok(draw.includes(MARKER), 'names are on, so the task shows on the screen')
  noMarkerIn(m.kestrel)
})

test('top live: Ctrl+C ends it too, leaving while the logs are read ends the process, and after an error the terminal is put back', async () => {
  computer()
  await refreshToday({ now: NOON })
  let t = terminal()
  let done = top({ input: t.input, output: t.output, env: {}, time: () => NOON, every: 20 })
  await until(() => t.output.writes.some((w) => w.includes('SESSION')))
  t.input.emit('data', Buffer.from([3]))
  await done
  assert.deepEqual(t.input.modes, [true, false])

  // The person leaves while the logs are still read: the terminal is put back, then the process ends.
  rmSync(join(process.env.KESTREL_HOME, 'today.json'))
  t = terminal()
  let quit = 0
  done = top({ input: t.input, output: t.output, env: {}, time: () => NOON, refresh: () => new Promise(() => {}), quit: () => quit++ })
  await until(() => t.output.writes.some((w) => w.includes('reading the logs')))
  t.input.emit('data', 'q')
  await done
  assert.equal(quit, 1)
  assert.deepEqual(t.input.modes, [true, false])
  assert.equal(t.output.writes.at(-1), '\x1b[?25h\x1b[?1049l')

  // An error while drawing: the error comes through, and the terminal is put back first.
  await refreshToday({ now: NOON })
  t = terminal()
  const write = t.output.write
  t.output.write = function (s) {
    if (String(s).includes('SESSION')) throw new Error('the screen broke')
    write.call(this, s)
  }
  await assert.rejects(top({ input: t.input, output: t.output, env: {}, time: () => NOON }), /the screen broke/)
  assert.deepEqual(t.input.modes, [true, false])
  assert.equal(t.output.writes.at(-1), '\x1b[?25h\x1b[?1049l')
})

test('tickets: the tickets with the most tokens first, their totals, the line for calls without a ticket, and the sentence when none has one', async () => {
  computer()
  const { records } = await load({ since: NOON - 7 * 86400e3 })
  // ABC-322: a0, a1 and a2 of c1 (301,000 + 311,000 + 314,000 tokens) and b1 of c2 (55,000): 981,000
  // tokens. On Claude Opus 5.5 (in $4, 1 hour cache write $8, cache read $0.20, out $20 per
  // million): a0 $2.42, a1 $2.50, a2 $0.0982, b1 $0.30, together $5.32. ABC-7: 60,000 in at $2,
  // 40,000 from the cache at $0.20 and 10,000 out at $10 per million: $0.228. Cowork's call has
  // no branch: 100,000 in at $2 and 1,000 out at $10 per million, $0.21.
  assert.equal(tickets(records, { days: 7 }), [
    'Spend per ticket, last 7 days, list prices. A call counts to the ticket in the name of the git branch that its log names.',
    '',
    '  ticket   tokens   cost  sessions',
    '  ABC-322    981k  $5.32  2 sessions',
    '  ABC-7      110k  $0.23  1 session',
    '',
    'Without a ticket: 101k tokens, $0.21, 1 session.',
  ].join('\n'))
  assert.equal(tickets(records.filter((r) => r.s === 'cowork'), { days: 7 }), 'No model call of the last 7 days has a ticket: the ticket comes from the git branch name, so a branch named user/abc-322-the-plugin gives ABC-322.')
  assert.equal(tickets([], { days: 3 }), 'No model calls in the last 3 days.')
})

test('"kestrel tickets" prints the report, and takes --days', () => {
  const m = machine()
  writeLogs(m, Date.now())
  const r = run(m, ['tickets', '--days', '30'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^Spend per ticket, last 30 days, list prices\./)
  assert.match(r.stdout, /\n {2}ABC-322 +981k +\$5\.32 +2 sessions\n {2}ABC-7 +110k +\$0\.23 +1 session\n/)
  assert.ok(!r.stdout.includes(MARKER))
})

/** Starts "kestrel mcp" on a made-up computer, after the handshake. `call` gives a tool's result. */
async function server(env) {
  const child = spawn(process.execPath, [KESTREL, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const waiting = new Map()
  const all = []
  let rest = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    rest += chunk
    for (let i = rest.indexOf('\n'); i >= 0; i = rest.indexOf('\n')) {
      const line = rest.slice(0, i)
      rest = rest.slice(i + 1)
      all.push(line)
      const message = JSON.parse(line)
      waiting.get(message.id)?.(message)
    }
  })
  let next = 0
  const request = (method, params) => new Promise((resolve) => {
    const id = ++next
    waiting.set(id, resolve)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  const exited = new Promise((resolve) => child.on('exit', resolve))
  return {
    call: async (name, args) => (await request('tools/call', { name, ...(args === undefined ? {} : { arguments: args }) })).result,
    close: async () => {
      child.stdin.end()
      return { code: await exited, lines: all }
    },
  }
}

test('the tools whats_running and spend_by_ticket answer over the server, check "days", and whats_running holds no task even with names on', { timeout: 60e3 }, async () => {
  const m = machine()
  const now = Date.now()
  writeLogs(m, now)
  writeSessions(m, now)
  writeJson(join(m.kestrel, 'config.json'), { hud: { names: true } })
  const s = await server(m.env)

  const running = await s.call('whats_running')
  assert.equal(running.isError, false)
  const text = running.content[0].text
  assert.match(text, /^Kestrel · 4 sessions on this computer · 5 hour limit 33% used/)
  assert.match(text, /\nSESSION +TOOL +TICKET +STATE +CONTEXT +CACHE +TODAY +AGENTS\n/)
  // The tokens of today depend on the time of day the test runs at: the calls are some hours old.
  assert.match(text, /\nwork\/app +Claude +ABC-322 also in work\/web +working +313k +warm, 50 min left +(?:\S+ +)?1\n/)
  assert.match(text, /\nwork\/web +Claude +ABC-322 also in work\/app +waits for you \(12 min\)/)
  assert.match(text, /\nsessions\/calm-river +Cowork +idle \(10 min\)/)
  assert.match(text, /\nNext: work\/web waits for you, and its cache ends at \d\d:\d\d\. Answer before then, or \/compact first\.$/)
  // The numbers of today were worked out for the answer.
  assert.match(text, /\nWaste today: /)
  assert.ok(!text.includes('TASK') && !text.includes(MARKER) && !text.includes('\x1b'), text)

  const byTicket = await s.call('spend_by_ticket')
  assert.equal(byTicket.isError, false)
  assert.match(byTicket.content[0].text, /^Spend per ticket, last 7 days, list prices\./)
  assert.match(byTicket.content[0].text, /\n {2}ABC-322 +981k +\$5\.32 +2 sessions\n/)
  assert.match(byTicket.content[0].text, /\nWithout a ticket: 101k tokens, \$0\.21, 1 session\.$/)
  assert.match((await s.call('spend_by_ticket', { days: 90 })).content[0].text, /last 90 days/)
  for (const days of [0, 91, 2.5, '7']) {
    const result = await s.call('spend_by_ticket', { days })
    assert.equal(result.isError, true)
    assert.deepEqual(result.content, [{ type: 'text', text: '"days" is a whole number from 1 to 90.' }])
  }
  assert.equal((await s.call('whats_running', { days: 7 })).content[0].text, 'whats_running takes no arguments.')

  const end = await s.close()
  assert.equal(end.code, 0)
  for (const line of end.lines) assert.ok(!line.includes(MARKER), line)
  noMarkerIn(m.kestrel)
})

test('privacy: after refresh-today and top as commands, no file of the tool holds text of a session', () => {
  const m = machine()
  const now = Date.now()
  writeLogs(m, now)
  writeSessions(m, now)
  assert.equal(run(m, ['refresh-today']).status, 0)
  const r = run(m, ['top', '--once'])
  assert.equal(r.status, 0, r.stderr)
  // The view itself shows the task: names are on by default, and this is the person's own screen.
  assert.ok(r.stdout.includes(MARKER))
  noMarkerIn(m.kestrel)
})
