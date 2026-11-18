// Where the agents keep their session logs, and where this tool keeps its own files.
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The name of this tool's command. */
export const NAME = 'widal'

/**
 * The names this tool had before it was called Widal.Code: agent-spend until 13 Nov 2026, then
 * Kestrel until 17 Nov 2026. Its command and its folder had those names. The command "kestrel"
 * keeps working for one release.
 */
export const OLD_NAME = 'agent-spend'
export const KESTREL_NAME = 'kestrel'

/** This tool's folder in a person's home folder, and the folders it had under its old names. */
export const newHome = () => join(homedir(), '.widal')
export const kestrelHome = () => join(homedir(), `.${KESTREL_NAME}`)
export const oldHome = () => join(homedir(), `.${OLD_NAME}`)

/**
 * A setting from the environment: WIDAL_<name>, else KESTREL_<name>. The names with KESTREL_
 * are read for one release after the change of name, so that a setting made before it keeps
 * working. An empty value counts as not set.
 */
export const envSetting = (name, env = process.env) => env[`WIDAL_${name}`] || env[`KESTREL_${name}`] || undefined

// Whether this process has seen the folder ~/.widal. Once it is there it stays, so the disk is
// asked for it only until then.
let seen = false

/**
 * This tool's own folder: its settings, its cache of parsed logs and its backups. It is
 * ~/.widal, or the folder that WIDAL_HOME names (or KESTREL_HOME, for one release).
 *
 * An install from before the change of name has its files in ~/.kestrel, or in ~/.agent-spend,
 * until the move has brought them to ~/.widal (see migrate.mjs). Until then the old folder has
 * to keep working. So while ~/.widal is not there, the folder is ~/.kestrel when that is there,
 * else ~/.agent-spend when that is there.
 *
 * The status line asks for this folder many times in one run. With WIDAL_HOME the disk is not
 * asked at all. Without it, one look finds ~/.widal, and the calls after that ask nothing.
 * Only an install that has not been moved yet takes more looks per call.
 */
export function home() {
  const named = envSetting('HOME')
  if (named) return named
  const now = newHome()
  if (seen || (seen = existsSync(now))) return now
  for (const old of [kestrelHome(), oldHome()]) if (existsSync(old)) return old
  return now
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
 * Every config folder of Claude Code that Widal.Code knows, each once. A person can run Claude Code
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
  const named = envSetting('COWORK_DIR', env)
  if (named) return named
  const app =
    platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Claude')
    : platform === 'win32' ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude')
    : join(home, '.config', 'Claude')
  return join(app, 'local-agent-mode-sessions')
}
