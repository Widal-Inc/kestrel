// The hint about the effort level, at the end of the status line.
//
// Claude Code's documentation says that a change of the effort level keeps the provider's cache
// on the current models, on a subscription and with an API key. A change of model sends the whole
// context again. So inside a running session the effort level is the one switch that is worth
// advising. The hint names the command, and the person types it. Nothing changes on its own.
//
// The hint comes from the last model calls of the session, read from the end of its log:
//   - mostly simple work at a high level: one level down;
//   - many failed rounds at a low level: one level up.
// For this hint only the names of the tools and the error flags of the tool results are taken
// from the log. No text of the log is kept, stored or printed.
//
// The status line must stay fast. So the log is never read as a whole, only its last 256 KB, and
// for this hint at most once every 5 minutes per session. The result is kept in the session's file.
//
// The same look at the log also says whether a task has just ended. That is for the hint to
// compact, which is in compact.mjs. It asks for a look at a break in the work, at most once
// after each model call. When both hints are due in one run of the status line, the log is
// read once for both. For that sign the look compares the start of a shell command and reads
// the status of the tasks of a task list. It keeps a time and nothing else: see the privacy
// rule further down.
//
// The work line of the status line (hud.mjs) uses the same look, once per run: the newest task
// list, and the agents that run. For that line, and only for it, the look takes what a task
// says and what an agent was asked to do (its kind and its short description). The owner
// allowed showing these on the person's own screen (14 Nov 2026). They stay in memory for the
// one run: no part of this tool writes them to a file.
import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { COMMANDS, NO_TOOL, READING, kindOf } from './analyze.mjs'
import { config } from './config.mjs'
import { count } from './format.mjs'

// On, from the last 30 calls: down when 80% of them are simple work, up from 5 tool errors.
const DEFAULTS = { on: true, calls: 30, simple: 0.8, errors: 5 }

/**
 * The settings of the hint: `{ on, calls, simple, errors }`, with the defaults for what is not
 * set. A number that was set by hand and cannot be used gives way to its default, so that the
 * status line still works.
 */
export function hintConfig(cfg = config()) {
  const h = { ...DEFAULTS, ...cfg?.hint }
  if (!Number.isInteger(h.calls) || h.calls < 1) h.calls = DEFAULTS.calls
  if (!Number.isFinite(h.simple) || h.simple <= 0 || h.simple > 1) h.simple = DEFAULTS.simple
  if (!Number.isFinite(h.errors) || h.errors < 1) h.errors = DEFAULTS.errors
  return h
}

/** The settings in words, for "widal hint" and the row of "widal doctor". */
export function hintSettingsText(h) {
  const when = `from the last ${count(h.calls)} model calls of a session: a lower level when ${Math.round(100 * h.simple)}% or more of them are simple work, a higher level from ${count(h.errors)} tool errors`
  return h.on ? `on, ${when}` : `off (when on: ${when})`
}

// The effort levels of Claude Code, the lowest first. The hint goes one level down or one level up.
const LADDER = ['low', 'medium', 'high', 'xhigh', 'max']
// From this level on a session can get the hint to go down. Below it, the hint to go up.
const HIGH = LADDER.indexOf('high')

// The models on which a change of the effort level keeps the cache. On an older model it sends
// the whole context again, so a session on one gets no hint.
const KEEP_CACHE = ['claude-fable-5-1', 'claude-fable-5-2', 'claude-mythos-5-1', 'claude-mythos-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
const keepsCache = (model) => typeof model === 'string' && KEEP_CACHE.some((name) => model.startsWith(name))

// Only this much of the end of a log is read: 256 KB, in bytes.
const TAIL = 256 * 1024
// Fewer calls than this say too little about the work.
const ENOUGH = 20
// The hint to go down allows this many tool errors among the calls.
const FEW_ERRORS = 2
// The log of a session is looked at this often at most.
const CHECK_EVERY = 5 * 60e3
// A hint that was found stays on the line for this long. Then the log is looked at again.
const SHOWN_FOR = 30 * 60e3
// The kinds of work that count as simple.
const SIMPLE = new Set([READING, COMMANDS, NO_TOOL])

/**
 * The lines in the last 256 KB of a file. The file is opened and read from that place on, never
 * as a whole, so that a log of any size takes the same short time. A piece that does not begin
 * at the start of the file begins in the middle of a line, so its first line is dropped.
 */
export function lastLines(path) {
  // Only a plain file is opened. Opening a pipe would wait for its other end.
  if (!statSync(path).isFile()) return []
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - TAIL)
    const piece = Buffer.alloc(size - start)
    const read = readSync(fd, piece, 0, piece.length, start)
    const lines = piece.toString('utf8', 0, read).split('\n')
    if (start > 0) lines.shift()
    return lines
  } finally {
    closeSync(fd)
  }
}

// The privacy rule for the shell command (the owner allowed this on 13 Nov 2026). The tool may
// look at the start of a shell command in the log, only to see whether it is one of these four
// commands: "git commit", "git push", "gh pr create" or "gh pr merge". It compares the first
// words and keeps only "a task ended at this time". It never keeps, prints or stores the
// command or any other text.
//
// This pattern is that comparison. It is tied to the start of the command, so a command that
// only holds these words later in its line does not match.
const ENDS_A_TASK = /^\s*(?:git\s+(?:commit|push)|gh\s+pr\s+(?:create|merge))(?:\s|$)/
// The tool that runs a shell command in Claude Code, and its task list tools.
const SHELL = 'Bash'
const TODO_LIST = 'TodoWrite'
const TASK_NEW = 'TaskCreate'
const TASK_CHANGED = 'TaskUpdate'
// The tool that starts an agent. Older versions of Claude Code call it "Task", newer ones "Agent".
const AGENT_TOOLS = new Set(['Task', 'Agent'])
// The states of a task that "TaskUpdate" can set.
const TASK_STATES = new Set(['pending', 'in_progress', 'completed', 'deleted'])

/**
 * The time of a line of the log in milliseconds, or 0 when the line has none that can be read.
 * A time that is not known counts as long ago.
 */
const timeOf = (d) => (typeof d?.timestamp === 'string' && Number.isFinite(Date.parse(d.timestamp)) ? Date.parse(d.timestamp) : 0)

/** A value when it is text that is not empty, else undefined. */
const words = (v) => (typeof v === 'string' && v.trim() ? v : undefined)

/**
 * The id of the task that a call of "TaskCreate" made, from the line with the call's result, or
 * undefined. Claude Code puts the id in the result's data (`toolUseResult.task.id`). The text of
 * the result begins with "Task #<id> created". Only that start is compared, and only the id is
 * taken from it.
 */
function madeTaskId(d, result) {
  const given = d?.toolUseResult?.task?.id
  if (typeof given === 'string' || Number.isFinite(given)) return String(given)
  const content = Array.isArray(result.content) ? result.content.find((c) => c?.type === 'text')?.text : result.content
  return typeof content === 'string' ? /^Task #(\w+) created/.exec(content)?.[1] : undefined
}

/**
 * What the end of a session's log says: `{ calls, taskAt, tasks, agents }`.
 *
 * `calls` are the model calls, the oldest first. Each is `{ tools, failed }`. `tools` has the
 * names of the tools that the call used, each as a list of one item, which is the form that
 * `kindOf` takes. `failed` says whether a tool result that came back before the call was marked
 * as an error.
 *
 * `taskAt` is the time of the newest sign that a task ended, or undefined when there is none.
 * Only what comes after the last compaction in this piece of the log counts. There are two signs:
 *   - A shell command that starts with "git commit", "git push", "gh pr create" or "gh pr
 *     merge", unless its result was marked as an error. See the privacy rule above.
 *   - The newest call of a task list tool shows every task as completed. "TodoWrite" gives the
 *     whole list on each call. "TaskCreate" and "TaskUpdate" give it together: each new task is
 *     open, and each update says whether one task is open or done. Only the status fields are
 *     read, never what a task says. So the tasks are counted and not told apart, and a task
 *     from before this piece of the log is known only once an update names its status.
 *
 * `tasks` and `agents` are for the work line of the status line, and are never written to a file:
 *   - `tasks` is the newest task list as items `{ name, status }`, in its order, or undefined
 *     when this piece of the log has none. The name is the task's "activeForm" when it has one,
 *     else what the task says. Of "TodoWrite" and "TaskCreate"/"TaskUpdate", the one used last
 *     gives the list. A task of "TaskCreate" is known by the id that its result gives. An update
 *     of a task from before this piece of the log adds the task as the update has it.
 *   - `agents` are the calls of the tool "Task" or "Agent" that have no result yet, the oldest
 *     first, each as `{ type, description, at }`: the kind of agent, its short description and
 *     the time of the call.
 *   A compaction does not end a task list or an agent, so these two go on across it. Lines that
 *   a subagent wrote into this log are left out of both.
 *
 * Nothing else of a line is taken. A model call is one message id: Claude Code writes one line
 * per content block of a message, and each of those lines carries the id. parse-claude.mjs says
 * more about the format. A line that is not JSON is skipped: it is broken, or still being written.
 */
function logEnd(path) {
  const calls = []
  const byId = new Map()
  let failed = false
  // The shell commands that end a task, each with its time, by the id of the tool call.
  const commands = new Map()
  // The tasks of "TaskCreate" and "TaskUpdate" that are open, and when the task list last
  // showed every task as completed.
  let open = 0
  let listDoneAt
  // The tool calls that were looked at for a sign, by their id. A log can hold the line of a
  // tool call twice, and a task that is counted twice would never be done.
  const looked = new Set()
  // For the work line: the list of the newest "TodoWrite", the tasks of "TaskCreate" and
  // "TaskUpdate" in the order they were made, the task of each "TaskCreate" call whose result
  // has not come yet, and which of the two kinds of task list was used last.
  let todoList
  const made = []
  const madeBy = new Map()
  let newest
  // The agent calls without a result yet, and the tool calls that have their result, by id.
  const agents = new Map()
  // Agents started in the background, by the id of their own log: their call gets a result at once.
  const launched = new Map()
  const answered = new Set()
  for (const line of lastLines(path)) {
    if (!line) continue
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const message = d?.message
    const content = Array.isArray(message?.content) ? message.content : []
    // A line that a subagent wrote: its task list and its agents are not the session's own.
    const side = d?.isSidechain === true
    if (d?.type === 'assistant') {
      // A message that Claude Code made up itself (after an error, for example) is no model call.
      if (message?.id == null || message.model === '<synthetic>') continue
      let call = byId.get(message.id)
      if (!call) {
        call = { tools: [], failed }
        failed = false
        byId.set(message.id, call)
        calls.push(call)
      }
      for (const b of content) {
        if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue
        call.tools.push([b.name])
        if (b.id != null && looked.has(b.id)) continue
        looked.add(b.id)
        if (b.name === SHELL) {
          // Only the start of the command is compared, and only its time is kept: see the privacy rule above.
          if (typeof b.input?.command === 'string' && ENDS_A_TASK.test(b.input.command)) commands.set(b.id ?? Symbol('no id'), timeOf(d))
        } else if (b.name === TODO_LIST) {
          const todos = b.input?.todos
          listDoneAt = Array.isArray(todos) && todos.length && todos.every((todo) => todo?.status === 'completed') ? timeOf(d) : undefined
          if (!side && Array.isArray(todos)) {
            todoList = todos.filter((todo) => todo && typeof todo === 'object').map((todo) => ({ name: words(todo.activeForm) ?? words(todo.content), status: todo.status }))
            newest = 'todo'
          }
        } else if (b.name === TASK_NEW) {
          open += 1
          listDoneAt = undefined
          if (!side) {
            const task = { subject: words(b.input?.subject), form: words(b.input?.activeForm), status: 'pending' }
            made.push(task)
            if (b.id != null) madeBy.set(b.id, task)
            newest = 'task'
          }
        } else if (b.name === TASK_CHANGED) {
          const status = b.input?.status
          if (status === 'completed') {
            open = Math.max(0, open - 1)
            listDoneAt = open ? undefined : timeOf(d)
          } else if (status === 'deleted') open = Math.max(0, open - 1)
          else if (status === 'pending' || status === 'in_progress') {
            open = Math.max(1, open)
            listDoneAt = undefined
          }
          const id = b.input?.taskId
          if (!side && (typeof id === 'string' || Number.isFinite(id))) {
            let task = made.find((t) => t.id === String(id))
            if (!task) made.push((task = { id: String(id) }))
            if (TASK_STATES.has(status)) task.status = status
            if (words(b.input.subject)) task.subject = b.input.subject
            if (words(b.input.activeForm)) task.form = b.input.activeForm
            if (status === 'deleted') made.splice(made.indexOf(task), 1)
            newest = 'task'
          }
        } else if (AGENT_TOOLS.has(b.name)) {
          if (!side && b.id != null && !answered.has(b.id)) agents.set(b.id, { type: words(b.input?.subagent_type), description: words(b.input?.description), at: timeOf(d) })
        }
      }
    } else if (d?.type === 'user') {
      for (const b of content) {
        if (b?.type !== 'tool_result') continue
        // An agent with a result has ended. A task that "TaskCreate" made gets its id.
        answered.add(b.tool_use_id)
        // An agent started in the background gets a result at once that names its own log. It is
        // kept by that name: whether it still runs is told by its log (see agentsRunning).
        const started = agents.get(b.tool_use_id)
        const agentId = d.toolUseResult?.agentId
        if (started && d.toolUseResult?.isAsync === true && typeof agentId === 'string') launched.set(agentId, started)
        agents.delete(b.tool_use_id)
        const task = madeBy.get(b.tool_use_id)
        madeBy.delete(b.tool_use_id)
        if (task && b.is_error === true) made.splice(made.indexOf(task), 1)
        else if (task) task.id = madeTaskId(d, b)
        if (b.is_error !== true) continue
        failed = true
        // A commit or a push that failed did not end a task.
        commands.delete(b.tool_use_id)
      }
    } else if (d?.type === 'system' && d.subtype === 'compact_boundary') {
      // What was done before a compaction is in the summary now. It is no reason to compact again.
      commands.clear()
      open = 0
      listDoneAt = undefined
    }
  }
  const signs = [...commands.values(), ...(listDoneAt === undefined ? [] : [listDoneAt])]
  const tasks = newest === 'todo' ? todoList : newest === 'task' ? made.map((t) => ({ name: t.form ?? t.subject, status: t.status })) : undefined
  return { calls, taskAt: signs.length ? Math.max(...signs) : undefined, tasks, agents: agentsRunning(path, Date.now(), launched, [...agents.values()]) }
}

/** The time of the first line of a log, from its first 8 KB, or undefined. */
function firstTime(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(8192)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const first = buf.subarray(0, n).toString('utf8').split('\n')[0]
    const t = Date.parse(JSON.parse(first)?.timestamp)
    return Number.isFinite(t) ? t : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// An agent whose log has not been written to for this long is taken as ended, also without its
// meta file: Claude Code may have stopped without writing it.
const AGENT_QUIET = 10 * 60e3

/**
 * The agents of a session that run now. Claude Code writes each agent's own log to
 * <the session's log without .jsonl>/subagents/agent-<id>.jsonl while it works, and a meta file
 * agent-<id>.meta.json next to it, which says "finished": true once the agent has ended. So an
 * agent runs while its log is there, its meta file does not say "finished": true, and its log was
 * written to in the last 10 minutes. This counts agents that run in the background too, whose call in the session's log
 * already has a result.
 *
 * `launched` gives the call of each agent that was started in the background, by the id of its
 * log, and `pending` the calls that have no result yet: they give the kind and the description.
 * Without the folder, the agents are the calls without a result, as the end of the log tells.
 * Each entry is `{ type, description, at }`, `at` being when the agent started (ms).
 */
export function agentsRunning(path, now = Date.now(), launched = new Map(), pending = []) {
  if (typeof path !== 'string' || !path.endsWith('.jsonl')) return pending
  const dir = join(path.slice(0, -'.jsonl'.length), 'subagents')
  let names
  try {
    names = readdirSync(dir).filter((n) => /^agent-[^/\\]+\.jsonl$/.test(n))
  } catch {
    return pending
  }
  const unmatched = [...pending]
  const running = []
  for (const name of names.slice(0, 200)) {
    try {
      const id = name.slice('agent-'.length, -'.jsonl'.length)
      const log = statSync(join(dir, name))
      if (now - log.mtimeMs > AGENT_QUIET) continue
      const metaPath = join(dir, `agent-${id}.meta.json`)
      const meta = statSync(metaPath, { throwIfNoEntry: false }) ? JSON.parse(readFileSync(metaPath, 'utf8')) : undefined
      // Claude Code writes the meta file when the agent starts, without "finished", and writes it
      // again with "finished": true when the agent ends.
      if (meta?.finished === true) continue
      const call = launched.get(id) ?? unmatched.shift()
      running.push({ type: call?.type ?? words(meta?.agentType), description: call?.description ?? words(meta?.description), at: call?.at ?? firstTime(join(dir, name)) })
    } catch {
      // An agent whose files cannot be read says nothing.
    }
  }
  return running.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
}

/**
 * A look at the end of a session's log that reads the log at most once. It returns a function:
 * its first call reads the log, and every later call gives the same result. So the two hints of
 * one run of the status line share one read. A log that is missing or cannot be read gives no
 * calls and no sign, and no error: it must not break the status line.
 */
export function logLook(path) {
  let seen
  return () => {
    if (seen) return seen
    try {
      seen = logEnd(path)
    } catch {
      seen = { calls: [] }
    }
    return seen
  }
}

/**
 * The hint that a session at this level can get, as [text, tone]: one level down from "high" on,
 * one level up below it. A session at "max" is sent to "xhigh". Undefined for a level that is not
 * on the ladder. The hint to go down has no colour. The hint to go up is yellow.
 */
function hintAt(level) {
  const i = LADDER.indexOf(level)
  if (i < 0) return undefined
  return i >= HIGH
    ? [`mostly simple work at ${level} effort: /effort ${LADDER[i - 1]} keeps the cache`]
    : [`many failed rounds at ${level} effort: /effort ${LADDER[i + 1]} keeps the cache`, 'warn']
}

/**
 * Whether the last calls of a session at this level give the hint of that level. `calls` is what
 * `lastCalls` gives, `h` what `hintConfig` gives.
 *
 * A failed round is a call that came after a tool result with an error. Several results with an
 * error before one call are one failed round.
 *   - Up, from "low" and "medium": `h.errors` failed rounds or more.
 *   - Down, from "high" on: the share `h.simple` of the calls or more read and searched, ran
 *     commands, or only thought and answered, and at most 2 rounds failed.
 */
function fits(level, calls, h) {
  if (calls.length < ENOUGH) return false
  const errors = calls.filter((call) => call.failed).length
  if (LADDER.indexOf(level) < HIGH) return errors >= h.errors
  const simple = calls.filter((call) => SIMPLE.has(kindOf(call))).length
  return simple / calls.length >= h.simple && errors <= FEW_ERRORS
}

/**
 * The hint for one run of the status line: `{ part, checked }`. `part` is the part of the line
 * as [text, tone], when there is a hint. `checked` is what to keep in the session's file as
 * `hint` when this run looked at the log: `{ at, text }`, the time of the look and the text of
 * the hint that it found, or `{ at }` when it found none.
 *
 * `input` is what Claude Code gives the status line, `saved` the `hint` of the session's file,
 * and `h` what `hintConfig` gives. `cloud` says that the person pays through a cloud provider.
 * `look` is what `logLook` gives for the session's log. The status line passes it, so that the
 * hint to compact can use the same read.
 *
 * There is no hint, and no look at the log, while the hint is off, without a level that is on
 * the ladder, and when a change of the effort level would lose the cache: through a cloud
 * provider, and on a model that is not in the list above.
 */
export function effortHint(input, saved, now, { h, cloud, look = logLook(input?.transcript_path) }) {
  const hint = hintAt(input?.effort?.level)
  const path = input?.transcript_path
  if (!h.on || !hint || cloud || !keepsCache(input?.model?.id) || typeof path !== 'string' || !path) return {}
  // How long ago the log was last looked at. A time that lies ahead comes from a clock that was
  // wrong. It does not count.
  const age = Number.isFinite(saved?.at) && saved.at <= now ? now - saved.at : Infinity
  // The text names the level of the session. A saved text for another level is no longer true:
  // the person has changed the level since. It is not shown.
  if (saved?.text === hint[0] && age < SHOWN_FOR) return { part: hint }
  if (age < CHECK_EVERY) return {}
  // A log that is missing or cannot be read has no calls, and so gives no hint.
  const found = fits(input.effort.level, look().calls.slice(-h.calls), h)
  return found ? { part: hint, checked: { at: now, text: hint[0] } } : { checked: { at: now } }
}
