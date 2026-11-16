#!/usr/bin/env node
// Kestrel: shows what AI coding agents on this machine spend, what the money pays for, and
// holds a limit. It reads the session logs of Claude Code, of Codex, and of Cowork sessions that
// ran on this computer. Nothing leaves the machine, unless the person links it to a Kestrel board
// ("kestrel board login"): then it sends what it records to that board, never the text of a session.
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { labelOf, readAccounts, setLabel, setPrice, updateAccounts } from '../src/accounts.mjs'
import { analyze } from '../src/analyze.mjs'
import { appCommand, appDir, copyApp, fromPlugin, nodeNote, refreshCopy, removeApp, version } from '../src/app.mjs'
import { ACTIONS, actionsStatus, applied, apply, undo } from '../src/actions.mjs'
import { adviseData, adviseReport, measureReport } from '../src/advise.mjs'
import { billing, billingText, storedLimits } from '../src/billing.mjs'
import { banner } from '../src/bird.mjs'
import { boardCommand, readBoard, startBoardSync } from '../src/board.mjs'
import { coldStartHook, config, keepWarmHook, limitHook, limitParts, modelSwitchHook, saveConfig, statusLine } from '../src/claude-code.mjs'
import { DEFAULT_KEEP, compactHintConfig, compactHintSettingsText, compactKeepText, saveCompactKeep } from '../src/compact.mjs'
import { money, table, when } from '../src/format.mjs'
import { branchInRepo, currentBranch } from '../src/git.mjs'
import { hintConfig, hintSettingsText } from '../src/hint.mjs'
import { hudCommand } from '../src/hud.mjs'
import { installStatusLine, installed, refreshText, setHook, setSecurityHooks, uninstall } from '../src/install.mjs'
import { keepWarmReport } from '../src/keep-warm.mjs'
import { ensureOwnLink, isOwnLink, isThere, linkOf, otherProgram, ownLink } from '../src/links.mjs'
import { migrate } from '../src/migrate.mjs'
import { nudgeConfig, nudgeSettingsText } from '../src/nudge.mjs'
import { ClaudeParser } from '../src/parse-claude.mjs'
import { PLUGIN_HOOKS, hookPlace, inSettings, pluginHookRuns, setPluginHook } from '../src/plugin.mjs'
import { accountsData, accountsText } from '../src/accounts-report.mjs'
import { CALL_HEAD, CALL_RIGHT, COWORK_NOTE, branch, branches, callLine, callsReport, compactions, findings, models, session, summary, summaryData, tickets } from '../src/report.mjs'
import { OLD_NAME, home } from '../src/paths.mjs'
import { refreshToday } from '../src/refresh-today.mjs'
import { settingsCommand } from '../src/settings.mjs'
import { load, logFiles } from '../src/store.mjs'
import { top } from '../src/top.mjs'

const USAGE = `kestrel: what your AI coding agents spend, and what the money pays for.

  kestrel summary [--days 7]       spend by day, project and model, and what it paid for
  kestrel summary --json           today and the period as data, for the pane in Claude Code
  kestrel session [id] [--days 7]  one session: cache losses, what filled the context
  kestrel calls [id] [-n 30]       one line per model call of a session
  kestrel live                     the same lines, as the calls happen
  kestrel findings [--days 7]      where the money went and what can be done, largest first
  kestrel branches [--days 7]      spend per project folder and git branch
  kestrel branch [name]            one branch (default: the one checked out here), with a line for the pull request
  kestrel tickets [--days 7]       spend per ticket, from the git branch that each call names
  kestrel top [--once]             every agent session on this computer now, drawn again every 2 seconds (q ends it)
  kestrel top --once --no-names    the same once, without the names of tasks
  kestrel top --once --json        the same once as data, for the pane in Claude Code (tasks only while names are on)
  kestrel refresh-today            work out today's numbers for the status line and "kestrel top" (the status line runs it)
  kestrel accounts [--days 7]      the dollars, the plan's limits and its price per account: Claude, Cowork, Codex
  kestrel accounts --json          the same as JSON
  kestrel accounts label <key> "<label>"   give an account your own name (take it away with: --clear)
  kestrel accounts price <key> <dollars>   the price of an account's plan a month (take it away with: --clear)
  kestrel models [--days 30]       spend by model, effort level and kind of work
  kestrel compactions [--days 30]  the compactions of your sessions: how many, and the context before and after
  kestrel advise [--days 30]       changes that would have saved money, from a replay of your logs
  kestrel advise --json            the same as data, for the pane in Claude Code
  kestrel apply [name] [options]   make one of those changes in Claude Code (with a backup)
  kestrel undo [name]              take a change back
  kestrel measure [name]           before and after a change
  kestrel limit --session 50 --day 200 [--action ask|warn|stop]
  kestrel limit --off              remove the limits
  kestrel plan                     how you pay: by subscription, or by the token (usage)
  kestrel plan subscription|usage  set that by hand (take it back with: kestrel plan auto)
  kestrel nudge                    the notification before a session's cache ends, and its settings
  kestrel nudge on [--before 5] [--min 100000]
  kestrel nudge off                turn that notification off
  kestrel compact-keep             the text that says what a summary has to keep, at every compaction
  kestrel compact-keep "<text>"    set your own text (put the default back with: kestrel compact-keep --default)
  kestrel hint                     the hints on the status line (the effort level, a good moment to compact), and their settings
  kestrel hint on|off              turn those hints on or off
  kestrel hud                      the lines of the status line: the settings, and a preview with sample data
  kestrel hud lines [list]         the lines to show, in this order: any of session,plan,work,hint (no list: all four)
  kestrel hud one                  one line instead of the lines
  kestrel hud bars on|off          bars for the context and the plan's limits, or numbers only
  kestrel hud names on|off         the names of tasks and agents on the status line, or counts only
  kestrel hud undo                 put back the settings from before the last change
  kestrel settings                 every setting: the status line, the hints, the security frameworks (a list to change in a terminal)
  kestrel settings --json          the same as data, with the allowed values
  kestrel settings set <key> <value> [--project <folder>]
                                   change one, for example: kestrel settings set security.frameworks.hipaa on
  kestrel settings undo            put back what the last "settings set" changed
  kestrel check [--run] [--json]   the open security findings, the most severe first (--run checks this folder first)
  kestrel check --export <file.csv>   the open and resolved findings with their dates and controls, for an audit
  kestrel apply no-bypass|deny-secret-files|transcript-days [--days 7]   the fixes that the findings name
  kestrel security-run             run the security checks (the hooks start it in the background)
  kestrel cloud-check aws [--profile <name>] [--region <r>] [--minutes 20]
  kestrel cloud-check vercel [--project <name>] [--team <id>]
  kestrel cloud-check github [--repo <owner/name>]
                                   read-only security checks of a cloud account, only when you run them
                                   (kestrel check --cloud <provider> is the same)
  kestrel hooks                    the hooks that the plugin carries: whether each runs, and from where
  kestrel hooks off|on <name>      turn one of them off or on
  kestrel install [--force]        put the command on your PATH and set Claude Code's status line
  kestrel install --refresh 30     the seconds between two runs of the status line (0: only after an answer)
  kestrel uninstall                take both out of Claude Code again
  kestrel migrate                  bring an install made under the old name, agent-spend, to the name kestrel
  kestrel status                   what is installed, and the limits
  kestrel mcp                      the server that the Claude desktop app starts (see docs/desktop.md)
  kestrel board login <address>    link this computer to your team's Kestrel board, for example:
                                   kestrel board login https://kestrel.widal.com
  kestrel board status             the board, the team, the last sync, and whether the board still knows this computer
  kestrel board sync [--days 30]   send now what Kestrel recorded (it also runs on its own every 10 minutes)
  kestrel board logout             unlink this computer: Kestrel sends nothing more
  kestrel --version               the version of this tool

The reports read the session logs of Claude Code, of Codex, and of Cowork sessions that ran on this
computer. Dollar figures are list prices per token. For an account that pays by the token they are
spend. On a subscription they are API value: what the same use would cost by the token, not what
you pay. Everything stays on this machine, unless you link it
to a Kestrel board with "kestrel board login": then Kestrel sends what it records to that board.
It never sends the text of prompts, answers, tool results or files.`

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  if (i < 0) return fallback
  const v = argv[i + 1]
  argv.splice(i, v === undefined || v.startsWith('--') ? 1 : 2)
  return v === undefined || v.startsWith('--') ? true : v
}
const stdin = () => {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return {}
  }
}
/** The field names of a value, with numbers kept and all text replaced by its length. */
const shape = (v) =>
  Array.isArray(v) ? [`${v.length} items`]
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]))
  : typeof v === 'string' ? `text of ${v.length}`
  : v
const self = realpathSync(fileURLToPath(import.meta.url))
// The link that puts the command on the PATH, and the link it had under the tool's old name.
// Claude Code's settings never call these: they call the link in the tool's own folder, made
// with ensureOwnLink or by "install" and "migrate". See src/links.mjs.
const LINK = linkOf('kestrel')
const OLD_LINK = linkOf(OLD_NAME)
/**
 * The command's file that the links point at. From a checkout it is this file. A plugin's folder
 * changes with every update, so from there it is the file in the stable copy of the tool, which
 * is made, or brought to this version, first. `say` gets a sentence when the tool was copied.
 */
function target(say = () => {}) {
  if (!fromPlugin()) return self
  if (version(appDir()) !== version()) {
    copyApp()
    say(`Copied the tool to ${appDir()}, because the plugin's own folder changes with every update.`)
  }
  return appCommand()
}
const progress = (done, all) => {
  if (!process.stderr.isTTY || all < 5) return
  process.stderr.write(done === all ? '\r\x1b[K' : `\rReading session logs: ${done} of ${all}`)
}

async function main() {
  // With no arguments at all: the bird, and below it every command.
  if (!argv.length) return console.log(`${banner(version())}\n\n${USAGE}`)
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'summary'
  if (cmd === 'help' || flag('--help') || flag('-h')) return console.log(USAGE)
  if (flag('--version')) return console.log(version())

  // The two commands Claude Code runs. They never fail and never print an error.
  if (cmd === 'statusline') {
    try {
      const input = stdin()
      // For checking what Claude Code really sends: while the file "debug" is in this tool's folder,
      // the names of the fields (not their text) are saved next to it.
      if (existsSync(join(home(), 'debug'))) writeFileSync(join(home(), 'statusline-fields.json'), JSON.stringify(shape(input), null, 2))
      process.stdout.write(statusLine(input))
    } catch {
      // Print nothing: a broken status line must not disturb the session.
    }
    return
  }
  if (cmd === 'hook') {
    // A hook that the plugin carries has the word --plugin after its name. It does nothing while
    // Claude Code's settings hold the same hook, or while the person has turned it off. See
    // src/plugin.mjs.
    const plugin = flag('--plugin') === true
    try {
      // For checking what Claude Code gives a hook: while the file "debug" is in this tool's folder,
      // the names of its CLAUDE environment variables are saved, with the value of the entry point only.
      if (existsSync(join(home(), 'debug'))) {
        const names = Object.keys(process.env).filter((k) => k.startsWith('CLAUDE')).sort()
        writeFileSync(join(home(), 'hook-env.json'), JSON.stringify({ names, entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null }, null, 2))
      }
      // The plugin's hook at the start of a session keeps the stable copy at the plugin's
      // version. It prints nothing: what a hook prints at a session's start goes to the model.
      if (argv[0] === 'refresh-copy') {
        refreshCopy()
        return
      }
      // The hooks at the start of a session and at the end of a turn also start a sync with the
      // Kestrel board in the background, when this computer is linked and the last sync is 10
      // minutes old. That is not a part of the security checks, so it runs also while their hook
      // is off. It never waits and prints nothing. See src/board.mjs.
      if (argv[0] === 'check-settings' || argv[0] === 'check-turn') startBoardSync(Date.now())
      if (plugin && !pluginHookRuns(argv[0])) return
      // The hooks of the security checks. The two at the start of a session and at the end of a
      // turn start the checks in the background and print nothing. The gate before a shell command
      // prints its question, or nothing. See src/security.mjs.
      if (argv[0] === 'check-settings' || argv[0] === 'check-turn' || argv[0] === 'push-gate') {
        const security = await import('../src/security.mjs')
        const input = stdin()
        if (argv[0] === 'check-settings') security.sessionStartHook(input)
        else if (argv[0] === 'check-turn') security.stopHook(input)
        else {
          const answer = security.gateHook(input)
          if (answer) process.stdout.write(JSON.stringify(answer))
        }
        return
      }
      // The keep-warm hook waits in the background. To wake the idle session it writes its words
      // to stderr and ends with exit code 2. In every other case it prints nothing and exits 0.
      if (argv[0] === 'keep-warm') {
        const wake = await keepWarmHook(stdin())
        if (wake) {
          process.stderr.write(wake)
          process.exitCode = 2
        }
        return
      }
      // The hook before a compaction prints the text that says what the summary has to keep,
      // the same for an automatic compaction and for one by hand. Claude Code adds it to the
      // instructions for the summary. The hook reads nothing of what Claude Code hands it. When
      // the text cannot be read, the catch below prints nothing.
      if (argv[0] === 'compact-keep') {
        process.stdout.write(compactKeepText())
        return
      }
      const answer = argv[0] === 'model-switch' ? modelSwitchHook(stdin()) : argv[0] === 'cold-start' ? coldStartHook(stdin()) : limitHook(stdin())
      if (answer) process.stdout.write(JSON.stringify(answer))
    } catch {
      // No decision: a broken hook must not stop a tool call. The plugin's hook before a
      // compaction is the one exception. It prints the default text then, also when this
      // tool's config is broken: the plugin carries the hook for every person who installs it,
      // also one who never set a text, and the default is what they asked for.
      if (plugin && argv[0] === 'compact-keep') process.stdout.write(DEFAULT_KEEP)
    }
    return
  }

  // The server that the Claude desktop app starts. It runs until the app closes its input.
  if (cmd === 'mcp') return (await import('../src/mcp.mjs')).serve()

  // Today's numbers. The status line starts this in the background: it prints nothing, and on any
  // error it writes nothing and ends with exit code 0.
  if (cmd === 'refresh-today') {
    try {
      await refreshToday()
    } catch {
      // Nothing: the next start tries again.
    }
    return
  }
  // The security checks that the hooks start in the background. It prints nothing, and on any error
  // it writes nothing more and ends with exit code 0.
  if (cmd === 'security-run') {
    try {
      const what = flag('--what')
      const cwd = flag('--cwd')
      const session = flag('--session')
      const transcript = flag('--transcript')
      ;(await import('../src/security.mjs')).securityRun({ what, cwd, session, transcript })
    } catch {
      // Nothing: the next start tries again.
    }
    return
  }
  // "kestrel check --cloud <provider>" is the same as "kestrel cloud-check <provider>". Reading an
  // option takes it out of the list, so it is read once.
  const cloudProvider = cmd === 'check' ? flag('--cloud') : undefined
  if (typeof cloudProvider === 'string') {
    const flags = Object.fromEntries(['profile', 'region', 'minutes', 'project', 'team', 'repo'].map((name) => [name, flag(`--${name}`)]))
    return console.log(await (await import('../src/cloud.mjs')).cloudCommand([cloudProvider], flags))
  }
  if (cmd === 'check') {
    const { checkCommand } = await import('../src/security.mjs')
    return console.log(checkCommand({ json: flag('--json') === true, run: flag('--run') === true, exportFile: flag('--export') }))
  }
  if (cmd === 'top') return top({ once: flag('--once') === true, json: flag('--json') === true, names: flag('--no-names') === true ? false : undefined })
  if (cmd === 'settings') {
    const json = flag('--json') === true
    const project = flag('--project')
    const out = await settingsCommand(argv, { json, project })
    if (out !== undefined) console.log(out)
    return
  }
  if (cmd === 'cloud-check') {
    const flags = Object.fromEntries(['profile', 'region', 'minutes', 'project', 'team', 'repo'].map((name) => [name, flag(`--${name}`)]))
    return console.log(await (await import('../src/cloud.mjs')).cloudCommand(argv, flags))
  }

  // The Kestrel board, before the reports' own --days is read: "board sync --days 30" takes it as its own.
  if (cmd === 'board') {
    const out = await boardCommand(argv, { days: flag('--days'), quiet: flag('--quiet') === true })
    if (out !== undefined) console.log(out)
    return
  }
  // Before the reports' own --days is read: "apply transcript-days --days 14" takes that option as its own.
  if (cmd === 'apply' || cmd === 'undo') {
    if (!argv[0]) {
      console.log(`The changes this tool can make:\n`)
      for (const [id, a] of Object.entries(ACTIONS)) console.log(`  ${id}\n    ${a.what}\n`)
      return console.log(`Make one: kestrel apply <name>. Take it back: kestrel undo <name>.`)
    }
    return console.log((cmd === 'apply' ? apply(argv[0], ensureOwnLink(target()), Date.now(), argv.slice(1)) : undo(argv[0], ownLink())).join('\n'))
  }
  const days = Number(flag('--days', 7))
  const since = Date.now() - days * 86400e3
  if (cmd === 'accounts') return accounts(days, since)
  if (cmd === 'summary') {
    const json = flag('--json') === true
    const { records } = await load({ since, progress })
    return console.log(json ? JSON.stringify(summaryData(records, { days, now: Date.now() })) : summary(records, { days }))
  }
  if (cmd === 'findings') return console.log(findings((await load({ since, progress })).records, { days }))
  if (cmd === 'session') {
    const { records, metas } = await load({ since, progress })
    return console.log(session(records, { id: argv[0], metas }))
  }
  if (cmd === 'calls') {
    const n = Number(flag('-n', 30))
    return console.log(callsReport((await load({ since, progress })).records, { id: argv[0], n }))
  }
  if (cmd === 'branches') return console.log(branches((await load({ since, progress })).records, { days, inRepo: branchInRepo }))
  if (cmd === 'tickets') return console.log(tickets((await load({ since, progress })).records, { days }))
  if (cmd === 'branch') {
    // Without a name: the branch that is checked out in this folder.
    const name = argv[0] ?? currentBranch()
    if (!name) throw new Error('This folder is not a git repository. Give a branch name: kestrel branch <name>')
    return console.log(branch((await load({ since, progress })).records, { days, name, inRepo: branchInRepo }))
  }
  if (cmd === 'models') {
    // This report looks at 30 days unless --days says otherwise. The flag itself was read above.
    const modelsDays = process.argv.includes('--days') ? days : 30
    return console.log(models((await load({ since: Date.now() - modelsDays * 86400e3, progress })).records, { days: modelsDays }))
  }
  if (cmd === 'compactions') {
    // The same as for "models": 30 days unless --days says otherwise. Only Claude Code's logs
    // name a compaction. The calls of the 5 minutes before the period are read too: they say
    // whether a compaction at its start came in the middle of work.
    const compactDays = process.argv.includes('--days') ? days : 30
    const from = Date.now() - compactDays * 86400e3
    const { records, metas } = await load({ since: from - 5 * 60e3, sources: ['claude'], progress })
    return console.log(compactions(records, metas, { days: compactDays, since: from }))
  }
  if (cmd === 'advise') {
    // The same as for "models": 30 days unless --days says otherwise.
    const adviseDays = process.argv.includes('--days') ? days : 30
    const json = flag('--json') === true
    const { records } = await load({ since: Date.now() - adviseDays * 86400e3, progress })
    const options = { days: adviseDays, applied: applied() }
    return console.log(json ? JSON.stringify(adviseData(records, options)) : adviseReport(records, options))
  }
  if (cmd === 'measure') {
    const id = argv[0] ?? 'subagent-cache-1h'
    // Keep-warm is measured from its own record of the wakes, not from the logs.
    if (id === 'keep-warm') return console.log(keepWarmReport({ mode: billing({}).mode }))
    const state = applied()[id]
    if (!state && !ACTIONS[id]) throw new Error(`There is no change "${id}". The changes are: ${Object.keys(ACTIONS).join(', ')}`)
    if (!state) return console.log(`${id} is not applied. Apply it with: kestrel apply ${id}`)
    const from = Math.min(state.at - 14 * 86400e3, since)
    const { records, metas } = await load({ since: from, progress })
    return console.log(measureReport(records, { id, at: state.at, before: state.before, metas }))
  }
  if (cmd === 'live') return live()
  if (cmd === 'limit') return limit()
  if (cmd === 'plan') return plan()
  if (cmd === 'nudge') return nudge()
  if (cmd === 'compact-keep') return compactKeep()
  if (cmd === 'hint') return hint()
  if (cmd === 'hud') return console.log(hudCommand(argv, { tty: process.stdout.isTTY }))
  if (cmd === 'hooks') return hooks()
  if (cmd === 'install') return install()
  if (cmd === 'migrate') {
    // Each thing the move does is printed as it is done, so that a later step that fails hides nothing.
    if (!migrate({ target: () => target(console.log), say: console.log })) console.log('Nothing was left to do.')
    return
  }
  if (cmd === 'uninstall') return uninstallAll()
  if (cmd === 'status') return status()
  console.error(`Unknown command "${cmd}".\n\n${USAGE}`)
  process.exitCode = 2
}

function install() {
  const refresh = flag('--refresh', 30)
  if (refresh === true || !Number.isInteger(Number(refresh)) || Number(refresh) < 0) throw new Error('--refresh is a whole number of seconds, or 0 for no timer.')
  const old = nodeNote()
  if (old) console.log(old)
  // An install from before the change of name is brought to the new name first. The same steps
  // make the link in the tool's own folder and the link on the PATH, to this file or, from a
  // plugin, to the stable copy. Anything of another program on the PATH stays, and the steps say so.
  migrate({ target: () => target(console.log), say: console.log, make: true })
  const onPath = isOwnLink(LINK)
  if (onPath) console.log(`The command is at ${LINK}.`)
  // Claude Code's settings call the link in the tool's own folder, never the one on the PATH.
  console.log(installStatusLine(ownLink(), { force: !!flag('--force'), refresh: Number(refresh) }))
  if (config().limits) setHook(ownLink(), true)
  // The hooks of the security checks: the settings when a session starts, the actions and the code
  // when a turn ends, and the question before a push while a high risk is open.
  console.log(setSecurityHooks(ownLink(), true)
    ? 'Added the hooks of the security checks to Claude Code: at the start of a session, at the end of a turn, and before a push. See the findings with: kestrel check'
    : 'The hooks of the security checks were already set. See the findings with: kestrel check')
  console.log('Codex needs no setup: its session logs are read as they are.')
  const name = onPath ? 'kestrel' : ownLink()
  console.log(`Try: ${name} summary, ${name} session, ${name} findings, ${name} live`)
  console.log(`\n${banner(version())}`)
}

/**
 * Takes this tool out of Claude Code's settings, and takes out its links and its stable copy: the
 * link in its own folder, each link on the PATH that is this tool's own, and the copy of an install
 * from a plugin. A link whose target is gone is still a link to take out. Anything of another
 * program on the PATH stays, and one sentence says so.
 */
function uninstallAll() {
  const changed = uninstall()
  const others = []
  // The links are looked at before the copy goes: a link to the copy is this tool's own only while the copy is there.
  for (const [name, file] of [['kestrel', LINK], [OLD_NAME, OLD_LINK]]) {
    if (isOwnLink(file)) unlinkSync(file)
    else if (isThere(file)) others.push([name, file])
  }
  if (lstatSync(ownLink(), { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(ownLink())
  const copy = removeApp()
  // This file can be one of the copy's, and then gone: the sentence names no path then.
  for (const [name, file] of others) console.log(otherProgram(name, file, existsSync(self) ? self : undefined))
  if (copy) console.log(`Removed the copy of the tool in ${appDir()}.`)
  // The PATH has no command of this tool left, unless another program has the name.
  if (others.some(([name]) => name === 'kestrel')) return console.log(changed ? 'Removed the status line and the hook from Claude Code.' : 'Nothing of Kestrel was in Claude Code\'s settings.')
  console.log(changed ? 'Removed the status line and the hook from Claude Code, and the command from your PATH.' : 'Nothing of Kestrel was in Claude Code\'s settings. The command is removed from your PATH.')
}

function limit() {
  if (flag('--off')) {
    const c = config()
    delete c.limits
    saveConfig(c)
    setHook(ownLink(), false)
    return console.log('The limits are removed, and the hook is out of Claude Code.')
  }
  const sessionLimit = flag('--session')
  const dayLimit = flag('--day')
  const action = flag('--action', 'ask')
  if (!sessionLimit && !dayLimit) return status()
  if (!['ask', 'warn', 'stop'].includes(action)) throw new Error('--action is one of ask, warn, stop')
  const limits = { action }
  if (sessionLimit) limits.session = Number(sessionLimit)
  if (dayLimit) limits.day = Number(dayLimit)
  if (Object.values(limits).some((v) => typeof v === 'number' && !(v > 0))) throw new Error('A limit is a number of dollars above 0.')
  saveConfig({ ...config(), limits })
  setHook(ensureOwnLink(target()), true)
  const what = { ask: 'Claude Code asks you before the next tool call', warn: 'Claude Code shows a warning', stop: 'the agent stops' }[action]
  console.log(`Limits set:${limits.session ? ` ${money(limits.session)} per session` : ''}${limits.day ? ` ${money(limits.day)} per day` : ''}. At a limit, ${what}.`)
  if (!installed().statusLine) console.log('Note: the limit uses the figures the status line saves. Run "kestrel install" first.')
}

/**
 * "kestrel accounts": the spend and the plan's limits of each account of the last `days` days, as
 * a table or, with --json, as one object. "kestrel accounts label" sets a label.
 */
async function accounts(days, since) {
  if (argv[0] === 'label') return accountsLabel()
  if (argv[0] === 'price') return accountsPrice()
  if (!Number.isInteger(days) || days < 1) throw new Error('--days is a whole number of days, 1 or more.')
  const json = flag('--json') === true
  if (argv.length) throw new Error(`"kestrel accounts" takes --days, --json, label or price, and "${argv[0]}" was given.`)
  const { records, metas } = await load({ since, progress })
  const now = Date.now()
  const data = accountsData(records.filter((r) => r.ts >= since), { days, now, metas })
  console.log(json ? JSON.stringify(data, null, 2) : accountsText(data, now))
}

/**
 * "kestrel accounts label <key> <label>" sets the person's own name for an account, and
 * "kestrel accounts label <key> --clear" takes it away. The key can be the short form that
 * "kestrel accounts" prints.
 */
function accountsLabel() {
  const clear = flag('--clear') === true
  const [, key, label, ...more] = argv
  const how = 'Use "kestrel accounts label <key> "<label>"", or "kestrel accounts label <key> --clear".'
  if (!key || more.length || (clear ? label !== undefined : label === undefined)) throw new Error(how)
  console.log(setLabel(key, clear ? undefined : label))
}

/**
 * "kestrel accounts price <key> <dollars a month>" sets the price of an account's plan, and
 * "kestrel accounts price <key> --clear" takes it away. A price the person set wins over the
 * table of plans that Kestrel knows. The key can be the short form that "kestrel accounts" prints.
 */
function accountsPrice() {
  const clear = flag('--clear') === true
  const [, key, dollars, ...more] = argv
  const how = 'Use "kestrel accounts price <key> <dollars a month>", or "kestrel accounts price <key> --clear".'
  if (!key || more.length || (clear ? dollars !== undefined : dollars === undefined)) throw new Error(how)
  console.log(setPrice(key, clear ? undefined : dollars))
}

/** Shows how the person pays, or sets it by hand. */
function plan() {
  const to = argv[0]
  if (to === undefined) {
    console.log(`Billing: ${billingText(billing({}))}`)
    return console.log('Set it by hand with "kestrel plan subscription" or "kestrel plan usage". Take that back with "kestrel plan auto".')
  }
  if (!['subscription', 'usage', 'auto'].includes(to)) throw new Error('The plan is one of subscription, usage, auto.')
  const c = config()
  if (to === 'auto') delete c.plan
  else c.plan = to
  saveConfig(c)
  console.log(`${to === 'auto' ? 'The plan is no longer set by hand.' : 'The plan is saved.'} Billing: ${billingText(billing({}))}`)
}

/** Shows the settings of the notification before a session's cache ends, or changes them. */
function nudge() {
  const before = flag('--before')
  const min = flag('--min')
  const to = argv[0]
  const n = nudgeConfig()
  if (to === undefined && before === undefined && min === undefined) {
    console.log(`Notification before a session's cache ends: ${nudgeSettingsText(n)}.`)
    console.log('It is a notification of the operating system, on macOS and on Linux (with notify-send). A cache that lasts 5 minutes gets it 1 minute before its end.')
    return console.log('Turn it on with "kestrel nudge on [--before <minutes>] [--min <tokens>]", and off with "kestrel nudge off".')
  }
  if (to !== 'on' && to !== 'off') throw new Error('Use "kestrel nudge on [--before 5] [--min 100000]" or "kestrel nudge off".')
  // A number is taken only when it is written in digits alone. Both are checked before anything is saved.
  if (before !== undefined) {
    if (before === true || !/^\d+$/.test(before) || Number(before) < 1 || Number(before) > 30) throw new Error('--before is a whole number of minutes from 1 to 30.')
    n.before = Number(before)
  }
  if (min !== undefined) {
    if (min === true || !/^\d+$/.test(min) || Number(min) < 1 || !Number.isSafeInteger(Number(min))) throw new Error('--min is a whole number of tokens, 1 or more.')
    n.min = Number(min)
  }
  n.on = to === 'on'
  saveConfig({ ...config(), nudge: n })
  console.log(`Notification before a session's cache ends: ${nudgeSettingsText(n)}.`)
  // The status line shows the notification. In an idle session Claude Code runs it only on a timer.
  if (n.on && !(installed().refresh > 0)) console.log('Note: the notification comes from the status line, and that has to run on a timer. Run "kestrel install".')
}

/** Shows the text that says what a summary has to keep at every compaction, sets it, or puts the default back. */
function compactKeep() {
  const toDefault = flag('--default')
  const how = 'Use "kestrel compact-keep", "kestrel compact-keep --default", or "kestrel compact-keep" with your text as one argument, in quotes.'
  if (argv.length > 1 || (toDefault !== undefined && (toDefault !== true || argv.length))) throw new Error(how)
  // Claude Code gets the text from a hook. Until that is applied, the text does nothing.
  const hook = applied()['compact-keep'] ? [] : ['Claude Code is not given the text yet. Add the hook for that with: kestrel apply compact-keep']
  if (toDefault || argv.length) {
    saveCompactKeep(toDefault ? undefined : argv[0])
    return console.log([toDefault ? 'The default text is back.' : 'The text is saved.', ...hook].join('\n'))
  }
  const text = compactKeepText()
  console.log([
    `What a summary has to keep, at every compaction (${text === DEFAULT_KEEP ? 'the default text' : 'your own text'}):`,
    text,
    'Set your own with: kestrel compact-keep "<text>". Put the default back with: kestrel compact-keep --default',
    ...hook,
  ].join('\n'))
}

/**
 * Shows the settings of the two hints at the end of the status line, or turns both on or off:
 * the hint about the effort level, and the hint to compact.
 */
function hint() {
  const to = argv[0]
  const h = hintConfig()
  const c = compactHintConfig()
  if (to === undefined) {
    console.log(`Effort hint on the status line: ${hintSettingsText(h)}.`)
    console.log('Simple work is reading and searching, running commands, and thinking and answering. The hint names the /effort command for one level down or up. A change of the effort level keeps the cache. You type the command: nothing changes on its own.')
    console.log(`Compaction hint on the status line: ${compactHintSettingsText(c)}.`)
    console.log('A break in the work is 60 seconds without a model call. The hint names /compact, comes at most once in 30 minutes per session, and stays while the session is idle. You type the command: nothing changes on its own.')
    return console.log('Turn both off with "kestrel hint off", and on with "kestrel hint on".')
  }
  if (to !== 'on' && to !== 'off') throw new Error('Use "kestrel hint on" or "kestrel hint off".')
  h.on = to === 'on'
  c.on = h.on
  saveConfig({ ...config(), hint: h, compactHint: c })
  console.log(`Effort hint on the status line: ${hintSettingsText(h)}.`)
  console.log(`Compaction hint on the status line: ${compactHintSettingsText(c)}.`)
  // A hint is a part of the status line. Without that there is nowhere to show it. The hint to
  // compact also needs the timer: a break in the work is seen only by a run after the last answer.
  if (h.on && !installed().statusLine) console.log('Note: the hint is shown on the status line. Run "kestrel install" first.')
  else if (h.on && !(installed().refresh > 0)) console.log('Note: the hint to compact comes at a break in the work, and only a status line that runs on a timer sees one. Run "kestrel install".')
}

/**
 * Shows, for each hook that the plugin carries, whether it runs and from where: Claude Code's
 * settings, the plugin, or nowhere (off). Or turns one plugin hook off or on.
 */
function hooks() {
  const [to, name] = argv
  const names = Object.keys(PLUGIN_HOOKS)
  const where = { settings: 'runs from Claude Code\'s settings', plugin: 'runs from the plugin', off: 'off' }
  if (to === undefined) {
    console.log('The hooks that the plugin carries:\n')
    console.log(table(names.map((n) => [`  ${n}`, PLUGIN_HOOKS[n].when, where[hookPlace(n)]])))
    console.log('\nA hook in Claude Code\'s settings is in charge: the plugin\'s hook for the same event then does nothing. A hook runs from the plugin only where the plugin is installed.')
    return console.log('Turn a plugin hook off with "kestrel hooks off <name>", and on with "kestrel hooks on <name>".')
  }
  if ((to !== 'on' && to !== 'off') || !Object.hasOwn(PLUGIN_HOOKS, name) || argv.length > 2) throw new Error(`Use "kestrel hooks", "kestrel hooks off <name>" or "kestrel hooks on <name>". The names are: ${names.join(', ')}.`)
  setPluginHook(name, to === 'on')
  console.log(`The plugin's hook ${name} is ${to}.`)
  // The same hook in the settings runs whatever the plugin's hook does.
  if (inSettings(name)) console.log(`Claude Code's settings hold this hook too, and it runs from there. Take it out of the settings with: ${PLUGIN_HOOKS[name].undo ?? `kestrel undo ${PLUGIN_HOOKS[name].change}`}`)
}

function status() {
  // The name of the account signed in now, from Claude Code's file .claude.json.
  updateAccounts({ signedIn: true })
  const i = installed()
  const l = config().limits
  const logs = logFiles()
  const found = (source) => logs.filter((f) => f.source === source).length
  // The command on the PATH is this tool's own link, under the new name or the old one. Another
  // program can have the name: then the row says so.
  const onPath = [LINK, OLD_LINK].find(isOwnLink)
  console.log(table([
    ['Command on PATH', onPath ?? (isThere(LINK) ? `no: another program named kestrel is at ${LINK}` : 'no (run: kestrel install)')],
    ['Command for Claude Code', existsSync(ownLink()) ? ownLink() : 'not made yet (run: kestrel install)'],
    ['Claude Code status line', i.statusLine ? `set, with ${refreshText(i.refresh)}` : i.otherStatusLine ? `another tool's: ${i.otherStatusLine}` : 'not set'],
    ['Claude Code limit hook', i.hook ? 'set' : 'not set (it is only added while a limit is set)'],
    ['Limits', l ? `${l.session ? `${money(l.session)} per session ` : ''}${l.day ? `${money(l.day)} per day ` : ''}then ${l.action}` : 'none'],
    ['Billing', billingText(billing({}))],
    ...limitRows(Date.now()),
    ['Cache end notification', nudgeSettingsText(nudgeConfig())],
    ['Effort hint', hintSettingsText(hintConfig())],
    ['Compaction hint', compactHintSettingsText(compactHintConfig())],
    ...actionsStatus().map(([id, state]) => [`Change: ${id}`, state]),
    ['Kestrel board', boardRow()],
    ['Session logs found', `${found('claude')} of Claude Code, ${found('codex')} of Codex, ${found('cowork')} of Cowork`],
  ]))
  if (found('cowork')) console.log(COWORK_NOTE)
}

/** The row about the Kestrel board in "kestrel status": linked or not, and the last sync. "kestrel board status" says more. */
function boardRow() {
  const b = readBoard()
  if (!b) return 'not linked (link with: kestrel board login <address>)'
  const last = Number.isFinite(b.lastSyncAt) ? `last sync ${when(b.lastSyncAt)}` : 'no sync yet'
  return `linked to ${b.url}${b.team ? ` (${b.team})` : ''}, ${last}${b.stopped ? ', background sync off: the board refused the token' : ''}. See: kestrel board status`
}

/**
 * One row for each account that has a reading of the plan's limits: the parts as the status line
 * words them, or when the last reading was, when its windows have ended.
 */
function limitRows(now) {
  const state = readAccounts()
  return [...storedLimits()].map(([key, readings]) => {
    const open = Object.fromEntries(Object.entries(readings).filter(([, r]) => r.resetsAt > now))
    const last = Math.max(...Object.values(readings).map((r) => r.at))
    const text = Object.keys(open).length ? limitParts(open, now).map(([part]) => part).join('; ') : `no window that is open now (the last reading is from ${when(last)})`
    return [`Plan limits of ${labelOf(key, state)}`, text]
  })
}

/** Prints each model call of the Claude Code sessions that are running, as it happens. */
async function live() {
  console.log('Waiting for model calls of running Claude Code sessions. Stop with Ctrl-C.\n')
  console.log(table([CALL_HEAD]))
  const open = new Map() // file -> { parser, offset, rest, printed }
  for (;;) {
    for (const { file, source } of logFiles()) {
      if (source !== 'claude') continue
      let st
      try {
        st = statSync(file)
      } catch {
        continue
      }
      let o = open.get(file)
      if (!o) {
        if (Date.now() - st.mtimeMs > 120e3) continue
        // A session that is already running: read what is there, and print only what comes after.
        o = { parser: new ClaudeParser(file), offset: 0, rest: '', printed: -1 }
        open.set(file, o)
      }
      if (st.size <= o.offset) continue
      const { openSync, readSync, closeSync } = await import('node:fs')
      const fd = openSync(file, 'r')
      const buf = Buffer.alloc(st.size - o.offset)
      readSync(fd, buf, 0, buf.length, o.offset)
      closeSync(fd)
      o.offset = st.size
      const lines = (o.rest + buf.toString('utf8')).split('\n')
      o.rest = lines.pop()
      for (const line of lines) o.parser.feed(line)
      const calls = analyze(o.parser.records).calls
      if (o.printed < 0) o.printed = calls.length
      // The newest call can still be growing: it is printed once a later line has closed it.
      const settled = Date.now() - st.mtimeMs > 1500 ? calls.length : calls.length - 1
      for (let k = o.printed; k < settled; k++) console.log(callLine(calls[k]).join('  '))
      o.printed = Math.max(o.printed, settled)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

main().catch((e) => {
  console.error(`kestrel: ${e.message}`)
  process.exitCode = 1
})
