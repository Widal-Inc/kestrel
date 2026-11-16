// How numbers and tables are printed.

/** Dollars: whole dollars from $100, cents below, and four places for less than a cent. */
export function money(x) {
  if (!Number.isFinite(x)) return '?'
  if (x !== 0 && Math.abs(x) < 0.01) return `$${x.toFixed(4)}`
  return `$${x.toLocaleString('en-US', x >= 100 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Tokens: 1.2M, 34k, 512. */
export function tok(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

export const pct = (part, whole) => (whole > 0 ? `${Math.round((100 * part) / whole)}%` : '')
export const count = (n) => n.toLocaleString('en-US')

/**
 * A value as text, without control characters: everything below a space, the delete character,
 * and the second block of control characters (0x80 to 0x9f), which some terminals read as the
 * start of an escape code. A name that comes from a log, from a file or from Claude Code's input
 * can hold a line break or an escape code. Printed as it is, it would break a line or a table,
 * or change the terminal.
 */
export const plain = (value) => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, '')

/** A table of rows. Columns listed in `right` are right-aligned. No cell keeps a control character. */
export function table(rows, right = []) {
  const cells = rows.map((row) => row.map(plain))
  const width = []
  for (const row of cells) row.forEach((cell, i) => (width[i] = Math.max(width[i] ?? 0, cell.length)))
  return cells
    .map((row) => row.map((cell, i) => (right.includes(i) ? cell.padStart(width[i]) : cell.padEnd(width[i]))).join('  ').trimEnd())
    .join('\n')
}

const two = (n) => String(n).padStart(2, '0')
export const day = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}
export const clock = (ms) => {
  const d = new Date(ms)
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}
export const when = (ms) => `${day(ms)} ${clock(ms)}`

/**
 * A short name for a project folder: its last two parts. The folder comes from a log or from
 * Claude Code's input, and the name is printed in plain lines and in a notification. So it has
 * no control characters, and a folder that is not text is an unknown folder.
 */
export const project = (cwd) => (typeof cwd === 'string' && cwd ? plain(cwd.split('/').filter(Boolean).slice(-2).join('/')) : '(unknown folder)')
/**
 * A short name for a model: without the "claude-" in front, and without control characters,
 * because the name comes from a log. A model that is not text is "?".
 */
export const model = (m) => plain(typeof m === 'string' ? m : '?').replace(/^claude-/, '')

// The colours of the status line, as ANSI codes: green, yellow, red, and dim text.
const TONES = { good: 32, warn: 33, bad: 31, dim: 2 }

/**
 * Text in the colour of a tone (good, warn, bad or dim), with a reset after it, so that the colour
 * ends with the text. Without a tone the text stays as it is.
 */
export const color = (text, tone) => (TONES[tone] ? `\x1b[${TONES[tone]}m${text}\x1b[0m` : text)

/** Colours are on, unless NO_COLOR is set and not empty, or the settings have `color: false`. */
export const colorOn = (env = process.env, cfg = {}) => !env.NO_COLOR && cfg.color !== false
