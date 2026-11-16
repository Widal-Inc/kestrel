// Tests for the status line in lines and the command "kestrel hud". With made-up input, session
// files, logs and today.json. Run: node --test
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'kestrel-hud-test-'))
// The home folder too: the status line can start the command, and nothing of it may reach the real one.
process.env.HOME = join(dir, 'person')
process.env.KESTREL_HOME = join(dir, 'home')
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
process.env.CODEX_HOME = join(dir, 'codex')
// Cowork's folder too: without this a test would read the real Cowork logs of whoever runs it.
process.env.KESTREL_COWORK_DIR = join(dir, 'cowork')
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })

const { saveConfig, statusLine } = await import('../src/claude-code.mjs')
const { bar, hudConfig, hudLines, hudPreview } = await import('../src/hud.mjs')
const { localDay, writeToday } = await import('../src/today-file.mjs')

// Each test gets its own empty folder for this tool's files, so that no test sees another's.
let homes = 0
const freshHome = () => {
  process.env.KESTREL_HOME = join(dir, `home-${++homes}`)
  starts.length = 0
}

const NOW = Date.parse('2026-11-14T12:00:00')
const MIN = 60e3
const HOUR = 3600e3
const DAY = 86400e3
/** A time as Claude Code gives it: in seconds. */
const sec = (ms) => Math.round(ms / 1000)
const iso = (ms) => new Date(ms).toISOString()

// The starts of "kestrel refresh-today" that the status lines of a test made, each as the
// arguments of the spawn. No test starts the real command.
const starts = []
const spawner = (...args) => {
  starts.push(args)
  return { unref() {} }
}

/**
 * The status line without colours, with an empty environment and without a notification. The
 * layout comes from the settings: the lines, unless a test sets another.
 */
const show = (input, now = NOW, opts = {}) => statusLine(input, now, { env: {}, color: false, notify: () => {}, spawn: spawner, ...opts })
/** What the status line keeps about one session. */
const kept = (id = 'one') => JSON.parse(readFileSync(join(process.env.KESTREL_HOME, 'sessions', `${id}.json`), 'utf8'))
/** Writes the file of another session, as its status line would have kept it. */
const otherSession = (id, fields) => {
  mkdirSync(join(process.env.KESTREL_HOME, 'sessions'), { recursive: true })
  writeFileSync(join(process.env.KESTREL_HOME, 'sessions', `${id}.json`), JSON.stringify({ day: localDay(NOW), cost: 1, dayStart: 0, ...fields }))
}

let repos = 0
/** A made-up git repository whose branch is `branch`, as a folder named `name`. Gives its path. */
const repo = (branch, name = `repo-${++repos}`) => {
  const folder = join(dir, 'repos', `${repos}`, name)
  mkdirSync(join(folder, '.git'), { recursive: true })
  writeFileSync(join(folder, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`)
  return folder
}

/**
 * What Claude Code gives the status line: a subscriber's session of 4 hours with 527,119 tokens of
 * context in a window of 1M, a cache that lasts 52 more minutes, and a week that is 36% used with
 * 44% of its time gone. A test changes the fields it is about.
 */
const session = (extra = {}) => ({
  session_id: 'one', cwd: '/work/repo',
  model: { id: 'claude-fable-5-2', display_name: 'Fable 5.2' },
  effort: { level: 'high' },
  cost: { total_cost_usd: 12.4, total_duration_ms: 4 * HOUR, total_api_duration_ms: 1000 },
  context_window: {
    context_window_size: 1000000, used_percentage: 53,
    current_usage: { input_tokens: 2, output_tokens: 5502, cache_creation_input_tokens: 14608, cache_read_input_tokens: 512509 },
  },
  prompt_cache: { warm: true, ttl: '1h', expires_at: sec(NOW + 52 * MIN), recache_tokens_if_cold: 527119 },
  rate_limits: { seven_day: { used_percentage: 36, resets_at: sec(NOW + 0.56 * 7 * DAY) } },
  ...extra,
})

let logs = 0
/** Writes a made-up session log and gives its path. A line is an object, or text that is written as it is. */
const logOf = (lines, file = join(dir, `log-${++logs}.jsonl`)) => {
  writeFileSync(file, `${lines.flat().map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`)
  return file
}
let uses = 0
/**
 * The lines that Claude Code writes for one model call that used one tool: the call, and the
 * result of the tool unless `done` is false. `at` is the time of the call. `result` adds fields
 * to the line of the result, and `text` is the text of the result.
 */
const toolUse = (name, input, { at = NOW - 2 * MIN, done = true, result = {}, text = 'done', failed = false, side = false } = {}) => {
  const id = `toolu_${++uses}`
  const lines = [{
    type: 'assistant', timestamp: iso(at), ...(side ? { isSidechain: true } : {}),
    message: { id: `msg_${uses}`, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  }]
  if (done) lines.push({ type: 'user', timestamp: iso(at + 1000), ...result, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(failed ? { is_error: true } : {}) }] } })
  return lines
}
/** A task list of "TodoWrite": each task as [content, status, activeForm]. */
const todos = (tasks, more) => toolUse('TodoWrite', { todos: tasks.map(([content, status, activeForm]) => ({ content, status, ...(activeForm ? { activeForm } : {}) })) }, more)
/** A new task of "TaskCreate", whose result gives the id as Claude Code gives it. */
const taskNew = (id, subject, activeForm, more = {}) => toolUse('TaskCreate', { subject, description: 'what to do', ...(activeForm ? { activeForm } : {}) }, { result: { toolUseResult: { task: { id, subject } } }, text: `Task #${id} created successfully: ${subject}`, ...more })
const taskSet = (taskId, fields) => toolUse('TaskUpdate', { taskId, ...fields })
/** An agent that was started `minutes` ago and runs still, unless `done`. */
const agent = (type, description, minutes, more = {}) => toolUse('Agent', { ...(type ? { subagent_type: type } : {}), description, prompt: 'what to do' }, { at: NOW - minutes * MIN, done: false, ...more })

/** The lines that the status line shows for this input, with only the lines that `lines` names. */
function onlyLines(lines, input, more = {}) {
  saveConfig({ ...more, hud: { lines, ...more.hud } })
  return show(input)
}
/** The work line of a session whose log has these lines. */
const workOf = (lines, names = true) => {
  freshHome()
  return onlyLines(['work'], session({ transcript_path: logOf(lines) }), { hud: { names } })
}

test('the four lines show the session, the plan, the work and the hints, each with numbers that can be checked', () => {
  freshHome()
  const folder = repo('main', 'my-app')
  writeToday({ day: localDay(NOW), at: NOW - MIN, tokens: 41e6, cacheRead: 39.4e6 })
  otherSession('two', { at: NOW - 30e3, callAt: NOW - 5 * MIN, project: 'work/other' })
  const log = logOf([todos([['Read the code', 'completed'], ['Write the code', 'in_progress', 'Writing the code'], ['Test it', 'pending']]), agent('Explore', 'find the parser', 3)])
  const shown = show(session({ cwd: folder, transcript_path: log, prompt_cache: { warm: true, ttl: '1h', expires_at: sec(NOW + 52 * MIN), last_miss_at: sec(NOW - MIN), last_miss_cause: { causes: ['model_changed'] } } }))
  assert.equal(shown, [
    '[Fable 5.2 · high] │ my-app git:(main) │ context █████░░░░░ 53% of 1M │ cache warm, 52 min left │ last cache loss: the model changed',
    'week ███▌░░░░░░ 36% │ today 41M tokens, 96% from the cache',
    '▸ Writing the code (1/3) │ Explore: find the parser (3 min) │ other sessions: 1 waits for you',
  ].join('\n'))
  // The session's file gets the branch and its ticket. This branch names no ticket.
  assert.deepEqual([kept().branch, kept().ticket], ['main', undefined])
})

test('the line "session": the model, the effort level, the folder and its branch, and the context in every form', () => {
  freshHome()
  const session1 = (extra) => onlyLines(['session'], session({ prompt_cache: undefined, ...extra }))
  assert.equal(session1(), '[Fable 5.2 · high] │ repo │ context █████░░░░░ 53% of 1M')
  // Without the effort level, without the display name, and without a model.
  assert.equal(session1({ effort: undefined }), '[Fable 5.2] │ repo │ context █████░░░░░ 53% of 1M')
  assert.equal(session1({ model: { id: 'claude-fable-5-2' } }), '[claude-fable-5-2 · high] │ repo │ context █████░░░░░ 53% of 1M')
  assert.equal(session1({ model: undefined, effort: undefined }), 'repo │ context █████░░░░░ 53% of 1M')
  // A folder in a repository shows its branch. A detached HEAD has none.
  assert.equal(session1({ cwd: repo('user/abc-321-lines') }), `[Fable 5.2 · high] │ repo-${repos} git:(user/abc-321-lines) │ context █████░░░░░ 53% of 1M`)
  assert.deepEqual([kept().branch, kept().ticket], ['user/abc-321-lines', 'ABC-321'])
  const detached = repo('x')
  writeFileSync(join(detached, '.git', 'HEAD'), 'a1b2c3d4e5f6\n')
  assert.equal(session1({ cwd: detached }), `[Fable 5.2 · high] │ repo-${repos} │ context █████░░░░░ 53% of 1M`)
  assert.deepEqual([kept().branch, kept().ticket], [undefined, undefined])
  // The window of 200k, a window without a percent (it is worked out), a percent without a
  // window, and neither: then the tokens.
  const usage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 150000 }
  assert.equal(session1({ context_window: { context_window_size: 200000, used_percentage: 75, current_usage: usage } }), '[Fable 5.2 · high] │ repo │ context ███████▌░░ 75% of 200k')
  assert.equal(session1({ context_window: { context_window_size: 200000, current_usage: usage } }), '[Fable 5.2 · high] │ repo │ context ███████▌░░ 75% of 200k')
  assert.equal(session1({ context_window: { used_percentage: 75, current_usage: usage } }), '[Fable 5.2 · high] │ repo │ context ███████▌░░ 75%')
  assert.equal(session1({ context_window: { current_usage: usage } }), '[Fable 5.2 · high] │ repo │ context 150k')
  // Nothing to show: the line is left out.
  assert.equal(onlyLines(['session'], { session_id: 'one' }), '')
})

test('the bars: 10 cells, a half cell from 5 percent, all empty at 0 and all full from 100', () => {
  assert.equal(bar(0), '░░░░░░░░░░')
  assert.equal(bar(4), '░░░░░░░░░░')
  assert.equal(bar(5), '▌░░░░░░░░░')
  assert.equal(bar(6), '▌░░░░░░░░░')
  assert.equal(bar(42), '████░░░░░░')
  assert.equal(bar(85), '████████▌░')
  assert.equal(bar(95), '█████████▌')
  assert.equal(bar(99), '█████████▌')
  assert.equal(bar(100), '██████████')
  assert.equal(bar(130), '██████████')
  // A value that is not a number draws an empty bar.
  assert.equal(bar(undefined), '░░░░░░░░░░')
  // On the line, the context and the limits have bars, and none with "bars: false".
  freshHome()
  const input = session({ rate_limits: { seven_day: { used_percentage: 95, resets_at: sec(NOW + 0.01 * 7 * DAY) }, five_hour: { used_percentage: 4, resets_at: sec(NOW + 4 * HOUR) } }, prompt_cache: undefined })
  assert.equal(onlyLines(['session', 'plan'], input), '[Fable 5.2 · high] │ repo │ context █████░░░░░ 53% of 1M\nweek █████████▌ 95% │ 5h ░░░░░░░░░░ 4%')
  assert.equal(onlyLines(['session', 'plan'], input, { hud: { bars: false } }), '[Fable 5.2 · high] │ repo │ context 53% of 1M\nweek 95% │ 5h 4%')
})

test('the line "plan": each limit with its bar and the words of the one line, or the dollars by the token', () => {
  freshHome()
  const plan = (extra, more) => onlyLines(['plan'], session(extra), more)
  // The week is on pace to be full early. The 5 hour limit is not. The week comes first.
  const limits = { seven_day: { used_percentage: 85, resets_at: sec(NOW + 2.9 * DAY) }, five_hour: { used_percentage: 33, resets_at: sec(NOW + 2 * HOUR) } }
  assert.equal(plan({ rate_limits: limits }), 'week ████████▌░ 85%, full 2.2 days early │ 5h ███░░░░░░░ 33%')
  // The colours of the one line: the week is red, because it would be full within a day.
  const coloured = statusLine(session({ rate_limits: limits }), NOW, { env: {}, color: true, notify: () => {}, spawn: spawner })
  assert.equal(coloured, '\x1b[31mweek ████████▌░ 85%, full 2.2 days early\x1b[0m │ \x1b[32m5h ███░░░░░░░ 33%\x1b[0m')
  // A reading of 8 minutes ago says so.
  freshHome()
  statusLine(session({ session_id: 'early', rate_limits: limits }), NOW - 8 * MIN, { env: {}, color: false, notify: () => {}, spawn: spawner, layout: 'one' })
  assert.equal(plan({ rate_limits: undefined }, { plan: 'subscription' }), 'week ████████▌░ 85% (read 8 min ago), full 2.2 days early │ 5h ███░░░░░░░ 33% (read 8 min ago)')
  // Before Claude Code gave a reading, and a limit the person set in dollars.
  freshHome()
  assert.equal(plan({ rate_limits: undefined }, { plan: 'subscription' }), 'plan limits not reported yet')
  assert.equal(plan({ rate_limits: limits }, { limits: { session: 50, action: 'warn' } }), 'week ████████▌░ 85%, full 2.2 days early │ 5h ███░░░░░░░ 33% │ limit $50 per session at list prices, $12.40 so far')
  // By the token: the dollars of the session and of today, as on the one line.
  freshHome()
  assert.equal(plan({ rate_limits: undefined }, { plan: 'usage' }), '$12.40 session, $3.10 per hour │ today $12.40')
  assert.equal(plan({ rate_limits: undefined }, { plan: 'usage', limits: { session: 10, day: 200, action: 'ask' } }), '$12.40 session, $3.10 per hour │ today $12.40 of $200 │ limit $10')
})

test('the line "hint": the effort hint and the compaction hint with their colours, and left out when there is none', () => {
  freshHome()
  // Thirty calls that only read, at effort high: the hint to go one level down.
  const reads = Array.from({ length: 30 }, () => toolUse('Read', { file_path: '/x' }))
  const input = session({ model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, transcript_path: logOf(reads) })
  assert.equal(onlyLines(['hint'], input), 'mostly simple work at high effort: /effort medium keeps the cache')
  // At a break, with a context that grew by 150,000 tokens: both hints.
  freshHome()
  const grown = (ctx, api) => session({ model: { id: 'claude-opus-5-5' }, transcript_path: logOf(reads), cost: { total_cost_usd: 1, total_duration_ms: HOUR, total_api_duration_ms: api }, context_window: { context_window_size: 1e6, current_usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: ctx } } })
  saveConfig({ hud: { lines: ['hint'] } })
  show(grown(100000, 1000), NOW - 3 * MIN)
  show(grown(420000, 2000), NOW - 2 * MIN)
  assert.equal(show(grown(420000, 2000)), 'mostly simple work at high effort: /effort medium keeps the cache │ context 420k: a good moment to /compact')
  // The hint to go up is yellow, and so is the hint that the automatic compaction is near.
  freshHome()
  const failing = Array.from({ length: 30 }, () => toolUse('Edit', { file_path: '/x' }, { failed: true }))
  saveConfig({ hud: { lines: ['hint'] } })
  const up = statusLine(session({ model: { id: 'claude-opus-5-5' }, effort: { level: 'low' }, transcript_path: logOf(failing) }), NOW, { env: {}, color: true, notify: () => {}, spawn: spawner })
  assert.equal(up, '\x1b[33mmany failed rounds at low effort: /effort medium keeps the cache\x1b[0m')
  // No hint: the line is left out.
  freshHome()
  assert.equal(onlyLines(['hint'], session()), '')
})

test('the task list from TodoWrite: the task in progress with its activeForm, all done, an empty list, and names off', () => {
  const list = (statuses, form = 'Running the tests') => todos([['Read the code', statuses[0]], ['Write the code', statuses[1]], ['Run the tests', statuses[2], form], ['Fix what fails', statuses[3]], ['Push', statuses[4]]])
  assert.equal(workOf([list(['completed', 'completed', 'in_progress', 'pending', 'pending'])]), '▸ Running the tests (2/5)')
  // Without an activeForm: what the task says.
  assert.equal(workOf([list(['completed', 'completed', 'in_progress', 'pending', 'pending'], null)]), '▸ Run the tests (2/5)')
  // No task in progress: the counts. All done: "tasks done".
  assert.equal(workOf([list(['completed', 'completed', 'pending', 'pending', 'pending'])]), 'tasks 2/5')
  assert.equal(workOf([list(['completed', 'completed', 'completed', 'completed', 'completed'])]), 'tasks done (5/5)')
  // The newest list counts. An empty list has nothing to show, and the line is left out.
  assert.equal(workOf([list(['in_progress', 'pending', 'pending', 'pending', 'pending']), list(['completed', 'completed', 'completed', 'in_progress', 'pending'], 'x')]), '▸ Fix what fails (3/5)')
  assert.equal(workOf([list(['in_progress', 'pending', 'pending', 'pending', 'pending']), todos([])]), '')
  // A compaction does not end the list. A list that a subagent wrote is not the session's.
  assert.equal(workOf([list(['completed', 'completed', 'in_progress', 'pending', 'pending']), { type: 'system', subtype: 'compact_boundary', timestamp: iso(NOW - MIN) }]), '▸ Running the tests (2/5)')
  assert.equal(workOf([list(['completed', 'completed', 'in_progress', 'pending', 'pending']), todos([['a task of a subagent', 'in_progress']], { side: true })]), '▸ Running the tests (2/5)')
  // With names off: the counts only.
  assert.equal(workOf([list(['completed', 'completed', 'in_progress', 'pending', 'pending'])], false), 'tasks 2/5')
  assert.equal(workOf([list(['completed', 'completed', 'completed', 'completed', 'completed'])], false), 'tasks done (5/5)')
  // A long name is cut, and a name keeps no control character.
  assert.equal(workOf([todos([['x', 'in_progress', `${'a'.repeat(70)}`]])]), `▸ ${'a'.repeat(57)}... (0/1)`)
  assert.equal(workOf([todos([['x', 'in_progress', 'red\x1b[31m text\nnext']])]), '▸ red[31m textnext (0/1)')
})

test('the task list from TaskCreate and TaskUpdate: the id from the result, an update of an older task, a deleted one, all done, and names off', () => {
  const three = [taskNew('1', 'Read the code'), taskNew('2', 'Write the code', 'Writing the code'), taskNew('3', 'Test it')]
  assert.equal(workOf([...three, taskSet('1', { status: 'completed' }), taskSet('2', { status: 'in_progress' })]), '▸ Writing the code (1/3)')
  // A result that gives the id in its text only.
  const byText = toolUse('TaskCreate', { subject: 'Write the code', activeForm: 'Writing the code' }, { text: 'Task #7 created successfully: Write the code' })
  assert.equal(workOf([byText, taskSet('7', { status: 'in_progress' })]), '▸ Writing the code (0/1)')
  // A task from before this piece of the log is known from its update. A deleted task no longer counts.
  assert.equal(workOf([...three, taskSet('9', { status: 'in_progress', subject: 'An older task' }), taskSet('3', { status: 'deleted' })]), '▸ An older task (0/3)')
  // An update can change the words of a task. A task that failed to be made does not count.
  assert.equal(workOf([...three, taskSet('3', { status: 'in_progress', activeForm: 'Testing it' }), taskNew('4', 'Never made', undefined, { failed: true })]), '▸ Testing it (0/3)')
  // All done, and with names off.
  const done = [...three, ...['1', '2', '3'].map((id) => taskSet(id, { status: 'completed' }))]
  assert.equal(workOf(done), 'tasks done (3/3)')
  assert.equal(workOf([...three, taskSet('2', { status: 'in_progress' })], false), 'tasks 0/3')
  // Of the two kinds of task list, the one used last counts.
  assert.equal(workOf([todos([['Old list', 'in_progress']]), ...three, taskSet('1', { status: 'in_progress' })]), '▸ Read the code (0/3)')
  assert.equal(workOf([...three, todos([['New list', 'in_progress', 'Making the new list']])]), '▸ Making the new list (0/1)')
})

test('the agents that run: one, two, three, one that has its result, an agent without a kind, and names off', () => {
  assert.equal(workOf([agent('Explore', 'find the parser', 3)]), 'Explore: find the parser (3 min)')
  assert.equal(workOf([agent('Explore', 'find the parser', 3), agent('general-purpose', 'write the tests', 1)]), 'Explore: find the parser (3 min), general-purpose: write the tests (1 min)')
  const three = [agent('Explore', 'find the parser', 3), agent('general-purpose', 'write the tests', 1), agent('Plan', 'plan the change', 0)]
  assert.equal(workOf(three), 'Explore: find the parser (3 min), general-purpose: write the tests (1 min), +1 more')
  // An agent that has its result has ended. An agent without a kind is "agent". The old tool name "Task" counts too.
  assert.equal(workOf([agent('Explore', 'find the parser', 3, { done: true }), agent(undefined, 'look around', 2)]), 'agent: look around (2 min)')
  assert.equal(workOf([toolUse('Task', { subagent_type: 'Explore', description: 'the old name' }, { at: NOW - 5 * MIN, done: false })]), 'Explore: the old name (5 min)')
  // With names off: how many.
  assert.equal(workOf([agent('Explore', 'find the parser', 3)], false), '1 agent running')
  assert.equal(workOf(three, false), '3 agents running')
  // The task list comes first, then the agents.
  assert.equal(workOf([todos([['x', 'in_progress', 'Doing x']]), agent('Explore', 'find the parser', 3)]), '▸ Doing x (0/1) │ Explore: find the parser (3 min)')
})

test('other sessions: working, waiting for you, one that is not open, and the warning when another open session has the same ticket', () => {
  freshHome()
  const folder = repo('user/abc-321-the-lines')
  otherSession('working', { at: NOW - 30e3, callAt: NOW - 20e3, project: 'work/a', ticket: 'ABC-321' })
  otherSession('waits', { at: NOW - 30e3, callAt: NOW - 5 * MIN, project: 'work/b' })
  otherSession('waits-too', { at: NOW - 90e3, project: 'work/c' })
  // Not open: the status line last ran 2 minutes ago. Its ticket does not count either.
  otherSession('closed', { at: NOW - 2 * MIN, callAt: NOW - 2 * MIN, project: 'work/d', ticket: 'ABC-321' })
  // A file that cannot be read, and one that is not of a session.
  writeFileSync(join(process.env.KESTREL_HOME, 'sessions', 'broken.json'), '{')
  writeFileSync(join(process.env.KESTREL_HOME, 'sessions', 'notes.txt'), 'x')
  const input = session({ cwd: folder })
  assert.equal(onlyLines(['work'], input), 'other sessions: 1 working, 2 wait for you │ ABC-321 is also open in work/a')
  // Both parts are yellow while one waits for you.
  const coloured = statusLine(input, NOW, { env: {}, color: true, notify: () => {}, spawn: spawner })
  assert.equal(coloured, '\x1b[33mother sessions: 1 working, 2 wait for you\x1b[0m │ \x1b[33mABC-321 is also open in work/a\x1b[0m')
  // Only working sessions: no colour. This session itself is never counted.
  freshHome()
  otherSession('working', { at: NOW - 30e3, callAt: NOW - 20e3, project: 'work/a' })
  otherSession('one', { at: NOW - 30e3, callAt: NOW - 5 * MIN })
  saveConfig({ hud: { lines: ['work'] } })
  assert.equal(statusLine(session(), NOW, { env: {}, color: true, notify: () => {}, spawn: spawner }), 'other sessions: 1 working\x1b[0m')
  // Many open sessions with the same ticket: one folder by name, and how many more. A folder counts once.
  freshHome()
  for (const [id, project] of [['a', 'work/a'], ['b', 'work/b'], ['b2', 'work/b'], ['c', 'work/c']]) otherSession(id, { at: NOW - 30e3, callAt: NOW - 20e3, project, ticket: 'ABC-321' })
  otherSession('no-folder', { at: NOW - 30e3, callAt: NOW - 20e3, ticket: 'ABC-321' })
  assert.equal(onlyLines(['work'], input), 'other sessions: 5 working │ ABC-321 is also open in work/a and 3 more')
  freshHome()
  otherSession('no-folder', { at: NOW - 30e3, callAt: NOW - 20e3, ticket: 'ABC-321' })
  assert.equal(onlyLines(['work'], input), 'other sessions: 1 working │ ABC-321 is also open in another session')
  // Another ticket is no overlap, and neither is a session without a ticket when this one has none.
  freshHome()
  otherSession('other-ticket', { at: NOW - 30e3, callAt: NOW - 20e3, project: 'work/x', ticket: 'ABC-322' })
  assert.equal(onlyLines(['work'], input), 'other sessions: 1 working')
  freshHome()
  otherSession('with-ticket', { at: NOW - 30e3, callAt: NOW - 20e3, project: 'work/x', ticket: 'ABC-321' })
  assert.equal(onlyLines(['work'], session({ cwd: repo('main') })), 'other sessions: 1 working')
  // No other open session: nothing to show, and the work line is left out.
  freshHome()
  otherSession('closed', { at: NOW - 10 * MIN })
  assert.equal(onlyLines(['work'], session()), '')
})

test('today\'s part: there, old (shown, and a refresh starts), missing (a refresh starts once in 2 minutes), and from another day', () => {
  freshHome()
  // A subscriber before the first reading of the limits: the line has one part of its own.
  const plan = (now = NOW) => {
    saveConfig({ plan: 'subscription', hud: { lines: ['plan'] } })
    return show(session({ rate_limits: undefined }), now)
  }
  // Missing: the part is left out, and the refresh starts in the background.
  assert.equal(plan(), 'plan limits not reported yet')
  assert.equal(starts.length, 1)
  const [[program, args, options]] = starts
  assert.deepEqual([program, args, options], [process.execPath, [fileURLToPath(new URL('../cli/kestrel.mjs', import.meta.url)), 'refresh-today'], { detached: true, stdio: 'ignore' }])
  assert.equal(JSON.parse(readFileSync(join(process.env.KESTREL_HOME, 'today.start'), 'utf8')), NOW)
  // Not again within 2 minutes, again after them.
  plan(NOW + MIN)
  plan(NOW + 2 * MIN - 1)
  assert.equal(starts.length, 1)
  plan(NOW + 2 * MIN)
  assert.equal(starts.length, 2)
  // There and fresh: the part, and no start.
  freshHome()
  writeToday({ day: localDay(NOW), at: NOW - MIN, tokens: 41e6, cacheRead: 39.4e6 })
  assert.equal(plan(), 'plan limits not reported yet │ today 41M tokens, 96% from the cache')
  assert.equal(starts.length, 0)
  // Older than 5 minutes: still shown, and a refresh starts.
  writeToday({ day: localDay(NOW), at: NOW - 5 * MIN, tokens: 1234567, cacheRead: 0 })
  assert.equal(plan(), 'plan limits not reported yet │ today 1.2M tokens, 0% from the cache')
  assert.equal(starts.length, 1)
  // From another day: left out, and a refresh starts.
  freshHome()
  writeToday({ day: localDay(NOW - DAY), at: NOW - 10 * MIN, tokens: 41e6, cacheRead: 39.4e6 })
  assert.equal(plan(), 'plan limits not reported yet')
  assert.equal(starts.length, 1)
  // No tokens yet today, and a file without numbers.
  freshHome()
  writeToday({ day: localDay(NOW), at: NOW, tokens: 0, cacheRead: 0 })
  assert.equal(plan(), 'plan limits not reported yet │ today 0 tokens')
  writeToday({ day: localDay(NOW), at: NOW, tokens: 'many' })
  assert.equal(plan(), 'plan limits not reported yet')
  // A spawn that fails does not break the line, and is not tried again on every run.
  freshHome()
  saveConfig({ plan: 'subscription', hud: { lines: ['plan'] } })
  let tries = 0
  const failing = () => {
    tries += 1
    throw new Error('no such program')
  }
  assert.equal(show(session({ rate_limits: undefined }), NOW, { spawn: failing }), 'plan limits not reported yet')
  assert.equal(show(session({ rate_limits: undefined }), NOW + 30e3, { spawn: failing }), 'plan limits not reported yet')
  assert.equal(tries, 1)
  // Without the plan line, and in the one line, nothing starts.
  freshHome()
  saveConfig({ hud: { lines: ['session', 'work', 'hint'] } })
  show(session())
  saveConfig({ hud: { layout: 'one' } })
  show(session())
  assert.equal(starts.length, 0)
})

test('the one line layout gives exactly the line of before, from the settings or from the caller', () => {
  freshHome()
  writeToday({ day: localDay(NOW), at: NOW - MIN, tokens: 41e6, cacheRead: 39.4e6 })
  otherSession('two', { at: NOW - 30e3, callAt: NOW - 5 * MIN, project: 'work/other', cost: 0 })
  const log = logOf([todos([['x', 'in_progress', 'Doing x']]), agent('Explore', 'find the parser', 3)])
  const limits = { five_hour: { used_percentage: 42, resets_at: sec(NOW + 2 * HOUR) }, seven_day: { used_percentage: 36, resets_at: sec(NOW + 0.56 * 7 * DAY) } }
  const input = session({ cwd: repo('user/abc-321-x'), transcript_path: log, rate_limits: limits })
  saveConfig({ hud: { layout: 'one', bars: true, names: true } })
  const expected = '5 hour limit 42% used, 60% of its time gone | week 36% used, 44% of the week gone | cache warm, 52 min left | context 527k (53%) | effort high'
  assert.equal(show(input), expected)
  saveConfig({})
  assert.equal(show(input, NOW, { layout: 'one' }), expected)
  // By the token, with limits in dollars: the line of before too.
  saveConfig({ plan: 'usage', limits: { session: 10, day: 200, action: 'ask' }, hud: { layout: 'one' } })
  assert.equal(show(input), '$12.40 session, $3.10 per hour | cache warm, 52 min left, then $8.43 | context 527k (53%) | effort high | today $12.40 of $200 | limit $10')
  // A layout that is not one of the two is the default, the lines.
  saveConfig({ hud: { layout: 'two' } })
  assert.equal(show(input).split('\n').length, 3)
  assert.equal(starts.length, 0)
})

test('colours: each part has the colour of before, each line ends with a reset, and without colours the bars stay', () => {
  freshHome()
  const input = session({ cwd: repo('main'), rate_limits: { seven_day: { used_percentage: 92, resets_at: sec(NOW + 3 * DAY) } } })
  saveConfig({ hud: { lines: ['session', 'plan'] } })
  const coloured = statusLine(input, NOW, { env: {}, notify: () => {}, spawn: spawner })
  assert.equal(coloured, [
    `[Fable 5.2 · high] │ repo-${repos} git:(main) │ context █████░░░░░ 53% of 1M │ \x1b[32mcache warm, 52 min left\x1b[0m`,
    '\x1b[31mweek █████████░ 92%, full 2.7 days early\x1b[0m',
  ].join('\n'))
  // A line whose last part has no colour gets a reset of its own.
  saveConfig({ hud: { lines: ['session'] } })
  assert.equal(statusLine(session({ rate_limits: input.rate_limits, prompt_cache: undefined }), NOW, { env: {}, notify: () => {}, spawn: spawner }), '[Fable 5.2 · high] │ repo │ context █████░░░░░ 53% of 1M\x1b[0m')
  // The context is yellow from 80% and red from 95%: the bar and the percent with it.
  const full = (pct) => statusLine(session({ rate_limits: input.rate_limits, prompt_cache: undefined, context_window: { context_window_size: 1e6, used_percentage: pct, current_usage: { input_tokens: pct * 1e4 } } }), NOW, { env: {}, notify: () => {}, spawn: spawner })
  assert.equal(full(80), '[Fable 5.2 · high] │ repo │ \x1b[33mcontext ████████░░ 80% of 1M\x1b[0m')
  assert.equal(full(96), '[Fable 5.2 · high] │ repo │ \x1b[31mcontext █████████▌ 96% of 1M\x1b[0m')
  // NO_COLOR and "color: false": no colour codes, and the bars stay.
  saveConfig({ hud: { lines: ['session', 'plan'] } })
  const plain = statusLine(input, NOW, { env: { NO_COLOR: '1' }, notify: () => {}, spawn: spawner })
  assert.equal(plain, coloured.replace(/\x1b\[\d+m/g, ''))
  assert.match(plain, /█████████░ 92%/)
  saveConfig({ color: false, hud: { lines: ['session', 'plan'] } })
  assert.equal(statusLine(input, NOW, { env: {}, notify: () => {}, spawn: spawner }), plain)
})

test('the settings of the lines: the defaults, and values set by hand that cannot be used', () => {
  const all = ['session', 'plan', 'work', 'hint']
  assert.deepEqual(hudConfig({}), { layout: 'lines', lines: all, bars: true, names: true })
  assert.deepEqual(hudConfig({ hud: { layout: 'one', lines: ['hint', 'plan'], bars: false, names: false } }), { layout: 'one', lines: ['hint', 'plan'], bars: false, names: false })
  // Only false turns bars and names off. A line that is not one of the four, and a second mention, are left out.
  assert.deepEqual(hudConfig({ hud: { bars: 'no', names: 0, lines: ['plan', 'other', 'plan', 7] } }), { layout: 'lines', lines: ['plan'], bars: true, names: true })
  for (const hud of [null, 'lines', [], { lines: [] }, { lines: 'plan' }, { layout: 1 }]) assert.deepEqual(hudConfig({ hud }), { layout: 'lines', lines: all, bars: true, names: true }, JSON.stringify(hud))
})

test('a line that fails is left out and the others are still shown, and broken files and logs do not break the lines', () => {
  const h = hudConfig({})
  const data = {
    session: () => {
      throw new Error('a line that fails')
    },
    plan: () => ({ money: [['$1.00 session']] }),
    work: () => undefined,
    hint: () => [['a hint']],
  }
  assert.equal(hudLines(data, h, false), '$1.00 session\na hint')
  freshHome()
  writeToday({ day: localDay(NOW), at: NOW, tokens: 41e6, cacheRead: 39.4e6 })
  // The work line reads the folder of the sessions. A file there that is a folder cannot be read.
  mkdirSync(join(process.env.KESTREL_HOME, 'sessions', 'odd.json'), { recursive: true })
  otherSession('two', { at: 'now', callAt: [] })
  assert.equal(onlyLines(['work', 'plan'], session()), 'week ███▌░░░░░░ 36% │ today 41M tokens, 96% from the cache')
  // A log that is missing, a folder or no text: no task list, and no error.
  for (const path of [join(dir, 'no-such.jsonl'), dir, 7]) assert.equal(onlyLines(['work'], session({ transcript_path: path })), '', String(path))
})

/** Every file below this tool's folder, as one text. */
const filesText = () => readdirSync(process.env.KESTREL_HOME, { recursive: true, withFileTypes: true })
  .filter((f) => f.isFile())
  .map((f) => readFileSync(join(f.parentPath ?? f.path, f.name), 'utf8'))
  .join('\n')

test('privacy: the names of tasks and agents, and the prompts, never reach a file of this tool', () => {
  freshHome()
  const MARK = 'zebramarker'
  const prompt = { type: 'user', timestamp: iso(NOW - 3 * MIN), message: { role: 'user', content: `a prompt about ${MARK}` } }
  const answer = { type: 'assistant', timestamp: iso(NOW - 3 * MIN), message: { id: 'msg_answer', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: `an answer about ${MARK}` }] } }
  const lines = [
    prompt, answer,
    todos([[`a task about ${MARK}`, 'in_progress', `working on ${MARK}`], ['another', 'pending']]),
    taskNew('1', `a subject about ${MARK}`, `doing ${MARK}`),
    taskSet('1', { status: 'in_progress', subject: `a new subject about ${MARK}` }),
    agent(`${MARK}-kind`, `look for ${MARK}`, 2),
    toolUse('Agent', { subagent_type: 'Explore', description: `done with ${MARK}`, prompt: MARK }),
  ]
  const input = session({ cwd: repo('user/abc-321-x'), transcript_path: logOf(lines) })
  // Names on: the line shows them on the screen. Several runs, with a hint look and a break in between.
  const shown = show(input, NOW - 2 * MIN)
  assert.match(shown, new RegExp(MARK))
  show({ ...input, cost: { ...input.cost, total_api_duration_ms: 2000 } }, NOW - MIN)
  show({ ...input, cost: { ...input.cost, total_api_duration_ms: 2000 } }, NOW)
  // Names off, and the one line.
  saveConfig({ hud: { names: false } })
  assert.doesNotMatch(show(input), new RegExp(MARK))
  saveConfig({ hud: { layout: 'one' } })
  assert.doesNotMatch(show(input), new RegExp(MARK))
  // No file below this tool's folder holds the word: not the session's file, not the settings.
  const all = filesText()
  assert.ok(all.includes('"ticket":"ABC-321"'), all)
  assert.doesNotMatch(all, new RegExp(MARK))
  assert.doesNotMatch(JSON.stringify(starts), new RegExp(MARK))
})

test('speed: one run with all four lines stays well under 100 ms, with a log of 100 MB and 30 session files', () => {
  freshHome()
  writeToday({ day: localDay(NOW), at: NOW - MIN, tokens: 41e6, cacheRead: 39.4e6 })
  for (let i = 0; i < 29; i++) otherSession(`other-${i}`, { at: NOW - (i % 4) * MIN, callAt: NOW - (i % 3) * MIN, project: `work/p${i}`, ticket: `ABC-${300 + (i % 5)}`, ctx: 400000, model: 'claude-opus-5-5' })
  // Only the end of the file is written: 800 calls that read, a task list and two agents, which
  // is more than 256 KB. The rest of the 100 MB is a hole that takes no room on the disk.
  const end = [...Array.from({ length: 800 }, () => toolUse('Read', { file_path: '/x/a-file' })), todos([['a', 'completed'], ['b', 'in_progress', 'Doing b']]), agent('Explore', 'look', 2), agent('Plan', 'plan', 1)]
  const tail = Buffer.from(`\n${end.flat().map((l) => JSON.stringify(l)).join('\n')}\n`)
  assert.ok(tail.length > 256 * 1024 && tail.length < 1024 * 1024, `the end has ${tail.length} bytes`)
  const file = join(dir, 'large.jsonl')
  const size = 100 * 1024 * 1024
  const fd = openSync(file, 'w')
  ftruncateSync(fd, size)
  writeSync(fd, tail, 0, tail.length, size - tail.length)
  closeSync(fd)
  const folder = repo('user/abc-302-speed')
  // Three sessions, each run for the first time. The fastest run counts, so that a busy machine does not fail the test.
  const took = ['first', 'second', 'third'].map((id) => {
    const input = session({ session_id: id, cwd: folder, model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, transcript_path: file })
    const start = performance.now()
    const shown = show(input)
    const ms = performance.now() - start
    assert.equal(shown.split('\n').length, 4, shown)
    assert.match(shown, /▸ Doing b \(1\/2\) │ Explore: look \(2 min\), Plan: plan \(1 min\) │ other sessions: /)
    return ms
  })
  const fastest = Math.min(...took)
  // The time is printed, so that it can be read in the output of the test.
  console.log(`# one status line run with four lines, a log of 100 MB and 30 session files: ${fastest.toFixed(1)} ms`)
  assert.ok(fastest < 100, `the fastest of three runs took ${fastest.toFixed(1)} ms`)
})

// From here on: the command "kestrel hud".

const BIN = fileURLToPath(new URL('../cli/kestrel.mjs', import.meta.url))
/**
 * Runs "kestrel hud" with folders of its own below `name`: the home folder, this tool's folder,
 * and the folders of Claude Code, Codex and Cowork. The command gets nothing else of the real
 * environment but the PATH. `run` takes the words after "hud". `settings` reads this tool's settings.
 */
function command(name) {
  const own = join(dir, name)
  const env = { PATH: process.env.PATH, HOME: own, USERPROFILE: own, KESTREL_HOME: join(own, 'home'), CLAUDE_CONFIG_DIR: join(own, 'claude'), CODEX_HOME: join(own, 'codex'), KESTREL_COWORK_DIR: join(own, 'cowork') }
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true })
  const run = (...args) => spawnSync(process.execPath, [BIN, 'hud', ...args], { encoding: 'utf8', env })
  const settings = () => JSON.parse(readFileSync(join(env.KESTREL_HOME, 'config.json'), 'utf8'))
  return { env, run, settings }
}

// The preview of the four lines, made with the sample of the owner's page.
const PREVIEW = [
  '[Opus 5.5 · high] │ my-app git:(main) │ context ████░░░░░░ 42% of 1M │ cache warm, 52 min left',
  'week ████████▌░ 85%, full 2.2 days early │ 5h ███░░░░░░░ 33% │ today 41M tokens, 96% from the cache',
  '▸ Writing the tests (3/5) │ Explore: find where the hooks run (4 min), general-purpose: check the guide (2 min) │ other sessions: 1 waits for you',
  'context 420k: a good moment to /compact',
]
const ONE = '5 hour limit 33% used, 60% of its time gone | week 85% used, 59% of the week gone: full about 2.2 days early | cache warm, 52 min left | context 420k (42%) | effort high | context 420k: a good moment to /compact'
/** What a change prints: what was saved, the new preview, and the way back. */
const saved = (words, preview) => [`Saved. ${words}`, '', 'Preview with sample data:', '', ...preview, '', 'Take it back with: kestrel hud undo', ''].join('\n')

test('"kestrel hud" shows the settings in words, a preview with the sample, what each line shows, and the commands', () => {
  const { run } = command('hud-show')
  const r = run()
  assert.deepEqual([r.status, r.stderr], [0, ''])
  assert.equal(r.stdout, [
    'The status line shows 4 lines, in this order: session, plan, work, hint. Bars on. Names of tasks and agents on.',
    '',
    'Preview with sample data:',
    '',
    ...PREVIEW,
    '',
    'What each line shows:',
    '  session  the model and its effort level, the folder and its git branch, the context, the cache',
    '  plan     the plan\'s limits (or the dollars, when you pay by the token), and today\'s tokens of all agents',
    '  work     the task in progress, the agents that run, the other open sessions, and a ticket that is open twice',
    '  hint     the hint about the effort level, and the hint to compact',
    'The names of tasks and agents show on your screen. Kestrel keeps them in no file. A computer linked to a Kestrel board sends them to the board too.',
    '',
    'Change it with:',
    '  kestrel hud lines session,plan,work,hint   the lines to show, in this order (any of the four)',
    '  kestrel hud lines                          all four lines again',
    '  kestrel hud one                            one line',
    '  kestrel hud bars on|off                    bars for the context and the limits, or numbers only',
    '  kestrel hud names on|off                   the names of tasks and agents, or counts only',
    '  kestrel hud undo                           put back the settings from before the last change',
    '',
  ].join('\n'))
  // It only shows: it saves nothing.
  assert.equal(readdirSync(join(dir, 'hud-show')).includes('home'), false)
  // "kestrel help" names every one of its commands.
  const help = spawnSync(process.execPath, [BIN, 'help'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(dir, 'hud-show') } }).stdout
  for (const words of ['hud', 'hud lines \\[list\\]', 'hud one', 'hud bars on\\|off', 'hud names on\\|off', 'hud undo']) assert.match(help, new RegExp(`^  kestrel ${words} +\\S`, 'm'), words)
})

test('each change prints the new preview and is saved, and "kestrel hud undo" puts back the settings from before, one step', () => {
  const { run, settings, env } = command('hud-change')
  const out = (...args) => {
    const r = run(...args)
    assert.deepEqual([r.status, r.stderr], [0, ''], args.join(' '))
    return r.stdout
  }
  // Other settings in the file stay as they are.
  mkdirSync(env.KESTREL_HOME, { recursive: true })
  writeFileSync(join(env.KESTREL_HOME, 'config.json'), JSON.stringify({ plan: 'subscription' }))
  // Lines in the given order. Before, nothing was set.
  assert.equal(out('lines', 'plan,session'), saved('The status line shows 2 lines, in this order: plan, session. Bars on. Names of tasks and agents on.', [PREVIEW[1], PREVIEW[0]]))
  assert.deepEqual(settings(), { plan: 'subscription', hud: { layout: 'lines', lines: ['plan', 'session'], bars: true, names: true }, hudBefore: null })
  // The list can have spaces and commas. A line named twice counts once.
  assert.equal(out('lines', 'work', 'hint,', 'work'), saved('The status line shows 2 lines, in this order: work, hint. Bars on. Names of tasks and agents on.', [PREVIEW[2], PREVIEW[3]]))
  assert.deepEqual(settings().hudBefore.lines, ['plan', 'session'])
  assert.equal(out('lines', 'hint'), saved('The status line shows 1 line: hint. Bars on. Names of tasks and agents on.', [PREVIEW[3]]))
  // Undo puts back the settings from before the last change, once.
  assert.equal(out('undo'), ['The settings from before are back. The status line shows 2 lines, in this order: work, hint. Bars on. Names of tasks and agents on.', '', 'Preview with sample data:', '', PREVIEW[2], PREVIEW[3], ''].join('\n'))
  assert.deepEqual(settings(), { plan: 'subscription', hud: { layout: 'lines', lines: ['work', 'hint'], bars: true, names: true } })
  assert.equal(out('undo'), 'There is no change to take back.\n')
  // Without a list: the four lines again.
  assert.equal(out('lines'), saved('The status line shows 4 lines, in this order: session, plan, work, hint. Bars on. Names of tasks and agents on.', PREVIEW))
  // Bars off: numbers only. Names off: counts only.
  assert.equal(out('bars', 'off'), saved('The status line shows 4 lines, in this order: session, plan, work, hint. Bars off. Names of tasks and agents on.', [
    '[Opus 5.5 · high] │ my-app git:(main) │ context 42% of 1M │ cache warm, 52 min left',
    'week 85%, full 2.2 days early │ 5h 33% │ today 41M tokens, 96% from the cache',
    PREVIEW[2], PREVIEW[3],
  ]))
  assert.equal(out('names', 'off'), saved('The status line shows 4 lines, in this order: session, plan, work, hint. Bars off. Names of tasks and agents off.', [
    '[Opus 5.5 · high] │ my-app git:(main) │ context 42% of 1M │ cache warm, 52 min left',
    'week 85%, full 2.2 days early │ 5h 33% │ today 41M tokens, 96% from the cache',
    'tasks 3/5 │ 2 agents running │ other sessions: 1 waits for you',
    PREVIEW[3],
  ]))
  assert.equal(out('bars', 'on').split('\n')[4], PREVIEW[0])
  assert.equal(out('names', 'on').split('\n')[6], PREVIEW[2])
  // One line: the line of before, with the same sample.
  assert.equal(out('one'), saved('The status line shows one line, with the parts separated by "|".', [ONE]))
  assert.deepEqual(settings().hud, { layout: 'one', lines: ['session', 'plan', 'work', 'hint'], bars: true, names: true })
  assert.equal(out('undo').split('\n')[0], 'The settings from before are back. The status line shows 4 lines, in this order: session, plan, work, hint. Bars on. Names of tasks and agents on.')
  assert.equal(settings().plan, 'subscription')
})

test('a wrong word gives one plain sentence that lists the right ones, exit code 1, and changes nothing', () => {
  const { run, env } = command('hud-wrong')
  for (const [args, sentence] of [
    [['foo'], '"foo" is not one of lines, one, bars, names, undo.'],
    [['lines', 'session,foo'], '"foo" is not one of session, plan, work, hint.'],
    [['bars', 'maybe'], '"maybe" is not one of on, off.'],
    [['names'], '"kestrel hud names" needs one of on, off.'],
    [['names', 'off', 'now'], '"kestrel hud names off" takes no more words, and "now" was given.'],
    [['one', 'two'], '"kestrel hud one" takes no more words, and "two" was given.'],
    [['undo', 'all'], '"kestrel hud undo" takes no more words, and "all" was given.'],
  ]) {
    const r = run(...args)
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, '', `kestrel: ${sentence}\n`], args.join(' '))
  }
  assert.equal(existsSync(join(env.KESTREL_HOME, 'config.json')), false)
})

test('the preview shows what the status line shows for the same sample, in both layouts, with and without colours', () => {
  freshHome()
  const folder = repo('main', 'my-app')
  writeToday({ day: localDay(NOW), at: NOW - MIN, tokens: 41e6, cacheRead: 39.4e6 })
  otherSession('other', { at: NOW - 30e3, callAt: NOW - 5 * MIN, project: 'work/other' })
  // The status line saw the last model call 2 minutes ago, and the context grew from 100k since the session began.
  otherSession('sample', { at: NOW - 30e3, apiMs: 2000, callAt: NOW - 2 * MIN, ctx: 420000, compactBase: 100000, ctxSeen: 420000 })
  const log = logOf([
    todos([['Read the status line code', 'completed'], ['Plan the lines', 'completed'], ['Write the bars', 'completed'], ['Write the tests', 'in_progress', 'Writing the tests'], ['Update the guide', 'pending']]),
    agent('Explore', 'find where the hooks run', 4),
    agent('general-purpose', 'check the guide', 2),
  ])
  const input = {
    session_id: 'sample', cwd: folder, transcript_path: log,
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, effort: { level: 'high' },
    cost: { total_cost_usd: 3, total_duration_ms: HOUR, total_api_duration_ms: 2000 },
    context_window: { context_window_size: 1e6, used_percentage: 42, current_usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 420000 } },
    prompt_cache: { warm: true, ttl: '1h', expires_at: sec(NOW + 52 * MIN) },
    rate_limits: { seven_day: { used_percentage: 85, resets_at: sec(NOW + 2.9 * DAY) }, five_hour: { used_percentage: 33, resets_at: sec(NOW + 2 * HOUR) } },
  }
  for (const color of [false, true]) {
    for (const hud of [{}, { layout: 'one' }, { bars: false, names: false, lines: ['work', 'plan'] }]) {
      saveConfig({ hud })
      assert.equal(statusLine(input, NOW, { env: {}, color, notify: () => {}, spawn: spawner }), hudPreview(hudConfig({ hud }), color), JSON.stringify(hud))
    }
  }
  assert.equal(hudPreview(hudConfig({})), PREVIEW.join('\n'))
  assert.equal(hudPreview(hudConfig({ hud: { layout: 'one' } })), ONE)
})

// From here on: the plugin's command "/kestrel:hud" and the skill.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// How the plugin runs the tool: node with the command's file in the plugin's folder.
const TOOL = 'node "${CLAUDE_PLUGIN_ROOT}/cli/kestrel.mjs"'

/** The front matter of a Markdown file (the "key: value" lines between two lines of "---" at its top) as an object, and the text after it. */
function markdown(...path) {
  const text = readFileSync(join(ROOT, ...path), 'utf8')
  const [, head, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? []
  assert.ok(head, `${path.join('/')} has front matter`)
  const fields = Object.fromEntries(head.split('\n').map((line) => {
    const [, key, value] = /^([\w-]+): (.*)$/.exec(line)
    return [key, value.replace(/^'(.*)'$/, '$1')]
  }))
  return { fields, body }
}

test('the plugin\'s command "/kestrel:hud" runs "kestrel hud", picks one command, shows its preview, names the undo, and never changes Claude Code\'s settings', () => {
  const { fields, body } = markdown('commands', 'hud.md')
  assert.deepEqual(Object.keys(fields).sort(), ['allowed-tools', 'argument-hint', 'description', 'disable-model-invocation'])
  // The person runs the command. The model does not start it on its own.
  assert.equal(fields['disable-model-invocation'], 'true')
  // Only the tool's "hud" is allowed, with any words after it.
  assert.equal(fields['allowed-tools'], `Bash(${TOOL} hud:*)`)
  for (const words of ['show agents', 'only two lines', 'hide the names', 'go back']) assert.ok(fields.description.includes(`"${words}"`), words)
  // The person's words reach the model.
  assert.match(body, /In their own words: \$ARGUMENTS\n/)
  // The steps: run "kestrel hud", pick one command, run it, show the preview, name the undo.
  assert.ok(body.includes(`1. Run \`${TOOL} hud\` with the Bash tool.`))
  assert.match(body, /\n2\. Pick the one command from that list that does what the person asked\./)
  assert.ok(body.includes(`\n3. Run that one command with the Bash tool: \`${TOOL} hud\` and its words.`))
  assert.match(body, /\n4\. Show the preview that it prints, exactly as it is, in one code block\./)
  assert.match(body, /\n5\. Say that `\/kestrel:hud undo` takes the change back\./)
  assert.match(body, /\nNever change Claude Code's settings for this, and run no other command\./)
  // Every program that the file names is the tool's "hud", which the allowed tool covers.
  const programs = [...body.matchAll(/`(node [^`]*)`/g)].map(([, line]) => line)
  assert.equal(programs.length, 2)
  for (const line of programs) assert.equal(line, `${TOOL} hud`)
  // Every example is a command that "kestrel hud" takes.
  const examples = [...body.matchAll(/`hud ([^`]*)`/g)].map(([, words]) => words.split(' '))
  assert.deepEqual(examples.map((words) => words[0]), ['lines', 'names', 'lines', 'lines', 'names', 'bars', 'one', 'undo'])
  const { run } = command('hud-examples')
  for (const words of examples) {
    const r = run(...words)
    assert.deepEqual([r.status, r.stderr], [0, ''], words.join(' '))
  }
})

test('the skill tells the person to type "/kestrel:hud" to change the status line, and names the undo', () => {
  const skill = readFileSync(join(ROOT, 'skills', 'kestrel', 'SKILL.md'), 'utf8')
  assert.match(skill, /\n## The lines of the status line\n\nThe status line shows up to four lines: .* tell them to type `\/kestrel:hud` with what they want in their own words, .* `\/kestrel:hud undo` takes the change back\.\n/)
})

test('an agent that runs in the background shows while its own log has no meta file, although its call already has a result', () => {
  freshHome()
  // Claude Code starts the agent in the background: the call gets a result at once that names the agent's log.
  const call = toolUse('Agent', { subagent_type: 'Explore', description: 'Count the files' }, { at: NOW - 2 * MIN, result: { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a1' } } })
  const log = logOf([todos([['Count the files', 'in_progress', 'Counting the files'], ['Answer', 'pending']]), call])
  const sub = join(log.slice(0, -'.jsonl'.length), 'subagents')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(sub, 'agent-a1.jsonl'), `${JSON.stringify({ type: 'user', timestamp: iso(NOW - 2 * MIN), agentId: 'a1', message: { role: 'user', content: 'go' } })}\n`)
  const work = (names = true) => onlyLines(['work'], session({ transcript_path: log }), { hud: { names } })
  assert.equal(work(), '▸ Counting the files (0/2) │ Explore: Count the files (2 min)')
  assert.equal(work(false), 'tasks 0/2 │ 1 agent running')
  // Claude Code writes the meta file when the agent starts, without "finished": it still runs.
  writeFileSync(join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Count the files', requestShape: 'background' }))
  assert.equal(work(), '▸ Counting the files (0/2) │ Explore: Count the files (2 min)')
  // When it ends, Claude Code writes the meta file again with "finished": true: no agent any more.
  writeFileSync(join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Count the files', finished: true }))
  assert.equal(work(), '▸ Counting the files (0/2)')
  // A meta file that says it still runs keeps it, and one that cannot be read ends it.
  writeFileSync(join(sub, 'agent-a1.meta.json'), JSON.stringify({ finished: false }))
  assert.equal(work(), '▸ Counting the files (0/2) │ Explore: Count the files (2 min)')
  writeFileSync(join(sub, 'agent-a1.meta.json'), '{ not json')
  assert.equal(work(), '▸ Counting the files (0/2)')
})
