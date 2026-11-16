// The security checks as a whole: when they run, the hooks that start them, the gate before a push,
// the part of the status line, and the command "kestrel check".
//
// When the checks run:
//   - the settings: when a session starts (the hook "check-settings"), and in "kestrel check --run";
//   - what the agent did, the code it changed and, when switched on, the text of the session: when
//     an agent's turn ends (the hook "check-turn"), for that session and its repository, and in
//     "kestrel check --run".
// The two hooks start the work in the background, as the status line starts "kestrel
// refresh-today", and return at once. A session never waits for a check. A second start for the
// same repository (or the settings) within 60 seconds is skipped.
//
// The gate (the hook "push-gate", before a shell command): a "git push", "gh pr create" or "gh pr
// merge" while a high finding of the code or the actions is open in that repository makes Claude
// Code ask the person first. It never refuses.
//
// Kestrel checks technical controls and flags risks. It does not make a company compliant or
// certify it. That sentence goes with every list of findings.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkCode } from './check-code.mjs'
import { checkActions, checkData, shellCommands, programOf } from './check-log.mjs'
import { checkSettings, personFiles, transcriptDays } from './check-settings.mjs'
import { config, readJson, writeJson } from './config.mjs'
import { FRAMEWORK_LABEL, controlWords, controlsFor, storedControlsFor } from './controls.mjs'
import { KINDS, SEVERITIES, openFindings, readFindings, saveFindings } from './findings.mjs'
import { day, plain } from './format.mjs'
import { repoOf } from './git.mjs'
import { claudeDir, home, realPath, shortPath } from './paths.mjs'
import { RULES } from './rules.mjs'
import { CHECKS_NOTE, frameworksFor, securityConfig } from './settings.mjs'

/** The sentence that goes with every list of findings. */
export const NOTE = CHECKS_NOTE

// A second start for the same repository within this time is skipped.
const START_EVERY = 60e3
// The command's file, next to this folder.
const COMMAND = fileURLToPath(new URL('../cli/kestrel.mjs', import.meta.url))

/** A session id as Claude Code gives it, when it is a plain name, else undefined. It becomes part of a finding's id and scope. */
export const plainId = (id) => (typeof id === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(id) ? id : undefined)

/** The frameworks for a repository: its own file's, else the person's. A broken file counts as none. */
function frameworksOf(cfg, repo) {
  try {
    return frameworksFor(cfg, repo).on
  } catch {
    return securityConfig(cfg).frameworks
  }
}

/**
 * Notes a start for a key ("settings", or a repository) and says whether it may go ahead: false
 * when one was made in the last 60 seconds. The time is saved before the start, so that a start
 * that fails is not tried again at once.
 */
function mayStart(key, now) {
  const dir = join(home(), 'checks')
  mkdirSync(dir, { recursive: true })
  const mark = join(dir, `${createHash('sha256').update(key).digest('hex').slice(0, 16)}.start`)
  const last = readJson(mark)
  // A time that lies ahead comes from a clock that was wrong. It does not count.
  if (Number.isFinite(last) && last <= now && now - last < START_EVERY) return false
  writeJson(mark, now)
  return true
}

/** Starts "kestrel security-run" in the background with these arguments. The hook never waits for it. */
function startRun(args, spawner) {
  spawner(process.execPath, [COMMAND, 'security-run', ...args], { detached: true, stdio: 'ignore' }).unref()
}

/**
 * The hook when a session starts. It starts the check of the settings in the background, and prints
 * nothing: what a hook prints at a session's start goes to the model. `spawner` stands in for
 * `spawn` in a test. Returns whether a check was started.
 */
export function sessionStartHook(input, { now = Date.now(), spawner = spawn, cfg = config() } = {}) {
  if (!securityConfig(cfg).checks.settings) return false
  const cwd = typeof input?.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : undefined
  if (!mayStart('settings', now)) return false
  startRun(['--what', 'settings', ...(cwd ? ['--cwd', cwd] : [])], spawner)
  return true
}

/**
 * The hook when an agent's turn ends. It starts the checks of the actions, the code and (when
 * switched on) the data in the background, for the session and its repository. Returns whether a
 * check was started.
 */
export function stopHook(input, { now = Date.now(), spawner = spawn, cfg = config() } = {}) {
  const { checks } = securityConfig(cfg)
  if (!checks.actions && !checks.code && !checks.data) return false
  const session = plainId(input?.session_id)
  const cwd = typeof input?.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : undefined
  const transcript = typeof input?.transcript_path === 'string' && input.transcript_path.endsWith('.jsonl') ? input.transcript_path : undefined
  if (!cwd && !(session && transcript)) return false
  const repo = cwd ? repoOf(cwd) : undefined
  if (!mayStart(repo ? `repo:${repo}` : `folder:${cwd ?? session}`, now)) return false
  startRun(['--what', 'turn', ...(cwd ? ['--cwd', cwd] : []), ...(session && transcript ? ['--session', session, '--transcript', transcript] : [])], spawner)
  return true
}

/** Runs the check of the settings for a folder, and saves its findings. Returns them. */
export function runSettings({ cwd, env = process.env, now = Date.now(), cfg = config() } = {}) {
  const frameworks = securityConfig(cfg).frameworks
  const { findings, projects } = checkSettings({ cwd, env, frameworks })
  // A finding of another project's files stays as it is: this run did not look there. It goes
  // when its file is gone.
  const looked = new Set(projects)
  const others = readFindings().filter((f) => f.kind === 'settings' && f.status === 'open' && f.where?.project && !looked.has(f.where.project) && exists(f.where.project))
  return saveFindings([...findings, ...others], { scope: 'settings', kind: 'settings', now })
}

const exists = (path) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Runs the checks of a turn: what the agent did and (when switched on) the text of the session, from
 * its log, and the code it changed in the repository of `cwd`. Each check that is off is left out.
 * `limits` stands in for the limits of the code check in a test. Returns what each check found.
 */
export function runTurn({ session, transcript, cwd, env = process.env, now = Date.now(), cfg = config(), limits } = {}) {
  const { checks, frameworks: own } = securityConfig(cfg)
  const repo = cwd ? repoOf(cwd) : undefined
  const frameworks = repo ? frameworksOf(cfg, repo) : own
  const out = {}
  const id = plainId(session)
  if (id && transcript) {
    if (checks.actions) out.actions = saveFindings(checkActions({ transcript, session: id, repo, frameworks }), { scope: `session:${id}`, kind: 'actions', now })
    if (checks.data) {
      const days = transcriptDays(personFiles()).cleanup
      out.data = saveFindings(checkData({ transcript, session: id, repo, frameworks, days }), { scope: `session:${id}`, kind: 'data', now })
    }
  }
  if (checks.code && repo) {
    const r = checkCode({ root: repo, frameworks, env, ...(limits && { limits }) })
    out.code = saveFindings(r.findings, { scope: `repo:${repo}`, kind: 'code', now })
    out.scanners = r.scanners
    out.files = r.files
    out.skipped = r.skipped
  }
  return out
}

/**
 * "kestrel security-run": the work that the two hooks start in the background. `what` is "settings"
 * or "turn". It prints nothing. The command catches every error.
 */
export function securityRun({ what, cwd, session, transcript, env = process.env, now = Date.now() }) {
  const folder = typeof cwd === 'string' && isAbsolute(cwd) ? cwd : undefined
  if (what === 'settings') return runSettings({ cwd: folder, env, now })
  if (what === 'turn') return runTurn({ session: plainId(session), transcript: typeof transcript === 'string' && transcript.endsWith('.jsonl') ? transcript : undefined, cwd: folder, env, now })
  return undefined
}

// The commands before which the gate asks. Only the start of each simple command is compared, as
// the privacy rule in check-log.mjs says.
// The options of git before its command that take the next word as their value.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--exec-path'])

/**
 * The folders whose repositories a shell line pushes from or opens a pull request from: for "git
 * push" (also after git's own options, such as "git -C <folder> push"), "gh pr create" and "gh pr
 * merge". A "cd <folder>" earlier in the line, and git's -C, change the folder; a relative folder
 * counts from `cwd`. An empty list when the line does none of these.
 */
export function pushFolders(command, cwd) {
  const out = []
  let folder = cwd
  for (const words of shellCommands(command)) {
    const { program, args } = programOf(words)
    if (program === 'cd') {
      if (args[0] && !args[0].startsWith('-') && !args[0].includes('$') && !args[0].startsWith('~')) folder = resolve(folder, args[0])
      continue
    }
    if (program === 'gh' && args[0] === 'pr' && (args[1] === 'create' || args[1] === 'merge')) out.push(folder)
    if (program !== 'git') continue
    let where = folder
    let i = 0
    while (i < args.length && args[i].startsWith('-')) {
      if (args[i] === '-C' && args[i + 1] !== undefined) where = resolve(where, args[i + 1])
      i += GIT_VALUE_OPTIONS.has(args[i]) ? 2 : 1
    }
    if (args[i] === 'push') out.push(where)
  }
  return out
}

/**
 * The gate before a shell command. Returns the JSON to print, or undefined to say nothing. It asks
 * only for "git push", "gh pr create" and "gh pr merge", only while a high finding of the code or the
 * actions is open in the command's repository, and only while the gate is on. It never refuses.
 */
export function gateHook(input, { cfg = config() } = {}) {
  if (!securityConfig(cfg).checks.push) return undefined
  const command = input?.tool_input?.command
  if (input?.tool_name !== 'Bash' || typeof command !== 'string' || typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) return undefined
  const repos = new Set(pushFolders(command, input.cwd).map(repoOf).filter(Boolean))
  if (!repos.size) return undefined
  const high = openFindings({ least: 'high' }).filter((f) => (f.kind === 'code' || f.kind === 'actions') && repos.has(f.where?.repo))
  if (!high.length) return undefined
  const titles = [...new Set(high.map((f) => plain(f.title)))]
  const shown = titles.length > 3 ? `${titles.slice(0, 3).join('; ')}; and ${titles.length - 3} more` : titles.join('; ')
  const reason = `Kestrel: ${high.length === 1 ? '1 high risk is' : `${high.length} high risks are`} open in this repository: ${shown}. See them with kestrel check.`
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } }
}

export { riskPart } from './risk.mjs'

/** The controls of a finding for the frameworks that are on: from its rule when it is one of Kestrel's, else from its own list. */
function shownControls(f, frameworks) {
  return RULES[f.rule] ? controlsFor(RULES[f.rule].controls, frameworks) : storedControlsFor(f.controls, frameworks)
}

/** The frameworks that count for a finding: those of its repository for a finding in one, else the person's. */
const frameworksForFinding = (f, cfg, own) => (f.where?.repo ? frameworksOf(cfg, f.where.repo) : own)

/** Where a finding is, in words. */
export function whereWords(w = {}) {
  const parts = []
  if (w.file) parts.push(w.line ? `${w.file}:${w.line}` : w.file)
  if (w.repo) parts.push(`in ${shortPath(w.repo)}`)
  else if (w.project) parts.push(`in ${shortPath(w.project)}`)
  if (w.session) parts.push(`session ${String(w.session).slice(0, 8)}`)
  if (w.provider) parts.push([w.provider, w.account].filter(Boolean).join(' '))
  if (w.resource) parts.push(String(w.resource))
  return plain(parts.join(', '))
}

/** The Claude Code logs of a folder that changed in the last 7 days, the newest first, at most 20: `[{ session, transcript }]`. */
function sessionsOf(cwd, now) {
  const names = [...new Set([cwd, realPath(cwd)].map((p) => p.replace(/[^A-Za-z0-9]/g, '-')))]
  const out = []
  for (const name of names) {
    const dir = join(claudeDir(), 'projects', name)
    let files = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      try {
        const mtime = statSync(join(dir, f)).mtimeMs
        if (now - mtime <= 7 * 86400e3) out.push({ session: f.slice(0, -'.jsonl'.length), transcript: join(dir, f), mtime })
      } catch {
        // Gone since.
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 20)
}

/** Runs the checks that are on for a folder now: the settings, the code of its repository, and its sessions of the last 7 days. */
export function runNow({ cwd, env = process.env, now = Date.now(), cfg = config(), limits } = {}) {
  const { checks } = securityConfig(cfg)
  const said = []
  if (checks.settings) runSettings({ cwd, env, now, cfg })
  const sessions = checks.actions || checks.data ? sessionsOf(cwd, now) : []
  for (const s of sessions) runTurn({ ...s, cwd, env, now, cfg: { ...cfg, security: { ...cfg.security, checks: { ...checks, code: false } } } })
  const repo = repoOf(cwd)
  if (checks.code && repo) {
    const r = runTurn({ cwd, env, now, cfg: { ...cfg, security: { ...cfg.security, checks: { ...checks, actions: false, data: false } } }, limits })
    said.push(`The code: ${r.files} changed ${r.files === 1 ? 'file' : 'files'} in ${shortPath(repo)}, checked with ${r.scanners.length ? r.scanners.join(', ') : 'nothing (no file to check)'}.${r.skipped ? ` ${r.skipped} left out (binary, larger than 2 MB, or beyond the first 200).` : ''}`)
  } else if (checks.code) said.push('The code: this folder is not in a git repository.')
  if (checks.actions || checks.data) said.push(`The sessions: ${sessions.length} of this folder in the last 7 days.`)
  const off = ['settings', 'actions', 'code', 'data'].filter((c) => !checks[c])
  if (off.length) said.push(`Off: ${off.join(', ')} (kestrel settings set security.checks.<name> on).`)
  return said
}

const KIND_WORDS = { settings: 'Settings', actions: 'Actions', code: 'Code', data: 'Data', cloud: 'Cloud' }

/** The open findings with the controls of the frameworks that are on, as "kestrel check --json" gives them. */
export function reportData({ cfg = config(), now = Date.now() } = {}) {
  const own = securityConfig(cfg).frameworks
  const findings = openFindings().map((f) => ({ ...f, controls: shownControls(f, frameworksForFinding(f, cfg, own)) }))
  const counts = { high: 0, medium: 0, low: 0, info: 0 }
  for (const f of findings) counts[f.severity]++
  return { at: now, frameworks: own, counts, findings, note: NOTE }
}

/** "kestrel check" as text: the frameworks that are on, the open findings by kind, the most severe first, and the sentence. */
export function checkText(data, { cwd = process.cwd(), cfg = config(), ran = [] } = {}) {
  const names = (list) => (list.length ? list.map((id) => FRAMEWORK_LABEL[id] ?? id).join(', ') : 'none')
  const out = [`Frameworks that are on: ${names(data.frameworks)}.`]
  const repo = repoOf(cwd)
  if (repo) {
    const fw = (() => {
      try {
        return frameworksFor(cfg, repo)
      } catch {
        return undefined
      }
    })()
    if (fw?.from === 'project') out.push(`For ${shortPath(repo)}: ${names(fw.on)}, from ${shortPath(fw.file)}.`)
  }
  out.push(...ran)
  const c = data.counts
  out.push('', data.findings.length ? `Open findings: ${c.high} high, ${c.medium} medium, ${c.low} low${c.info ? `, ${c.info} info` : ''}.` : 'No open findings. Run the checks for this folder now with: kestrel check --run')
  for (const kind of KINDS) {
    const list = data.findings.filter((f) => f.kind === kind)
    if (!list.length) continue
    out.push('', KIND_WORDS[kind])
    for (const f of list) {
      out.push(`  ${f.severity.padEnd(6)}  ${plain(f.title)}`)
      if (f.detail) out.push(`          ${plain(f.detail)}`)
      const where = whereWords(f.where)
      if (where) out.push(`          where: ${where}`)
      if (f.controls.length) out.push(`          controls: ${f.controls.map(controlWords).join('; ')}`)
      if (f.fix?.words) out.push(`          fix: ${plain(f.fix.words)}`)
    }
  }
  out.push('', data.note)
  return out.join('\n')
}

/**
 * A value in a cell of a CSV file: in quotes when it holds a comma, a quote or a line break. A
 * value that starts with =, +, -, @, a tab or a carriage return gets a ' in front, so that a
 * spreadsheet shows it as text and never runs it as a formula. A path or a title of a finding
 * can start with any of these.
 */
export const cell = (v) => {
  let s = v === undefined || v === null ? '' : plain(String(v))
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}
const date = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : '')

/** The open and resolved findings as CSV, with their dates and the controls of the frameworks that are on, for an audit. */
export function checkCsv({ cfg = config() } = {}) {
  const own = securityConfig(cfg).frameworks
  const rows = [['id', 'rule', 'kind', 'severity', 'status', 'title', 'detail', 'where', 'controls', 'fix', 'source', 'first seen', 'last seen', 'resolved']]
  const all = readFindings().sort((a, b) => (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1) || SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || (a.id < b.id ? -1 : 1))
  for (const f of all) {
    const controls = shownControls(f, frameworksForFinding(f, cfg, own)).map(controlWords).join('; ')
    rows.push([f.id, f.rule, f.kind, f.severity, f.status, f.title, f.detail, whereWords(f.where), controls, f.fix?.words, f.source, date(f.firstSeen), date(f.lastSeen), date(f.resolvedAt)])
  }
  // The sentence, as the last line: an audit that reads the file reads it too.
  rows.push([NOTE])
  return `${rows.map((r) => r.map(cell).join(',')).join('\n')}\n`
}

/**
 * The command "kestrel check". `run` runs the checks for `cwd` first, `json` gives the data, and
 * `exportFile` writes the CSV for an audit to that file. Returns what to print.
 */
export function checkCommand({ json = false, run = false, exportFile, cwd = process.cwd(), env = process.env, now = Date.now() } = {}) {
  if (exportFile === true) throw new Error('--export needs a file, for example: kestrel check --export findings.csv')
  const cfg = config()
  const ran = run ? runNow({ cwd, env, now, cfg }) : []
  if (exportFile !== undefined) {
    const file = resolve(String(exportFile))
    writeFileSync(file, checkCsv({ cfg }))
    const n = readFindings().length
    return `Wrote ${n} ${n === 1 ? 'finding' : 'findings'}, open and resolved, to ${file} (${day(now)}).\n${NOTE}`
  }
  const data = reportData({ cfg, now })
  return json ? JSON.stringify(data) : checkText(data, { cwd, cfg, ran })
}
