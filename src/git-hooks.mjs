// The folder of git hooks that belongs to Widal.Code, ~/.widal/git-hooks/. "widal connect" sets it
// as git's global core.hooksPath, and "widal disconnect" puts back the value from before. Through it,
// git runs the check before a push (pre-push.mjs) for every push from this computer: from an agent
// with hooks, from one without (Aider), from a script, and from a person's terminal.
//
// A global core.hooksPath makes git stop reading each repository's own .git/hooks/, for every hook
// and not only for pre-push. So the folder holds a script for every hook that git knows. Each one
// runs the hook that git would have run without Widal.Code, with the same arguments and the same
// input: the hook of that name in the folder that core.hooksPath named before (for the person, or for
// the whole computer), else the repository's own .git/hooks/<name>. A hook that is not executable is
// not run, as git does. The pre-push script runs that hook first, then the check.
//
// Two hooks need more than that:
//   - push-to-checkout: when the hook exists, git leaves the update of a checked-out branch to it.
//     Without one of the repository's own, the script does what git itself does then.
//   - fsmonitor-watchman is not in the list: git never looks for it in the hooks folder. The
//     setting core.fsmonitor names its file.
//
// A repository that sets core.hooksPath for itself (husky, and tools like it) wins over the global
// value: git runs none of these scripts there. "widal connect" names such repositories, and gives the
// line that a team can add to its own pre-push hook.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { config, readJson, writeJson } from './config.mjs'
import { readFindings } from './findings.mjs'
import { repoOf } from './git.mjs'
import { claudeDirs, claudeJsonOf, home, realPath, shortPath } from './paths.mjs'

/** Every hook that git runs from a hooks folder: the list in "git help githooks", without fsmonitor-watchman. */
export const HOOKS = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg',
  'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive',
  'post-update', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate',
  'post-index-change', 'p4-changelist', 'p4-prepare-changelist', 'p4-post-changelist', 'p4-pre-submit',
]

/** The script with the check alone. git never runs it on its own: it has no hook's name. A team's own pre-push hook can call it. */
export const CHECK = 'widal-push-check'

/** The folder that git's global core.hooksPath names while Widal.Code is connected. */
export const hooksDir = () => join(home(), 'git-hooks')
// What "widal connect" found before it set the value: { before }, the global core.hooksPath or null.
const stateFile = () => join(home(), 'git-hooks.json')
// Each script starts with this, so that only Widal.Code's own files are ever taken out.
const HEAD = '#!/bin/sh\n# Widal.Code:'

/** A word for the shell, in single quotes. */
const sq = (s) => `'${String(s).replaceAll("'", "'\\''")}'`
/** A path with "~" or "~/" in front, as git reads such a value of core.hooksPath. */
const expand = (p) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)
const sameFolder = (a, b) => typeof a === 'string' && typeof b === 'string' && realPath(expand(a)) === realPath(expand(b))

/** Runs git and gives its output without the line end, or undefined when it fails (also when git is not there). */
function gitOut(args, cwd = homedir()) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
  } catch {
    return undefined
  }
}

const hasGit = () => gitOut(['--version']) !== undefined
/** The value of core.hooksPath in the person's global git config, or undefined. */
export const globalHooksPath = () => gitOut(['config', '--global', '--get', 'core.hooksPath'])

/** Sets core.hooksPath in the person's global git config, or takes it out with undefined. */
function setGlobalHooksPath(value) {
  if (value === undefined && globalHooksPath() === undefined) return
  execFileSync('git', ['config', '--global', ...(value === undefined ? ['--unset-all', 'core.hooksPath'] : ['core.hooksPath', value])], { cwd: homedir(), stdio: 'ignore' })
}

/**
 * The lines of a script that set `hook` to the hook that git would run without Widal.Code: the one
 * in the folder `chain`, else the repository's own. git runs a hook in the top folder of the working
 * tree, or in the git folder of a bare repository and during a push to this repository. A relative
 * `chain` counts from there, as git reads it.
 */
function findHook(chain, name) {
  if (!chain) return ['hook=', `dir=$(git rev-parse --git-common-dir 2>/dev/null) && hook="$dir/hooks/${name}"`]
  if (chain === '~' || chain.startsWith('~/')) return [`hook="$HOME"${sq(`${chain.slice(1).replace(/\/+$/, '')}/${name}`)}`]
  return [`hook=${sq(`${chain.replace(/\/+$/, '')}/${name}`)}`]
}
const RUNS = 'if [ -n "$hook" ] && [ -f "$hook" ] && [ -x "$hook" ] && ! [ "$hook" -ef "$0" ]; then'
const whose = (chain, name) => (chain ? `the hook ${name} in ${chain}` : `the repository's own .git/hooks/${name}`)

// What git does at a push to a checked-out branch with receive.denyCurrentBranch=updateInstead and
// no push-to-checkout hook (push_to_deploy in git's builtin/receive-pack.c): no push while the
// working tree or the index has changes, else both are brought to the pushed commit.
const UPDATE_INSTEAD = [
  'cd "${GIT_WORK_TREE:-.}" || exit 1',
  "git update-index -q --ignore-submodules --refresh || { echo 'Up-to-date check failed' >&2; exit 1; }",
  "git diff-files --quiet --ignore-submodules -- || { echo 'Working directory has unstaged changes' >&2; exit 1; }",
  'head=$(git rev-parse --verify --quiet HEAD) || head=$(git hash-object -t tree /dev/null)',
  "git diff-index --quiet --cached --ignore-submodules \"$head\" -- || { echo 'Working directory has staged changes' >&2; exit 1; }",
  'exec git read-tree -u -m "$1"',
]

/** The script of one hook: it runs the hook that git would run without Widal.Code. */
function passThrough(name, chain) {
  return [
    `${HEAD} a hook of git's global core.hooksPath, set by "widal connect". It runs ${whose(chain, name)}`,
    '# with the same arguments and input, as git would without Widal.Code. "widal disconnect" takes it out.',
    ...findHook(chain, name),
    `${RUNS} exec "$hook" "$@"; fi`,
    ...(name === 'push-to-checkout' ? ['# No hook of the repository\'s own: what git does without one.', ...UPDATE_INSTEAD] : ['exit 0']),
    '',
  ].join('\n')
}

/** The pre-push script: the hook that git would run without Widal.Code, with the same refs on its input, then the check. */
function prePushScript(chain, folder) {
  return [
    `${HEAD} the check before a push, set by "widal connect" as git's global core.hooksPath. It runs`,
    `# ${whose(chain, 'pre-push')} first, as git would without Widal.Code, then the check. "widal disconnect" takes it out.`,
    '# The refs that git gives on the input go to both, unchanged: the dot keeps the last line end.',
    'refs=$(cat; echo .)',
    'refs=${refs%.}',
    ...findHook(chain, 'pre-push'),
    RUNS,
    '  printf \'%s\' "$refs" | "$hook" "$@" || exit $?',
    'fi',
    `printf '%s' "$refs" | ${sq(join(folder, CHECK))} "$@"`,
    '',
  ].join('\n')
}

/**
 * The check alone: "widal hook pre-push" with node. Its code 10 stops the push (git gets 1). Any other
 * code but 0 means that the check failed: the push goes ahead, with one line that says so. Without
 * node it does the same.
 */
function checkScript({ node, command }) {
  return [
    `${HEAD} the check before a push alone ("widal hook pre-push"). It reads the refs of the push on its input.`,
    '# The node that "widal connect" ran with, else the one on the PATH.',
    `node=${sq(node)}`,
    '[ -x "$node" ] || node=$(command -v node 2>/dev/null) || node=',
    'if [ -z "$node" ]; then',
    "  echo 'Widal.Code: the check before this push did not run: node was not found.' >&2",
    '  exit 0',
    'fi',
    `"$node" ${sq(command)} hook pre-push "$@"`,
    'status=$?',
    '[ "$status" -eq 10 ] && exit 1',
    "[ \"$status\" -eq 0 ] || echo 'Widal.Code: the check before this push did not finish. The push goes ahead.' >&2",
    'exit 0',
    '',
  ].join('\n')
}

/** Writes every script into the folder, each as a whole, executable. */
function writeHooks(folder, { chain, node, command }) {
  mkdirSync(folder, { recursive: true })
  const scripts = [...HOOKS.map((name) => [name, name === 'pre-push' ? prePushScript(chain, folder) : passThrough(name, chain)]), [CHECK, checkScript({ node, command })]]
  for (const [name, text] of scripts) {
    const file = join(folder, name)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, text)
    chmodSync(tmp, 0o755)
    renameSync(tmp, file)
  }
}

/** Takes Widal.Code's scripts out of the folder, and the folder when nothing else is left in it. */
function removeHooks(folder) {
  for (const name of [...HOOKS, CHECK]) {
    const file = join(folder, name)
    try {
      if (readFileSync(file, 'utf8').startsWith(HEAD)) rmSync(file)
    } catch {
      // Not there.
    }
  }
  try {
    if (!readdirSync(folder).length) rmdirSync(folder)
  } catch {
    // Not there, or something of the person's is in it: it stays.
  }
}

/**
 * The repositories that Widal.Code knows on this computer: the one of `cwd`, those of the findings,
 * and those of the folders where Claude Code ran (the list of projects in each .claude.json, of which
 * nothing else is read). At most 300.
 */
export function knownRepos({ cwd } = {}) {
  const folders = new Set(cwd ? [cwd] : [])
  for (const f of readFindings()) if (typeof f.where?.repo === 'string') folders.add(f.where.repo)
  for (const dir of claudeDirs({ more: config().claudeDirs })) {
    const projects = readJson(claudeJsonOf(dir), undefined)?.projects
    if (projects && typeof projects === 'object' && !Array.isArray(projects)) for (const folder of Object.keys(projects)) folders.add(folder)
  }
  const repos = new Set()
  for (const folder of folders) {
    const repo = repoOf(folder)
    if (repo) repos.add(repo)
    if (repos.size >= 300) break
  }
  return [...repos]
}

/** Of these repositories, those where git does not run the scripts of `folder`: they set core.hooksPath for themselves. */
export function uncoveredRepos(repos, folder = hooksDir()) {
  return repos.filter((repo) => {
    const value = gitOut(['-C', repo, 'config', '--get', 'core.hooksPath'], repo)
    if (value === undefined) return false
    const path = expand(value)
    return !sameFolder(isAbsolute(path) ? path : resolve(repo, path), folder)
  })
}

/** The line that a repository's own pre-push hook can hold, so that the check runs there too. It does nothing on a computer without Widal.Code. */
export function teamLine(folder = hooksDir()) {
  const file = join(folder, CHECK)
  const shown = file.startsWith(`${homedir()}/`) ? `$HOME/${file.slice(homedir().length + 1)}` : file
  return `if [ -x "${shown}" ]; then "${shown}" "$@" || exit $?; fi`
}

/**
 * "widal connect" for git: writes the scripts, with `node` and the command's file `command`, and sets
 * git's global core.hooksPath to their folder. The value from before is kept for "widal disconnect",
 * and its hooks keep running. A second run renews the scripts and keeps the value from before the
 * first. Returns what it did, in lines, with the known repositories that set core.hooksPath for
 * themselves.
 */
export function connectGitHooks({ command, node = process.execPath, cwd = process.cwd() }) {
  if (!hasGit()) return ['git was not found, so the check before a push is not set up.']
  const folder = hooksDir()
  const now = globalHooksPath()
  const ours = sameFolder(now, folder)
  const state = readJson(stateFile(), {})
  const before = ours ? (typeof state?.before === 'string' ? state.before : undefined) : now
  // Without a global value of the person's, git ran the one for the whole computer, if any.
  const system = before === undefined ? gitOut(['config', '--system', '--get', 'core.hooksPath']) : undefined
  const chain = [before, system].find((p) => p !== undefined && !sameFolder(p, folder))
  writeHooks(folder, { chain, node, command })
  mkdirSync(home(), { recursive: true })
  writeJson(stateFile(), { before: before ?? null })
  if (!ours) setGlobalHooksPath(folder)
  const out = [ours
    ? `The check before a push was already set: git's global core.hooksPath is ${shortPath(folder)}. Its scripts are renewed.`
    : `Set git's global core.hooksPath to ${shortPath(folder)}: git runs the check before a push for every push from this computer, by an agent or by you. Each repository's own hooks still run.`]
  if (!ours && before !== undefined) out.push(`It was ${before} before. The hooks there still run, and "widal disconnect" puts that value back.`)
  const uncovered = uncoveredRepos(knownRepos({ cwd }), folder)
  if (uncovered.length) {
    out.push(`Not covered: ${uncovered.length === 1 ? 'this repository sets' : 'these repositories set'} core.hooksPath for ${uncovered.length === 1 ? 'itself' : 'themselves'} (husky does that), so git does not run the check before a push there:`)
    for (const repo of uncovered.slice(0, 10)) out.push(`  ${shortPath(repo)}`)
    if (uncovered.length > 10) out.push(`  and ${uncovered.length - 10} more`)
    out.push('To run the check there too, add this line to the repository\'s own pre-push hook (with husky: .husky/pre-push). On a computer without Widal.Code it does nothing:')
    out.push(`  ${teamLine(folder)}`)
  }
  return out
}

/**
 * "widal disconnect" for git: puts git's global core.hooksPath back to the value from before "widal
 * connect", or takes it out when there was none, and takes the scripts out. A value that the person
 * changed since stays. Returns what it did, in lines.
 */
export function disconnectGitHooks() {
  const folder = hooksDir()
  const state = readJson(stateFile(), undefined)
  const now = globalHooksPath()
  const out = []
  if (sameFolder(now, folder)) {
    const before = typeof state?.before === 'string' ? state.before : undefined
    setGlobalHooksPath(before)
    const system = before === undefined ? gitOut(['config', '--system', '--get', 'core.hooksPath']) : undefined
    out.push(before !== undefined ? `Put git's global core.hooksPath back to ${before}.`
      : `Took git's global core.hooksPath out again: git runs ${system !== undefined ? `the hooks in ${system}, which the computer's git config names` : 'each repository\'s own hooks'}.`)
  } else if (state && now !== undefined) out.push(`git's global core.hooksPath is ${now} now, not Widal.Code's folder, so it stays as it is.`)
  if (existsSync(folder)) {
    removeHooks(folder)
    out.push('Removed the check before a push.')
  }
  rmSync(stateFile(), { force: true })
  return out
}

/** The row of "widal doctor" about the check before a push. */
export function gitHooksRow() {
  const now = globalHooksPath()
  if (sameFolder(now, hooksDir()) && existsSync(join(hooksDir(), 'pre-push'))) return `set: git's global core.hooksPath is ${shortPath(hooksDir())}`
  return now !== undefined ? `not set: git's global core.hooksPath is ${now} (run: widal connect)` : 'not set (run: widal connect)'
}
