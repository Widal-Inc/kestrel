// Tests with small made-up session logs. Run: node --test
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

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

const { cost, priceOf } = await import('../src/prices.mjs')
const { ClaudeParser } = await import('../src/parse-claude.mjs')
const { CodexParser } = await import('../src/parse-codex.mjs')
const { analyze, totals } = await import('../src/analyze.mjs')
const { limitHook, saveConfig, statusLine } = await import('../src/claude-code.mjs')
const { installStatusLine, installed, setHook, uninstall } = await import('../src/install.mjs')

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`)

test('the price table gives the cost that Claude Code itself saved for the same tokens', () => {
  // Token counts and cost of one model in a real session, as Claude Code wrote them: $82.5528.
  const c = cost({ m: 'claude-opus-5-5', in: 22043, w5: 777188, w1: 3462881, cr: 178025541, out: 763525, th: 149970, web: 0 })
  near(c.total, 82.55276819999997, 1e-6)
  // The same session's Claude Haiku 5.5 figure, $0.4999, is its tokens at the short-prompt price plus
  // 37 web searches at one cent. Here as 37 equal calls, each under 100,000 tokens.
  const part = cost({ m: 'claude-haiku-5-5', in: 775058 / 37, w5: 58487 / 37, w1: 0, cr: 27379 / 37, out: 89679 / 37, th: 0, web: 1 })
  near(part.total * 37, 0.499929965, 1e-6)
  // Above 100,000 prompt tokens that model costs five times as much.
  near(cost({ m: 'claude-haiku-5-5', in: 150000, w5: 0, w1: 0, cr: 0, out: 0 }).total, 0.075)
})

test('a model id with a date or a provider prefix finds its price, and an unknown model has none', () => {
  assert.equal(priceOf('claude-sonnet-4-5-20250929').in, 3)
  assert.equal(priceOf('us.anthropic.claude-opus-5-5').out, 20)
  assert.equal(priceOf('some-new-model'), undefined)
  assert.equal(cost({ m: 'some-new-model', in: 1, w5: 0, w1: 0, cr: 0, out: 1 }).known, false)
  // OpenAI: cached input at its own price, and twice the input price above 272,000 input tokens.
  near(cost({ m: 'gpt-6-astra', in: 1e6, w5: 0, w1: 0, cr: 1e6, out: 1e6 }).total, 20 + 2 + 75)
  near(cost({ m: 'gpt-5.6-sol', in: 1000, w5: 1000, w1: 0, cr: 1000, out: 1000 }).total, (4 + 5 + 0.4 + 20) / 1000)
})

const assistant = (id, ts, usage, content = [], extra = {}) => JSON.stringify({
  type: 'assistant', timestamp: ts, cwd: '/work/repo', sessionId: 's1', ...extra,
  message: { id, model: 'claude-opus-5-5', role: 'assistant', content, usage },
})
const toolResult = (toolUseId, text) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] } })
const usage = (inp, w1, cr, out, th = 0) => ({
  input_tokens: inp, cache_creation_input_tokens: w1, cache_read_input_tokens: cr, output_tokens: out,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: w1 }, output_tokens_details: { thinking_tokens: th },
})

function parsed(lines, file = '/logs/s1.jsonl') {
  const p = new ClaudeParser(file)
  for (const l of lines) p.feed(l)
  return p.result().records
}

test('a Claude Code message with several lines is one model call, with its tool results as what entered', () => {
  const records = parsed([
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix the bug' }, cwd: '/work/repo' }),
    assistant('m1', '2026-11-12T10:00:00Z', usage(10, 20000, 0, 100), [{ type: 'text', text: 'ok' }]),
    assistant('m1', '2026-11-12T10:00:01Z', usage(10, 20000, 0, 300), [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
    toolResult('t1', 'x'.repeat(3600)),
    JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', text: 'y'.repeat(9000) } }),
    assistant('m2', '2026-11-12T10:00:10Z', usage(5, 1400, 20000, 50)),
  ])
  assert.equal(records.length, 2)
  assert.equal(records[0].out, 300)
  assert.deepEqual(records[0].tools.map((t) => t[0]), ['Bash'])
  assert.deepEqual(records[0].add, [['(your messages)', 11]])
  // The hook's record is bookkeeping, not context. The result carries the signature of its call and
  // the program of the shell command, never the command.
  assert.deepEqual(records[1].add, [['Bash', 3600, records[0].tools[0][1], 'ls']])
  assert.equal(new ClaudeParser('/p/abc/subagents/workflows/wf1/agent-7.jsonl').session, 'abc')
})

test('every dollar of input is assigned to carrying old context or to new context', () => {
  const { calls, blocks } = analyze(parsed([
    assistant('m1', '2026-11-12T10:00:00Z', usage(10, 20000, 0, 300), [{ type: 'tool_use', id: 't1', name: 'Read', input: { f: 1 } }]),
    toolResult('t1', 'x'.repeat(36000)),
    assistant('m2', '2026-11-12T10:00:10Z', usage(5, 10100, 20010, 200)),
    assistant('m3', '2026-11-12T10:00:20Z', usage(5, 300, 30115, 100)),
  ]))
  const t = totals(calls)
  near(t.carried + t.fresh + t.out, t.total)
  // The file that was read: 10,105 new tokens minus the model's 300 tokens of earlier output.
  const read = blocks.find((b) => b.label === 'Read')
  near(read.tokens, 10105 - 300, 1)
  assert.equal(read.carriedCalls, 1)
  near(read.carry, read.tokens * 0.2e-6, 1e-7) // Carried once, at the cache read price.
  // The sum over all blocks is the whole input side.
  near(blocks.reduce((n, b) => n + b.entry + b.carry, 0), t.carried + t.fresh)
})

test('a call after a long break that reads nothing from the cache is a lost cache, with its cost', () => {
  const { calls } = analyze(parsed([
    assistant('m1', '2026-11-12T10:00:00Z', usage(10, 100000, 0, 300)),
    assistant('m2', '2026-11-12T12:30:00Z', usage(10, 100400, 0, 100)),
  ]))
  assert.equal(calls[1].miss, 'idle for over 1 hour')
  near(calls[1].waste, 100010 * (8e-6 - 0.2e-6), 1e-3) // The whole earlier context, written again instead of read.
})

test('a Codex log gives one call per usage record, with cached input taken out of input', () => {
  const p = new CodexParser('/codex/rollout-1.jsonl')
  for (const l of [
    { type: 'session_meta', payload: { session_id: 'c1', cwd: '/work/app' } },
    { type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'high' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'k1' } },
    { type: 'token_usage_record', timestamp: '2026-09-01T10:00:00Z', payload: { response_id: 'r1', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 20 } } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'k1', output: 'abc' } },
    { type: 'token_usage_record', timestamp: '2026-09-01T10:00:05Z', payload: { response_id: 'r2', usage: { input_tokens: 1100, cached_input_tokens: 1000, output_tokens: 10, reasoning_output_tokens: 0 } } },
  ]) p.feed(JSON.stringify(l))
  const [a, b] = p.result().records
  assert.deepEqual([a.in, a.cr, a.out, a.th, a.m, a.ses], [600, 400, 50, 20, 'gpt-6-astra', 'c1'])
  assert.deepEqual(a.tools.map((t) => t[0]), ['shell'])
  assert.deepEqual(b.add, [['shell', 3]])
})

test('the status line shows the plan\'s limit, the cache and the context, and the hook holds the limit', () => {
  const now = Date.parse('2026-11-12T12:00:00')
  const input = {
    session_id: 'sess-1', model: { id: 'claude-opus-5-5' },
    cost: { total_cost_usd: 12.5, total_duration_ms: 60000 },
    context_window: { used_percentage: 40, current_usage: { input_tokens: 10, cache_creation_input_tokens: 990, cache_read_input_tokens: 399000 } },
    rate_limits: { five_hour: { used_percentage: 33 } },
  }
  // The first part has a colour, unless NO_COLOR is set where the tests run. The codes of the colour are not checked here.
  assert.match(statusLine(input, now, { layout: 'one' }), /^\S*5 hour limit 33% used\S* \| context 400k \(40%\)$/)
  assert.equal(limitHook({ session_id: 'sess-1' }, now), undefined) // No limit set.
  // Claude Code also says until when the cache lasts. After that the next call sends the 400,000 tokens again.
  const warm = { ...input, session_id: 'sess-2', prompt_cache: { warm: true, ttl: '1h', expires_at: (now + 30 * 60e3) / 1000 } }
  assert.match(statusLine(warm, now, { layout: 'one' }), /cache warm, 30 min left/)
  const gone = { ...input, session_id: 'sess-2', prompt_cache: { warm: false, ttl: '5m', expires_at: (now - 60e3) / 1000 } }
  assert.match(statusLine(gone, now, { layout: 'one' }), /cache gone: the next call re-sends 400k/)
  statusLine({ ...input, session_id: 'sess-2', cost: { total_cost_usd: 0, total_duration_ms: 1 } }, now, { layout: 'one' }) // Leaves today's total as it was.

  saveConfig({ limits: { session: 10, action: 'ask' } })
  const ask = limitHook({ session_id: 'sess-1' }, now)
  assert.equal(ask.hookSpecificOutput.permissionDecision, 'ask')
  assert.match(ask.hookSpecificOutput.permissionDecisionReason, /spent \$12\.50, and its limit is \$10\.00/)
  assert.equal(limitHook({ session_id: 'sess-1' }, now), undefined) // Asked once: not again until the spend has grown.
  statusLine({ ...input, cost: { total_cost_usd: 14, total_duration_ms: 90000 } }, now, { layout: 'one' })
  assert.ok(limitHook({ session_id: 'sess-1' }, now)) // $1.50 more is over a tenth of the limit: ask again.

  saveConfig({ limits: { day: 5, action: 'stop' } })
  const stop = limitHook({ session_id: 'sess-1' }, now)
  assert.equal(stop.continue, false)
  assert.equal(stop.hookSpecificOutput.permissionDecision, 'deny') // Without this, the tool call still runs before the stop.
  assert.match(stop.stopReason, /today's spend is \$14\.00/)
  // The day's limit also holds for a session the status line has not seen yet.
  assert.equal(limitHook({ session_id: 'never-seen' }, now).continue, false)
  saveConfig({ limits: { session: 10, action: 'stop' } })
  assert.equal(limitHook({ session_id: 'never-seen-2' }, now), undefined) // No figure of its own, and no day limit.
})

test('install keeps the other settings and hooks, saves a copy first, and uninstall takes it out again', () => {
  const file = join(process.env.CLAUDE_CONFIG_DIR, 'settings.json')
  writeFileSync(file, JSON.stringify({ theme: 'dark', hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: '/x/auto-allow.sh' }] }] } }))
  installStatusLine('/bin/kestrel')
  setHook('/bin/kestrel', true)
  setHook('/bin/kestrel', true) // Twice adds it once.
  let s = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(s.theme, 'dark')
  assert.equal(s.statusLine.command, '/bin/kestrel statusline')
  assert.deepEqual(s.hooks.PreToolUse.map((m) => m.hooks[0].command), ['/x/auto-allow.sh', '/bin/kestrel hook'])
  assert.deepEqual(installed(), { statusLine: true, otherStatusLine: undefined, hook: true, refresh: 30 })
  assert.equal(uninstall(), true)
  s = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(s.statusLine, undefined)
  assert.deepEqual(s.hooks.PreToolUse.map((m) => m.hooks[0].command), ['/x/auto-allow.sh'])

  writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'other-tool' } }))
  assert.match(installStatusLine('/bin/kestrel'), /already has a status line/)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).statusLine.command, 'other-tool')
})

const { proposals, measureCache } = await import('../src/advise.mjs')
const { apply: applyAction, undo: undoAction, applied: appliedActions } = await import('../src/actions.mjs')
const { modelSwitchHook } = await import('../src/claude-code.mjs')

/** A subagent that waits 10 minutes between two calls and loses its 5 minute cache. */
const waitingSubagent = (wrote) => parsed([
  assistant('a1', '2026-11-12T10:00:00Z', { ...usage(10, 0, 0, 300), cache_creation_input_tokens: 100000, cache_creation: wrote === '1h' ? { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100000 } : { ephemeral_5m_input_tokens: 100000, ephemeral_1h_input_tokens: 0 } }),
  assistant('a2', '2026-11-12T10:10:00Z', wrote === '1h'
    ? { ...usage(10, 400, 100010, 100) }
    : { ...usage(10, 0, 0, 100), cache_creation_input_tokens: 100400, cache_creation: { ephemeral_5m_input_tokens: 100400, ephemeral_1h_input_tokens: 0 } }),
], '/logs/s9/subagents/agent-1.jsonl')

test('a replay says what a 1 hour cache for subagents would have saved, and what it would have cost more', () => {
  const p = proposals(waitingSubagent('5m'))
  const cache = p.list.find((x) => x.id === 'subagent-cache-1h')
  // The 100,010 tokens that were written again would have been read: 100,010 x ($5.00 - $0.20) per million.
  // The first write of 100,000 tokens and the 390 new tokens of the second call cost $3 per million more.
  near(cache.saving, (100010 * 4.8 - 100390 * 3) / 1e6, 1e-6)
  assert.equal(cache.apply, true)
  // Keeping the cache alive: two reads of the context instead of the rewrite.
  near(p.list.find((x) => x.id === 'subagent-check-in').saving, (100010 * 4.8 - 2 * 100010 * 0.2) / 1e6, 1e-4)
  // A session with no subagents and no long context has none of those proposals. It is one short
  // session that only answers, on a model above Sonnet 5.5: the one proposal is a cheaper model for
  // new sessions in its folder.
  assert.deepEqual(proposals(parsed([assistant('m1', '2026-11-12T10:00:00Z', usage(10, 20000, 0, 300))])).list.map((x) => x.id), ['project-model'])
})

test('before and after a change: the share of 1 hour writes and the lost caches per 1,000 subagent calls', () => {
  const before = waitingSubagent('5m')
  const after = waitingSubagent('1h').map((r, i) => ({ ...r, id: `later-${i}`, f: '/logs/s9/subagents/agent-2.jsonl', ts: r.ts + 86400e3 }))
  const m = measureCache([...before, ...after], Date.parse('2026-11-13T00:00:00Z'))
  assert.deepEqual([m.before.calls, m.before.hour, m.before.lost], [2, 0, 500])
  assert.deepEqual([m.after.calls, m.after.hour, m.after.lost], [2, 1, 0])
})

test('apply changes one setting and remembers what was there, and undo puts that back', () => {
  const file = join(process.env.CLAUDE_CONFIG_DIR, 'settings.json')
  const settings = () => JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ theme: 'dark', subagentPromptCacheTtl: '5m', hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: '/x/auto-allow.sh' }] }] } }))
  assert.match(applyAction('subagent-cache-1h', '/bin/kestrel').join('\n'), /undo subagent-cache-1h/)
  assert.equal(settings().subagentPromptCacheTtl, '1h')
  assert.deepEqual(applyAction('subagent-cache-1h', '/bin/kestrel'), ['subagent-cache-1h is already applied.'])
  applyAction('model-switch-cost', '/bin/kestrel')
  assert.equal(settings().hooks.PreModelSwitch[0].hooks[0].command, '/bin/kestrel hook model-switch')
  assert.deepEqual(Object.keys(appliedActions()).sort(), ['model-switch-cost', 'subagent-cache-1h'])
  undoAction('subagent-cache-1h', '/bin/kestrel')
  assert.equal(settings().subagentPromptCacheTtl, '5m') // What was there before, not just "gone".
  undoAction('model-switch-cost', '/bin/kestrel')
  assert.equal(settings().hooks.PreModelSwitch, undefined)
  assert.deepEqual(settings().hooks.PreToolUse.map((m) => m.hooks[0].command), ['/x/auto-allow.sh'])
  assert.equal(settings().theme, 'dark')
  assert.match(undoAction('subagent-cache-1h', '/bin/kestrel')[0], /was not applied by this tool/)
  assert.throws(() => applyAction('no-such-thing', '/bin/kestrel'), /There is no action/)
})

test('the hook before a change of model asks when it can, shows the cost when it cannot, and is silent when the cache is gone', () => {
  const input = { from_model: 'claude-fable-5-2', to_model: 'claude-opus-5-5', source: 'command', context_tokens: 483000, prompt_cache_warm: true, estimated_cache_write_usd: 3.864, pricing: 'catalog' }
  const terminal = { CLAUDE_CODE_ENTRYPOINT: 'cli' }
  const ask = modelSwitchHook(input, terminal)
  assert.equal(ask.hookSpecificOutput.hookEventName, 'PreModelSwitch')
  assert.equal(ask.hookSpecificOutput.permissionDecision, 'ask')
  assert.match(ask.hookSpecificOutput.permissionDecisionReason, /483k tokens\) to the new model again\. That costs about \$3\.86 \(at list prices\)\. Switch anyway\?/)
  // Claude Code can only ask for /model with a name. For the picker an "ask" would count as a refusal.
  assert.deepEqual(Object.keys(modelSwitchHook({ ...input, source: 'picker' }, terminal)), ['systemMessage'])
  // In a run without a person (seen live: the entry point is "sdk-cli") an "ask" would refuse the switch.
  assert.deepEqual(Object.keys(modelSwitchHook(input, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })), ['systemMessage'])
  assert.deepEqual(Object.keys(modelSwitchHook({ ...input, estimated_cache_write_usd: 0.2 }, terminal)), ['systemMessage'])
  assert.equal(modelSwitchHook({ ...input, prompt_cache_warm: false }, terminal), undefined)
  assert.equal(modelSwitchHook({ ...input, estimated_cache_write_usd: 0.01 }, terminal), undefined)
  assert.equal(modelSwitchHook({}, terminal), undefined)
})
