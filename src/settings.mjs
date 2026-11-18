// Every setting a person may change, in one place, and the command "widal settings".
//
// Each setting has a key, a plain label, a group, the values it takes and the value it has now.
// "widal settings --json" gives them all as data, for the pane in Claude Code. "widal settings
// set <key> <value>" changes one and keeps what was there before, so that "widal settings undo"
// puts it back (one step). In a terminal, "widal settings" alone is a list to move through and
// change with the keys.
//
// The settings live where the older commands keep them, so "widal hud", "widal hint" and
// "widal nudge" change the same ones: `hud`, `hint`, `compactHint` and `nudge` in this tool's
// config. The security frameworks and checks are new: `security` in the config, for the person.
// The frameworks can be set for one repository instead, in <folder>/.claude/loobster-frameworks.json,
// the file the owner's other plugin already uses. When that file names frameworks, it wins over
// the person's setting for that repository.
//
// The checks themselves are in other files: the local checks in src/security.mjs, the cloud checks in
// src/cloud.mjs, and what they found in src/findings.mjs. Wherever the choices or the findings show, one
// sentence says that Widal.Code checks technical controls and does not certify anything.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compactHintConfig } from './compact.mjs'
import { config, readJson, saveConfig, writeJson } from './config.mjs'
import { plain, table } from './format.mjs'
import { hintConfig } from './hint.mjs'
import { HUD_LINES, hudConfig } from './hud.mjs'
import { nudgeConfig } from './nudge.mjs'
import { home } from './paths.mjs'
import { labelOf, readAccounts } from './accounts.mjs'
import { CHECK_NOTE } from './finding-words.mjs'

/** The one sentence that goes with the frameworks, the checks and every list of findings, the same in every place (finding-words.mjs). */
export const CHECKS_NOTE = CHECK_NOTE

/** The security frameworks in their groups: [group, [[id, label], ...]]. */
export const FRAMEWORKS = [
  ['Healthcare', [['hipaa', 'HIPAA'], ['hitrust', 'HITRUST CSF'], ['soc2', 'SOC 2'], ['iso27001', 'ISO 27001']]],
  ['Life sciences', [['part11', '21 CFR Part 11'], ['annex11', 'EU GMP Annex 11'], ['gdpr', 'GDPR']]],
  ['Fintech', [['pci', 'PCI DSS'], ['glba', 'GLBA Safeguards Rule'], ['nydfs', 'NYDFS 23 NYCRR 500'], ['dora', 'EU DORA']]],
  ['AI agents', [['owasp-agentic', 'OWASP Top 10 for Agentic Applications'], ['owasp-llm', 'OWASP Top 10 for LLM Applications'], ['nist-ai-rmf', 'NIST AI RMF'], ['iso42001', 'ISO/IEC 42001']]],
]
const FRAMEWORK_IDS = FRAMEWORKS.flatMap(([, list]) => list.map(([id]) => id))
const FRAMEWORK_LABEL = Object.fromEntries(FRAMEWORKS.flatMap(([, list]) => list))

/** The frameworks that are on for everyone who has chosen nothing. */
export const DEFAULT_FRAMEWORKS = ['owasp-agentic']

/** The sets: each switches several frameworks on at once. It switches none off. */
export const SETS = {
  healthcare: { label: 'Healthcare', frameworks: ['hipaa', 'soc2', 'hitrust'] },
  'life-sciences': { label: 'Life sciences', frameworks: ['part11', 'annex11', 'soc2'] },
  fintech: { label: 'Fintech', frameworks: ['soc2', 'pci', 'glba'] },
}

/** The checks: [id, label, on by default]. The data check reads the text of sessions, so it is off until the person turns it on. */
export const CHECKS = [
  ['settings', 'Settings', true],
  ['actions', 'Actions', true],
  ['code', 'Code', true],
  ['data', 'Data (it reads the text of sessions)', false],
  ['cloud', 'Cloud (only on request)', false],
  ['push', 'The gate before a push', true],
]

const ON_OFF = ['on', 'off']
const LINE_LABELS = {
  session: 'Line "session": the model, the folder, the context, the cache',
  plan: 'Line "plan": the plan\'s limits or the dollars, and today\'s tokens',
  work: 'Line "work": the task, the agents, the other sessions',
  hint: 'Line "hint": the hints',
}
// The words for the two layouts, where a sentence says which one is set.
const LAYOUT_WORDS = { lines: 'up to four lines', one: 'one line' }

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const onOff = (v) => (v ? 'on' : 'off')
/** A list of names in words: "a", "a and b", "a, b and c". */
const inWords = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? 'none')

/** The security settings of the person: `{ frameworks, checks }`, with the defaults for what is not set. */
export function securityConfig(cfg = config()) {
  const s = isObject(cfg?.security) ? cfg.security : {}
  const frameworks = Array.isArray(s.frameworks) ? FRAMEWORK_IDS.filter((id) => s.frameworks.includes(id)) : [...DEFAULT_FRAMEWORKS]
  const checks = Object.fromEntries(CHECKS.map(([id, , on]) => [id, typeof s.checks?.[id] === 'boolean' ? s.checks[id] : on]))
  return { frameworks, checks }
}

/** The file that holds the frameworks of one repository. */
export const projectFile = (folder) => join(folder, '.claude', 'loobster-frameworks.json')

/**
 * A repository's file as `{ exists, value }`. A file that is missing is an empty object. A file that
 * is there and is not a JSON object fails with one sentence, and is never written over.
 */
function readProject(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, value: {} }
    throw new Error(`${file} cannot be read (${e.code ?? e.message}).`)
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`${file} is not valid JSON, so Widal.Code leaves it as it is.`)
  }
  if (!isObject(value)) throw new Error(`${file} does not hold a JSON object, so Widal.Code leaves it as it is.`)
  return { exists: true, value }
}

/** Writes a repository's file through a temp file and a rename, readable for a person, with every other key kept as it was. */
function writeProject(file, value) {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, file)
}

/** A folder given with --project, as an absolute path. It has to be there. */
export function projectFolder(folder) {
  const path = resolve(String(folder))
  if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`The folder ${path} is not there.`)
  return path
}

/**
 * The frameworks that are on for a repository, and where they come from: `{ on, from, file }`.
 * `from` is "project" when the repository's file names frameworks, else "person". Without a
 * folder it is the person's own setting.
 */
export function frameworksFor(cfg, folder) {
  const own = securityConfig(cfg).frameworks
  if (!folder) return { on: own, from: 'person', file: undefined }
  const file = projectFile(folder)
  const { value } = readProject(file)
  if (!Array.isArray(value.frameworks)) return { on: own, from: 'person', file }
  return { on: FRAMEWORK_IDS.filter((id) => value.frameworks.includes(id)), from: 'project', file }
}

/** Every setting with its key, label, group, kind, values, value now and default. */
function settingsList(cfg, fw) {
  const h = hudConfig(cfg)
  const sec = securityConfig(cfg)
  const list = [
    { key: 'hud.layout', group: 'Status line', label: 'Layout of the status line', values: ['lines', 'one'], value: h.layout, default: 'lines' },
    ...HUD_LINES.map((line) => ({ key: `hud.lines.${line}`, group: 'Status line', label: LINE_LABELS[line], values: ON_OFF, value: onOff(h.lines.includes(line)), default: 'on' })),
    { key: 'hud.bars', group: 'Status line', label: 'Bars for the context and the limits', values: ON_OFF, value: onOff(h.bars), default: 'on' },
    { key: 'hud.names', group: 'Status line', label: 'Names of tasks and agents, on your screen (and on the Widal.Code board, when linked)', values: ON_OFF, value: onOff(h.names), default: 'on' },
    { key: 'hint.effort', group: 'Hints', label: 'The hint about the effort level', values: ON_OFF, value: onOff(hintConfig(cfg).on), default: 'on' },
    { key: 'hint.compact', group: 'Hints', label: 'The hint to compact', values: ON_OFF, value: onOff(compactHintConfig(cfg).on), default: 'on' },
    { key: 'hint.nudge', group: 'Hints', label: 'The notification before a cache ends', values: ON_OFF, value: onOff(nudgeConfig(cfg).on), default: 'off' },
    ...FRAMEWORKS.flatMap(([group, frameworks]) => frameworks.map(([id, label]) => ({
      key: `security.frameworks.${id}`, group: `Frameworks: ${group}`, label, values: ON_OFF, value: onOff(fw.on.includes(id)), default: onOff(DEFAULT_FRAMEWORKS.includes(id)),
    }))),
    ...CHECKS.map(([id, label, on]) => ({ key: `security.checks.${id}`, group: 'Checks', label, values: ON_OFF, value: onOff(sec.checks[id]), default: onOff(on) })),
  ]
  return list.map((s) => ({ ...s, kind: s.values === ON_OFF ? 'on-off' : 'choice' }))
}

/** The keys of every setting, in the order they are listed. */
export const SETTING_KEYS = settingsList({}, { on: [] }).map((s) => s.key)

// The file that keeps what the last change found, for one step of undo.
const undoFile = () => join(home(), 'settings-undo.json')

/** Keeps what one change is about to replace: a top-level key of the config, or the frameworks of a repository's file. */
function keep(record) {
  mkdirSync(home(), { recursive: true })
  writeJson(undoFile(), record)
}

/** Changes one top-level key of the config, after keeping its value from before. */
function saveKey(key, value, what) {
  const cfg = config()
  keep({ target: 'config', key, had: Object.hasOwn(cfg, key), before: cfg[key], what })
  saveConfig({ ...cfg, [key]: value })
}

/**
 * Changes the list of frameworks, for the person or for a repository. `change` gets the list as it
 * is and gives the new one. In a repository's file the frameworks start from what is on there
 * now: its own list, or else the person's, so that what the person sees is what is saved. Ids that
 * Widal.Code does not know stay in that file. Returns whether anything changed.
 */
function changeFrameworks(change, folder, what) {
  const order = (list) => [...FRAMEWORK_IDS.filter((id) => list.includes(id)), ...list.filter((id) => !FRAMEWORK_IDS.includes(id))]
  if (!folder) {
    const cfg = config()
    const now = securityConfig(cfg).frameworks
    const next = order(change(now))
    if (next.join() === now.join()) return false
    saveKey('security', { ...(isObject(cfg.security) ? cfg.security : {}), frameworks: next }, what)
    return true
  }
  const file = projectFile(folder)
  const { exists, value } = readProject(file)
  const had = Array.isArray(value.frameworks)
  const now = had ? value.frameworks.filter((id) => typeof id === 'string') : securityConfig().frameworks
  const next = order(change(now))
  if (had && next.join() === value.frameworks.join()) return false
  keep({ target: 'project', file, existed: exists, had: Object.hasOwn(value, 'frameworks'), before: value.frameworks, what })
  writeProject(file, { ...value, frameworks: next })
  return true
}

/**
 * Changes one setting. `key` and `value` are as "widal settings set" takes them. `project` is
 * the folder of a repository, for the frameworks only. Returns the lines to print. A wrong key or
 * value fails with one plain sentence, and nothing is saved.
 */
export function setSetting(key, value, { project } = {}) {
  const undoLine = 'Take it back with: widal settings undo'
  const where = project ? ` for ${project}` : ''
  const written = project ? [`Written to ${projectFile(project)}.`] : []
  if (key === 'security.set') {
    const set = SETS[value]
    if (!set) throw new Error(`"${value}" is not a set. The sets are: ${Object.keys(SETS).join(', ')}.`)
    const labels = set.frameworks.map((id) => FRAMEWORK_LABEL[id])
    const what = `the ${set.label} set`
    if (!changeFrameworks((list) => [...list, ...set.frameworks], project, what)) return `The frameworks of the ${set.label} set were already on${where}. Nothing changed.`
    return [`Saved${where}: the ${set.label} set switched on ${inWords(labels)}.`, ...written, CHECKS_NOTE, undoLine].join('\n')
  }
  const setting = settingsList({}, { on: [] }).find((s) => s.key === key)
  if (!setting) throw new Error(`"${key}" is not a setting. See them all with: widal settings`)
  if (!setting.values.includes(value)) throw new Error(`"${value}" is not a value of ${key}. Use one of: ${setting.values.join(', ')}.`)
  const framework = key.startsWith('security.frameworks.')
  if (project && !framework) throw new Error(`Only the frameworks can be set for a project. Set ${key} without --project.`)
  const on = value === 'on'
  const what = `${setting.label}: ${key === 'hud.layout' ? LAYOUT_WORDS[value] : value}`
  const cfg = config()

  if (framework) {
    const id = key.slice('security.frameworks.'.length)
    if (!changeFrameworks((list) => (on ? [...list, id] : list.filter((x) => x !== id)), project, what)) return `${setting.label} was already ${value}${where}. Nothing changed.`
    return [`Saved${where}: ${what}.`, ...written, CHECKS_NOTE, undoLine].join('\n')
  }
  if (key.startsWith('security.checks.')) {
    const id = key.slice('security.checks.'.length)
    const s = isObject(cfg.security) ? cfg.security : {}
    saveKey('security', { ...s, checks: { ...(isObject(s.checks) ? s.checks : {}), [id]: on } }, what)
    return [`Saved: ${what}.`, CHECKS_NOTE, undoLine].join('\n')
  }
  if (key.startsWith('hud.')) {
    const h = hudConfig(cfg)
    let next
    if (key === 'hud.layout') next = { ...h, layout: value }
    else if (key === 'hud.bars' || key === 'hud.names') next = { ...h, [key.slice(4)]: on }
    else {
      const line = key.slice('hud.lines.'.length)
      const lines = h.lines.filter((l) => l !== line)
      if (on) {
        // A line that comes back takes its place after the lines that come before it in the usual order.
        const rank = HUD_LINES.indexOf(line)
        lines.splice(lines.reduce((at, l, i) => (HUD_LINES.indexOf(l) < rank ? i + 1 : at), 0), 0, line)
      } else if (!lines.length) {
        throw new Error('At least one line of the status line stays on. For one line, use: widal settings set hud.layout one')
      }
      next = { ...h, lines }
    }
    saveKey('hud', next, what)
    return [`Saved: ${what}.`, undoLine].join('\n')
  }
  // The hints: each keeps its other settings as they are.
  const configKey = { 'hint.effort': 'hint', 'hint.compact': 'compactHint', 'hint.nudge': 'nudge' }[key]
  saveKey(configKey, { ...(isObject(cfg[configKey]) ? cfg[configKey] : {}), on }, what)
  return [`Saved: ${what}.`, undoLine].join('\n')
}

/** Puts back what the last "widal settings set" replaced. One step: a second undo has nothing left to take back. */
export function undoSetting() {
  const record = readJson(undoFile())
  if (!isObject(record) || !['config', 'project'].includes(record.target)) return 'There is no change to take back.'
  if (record.target === 'config') {
    const back = { ...config() }
    if (record.had) back[record.key] = record.before
    else delete back[record.key]
    saveConfig(back)
  } else {
    const { exists, value } = readProject(record.file)
    const back = { ...value }
    if (record.had) back.frameworks = record.before
    else delete back.frameworks
    // A file that this tool made, and that holds nothing else, goes again.
    if (!record.existed && !Object.keys(back).length) {
      if (exists) unlinkSync(record.file)
    } else writeProject(record.file, back)
  }
  unlinkSync(undoFile())
  return `Taken back: ${plain(record.what ?? 'the last change')}. The setting is as it was before.`
}

// The command's own file, to ask it for the accounts.
const COMMAND = fileURLToPath(new URL('../cli/widal.mjs', import.meta.url))
const text = (v) => (typeof v === 'string' && v ? plain(v) : null)

/**
 * The accounts that Widal.Code knows, from its own small file accounts.json, in the shape of
 * "widal accounts --json". Reading all logs for this would make the settings slow to open.
 */
function fromFile() {
  const { accounts } = readAccounts()
  const list = [...accounts.entries()].map(([key, e]) => ({ key, label: labelOf(key), tool: key.startsWith('cowork:') ? 'Cowork' : key.startsWith('codex:') ? 'Codex' : 'Claude Code', kind: null, plan: e?.seatTier ?? null }))
  return { status: 0, stdout: JSON.stringify({ accounts: list }) }
}

/**
 * The accounts with their labels, from "widal accounts --json", or null when that command is not
 * there or gives no list. Only what a label needs is kept: the key, the label, the tool, the kind
 * and the plan. `run` stands in for running the command in a test.
 */
export function accountsNow(run = fromFile) {
  try {
    const r = run()
    if (r.status !== 0) return null
    const data = JSON.parse(r.stdout)
    if (!Array.isArray(data?.accounts)) return null
    return data.accounts.filter((a) => isObject(a) && text(a.key)).map((a) => ({ key: text(a.key), label: text(a.label), tool: text(a.tool), kind: text(a.kind), plan: text(a.plan) }))
  } catch {
    return null
  }
}

/**
 * All settings as data: `{ settings, sets, frameworks, note, accounts, undo }`. `project` is the
 * folder of a repository: the frameworks are then those of that repository. `accounts` is what
 * `accountsNow` gives.
 */
export function settingsData({ project, accounts = null } = {}) {
  const cfg = config()
  const fw = frameworksFor(cfg, project)
  return {
    settings: settingsList(cfg, fw),
    sets: Object.entries(SETS).map(([name, s]) => ({ key: 'security.set', value: name, label: s.label, frameworks: s.frameworks })),
    frameworks: { on: fw.on, from: fw.from, file: fw.file ?? null, project: project ?? null },
    note: CHECKS_NOTE,
    accounts,
    undo: existsSync(undoFile()),
  }
}

/** The words for a setting's value in a list: "on", "off", or the layout in words. */
const valueWords = (s) => (s.key === 'hud.layout' ? `${s.value} (${LAYOUT_WORDS[s.value]})` : s.value)

/** The settings as text, with the commands that change them. `cwd` is the folder the command runs in. */
export function settingsText(data, { cwd = process.cwd() } = {}) {
  const rows = []
  let group
  for (const s of data.settings) {
    if (s.group !== group) {
      if (group) rows.push([''])
      group = s.group
      rows.push([group])
    }
    rows.push([`  ${s.key}`, valueWords(s), s.label])
  }
  const out = ['Widal.Code settings. Change one with: widal settings set <key> <value>', '', table(rows), '']
  out.push('Sets switch several frameworks on at once:')
  out.push(table(data.sets.map((s) => [`  widal settings set security.set ${s.value}`, s.frameworks.map((id) => FRAMEWORK_LABEL[id]).join(', ')])), '')
  out.push(CHECKS_NOTE)
  const fw = data.frameworks
  if (fw.project) out.push(fw.from === 'project' ? `The frameworks above are those of ${fw.project}, from ${fw.file}.` : `The frameworks above are your own: ${fw.file} names none.`)
  else if (existsSync(projectFile(cwd))) out.push(`This folder has frameworks of its own in ${projectFile(cwd)}. Show them with: widal settings --project .`)
  out.push('For one repository, add --project <folder>. The frameworks then go to <folder>/.claude/loobster-frameworks.json, and that file wins over your own setting there.')
  if (data.accounts?.length) {
    out.push('', 'Accounts:', table(data.accounts.map((a) => [`  ${a.key}`, a.label ?? ''])), 'Change a label with: widal accounts label <key> "<label>"')
  }
  out.push('', 'Take the last change back with: widal settings undo')
  return out.join('\n')
}

// The terminal's other screen and the cursor, as in "widal top".
const ENTER = '\x1b[?1049h\x1b[?25l'
const LEAVE = '\x1b[?25h\x1b[?1049l'
const SIGNALS = ['SIGTERM', 'SIGHUP']
const HELP = 'Widal.Code settings · up and down (or j and k) move, space or Enter changes, u undoes, q quits'

/** The rows of the list: a heading for each group, a row for each setting, and the sets after the frameworks. */
function listRows(data) {
  const rows = []
  let group
  for (const s of data.settings) {
    if (s.group !== group) {
      if (group?.startsWith('Frameworks:') && !s.group.startsWith('Frameworks:')) {
        rows.push({ head: 'Sets: each switches several frameworks on' })
        for (const set of data.sets) rows.push({ set })
      }
      group = s.group
      rows.push({ head: group })
    }
    rows.push({ setting: s })
  }
  return rows
}

/** One row of the list as a line. */
function rowLine(row, here) {
  if (row.head) return row.head
  const mark = here ? '> ' : '  '
  if (row.set) return `${mark}${row.set.label}: ${row.set.frameworks.map((id) => FRAMEWORK_LABEL[id]).join(', ')}`
  const s = row.setting
  return s.kind === 'on-off' ? `${mark}[${s.value === 'on' ? 'x' : ' '}] ${s.label}` : `${mark}${s.label}: ${valueWords(s)}`
}

/** The value a setting gets when it is changed in the list: on and off swap, a choice moves to the next one. */
const nextValue = (s) => s.values[(s.values.indexOf(s.value) + 1) % s.values.length]

/**
 * The list in a terminal. Up and down (and j, k) move, space or Enter toggles a setting, cycles a
 * choice or switches a set on, u undoes, q or Ctrl+C quits. The terminal is put back as it was
 * after q, Ctrl+C, a signal and an error. `project` is the folder of a repository for the frameworks.
 */
export async function settingsLive({ input, output, project, accounts = null }) {
  let data = settingsData({ project, accounts })
  let rows = listRows(data)
  let at = rows.findIndex((r) => !r.head)
  let message = ''
  let failure
  let finish
  const done = new Promise((r) => (finish = r))

  const view = () => {
    const lines = rows.map((r, i) => rowLine(r, i === at))
    const foot = ['', CHECKS_NOTE]
    if (data.frameworks.project) foot.push(`Frameworks for ${data.frameworks.project}.`)
    if (data.accounts?.length) foot.push(`Accounts: ${data.accounts.map((a) => `${a.label ?? a.key}`).join(', ')}. Change a label with: widal accounts label <key> "<label>"`)
    foot.push(message)
    // Only the rows that fit are drawn, with the cursor's row among them.
    const room = Math.max(3, (output.rows ?? 24) - foot.length - 2)
    const first = Math.max(0, Math.min(at - Math.floor(room / 2), lines.length - room))
    return [HELP, '', ...lines.slice(first, first + room), ...foot]
  }
  const draw = () => output.write(`\x1b[H${view().map((line) => `${line}\x1b[K`).join('\r\n')}\x1b[J`)
  const reload = () => {
    data = settingsData({ project, accounts })
    rows = listRows(data)
  }
  const move = (step) => {
    let i = at + step
    while (rows[i]?.head) i += step
    if (rows[i]) at = i
  }
  const change = () => {
    const row = rows[at]
    try {
      const said = row.set
        ? setSetting('security.set', row.set.value, { project })
        : setSetting(row.setting.key, nextValue(row.setting), { project: row.setting.key.startsWith('security.frameworks.') ? project : undefined })
      message = said.split('\n')[0]
    } catch (e) {
      message = e.message
    }
    reload()
  }
  const quit = () => finish()
  const onKey = (chunk) => {
    try {
      // One chunk can hold several keys. The arrow keys come as three characters each.
      let keys = String(chunk)
      while (keys) {
        const arrow = keys.startsWith('\x1b[A') ? -1 : keys.startsWith('\x1b[B') ? 1 : 0
        const key = arrow ? '' : keys[0]
        keys = keys.slice(arrow ? 3 : 1)
        if (arrow) move(arrow)
        else if (key === 'k') move(-1)
        else if (key === 'j') move(1)
        else if (key === ' ' || key === '\r' || key === '\n') change()
        else if (key === 'u') {
          message = undoSetting()
          reload()
        } else if (key === 'q' || key === 'Q' || key === '\x03') return quit()
      }
      draw()
    } catch (e) {
      failure = e
      quit()
    }
  }

  const wasRaw = !!input.isRaw
  output.write(ENTER)
  try {
    input.setRawMode(true)
    input.on('data', onKey)
    input.resume?.()
    for (const signal of SIGNALS) process.on(signal, quit)
    draw()
    await done
  } finally {
    // The terminal is put back as it was, also after an error.
    for (const signal of SIGNALS) process.off(signal, quit)
    input.off('data', onKey)
    try {
      input.setRawMode(wasRaw)
    } finally {
      input.pause?.()
      output.write(LEAVE)
    }
  }
  if (failure) throw failure
}

/**
 * The command "widal settings". `args` are the words after "settings". Returns what to print,
 * or nothing when the list in the terminal ran. A wrong word, key or value fails with one plain
 * sentence.
 *
 *   (nothing)                the settings: as JSON with `json`, as the list in a terminal, else as text
 *   set <key> <value>        change one
 *   undo                     put back what the last change replaced
 *
 * `project` is the folder that --project names. `input` and `output` stand in for the terminal,
 * and `loadAccounts` for asking "widal accounts --json".
 */
export async function settingsCommand(args, { json = false, project, input = process.stdin, output = process.stdout, loadAccounts = accountsNow } = {}) {
  if (project === true) throw new Error('--project needs a folder, for example: widal settings --project .')
  const folder = project === undefined ? undefined : projectFolder(project)
  const [word, ...rest] = args
  if (word === undefined) {
    if (json) return JSON.stringify(settingsData({ project: folder, accounts: loadAccounts() }))
    if (output.isTTY && input.isTTY && typeof input.setRawMode === 'function') return settingsLive({ input, output, project: folder, accounts: loadAccounts() })
    return settingsText(settingsData({ project: folder, accounts: loadAccounts() }))
  }
  if (word === 'set') {
    if (rest.length !== 2) throw new Error('Use "widal settings set <key> <value>", for example: widal settings set security.frameworks.hipaa on')
    return setSetting(rest[0], rest[1], { project: folder })
  }
  if (word === 'undo') {
    if (rest.length) throw new Error(`"widal settings undo" takes no more words, and "${rest[0]}" was given.`)
    return undoSetting()
  }
  throw new Error(`"${word}" is not one of set, undo. Use "widal settings", "widal settings set <key> <value>" or "widal settings undo".`)
}
