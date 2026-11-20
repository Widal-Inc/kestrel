// Scores what an agent left in a project folder for one task.
//
// A task is closed when every hidden check passes and the tests that the project had at the start
// still pass. The quality score is the share of hidden checks that pass.
//
//   node bench/score.mjs <task id> <project folder>
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { taskOf } from './tasks.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
/** Folders that are not part of the work: git's own, packages, Claude Code's settings, and a cache that a plugin of the person's own agent can leave. */
const SKIP = new Set(['.git', 'node_modules', '.claude', '.impeccable'])
const kept = (path) => !SKIP.has(path.split('/').pop())

/** The files of a folder, as paths from its root. */
function files(root, dir = root) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name === '.DS_Store') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...files(root, path))
    else out.push(relative(root, path))
  }
  return out.sort()
}

/**
 * Puts the project as a task starts with it into a folder: the sample project, then the files of
 * the task's variant, then the task's edits (each one a file, a text in it, and the text to put there).
 */
export function startState(task, into) {
  cpSync(join(HERE, 'project'), into, { recursive: true, filter: kept })
  if (task.variant) cpSync(join(HERE, 'variants', task.variant), into, { recursive: true, filter: kept })
  for (const [file, from, to] of task.edits ?? []) {
    const text = readFileSync(join(into, file), 'utf8')
    if (!text.includes(from)) throw new Error(`task ${task.id}: ${file} does not hold the text that the task's edit replaces`)
    writeFileSync(join(into, file), text.replace(from, to))
  }
}

/** The files that are new, gone or different in `dir` against `start`. */
export function changedFiles(dir, start) {
  const now = new Set(files(dir))
  const before = new Set(files(start))
  const same = (file) => readFileSync(join(dir, file)).equals(readFileSync(join(start, file)))
  return [...new Set([...now, ...before])].filter((file) => !now.has(file) || !before.has(file) || !same(file)).sort()
}

/**
 * The score of a project folder for a task.
 * @returns {{task: string, checks: {name: string, ok: boolean, why?: string}[], passed: number, total: number, quality: number, testsPass: boolean, changed: string[], closed: boolean}}
 */
export function score(taskId, dir) {
  const task = taskOf(taskId)
  const temp = mkdtempSync(join(tmpdir(), 'widal-bench-score-'))
  try {
    const start = join(temp, 'start')
    const copy = join(temp, 'copy')
    startState(task, start)
    cpSync(dir, copy, { recursive: true, filter: kept })
    const changed = changedFiles(copy, start)

    // The tests of the start, on the agent's code. The agent's own changes to the tests do not count here.
    for (const file of files(join(start, 'test'))) cpSync(join(start, 'test', file), join(copy, 'test', file))
    // Without NODE_TEST_CONTEXT: under "node --test" that variable makes a second test run skip every file and report success.
    const { NODE_TEST_CONTEXT: _, ...env } = process.env
    const tests = spawnSync(process.execPath, ['--test', ...files(join(start, 'test')).map((file) => join('test', file))], { cwd: copy, encoding: 'utf8', timeout: 60_000, env })

    const run = spawnSync(process.execPath, [join(HERE, 'checks', 'run.mjs'), task.checksOf ?? task.id, copy, start], {
      encoding: 'utf8', timeout: 120_000, env: { ...process.env, BENCH_CHANGED: JSON.stringify(changed) },
    })
    const line = (run.stdout ?? '').split('\n').findLast((l) => l.startsWith('@@RESULT '))
    // Checks that never answered (the code hung or broke the process) all count as failed.
    const checks = line ? JSON.parse(line.slice('@@RESULT '.length)) : Array.from({ length: task.checks }, (_, i) => ({ name: `check ${i + 1}`, ok: false, why: 'the checks did not finish' }))
    const passed = checks.filter((c) => c.ok).length
    const testsPass = tests.status === 0
    return { task: task.id, checks, passed, total: checks.length, quality: checks.length ? passed / checks.length : 0, testsPass, changed, closed: passed === checks.length && testsPass }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [id, dir] = process.argv.slice(2)
  if (!id || !dir || !existsSync(dir)) {
    console.error('usage: node bench/score.mjs <task id> <project folder>')
    process.exit(1)
  }
  console.log(JSON.stringify(score(id, dir), null, 2))
}
