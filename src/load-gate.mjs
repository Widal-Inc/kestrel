// The check before a subagent starts: it keeps an agent from starting more subagents than the
// computer can carry.
//
// Claude Code runs the hook "load-gate" before each call of the Agent tool (called Task in older
// versions) and of the Workflow tool. The hook measures how busy the computer's processors (CPU)
// and its memory (RAM) are:
//
// - Both are below their limits: the subagent starts.
// - One is at or above its limit: the hook waits and measures again every few seconds. That is the
//   queue. When the computer has room again within the wait, the subagent starts, and the agent is
//   told how long it waited.
// - Still busy at the end of the wait: the hook refuses the start. The agent reads why, and is told
//   to wait for its running subagents, or to do the work itself, and then to try again.
//
// Several subagents that an agent starts at the same time would all measure the same quiet
// computer and all start. So only one start is let through at a time, with a few seconds between
// two starts ("spacing"), and each start measures again after the one before it. The hooks of all
// sessions on the computer share this queue through a lock folder in this tool's folder.
//
// The settings are in this tool's config as "loadGate". The defaults are in DEFAULTS. A broken
// measurement, a broken config or a lock that cannot be taken never stops a subagent.
import { cpus, freemem, totalmem } from 'node:os'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { config, readJson, saveConfig, writeJson } from './config.mjs'
import { home } from './paths.mjs'

/** The limits in percent used, the longest wait and the gap between two starts in seconds. */
export const DEFAULTS = { on: true, cpu: 90, memory: 90, wait: 120, spacing: 5 }
/** The seconds between two measurements while the hook waits. */
const STEP = 5
/** The longest wait in seconds. Claude Code ends the hook after 150 seconds (hooks/hooks.json), and an ended hook lets the subagent start. */
export const MAX_WAIT = 140
/** A lock older than this many milliseconds was left by a hook that ended without freeing it. */
const STALE = 30e3

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const inRange = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi

/** The settings of the gate: the person's own values where they are valid, the defaults elsewhere. */
export function gateSettings(cfg = config()) {
  const own = isObject(cfg) && isObject(cfg.loadGate) ? cfg.loadGate : {}
  return {
    on: own.on !== false,
    cpu: inRange(own.cpu, 1, 100) ? own.cpu : DEFAULTS.cpu,
    memory: inRange(own.memory, 1, 100) ? own.memory : DEFAULTS.memory,
    wait: inRange(own.wait, 0, MAX_WAIT) ? own.wait : DEFAULTS.wait,
    spacing: inRange(own.spacing, 0, 600) ? own.spacing : DEFAULTS.spacing,
  }
}

/** Keeps changed settings of the gate in the config. The other settings stay. */
export function saveGateSettings(change) {
  const cfg = config()
  const base = isObject(cfg) ? cfg : {}
  saveConfig({ ...base, loadGate: { ...(isObject(base.loadGate) ? base.loadGate : {}), ...change } })
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** The processors' busy and idle time so far, summed over all of them. */
function cpuTimes() {
  let busy = 0
  let all = 0
  for (const { times } of cpus()) {
    const sum = times.user + times.nice + times.sys + times.idle + times.irq
    all += sum
    busy += sum - times.idle
  }
  return { busy, all }
}

/** The percent of processor time that was busy over `ms` milliseconds. */
export async function cpuPercent(ms = 1000) {
  const a = cpuTimes()
  await sleep(ms)
  const b = cpuTimes()
  const all = b.all - a.all
  return all > 0 ? Math.round((100 * (b.busy - a.busy)) / all) : 0
}

/**
 * The percent of memory in use. On a Mac, Node's free memory leaves out the memory that holds
 * files and can be given back at once, so a Mac looks full most of the time. There the pages that
 * vm_stat counts as free, inactive, speculative or purgeable count as available.
 */
export function memoryPercent({ platform = process.platform, vmStat } = {}) {
  const total = totalmem()
  let available = freemem()
  if (platform === 'darwin') {
    try {
      const text = vmStat ?? execFileSync('vm_stat', { encoding: 'utf8', timeout: 2000 })
      const page = Number(/page size of (\d+) bytes/.exec(text)?.[1])
      const pages = (name) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0)
      if (page > 0) available = page * (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable'))
    } catch {
      // Node's own figure stays.
    }
  }
  return total > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - available / total)))) : 0
}

/** How busy the computer is now, in percent. */
export async function measure() {
  return { cpu: await cpuPercent(), memory: memoryPercent() }
}

/** What is over its limit, in words, or undefined when nothing is. */
export function overWords(load, s) {
  const over = []
  if (load.cpu >= s.cpu) over.push(`the processors (CPU) are ${load.cpu}% busy, and the limit is ${s.cpu}%`)
  if (load.memory >= s.memory) over.push(`memory (RAM) is ${load.memory}% used, and the limit is ${s.memory}%`)
  return over.length ? over.join(', and ') : undefined
}

const lockDir = () => join(home(), 'load-gate.lock')
const stateFile = () => join(home(), 'load-gate.json')

/** Takes the lock of the queue. True when it is taken. A lock left by a hook that ended is taken over. */
function takeLock(now) {
  mkdirSync(home(), { recursive: true })
  try {
    mkdirSync(lockDir())
    return true
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  }
  try {
    if (now - statSync(lockDir()).mtimeMs > STALE) {
      rmdirSync(lockDir())
      mkdirSync(lockDir())
      return true
    }
  } catch {
    // Another hook took it over first.
  }
  return false
}

function freeLock() {
  try {
    rmdirSync(lockDir())
  } catch {
    // Already gone.
  }
}

/**
 * The hook before a subagent starts. Returns the JSON to print, or undefined to let it start
 * without a word. `tools` replaces the clock, the sleep and the measurement in tests.
 */
export async function loadGateHook(input, { cfg = config(), now = () => Date.now(), wait = sleep, look = measure } = {}) {
  const s = gateSettings(cfg)
  if (!s.on) return undefined
  const start = now()
  const end = start + s.wait * 1000
  let last
  for (;;) {
    if (takeLock(now())) {
      let free = false
      try {
        const since = now() - (readJson(stateFile(), {}).lastStart ?? 0)
        if (since >= s.spacing * 1000 || since < 0) {
          last = await look()
          if (!overWords(last, s)) {
            writeJson(stateFile(), { lastStart: now() })
            free = true
          }
        }
      } finally {
        freeLock()
      }
      if (free) {
        const waited = Math.round((now() - start) / 1000)
        return waited >= STEP ? { systemMessage: `widal: this subagent waited ${waited}s in the queue before it started (CPU ${last.cpu}%, memory ${last.memory}%).` } : undefined
      }
    }
    if (now() >= end) break
    await wait(Math.min(last && overWords(last, s) ? STEP * 1000 : 1000, Math.max(0, end - now())))
  }
  // Waited to the end. Without a measurement (the queue stayed full) nothing is known to be over.
  const over = last && overWords(last, s)
  if (!over) return undefined
  const reason = `Widal.Code did not start this subagent: ${over}, also after a wait of ${s.wait}s. Too many agents run on this computer at once. Wait until your running subagents have finished, or do this work yourself in this agent, and then try again. Do not start other subagents meanwhile. (The person can change the limits with "widal load".)`
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
}
