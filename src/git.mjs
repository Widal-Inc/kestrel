// Local git questions. No network.
//
// An agent's log gives each call a branch name. It is the branch of the folder where the session
// started, and it stays the same when the session moves to a folder of another repository. So a
// call counts to a branch only when the folder it ran in belongs to a repository that has that
// branch.
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'

const known = new Map()

/**
 * The top folder of the git repository that a folder is in, as a real path, or undefined. It looks
 * for ".git" (a folder, or the file of a worktree) in the folder and the folders above it, and runs
 * no program, so that the status line and the hooks can call it on every run. The security checks
 * use it to tie a finding to its repository.
 */
export function repoOf(folder) {
  if (typeof folder !== 'string' || !isAbsolute(folder)) return undefined
  try {
    let dir = realpathSync(folder)
    for (let i = 0; i < 60; i++) {
      if (statSync(`${dir}/.git`, { throwIfNoEntry: false })) return dir
      const up = dirname(dir)
      if (up === dir) return undefined
      dir = up
    }
  } catch {
    // A folder that is gone is in no repository.
  }
  return undefined
}

/** Does the repository that `cwd` is in have the branch `name`? False for a folder that is gone or is not in a repository. */
export function branchInRepo(cwd, name) {
  if (!cwd || !name || name === 'HEAD') return false
  const key = `${cwd}\n${name}`
  if (!known.has(key)) {
    let ok = false
    if (existsSync(cwd)) {
      try {
        execFileSync('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { stdio: 'ignore' })
        ok = true
      } catch {
        // Not a repository, or no such branch in it.
      }
    }
    known.set(key, ok)
  }
  return known.get(key)
}

/** The branch that is checked out in the current folder, or undefined. */
export function currentBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
  } catch {
    return undefined
  }
}
