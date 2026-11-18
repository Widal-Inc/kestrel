// Tests for "widal desktop-mcp", the server that the Claude desktop app starts, and for the two files
// for the app: the desktop extension and the skill. Each test starts the server as a child
// process, with made-up home folders and made-up logs. Run: node --test
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const dir = mkdtempSync(join(tmpdir(), 'widal-code-mcp-test-'))
// This process imports no module of the tool. The folders are set all the same, as in the other
// test files, so that nothing here can reach the real ones.
// Widal.Code also reads the config folders of Claude Code in the home folder, so the home folder is a
// made-up one too.
process.env.HOME = join(dir, 'person')
process.env.WIDAL_HOME = join(dir, 'home')
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
process.env.CODEX_HOME = join(dir, 'codex')
process.env.WIDAL_COWORK_DIR = join(dir, 'cowork')

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[/\\]$/, '')
const WIDAL = join(ROOT, 'cli', 'widal.mjs')
const json = (...path) => JSON.parse(readFileSync(join(ROOT, ...path), 'utf8'))
const HOUR = 3600e3
const iso = (ms) => new Date(ms).toISOString()
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const TOOL_NAMES = ['what_widal_code_sees', 'spend_summary', 'plan_limits', 'spend_advice', 'compactions', 'spend_by_model', 'whats_running', 'spend_by_ticket', 'spend_by_account', 'security_check']
// A word that the made-up logs carry in prompts, answers, tool calls and tool results. No answer may hold it.
const MARKER = 'PELICANSECRET'
// A word in a git branch name. Widal.Code's own cache keeps branch names, on this computer only, so it is checked in what the server says, not in its files.
const BRANCH = 'HERONBRANCH'

let machines = 0
/**
 * A made-up computer: an empty home folder, with every folder the tool reads or writes inside it.
 * The server gets nothing of the real environment but the PATH.
 */
function machine(more = {}) {
  const home = join(dir, `machine-${++machines}`)
  mkdirSync(home, { recursive: true })
  return {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, NO_COLOR: '1',
    WIDAL_HOME: join(home, '.widal'), CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), WIDAL_COWORK_DIR: join(home, 'cowork'),
    ...more,
  }
}

/**
 * Starts the server as a child process. `request` sends a request and gives its answer, `send`
 * sends a line as it is, and `answer` waits for the answer with an id (null for an answer
 * without one). `close` ends standard input and gives the exit code, every line of standard
 * output, what came after the last line break, and standard error.
 */
function start(env, { bin = WIDAL } = {}) {
  const child = spawn(process.execPath, [bin, 'desktop-mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = []
  const waiting = new Map()
  let rest = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    rest += chunk
    for (let i = rest.indexOf('\n'); i >= 0; i = rest.indexOf('\n')) {
      const line = rest.slice(0, i)
      rest = rest.slice(i + 1)
      lines.push(line)
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const key = JSON.stringify(message?.id ?? null)
      waiting.get(key)?.(message)
      waiting.delete(key)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  let next = 0
  const send = (message) => child.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`)
  const answer = (id) => new Promise((resolve) => waiting.set(JSON.stringify(id), resolve))
  const request = (method, params, id = ++next) => {
    const reply = answer(id)
    send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    return reply
  }
  const call = async (name, args) => (await request('tools/call', { name, ...(args === undefined ? {} : { arguments: args }) })).result
  /** The text of a tool's answer. The answer must not be an error. */
  const text = async (name, args) => {
    const result = await call(name, args)
    assert.equal(result.isError, false, result.content?.[0]?.text)
    assert.equal(result.content.length, 1)
    assert.equal(result.content[0].type, 'text')
    return result.content[0].text
  }
  const close = async () => {
    child.stdin.end()
    return { code: await exited, lines, rest, stderr }
  }
  return { send, answer, request, call, text, close }
}

/** A server after the handshake of the version 2025-11-25. */
async function opened(env, options) {
  const s = start(env, options)
  const init = await s.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  assert.equal(init.result.protocolVersion, '2025-11-25')
  s.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return s
}

/** The server ended well, and standard output held whole lines that are protocol messages only: here, answers. */
function onlyProtocol({ code, lines, rest, stderr }) {
  assert.equal(code, 0, stderr)
  assert.equal(rest, '')
  for (const line of lines) {
    const message = JSON.parse(line)
    assert.equal(message.jsonrpc, '2.0', line)
    assert.ok(('result' in message) !== ('error' in message), line)
  }
}

/**
 * Made-up logs of all three agents, from the last few hours, with prices that can be worked out:
 *   - Claude Code, in /work/app: a call on Claude Opus 5.5 ($4 and $20 per million tokens in and
 *     out) with 100,000 tokens in and 10,000 out: $0.60. Then a call at effort "high" that read a
 *     file, with 100,000 tokens read from the cache ($0.20 per million) and 5,000 out: $0.12.
 *     Then a compaction by hand from 300,000 tokens to 30,000.
 *   - Codex, in /work/api: a call on GPT-6 Sol ($2 and $10) with 100,000 in and 10,000 out: $0.30.
 *   - Cowork: a call on Claude Sonnet 5.5 ($2 and $10) with 100,000 in and 1,000 out: $0.21.
 * Together $1.23 in 4 calls.
 */
function writeLogs(env, now = Date.now()) {
  const claude = join(env.CLAUDE_CONFIG_DIR, 'projects', '-work-app')
  mkdirSync(claude, { recursive: true })
  const usage = (input, cacheRead, output) => ({
    input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: output,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  })
  const line = (fields) => JSON.stringify({ cwd: '/work/app', sessionId: 's1', gitBranch: `fix-${BRANCH}`, ...fields })
  writeFileSync(join(claude, 's1.jsonl'), `${[
    line({ type: 'user', timestamp: iso(now - 2 * HOUR - 5e3), message: { role: 'user', content: `Read the notes of ${MARKER} and fix them` } }),
    line({ type: 'assistant', timestamp: iso(now - 2 * HOUR), message: { id: 'm1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: `I will look at ${MARKER}.` }], usage: usage(100000, 0, 10000) } }),
    line({ type: 'assistant', timestamp: iso(now - 2 * HOUR + 10e3), effort: 'high', message: { id: 'm2', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `/work/app/${MARKER}.txt` } }], usage: usage(0, 100000, 5000) } }),
    line({ type: 'user', timestamp: iso(now - 2 * HOUR + 11e3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `the notes say ${MARKER}` }] } }),
    line({ type: 'system', subtype: 'compact_boundary', timestamp: iso(now - HOUR), compactMetadata: { trigger: 'manual', preTokens: 300000, postTokens: 30000, durationMs: 20000 } }),
  ].join('\n')}\n`)

  const codex = join(env.CODEX_HOME, 'sessions', '2026', '11', '13')
  mkdirSync(codex, { recursive: true })
  const event = (type, payload) => JSON.stringify({ timestamp: iso(now - 3 * HOUR), type, payload })
  writeFileSync(join(codex, 'rollout-c1.jsonl'), `${[
    event('session_meta', { session_id: 'c1', cwd: '/work/api' }),
    event('turn_context', { model: 'gpt-6-sol', effort: 'medium', cwd: '/work/api' }),
    event('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Run the tests of ${MARKER}` }] }),
    event('response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['echo', MARKER] }), call_id: 'k1' }),
    event('token_usage_record', { response_id: 'r1', usage: { input_tokens: 100000, cached_input_tokens: 0, output_tokens: 10000, reasoning_output_tokens: 0 } }),
    event('response_item', { type: 'function_call_output', call_id: 'k1', output: MARKER }),
  ].join('\n')}\n`)

  const cowork = join(env.WIDAL_COWORK_DIR, 'account-1', 'workspace-1', 'local_w1')
  mkdirSync(cowork, { recursive: true })
  const entry = (fields) => JSON.stringify({ session_id: 'engine-1', _audit_timestamp: iso(now - 4 * HOUR), ...fields })
  writeFileSync(join(cowork, 'audit.jsonl'), `${[
    entry({ type: 'system', subtype: 'init', cwd: '/sessions/calm-river' }),
    entry({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: `Write a note about ${MARKER}` } }),
    entry({ type: 'assistant', parent_tool_use_id: null, message: { id: 'w1', model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'text', text: `A note on ${MARKER}` }], usage: { input_tokens: 100000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1000 } } }),
  ].join('\n')}\n`)
}

/** Every file below a folder, as paths relative to it. */
const filesBelow = (folder) => readdirSync(folder, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name))

/** Today's date as the reports write it. */
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test('the handshake agrees on a version, ping answers, and tools/list gives the ten tools with their arguments', { timeout: 60e3 }, async () => {
  const s = start(machine())
  const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  // A version that the server speaks is agreed as it is.
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.deepEqual(init.result.serverInfo, { name: 'widal-code', title: 'Widal.Code', version: json('package.json').version })
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } })
  assert.match(init.result.instructions, /what_widal_code_sees/)
  s.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  // A version that it does not know: the answer is the newest one with a handshake.
  assert.equal((await s.request('initialize', { protocolVersion: '1999-01-01', capabilities: {} })).result.protocolVersion, '2025-11-25')
  assert.equal((await s.request('initialize', { capabilities: {} })).error.code, -32602)
  assert.deepEqual((await s.request('ping')).result, {})

  const { tools } = (await s.request('tools/list')).result
  assert.deepEqual(tools.map((t) => t.name), TOOL_NAMES)
  for (const t of tools) {
    assert.equal(typeof t.title, 'string')
    // One or two sentences: what it answers, and when to use it.
    assert.match(t.description, /^[A-Z].+\. Use it .+[.?]$/)
    assert.deepEqual(t.annotations, { readOnlyHint: true, openWorldHint: false })
  }
  const days = (fallback) => ({
    type: 'object',
    properties: { days: { type: 'integer', minimum: 1, maximum: 90, default: fallback, description: `How many days back to look, from 1 to 90. Without it, ${fallback}.` } },
    additionalProperties: false,
  })
  const none = { type: 'object', additionalProperties: false }
  assert.deepEqual(tools.map((t) => t.inputSchema), [none, days(7), none, days(30), days(30), days(30), none, days(7), days(7), none])

  const end = await s.close()
  onlyProtocol(end)
  // Five requests, five answers: the notification got none.
  assert.equal(end.lines.length, 5)
})

test('a client of the newest version, without a handshake, gets the versions from server/discover and the same tools', { timeout: 60e3 }, async () => {
  const env = machine()
  writeLogs(env)
  const s = start(env)
  const meta = (version = '2026-07-28', more = { 'io.modelcontextprotocol/clientCapabilities': {} }) => ({ _meta: { 'io.modelcontextprotocol/protocolVersion': version, ...more } })
  const discover = (await s.request('server/discover', meta())).result
  assert.equal(discover.resultType, 'complete')
  assert.equal(discover.supportedVersions[0], '2026-07-28')
  assert.ok(discover.supportedVersions.includes('2025-11-25'))
  assert.deepEqual(discover.capabilities, { tools: { listChanged: false } })
  assert.equal(discover._meta['io.modelcontextprotocol/serverInfo'].name, 'widal-code')
  assert.equal(discover.cacheScope, 'public')
  assert.ok(discover.ttlMs > 0)

  const list = (await s.request('tools/list', meta())).result
  assert.equal(list.resultType, 'complete')
  assert.deepEqual(list.tools.map((t) => t.name), TOOL_NAMES)
  assert.ok(list.ttlMs > 0)
  const called = (await s.request('tools/call', { name: 'spend_summary', arguments: {}, ...meta() })).result
  assert.equal(called.resultType, 'complete')
  assert.equal(called.isError, false)
  assert.match(called.content[0].text, /Total\s+\$1\.23/)

  // A version that the server does not know, a request without the client's capabilities, and
  // server/discover without a version.
  const old = await s.request('tools/list', meta('1900-01-01'))
  assert.equal(old.error.code, -32022)
  assert.deepEqual(old.error.data, { supported: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'], requested: '1900-01-01' })
  assert.equal((await s.request('tools/list', meta('2026-07-28', {}))).error.code, -32602)
  assert.equal((await s.request('server/discover')).error.code, -32602)
  onlyProtocol(await s.close())
})

test('each tool answers on made-up logs, with numbers that can be checked, and no answer holds text from a session', { timeout: 60e3 }, async () => {
  const env = machine()
  writeLogs(env)
  const s = await opened(env)
  const answers = []
  const ask = async (name, args) => {
    const text = await s.text(name, args)
    answers.push(text)
    return text
  }

  const sees = await ask('what_widal_code_sees')
  assert.match(sees, new RegExp(`Claude Code: 1 log, the newest from ${today()}\\.`))
  assert.match(sees, /Codex: 1 log, the newest from /)
  assert.match(sees, /Cowork: 1 log, the newest from /)
  assert.match(sees, /What Widal.Code cannot see:\n {2}Chat on claude\.ai.+\n {2}Cloud sessions.+\n {2}Other computers/)

  for (const days of [undefined, 1, 90]) {
    const summary = await ask('spend_summary', days === undefined ? undefined : { days })
    assert.match(summary, new RegExp(`^What the agents used, last ${days ?? 7} days, in dollars at list prices, so an estimate\\.`))
    // Cowork runs on a Claude plan, so its dollars are API value. The others are not known to be paid either way.
    assert.match(summary, /\nOn subscriptions: \$0\.21 of API value \(what the same use would cost by the token\)\n/)
    assert.match(summary, /Total\s+\$1\.23\s+4 model calls/)
    assert.match(summary, /Claude Code\s+\$0\.72\s+2 calls/)
    assert.match(summary, /Codex\s+\$0\.30\s+1 calls/)
    assert.match(summary, /Cowork\s+\$0\.21\s+1 calls/)
    assert.match(summary, /work\/app\s+\$0\.72\s+59%/)
    assert.match(summary, /opus-5-5\s+\$0\.72/)
    // The plan, as far as Widal.Code knows: nothing says how this person pays.
    assert.match(summary, /The plan\nHow you pay, as far as Widal.Code knows: usage, paid by the token, not sure/)
    assert.match(summary, /Widal.Code has no reading of the plan's limits\. The Claude app shows the percent under Settings, Usage\./)
    // The line that names the command's other reports is gone.
    assert.doesNotMatch(summary, /Next: "widal/)
  }

  const byModel = await ask('spend_by_model')
  assert.match(byModel, /^Spend by model, effort level and kind of work, last 30 days\./)
  assert.match(byModel, /Total\s+\$1\.23\s+4 model calls/)
  assert.match(byModel, /opus-5-5\s+\(not logged\)\s+1\s+\$0\.60\s+49%/)
  assert.match(byModel, /opus-5-5\s+high\s+1\s+\$0\.12\s+10%/)
  assert.match(byModel, /gpt-6-sol\s+medium\s+1\s+\$0\.30\s+24%/)
  assert.match(byModel, /sonnet-5-5\s+\(not logged\)\s+1\s+\$0\.21\s+17%/)

  // Two proposals. The short session in /work/app on a strong model: the same tokens at Claude
  // Sonnet 5.5's prices cost $0.36 instead of $0.72. And the call that read a file at effort high,
  // with no calls at a lower effort to compare with, so without an amount.
  const advice = await ask('spend_advice')
  assert.match(advice, /^Proposals from a replay of the last 30 days: \$1\.23 at list prices, 4 model calls\./)
  assert.match(advice, /1\. Start new sessions in work\/app on a cheaper model: \$0\.36 less, 29% of the total/)
  assert.match(advice, /2\. Start sessions at a lower effort: no amount yet/)
  assert.match(advice, /Apply: widal apply effort-default --level medium/)
  assert.ok(advice.endsWith('\n\nA change with a "widal apply" command is made in a terminal, with that command: Widal.Code in the desktop app never changes a setting.'))

  const compactions = await ask('compactions', { days: 30 })
  assert.match(compactions, /^Compactions, last 30 days\./)
  assert.match(compactions, /All\s+1\s+300k \(300k to 300k\)\s+30k \(30k to 30k\)\s+90%\s+20 seconds/)
  assert.match(compactions, /Automatic\s+0\n/)
  assert.match(compactions, /By hand\s+1\s+300k/)

  const unknown = await ask('plan_limits')
  assert.match(unknown, /^How you pay, as far as Widal.Code knows: usage, paid by the token, not sure \(no sign of a plan, so figures are list prices\)\./)
  assert.match(unknown, /Widal.Code has no reading of the plan's limits/)
  assert.match(unknown, /Where the numbers come from:\n {2}The percent: Claude Code gives/)
  assert.match(unknown, /Widal.Code does not read Codex's plan or its limits\./)
  // A reading of the plan's limits from 10 minutes ago, as Widal.Code's status line keeps it: 33%
  // of the 5 hour limit, which resets in 2 hours. So 3 of its 5 hours have gone.
  const now = Date.now()
  mkdirSync(env.WIDAL_HOME, { recursive: true })
  writeFileSync(join(env.WIDAL_HOME, 'limits.json'), JSON.stringify({ five: { pct: 33, resetsAt: now + 2 * HOUR, at: now - 10 * 60e3 } }))
  const known = await ask('plan_limits')
  assert.match(known, /^How you pay, as far as Widal.Code knows: subscription \(the plan's limits were seen on this machine today\)\./)
  assert.match(known, /The plan's limits, from the newest reading on this computer:\n {2}5 hour limit 33% used \(read 10 min ago\), 60% of its time gone\. It resets at \d{4}-\d\d-\d\d \d\d:\d\d\./)

  // Privacy: no answer holds the word from the prompts, answers, tool calls and tool results, and
  // neither does any line of standard output or any file that the server wrote.
  for (const text of answers) assert.ok(!text.includes(MARKER) && !text.includes(BRANCH))
  const end = await s.close()
  onlyProtocol(end)
  for (const line of end.lines) assert.ok(!line.includes(MARKER) && !line.includes(BRANCH))
  const written = filesBelow(env.WIDAL_HOME)
  assert.ok(written.some((file) => file.includes(`${join(env.WIDAL_HOME, 'cache')}`)), 'the logs went through the cache')
  for (const file of written) assert.ok(!readFileSync(file, 'utf8').includes(MARKER), file)
})

test('"days" at its bounds and out of them, an unknown tool, an unknown method and a line that is not JSON: each gets an answer, and the server keeps running', { timeout: 60e3 }, async () => {
  const env = machine()
  writeLogs(env)
  const s = await opened(env)
  let requests = 1
  const alive = async () => {
    requests++
    assert.deepEqual((await s.request('ping')).result, {})
  }

  for (const days of [1, 90]) {
    requests++
    assert.match(await s.text('spend_by_model', { days }), new RegExp(`last ${days} days`))
  }
  // A value out of range is an error in the tool's answer, so that the model can try again.
  for (const days of [0, 91, -1, 7.5, '7', true]) {
    requests++
    const result = await s.call('spend_summary', { days })
    assert.equal(result.isError, true)
    assert.deepEqual(result.content, [{ type: 'text', text: '"days" is a whole number from 1 to 90.' }])
    await alive()
  }
  requests += 2
  assert.equal((await s.call('spend_summary', { weeks: 1 })).content[0].text, 'spend_summary takes one argument, "days".')
  assert.equal((await s.call('what_widal_code_sees', { days: 7 })).content[0].text, 'what_widal_code_sees takes no arguments.')

  // A request that is not right in itself is a protocol error.
  requests++
  const unknownTool = await s.request('tools/call', { name: 'delete_everything', arguments: {} })
  assert.deepEqual(unknownTool.error, { code: -32602, message: 'Unknown tool: delete_everything' })
  await alive()
  requests += 3
  assert.equal((await s.request('tools/call', { name: 'spend_summary', arguments: [7] })).error.code, -32602)
  assert.equal((await s.request('tools/call', { arguments: {} })).error.code, -32602)
  assert.equal((await s.request('tools/call', 'spend_summary')).error.code, -32602)
  await alive()
  requests++
  assert.deepEqual((await s.request('resources/list')).error, { code: -32601, message: 'Method not found: resources/list' })
  await alive()

  // A line that is not JSON, and messages that are not JSON-RPC requests.
  let reply = s.answer(null)
  s.send('{"jsonrpc":"2.0","id":')
  assert.deepEqual(await reply, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: the line is not JSON.' } })
  await alive()
  reply = s.answer(9)
  s.send({ id: 9, method: 'ping' })
  assert.equal((await reply).error.code, -32600)
  reply = s.answer(null)
  s.send('[1, 2]')
  assert.equal((await reply).error.code, -32600)
  await alive()
  // An answer from the client and an empty line get nothing back.
  s.send({ jsonrpc: '2.0', id: 77, result: {} })
  s.send('')
  await alive()

  const end = await s.close()
  onlyProtocol(end)
  // One answer per request, and one for each of the three broken lines.
  assert.equal(end.lines.length, requests + 3)
})

test('with no logs at all, every tool of the logs says so in plain words, and security_check still answers from the findings', { timeout: 60e3 }, async () => {
  const s = await opened(machine())
  assert.match(await s.text('security_check'), /^Widal.Code's security checks: 0 open findings/)
  for (const name of TOOL_NAMES.filter((n) => n !== 'security_check')) {
    const text = await s.text(name)
    assert.match(text, /Widal.Code found no logs of Claude Code, Codex or Cowork on this computer/, name)
    assert.match(text, /Claude does not keep chat usage on this computer/, name)
    assert.match(text, /The plan's percent is shown in the Claude app under Settings, Usage\./, name)
    assert.match(text, /The numbers start once you use Cowork, Claude Code or Codex on this computer\./, name)
  }
  const sees = await s.text('what_widal_code_sees')
  assert.match(sees, /Claude Code: no logs\.\n {2}Codex: no logs\.\n {2}Cowork: no logs\./)
  onlyProtocol(await s.close())
})

test('an error inside a tool gives an error result with one plain sentence, and the server keeps running', { timeout: 60e3 }, async () => {
  // Widal.Code's folder is a file here, so the cache of the parsed logs cannot be made.
  const env = machine()
  writeFileSync(join(env.HOME, 'not-a-folder'), '')
  env.WIDAL_HOME = join(env.HOME, 'not-a-folder')
  writeLogs(env)
  const s = await opened(env)
  for (const name of ['spend_summary', 'spend_by_model']) {
    const result = await s.call(name, null)
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /^Widal.Code could not answer because of an error: [^\n]+\.$/)
  }
  // The tools that do not need the cache still answer.
  assert.match(await s.text('what_widal_code_sees'), /Claude Code: 1 log/)
  assert.match(await s.text('plan_limits'), /^How you pay/)
  const end = await s.close()
  onlyProtocol(end)
  assert.match(end.stderr, /reading the logs failed/)
})

test('when the first read of the logs takes longer than the wait, a call says how far it is, and the read goes on', { timeout: 60e3 }, async () => {
  // The wait is 1 millisecond here instead of 40 seconds, and there are 600 logs to read.
  const env = machine({ WIDAL_MCP_WAIT_MS: '1' })
  const folder = join(env.CLAUDE_CONFIG_DIR, 'projects', '-work-app')
  mkdirSync(folder, { recursive: true })
  const at = iso(Date.now() - HOUR)
  const usage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 100 }
  for (let i = 0; i < 600; i++) {
    writeFileSync(join(folder, `s${i}.jsonl`), `${JSON.stringify({ type: 'assistant', timestamp: at, cwd: '/work/app', sessionId: `s${i}`, message: { id: `m${i}`, model: 'claude-opus-5-5', role: 'assistant', content: [], usage } })}\n`)
  }
  const s = await opened(env)
  const first = await s.call('spend_summary')
  assert.equal(first.isError, false)
  const [, done] = first.content[0].text.match(/^Widal.Code is still reading the session logs on this computer for the first time: (\d+) of 600 logs done\. Ask again in a minute, and the answer will be there: the reading goes on in the background\.$/) ?? []
  assert.ok(Number(done) < 600, first.content[0].text)
  // A tool that does not read the logs answers at once.
  assert.match(await s.text('plan_limits'), /^How you pay/)
  // The read goes on without another call. Once it is done, the answer is there.
  let text
  for (let tries = 0; tries < 300; tries++) {
    text = await s.text('spend_summary')
    if (!text.startsWith('Widal.Code is still reading')) break
    await pause(100)
  }
  assert.match(text, /Total\s+\$\d+\.\d\d\s+600 model calls/)
  onlyProtocol(await s.close())
})

test('a very long line, two requests in one write, and standard input closed while calls are open: each request gets one answer, and the server ends well', { timeout: 60e3 }, async () => {
  const env = machine()
  writeLogs(env)
  const s = await opened(env)
  // A line of 5 MB that is not JSON gets one answer, and the server goes on.
  const parseError = s.answer(null)
  s.send('x'.repeat(5 * 1024 * 1024))
  assert.equal((await parseError).error.code, -32700)
  // Two requests in one write.
  const first = s.answer(101)
  const second = s.answer(102)
  s.send(`${JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'ping' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'tools/list' })}`)
  assert.deepEqual((await first).result, {})
  assert.equal((await second).result.tools.length, 10)
  // Two calls, then standard input ends at once: both are answered before the server ends.
  const one = s.answer(201)
  const two = s.answer(202)
  s.send({ jsonrpc: '2.0', id: 201, method: 'tools/call', params: { name: 'spend_summary', arguments: { days: 7 } } })
  s.send({ jsonrpc: '2.0', id: 202, method: 'tools/call', params: { name: 'what_widal_code_sees' } })
  const end = await s.close()
  assert.equal((await one).result.isError, false)
  assert.equal((await two).result.isError, false)
  onlyProtocol(end)
  const ids = end.lines.map((line) => JSON.parse(line).id)
  for (const id of [101, 102, 201, 202]) assert.equal(ids.filter((x) => x === id).length, 1, `answers to ${id}`)
})

/** The files in a zip, from its central directory: name, how it is packed, its size packed, and where it starts. */
function zipEntries(file) {
  const b = readFileSync(file)
  // The record at the end of a zip that says where its list of files is.
  let end = b.length - 22
  while (end >= 0 && b.readUInt32LE(end) !== 0x06054b50) end--
  assert.ok(end >= 0, `${file} is a zip`)
  const entries = []
  let at = b.readUInt32LE(end + 16)
  for (let left = b.readUInt16LE(end + 10); left > 0; left--) {
    assert.equal(b.readUInt32LE(at), 0x02014b50)
    const nameLength = b.readUInt16LE(at + 28)
    entries.push({ name: b.toString('utf8', at + 46, at + 46 + nameLength), method: b.readUInt16LE(at + 10), packed: b.readUInt32LE(at + 20), offset: b.readUInt32LE(at + 42) })
    at += 46 + nameLength + b.readUInt16LE(at + 30) + b.readUInt16LE(at + 32)
  }
  /** The content of one file of the zip: stored as it is, or packed with deflate. */
  const content = (e) => {
    const start = e.offset + 30 + b.readUInt16LE(e.offset + 26) + b.readUInt16LE(e.offset + 28)
    const data = b.subarray(start, start + e.packed)
    return e.method === 8 ? inflateRawSync(data) : data
  }
  return { names: entries.map((e) => e.name).sort(), entries, content }
}

/** Builds both files into a new temp folder, and gives that folder. */
function build() {
  const out = mkdtempSync(join(tmpdir(), 'widal-code-build-test-'))
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-desktop.mjs'), out], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return out
}

test('the manifest is valid JSON, has the version of package.json and the tools of tools/list, and names files that are there', { timeout: 60e3 }, async () => {
  const manifest = json('desktop', 'manifest.json')
  const pkg = json('package.json')
  assert.equal(manifest.manifest_version, '0.3')
  assert.equal(manifest.name, 'kestrel')
  assert.equal(manifest.display_name, 'Kestrel')
  assert.equal(manifest.version, pkg.version)
  assert.deepEqual(manifest.author, { name: 'Widal, Inc.', email: 'hello@widal.com', url: 'https://kestrel.widal.com' })
  assert.equal(manifest.license, 'MIT')
  assert.deepEqual(manifest.repository, { type: 'git', url: 'https://github.com/Widal-Inc/kestrel' })
  assert.match(manifest.long_description, /reads local agent logs, returns numbers only, sends nothing anywhere/)
  assert.equal(manifest.icon, 'icon.png')
  assert.equal(manifest.server.type, 'node')
  assert.equal(manifest.server.entry_point, 'cli/widal.mjs')
  assert.deepEqual(manifest.server.mcp_config, { command: 'node', args: ['${__dirname}/cli/widal.mjs', 'desktop-mcp'], env: {} })
  // The Node that package.json asks for, and only systems the code is known to work on.
  assert.equal(pkg.engines.node, '>=22')
  assert.deepEqual(manifest.compatibility, { platforms: ['darwin', 'linux'], runtimes: { node: '>=22.0.0' } })

  // The files it names: in the repo, and in the built extension, where the icon has its new name.
  assert.ok(existsSync(join(ROOT, manifest.server.entry_point)))
  assert.ok(existsSync(join(ROOT, 'assets', 'widal-code-512.png')))
  const { names } = zipEntries(join(build(), 'kestrel.mcpb'))
  for (const file of [manifest.icon, manifest.server.entry_point, 'manifest.json']) assert.ok(names.includes(file), file)

  const s = await opened(machine())
  const { tools } = (await s.request('tools/list')).result
  assert.deepEqual(manifest.tools, tools.map(({ name, description }) => ({ name, description })))
  onlyProtocol(await s.close())
})

test('the build makes the extension with exactly its files, which runs once unpacked, and the skill with its folder at the top', { timeout: 60e3 }, async () => {
  const out = build()
  const mcpb = zipEntries(join(out, 'kestrel.mcpb'))
  // Hidden files, such as .DS_Store on a Mac, stay out of the extension.
  const visible = (folder) => readdirSync(join(ROOT, folder)).filter((f) => !f.startsWith('.')).map((f) => `${folder}/${f}`)
  const expected = ['manifest.json', 'icon.png', 'package.json', ...visible('cli'), ...visible('src')].sort()
  assert.deepEqual(mcpb.names, expected)
  const content = (name) => mcpb.content(mcpb.entries.find((e) => e.name === name))
  assert.ok(content('icon.png').equals(readFileSync(join(ROOT, 'assets', 'widal-code-512.png'))))
  assert.ok(content('manifest.json').equals(readFileSync(join(ROOT, 'desktop', 'manifest.json'))))

  // Unpacked into a folder of its own, the extension's server answers from its own files.
  const unpacked = mkdtempSync(join(tmpdir(), 'widal-code-unpacked-test-'))
  for (const e of mcpb.entries) {
    mkdirSync(dirname(join(unpacked, e.name)), { recursive: true })
    writeFileSync(join(unpacked, e.name), mcpb.content(e))
  }
  const env = machine()
  writeLogs(env)
  const s = await opened(env, { bin: join(unpacked, 'cli', 'widal.mjs') })
  assert.match(await s.text('spend_summary'), /Total\s+\$1\.23\s+4 model calls/)
  onlyProtocol(await s.close())

  const skill = zipEntries(join(out, 'kestrel-skill.zip'))
  assert.deepEqual(skill.names, ['widal-code/SKILL.md'])
  assert.ok(skill.content(skill.entries[0]).equals(readFileSync(join(ROOT, 'desktop', 'skill', 'widal-code', 'SKILL.md'))))
})

test('the skill has a name and a description in its front matter, names every tool, and stays under 500 lines', () => {
  const text = readFileSync(join(ROOT, 'desktop', 'skill', 'widal-code', 'SKILL.md'), 'utf8')
  const [, front] = text.match(/^---\n([\s\S]*?)\n---\n/) ?? []
  assert.ok(front, 'front matter')
  const fields = Object.fromEntries(front.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]))
  assert.deepEqual(Object.keys(fields), ['name', 'description'])
  assert.equal(fields.name, 'widal-code')
  // Anthropic's help page on skills allows 200 characters for the description.
  assert.ok(fields.description.length > 50 && fields.description.length <= 200, fields.description)
  for (const words of ['spend', 'tokens', 'usage', 'limits', 'Claude Code', 'Cowork', 'Codex', 'use less of my plan']) assert.ok(fields.description.includes(words), words)
  for (const name of TOOL_NAMES) assert.ok(text.includes(`\`${name}\``), name)
  assert.match(text, /Never ask the person to paste a log/)
  assert.match(text, /The numbers need the Widal.Code extension in the Claude desktop app, on the computer where your agents run\./)
  assert.ok(text.split('\n').length < 500)
})

test('no new file and no changed file of this part has an em dash or an en dash', () => {
  // The two characters are made from their codes, so that this file holds neither.
  const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`)
  const files = [
    'src/mcp.mjs', 'test/mcp.test.mjs', 'scripts/build-desktop.mjs', 'desktop/manifest.json', 'desktop/skill/widal-code/SKILL.md',
    'docs/desktop.md', 'cli/widal.mjs', 'src/claude-code.mjs', 'package.json', '.gitignore',
  ]
  for (const file of files) assert.doesNotMatch(readFileSync(join(ROOT, file), 'utf8'), dashes, file)
})
