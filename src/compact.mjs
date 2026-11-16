// Help to compact the context at a good moment.
//
// A compaction replaces a long conversation with a summary. Claude Code does it on its own when
// the context is full, and the person can ask for it with /compact. Nothing outside Claude Code
// can start one. What this tool can do is say what the summary has to keep, and say when a
// compaction fits.
//
// What to keep: Claude Code runs a hook before every compaction and adds what the hook prints
// to the instructions for the summary. This file holds the text that the hook prints: a
// default, or the person's own.
//
// When: one more part at the end of the status line, at a break in the work. It names /compact,
// and the person types it. Nothing changes on its own.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config, configFile, readJson, saveConfig } from './config.mjs'
import { count, tok } from './format.mjs'
import { claudeDir } from './paths.mjs'

/** What the summary of a compaction has to keep, unless the person set a text of their own. */
export const DEFAULT_KEEP = 'Keep what the person asked for and decided, the current plan with its open steps, the files that were changed, commands that have to be run again, and everything the person said not to do.'

// Claude Code adds at most this many characters of the hook's output to the instructions.
const KEEP_MAX = 10_000
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
/** Whether a value can be the text: text of 1 to 10,000 characters. */
const isKeepText = (v) => typeof v === 'string' && v.length >= 1 && v.length <= KEEP_MAX

/**
 * The text that says what to keep at a compaction: the one the person set (`compactKeep.text`
 * in this tool's settings), else the default.
 *
 * It reads the settings file itself, and fails with one plain sentence when the file is there
 * and is broken: not JSON, no object, or a "compactKeep" without a text of 1 to 10,000
 * characters. `config()` reads a broken file as empty settings. The default would then take the
 * place of the person's own text, and nobody would see it. So the hook prints nothing for a
 * broken file, and the command says what is wrong.
 */
export function compactKeepText() {
  const file = configFile()
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    // No settings file: nothing was set.
    if (e.code === 'ENOENT') return DEFAULT_KEEP
    throw new Error(`${file} cannot be read (${e.code ?? e.message}), so the text is not known.`)
  }
  let cfg
  try {
    cfg = JSON.parse(raw)
  } catch {
    throw new Error(`${file} is not valid JSON, so the text is not known.`)
  }
  if (!isObject(cfg)) throw new Error(`${file} does not hold a JSON object, so the text is not known.`)
  if (cfg.compactKeep === undefined) return DEFAULT_KEEP
  if (!isKeepText(cfg.compactKeep?.text)) throw new Error(`"compactKeep" in ${file} does not hold a text of 1 to ${count(KEEP_MAX)} characters. Set one with: kestrel compact-keep "<text>"`)
  return cfg.compactKeep.text
}

/**
 * Saves the person's own text in this tool's settings. Without a text it takes their text out,
 * so that the default holds again. A text that is not 1 to 10,000 characters fails with one
 * plain sentence, and nothing is saved.
 */
export function saveCompactKeep(text) {
  const cfg = { ...config() }
  if (text === undefined) delete cfg.compactKeep
  else {
    if (!isKeepText(text)) throw new Error(`The text has to be 1 to ${count(KEEP_MAX)} characters long, and this one has ${count(String(text).length)}.`)
    cfg.compactKeep = { text }
  }
  saveConfig(cfg)
}

// The hint to compact, at the end of the status line.
//
// On, at 150,000 tokens of growth, and from 100,000 tokens before the automatic compaction.
// There is no standard for these numbers. They are this tool's own choice.
const HINT_DEFAULTS = { on: true, growth: 150_000, near: 100_000 }

/**
 * The settings of the hint to compact: `{ on, growth, near }`, with the defaults for what is
 * not set. A number that was set by hand and cannot be used gives way to its default, so that
 * the status line still works.
 */
export function compactHintConfig(cfg = config()) {
  const c = { ...HINT_DEFAULTS, ...cfg?.compactHint }
  if (!Number.isFinite(c.growth) || c.growth < 1) c.growth = HINT_DEFAULTS.growth
  if (!Number.isFinite(c.near) || c.near < 0) c.near = HINT_DEFAULTS.near
  return c
}

/** The settings in words, for "kestrel hint" and the row of "kestrel status". */
export function compactHintSettingsText(c) {
  const when = `at a break in the work: when ${count(c.near)} tokens or less are left before Claude Code compacts on its own, when a task just ended and the context has ${count(c.growth)} tokens or more, or when the context grew by ${count(c.growth)} tokens`
  return c.on ? `on, ${when}` : `off (when on: ${when})`
}

// A session is quiet when it made no model call for this long. Only a quiet session gets a hint:
// in the middle of work a compaction does not fit.
const QUIET = 60e3
// A hint comes at most once in this time per session.
const HINT_EVERY = 30 * 60e3
// Claude Code compacts on its own at the model's limit: about this share of the context window.
const AUTO_SHARE = 0.967
// The sizes that Claude Code takes for its setting "autoCompactWindow".
const WINDOW_MIN = 100_000
const WINDOW_MAX = 1_000_000
// A drop of the context to under half counts as a compaction when the context was above this.
const DROP_FROM = 100_000

/** A value when it is a number, else undefined. For a value from a session's file, which can be broken. */
const number = (v) => (Number.isFinite(v) ? v : undefined)
/** A time from a session's file, or undefined when it is none or lies ahead: that comes from a clock that was wrong. */
const past = (v, now) => (Number.isFinite(v) && v <= now ? v : undefined)

/** One key of Claude Code's user settings, or undefined. A file that is missing or broken has no keys, and gives no error. */
export function claudeSetting(key) {
  const settings = readJson(join(claudeDir(), 'settings.json'))
  return isObject(settings) ? settings[key] : undefined
}

/**
 * The size of the context at which Claude Code compacts it on its own, in tokens. That is
 * "autoCompactWindow" from Claude Code's settings when it is set and not above the model's
 * context window, otherwise 96.7% of the window. Undefined when neither is known. `window` is
 * the size of the window, as Claude Code gives it to the status line.
 */
export function autoCompactPoint(window, set = claudeSetting('autoCompactWindow')) {
  if (Number.isInteger(set) && set >= WINDOW_MIN && set <= WINDOW_MAX && !(set > window)) return set
  return window > 0 ? Math.round(AUTO_SHARE * window) : undefined
}

/**
 * What the status line keeps about the size of the context, to tell how much it grew: `{ base,
 * seen }`. `base` is the size right after the last compaction, or the first size that was seen
 * for the session. `seen` is the last size that a run was given. `s` is the session's file as
 * it was read, and `ctx` the size now (0 when this run was given none).
 *
 * Nobody tells the status line that a compaction happened. It is seen as a drop: the context is
 * now under half of what it was at the last run, and it was above 100,000 tokens then. A run
 * without a size changes nothing, so that a drop is still seen when the next size comes.
 */
export function contextBase(s, ctx) {
  // A file from before this was kept has the size of the context only.
  const seen = number(s?.ctxSeen) ?? number(s?.ctx)
  const base = number(s?.compactBase)
  if (!(ctx > 0)) return { base, seen }
  const dropped = seen > DROP_FROM && ctx < seen / 2
  return { base: dropped || base === undefined ? ctx : base, seen: ctx }
}

/**
 * The hint to compact for one run of the status line: `{ part, base, seen, checked }`.
 *   - `part` is the part of the line as [text, tone], when there is a hint.
 *   - `base` and `seen` are what `contextBase` gives. The status line keeps them in the
 *     session's file as `compactBase` and `ctxSeen`.
 *   - `checked` is what to keep in the session's file as `compactHint`, when this run changed
 *     it: `{ at, look, task }`. `at` is when the hint last came. `look` is when the log was last
 *     looked at for a sign that a task ended, and `task` the time of the sign that this look
 *     found. Of the log, only that time is kept.
 *
 * `ctx` is the size of the context and `window` the size of the model's context window. `s` is
 * the session's file as it was read, and `callAt` when the status line last saw that the
 * session had made a model call. `c` is what `compactHintConfig` gives. `path` is the path of
 * the session's log and `look` what `logLook` in hint.mjs gives for it.
 *
 * A hint comes only while the session is quiet: it made no model call for 60 seconds. Then the
 * first of these rules that holds gives the hint:
 *   1. The automatic compaction is near: the context is within `near` tokens of the point at
 *      which Claude Code compacts on its own.
 *   2. A task just ended, and the context has `growth` tokens or more. The sign of a task that
 *      ended comes from the end of the session's log: see `logLook`.
 *   3. The context grew by `growth` tokens or more since the last compaction.
 *
 * A hint comes at most once in 30 minutes per session. Once it is there, it stays while the
 * session stays quiet, so that the person still sees it when they come back to the terminal.
 * After the next model call it is gone, and no hint comes until the 30 minutes are over.
 *
 * The log is looked at only when everything else for rule 2 holds, and at most once after each
 * model call: the log does not change while the session is quiet. A sign counts once. One that
 * is not later than the look before it was there then, and had its hint. So "a task just ended"
 * is not said again for the same task.
 */
export function compactHint({ ctx, window, s, callAt, now, c, path, look }) {
  const out = contextBase(s, ctx)
  // A time of the last call that is not known, or that lies ahead, does not say that the session is quiet.
  if (!c.on || !(ctx > 0) || !Number.isFinite(callAt) || !(now - callAt >= QUIET)) return out
  const was = isObject(s?.compactHint) ? s.compactHint : {}
  const hintAt = past(was.at, now)
  // The hint that came less than 30 minutes ago is still the one on the line, as long as the
  // session made no call since. After a call it is gone, and the rest of the 30 minutes has none.
  const recent = hintAt !== undefined && now - hintAt < HINT_EVERY
  if (recent && callAt > hintAt) return out
  const kept = { at: recent ? hintAt : now, look: past(was.look, now), task: number(was.task) }
  const shown = (part) => ({ ...out, part, checked: kept })

  const point = autoCompactPoint(window)
  if (point !== undefined && ctx >= point - c.near) return shown(['automatic compaction is near: /compact now to choose what stays', 'warn'])

  if (ctx >= c.growth) {
    // A look that was made after the last model call still holds.
    if (!(kept.look > callAt) && typeof path === 'string' && path) {
      const found = look().taskAt
      kept.task = found !== undefined && !(found <= kept.look) ? found : undefined
      kept.look = now
      // The look is kept also when it found nothing, so that the log is not read again on every run.
      if (kept.task === undefined) out.checked = { at: hintAt, look: now }
    }
    if (kept.look > callAt && kept.task !== undefined) return shown([`a task just ended and the context is ${tok(ctx)}: a good moment to /compact`])
  }

  if (ctx - out.base >= c.growth) return shown([`context ${tok(ctx)}: a good moment to /compact`])
  return out
}
