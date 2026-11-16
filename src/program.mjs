// The name of the program that a shell command runs, such as "npm", "git" or "pytest".
//
// "kestrel findings" splits the results of shell commands by program, so that a person sees which
// programs fill the context. From a command Kestrel keeps this one name and nothing else: never
// an argument, never the rest of the command.
//
// The name is the first word of the command, reduced to its base name ("/usr/bin/git" gives
// "git"). A command can start with a change of folder: "cd <folder> && npm test" and
// "cd <folder>; npm test" give "npm". Words in front that set a variable ("NODE_ENV=test npm
// test") are skipped and never kept, because their value can be a secret. A name has letters,
// digits, ".", "-" and "_" only, and at most 24 characters.
//
// When Kestrel cannot be sure which word is the program, the command gives "(other)", so that no
// stray text is kept. That is the case when a quote, a backslash or a "$(" or "`" comes before the
// program's word (a value in quotes can hold spaces, so the word after a space may be a part of
// it), when the word looks like a key or a token, and when it is a home folder such as
// "/Users/<name>" or "/home/<name>", whose last part is a person's name.

/** The longest name that is kept. */
export const PROGRAM_MAX = 24
/** What a command gives when its first word is not a plain program name. */
export const OTHER_PROGRAM = '(other)'

const NAME = new RegExp(`^[A-Za-z0-9._-]{1,${PROGRAM_MAX}}$`)
// A word that sets a variable for the command: NAME=value. Its value has to be plain: a quote, a
// backslash, "$(", "${" or "`" in it can carry a space, so the words after it could be the value.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const PLAIN_VALUE = /^[A-Za-z_][A-Za-z0-9_]*=[^'"`\\(){}]*$/
// A change of folder in front of the command: "cd <folder> &&" or "cd <folder>;". The folder is
// one word, or one text in quotes that is closed.
const CD_PREFIX = /^cd\s+("[^"]*"|'[^']*'|[^\s'"`\\;&|()]+)\s*(&&|;)\s*/
// The starts of keys and tokens that some services give: AWS access keys, GitHub, GitLab, Slack,
// Stripe and OpenAI style keys, Google API keys and tokens, npm and Hugging Face tokens, a Kestrel
// board token, and a JSON web token.
const KEY_PREFIX = /^(AKIA|ASIA|AGPA|AIDA|AROA|ANPA|AIza|ya29\.|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|glpat-|xox[abeprs]-|xapp-|sk-|sk_|pk_|rk_|npm_|hf_|kbm_|eyJ)/
// A home folder: its last part is the name of a person's account.
const HOME_FOLDER = /^\/(Users|home)\/[^/]+\/?$/

/**
 * Whether a word looks like a key or a token rather than the name of a program: it starts like a
 * known key, or it is long (16 characters or more) and is hex, or mostly capitals and digits, or
 * mixes capitals, small letters and digits.
 */
export function looksSecret(word) {
  if (KEY_PREFIX.test(word)) return true
  if (word.length < 16) return false
  const count = (re) => (word.match(re) ?? []).length
  const upper = count(/[A-Z]/g)
  const lower = count(/[a-z]/g)
  const digits = count(/[0-9]/g)
  if (digits && /^[0-9a-fA-F]+$/.test(word)) return true
  if (upper >= 8 && upper + digits >= 0.8 * word.length) return true
  return upper > 0 && lower > 0 && digits >= 2
}

/** The program that a shell command runs, as described above. Undefined for a command that is not text or is empty. */
export function programOf(command) {
  if (typeof command !== 'string') return undefined
  let rest = command.trim()
  if (!rest) return undefined
  // Up to three changes of folder in front of the command.
  for (let i = 0; i < 3; i++) {
    const cd = CD_PREFIX.exec(rest)
    if (!cd) break
    rest = rest.slice(cd[0].length)
  }
  const words = rest.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < words.length && ASSIGNMENT.test(words[i])) {
    // A value that is not plain may hold spaces: the program's word is then not known for sure.
    if (!PLAIN_VALUE.test(words[i])) return OTHER_PROGRAM
    i++
  }
  if (i >= words.length) return OTHER_PROGRAM
  // One pair of quotes around the word is taken away. Any other quote, or a backslash, makes it unclear.
  const word = words[i].replace(/^(["'])([^"']*)\1$/, '$2')
  if (/["'`\\]/.test(word) || HOME_FOLDER.test(word)) return OTHER_PROGRAM
  const base = word.slice(word.lastIndexOf('/') + 1)
  return NAME.test(base) && !/^\.+$/.test(base) && !looksSecret(base) ? base : OTHER_PROGRAM
}
