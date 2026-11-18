// Tests for the changes of name, from agent-spend to Kestrel (13 Nov 2026) and from Kestrel to
// Widal.Code (17 Nov 2026): the commands under their old names, the folders under their old names,
// the move of an old install, and the entries of other programs named widal or kestrel, which
// the tool never takes. With made-up home folders and settings. Run: node --test
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'widal-code-migrate-test-'))
// Widal.Code also reads the config folders of Claude Code in the home folder, so the home folder is a
// made-up one too.
process.env.HOME = join(dir, 'person')
process.env.WIDAL_HOME = join(dir, 'home')
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
process.env.CODEX_HOME = join(dir, 'codex')
// Cowork's folder too: without this a test would read the real Cowork logs of whoever runs it.
process.env.WIDAL_COWORK_DIR = join(dir, 'cowork')
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })

const ROOT = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const WIDAL = join(ROOT, 'cli', 'widal.mjs')
const KESTREL = join(ROOT, 'cli', 'kestrel.mjs')
const AGENT_SPEND = join(ROOT, 'cli', 'agent-spend.mjs')
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

/**
 * A made-up machine: the empty home folder of a person, below `name`. Returns the folder and a
 * function that runs the command there. The command gets nothing of the real environment. Its
 * PATH is the made-up ~/.local/bin, the folder of node and the system's folders, so that no
 * program named widal of the real machine is found. WIDAL_HOME is not set, so that the command
 * looks for its folder in the home folder, as it does on a real machine. `more` sets further
 * variables for every run.
 *
 * `run` takes the arguments of the command, and then `bin` (the file to run, the command widal
 * unless another is given), `input` (what the command gets on stdin) and `env` (further variables
 * for this one run).
 */
function machine(name, more = {}) {
  const home = join(dir, name)
  const path = [join(home, '.local', 'bin'), dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter)
  const env = { PATH: path, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), WIDAL_COWORK_DIR: join(home, 'cowork'), NO_COLOR: '1', ...more }
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true })
  // The command reaches into the home folder. A test must only ever reach the made-up one.
  assert.equal(spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], { encoding: 'utf8', env }).stdout, home)
  const run = (args, { bin = WIDAL, input, env: forRun = {} } = {}) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', input, env: { ...env, ...forRun } })
  // A link or a file that is run as a program, as Claude Code runs the status line.
  const exec = (program, args, input) => spawnSync(program, args, { encoding: 'utf8', input, env })
  const file = join(env.CLAUDE_CONFIG_DIR, 'settings.json')
  const folders = { widal: join(home, '.widal'), kestrel: join(home, '.kestrel'), spend: join(home, '.agent-spend') }
  return {
    home, env, run, exec, file, ...folders,
    text: () => readFileSync(file, 'utf8'),
    settings: () => JSON.parse(readFileSync(file, 'utf8')),
    write: (value) => writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`),
  }
}

/** The exit code of a run, and what it printed. */
const result = (r) => [r.status, r.stdout, r.stderr]

/** The lines that a run printed. */
const lines = (r) => r.stdout.split('\n')

/** The value in one row of what "doctor" printed, for example the row "Command on PATH". */
const row = (r, name) => lines(r).find((line) => line.startsWith(name))?.slice(name.length).trim()

/** The link that puts the command on the PATH under a name, in a made-up home folder. */
const linkIn = (home, name) => join(home, '.local', 'bin', name)

/** The link in a tool folder that Claude Code's settings call, under the new name or the name before. */
const ownIn = (folder) => join(folder, 'bin', 'widal')
const beforeIn = (folder) => join(folder, 'bin', 'kestrel')

/** The command's file of a name in this repo. */
const cli = (name) => join(ROOT, 'cli', `${name}.mjs`)

/** The note on stderr for a command typed under an old name. */
const note = (old, renamed = '') => `${old} is now called widal. Type widal in place of ${old}.${renamed} The name ${old} stops working with the next release.\n`

// The sentences of the move.
const renamed = (from, to) => `Renamed this tool's folder from ${from} to ${to}, and left ${from} as a link to it so that open sessions keep working.`
const made = (folder, file = cli('widal')) => `Made the link ${ownIn(folder)} to ${file}: Claude Code's settings call this tool through it.`
const added = (home, ...olds) => `Added the command ${linkIn(home, 'widal')}, and left the old ${olds.length === 1 ? 'command' : 'commands'} ${olds.map((name) => linkIn(home, name)).join(' and ')} in place so that open sessions keep working.`
const changed = (m, what) => `Changed ${what} in ${m.file} to call ${ownIn(m.widal)}, and saved a copy of the file as it was in ${join(m.widal, 'backup')} first.`
const boardMoved = (m) => `Changed the board's address in ${join(m.widal, 'board.json')} from https://kestrel.widal.com to https://code.widal.com: it is the same board at its new address, and the link stays valid.`
const leftAlone = (name, link, runAs) => `Another program named ${name} is at ${link}, so it was left as it is, and this tool can be run as ${runAs}.`
const NOTHING_LEFT = 'Nothing was left to do.\n'
/** What the move on its own prints on stderr: each sentence after "widal: ". */
const onItsOwn = (...sentences) => sentences.map((s) => `widal: ${s}\n`).join('')

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

/** A link at `at` to `target`, with the folders it needs. */
function link(target, at) {
  mkdirSync(dirname(at), { recursive: true })
  symlinkSync(target, at)
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

// The link of this computer to the board, as Kestrel saved it, with a made-up token. Its last sync
// is now: the status line and the hooks start a sync in the background only when the last one is
// 10 minutes old, and a test must never send anything to a real address.
const TOKEN = `kbm_${'a1B2c3D4e5F6g7H8i9J0'.repeat(2)}`
const BOARD = { url: 'https://kestrel.widal.com', token: TOKEN, machineId: 'm1', team: 'Acme', linkedAt: 1762941600000, lastSyncAt: Date.now() }

// Hooks of other tools. The second one has an old name of this tool in its program, and is not this tool's.
const AUTO_ALLOW = { type: 'command', command: '/x/auto-allow.sh' }
const LOOKALIKE = { type: 'command', command: '/usr/bin/other-agent-spend hook' }

/**
 * Claude Code's settings with this tool's status line and its five hooks calling `program`, next
 * to keys and hooks of other tools, in the layout that the tool itself writes.
 */
const settingsWith = (program) => ({
  theme: 'dark',
  statusLine: { type: 'command', command: `${program} statusline`, refreshInterval: 30, padding: 1 },
  env: { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5-5' },
  hooks: {
    PreToolUse: [{ matcher: '', hooks: [AUTO_ALLOW] }, { matcher: 'Bash', hooks: [LOOKALIKE, { type: 'command', command: `${program} hook push-gate`, timeout: 5 }] }],
    PreModelSwitch: [{ hooks: [{ type: 'command', command: `${program} hook model-switch`, timeout: 5 }] }],
    PreCompact: [{ hooks: [{ type: 'command', command: `${program} hook compact-keep`, timeout: 5 }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: `${program} hook check-settings`, timeout: 5 }] }],
    Stop: [{ hooks: [{ type: 'command', command: `${program} hook check-turn`, timeout: 5 }, { type: 'command', command: '/x/notify.sh done' }] }],
  },
  permissions: { allow: ['Bash(ls:*)'] },
})

/**
 * A machine with an install as Kestrel made it: the folder ~/.kestrel with `kept` and the link to
 * the board in it, the link ~/.kestrel/bin/kestrel that Claude Code's settings call, the links
 * ~/.local/bin/kestrel and ~/.local/bin/agent-spend that the move of 13 Nov 2026 left, and the
 * settings with the status line and the hooks calling ~/.kestrel/bin/kestrel.
 */
function kestrelInstall(name, kept = KEPT) {
  const m = machine(name)
  mkdirSync(m.kestrel, { recursive: true })
  fill(m.kestrel, kept)
  writeFileSync(join(m.kestrel, 'board.json'), `${JSON.stringify(BOARD, null, 2)}\n`, { mode: 0o600 })
  link(KESTREL, beforeIn(m.kestrel))
  link(KESTREL, linkIn(m.home, 'kestrel'))
  link(AGENT_SPEND, linkIn(m.home, 'agent-spend'))
  m.write(settingsWith(beforeIn(m.kestrel)))
  return m
}

/** What Claude Code gives the status line: a session on a subscription, with nothing in it that changes with the time. */
const SESSION = JSON.stringify({
  session_id: 'one', cwd: '/work/repo', model: { id: 'claude-opus-5-5' },
  cost: { total_cost_usd: 12.5, total_duration_ms: 60000 },
  context_window: { used_percentage: 40, current_usage: { input_tokens: 10, cache_creation_input_tokens: 990, cache_read_input_tokens: 399000 } },
  rate_limits: { five_hour: { used_percentage: 33 } },
})
// The same session in the lines, which a tool folder without settings shows.
const LINES = '[claude-opus-5-5] │ repo │ context ████░░░░░░ 40%\n5h ███░░░░░░░ 33%'

/**
 * A run of the status line, without the tokens of today: the first run starts the count of today
 * in the background, so a later run can show it. The rest is the same in every run.
 */
const shown = (r) => [r.status, r.stdout.replace(/ │ today .*$/m, ''), r.stderr]

/** A tool folder with settings that name a text for the compaction hook. The hook prints that text, so it shows which folder the command read. */
function folderWithText(folder, text) {
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'config.json'), JSON.stringify({ compactKeep: { text } }))
}

// From here on: the move from Kestrel to Widal.Code.

test('the first command a person types moves a Kestrel install: the folder as a link, the links, the settings with a backup, and the board\'s address, and a second run changes nothing', () => {
  const m = kestrelInstall('kestrel-move')
  const was = m.text()
  const r = m.run(['doctor'])
  assert.equal(r.status, 0)
  // What the move did is on stderr, each thing as it was done.
  assert.equal(r.stderr, onItsOwn(
    renamed(m.kestrel, m.widal),
    made(m.widal),
    added(m.home, 'kestrel', 'agent-spend'),
    changed(m, 'the status line and 5 hooks'),
    boardMoved(m),
  ))
  // "doctor" shows what "kestrel status" showed, for the moved install.
  assert.equal(row(r, 'Command on PATH'), linkIn(m.home, 'widal'))
  assert.equal(row(r, 'Command for Claude Code'), ownIn(m.widal))
  assert.equal(row(r, 'Claude Code status line'), 'set, with a refresh every 30 seconds')
  assert.match(row(r, 'Widal.Code board'), /^linked to https:\/\/code\.widal\.com \(Acme\), last sync .+\. See: widal board status$/)

  // The folder is ~/.widal now, with everything in it, and ~/.kestrel is a link to it.
  assert.equal(lstatSync(m.kestrel).isSymbolicLink(), true)
  assert.equal(readlinkSync(m.kestrel), m.widal)
  const files = tree(m.widal)
  for (const [name, text] of Object.entries(KEPT)) assert.equal(files[name], text, name)
  // The settings call the link in ~/.widal. Only the text of the tool's own commands changed.
  assert.equal(m.text(), `${JSON.stringify(settingsWith(ownIn(m.widal)), null, 2)}\n`)
  // A copy of the settings as they were is in the backup folder, next to the copies from before.
  const copies = readdirSync(join(m.widal, 'backup')).filter((f) => f !== 'settings.2026-11-12T10-00-00-000Z.json')
  assert.equal(copies.length, 1)
  assert.equal(readFileSync(join(m.widal, 'backup', copies[0]), 'utf8'), was)
  // The board's address is the new one. The token and the rest stay, and only the person can read the file.
  assert.deepEqual(JSON.parse(readFileSync(join(m.widal, 'board.json'), 'utf8')), { ...BOARD, url: 'https://code.widal.com' })
  assert.equal(statSync(join(m.widal, 'board.json')).mode & 0o777, 0o600)
  // The links: the new ones next to the old ones, which stay for open sessions.
  assert.equal(readlinkSync(ownIn(m.widal)), cli('widal'))
  assert.equal(readlinkSync(beforeIn(m.widal)), cli('kestrel'))
  for (const name of ['widal', 'kestrel', 'agent-spend']) assert.equal(readlinkSync(linkIn(m.home, name)), cli(name), name)

  // The status line runs from the old path, as open sessions call it, and from the new one, the same.
  const oldLine = m.exec(beforeIn(m.kestrel), ['statusline'], SESSION)
  const newLine = m.exec(ownIn(m.widal), ['statusline'], SESSION)
  assert.deepEqual(shown(oldLine), [0, LINES, ''])
  assert.deepEqual(shown(newLine), [0, LINES, ''])
  // And so do the hooks.
  assert.deepEqual(result(m.exec(beforeIn(m.kestrel), ['hook', 'compact-keep'], '{}')), result(m.exec(ownIn(m.widal), ['hook', 'compact-keep'], '{}')))

  // A second run changes nothing: not the settings, not the folder, not the links. It prints only what "doctor" prints.
  const links = () => [ownIn(m.widal), beforeIn(m.widal), ...['widal', 'kestrel', 'agent-spend'].map((name) => linkIn(m.home, name))].map((l) => readlinkSync(l))
  const state = () => [statSync(m.file).ino, m.text(), tree(m.widal), readlinkSync(m.kestrel), ...links()]
  const after = state()
  const again = m.run(['doctor'])
  assert.deepEqual([again.status, again.stderr], [0, ''])
  assert.deepEqual(state(), after)
  assert.deepEqual(result(m.run(['migrate'])), [0, NOTHING_LEFT, ''])
  assert.deepEqual(state(), after)
  // No sync with the board was started: the test sent nothing to the board's real address.
  assert.equal(existsSync(join(m.widal, 'board.start')), false)
})

test('"kestrel" keeps working with every command for one release and prints the note once on stderr, and the status line and the hooks never print it', () => {
  const m = kestrelInstall('kestrel-alias')
  // The first command through the old name also moves the install.
  const first = m.run(['summary'], { bin: linkIn(m.home, 'kestrel') })
  assert.equal(first.status, 0)
  assert.ok(first.stderr.startsWith(note('kestrel')), first.stderr)
  assert.equal(first.stderr.split(note('kestrel')).length - 1, 1)
  assert.ok(first.stdout.length > 0)
  // After the move: the note and nothing else, through the link and through the file of the old name.
  for (const bin of [linkIn(m.home, 'kestrel'), KESTREL]) {
    const r = m.run(['summary'], { bin })
    assert.deepEqual([r.status, r.stderr], [0, note('kestrel')], bin)
    assert.equal(r.stdout, m.run(['summary']).stdout, bin)
  }
  // The name before that gets the same note.
  assert.equal(m.run(['summary'], { bin: linkIn(m.home, 'agent-spend') }).stderr, note('agent-spend'))
  // The status line and the hooks under the old names print exactly what the new name prints, and no note.
  for (const bin of [linkIn(m.home, 'kestrel'), KESTREL, beforeIn(m.kestrel), linkIn(m.home, 'agent-spend')]) {
    for (const [args, input] of [[['statusline'], SESSION], [['hook', 'compact-keep'], '{}'], [['hook', 'cold-start'], '{}'], [['hook', 'compact-keep', '--plugin'], '{}']]) {
      const r = m.run(args, { bin, input })
      assert.deepEqual(shown(r), shown(m.run(args, { input })), `${bin} ${args.join(' ')}`)
      assert.equal(r.stderr, '', `${bin} ${args.join(' ')}`)
    }
  }
  // No sync with the board was started: the test sent nothing to the board's real address.
  assert.equal(existsSync(join(m.widal, 'board.start')), false)
})

test('the four renamed commands: under the old name they still run, with a note that names the new command, and "widal" does not take the old names', () => {
  const m = machine('renamed')
  for (const [old, now] of [['install', 'connect'], ['uninstall', 'disconnect'], ['status', 'doctor'], ['mcp', 'desktop-mcp']]) {
    // Widal.Factory has a command named widal with commands of these names, so "widal" does not take them.
    assert.deepEqual(result(m.run([old])), [2, '', `Unknown command "${old}". Widal.Code calls it "widal ${now}".\n`], old)
  }
  // Nothing was made by any of that.
  assert.deepEqual(readdirSync(m.home), ['.claude'])
  const renamedNote = (old, now) => note('kestrel', ` "kestrel ${old}" is "widal ${now}" now.`)
  // "kestrel status" shows the rows of "widal doctor".
  const status = m.run(['status'], { bin: KESTREL })
  assert.deepEqual([status.status, status.stderr], [0, renamedNote('status', 'doctor')])
  assert.equal(row(status, 'Command for Claude Code'), 'not made yet (run: widal connect)')
  // "kestrel install" connects, and "kestrel uninstall" disconnects.
  const install = m.run(['install'], { bin: KESTREL })
  assert.deepEqual([install.status, install.stderr], [0, renamedNote('install', 'connect')])
  assert.equal(m.settings().statusLine.command, `${ownIn(m.widal)} statusline`)
  const uninstall = m.run(['uninstall'], { bin: KESTREL })
  assert.deepEqual([uninstall.status, uninstall.stderr], [0, renamedNote('uninstall', 'disconnect')])
  assert.equal(m.settings().statusLine, undefined)
  // "kestrel mcp" is the server for the desktop app, as the extension of the version before starts it. A server prints no note.
  const ping = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`
  const old = m.run(['mcp'], { bin: KESTREL, input: ping })
  assert.deepEqual([old.status, old.stderr], [0, ''])
  assert.deepEqual(JSON.parse(old.stdout), { jsonrpc: '2.0', id: 1, result: {} })
  assert.deepEqual(JSON.parse(m.run(['desktop-mcp'], { input: ping }).stdout), { jsonrpc: '2.0', id: 1, result: {} })
})

test('the status line and the hooks never move an install: ~/.kestrel stays the tool\'s folder until a person types a command', () => {
  const m = kestrelInstall('no-move-from-status-line')
  const was = m.text()
  for (const [args, input] of [[['statusline'], SESSION], [['hook', 'compact-keep'], '{}'], [['hook', 'cold-start'], '{}'], [['refresh-today'], '']]) {
    const r = m.exec(beforeIn(m.kestrel), args, input)
    assert.deepEqual([r.status, r.stderr], [0, ''], args.join(' '))
  }
  assert.equal(lstatSync(m.kestrel).isDirectory(), true)
  assert.equal(existsSync(m.widal), false)
  assert.equal(m.text(), was)
  // The status line kept the file of the session in the old folder.
  assert.ok(readdirSync(join(m.kestrel, 'sessions')).includes('one.json'))
  // No sync with the board was started: the test sent nothing to the board's real address.
  assert.equal(existsSync(join(m.kestrel, 'board.start')), false)
})

test('the plugin\'s hook at the start of a session moves a Kestrel install from the plugin, copies the new version, and prints nothing', () => {
  const m = machine('plugin-move')
  // The stable copy of the version before, in ~/.kestrel/app, with the link to it and the status line calling the link.
  const oldApp = join(m.kestrel, 'app')
  for (const name of ['cli', 'src', 'package.json', 'assets']) cpSync(join(ROOT, name), join(oldApp, name), { recursive: true })
  writeFileSync(join(oldApp, 'package.json'), JSON.stringify({ name: '@widal/kestrel', version: '0.1.0', type: 'module' }))
  link(join(oldApp, 'cli', 'kestrel.mjs'), beforeIn(m.kestrel))
  m.write(settingsWith(beforeIn(m.kestrel)))
  // The plugin's folder of the new version, where Claude Code keeps it.
  const plugin = join(m.env.CLAUDE_CONFIG_DIR, 'plugins', 'cache', 'widal', 'widal', VERSION)
  for (const name of ['cli', 'src', 'package.json', 'assets', 'hooks', '.claude-plugin']) cpSync(join(ROOT, name), join(plugin, name), { recursive: true })
  const sessionStart = () => m.run(['hook', 'refresh-copy', '--plugin'], { bin: join(plugin, 'cli', 'widal.mjs'), input: '{}', env: { CLAUDE_PLUGIN_ROOT: plugin } })
  assert.deepEqual(result(sessionStart()), [0, '', ''])
  // The folder moved, the copy is of the new version, and the links point into the copy at its new place.
  assert.equal(readlinkSync(m.kestrel), m.widal)
  assert.equal(JSON.parse(readFileSync(join(m.widal, 'app', 'package.json'), 'utf8')).version, VERSION)
  assert.equal(readlinkSync(ownIn(m.widal)), join(m.widal, 'app', 'cli', 'widal.mjs'))
  assert.equal(readlinkSync(beforeIn(m.widal)), join(m.widal, 'app', 'cli', 'kestrel.mjs'))
  assert.equal(m.text(), `${JSON.stringify(settingsWith(ownIn(m.widal)), null, 2)}\n`)
  // Open sessions call the old path, which runs the new copy.
  assert.deepEqual(shown(m.exec(beforeIn(m.kestrel), ['statusline'], SESSION)), [0, LINES, ''])
  assert.deepEqual(shown(m.exec(ownIn(m.widal), ['statusline'], SESSION)), [0, LINES, ''])
  // The next start changes nothing.
  const state = () => [m.text(), readlinkSync(ownIn(m.widal)), readlinkSync(beforeIn(m.widal)), statSync(join(m.widal, 'app', 'package.json')).mtimeMs]
  const after = state()
  assert.deepEqual(result(sessionStart()), [0, '', ''])
  assert.deepEqual(state(), after)

  // A plugin that was never set up: the hook moves the folder with the findings in it, and makes no copy and no link.
  const bare = machine('plugin-bare')
  fill(bare.kestrel, { 'findings.json': '{"findings":[]}' })
  const barePlugin = join(bare.env.CLAUDE_CONFIG_DIR, 'plugins', 'cache', 'widal', 'widal', VERSION)
  for (const name of ['cli', 'src', 'package.json', 'assets']) cpSync(join(ROOT, name), join(barePlugin, name), { recursive: true })
  assert.deepEqual(result(bare.run(['hook', 'refresh-copy', '--plugin'], { bin: join(barePlugin, 'cli', 'widal.mjs'), input: '{}', env: { CLAUDE_PLUGIN_ROOT: barePlugin } })), [0, '', ''])
  assert.deepEqual(readdirSync(bare.widal), ['findings.json'])
  assert.equal(readlinkSync(bare.kestrel), bare.widal)
})

test('the move on its own is for the copy of the tool that the install runs: run from another copy it changes nothing, and "widal migrate" there moves the install to that copy', () => {
  const m = machine('other-copy')
  // Another checkout of the tool, of the version before. The install runs it.
  const other = join(m.home, 'other-checkout')
  fill(other, { 'package.json': JSON.stringify({ name: '@widal/kestrel', version: '0.1.0' }), 'cli/kestrel.mjs': '#!/usr/bin/env node\n' })
  fill(m.kestrel, KEPT)
  link(join(other, 'cli', 'kestrel.mjs'), beforeIn(m.kestrel))
  m.write(settingsWith(beforeIn(m.kestrel)))
  const was = m.text()
  // A command of this checkout, typed by a developer, moves nothing and prints only its own output.
  const r = m.run(['summary'])
  assert.deepEqual([r.status, r.stderr], [0, ''])
  assert.equal(lstatSync(m.kestrel).isDirectory(), true)
  assert.equal(existsSync(m.widal), false)
  assert.equal(m.text(), was)
  assert.equal(readlinkSync(beforeIn(m.kestrel)), join(other, 'cli', 'kestrel.mjs'))
  // "widal migrate" is asked for: it moves the install, to this checkout.
  assert.deepEqual(result(m.run(['migrate'])), [0, [
    renamed(m.kestrel, m.widal),
    made(m.widal),
    `Pointed the link ${beforeIn(m.widal)} at ${cli('kestrel')}, so that sessions from before the change of name keep working.`,
    changed(m, 'the status line and 5 hooks'),
    '',
  ].join('\n'), ''])
})

test('an install from before 13 Nov 2026 moves along the chain: ~/.agent-spend becomes ~/.widal, and its old link stays', () => {
  const m = machine('agent-spend-move')
  fill(m.spend, KEPT)
  link(AGENT_SPEND, linkIn(m.home, 'agent-spend'))
  m.write({ statusLine: { type: 'command', command: `${linkIn(m.home, 'agent-spend')} statusline` }, hooks: { PreCompact: [{ hooks: [{ type: 'command', command: 'agent-spend hook compact-keep' }] }] } })
  const r = m.run(['summary'])
  assert.equal(r.status, 0)
  assert.equal(r.stderr, onItsOwn(
    renamed(m.spend, m.widal),
    made(m.widal),
    added(m.home, 'agent-spend'),
    changed(m, 'the status line and one hook'),
  ))
  assert.equal(readlinkSync(m.spend), m.widal)
  assert.equal(existsSync(m.kestrel), false)
  for (const [name, text] of Object.entries(KEPT)) assert.equal(tree(m.widal)[name], text, name)
  assert.deepEqual(m.settings(), { statusLine: { type: 'command', command: `${ownIn(m.widal)} statusline` }, hooks: { PreCompact: [{ hooks: [{ type: 'command', command: `${ownIn(m.widal)} hook compact-keep` }] }] } })
  assert.equal(readlinkSync(linkIn(m.home, 'agent-spend')), AGENT_SPEND)
  assert.deepEqual(result(m.run(['migrate'])), [0, NOTHING_LEFT, ''])
})

test('the move leaves the folders alone when the new one is there too, when WIDAL_HOME or KESTREL_HOME is set, and when there is none', () => {
  // Both: neither is changed, and "migrate" says so, and which folder the tool uses.
  const both = machine('move-both')
  const NEWER = { 'config.json': JSON.stringify({ nudge: { on: false } }), 'sessions/two.json': '{}' }
  fill(both.kestrel, KEPT)
  fill(both.widal, NEWER)
  assert.deepEqual(result(both.run(['migrate'])), [0, `Both ${both.kestrel} and ${both.widal} exist, so neither was changed. The tool uses ${both.widal} from now on, and does not read the records in ${both.kestrel}.\n${NOTHING_LEFT}`, ''])
  assert.deepEqual(tree(both.kestrel), KEPT)
  assert.deepEqual(tree(both.widal), NEWER)
  // The move on its own says nothing about it.
  assert.equal(both.run(['summary']).stderr, '')

  // With WIDAL_HOME, or KESTREL_HOME for one release, the person has named the tool's folder, so the old one stays where it is.
  for (const name of ['WIDAL_HOME', 'KESTREL_HOME']) {
    const named = machine(`move-named-${name}`)
    fill(named.kestrel, KEPT)
    const r = named.run(['migrate'], { env: { [name]: join(named.home, 'own') } })
    assert.deepEqual(result(r), [0, `${name} is set, so the folder ${named.kestrel} was not moved.\n${NOTHING_LEFT}`, ''], name)
    assert.deepEqual(tree(named.kestrel), KEPT)
    assert.equal(existsSync(named.widal), false)
  }

  // None: nothing is made.
  const none = machine('move-none')
  assert.deepEqual(result(none.run(['migrate'])), [0, NOTHING_LEFT, ''])
  assert.deepEqual(result(none.run(['--version'])), [0, `${VERSION}\n`, ''])
  assert.deepEqual(readdirSync(none.home), ['.claude'])
  assert.deepEqual(readdirSync(none.env.CLAUDE_CONFIG_DIR), [])
})

// From here on: the folder of the tool, and its settings in the environment.

test('the old folders are used while the new one does not exist, ~/.kestrel before ~/.agent-spend, and the new one once it is there', () => {
  const m = machine('folders')
  folderWithText(m.spend, 'from agent-spend')
  assert.deepEqual(result(m.run(['hook', 'compact-keep'])), [0, 'from agent-spend', ''])
  folderWithText(m.kestrel, 'from kestrel')
  assert.deepEqual(result(m.run(['hook', 'compact-keep'])), [0, 'from kestrel', ''])
  // The status line keeps the file of the session there, and makes no new folder.
  assert.equal(m.run(['statusline'], { input: SESSION }).status, 0)
  assert.deepEqual(readdirSync(join(m.kestrel, 'sessions')), ['one.json'])
  assert.equal(existsSync(m.widal), false)
  folderWithText(m.widal, 'from widal')
  assert.deepEqual(result(m.run(['hook', 'compact-keep'])), [0, 'from widal', ''])
  assert.deepEqual(result(m.run(['hook', 'compact-keep'], { bin: KESTREL })), [0, 'from widal', ''])

  // With neither folder there, the tool makes the new one.
  const none = machine('folders-none')
  assert.deepEqual(result(none.run(['statusline'], { input: SESSION })), [0, LINES, ''])
  assert.deepEqual(readdirSync(join(none.widal, 'sessions')), ['one.json'])
  assert.equal(existsSync(none.kestrel), false)
})

test('WIDAL_HOME names the tool\'s folder, KESTREL_HOME is still read for one release, WIDAL_HOME wins over it, and AGENT_SPEND_HOME is not read', () => {
  const m = machine('folder-named')
  folderWithText(m.widal, 'from the folder in the home folder')
  for (const name of ['own', 'kestrel-own', 'spend-own']) folderWithText(join(m.home, name), `from ${name}`)
  const text = (env) => m.run(['hook', 'compact-keep'], { env }).stdout
  assert.equal(text({ WIDAL_HOME: join(m.home, 'own') }), 'from own')
  assert.equal(text({ KESTREL_HOME: join(m.home, 'kestrel-own') }), 'from kestrel-own')
  assert.equal(text({ WIDAL_HOME: join(m.home, 'own'), KESTREL_HOME: join(m.home, 'kestrel-own') }), 'from own')
  assert.equal(text({ AGENT_SPEND_HOME: join(m.home, 'spend-own') }), 'from the folder in the home folder')
  // An empty value counts as not set.
  assert.equal(text({ WIDAL_HOME: '', KESTREL_HOME: join(m.home, 'kestrel-own') }), 'from kestrel-own')
})

test('each setting in the environment is read under its WIDAL_ name, and under its KESTREL_ name for one release', async () => {
  const { envSetting, coworkDir } = await import('../src/paths.mjs')
  const { managedSettingsFile } = await import('../src/check-settings.mjs')
  for (const name of ['HOME', 'COWORK_DIR', 'MANAGED_SETTINGS', 'MCP_WAIT_MS', 'NO_BROWSER']) {
    assert.equal(envSetting(name, { [`WIDAL_${name}`]: 'new' }), 'new', name)
    assert.equal(envSetting(name, { [`KESTREL_${name}`]: 'old' }), 'old', name)
    assert.equal(envSetting(name, { [`WIDAL_${name}`]: 'new', [`KESTREL_${name}`]: 'old' }), 'new', name)
    assert.equal(envSetting(name, { [`WIDAL_${name}`]: '' }), undefined, name)
    assert.equal(envSetting(name, {}), undefined, name)
  }
  assert.equal(coworkDir({ env: { KESTREL_COWORK_DIR: '/c/old' } }), '/c/old')
  assert.equal(coworkDir({ env: { WIDAL_COWORK_DIR: '/c/new', KESTREL_COWORK_DIR: '/c/old' } }), '/c/new')
  assert.equal(managedSettingsFile({ KESTREL_MANAGED_SETTINGS: '/m/old.json' }), '/m/old.json')
  assert.equal(managedSettingsFile({ WIDAL_MANAGED_SETTINGS: '/m/new.json' }), '/m/new.json')
})

// From here on: the entries in Claude Code's settings, and the programs of other tools.

test('every form an own entry ever had is changed by "migrate", and recognised by "undo" and "doctor"', () => {
  const m = kestrelInstall('every-form', {})
  const forms = [
    linkIn(m.home, 'agent-spend'), linkIn(m.home, 'kestrel'), // the links on the PATH of the old names
    beforeIn(m.spend), beforeIn(m.kestrel), // the link in the tool's folder, under the folder's old names
    'agent-spend', 'kestrel', // the bare old names
    ...['bin/agent-spend.mjs', 'bin/kestrel.mjs', 'cli/agent-spend.mjs', 'cli/kestrel.mjs'].map((file) => `node /some/checkout/${file}`), // "node" with the command's file
    'node cli/kestrel.mjs', // a path relative to the folder of the tool
    `node ${WIDAL}`, // "node" with the command's file of this tool under the new name
  ]
  const hooks = (programs) => ({ PreCompact: programs.map((program) => ({ hooks: [{ type: 'command', command: `${program} hook compact-keep`, timeout: 5 }] })) })
  m.write({ hooks: hooks(forms) })
  const r = m.run(['migrate'])
  assert.ok(lines(r).includes(changed(m, `${forms.length} hooks`)), r.stdout)
  assert.deepEqual(m.settings(), { hooks: hooks(forms.map(() => ownIn(m.widal))) })

  // "undo" takes out an entry in each form, and "doctor" shows the change as applied until then.
  // The links of the new name count too: the link in the tool's folder, and the link on the PATH that is this tool's own.
  for (const program of [...forms, ownIn(m.widal), beforeIn(m.widal), linkIn(m.home, 'widal')]) {
    m.write({ theme: 'dark', hooks: { PreModelSwitch: [{ hooks: [{ type: 'command', command: `${program} hook model-switch`, timeout: 5 }] }] } })
    writeFileSync(join(m.widal, 'actions.json'), JSON.stringify({ 'model-switch-cost': { at: 1762941600000, before: {} } }))
    assert.match(row(m.run(['doctor']), 'Change: model-switch-cost'), /^applied on \d{4}-\d\d-\d\d$/, program)
    assert.match(m.run(['undo', 'model-switch-cost']).stdout, /^model-switch-cost is taken back\./, program)
    assert.deepEqual(m.settings(), { theme: 'dark', hooks: {} }, program)
  }
})

test('after the move, undo takes back the changes that were applied under the old name, and "doctor" shows them until then', () => {
  const m = kestrelInstall('undo-after-move', {})
  const before = { theme: 'dark', subagentPromptCacheTtl: '5m', hooks: { PreToolUse: [{ matcher: '', hooks: [AUTO_ALLOW, LOOKALIKE] }] } }
  m.write(before)
  const was = m.text()
  // Three changes as Kestrel applied them: their hooks call the link in ~/.kestrel, and their record is there.
  const applied = (program) => ({
    ...before, subagentPromptCacheTtl: '1h',
    hooks: {
      ...before.hooks,
      PreModelSwitch: [{ hooks: [{ type: 'command', command: `${program} hook model-switch`, timeout: 5 }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: `${program} hook compact-keep`, timeout: 5 }] }],
    },
  })
  m.write(applied(beforeIn(m.kestrel)))
  writeFileSync(join(m.kestrel, 'actions.json'), JSON.stringify({
    'subagent-cache-1h': { at: 1762941600000, before: { value: '5m' } },
    'model-switch-cost': { at: 1762941600000, before: {} },
    'compact-keep': { at: 1762941600000, before: {} },
  }))
  const shown = (r) => ['subagent-cache-1h', 'model-switch-cost', 'compact-keep'].map((change) => row(r, `Change: ${change}`).replace(/\d{4}-\d\d-\d\d/, '<day>'))
  // "kestrel status" moves the install first, and then shows them.
  assert.deepEqual(shown(m.run(['status'], { bin: linkIn(m.home, 'kestrel') })), ['applied on <day>', 'applied on <day>', 'applied on <day>'])
  assert.deepEqual(m.settings(), applied(ownIn(m.widal)))
  assert.match(m.run(['undo', 'model-switch-cost']).stdout, /^model-switch-cost is taken back\./)
  assert.match(m.run(['undo', 'subagent-cache-1h']).stdout, /^subagent-cache-1h is taken back\./)
  assert.match(m.run(['undo', 'compact-keep'], { bin: KESTREL }).stdout, /^compact-keep is taken back\./)
  // The settings are exactly as before the first change: the same text.
  assert.equal(m.text(), was)
  assert.deepEqual(JSON.parse(readFileSync(join(m.widal, 'actions.json'), 'utf8')), {})
})

test('"connect" on a Kestrel install ends with only new entries in the settings, and "disconnect" removes every link of the tool', () => {
  const m = kestrelInstall('connect-old', { ...KEPT, 'config.json': JSON.stringify({ limits: { session: 50, action: 'ask' } }) })
  m.write({ theme: 'dark', statusLine: { type: 'command', command: `${beforeIn(m.kestrel)} statusline`, refreshInterval: 30 }, hooks: { PreToolUse: [{ matcher: '', hooks: [AUTO_ALLOW, { type: 'command', command: `${beforeIn(m.kestrel)} hook`, timeout: 5 }] }] } })
  const r = m.run(['connect'], { bin: linkIn(m.home, 'kestrel') })
  assert.deepEqual([r.status, r.stderr], [0, note('kestrel')])
  assert.deepEqual(lines(r).slice(0, 7), [
    renamed(m.kestrel, m.widal),
    made(m.widal),
    added(m.home, 'kestrel', 'agent-spend'),
    changed(m, 'the status line and one hook'),
    boardMoved(m),
    `The command is at ${linkIn(m.home, 'widal')}.`,
    'The status line was already set, with a refresh every 30 seconds.',
  ])
  // Only new entries: every command of the tool in the settings calls the link in ~/.widal.
  assert.doesNotMatch(m.text(), /kestrel|agent-spend/)
  assert.ok(lines(r).includes('Try: widal summary, widal session, widal findings, widal live'))
  // "disconnect" takes out the tool's entries and all its links. The folder stays, and so does the link of its old name.
  assert.equal(m.run(['disconnect']).status, 0)
  assert.deepEqual(m.settings(), { theme: 'dark', hooks: { PreToolUse: [{ matcher: '', hooks: [AUTO_ALLOW] }] } })
  for (const gone of [ownIn(m.widal), beforeIn(m.widal), ...['widal', 'kestrel', 'agent-spend'].map((name) => linkIn(m.home, name))]) assert.equal(lstatSync(gone, { throwIfNoEntry: false }), undefined, gone)
  assert.equal(existsSync(join(m.widal, 'config.json')), true)
  assert.equal(readlinkSync(m.kestrel), m.widal)
})

/** Another program at a path: a file, or a link to another place. Returns what was there, to compare with later. */
function otherProgramAt(at, kind) {
  mkdirSync(dirname(at), { recursive: true })
  if (kind === 'file') writeFileSync(at, '#!/bin/sh\necho another program\n', { mode: 0o755 })
  else symlinkSync('/opt/other/program', at)
  return thing(at)
}

/** What is at a path: the target of a link, or the text and inode of a file. */
const thing = (path) => (lstatSync(path).isSymbolicLink() ? ['link', readlinkSync(path)] : ['file', readFileSync(path, 'utf8'), statSync(path).ino])

/**
 * Widal.Factory, the other program named widal: a checkout with its command bin/widal and a file
 * cli/widal.mjs, in a folder that does not hold this tool.
 */
function factoryIn(home) {
  const folder = join(home, 'factory')
  fill(folder, { 'package.json': JSON.stringify({ name: 'widal-factory' }), 'cli/widal.mjs': 'console.log("factory")\n' })
  mkdirSync(join(folder, 'bin'), { recursive: true })
  writeFileSync(join(folder, 'bin', 'widal'), '#!/bin/sh\necho factory\n', { mode: 0o755 })
  return folder
}

test('the entries of another program named widal are never taken: not the bare word, not another folder, not a path where nothing is, not another program on the PATH', () => {
  const m = machine('factory-entries')
  const factory = factoryIn(m.home)
  link(join(factory, 'bin', 'widal'), linkIn(m.home, 'widal'))
  const gone = join(m.home, 'gone', 'bin', 'widal')
  const theirs = {
    statusLine: { type: 'command', command: 'widal statusline' },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'widal hook check-turn' }, { type: 'command', command: `${join(factory, 'bin', 'widal')} hook stop` }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: `${gone} hook check-settings` }, { type: 'command', command: `node ${join(factory, 'cli', 'widal.mjs')} hook check-settings` }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${linkIn(m.home, 'widal')} hook push-gate` }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: 'widal hook compact-keep' }, { type: 'command', command: `node ${join(m.home, 'gone', 'cli', 'widal.mjs')} hook compact-keep` }] }],
    },
  }
  m.write(theirs)
  const was = m.text()
  // The move on its own and "migrate" change none of them.
  const summary = m.run(['summary'])
  assert.deepEqual([summary.status, summary.stderr], [0, ''])
  assert.equal(m.text(), was)
  assert.deepEqual(result(m.run(['migrate'])), [0, `${leftAlone('widal', linkIn(m.home, 'widal'), WIDAL)}\n${NOTHING_LEFT}`, ''])
  assert.equal(m.text(), was)
  // "doctor" counts none of them as this tool's.
  const doctor = m.run(['doctor'])
  assert.equal(row(doctor, 'Claude Code status line'), 'another tool\'s: widal statusline')
  assert.equal(row(doctor, 'Command on PATH'), `no: another program named widal is at ${linkIn(m.home, 'widal')}`)
  assert.match(row(doctor, 'Change: compact-keep'), /^not applied/)
  // "connect" keeps their status line and their hooks, adds its own hooks, and names the link in its folder to type.
  const connect = m.run(['connect'])
  assert.deepEqual([connect.status, connect.stderr], [0, ''])
  assert.ok(lines(connect).includes(leftAlone('widal', linkIn(m.home, 'widal'), ownIn(m.widal))), connect.stdout)
  assert.ok(lines(connect).includes('Claude Code already has a status line (widal statusline). It was kept. Use --force to replace it.'), connect.stdout)
  assert.ok(lines(connect).includes(`Try: ${ownIn(m.widal)} summary, ${ownIn(m.widal)} session, ${ownIn(m.widal)} findings, ${ownIn(m.widal)} live`))
  const own = (name) => ({ type: 'command', command: `${ownIn(m.widal)} hook ${name}`, timeout: 5 })
  assert.deepEqual(m.settings(), {
    statusLine: theirs.statusLine,
    hooks: {
      Stop: [...theirs.hooks.Stop, { hooks: [own('check-turn')] }],
      SessionStart: [...theirs.hooks.SessionStart, { hooks: [own('check-settings')] }],
      PreToolUse: [...theirs.hooks.PreToolUse, { matcher: 'Bash', hooks: [own('push-gate')] }],
      PreCompact: theirs.hooks.PreCompact,
    },
  })
  // "disconnect" takes out only its own hooks, and leaves the other program on the PATH.
  const disconnect = m.run(['disconnect'])
  assert.deepEqual(result(disconnect), [0, `${leftAlone('widal', linkIn(m.home, 'widal'), WIDAL)}\nRemoved the status line and the hook from Claude Code.\n`, ''])
  assert.equal(m.text(), was)
  assert.equal(readlinkSync(linkIn(m.home, 'widal')), join(factory, 'bin', 'widal'))
})

test('when another program named widal comes first on the PATH, "connect" and "doctor" say so and name the link to type', () => {
  const m = machine('factory-first')
  const factory = factoryIn(m.home)
  const env = { PATH: [join(factory, 'bin'), m.env.PATH].join(delimiter) }
  const connect = m.run(['connect'], { env })
  assert.equal(connect.status, 0)
  assert.ok(lines(connect).includes(`The command is at ${linkIn(m.home, 'widal')}.`))
  assert.ok(lines(connect).includes(`But another program named widal comes first on your PATH, at ${join(factory, 'bin', 'widal')}. Type ${ownIn(m.widal)} to run this tool, or put ${join(m.home, '.local', 'bin')} before ${join(factory, 'bin')} in your PATH.`), connect.stdout)
  assert.ok(lines(connect).includes(`Try: ${ownIn(m.widal)} summary, ${ownIn(m.widal)} session, ${ownIn(m.widal)} findings, ${ownIn(m.widal)} live`))
  assert.equal(row(m.run(['doctor'], { env }), 'Command on PATH'), `${linkIn(m.home, 'widal')}, but another program named widal comes first on your PATH, at ${join(factory, 'bin', 'widal')}. Type ${ownIn(m.widal)} instead`)
  // With this tool first, nothing is said.
  assert.equal(row(m.run(['doctor']), 'Command on PATH'), linkIn(m.home, 'widal'))
})

test('a file or a link of another program at the places on the PATH stays untouched by "connect", "migrate" and "disconnect", and the settings call the link in the tool\'s folder', () => {
  for (const [first, second] of [['file', 'link'], ['link', 'file']]) {
    const m = machine(`other-connect-${first}`)
    const [now, old] = [linkIn(m.home, 'widal'), linkIn(m.home, 'kestrel')]
    const own = ownIn(m.widal)
    const before = [otherProgramAt(now, first), otherProgramAt(old, second)]
    const r = m.run(['connect'])
    assert.deepEqual([r.status, r.stderr], [0, ''], first)
    assert.deepEqual(lines(r).slice(0, 4), [
      made(m.widal),
      leftAlone('widal', now, own),
      leftAlone('kestrel', old, own),
      'The status line is set, with a refresh every 30 seconds. Open sessions show it after their next answer.',
    ], first)
    assert.equal(lines(r).some((line) => line.startsWith('The command is at')), false)
    assert.deepEqual([thing(now), thing(old)], before, first)
    assert.deepEqual(m.settings().statusLine, { type: 'command', command: `${own} statusline`, refreshInterval: 30 })
    assert.deepEqual(result(m.run(['--version'], { bin: own })), [0, `${VERSION}\n`, ''])
    assert.equal(row(m.run(['doctor']), 'Command for Claude Code'), own)

    const gone = m.run(['disconnect'])
    assert.deepEqual(result(gone), [0, [leftAlone('widal', now, WIDAL), leftAlone('kestrel', old, WIDAL), 'Removed the status line and the hook from Claude Code.', ''].join('\n'), ''], first)
    assert.deepEqual([thing(now), thing(old)], before, first)
    assert.equal(lstatSync(own, { throwIfNoEntry: false }), undefined)
  }

  // Settings that call a link on the PATH where another program is: such an entry can only be that program's own. The move leaves it.
  for (const kind of ['file', 'link']) {
    const m = kestrelInstall(`other-migrate-${kind}`, {})
    const old = linkIn(m.home, 'kestrel')
    unlinkSync(old)
    const before = otherProgramAt(old, kind)
    const theirs = { statusLine: { type: 'command', command: `${old} statusline`, refreshInterval: 30 } }
    m.write(theirs)
    const r = m.run(['migrate'])
    assert.equal(r.status, 0)
    assert.ok(lines(r).includes(leftAlone('kestrel', old, ownIn(m.widal))), r.stdout)
    assert.deepEqual(thing(old), before, kind)
    assert.deepEqual(m.settings(), theirs)
  }
})

test('a command of another tool with the name only in a longer name or in an argument is not changed by the move or "disconnect"', () => {
  const m = kestrelInstall('lookalikes', {})
  const text = `${JSON.stringify({
    statusLine: { type: 'command', command: '/usr/bin/other-widal statusline' },
    hooks: {
      PreToolUse: [{ matcher: '', hooks: [
        { type: 'command', command: 'widal-wrapper hook' },
        { type: 'command', command: 'kestrel-wrapper hook' },
        { type: 'command', command: 'agent-spend-helper hook compact-keep' },
        { type: 'command', command: '/x/tool --for widal hook' },
        { type: 'command', command: '/x/notify kestrel statusline' },
        { type: 'command', command: 'node /x/run.mjs widal hook compact-keep' },
        { type: 'command', command: 'node /x/cli/widal.mjs.bak hook' },
        { type: 'command', command: 'node /x/cli/kestrel.mjs.bak hook' },
      ] }],
    },
  }, null, 2)}\n`
  m.write(text)
  const ino = statSync(m.file).ino
  const r = m.run(['migrate'])
  assert.equal(r.status, 0)
  assert.equal(lines(r).some((line) => line.startsWith(`Changed the status line`) || / hooks? in /.test(line)), false)
  assert.equal(m.text(), text)
  const u = m.run(['disconnect'])
  assert.deepEqual(result(u), [0, 'Nothing of Widal.Code was in Claude Code\'s settings. The command is removed from your PATH.\n', ''])
  assert.equal(m.text(), text)
  assert.equal(statSync(m.file).ino, ino)
})

test('a program with an old name in another folder: really there it is another program, and where nothing is it is this tool from an older install', () => {
  for (const name of ['kestrel', 'agent-spend']) {
    const m = machine(`old-name-folder-${name}`)
    const other = join(m.home, 'opt', 'other', name)
    fill(join(m.home, 'opt', 'other'), { [name]: '#!/bin/sh\necho other\n' })
    const theirs = { statusLine: { type: 'command', command: `${other} statusline` }, hooks: { PreCompact: [{ hooks: [{ type: 'command', command: `${other} hook compact-keep` }] }] } }
    m.write(theirs)
    const connect = m.run(['connect'])
    assert.equal(connect.status, 0, connect.stderr)
    assert.ok(connect.stdout.includes(`already has a status line (${other} statusline). It was kept.`), connect.stdout)
    assert.equal(m.run(['disconnect']).status, 0)
    assert.deepEqual(m.settings().statusLine, theirs.statusLine)
    assert.deepEqual(m.settings().hooks.PreCompact, theirs.hooks.PreCompact)

    // A "node" script with the old name in a folder that does not hold this tool is another program too.
    const script = machine(`old-name-script-${name}`)
    fill(join(script.home, 'opt', 'other', 'cli'), { [`${name}.mjs`]: 'console.log("other")\n' })
    const theirScript = { statusLine: { type: 'command', command: `node ${join(script.home, 'opt', 'other', 'cli', `${name}.mjs`)} statusline` } }
    script.write(theirScript)
    assert.equal(script.run(['migrate']).status, 0)
    assert.equal(script.run(['connect']).status, 0)
    assert.equal(script.run(['disconnect']).status, 0)
    assert.deepEqual(script.settings().statusLine, theirScript.statusLine)

    // Where nothing is, the program is this tool from an older install: "connect" takes the status line, and "disconnect" removes the hook.
    const older = machine(`old-name-missing-${name}`)
    const missing = join(older.home, 'opt', 'gone', name)
    older.write({ statusLine: { type: 'command', command: `${missing} statusline` }, hooks: { PreCompact: [{ hooks: [{ type: 'command', command: `${missing} hook compact-keep` }] }] } })
    assert.equal(older.run(['connect']).status, 0)
    assert.equal(older.settings().statusLine.command, `${ownIn(older.widal)} statusline`)
    assert.equal(older.run(['disconnect']).status, 0)
    assert.equal(older.settings().statusLine, undefined)
    assert.ok(!older.text().includes(missing))
  }
})
