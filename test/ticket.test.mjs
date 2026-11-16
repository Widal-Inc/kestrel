// Tests for the ticket of a branch, the branch of a folder, and the file of today's numbers.
// Run: node --test
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'kestrel-ticket-test-'))
// Kestrel also reads the config folders of Claude Code in the home folder, so the home folder is a
// made-up one too.
process.env.HOME = join(dir, 'person')
process.env.KESTREL_HOME = join(dir, 'home')
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
process.env.CODEX_HOME = join(dir, 'codex')
process.env.KESTREL_COWORK_DIR = join(dir, 'cowork')

const { branchOf, ticketOf } = await import('../src/ticket.mjs')
const { REFRESH_EVERY, localDay, readToday, todayDue, writeToday } = await import('../src/today-file.mjs')

test('the ticket of a branch name', () => {
  assert.equal(ticketOf('user/abc-322-the-plugin'), 'ABC-322')
  assert.equal(ticketOf('ABC-322'), 'ABC-322')
  assert.equal(ticketOf('feature/ABC-12_login'), 'ABC-12')
  assert.equal(ticketOf('car-3511'), 'CAR-3511')
  assert.equal(ticketOf('x2-7'), 'X2-7')
  // A kind of change is not a ticket key, and the next candidate counts.
  assert.equal(ticketOf('fix-123'), undefined)
  assert.equal(ticketOf('release-2026'), undefined)
  assert.equal(ticketOf('fix-12/abc-9'), 'ABC-9')
  // Not standing alone, too long, or no number.
  assert.equal(ticketOf('main'), undefined)
  assert.equal(ticketOf('polecat/hd-2wm'), undefined)
  assert.equal(ticketOf('abcdefg-12'), undefined)
  assert.equal(ticketOf('abc-1234567'), undefined)
  assert.equal(ticketOf('myabc-12x'), undefined)
  assert.equal(ticketOf(undefined), undefined)
  assert.equal(ticketOf(42), undefined)
})

test('the branch of a folder, from the HEAD file of its repository, also in a sub folder and in a worktree', () => {
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/user/abc-322-the-plugin\n')
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
  assert.equal(branchOf(repo), 'user/abc-322-the-plugin')
  assert.equal(branchOf(join(repo, 'src', 'deep')), 'user/abc-322-the-plugin')
  // A worktree: ".git" is a file that names the real folder.
  const real = join(dir, 'real-git-dir')
  mkdirSync(real, { recursive: true })
  writeFileSync(join(real, 'HEAD'), 'ref: refs/heads/plan/desktop\n')
  const tree = join(dir, 'tree')
  mkdirSync(tree, { recursive: true })
  writeFileSync(join(tree, '.git'), `gitdir: ${real}\n`)
  assert.equal(branchOf(tree), 'plan/desktop')
  // A detached HEAD, no repository, a broken file, and no absolute folder.
  writeFileSync(join(real, 'HEAD'), '3f0c30d0000000000000000000000000000000000\n')
  assert.equal(branchOf(tree), undefined)
  const none = join(dir, 'none')
  mkdirSync(none, { recursive: true })
  assert.equal(branchOf(none), undefined)
  writeFileSync(join(tree, '.git'), 'nonsense')
  assert.equal(branchOf(tree), undefined)
  assert.equal(branchOf('relative/path'), undefined)
  assert.equal(branchOf(undefined), undefined)
})

test('today\'s numbers: written and read back for the same day, not for another day, and due after 5 minutes', () => {
  const now = Date.parse('2026-11-14T16:05:00')
  assert.equal(readToday(now), undefined)
  assert.equal(todayDue(now), true)
  const value = { day: localDay(now), at: now, tokens: 41e6, cacheRead: 39.4e6, coldStarts: 3, coldTokens: 1.4e6, sessions: {}, tickets: {} }
  writeToday(value)
  assert.deepEqual(readToday(now), value)
  assert.equal(todayDue(now + REFRESH_EVERY - 1), false)
  assert.equal(todayDue(now + REFRESH_EVERY), true)
  // The next day the file says nothing.
  assert.equal(readToday(now + 86400e3), undefined)
  // A broken file says nothing either.
  writeFileSync(join(process.env.KESTREL_HOME, 'today.json'), '{ not json')
  assert.equal(readToday(now), undefined)
})
