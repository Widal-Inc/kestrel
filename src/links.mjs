// The links that run this tool.
//
// Claude Code's settings call this tool through a link in the tool's own folder:
// <tool folder>/bin/kestrel, so ~/.kestrel/bin/kestrel by default. No other program can be at
// that path. The link points at the command's file: in the checkout when the tool runs from a
// checkout, and in the stable copy <tool folder>/app when it was installed from a plugin.
//
// The links on the PATH, ~/.local/bin/kestrel and ~/.local/bin/agent-spend under the tool's old
// name, are only there so that the person can type the command. Another program can have the
// same name: a package named kestrel exists on npm. So a link on the PATH is changed or removed
// only when it is this tool's own link. Anything else at that path stays as it is, and the person
// is told so.
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { ROOT, holdsTool, real } from './app.mjs'
import { OLD_NAME, home, newHome, oldHome } from './paths.mjs'

/** The link that puts the command on the PATH under a name: ~/.local/bin/kestrel for "kestrel". */
export const linkOf = (name) => join(homedir(), '.local', 'bin', name)

/** The link in the tool's own folder that Claude Code's settings call. */
export const ownLink = () => join(home(), 'bin', 'kestrel')

/** Whether something is at a path. A link whose target is gone counts too. */
export const isThere = (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined

/** The target of a link, as a full path. A link can name its target relative to its own folder. */
const targetOf = (link) => resolve(dirname(link), readlinkSync(link))

/**
 * Whether a folder holds this tool: the folder of the tool that runs now, or a folder whose
 * package.json names this tool's package. The second one covers another checkout and the stable
 * copy of an install from a plugin.
 */
const isToolFolder = (folder) => real(folder) === real(ROOT) || holdsTool(folder)

/**
 * Whether a path holds this tool's own link: a link whose target is this tool's command file,
 * kestrel.mjs or agent-spend.mjs, in the folder "cli" or (before 13 Nov 2026) "bin" of a folder
 * that holds this tool. The target need not be there any more: a link to the old "bin" folder is
 * still this tool's. A file, a folder, and a link to any other place belong to another program.
 */
export function isOwnLink(path) {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return false
  const target = targetOf(path)
  return ['kestrel.mjs', `${OLD_NAME}.mjs`].includes(basename(target)) && ['bin', 'cli'].includes(basename(dirname(target))) && isToolFolder(dirname(dirname(target)))
}

/**
 * Whether another program is at a path that an entry in Claude Code's settings calls. Nothing at
 * the path: no, nothing else can run from there. A link: yes, unless it is this tool's own link.
 * A file: yes, unless it is this tool's command file in the folder "cli" or "bin" of a folder
 * that holds this tool.
 */
export function otherProgramAt(path) {
  const found = lstatSync(path, { throwIfNoEntry: false })
  if (!found) return false
  if (found.isSymbolicLink()) return !isOwnLink(path)
  const toolFile = ['kestrel.mjs', `${OLD_NAME}.mjs`].includes(basename(path)) && ['bin', 'cli'].includes(basename(dirname(path)))
  return !(toolFile && isToolFolder(dirname(dirname(path))))
}

/**
 * Makes a link point at a file: makes it when nothing is there, and changes it when it points
 * elsewhere. Returns "made" or "changed", or undefined when it already pointed at the file.
 * Only for a path that is this tool's own: whatever is there is replaced.
 */
function pointLink(link, file) {
  const there = isThere(link)
  if (there && lstatSync(link).isSymbolicLink() && real(targetOf(link)) === real(file)) return undefined
  mkdirSync(dirname(link), { recursive: true })
  if (there) unlinkSync(link)
  symlinkSync(file, link)
  return there ? 'changed' : 'made'
}

/**
 * The link in the tool's own folder, made when it is missing or its target is gone. `file` is
 * the command's file it then points at. Returns the link. "apply" and "limit" use it, so that
 * a hook they add calls a command that is there. "install" and "migrate" point the link with
 * `placeLinks`.
 */
export function ensureOwnLink(file) {
  const link = ownLink()
  if (!existsSync(link)) pointLink(link, file)
  return link
}

/**
 * The sentence for a path on the PATH that holds another program: what is there, that it was left
 * as it is, and the full path under which this tool can be run. Without `runAs` it leaves the
 * last part out: after "uninstall" the tool can have no path of its own left.
 */
export const otherProgram = (name, link, runAs) =>
  `Another program named ${name} is at ${link}, so it was left as it is${runAs ? `, and this tool can be run as ${runAs}` : ''}.`

/**
 * Places the links that run this tool. `file` is the command's file that they point at, in the
 * checkout or in the stable copy. Returns what was done, each as { did } or { note }, in order.
 *
 *   - The link in the tool's own folder points at `file`, when `own` is set.
 *   - Each link on the PATH that is this tool's own points at the file of its name next to
 *     `file`: "kestrel" at kestrel.mjs, the old name's link at agent-spend.mjs. A link from
 *     before the files moved from "bin" to "cli" is pointed at "cli" this way.
 *   - The link "kestrel" on the PATH is made when nothing is there, with `make` (for "install"),
 *     or when the old name's link is this tool's own (for "migrate": the new name next to the old).
 *   - Anything else at a path on the PATH stays as it is, with a note that says so.
 */
export function placeLinks(file, { make = false, own = make } = {}) {
  const out = []
  const mine = ownLink()
  if (own) {
    const how = pointLink(mine, file)
    if (how === 'made') out.push({ did: `Made the link ${mine} to ${file}: Claude Code's settings call this tool through it.` })
    if (how === 'changed') out.push({ did: `Pointed the link ${mine} at ${file}.` })
  }
  const runAs = existsSync(mine) ? mine : file
  const [now, old] = [linkOf('kestrel'), linkOf(OLD_NAME)]
  const oldIsOurs = isOwnLink(old)
  for (const [name, link] of [['kestrel', now], [OLD_NAME, old]]) {
    const want = join(dirname(file), `${name}.mjs`)
    if (isOwnLink(link)) {
      if (real(targetOf(link)) === real(want)) continue
      unlinkSync(link)
      symlinkSync(want, link)
      out.push({ did: `Pointed the command ${link} at ${want}, where the command's files are now.` })
    } else if (isThere(link)) out.push({ note: otherProgram(name, link, runAs) })
    else if (name === 'kestrel' && (make || oldIsOurs)) {
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(want, link)
      if (oldIsOurs) out.push({ did: `Added the command ${link}, and left the old command ${old} in place so that open sessions keep working.` })
    }
  }
  return out
}

/**
 * The programs of this tool's own entries, in every form they ever had: the old link on the PATH,
 * the link on the PATH, the link in the tool's own folder (in the old folder, in the new one, and
 * in the folder that KESTREL_HOME names), and the bare names.
 */
export const ownPrograms = () => [...new Set([linkOf(OLD_NAME), linkOf('kestrel'), join(oldHome(), 'bin', 'kestrel'), join(newHome(), 'bin', 'kestrel'), ownLink(), OLD_NAME, 'kestrel'])]

/**
 * The words after the program of an entry in Claude Code's settings, when the entry is this
 * tool's own. Undefined when it is not.
 *
 * An entry is this tool's own when its program is one of `ownPrograms`, or "node" with a path
 * that ends in the command's file (kestrel.mjs, or agent-spend.mjs under the old name) in the
 * folder "cli", or "bin" where the files were before. Only the program counts. A program that
 * only has the name in it, such as "/usr/bin/other-agent-spend", and a command that has the name
 * only in an argument belong to another tool.
 */
export function ownRest(command) {
  if (typeof command !== 'string') return undefined
  for (const program of ownPrograms()) {
    if (command !== program && !command.startsWith(`${program} `)) continue
    // A link on the PATH can be another program with the same name. The link in the tool's own
    // folder cannot: nothing else is put there.
    if (program.startsWith(`${linkOf('')}`) && otherProgramAt(program)) return undefined
    return command.slice(program.length)
  }
  const script = /^node ((?:\S*[/\\])?(?:bin|cli)[/\\](?:kestrel|agent-spend)\.mjs)(?= |$)/.exec(command)
  // A script with the command's name in a folder that does not hold this tool belongs to another program.
  if (!script || otherProgramAt(script[1])) return undefined
  return command.slice(script[0].length)
}
