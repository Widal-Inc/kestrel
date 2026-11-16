// Tests for the store of findings. Run: node --test
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'kestrel-findings-test-'))
process.env.HOME = join(dir, 'person')
process.env.KESTREL_HOME = join(dir, 'home')
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
process.env.CODEX_HOME = join(dir, 'codex')
process.env.KESTREL_COWORK_DIR = join(dir, 'cowork')

const { countOpen, findingsFile, openFindings, readFindings, saveFindings, validFinding } = await import('../src/findings.mjs')

const NOW = Date.parse('2026-11-14T12:00:00')
const finding = (id, fields = {}) => ({
  id, rule: id.split(':')[0], kind: 'code', severity: 'high', title: 'A thing that was found', scope: 'repo:/work/app',
  where: { repo: '/work/app', file: 'a.py', line: 3 }, controls: [{ framework: 'hipaa', id: '164.312(e)', confirmed: true, label: 'Transmission security' }],
  fix: null, source: 'kestrel', ...fields,
})

test('a finding must have its fields, and may not hold what was matched', () => {
  assert.equal(validFinding(finding('code.tls-off:x')), true)
  for (const bad of [{ id: '' }, { kind: 'other' }, { severity: 'urgent' }, { title: '' }, { scope: undefined }, { match: 'AKIA...' }, { text: 'x' }, { where: { command: 'curl' } }, { controls: 'x' }]) {
    assert.equal(validFinding(finding('code.tls-off:x', bad)), false, JSON.stringify(bad))
  }
  assert.equal(validFinding(null), false)
})

test('a run of a check: new findings open, found again keeps the first time, not found again is resolved, other scopes stay', () => {
  saveFindings([finding('code.tls-off:1'), finding('code.secret:2', { severity: 'medium' })], { scope: 'repo:/work/app', kind: 'code', now: NOW })
  saveFindings([finding('set.bypass-mode', { kind: 'settings', scope: 'settings', where: {} })], { scope: 'settings', kind: 'settings', now: NOW })
  assert.equal(readFindings().length, 3)
  // Run again an hour later: one is found again, one is gone.
  const open = saveFindings([finding('code.tls-off:1')], { scope: 'repo:/work/app', kind: 'code', now: NOW + 3600e3 })
  assert.deepEqual(open.map((f) => f.id), ['code.tls-off:1'])
  const all = readFindings()
  const again = all.find((f) => f.id === 'code.tls-off:1')
  assert.equal(again.firstSeen, NOW)
  assert.equal(again.lastSeen, NOW + 3600e3)
  assert.equal(all.find((f) => f.id === 'code.secret:2').status, 'resolved')
  assert.equal(all.find((f) => f.id === 'set.bypass-mode').status, 'open')
  // A finding of another scope or kind in the run is left out, and so is an invalid one.
  saveFindings([finding('code.x:9', { scope: 'repo:/other' }), finding('code.y:9', { match: 'secret' })], { scope: 'repo:/work/app', kind: 'code', now: NOW + 7200e3 })
  assert.equal(readFindings().some((f) => f.id === 'code.x:9' || f.id === 'code.y:9'), false)
})

test('open findings: the most severe first, by repository, by least severity, and the counts', () => {
  saveFindings([finding('code.a:1', { severity: 'low' }), finding('code.b:1', { severity: 'high' })], { scope: 'repo:/work/app', kind: 'code', now: NOW })
  saveFindings([finding('code.c:1', { severity: 'medium', scope: 'repo:/work/api', where: { repo: '/work/api' } })], { scope: 'repo:/work/api', kind: 'code', now: NOW })
  assert.deepEqual(openFindings({ repo: '/work/app' }).map((f) => f.id), ['code.b:1', 'set.bypass-mode', 'code.a:1'])
  assert.deepEqual(openFindings({ least: 'medium' }).map((f) => f.severity), ['high', 'high', 'medium'])
  assert.deepEqual(countOpen(), { high: 2, medium: 1, low: 1, info: 0 })
  // The file holds nothing that was matched.
  assert.doesNotMatch(readFileSync(findingsFile(), 'utf8'), /"(match|text|secret|command)"/)
})

test('resolved findings older than 30 days are dropped', () => {
  saveFindings([], { scope: 'repo:/work/api', kind: 'code', now: NOW })
  assert.equal(readFindings().find((f) => f.id === 'code.c:1').status, 'resolved')
  saveFindings([], { scope: 'repo:/work/api', kind: 'code', now: NOW + 31 * 86400e3 })
  assert.equal(readFindings().some((f) => f.id === 'code.c:1'), false)
})
