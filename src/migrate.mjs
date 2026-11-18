// The move of an install that was made under one of this tool's old names to the name Widal.Code.
// The tool was called agent-spend until 13 Nov 2026, and Kestrel until 17 Nov 2026.
//
// "widal migrate" runs the move, and "widal connect" runs it first. It also runs on its own: at
// the first command a person types, and in the plugin's hook at the start of a session (see
// cli/widal.mjs). The status line and the other hooks never run it.
//
// An install under an old name has these things that carry the name: the folder ~/.kestrel (or
// ~/.agent-spend) with everything the tool keeps, the link in it that Claude Code's settings call
// (bin/kestrel), the links on the PATH that put the command there (~/.local/bin/kestrel and
// ~/.local/bin/agent-spend), the entries in Claude Code's settings that call one of them (the
// status line and the hooks), and the board's old address in board.json. The move brings each of
// them to the new name, in that order.
//
// The entries in the settings end up calling the link in the tool's own folder,
// ~/.widal/bin/widal, and never a link on the PATH: another program named widal can be on the
// PATH. See links.mjs.
//
// Sessions that are open during the move go on calling the old command every few seconds, as
// ~/.kestrel/bin/kestrel: Claude Code reads a session's hooks when the session starts. So the move
// takes nothing away that they use. The folder is renamed in one step, and the old folder's name
// is left as a link to ~/.widal for one release. So ~/.kestrel/bin/kestrel is still there (it is
// ~/.widal/bin/kestrel), and it runs the program. The links on the PATH under the old names stay
// too.
//
// What the tool remembers about its own changes needs no step. The record of the applied changes
// is a file in the folder and moves with it, and install.mjs takes an entry under any of the names
// as this tool's own. So "undo" and "doctor" work for a change that was applied under an old name.
import { existsSync, lstatSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { moveBoardAddress } from './board.mjs'
import { read, settingsFile, write } from './install.mjs'
import { real } from './app.mjs'
import { installedRoot, isOwnLink, isThere, kestrelLink, linkOf, ownLink, ownRest, placeLinks } from './links.mjs'
import { KESTREL_NAME, NAME, OLD_NAME, home, kestrelHome, newHome, oldHome } from './paths.mjs'

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Whether a path is the link that an earlier move left: a link to ~/.widal. */
function movedHere(path) {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return false
  return resolve(dirname(path), readlinkSync(path)) === newHome()
}

/**
 * Renames the folder `from` to ~/.widal, and leaves `from` as a link to ~/.widal. The link is
 * made under another name first and then takes the folder's old name, so the old name is missing
 * for only a moment. When another run of the tool did the same at the same time, its rename wins
 * and this one does nothing. Returns whether this run renamed the folder.
 */
function renameWithLink(from) {
  const now = newHome()
  const tmp = `${from}.${process.pid}.tmp`
  rmSync(tmp, { force: true })
  symlinkSync(now, tmp)
  try {
    renameSync(from, now)
  } catch (e) {
    rmSync(tmp, { force: true })
    if (movedHere(from) || existsSync(now)) return false
    throw e
  }
  renameSync(tmp, from)
  return true
}

/**
 * Step 1, the folder: ~/.kestrel becomes ~/.widal, or ~/.agent-spend does on a machine that never
 * had ~/.kestrel. The old name is left as a link to ~/.widal. Returns what it did as one
 * sentence, or what kept it from doing so as a note. With only the new folder, with a link that
 * an earlier move left, or with no folder, there is nothing to do.
 *
 * With both the old folder and the new one it changes neither: it cannot know which files the
 * person wants. The note says which folder the tool uses: the new one. With WIDAL_HOME (or
 * KESTREL_HOME) the person has named the tool's folder, so no folder in the home folder is moved.
 */
function moveFolder(env) {
  const now = newHome()
  const old = [kestrelHome(), oldHome()].find((path) => isThere(path))
  if (!old || movedHere(old)) return {}
  const named = ['WIDAL_HOME', 'KESTREL_HOME'].find((name) => env[name])
  if (named) return { note: `${named} is set, so the folder ${old} was not moved.` }
  if (existsSync(now)) return { note: `Both ${old} and ${now} exist, so neither was changed. The tool uses ${now} from now on, and does not read the records in ${old}.` }
  if (!renameWithLink(old)) return {}
  return { did: `Renamed this tool's folder from ${old} to ${now}, and left ${old} as a link to it so that open sessions keep working.` }
}

/**
 * The command of an entry in Claude Code's settings as the move leaves it: the link in the tool's
 * own folder, with the same words after the program. Undefined when the entry is not this tool's
 * own, or already calls that link.
 */
function newCommand(command) {
  const rest = ownRest(command)
  const next = rest === undefined ? undefined : `${ownLink()}${rest}`
  return next === command ? undefined : next
}

/**
 * Whether a command of this tool's own entry calls it under an old name: its program (the first
 * word, or the file after "node") is named kestrel or agent-spend, with or without ".mjs".
 */
const oldNamed = (command) => [KESTREL_NAME, OLD_NAME].includes(basename(command.replace(/^node /, '').split(' ')[0]).replace(/\.mjs$/, ''))

/** Calls `visit` with the status line and each hook of the settings. Settings that are not in the shape Claude Code writes hold no entry. */
function eachEntry(s, visit) {
  if (isObject(s.statusLine)) visit(s.statusLine, 'statusLine')
  for (const groups of Object.values(isObject(s.hooks) ? s.hooks : {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) if (isObject(hook)) visit(hook, 'hooks')
    }
  }
}

/**
 * Whether Claude Code's settings hold an entry of this tool, in any form, or with `old` only one
 * that calls it under an old name. A settings file that cannot be read holds none.
 */
function holdsOwnEntry(old = false) {
  let found = false
  try {
    eachEntry(read(), (entry) => (found ||= ownRest(entry.command) !== undefined && (!old || oldNamed(entry.command))))
  } catch {
    // The step for the settings reads the file again, and says what is wrong with it.
  }
  return found
}

/**
 * Step 3, Claude Code's settings: the status line and every hook of this tool are changed to
 * call the link in the tool's own folder. Only the text of those commands changes. Every other
 * key, every other hook and the order of all of them stay. A copy of the file is saved first, as
 * for every change of the settings. When no entry needs a change, the file is not written.
 */
function moveSettings(old = false) {
  const s = read()
  const count = { statusLine: 0, hooks: 0 }
  eachEntry(s, (entry, kind) => {
    if (old && typeof entry.command === 'string' && !oldNamed(entry.command)) return
    const command = newCommand(entry.command)
    if (command === undefined) return
    entry.command = command
    count[kind]++
  })
  if (!count.statusLine && !count.hooks) return {}
  write(s)
  const what = [...(count.statusLine ? ['the status line'] : []), ...(count.hooks ? [count.hooks === 1 ? 'one hook' : `${count.hooks} hooks`] : [])].join(' and ')
  return { did: `Changed ${what} in ${settingsFile()} to call ${ownLink()}, and saved a copy of the file as it was in ${join(home(), 'backup')} first.` }
}

/**
 * Brings an install under an old name to the new one: the folder, the links, Claude Code's
 * settings and the board's address, in that order. `target` is the command's file that the links
 * point at, or a function that gives it: it is asked for after the folder has moved, so that a
 * file in the tool's folder is named at its new place. `say` gets one sentence for each thing
 * that was done, as soon as it is done, and `note` gets a sentence for a thing that was left out
 * on purpose. Returns how many things were done: 0 when nothing was left to do.
 *
 * With `make` ("connect") the links are made in any case. Without it the link in the tool's own
 * folder is made only for an install of this tool: an own entry in the settings, an own link on
 * the PATH, or a link in the tool's folder. On a machine without any of these the move makes
 * nothing. See `placeLinks` for the links on the PATH.
 *
 * With `auto` (the move that runs on its own) more rules hold, so that it only does what the
 * change of name needs:
 *   - `root` is the folder of the tool that this run would link to, or a function that gives it.
 *     When the install runs the tool from another folder (another checkout, say), the move
 *     changes nothing at all: it is for the copy of the tool that the install runs. "widal
 *     migrate" or "widal connect" from another copy moves the install to that copy.
 *   - The links and the settings are looked at only while something still has an old name: the
 *     folder of an install was moved just now, an entry in the settings calls an old name, or a
 *     link of an old name is there without the link of the new name next to it. Else the
 *     command's file is not even asked for, so a plugin that was never set up gets no copy of
 *     the tool.
 *   - Only the entries that call an old name are changed.
 *
 * A second run finds the new folder, the links in place and no entry to change, and does nothing.
 */
export function migrate({ target, root, say = () => {}, note = say, env = process.env, make = false, auto = false }) {
  if (auto) {
    const installed = installedRoot()
    if (installed && installed !== real(typeof root === 'function' ? root() : root)) return 0
  }
  let done = 0
  const tell = ({ did, note: why } = {}) => {
    if (did) {
      done++
      say(did)
    } else if (why) note(why)
  }
  const folder = moveFolder(env)
  tell(folder)
  const moved = Boolean(folder.did)
  if (auto) {
    // An install of this tool: an own link on the PATH, an own entry in the settings, or a link in
    // the tool's folder. A folder of a plugin that was never set up holds none.
    const install = [NAME, KESTREL_NAME, OLD_NAME].some((name) => isOwnLink(linkOf(name))) || holdsOwnEntry() || isThere(ownLink()) || isThere(kestrelLink())
    const oldLinkAlone = [KESTREL_NAME, OLD_NAME].some((name) => isOwnLink(linkOf(name))) && !isThere(linkOf(NAME))
    const oldOwnAlone = isThere(kestrelLink()) && !isThere(ownLink())
    if ((moved && install) || holdsOwnEntry(true) || oldLinkAlone || oldOwnAlone) {
      const file = typeof target === 'function' ? target() : target
      for (const step of placeLinks(file, { own: true })) tell(step)
      tell(moveSettings(true))
    }
  } else {
    const ours = [NAME, KESTREL_NAME, OLD_NAME].some((name) => isOwnLink(linkOf(name)))
    const own = make || ours || holdsOwnEntry() || isThere(ownLink()) || isThere(kestrelLink())
    const file = typeof target === 'function' ? target() : target
    for (const step of placeLinks(file, { make, own })) tell(step)
    tell(moveSettings())
  }
  tell(moveBoardAddress())
  return done
}
