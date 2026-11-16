// Tests for the change of name from agent-spend to Kestrel: the command under its old name, the
// folder under its old name, and the move of an old install. With made-up home folders and
// settings. Run: node --test
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'kestrel-migrate-test-'))
// Kestrel also reads the config folders of Claude Code in the home folder, so the home folder is a
// made-up one too.
process.env.HOME = join(dir, 'person')
process.env.KESTREL_HOME = join(dir, 'home')
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
process.env.CODEX_HOME = join(dir, 'codex')
// Cowork's folder too: without this a test would read the real Cowork logs of whoever runs it.
process.env.KESTREL_COWORK_DIR = join(dir, 'cowork')
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })

const KESTREL = fileURLToPath(new URL('../cli/kestrel.mjs', import.meta.url))
const AGENT_SPEND = fileURLToPath(new URL('../cli/agent-spend.mjs', import.meta.url))

/**
 * A made-up machine: the empty home folder of a person, below `name`. Returns the folder and a
 * function that runs the command there. The command gets nothing of the real environment but
 * the PATH. KESTREL_HOME is not set, so that the command looks for its folder in the home
 * folder, as it does on a real machine. `more` sets further variables for every run.
 *
 * `run` takes the arguments of the command, and then `bin` (the file to run, the new command
 * unless another is given), `input` (what the command gets on stdin) and `env` (further
 * variables for this one run).
 */
function machine(name, more = {}) {
  const home = join(dir, name)
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), KESTREL_COWORK_DIR: join(home, 'cowork'), NO_COLOR: '1', ...more }
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true })
  // The command reaches into the home folder. A test must only ever reach the made-up one.
  assert.equal(spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], { encoding: 'utf8', env }).stdout, home)
  const run = (args, { bin = KESTREL, input, env: forRun = {} } = {}) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', input, env: { ...env, ...forRun } })
  return { home, env, run }
}

/** The exit code of a run, and what it printed. */
const result = (r) => [r.status, r.stdout, r.stderr]

/** The lines that a run printed. */
const lines = (r) => r.stdout.split('\n')

/** The value in one row of what "status" printed, for example the row "Command on PATH". */
const row = (r, name) => lines(r).find((line) => line.startsWith(name))?.slice(name.length).trim()

/**
 * A tool folder with settings that name a text for the compaction hook. The hook prints that text, so it shows which folder the command read.
 * The settings also choose the one line, so that the status line prints LINE.
 */
function folderWithText(folder, text) {
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'config.json'), JSON.stringify({ compactKeep: { text }, hud: { layout: 'one' } }))
}

/** What Claude Code gives the status line: a session on a subscription, with nothing in it that changes with the time. */
const SESSION = JSON.stringify({
  session_id: 'one', cwd: '/work/repo', model: { id: 'claude-opus-5-5' },
  cost: { total_cost_usd: 12.5, total_duration_ms: 60000 },
  context_window: { used_percentage: 40, current_usage: { input_tokens: 10, cache_creation_input_tokens: 990, cache_read_input_tokens: 399000 } },
  rate_limits: { five_hour: { used_percentage: 33 } },
})
const LINE = '5 hour limit 33% used | context 400k (40%)'
// The same session in the lines, which a tool folder without settings shows.
const LINES = '[claude-opus-5-5] │ repo │ context ████░░░░░░ 40%\n5h ███░░░░░░░ 33%'

test('the old command name still runs: the status line and a hook give the same output and exit code as the new command', () => {
  // Each run gets a machine of its own, so that no run sees a file that another one wrote.
  const runs = [
    { args: ['statusline'], input: SESSION, expected: [0, LINE, ''] },
    { args: ['hook', 'compact-keep'], input: '{}', expected: [0, 'a text of the person', ''] },
  ]
  runs.forEach(({ args, input, expected }, i) => {
    const byNew = machine(`name-new-${i}`)
    const byOld = machine(`name-old-${i}`)
    // A link as the install made it under the old name: Claude Code's settings call that link.
    const byLink = machine(`name-link-${i}`)
    const link = join(byLink.home, '.local', 'bin', 'agent-spend')
    mkdirSync(join(byLink.home, '.local', 'bin'), { recursive: true })
    symlinkSync(AGENT_SPEND, link)
    for (const m of [byNew, byOld, byLink]) folderWithText(join(m.home, '.kestrel'), 'a text of the person')
    assert.deepEqual(result(byNew.run(args, { input })), expected, args.join(' '))
    // The old name prints nothing more and nothing less, also on stderr.
    assert.deepEqual(result(byOld.run(args, { input, bin: AGENT_SPEND })), expected, args.join(' '))
    assert.deepEqual(result(byLink.run(args, { input, bin: link })), expected, args.join(' '))
  })
})

test('the old folder is used while the new one does not exist, and the new one is used once it is there', () => {
  const m = machine('folder-old')
  const [old, now] = [join(m.home, '.agent-spend'), join(m.home, '.kestrel')]
  folderWithText(old, 'from the old folder')
  // A hook reads this tool's settings from the old folder.
  assert.deepEqual(result(m.run(['hook', 'compact-keep'])), [0, 'from the old folder', ''])
  // The status line keeps the file of the session there, and makes no new folder.
  assert.deepEqual(result(m.run(['statusline'], { input: SESSION })), [0, LINE, ''])
  assert.deepEqual(readdirSync(join(old, 'sessions')), ['one.json'])
  assert.equal(existsSync(now), false)
  // The same through the old command name, as an open session calls it.
  assert.deepEqual(result(m.run(['hook', 'compact-keep'], { bin: AGENT_SPEND })), [0, 'from the old folder', ''])
  assert.equal(existsSync(now), false)
  // Once the new folder is there, it is the tool's folder, and the old one is left alone.
  const files = (folder) => readdirSync(folder, { recursive: true }).sort().map((f) => [f, statSync(join(folder, f)).mtimeMs])
  const oldFiles = files(old)
  folderWithText(now, 'from the new folder')
  assert.deepEqual(result(m.run(['hook', 'compact-keep'])), [0, 'from the new folder', ''])
  assert.deepEqual(result(m.run(['statusline'], { input: SESSION })), [0, LINE, ''])
  assert.deepEqual(readdirSync(join(now, 'sessions')), ['one.json'])
  assert.deepEqual(files(old), oldFiles)
})

test('KESTREL_HOME wins over both folders, and AGENT_SPEND_HOME is no longer read', () => {
  const m = machine('folder-set')
  folderWithText(join(m.home, '.agent-spend'), 'from the old folder')
  folderWithText(join(m.home, '.kestrel'), 'from the new folder')
  folderWithText(join(m.home, 'own'), 'from the folder that KESTREL_HOME names')
  folderWithText(join(m.home, 'old-own'), 'from the folder that AGENT_SPEND_HOME names')
  const set = { KESTREL_HOME: join(m.home, 'own') }
  assert.deepEqual(result(m.run(['hook', 'compact-keep'], { env: set })), [0, 'from the folder that KESTREL_HOME names', ''])
  assert.deepEqual(result(m.run(['statusline'], { input: SESSION, env: set })), [0, LINE, ''])
  assert.deepEqual(readdirSync(join(m.home, 'own', 'sessions')), ['one.json'])
  for (const folder of ['.agent-spend', '.kestrel']) assert.deepEqual(readdirSync(join(m.home, folder)), ['config.json'], folder)
  // The variable of the old name sets nothing: the folder is the one in the home folder.
  assert.deepEqual(result(m.run(['hook', 'compact-keep'], { env: { AGENT_SPEND_HOME: join(m.home, 'old-own') } })), [0, 'from the new folder', ''])
  // KESTREL_HOME also wins while only the old folder is there.
  const onlyOld = machine('folder-set-old')
  folderWithText(join(onlyOld.home, '.agent-spend'), 'from the old folder')
  folderWithText(join(onlyOld.home, 'own'), 'from the folder that KESTREL_HOME names')
  assert.deepEqual(result(onlyOld.run(['hook', 'compact-keep'], { env: { KESTREL_HOME: join(onlyOld.home, 'own') } })), [0, 'from the folder that KESTREL_HOME names', ''])
})

test('with neither folder there, the tool makes the new one', () => {
  const m = machine('folder-none')
  assert.deepEqual(result(m.run(['statusline'], { input: SESSION })), [0, LINES, ''])
  assert.deepEqual(readdirSync(join(m.home, '.kestrel', 'sessions')), ['one.json'])
  assert.equal(existsSync(join(m.home, '.agent-spend')), false)
})

// From here on: the move of an old install, "kestrel migrate".

/** The link that puts the command on the PATH under a name, in a made-up home folder. */
const linkIn = (home, name) => join(home, '.local', 'bin', name)

/** The link in a tool folder that Claude Code's settings call. */
const ownIn = (folder) => join(folder, 'bin', 'kestrel')

/** The sentence of the move when it made the link in the tool's folder. */
const made = (folder) => `Made the link ${ownIn(folder)} to ${realpathSync(KESTREL)}: Claude Code's settings call this tool through it.`

/** Every file below a folder, as its path in the folder and its text. */
const tree = (folder) => Object.fromEntries(
  readdirSync(folder, { recursive: true, withFileTypes: true }).filter((f) => f.isFile())
    .map((f) => [join(f.parentPath ?? f.path, f.name).slice(folder.length + 1), readFileSync(join(f.parentPath ?? f.path, f.name), 'utf8')])
    .sort(([a], [b]) => (a < b ? -1 : 1)),
)

/** Writes files below a folder: `files` holds the path in the folder and the text of each. */
function fill(folder, files) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(folder, name, '..'), { recursive: true })
    writeFileSync(join(folder, name), text)
  }
}

// What the tool keeps in its folder, with made-up values: one file of each kind.
const KEPT = {
  'actions.json': JSON.stringify({ 'subagent-cache-1h': { at: 1762941600000, before: { value: '5m' } } }),
  'backup/settings.2026-11-12T10-00-00-000Z.json': '{"theme":"dark"}',
  'cache/logs.json': '{"records":[]}',
  'config.json': JSON.stringify({ nudge: { on: true } }),
  'limits.json': JSON.stringify({ five: { pct: 42 } }),
  'sessions/one.json': JSON.stringify({ day: '2026-11-12', cost: 12.4 }),
  'sweep.json': JSON.stringify({ at: 1762941600000 }),
}

/**
 * A machine with an install as it was made under the old name: the folder ~/.agent-spend with
 * `kept` in it, and the link ~/.local/bin/agent-spend to the old command file. Claude Code's
 * settings are for the test to write, with `write`: as text, or as a value in the layout that
 * the tool itself writes. `settings` reads them, and `text` gives the file as it is.
 */
function oldInstall(name, kept = KEPT) {
  const m = machine(name)
  const [old, now] = [join(m.home, '.agent-spend'), join(m.home, '.kestrel')]
  const [oldLink, newLink] = [linkIn(m.home, 'agent-spend'), linkIn(m.home, 'kestrel')]
  mkdirSync(old)
  fill(old, kept)
  mkdirSync(join(m.home, '.local', 'bin'), { recursive: true })
  symlinkSync(AGENT_SPEND, oldLink)
  const file = join(m.env.CLAUDE_CONFIG_DIR, 'settings.json')
  const text = () => readFileSync(file, 'utf8')
  const write = (value) => writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
  return { ...m, old, now, oldLink, newLink, file, text, write, settings: () => JSON.parse(text()) }
}

// Hooks of other tools. The second one has this tool's old name in its program, and is not this tool's.
const AUTO_ALLOW = { type: 'command', command: '/x/auto-allow.sh' }
const LOOKALIKE = { type: 'command', command: '/usr/bin/other-agent-spend hook' }
const NOTHING_LEFT = 'Nothing was left to do.\n'

test('the move renames the folder when only the old one is there, and loses nothing in it', () => {
  const m = machine('move-old')
  const [old, now] = [join(m.home, '.agent-spend'), join(m.home, '.kestrel')]
  fill(old, KEPT)
  assert.deepEqual(result(m.run(['migrate'])), [0, `Renamed this tool's folder from ${old} to ${now}.\n`, ''])
  assert.equal(existsSync(old), false)
  assert.deepEqual(tree(now), KEPT)
  // The second run changes nothing, and says so.
  assert.deepEqual(result(m.run(['migrate'])), [0, NOTHING_LEFT, ''])
  assert.equal(existsSync(old), false)
  assert.deepEqual(tree(now), KEPT)
})

test('the move leaves the folders alone when only the new one is there, when both are there, and when there is none', () => {
  const onlyNew = machine('move-new')
  fill(join(onlyNew.home, '.kestrel'), KEPT)
  assert.deepEqual(result(onlyNew.run(['migrate'])), [0, NOTHING_LEFT, ''])
  assert.deepEqual(tree(join(onlyNew.home, '.kestrel')), KEPT)
  assert.equal(existsSync(join(onlyNew.home, '.agent-spend')), false)

  // Both: neither is changed, and the move says so, and which folder the tool uses.
  const both = machine('move-both')
  const [old, now] = [join(both.home, '.agent-spend'), join(both.home, '.kestrel')]
  const NEWER = { 'config.json': JSON.stringify({ nudge: { on: false } }), 'sessions/two.json': '{}' }
  fill(old, KEPT)
  fill(now, NEWER)
  assert.deepEqual(result(both.run(['migrate'])), [0, `Both ${old} and ${now} exist, so neither was changed. The tool uses ${now} from now on, and does not read the records in ${old}.\n${NOTHING_LEFT}`, ''])
  assert.deepEqual(tree(old), KEPT)
  assert.deepEqual(tree(now), NEWER)

  // None: nothing is made.
  const none = machine('move-none')
  assert.deepEqual(result(none.run(['migrate'])), [0, NOTHING_LEFT, ''])
  assert.deepEqual(readdirSync(none.home), ['.claude'])
  assert.deepEqual(readdirSync(none.env.CLAUDE_CONFIG_DIR), [])

  // With KESTREL_HOME the person has named the tool's folder, so the old one stays where it is.
  const named = machine('move-named')
  fill(join(named.home, '.agent-spend'), KEPT)
  const r = named.run(['migrate'], { env: { KESTREL_HOME: join(named.home, 'own') } })
  assert.deepEqual(result(r), [0, `KESTREL_HOME is set, so the folder ${join(named.home, '.agent-spend')} was not renamed.\n${NOTHING_LEFT}`, ''])
  assert.deepEqual(tree(join(named.home, '.agent-spend')), KEPT)
  assert.equal(existsSync(join(named.home, '.kestrel')), false)
})

test('the move adds the command under the new name next to the old link, and leaves the old link in place', () => {
  const m = oldInstall('move-link')
  // No settings file: the move makes none. It makes the link in the tool's folder, for the settings to call later.
  assert.deepEqual(result(m.run(['migrate'], { bin: m.oldLink })), [0, [
    `Renamed this tool's folder from ${m.old} to ${m.now}.`,
    made(m.now),
    `Added the command ${m.newLink}, and left the old command ${m.oldLink} in place so that open sessions keep working.`,
    '',
  ].join('\n'), ''])
  assert.equal(readlinkSync(m.newLink), realpathSync(KESTREL))
  assert.equal(readlinkSync(m.oldLink), AGENT_SPEND)
  assert.equal(readlinkSync(ownIn(m.now)), realpathSync(KESTREL))
  assert.equal(existsSync(m.file), false)
  // Both names run the program, with the folder that was moved.
  folderWithText(m.now, 'a text of the person')
  for (const bin of [m.newLink, m.oldLink]) assert.deepEqual(result(m.run(['hook', 'compact-keep'], { bin })), [0, 'a text of the person', ''], bin)

  // Without a link under the old name there is no old install of the command, and no link is made.
  const noLink = machine('move-no-link')
  assert.deepEqual(result(noLink.run(['migrate'])), [0, NOTHING_LEFT, ''])
  assert.equal(existsSync(join(noLink.home, '.local')), false)

  // A link under the new name to another program stays as it is, and the move says so.
  const has = oldInstall('move-has-link')
  symlinkSync('/somewhere/else/kestrel.mjs', has.newLink)
  assert.deepEqual(result(has.run(['migrate'])), [0, [
    `Renamed this tool's folder from ${has.old} to ${has.now}.`,
    made(has.now),
    `Another program named kestrel is at ${has.newLink}, so it was left as it is, and this tool can be run as ${ownIn(has.now)}.`,
    '',
  ].join('\n'), ''])
  assert.equal(readlinkSync(has.newLink), '/somewhere/else/kestrel.mjs')
})

test('the move changes the three kinds of own entries and keeps the words after the command, and everything else stays as it is and in its order', () => {
  const m = oldInstall('move-settings')
  const script = (name) => `node ${join(AGENT_SPEND, '..', name)}`
  // The settings with the command of this tool's entries filled in: `link` is the link, `bare`
  // the bare word, and `node` the program "node" with the path of the command file.
  const settings = ({ link, bare, node }) => ({
    theme: 'dark',
    statusLine: { type: 'command', command: `${link} statusline`, refreshInterval: 30, padding: 1 },
    env: { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5-5' },
    hooks: {
      PreToolUse: [
        { matcher: '', hooks: [AUTO_ALLOW, { type: 'command', command: `${bare} hook`, timeout: 5 }] },
        { matcher: 'Bash', hooks: [LOOKALIKE] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: `${link} hook keep-warm`, asyncRewake: true, timeout: 3600 }, { type: 'command', command: '/x/notify.sh done' }] }],
      PreModelSwitch: [{ hooks: [{ type: 'command', command: `${link} hook model-switch`, timeout: 5 }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: `${node} hook compact-keep`, timeout: 5 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${bare} hook cold-start --and more words`, timeout: 5 }] }],
    },
    permissions: { allow: ['Bash(ls:*)'] },
    subagentPromptCacheTtl: '1h',
  })
  const before = settings({ link: m.oldLink, bare: 'agent-spend', node: script('agent-spend.mjs') })
  m.write(before)
  const was = m.text()
  const own = ownIn(m.now)
  assert.deepEqual(result(m.run(['migrate'])), [0, [
    `Renamed this tool's folder from ${m.old} to ${m.now}.`,
    made(m.now),
    `Added the command ${m.newLink}, and left the old command ${m.oldLink} in place so that open sessions keep working.`,
    `Changed the status line and 5 hooks in ${m.file} to call ${own}, and saved a copy of the file as it was in ${join(m.now, 'backup')} first.`,
    '',
  ].join('\n'), ''])
  // The same text with every entry calling the link in the tool's folder: the same keys and hooks, in the same order.
  assert.equal(m.text(), `${JSON.stringify(settings({ link: own, bare: own, node: own }), null, 2)}\n`)
  // A copy of the file as it was is in the backup folder, next to the copies from before the move.
  const copies = readdirSync(join(m.now, 'backup')).filter((f) => f !== 'settings.2026-11-12T10-00-00-000Z.json')
  assert.equal(copies.length, 1)
  assert.match(copies[0], /^settings\.\d{4}-\d\d-\d\dT[\d-]+Z\.json$/)
  assert.equal(readFileSync(join(m.now, 'backup', copies[0]), 'utf8'), was)

  // The second run changes nothing: not the settings, not the folder, not the links.
  const state = () => [statSync(m.file).ino, m.text(), tree(m.now), readlinkSync(m.newLink), readlinkSync(m.oldLink), readlinkSync(own)]
  const after = state()
  assert.deepEqual(result(m.run(['migrate'])), [0, NOTHING_LEFT, ''])
  assert.deepEqual(state(), after)
  assert.equal(existsSync(m.old), false)

  // Another tool's status line stays as it is, also in a file in which a hook of this tool changes.
  const other = oldInstall('move-settings-other')
  const withHook = (command) => ({
    statusLine: { type: 'command', command: '/usr/bin/other-agent-spend statusline', refreshInterval: 5 },
    hooks: { PreCompact: [{ hooks: [AUTO_ALLOW] }, { hooks: [{ type: 'command', command, timeout: 5 }] }, { hooks: [LOOKALIKE] }] },
  })
  other.write(withHook(`${other.oldLink} hook compact-keep`))
  assert.ok(lines(other.run(['migrate'])).includes(`Changed one hook in ${other.file} to call ${ownIn(other.now)}, and saved a copy of the file as it was in ${join(other.now, 'backup')} first.`))
  assert.equal(other.text(), `${JSON.stringify(withHook(`${ownIn(other.now)} hook compact-keep`), null, 2)}\n`)
})

test('the move writes no settings file that needs no change: another tool\'s status line and hooks stay as they are', () => {
  const m = oldInstall('move-no-change')
  // Nothing here is an entry of this tool under the old name. The file is in a layout of its own.
  const text = JSON.stringify({
    statusLine: { type: 'command', command: '/usr/bin/other-agent-spend statusline' },
    hooks: {
      PreToolUse: [{ matcher: '', hooks: [AUTO_ALLOW, LOOKALIKE] }],
      // A program in another folder, a program whose name only starts with the old name, and a
      // file whose name goes on after the old one are not known to be this tool's.
      Stop: [{ hooks: [{ type: 'command', command: '/opt/tools/agent-spend hook keep-warm' }, { type: 'command', command: 'agent-spend-wrapper hook' }, { type: 'command', command: 'node /x/bin/agent-spend.mjs.old hook' }] }],
      // An entry that already calls the link in the tool's folder.
      PreCompact: [{ hooks: [{ type: 'command', command: `${ownIn(m.now)} hook compact-keep`, timeout: 5 }] }],
    },
    theme: 'dark',
  })
  m.write(text)
  const { ino, mtimeMs } = statSync(m.file)
  const backups = readdirSync(join(m.old, 'backup'))
  // The folder and the links are moved. The settings are not touched.
  assert.deepEqual(result(m.run(['migrate'])), [0, [
    `Renamed this tool's folder from ${m.old} to ${m.now}.`,
    made(m.now),
    `Added the command ${m.newLink}, and left the old command ${m.oldLink} in place so that open sessions keep working.`,
    '',
  ].join('\n'), ''])
  assert.equal(m.text(), text)
  assert.deepEqual([statSync(m.file).ino, statSync(m.file).mtimeMs], [ino, mtimeMs])
  assert.deepEqual(readdirSync(join(m.now, 'backup')), backups)
})

test('after the move, undo takes back a hook change and a settings key change that were applied under the old name, and "status" shows them until then', () => {
  const m = oldInstall('move-undo', {})
  // The settings before any change, in the layout that the tool writes. One key is there with
  // another value, and one is not there at all.
  const before = { theme: 'dark', subagentPromptCacheTtl: '5m', hooks: { PreToolUse: [{ matcher: '', hooks: [AUTO_ALLOW, LOOKALIKE] }] } }
  m.write(before)
  const was = m.text()
  // The changes are applied through the old link, before the move. The hooks call the link in the
  // tool's folder, which is still the old folder, and the record of the changes is there too.
  const byOld = (...args) => m.run(args, { bin: m.oldLink })
  for (const change of ['subagent-cache-1h', 'effort-default', 'model-switch-cost', 'compact-keep']) assert.equal(byOld('apply', change).status, 0, change)
  const applied = (link) => ({
    ...before, subagentPromptCacheTtl: '1h',
    hooks: {
      ...before.hooks,
      PreModelSwitch: [{ hooks: [{ type: 'command', command: `${link} hook model-switch`, timeout: 5 }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: `${link} hook compact-keep`, timeout: 5 }] }],
    },
    effortLevel: 'medium',
  })
  assert.deepEqual(m.settings(), applied(ownIn(m.old)))
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(m.old, 'actions.json'), 'utf8'))).sort(), ['compact-keep', 'effort-default', 'model-switch-cost', 'subagent-cache-1h'])
  const shown = (r) => ['subagent-cache-1h', 'effort-default', 'model-switch-cost', 'compact-keep', 'cold-start-warn'].map((change) => row(r, `Change: ${change}`).replace(/\d{4}-\d\d-\d\d/, '<day>'))
  const SHOWN = ['applied on <day>', 'applied on <day>', 'applied on <day>', 'applied on <day>', 'not applied']
  // Before the move the hooks under the old name are this tool's own: "status" shows them.
  assert.deepEqual(shown(byOld('status')), SHOWN)

  // The link in the tool's folder moves with the folder. The hooks are changed to call it at its new place.
  const moved = byOld('migrate')
  assert.equal(moved.status, 0)
  assert.equal(lines(moved)[2], `Changed 2 hooks in ${m.file} to call ${ownIn(m.now)}, and saved a copy of the file as it was in ${join(m.now, 'backup')} first.`)
  assert.deepEqual(m.settings(), applied(ownIn(m.now)))
  // After the move "status" still shows the changes as applied, under either name of the command.
  const byNew = (...args) => m.run(args, { bin: m.newLink })
  assert.deepEqual(shown(byNew('status')), SHOWN)
  assert.deepEqual(shown(byOld('status')), SHOWN)
  assert.equal(row(byNew('status'), 'Command on PATH'), m.newLink)

  // Undo, one change after the other. Each puts back what was there before its apply.
  assert.match(byNew('undo', 'model-switch-cost').stdout, /^model-switch-cost is taken back\./)
  assert.deepEqual(m.settings().hooks, { ...before.hooks, PreCompact: applied(ownIn(m.now)).hooks.PreCompact })
  assert.match(byNew('undo', 'subagent-cache-1h').stdout, /^subagent-cache-1h is taken back\./)
  assert.equal(m.settings().subagentPromptCacheTtl, '5m')
  assert.match(byNew('undo', 'effort-default').stdout, /^effort-default is taken back\./)
  assert.match(byOld('undo', 'compact-keep').stdout, /^compact-keep is taken back\./)
  // The settings are exactly as before the first apply: the same text.
  assert.equal(m.text(), was)
  assert.deepEqual(JSON.parse(readFileSync(join(m.now, 'actions.json'), 'utf8')), {})
  assert.deepEqual(shown(byNew('status')), ['not applied', 'not applied', 'not applied', 'not applied', 'not applied'])
})

test('before the move, a change is applied and taken back through the old link, and its hook calls a command that is there', () => {
  const m = oldInstall('move-before', {})
  const before = { hooks: { PreToolUse: [{ matcher: '', hooks: [AUTO_ALLOW] }] } }
  m.write(before)
  const byOld = (...args) => m.run(args, { bin: m.oldLink })
  assert.equal(byOld('apply', 'cold-start-warn').status, 0)
  // The hook calls the link in the tool's folder, which is the old folder until the move. The
  // apply makes that link. It calls no link on the PATH.
  assert.equal(existsSync(m.newLink), false)
  assert.deepEqual(m.settings().hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: `${ownIn(m.old)} hook cold-start`, timeout: 5 }] }])
  assert.equal(readlinkSync(ownIn(m.old)), realpathSync(KESTREL))
  assert.equal(row(byOld('status'), 'Command on PATH'), m.oldLink)
  assert.match(byOld('undo', 'cold-start-warn').stdout, /^cold-start-warn is taken back\./)
  assert.deepEqual(m.settings(), before)
  // Nothing was moved by any of that.
  assert.equal(existsSync(m.now), false)
})

test('"install" on a machine that has the old install ends with only new entries in the settings, and "uninstall" removes both links', () => {
  const m = oldInstall('move-install', { ...KEPT, 'config.json': JSON.stringify({ limits: { session: 50, action: 'ask' } }) })
  const others = { theme: 'dark', hooks: { PreToolUse: [{ matcher: '', hooks: [AUTO_ALLOW] }] } }
  const installed = (link) => ({
    theme: 'dark',
    statusLine: { type: 'command', command: `${link} statusline`, refreshInterval: 30, padding: 1 },
    hooks: {
      PreToolUse: [...others.hooks.PreToolUse, { matcher: '', hooks: [{ type: 'command', command: `${link} hook`, timeout: 5 }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: `${link} hook compact-keep`, timeout: 5 }] }],
    },
  })
  // "install" also adds the three hooks of the security checks.
  const secured = (link) => {
    const s = installed(link)
    return {
      ...s,
      hooks: {
        ...s.hooks,
        PreToolUse: [...s.hooks.PreToolUse, { matcher: 'Bash', hooks: [{ type: 'command', command: `${link} hook push-gate`, timeout: 5 }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: `${link} hook check-settings`, timeout: 5 }] }],
        Stop: [{ hooks: [{ type: 'command', command: `${link} hook check-turn`, timeout: 5 }] }],
      },
    }
  }
  m.write(installed(m.oldLink))
  // The person runs the old command, the only one on the PATH so far.
  const r = m.run(['install'], { bin: m.oldLink })
  const own = ownIn(m.now)
  assert.deepEqual([r.status, r.stderr], [0, ''])
  assert.deepEqual(lines(r).slice(0, 6), [
    `Renamed this tool's folder from ${m.old} to ${m.now}.`,
    made(m.now),
    `Added the command ${m.newLink}, and left the old command ${m.oldLink} in place so that open sessions keep working.`,
    `Changed the status line and 2 hooks in ${m.file} to call ${own}, and saved a copy of the file as it was in ${join(m.now, 'backup')} first.`,
    `The command is at ${m.newLink}.`,
    'The status line was already set, with a refresh every 30 seconds.',
  ])
  // Only new entries: every command in the settings calls the link in the tool's folder.
  assert.deepEqual(m.settings(), secured(own))
  assert.doesNotMatch(m.text(), /agent-spend/)
  assert.equal(existsSync(m.old), false)
  assert.equal(readlinkSync(m.newLink), realpathSync(KESTREL))
  assert.equal(readlinkSync(m.oldLink), AGENT_SPEND)
  assert.equal(readlinkSync(own), realpathSync(KESTREL))
  // A second install finds nothing to move.
  const again = m.run(['install'], { bin: m.newLink })
  assert.deepEqual(lines(again).slice(0, 2), [`The command is at ${m.newLink}.`, 'The status line was already set, with a refresh every 30 seconds.'])
  assert.deepEqual(m.settings(), secured(own))

  // "uninstall" takes out this tool's entries and all three links. The tool's folder stays.
  assert.equal(m.run(['uninstall'], { bin: m.newLink }).status, 0)
  assert.deepEqual(m.settings(), others)
  for (const link of [m.newLink, m.oldLink, own]) assert.equal(lstatSync(link, { throwIfNoEntry: false }), undefined, link)
  assert.equal(existsSync(m.now), true)
})

test('"uninstall" before the move takes out the entries under the old name and the old link', () => {
  const m = oldInstall('move-uninstall')
  const others = { theme: 'dark', hooks: { PreToolUse: [{ matcher: '', hooks: [AUTO_ALLOW, LOOKALIKE] }] } }
  m.write({
    ...others, statusLine: { type: 'command', command: `${m.oldLink} statusline`, refreshInterval: 30 },
    hooks: { PreToolUse: [{ matcher: '', hooks: [AUTO_ALLOW, LOOKALIKE, { type: 'command', command: `${m.oldLink} hook`, timeout: 5 }] }], PreCompact: [{ hooks: [{ type: 'command', command: 'agent-spend hook compact-keep', timeout: 5 }] }] },
  })
  assert.deepEqual(result(m.run(['uninstall'], { bin: m.oldLink })), [0, 'Removed the status line and the hook from Claude Code, and the command from your PATH.\n', ''])
  assert.deepEqual(m.settings(), others)
  assert.equal(lstatSync(m.oldLink, { throwIfNoEntry: false }), undefined)
  // The folder is the person's data. It stays where it is, under its old name.
  assert.deepEqual(readdirSync(m.old).sort(), ['actions.json', 'backup', 'cache', 'config.json', 'limits.json', 'sessions', 'sweep.json'])
})

// From here on: another program named kestrel or agent-spend on the PATH, and the link in the
// tool's own folder that Claude Code's settings call instead.

/** Another program at a path on the PATH: a file, or a link to another place. Returns what was there, to compare with later. */
function otherProgramAt(link, kind) {
  mkdirSync(join(link, '..'), { recursive: true })
  if (kind === 'file') writeFileSync(link, '#!/bin/sh\necho another program\n', { mode: 0o755 })
  else symlinkSync('/opt/other/program', link)
  return thing(link)
}

/** What is at a path: the target of a link, or the text and inode of a file. */
const thing = (path) => (lstatSync(path).isSymbolicLink() ? ['link', readlinkSync(path)] : ['file', readFileSync(path, 'utf8'), statSync(path).ino])

/** The sentence about another program at a path on the PATH. */
const leftAlone = (name, link, runAs) => `Another program named ${name} is at ${link}, so it was left as it is, and this tool can be run as ${runAs}.`

test('a file or a link of another program at the places on the PATH stays untouched by "install", "migrate" and "uninstall", and the settings call the link in the tool\'s folder', () => {
  for (const [first, second] of [['file', 'link'], ['link', 'file']]) {
    // "install": another program under each name. Nothing on the PATH changes.
    const m = machine(`other-install-${first}`)
    const [now, old] = [linkIn(m.home, 'kestrel'), linkIn(m.home, 'agent-spend')]
    const own = ownIn(join(m.home, '.kestrel'))
    const before = [otherProgramAt(now, first), otherProgramAt(old, second)]
    const r = m.run(['install'])
    assert.deepEqual([r.status, r.stderr], [0, ''], first)
    assert.deepEqual(lines(r).slice(0, 4), [
      made(join(m.home, '.kestrel')),
      leftAlone('kestrel', now, own),
      leftAlone('agent-spend', old, own),
      'The status line is set, with a refresh every 30 seconds. Open sessions show it after their next answer.',
    ], first)
    // No line says that the command is on the PATH, and the hint names the link in the tool's folder.
    assert.equal(lines(r).some((line) => line.startsWith('The command is at')), false)
    assert.ok(lines(r).includes(`Try: ${own} summary, ${own} session, ${own} findings, ${own} live`))
    assert.deepEqual([thing(now), thing(old)], before, first)
    const settings = JSON.parse(readFileSync(join(m.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'))
    assert.deepEqual(settings.statusLine, { type: 'command', command: `${own} statusline`, refreshInterval: 30 })
    assert.equal(readlinkSync(own), realpathSync(KESTREL))
    // The link in the tool's folder runs this tool.
    assert.deepEqual(result(m.run(['--version'], { bin: own })), [0, `${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}\n`, ''])
    assert.equal(row(m.run(['status']), 'Command on PATH'), `no: another program named kestrel is at ${now}`)
    assert.equal(row(m.run(['status']), 'Command for Claude Code'), own)

    // "uninstall": the settings are cleaned and the tool's own link goes. The other programs stay.
    const gone = m.run(['uninstall'])
    assert.deepEqual(result(gone), [0, [
      leftAlone('kestrel', now, realpathSync(KESTREL)),
      leftAlone('agent-spend', old, realpathSync(KESTREL)),
      'Removed the status line and the hook from Claude Code.',
      '',
    ].join('\n'), ''], first)
    assert.deepEqual([thing(now), thing(old)], before, first)
    assert.equal(lstatSync(own, { throwIfNoEntry: false }), undefined)
    assert.equal(JSON.parse(readFileSync(join(m.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8')).statusLine, undefined)
  }

  // "migrate": settings that call the link on the PATH, where another program is. Such an entry
  // can only be that program's own: no released version of this tool wrote that path into the
  // settings. So the move leaves it as it is.
  for (const kind of ['file', 'link']) {
    const m = oldInstall(`other-migrate-${kind}`, {})
    const before = otherProgramAt(m.newLink, kind)
    const theirs = { statusLine: { type: 'command', command: `${m.newLink} statusline`, refreshInterval: 30 }, hooks: { PreCompact: [{ hooks: [{ type: 'command', command: `${m.newLink} hook compact-keep`, timeout: 5 }] }] } }
    m.write(theirs)
    const own = ownIn(m.now)
    assert.deepEqual(result(m.run(['migrate'])), [0, [
      `Renamed this tool's folder from ${m.old} to ${m.now}.`,
      made(m.now),
      leftAlone('kestrel', m.newLink, own),
      '',
    ].join('\n'), ''], kind)
    assert.deepEqual(thing(m.newLink), before, kind)
    assert.deepEqual(m.settings(), theirs)
    // The old link is this tool's own, and stays.
    assert.equal(readlinkSync(m.oldLink), AGENT_SPEND)
    // A second run changes nothing, and says again that the other program was left alone.
    assert.deepEqual(result(m.run(['migrate'])), [0, `${leftAlone('kestrel', m.newLink, own)}\n${NOTHING_LEFT}`, ''], kind)
  }

  // The old name's link of another program: no new link is added next to it, and it stays.
  const foreignOld = machine('other-migrate-old')
  const old = linkIn(foreignOld.home, 'agent-spend')
  const before = otherProgramAt(old, 'link')
  assert.deepEqual(result(foreignOld.run(['migrate'])), [0, `${leftAlone('agent-spend', old, realpathSync(KESTREL))}\n${NOTHING_LEFT}`, ''])
  assert.deepEqual(thing(old), before)
  assert.equal(isLinkThere(linkIn(foreignOld.home, 'kestrel')), false)
})

/** Whether anything is at a path, a link whose target is gone included. */
const isLinkThere = (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined

test('without the old link the move still makes the link in the tool\'s folder and points the entries at it', () => {
  const m = machine('no-old-link')
  const [old, now] = [join(m.home, '.agent-spend'), join(m.home, '.kestrel')]
  fill(old, {})
  folderWithText(old, 'a text of the person')
  const file = join(m.env.CLAUDE_CONFIG_DIR, 'settings.json')
  // The old link is named in the settings, but it is not there.
  writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'agent-spend statusline' }, hooks: { PreCompact: [{ hooks: [{ type: 'command', command: `${linkIn(m.home, 'agent-spend')} hook compact-keep` }] }] } }))
  assert.deepEqual(result(m.run(['migrate'])), [0, [
    `Renamed this tool's folder from ${old} to ${now}.`,
    made(now),
    `Changed the status line and one hook in ${file} to call ${ownIn(now)}, and saved a copy of the file as it was in ${join(now, 'backup')} first.`,
    '',
  ].join('\n'), ''])
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { statusLine: { type: 'command', command: `${ownIn(now)} statusline` }, hooks: { PreCompact: [{ hooks: [{ type: 'command', command: `${ownIn(now)} hook compact-keep` }] }] } })
  // No link on the PATH is made, and the hook in the settings runs.
  assert.equal(existsSync(join(m.home, '.local')), false)
  assert.deepEqual(result(m.run(['hook', 'compact-keep'], { bin: ownIn(now) })), [0, 'a text of the person', ''])
})

test('every form an own entry ever had is changed by the move, and recognised by "undo" and "status"', () => {
  const m = oldInstall('every-form', {})
  const forms = [
    m.oldLink, // the old link on the PATH
    m.newLink, // the link on the PATH
    ownIn(m.old), // the link in the tool's folder, under the old name of the folder
    'agent-spend', // the bare names
    'kestrel',
    ...['bin/agent-spend.mjs', 'bin/kestrel.mjs', 'cli/agent-spend.mjs', 'cli/kestrel.mjs'].map((file) => `node /some/checkout/${file}`), // "node" with the command's file
    'node cli/kestrel.mjs', // a path relative to the folder of the tool
  ]
  const hooks = (programs) => ({ PreCompact: programs.map((program) => ({ hooks: [{ type: 'command', command: `${program} hook compact-keep`, timeout: 5 }] })) })
  // The link in the tool's folder under the new name is already where the move puts the entries.
  m.write({ hooks: hooks([...forms, ownIn(m.now)]) })
  const own = ownIn(m.now)
  assert.ok(lines(m.run(['migrate'])).includes(`Changed ${forms.length} hooks in ${m.file} to call ${own}, and saved a copy of the file as it was in ${join(m.now, 'backup')} first.`))
  assert.deepEqual(m.settings(), { hooks: hooks([...forms, own].map(() => own)) })

  // "undo" takes out an entry in each form, and "status" shows the change as applied until then.
  for (const program of [...forms, own]) {
    m.write({ theme: 'dark', hooks: { PreModelSwitch: [{ hooks: [{ type: 'command', command: `${program} hook model-switch`, timeout: 5 }] }] } })
    writeFileSync(join(m.now, 'actions.json'), JSON.stringify({ 'model-switch-cost': { at: 1762941600000, before: {} } }))
    assert.match(row(m.run(['status']), 'Change: model-switch-cost'), /^applied on \d{4}-\d\d-\d\d$/, program)
    assert.match(m.run(['undo', 'model-switch-cost']).stdout, /^model-switch-cost is taken back\./, program)
    assert.deepEqual(m.settings(), { theme: 'dark', hooks: {} }, program)
  }
})

test('a command of another tool with the name only in a longer name or in an argument is not changed by the move or "uninstall"', () => {
  const m = oldInstall('lookalikes', {})
  const text = `${JSON.stringify({
    statusLine: { type: 'command', command: '/usr/bin/other-kestrel statusline' },
    hooks: {
      PreToolUse: [{ matcher: '', hooks: [
        { type: 'command', command: 'kestrel-wrapper hook' },
        { type: 'command', command: 'agent-spend-helper hook compact-keep' },
        { type: 'command', command: '/x/tool --for kestrel hook' },
        { type: 'command', command: '/x/notify kestrel statusline' },
        { type: 'command', command: 'node /x/run.mjs agent-spend hook compact-keep' },
        { type: 'command', command: 'node /x/cli/kestrel.mjs.bak hook' },
      ] }],
    },
  }, null, 2)}\n`
  m.write(text)
  const ino = statSync(m.file).ino
  const r = m.run(['migrate'])
  assert.equal(r.status, 0)
  assert.equal(lines(r).some((line) => line.startsWith('Changed')), false)
  assert.equal(m.text(), text)
  const u = m.run(['uninstall'])
  assert.deepEqual(result(u), [0, 'Nothing of Kestrel was in Claude Code\'s settings. The command is removed from your PATH.\n', ''])
  assert.equal(m.text(), text)
  assert.equal(statSync(m.file).ino, ino)
})

test('a program named kestrel in another folder, really there, is not this tool: install keeps its status line, and uninstall leaves it and its hook', () => {
  const m = machine('other-folder')
  const settingsPath = join(m.env.CLAUDE_CONFIG_DIR, 'settings.json')
  // Another program named kestrel, really there, in a folder of its own.
  const other = join(m.home, 'opt', 'other', 'kestrel')
  mkdirSync(join(m.home, 'opt', 'other'), { recursive: true })
  writeFileSync(other, '#!/bin/sh\necho other\n', { mode: 0o755 })
  const theirs = {
    statusLine: { type: 'command', command: `${other} statusline` },
    hooks: { PreCompact: [{ hooks: [{ type: 'command', command: `${other} hook compact-keep` }] }] },
  }
  writeFileSync(settingsPath, JSON.stringify(theirs, null, 2))
  const installed = m.run(['install'])
  assert.equal(installed.status, 0, installed.stderr)
  assert.ok(installed.stdout.includes(`already has a status line (${other} statusline). It was kept.`), installed.stdout)
  const after = JSON.parse(readFileSync(settingsPath, 'utf8'))
  assert.deepEqual(after.statusLine, theirs.statusLine)
  assert.deepEqual(after.hooks.PreCompact, theirs.hooks.PreCompact)
  const removed = m.run(['uninstall'])
  assert.equal(removed.status, 0, removed.stderr)
  const end = JSON.parse(readFileSync(settingsPath, 'utf8'))
  assert.deepEqual(end.statusLine, theirs.statusLine)
  assert.deepEqual(end.hooks.PreCompact, theirs.hooks.PreCompact)
})

test('a "node" script named kestrel.mjs in a folder that does not hold this tool is another program: install, the move and uninstall leave it', () => {
  const m = machine('other-node-script')
  const settingsPath = join(m.env.CLAUDE_CONFIG_DIR, 'settings.json')
  const script = join(m.home, 'opt', 'other', 'cli', 'kestrel.mjs')
  mkdirSync(join(m.home, 'opt', 'other', 'cli'), { recursive: true })
  writeFileSync(script, 'console.log("other")\n')
  const theirs = {
    statusLine: { type: 'command', command: `node ${script} statusline` },
    hooks: { PreCompact: [{ hooks: [{ type: 'command', command: `node ${script} hook compact-keep` }] }] },
  }
  writeFileSync(settingsPath, JSON.stringify(theirs, null, 2))
  const moved = m.run(['migrate'])
  assert.equal(moved.status, 0, moved.stderr)
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), theirs)
  const installed = m.run(['install'])
  assert.equal(installed.status, 0, installed.stderr)
  assert.ok(installed.stdout.includes(`already has a status line (node ${script} statusline). It was kept.`), installed.stdout)
  const after = JSON.parse(readFileSync(settingsPath, 'utf8'))
  assert.deepEqual(after.statusLine, theirs.statusLine)
  assert.deepEqual(after.hooks.PreCompact, theirs.hooks.PreCompact)
  assert.equal(m.run(['uninstall']).status, 0)
  const end = JSON.parse(readFileSync(settingsPath, 'utf8'))
  assert.deepEqual(end.statusLine, theirs.statusLine)
  assert.deepEqual(end.hooks.PreCompact, theirs.hooks.PreCompact)
})

test('a program named kestrel at a path where nothing is: install takes the status line, and uninstall removes the hook', () => {
  const m = machine('missing-path')
  const settingsPath = join(m.env.CLAUDE_CONFIG_DIR, 'settings.json')
  const gone = join(m.home, 'opt', 'gone', 'kestrel')
  writeFileSync(settingsPath, JSON.stringify({
    statusLine: { type: 'command', command: `${gone} statusline` },
    hooks: { PreCompact: [{ hooks: [{ type: 'command', command: `${gone} hook compact-keep` }] }] },
  }, null, 2))
  const installed = m.run(['install'])
  assert.equal(installed.status, 0, installed.stderr)
  assert.doesNotMatch(installed.stdout, /It was kept/)
  assert.notEqual(JSON.parse(readFileSync(settingsPath, 'utf8')).statusLine.command, `${gone} statusline`)
  assert.equal(m.run(['uninstall']).status, 0)
  const end = JSON.parse(readFileSync(settingsPath, 'utf8'))
  assert.equal(end.statusLine, undefined)
  assert.ok(!JSON.stringify(end.hooks ?? {}).includes(gone))
})
