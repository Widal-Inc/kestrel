// Tests for the Kestrel pane in Claude Code: "kestrel top --once --json" and the other data the
// pane reads, and the mod in hooks/pane.mjs, loaded with a stand-in for what Claude Code gives it
// (the mods API "$", the events and the elements), built from Anthropic's documentation of mods
// and the types of Claude Code 2.1.325. With made-up home folders. Run: node --test
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'kestrel-pane-test-'))
process.env.HOME = join(dir, 'home-folder')
process.env.KESTREL_HOME = join(dir, 'home')
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
process.env.CODEX_HOME = join(dir, 'codex')
process.env.KESTREL_COWORK_DIR = join(dir, 'cowork')
mkdirSync(process.env.HOME, { recursive: true })
// These say that the person pays by the token. The made-up computer is on a subscription.
for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE']) delete process.env[name]

const { topData } = await import('../src/top.mjs')
const { localDay } = await import('../src/today-file.mjs')

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[/\\]$/, '')
const KESTREL = join(ROOT, 'cli', 'kestrel.mjs')
const MIN = 60e3
// A word in every prompt, answer and task of the made-up log. Only the pane with names on may show it.
const MARKER = 'PELICANSECRET'

let homes = 0
/** A made-up computer: every folder the tool reads or writes is in a new folder, and this process points at it. */
function machine() {
  const home = join(dir, `machine-${++homes}`)
  const env = { HOME: home, KESTREL_HOME: join(home, '.kestrel'), CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), KESTREL_COWORK_DIR: join(home, 'cowork') }
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true })
  Object.assign(process.env, env)
  return { home, env: { PATH: process.env.PATH, NO_COLOR: '1', ...env } }
}
const writeJson = (file, value) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

/**
 * A Claude Code session that works now, as the status line keeps it, with its log and today's
 * numbers: session c1 in work/app on the ticket ABC-322, 313k of context, a cache that lasts 50 more
 * minutes, a task in progress whose name holds the marker, and 625k tokens today.
 */
function oneSession(m, now) {
  writeJson(join(m.env.KESTREL_HOME, 'sessions', 'c1.json'), { at: now - 10e3, callAt: now - 20e3, cacheUntil: now + 50 * MIN, ttl: '1h', ctx: 313000, project: 'work/app', model: 'claude-opus-5-5', ticket: 'ABC-322' })
  const log = join(m.env.CLAUDE_CONFIG_DIR, 'projects', '-work-app', 'c1.jsonl')
  mkdirSync(join(log, '..'), { recursive: true })
  const line = (fields) => JSON.stringify({ cwd: '/work/app', sessionId: 'c1', gitBranch: 'user/abc-322-login', ...fields })
  writeFileSync(log, [
    line({ type: 'user', timestamp: new Date(now - 2 * MIN).toISOString(), message: { role: 'user', content: `Fix the ${MARKER} parser` } }),
    line({
      type: 'assistant', timestamp: new Date(now - MIN).toISOString(),
      message: {
        id: 'a1', model: 'claude-opus-5-5', role: 'assistant',
        content: [{ type: 'tool_use', id: 'todo1', name: 'TodoWrite', input: { todos: [{ content: `Write the ${MARKER} notes`, activeForm: `Writing the ${MARKER} notes`, status: 'in_progress' }] } }],
        usage: { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 300000, output_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 } },
      },
    }),
    '',
  ].join('\n'))
  writeJson(join(m.env.KESTREL_HOME, 'today.json'), { day: localDay(now), at: now, tokens: 625000, cacheRead: 311000, coldStarts: 0, coldTokens: 0, sessions: { c1: { tokens: 625000, source: 'claude', project: 'work/app', ticket: 'ABC-322' } }, tickets: {} })
  // Limits in the shape of today: one reading per account. The account signed in now has 33%; an older
  // reading of another account ("unknown") has 11% and must not show, although it is newer.
  writeJson(join(m.env.KESTREL_HOME, 'limits.json'), {
    'claude:acct-now': { five: { pct: 33, resetsAt: now + 2 * 3600e3, at: now - 5 * MIN } },
    // Newer than the signed-in account's, so only the right choice of account shows 33%.
    unknown: { five: { pct: 11, resetsAt: now + 2 * 3600e3, at: now - 30e3 } },
  })
  writeJson(join(m.env.KESTREL_HOME, 'accounts.json'), { accounts: { 'claude:acct-now': { org: 'Example Org' } }, signedIn: { [realpathSync(m.env.CLAUDE_CONFIG_DIR)]: 'claude:acct-now' } })
}

/** Runs the command on a made-up computer. */
const run = (m, args) => spawnSync(process.execPath, [KESTREL, ...args], { encoding: 'utf8', env: m.env })

test('"kestrel top --once --json": the head, each row with its facts and its words, the footer, and no task while names are off', () => {
  const m = machine()
  const now = Date.now()
  oneSession(m, now)
  const data = topData(now, { names: true, env: {} })
  assert.deepEqual(Object.keys(data), ['at', 'count', 'limits', 'sessions', 'waste', 'next'])
  assert.equal(data.at, now)
  assert.equal(data.count, 1)
  assert.equal(data.limits.length, 1)
  assert.match(data.limits[0].text, /^5 hour limit 33% used/)
  const [row] = data.sessions
  assert.deepEqual(row, {
    id: 'c1', tool: 'Claude', project: 'work/app', ticket: 'ABC-322', also: [], state: 'working', minutes: null,
    context: 313000, window: null, cacheUntil: now + 50 * MIN, today: 625000, agents: 0,
    shown: { session: 'work/app', tool: 'Claude', ticket: 'ABC-322', state: 'working', context: '313k', cache: 'warm, 50 min left', today: '625k', agents: '' },
    resume: 'claude --resume c1',
    task: `Writing the ${MARKER} notes`,
  })
  assert.equal(data.waste, 'Waste today: 0 cold starts sent 0 tokens again (0% of today).')
  assert.equal(data.next, null)
  // Without names the row has no task, and nothing of the session's text is in the data.
  const without = topData(now, { names: false, env: {} })
  assert.equal(Object.hasOwn(without.sessions[0], 'task'), false)
  assert.ok(!JSON.stringify(without).includes(MARKER))

  // The command: names follow the setting hud.names, and --no-names leaves them out.
  const r = run(m, ['top', '--once', '--json'])
  assert.deepEqual([r.status, r.stderr], [0, ''])
  assert.equal(JSON.parse(r.stdout).sessions[0].task, `Writing the ${MARKER} notes`)
  assert.ok(!run(m, ['top', '--once', '--json', '--no-names']).stdout.includes(MARKER))
  writeJson(join(m.env.KESTREL_HOME, 'config.json'), { hud: { names: false } })
  const off = run(m, ['top', '--once', '--json'])
  assert.equal(off.status, 0)
  assert.ok(!off.stdout.includes(MARKER))
  assert.equal(JSON.parse(off.stdout).sessions.length, 1)
  // --json alone is the view once too, never the live view.
  assert.equal(JSON.parse(run(m, ['top', '--json']).stdout).count, 1)
  // No file of the tool holds the task.
  assert.ok(!readFileSync(join(m.env.KESTREL_HOME, 'today.json'), 'utf8').includes(MARKER))
})

test('"kestrel summary --json" and "kestrel advise --json" give today, the period and the proposals as data', () => {
  const m = machine()
  oneSession(m, Date.now())
  const s = run(m, ['summary', '--json'])
  assert.deepEqual([s.status, s.stderr], [0, ''])
  const summary = JSON.parse(s.stdout)
  assert.deepEqual(Object.keys(summary), ['days', 'period', 'today', 'byDay', 'byTool'])
  assert.equal(summary.days, 7)
  assert.deepEqual(Object.keys(summary.today), ['cost', 'tokens', 'calls', 'sessions', 'unpriced', 'paid'])
  // The dollars split by how they are paid: by the token, on a subscription, or not known. Together they are the cost.
  assert.deepEqual(Object.keys(summary.today.paid), ['token', 'subscription', 'unknown'])
  assert.ok(Math.abs(summary.today.paid.token + summary.today.paid.subscription + summary.today.paid.unknown - summary.today.cost) < 1e-9)
  assert.deepEqual([summary.today.calls, summary.today.tokens, summary.today.sessions], [1, 303500, 1])
  assert.ok(summary.today.cost > 0)
  assert.deepEqual(summary.byTool.map((t) => t.tool), ['Claude Code'])
  assert.equal(summary.byDay[0].day, localDay(Date.now()))
  assert.ok(!s.stdout.includes(MARKER))
  const a = run(m, ['advise', '--json'])
  assert.deepEqual([a.status, a.stderr], [0, ''])
  const advise = JSON.parse(a.stdout)
  assert.deepEqual(Object.keys(advise), ['days', 'total', 'calls', 'proposals'])
  assert.equal(advise.days, 30)
  assert.ok(Array.isArray(advise.proposals))
})

test('the data of a proposal: its change with the arguments as a list, or none when it is made by hand, and whether it is applied', async () => {
  const { adviseData } = await import('../src/advise.mjs')
  const { ClaudeParser } = await import('../src/parse-claude.mjs')
  assert.deepEqual(adviseData([], { days: 30 }), { days: 30, total: 0, calls: 0, proposals: [] })
  // Reading at effort high, and 200 calls of the person's own at medium: the proposal to start sessions at a lower effort.
  let n = 0
  const call = (effort, out) => JSON.stringify({
    type: 'assistant', timestamp: new Date(Date.parse('2026-11-12T10:00:00Z') + n * 10e3).toISOString(), cwd: '/work/repo', effort,
    message: { id: `m${n}`, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: `t${n++}`, name: 'Read', input: { n } }], usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 50000, output_tokens: out } },
  })
  const parser = new ClaudeParser('/logs/main.jsonl')
  for (let i = 0; i < 200; i++) parser.feed(call('medium', 300))
  for (let i = 0; i < 50; i++) parser.feed(call('high', 1000))
  const records = parser.result().records
  const effort = (data) => data.proposals.find((p) => p.id === 'effort-lower')
  assert.deepEqual(effort(adviseData(records, { days: 30 })), {
    id: 'effort-lower', title: 'Start sessions at a lower effort', saving: effort(adviseData(records, { days: 30 })).saving, share: effort(adviseData(records, { days: 30 })).share,
    action: 'effort-default', args: ['--level', 'medium'], applied: false, appliedAt: null, note: null,
  })
  // Applied: the change has a time, and the pane offers Undo for it.
  // Output above 300 tokens at $20 per million: 50 calls with 700 tokens more.
  assert.ok(Math.abs(effort(adviseData(records, { days: 30 })).saving - (50 * 700 * 20) / 1e6) < 1e-9)
  const applied = effort(adviseData(records, { days: 30, applied: { 'effort-default': { at: 5, before: {} } } }))
  assert.deepEqual([applied.applied, applied.appliedAt], [true, 5])
  // A proposal made by hand has no change and no arguments.
  for (const p of adviseData(records, { days: 30 }).proposals.filter((x) => !x.action)) assert.deepEqual(p.args, [], p.id)
})

// From here on: the mod. The stand-in is built from the documentation: an element is a function
// that takes props and gives { type, props, children }; $.process.run(argv, init) resolves
// { exitCode, stdout, stderr }; $.ui.open resolves { isPlaced }; $.clock.every gives a timer with
// cancel(); a Pane is drawn with e.requestId and e.props.bodyColumns.

// The props each element takes, from the elements reference. A tree with any other prop is refused.
const PROPS = {
  Box: ['key', 'flexDirection', 'gap', 'columnGap', 'rowGap', 'padding', 'paddingX', 'paddingY', 'margin', 'marginTop', 'width', 'height', 'borderStyle', 'borderColor', 'children'],
  Text: ['color', 'backgroundColor', 'bold', 'italic', 'underline', 'strikethrough', 'dimColor', 'inverse', 'wrap', 'weight', 'children'],
  Button: ['key', 'label', 'children', 'onPress', 'hotkey', 'plain', 'dimColor', 'autoFocus', 'action', 'variant', 'role'],
  Select: ['key', 'label', 'options', 'value', 'onSelect', 'autoFocus'],
  Input: ['key', 'label', 'placeholder', 'value', 'submitLabel', 'rows', 'onSubmit', 'onInput', 'autoFocus'],
}
// The colours a Text takes: a theme key, or a colour such as "red".
const COLORS = ['text', 'inactive', 'subtle', 'success', 'error', 'warning', 'claude']

/** The elements, as $.ui.resolve(e) gives them, each checking its props as Claude Code does. */
const ELEMENTS = Object.fromEntries(Object.entries(PROPS).map(([type, allowed]) => [type, (props) => {
  for (const name of Object.keys(props)) assert.ok(allowed.includes(name), `${type} prop "${name}" is not allowed`)
  const children = props.children ?? []
  assert.ok(Array.isArray(children), `${type} children are a list`)
  if (type === 'Text') {
    for (const child of children) assert.equal(typeof child, 'string', 'a Text holds strings')
    if (props.color !== undefined) assert.ok(COLORS.includes(props.color), props.color)
  }
  if (type === 'Button') {
    assert.equal(typeof props.onPress, 'function', 'a Button runs onPress')
    assert.ok(typeof props.label === 'string' && props.label, 'a Button has a label')
    if (props.hotkey !== undefined) assert.match(props.hotkey, /^[0-9a-z]$/)
    if (props.plain !== undefined) assert.equal(props.plain, true, 'plain is true or left out')
  }
  if (type === 'Select') {
    assert.ok(typeof props.key === 'string' && props.key, '<Select> needs a key')
    assert.ok(props.options.length >= 1 && new Set(props.options.map((o) => o.value)).size === props.options.length)
    assert.equal(typeof props.onSelect, 'function')
  }
  if (type === 'Input') {
    assert.ok(typeof props.key === 'string' && props.key, '<Input> needs a key')
    assert.equal(typeof props.onSubmit, 'function')
  }
  return { type, props, children }
}]))

/** Every element of a tree, and a check that no two controls share a key. */
function elements(tree) {
  const all = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    all.push(node)
    for (const child of node.children) walk(child)
  }
  walk(tree)
  const keys = all.filter((n) => ['Button', 'Select', 'Input'].includes(n.type)).map((n) => `${n.type} ${n.props.key ?? n.props.label}`)
  assert.equal(new Set(keys).size, keys.length, `a control is drawn twice: ${keys.join(', ')}`)
  return all
}
/** The words a tree shows: the text of each Text and the label of each Button and Input, in order. */
const words = (tree) => elements(tree).flatMap((n) => (n.type === 'Text' ? [n.children.join('')] : ['Button', 'Input', 'Select'].includes(n.type) ? [n.props.label] : []))
const control = (tree, key) => elements(tree).find((n) => (n.props.key ?? n.props.label) === key)

/** Lets the work that a hook or a press started without waiting for it finish. */
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve))
}

let loads = 0
/**
 * Loads the mod afresh, as Claude Code does for a new session, and calls its register with a
 * stand-in for "on". Returns the hooks it registered, by event, with their matchers.
 */
async function loadMod() {
  const { register } = await import(`../hooks/pane.mjs?load=${++loads}`)
  const hooks = []
  register((event, matcher, hook) => {
    if (typeof matcher === 'function') [hook, matcher] = [matcher, undefined]
    hooks.push({ event, matcher, hook })
    return { catch() {} }
  })
  return hooks
}

/**
 * A stand-in for the mods API, "$". `answer(args)` gives what a run of Kestrel with these
 * arguments resolves to: { exitCode, stdout, stderr }, or it throws as a program that cannot start.
 */
function standIn({ answer, placed = true, cwd = '/work/app' }) {
  const calls = { open: [], close: [], redraws: 0, runs: [], timers: [] }
  const $ = {
    plugin: { name: 'kestrel', root: ROOT },
    ui: {
      resolve: () => ELEMENTS,
      open: async (pane) => {
        calls.open.push(pane)
        return placed ? { isPlaced: true } : { isPlaced: false, reason: 'no-surface: this run draws nowhere' }
      },
      close: async (pane) => calls.close.push(pane),
      invalidate: (name) => {
        assert.equal(name, 'ui.render')
        calls.redraws++
      },
    },
    process: {
      run: async (argv, init) => {
        calls.runs.push({ argv, init })
        // The plugin's own command file, run by node, with an argument list.
        assert.deepEqual(argv.slice(0, 2), ['node', KESTREL])
        assert.ok(init.timeoutMs >= 60e3 && init.timeoutMs <= 600e3)
        const r = await answer(argv.slice(2))
        return { stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...r }
      },
    },
    clock: {
      every: (ms, fn) => {
        const timer = { ms, fn, cancelled: false, cancel() { this.cancelled = true } }
        calls.timers.push(timer)
        return timer
      },
    },
    session: { cwd: async () => cwd },
  }
  return { $, calls, args: () => calls.runs.map((r) => r.argv.slice(2).join(' ')) }
}

/** What Claude Code passes to the pane's ui.render hook. */
const paneEvent = (surface = 'terminal') => ({
  plugin: 'kestrel', component: 'Pane', requestId: 'kestrel', surface, viewport: { columns: 200, rows: 50, isFullscreen: true },
  props: { title: 'Kestrel', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
})
/** The parts of the mod a test drives: run a command, draw the pane, and the hooks themselves. */
function driver(hooks, s) {
  const of = (event) => hooks.find((h) => h.event === event)
  const passedOn = []
  return {
    passedOn,
    command: (command) => of('command.run').hook(s.$, { command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } }, async (e) => {
      passedOn.push(e.command)
      return { text: 'the command file ran' }
    }),
    draw: (surface) => of('ui.render').hook(s.$, paneEvent(surface), async () => ({ type: 'engine' })),
    close: () => of('ui.close').hook(s.$, { id: 'kestrel', origin: { kind: 'person' } }, async () => ({ value: undefined })),
  }
}

/** Runs the real command for a run of the mod, on the made-up computer this process points at. */
const realAnswer = (args) => {
  const env = { PATH: process.env.PATH, NO_COLOR: '1' }
  for (const key of ['HOME', 'KESTREL_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'KESTREL_COWORK_DIR']) env[key] = process.env[key]
  const r = spawnSync(process.execPath, [KESTREL, ...args], { encoding: 'utf8', env })
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr }
}
const ok = (value) => ({ exitCode: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value) })

test('the mod registers its hooks: the two plugin commands, the drawing of its pane, and the pane closing', async () => {
  const hooks = await loadMod()
  assert.deepEqual(hooks.map((h) => [h.event, h.matcher]), [
    ['command.run', { command: ['kestrel:open', 'kestrel:settings'] }],
    ['ui.render', { component: 'Pane' }],
    ['ui.close', { id: 'kestrel' }],
  ])
  // Claude Code reads hooks/hooks.json: it names the mod, and still carries the plugin's hooks, now also those of the security checks.
  const file = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'))
  assert.deepEqual(file.modules, ['./pane.mjs'])
  assert.deepEqual(Object.keys(file.hooks).sort(), ['PreCompact', 'PreModelSwitch', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'])
  // The module has no Node: its two imports are the words for a finding and the tool's formatting of numbers, which import nothing.
  const source = readFileSync(join(ROOT, 'hooks', 'pane.mjs'), 'utf8')
  assert.deepEqual([...source.matchAll(/^import .* from '(.+)'$/gm)].map((x) => x[1]), ['../src/finding-words.mjs', '../src/format.mjs'])
  for (const file of ['format.mjs', 'finding-words.mjs']) assert.doesNotMatch(readFileSync(join(ROOT, 'src', file), 'utf8'), /^import /m, file)
  // It never fetches and runs no shell. Its one prompt is the button "Hand to the agent", which asks first.
  assert.doesNotMatch(source, /\$\.http\.|\$\.model\.|'sh'|'bash'|'-c'/)
  assert.deepEqual([...new Set([...source.matchAll(/\$\.prompt\.\w+/g)].map((x) => x[0]))], ['$.prompt.submit'])
  // Another mod's pane is left alone.
  const other = { ...paneEvent(), requestId: 'someone-else' }
  assert.deepEqual(await hooks[1].hook(standIn({ answer: () => ok('{}') }).$, other, async () => 'theirs'), 'theirs')
})

test('/kestrel:open opens the pane on Now, reads the sessions every 5 seconds, a row opens its detail view, Back returns, and closing stops the reading', async () => {
  const m = machine()
  const at = Date.now()
  oneSession(m, at)
  const top = topData(at, { names: true, env: {} })
  // A second row, of Codex, without a ticket and without a way to resume it.
  top.sessions.push({ ...top.sessions[0], id: 'x1', tool: 'Codex', project: 'work/api', ticket: null, resume: null, task: undefined, shown: { ...top.sessions[0].shown, session: 'work/api', tool: 'Codex', ticket: '', state: 'idle (10 min)', cache: 'not known' } })
  delete top.sessions[1].task
  top.count = 2
  const s = standIn({ answer: (args) => (args.join(' ') === 'top --once --json' ? ok(top) : assert.fail(args.join(' '))) })
  const d = driver(await loadMod(), s)

  assert.deepEqual(await d.command('kestrel:open'), {})
  assert.deepEqual(s.calls.open, [{ id: 'kestrel', title: 'Kestrel', focus: true, closeOnEscape: true }])
  assert.deepEqual(d.passedOn, [])
  assert.equal(s.calls.timers.length, 1)
  assert.equal(s.calls.timers[0].ms, 5000)
  await settle()
  assert.deepEqual(s.args(), ['top --once --json'])
  let tree = await d.draw()
  let shown = words(tree)
  // The four tabs, each a button with its digit, Now in full strength.
  assert.deepEqual(['Now', 'Spend', 'Settings', 'Security'].map((label) => control(tree, `tab-${label.toLowerCase()}`).props.hotkey), ['1', '2', '3', '4'])
  assert.equal(control(tree, 'tab-now').props.dimColor, false)
  assert.equal(control(tree, 'tab-spend').props.dimColor, true)
  // After the four tabs and a blank line: the head.
  assert.deepEqual(shown.slice(0, 5), ['Now', 'Spend', 'Settings', 'Security', ' '])
  assert.match(shown[5], /^2 sessions on this computer · 5 hour limit 33% used.* · \d\d:\d\d:\d\d$/)
  // Each row is a button with the columns of "kestrel top".
  const row = control(tree, 'session-Claude-c1')
  assert.equal(row.type, 'Button')
  assert.match(row.props.label, /^work\/app {2}Claude {2}ABC-322 {2}working {8}313k {2}warm, 50 min left {2}today 625k$/)
  assert.match(control(tree, 'session-Codex-x1').props.label, /^work\/api {2}Codex {12}idle \(10 min\) {2}313k {2}not known {10}today 625k$/)
  assert.ok(shown.includes('Waste today: 0 cold starts sent 0 tokens again (0% of today).'))

  // Pressing a row opens its detail view.
  row.props.onPress({ surface: 'terminal' })
  tree = await d.draw()
  shown = words(tree)
  assert.deepEqual(shown.slice(shown.indexOf('work/app')), [
    'work/app',
    'Project: work/app',
    'Tool: Claude Code',
    'Ticket: ABC-322',
    'State: working',
    'Context: 313k',
    'Cache: warm, 50 min left',
    'Tokens today: 625k',
    'Agents running: 0',
    `Task: Writing the ${MARKER} notes`,
    'Resume it in a terminal with: claude --resume c1',
    ' ',
    'Back',
  ])
  assert.equal(control(tree, 'back').props.hotkey, 'b')
  // Every 5 seconds the timer reads the sessions again, also in the detail view.
  await s.calls.timers[0].fn()
  assert.deepEqual(s.args(), ['top --once --json', 'top --once --json'])
  // Back returns to the list.
  control(tree, 'back').props.onPress({ surface: 'terminal' })
  assert.ok(control(await d.draw(), 'session-Claude-c1'))
  // A Codex row has no task and no command to resume it.
  control(await d.draw(), 'session-Codex-x1').props.onPress({})
  shown = words(await d.draw())
  assert.ok(shown.includes('Ticket: none'))
  assert.ok(!shown.some((w) => w.startsWith('Task:') || w.startsWith('Resume')))

  // Closing the pane stops the timer.
  assert.deepEqual(await d.close(), { value: undefined })
  assert.equal(s.calls.timers[0].cancelled, true)
})

test('with names off the detail view has no task, because the data holds none', async () => {
  const m = machine()
  const at = Date.now()
  oneSession(m, at)
  const top = topData(at, { names: false, env: {} })
  const s = standIn({ answer: () => ok(top) })
  const d = driver(await loadMod(), s)
  await d.command('kestrel:open')
  await settle()
  control(await d.draw(), 'session-Claude-c1').props.onPress({})
  const shown = words(await d.draw())
  assert.ok(shown.includes('Resume it in a terminal with: claude --resume c1'))
  assert.ok(!shown.join('\n').includes(MARKER))
})

test('/kestrel:settings opens the pane on Settings: each checkbox runs "kestrel settings set" with the right arguments, as do the sets, the switch for this project and Undo', async () => {
  machine()
  const repo = mkdtempSync(join(dir, 'repo-'))
  const s = standIn({ answer: realAnswer, cwd: repo })
  const d = driver(await loadMod(), s)
  assert.deepEqual(await d.command('kestrel:settings'), {})
  await settle()
  assert.deepEqual(s.args(), ['settings --json'])
  let tree = await d.draw()
  let shown = words(tree)
  assert.equal(control(tree, 'tab-settings').props.dimColor, false)
  // The groups, a checkbox per setting, the sentence about the checks.
  for (const head of ['Status line', 'Hints', 'Security frameworks', 'Frameworks: Healthcare', 'Frameworks: Life sciences', 'Frameworks: Fintech', 'Frameworks: AI agents', 'Checks']) assert.ok(shown.includes(head), head)
  assert.ok(shown.includes('[ ] HIPAA'))
  assert.ok(shown.includes('[x] OWASP Top 10 for Agentic Applications'))
  assert.ok(shown.includes('[x] Bars for the context and the limits'))
  assert.ok(shown.includes('[ ] Data (it reads the text of sessions)'))
  assert.ok(shown.includes('Kestrel checks technical controls and flags risks. It does not make a company compliant or certify it.'))
  assert.ok(shown.includes(`[ ] For this project: ${repo}`))

  // Pressing a checkbox runs "kestrel settings set" and shows the new value.
  control(tree, 'setting-security.frameworks.hipaa').props.onPress({ surface: 'terminal' })
  await settle()
  assert.deepEqual(s.calls.runs.at(-2).argv.slice(2), ['settings', 'set', 'security.frameworks.hipaa', 'on'])
  tree = await d.draw()
  assert.ok(words(tree).includes('[x] HIPAA'))
  assert.ok(words(tree).includes('Saved: HIPAA: on.'))
  control(tree, 'setting-hud.bars').props.onPress({})
  await settle()
  assert.deepEqual(s.calls.runs.at(-2).argv.slice(2), ['settings', 'set', 'hud.bars', 'off'])
  // A choice of two moves on to the other value.
  tree = await d.draw()
  assert.equal(control(tree, 'setting-hud.layout').props.label, 'Layout of the status line: lines (press for one)')
  control(tree, 'setting-hud.layout').props.onPress({})
  await settle()
  assert.deepEqual(s.calls.runs.at(-2).argv.slice(2), ['settings', 'set', 'hud.layout', 'one'])
  // A set switches several on.
  control(await d.draw(), 'set-fintech').props.onPress({})
  await settle()
  assert.deepEqual(s.calls.runs.at(-2).argv.slice(2), ['settings', 'set', 'security.set', 'fintech'])
  tree = await d.draw()
  for (const label of ['[x] PCI DSS', '[x] GLBA Safeguards Rule', '[x] SOC 2']) assert.ok(words(tree).includes(label), label)
  // Undo takes the set back.
  control(tree, 'undo').props.onPress({})
  await settle()
  assert.equal(s.calls.runs.at(-2).argv.slice(2).join(' '), 'settings undo')
  tree = await d.draw()
  assert.ok(words(tree).includes('[ ] PCI DSS'))
  assert.ok(words(tree).includes('Taken back: the Fintech set. The setting is as it was before.'))

  // For this project: the frameworks are read and written for the session's folder.
  control(tree, 'project').props.onPress({})
  await settle()
  assert.deepEqual(s.calls.runs.at(-1).argv.slice(2), ['settings', '--json', '--project', repo])
  tree = await d.draw()
  assert.ok(words(tree).includes(`[x] For this project: ${repo}`))
  assert.ok(words(tree).includes(`This project has no frameworks of its own yet. A change writes ${join(repo, '.claude', 'loobster-frameworks.json')}.`))
  control(tree, 'setting-security.frameworks.gdpr').props.onPress({})
  await settle()
  assert.deepEqual(s.calls.runs.at(-2).argv.slice(2), ['settings', 'set', 'security.frameworks.gdpr', 'on', '--project', repo])
  assert.deepEqual(JSON.parse(readFileSync(join(repo, '.claude', 'loobster-frameworks.json'), 'utf8')), { frameworks: ['hipaa', 'gdpr', 'owasp-agentic'] })
  // A setting that is not a framework still goes to the person, also while the switch is on.
  control(await d.draw(), 'setting-hint.nudge').props.onPress({})
  await settle()
  assert.deepEqual(s.calls.runs.at(-2).argv.slice(2), ['settings', 'set', 'hint.nudge', 'on'])

  // The Security tab: what is on, for this project, from "kestrel check --json", which finds nothing open here.
  control(await d.draw(), 'tab-security').props.onPress({})
  await settle()
  shown = words(await d.draw())
  assert.deepEqual(s.calls.runs.at(-1).argv.slice(2), ['check', '--json'])
  assert.equal(s.calls.runs.at(-1).init.cwd, repo)
  assert.deepEqual(shown.slice(shown.indexOf('Frameworks that are on')), [
    'Frameworks that are on',
    'HIPAA, OWASP Top 10 for Agentic Applications',
    `For ${repo}, from ${join(repo, '.claude', 'loobster-frameworks.json')}.`,
    'Open findings: 0 high, 0 medium, 0 low, 0 info',
    'Kestrel checks technical controls and flags risks. It does not make a company compliant or certify it.',
    ' ',
    'No check has found anything open.',
    ' ',
    'Run checks for this folder',
    'Cloud checks run only when you ask, in a terminal: kestrel cloud-check aws, vercel or github.',
  ])
})

test('a setting with more than two choices is a Select, and the accounts get a field for their label', async () => {
  machine()
  const data = {
    settings: [{ key: 'hud.speed', group: 'Status line', label: 'Speed', kind: 'choice', values: ['slow', 'normal', 'fast'], value: 'normal', default: 'normal' }],
    sets: [], frameworks: { on: [], from: 'person', file: null, project: null }, note: 'The checks run now: settings, actions and code on their own, data only when you turn it on, and the cloud only when you ask (kestrel cloud-check). Kestrel checks technical controls and certifies nothing.', undo: false,
    accounts: [{ key: 'claude:aaa', label: 'Widal, Inc.', tool: 'Claude Code', kind: 'subscription', plan: 'max' }],
  }
  const s = standIn({ answer: (args) => (args[0] === 'settings' ? ok(data) : ok('The label is saved.\n')) })
  const d = driver(await loadMod(), s)
  await d.command('kestrel:settings')
  await settle()
  const tree = await d.draw()
  const select = control(tree, 'setting-hud.speed')
  assert.equal(select.type, 'Select')
  assert.deepEqual(select.props.options, [{ value: 'slow', label: 'slow' }, { value: 'normal', label: 'normal' }, { value: 'fast', label: 'fast' }])
  assert.equal(select.props.value, 'normal')
  select.props.onSelect('fast')
  await settle()
  assert.deepEqual(s.calls.runs.find((r) => r.argv[2] === 'settings' && r.argv[3] === 'set').argv.slice(2), ['settings', 'set', 'hud.speed', 'fast'])
  const field = control(await d.draw(), 'label-claude:aaa')
  assert.equal(field.type, 'Input')
  assert.equal(field.props.label, 'Widal, Inc. (claude:aaa)')
  field.props.onSubmit('  Client work  ')
  await settle()
  assert.ok(s.calls.runs.some((r) => r.argv.slice(2).join('|') === 'accounts|label|claude:aaa|Client work'))
})

/** The Spend tab's data: today and 7 days, two accounts, and four proposals of which three show. */
const SUMMARY = { days: 7, period: { cost: 312.5, tokens: 41e6, calls: 900, sessions: 12, unpriced: 0, paid: { token: 12.5, subscription: 300, unknown: 0 } }, today: { cost: 45.67, tokens: 12.3e6, calls: 120, sessions: 3, unpriced: 0, paid: { token: 0, subscription: 45.67, unknown: 0 } }, byDay: [], byTool: [] }
const ACCOUNTS = {
  days: 7, current: 'claude:aaa',
  accounts: [
    { key: 'claude:aaa', label: 'Widal, Inc.', kind: 'subscription', tool: 'Claude Code', plan: 'max', limits: { five: { pct: 20, resetsAt: 1, at: 1 }, week: { pct: 40, resetsAt: 1, at: 1 } }, today: { tokens: 5e6, cost: 20 }, period: { tokens: 30e6, cost: 200, sessions: 8 }, lastSeen: 1, price: { monthly: 100, source: 'table' }, dollars: 'API value' },
    { key: 'api', label: 'api', kind: 'usage', tool: 'Claude Code', plan: null, limits: { five: null, week: null }, today: { tokens: 1000, cost: 0.5 }, period: { tokens: 2e6, cost: 9.25, sessions: 2 }, lastSeen: 1, price: null, dollars: 'spend' },
  ],
}
const proposal = (fields) => ({ id: 'x', title: 'x', saving: 1, share: 0.01, action: null, args: [], applied: false, appliedAt: null, note: null, ...fields })
const ADVISE = {
  days: 30, total: 1000, calls: 5000,
  proposals: [
    proposal({ id: 'effort-lower', title: 'Start sessions at a lower effort', saving: 120, action: 'effort-default', args: ['--level', 'medium'] }),
    proposal({ id: 'subagent-check-in', title: 'Subagents check in every 4 minutes while they wait', saving: 80 }),
    proposal({ id: 'subagent-cache-1h', title: 'Give subagents a 1 hour cache', saving: 40, action: 'subagent-cache-1h', applied: true, appliedAt: 1 }),
    proposal({ id: 'subagent-start', title: 'Start subagents with 20k tokens less', saving: 10 }),
  ],
}

test('Spend: today and 7 days, per account, the top 3 proposals; Apply asks once more and then runs "kestrel apply", and an applied change has Undo', async () => {
  machine()
  const answers = { 'summary --json': ok(SUMMARY), 'advise --json': ok(ADVISE), 'accounts --json': ok(ACCOUNTS), 'apply effort-default --level medium': ok('Set "effortLevel" to medium in Claude Code\'s settings.\nNew sessions use it.\n'), 'undo subagent-cache-1h': ok('subagent-cache-1h is taken back. Claude Code\'s settings are as they were before it.\n') }
  const s = standIn({ answer: (args) => answers[args.join(' ')] ?? assert.fail(args.join(' ')) })
  const d = driver(await loadMod(), s)
  await d.command('kestrel:open')
  await settle()
  control(await d.draw(), 'tab-spend').props.onPress({})
  // While the logs are read, the tab says so.
  assert.ok(words(await d.draw()).includes('Reading the logs. The first time can take a while.'))
  await settle()
  assert.deepEqual(s.args().slice(1), ['summary --json', 'advise --json', 'accounts --json'])
  let tree = await d.draw()
  let shown = words(tree)
  // The tab is named Spend too: the heading is the second.
  const spendAt = shown.lastIndexOf('Spend')
  assert.deepEqual(shown.slice(spendAt, spendAt + 4), [
    'Spend',
    'Today: 12M tokens, $45.67 of API value, 120 model calls',
    'Last 7 days: 41M tokens, $12.50 spend by the token and $300 of API value on subscriptions, 12 sessions',
    'Dollars are list prices. Paid by the token they are spend. On a subscription they are API value: what the same use would cost by the token.',
  ])
  assert.deepEqual(shown.slice(shown.indexOf('Per account') + 1, shown.indexOf('Per account') + 3), [
    'Widal, Inc. (Claude Code, max, $100 a month): today 5.0M tokens, $20.00 of API value, last 7 days $200 of API value, 5 hours 20% used, week 40% used',
    'api (Claude Code): today 1.0k tokens, $0.50 spend, last 7 days $9.25 spend',
  ])
  // Three proposals, each with what can be done about it. The fourth does not show.
  assert.ok(shown.includes('1. Start sessions at a lower effort: $120 less'))
  assert.ok(shown.includes('2. Subagents check in every 4 minutes while they wait: $80.00 less'))
  assert.ok(shown.includes('3. Give subagents a 1 hour cache: $40.00 less'))
  assert.ok(!shown.some((w) => w.includes('20k tokens less')))
  assert.ok(shown.includes('This change is made by hand. "kestrel advise" says how.'))
  assert.equal(control(tree, 'apply-0').props.label, 'Apply effort-default --level medium')
  assert.equal(control(tree, 'undo-2').props.label, 'Undo subagent-cache-1h')

  // Apply asks first, and runs nothing yet.
  const before = s.calls.runs.length
  control(tree, 'apply-0').props.onPress({})
  tree = await d.draw()
  assert.ok(words(tree).includes('Apply effort-default? It changes Claude Code\'s settings, with a backup.'))
  assert.equal(s.calls.runs.length, before)
  // No: nothing runs, and the Apply button is back.
  control(tree, 'confirm-no').props.onPress({})
  tree = await d.draw()
  assert.equal(s.calls.runs.length, before)
  assert.ok(control(tree, 'apply-0'))
  // Yes: "kestrel apply" runs with the proposal's arguments, its first line shows, and the change gets Undo.
  control(tree, 'apply-0').props.onPress({})
  const yes = control(await d.draw(), 'confirm-yes')
  assert.equal(yes.props.hotkey, 'y')
  yes.props.onPress({})
  await settle()
  assert.deepEqual(s.calls.runs.at(-1).argv.slice(2), ['apply', 'effort-default', '--level', 'medium'])
  tree = await d.draw()
  assert.ok(words(tree).includes('Set "effortLevel" to medium in Claude Code\'s settings.'))
  assert.equal(control(tree, 'undo-0').props.label, 'Undo effort-default')
  // Undo of an applied change runs "kestrel undo".
  control(tree, 'undo-2').props.onPress({})
  await settle()
  assert.deepEqual(s.calls.runs.at(-1).argv.slice(2), ['undo', 'subagent-cache-1h'])
  tree = await d.draw()
  assert.ok(words(tree).includes('subagent-cache-1h is taken back. Claude Code\'s settings are as they were before it.'))
  assert.equal(control(tree, 'apply-2').props.label, 'Apply subagent-cache-1h')
  // "Read again" reads the tab again.
  control(tree, 'read-again').props.onPress({})
  await settle()
  assert.deepEqual(s.args().slice(-3), ['summary --json', 'advise --json', 'accounts --json'])
})

test('a run that fails shows one plain line in the pane, and a missing "kestrel accounts" is no failure', async () => {
  machine()
  // The command ends with an error.
  let s = standIn({ answer: () => ({ exitCode: 1, stdout: '', stderr: 'kestrel: The folder of the logs cannot be read.\n    at somewhere\n' }) })
  let d = driver(await loadMod(), s)
  await d.command('kestrel:open')
  await settle()
  let tree = await d.draw()
  const fail = elements(tree).find((n) => n.type === 'Text' && n.props.color === 'error')
  assert.deepEqual(fail.children, ['The folder of the logs cannot be read.'])
  assert.equal(words(tree).filter((w) => w.includes('cannot be read')).length, 1)

  // The program cannot start at all.
  s = standIn({ answer: () => { throw new Error('spawn node ENOENT') } })
  d = driver(await loadMod(), s)
  await d.command('kestrel:settings')
  await settle()
  assert.ok(words(await d.draw()).includes('Kestrel could not run: spawn node ENOENT'))

  // An answer that is not JSON, and an exit code without a word.
  s = standIn({ answer: (args) => (args[0] === 'top' ? ok('not json') : { exitCode: 3, stdout: '', stderr: '' }) })
  d = driver(await loadMod(), s)
  await d.command('kestrel:open')
  await settle()
  assert.ok(words(await d.draw()).includes('Kestrel gave an answer that could not be read.'))
  control(await d.draw(), 'tab-security').props.onPress({})
  await settle()
  assert.ok(words(await d.draw()).includes('Kestrel ended with exit code 3.'))

  // A wrong value from a press: the sentence of "kestrel settings set" is the line.
  s = standIn({ answer: realAnswer })
  d = driver(await loadMod(), s)
  writeJson(join(process.env.KESTREL_HOME, 'config.json'), { hud: { lines: ['plan'] } })
  await d.command('kestrel:settings')
  await settle()
  control(await d.draw(), 'setting-hud.lines.plan').props.onPress({})
  await settle()
  assert.ok(words(await d.draw()).includes('At least one line of the status line stays on. For one line, use: kestrel settings set hud.layout one'))

  // This version has no "kestrel accounts": the real command says it does not know it, and the tab shows no failure.
  // Its summary does not split the dollars by how they are paid either: the tab gives the dollars alone.
  const older = { ...SUMMARY, period: { ...SUMMARY.period, paid: undefined }, today: { ...SUMMARY.today, paid: undefined } }
  s = standIn({ answer: (args) => (args[0] === 'accounts' || args[0] === 'top' ? realAnswer(args) : args[0] === 'summary' ? ok(older) : ok(ADVISE)) })
  d = driver(await loadMod(), s)
  await d.command('kestrel:open')
  await settle()
  control(await d.draw(), 'tab-spend').props.onPress({})
  await settle()
  tree = await d.draw()
  assert.equal(elements(tree).filter((n) => n.props.color === 'error').length, 0)
  assert.ok(!words(tree).includes('Per account'))
  assert.ok(words(tree).includes('Today: 12M tokens, $45.67, 120 model calls'))
})

test('where nothing draws a pane, the commands hand on to their command files, which print the same as text', async () => {
  machine()
  const s = standIn({ answer: () => assert.fail('nothing runs'), placed: false })
  const d = driver(await loadMod(), s)
  assert.deepEqual(await d.command('kestrel:settings'), { text: 'the command file ran' })
  assert.deepEqual(await d.command('kestrel:open'), { text: 'the command file ran' })
  assert.deepEqual(d.passedOn, ['kestrel:settings', 'kestrel:open'])
  // The pane that waits undrawn is closed again, and nothing reads on a timer.
  assert.deepEqual(s.calls.close, [{ id: 'kestrel' }, { id: 'kestrel' }])
  assert.equal(s.calls.timers.length, 0)
  assert.equal(s.calls.runs.length, 0)
  // The command files print text without a terminal: the settings with the commands that change
  // them, and the sessions without the names of tasks.
  const m = machine()
  oneSession(m, Date.now())
  const settings = run(m, ['settings'])
  assert.equal(settings.status, 0)
  assert.match(settings.stdout, /kestrel settings set security\.set healthcare/)
  const open = run(m, ['top', '--once', '--no-names'])
  assert.equal(open.status, 0)
  assert.match(open.stdout, /^Kestrel · 1 session on this computer/)
  assert.ok(!open.stdout.includes(MARKER))
})

test('each tab draws a tree the terminal, the desktop app and VS Code take', async () => {
  const m = machine()
  oneSession(m, Date.now())
  const s = standIn({ answer: (args) => ({ 'summary --json': ok(SUMMARY), 'advise --json': ok(ADVISE), 'accounts --json': ok(ACCOUNTS) })[args.join(' ')] ?? realAnswer(args) })
  const d = driver(await loadMod(), s)
  await d.command('kestrel:open')
  await settle()
  for (const tab of ['now', 'spend', 'settings', 'security']) {
    control(await d.draw(), `tab-${tab}`).props.onPress({})
    await settle()
    for (const surface of ['terminal', 'desktop', 'vscode']) {
      const tree = await d.draw(surface)
      assert.equal(tree.type, 'Box')
      // The row of tabs comes first, and the tree is not deeper than Claude Code draws.
      assert.equal(tree.children[0].children.length, 4)
      const depth = (node) => 1 + Math.max(0, ...node.children.filter((c) => typeof c === 'object').map(depth))
      assert.ok(depth(tree) < 32)
      assert.ok(elements(tree).length < 20000)
    }
  }
  assert.ok(existsSync(join(ROOT, 'hooks', 'pane.mjs')))
})
