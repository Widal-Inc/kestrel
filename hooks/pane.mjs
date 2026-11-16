// The Kestrel pane inside Claude Code. This file is a mod: Claude Code loads it from the plugin
// through "modules" in hooks/hooks.json, in the terminal (2.1.287 or newer), the desktop app's Code
// tab and VS Code. It draws a pane beside the chat (above the prompt in a narrow terminal) with
// four tabs: Now, the sessions on this computer; Spend, today, the last 7 days, the accounts and
// the top proposals; Settings, every setting as a checkbox; Security, the open findings of
// Kestrel's security checks, each with its detail, a Fix when Kestrel can make one, and a button
// that hands the finding to the agent in this session.
//
// /kestrel:open and /kestrel:settings are the plugin's own command files. A mod hears every slash
// command as the event "command.run", named without its slash, so this module answers those two
// itself: it opens the pane and runs no command. Where nothing draws a pane (claude -p, the Agent
// SDK, an app that places no panes), it hands the command on, and the command file prints the
// same as text.
//
// The module runs inside Claude Code, without Node. It reaches Kestrel only by running the
// plugin's own command file with $.process.run, with an argument list and no shell. A run that
// fails shows as one plain line in the pane. Nothing here uses the network.
//
// Task names follow the setting hud.names: "kestrel top --json" leaves them out while names are
// off, and the pane shows them only on the person's own screen. Nothing the pane shows goes to
// the model: the commands it answers return no text. The one exception is the button "Hand to
// the agent" on the Security tab. After the person says yes, it submits one prompt in the
// session with $.prompt.submit, made of the finding's own fields: its title, where it is and its
// controls. A finding never holds what was matched, so no secret and no patient data can go in.
import { CHECK_NOTE, controlsLine, handPrompt, placeOf } from '../src/finding-words.mjs'
import { money, tok, when } from '../src/format.mjs'

// The pane's id: it opens the pane, and tells this pane apart when Claude Code draws panes.
const PANE = 'kestrel'
const TABS = [
  { id: 'now', label: 'Now', hotkey: '1' },
  { id: 'spend', label: 'Spend', hotkey: '2' },
  { id: 'settings', label: 'Settings', hotkey: '3' },
  { id: 'security', label: 'Security', hotkey: '4' },
]
// The tab each command opens the pane on.
const COMMANDS = { 'kestrel:open': 'now', 'kestrel:settings': 'settings' }
// The Now tab is read again this often while the pane is open, in milliseconds.
const EVERY = 5000
// The longest a run of Kestrel may take. A replay of 30 days of logs for the proposals takes the longest.
const SHORT = 60e3
const LONG = 300e3
const TOOL_NAMES = { Claude: 'Claude Code', Codex: 'Codex', Cowork: 'Cowork' }

// What the pane shows. Each tab keeps its data, the line of a run that failed, and the line of the
// last change. These are lost when the module loads again, and the next open reads them again.
let tab = 'now'
// The session whose detail view is open, by its key, or undefined for the list.
let detail
let timer
const now = { data: undefined, line: undefined, busy: false }
const spend = { summary: undefined, advise: undefined, accounts: undefined, line: undefined, message: undefined, busy: false, read: false, confirm: undefined }
const settings = { data: undefined, line: undefined, message: undefined, project: false, cwd: undefined }
// The Security tab: the answer of "kestrel check --json", the finding whose detail is open (by
// its id), which question is asked ("fix" or "hand"), and the fixes applied while the pane is open.
// `missing` says that this version of Kestrel has no "kestrel check" yet.
const security = { data: undefined, line: undefined, message: undefined, busy: false, missing: false, detail: undefined, confirm: undefined, applied: {} }

/** The first line of a text that is not empty, cut so that it fits one line of the pane. */
function firstLine(text) {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.length > 200 ? `${line.slice(0, 197)}...` : line
}

/**
 * Runs the plugin's own command file with these arguments, with no shell. Resolves `{ ok: true,
 * out }`, or `{ ok: false, line }` with one plain line that says what went wrong. `missing` says
 * that this version of Kestrel has no such command. `cwd` is the folder it runs in, else the
 * session's.
 */
async function kestrel($, args, timeoutMs = SHORT, cwd) {
  let r
  try {
    r = await $.process.run(['node', `${$.plugin.root}/cli/kestrel.mjs`, ...args], cwd ? { timeoutMs, cwd } : { timeoutMs })
  } catch (err) {
    return { ok: false, line: `Kestrel could not run: ${firstLine(err?.message ?? err)}` }
  }
  if (r.exitCode === 0) return { ok: true, out: r.stdout }
  const said = firstLine(r.stderr).replace(/^kestrel: /, '')
  return { ok: false, line: said || `Kestrel ended with exit code ${r.exitCode}.`, missing: r.exitCode === 2 && /^Unknown command /.test(said) }
}

/**
 * The same, for a command that prints JSON: `{ ok: true, data }` or `{ ok: false, line }`. `fits`
 * says whether the data has the shape the pane draws. An answer of another shape is a failure
 * too: drawn as it is, it would throw, and Claude Code would leave the pane empty.
 */
async function kestrelJson($, args, timeoutMs, fits, cwd) {
  const r = await kestrel($, args, timeoutMs, cwd)
  if (!r.ok) return r
  let data
  try {
    data = JSON.parse(r.out)
  } catch {
    data = undefined
  }
  return fits(data) ? { ok: true, data } : { ok: false, line: 'Kestrel gave an answer that could not be read.' }
}
// The shapes of the answers the pane draws.
const isTop = (d) => Array.isArray(d?.sessions) && Array.isArray(d?.limits) && d.sessions.every((s) => s?.shown && Array.isArray(s.also))
const isSummary = (d) => typeof d?.today === 'object' && typeof d?.period === 'object' && d.today && d.period
const isAdvice = (d) => Array.isArray(d?.proposals) && d.proposals.every((p) => Array.isArray(p?.args))
const isAccounts = (d) => Array.isArray(d?.accounts)
const isSettings = (d) => Array.isArray(d?.settings) && Array.isArray(d?.sets) && typeof d?.frameworks === 'object' && d.frameworks
  && d.settings.every((s) => Array.isArray(s?.values)) && (d.accounts === null || d.accounts === undefined || Array.isArray(d.accounts))
const SEVERITIES = ['high', 'medium', 'low', 'info']
const isCheck = (d) => Array.isArray(d?.findings) && Array.isArray(d?.frameworks) && typeof d?.counts === 'object' && d.counts
  && d.findings.every((f) => typeof f?.id === 'string' && typeof f?.title === 'string' && SEVERITIES.includes(f?.severity))

/** Asks Claude Code to draw the pane again. */
function redraw($) {
  $.ui.invalidate('ui.render')
}

/** Reads the sessions for the Now tab. A read that is still running is not started twice. */
async function loadNow($) {
  if (now.busy) return
  now.busy = true
  const r = await kestrelJson($, ['top', '--once', '--json'], SHORT, isTop)
  now.busy = false
  if (r.ok) {
    now.data = r.data
    now.line = undefined
  } else now.line = r.line
  redraw($)
}

/**
 * Reads the Spend tab: today and the last 7 days, the proposals, and the accounts. One after the
 * other, because each reads the logs through the same cache. "kestrel accounts" may not be part of
 * this version yet: then the tab has no accounts, and that is no failure.
 */
async function loadSpend($) {
  if (spend.busy) return
  spend.busy = true
  spend.read = true
  spend.line = undefined
  redraw($)
  const summary = await kestrelJson($, ['summary', '--json'], LONG, isSummary)
  const advise = await kestrelJson($, ['advise', '--json'], LONG, isAdvice)
  const accounts = await kestrelJson($, ['accounts', '--json'], LONG, isAccounts)
  spend.summary = summary.ok ? summary.data : undefined
  spend.advise = advise.ok ? advise.data : undefined
  spend.accounts = accounts.ok ? accounts.data.accounts : undefined
  spend.line = [summary, advise, accounts].find((r) => !r.ok && !r.missing)?.line
  spend.busy = false
  redraw($)
}

/** Reads the settings, for the Settings and Security tabs: for the session's folder while "for this project" is on. */
async function loadSettings($) {
  if (!settings.cwd) settings.cwd = await $.session.cwd()
  const r = await kestrelJson($, ['settings', '--json', ...(settings.project ? ['--project', settings.cwd] : [])], SHORT, isSettings)
  if (r.ok) {
    settings.data = r.data
    settings.line = undefined
  } else settings.line = r.line
  redraw($)
}

/**
 * Reads the Security tab: the settings, for the names of the frameworks, then the open findings
 * from "kestrel check --json" for the session's folder. A version of Kestrel without "kestrel
 * check" is no failure: the tab says that the checks are not part of it yet.
 */
async function loadSecurity($) {
  await loadSettings($)
  const r = await kestrelJson($, ['check', '--json'], SHORT, isCheck, settings.cwd)
  security.missing = !r.ok && !!r.missing
  if (r.ok) security.data = r.data
  security.line = r.ok || r.missing ? undefined : r.line
  redraw($)
}

/** Reads what a tab shows. It never throws: a failure is a line in the pane. */
async function loadTab($) {
  try {
    // The Spend tab is read once each time the pane opens: its replay of the logs takes a while. "Read again" reads it again.
    if (tab === 'now') await loadNow($)
    else if (tab === 'spend') {
      if (!spend.read) await loadSpend($)
    } else if (tab === 'settings') await loadSettings($)
    else await loadSecurity($)
  } catch (err) {
    const line = `Kestrel could not run: ${firstLine(err?.message ?? err)}`
    if (tab === 'now') now.line = line
    else if (tab === 'spend') spend.line = line
    else if (tab === 'settings') settings.line = line
    else security.line = line
    redraw($)
  }
}

/** Shows a tab, and reads what it shows. */
function showTab($, id) {
  tab = id
  detail = undefined
  spend.confirm = undefined
  security.detail = undefined
  security.confirm = undefined
  redraw($)
  return loadTab($)
}

/** The Now tab is read again every 5 seconds while the pane is open. */
function startTimer($) {
  if (timer) return
  timer = $.clock.every(EVERY, () => tick($))
}
function stopTimer() {
  timer?.cancel()
  timer = undefined
}
async function tick($) {
  if (tab === 'now') await loadTab($)
}

/**
 * Changes one setting with "kestrel settings set". The frameworks and the sets go to the session's
 * folder while "for this project" is on.
 */
async function changeSetting($, key, value) {
  const forProject = settings.project && (key.startsWith('security.frameworks.') || key === 'security.set')
  const r = await kestrel($, ['settings', 'set', key, value, ...(forProject ? ['--project', settings.cwd] : [])])
  await loadSettings($)
  settings.message = r.ok ? firstLine(r.out) : undefined
  if (!r.ok) settings.line = r.line
  redraw($)
}

/** Puts back what the last change of a setting replaced. */
async function undoSetting($) {
  const r = await kestrel($, ['settings', 'undo'])
  await loadSettings($)
  settings.message = r.ok ? firstLine(r.out) : undefined
  if (!r.ok) settings.line = r.line
  redraw($)
}

/** Gives an account a label of the person's own, with "kestrel accounts label". */
async function labelAccount($, key, label) {
  if (!String(label).trim()) return
  const r = await kestrel($, ['accounts', 'label', key, String(label).trim()])
  await loadSettings($)
  settings.message = r.ok ? firstLine(r.out) || 'The label is saved.' : undefined
  if (!r.ok) settings.line = r.line
  redraw($)
}

/** Turns "for this project" on or off, and reads the frameworks again for it. */
async function toggleProject($) {
  settings.project = !settings.project
  settings.message = undefined
  await loadSettings($)
}

/** Applies a proposal's change with "kestrel apply", after the person said yes. */
async function applyChange($, proposal) {
  spend.confirm = undefined
  spend.message = `Applying ${proposal.action}...`
  redraw($)
  const r = await kestrel($, ['apply', proposal.action, ...proposal.args], SHORT)
  spend.message = r.ok ? firstLine(r.out) : undefined
  spend.line = r.ok ? undefined : r.line
  if (r.ok) proposal.applied = true
  redraw($)
}

/** Takes an applied change back with "kestrel undo". */
async function undoChange($, proposal) {
  const r = await kestrel($, ['undo', proposal.action], SHORT)
  spend.message = r.ok ? firstLine(r.out) : undefined
  spend.line = r.ok ? undefined : r.line
  if (r.ok) proposal.applied = false
  redraw($)
}

/** Asks once more before a change is applied. */
function askApply($, index) {
  spend.confirm = index
  spend.message = undefined
  redraw($)
}
function cancelApply($) {
  spend.confirm = undefined
  redraw($)
}

/** Opens the detail view of a session, or goes back to the list. */
function openDetail($, key) {
  detail = key
  redraw($)
}

/** Opens the detail of a finding by its id, or goes back to the list of findings. */
function openFinding($, id) {
  security.detail = id
  security.confirm = undefined
  security.message = undefined
  redraw($)
}

/** Asks once before a fix is applied ("fix") or a finding is handed to the agent ("hand"), or takes the question away. */
function askSecurity($, what) {
  security.confirm = what
  security.message = undefined
  redraw($)
}

/** Applies a finding's fix with "kestrel apply", after the person said yes, as the Spend tab does. */
async function applyFix($, action) {
  security.confirm = undefined
  security.message = `Applying ${action}...`
  redraw($)
  const r = await kestrel($, ['apply', action], SHORT)
  security.message = r.ok ? firstLine(r.out) : undefined
  security.line = r.ok ? undefined : r.line
  if (r.ok) security.applied[action] = true
  redraw($)
}

/** Takes an applied fix back with "kestrel undo". */
async function undoFix($, action) {
  const r = await kestrel($, ['undo', action], SHORT)
  security.message = r.ok ? firstLine(r.out) : undefined
  security.line = r.ok ? undefined : r.line
  if (r.ok) delete security.applied[action]
  redraw($)
}

/**
 * Hands a finding to the agent, after the person said yes: one prompt in this session, made of the
 * finding's own fields. Claude Code runs it as a turn of its own once the session is idle. This is
 * the only place where the pane uses tokens.
 */
async function handToAgent($, f) {
  security.confirm = undefined
  const text = handPrompt(f, controlsOf(f))
  try {
    const r = await $.prompt.submit({ text })
    if (r?.drop) {
      security.line = `The prompt was not sent: ${firstLine(r.drop)}`
      security.message = undefined
    } else {
      security.line = undefined
      security.message = 'Sent to Claude in this session. It answers in the chat.'
    }
  } catch (err) {
    security.line = `The prompt could not be sent: ${firstLine(err?.message ?? err)}`
  }
  redraw($)
}

/** Runs the checks with "kestrel check --run" for the session's folder, then reads the findings again. */
async function runChecks($) {
  if (security.busy) return
  security.busy = true
  security.message = undefined
  security.line = undefined
  redraw($)
  try {
    if (!settings.cwd) settings.cwd = await $.session.cwd()
    const r = await kestrel($, ['check', '--run'], LONG, settings.cwd)
    if (r.ok) security.message = firstLine(r.out) || 'The checks ran.'
    else if (r.missing) security.missing = true
    else security.line = r.line
    if (r.ok) await loadSecurity($)
  } catch (err) {
    security.line = `Kestrel could not run: ${firstLine(err?.message ?? err)}`
  } finally {
    security.busy = false
    redraw($)
  }
}

/** A session's key: its tool and its id, so that two tools with the same id stay apart. */
const keyOf = (s) => `${s.tool}-${s.id}`
/** The time of day as HH:MM:SS. */
function clockOf(ms) {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}
/** Text cut to a width, with "..." at its end when it was longer. */
const cut = (text, width) => (text.length > width ? `${text.slice(0, Math.max(1, width - 3))}...` : text)

// Small builders for the tree. `ui` is the table of elements that $.ui.resolve gives.
const line = (ui, text, props = {}) => ui.Text({ ...props, children: [text] })
const blank = (ui) => ui.Text({ children: [' '] })
const heading = (ui, text) => ui.Text({ bold: true, children: [text] })
const failed = (ui, text) => ui.Text({ color: 'error', children: [text] })

/** The row of tabs, each a button with its digit. */
function tabRow($, ui) {
  return ui.Box({
    flexDirection: 'row',
    columnGap: 3,
    children: TABS.map((t) => ui.Button({ key: `tab-${t.id}`, label: t.label, hotkey: t.hotkey, plain: true, dimColor: tab !== t.id, onPress: () => showTab($, t.id) })),
  })
}

/** The rows of the Now tab as lines of the same columns. */
function rowLabels(sessions, width) {
  const cols = ['session', 'tool', 'ticket', 'state', 'context', 'cache']
  const widths = cols.map((c) => Math.max(...sessions.map((s) => (s.shown[c] ?? '').length)))
  return sessions.map((s) => {
    const parts = cols.map((c, i) => (s.shown[c] ?? '').padEnd(widths[i]))
    if (s.shown.today) parts.push(`today ${s.shown.today}`)
    return cut(parts.join('  ').trimEnd(), width)
  })
}

/** The Now tab: the sessions, each a button that opens its detail view, and the footer of "kestrel top". */
function drawNow($, ui, width) {
  const d = now.data
  const out = now.line ? [failed(ui, now.line)] : []
  if (!d) return now.line ? out : [line(ui, 'Reading the sessions...', { dimColor: true })]
  if (detail) return [...out, ...drawDetail($, ui, d)]
  const head = [`${d.count} ${d.count === 1 ? 'session' : 'sessions'} on this computer`, ...d.limits.map((l) => l.text), clockOf(d.at)].join(' · ')
  out.push(line(ui, cut(head, width)), blank(ui))
  if (!d.sessions.length) out.push(line(ui, 'No agent session runs on this computer now.'))
  const labels = rowLabels(d.sessions, width)
  d.sessions.forEach((s, i) => out.push(ui.Button({ key: `session-${keyOf(s)}`, label: labels[i], plain: true, onPress: () => openDetail($, keyOf(s)) })))
  out.push(blank(ui), line(ui, d.waste, { dimColor: true }))
  if (d.next) out.push(line(ui, d.next, { color: 'warning' }))
  out.push(line(ui, 'Press a row for its details. The list is read again every 5 seconds.', { dimColor: true }))
  return out
}

/** The detail view of one session, with a Back button. */
function drawDetail($, ui, d) {
  const back = ui.Button({ key: 'back', label: 'Back', hotkey: 'b', plain: true, onPress: () => openDetail($, undefined) })
  const s = d.sessions.find((x) => keyOf(x) === detail)
  if (!s) return [line(ui, 'This session is not open any more.'), blank(ui), back]
  const lines = [
    `Project: ${s.project ?? '(unknown folder)'}`,
    `Tool: ${TOOL_NAMES[s.tool] ?? s.tool}`,
    `Ticket: ${s.ticket ?? 'none'}${s.also.length ? `, also open in ${s.also.join(', ')}` : ''}`,
    `State: ${s.shown.state}`,
    `Context: ${s.shown.context || 'not known'}`,
    `Cache: ${s.shown.cache}`,
    `Tokens today: ${s.shown.today || 'none yet'}`,
    `Agents running: ${s.agents}`,
  ]
  // The task is there only while names are on.
  if (s.task) lines.push(`Task: ${s.task}`)
  if (s.resume) lines.push(`Resume it in a terminal with: ${s.resume}`)
  return [heading(ui, s.shown.session), ...lines.map((l) => line(ui, l)), blank(ui), back]
}

/**
 * Dollars with the word for what they are: spend for an account that pays by the token, API value
 * on a subscription (what the same use would cost by the token). `dollars` is what "kestrel
 * accounts --json" says. A version of Kestrel that does not say it gives the dollars alone.
 */
const valued = (amount, dollars) => (dollars === 'API value' ? `${money(amount)} of API value` : dollars === 'spend' ? `${money(amount)} spend` : money(amount))

/** A price a month: whole dollars without cents. */
const monthly = (x) => (Number.isInteger(x) ? `$${x.toLocaleString('en-US')}` : money(x))

/**
 * The dollars of a part of "kestrel summary --json", with what they are: `paid` splits them into
 * spend by the token, API value on subscriptions, and dollars of accounts whose way to pay is not
 * known. A version of Kestrel without `paid` gives the dollars alone.
 */
function paidWords(part) {
  const p = part?.paid
  const has = (k) => Number.isFinite(p?.[k]) && p[k] > 0
  if (!p || ![has('token'), has('subscription'), has('unknown')].some(Boolean)) return money(part?.cost ?? 0)
  if (has('token') && !has('subscription') && !has('unknown')) return `${money(p.token)} spend`
  if (has('subscription') && !has('token') && !has('unknown')) return `${money(p.subscription)} of API value`
  if (!has('token') && !has('subscription')) return money(part.cost)
  const words = [has('token') && `${money(p.token)} spend by the token`, has('subscription') && `${money(p.subscription)} of API value on subscriptions`, has('unknown') && `${money(p.unknown)} at list prices`].filter(Boolean)
  return words.length === 2 ? words.join(' and ') : words.join(', ')
}

/** One account on the Spend tab, from "kestrel accounts --json": its dollars with what they are, and the price of its plan when known. */
function accountLine(a, days) {
  const limits = [a.limits?.five && `5 hours ${a.limits.five.pct}% used`, a.limits?.week && `week ${a.limits.week.pct}% used`].filter(Boolean)
  const price = Number.isFinite(a.price?.monthly) ? `${monthly(a.price.monthly)} a month` : undefined
  const what = [a.tool, a.plan, price].filter(Boolean).join(', ')
  const parts = [`today ${tok(a.today?.tokens ?? 0)} tokens, ${valued(a.today?.cost ?? 0, a.dollars)}`, `last ${days} days ${valued(a.period?.cost ?? 0, a.dollars)}`, ...limits]
  return `${a.label ?? a.key}${what ? ` (${what})` : ''}: ${parts.join(', ')}`
}

/** The Spend tab: today and the last 7 days, per account, and the top 3 proposals with Apply or Undo. */
function drawSpend($, ui) {
  const out = spend.line ? [failed(ui, spend.line)] : []
  if (spend.busy) out.push(line(ui, 'Reading the logs. The first time can take a while.', { dimColor: true }))
  const s = spend.summary
  if (s) {
    out.push(heading(ui, 'Spend'))
    out.push(line(ui, `Today: ${tok(s.today.tokens)} tokens, ${paidWords(s.today)}, ${s.today.calls} model calls`))
    out.push(line(ui, `Last ${s.days} days: ${tok(s.period.tokens)} tokens, ${paidWords(s.period)}, ${s.period.sessions} sessions`))
    out.push(line(ui, 'Dollars are list prices. Paid by the token they are spend. On a subscription they are API value: what the same use would cost by the token.', { dimColor: true }))
  }
  if (spend.accounts?.length) {
    out.push(blank(ui), heading(ui, 'Per account'))
    for (const a of spend.accounts) out.push(line(ui, accountLine(a, s?.days ?? 7)))
  }
  if (spend.advise) {
    const top = spend.advise.proposals.slice(0, 3)
    out.push(blank(ui), heading(ui, `Proposals from a replay of the last ${spend.advise.days} days`))
    if (!top.length) out.push(line(ui, 'Nothing was found that would have saved 1% or more.'))
    top.forEach((p, i) => {
      out.push(line(ui, `${i + 1}. ${p.title}: ${p.saving === null ? 'no amount yet' : `${money(p.saving)} less`}`))
      if (spend.confirm === i) {
        out.push(line(ui, `Apply ${p.action}? It changes Claude Code's settings, with a backup.`, { color: 'warning' }))
        out.push(ui.Box({
          flexDirection: 'row',
          columnGap: 3,
          children: [
            ui.Button({ key: 'confirm-yes', label: 'Yes, apply', hotkey: 'y', plain: true, onPress: () => applyChange($, p) }),
            ui.Button({ key: 'confirm-no', label: 'No', hotkey: 'n', plain: true, onPress: () => cancelApply($) }),
          ],
        }))
      } else if (p.action && p.applied) out.push(ui.Button({ key: `undo-${i}`, label: `Undo ${p.action}`, plain: true, onPress: () => undoChange($, p) }))
      else if (p.action) out.push(ui.Button({ key: `apply-${i}`, label: `Apply ${[p.action, ...p.args].join(' ')}`, plain: true, onPress: () => askApply($, i) }))
      else out.push(line(ui, 'This change is made by hand. "kestrel advise" says how.', { dimColor: true }))
    })
  }
  if (spend.message) out.push(blank(ui), line(ui, spend.message))
  out.push(blank(ui), ui.Button({ key: 'read-again', label: 'Read again', hotkey: 'r', plain: true, onPress: () => loadSpend($) }))
  return out
}

/** One setting as a control: a checkbox for on and off, a button that moves on for two choices, a Select for more. */
function settingControl($, ui, s) {
  const key = `setting-${s.key}`
  if (s.kind === 'on-off') return ui.Button({ key, label: `[${s.value === 'on' ? 'x' : ' '}] ${s.label}`, plain: true, onPress: () => changeSetting($, s.key, s.value === 'on' ? 'off' : 'on') })
  if (s.values.length > 2) return ui.Select({ key, label: s.label, value: s.value, options: s.values.map((v) => ({ value: v, label: v })), onSelect: (v) => changeSetting($, s.key, v) })
  const next = s.values[(s.values.indexOf(s.value) + 1) % s.values.length]
  return ui.Button({ key, label: `${s.label}: ${s.value} (press for ${next})`, plain: true, onPress: () => changeSetting($, s.key, next) })
}

/** The Settings tab: every setting in its group, the switch for this project, the sets, the accounts' labels and Undo. */
function drawSettings($, ui) {
  const d = settings.data
  const out = settings.line ? [failed(ui, settings.line)] : []
  if (!d) return settings.line ? out : [line(ui, 'Reading the settings...', { dimColor: true })]
  let group
  for (const s of d.settings) {
    if (s.group !== group) {
      // The frameworks start with the switch for this project, and end with the sets.
      if (s.group.startsWith('Frameworks:') && !group?.startsWith('Frameworks:')) {
        out.push(blank(ui), heading(ui, 'Security frameworks'))
        out.push(ui.Button({ key: 'project', label: `[${settings.project ? 'x' : ' '}] For this project: ${settings.cwd ?? 'the session\'s folder'}`, plain: true, onPress: () => toggleProject($) }))
        if (settings.project) out.push(line(ui, d.frameworks.from === 'project' ? `From ${d.frameworks.file}.` : `This project has no frameworks of its own yet. A change writes ${d.frameworks.file}.`, { dimColor: true }))
      }
      if (group?.startsWith('Frameworks:') && !s.group.startsWith('Frameworks:')) out.push(...setButtons($, ui, d))
      group = s.group
      out.push(blank(ui), heading(ui, group))
    }
    out.push(settingControl($, ui, s))
  }
  out.push(blank(ui), line(ui, d.note))
  if (d.accounts?.length) {
    out.push(blank(ui), heading(ui, 'Account labels'))
    for (const a of d.accounts) {
      out.push(ui.Input({ key: `label-${a.key}`, label: a.label ? `${a.label} (${a.key})` : a.key, placeholder: 'type a new label and press Enter', value: '', submitLabel: 'save', onSubmit: (v) => labelAccount($, a.key, v) }))
    }
  }
  if (settings.message) out.push(blank(ui), line(ui, settings.message))
  out.push(blank(ui), ui.Button({ key: 'undo', label: 'Undo the last change', hotkey: 'u', plain: true, onPress: () => undoSetting($) }))
  return out
}

/** The buttons for the three sets, each switching several frameworks on at once. */
function setButtons($, ui, d) {
  return [
    blank(ui),
    line(ui, 'Sets switch several frameworks on at once:', { dimColor: true }),
    ui.Box({ flexDirection: 'row', columnGap: 3, children: d.sets.map((set) => ui.Button({ key: `set-${set.value}`, label: `${set.label} set`, plain: true, onPress: () => changeSetting($, 'security.set', set.value) })) }),
  ]
}

const FRAMEWORK_PREFIX = 'security.frameworks.'
/** The label of each framework, by its key, from the settings. */
function frameworkLabels() {
  const list = settings.data?.settings ?? []
  return Object.fromEntries(list.filter((s) => s.key.startsWith(FRAMEWORK_PREFIX)).map((s) => [s.key.slice(FRAMEWORK_PREFIX.length), s.label]))
}
/** The frameworks of the AI agents group: their controls show for a finding that touches no framework that is on. */
const agentFrameworks = () => (settings.data?.settings ?? []).filter((s) => s.group === 'Frameworks: AI agents').map((s) => s.key.slice(FRAMEWORK_PREFIX.length))
/** The controls of a finding that the tab shows: those of the frameworks that are on. */
const controlsOf = (f) => controlsLine(f, { on: security.data?.frameworks ?? [], labels: frameworkLabels(), fallback: agentFrameworks() })

/** The two buttons of a question, Yes and No. */
function yesNo($, ui, yes, onYes) {
  return ui.Box({
    flexDirection: 'row',
    columnGap: 3,
    children: [
      ui.Button({ key: 'security-yes', label: yes, hotkey: 'y', plain: true, onPress: onYes }),
      ui.Button({ key: 'security-no', label: 'No', hotkey: 'n', plain: true, onPress: () => askSecurity($, undefined) }),
    ],
  })
}

/**
 * The Security tab: at the top the frameworks that are on, the open findings by severity and the
 * sentence that Kestrel does not certify; then one row per open finding, the most severe first.
 * A row opens the finding's detail. "Run checks" runs the checks for the session's folder.
 */
function drawSecurity($, ui, width) {
  const d = security.data
  const fail = security.line ?? settings.line
  const out = fail ? [failed(ui, fail)] : []
  if (security.detail && d) return [...out, ...drawFinding($, ui)]
  if (!d && !settings.data && !security.missing) return fail ? out : [line(ui, 'Reading the findings...', { dimColor: true })]
  const labels = frameworkLabels()
  const on = d?.frameworks ?? (settings.data?.settings ?? []).filter((s) => s.key.startsWith(FRAMEWORK_PREFIX) && s.value === 'on').map((s) => s.key.slice(FRAMEWORK_PREFIX.length))
  out.push(heading(ui, 'Frameworks that are on'), line(ui, on.length ? on.map((id) => labels[id] ?? id).join(', ') : 'None.'))
  if (settings.data?.frameworks.from === 'project') out.push(line(ui, `For ${settings.data.frameworks.project}, from ${settings.data.frameworks.file}.`, { dimColor: true }))
  if (security.missing) {
    out.push(blank(ui), line(ui, 'The checks are not part of this version of Kestrel yet.'), line(ui, CHECK_NOTE, { dimColor: true }))
  } else if (!d) {
    if (!fail) out.push(blank(ui), line(ui, 'Reading the findings...', { dimColor: true }))
  } else {
    out.push(line(ui, `Open findings: ${SEVERITIES.map((s) => `${d.counts[s] ?? 0} ${s}`).join(', ')}`))
    out.push(line(ui, typeof d.note === 'string' && d.note ? d.note : CHECK_NOTE, { dimColor: true }), blank(ui))
    if (!d.findings.length) out.push(line(ui, 'No check has found anything open.'))
    for (const f of d.findings) {
      const controls = controlsOf(f)
      const label = [f.severity.toUpperCase(), f.title, placeOf(f.where), controls].filter(Boolean).join('  ')
      out.push(ui.Button({ key: `finding-${f.id}`, label: cut(label, width), plain: true, onPress: () => openFinding($, f.id) }))
    }
    if (d.findings.length) out.push(line(ui, 'Press a row for its detail.', { dimColor: true }))
  }
  if (security.busy) out.push(blank(ui), line(ui, 'Running the checks...', { dimColor: true }))
  if (security.message) out.push(blank(ui), line(ui, security.message))
  out.push(blank(ui), ui.Button({ key: 'run-checks', label: 'Run checks for this folder', hotkey: 'r', plain: true, onPress: () => runChecks($) }))
  out.push(line(ui, 'Cloud checks run only when you ask, in a terminal: kestrel cloud-check aws, vercel or github.', { dimColor: true }))
  return out
}

/**
 * The detail of one finding: all its fields (none holds what was matched), its fix command, and
 * when it was first and last seen. Then Fix, when the finding names a fix that Kestrel makes, and
 * Hand to the agent, each asking once, and Back.
 */
function drawFinding($, ui) {
  const back = ui.Button({ key: 'finding-back', label: 'Back', hotkey: 'b', plain: true, onPress: () => openFinding($, undefined) })
  const f = security.data.findings.find((x) => x.id === security.detail)
  if (!f) return [line(ui, 'This finding is not open any more.'), blank(ui), back]
  const labels = frameworkLabels()
  const shown = controlsOf(f)
  const all = (Array.isArray(f.controls) ? f.controls : []).filter((c) => c && typeof c === 'object').map((c) => `${labels[c.framework] ?? c.framework} ${c.id}${c.confirmed === true ? '' : ' (id to check)'}`)
  const lines = [
    `Severity: ${f.severity}`,
    `Kind: ${f.kind}`,
    `Rule: ${f.rule}`,
    `Where: ${placeOf(f.where)}`,
    ...(f.detail ? [`What: ${f.detail}`] : []),
    `Controls of the frameworks that are on: ${shown || 'none'}`,
    ...(all.length ? [`Every control it touches: ${all.join('; ')}`] : []),
    ...(Array.isArray(f.reported) && f.reported.length ? [`Frameworks the tool reported: ${f.reported.join(', ')}`] : []),
    `Found by: ${f.source ?? 'kestrel'}`,
    `Fix: ${f.fix?.words ?? 'none that Kestrel makes. The finding says what to change.'}`,
    ...(f.firstSeen ? [`First seen: ${when(f.firstSeen)}`, `Last seen: ${when(f.lastSeen ?? f.firstSeen)}`] : []),
  ]
  const out = [heading(ui, f.title), ...lines.map((l) => line(ui, l)), blank(ui)]
  const action = f.fix?.action
  if (security.confirm === 'fix' && action) {
    out.push(line(ui, `Apply ${action}? It changes Claude Code's settings, with a backup.`, { color: 'warning' }), yesNo($, ui, 'Yes, apply', () => applyFix($, action)))
  } else if (action && security.applied[action]) out.push(ui.Button({ key: 'finding-undo', label: `Undo ${action}`, plain: true, onPress: () => undoFix($, action) }))
  else if (action) out.push(ui.Button({ key: 'finding-fix', label: `Fix: ${f.fix.words ?? `kestrel apply ${action}`}`, hotkey: 'f', plain: true, onPress: () => askSecurity($, 'fix') }))
  if (security.confirm === 'hand') {
    out.push(line(ui, 'Send this finding to Claude in this session? It uses tokens.', { color: 'warning' }), yesNo($, ui, 'Yes, send', () => handToAgent($, f)))
  } else out.push(ui.Button({ key: 'finding-hand', label: 'Hand to the agent (the only button that uses tokens)', hotkey: 'h', plain: true, onPress: () => askSecurity($, 'hand') }))
  if (security.message) out.push(blank(ui), line(ui, security.message))
  out.push(blank(ui), back)
  return out
}

/** The whole pane: the row of tabs, then the open tab. */
function drawPane($, ui, e) {
  const width = Math.max(20, e.props?.bodyColumns ?? 80)
  const body = tab === 'now' ? drawNow($, ui, width) : tab === 'spend' ? drawSpend($, ui) : tab === 'settings' ? drawSettings($, ui) : drawSecurity($, ui, width)
  return ui.Box({ flexDirection: 'column', children: [tabRow($, ui), blank(ui), ...body] })
}

export function register(on) {
  // Runs for /kestrel:open and /kestrel:settings, the plugin's own command files.
  on('command.run', { command: ['kestrel:open', 'kestrel:settings'] }, async ($, e, next) => {
    tab = COMMANDS[e.command] ?? 'now'
    detail = undefined
    spend.confirm = undefined
    security.detail = undefined
    security.confirm = undefined
    spend.read = false
    const placed = await $.ui.open({ id: PANE, title: 'Kestrel', focus: true, closeOnEscape: true })
    if (!placed?.isPlaced) {
      // Nothing draws the pane here: the command file prints the same as text.
      await $.ui.close({ id: PANE })
      return next(e)
    }
    startTimer($)
    // Not waited for: the pane shows that it reads, and draws again when the data is there.
    loadTab($)
    // Nothing in the transcript, and nothing for the model.
    return {}
  })

  // Runs each time Claude Code draws a pane. Other panes are left alone.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    return drawPane($, $.ui.resolve(e), e)
  })

  // The pane closes (Esc, the close mark, or a reload): the Now tab is no longer read.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    stopTimer()
    return next(e)
  })
}
