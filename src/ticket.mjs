// The ticket a session works on, and its git branch.
//
// Widal.Code learns the ticket from the name of the git branch, for example "user/abc-322-the-plugin"
// gives ABC-322. A branch name is not text of a session, so the ticket can be kept and shown, and
// sent to the team view, without reading what anybody wrote.
import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

// Words that look like a ticket key in a branch name but name a kind of change, such as
// "fix-123" or "release-2026".
const NOT_KEYS = new Set(['FIX', 'FEAT', 'FEATURE', 'BUG', 'BUGFIX', 'HOTFIX', 'RELEASE', 'CHORE', 'DOCS', 'TEST', 'WIP', 'PR', 'V'])

/**
 * The ticket in a branch name, such as "ABC-322", or undefined. A ticket is 2 to 6 letters (a
 * digit may follow the first letter), a dash and 1 to 6 digits, standing alone between the start,
 * the end, "/", "_" or "-". The first one counts.
 */
export function ticketOf(branch) {
  if (typeof branch !== 'string') return undefined
  const found = branch.matchAll(/(?:^|[/_-])([a-z][a-z0-9]{1,5})-(\d{1,6})(?=$|[/_-])/gi)
  for (const [, key, number] of found) {
    const upper = key.toUpperCase()
    if (!NOT_KEYS.has(upper)) return `${upper}-${number}`
  }
  return undefined
}

/**
 * The git branch of a folder, from the HEAD file of its repository, or undefined: no repository,
 * a detached HEAD, or a file that cannot be read. It reads two small files at most and runs no
 * program, so the status line can call it on every run.
 */
export function branchOf(folder) {
  if (typeof folder !== 'string' || !isAbsolute(folder)) return undefined
  try {
    let dir = resolve(folder)
    for (let i = 0; i < 40; i++) {
      const git = join(dir, '.git')
      const found = statSync(git, { throwIfNoEntry: false })
      if (found) {
        // A worktree or a submodule has a file ".git" that names the real folder.
        const gitDir = found.isDirectory() ? git : resolve(dir, /^gitdir: (.+)$/m.exec(readFileSync(git, 'utf8'))?.[1]?.trim() ?? '')
        const head = readFileSync(join(gitDir, 'HEAD'), 'utf8')
        return /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim() || undefined
      }
      const up = dirname(dir)
      if (up === dir) return undefined
      dir = up
    }
  } catch {
    // Not readable: no branch.
  }
  return undefined
}
