// The server that the Claude desktop app starts: "kestrel mcp".
//
// The Model Context Protocol lets an app such as the Claude desktop app call the tools of a
// program on the same computer. The app starts the program and talks to it over standard input
// and output: one JSON-RPC message per line, each way. Standard output carries those messages
// only. Anything else, such as an error that is logged, goes to standard error.
//
// The protocol has two kinds of versions. It is not known which kind the app uses, so this
// server speaks both (the specification calls that "dual-era"):
//   - Up to version 2025-11-25, a client opens with the request "initialize", which agrees on a
//     version, and then sends the notification "notifications/initialized".
//   - From version 2026-07-28 on, there is no such handshake. Every request names its version in
//     its "_meta", and "server/discover" says which versions the server knows.
//
// Every tool only reads. Its answer is the text of one of Kestrel's reports. Those hold numbers,
// model names, project folder names, ticket names, dates, the state of each session, and the
// names of accounts (an organisation's name, or the person's own label, never an email address
// or a person's name), and never
// any text of a session: no prompt, no answer, no command, no file name from a tool call, and no
// name of a task or of a subagent. The view of the sessions that run now is the one of
// "kestrel top" without its column of tasks, whatever the setting hud.names says. The tool
// security_check gives the open findings of Kestrel's security checks: for each its kind, title,
// where it is, its controls and its fix. A finding never holds what was matched, so no secret,
// no patient data and no command is in that answer either.
//
// The first read of thousands of logs can take minutes, and the app gives up on a tool call after
// about a minute. So the logs are read in the background as soon as a client has opened, and a
// tool call waits for that read for at most 40 seconds. After that it says how far the read is,
// and that asking again in a minute will work. The read goes on, and what it parsed is kept in
// Kestrel's cache, as for the command.
import { statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { format } from 'node:util'
import { applied } from './actions.mjs'
import { adviseReport } from './advise.mjs'
import { version } from './app.mjs'
import { accountsData, accountsText } from './accounts-report.mjs'
import { labelOf, readAccounts, shortKey } from './accounts.mjs'
import { WINDOWS, allLimits, billing, billingText } from './billing.mjs'
import { limitParts } from './claude-code.mjs'
import { findingsText } from './findings-text.mjs'
import { count, day, plain, when } from './format.mjs'
import { refreshToday } from './refresh-today.mjs'
import { compactions, models, summary, tickets } from './report.mjs'
import { load, logFiles } from './store.mjs'
import { todayDue } from './today-file.mjs'
import { topText } from './top.mjs'

const DAY = 86400e3

// The versions of the protocol that this server speaks, the newest first: the one without a
// handshake, and those with one.
const MODERN = ['2026-07-28']
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
// The keys of the protocol's own fields in "_meta".
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion'
const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities'
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo'

// The error codes of JSON-RPC, and the one that the protocol adds for a version it does not know.
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const UNSUPPORTED_VERSION = -32022

// How long a tool call waits for the logs before it says that they are still being read. The
// tests make it short with KESTREL_MCP_WAIT_MS. Nothing else sets that variable.
const WAIT = 40e3
// The logs are read for the longest period that a tool takes, 90 days, and 5 minutes more: the
// compactions report also looks at the calls of the 5 minutes before its period.
const PERIOD = 90 * DAY
const BEFORE = 5 * 60e3
// A read that ended less than a minute ago is used again. One answer can take several tool
// calls, and they then read the logs once.
const FRESH = 60e3
// How long a client may keep the list of tools. It changes only with a new version of Kestrel.
const KEEP_LIST = 3600e3

const CAPABILITIES = { tools: { listChanged: false } }
const INSTRUCTIONS = "Kestrel answers what the AI agents on this computer spent and which of their sessions run now (Claude Code, Codex and Cowork), from their local logs, with numbers only. Use what_kestrel_sees first when unsure what there is. Dollar figures are list prices. On a subscription, the plan's percent is what counts. security_check gives the open findings of Kestrel's security checks; Kestrel flags risks; it does not make a company compliant or certify it."

const SOURCES = [['claude', 'Claude Code'], ['codex', 'Codex'], ['cowork', 'Cowork']]
const CANNOT_SEE = [
  'Chat on claude.ai, in the Claude app and on the phone, and ChatGPT: their use is not kept on this computer.',
  'Cloud sessions: Cowork, Claude Code or Codex sessions that ran in the cloud and not on this computer.',
  'Other computers: Kestrel reads only the logs on this one.',
]
const PRIVACY = 'Kestrel reads these logs on this computer and answers with numbers only, never with the text of a session. It sends nothing anywhere and changes no setting.'

/** What every tool says when there are no logs at all: the person only chats, or runs the agents on another computer. */
export const NOTHING_FOUND = [
  'Kestrel found no logs of Claude Code, Codex or Cowork on this computer, so it has no numbers yet.',
  'Claude does not keep chat usage on this computer, so chat on claude.ai, in the Claude app and on the phone is not counted.',
  "The plan's percent is shown in the Claude app under Settings, Usage.",
  'The numbers start once you use Cowork, Claude Code or Codex on this computer.',
].join(' ')

// Added to an answer that names a command to change something. In the app Kestrel only reads.
const IN_A_TERMINAL = 'A change with a "kestrel apply" command is made in a terminal, with that command: Kestrel in the desktop app never changes a setting.'

// Where the numbers of plan_limits come from.
const PLAN_SOURCES = [
  "The percent: Claude Code gives the plan's limits to Kestrel's status line after each answer, and Kestrel keeps the newest reading of each account. That needs Kestrel's status line in Claude Code on this computer.",
  "Each account has limits of its own. Kestrel tells the accounts apart by the account that Claude Code names at the start of each session's log.",
  'Chat, Cowork and Claude Code share one plan, so the percent counts all three.',
  "The Claude app shows the percent under Settings, Usage. When the two differ, the app is right: Kestrel's reading can be old.",
  "Kestrel does not read Codex's plan or its limits.",
  "Dollar figures in Kestrel's other answers are list prices per token. On a subscription they say what the same use would cost by the token, not what you pay.",
]

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
/** Whether a value can be the id of a request: text, or a whole number. */
const isId = (v) => typeof v === 'string' || Number.isInteger(v)
/** An id as a key, so that the id 1 and the id "1" stay apart. */
const idKey = (id) => `${typeof id}:${id}`
/** Text from a client or from an error, made safe for one line of an answer: no control characters, and not too long. */
const short = (v) => plain(String(v)).slice(0, 100)
/** The calls of the last `days` days. */
const within = (records, days, now) => records.filter((r) => r.ts >= now - days * DAY)

/** The time of the newest log of a list, in milliseconds. 0 when none can be read. */
function newest(files) {
  let at = 0
  for (const { file } of files) {
    try {
      at = Math.max(at, statSync(file).mtimeMs)
    } catch {
      // The log is gone since it was listed.
    }
  }
  return at
}

/** Which logs Kestrel finds, how many and how new, and what it cannot see. Only the times of the files are read. */
function sees(files) {
  const out = ['What Kestrel finds on this computer:']
  for (const [source, name] of SOURCES) {
    const mine = files.filter((f) => f.source === source)
    const at = newest(mine)
    const found = `${count(mine.length)} ${mine.length === 1 ? 'log' : 'logs'}${at ? `, the newest from ${day(at)}` : ''}`
    out.push(`  ${name}: ${mine.length ? found : 'no logs'}.`)
  }
  out.push('', 'What Kestrel cannot see:', ...CANNOT_SEE.map((line) => `  ${line}`), '', PRIVACY)
  if (!files.length) out.push('', NOTHING_FOUND)
  return out.join('\n')
}

/**
 * How the person pays and the plan's limits, as far as Kestrel knows. `full` adds where each
 * number comes from. The limits are the newest reading that Claude Code gave Kestrel's status
 * line on this computer. A window that has ended is left out.
 */
function planText(now, full) {
  const all = allLimits(now)
  const out = [`How you pay, as far as Kestrel knows: ${billingText(billing({}, { now }))}.`]
  /** The lines of one account's limits. The parts come in the same order as the windows: the 5 hour limit first, then the week. */
  const lines = (limits, indent) => {
    const keys = WINDOWS.map((w) => w.key).filter((key) => limits[key])
    return limitParts(limits, now).map(([text], i) => `${indent}${text[0].toUpperCase()}${text.slice(1)}. It resets at ${when(limits[keys[i]].resetsAt)}.`)
  }
  if (all.size > 1) {
    // More than one account: each with its name, the newest reading first.
    const state = readAccounts()
    const newest = (limits) => Math.max(...Object.values(limits).map((r) => r.at))
    out.push(full ? "The plan's limits of each account, from the newest reading on this computer:" : "The plan's limits of each account:")
    for (const [key, limits] of [...all].sort((a, b) => newest(b[1]) - newest(a[1]))) out.push(`  ${labelOf(key, state)} (${shortKey(key)}):`, ...lines(limits, '    '))
  } else if (all.size === 1) {
    out.push(full ? "The plan's limits, from the newest reading on this computer:" : "The plan's limits:", ...lines([...all.values()][0], '  '))
  } else out.push("Kestrel has no reading of the plan's limits. The Claude app shows the percent under Settings, Usage.")
  if (full) out.push('', 'Where the numbers come from:', ...PLAN_SOURCES.map((line) => `  ${line}`))
  return out.join('\n')
}

/** A sentence for a period without calls when the newest log is older than the period. Undefined otherwise. */
function olderNote(records, days, now, files) {
  if (records.length) return undefined
  const at = newest(files)
  return at && at < now - days * DAY ? `The newest log on this computer is from ${day(at)}. Ask for more days, up to 90.` : undefined
}

/** The answer when the logs are still being read the first time. `all` is 0 before the count is known. */
function stillReading({ done, all }) {
  const far = all ? `: ${count(done)} of ${count(all)} logs done` : ''
  return `Kestrel is still reading the session logs on this computer for the first time${far}. Ask again in a minute, and the answer will be there: the reading goes on in the background.`
}

/**
 * The text of an answer, from the parts that a tool gives. Colour codes are taken out. Kestrel's
 * summary ends with a line that names other reports of the command: in the app those are other
 * tools, so the line goes. An answer that names a command to change something says that the
 * change is made in a terminal.
 */
function tidy(parts) {
  let text = [parts].flat().filter((part) => part !== undefined).join('\n')
  text = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  text = text.split('\n').filter((line) => !line.startsWith('Next: "kestrel')).join('\n')
  if (text.includes('kestrel apply')) text += `\n\n${IN_A_TERMINAL}`
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

const NO_ARGUMENTS = { type: 'object', additionalProperties: false }
const withDays = (fallback) => ({
  type: 'object',
  properties: { days: { type: 'integer', minimum: 1, maximum: 90, default: fallback, description: `How many days back to look, from 1 to 90. Without it, ${fallback}.` } },
  additionalProperties: false,
})

// The tools. A tool with `days` takes that one argument, with `days` as its default, and reads the
// logs. The others read only small files and the ends of a few logs. The descriptions are the
// same in desktop/manifest.json.
const TOOLS = [
  {
    name: 'what_kestrel_sees',
    title: 'What Kestrel sees',
    description: 'Which agent logs Kestrel finds on this computer (Claude Code, Codex, Cowork), how many and how new, and what it cannot see. Use it first when unsure what there is, or when another answer is empty.',
    answer: ({ files }) => sees(files),
  },
  {
    name: 'spend_summary',
    title: 'Spend summary',
    days: 7,
    description: "What the agents on this computer spent, by tool, project and model, at list prices, with the plan's limits where known. Use it for a question such as: what did my agents spend this week?",
    answer: ({ data, days, now, files }) => {
      const records = within(data.records, days, now)
      return [summary(records, { days }), olderNote(records, days, now, files), '', 'The plan', planText(now, false), '', 'For ways to spend less, ask spend_advice.']
    },
  },
  {
    name: 'plan_limits',
    title: "The plan's limits",
    description: "How the person pays, the plan's limits and how much of them is used, as far as Kestrel knows, and where each number comes from. Use it for questions about the plan, its limits or the percent used.",
    answer: ({ now }) => planText(now, true),
  },
  {
    name: 'spend_advice',
    title: 'How to spend less',
    days: 30,
    description: 'Proposals to spend less, each with the reason and the expected saving, from a replay of the logs. Use it when the person asks where to save or how to use less of the plan.',
    answer: ({ data, days, now, files }) => {
      const records = within(data.records, days, now)
      return [adviseReport(records, { days, applied: applied() }), olderNote(records, days, now, files)]
    },
  },
  {
    name: 'compactions',
    title: 'Compactions',
    days: 30,
    description: 'How often the context of Claude Code sessions was compacted (replaced by a summary), and how large it was before and after. Use it for questions about compaction or long sessions.',
    // Only Claude Code's logs name a compaction. The calls of the 5 minutes before the period say
    // whether a compaction at its start came in the middle of work, as in the command.
    answer: ({ data, days, now }) => {
      const since = now - days * DAY
      return compactions(data.records.filter((r) => r.s === 'claude' && r.ts >= since - BEFORE), data.metas, { days, since })
    },
  },
  {
    name: 'spend_by_model',
    title: 'Spend by model',
    days: 30,
    description: 'Spend by model, effort level and kind of work, such as reading, running commands or changing files. Use it for questions about which model or effort level costs the most.',
    answer: ({ data, days, now, files }) => {
      const records = within(data.records, days, now)
      return [models(records, { days }), olderNote(records, days, now, files)]
    },
  },
  {
    name: 'whats_running',
    title: "What's running",
    description: 'Which agent sessions run on this computer now (Claude Code, Codex and Cowork), which of them wait for the person, and what to do next, with the ticket, context, cache and tokens of today of each session. Use it for questions such as: what are my agents doing right now?',
    // Today's tokens come from today.json. When that is missing or due, it is worked out first,
    // for as long as a tool call waits for the logs. A longer reading goes on in the background.
    answer: async ({ wait }) => {
      if (todayDue(Date.now())) {
        let timer
        const late = new Promise((resolve) => {
          timer = setTimeout(resolve, wait)
        })
        await Promise.race([refreshToday().catch(() => {}), late])
        clearTimeout(timer)
      }
      return topText(Date.now(), { names: false, colors: false })
    },
  },
  {
    name: 'spend_by_ticket',
    title: 'Spend by ticket',
    days: 7,
    description: 'Tokens, cost at list prices and sessions per ticket, from the git branch that each call names (a branch such as user/abc-322-login gives ABC-322). Use it for questions such as: what did each ticket cost this week?',
    answer: ({ data, days, now, files }) => {
      const records = within(data.records, days, now)
      return [tickets(records, { days }), olderNote(records, days, now, files)]
    },
  },
  {
    name: 'spend_by_account',
    title: 'Spend by account',
    days: 7,
    description: "The spend and the plan's limits of each account that the agents used, such as a work and a personal Claude account, Cowork and Codex, with tokens and cost at list prices. Use it for questions such as: which of my accounts used the most this week?",
    // The text of "kestrel accounts". It learns the name of the account signed in now, as the command does.
    answer: ({ data, days, now, files }) => {
      const records = within(data.records, days, now)
      return [accountsText(accountsData(records, { days, now, metas: data.metas }), now), olderNote(records, days, now, files)]
    },
  },
  {
    name: 'security_check',
    title: 'Security check',
    // It reads the store of findings, not the logs: cloud findings are there also on a computer without agent logs.
    findings: true,
    description: "The open findings of Kestrel's security checks (the agents' settings, their actions, the code they changed, and cloud accounts checked on request), each with its kind, title, where it is, the controls of the frameworks that are on and the fix. Use it when the person asks about security risks or compliance, such as HIPAA or SOC 2.",
    // The same findings and controls as "kestrel check": the controls of each finding's repository's frameworks.
    answer: async ({ now }) => {
      const { reportData } = await import('./security.mjs')
      const data = reportData({ now })
      return findingsText({ findings: data.findings, frameworks: data.frameworks, computed: true })
    },
  },
]

/** The tools as "tools/list" gives them. */
export const tools = () =>
  TOOLS.map(({ name, title, description, days }) => ({
    name, title, description,
    inputSchema: days ? withDays(days) : NO_ARGUMENTS,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }))

/** The arguments of a call, checked: `{ days }`, or `{ error }` with one sentence for the model. */
function check(tool, args) {
  if (Object.keys(args).some((key) => key !== 'days' || !tool.days)) return { error: tool.days ? `${tool.name} takes one argument, "days".` : `${tool.name} takes no arguments.` }
  if (!tool.days) return {}
  // A client may send null for an argument it leaves out.
  if (args.days === undefined || args.days === null) return { days: tool.days }
  return Number.isInteger(args.days) && args.days >= 1 && args.days <= 90 ? { days: args.days } : { error: '"days" is a whole number from 1 to 90.' }
}

/**
 * The logs of the last 90 days, read through Kestrel's cache. There is one read at a time: a call
 * that comes while a read is going on waits for that same read.
 */
class Logs {
  /** @param {(message: string) => void} log Where the error of a read is written, also when no call waits for it. */
  constructor(log) {
    this.log = log
    this.reading = undefined // { promise, done, all }
    this.last = undefined // { at, data }: the newest read that ended
  }

  /** Starts a read, unless one is going on or one ended less than a minute ago. Returns the read that is going on. */
  start() {
    if (this.reading || (this.last && Date.now() - this.last.at < FRESH)) return this.reading
    const reading = { done: 0, all: 0 }
    reading.promise = load({ since: Date.now() - PERIOD - BEFORE, progress: (done, all) => Object.assign(reading, { done, all }) })
      .then((data) => {
        this.last = { at: Date.now(), data }
        return data
      })
      .finally(() => {
        this.reading = undefined
      })
    // A read that fails must not end the server. A call that waits for it gets the error as well.
    reading.promise.catch((e) => this.log(`reading the logs failed: ${e?.stack ?? e}`))
    this.reading = reading
    return reading
  }

  /**
   * `{ data }`: the calls and what `load()` gives next to them. When a read is going on, it waits
   * for it at most `wait` milliseconds. When the read takes longer, the answer is the read before,
   * or, on the first read, `{ waiting: { done, all } }`: how many logs are parsed of how many.
   */
  async get(wait) {
    const reading = this.start()
    if (!reading) return { data: this.last.data }
    let timer
    const late = new Promise((resolve) => {
      timer = setTimeout(resolve, wait)
    })
    try {
      const read = await Promise.race([reading.promise.then((data) => ({ data })), late])
      if (read) return read
      return this.last ? { data: this.last.data } : { waiting: { done: reading.done, all: reading.all } }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** One tool call: `{ text, isError }`. It throws only on an error inside the tool. */
async function run(tool, args, logs, wait) {
  const { days, error } = check(tool, args)
  if (error) return { text: error, isError: true }
  if (tool.findings) return { text: tidy(await tool.answer({ now: Date.now() })), isError: false }
  const files = logFiles()
  if (!files.length) return { text: tool.name === 'what_kestrel_sees' ? sees(files) : NOTHING_FOUND, isError: false }
  let data
  if (tool.days) {
    const got = await logs.get(wait)
    if (got.waiting) return { text: stillReading(got.waiting), isError: false }
    data = got.data
  }
  return { text: tidy(await tool.answer({ data, days, now: Date.now(), files, wait })), isError: false }
}

/**
 * Runs the server until standard input ends. `input`, `output` and `errors` stand in for standard
 * input, output and error, and `env` for the environment.
 */
export function serve({ input = process.stdin, output = process.stdout, errors = process.stderr, env = process.env } = {}) {
  // Only protocol messages go to standard output. A part of the tool that prints by mistake
  // prints to standard error instead.
  for (const name of ['log', 'info', 'warn', 'debug']) console[name] = (...args) => errors.write(`${format(...args)}\n`)
  const wait = /^\d+$/.test(env.KESTREL_MCP_WAIT_MS ?? '') ? Number(env.KESTREL_MCP_WAIT_MS) : WAIT
  const logs = new Logs((message) => errors.write(`kestrel mcp: ${message}\n`))
  const serverInfo = { name: 'kestrel', title: 'Kestrel', version: version() ?? '0.0.0' }
  const open = new Set() // The tool calls that are not answered yet.
  const cancelled = new Set() // The ids of requests that the client cancelled.
  const send = (message) => output.write(`${JSON.stringify(message)}\n`)
  const failure = (id, code, message, data) => send({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), error: { code, message, ...(data === undefined ? {} : { data }) } })
  // When standard output can no longer be written, the client is gone.
  output.on('error', () => process.exit(0))

  function notification({ method, params }) {
    if (method === 'notifications/initialized') logs.start()
    else if (method === 'notifications/cancelled' && isId(params?.requestId)) cancelled.add(idKey(params.requestId))
    // Other notifications need nothing from this server.
  }

  function call(id, params, reply) {
    if (typeof params.name !== 'string') return failure(id, INVALID_PARAMS, 'Invalid params: "name" is the name of a tool.')
    // A client may send null for arguments it does not have.
    if (params.arguments != null && !isObject(params.arguments)) return failure(id, INVALID_PARAMS, 'Invalid params: "arguments" is an object.')
    const tool = TOOLS.find((t) => t.name === params.name)
    if (!tool) return failure(id, INVALID_PARAMS, `Unknown tool: ${short(params.name)}`)
    const task = run(tool, params.arguments ?? {}, logs, wait)
      .catch((e) => {
        errors.write(`kestrel mcp: ${tool.name}: ${e?.stack ?? e}\n`)
        const why = short(String(e?.message ?? e).split('\n')[0]).replace(/[.\s]+$/, '')
        return { text: `Kestrel could not answer because of an error: ${why}.`, isError: true }
      })
      .then(({ text, isError }) => {
        // A cancelled request gets no answer.
        if (!cancelled.delete(idKey(id))) reply({ content: [{ type: 'text', text }], isError })
      })
      .catch((e) => errors.write(`kestrel mcp: ${e?.stack ?? e}\n`))
    open.add(task)
    task.finally(() => open.delete(task))
  }

  function request(id, method, params) {
    const meta = isObject(params._meta) ? params._meta : {}
    // A request that names its version in "_meta" is one of the versions without a handshake.
    const modern = method !== 'initialize' && VERSION_KEY in meta
    if (method === 'server/discover' && !modern) return failure(id, INVALID_PARAMS, 'Invalid params: "_meta" has no protocol version.')
    if (modern) {
      const asked = meta[VERSION_KEY]
      if (typeof asked !== 'string') return failure(id, INVALID_PARAMS, 'Invalid params: the protocol version in "_meta" is not text.')
      if (!MODERN.includes(asked)) return failure(id, UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: [...MODERN, ...LEGACY], requested: asked })
      if (!isObject(meta[CAPABILITIES_KEY])) return failure(id, INVALID_PARAMS, 'Invalid params: "_meta" has no client capabilities.')
      // Such a client has no handshake, so its first request is the moment to start reading the logs.
      logs.start()
    }
    const reply = (result) => send({ jsonrpc: '2.0', id, result: modern ? { resultType: 'complete', ...result, _meta: { [SERVER_INFO_KEY]: serverInfo } } : result })
    switch (method) {
      case 'initialize': {
        if (typeof params.protocolVersion !== 'string') return failure(id, INVALID_PARAMS, 'Invalid params: "protocolVersion" is missing.')
        // The client's version when this server speaks it, else the newest one with a handshake.
        const agreed = LEGACY.includes(params.protocolVersion) ? params.protocolVersion : LEGACY[0]
        reply({ protocolVersion: agreed, capabilities: CAPABILITIES, serverInfo, instructions: INSTRUCTIONS })
        // The handshake is done, so the logs are read from now on: the first question then finds
        // them read, or partly read. The read starts after the answer has gone out.
        setImmediate(() => logs.start())
        return
      }
      case 'ping':
        return reply({})
      case 'server/discover':
        return reply({ supportedVersions: [...MODERN, ...LEGACY], capabilities: CAPABILITIES, instructions: INSTRUCTIONS, ttlMs: KEEP_LIST, cacheScope: 'public' })
      case 'tools/list':
        // All tools fit on one page, so a cursor is not needed.
        return reply({ tools: tools(), ...(modern ? { ttlMs: KEEP_LIST, cacheScope: 'public' } : {}) })
      case 'tools/call':
        return call(id, params, reply)
      default:
        return failure(id, METHOD_NOT_FOUND, `Method not found: ${short(method)}`)
    }
  }

  function handle(line) {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return failure(undefined, PARSE_ERROR, 'Parse error: the line is not JSON.')
    }
    const id = isId(message?.id) ? message.id : undefined
    if (!isObject(message) || message.jsonrpc !== '2.0') return failure(id, INVALID_REQUEST, 'Invalid request: not a JSON-RPC 2.0 message.')
    if (typeof message.method !== 'string') {
      // A response to a request. This server sends no requests, so there is nothing to do.
      if ('result' in message || 'error' in message) return
      return failure(id, INVALID_REQUEST, 'Invalid request: there is no method.')
    }
    if (!('id' in message)) return notification(message)
    if (id === undefined) return failure(undefined, INVALID_REQUEST, 'Invalid request: the id is text or a whole number.')
    if (message.params !== undefined && !isObject(message.params)) return failure(id, INVALID_PARAMS, 'Invalid params: "params" is an object.')
    return request(id, message.method, message.params ?? {})
  }

  const lines = createInterface({ input, crlfDelay: Infinity })
  lines.on('line', (line) => {
    try {
      handle(line)
    } catch (e) {
      // A message that breaks this server must not end it.
      errors.write(`kestrel mcp: ${e?.stack ?? e}\n`)
    }
  })
  // The client closes standard input to end the server. The calls that are still open are
  // answered first, each within its own wait. The read of the logs is not waited for: what it
  // parsed so far is in the cache.
  lines.on('close', () => {
    Promise.allSettled([...open]).then(() => output.write('', () => process.exit(0)))
  })
}
