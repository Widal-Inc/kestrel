// The check before a subagent starts (src/load-gate.mjs): it lets a subagent start while the
// computer has room, waits in a queue while it is busy, and refuses the start when it stays busy.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'widal-code-load-gate-test-')))
process.env.HOME = join(dir, 'person')
process.env.WIDAL_HOME = join(dir, 'home')
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
mkdirSync(process.env.HOME, { recursive: true })
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[/\\]$/, '')

const gate = await import('../src/load-gate.mjs')

/** A made-up clock and sleep: a sleep moves the clock on at once. */
function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, wait: async (ms) => { t += ms }, add: (ms) => { t += ms } }
}

/** A measurement that gives the loads in turn, and the last one after that. */
function loads(...list) {
  let i = 0
  const look = async () => list[Math.min(i++, list.length - 1)]
  look.calls = () => i
  return look
}

const QUIET = { cpu: 20, memory: 40 }
const BUSY_CPU = { cpu: 97, memory: 40 }
const BUSY_MEMORY = { cpu: 20, memory: 95 }

/** A fresh tool folder for each test, so that the queue's state of one test is not seen by another. */
let n = 0
function fresh() {
  process.env.WIDAL_HOME = join(dir, `home-${n++}`)
}

test('the settings: the defaults, the person\'s valid values, and the defaults again for values out of range', () => {
  assert.deepEqual(gate.gateSettings({}), gate.DEFAULTS)
  assert.deepEqual(gate.gateSettings(null), gate.DEFAULTS)
  assert.deepEqual(gate.gateSettings({ loadGate: { cpu: 80, memory: 70, wait: 30, spacing: 0, on: false } }), { on: false, cpu: 80, memory: 70, wait: 30, spacing: 0 })
  assert.deepEqual(gate.gateSettings({ loadGate: { cpu: 0, memory: 101, wait: gate.MAX_WAIT + 1, spacing: '5' } }), gate.DEFAULTS)
})

test('a quiet computer: the subagent starts without a word', async () => {
  fresh()
  const c = clock()
  assert.equal(await gate.loadGateHook({}, { cfg: {}, ...c, look: loads(QUIET) }), undefined)
})

test('a busy computer that gets room within the wait: the subagent starts, and the agent is told how long it waited', async () => {
  fresh()
  const c = clock()
  const look = loads(BUSY_CPU, BUSY_MEMORY, QUIET)
  const answer = await gate.loadGateHook({}, { cfg: {}, ...c, look })
  assert.equal(look.calls(), 3)
  assert.equal(answer.systemMessage, 'widal: this subagent waited 10s in the queue before it started (CPU 20%, memory 40%).')
})

test('a computer that stays busy: the start is refused with the reason and what to do', async () => {
  fresh()
  const c = clock()
  const answer = await gate.loadGateHook({}, { cfg: { loadGate: { wait: 30 } }, ...c, look: loads({ cpu: 99, memory: 93 }) })
  const out = answer.hookSpecificOutput
  assert.equal(out.hookEventName, 'PreToolUse')
  assert.equal(out.permissionDecision, 'deny')
  assert.match(out.permissionDecisionReason, /^Widal\.Code did not start this subagent: the processors \(CPU\) are 99% busy, and the limit is 90%, and memory \(RAM\) is 93% used, and the limit is 90%, also after a wait of 30s\./)
  assert.match(out.permissionDecisionReason, /Wait until your running subagents have finished, or do this work yourself in this agent/)
})

test('a wait of 0: one measurement, then the answer', async () => {
  fresh()
  const c = clock()
  const look = loads(BUSY_MEMORY)
  const answer = await gate.loadGateHook({}, { cfg: { loadGate: { wait: 0 } }, ...c, look })
  assert.equal(look.calls(), 1)
  assert.equal(answer.hookSpecificOutput.permissionDecision, 'deny')
})

test('turned off: no measurement and no answer', async () => {
  fresh()
  const look = loads(BUSY_CPU)
  assert.equal(await gate.loadGateHook({}, { cfg: { loadGate: { on: false } }, ...clock(), look }), undefined)
  assert.equal(look.calls(), 0)
})

test('two starts close together: the second waits for the spacing, then measures again', async () => {
  fresh()
  const c = clock()
  assert.equal(await gate.loadGateHook({}, { cfg: {}, ...c, look: loads(QUIET) }), undefined)
  c.add(1000)
  const look = loads(QUIET)
  const before = c.now()
  // A wait shorter than 5 seconds is not worth a message.
  assert.equal(await gate.loadGateHook({}, { cfg: {}, ...c, look }), undefined)
  assert.equal(look.calls(), 1)
  assert.equal(c.now() - before, 4000)
  // A longer spacing is.
  c.add(1000)
  const answer = await gate.loadGateHook({}, { cfg: { loadGate: { spacing: 10 } }, ...c, look: loads(QUIET) })
  assert.match(answer.systemMessage, /^widal: this subagent waited 9s in the queue before it started/)
  // With no spacing the second starts at once.
  fresh()
  assert.equal(await gate.loadGateHook({}, { cfg: { loadGate: { spacing: 0 } }, ...c, look: loads(QUIET) }), undefined)
  assert.equal(await gate.loadGateHook({}, { cfg: { loadGate: { spacing: 0 } }, ...c, look: loads(QUIET) }), undefined)
})

test('a lock left by a hook that ended is taken over after 30 seconds, and a fresh one is waited for', async () => {
  fresh()
  const lock = join(process.env.WIDAL_HOME, 'load-gate.lock')
  mkdirSync(lock, { recursive: true })
  const c = clock(Date.now())
  // A fresh lock that stays for the whole wait: nothing is measured, and nothing is known to be over.
  const look = loads(BUSY_CPU)
  assert.equal(await gate.loadGateHook({}, { cfg: { loadGate: { wait: 3 } }, ...c, look }), undefined)
  assert.equal(look.calls(), 0)
  // An old lock is taken over.
  const old = (Date.now() - 60e3) / 1000
  utimesSync(lock, old, old)
  assert.equal(await gate.loadGateHook({}, { cfg: {}, ...clock(Date.now()), look: loads(QUIET) }), undefined)
  assert.equal(existsSync(lock), false)
})

test('input that is not JSON never stops a subagent: the hook command prints nothing and exits 0', () => {
  fresh()
  mkdirSync(process.env.WIDAL_HOME, { recursive: true })
  const r = spawnSync(process.execPath, [join(ROOT, 'cli', 'widal.mjs'), 'hook', 'load-gate'], { encoding: 'utf8', input: 'not json', env: { ...process.env, WIDAL_HOME: process.env.WIDAL_HOME } })
  assert.equal(r.status, 0)
  assert.equal(r.stderr, '')
})

test('memory on a Mac counts free, inactive, speculative and purgeable pages as available', () => {
  // 16384-byte pages. The share of available memory is worked out against the real total, so the test only checks the bounds and that more available pages give a lower figure.
  const vm = (free) => `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               ${free}.\nPages active:                            100.\nPages inactive:                          100.\nPages speculative:                       10.\nPages purgeable:                         5.\n`
  const low = gate.memoryPercent({ platform: 'darwin', vmStat: vm(1000) })
  const high = gate.memoryPercent({ platform: 'darwin', vmStat: vm(10) })
  assert.ok(low >= 0 && low <= 100 && high >= 0 && high <= 100)
  assert.ok(low <= high)
  // Text that is not vm_stat's keeps Node's own figure.
  assert.ok(gate.memoryPercent({ platform: 'darwin', vmStat: 'nonsense' }) >= 0)
})

test('"widal load" shows the load and the limits, keeps a change, and refuses a value out of range', () => {
  fresh()
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, 'cli', 'widal.mjs'), 'load', ...args], { encoding: 'utf8', env: process.env })
  const shown = run()
  assert.equal(shown.status, 0)
  assert.match(shown.stdout, /^Now: CPU \d+% busy, memory \d+% used\.\nA subagent starts while CPU is below 90% and memory below 90%\./)
  const changed = run('--cpu', '75', '--wait', '60')
  assert.match(changed.stdout, /CPU is below 75% and memory below 90%\. Otherwise it waits in a queue for up to 60s/)
  assert.match(run('off').stdout, /The check before a subagent starts is off\./)
  assert.match(run('on').stdout, /CPU is below 75%/)
  const bad = run('--wait', '9999')
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /--wait takes a number from 0 to 140\./)
  writeFileSync(join(process.env.WIDAL_HOME, 'config.json'), 'broken')
  assert.equal(run().status, 0)
})
