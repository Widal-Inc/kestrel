// The status line in lines, its settings, and the command "kestrel hud".
//
// The status line shows up to four lines: the session, the plan, the work and the hints. Bars
// read faster than numbers, and a person likes to choose the lines. So the settings say which
// lines to show and in which order, whether the context and the limits get bars, and whether the
// names of tasks and agents are shown. The other layout is the one line of parts that the status
// line has always had.
//
// The settings are `hud` in this tool's config: `{ layout: 'lines' | 'one', lines: [...], bars,
// names }`. "kestrel hud" shows them with a preview made from sample data, and changes them. Each
// change keeps the settings from before as `hudBefore`, so that "kestrel hud undo" puts them back.
//
// Names: the names of tasks and agents are text from a session. They are shown on the status line
// while `names` is not false, and are never written to a file. With names off, the work line gives
// counts only. A computer linked to a Kestrel board sends the tasks and agents of its open sessions
// to the board while names are on (see board.mjs), and none while they are off.
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, readJson, saveConfig, writeJson } from './config.mjs'
import { color, colorOn, plain, tok } from './format.mjs'
import { home } from './paths.mjs'
import { todayDue } from './today-file.mjs'

/** The four lines, in the order they have when nothing else is set. */
export const HUD_LINES = ['session', 'plan', 'work', 'hint']

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The settings of the lines: `{ layout, lines, bars, names }`. The defaults are four lines with
 * bars and names. A value that was set by hand and cannot be used gives way to its default, so
 * that the status line still works. A line that is not one of the four is left out, and so is
 * the second mention of a line.
 */
export function hudConfig(cfg = config()) {
  const set = isObject(cfg?.hud) ? cfg.hud : {}
  const lines = Array.isArray(set.lines) ? [...new Set(set.lines.filter((name) => HUD_LINES.includes(name)))] : []
  return { layout: set.layout === 'one' ? 'one' : 'lines', lines: lines.length ? lines : [...HUD_LINES], bars: set.bars !== false, names: set.names !== false }
}

// A bar has 10 cells. A cell is 10 percent, and a half cell 5 percent.
const CELLS = 10

/**
 * A percent as a bar of 10 cells: "█" for a full cell, "▌" for a half cell and "░" for an empty
 * one. Only whole half cells are drawn, so 0 to 4 percent is all empty, and only 100 percent and
 * more is all full.
 */
export function bar(pct) {
  const halves = Math.max(0, Math.min(2 * CELLS, Math.floor((Number.isFinite(pct) ? pct : 0) / 5)))
  const full = Math.floor(halves / 2)
  const half = halves % 2
  return `${'█'.repeat(full)}${half ? '▌' : ''}${'░'.repeat(CELLS - full - half)}`
}

/** The size of a context window in short form: 1M, 200k. */
const windowSize = (n) => tok(n).replace(/\.0(?=[kM]$)/, '')

/** A name from a session or a log, without control characters, and cut to 60 characters so that it fits on the line. */
const cut = (text, max = 60) => {
  const clean = plain(text)
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean
}

/** The line "session": the model and its effort level, the folder and its branch, the context, the cache, and the open security risks. */
function sessionLine({ model, effort, folder, branch, ctx, cache, risk }, h) {
  const parts = []
  const name = [model, effort].filter((w) => w !== undefined).join(' · ')
  if (name) parts.push([`[${name}]`])
  if (folder) parts.push([branch ? `${folder} git:(${branch})` : folder])
  if (ctx) {
    // Without a percent there is nothing to draw, and the line gives the tokens.
    const text = ctx.pct === undefined ? `context ${tok(ctx.tokens)}` : `context ${h.bars ? `${bar(ctx.pct)} ` : ''}${ctx.pct}%${ctx.window ? ` of ${windowSize(ctx.window)}` : ''}`
    parts.push([text, ctx.tone])
  }
  return [...parts, ...cache, ...(risk ? [risk] : [])]
}

/**
 * The plan's limits as parts of the line "plan", the week first: the week is the limit that is
 * hard to get back. `facts` is what `limitFacts` in claude-code.mjs gives. The words are those of
 * the one line, made short: the percent, how old the reading is, and how early the limit is full.
 */
export function limitBars(facts, h) {
  if (!facts.length) return [['plan limits not reported yet']]
  return [...facts].sort((a, b) => a.five - b.five).map(({ five, used, tone, read, early }) => {
    let text = `${five ? '5h' : 'week'} ${h.bars ? `${bar(used)} ` : ''}${used}%`
    if (read) text += ` (read ${read} ago)`
    if (early) text += `, full ${early} early`
    return [text, tone]
  })
}

/**
 * The line "plan": the plan's limits or the dollars, and today's tokens of all agents. `account`
 * is the name of the session's account, given only when more than one account was used: the
 * line then starts with it, "Widal, Inc. · week ...".
 */
function planLine({ account, limits, money, today }, h) {
  const parts = [...(limits ? limitBars(limits, h) : []), ...money]
  if (today) {
    const share = today.tokens > 0 && Number.isFinite(today.cacheRead) ? `, ${Math.round((100 * today.cacheRead) / today.tokens)}% from the cache` : ''
    parts.push([`today ${tok(today.tokens)} tokens${share}`])
  }
  if (account) {
    const name = cut(account, 40)
    if (parts.length) parts[0] = [`${name} · ${parts[0][0]}`, parts[0][1]]
    else parts.push([name])
  }
  return parts
}

/**
 * The part about the task list: the task in progress with how many are done, or "tasks done"
 * when all are done. Without names, or without a task in progress that has a name: the counts.
 */
function taskPart(tasks, names) {
  if (!tasks?.length) return undefined
  const all = tasks.length
  const done = tasks.filter((task) => task.status === 'completed').length
  if (done === all) return [`tasks done (${all}/${all})`]
  const now = names ? tasks.find((task) => task.status === 'in_progress' && task.name) : undefined
  return [now ? `▸ ${cut(now.name)} (${done}/${all})` : `tasks ${done}/${all}`]
}

/** The part about the agents that run: up to two by name, then how many more. Without names: how many. */
function agentPart(agents, names) {
  if (!agents?.length) return undefined
  if (!names) return [`${agents.length} ${agents.length === 1 ? 'agent' : 'agents'} running`]
  const shown = agents.slice(0, 2).map(({ type, description, min }) => `${cut(type ?? 'agent')}${description ? `: ${cut(description)}` : ''}${min !== undefined ? ` (${min} min)` : ''}`)
  if (agents.length > 2) shown.push(`+${agents.length - 2} more`)
  return [shown.join(', ')]
}

/** The line "work": the task list, the agents, the other open sessions, and a ticket that is open twice. */
function workLine({ tasks, agents, others, overlap }, h) {
  const parts = [taskPart(tasks, h.names), agentPart(agents, h.names)]
  const said = []
  if (others?.working) said.push(`${others.working} working`)
  if (others?.waiting) said.push(`${others.waiting} ${others.waiting === 1 ? 'waits' : 'wait'} for you`)
  if (said.length) parts.push([`other sessions: ${said.join(', ')}`, others.waiting ? 'warn' : undefined])
  // One folder by name is enough to see the overlap. More would not fit on the line.
  const [first, ...more] = overlap?.projects ?? []
  if (first) parts.push([`${overlap.ticket} is also open in ${first}${more.length ? ` and ${more.length} more` : ''}`, 'warn'])
  return parts.filter(Boolean)
}

const LINES = { session: sessionLine, plan: planLine, work: workLine, hint: (parts) => parts }

// The code that ends a colour.
const RESET = '\x1b[0m'

/**
 * The status line in lines. `data` has one function per line that gives what the line shows, so
 * that only the lines that are shown are worked out. `h` is what `hudConfig` gives, and `on` says
 * whether there are colours.
 *
 * A line with nothing to show is left out. A line that fails is left out too, and the others are
 * still shown. Parts are separated by " │ ". With colours, each part has its colour and each line
 * ends with a reset. No part keeps a control character.
 */
export function hudLines(data, h, on) {
  const out = []
  for (const name of h.lines) {
    let parts
    try {
      parts = LINES[name](data[name](), h)
    } catch {
      continue
    }
    if (!parts?.length) continue
    const line = parts.map(([text, tone]) => (on ? color(plain(text), tone) : plain(text))).join(' │ ')
    // A coloured last part already ends with a reset.
    out.push(on && !line.endsWith(RESET) ? `${line}${RESET}` : line)
  }
  return out.join('\n')
}

// A session is open while its status line has run in the last 2 minutes, and it is working while
// the status line saw a model call in the last 60 seconds. Otherwise it waits for the person.
const OPEN = 2 * 60e3
const WORKING = 60e3

/**
 * The other open sessions, from the files that the status line keeps: `{ others: { working,
 * waiting }, overlap }`. `dir` is the folder of the session files and `own` the name of this
 * session's file without ".json". `ticket` is this session's ticket: `overlap` is `{ ticket,
 * projects }` when another open session has the same one, else undefined. A file that cannot be
 * read, or that has no time in it, counts as a session that is not open.
 */
export function sessionsAround(dir, own, ticket, now) {
  let working = 0
  let waiting = 0
  const projects = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name === `${own}.json`) continue
    const s = readJson(join(dir, name))
    if (!isObject(s) || !Number.isFinite(s.at) || !(now - s.at < OPEN)) continue
    if (Number.isFinite(s.callAt) && now - s.callAt < WORKING) working += 1
    else waiting += 1
    if (ticket && s.ticket === ticket) projects.push(typeof s.project === 'string' && s.project ? s.project : 'another session')
  }
  return { others: { working, waiting }, overlap: projects.length ? { ticket, projects: [...new Set(projects)] } : undefined }
}

// "kestrel refresh-today" is started at most this often, also when it fails to write the file.
const START_EVERY = 2 * 60e3
// The command's file, next to this folder.
const COMMAND = fileURLToPath(new URL('../cli/kestrel.mjs', import.meta.url))

/**
 * Starts "kestrel refresh-today" in the background when today's numbers are missing or old, and
 * no start was made in the last 2 minutes. The time of the last start is kept in today.start, and
 * is saved before the start, so that a start that fails is not tried again on every run. The
 * status line never waits for the command. `spawner` stands in for `spawn` in a test. Returns
 * whether a start was made. It never throws.
 */
export function startToday(now, spawner = spawn) {
  try {
    if (!todayDue(now)) return false
    const mark = join(home(), 'today.start')
    const last = readJson(mark)
    // A time that lies ahead comes from a clock that was wrong. It does not count.
    if (Number.isFinite(last) && last <= now && now - last < START_EVERY) return false
    writeJson(mark, now)
    spawner(process.execPath, [COMMAND, 'refresh-today'], { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch {
    return false
  }
}

// The sample of the preview: a session on Opus 5.5 at effort high, in the folder my-app
// on the branch main, with 42% of a 1M context and a cache that lasts 52 more minutes. The week
// is at 85% and full early, the 5 hour limit at 33%, and all agents used 41M tokens today. A task
// list has 3 of 5 done, two agents run, another session waits, and the hint to compact is there.
const SAMPLE_TASKS = [
  { name: 'Reading the status line code', status: 'completed' },
  { name: 'Planning the lines', status: 'completed' },
  { name: 'Writing the bars', status: 'completed' },
  { name: 'Writing the tests', status: 'in_progress' },
  { name: 'Updating the guide', status: 'pending' },
]
const SAMPLE = {
  session: () => ({ model: 'Opus 5.5', effort: 'high', folder: 'my-app', branch: 'main', ctx: { tokens: 420000, pct: 42, window: 1e6 }, cache: [['cache warm, 52 min left', 'good']] }),
  plan: () => ({ limits: [{ five: false, used: 85, tone: 'bad', early: '2.2 days' }, { five: true, used: 33, tone: 'good' }], money: [], today: { tokens: 41e6, cacheRead: 39.4e6 } }),
  work: () => ({
    tasks: SAMPLE_TASKS,
    agents: [{ type: 'Explore', description: 'find where the hooks run', min: 4 }, { type: 'general-purpose', description: 'check the guide', min: 2 }],
    others: { working: 0, waiting: 1 },
  }),
  hint: () => [['context 420k: a good moment to /compact']],
}
// The same sample in the one line. The one line has no bars, no names, and no work line.
const SAMPLE_ONE = [
  ['5 hour limit 33% used, 60% of its time gone', 'good'],
  ['week 85% used, 59% of the week gone: full about 2.2 days early', 'bad'],
  ['cache warm, 52 min left', 'good'],
  ['context 420k (42%)'],
  ['effort high'],
  ['context 420k: a good moment to /compact'],
]

/** The status line as these settings show it, made with the sample data. */
export function hudPreview(h, on = false) {
  if (h.layout === 'one') return SAMPLE_ONE.map(([text, tone]) => (on ? color(text, tone) : text)).join(' | ')
  return hudLines(SAMPLE, h, on)
}

/** The settings in words. */
export function hudSettingsText(h) {
  if (h.layout === 'one') return 'The status line shows one line, with the parts separated by "|".'
  const which = h.lines.length === 1 ? `1 line: ${h.lines[0]}` : `${h.lines.length} lines, in this order: ${h.lines.join(', ')}`
  return `The status line shows ${which}. Bars ${h.bars ? 'on' : 'off'}. Names of tasks and agents ${h.names ? 'on' : 'off'}.`
}

const WHAT = [
  'What each line shows:',
  '  session  the model and its effort level, the folder and its git branch, the context, the cache',
  '  plan     the plan\'s limits (or the dollars, when you pay by the token), and today\'s tokens of all agents',
  '  work     the task in progress, the agents that run, the other open sessions, and a ticket that is open twice',
  '  hint     the hint about the effort level, and the hint to compact',
  'The names of tasks and agents show on your screen. Kestrel keeps them in no file. A computer linked to a Kestrel board sends them to the board too.',
]
const HOW = [
  'Change it with:',
  '  kestrel hud lines session,plan,work,hint   the lines to show, in this order (any of the four)',
  '  kestrel hud lines                          all four lines again',
  '  kestrel hud one                            one line',
  '  kestrel hud bars on|off                    bars for the context and the limits, or numbers only',
  '  kestrel hud names on|off                   the names of tasks and agents, or counts only',
  '  kestrel hud undo                           put back the settings from before the last change',
]

/** A wrong word: one sentence that lists the right ones. */
const wrong = (word, right) => new Error(`"${word}" is not one of ${right.join(', ')}.`)

/**
 * The command "kestrel hud". `args` are the words after "hud". It returns what to print, and
 * throws one plain sentence for a wrong word. `tty` says that the output goes to a terminal: only
 * there does the preview have colours.
 *
 *   (nothing)            the settings in words, a preview, what each line shows, and the commands
 *   lines [list]         the lines to show, in the given order; without a list all four
 *   one                  the one line
 *   bars on|off          bars or numbers only
 *   names on|off         names or counts only
 *   undo                 the settings from before the last change
 *
 * Each change prints the new preview and keeps the settings from before, for one step of undo.
 */
export function hudCommand(args, { tty = false } = {}) {
  const cfg = config()
  const h = hudConfig(cfg)
  const on = !!tty && colorOn(process.env, cfg)
  const preview = (settings) => ['Preview with sample data:', '', hudPreview(settings, on)]
  const [word, ...rest] = args
  if (word === undefined) return [hudSettingsText(h), '', ...preview(h), '', ...WHAT, '', ...HOW].join('\n')
  const nothingAfter = () => {
    if (rest.length) throw new Error(`"kestrel hud ${word}" takes no more words, and "${rest[0]}" was given.`)
  }
  if (word === 'undo') {
    nothingAfter()
    if (!Object.hasOwn(cfg, 'hudBefore')) return 'There is no change to take back.'
    const back = { ...cfg }
    if (isObject(cfg.hudBefore)) back.hud = cfg.hudBefore
    else delete back.hud
    delete back.hudBefore
    saveConfig(back)
    const restored = hudConfig(back)
    return [`The settings from before are back. ${hudSettingsText(restored)}`, '', ...preview(restored)].join('\n')
  }
  let next
  if (word === 'one') {
    nothingAfter()
    next = { ...h, layout: 'one' }
  } else if (word === 'lines') {
    // The list can be given with commas, with spaces, or both.
    const list = rest.join(',').split(',').map((name) => name.trim()).filter(Boolean)
    const bad = list.find((name) => !HUD_LINES.includes(name))
    if (bad) throw wrong(bad, HUD_LINES)
    next = { ...h, layout: 'lines', lines: list.length ? [...new Set(list)] : [...HUD_LINES] }
  } else if (word === 'bars' || word === 'names') {
    if (!rest.length) throw new Error(`"kestrel hud ${word}" needs one of on, off.`)
    if (rest[0] !== 'on' && rest[0] !== 'off') throw wrong(rest[0], ['on', 'off'])
    if (rest.length > 1) throw new Error(`"kestrel hud ${word} ${rest[0]}" takes no more words, and "${rest[1]}" was given.`)
    next = { ...h, [word]: rest[0] === 'on' }
  } else throw wrong(word, ['lines', 'one', 'bars', 'names', 'undo'])
  saveConfig({ ...cfg, hud: next, hudBefore: isObject(cfg.hud) ? cfg.hud : null })
  return [`Saved. ${hudSettingsText(next)}`, '', ...preview(next), '', 'Take it back with: kestrel hud undo'].join('\n')
}
