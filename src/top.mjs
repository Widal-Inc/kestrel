// "widal top": a live view in the terminal of every agent session on this computer.
//
// Where the sessions come from:
//   - Claude Code: the files that the status line keeps per session. A session is open while the
//     status line ran for it in the last 2 minutes. It is working when it made a model call in the
//     last 60 seconds, and otherwise it waits for the person.
//   - Codex and Cowork: their logs that were written to in the last 30 minutes. Working when
//     written to in the last 60 seconds, otherwise idle.
// Of a log only the end is read, at most 256 KB, as for the hints of the status line.
//
// Today's tokens come from today.json, which "widal refresh-today" writes.
//
// Names: a task in progress is text from a session. It is shown here, on the person's own screen,
// while the setting hud.names is not false. It is never written to a file. A computer linked to a
// Widal.Code board sends the tasks of its open sessions to the board while names are on (board.mjs).
// The desktop extension asks for the view without it. The pane in Claude Code asks for the view as data
// ("--json"), which holds the task only while the setting allows it.
//
// Nothing here makes a model call.
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { accountToShow } from './accounts.mjs'
import { billing, readLimits } from './billing.mjs'
import { limitParts } from './claude-code.mjs'
import { config, readJson } from './config.mjs'
import { clock, color, colorOn, count, pct, plain, project, tok } from './format.mjs'
import { agentsRunning, lastLines } from './hint.mjs'

/** How many agents of a session run now, from their own logs, or `fallback` when the session has no folder for them. */
const agentsRunningCount = (log, now, fallback) => {
  const list = agentsRunning(log, now, new Map(), Array.from({ length: fallback }, () => ({})))
  return list.length
}
import { claudeDir, home } from './paths.mjs'
import { priceOf } from './prices.mjs'
import { refreshToday } from './refresh-today.mjs'
import { logFiles } from './store.mjs'
import { ticketOf } from './ticket.mjs'
import { readToday, todayDue } from './today-file.mjs'

// A Claude Code session is open while its status line ran in this time.
const OPEN = 2 * 60e3
// A session is working when it made a model call (or wrote its log) in this time.
const WORKING = 60e3
// Codex and Cowork logs written to in this time are shown.
const RECENT = 30 * 60e3
// The first "Next" rule: a session waits, and its cache ends within this time.
const CACHE_SOON = 30 * 60e3
// The second "Next" rule: a session waits with this much context or more.
const LARGE_CONTEXT = 150_000
// A cache that is gone is red from this many tokens to send again, as on the status line.
const LARGE_RESEND = 100_000
// The view is drawn again this often, in milliseconds.
const EVERY = 2000
// A task is cut to this many characters, so that a row stays on one line.
const TASK_WIDTH = 50
// Only this much of the start of a Codex log is read for its first line, which names the session.
const FIRST_LINE_MAX = 1024 * 1024

// The tools of Claude Code that start a subagent. "Task" is the older name.
const AGENT_TOOLS = new Set(['Agent', 'Task'])

const WORK = 'working'
const WAITS = 'waits for you'
const IDLE = 'idle'
const ORDER = [WORK, WAITS, IDLE]

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
/** A value when it is text that is not empty, without control characters, else undefined. */
const text = (v) => (typeof v === 'string' && v ? plain(v) : undefined)
/** A value when it is a number, else undefined. For a value from a file, which can be broken. */
const number = (v) => (Number.isFinite(v) ? v : undefined)
/** A ticket from a session's file: only text in the form that ticketOf gives. */
const ticketText = (v) => (typeof v === 'string' && /^[A-Z][A-Z0-9]{1,5}-\d{1,6}$/.test(v) ? v : undefined)
const minutes = (ms) => Math.max(0, Math.floor(ms / 60e3))

/** The setting hud.names: names are shown unless it is false. */
export const namesOn = (cfg = config()) => cfg?.hud?.names !== false

/** The first line of a file, read from its start and never further than 1 MB. */
function firstLine(path) {
  const fd = openSync(path, 'r')
  try {
    const parts = []
    let size = 0
    while (size < FIRST_LINE_MAX) {
      const piece = Buffer.alloc(64 * 1024)
      const read = readSync(fd, piece, 0, piece.length, size)
      if (!read) break
      const end = piece.subarray(0, read).indexOf(10)
      parts.push(piece.subarray(0, end >= 0 ? end : read))
      size += read
      if (end >= 0) break
    }
    return Buffer.concat(parts).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** Each line of a list that is JSON, parsed. A line that is not JSON is broken or still being written. */
function* parsed(lines, wanted) {
  for (const line of lines) {
    if (!line || !wanted.some((w) => line.includes(w))) continue
    try {
      yield JSON.parse(line)
    } catch {
      // Skipped.
    }
  }
}

/**
 * What the end of a Claude Code log says: how many subagents run, and the task in progress.
 *
 * A subagent runs from the tool call that starts it until its result comes back. The task in
 * progress comes from the newest task list: "TodoWrite" gives the whole list on each call, and
 * "TaskCreate" and "TaskUpdate" give it one task at a time. Of a task only its status and its
 * name are read. The name is text of the session: the caller shows it only on the person's own
 * screen, and never keeps it.
 */
export function claudeTail(path) {
  const running = new Set()
  // The newest "TodoWrite" list: its task in progress, and where it was in the log.
  let listAt = -1
  let listTask
  // The tasks of "TaskCreate" and "TaskUpdate", by their id: { name, status, at }.
  const tasks = new Map()
  const creating = new Map() // The name of each "TaskCreate" call whose result has not come yet.
  let tasksAt = -1
  let at = 0
  const nameOf = (...values) => {
    const v = values.find((x) => typeof x === 'string' && x.trim())
    return v === undefined ? undefined : plain(v).replace(/\s+/g, ' ').trim()
  }
  const idOf = (v) => (typeof v === 'string' && v ? v : Number.isInteger(v) ? String(v) : undefined)
  for (const d of parsed(lastLines(path), ['"type":"assistant"', '"type":"user"'])) {
    // A line that a subagent wrote into the main log belongs to that agent, not to the session.
    if (d?.isSidechain === true) continue
    at++
    const content = Array.isArray(d?.message?.content) ? d.message.content : []
    if (d?.type === 'assistant') {
      for (const b of content) {
        if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue
        const input = isObject(b.input) ? b.input : {}
        if (AGENT_TOOLS.has(b.name)) {
          if (b.id != null) running.add(b.id)
        } else if (b.name === 'TodoWrite' && Array.isArray(input.todos)) {
          const doing = input.todos.find((t) => t?.status === 'in_progress')
          listTask = doing ? nameOf(doing.activeForm, doing.content) : undefined
          listAt = at
        } else if (b.name === 'TaskCreate') {
          creating.set(b.id, nameOf(input.activeForm, input.subject))
          tasksAt = at
        } else if (b.name === 'TaskUpdate') {
          const id = idOf(input.taskId)
          if (!id) continue
          const task = tasks.get(id) ?? {}
          if (typeof input.status === 'string') task.status = input.status
          task.name = nameOf(input.activeForm, input.subject) ?? task.name
          task.at = at
          tasks.set(id, task)
          tasksAt = at
        }
      }
    } else {
      for (const b of content) {
        if (b?.type !== 'tool_result') continue
        running.delete(b.tool_use_id)
        if (!creating.has(b.tool_use_id)) continue
        // The new task's id is in the result. Claude Code numbers the tasks of a session 1, 2, 3,
        // so without an id the task gets the number after the highest one seen.
        const highest = Math.max(0, ...[...tasks.keys()].map(Number).filter(Number.isInteger))
        const id = idOf(d.toolUseResult?.task?.id) ?? String(highest + 1)
        tasks.set(id, { name: creating.get(b.tool_use_id), status: 'pending', at, ...tasks.get(id) })
        creating.delete(b.tool_use_id)
      }
    }
  }
  const doing = [...tasks.values()].filter((t) => t.status === 'in_progress').sort((a, b) => b.at - a.at)[0]
  return { agents: running.size, task: listAt > tasksAt ? listTask : doing?.name }
}

/** What the start and the end of a Codex log say: the session, its folder, its ticket and its context. */
function codexTail(file) {
  let id, cwd, branch, ctx, window
  try {
    const d = JSON.parse(firstLine(file))
    if (d?.type === 'session_meta' && isObject(d.payload)) {
      // The same id as the reader of Codex logs takes, so that today's tokens can be found.
      id = text(d.payload.session_id) ?? text(d.payload.id)
      cwd = text(d.payload.cwd)
      branch = text(d.payload.git?.branch)
      window = number(d.payload.context_window)
    }
  } catch {
    // No first line that can be read.
  }
  for (const d of parsed(lastLines(file), ['"token_count"', '"turn_context"'])) {
    const p = d?.payload
    if (d?.type === 'turn_context') cwd = text(p?.cwd) ?? cwd
    else if (d?.type === 'event_msg' && p?.type === 'token_count' && isObject(p.info)) {
      // In OpenAI's usage the input counts the cached input too: it is the whole context sent.
      ctx = number(p.info.last_token_usage?.input_tokens) ?? ctx
      window = number(p.info.model_context_window) ?? window
    }
  }
  return { id: id ?? basename(file, '.jsonl'), cwd, ticket: ticketOf(branch), ctx, window }
}

/** What the end of a Cowork log says: the session's folder and its context. */
function coworkTail(file) {
  let cwd, ctx
  for (const d of parsed(lastLines(file), ['"system"', '"assistant"'])) {
    if (d?.type === 'system' && d.subtype === 'init') cwd = text(d.cwd) ?? cwd
    else if (d?.type === 'assistant' && typeof d.parent_tool_use_id !== 'string' && isObject(d.message?.usage)) {
      const u = d.message.usage
      ctx = (number(u.input_tokens) ?? 0) + (number(u.cache_creation_input_tokens) ?? 0) + (number(u.cache_read_input_tokens) ?? 0)
    }
  }
  // The session's folder is local_<id>, as for the reader of Cowork logs.
  return { id: basename(dirname(file)).replace(/^local_/, ''), cwd, ctx }
}

// Where each Claude Code session's log was found, so that the folders are not looked through on
// every draw.
const logOf = new Map()

/** The log of a Claude Code session: <Claude's folder>/projects/<folder>/<id>.jsonl, or undefined. */
function claudeLog(id) {
  const projects = join(claudeDir(), 'projects')
  const key = `${projects}\n${id}`
  if (logOf.has(key) && existsSync(logOf.get(key))) return logOf.get(key)
  let folders = []
  try {
    folders = readdirSync(projects)
  } catch {
    return undefined
  }
  for (const folder of folders) {
    const file = join(projects, folder, `${id}.jsonl`)
    if (existsSync(file)) {
      logOf.set(key, file)
      return file
    }
  }
  return undefined
}

/** The open Claude Code sessions, from the files the status line keeps. */
function claudeSessions(now, names) {
  const dir = join(home(), 'sessions')
  let files = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const rows = []
  for (const name of files) {
    const s = readJson(join(dir, name))
    if (!isObject(s) || !Number.isFinite(s.at) || now - s.at >= OPEN) continue
    const id = name.slice(0, -'.json'.length)
    const callAt = number(s.callAt)
    const working = callAt !== undefined && now - callAt < WORKING
    const row = {
      id, tool: 'Claude', project: text(s.project), ticket: ticketText(s.ticket),
      state: working ? WORK : WAITS, minutes: working || callAt === undefined ? undefined : minutes(now - callAt), last: callAt ?? s.at,
      ctx: number(s.ctx), cacheUntil: number(s.cacheUntil), ttl: s.ttl, model: text(s.model), agents: 0,
    }
    // A session id that is not a plain name is kept as "unknown": its log cannot be found.
    const log = id === 'unknown' ? undefined : claudeLog(id)
    if (log) {
      try {
        const tail = claudeTail(log)
        // The agents' own logs count agents that run in the background too. Without them, the end
        // of the log says how many run.
        row.agents = agentsRunningCount(log, now, tail.agents)
        if (names) row.task = tail.task
      } catch {
        // A log that cannot be read says nothing.
      }
    }
    rows.push(row)
  }
  return rows
}

/** The Codex and Cowork sessions whose logs were written to in the last 30 minutes. */
function logSessions(now) {
  const rows = []
  for (const { file, source } of logFiles(['codex', 'cowork'])) {
    let st
    try {
      st = statSync(file)
    } catch {
      continue
    }
    const age = now - st.mtimeMs
    if (age >= RECENT || !st.isFile()) continue
    let tail
    try {
      tail = source === 'codex' ? codexTail(file) : coworkTail(file)
    } catch {
      continue
    }
    const working = age < WORKING
    rows.push({
      id: tail.id, tool: source === 'codex' ? 'Codex' : 'Cowork', project: tail.cwd && project(tail.cwd), ticket: tail.ticket,
      state: working ? WORK : IDLE, minutes: working ? undefined : minutes(age), last: st.mtimeMs, ctx: tail.ctx || undefined, window: tail.window,
    })
  }
  return rows
}

/**
 * Every agent session on this computer now, in the order of the view: working, waiting for the
 * person, idle, and inside each the newest first. Each row has today's tokens from today.json,
 * and its folder and ticket from there when its own files do not name them.
 */
export function sessionsNow(now, { names = false, today = readToday(now) } = {}) {
  const sessions = isObject(today?.sessions) ? today.sessions : {}
  const rows = [...claudeSessions(now, names), ...logSessions(now)]
  for (const row of rows) {
    const t = Object.hasOwn(sessions, row.id) && isObject(sessions[row.id]) ? sessions[row.id] : {}
    row.today = number(t.tokens)
    row.project ??= text(t.project)
    row.ticket ??= ticketText(t.ticket)
  }
  return rows.sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || b.last - a.last || String(a.id).localeCompare(String(b.id)))
}

/** The time left of a cache, in minutes rounded up. */
const left = (ms) => `${Math.ceil(ms / 60e3)} min left`

/** A row's cells, each a list of parts [text, tone]. */
function cells(row, now, others, names) {
  // Only a row with a ticket has others with the same ticket.
  const ticket = row.ticket ? [[row.ticket]] : []
  if (others.length) ticket.push([` also in ${others.join(', ')}`, 'warn'])
  const state =
    row.state === WORK ? [WORK, 'good']
    : row.state === WAITS ? [`${WAITS}${row.minutes === undefined ? '' : ` (${row.minutes} min)`}`, 'warn']
    : [`${IDLE} (${row.minutes} min)`, 'dim']
  const percent = row.window > 0 && row.ctx ? Math.round((100 * row.ctx) / row.window) : undefined
  const ctxTone = percent >= 95 ? 'bad' : percent >= 80 || row.ctx > priceOf(row.model)?.longOver ? 'warn' : undefined
  const context = row.ctx ? [`${tok(row.ctx)}${percent === undefined ? '' : ` (${percent}%)`}`, ctxTone] : ['']
  let cache = ['not known']
  if (row.cacheUntil > now) cache = [`warm, ${left(row.cacheUntil - now)}`, row.cacheUntil - now <= (row.ttl === '5m' ? 1 : 10) * 60e3 ? 'warn' : 'good']
  else if (row.cacheUntil !== undefined) cache = ['gone', row.ctx >= LARGE_RESEND ? 'bad' : 'dim']
  const task = row.task && row.task.length > TASK_WIDTH ? `${row.task.slice(0, TASK_WIDTH - 3)}...` : row.task ?? ''
  const out = [[[row.project ?? '(unknown folder)']], [[row.tool]], ticket, [state], [context], [cache], [[row.today === undefined ? '' : tok(row.today)]], [[row.agents ? String(row.agents) : '']]]
  if (names) out.push([[task]])
  return out
}

/**
 * Rows of cells as lines: each column as wide as its widest cell, two spaces between columns.
 * The width counts the text only, so that the colour codes do not move a column.
 */
function grid(rows, colors) {
  const width = []
  const plainOf = (cell) => cell.map(([t]) => plain(t)).join('')
  for (const row of rows) row.forEach((cell, i) => (width[i] = Math.max(width[i] ?? 0, plainOf(cell).length)))
  return rows.map((row) =>
    row.map((cell, i) => {
      const shown = cell.map(([t, tone]) => (colors ? color(plain(t), tone) : plain(t))).join('')
      return shown + ' '.repeat(width[i] - plainOf(cell).length)
    }).join('  ').trimEnd(),
  )
}

/** The time as HH:MM:SS. */
const seconds = (ms) => `${clock(ms)}:${String(new Date(ms).getSeconds()).padStart(2, '0')}`

/** The line "Next: ...", or undefined when no rule holds. */
function nextStep(rows, now) {
  const waiting = rows.filter((r) => r.state === WAITS)
  const ending = waiting.filter((r) => r.cacheUntil > now && r.cacheUntil - now <= CACHE_SOON).sort((a, b) => a.cacheUntil - b.cacheUntil)[0]
  if (ending) return `Next: ${ending.project ?? '(unknown folder)'} waits for you, and its cache ends at ${clock(ending.cacheUntil)}. Answer before then, or /compact first.`
  const large = waiting.filter((r) => r.ctx >= LARGE_CONTEXT).sort((a, b) => b.ctx - a.ctx)[0]
  if (large) return `Next: ${large.project ?? '(unknown folder)'} waits with ${tok(large.ctx)} of context: a good moment to /compact.`
  return undefined
}

/** The line about today's cold starts, from today.json. */
function wasteLine(today) {
  if (!today) return "Today's numbers are not worked out yet."
  const n = number(today.coldStarts) ?? 0
  const tokens = number(today.coldTokens) ?? 0
  return `Waste today: ${count(n)} ${n === 1 ? 'cold start' : 'cold starts'} sent ${tok(tokens)} tokens again (${pct(tokens, number(today.tokens) ?? 0) || '0%'} of today).`
}

/**
 * The view as text, once. `names` adds the TASK column, `colors` the colours of the status line.
 * `env` stands in for the environment, which says how the person pays.
 */
export function topText(now, { names = false, colors = false, env = process.env } = {}) {
  const today = readToday(now)
  const rows = sessionsNow(now, { names, today })
  const paint = (t, tone) => (colors ? color(plain(t), tone) : plain(t))
  const head = [`Widal.Code · ${count(rows.length)} ${rows.length === 1 ? 'session' : 'sessions'} on this computer`]
  // The plan's limits, as the status line words them, on a subscription.
  // Each account has limits of its own. The view shows those of the account signed in now, else the newest reading.
  if (billing({}, { env, now }).mode === 'subscription') head.push(...limitParts(readLimits(now, accountToShow(now)), now).map(([t, tone]) => paint(t, tone)))
  head.push(seconds(now))
  const out = [head.join(' · '), '']
  if (rows.length) {
    // A ticket that is in more than one row: each of those rows names the folders of the others.
    const others = (row) => (row.ticket ? rows.filter((r) => r !== row && r.ticket === row.ticket).map((r) => r.project ?? '(unknown folder)') : [])
    const titles = ['SESSION', 'TOOL', 'TICKET', 'STATE', 'CONTEXT', 'CACHE', 'TODAY', 'AGENTS', ...(names ? ['TASK'] : [])]
    out.push(...grid([titles.map((t) => [[t]]), ...rows.map((row) => cells(row, now, [...new Set(others(row))], names))], colors))
  } else out.push('No agent session runs on this computer now.')
  out.push('', wasteLine(today))
  const next = nextStep(rows, now)
  if (next) out.push(next)
  return out.join('\n')
}

/**
 * The view as data, once ("widal top --once --json"), for the pane in Claude Code: the head, the
 * rows and the footer. `names` adds the task of a row: without names no row holds a task. Each row
 * has its facts and, under `shown`, the words of its cells as the view prints them. A Claude Code
 * row has the command that resumes it. `env` stands in for the environment.
 */
export function topData(now, { names = false, env = process.env } = {}) {
  const today = readToday(now)
  const rows = sessionsNow(now, { names, today })
  const others = (row) => (row.ticket ? rows.filter((r) => r !== row && r.ticket === row.ticket).map((r) => r.project ?? '(unknown folder)') : [])
  // The same account as the text view: the one signed in now, else the newest reading.
  const limits = billing({}, { env, now }).mode === 'subscription' ? limitParts(readLimits(now, accountToShow(now)), now).map(([t, tone]) => ({ text: plain(t), tone: tone ?? null })) : []
  const sessions = rows.map((row) => {
    const also = [...new Set(others(row))]
    const [session, tool, ticket, state, context, cache, todayWords, agents] = cells(row, now, also, false).map((cell) => cell.map(([t]) => plain(t)).join(''))
    const out = {
      id: row.id, tool: row.tool, project: row.project ?? null, ticket: row.ticket ?? null, also, state: row.state, minutes: row.minutes ?? null,
      context: row.ctx ?? null, window: row.window ?? null, cacheUntil: row.cacheUntil ?? null, today: row.today ?? null, agents: row.agents ?? 0,
      shown: { session, tool, ticket, state, context, cache, today: todayWords, agents },
      // A session id that is not a plain name was kept as "unknown": it cannot be resumed by it.
      resume: row.tool === 'Claude' && row.id !== 'unknown' ? `claude --resume ${row.id}` : null,
    }
    if (names && row.task) out.task = row.task
    return out
  })
  return { at: now, count: rows.length, limits, sessions, waste: wasteLine(today), next: nextStep(rows, now) ?? null }
}

// The terminal's other screen, and the cursor: on for the live view, back off at its end.
const ENTER = '\x1b[?1049h\x1b[?25l'
const LEAVE = '\x1b[?25h\x1b[?1049l'
const SIGNALS = ['SIGTERM', 'SIGHUP']

/**
 * "widal top". With a terminal it draws the view every 2 seconds until the person presses q or
 * Ctrl+C. Without a terminal, or with `once`, it prints the view once.
 *
 * When today's numbers are missing or due, it works them out first, in this process, and says so.
 *
 * `names: false` leaves the TASK column out whatever hud.names says ("--no-names"). The plugin's
 * skill runs the view that way, because what it runs goes to the model.
 *
 * `json` prints the view once as data (see `topData`), for the pane in Claude Code.
 *
 * `input`, `output` and `errors` stand in for standard input, output and error, `env` for the
 * environment, `time` for the clock, `every` for the 2 seconds and `refresh` for the work on
 * today's numbers, so that a test can drive it. `quit` ends the process when the person leaves
 * while the logs are still being read: the reading would keep it running.
 */
export async function top({
  once = false, json = false, names: shown, input = process.stdin, output = process.stdout, errors = process.stderr, env = process.env,
  time = Date.now, every = EVERY, refresh = refreshToday, quit = () => process.exit(0),
} = {}) {
  const cfg = config()
  const names = shown !== false && namesOn(cfg)
  const colors = !!output.isTTY && colorOn(env, cfg)
  const view = () => topText(time(), { names, colors, env })
  const live = !once && !json && !!output.isTTY && !!input.isTTY && typeof input.setRawMode === 'function'

  if (!live) {
    if (todayDue(time())) {
      // The view goes to standard output. The note goes to the terminal only, and is wiped after.
      if (errors.isTTY) errors.write('Widal.Code · reading the logs')
      await refresh({ now: time() }).catch(() => {})
      if (errors.isTTY) errors.write('\r\x1b[K')
    }
    output.write(json ? `${JSON.stringify(topData(time(), { names, env }))}\n` : `${view()}\n`)
    return
  }

  let stop = false
  let wake = () => {}
  const onKey = (chunk) => {
    // In raw mode Ctrl+C comes as its character, not as a signal.
    if (/[qQ\x03]/.test(String(chunk))) {
      stop = true
      wake()
    }
  }
  const onSignal = () => {
    stop = true
    wake()
  }
  const onResize = () => wake()
  const draw = (lines) => output.write(`\x1b[H${lines.map((line) => `${line}\x1b[K`).join('\r\n')}\x1b[J`)
  const pause = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    wake = () => {
      clearTimeout(timer)
      resolve()
    }
  })

  const wasRaw = !!input.isRaw
  let leftEarly = false
  output.write(ENTER)
  try {
    input.setRawMode(true)
    input.on('data', onKey)
    input.resume?.()
    output.on?.('resize', onResize)
    for (const signal of SIGNALS) process.on(signal, onSignal)
    if (todayDue(time())) {
      draw(['Widal.Code · reading the logs'])
      let done = false
      // The wait ends when the reading is done, or when the person leaves before that.
      await new Promise((resolve) => {
        wake = resolve
        refresh({ now: time() }).catch(() => {}).then(() => {
          done = true
          resolve()
        })
      })
      leftEarly = stop && !done
    }
    while (!stop) {
      draw(view().split('\n'))
      await pause(every)
    }
  } finally {
    // The terminal is put back as it was, also after an error.
    for (const signal of SIGNALS) process.off(signal, onSignal)
    output.off?.('resize', onResize)
    input.off('data', onKey)
    try {
      input.setRawMode(wasRaw)
    } finally {
      input.pause?.()
      output.write(LEAVE)
    }
  }
  if (leftEarly) quit()
}
