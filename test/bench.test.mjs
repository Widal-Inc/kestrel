// The benchmark's tasks (bench/): each task is open at the start, and its reference solution
// closes it. So a task that an agent does not close is the agent's miss, not a broken check.
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { score, startState } from '../bench/score.mjs'
import { TASKS } from '../bench/tasks.mjs'

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
