// The bird of Kestrel, drawn in the terminal.
//
// The drawing is a grid of 24 by 24 cells, the same as assets/bird-grid.txt. Each letter is one
// colour, and a dot is an empty cell. A terminal draws two rows of cells in one line of text: the
// upper half block character, with the upper cell's colour as the text colour and the lower cell's
// colour as the background, in 24 bit colour codes. So the bird is 12 lines of 24 characters. The
// grid is kept here, so that the command needs no file read for it.
//
// It shows when "kestrel" runs with no arguments, and at the end of "kestrel install". Never in
// the status line and never in a hook. Without colours (NO_COLOR is set, the output is not a
// terminal, or TERM is "dumb") only the name and the version are shown, on one line.

/** The drawing: 24 rows of 24 cells. */
export const GRID = [
  '....ssssssssssssssss....',
  '..ssssssssssssssssssss..',
  '.ssssssssssssssssssssss.',
  'ssssssssssssssssssssssss',
  'ssdssssssssssssssssssdss',
  'sssddssssssssssssssddsss',
  'ssssdddssssssssssdddssss',
  'sssssddosssggsssoddsssss',
  'ssssssdoooggggooodssssss',
  'sssssssoooyggyooosssssss',
  'ssssssssoogyygoossssssss',
  'sssssssssoccccosssssssss',
  'sssssssssscbbcssssssssss',
  'sssssssssscccbssssssssss',
  'ssssssssssbcccssssssssss',
  'sssssssssscccbssssssssss',
  'ssssssssssyggyssssssssss',
  'ssssssssssggggssssssssss',
  'sssssssssggggggsssssssss',
  'ssssssssskkkkkksssssssss',
  'sssssssssccccccsssssssss',
  '.ssssssssssssssssssssss.',
  '..ssssssssssssssssssss..',
  '....ssssssssssssssss....',
]

/** The colour of each letter, as red, green and blue. */
const COLORS = {
  s: [191, 220, 229],
  c: [251, 244, 228],
  o: [194, 98, 44],
  d: [42, 35, 32],
  g: [124, 142, 156],
  k: [22, 27, 31],
  y: [245, 197, 66],
  b: [122, 74, 43],
}

/** The sentence next to the bird. */
export const SENTENCE = 'Shows what your AI coding agents spend, and helps to spend less.'

// The upper and the lower half block, built from their codes, and the codes for the colours.
const UPPER = String.fromCharCode(0x2580)
const LOWER = String.fromCharCode(0x2584)
const RESET = '\x1b[0m'
const fg = ([r, g, b]) => `\x1b[38;2;${r};${g};${b}m`
const bg = ([r, g, b]) => `\x1b[48;2;${r};${g};${b}m`
// The terminal's own background, for the half of a character that has no colour.
const NO_BG = '\x1b[49m'

/** One character of a line: an upper cell and the lower cell below it. */
function cell(top, bottom) {
  const [up, down] = [COLORS[top], COLORS[bottom]]
  if (up && down) return `${fg(up)}${bg(down)}${UPPER}`
  if (up) return `${fg(up)}${NO_BG}${UPPER}`
  // Only the lower cell has a colour. The upper half block would fill its upper half with the
  // text colour, so the lower half block draws this one.
  if (down) return `${fg(down)}${NO_BG}${LOWER}`
  return `${NO_BG} `
}

/** The bird as 12 lines of 24 characters. Every line ends with a reset, so that no colour runs on. */
export function bird() {
  const lines = []
  for (let row = 0; row < GRID.length; row += 2) lines.push([...GRID[row]].map((top, i) => cell(top, GRID[row + 1][i])).join('') + RESET)
  return lines
}

/**
 * Whether the bird can be shown: the output is a terminal, NO_COLOR is not set, and TERM is not
 * "dumb". `env` and `tty` stand in for the environment and for whether the output is a terminal.
 */
export const birdShows = ({ env = process.env, tty = process.stdout.isTTY } = {}) => Boolean(tty) && !env.NO_COLOR && env.TERM !== 'dumb'

/**
 * The bird, with the name and the version, and the sentence, next to its two middle lines. Where
 * the bird cannot be shown, only the name and the version, on one line. `opts` is as for
 * `birdShows`.
 */
export function banner(version, opts = {}) {
  const name = version ? `Kestrel ${version}` : 'Kestrel'
  if (!birdShows(opts)) return name
  const lines = bird()
  lines[5] += `  ${name}`
  lines[6] += `  ${SENTENCE}`
  return lines.join('\n')
}
