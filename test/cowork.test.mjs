// Tests of the Cowork reader, with a small made-up log in Cowork's layout. Run: node --test
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'kestrel-test-'))
// Kestrel also reads the config folders of Claude Code in the home folder, so the home folder is a
// made-up one too.
process.env.HOME = join(dir, 'person')
process.env.KESTREL_HOME = join(dir, 'home')
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
process.env.CODEX_HOME = join(dir, 'codex')
process.env.KESTREL_COWORK_DIR = join(dir, 'cowork')
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })

const { CoworkParser } = await import('../src/parse-cowork.mjs')
const { ClaudeParser } = await import('../src/parse-claude.mjs')
const { CodexParser } = await import('../src/parse-codex.mjs')
const { coworkDir } = await import('../src/paths.mjs')
const { load, logFiles } = await import('../src/store.mjs')
const { analyze, totals } = await import('../src/analyze.mjs')
const { COWORK_NOTE, findings, models, session, summary } = await import('../src/report.mjs')

const COWORK = process.env.KESTREL_COWORK_DIR
const SESSION = join(COWORK, 'account-1', 'workspace-1', 'local_s1')
const LOG = join(SESSION, 'audit.jsonl')
const OPUS = 'claude-opus-4-7'
const HAIKU = 'claude-haiku-4-5-20251001'

let n = 0
const at = (minute, second = 0) => `2026-11-12T10:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`
const line = (time, fields) => JSON.stringify({ ...fields, session_id: 'engine-1', uuid: `u${n++}`, _audit_timestamp: time, _audit_hmac: 'h' })
const usage = (inp, w5, w1, cr, out) => ({
  input_tokens: inp, cache_creation_input_tokens: w5 + w1, cache_read_input_tokens: cr, output_tokens: out,
  cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 }, service_tier: 'standard', inference_geo: 'not_available',
})
const init = (time) => line(time, { type: 'system', subtype: 'init', cwd: '/sessions/calm-river', model: `${OPUS}[1m]`, tools: [] })
/** One line of an answer: it holds one content block, and the usage from the start of the answer. */
const assistant = (id, time, u, block, extra = {}) => line(time, {
  type: 'assistant', parent_tool_use_id: null, ...extra,
  message: { model: OPUS, id, type: 'message', role: 'assistant', content: [block], usage: u, stop_reason: null, ...extra.message },
})
const user = (time, content, extra = {}) => line(time, { type: 'user', parent_tool_use_id: null, message: { role: 'user', content }, ...extra })
const toolResult = (toolUseId, text) => [{ type: 'tool_result', tool_use_id: toolUseId, content: text }]
const modelUsage = (inp, out, cr, cw, costUSD) => ({ inputTokens: inp, outputTokens: out, cacheReadInputTokens: cr, cacheCreationInputTokens: cw, webSearchRequests: 0, costUSD, contextWindow: 1000000, maxOutputTokens: 64000 })
const result = (time, models, total) => line(time, { type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: total, usage: {}, modelUsage: models })

// One turn of a session: three answers of the main session, and one of a subagent that the second answer started.
const TURN = [
  init(at(0)),
  user(at(0, 1), 'fix the report', { client_platform: 'desktop' }),
  user(at(0, 2), 'fix the report', { isReplay: true }),
  // The first answer takes two lines: its thinking (only the signature is kept), then a tool call.
  assistant('m1', at(0, 5), usage(10, 500, 20000, 0, 2), { type: 'thinking', thinking: '', signature: 's'.repeat(40) }, { timestamp: '2026-11-12T09:00:00.000Z' }),
  assistant('m1', at(0, 6), usage(10, 500, 20000, 0, 2), { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la /work/src' } }),
  user(at(0, 7), toolResult('t1', 'x'.repeat(3600))),
  assistant('m2', at(0, 10), usage(5, 0, 1400, 20510, 3), { type: 'tool_use', id: 't2', name: 'Task', input: { prompt: 'find the old code' } }),
  user(at(0, 11), [{ type: 'text', text: 'find the old code' }], { parent_tool_use_id: 't2', subagent_type: 'Explore' }),
  assistant('a1', at(0, 12), usage(8, 9000, 0, 0, 1), { type: 'text', text: 'It is in src.' }, { parent_tool_use_id: 't2', subagent_type: 'Explore', message: { model: HAIKU } }),
  user(at(0, 20), toolResult('t2', [{ type: 'text', text: 'y'.repeat(100) }])),
  assistant('e1', at(0, 21), usage(0, 0, 0, 0, 0), { type: 'text', text: 'No response.' }, { message: { model: '<synthetic>' } }),
  line(at(0, 22), { type: 'tool_use_summary', summary: 'Looked at the folder', preceding_tool_use_ids: ['t1'] }),
  // Lines of types that this reader does not know. Each holds everything that a line of a known
  // type holds: an answer, a message that enters the context, the totals of a turn, and the start
  // of a turn. So each would change the result if only its type were not looked at.
  line(at(0, 23), { type: 'answer_of_a_later_version', parent_tool_use_id: null, message: { model: OPUS, id: 'later-1', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: {} }], usage: usage(1, 1, 1, 1, 1) } }),
  line(at(0, 24), { type: 'message_of_a_later_version', parent_tool_use_id: null, message: { role: 'user', content: 'w'.repeat(900) } }),
  line(at(0, 25), { type: 'result_of_a_later_version', total_cost_usd: 9, modelUsage: { [OPUS]: modelUsage(1, 5000, 1, 1, 9) } }),
  line(at(0, 26), { type: 'system', subtype: 'init_of_a_later_version', cwd: '/sessions/another-place' }),
  line(at(0, 27), { type: 'system_of_a_later_version', subtype: 'init', cwd: '/sessions/another-place' }),
  '{"type":"assistant","message":{"id":"m9","model":"claude-opus-4-7","usage":{"input_tok',
  assistant('m3', at(0, 30), usage(5, 0, 300, 23315, 1), { type: 'text', text: 'It is done' }),
  // The totals of the turn. The small model also made a call on the side that no line shows.
  result(at(0, 31), { [`${OPUS}[1m]`]: modelUsage(20, 1007, 43825, 22200, 0.5), [HAIKU]: modelUsage(308, 41, 0, 9000, 0.01) }, 0.51),
]

function parse(lines, file = LOG) {
  const p = new CoworkParser(file)
  for (const l of lines) p.feed(l)
  return p.result()
}
const tokens = (r) => [r.in, r.cr, r.w5, r.w1, r.out, r.m]

test('a Cowork log gives one call per answer, with its tokens, its model, its time and the working folder', () => {
  const { records } = parse(TURN)
  assert.deepEqual(records.map((r) => r.id), ['m1', 'm2', 'a1', 'm3'])
  const [m1, m2, a1, m3] = records
  // The output is the turn's total from the result line, shared by how much each answer wrote:
  // 60, 30 and 10 characters. 1,007 tokens minus the 6 counted at the starts leave 1,001 to share.
  assert.deepEqual(tokens(m1), [10, 0, 500, 20000, 2 + 600, OPUS])
  assert.deepEqual(tokens(m2), [5, 20510, 0, 1400, 3 + 300, OPUS])
  assert.deepEqual(tokens(m3), [5, 23315, 0, 300, 1 + 100 + 1, OPUS]) // The 1 token that rounding left goes to the last call.
  assert.deepEqual(tokens(a1), [8, 0, 9000, 0, 41, HAIKU])
  assert.equal(m1.out + m2.out + m3.out, 1007)
  assert.deepEqual([m1.s, m1.ses, m1.cwd, m1.f], ['cowork', 's1', '/sessions/calm-river', LOG])
  assert.equal(m1.ts, Date.parse(at(0, 5))) // The time is "_audit_timestamp", also when a line has a "timestamp" too.
})

test('an answer written as several lines counts once', () => {
  const { records } = parse(TURN)
  assert.equal(records.filter((r) => r.id === 'm1').length, 1)
  assert.deepEqual(records[0].tools.map((t) => t[0]), ['Bash'])
  // The same lines again, as in a file that is read twice, add nothing.
  const twice = parse([...TURN.slice(0, 5), ...TURN.slice(3, 5)])
  assert.deepEqual(twice.records.map((r) => r.id), ['m1'])
  assert.deepEqual(twice.records[0].tools.map((t) => t[0]), ['Bash'])
})

test('what entered the context between two calls is kept by its label and size, and a repeated message counts once', () => {
  const [m1, m2, a1, m3] = parse(TURN).records
  assert.deepEqual(m1.add, [['(your messages)', 14]])
  assert.deepEqual(m2.add, [['Bash', 3600]])
  assert.deepEqual(a1.add, [['(messages to the subagent)', 17]])
  assert.deepEqual(m3.add, [['Task', 100]])
})

test("a subagent's call is told apart from the main session's, and has a context of its own", () => {
  const { records } = parse(TURN)
  const [m1, m2, a1, m3] = records
  assert.deepEqual([m1.agent, m2.agent, m3.agent], [undefined, undefined, undefined])
  assert.equal(a1.agent, 't2') // The id of the tool call that started it.
  assert.equal(a1.f, `${LOG}/subagents/t2`)
  assert.equal(a1.ses, m1.ses)
  // The subagent's call is between two calls of the main session. The analysis must not take it
  // for the main session's next call: the main session then reads its context from the cache.
  const { calls } = analyze(records)
  assert.deepEqual(calls.filter((e) => e.miss), [])
  assert.equal(calls.find((e) => e.r.id === 'm3').carried, 20000 + 510 + 1400 + 5)
  assert.match(session(records, {}), /Session s1 {2}sessions\/calm-river {2}\(Cowork\)\n.* 4 model calls, 1 subagent runs/)
})

test('a made-up answer, a line of an unknown type and a broken line are skipped, and no line makes the reader fail', () => {
  const { records, meta } = parse(TURN)
  assert.equal(records.length, 4)
  assert.equal(records.some((r) => r.m === '<synthetic>' || r.id === 'm9' || r.id === 'later-1'), false)
  // The lines of unknown types changed nothing: not what entered the context, not the working
  // folder, not the app's cost figure, and not how the output of the turn is shared.
  assert.deepEqual(records.at(-1).add, [['Task', 100]])
  assert.deepEqual(records.map((r) => r.cwd), Array(4).fill('/sessions/calm-river'))
  assert.equal(meta.costState.total, 0.51)
  assert.deepEqual(records.map((r) => r.out), [602, 303, 41, 102])
  const odd = [
    '', 'null', '5', '"text"', '[]', '{', '{"type":"assistant"}', '{"type":"assistant","message":5}',
    '{"type":"assistant","message":{"id":"x0","usage":7,"content":[null,3,{"type":"tool_use"}]}}',
    '{"type":"assistant","message":{"id":"x1","model":"claude-opus-4-7","usage":{},"content":[null,3,{"type":"tool_use"}]}}',
    '{"type":"user"}', '{"type":"user","message":{"content":[null,5,{"type":"tool_result"}]}}',
    '{"type":"system"}', '{"type":"system","subtype":"init","cwd":7}',
    '{"type":"result"}', '{"type":"result","modelUsage":"text","total_cost_usd":"much"}', '{"type":"result","modelUsage":{"m":null,"n":7}}',
  ]
  const p = new CoworkParser(LOG)
  assert.doesNotThrow(() => odd.forEach((l) => p.feed(l)))
  for (const l of TURN) p.feed(l)
  assert.deepEqual(p.result().records.map((r) => r.id), ['x1', 'm1', 'm2', 'a1', 'm3'])
})

test('a turn without a result line keeps the output counted at the start of each answer', () => {
  const { records } = parse([
    init(at(0)),
    assistant('m1', at(0, 5), usage(10, 0, 20000, 0, 4), { type: 'text', text: 'One moment.' }),
    // The turn was stopped. The next turn's result line is only for the calls of that turn.
    init(at(5)),
    assistant('m2', at(5, 5), usage(10, 0, 100, 20000, 2), { type: 'text', text: 'Here it is.' }),
    result(at(5, 9), { [OPUS]: modelUsage(10, 50, 20000, 100, 0.1) }, 0.1),
    // A call after the result line and before the next turn belongs to no result line.
    assistant('m3', at(5, 20), usage(10, 0, 100, 20100, 3), { type: 'text', text: 'One more thing.' }),
  ])
  assert.deepEqual(records.map((r) => r.out), [4, 50, 3])
})

test('the call after a summary of the context starts a new context', () => {
  const { records } = parse([
    init(at(0)),
    assistant('m1', at(0, 5), usage(10, 0, 90000, 0, 4), { type: 'text', text: 'Working.' }),
    line(at(1), { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 90000 } }),
    user(at(1, 1), [{ type: 'text', text: 'z'.repeat(5000) }], { isSynthetic: true }),
    assistant('m2', at(1, 5), usage(10, 0, 9000, 0, 4), { type: 'text', text: 'Going on.' }),
    user(at(1, 6), [{ type: 'text', text: 'q'.repeat(700) }], { isSynthetic: true }),
    assistant('m3', at(1, 9), usage(10, 0, 200, 9000, 4), { type: 'text', text: 'Done.' }),
  ])
  assert.deepEqual(records.map((r) => r.ac), [undefined, true, undefined])
  assert.deepEqual(records[1].add, []) // The summary is the new context's start, not something that entered.
  assert.deepEqual(records[2].add, [['(added by the app)', 700]])
  assert.deepEqual(analyze(records).calls.filter((e) => e.miss), [])
})

test("the reader keeps the app's own cost figure, which also counts the calls that no line shows", () => {
  const { records, meta } = parse(TURN)
  assert.equal(meta.costState.total, 0.51)
  assert.deepEqual(Object.keys(meta.costState.models), [OPUS, HAIKU]) // Without the "[1m]" of the long context window.
  assert.equal(meta.costState.models[OPUS].outputTokens, 1007)
  // The small model: 8 input tokens in the one call the log shows, 308 in the app's figure.
  assert.equal(records.filter((r) => r.m === HAIKU).reduce((sum, r) => sum + r.in, 0), 8)
  assert.equal(meta.costState.models[HAIKU].inputTokens, 308)
  assert.equal(parse([init(at(0))]).meta.costState, undefined)
})

const SECOND = join(COWORK, 'account-1', 'workspace-1', 'local_s2', 'audit.jsonl')
function writeLogs() {
  const files = {
    [LOG]: TURN.join('\n'),
    [SECOND]: [init(at(40)), assistant('n1', at(40, 5), usage(10, 0, 20000, 0, 4), { type: 'text', text: 'Hello.' })].join('\n'),
    // None of these is a session log.
    [join(SESSION, 'outputs', 'data.jsonl')]: '{"type":"assistant"}',
    [join(SESSION, 'outputs', 'local_copy', 'audit.jsonl')]: TURN.join('\n'),
    [join(SESSION, '.claude', 'projects', 'folder', 'engine-1.jsonl')]: '{"type":"assistant"}',
    [join(SESSION, 'notes.txt')]: 'not a log',
    [join(COWORK, 'account-1', 'workspace-1', 'stray.jsonl')]: '{"type":"assistant"}',
    [join(COWORK, 'skills-plugin', 'one', 'list.jsonl')]: '{"type":"assistant"}',
  }
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
}

test('only the .jsonl files directly inside a local_ folder are Cowork logs, and nothing under outputs', () => {
  writeLogs()
  assert.equal(coworkDir(), COWORK)
  assert.deepEqual(logFiles().sort((a, b) => a.file.localeCompare(b.file)), [{ file: LOG, source: 'cowork' }, { file: SECOND, source: 'cowork' }])
})

test('the calls of the Cowork logs are loaded with the Cowork reader, also from the cache', async () => {
  writeLogs()
  const first = await load()
  assert.deepEqual(first.records.map((r) => [r.id, r.s, r.out]), [['m1', 'cowork', 602], ['m2', 'cowork', 303], ['a1', 'cowork', 41], ['m3', 'cowork', 102], ['n1', 'cowork', 4]])
  assert.equal(first.metas.get(LOG).costState.total, 0.51)
  // The second time the calls come from the cache, as the JSON that was saved.
  const again = await load()
  assert.deepEqual(again.records, JSON.parse(JSON.stringify(first.records)))
  assert.deepEqual(await load({ sources: ['claude', 'codex'] }), { records: [], metas: new Map() })
})

test('the reports name Cowork, and say that sessions in the cloud are not counted, only when there are Cowork calls', async () => {
  writeLogs()
  const { records } = await load()
  const text = summary(records, { days: 7 })
  assert.match(text, /\n {2}Cowork {2}\$\d+\.\d\d {2}5 calls, .* tokens\n/)
  assert.ok(text.includes(`\n${COWORK_NOTE}\n`))
  assert.equal(COWORK_NOTE, "Cowork sessions that ran in Anthropic's cloud are not on this computer, so they are not counted.")
  const claude = new ClaudeParser('/logs/s1.jsonl')
  claude.feed(JSON.stringify({ type: 'assistant', timestamp: at(0), cwd: '/work/repo', message: { id: 'c1', model: 'claude-opus-5-5', content: [], usage: usage(10, 0, 20000, 0, 100) } }))
  const other = summary(claude.result().records, { days: 7 })
  assert.match(other, /\n {2}Claude Code {2}/)
  assert.equal(other.includes('Cowork'), false)
})

const status = (coworkFolder) => spawnSync(process.execPath, [fileURLToPath(new URL('../cli/kestrel.mjs', import.meta.url)), 'status'], {
  // The command also looks for its link below the home folder: a made-up one, not the real one.
  env: { ...process.env, HOME: join(dir, 'user'), USERPROFILE: join(dir, 'user'), KESTREL_COWORK_DIR: coworkFolder }, encoding: 'utf8',
}).stdout

test('kestrel status counts the Cowork logs', () => {
  writeLogs()
  const text = status(COWORK)
  assert.match(text, /Session logs found +0 of Claude Code, 0 of Codex, 2 of Cowork\n/)
  assert.ok(text.includes(COWORK_NOTE))
  const without = status(join(dir, 'no-such-folder'))
  assert.match(without, /Session logs found +0 of Claude Code, 0 of Codex, 0 of Cowork\n/)
  assert.equal(without.includes(COWORK_NOTE), false)
})

test('no Cowork folder gives no files and no error', async () => {
  process.env.KESTREL_COWORK_DIR = join(dir, 'no-such-folder')
  try {
    assert.deepEqual(logFiles(), [])
    assert.deepEqual((await load()).records, [])
  } finally {
    process.env.KESTREL_COWORK_DIR = COWORK
  }
})

test('without the setting, the Cowork folder is the desktop app\'s folder of sessions that ran on the computer, for each system', () => {
  // The system, the home folder and the environment are given, so the real ones do not count.
  const home = join(dir, 'someone')
  const env = {}
  assert.equal(coworkDir({ platform: 'darwin', home, env }), join(home, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'))
  assert.equal(coworkDir({ platform: 'linux', home, env }), join(home, '.config', 'Claude', 'local-agent-mode-sessions'))
  // Windows names the folder for the data of apps in APPDATA. Without it, it is the usual place below the home folder.
  assert.equal(coworkDir({ platform: 'win32', home, env }), join(home, 'AppData', 'Roaming', 'Claude', 'local-agent-mode-sessions'))
  assert.equal(coworkDir({ platform: 'win32', home, env: { APPDATA: join(dir, 'app-data') } }), join(dir, 'app-data', 'Claude', 'local-agent-mode-sessions'))
  // APPDATA only counts on Windows.
  assert.equal(coworkDir({ platform: 'darwin', home, env: { APPDATA: join(dir, 'app-data') } }), join(home, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'))
  // Any other system gets the same place as Linux.
  assert.equal(coworkDir({ platform: 'freebsd', home, env }), join(home, '.config', 'Claude', 'local-agent-mode-sessions'))
  // The setting wins on every system. An empty one does not count.
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.equal(coworkDir({ platform, home, env: { KESTREL_COWORK_DIR: join(dir, 'set') } }), join(dir, 'set'), platform)
    assert.equal(coworkDir({ platform, home, env: { KESTREL_COWORK_DIR: '' } }), coworkDir({ platform, home, env }), platform)
  }
  // Without arguments it is the folder for this system, or the setting of this run.
  assert.equal(coworkDir(), COWORK)
  assert.ok(coworkDir({ env }).endsWith(join('Claude', 'local-agent-mode-sessions')))
})

test('an answer whose model is not text, or whose usage is not an object, is skipped, and a count that is not a number is 0', () => {
  const good = usage(10, 0, 100, 20000, 2)
  let second = 5
  const answer = (id, message) => line(at(1, second++), {
    type: 'assistant', parent_tool_use_id: null,
    message: { id, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: `tool-${id}`, name: 'Read', input: {} }], ...message },
  })
  const { records } = parse([
    init(at(1)),
    // No model, and a model that is a number, nothing, a list or an object.
    answer('no-model', { usage: good }),
    answer('model-number', { model: 5, usage: good }),
    answer('model-null', { model: null, usage: good }),
    answer('model-list', { model: [OPUS], usage: good }),
    answer('model-object', { model: { id: OPUS }, usage: good }),
    // No usage, and a usage that is a number, a text, a list or nothing.
    answer('no-usage', { model: OPUS }),
    answer('usage-number', { model: OPUS, usage: 7 }),
    answer('usage-text', { model: OPUS, usage: 'much' }),
    answer('usage-list', { model: OPUS, usage: [good] }),
    answer('usage-null', { model: OPUS, usage: null }),
    answer('fine', { model: OPUS, usage: good }),
    // A usage whose counts are not numbers, and whose other values are of another type.
    answer('odd-counts', { model: OPUS, usage: { input_tokens: '10', cache_read_input_tokens: '20000', output_tokens: [5], cache_creation_input_tokens: { n: 1 }, cache_creation: 'none', server_tool_use: { web_search_requests: 'two' }, speed: 5 } }),
    answer('odd-split', { model: OPUS, usage: { input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 4, cache_creation: { ephemeral_5m_input_tokens: '5', ephemeral_1h_input_tokens: true } } }),
  ])
  assert.deepEqual(records.map((r) => r.id), ['fine', 'odd-counts', 'odd-split'])
  assert.deepEqual(tokens(records[0]), [10, 20000, 0, 100, 2, OPUS])
  assert.deepEqual(records.slice(1).map((r) => [r.in, r.cr, r.w5, r.w1, r.out, r.web, r.sp]), [[0, 0, 0, 0, 0, 0, undefined], [1, 2, 0, 0, 3, 0, undefined]])
  // Every value that is kept has the type the analysis counts with.
  for (const r of records) {
    assert.equal(typeof r.m, 'string')
    for (const key of ['in', 'cr', 'w5', 'w1', 'out', 'th', 'web']) assert.equal(typeof r[key], 'number', `${r.id} ${key}`)
  }
  // A skipped line leaves nothing behind: its tool call does not belong to the next call.
  assert.deepEqual(records.map((r) => r.tools.map((t) => t[0])), [['Read'], ['Read'], ['Read']])
  const t = totals(analyze(records).calls)
  assert.ok(Number.isFinite(t.total) && t.total > 0)
})

test('a tool whose name is not text is not kept as a tool call, and its result counts as the result of an unknown tool', () => {
  const good = usage(10, 0, 100, 20000, 2)
  const answer = (id, time, content) => line(time, { type: 'assistant', parent_tool_use_id: null, message: { id, model: OPUS, type: 'message', role: 'assistant', content, usage: good } })
  const { records } = parse([
    init(at(1)),
    // Three tool calls whose name is an object, a number or empty, and one that is fine.
    answer('odd-tools', at(1, 5), [
      { type: 'tool_use', id: 'odd-1', name: { not: 'text' }, input: {} }, { type: 'tool_use', id: 'odd-2', name: 5, input: {} },
      { type: 'tool_use', id: 'odd-3', name: '', input: {} }, { type: 'tool_use', id: 'fine-1', name: 'Read', input: {} },
    ]),
    user(at(1, 6), toolResult('odd-1', 'made-up output')),
    user(at(1, 7), toolResult('fine-1', 'made-up output')),
    answer('next', at(1, 8), [{ type: 'text', text: 'done' }]),
  ])
  assert.deepEqual(records.map((r) => r.tools.map((t) => t[0])), [['Read'], []])
  assert.deepEqual(records[1].add, [['(unknown tool)', 14], ['Read', 14]])
  // So every name that a report prints is text.
  for (const report of [summary(records, { days: 7 }), findings(records, { days: 7 }), models(records, { days: 30 }), session(records, {})]) {
    assert.doesNotMatch(report, /\[object Object\]|undefined|NaN/)
  }
})

test('the lines with an estimate of the thinking are not used: the thinking of a call stays 0', () => {
  const estimate = (second, tokens, delta) => line(at(2, second), { type: 'system', subtype: 'thinking_tokens', estimated_tokens: tokens, estimated_tokens_delta: delta })
  const lines = [
    init(at(2)),
    estimate(1, 400, 400), estimate(2, 900, 500),
    assistant('k1', at(2, 5), usage(10, 0, 20000, 0, 2), { type: 'thinking', thinking: '', signature: 's'.repeat(40) }),
    estimate(6, 300, 300),
    user(at(2, 7), 'go on'),
    assistant('k2', at(2, 9), usage(10, 0, 100, 20000, 2), { type: 'text', text: 'Done.' }),
    result(at(2, 10), { [OPUS]: modelUsage(20, 1000, 20000, 20100, 0.2) }, 0.2),
  ]
  const withEstimates = parse(lines)
  assert.deepEqual(withEstimates.records.map((r) => r.th), [0, 0])
  // The same log without those lines gives the same calls.
  assert.deepEqual(withEstimates, parse(lines.filter((l) => !l.includes('thinking_tokens'))))
})

/** The names of what Object, its prototype and two of its functions hold. A reader that used a name from a log as a key of a plain object would add to them. */
const builtIns = () => [Object, Object.prototype, Object.prototype.toString, Object.prototype.hasOwnProperty].map((o) => Object.getOwnPropertyNames(o).sort())
const ODD_NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty']

test('a model or a tool that is named "__proto__" or "constructor" in a Cowork log is a name like any other', async () => {
  const before = builtIns()
  const lines = [
    init(at(3)),
    ...ODD_NAMES.map((name, i) => assistant(`odd-${i}`, at(3, 5 + i), usage(10, 0, 100, 20000, 2), { type: 'tool_use', id: `odd-tool-${i}`, name, input: {} }, { message: { model: name } })),
    ...ODD_NAMES.map((name, i) => user(at(3, 20 + i), toolResult(`odd-tool-${i}`, 'x'.repeat(100 + i)))),
    assistant('odd-last', at(3, 40), usage(10, 0, 100, 20000, 2), { type: 'text', text: 'Done.' }),
    // The totals of the turn, with each name as a key, twice: once with the mark of the long context window.
    result(at(3, 50), Object.fromEntries([
      ...ODD_NAMES.map((name) => [name, modelUsage(10, 100, 20000, 100, 0.1)]),
      ...ODD_NAMES.map((name) => [`${name}[1m]`, modelUsage(1, 0, 0, 0, 0.01)]),
      [OPUS, modelUsage(10, 50, 20000, 100, 0.1)],
    ]), 0.54),
  ]
  // The made-up log really holds the names as keys.
  assert.ok(lines.at(-1).includes('"__proto__":{') && lines.at(-1).includes('"constructor":{'))
  const { records, meta } = parse(lines)
  assert.deepEqual(builtIns(), before)
  assert.equal({}.inputTokens, undefined)
  assert.deepEqual(records.map((r) => r.m), [...ODD_NAMES, OPUS])
  assert.deepEqual(records.map((r) => r.tools.map((t) => t[0])), [...ODD_NAMES.map((name) => [name]), []])
  assert.deepEqual(records.at(-1).add, ODD_NAMES.map((name, i) => [name, 100 + i]))
  // Each model got the output of its own row of the result line.
  assert.deepEqual(records.map((r) => r.out), [100, 100, 100, 100, 50])
  // The app's figures are kept per name, each as a key of its own.
  const figures = meta.costState.models
  assert.deepEqual(Object.keys(figures), [...ODD_NAMES, OPUS])
  for (const name of ODD_NAMES) {
    assert.ok(Object.hasOwn(figures, name), name)
    assert.deepEqual(figures[name], { inputTokens: 11, outputTokens: 100, cacheReadInputTokens: 20000, cacheCreationInputTokens: 100, webSearchRequests: 0, costUSD: 0.11 }, name)
  }
  assert.equal(meta.costState.total, 0.54)

  // The same through the cache and the reports, in a Cowork folder of its own.
  const folder = join(dir, 'cowork-odd-names')
  const log = join(folder, 'account-1', 'workspace-1', 'local_odd', 'audit.jsonl')
  mkdirSync(dirname(log), { recursive: true })
  writeFileSync(log, lines.join('\n'))
  process.env.KESTREL_COWORK_DIR = folder
  try {
    for (const loaded of [await load(), await load()]) {
      assert.deepEqual(loaded.records.map((r) => r.m), [...ODD_NAMES, OPUS])
      assert.deepEqual(Object.keys(loaded.metas.get(log).costState.models), [...ODD_NAMES, OPUS])
      assert.equal(loaded.metas.get(log).costState.models.__proto__.outputTokens, 100)
      const text = [summary(loaded.records, { days: 7 }), models(loaded.records, { days: 30 }), session(loaded.records, {}), findings(loaded.records, { days: 7 })].join('\n')
      assert.match(text, /^No price is known for __proto__, constructor, toString, hasOwnProperty: 4 calls, /m)
      for (const name of ODD_NAMES) assert.match(text, new RegExp(`^ {2}${name} {2,}\\(not logged\\) {2,}1 {2,}no price$`, 'm'), name)
    }
  } finally {
    process.env.KESTREL_COWORK_DIR = COWORK
  }
  assert.deepEqual(builtIns(), before)
})

test('the readers of Claude Code and Codex take "__proto__" and "constructor" as names like any other too', () => {
  const before = builtIns()
  const counts = { inputTokens: 10, outputTokens: 50, costUSD: 0.1 }
  // Claude Code: the model, a tool, an attachment and the keys of its own cost figure.
  const claude = new ClaudeParser('/logs/odd-names.jsonl')
  ODD_NAMES.forEach((name, i) => {
    // Each call reads 500 tokens more than the one before, so that what entered has a size in the analysis.
    claude.feed(JSON.stringify({ type: 'assistant', timestamp: at(4, i), cwd: '/work/repo', effort: name, message: { id: `c-odd-${i}`, model: name, content: [{ type: 'tool_use', id: `c-tool-${i}`, name, input: {} }], usage: usage(10, 0, 100, 20000 + i * 500, 50) } }))
    claude.feed(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `c-tool-${i}`, content: 'x'.repeat(10) }] } }))
    claude.feed(JSON.stringify({ type: 'attachment', attachment: { type: name, text: 'y' } }))
  })
  claude.feed(JSON.stringify({ type: 'cost-state', totalCostUSD: 0.4, modelUsage: Object.fromEntries(ODD_NAMES.map((name) => [name, counts])) }))
  const fromClaude = claude.result()
  assert.deepEqual(fromClaude.records.map((r) => [r.m, r.tools[0][0], r.ef]), ODD_NAMES.map((name) => [name, name, name]))
  assert.deepEqual(fromClaude.records.slice(1).map((r) => r.add), ODD_NAMES.slice(0, -1).map((name) => [[name, 10]]))
  assert.deepEqual(Object.keys(fromClaude.meta.costState.models), ODD_NAMES)
  assert.deepEqual(fromClaude.meta.costState.models.__proto__, counts)

  // Codex: the model, a tool, and the keys of the plan's limits.
  const codex = new CodexParser('/codex/rollout-odd.jsonl')
  codex.feed(JSON.stringify({ type: 'session_meta', payload: { session_id: 'odd', cwd: '/work/app' } }))
  ODD_NAMES.forEach((name, i) => {
    codex.feed(JSON.stringify({ type: 'turn_context', payload: { model: name, effort: name } }))
    codex.feed(JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name, arguments: '{}', call_id: `k-odd-${i}` } }))
    codex.feed(JSON.stringify({ type: 'token_usage_record', timestamp: at(5, i), payload: { response_id: `r-odd-${i}`, usage: { input_tokens: 1000 + i * 500, cached_input_tokens: 400, output_tokens: 50 } } }))
    codex.feed(JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: `k-odd-${i}`, output: 'abc' } }))
  })
  codex.feed(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { plan_type: 'plus', primary: Object.fromEntries(ODD_NAMES.map((name) => [name, 5])) } } }))
  const fromCodex = codex.result()
  assert.deepEqual(fromCodex.records.map((r) => [r.m, r.tools[0][0], r.ef]), ODD_NAMES.map((name) => [name, name, name]))
  assert.deepEqual(Object.keys(fromCodex.meta.limits), ['plan', ...ODD_NAMES])
  assert.equal(fromCodex.meta.limits.__proto__, 5)

  // The analysis and the reports group by these names without a change to any object of the run.
  const records = [...fromClaude.records, ...fromCodex.records]
  const { calls, blocks } = analyze(records)
  assert.equal(calls.length, 8)
  // The result of a tool enters the context at the next call, so the last name has no piece of its own.
  assert.deepEqual([...new Set(blocks.map((b) => b.label))].filter((label) => ODD_NAMES.includes(label)), ODD_NAMES.slice(0, -1))
  const text = [summary(records, { days: 7 }), models(records, { days: 30 }), session(records, { id: 'odd' }), findings(records, { days: 7 })].join('\n')
  for (const name of ODD_NAMES) assert.match(text, new RegExp(`^ {2}${name} {2,}${name} {2,}2 {2,}no price$`, 'm'), name)
  assert.deepEqual(builtIns(), before)
  assert.equal({}.inputTokens, undefined)
})
