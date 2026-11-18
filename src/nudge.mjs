// The notification before a session's cache ends.
//
// A provider keeps the context of a session in its cache for a while after the last call: 5
// minutes or 1 hour. The first call after that sends the whole context again. A short message
// before the end keeps the cache. So the status line, which Claude Code can run on a timer, shows
// a notification of the operating system shortly before the end. It is off until the person
// turns it on. While keep-warm wakes a session before that end, the status line shows none.
//
// Claude Code compacts a large idle session on its own before its 1 hour cache ends. For such a
// session the notification says that, because then the choice is another one: send a message
// to keep the full context, or compact now and say what stays.
import { spawn as startProgram } from 'node:child_process'
import { config } from './config.mjs'
import { clock, count, money, tok } from './format.mjs'

// Off, 5 minutes before the end, and only for 100,000 tokens or more: a smaller context costs
// little to send again.
const DEFAULTS = { on: false, before: 5, min: 100_000 }

/** The settings of the notification: `{ on, before, min }`, with the defaults for what is not set. */
export const nudgeConfig = (cfg = config()) => ({ ...DEFAULTS, ...cfg?.nudge })

/** The settings in words, for "widal nudge" and the row of "widal doctor". */
export function nudgeSettingsText(n) {
  const when = `${n.before} ${n.before === 1 ? 'minute' : 'minutes'} before the end, when the next call would send ${count(n.min)} tokens or more again`
  return n.on ? `on, ${when}` : `off (when on: ${when})`
}

/**
 * Whether the notification is to be shown now. `until` is when the cache ends and `now` the time,
 * both in milliseconds. `recache` is the number of tokens the next call sends again once the cache
 * is gone. `nudgedFor` is the end that the last notification of this session was for. `cfg` is
 * what `nudgeConfig` gives.
 */
export function nudgeDue({ until, ttl, recache, nudgedFor, now, cfg }) {
  // A cache that has ended cannot be kept any more.
  if (!cfg?.on || !(until > now)) return false
  // A 5 minute cache is always close to its end, so it gets the notification in its last minute.
  const lead = (ttl === '5m' ? 1 : cfg.before) * 60e3
  // One notification per end: the next one comes after a call has moved the end.
  return until - now <= lead && recache >= cfg.min && nudgedFor !== until
}

// Claude Code compacts an idle session on its own before its 1 hour cache ends, when the
// session has about this many tokens or more. Its setting "idleCompaction": false turns that off.
const IDLE_COMPACTION_FROM = 200_000

/**
 * The words of the notification: `{ title, body }`. `project` is the short name of the session's
 * folder, and no other text of the session is used. `mode` is how the person pays. By the token
 * the body gives `coldCost`, the dollars the next call costs once the cache is gone. On a
 * subscription, or when the model has no price, it gives the tokens.
 *
 * `keepWarmStopped` is the cap of keep-warm in words ("3 hours") when keep-warm kept this cache
 * until now and has reached its cap. The body then starts with that, so that the person knows
 * why the notification comes now and no wake.
 *
 * `ttl` is how long the cache lasts ("5m" or "1h"), and `idleCompaction` is Claude Code's
 * setting of that name. When the cache lasts 1 hour, the tokens to send again are 200,000 or
 * more, and the setting is not `false`, Claude Code compacts the idle session on its own before
 * the cache ends. The body then says that instead, with the tokens and the end of the cache.
 */
export function nudgeText({ project, until, recache, mode, coldCost, keepWarmStopped, ttl, idleCompaction }) {
  const title = `widal: ${project ? `${project} ` : ''}cache ends at ${clock(until)}`
  const stopped = keepWarmStopped ? `Keep-warm stopped after ${keepWarmStopped}. ` : ''
  if (ttl === '1h' && recache >= IDLE_COMPACTION_FROM && idleCompaction !== false) {
    return { title, body: `${stopped}Soon Claude Code compacts this idle session on its own (${tok(recache)} tokens). To keep the full context, send a message before ${clock(until)}. To choose what stays, run /compact with your own words now.` }
  }
  const next = mode === 'usage' && Number.isFinite(coldCost) ? `costs about ${money(coldCost)}` : `sends ${tok(recache)} tokens again`
  return { title, body: `${stopped}After that the next call ${next}. To keep it, send any message before then. Done for now? Run /compact first.` }
}

/** Text as an AppleScript string: in quotes, with a backslash before each backslash and each quote. */
const appleScriptText = (text) => `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/**
 * Shows a notification of the operating system: with osascript on macOS, with notify-send on
 * Linux. On any other system it does nothing. `spawn` stands in for the start of the program in
 * a test.
 *
 * The program gets its arguments as a list and never goes through a shell, so no text can be
 * read as a command. It runs on its own: this process does not wait for it, does not read its
 * output, and a program that is missing or fails is not an error here.
 */
export function notify(title, body, { platform = process.platform, spawn = startProgram } = {}) {
  const command =
    platform === 'darwin' ? ['osascript', ['-e', `display notification ${appleScriptText(body)} with title ${appleScriptText(title)}`]]
    : platform === 'linux' ? ['notify-send', [String(title), String(body)]]
    : undefined
  if (!command) return
  try {
    const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' })
    // A program that is not installed is reported as an "error" event. Without a listener that
    // event would end this process with an error.
    child?.on?.('error', () => {})
    child?.unref?.()
  } catch {
    // No notification. The status line goes on.
  }
}
