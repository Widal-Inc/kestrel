// Where the agents keep their session logs, and where this tool keeps its own files.
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The name this tool had before it was called Kestrel. Its command and its folder had that name. */
export const OLD_NAME = 'agent-spend'

/** This tool's folder in a person's home folder, and the folder it had under its old name. */
export const newHome = () => join(homedir(), '.kestrel')
export const oldHome = () => join(homedir(), `.${OLD_NAME}`)

// Whether this process has seen the folder ~/.kestrel. Once it is there it stays, so the disk is
// asked for it only until then.
let seen = false

/**
 * This tool's own folder: its settings, its cache of parsed logs and its backups. It is
 * ~/.kestrel, or the folder that KESTREL_HOME names.
 *
 * An install from before the change of name has its files in ~/.agent-spend until
 * "kestrel migrate" has moved them. Until then the old folder has to keep working. So while
 * ~/.kestrel is not there and ~/.agent-spend is, the folder is ~/.agent-spend.
 *
 * The status line asks for this folder many times in one run. With KESTREL_HOME the disk is not
 * asked at all. Without it, one look finds ~/.kestrel, and the calls after that ask nothing.
 * Only an install that has not been moved yet takes two looks per call.
 */
export function home() {
  if (process.env.KESTREL_HOME) return process.env.KESTREL_HOME
  const now = newHome()
  if (seen || (seen = existsSync(now))) return now
  const old = oldHome()
  return existsSync(old) ? old : now
}

/** A path for a person to read: with "~" for the home folder, else as it is. */
export function shortPath(path, home = homedir()) {
  if (typeof path !== 'string') return ''
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** Claude Code's folder. Its session logs are in projects/<folder>/<session>.jsonl below it. */
export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

/** The real path of a folder, through any link. The path as it is when the folder is not there. */
export function realPath(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Every config folder of Claude Code that Kestrel knows, each once. A person can run Claude Code
 * with another folder (CLAUDE_CONFIG_DIR=~/.claude-work claude), for example for a second account.
 * Its logs are then in that folder's projects/. The folders are, in this order: the one that
 * CLAUDE_CONFIG_DIR names, ~/.claude, every folder in the home folder whose name starts with
 * ".claude" and that has a folder projects, and the folders in `more` (the setting claudeDirs,
 * where "~/" stands for the home folder). The same folder twice, also once through a link, is
 * given once.
 *
 * `env` and `home` stand in for the environment and the person's home folder in a test.
 */
export function claudeDirs({ env = process.env, home = homedir(), more = [] } = {}) {
  const list = []
  if (env.CLAUDE_CONFIG_DIR) list.push(env.CLAUDE_CONFIG_DIR)
  list.push(join(home, '.claude'))
  let entries = []
  try {
    entries = readdirSync(home, { withFileTypes: true })
  } catch {
    // No home folder: only the folders named elsewhere.
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith('.claude') && (e.isDirectory() || e.isSymbolicLink()) && existsSync(join(home, e.name, 'projects'))) list.push(join(home, e.name))
  }
  for (const dir of Array.isArray(more) ? more : []) {
    if (typeof dir !== 'string' || !dir) continue
    list.push(dir === '~' ? home : dir.startsWith('~/') ? join(home, dir.slice(2)) : resolve(dir))
  }
  const seen = new Set()
  return list.filter((dir) => {
    const real = realPath(dir)
    if (seen.has(real)) return false
    seen.add(real)
    return true
  })
}

/**
 * The file where Claude Code keeps the account that is signed in for a config folder. For
 * ~/.claude it is ~/.claude.json, next to the folder. For any other folder it is .claude.json in
 * that folder (Claude Code's documentation: "The same applies to .claude.json").
 */
export const claudeJsonOf = (dir, home = homedir()) => (realPath(dir) === realPath(join(home, '.claude')) ? join(home, '.claude.json') : join(dir, '.claude.json'))

/** Codex's folder. Its session logs are in sessions/<year>/<month>/<day>/rollout-*.jsonl below it. */
export const codexDir = () => process.env.CODEX_HOME || join(homedir(), '.codex')

/**
 * The folder where the Claude desktop app keeps the Cowork sessions that ran on this computer.
 * Their logs are in <id>/<id>/local_<id>/*.jsonl below it. Only the macOS path is confirmed. The
 * Windows and Linux paths are the app's data folder on those systems, and nobody has checked them.
 *
 * `platform`, `home` and `env` stand in for the system, the person's home folder and the
 * environment, so that a test can ask for the folder of each system.
 */
export function coworkDir({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  if (env.KESTREL_COWORK_DIR) return env.KESTREL_COWORK_DIR
  const app =
    platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Claude')
    : platform === 'win32' ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude')
    : join(home, '.config', 'Claude')
  return join(app, 'local-agent-mode-sessions')
}
