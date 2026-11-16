// Tests for spend and limits per account: the account of each call, the config folders of Claude
// Code, the names and labels of accounts, the plan's limits per account, "kestrel accounts", the
// status line and the desktop tool. Each test makes its own computer: a home folder with made-up
// logs of three accounts, and the folders of the tool inside it. Run: node --test
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'kestrel-accounts-test-'))
// Every folder the tool reads or writes is a made-up one, before any module of the tool is loaded.
process.env.HOME = join(dir, 'person')
process.env.USERPROFILE = process.env.HOME
process.env.KESTREL_HOME = join(dir, 'home')
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
process.env.CODEX_HOME = join(dir, 'codex')
process.env.KESTREL_COWORK_DIR = join(dir, 'cowork')
for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE', 'NO_COLOR']) delete process.env[name]

const { load, logFiles } = await import('../src/store.mjs')
const { accountInHead } = await import('../src/parse-claude.mjs')
const { claudeDirs, realPath } = await import('../src/paths.mjs')
const { refreshToday } = await import('../src/refresh-today.mjs')
const { allLimits, billing, readLimits, saveLimits } = await import('../src/billing.mjs')
const { statusLine } = await import('../src/claude-code.mjs')
const { localDay, readToday, writeToday } = await import('../src/today-file.mjs')
const { updateAccounts } = await import('../src/accounts.mjs')
const { config, saveConfig } = await import('../src/config.mjs')
const readAccountsFile = () => { try { return JSON.parse(readFileSync(join(process.env.KESTREL_HOME, 'accounts.json'), 'utf8')) } catch { return {} } }

const BIN = fileURLToPath(new URL('../cli/kestrel.mjs', import.meta.url))
const MIN = 60e3
const HOUR = 3600e3
const DAY = 86400e3
/** Noon of today, local time: calls some hours before it are all of today. */
const NOON = new Date(new Date().setHours(12, 0, 0, 0)).getTime()
const iso = (ms) => new Date(ms).toISOString()
const sec = (ms) => Math.round(ms / 1000)
// A word that the made-up logs carry in prompts and answers. No output and no file of the tool may hold it.
const MARKER = 'PELICANSECRET'

// The two Claude accounts and their organisations.
const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const ORG_A = 'oaoaoaoa-1111-4111-8111-111111111111'
const ORG_B = 'obobobob-2222-4222-8222-222222222222'

let machines = 0
/**
 * A made-up computer: a home folder with the folders of Claude Code, Codex, Cowork and the tool
 * in it. `env` is the environment for the command: nothing of the real one but the PATH.
 */
function machine() {
  const home = join(dir, `machine-${++machines}`)
  mkdirSync(home, { recursive: true })
  const m = {
    home,
    kestrel: join(home, '.kestrel'),
    claude: join(home, '.claude'),
    codex: join(home, '.codex'),
    cowork: join(home, 'cowork'),
  }
  m.env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, NO_COLOR: '1', KESTREL_HOME: m.kestrel, CODEX_HOME: m.codex, KESTREL_COWORK_DIR: m.cowork }
  return m
}

/** Makes this process use a made-up computer, for the parts of the tool that a test calls directly. */
function use(m) {
  for (const [name, value] of Object.entries(m.env)) if (name !== 'PATH' && name !== 'NO_COLOR') process.env[name] = value
  delete process.env.CLAUDE_CONFIG_DIR
  if (m.env.CLAUDE_CONFIG_DIR) process.env.CLAUDE_CONFIG_DIR = m.env.CLAUDE_CONFIG_DIR
  return m
}

/** Runs the command on a made-up computer. */
const run = (m, args, more = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...m.env, ...more } })

const write = (file, lines) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${lines.join('\n')}\n`)
}

const usage = (input, output) => ({
  input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
})
/** A call of Claude Code on Claude Opus 5.5 ($4 and $20 per million tokens in and out). The default, 100,000 in and 1,000 out, costs $0.42. */
const call = (id, ts, { input = 100000, out = 1000, cwd = '/work/app' } = {}) => JSON.stringify({
  type: 'assistant', timestamp: iso(ts), cwd, message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: MARKER }], usage: usage(input, out) },
})
const owner = (account, org) => JSON.stringify({ type: 'session-owner', accountUuid: account, organizationUuid: org, sessionId: 'x' })
const prompt = (ts) => JSON.stringify({ type: 'user', timestamp: iso(ts), message: { role: 'user', content: `Fix the notes of ${MARKER}` } })

/**
 * Made-up logs of three accounts, all of today and some hours before `now`:
 *   - Claude account A, in ~/.claude: session sA with 2 calls, and an agent's log of sA with 1
 *     call. The agent's log has no line of its own about the account.
 *   - Claude account B, in a second config folder ~/.claude-work: session sB with 1 call.
 *   - Cowork, in the account folder cw-account: 1 call on Claude Sonnet 5.5 ($2 and $10), 100,000
 *     in and 1,000 out: $0.21.
 *   - Codex: one log with the plan type "plus" (1 call), and one without a plan type (1 call),
 *     both on GPT-6 Sol ($2 and $10), 100,000 in and 10,000 out: $0.30 each.
 * Account A: 300,000 + 3,000 tokens, $1.26. Account B: 101,000 tokens, $0.42.
 * With `HOUR` set to a minute, all of it is minutes before `now`, for a test of the command.
 */
function writeLogs(m, now, HOUR = 3600e3) {
  write(join(m.claude, 'projects', '-work-app', 'sA.jsonl'), [owner(A, ORG_A), prompt(now - 3 * HOUR), call('a1', now - 3 * HOUR), owner(A, ORG_A), call('a2', now - 2 * HOUR)])
  write(join(m.claude, 'projects', '-work-app', 'sA', 'subagents', 'agent-x1.jsonl'), [call('a3', now - 2.5 * HOUR)])
  write(join(m.home, '.claude-work', 'projects', '-work-web', 'sB.jsonl'), [owner(B, ORG_B), prompt(now - HOUR), call('b1', now - HOUR, { cwd: '/work/web' })])
  const entry = (fields) => JSON.stringify({ session_id: 'engine-1', _audit_timestamp: iso(now - 4 * HOUR), ...fields })
  write(join(m.cowork, 'cw-account', 'ws-1', 'local_w1', 'audit.jsonl'), [
    entry({ type: 'system', subtype: 'init', cwd: '/sessions/calm-river' }),
    entry({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: `Write about ${MARKER}` } }),
    entry({ type: 'assistant', parent_tool_use_id: null, message: { id: 'w1', model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'text', text: MARKER }], usage: { input_tokens: 100000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1000 } } }),
  ])
  const codex = (name, id, plan) => {
    const event = (type, payload) => JSON.stringify({ timestamp: iso(now - 5 * HOUR), type, payload })
    write(join(m.codex, 'sessions', '2026', '11', '14', `rollout-${name}.jsonl`), [
      event('session_meta', { session_id: name, cwd: '/work/api' }),
      event('turn_context', { model: 'gpt-6-sol', effort: 'medium', cwd: '/work/api' }),
      event('token_usage_record', { response_id: id, usage: { input_tokens: 100000, cached_input_tokens: 0, output_tokens: 10000, reasoning_output_tokens: 0 } }),
      event('event_msg', { type: 'token_count', rate_limits: { plan_type: plan, primary: { used_percent: 5 } } }),
    ])
  }
  codex('x1', 'r1', 'plus')
  codex('x2', 'r2', null)
}

/** The account of each call, by the id of the call. */
const accountsOf = (records) => Object.fromEntries(records.map((r) => [r.id, r.acct]))

test('each call gets the account of its log: Claude Code from the session-owner line, an agent from its session, Cowork from its folder, Codex from its plan type', async () => {
  const m = use(machine())
  const now = Date.now()
  writeLogs(m, now)
  const { records, metas } = await load({ since: now - DAY })
  assert.deepEqual(accountsOf(records), {
    a1: `claude:${A}`, a2: `claude:${A}`, a3: `claude:${A}`, b1: `claude:${B}`,
    w1: 'cowork:cw-account', r1: 'codex:plus', r2: 'codex:unknown',
  })
  // The organisation of each account is kept next to the calls, also for the agent's log.
  const orgs = Object.assign({}, ...[...metas.values()].map((meta) => meta.orgs ?? {}))
  assert.deepEqual(orgs, { [`claude:${A}`]: ORG_A, [`claude:${B}`]: ORG_B })
})

test('a log without the session-owner line is "unknown", a cloud provider\'s answers are "cloud", and a change of account in a log counts from the line on', async () => {
  const m = use(machine())
  const now = Date.now()
  const projects = join(m.claude, 'projects', '-work-app')
  write(join(projects, 'old.jsonl'), [prompt(now - HOUR), call('u1', now - HOUR)])
  write(join(projects, 'old', 'subagents', 'agent-u.jsonl'), [call('u2', now - HOUR)])
  const bedrock = (id, ts) => call(id, ts).replace(`"id":"${id}"`, `"id":"msg_bdrk_${id}"`)
  write(join(projects, 'bedrock.jsonl'), [prompt(now - HOUR), bedrock('c1', now - HOUR)])
  // A call before the first line counts to the first account. After a sign-in with another
  // account, the calls count to that one.
  write(join(projects, 'switch.jsonl'), [call('s1', now - 50 * MIN), owner(A, ORG_A), call('s2', now - 40 * MIN), owner(B, ORG_B), call('s3', now - 30 * MIN)])
  // An id that is not a plain id is not taken.
  write(join(projects, 'odd.jsonl'), [JSON.stringify({ type: 'session-owner', accountUuid: '../../etc', organizationUuid: 7 }), call('o1', now - HOUR)])
  const { records } = await load({ since: now - DAY })
  assert.deepEqual(accountsOf(records), {
    u1: 'unknown', u2: 'unknown', msg_bdrk_c1: 'cloud',
    s1: `claude:${A}`, s2: `claude:${A}`, s3: `claude:${B}`, o1: 'unknown',
  })
})

test('the start of a log gives its account: only the first 8 KB are read, and a short log without the line can still get it', () => {
  const m = machine()
  const file = join(m.claude, 'projects', '-p', 'head.jsonl')
  write(file, [owner(A, ORG_A), call('h1', Date.now())])
  assert.deepEqual(accountInHead(file), { key: `claude:${A}`, orgId: ORG_A, complete: true })
  // The line after the first 8 KB is not seen. Such a log stays "unknown".
  write(file, [prompt(Date.now()).replace(MARKER, 'x'.repeat(9000)), owner(A, ORG_A)])
  assert.deepEqual(accountInHead(file), { key: 'unknown', complete: true })
  // A short log without the line: a later look can still find it.
  write(file, [prompt(Date.now())])
  assert.deepEqual(accountInHead(file), { key: 'unknown', complete: false })
  assert.deepEqual(accountInHead(join(m.claude, 'no-such.jsonl')), { key: undefined, complete: false })
})

test('the logs of every config folder are read: CLAUDE_CONFIG_DIR, ~/.claude, ~/.claude-* with a projects folder, and the setting claudeDirs, each folder once', async () => {
  const m = machine()
  const now = Date.now()
  const log = (folder, name, id) => write(join(folder, 'projects', '-p', `${name}.jsonl`), [owner(A, ORG_A), call(id, now - HOUR)])
  log(m.claude, 'one', 'k1')
  log(join(m.home, '.claude-work'), 'two', 'k2')
  log(join(m.home, 'elsewhere'), 'three', 'k3')
  log(join(m.home, 'named-by-env'), 'four', 'k4')
  // A folder without projects, and a file, are not config folders.
  mkdirSync(join(m.home, '.claude-empty'))
  writeFileSync(join(m.home, '.claude.json'), '{}')
  // The same folders again through links, and in the setting.
  symlinkSync(m.claude, join(m.home, '.claude-link'))
  symlinkSync(join(m.home, 'elsewhere'), join(m.home, 'elsewhere-link'))
  mkdirSync(m.kestrel, { recursive: true })
  writeFileSync(join(m.kestrel, 'config.json'), JSON.stringify({ claudeDirs: ['~/elsewhere', join(m.home, 'elsewhere-link'), '~/.claude'] }))
  m.env.CLAUDE_CONFIG_DIR = join(m.home, 'named-by-env')
  use(m)
  assert.deepEqual(claudeDirs({ more: ['~/elsewhere', join(m.home, 'elsewhere-link')] }), [join(m.home, 'named-by-env'), m.claude, join(m.home, '.claude-work'), join(m.home, 'elsewhere')])
  const files = logFiles(['claude']).map((f) => f.file).sort()
  assert.deepEqual(files, [
    join(m.home, '.claude-work', 'projects', '-p', 'two.jsonl'),
    join(m.claude, 'projects', '-p', 'one.jsonl'),
    join(m.home, 'elsewhere', 'projects', '-p', 'three.jsonl'),
    join(m.home, 'named-by-env', 'projects', '-p', 'four.jsonl'),
  ].sort())
  const { records } = await load({ since: now - DAY })
  assert.deepEqual(records.map((r) => r.id).sort(), ['k1', 'k2', 'k3', 'k4'])
  // Without CLAUDE_CONFIG_DIR, ~/.claude is still read.
  delete m.env.CLAUDE_CONFIG_DIR
  use(m)
  assert.equal(logFiles(['claude']).length, 3)
})

// Words in the fields of .claude.json that must never be stored or printed.
const EMAIL = 'heronmail@example.com'
const PERSONAL = ['heronmail', 'HERONFULL', 'HERONDISPLAY']
/** A made-up .claude.json, as Claude Code writes it, with the person's email address and names in it. */
function claudeJson(file, account, org, orgName, more = {}) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({
    numStartups: 7,
    projects: { '/work/app': { allowedTools: [] } },
    oauthAccount: {
      accountUuid: account, organizationUuid: org, organizationName: orgName, emailAddress: EMAIL, fullName: 'HERONFULL Person', displayName: 'HERONDISPLAY',
      billingType: 'stripe_subscription', seatTier: 'team_tier_1', organizationType: 'claude_team', organizationRateLimitTier: 'default_raven', userRateLimitTier: 'default_claude_max_5x',
      ...more,
    },
  }))
}

/** What accounts.json holds. */
const accountsJson = (m) => JSON.parse(readFileSync(join(m.kestrel, 'accounts.json'), 'utf8'))

/** Every file below a folder, as text. */
const filesText = (folder) => readdirSync(folder, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name), 'utf8')).join('\n')

test('accounts.json learns the name of the account signed in now, keeps it after another account signs in, and holds no email, full name or display name', async () => {
  const m = use(machine())
  writeLogs(m, NOON)
  claudeJson(join(m.home, '.claude.json'), A, ORG_A, 'Widal, Inc.')
  assert.equal(await refreshToday({ now: NOON }), true)
  let saved = accountsJson(m)
  assert.deepEqual(saved.accounts[`claude:${A}`], {
    org: 'Widal, Inc.', orgId: ORG_A, billingType: 'stripe_subscription', seatTier: 'team_tier_1', organizationType: 'claude_team',
    firstSeen: NOON - 3 * HOUR, lastSeen: NOON - 2 * HOUR,
  })
  // The account in the second config folder is known from its logs, with its organisation id.
  assert.deepEqual(saved.accounts[`claude:${B}`], { orgId: ORG_B, firstSeen: NOON - HOUR, lastSeen: NOON - HOUR })
  assert.deepEqual(Object.keys(saved.accounts).sort(), [`claude:${A}`, `claude:${B}`, 'codex:plus', 'codex:unknown', 'cowork:cw-account'])
  assert.deepEqual(saved.signedIn, { [realPath(m.claude)]: `claude:${A}` })

  // Another account signs in, in ~/.claude and in the second config folder. Account A keeps its name.
  claudeJson(join(m.home, '.claude.json'), B, ORG_B, 'Second Org', { seatTier: 'max' })
  claudeJson(join(m.home, '.claude-work', '.claude.json'), A, ORG_A, 'Widal, Inc.')
  assert.equal(await refreshToday({ now: NOON + MIN }), true)
  saved = accountsJson(m)
  assert.equal(saved.accounts[`claude:${A}`].org, 'Widal, Inc.')
  assert.equal(saved.accounts[`claude:${B}`].org, 'Second Org')
  assert.equal(saved.accounts[`claude:${B}`].seatTier, 'max')
  assert.deepEqual(saved.signedIn, { [realPath(m.claude)]: `claude:${B}`, [realPath(join(m.home, '.claude-work'))]: `claude:${A}` })

  // Claude names a personal organisation after its person. Such a name is not kept.
  for (const orgName of [`${EMAIL}'s Organization`, "HERONFULL Person's Organization", "heronmail's Organization", 'HERONDISPLAY']) {
    claudeJson(join(m.home, '.claude.json'), 'cccccccc-3333-4333-8333-333333333333', ORG_B, orgName)
    run(m, ['status'])
    assert.equal(accountsJson(m).accounts['claude:cccccccc-3333-4333-8333-333333333333'].org, undefined, orgName)
  }
  const all = filesText(m.kestrel)
  for (const word of [...PERSONAL, MARKER, 'default_raven', 'numStartups', 'allowedTools']) assert.ok(!all.includes(word), word)
})

test('labels: set by the whole key or its short form, taken away with --clear, and a wrong or unclear key gets one plain sentence', async () => {
  const m = use(machine())
  writeLogs(m, NOON)
  // A Cowork account folder with the id of Claude account A: the start of the id fits both.
  write(join(m.cowork, A, 'ws-2', 'local_w2', 'audit.jsonl'), [JSON.stringify({ type: 'assistant', _audit_timestamp: iso(NOON - HOUR), message: { id: 'w2', model: 'claude-sonnet-5-5', content: [], usage: usage(1000, 10) } })])
  claudeJson(join(m.home, '.claude.json'), A, ORG_A, 'Widal, Inc.')
  await refreshToday({ now: NOON })
  const label = (...args) => {
    const r = run(m, ['accounts', 'label', ...args])
    return [r.status, (r.stdout + r.stderr).trim()]
  }
  assert.deepEqual(label(`claude:${A}`, 'Work'), [0, 'The account claude:aaaaaaaa is now called "Work".'])
  assert.equal(accountsJson(m).accounts[`claude:${A}`].label, 'Work')
  assert.deepEqual(label('claude:aaaaaaaa', 'Work, the big one'), [0, 'The account claude:aaaaaaaa is now called "Work, the big one".'])
  assert.deepEqual(label('bbbbbbbb', 'Home'), [0, 'The account claude:bbbbbbbb is now called "Home".'])
  assert.deepEqual(label('plus', 'ChatGPT'), [0, 'The account codex:plus is now called "ChatGPT".'])
  assert.deepEqual(label('aaaaaaaa', 'Both'), [1, 'kestrel: "aaaaaaaa" fits more than one account: claude:aaaaaaaa, cowork:aaaaaaaa. Give more of the key.'])
  assert.deepEqual(label('zzzz', 'None'), [1, 'kestrel: There is no account "zzzz". The accounts are: claude:aaaaaaaa, claude:bbbbbbbb, codex:plus, codex:unknown, cowork:aaaaaaaa, cowork:cw-accou.'])
  assert.deepEqual(label('bbbbbbbb', 'x'.repeat(61)), [1, 'kestrel: A label has 1 to 60 characters.'])
  assert.deepEqual(label('bbbbbbbb', '   '), [1, 'kestrel: A label has 1 to 60 characters.'])
  assert.match(label('bbbbbbbb')[1], /^kestrel: Use "kestrel accounts label <key>/)
  assert.match(label('bbbbbbbb', 'Home', '--clear')[1], /^kestrel: Use "kestrel accounts label <key>/)
  // Without a label, the organisation's name shows, else the short key.
  assert.deepEqual(label('claude:aaaaaaaa', '--clear'), [0, 'The account claude:aaaaaaaa has no label now. It shows as "Widal, Inc.".'])
  assert.deepEqual(label('bbbbbbbb', '--clear'), [0, 'The account claude:bbbbbbbb has no label now. It shows as "claude:bbbbbbbb".'])
  assert.equal(accountsJson(m).accounts[`claude:${A}`].label, undefined)
  // A Cowork account in the folder of a Claude account takes that account's name.
  assert.deepEqual(label(`cowork:${A}`, '--clear'), [0, 'The account cowork:aaaaaaaa has no label now. It shows as "Widal, Inc.".'])
  // With no account known yet.
  const empty = machine()
  assert.deepEqual([run(empty, ['accounts', 'label', 'x', 'y']).status, run(empty, ['accounts', 'label', 'x', 'y']).stderr.trim()], [1, 'kestrel: Kestrel knows no account yet. Run "kestrel accounts" first.'])
})

/** What the status line keeps about one session. */
const kept = (m, id) => JSON.parse(readFileSync(join(m.kestrel, 'sessions', `${id}.json`), 'utf8'))
/** What Claude Code gives the status line of a session, with a reading of the week when `week` is a percent. */
const given = (id, path, { week, resets = NOON + 3 * DAY, api } = {}) => ({
  session_id: id, transcript_path: path, cwd: '/work/app', model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  cost: { total_cost_usd: 1, total_duration_ms: HOUR, ...(api === undefined ? {} : { total_api_duration_ms: api }) },
  ...(week === undefined ? {} : { rate_limits: { seven_day: { used_percentage: week, resets_at: sec(resets) } } }),
})
/** The status line in one line, without colours, with an empty environment and no notification. */
const oneLine = (input, now = NOON, env = {}) => statusLine(input, now, { env, color: false, layout: 'one', notify: () => {}, spawn: () => ({ unref() {} }) })
/** The logs of a session of account A and one of account B. */
function twoSessions(m) {
  const logA = join(m.claude, 'projects', '-work-app', 'sA.jsonl')
  const logB = join(m.home, '.claude-work', 'projects', '-work-web', 'sB.jsonl')
  write(logA, [owner(A, ORG_A), call('a1', NOON - HOUR)])
  write(logB, [owner(B, ORG_B), call('b1', NOON - HOUR)])
  return { logA, logB }
}

test('the plan\'s limits per account: two sessions of two accounts each save and show their own week, and keep their account in their file', () => {
  const m = use(machine())
  const { logA, logB } = twoSessions(m)
  assert.equal(oneLine(given('sA', logA, { week: 9 })), 'week 9% used, 57% of the week gone')
  assert.match(oneLine(given('sB', logB, { week: 70 })), /^week 70% used, 57% of the week gone: full about/)
  assert.equal(kept(m, 'sA').account, `claude:${A}`)
  assert.equal(kept(m, 'sB').account, `claude:${B}`)
  // A run without a reading of its own shows the reading of its own account, not the newest of the computer.
  assert.match(oneLine(given('sA', logA), NOON + MIN), /^week 9% used/)
  assert.match(oneLine(given('sB', logB), NOON + MIN), /^week 70% used/)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(m.kestrel, 'limits.json'), 'utf8'))).sort(), [`claude:${A}`, `claude:${B}`])
  assert.equal(readLimits(NOW_ANY, `claude:${A}`).week.pct, 9)
  // The 24 hour rule of the billing mode holds per account: a session of an account that was
  // never seen with limits does not count as a subscription because of another account's reading.
  const C = 'cccccccc-3333-4333-8333-333333333333'
  const logC = join(m.claude, 'projects', '-work-app', 'sC.jsonl')
  write(logC, [owner(C, ORG_A), call('c1', NOON - HOUR)])
  assert.match(oneLine(given('sC', logC), NOON + MIN), /^\$1\.00 session, \$1\.00 per hour \(list prices\) \|/)
  assert.deepEqual(billing({}, { env: {}, cfg: {}, now: NOON, account: `claude:${C}` }).mode, 'usage')
  // Outside a session, the reading of any account counts.
  assert.deepEqual(billing({}, { env: {}, cfg: {}, now: NOON }).mode, 'subscription')
})

// Any time between the readings and their ends.
const NOW_ANY = NOON + HOUR

test('the plan\'s limits per account: a fresh reading wins only within its own account, and the old file shape is read as "unknown" and rewritten', () => {
  const m = use(machine())
  const { logA, logB } = twoSessions(m)
  const logA2 = join(m.claude, 'projects', '-work-app', 'sA2.jsonl')
  write(logA2, [owner(A, ORG_A), call('a9', NOON - HOUR)])
  oneLine(given('sA', logA, { week: 9, api: 1000 }))
  oneLine(given('sB', logB, { week: 70, api: 1000 }))
  // A second session of account A has just made a call: its reading of a week that ends earlier
  // is true now, for account A. Account B keeps its own.
  oneLine(given('sA2', logA2, { week: 1, api: 1000 }), NOON + MIN)
  oneLine(given('sA2', logA2, { week: 2, resets: NOON + 2 * DAY, api: 2000 }), NOON + 2 * MIN)
  assert.deepEqual(readLimits(NOW_ANY, `claude:${A}`).week, { pct: 2, resetsAt: NOON + 2 * DAY, at: NOON + 2 * MIN })
  assert.deepEqual(readLimits(NOW_ANY, `claude:${B}`).week, { pct: 70, resetsAt: NOON + 3 * DAY, at: NOON })
  // A fresh reading of account B does not touch account A.
  oneLine(given('sB', logB, { week: 71, resets: NOON + DAY, api: 2000 }), NOON + 3 * MIN)
  assert.equal(readLimits(NOW_ANY, `claude:${A}`).week.pct, 2)
  assert.equal(readLimits(NOW_ANY, `claude:${B}`).week.pct, 71)

  // A file from before: one reading for the whole computer. It is the reading of "unknown".
  const file = join(m.kestrel, 'limits.json')
  writeFileSync(file, JSON.stringify({ week: { pct: 40, resetsAt: NOON + 2 * DAY, at: NOON - MIN } }))
  assert.deepEqual(readLimits(NOW_ANY), { week: { pct: 40, resetsAt: NOON + 2 * DAY, at: NOON - MIN } })
  assert.deepEqual(readLimits(NOW_ANY, `claude:${A}`), {})
  assert.deepEqual([...allLimits(NOW_ANY).keys()], ['unknown'])
  // A session of an unknown account, such as one of an older Claude Code, still shows it.
  assert.match(oneLine(given('old', join(m.home, 'no-log.jsonl'))), /^week 40% used/)
  // The next save writes the new shape, with the old reading as that of "unknown".
  saveLimits({ seven_day: { used_percentage: 5, resets_at: sec(NOON + 3 * DAY) } }, NOON, { account: `claude:${A}` })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    unknown: { week: { pct: 40, resetsAt: NOON + 2 * DAY, at: NOON - MIN } },
    [`claude:${A}`]: { week: { pct: 5, resetsAt: NOON + 3 * DAY, at: NOON } },
  })
})

/** Counts how often a file is opened while `work` runs. */
function opensOf(file, work) {
  const real = fs.openSync
  let opens = 0
  fs.openSync = (path, ...rest) => {
    if (path === file) opens++
    return real(path, ...rest)
  }
  syncBuiltinESMExports()
  try {
    work()
  } finally {
    fs.openSync = real
    syncBuiltinESMExports()
  }
  return opens
}

test('the status line reads the first 8 KB of the session\'s log once, and then takes the account from the session\'s file', async () => {
  const m = use(machine())
  const { logA } = twoSessions(m)
  assert.equal(opensOf(logA, () => {
    for (const at of [0, 1, 2]) oneLine(given('sA', logA, { week: 9 }), NOON + at * MIN)
  }), 1)
  assert.equal(kept(m, 'sA').account, `claude:${A}`)
  // The log changes or goes: the account stays the one in the file.
  write(logA, [owner(B, ORG_B)])
  oneLine(given('sA', logA), NOON + 3 * MIN)
  rmSync(logA)
  oneLine(given('sA', logA), NOON + 4 * MIN)
  assert.equal(kept(m, 'sA').account, `claude:${A}`)

  // A log of 8 KB or more without the line is "unknown", or "api" with an API key in the environment.
  const big = join(m.claude, 'projects', '-p', 'big.jsonl')
  write(big, [prompt(NOON).replace(MARKER, 'x'.repeat(9000)), owner(A, ORG_A)])
  oneLine(given('big', big))
  assert.equal(kept(m, 'big').account, 'unknown')
  oneLine(given('keyed', big), NOON, { ANTHROPIC_API_KEY: 'a-key' })
  assert.equal(kept(m, 'keyed').account, 'api')
  oneLine(given('bedrock', big), NOON, { CLAUDE_CODE_USE_BEDROCK: '1' })
  assert.equal(kept(m, 'bedrock').account, 'cloud')

  // A log that is not there yet: nothing is kept, and the session counts to the account signed in
  // now in this config folder. Its reading is shown.
  claudeJson(join(m.home, '.claude.json'), A, ORG_A, 'Widal, Inc.')
  await refreshToday({ now: NOON })
  const later = join(m.claude, 'projects', '-work-app', 'later.jsonl')
  assert.match(oneLine(given('later', later), NOON + MIN), /^week 9% used/)
  assert.equal(kept(m, 'later').account, undefined)
  // Once the log is there with its line, the account is kept. The limits still are those of the
  // account signed in now in this config folder: Claude Code hands the status line that account's.
  write(later, [owner(B, ORG_B), call('l1', NOON)])
  assert.match(oneLine(given('later', later), NOON + 2 * MIN), /^week 9% used/)
  assert.equal(kept(m, 'later').account, `claude:${B}`)
})

test('"kestrel status" lists the last reading of each account, with its name', async () => {
  const m = use(machine())
  const { logA, logB } = twoSessions(m)
  const now = Date.now()
  oneLine(given('sA', logA, { week: 9, resets: now + 3 * DAY }), now)
  oneLine(given('sB', logB, { week: 70, resets: now + 3 * DAY }), now)
  // A reading of a window that has ended.
  saveLimits({ five_hour: { used_percentage: 50, resets_at: sec(now + 30e3) } }, now, { account: 'unknown' })
  claudeJson(join(m.home, '.claude.json'), A, ORG_A, 'Widal, Inc.')
  const r = run(m, ['status'], { TZ: 'UTC' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^Plan limits of Widal, Inc\. +week 9% used, 57% of the week gone$/m)
  assert.match(r.stdout, /^Plan limits of claude:bbbbbbbb +week 70% used, 57% of the week gone: full about [\d.]+ days? early$/m)
  assert.match(r.stdout, /^Plan limits of unknown +(5 hour limit 50% used|no window that is open now \(the last reading is from \d{4}-\d\d-\d\d \d\d:\d\d\))/m)
  for (const word of [...PERSONAL, MARKER]) assert.ok(!r.stdout.includes(word), word)
})

/** Whether the made-up calls of the last `minutes` minutes are all of today, so that the numbers of today can be checked. */
const allToday = (now, minutes) => new Date(now - minutes * MIN).toDateString() === new Date(now).toDateString()

test('"kestrel accounts" shows one row per account, the newest first, with its short key, kind, plan, limits and spend, and --json has the shape that the pane reads', () => {
  const m = machine()
  const now = Date.now()
  writeLogs(m, now, MIN)
  claudeJson(join(m.home, '.claude.json'), A, ORG_A, 'Widal, Inc.')
  mkdirSync(m.kestrel, { recursive: true })
  writeFileSync(join(m.kestrel, 'limits.json'), JSON.stringify({ [`claude:${A}`]: { week: { pct: 9, resetsAt: now + 3 * DAY, at: now - MIN }, five: { pct: 33, resetsAt: now + 2 * HOUR, at: now - MIN } } }))
  const r = run(m, ['accounts'])
  assert.equal(r.status, 0, r.stderr)
  const text = r.stdout
  assert.match(text, /^Accounts, last 7 days, the newest first\./)
  assert.match(text, /\n {2}account +tool +kind and plan +plan's limits +tokens today +dollars today +tokens +dollars +dollars are +sessions +last seen\n/)
  const rowOf = (label) => text.split('\n').find((line) => line.startsWith(`  ${label} `))
  const today = allToday(now, 6)
  assert.match(rowOf('claude:bbbbbbbb'), /^ {2}claude:bbbbbbbb +Claude Code +unknown +none seen +101k +\$0\.42 +101k +\$0\.42 +list prices +1 +\d{4}-\d\d-\d\d \d\d:\d\d$/)
  assert.match(rowOf('Widal, Inc.'), today
    ? /^ {2}Widal, Inc\. +Claude Code +subscription, team_tier_1 +week 9%; 5h 33% +303k +\$1\.26 +303k +\$1\.26 +API value +1 +\d{4}/
    : /^ {2}Widal, Inc\. +Claude Code +subscription, team_tier_1 +week 9%; 5h 33% +/)
  assert.match(text, /\n {2}Widal, Inc\. .+\n {4}claude:aaaaaaaa \(signed in now\)\n/)
  assert.match(rowOf('cowork:cw-accou'), /^ {2}cowork:cw-accou +Cowork +subscription +101k +\$0\.21 +101k +\$0\.21 +API value +1 /)
  assert.match(rowOf('codex:plus'), /^ {2}codex:plus +Codex +subscription, plus +110k +\$0\.30 +110k +\$0\.30 +API value +1 /)
  assert.match(rowOf('codex:unknown'), /^ {2}codex:unknown +Codex +unknown +110k +\$0\.30 +110k +\$0\.30 +list prices +1 /)
  // The newest first: B, then A, then Cowork, then Codex.
  const order = ['claude:bbbbbbbb', 'Widal, Inc.', 'cowork:cw-accou', 'codex:'].map((label) => text.indexOf(`\n  ${label}`))
  assert.deepEqual([...order].sort((x, y) => x - y), order)
  assert.ok(!text.includes('Kestrel found one account'))
  // On a subscription the dollars are API value. Accounts whose way to pay is not known stand apart.
  assert.match(text, /\nOn subscriptions: \$1\.77 of API value \(what the same use would cost by the token\)\nNot known how it is paid: \$0\.72 at list prices\n/)
  assert.doesNotMatch(text, /spend for this|Spend:/)
  // The plans, with the limits first, and the line that says how to set a price.
  assert.match(text, /\nPlans\n {2}Widal, Inc\. \(claude:aaaaaaaa\): team_tier_1\n {4}Limits now: week 9% used, \d+% of the week gone; 5 hour limit 33% used, \d+% of its time gone\n {4}API value in 7 days: \$1\.26\. Price not set: kestrel accounts price claude:aaaaaaaa <dollars>\n/)
  assert.match(text, /\n {2}codex:plus: ChatGPT Plus, \$20 a month \(the plan's public price\)\n {4}API value in 7 days: \$0\.30\. The plan's price for 7 days: \$4\.67\. That is 0\.1 times the plan's price\.\n/)
  assert.match(text, /\nGive an account your own name with: kestrel accounts label <key> "<label>"\nSet the price of an account's plan with: kestrel accounts price <key> <dollars a month>\n$/)

  const json = run(m, ['accounts', '--json'])
  assert.equal(json.status, 0, json.stderr)
  const data = JSON.parse(json.stdout)
  assert.deepEqual(Object.keys(data), ['days', 'current', 'accounts'])
  assert.equal(data.days, 7)
  assert.equal(data.current, `claude:${A}`)
  assert.deepEqual(data.accounts.map((a) => a.key).slice(0, 3), [`claude:${B}`, `claude:${A}`, 'cowork:cw-account'])
  for (const a of data.accounts) {
    assert.deepEqual(Object.keys(a), ['key', 'label', 'kind', 'tool', 'plan', 'limits', 'today', 'period', 'lastSeen', 'price', 'dollars'])
    assert.ok(['API value', 'spend', 'list prices'].includes(a.dollars), a.dollars)
    assert.ok(['subscription', 'usage', 'cloud', 'unknown'].includes(a.kind), a.kind)
    assert.ok(['Claude Code', 'Cowork', 'Codex'].includes(a.tool), a.tool)
    assert.deepEqual(Object.keys(a.limits), ['five', 'week'])
    assert.deepEqual(Object.keys(a.today), ['tokens', 'cost'])
    assert.deepEqual(Object.keys(a.period), ['tokens', 'cost', 'sessions'])
    assert.ok(Number.isFinite(a.lastSeen))
  }
  const a = data.accounts[1]
  assert.deepEqual({ ...a, lastSeen: undefined, today: undefined }, {
    key: `claude:${A}`, label: 'Widal, Inc.', kind: 'subscription', tool: 'Claude Code', plan: 'team_tier_1',
    limits: { five: { pct: 33, resetsAt: now + 2 * HOUR, at: now - MIN }, week: { pct: 9, resetsAt: now + 3 * DAY, at: now - MIN } },
    today: undefined, period: { tokens: 303000, cost: 1.26, sessions: 1 }, lastSeen: undefined, price: null, dollars: 'API value',
  })
  assert.deepEqual(data.accounts.find((x) => x.key === 'codex:plus').price, { monthly: 20, source: 'table' })
  assert.equal(a.lastSeen, now - 2 * MIN)
  if (today) assert.deepEqual(a.today, { tokens: 303000, cost: 1.26 })
  assert.deepEqual(data.accounts.find((x) => x.key === 'codex:unknown'), { ...data.accounts.find((x) => x.key === 'codex:unknown'), kind: 'unknown', plan: null, limits: { five: null, week: null } })
  for (const word of [...PERSONAL, MARKER]) assert.ok(!json.stdout.includes(word) && !text.includes(word), word)
  // A label shows in both, and --days changes the period.
  assert.equal(run(m, ['accounts', 'label', 'bbbbbbbb', 'Home']).status, 0)
  assert.match(run(m, ['accounts']).stdout, /\n {2}Home +Claude Code .+\n {4}claude:bbbbbbbb\n/)
  assert.equal(JSON.parse(run(m, ['accounts', '--json', '--days', '30']).stdout).accounts[0].label, 'Home')
  assert.equal(JSON.parse(run(m, ['accounts', '--json', '--days', '30']).stdout).days, 30)
  assert.equal(run(m, ['accounts', '--days', '0']).stderr, 'kestrel: --days is a whole number of days, 1 or more.\n')
  assert.equal(run(m, ['accounts', 'more']).stderr, 'kestrel: "kestrel accounts" takes --days, --json, label or price, and "more" was given.\n')
})

test('"kestrel accounts price" sets the price of a plan, wins over the table, is shared by Cowork, and --clear takes it away', async () => {
  const m = use(machine())
  const now = Date.now()
  writeLogs(m, now, MIN)
  // Account A on Claude Max: the table knows its price.
  claudeJson(join(m.home, '.claude.json'), A, ORG_A, 'Acme', { organizationType: 'claude_max', seatTier: undefined })
  mkdirSync(m.kestrel, { recursive: true })
  writeFileSync(join(m.kestrel, 'limits.json'), JSON.stringify({ [`claude:${A}`]: { week: { pct: 40, resetsAt: now + 3 * DAY, at: now - MIN } } }))
  const price = (...args) => {
    const r = run(m, ['accounts', 'price', ...args])
    return [r.status, (r.stdout + r.stderr).trim()]
  }
  const planOfA = () => {
    const text = run(m, ['accounts']).stdout
    return text.slice(text.indexOf('\nPlans\n')).split('\n').slice(2, 5).join('\n')
  }
  assert.equal(run(m, ['accounts']).status, 0)
  assert.match(planOfA(), /^ {2}Acme \(claude:aaaaaaaa\): Claude Max, \$100 a month \(the plan's public price\)\n {4}Limits now: week 40% used, 57% of the week gone(: full about [\d.]+ days? early)?\n {4}API value in 7 days: \$1\.26\. The plan's price for 7 days: \$23\.33\. That is 0\.1 times the plan's price\.$/)
  // The person's own price wins.
  assert.deepEqual(price('aaaaaaaa', '80'), [0, 'The plan of the account claude:aaaaaaaa costs $80 a month now.'])
  assert.equal(accountsJson(m).accounts[`claude:${A}`].price, 80)
  assert.match(planOfA(), /^ {2}Acme \(claude:aaaaaaaa\): Claude Max, \$80 a month \(your price\)\n/)
  assert.match(planOfA(), /The plan's price for 7 days: \$18\.67\./)
  assert.deepEqual(price(`claude:${A}`, '$19.99'), [0, 'The plan of the account claude:aaaaaaaa costs $19.99 a month now.'])
  // A team seat has no price in the table, and gets one of the person's own.
  assert.deepEqual(price('bbbbbbbb', '30'), [0, 'The plan of the account claude:bbbbbbbb costs $30 a month now.'])
  const { planPrice } = await import('../src/plans.mjs')
  const { readAccounts } = await import('../src/accounts.mjs')
  assert.deepEqual(planPrice(`claude:${B}`, readAccounts()), { monthly: 30, source: 'set' })
  // A Cowork account with A's id runs on A's plan, and has its price.
  assert.deepEqual(planPrice(`cowork:${A}`, readAccounts()), { monthly: 19.99, source: 'set' })
  // Wrong prices and words change nothing.
  for (const bad of ['-5', 'abc', '100001', '1e3', '12.345', '']) assert.deepEqual(price('aaaaaaaa', bad), [1, 'kestrel: A price is a number of dollars a month from 0 to 100,000, such as 100 or 19.99.'], bad)
  assert.match(price('aaaaaaaa')[1], /^kestrel: Use "kestrel accounts price <key> <dollars a month>"/)
  assert.match(price('aaaaaaaa', '5', '--clear')[1], /^kestrel: Use "kestrel accounts price <key>/)
  assert.match(price('zzzz', '5')[1], /^kestrel: There is no account "zzzz"\./)
  assert.equal(accountsJson(m).accounts[`claude:${A}`].price, 19.99)
  // --clear: the table's price is back.
  assert.deepEqual(price('aaaaaaaa', '--clear'), [0, 'The account claude:aaaaaaaa has no price of yours now.'])
  assert.equal(accountsJson(m).accounts[`claude:${A}`].price, undefined)
  assert.match(planOfA(), /\$100 a month \(the plan's public price\)/)
  // A price that the file holds in a wrong shape is not used.
  const file = join(m.kestrel, 'accounts.json')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  saved.accounts[`claude:${A}`].price = 'a lot'
  writeFileSync(file, JSON.stringify(saved))
  assert.deepEqual(planPrice(`claude:${A}`, readAccounts()), { monthly: 100, source: 'table' })
})

test('the words for the dollars: spend by the token, API value on a subscription, and both apart when a period mixes them', async () => {
  const { paidLines, payingOf, DOLLARS } = await import('../src/plans.mjs')
  assert.deepEqual(paidLines({ token: 12.5, subscription: 0, unknown: 0 }), ['Spend: $12.50, paid by the token, at list prices.'])
  assert.deepEqual(paidLines({ token: 0, subscription: 412.3, unknown: 0 }), ["On subscriptions: $412 of API value. That is what the same use would cost by the token. You pay your plan's price, not this."])
  assert.deepEqual(paidLines({ token: 12.5, subscription: 412.3, unknown: 0 }), ['Paid by the token: $12.50 (spend, at list prices)', 'On subscriptions: $412 of API value (what the same use would cost by the token)'])
  assert.match(paidLines({ token: 0, subscription: 0, unknown: 3 })[0], /^\$3\.00 at list prices\. Kestrel does not know how this is paid\./)
  assert.deepEqual(paidLines({ token: 0, subscription: 0, unknown: 0 }), [])
  // How each kind of account pays.
  const state = { accounts: new Map([['claude:x', { organizationType: 'claude_pro' }], ['claude:y', {}]]), signedIn: new Map() }
  const none = new Map()
  const pay = (key, cfg = {}, stored = none) => payingOf(key, state, { stored, cfg })
  assert.equal(pay('api'), 'token')
  assert.equal(pay('cloud'), 'token')
  assert.equal(pay('claude:x'), 'subscription')
  assert.equal(pay('cowork:x'), 'subscription')
  assert.equal(pay('codex:plus'), 'subscription')
  assert.equal(pay('claude:y'), 'unknown')
  assert.equal(pay('claude:y', {}, new Map([['claude:y', { week: {} }]])), 'subscription')
  assert.equal(pay('unknown', {}, new Map([['unknown', { week: {} }]])), 'subscription')
  // An account whose way to pay is not known follows "kestrel plan" when it is set by hand.
  assert.equal(pay('claude:y', { plan: 'subscription' }), 'subscription')
  assert.equal(pay('claude:y', { plan: 'usage' }), 'token')
  assert.equal(pay('api', { plan: 'subscription' }), 'token')
  assert.deepEqual(DOLLARS, { subscription: 'API value', token: 'spend', unknown: 'list prices' })
})

test('"kestrel accounts" with one account has one row and says that Kestrel found one account, and "kestrel summary" has "By account" only with more than one', () => {
  const one = machine()
  const now = Date.now()
  write(join(one.claude, 'projects', '-work-app', 'sA.jsonl'), [owner(A, ORG_A), call('a1', now - 2 * MIN)])
  const text = run(one, ['accounts']).stdout
  assert.equal(text.split('\n').filter((line) => /^ {2}\S/.test(line)).length, 2) // The head and one row.
  assert.match(text, /\n {2}claude:aaaaaaaa +Claude Code +unknown +none seen +/)
  assert.match(text, /\nKestrel found one account in the last 7 days\.\n/)
  assert.doesNotMatch(run(one, ['summary']).stdout, /By account/)
  assert.equal(JSON.parse(run(one, ['accounts', '--json']).stdout).current, null)
  assert.equal(run(machine(), ['accounts']).stdout, 'No model calls in the last 7 days.\n')

  const three = machine()
  writeLogs(three, now, MIN)
  claudeJson(join(three.home, '.claude.json'), A, ORG_A, 'Widal, Inc.')
  run(three, ['accounts'])
  const summary = run(three, ['summary']).stdout
  assert.match(summary, /\nBy account\n {2}Widal, Inc\. +\$1\.26 +51% +3 calls\n/)
  assert.match(summary, /\n {2}claude:bbbbbbbb +\$0\.42 +17% +1 calls\n/)
  assert.match(summary, /\n {2}codex:plus +\$0\.30 +12% +1 calls\n/)
})

test('today\'s numbers have the tokens of each account', async () => {
  const m = use(machine())
  writeLogs(m, NOON)
  assert.equal(await refreshToday({ now: NOON }), true)
  assert.deepEqual(readToday(NOON).accounts, {
    [`claude:${A}`]: { tokens: 303000, cacheRead: 0 }, [`claude:${B}`]: { tokens: 101000, cacheRead: 0 },
    'cowork:cw-account': { tokens: 101000, cacheRead: 0 }, 'codex:plus': { tokens: 110000, cacheRead: 0 }, 'codex:unknown': { tokens: 110000, cacheRead: 0 },
  })
  assert.ok(!filesText(m.kestrel).includes(MARKER))
})

test('line "plan" starts with the name of the session\'s account only when more than one account was used in the last 7 days', () => {
  const m = use(machine())
  const { logA, logB } = twoSessions(m)
  mkdirSync(m.kestrel, { recursive: true })
  writeFileSync(join(m.kestrel, 'config.json'), JSON.stringify({ hud: { lines: ['plan'] } }))
  claudeJson(join(m.home, '.claude.json'), A, ORG_A, 'Widal, Inc.')
  updateAccounts({ signedIn: true })
  const today = (accounts) => writeToday({ day: localDay(NOON), at: NOON, tokens: 303000, cacheRead: 0, coldStarts: 0, coldTokens: 0, sessions: {}, tickets: {}, accounts })
  const plan = (input = given('sA', logA, { week: 9 })) => statusLine(input, NOON, { env: {}, color: false, layout: 'lines', notify: () => {}, spawn: () => ({ unref() {} }) })
  const ONE = 'week ▌░░░░░░░░░ 9% │ today 303k tokens, 0% from the cache'
  // One account today, and none other in accounts.json: nothing changes.
  today({ [`claude:${A}`]: { tokens: 303000, cacheRead: 0 } })
  assert.equal(plan(), ONE)
  // A second account today: the line starts with the name of this session's account.
  today({ [`claude:${A}`]: { tokens: 200000, cacheRead: 0 }, [`claude:${B}`]: { tokens: 103000, cacheRead: 0 } })
  assert.equal(plan(), `Widal, Inc. · ${ONE}`)
  // In the same config folder, a session that started on account B shows the account signed in
  // now: its limits come from that account.
  assert.match(plan(given('sB', logB, { week: 9 })), /^Widal, Inc\. · week /)
  // Without a known account signed in, the session's own account counts. B has no name: its short key.
  const accountsPath = join(m.kestrel, 'accounts.json')
  const before = JSON.parse(readFileSync(accountsPath, 'utf8'))
  writeFileSync(accountsPath, JSON.stringify({ ...before, signedIn: {} }))
  assert.match(plan(given('sB', logB, { week: 9 })), /^claude:bbbbbbbb · week /)
  writeFileSync(accountsPath, JSON.stringify(before))
  // The second account only in accounts.json: used 6 days ago counts, 8 days ago does not.
  today({ [`claude:${A}`]: { tokens: 303000, cacheRead: 0 } })
  const seen = (ago) => {
    const file = join(m.kestrel, 'accounts.json')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.accounts[`claude:${B}`] = { lastSeen: NOON - ago }
    writeFileSync(file, JSON.stringify(saved))
  }
  seen(6 * DAY)
  assert.equal(plan(), `Widal, Inc. · ${ONE}`)
  seen(8 * DAY)
  assert.equal(plan(), ONE)
  // A label the person set is used, and the one line layout does not change.
  assert.equal(run(m, ['accounts', 'label', 'aaaaaaaa', 'Work']).status, 0)
  seen(DAY)
  assert.equal(plan(), `Work · ${ONE}`)
  assert.equal(oneLine(given('sA', logA, { week: 9 })), 'week 9% used, 57% of the week gone')
})

/** Starts "kestrel mcp" on a made-up computer and opens it. `call` gives a tool's result, `close` ends it. */
async function server(env) {
  const child = spawn(process.execPath, [BIN, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const waiting = new Map()
  const lines = []
  let rest = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    rest += chunk
    for (let i = rest.indexOf('\n'); i >= 0; i = rest.indexOf('\n')) {
      const line = rest.slice(0, i)
      rest = rest.slice(i + 1)
      lines.push(line)
      const message = JSON.parse(line)
      waiting.get(message.id)?.(message)
      waiting.delete(message.id)
    }
  })
  const exited = new Promise((resolve) => child.on('exit', resolve))
  let next = 0
  const request = (method, params) => {
    const id = ++next
    const reply = new Promise((resolve) => waiting.set(id, resolve))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return reply
  }
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  return {
    request,
    call: async (name, args) => (await request('tools/call', { name, ...(args === undefined ? {} : { arguments: args }) })).result,
    close: async () => {
      child.stdin.end()
      return { code: await exited, lines }
    },
  }
}

test('the desktop tool spend_by_account gives the text of "kestrel accounts", checks "days", and plan_limits names each account', async () => {
  const m = machine()
  const now = Date.now()
  writeLogs(m, now, MIN)
  claudeJson(join(m.home, '.claude.json'), A, ORG_A, 'Widal, Inc.')
  mkdirSync(m.kestrel, { recursive: true })
  writeFileSync(join(m.kestrel, 'limits.json'), JSON.stringify({
    [`claude:${A}`]: { week: { pct: 9, resetsAt: now + 3 * DAY, at: now - MIN } },
    [`claude:${B}`]: { week: { pct: 70, resetsAt: now + 3 * DAY, at: now - 2 * MIN } },
  }))
  const s = await server(m.env)
  const { tools } = (await s.request('tools/list')).result
  const tool = tools.find((x) => x.name === 'spend_by_account')
  assert.equal(tool.title, 'Spend by account')
  assert.deepEqual(tool.inputSchema.properties.days, { type: 'integer', minimum: 1, maximum: 90, default: 7, description: 'How many days back to look, from 1 to 90. Without it, 7.' })
  assert.deepEqual(tool.annotations, { readOnlyHint: true, openWorldHint: false })

  const result = await s.call('spend_by_account')
  assert.equal(result.isError, false, result.content[0].text)
  const text = result.content[0].text
  assert.match(text, /^Accounts, last 7 days, the newest first\./)
  assert.match(text, /\n {2}Widal, Inc\. +Claude Code +subscription, team_tier_1 +week 9% +/)
  assert.match(text, /\n {2}claude:bbbbbbbb +Claude Code +subscription +week 70%, full [\d.]+ days? early +/)
  assert.match(text, /\n {2}codex:plus +Codex +subscription, plus +/)
  assert.match((await s.call('spend_by_account', { days: 90 })).content[0].text, /^Accounts, last 90 days/)
  for (const days of [0, 91, 2.5, '7']) {
    const bad = await s.call('spend_by_account', { days })
    assert.equal(bad.isError, true)
    assert.deepEqual(bad.content, [{ type: 'text', text: '"days" is a whole number from 1 to 90.' }])
  }
  // The answer about the plan names each account, the newest reading first.
  const plan = (await s.call('plan_limits')).content[0].text
  assert.match(plan, /\nThe plan's limits of each account, from the newest reading on this computer:\n {2}Widal, Inc\. \(claude:aaaaaaaa\):\n {4}Week 9% used.+\n {2}claude:bbbbbbbb \(claude:bbbbbbbb\):\n {4}Week 70% used/)
  // The summary splits by account too.
  assert.match((await s.call('spend_summary')).content[0].text, /\nBy account\n {2}Widal, Inc\. +\$1\.26/)
  const end = await s.close()
  assert.equal(end.code, 0)
  for (const line of end.lines) for (const word of [...PERSONAL, MARKER]) assert.ok(!line.includes(word), word)
  for (const word of [...PERSONAL, MARKER]) assert.ok(!filesText(m.kestrel).includes(word), word)
})

test('two config folders whose "projects" folders are the same folder through a link: its logs are read once', () => {
  const base = mkdtempSync(join(dir, 'linked-projects-'))
  const first = join(base, 'claude-one')
  const second = join(base, 'claude-two')
  mkdirSync(join(first, 'projects', '-work-app'), { recursive: true })
  writeFileSync(join(first, 'projects', '-work-app', 's1.jsonl'), '{"type":"user"}\n')
  mkdirSync(second, { recursive: true })
  // The second folder's "projects" is a link to the first folder's "projects".
  symlinkSync(join(first, 'projects'), join(second, 'projects'))
  const before = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = first
  try {
    saveConfig({ ...config(), claudeDirs: [second] })
    const files = logFiles(['claude']).map((f) => f.file ?? f).filter((f) => String(f).includes('linked-projects-'))
    assert.equal(files.length, 1, JSON.stringify(files))
  } finally {
    process.env.CLAUDE_CONFIG_DIR = before
    saveConfig({ ...config(), claudeDirs: undefined })
  }
})

test('after a sign-in in the middle of a session, the status line saves and shows the limits for the account signed in now', () => {
  const now = Date.now()
  const log = join(dir, 'midway-session.jsonl')
  // The session started on account "old"; its log keeps naming that account.
  writeFileSync(log, `${JSON.stringify({ type: 'session-owner', accountUuid: 'old-acct-0000-0000', organizationUuid: 'org-old', sessionId: 'midway' })}\n`)
  // Kestrel saw that the account signed in now in this config folder is "new".
  const state = readAccountsFile()
  writeFileSync(join(process.env.KESTREL_HOME, 'accounts.json'), JSON.stringify({ accounts: { ...(state.accounts ?? {}), 'claude:new-acct-0000-0000': { org: 'New Org' } }, signedIn: { ...(state.signedIn ?? {}), [realPath(process.env.CLAUDE_CONFIG_DIR)]: 'claude:new-acct-0000-0000' } }))
  const input = {
    session_id: 'midway', cwd: '/work/repo', transcript_path: log, model: { id: 'claude-opus-5-5' },
    cost: { total_cost_usd: 1, total_duration_ms: 60000, total_api_duration_ms: 1000 },
    context_window: { context_window_size: 1000000, used_percentage: 10, current_usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 100000 } },
    rate_limits: { seven_day: { used_percentage: 12, resets_at: Math.round((now + 3 * 86400e3) / 1000) } },
  }
  statusLine(input, now, { env: {}, color: false, notify: () => {}, spawn: () => ({ unref() {} }) })
  assert.equal(readLimits(now, 'claude:new-acct-0000-0000').week?.pct, 12)
  assert.equal(readLimits(now, 'claude:old-acct-0000-0000').week, undefined)
})
