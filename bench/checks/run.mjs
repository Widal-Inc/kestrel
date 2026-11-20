// Runs the hidden checks of one task on a project folder, and prints the result as one line of JSON.
//
//   node bench/checks/run.mjs <task id> <project folder> <folder of the project as it started>
//
// The checks run in this process of their own, because they load code that an agent wrote. The
// caller ends the process when it takes too long.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [id, dir, start] = process.argv.slice(2)

/** What a check gets: the folders, and ways to load the project's code and to run its command line. */
const ctx = {
  dir,
  start,
  /** A module of the project, such as "src/csv.mjs". */
  load: (file) => import(pathToFileURL(join(dir, file)).href),
  /** The same module of the project as it started. */
  loadStart: (file) => import(pathToFileURL(join(start, file)).href),
  /** Runs the project's command line. `tz` sets the time zone of the process. */
  cli: (args, { tz, from = dir, timeout = 10_000 } = {}) => {
    const env = { ...process.env }
    if (tz) env.TZ = tz
    const began = Date.now()
    const r = spawnSync(process.execPath, [join(from, 'src', 'cli.mjs'), ...args], { encoding: 'utf8', cwd: from, env, timeout, maxBuffer: 64e6 })
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ms: Date.now() - began }
  },
  /** Runs a line of JavaScript in a process of its own in a time zone, and gives what it prints. */
  inZone: (tz, code) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', cwd: dir, env: { ...process.env, TZ: tz }, timeout: 10_000 })
    if (r.status !== 0) throw new Error(`the code failed in ${tz}: ${(r.stderr ?? '').trim().split('\n').pop()}`)
    return r.stdout.trim()
  },
  read: (file) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : undefined),
  readStart: (file) => readFileSync(join(start, file), 'utf8'),
  /** The files that differ from the start, as the caller found them. */
  changed: JSON.parse(process.env.BENCH_CHANGED ?? '[]'),
  assert,
}

const { default: checks } = await import(new URL(`./${id}.mjs`, import.meta.url).href)
const results = []
for (const [name, check] of checks) {
  let timer
  try {
    await Promise.race([
      check(ctx),
      new Promise((_, no) => {
        timer = setTimeout(() => no(new Error('took longer than 20 seconds')), 20_000)
      }),
    ])
    results.push({ name, ok: true })
  } catch (e) {
    results.push({ name, ok: false, why: String(e?.message ?? e).split('\n')[0].slice(0, 200) })
  } finally {
    clearTimeout(timer)
  }
}
console.log(`\n@@RESULT ${JSON.stringify(results)}`)
process.exit(0)
