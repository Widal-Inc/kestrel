// The move of an install that was made under this tool's old name, agent-spend, to the name
// Kestrel. "kestrel migrate" runs it, and "kestrel install" runs it first.
//
// An install under the old name has three things that carry the name: the folder ~/.agent-spend
// with everything the tool keeps, the link ~/.local/bin/agent-spend that puts the command on the
// PATH, and the entries in Claude Code's settings that call that command (the status line and the
// hooks). The move brings each of them to the new name, in that order.
//
// The entries in the settings end up calling the link in the tool's own folder,
// ~/.kestrel/bin/kestrel, and never a link on the PATH: another program named kestrel can be on
// the PATH. See links.mjs.
//
// Sessions that are open during the move call the old command every few seconds. So the move
// takes nothing away that they use: the old link stays, and the file it points to still runs the
// program. The folder is renamed in one step, and from then on every run finds the new one.
//
// What the tool remembers about its own changes needs no step. The record of the applied changes
// is a file in the folder and moves with it, and install.mjs takes an entry under either name as
// this tool's own. So "undo" and "status" work for a change that was applied under the old name.
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { read, settingsFile, write } from './install.mjs'
import { isOwnLink, isThere, linkOf, ownLink, ownRest, placeLinks } from './links.mjs'
import { OLD_NAME, home, newHome, oldHome } from './paths.mjs'

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Step 1, the folder: ~/.agent-spend becomes ~/.kestrel. Returns what it did as one sentence, or
 * what kept it from doing so as a note. With only the new folder, or with none, there is nothing
 * to do.
 *
 * With both folders it changes neither: it cannot know which files the person wants. The note
 * says which folder the tool uses: the new one, or the one that KESTREL_HOME names. With
 * KESTREL_HOME the person has named the tool's folder, so no folder in the home folder is moved.
 */
function moveFolder(env) {
  const [old, now] = [oldHome(), newHome()]
  if (!existsSync(old)) return {}
  if (existsSync(now)) return { note: `Both ${old} and ${now} exist, so neither was changed. The tool uses ${home()} from now on, and does not read the records in ${old}.` }
  if (env.KESTREL_HOME) return { note: `KESTREL_HOME is set, so the folder ${old} was not renamed.` }
  renameSync(old, now)
  return { did: `Renamed this tool's folder from ${old} to ${now}.` }
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

/** Calls `visit` with the status line and each hook of the settings. Settings that are not in the shape Claude Code writes hold no entry. */
function eachEntry(s, visit) {
  if (isObject(s.statusLine)) visit(s.statusLine, 'statusLine')
  for (const groups of Object.values(isObject(s.hooks) ? s.hooks : {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) if (isObject(hook)) visit(hook, 'hooks')
    }
  }
}

/** Whether Claude Code's settings hold an entry of this tool, in any form. A settings file that cannot be read holds none. */
function holdsOwnEntry() {
  let found = false
  try {
    eachEntry(read(), (entry) => (found ||= ownRest(entry.command) !== undefined))
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
function moveSettings() {
  const s = read()
  const count = { statusLine: 0, hooks: 0 }
  eachEntry(s, (entry, kind) => {
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
 * Brings an install under the old name to the new one: the folder, the links, and Claude Code's
 * settings, in that order. `target` is the command's file that the links point at, or a function
 * that gives it: it is asked for after the folder has moved, so that a file in the tool's folder
 * is named at its new place. `say` gets one sentence for each thing that was done, as soon as it
 * is done, and a note for a thing that was left out on purpose. Returns how many things were
 * done: 0 when nothing was left to do.
 *
 * With `make` ("install") the links are made in any case. Without it ("migrate") the link in the
 * tool's own folder is made only for an install of this tool: an own entry in the settings, an
 * own link on the PATH, or that link itself. On a machine without any of these the move makes
 * nothing. See `placeLinks` for the links on the PATH.
 *
 * A second run finds the new folder, the links in place and no entry to change, and does nothing.
 */
export function migrate({ target, say = () => {}, env = process.env, make = false }) {
  let done = 0
  const tell = ({ did, note } = {}) => {
    if (did) done++
    if (did ?? note) say(did ?? note)
  }
  tell(moveFolder(env))
  const file = typeof target === 'function' ? target() : target
  const own = make || holdsOwnEntry() || isOwnLink(linkOf('kestrel')) || isOwnLink(linkOf(OLD_NAME)) || isThere(ownLink())
  for (const step of placeLinks(file, { make, own })) tell(step)
  tell(moveSettings())
  return done
}
