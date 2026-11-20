// Runs one of Widal.Code's hooks for a benchmark session, and notes how long it took.
//
//   node bench/hook.mjs <hook name> <log file>
//
// Claude Code starts this file as the hook command of the arm with Widal.Code on. It passes the
// hook's input on to "widal hook <name> --plugin", prints what the hook prints, and adds one line
// to the log: the name, the milliseconds, and how many characters the hook printed. The
// environment (WIDAL_HOME, CLAUDE_CONFIG_DIR, HOME) is set by the hook command, so the hook reads
// the benchmark's settings and never the person's own.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { WIDAL } from './lib.mjs'

const [name, log] = process.argv.slice(2)
let input = ''
try {
  input = readFileSync(0, 'utf8')
} catch {
  // No input.
}
const start = process.hrtime.bigint()
const r = spawnSync(process.execPath, [WIDAL, 'hook', name, '--plugin'], { input, encoding: 'utf8', env: process.env })
const ms = Number(process.hrtime.bigint() - start) / 1e6
const printed = r.stdout ?? ''
try {
  appendFileSync(log, `${JSON.stringify({ at: Date.now(), hook: name, ms: Math.round(ms), printed: printed.length, status: r.status })}\n`)
} catch {
  // The log is not worth a failed hook.
}
process.stdout.write(printed)
