// Reads the runs of each arm through Widal.Code, in a home of its own per arm.
//
//   node bench/collect.mjs --out <folder> [--arms a,b]
//
// For each arm it links the folders of Claude Code's logs that hold the arm's sessions into
// an empty Claude Code folder, and runs Widal.Code there. So the tool sees the arm's sessions and
// nothing else, and the person's real setup is neither read nor changed. It writes
// <folder>/widal/<arm>/view.json: the sessions as the tool counts them, the tool's signs, its
// spend per ticket and its proposals ("widal advise --json").
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, symlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ARMS, armOf } from './arms.mjs'
import { ROOT, WIDAL, flags, logFolder, outDir, paths, runsOf, viewEnv, workFolders, writeJson } from './lib.mjs'

/** Runs Widal.Code's command line for an arm, in the arm's own home. */
export function widal(out, arm, args) {
  const r = spawnSync(process.execPath, [WIDAL, ...args], { encoding: 'utf8', env: viewEnv(out, arm), cwd: paths(out).view(arm).root, timeout: 300_000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/**
 * Links the logs of an arm's work folders into the Claude Code folder that Widal.Code reads for
 * the arm `into`: its own, unless another is named. True when there are logs.
 */
export function linkLogs(out, into, of = into, { early = false } = {}) {
  const env = viewEnv(out, into)
  let found = false
  for (const work of workFolders(out, of)) {
    const real = logFolder(work)
    // `early` links a folder before its first session has made it, so that the hooks of that session find its log.
    if (!existsSync(real) && !early) continue
    found = true
    const link = join(env.CLAUDE_CONFIG_DIR, 'projects', basename(real))
    try {
      lstatSync(link)
    } catch {
      symlinkSync(real, link)
    }
  }
  return found
}

/** The rows of "widal tickets": ticket to cost in dollars. */
function ticketCosts(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const m = /^\s+([A-Z]{2,6}-\d+)\s+\S+\s+\$([\d,.]+)\s/.exec(line)
    if (m) out[m[1]] = Number(m[2].replaceAll(',', ''))
  }
  return out
}

export function collect(out, armId) {
  if (!linkLogs(out, armId)) return undefined
  const env = viewEnv(out, armId)
  const view = spawnSync(process.execPath, [join(ROOT, 'bench', 'view.mjs')], { encoding: 'utf8', env, timeout: 300_000, maxBuffer: 64e6 })
  if (view.status !== 0) throw new Error(`Widal.Code could not read the runs of "${armId}": ${view.stderr.slice(-300)}`)
  const data = JSON.parse(view.stdout)
  const tickets = widal(out, armId, ['tickets', '--days', '30'])
  const advise = widal(out, armId, ['advise', '--json', '--days', '30'])
  const result = {
    arm: armId,
    sessions: data.sessions,
    signs: data.signs,
    tickets: ticketCosts(tickets.stdout),
    advise: advise.status === 0 ? JSON.parse(advise.stdout) : { error: advise.stderr.slice(-300) },
    runs: runsOf(out, armId).length,
  }
  writeJson(join(paths(out).view(armId).root, 'view.json'), result)
  return result
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const f = flags()
  const out = outDir(f)
  for (const arm of (typeof f.arms === 'string' ? f.arms.split(',') : ARMS.map((a) => a.id)).map(armOf)) {
    const data = collect(out, arm.id)
    if (!data) continue
    const cost = data.sessions.reduce((n, s) => n + s.cost, 0)
    console.log(`${arm.id}: Widal.Code sees ${data.sessions.length} sessions, $${cost.toFixed(4)}, ${Object.keys(data.tickets).length} tickets, ${data.advise.proposals?.length ?? 0} proposals`)
  }
}
