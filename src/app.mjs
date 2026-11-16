// The tool's own files: the folder they are in, the version, and the stable copy of an install
// from a plugin.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeDir, home } from './paths.mjs'

/** The folder that holds this tool: the one with "cli", "src" and package.json in it. */
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** The name of this tool's package, as package.json gives it. A folder whose package.json has this name holds this tool. */
export const PACKAGE = '@widal/kestrel'

/** A path with its links resolved. A path that is not there is only made absolute. */
export const real = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** The package.json of the tool in a folder, as a value. Undefined when it is missing or cannot be read. */
function packageOf(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * The version of the tool in a folder, from its package.json. That file is the one place that
 * holds the version. Undefined when the file is missing or cannot be read. It is read only
 * when it is asked for: the status line and the hooks never need it.
 */
export function version(root = ROOT) {
  const found = packageOf(root)?.version
  return typeof found === 'string' ? found : undefined
}

/** Whether a folder holds this tool: its package.json names this tool's package. */
export const holdsTool = (root) => packageOf(root)?.name === PACKAGE

/**
 * A sentence for a Node that is too old for this tool, or undefined. The tool needs Node 22: it
 * uses functions of newer versions in many places. `found` is the version of Node, as Node gives it.
 */
export function nodeNote(found = process.versions.node) {
  return Number(String(found).split('.')[0]) < 22 ? `Kestrel needs Node 22 or newer, and this computer runs Node ${found}.` : undefined
}

// The stable copy.
//
// Claude Code keeps a plugin's files in a cache folder whose name has the plugin's version in it,
// so the folder changes with every update. The status line in Claude Code's settings must not
// point into it: after an update the old folder is deleted. So an install from a plugin copies the
// tool into a folder of its own, <tool folder>/app, and the links point at that copy. A hook of the
// plugin at the start of each session brings the copy to the plugin's version.

/** The parts of the tool that the copy holds. The rest of the repo (tests, notes, the plugin's own files) is not needed to run it. */
const APP_FILES = ['cli', 'src', 'package.json', 'assets']

/** The folder of the stable copy, and the command's file in it. */
export const appDir = () => join(home(), 'app')
export const appCommand = () => join(appDir(), 'cli', 'kestrel.mjs')

/** The folders where Claude Code keeps the plugins it installed: the one CLAUDE_CODE_PLUGIN_CACHE_DIR names, else "plugins" in Claude Code's folder. */
const pluginsDirs = (env) => [env.CLAUDE_CODE_PLUGIN_CACHE_DIR, join(claudeDir(), 'plugins'), join(homedir(), '.claude', 'plugins')].filter(Boolean)

/**
 * Whether the tool in `root` runs from a plugin's folder that Claude Code installed. That is so
 * when the folder lies below Claude Code's plugins folder (the cache of every version, and the
 * plugins synced from claude.ai). It is also so when Claude Code named the folder in
 * CLAUDE_PLUGIN_ROOT, as it does for a plugin's hooks, and the folder is not a git checkout.
 * Claude Code does not set that variable for a command that a plugin's command file runs, so the
 * first rule is the one for "/kestrel:setup".
 */
export function fromPlugin({ root = ROOT, env = process.env } = {}) {
  const here = real(root)
  if (pluginsDirs(env).some((dir) => here.startsWith(real(dir) + sep))) return true
  return Boolean(env.CLAUDE_PLUGIN_ROOT) && real(env.CLAUDE_PLUGIN_ROOT) === here && !existsSync(join(root, '.git'))
}

/**
 * Copies the tool from one folder to the stable copy. The files go to a new folder first, which
 * then takes the place of the old copy. So a status line that runs during the copy finds the old
 * copy or the new one, never half of one. The command's files can be run as programs, also when
 * the folder they came from lost that.
 */
export function copyApp(from = ROOT, to = appDir()) {
  const [fresh, old] = [`${to}.${process.pid}.tmp`, `${to}.${process.pid}.old`]
  rmSync(fresh, { recursive: true, force: true })
  mkdirSync(fresh, { recursive: true })
  for (const name of APP_FILES) if (existsSync(join(from, name))) cpSync(join(from, name), join(fresh, name), { recursive: true })
  for (const name of ['kestrel.mjs', 'agent-spend.mjs']) if (existsSync(join(fresh, 'cli', name))) chmodSync(join(fresh, 'cli', name), 0o755)
  if (existsSync(to)) renameSync(to, old)
  renameSync(fresh, to)
  rmSync(old, { recursive: true, force: true })
}

/**
 * The hook of the plugin at the start of a session: when a stable copy exists and its version
 * differs from the version of the plugin in `root`, the plugin's files are copied over it.
 * Returns whether it copied. With nothing to do it reads two small files and nothing else.
 */
export function refreshCopy({ root = ROOT } = {}) {
  const to = appDir()
  const have = version(to)
  if (have === undefined) return false
  const want = version(root)
  if (want === undefined || want === have || real(to) === real(root)) return false
  copyApp(root, to)
  return true
}

/** Removes the stable copy. Only a folder that holds this tool is removed. Returns whether it did. */
export function removeApp() {
  if (!holdsTool(appDir())) return false
  rmSync(appDir(), { recursive: true, force: true })
  return true
}
