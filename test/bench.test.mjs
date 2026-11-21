// The benchmark's tasks (bench/): each task is open at the start, and its reference solution
// closes it. So a task that an agent does not close is the agent's miss, not a broken check.
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ARMS } from '../bench/arms.mjs'
import { publicRecord, taskHash } from '../bench/record.mjs'
import { score, startState } from '../bench/score.mjs'
import { TASKS, taskOf } from '../bench/tasks.mjs'

const BENCH = fileURLToPath(new URL('../bench/', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'widal-code-bench-test-'))

for (const task of TASKS) {
  test(`task ${task.id} (${task.slug}): open at the start, closed by its reference solution`, () => {
    const start = join(dir, `${task.id}-start`)
    startState(task, start)
    const before = score(task.id, start)
    assert.equal(before.total, task.checks, 'the number of checks in bench/tasks.mjs')
    assert.equal(before.closed, false)
    assert.equal(before.testsPass, true, 'the tests of the start pass at the start')
    assert.deepEqual(before.changed, [])

    const solved = join(dir, `${task.id}-solved`)
    startState(task, solved)
    const solution = join(BENCH, 'solutions', task.checksOf ?? task.id)
    assert.ok(existsSync(solution), 'the task has a reference solution')
    cpSync(solution, solved, { recursive: true })
    const after = score(task.id, solved)
    assert.deepEqual(after.checks.filter((c) => !c.ok), [])
    assert.equal(after.testsPass, true)
    assert.equal(after.closed, true)
    assert.equal(after.quality, 1)
  })
}

test('the task ids, numbers and branch names are all different, and each prompt is there', () => {
  assert.equal(new Set(TASKS.map((t) => t.id)).size, TASKS.length)
  assert.equal(new Set(TASKS.map((t) => t.number)).size, TASKS.length)
  for (const task of TASKS) {
    assert.match(task.slug, /^[a-z0-9-]+$/)
    assert.ok(task.prompt.length > 100)
    assert.ok(task.minutes > 0)
  }
})

test('the arms have different ids and numbers, and an arm names only tasks that are there', () => {
  assert.equal(new Set(ARMS.map((a) => a.id)).size, ARMS.length)
  assert.equal(new Set(ARMS.map((a) => a.number)).size, ARMS.length)
  for (const arm of ARMS) for (const id of arm.only ?? []) assert.ok(taskOf(id))
  // An arm that runs only some tasks is never part of a run that names no arms.
  for (const arm of ARMS) if (arm.only) assert.equal(arm.extra, true)
})

// A run record as bench/run.mjs writes it, with text in every place that must not be shared.
const SECRET = 'do-not-share'
const runRecord = () => ({
  arm: 'fable-xhigh', task: 't1', taskNumber: 1, rep: 2, ticket: `ABC-${SECRET}`, branch: `user/${SECRET}`, cwd: `/Users/${SECRET}/w/ledger`,
  setup: { claudeCode: '2.1.329', widalCode: '0.3.1', node: 'v24.11.1', platform: 'darwin arm64', paired: true, armsSideBySide: 4 },
  settings: { model: 'claude-fable-5-2', effortLevel: 'xhigh', env: { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5-5', OTHER: SECRET }, other: SECRET },
  started: '2026-11-21T18:00:00.000Z', wallMs: 38812, exit: 0, timedOut: false,
  claude: {
    cost: 0.34, durationMs: 38000, apiMs: 37400, turns: 7, session: SECRET, isError: false, subtype: 'success', usage: { note: SECRET },
    modelUsage: { 'claude-fable-5-2': { inputTokens: 10, outputTokens: 3332, thinkingTokens: 948, cacheReadInputTokens: 107538, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 11719, costUSD: 0.34, provider: SECRET } },
    denials: [`Bash: cat /Users/${SECRET}`],
  },
  stderr: SECRET,
  score: { task: 't1', checks: [{ name: SECRET, ok: false, why: SECRET }], passed: 9, total: 10, quality: 0.9, testsPass: true, changed: [`src/${SECRET}.mjs`], closed: false },
})

test('the record of a run that may be shared holds numbers, ids and versions, and no other text', () => {
  const record = publicRecord(runRecord())
  assert.ok(!JSON.stringify(record).includes(SECRET))
  assert.deepEqual(Object.keys(record), ['v', 'taskSet', 'task', 'taskHash', 'byHandMinutes', 'arm', 'round', 'day', 'settings', 'setup', 'outcome', 'cost', 'wallSeconds', 'apiSeconds', 'turns', 'refused', 'models'])
  assert.deepEqual(record.settings, { model: 'claude-fable-5-2', effort: 'xhigh', subagentModel: 'claude-sonnet-5-5', bashOutputMaxChars: null, widalCodeHooks: false })
  assert.deepEqual(record.setup, { claudeCode: '2.1.329', widalCode: '0.3.1', node: 'v24.11.1', platform: 'darwin arm64', paired: true, armsSideBySide: 4 })
  assert.deepEqual(record.outcome, { closed: false, passed: 9, total: 10, testsPass: true, timedOut: false })
  assert.equal(record.day, '2026-11-21')
  assert.equal(record.wallSeconds, 38.8)
  assert.equal(record.refused, 1)
  assert.deepEqual(record.models, [{ model: 'claude-fable-5-2', in: 10, out: 3332, thinking: 948, cacheRead: 107538, cacheWrite5m: 0, cacheWrite1h: 11719, cost: 0.34 }])
  // Every text in the record is one of these few, each with a strict form.
  const texts = []
  const walk = (value) => (typeof value === 'string' ? texts.push(value) : value && typeof value === 'object' ? Object.values(value).forEach(walk) : undefined)
  walk(record)
  for (const value of texts) assert.match(value, /^[A-Za-z0-9][A-Za-z0-9.:+ _-]{0,79}$/)
})

test('a run with a text in the wrong form gives no record', () => {
  const path = runRecord()
  path.settings.model = '/Users/someone/model'
  assert.throws(() => publicRecord(path), /settings\.model/)
  const version = runRecord()
  version.setup.claudeCode = 'a version with words in it'
  assert.throws(() => publicRecord(version), /setup\.claudeCode/)
  const model = runRecord()
  model.claude.modelUsage = { 'a model\nwith a line break': {} }
  assert.throws(() => publicRecord(model), /models\.model/)
})

test('the hash of a task changes with its issue text, and is the same when asked twice', () => {
  const task = taskOf('t1')
  assert.match(taskHash(task), /^[0-9a-f]{16}$/)
  assert.equal(taskHash(task), taskHash(task))
  assert.notEqual(taskHash({ ...task, id: 't1-other-text', checksOf: 't1', prompt: `${task.prompt} More.` }), taskHash(task))
  assert.notEqual(taskHash(taskOf('t2')), taskHash(taskOf('s2')), 'a task with another start of the project is another test')
})
