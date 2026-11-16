// Tests for "kestrel settings": every setting as data, "set" for each kind of value, the sets,
// wrong keys and values, undo, the frameworks of a repository, the older commands that change the
// same settings, and the list in a stand-in terminal. With made-up home folders. Run: node --test
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'kestrel-settings-test-'))
process.env.HOME = join(dir, 'home-folder')
process.env.KESTREL_HOME = join(dir, 'home')
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
process.env.CODEX_HOME = join(dir, 'codex')
process.env.KESTREL_COWORK_DIR = join(dir, 'cowork')
mkdirSync(process.env.HOME, { recursive: true })
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })

const { CHECKS_NOTE, accountsNow, settingsCommand, settingsData, settingsText, setSetting, undoSetting } = await import('../src/settings.mjs')
const { hudConfig } = await import('../src/hud.mjs')
const { hintConfig } = await import('../src/hint.mjs')
const { compactHintConfig } = await import('../src/compact.mjs')
const { nudgeConfig } = await import('../src/nudge.mjs')

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[/\\]$/, '')
const KESTREL = join(ROOT, 'cli', 'kestrel.mjs')

let homes = 0
/** A new, empty folder for this tool, so that each test starts with no settings. Returns its config file. */
function fresh() {
  process.env.KESTREL_HOME = join(dir, `home-${++homes}`)
  return join(process.env.KESTREL_HOME, 'config.json')
}
const readConfig = () => JSON.parse(readFileSync(join(process.env.KESTREL_HOME, 'config.json'), 'utf8'))
const writeConfig = (value) => {
  mkdirSync(process.env.KESTREL_HOME, { recursive: true })
  writeFileSync(join(process.env.KESTREL_HOME, 'config.json'), JSON.stringify(value))
}
/** Runs the command with every folder it reads or writes in the made-up home. */
const run = (args) => spawnSync(process.execPath, [KESTREL, ...args], {
  encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: process.env.HOME, KESTREL_HOME: process.env.KESTREL_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, KESTREL_COWORK_DIR: process.env.KESTREL_COWORK_DIR, NO_COLOR: '1' },
})
/** The value of one setting, as "settings --json" gives it. */
const valueOf = (key, options) => settingsData(options).settings.find((s) => s.key === key).value

const FRAMEWORK_KEYS = ['hipaa', 'hitrust', 'soc2', 'iso27001', 'part11', 'annex11', 'gdpr', 'pci', 'glba', 'nydfs', 'dora', 'owasp-agentic', 'owasp-llm', 'nist-ai-rmf', 'iso42001']
const ALL_KEYS = [
  'hud.layout', 'hud.lines.session', 'hud.lines.plan', 'hud.lines.work', 'hud.lines.hint', 'hud.bars', 'hud.names',
  'hint.effort', 'hint.compact', 'hint.nudge',
  ...FRAMEWORK_KEYS.map((id) => `security.frameworks.${id}`),
  'security.checks.settings', 'security.checks.actions', 'security.checks.code', 'security.checks.data', 'security.checks.cloud', 'security.checks.push',
]

test('"kestrel settings --json" lists every setting with its value, allowed values, label, group and default, the sets, and the sentence about the checks', () => {
  fresh()
  const r = run(['settings', '--json'])
  assert.deepEqual([r.status, r.stderr], [0, ''])
  const data = JSON.parse(r.stdout)
  assert.deepEqual(data.settings.map((s) => s.key), ALL_KEYS)
  for (const s of data.settings) {
    assert.deepEqual(Object.keys(s).sort(), ['default', 'group', 'key', 'kind', 'label', 'value', 'values'], s.key)
    assert.ok(s.label.length > 1 && s.values.includes(s.value) && s.values.includes(s.default), s.key)
    assert.equal(s.kind, s.key === 'hud.layout' ? 'choice' : 'on-off', s.key)
    // Nothing is set yet, so each value is its default.
    assert.equal(s.value, s.default, s.key)
  }
  const by = Object.fromEntries(data.settings.map((s) => [s.key, s]))
  assert.deepEqual(by['hud.layout'].values, ['lines', 'one'])
  assert.equal(by['security.frameworks.hipaa'].label, 'HIPAA')
  assert.equal(by['security.frameworks.nydfs'].label, 'NYDFS 23 NYCRR 500')
  assert.equal(by['security.frameworks.owasp-agentic'].label, 'OWASP Top 10 for Agentic Applications')
  // The defaults: OWASP Top 10 for Agentic Applications is on for everyone, the data and cloud checks are off, the other checks on.
  assert.deepEqual(data.settings.filter((s) => s.key.startsWith('security.frameworks.') && s.value === 'on').map((s) => s.key), ['security.frameworks.owasp-agentic'])
  assert.deepEqual(data.settings.filter((s) => s.key.startsWith('security.checks.') && s.value === 'off').map((s) => s.key), ['security.checks.data', 'security.checks.cloud'])
  assert.equal(by['hint.nudge'].value, 'off')
  // The groups, in order.
  assert.deepEqual([...new Set(data.settings.map((s) => s.group))], ['Status line', 'Hints', 'Frameworks: Healthcare', 'Frameworks: Life sciences', 'Frameworks: Fintech', 'Frameworks: AI agents', 'Checks'])
  assert.deepEqual(data.sets, [
    { key: 'security.set', value: 'healthcare', label: 'Healthcare', frameworks: ['hipaa', 'soc2', 'hitrust'] },
    { key: 'security.set', value: 'life-sciences', label: 'Life sciences', frameworks: ['part11', 'annex11', 'soc2'] },
    { key: 'security.set', value: 'fintech', label: 'Fintech', frameworks: ['soc2', 'pci', 'glba'] },
  ])
  assert.equal(data.note, 'Kestrel checks technical controls and flags risks. It does not make a company compliant or certify it.')
  assert.deepEqual(data.frameworks, { on: ['owasp-agentic'], from: 'person', file: null, project: null })
  // "kestrel accounts" finds no account in the empty test folders, and there is nothing to take back yet.
  assert.deepEqual(data.accounts, [])
  assert.equal(data.undo, false)
  // Asking changed no setting. (Asking for the accounts may write Kestrel's cache of the logs.)
  assert.equal(existsSync(join(process.env.KESTREL_HOME, 'config.json')), false)
})

test('"set" for each kind of value: on and off, a choice, the lines of the status line, the hints, the frameworks and the checks', () => {
  fresh()
  assert.equal(setSetting('hud.bars', 'off'), 'Saved: Bars for the context and the limits: off.\nTake it back with: kestrel settings undo')
  assert.equal(hudConfig().bars, false)
  assert.equal(setSetting('hud.layout', 'one'), 'Saved: Layout of the status line: one line.\nTake it back with: kestrel settings undo')
  assert.equal(hudConfig().layout, 'one')
  setSetting('hud.names', 'off')
  assert.deepEqual(readConfig().hud, { layout: 'one', lines: ['session', 'plan', 'work', 'hint'], bars: false, names: false })

  // A line goes, and comes back at its place in the usual order, also in a list of the person's own order.
  setSetting('hud.lines.plan', 'off')
  assert.deepEqual(hudConfig().lines, ['session', 'work', 'hint'])
  writeConfig({ hud: { lines: ['work', 'session'] } })
  setSetting('hud.lines.plan', 'on')
  assert.deepEqual(hudConfig().lines, ['work', 'session', 'plan'])
  setSetting('hud.lines.session', 'off')
  setSetting('hud.lines.plan', 'off')
  // The last line stays: without any, the status line would fall back to all four.
  assert.throws(() => setSetting('hud.lines.work', 'off'), { message: 'At least one line of the status line stays on. For one line, use: kestrel settings set hud.layout one' })
  assert.deepEqual(hudConfig().lines, ['work'])

  // The three hints are three settings. Each keeps the other settings of its hint.
  fresh()
  writeConfig({ nudge: { before: 7, min: 200000 }, compactHint: { growth: 90000 } })
  setSetting('hint.effort', 'off')
  assert.equal(hintConfig().on, false)
  assert.equal(compactHintConfig().on, true)
  setSetting('hint.compact', 'off')
  assert.deepEqual([compactHintConfig().on, compactHintConfig().growth], [false, 90000])
  assert.equal(setSetting('hint.nudge', 'on'), 'Saved: The notification before a cache ends: on.\nTake it back with: kestrel settings undo')
  assert.deepEqual(nudgeConfig(), { on: true, before: 7, min: 200000 })

  // A framework and a check: both carry the sentence that Kestrel checks technical controls and certifies nothing.
  fresh()
  assert.equal(setSetting('security.frameworks.hipaa', 'on'), `Saved: HIPAA: on.\n${CHECKS_NOTE}\nTake it back with: kestrel settings undo`)
  assert.deepEqual(readConfig().security, { frameworks: ['hipaa', 'owasp-agentic'] })
  assert.equal(setSetting('security.frameworks.hipaa', 'on'), 'HIPAA was already on. Nothing changed.')
  setSetting('security.frameworks.owasp-agentic', 'off')
  assert.deepEqual(readConfig().security.frameworks, ['hipaa'])
  assert.equal(setSetting('security.checks.data', 'on'), `Saved: Data (it reads the text of sessions): on.\n${CHECKS_NOTE}\nTake it back with: kestrel settings undo`)
  setSetting('security.checks.push', 'off')
  assert.deepEqual(readConfig().security, { frameworks: ['hipaa'], checks: { data: true, push: false } })
  assert.equal(valueOf('security.checks.data'), 'on')
  assert.equal(valueOf('security.checks.push'), 'off')
  assert.equal(valueOf('security.checks.code'), 'on')
})

test('the sets switch their frameworks on, keep the others, and say when all were already on', () => {
  fresh()
  assert.equal(setSetting('security.set', 'healthcare'), `Saved: the Healthcare set switched on HIPAA, SOC 2 and HITRUST CSF.\n${CHECKS_NOTE}\nTake it back with: kestrel settings undo`)
  assert.deepEqual(readConfig().security.frameworks, ['hipaa', 'hitrust', 'soc2', 'owasp-agentic'])
  setSetting('security.set', 'life-sciences')
  setSetting('security.set', 'fintech')
  assert.deepEqual(readConfig().security.frameworks, ['hipaa', 'hitrust', 'soc2', 'part11', 'annex11', 'pci', 'glba', 'owasp-agentic'])
  assert.equal(setSetting('security.set', 'fintech'), 'The frameworks of the Fintech set were already on. Nothing changed.')
  // The command takes the same words.
  fresh()
  const r = run(['settings', 'set', 'security.set', 'healthcare'])
  assert.deepEqual([r.status, r.stderr], [0, ''])
  assert.deepEqual(readConfig().security.frameworks, ['hipaa', 'hitrust', 'soc2', 'owasp-agentic'])
})

test('a wrong key, value or word: one plain sentence, exit code 1, and nothing saved', () => {
  const config = fresh()
  writeConfig({ hud: { bars: false } })
  const before = readFileSync(config, 'utf8')
  const cases = [
    [['settings', 'set', 'hud.colour', 'on'], 'kestrel: "hud.colour" is not a setting. See them all with: kestrel settings\n'],
    [['settings', 'set', 'hud.bars', 'maybe'], 'kestrel: "maybe" is not a value of hud.bars. Use one of: on, off.\n'],
    [['settings', 'set', 'hud.layout', 'two'], 'kestrel: "two" is not a value of hud.layout. Use one of: lines, one.\n'],
    [['settings', 'set', 'security.set', 'retail'], 'kestrel: "retail" is not a set. The sets are: healthcare, life-sciences, fintech.\n'],
    [['settings', 'set', 'hud.bars'], 'kestrel: Use "kestrel settings set <key> <value>", for example: kestrel settings set security.frameworks.hipaa on\n'],
    [['settings', 'set', 'hud.bars', 'on', 'more'], 'kestrel: Use "kestrel settings set <key> <value>", for example: kestrel settings set security.frameworks.hipaa on\n'],
    [['settings', 'toggle'], 'kestrel: "toggle" is not one of set, undo. Use "kestrel settings", "kestrel settings set <key> <value>" or "kestrel settings undo".\n'],
    [['settings', 'undo', 'now'], 'kestrel: "kestrel settings undo" takes no more words, and "now" was given.\n'],
    [['settings', 'set', 'hud.bars', 'on', '--project', dir], 'kestrel: Only the frameworks can be set for a project. Set hud.bars without --project.\n'],
    [['settings', 'set', 'security.frameworks.hipaa', 'on', '--project', join(dir, 'missing')], `kestrel: The folder ${join(dir, 'missing')} is not there.\n`],
    [['settings', 'set', 'security.frameworks.hipaa', 'on', '--project'], 'kestrel: --project needs a folder, for example: kestrel settings --project .\n'],
  ]
  for (const [args, said] of cases) {
    const r = run(args)
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, '', said], args.join(' '))
    // One sentence or two short ones, on one line.
    assert.equal(r.stderr.trim().split('\n').length, 1, args.join(' '))
  }
  assert.equal(readFileSync(config, 'utf8'), before)
  assert.equal(existsSync(join(process.env.KESTREL_HOME, 'settings-undo.json')), false)
})

test('undo puts back what the last change replaced, one step, and a key that was not there goes again', () => {
  fresh()
  writeConfig({ hud: { bars: false }, limits: { day: 20, action: 'ask' } })
  setSetting('hud.names', 'off')
  assert.equal(settingsData().undo, true)
  assert.equal(undoSetting(), 'Taken back: Names of tasks and agents, on your screen (and on the Kestrel board, when linked): off. The setting is as it was before.')
  assert.deepEqual(readConfig(), { hud: { bars: false }, limits: { day: 20, action: 'ask' } })
  assert.equal(undoSetting(), 'There is no change to take back.')
  assert.equal(settingsData().undo, false)

  // Only the last change is kept.
  setSetting('security.frameworks.hipaa', 'on')
  setSetting('security.frameworks.gdpr', 'on')
  undoSetting()
  assert.deepEqual(readConfig().security.frameworks, ['hipaa', 'owasp-agentic'])
  assert.equal(undoSetting(), 'There is no change to take back.')

  // A key that the change added goes when it is taken back.
  fresh()
  setSetting('hint.nudge', 'on')
  undoSetting()
  assert.deepEqual(readConfig(), {})
  // The command does the same.
  setSetting('hud.layout', 'one')
  const r = run(['settings', 'undo'])
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'Taken back: Layout of the status line: one line. The setting is as it was before.\n', ''])
  assert.equal(hudConfig().layout, 'lines')
})

test('the frameworks of a repository: written with the other keys kept, read back, winning over the person\'s setting, and undone', () => {
  fresh()
  const repo = mkdtempSync(join(dir, 'repo-'))
  const file = join(repo, '.claude', 'loobster-frameworks.json')
  mkdirSync(join(repo, '.claude'))
  writeFileSync(file, JSON.stringify({ frameworks: ['pci', 'custom-x'], owner: 'loobster', rules: { strict: true } }))
  // The person's own setting is different.
  setSetting('security.frameworks.hipaa', 'on')

  const r = run(['settings', 'set', 'security.frameworks.gdpr', 'on', '--project', repo])
  assert.deepEqual([r.status, r.stderr], [0, ''])
  assert.equal(r.stdout, `Saved for ${repo}: GDPR: on.\nWritten to ${file}.\n${CHECKS_NOTE}\nTake it back with: kestrel settings undo\n`)
  // Every other key stays, and so does a framework that Kestrel does not know.
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { frameworks: ['gdpr', 'pci', 'custom-x'], owner: 'loobster', rules: { strict: true } })
  // The person's own setting did not change.
  assert.deepEqual(readConfig().security.frameworks, ['hipaa', 'owasp-agentic'])

  // Read back: for the repository its file wins. Without --project the person's setting shows.
  const shown = JSON.parse(run(['settings', '--json', '--project', repo]).stdout)
  assert.deepEqual(shown.frameworks, { on: ['gdpr', 'pci'], from: 'project', file, project: repo })
  assert.equal(shown.settings.find((s) => s.key === 'security.frameworks.hipaa').value, 'off')
  assert.equal(shown.settings.find((s) => s.key === 'security.frameworks.gdpr').value, 'on')
  assert.equal(valueOf('security.frameworks.hipaa'), 'on')
  assert.equal(valueOf('security.frameworks.gdpr'), 'off')

  // A set for the repository, and undo puts its file back as it was, other keys and all.
  setSetting('security.set', 'healthcare', { project: repo })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).frameworks, ['hipaa', 'hitrust', 'soc2', 'gdpr', 'pci', 'custom-x'])
  assert.equal(undoSetting(), 'Taken back: the Healthcare set. The setting is as it was before.')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { frameworks: ['gdpr', 'pci', 'custom-x'], owner: 'loobster', rules: { strict: true } })

  // A repository without the file: it starts from what the person has on, and undo takes the file away again.
  const other = mkdtempSync(join(dir, 'repo-'))
  const made = join(other, '.claude', 'loobster-frameworks.json')
  assert.deepEqual(settingsData({ project: other }).frameworks, { on: ['hipaa', 'owasp-agentic'], from: 'person', file: made, project: other })
  setSetting('security.frameworks.soc2', 'on', { project: other })
  assert.equal(readFileSync(made, 'utf8'), `${JSON.stringify({ frameworks: ['hipaa', 'soc2', 'owasp-agentic'] }, null, 2)}\n`)
  undoSetting()
  assert.equal(existsSync(made), false)

  // A file that is not a JSON object is never written over.
  writeFileSync(file, '{ not json')
  assert.throws(() => setSetting('security.frameworks.dora', 'on', { project: repo }), { message: `${file} is not valid JSON, so Kestrel leaves it as it is.` })
  assert.equal(readFileSync(file, 'utf8'), '{ not json')
})

test('the older commands change the same settings, and "kestrel settings" shows what they set', () => {
  fresh()
  assert.equal(run(['hud', 'bars', 'off']).status, 0)
  assert.equal(run(['hint', 'off']).status, 0)
  assert.equal(run(['nudge', 'on']).status, 0)
  const data = JSON.parse(run(['settings', '--json']).stdout)
  const by = Object.fromEntries(data.settings.map((s) => [s.key, s.value]))
  assert.deepEqual([by['hud.bars'], by['hint.effort'], by['hint.compact'], by['hint.nudge']], ['off', 'off', 'off', 'on'])
  // And the other way: what "settings set" changes, the older commands show.
  assert.equal(run(['settings', 'set', 'hint.nudge', 'off']).status, 0)
  assert.match(run(['nudge']).stdout, /^Notification before a session's cache ends: off /)
  assert.equal(run(['settings', 'set', 'hud.layout', 'one']).status, 0)
  assert.match(run(['hud']).stdout, /^The status line shows one line/)
  // "kestrel hud undo" still takes back its own last change.
  assert.equal(run(['hud', 'names', 'off']).status, 0)
  assert.equal(run(['hud', 'undo']).status, 0)
  assert.equal(hudConfig().names, true)
})

test('without a terminal "kestrel settings" prints the settings as text, with the commands that change them', async () => {
  fresh()
  const r = run(['settings'])
  assert.deepEqual([r.status, r.stderr], [0, ''])
  const out = r.stdout
  assert.ok(out.startsWith('Kestrel settings. Change one with: kestrel settings set <key> <value>\n\nStatus line\n'), out)
  assert.match(out, /^ {2}hud\.layout +lines \(up to four lines\) +Layout of the status line$/m)
  assert.match(out, /^ {2}security\.frameworks\.hipaa +off +HIPAA$/m)
  assert.match(out, /^ {2}kestrel settings set security\.set healthcare +HIPAA, SOC 2, HITRUST CSF$/m)
  assert.ok(out.includes(`\n${CHECKS_NOTE}\n`))
  assert.ok(out.endsWith('Take the last change back with: kestrel settings undo\n'))
  // A folder with its own frameworks says so.
  const repo = mkdtempSync(join(dir, 'repo-'))
  mkdirSync(join(repo, '.claude'))
  writeFileSync(join(repo, '.claude', 'loobster-frameworks.json'), JSON.stringify({ frameworks: ['hipaa'] }))
  assert.match(settingsText(settingsData(), { cwd: repo }), /\nThis folder has frameworks of its own in .+loobster-frameworks\.json\. Show them with: kestrel settings --project \.\n/)
  assert.match(settingsText(settingsData({ project: repo }), { cwd: repo }), /\nThe frameworks above are those of .+, from .+loobster-frameworks\.json\.\n/)
  // The same text comes from the function when the output is not a terminal.
  const text = await settingsCommand([], { output: { isTTY: false }, input: { isTTY: false }, loadAccounts: () => null })
  assert.equal(text, settingsText(settingsData()))
})

test('the accounts come from "kestrel accounts --json" when it is there, with only what a label needs', async () => {
  fresh()
  const contract = {
    days: 7, current: 'claude:aaa',
    accounts: [
      { key: 'claude:aaa', label: 'Widal, Inc.', kind: 'subscription', tool: 'Claude Code', plan: 'max', limits: { five: null, week: null }, today: { tokens: 5, cost: 1 }, period: { tokens: 9, cost: 2, sessions: 1 }, lastSeen: 1 },
      { key: 'api', label: 'api', kind: 'usage', tool: 'Claude Code', plan: null, limits: { five: null, week: null }, today: { tokens: 0, cost: 0 }, period: { tokens: 0, cost: 0, sessions: 0 }, lastSeen: 1 },
    ],
  }
  const accounts = accountsNow(() => ({ status: 0, stdout: JSON.stringify(contract) }))
  assert.deepEqual(accounts, [
    { key: 'claude:aaa', label: 'Widal, Inc.', tool: 'Claude Code', kind: 'subscription', plan: 'max' },
    { key: 'api', label: 'api', tool: 'Claude Code', kind: 'usage', plan: null },
  ])
  // An unknown command, a failure or an answer that is not the contract: no accounts.
  assert.equal(accountsNow(() => ({ status: 2, stdout: '', stderr: 'Unknown command "accounts".' })), null)
  assert.equal(accountsNow(() => ({ status: 0, stdout: 'not json' })), null)
  assert.equal(accountsNow(() => ({ status: 0, stdout: '{}' })), null)
  // The real command finds no account in the empty test folders.
  assert.deepEqual(accountsNow(), [])
  const json = JSON.parse(await settingsCommand([], { json: true, loadAccounts: () => accounts }))
  assert.deepEqual(json.accounts, accounts)
  const text = settingsText(settingsData({ accounts }))
  assert.match(text, /\nAccounts:\n {2}claude:aaa +Widal, Inc\.\n {2}api +api\nChange a label with: kestrel accounts label <key> "<label>"\n/)
})

/** A stand-in for a terminal: standard input in raw mode, and standard output that keeps what is written. */
function terminal() {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true, isRaw: false, modes: [],
    setRawMode(on) {
      this.modes.push(on)
      this.isRaw = on
      return this
    },
    resume() {},
    pause() {},
  })
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 120, rows: 60, writes: [], write(s) { this.writes.push(String(s)) } })
  return { input, output }
}
/** The last screen drawn, as lines without the codes that clear a line. */
const screen = (output) => output.writes.filter((w) => w.startsWith('\x1b[H')).at(-1).replace(/^\x1b\[H/, '').replace(/\x1b\[J$/, '').split('\r\n').map((line) => line.replace(/\x1b\[K$/, ''))
const pause = () => new Promise((resolve) => setImmediate(resolve))

test('the list in a terminal: move, toggle, cycle, a set, undo, quit, and the terminal put back', async () => {
  fresh()
  const { input, output } = terminal()
  const done = settingsCommand([], { input, output, loadAccounts: () => null })
  await pause()
  let lines = screen(output)
  assert.equal(lines[0], 'Kestrel settings · up and down (or j and k) move, space or Enter changes, u undoes, q quits')
  assert.equal(lines[2], 'Status line')
  // The cursor starts on the first setting.
  assert.equal(lines[3], '> Layout of the status line: lines (up to four lines)')
  assert.ok(lines.includes(`${CHECKS_NOTE}`))
  // Space on a choice moves it to the next value.
  input.emit('data', ' ')
  assert.equal(hudConfig().layout, 'one')
  // Down with an arrow key and with j: the cursor is on the line "plan".
  input.emit('data', '\x1b[B')
  input.emit('data', 'j')
  lines = screen(output)
  assert.ok(lines.includes('> [x] Line "plan": the plan\'s limits or the dollars, and today\'s tokens'), lines.join('\n'))
  assert.ok(lines.includes('  [x] Line "session": the model, the folder, the context, the cache'))
  // Enter toggles it off. The message says what was saved.
  input.emit('data', '\r')
  lines = screen(output)
  assert.ok(lines.includes('> [ ] Line "plan": the plan\'s limits or the dollars, and today\'s tokens'))
  assert.equal(lines.at(-1), 'Saved: Line "plan": the plan\'s limits or the dollars, and today\'s tokens: off.')
  assert.deepEqual(hudConfig().lines, ['session', 'work', 'hint'])
  // u undoes it.
  input.emit('data', 'u')
  assert.deepEqual(hudConfig().lines, ['session', 'plan', 'work', 'hint'])
  assert.match(screen(output).at(-1), /^Taken back: /)
  // k goes up again. Several keys in one chunk all count.
  input.emit('data', 'kk')
  assert.ok(screen(output).includes('> Layout of the status line: one (one line)'))
  // Down to the first set, and space switches its frameworks on. The headings are skipped.
  const toSet = screen(output).length
  for (let i = 0; i < 40 && !screen(output).some((l) => l.startsWith('> Healthcare: ')); i++) input.emit('data', 'j')
  assert.ok(screen(output).includes('> Healthcare: HIPAA, SOC 2, HITRUST CSF'), String(toSet))
  input.emit('data', ' ')
  assert.deepEqual(readConfig().security.frameworks, ['hipaa', 'hitrust', 'soc2', 'owasp-agentic'])
  assert.ok(screen(output).includes('  [x] HIPAA'))
  input.emit('data', 'q')
  assert.equal(await done, undefined)
  // The other screen of the terminal and a hidden cursor while it runs, both back at the end.
  assert.equal(output.writes[0], '\x1b[?1049h\x1b[?25l')
  assert.equal(output.writes.at(-1), '\x1b[?25h\x1b[?1049l')
  assert.deepEqual(input.modes, [true, false])
  assert.equal(input.listenerCount('data'), 0)
})

test('the list ends with Ctrl+C too, and after an error the terminal is put back first', async () => {
  fresh()
  let t = terminal()
  let done = settingsCommand([], { input: t.input, output: t.output, loadAccounts: () => null })
  await pause()
  t.input.emit('data', Buffer.from([3]))
  await done
  assert.deepEqual(t.input.modes, [true, false])
  assert.equal(t.output.writes.at(-1), '\x1b[?25h\x1b[?1049l')

  // A draw that fails: the error comes through, after the terminal is put back.
  t = terminal()
  done = settingsCommand([], { input: t.input, output: t.output, loadAccounts: () => null })
  await pause()
  const write = t.output.write
  t.output.write = function (s) {
    if (String(s).startsWith('\x1b[H')) throw new Error('the screen broke')
    write.call(this, s)
  }
  t.input.emit('data', 'j')
  await assert.rejects(done, /the screen broke/)
  assert.deepEqual(t.input.modes, [true, false])
  assert.equal(t.output.writes.at(-1), '\x1b[?25h\x1b[?1049l')
  assert.equal(t.input.listenerCount('data'), 0)

  // A setting that cannot change shows its sentence in the list, and the list goes on.
  t = terminal()
  writeConfig({ hud: { lines: ['plan'] } })
  done = settingsCommand([], { input: t.input, output: t.output, loadAccounts: () => null })
  await pause()
  for (let i = 0; i < 10 && !screen(t.output).includes('> [x] Line "plan": the plan\'s limits or the dollars, and today\'s tokens'); i++) t.input.emit('data', 'j')
  t.input.emit('data', ' ')
  assert.equal(screen(t.output).at(-1), 'At least one line of the status line stays on. For one line, use: kestrel settings set hud.layout one')
  t.input.emit('data', 'q')
  await done
  assert.deepEqual(hudConfig().lines, ['plan'])
})
