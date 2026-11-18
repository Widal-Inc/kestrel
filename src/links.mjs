// The links that run this tool.
//
// Claude Code's settings call this tool through a link in the tool's own folder:
// <tool folder>/bin/widal, so ~/.widal/bin/widal by default. No other program can be at that
// path. The link points at the command's file: in the checkout when the tool runs from a
// checkout, and in the stable copy <tool folder>/app when it was installed from a plugin.
//
// Before the change of name the settings called <tool folder>/bin/kestrel. That link moved with
// the folder to ~/.widal/bin/kestrel, and sessions that were open during the move still call it
// as ~/.kestrel/bin/kestrel. So it stays for one release, and points at the command's file under
// its old name, cli/kestrel.mjs, which runs this tool.
//
// The links on the PATH, ~/.local/bin/widal, and ~/.local/bin/kestrel and ~/.local/bin/agent-spend
// under the tool's old names, are only there so that the person can type the command. Another
// program can have the same name: Widal.Factory has a command named widal, and a package named
// kestrel exists on npm. So a link on the PATH is changed or removed only when it is this tool's
// own link. Anything else at that path stays as it is, and the person is told so.
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { ROOT, holdsTool, real } from './app.mjs'
import { KESTREL_NAME, NAME, OLD_NAME, home, kestrelHome, newHome, oldHome } from './paths.mjs'

/** The link that puts the command on the PATH under a name: ~/.local/bin/widal for "widal". */
export const linkOf = (name) => join(homedir(), '.local', 'bin', name)

/** The link in the tool's own folder that Claude Code's settings call. */
export const ownLink = () => join(home(), 'bin', NAME)

/** The link in the tool's own folder under the name before, which sessions from before the move call. */
export const kestrelLink = () => join(home(), 'bin', KESTREL_NAME)

/** Whether something is at a path. A link whose target is gone counts too. */
export const isThere = (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined

/** The target of a link, as a full path. A link can name its target relative to its own folder. */
const targetOf = (link) => resolve(dirname(link), readlinkSync(link))

/** The names of the command's files: under the tool's name, and under its two old names. */
const FILES = [`${NAME}.mjs`, `${KESTREL_NAME}.mjs`, `${OLD_NAME}.mjs`]

/**
 * Whether a folder holds this tool: the folder of the tool that runs now, or a folder whose
 * package.json names this tool's package. The second one covers another checkout and the stable
 * copy of an install from a plugin.
 */
const isToolFolder = (folder) => real(folder) === real(ROOT) || holdsTool(folder)

/** Whether a path names one of the command's files in the folder "cli" or (before 13 Nov 2026) "bin" of a folder that holds this tool. */
const isToolFile = (path) => FILES.includes(basename(path)) && ['bin', 'cli'].includes(basename(dirname(path))) && isToolFolder(dirname(dirname(path)))

/**
 * Whether a path holds this tool's own link: a link whose target is one of this tool's command
 * files (widal.mjs, kestrel.mjs or agent-spend.mjs) in the folder "cli" or "bin" of a folder that
 * holds this tool. The target need not be there any more: a link to the old "bin" folder is still
 * this tool's. A file, a folder, and a link to any other place belong to another program.
 */
export function isOwnLink(path) {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return false
  return isToolFile(targetOf(path))
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
  return !isToolFile(path)
}

/** Whether a program at a path runs this tool: through any links, it is one of this tool's command files. */
export const runsThisTool = (path) => isToolFile(real(path))

/**
 * The program that a shell runs for a name: the first file of that name in the folders of the
 * PATH that can be run. Undefined when there is none. `env` stands in for the environment.
 */
export function firstOnPath(name, env = process.env) {
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const file = join(dir, name)
    try {
      accessSync(file, constants.X_OK)
      if (statSync(file).isFile()) return file
    } catch {
      // Not in this folder.
    }
  }
  return undefined
}

/**
 * Makes a link point at a file: makes it when nothing is there, and changes it when it names
 * another target. Returns "made" or "changed", or undefined when it already named the file. Only
 * for a path that is this tool's own: whatever is there is replaced. A changed link takes the
 * place of the old one in one step, so a status line that runs in that moment finds one of them.
 */
function pointLink(link, file) {
  const there = isThere(link)
  if (there && lstatSync(link).isSymbolicLink() && targetOf(link) === file) return undefined
  mkdirSync(dirname(link), { recursive: true })
  const tmp = `${link}.${process.pid}.tmp`
  rmSync(tmp, { force: true })
  symlinkSync(file, tmp)
  renameSync(tmp, link)
  return there ? 'changed' : 'made'
}

/**
 * The link in the tool's own folder, made when it is missing or its target is gone. `file` is
 * the command's file it then points at. Returns the link. "apply" and "limit" use it, so that
 * a hook they add calls a command that is there. "connect" and the move point the link with
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
 * last part out: after "disconnect" the tool can have no path of its own left.
 */
export const otherProgram = (name, link, runAs) =>
  `Another program named ${name} is at ${link}, so it was left as it is${runAs ? `, and this tool can be run as ${runAs}` : ''}.`

/**
 * Places the links that run this tool. `file` is the command's file that they point at, in the
 * checkout or in the stable copy. Returns what was done, each as { did } or { note }, in order.
 *
 *   - The link in the tool's own folder, bin/widal, points at `file`, when `own` is set.
 *   - The link bin/kestrel in the tool's own folder, when it is there and is this tool's own,
 *     points at kestrel.mjs next to `file`. It is never made anew.
 *   - Each link on the PATH that is this tool's own points at the file of its name next to
 *     `file`: "widal" at widal.mjs, "kestrel" at kestrel.mjs, "agent-spend" at agent-spend.mjs. A
 *     link from before the files moved from "bin" to "cli" is pointed at "cli" this way.
 *   - The link "widal" on the PATH is made when nothing is there, with `make` (for "connect"), or
 *     when a link of an old name is this tool's own (for the move: the new name next to the old).
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
  const before = kestrelLink()
  const beforeWant = join(dirname(file), `${KESTREL_NAME}.mjs`)
  if (isOwnLink(before) && pointLink(before, beforeWant)) out.push({ did: `Pointed the link ${before} at ${beforeWant}, so that sessions from before the change of name keep working.` })
  const runAs = existsSync(mine) ? mine : file
  const links = [NAME, KESTREL_NAME, OLD_NAME].map((name) => [name, linkOf(name)])
  const olds = links.slice(1).map(([, link]) => link).filter(isOwnLink)
  for (const [name, link] of links) {
    const want = join(dirname(file), `${name}.mjs`)
    if (isOwnLink(link)) {
      if (targetOf(link) === want) continue
      pointLink(link, want)
      out.push({ did: `Pointed the command ${link} at ${want}, where the command's files are now.` })
    } else if (isThere(link)) out.push({ note: otherProgram(name, link, runAs) })
    else if (name === NAME && (make || olds.length)) {
      pointLink(link, want)
      if (olds.length) out.push({ did: `Added the command ${link}, and left the old ${olds.length === 1 ? 'command' : 'commands'} ${olds.join(' and ')} in place so that open sessions keep working.` })
    }
  }
  return out
}

/**
 * The folder of the tool that the install runs now: the folder that holds the command's file of
 * the first of this tool's own links that is there. The links are looked at in this order: the
 * links in the tool's own folder (bin/widal, then bin/kestrel, also in the folders of the old
 * names), then the links on the PATH. Undefined when there is no such link.
 */
export function installedRoot() {
  const links = [ownLink(), kestrelLink(), join(kestrelHome(), 'bin', KESTREL_NAME), join(oldHome(), 'bin', KESTREL_NAME), ...[NAME, KESTREL_NAME, OLD_NAME].map(linkOf)]
  const found = links.find(isOwnLink)
  return found && real(dirname(dirname(targetOf(found))))
}

/**
 * Takes out every link of this tool: each link on the PATH that is this tool's own, and the
 * links in the tool's own folder. Returns the links on the PATH that hold another program, as
 * [name, path]. A link whose target is gone is still a link to take out.
 */
export function removeLinks() {
  const others = []
  for (const name of [NAME, KESTREL_NAME, OLD_NAME]) {
    const link = linkOf(name)
    if (isOwnLink(link)) unlinkSync(link)
    else if (isThere(link)) others.push([name, link])
  }
  for (const link of [ownLink(), kestrelLink()]) if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(link)
  return others
}

/**
 * The programs of this tool's own entries, in every form they ever had: the links on the PATH of
 * the old names, the link in the tool's own folder (in each folder it ever had, and in the folder
 * that WIDAL_HOME names), and the bare old names.
 *
 * The bare name "widal", and the link ~/.local/bin/widal, are not in this list: Widal.Factory has
 * a command named widal, and can write entries of its own that call it. See `ownRest`.
 */
export const ownPrograms = () => [...new Set([
  linkOf(OLD_NAME), linkOf(KESTREL_NAME),
  join(oldHome(), 'bin', KESTREL_NAME), join(kestrelHome(), 'bin', KESTREL_NAME), join(newHome(), 'bin', KESTREL_NAME), kestrelLink(),
  join(newHome(), 'bin', NAME), ownLink(),
  OLD_NAME, KESTREL_NAME,
])]

/** The words after `program` in a command, when the command starts with that program. Undefined when it does not. */
const after = (command, program) => (command === program || command.startsWith(`${program} `) ? command.slice(program.length) : undefined)

/**
 * The words after the program of an entry in Claude Code's settings, when the entry is this
 * tool's own. Undefined when it is not.
 *
 * An entry is this tool's own when its program is:
 *   - one of `ownPrograms`;
 *   - the link ~/.local/bin/widal, only while it is this tool's own link;
 *   - "node" with a path that ends in kestrel.mjs or agent-spend.mjs in the folder "cli", or "bin"
 *     where the files were before, unless another program is at that path;
 *   - "node" with a path that ends in cli/widal.mjs, only when that file is there in a folder that
 *     holds this tool.
 * Only the program counts. A program that only has the name in it, such as
 * "/usr/bin/other-agent-spend", and a command that has the name only in an argument belong to
 * another tool. A program named widal anywhere else, the bare word "widal" too, is never this
 * tool's: it can be Widal.Factory's command.
 */
export function ownRest(command) {
  if (typeof command !== 'string') return undefined
  for (const program of ownPrograms()) {
    const rest = after(command, program)
    if (rest === undefined) continue
    // A link on the PATH can be another program with the same name. The link in the tool's own
    // folder cannot: nothing else is put there.
    if (program.startsWith(`${linkOf('')}`) && otherProgramAt(program)) return undefined
    return rest
  }
  const path = linkOf(NAME)
  const onPath = after(command, path)
  if (onPath !== undefined) return isOwnLink(path) ? onPath : undefined
  const script = /^node ((?:\S*[/\\])?(?:bin|cli)[/\\](?:kestrel|agent-spend)\.mjs)(?= |$)/.exec(command)
  // A script with the command's name in a folder that does not hold this tool belongs to another program.
  if (script) return otherProgramAt(script[1]) ? undefined : command.slice(script[0].length)
  const named = /^node ((?:\S*[/\\])?cli[/\\]widal\.mjs)(?= |$)/.exec(command)
  if (named && isThere(named[1]) && !otherProgramAt(named[1])) return command.slice(named[0].length)
  return undefined
}
