// Adds this tool to Claude Code's settings, and takes it out again.
//
// It changes three things in ~/.claude/settings.json: the status line, the three hooks of the
// security checks (see security.mjs), and (only while a limit is set) one hook before tool calls.
// Every change first saves a copy of the settings file in this
// tool's backup folder. Other hooks and settings are left as they are, also a hook of another
// tool that stands in one group with a hook of this tool.
//
// The settings file is the person's own, and other tools write it too. So this file is careful
// with it: a file is replaced as a whole and never written in place, a value that is not in the
// shape Claude Code writes is not changed, and a number is written back as it was read.
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { KESTREL_NAME, NAME, OLD_NAME, claudeDir, home } from './paths.mjs'
import { otherProgramAt, ownRest } from './links.mjs'

/** The file of Claude Code's user settings. */
export const settingsFile = () => join(claudeDir(), 'settings.json')
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

// This tool's own command in Claude Code's settings: the program "widal" or "widal.mjs", then
// "statusline", or "hook" and the name of a hook. The program is the first word of the command,
// with or without a folder in front, or the word after "node" (as in
// "node /x/cli/widal.mjs hook"). A program whose name only ends in the name, for example
// "other-widal", and a command that has the name only in an argument, for example
// "other-tool widal hook", belong to another tool. Their entries are never changed or taken out.
//
// The program can also have a name the tool had before it was called Widal.Code: kestrel, or
// agent-spend. An entry from that time is this tool's own as well, in every form the tool ever
// wrote: the link on the PATH, the link in the tool's own folder, the bare name and "node" with
// the command's file. So a change that was applied under an old name is still shown as applied
// and can still be taken back, before and after the move to the new name.
const OURS = new RegExp(`^(node )?(\\S*[/\\\\])?(${NAME}|${KESTREL_NAME}|${OLD_NAME})(\\.mjs)? (statusline|hook( [a-z-]+)?)$`)
// A program with an old name in another folder, such as /opt/other/kestrel, is this tool's only
// when no other program is at that path. A package named kestrel exists on npm, so another program
// with the name can be on the machine. The places this tool itself uses (see ownRest in links.mjs)
// always count.
//
// A program named widal is this tool's only at those places: the link in the tool's own folder,
// its own link on the PATH, and its own command file. Widal.Factory has a command named widal
// too, and can write entries of its own, such as "widal hook ..." with the bare word. Such an
// entry, and one with a path where nothing is, is never changed or taken out.
function ours(command) {
  if (typeof command !== 'string' || !OURS.test(command)) return false
  if (ownRest(command) !== undefined) return true
  const program = command.replace(/^node /, '').split(' ')[0]
  if (new RegExp(`(^|[/\\\\])${NAME}(\\.mjs)?$`).test(program)) return false
  return !/[/\\]/.test(program) || !otherProgramAt(program)
}

/** The name of one of this tool's hooks in its command: "keep-warm" for "... hook keep-warm", and "" for the hook that holds a limit ("... hook"). */
const hookName = (command) => / hook(?: ([a-z-]+))?$/.exec(command)?.[1] ?? ''

/**
 * The hook groups of one event without this tool's hooks, or without only its hook with the name
 * `name` when one is given. Claude Code's settings hold a list of groups per event, and each group
 * holds a list of hooks. A group can hold hooks of several tools, so only this tool's hooks are
 * taken out of it. A group that is then empty is dropped. A group without such a hook stays as it
 * is, and so does a group that is not in that shape. Two hooks of this tool can share an event (the
 * keep-warm hook and the security check both run when a turn ends): a change of one keeps the other.
 */
const withoutOurs = (groups, name) => groups.flatMap((group) => {
  if (!Array.isArray(group?.hooks)) return [group]
  const rest = group.hooks.filter((h) => !(ours(h?.command) && (name === undefined || hookName(h.command) === name)))
  if (rest.length === group.hooks.length) return [group]
  return rest.length ? [{ ...group, hooks: rest }] : []
})

/**
 * The hook groups of one event as they are in the settings: a list, empty when there is none.
 * It fails with one plain sentence when "hooks" is not an object, or when the event does not
 * hold a list. This tool then does not know what is there, and changes nothing.
 */
function groupsOf(s, event) {
  if (s.hooks !== undefined && !isObject(s.hooks)) throw new Error(`"hooks" in ${settingsFile()} is not an object, so this tool does not change it.`)
  const groups = s.hooks?.[event]
  if (groups !== undefined && !Array.isArray(groups)) throw new Error(`"hooks.${event}" in ${settingsFile()} is not a list, so this tool does not change it.`)
  return groups ?? []
}

/** The commands of the hooks of one event. Settings that are not in the shape Claude Code writes have none. */
function commandsOf(s, event) {
  const groups = isObject(s.hooks) ? s.hooks[event] : undefined
  return (Array.isArray(groups) ? groups : []).flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : [])).map((h) => h?.command)
}

/** Whether this tool's hook with this name is set for an event in Claude Code's settings: for example "keep-warm" for the event "Stop". */
export const hookSet = (event, name) => commandsOf(read(), event).some((command) => ours(command) && command.endsWith(` hook ${name}`))

/**
 * Keeps a whole number that is too large for a JavaScript number, and a number that is beyond
 * its range, as the text it has in the file. Read as a number and written again,
 * 12345678901234567890 would come back as 12345678901234567000. Node gives the text of a value
 * to this function from version 21 on. An older Node gives none: a number is then read as before.
 */
const keepLargeNumber = (key, value, context) =>
  typeof value === 'number' && !Number.isSafeInteger(value) && (Number.isInteger(value) || !Number.isFinite(value)) && typeof context?.source === 'string' && typeof JSON.rawJSON === 'function'
    ? JSON.rawJSON(context.source)
    : value

/**
 * Claude Code's user settings, as an object. An empty object when there is no file. A file that
 * is not JSON, or whose JSON is not an object (a list, text, null), fails with one plain
 * sentence: this tool cannot set a key in it, so it changes nothing.
 */
export function read() {
  let settings
  try {
    settings = JSON.parse(readFileSync(settingsFile(), 'utf8'), keepLargeNumber)
  } catch (e) {
    if (existsSync(settingsFile())) throw new Error(`${settingsFile()} is not valid JSON: ${e.message}`)
    return {}
  }
  if (!isObject(settings)) throw new Error(`${settingsFile()} does not hold a JSON object, so this tool does not change it.`)
  return settings
}

/**
 * Saves a copy of a file in this tool's backup folder. The copy's name is `name`, the time and
 * `ending`. A copy never takes the place of an earlier one: when two changes are made in the
 * same millisecond, the later copy gets a number after the time.
 */
function backup(file, name, ending) {
  const dir = join(home(), 'backup')
  mkdirSync(dir, { recursive: true })
  const time = new Date().toISOString().replace(/[:.]/g, '-')
  for (let n = 1; ; n++) {
    try {
      copyFileSync(file, join(dir, `${name}.${time}${n > 1 ? `-${n}` : ''}${ending}`), constants.COPYFILE_EXCL)
      return
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
  }
}

/**
 * Puts new text in the place of a file, as a whole: the text is written to a new file next to
 * it, and that file then takes its place. A crash in the middle of the write leaves the file as
 * it was, and no reader ever sees half of it. A file that is a link stays a link: the new text
 * goes to the file it points to. The file keeps its mode.
 */
function replaceFile(file, text) {
  const target = existsSync(file) ? realpathSync(file) : file
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : undefined
  const tmp = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, text)
    if (mode !== undefined) chmodSync(tmp, mode)
    renameSync(tmp, target)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/** Writes Claude Code's user settings, after saving a copy of the file as it was. */
export function write(settings) {
  if (existsSync(settingsFile())) backup(settingsFile(), 'settings', '.json')
  replaceFile(settingsFile(), `${JSON.stringify(settings, null, 2)}\n`)
}

/** The seconds of a refresh timer as they are in the settings. A value that is not a number is no timer. */
const seconds = (value) => (typeof value === 'number' ? value : 0)

/** The refresh timer of the status line in words, for the sentences of "install" and the row of "status". */
export const refreshText = (seconds) => (seconds > 0 ? `a refresh every ${seconds} ${seconds === 1 ? 'second' : 'seconds'}` : 'no refresh timer')

/**
 * Sets the status line. Returns what it did, in words. A status line of another tool is kept unless `force`.
 *
 * Claude Code runs the status line after each answer. With `refresh` it also runs it every that
 * many seconds, so that an idle session still shows the time its cache has left and the newest
 * reading of the plan's limits. `refresh: 0` sets no timer.
 */
export function installStatusLine(bin, { force = false, refresh = 30 } = {}) {
  const s = read()
  const now = s.statusLine?.command
  if (now && !ours(now) && !force) return `Claude Code already has a status line (${now}). It was kept. Use --force to replace it.`
  const command = `${bin} statusline`
  const before = seconds(s.statusLine?.refreshInterval)
  if (now === command && before === refresh) return `The status line was already set, with ${refreshText(refresh)}.`
  // What the person added to this tool's own status line, such as a padding, stays.
  const next = { ...(ours(now) ? s.statusLine : {}), type: 'command', command }
  if (refresh > 0) next.refreshInterval = refresh
  else delete next.refreshInterval
  s.statusLine = next
  write(s)
  if (now === command) return `The status line now has ${refreshText(refresh)} (before: ${refreshText(before)}).`
  return `The status line is set, with ${refreshText(refresh)}. Open sessions show it after their next answer.`
}

/** Adds or removes the hook that holds a limit. */
export function setHook(bin, on) {
  const s = read()
  const list = withoutOurs(groupsOf(s, 'PreToolUse'), '')
  const before = JSON.stringify(s.hooks ?? {})
  if (on) list.push({ matcher: '', hooks: [{ type: 'command', command: `${bin} hook`, timeout: 5 }] })
  s.hooks = { ...s.hooks, PreToolUse: list }
  if (!list.length) delete s.hooks.PreToolUse
  if (JSON.stringify(s.hooks) === before) return false
  write(s)
  return true
}

/** Takes the status line and this tool's hooks out again. Settings it changed stay: undo those with "widal undo". */
export function uninstall() {
  const s = read()
  let changed = false
  if (ours(s.statusLine?.command)) {
    delete s.statusLine
    changed = true
  }
  for (const [event, groups] of Object.entries(isObject(s.hooks) ? s.hooks : {})) {
    // An event that does not hold a list is not in the shape Claude Code writes. It stays.
    if (!Array.isArray(groups)) continue
    const list = withoutOurs(groups)
    // Nothing of this tool in this event: its groups stay exactly as they are.
    if (JSON.stringify(list) === JSON.stringify(groups)) continue
    s.hooks[event] = list
    if (!list.length) delete s.hooks[event]
    changed = true
  }
  if (changed) write(s)
  return changed
}

/** What is installed now. `refresh` is the seconds between two runs of this tool's status line, 0 without a timer. */
export function installed() {
  const s = read()
  return {
    statusLine: ours(s.statusLine?.command),
    otherStatusLine: s.statusLine?.command && !ours(s.statusLine.command) ? s.statusLine.command : undefined,
    // The hook that holds a limit. The gate of the security checks is a hook before tool calls too, with a name.
    hook: commandsOf(s, 'PreToolUse').some((command) => ours(command) && hookName(command) === ''),
    refresh: ours(s.statusLine?.command) ? seconds(s.statusLine.refreshInterval) : 0,
  }
}

/**
 * The hooks of the security checks, which "widal connect" puts into Claude Code's settings: the
 * check of the settings when a session starts, the checks of a turn when it ends, and the gate before
 * a shell command. Each is [event, name, matcher]. The plugin carries the same three.
 */
export const SECURITY_HOOKS = [['SessionStart', 'check-settings'], ['Stop', 'check-turn'], ['PreToolUse', 'push-gate', 'Bash']]

/**
 * Adds the hooks of the security checks to Claude Code's settings, in one write, or takes them out
 * with `on` false. A hook of this tool with the same name is replaced, and other hooks stay.
 * Returns whether the file changed.
 */
export function setSecurityHooks(bin, on = true) {
  const s = read()
  const before = JSON.stringify(s.hooks ?? {})
  const hooks = { ...s.hooks }
  for (const [event, name, matcher] of SECURITY_HOOKS) {
    const list = withoutOurs(groupsOf(s, event), name)
    if (on) list.push({ ...(matcher && { matcher }), hooks: [{ type: 'command', command: `${bin} hook ${name}`, timeout: 5 }] })
    if (list.length) hooks[event] = list
    else delete hooks[event]
  }
  if (JSON.stringify(hooks) === before) return false
  s.hooks = hooks
  write(s)
  return true
}

/**
 * Sets one top-level key of Claude Code's settings. `undefined` takes the key out.
 * Returns the value it had before, or undefined.
 */
export function setSetting(key, value) {
  const s = read()
  const before = s[key]
  if (value === undefined) delete s[key]
  else s[key] = value
  if (JSON.stringify(before) !== JSON.stringify(value)) write(s)
  return before
}

/**
 * Adds or removes this tool's hook for one event, for example PreModelSwitch. Other hooks stay.
 * `timeout` is the seconds the hook may run. `extra` holds more fields for the hook's entry, for
 * example `{ asyncRewake: true }` for a hook that waits in the background.
 */
export function setEventHook(event, command, on, timeout = 5, extra = {}) {
  const s = read()
  const list = withoutOurs(groupsOf(s, event), hookName(command))
  const before = JSON.stringify(s.hooks ?? {})
  if (on) list.push({ hooks: [{ type: 'command', command, ...extra, timeout }] })
  s.hooks = { ...s.hooks, [event]: list }
  if (!list.length) delete s.hooks[event]
  if (JSON.stringify(s.hooks) === before) return false
  write(s)
  return true
}

/**
 * Sets one key inside the "env" object of Claude Code's settings. The other keys of "env" stay.
 * `undefined` takes the key out. With `dropEmpty`, an "env" that is then empty is taken out too:
 * that puts the settings back when there was no "env" before.
 * Returns the value the key had before, or undefined. It fails with one plain sentence when
 * "env" is there and is not an object: a key cannot be set in text or in a list.
 */
export function setEnvSetting(key, value, dropEmpty = false) {
  const s = read()
  if (s.env !== undefined && !isObject(s.env)) throw new Error(`"env" in ${settingsFile()} is not an object, so "${key}" cannot be set in it.`)
  const before = s.env?.[key]
  if (before === value) return before
  if (value === undefined) {
    delete s.env[key]
    if (dropEmpty && !Object.keys(s.env).length) delete s.env
  } else s.env = { ...s.env, [key]: value }
  write(s)
  return before
}

/**
 * The file of one of the person's own subagents, <Claude Code's folder>/agents/<name>.md, or
 * undefined when there is none. A kind of subagent that is built into Claude Code has no file.
 */
export function agentFile(name) {
  const file = join(claudeDir(), 'agents', `${name}.md`)
  return name === basename(name) && existsSync(file) ? file : undefined
}

// The front matter of a subagent's file is the block of "key: value" lines between two lines of
// "---" at its top. `end` is the index of the closing line, or -1 when there is no front matter.
function frontMatter(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const fence = (line) => line.replace(/^\uFEFF/, '').trimEnd() === '---'
  const end = fence(lines[0]) ? lines.findIndex((line, i) => i > 0 && fence(line)) : -1
  const at = (key) => lines.findIndex((line, i) => i > 0 && i < end && line.startsWith(`${key}:`))
  return { lines, end, at }
}

/** Whether a subagent's file has front matter. False for a file that is gone. */
export function hasFrontMatter(file) {
  try {
    return frontMatter(file).end >= 0
  } catch {
    return false
  }
}

/** The line of one key in the front matter of a subagent's file, for example "model: sonnet". Undefined when it is not there. */
export function agentLine(file, key) {
  try {
    const { lines, at } = frontMatter(file)
    return lines[at(key)]?.replace(/\r$/, '')
  } catch {
    return undefined // No such file.
  }
}

/**
 * Sets the line of one key in the front matter of a subagent's file. `undefined` takes the line
 * out. The file is copied to this tool's backup folder first, and the rest of the file stays as
 * it is. Returns the line as it was before, or undefined when the key was not there.
 */
export function setAgentLine(file, key, line) {
  const { lines, end, at } = frontMatter(file)
  if (end < 0) throw new Error(`${file} has no front matter (the lines between "---" at its top), so "${key}:" cannot be set in it.`)
  const i = at(key)
  const before = i >= 0 ? lines[i].replace(/\r$/, '') : undefined
  if (before === line) return before
  // A file with Windows line ends keeps them.
  const ending = lines[0].endsWith('\r') ? '\r' : ''
  if (line === undefined) lines.splice(i, 1)
  else if (i >= 0) lines[i] = line + ending
  else lines.splice(end, 0, line + ending)
  backup(file, `agent-${basename(file, '.md')}`, '.md')
  replaceFile(file, lines.join('\n'))
  return before
}
