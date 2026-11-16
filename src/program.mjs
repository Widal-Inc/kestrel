// The name of the program that a shell command runs, such as "npm", "git" or "pytest".
//
// "kestrel findings" splits the results of shell commands by program, so that a person sees which
// programs fill the context. From a command Kestrel keeps this one name and nothing else: never
// an argument, never the rest of the command.
//
// The name is the first word of the command, reduced to its base name ("/usr/bin/git" gives
// "git"). Words in front that set a variable ("NODE_ENV=test npm test") are skipped and never
// kept, because their value can be a secret. A name has letters, digits, ".", "-" and "_" only,
// and at most 24 characters. Any other first word gives "(other)", so that no stray text is kept.

/** The longest name that is kept. */
export const PROGRAM_MAX = 24
/** What a command gives when its first word is not a plain program name. */
export const OTHER_PROGRAM = '(other)'

const NAME = new RegExp(`^[A-Za-z0-9._-]{1,${PROGRAM_MAX}}$`)
// A word that sets a variable for the command: NAME=value.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The program that a shell command runs, as described above. Undefined for a command that is not text or is empty. */
export function programOf(command) {
  if (typeof command !== 'string') return undefined
  const words = command.trim().split(/\s+/).filter(Boolean)
  let i = 0
  while (i < words.length && ASSIGNMENT.test(words[i])) i++
  if (i >= words.length) return words.length ? OTHER_PROGRAM : undefined
  // One pair of quotes around the word, then the part after the last slash.
  const word = words[i].replace(/^(["'])(.*)\1$/, '$2')
  const base = word.slice(word.lastIndexOf('/') + 1)
  return NAME.test(base) && !/^\.+$/.test(base) ? base : OTHER_PROGRAM
}
