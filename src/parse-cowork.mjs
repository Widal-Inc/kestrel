// Reads a Cowork session log and returns one record per model call.
//
// Cowork is the agent mode of the Claude desktop app. It runs the Claude Code engine. The app keeps
// one log per session that ran on this computer: the file audit.jsonl in the session's folder
// local_<id>. Its layout is not the layout of Claude Code's own logs:
//
//   - An answer of the model takes one line of type "assistant" per content block. Each line has
//     the answer's id and its token usage. So a model call is one id, counted once.
//   - That usage is from the start of the answer. Its input, cache read and cache write counts are
//     complete. Its output count is only the few tokens written by then.
//   - A turn starts with a line of type "system" and subtype "init", and ends with a line of type
//     "result". The result line has the turn's totals per model. This reader shares the output of
//     a model in a turn among that model's calls in the turn, by how much each call wrote. So the
//     output of a turn is exact, and its split between the calls is an estimate.
//   - A subagent's calls are in the same file. They carry the id of the tool call that started the
//     subagent in "parent_tool_use_id".
//   - Between two calls, the lines of type "user" hold the tool results and the person's messages
//     that were added to the context.
//   - The time of a line is "_audit_timestamp". The working folder is on the "init" line.
//
// What the log does not have:
//   - The calls the app makes on the side, for example a small model that reads a web page. A
//     result line counts them, and no line shows them. They are not in the records.
//   - How much of an answer was thinking, as a count for one call. The log does have lines of
//     type "system" with subtype "thinking_tokens". Each holds a running estimate while the
//     model thinks: "estimated_tokens", and "estimated_tokens_delta" for what was added since
//     the line before. Such a line has no key that names an answer or a subagent: its other keys
//     are an id of its own, the session and the time. The lines follow each other in runs. In
//     the logs on one Mac (2026-11-13), 456 of 579 runs were followed by an answer with a
//     thinking block, and 123 by a line of another kind. So a run cannot be tied to one call for
//     certain, and its number is an estimate, not a count. This reader does not use these
//     lines, and the thinking of a call stays 0.
//   - The effort and the git branch.
//   - The output of a call in a turn that has no result line (a turn that was stopped). Such a
//     call keeps the count from the start of its answer, which is too low.
//
// The engine's own logs of the same session are in .claude/projects below the session's folder,
// in Claude Code's layout, with the full output of each call. They were used to check this reader.
// It does not read them.
//
// The account: the app keeps the logs in <cowork folder>/<account folder>/<workspace folder>/
// local_<id>/. So the first folder below the Cowork folder is the account, and the calls of a log
// count to "cowork:<that folder's name>". On the Mac this was checked on (14 Nov 2026), 2 of the 4
// account folders had the id of a Claude account that Claude Code's logs name.
//
// The layout was read from the logs on one Mac on 2026-11-13. It is internal to the app and can
// change. This parser reads only the fields it needs and skips what it does not know.
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'
import { resultEntry } from './parse-claude.mjs'
import { coworkDir } from './paths.mjs'
import { programOf } from './program.mjs'

// The name of an account folder becomes a part of a key, so it is taken only when it is a plain name.
const FOLDER = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/

/**
 * The account of a Cowork log: "cowork:<account folder>", or "unknown" when the log is not in
 * an account folder. The account folder is the first folder below the Cowork folder, with two
 * more folders below it. A log outside the Cowork folder (a test can parse one) takes the folder
 * three above it.
 */
export function coworkAccount(file) {
  const rel = relative(coworkDir(), file)
  const parts = rel.split(sep)
  const inside = rel && !rel.startsWith('..') && !isAbsolute(rel)
  const folder = inside ? (parts.length >= 4 ? parts[0] : undefined) : basename(dirname(dirname(dirname(file))))
  return folder && FOLDER.test(folder) ? `cowork:${folder}` : 'unknown'
}

// What a result line counts per model. Its other figures are limits of the model, not counts.
const COUNTED = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'webSearchRequests', 'costUSD']

// A count that is not a number is taken as 0, so that it cannot turn a sum into text or into "not a number".
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

const textSize = (content) => {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const b of content) {
    if (typeof b === 'string') n += b.length
    else if (b?.type === 'text' && typeof b.text === 'string') n += b.text.length
    else if (b?.type === 'tool_result') n += textSize(b.content)
  }
  return n
}

/**
 * How much one content block of an answer wrote, in characters. The log mostly leaves the thinking
 * out and keeps only its signature, which grows with it. So three quarters of the signature's
 * length stand for the thinking. Checked against the engine's own logs of 5,714 calls: the split
 * of a turn's output was then off by 19% of the output on average, and by 45% without the signature.
 */
const written = (b) =>
  b?.type === 'text' ? textSize(b.text)
  : b?.type === 'thinking' ? (typeof b.signature === 'string' && b.signature ? 0.75 * b.signature.length : textSize(b.thinking))
  : b?.type === 'tool_use' ? JSON.stringify(b.input ?? null).length
  : 0

export class CoworkParser {
  /** @param {string} file The path of the session log. */
  constructor(file) {
    this.file = file
    // The session's folder is local_<id>. The lines carry two session ids: this one, and the engine's.
    this.session = basename(dirname(file)).replace(/^local_/, '')
    this.account = coworkAccount(file)
    this.records = []
    this.byId = new Map()
    this.toolName = new Map() // The name and the signature of each tool call, by its id.
    this.programs = new Map() // The program of each shell command, by the id of its call.
    // What entered the context since the last call: of the main session (the key '') and of each subagent.
    this.pending = new Map()
    this.wrote = new Map() // How many characters each call wrote.
    this.turn = [] // The calls since the last "init" line.
    this.afterCompact = false
    this.cwd = undefined
    // The app's own figures, from the result lines: the total, and the counts per model. The
    // name of a model comes from the log, so the counts are kept in a Map. In a plain object a
    // model that is named "__proto__" would change every object of this run.
    this.cost = undefined
  }

  /** Takes the next line of the log. It never throws: a line it cannot read is skipped. */
  feed(line) {
    try {
      const d = JSON.parse(line)
      if (d?.type === 'assistant') this.#assistant(d)
      else if (d?.type === 'user') this.#user(d)
      else if (d?.type === 'result') this.#result(d)
      else if (d?.type === 'system' && d.subtype === 'init') {
        if (typeof d.cwd === 'string') this.cwd = d.cwd
        this.turn = []
      } else if (d?.type === 'system' && d.subtype === 'compact_boundary') this.afterCompact = true
    } catch {
      // A line that is still being written, broken, or not in the shape this reader knows.
    }
  }

  #assistant(d) {
    const m = d.message
    const u = m?.usage
    // A line whose model is not text, or whose usage is not an object, is not an answer in the
    // shape this reader knows. It is skipped, so that no value of another type gets into a record.
    if (!m?.id || typeof m.model !== 'string' || !isObject(u) || m.model === '<synthetic>') return
    let r = this.byId.get(m.id)
    if (!r) {
      const parent = typeof d.parent_tool_use_id === 'string' ? d.parent_tool_use_id : undefined
      r = {
        // The analysis follows one context per `f`, and knows a subagent by "/subagents/" in it.
        // Claude Code gives a subagent a file of its own there. Here its calls get the same kind of name.
        s: 'cowork', f: parent ? `${this.file}/subagents/${parent}` : this.file, ses: this.session, agent: parent, cwd: this.cwd,
        ts: Date.parse(d._audit_timestamp ?? d.timestamp) || 0, id: m.id, m: m.model, ef: undefined,
        in: 0, w5: 0, w1: 0, cr: 0, out: 0, th: 0, web: 0, tools: [], add: this.pending.get(parent ?? '') ?? [], acct: this.account,
      }
      this.pending.delete(parent ?? '')
      if (this.afterCompact && !parent) {
        r.ac = true
        this.afterCompact = false
      }
      this.byId.set(m.id, r)
      this.records.push(r)
      this.turn.push(r)
      this.wrote.set(r, 0)
    }
    // Every line of an answer repeats the usage from its start.
    const split = isObject(u.cache_creation) ? u.cache_creation : undefined
    r.in = num(u.input_tokens)
    r.cr = num(u.cache_read_input_tokens)
    r.w1 = num(split?.ephemeral_1h_input_tokens)
    r.w5 = split ? num(split.ephemeral_5m_input_tokens) : num(u.cache_creation_input_tokens)
    r.out = Math.max(r.out, num(u.output_tokens))
    r.web = num(u.server_tool_use?.web_search_requests)
    if (typeof u.speed === 'string' && u.speed !== 'standard') r.sp = u.speed
    for (const b of Array.isArray(m.content) ? m.content : []) {
      // A tool call whose name is not text is not one this reader knows. It is not kept as a
      // tool call, and its result, if one comes, counts as the result of an unknown tool.
      if (b?.type === 'tool_use' && typeof b.name === 'string' && b.name) {
        if (this.toolName.has(b.id)) continue
        // The same tool with the same input has the same signature: this finds repeated calls.
        const sig = createHash('sha1').update(b.name).update(JSON.stringify(b.input ?? null)).digest('hex').slice(0, 8)
        this.toolName.set(b.id, [b.name, sig])
        // Of a shell command only the name of its program is kept, never the command (see program.mjs).
        if (b.name === 'Bash') this.programs.set(b.id, programOf(b.input?.command))
        r.tools.push([b.name, sig])
      }
      this.wrote.set(r, this.wrote.get(r) + written(b))
    }
  }

  #user(d) {
    // The app writes a message again when the engine confirms it. It is counted once.
    if (d.isReplay) return
    // The summary that replaced the old context is counted as the new context's start, not here.
    if (d.isSynthetic && this.afterCompact) return
    const parent = typeof d.parent_tool_use_id === 'string' ? d.parent_tool_use_id : ''
    const typed = parent ? '(messages to the subagent)' : d.isSynthetic ? '(added by the app)' : '(your messages)'
    if (!this.pending.has(parent)) this.pending.set(parent, [])
    const pending = this.pending.get(parent)
    const content = d.message?.content
    if (typeof content === 'string') {
      if (content.length) pending.push([typed, content.length])
      return
    }
    for (const b of Array.isArray(content) ? content : []) {
      if (b?.type === 'tool_result') pending.push(resultEntry(this.toolName.get(b.tool_use_id), textSize(b.content), this.programs.get(b.tool_use_id), b.is_error === true))
      else if (b?.type === 'text' && typeof b.text === 'string' && b.text) pending.push([typed, b.text.length])
    }
  }

  /** The end of a turn. Its figures are for the calls since the "init" line before it. */
  #result(d) {
    const calls = this.turn
    this.turn = []
    this.cost ??= { total: 0, models: new Map() }
    this.cost.total += num(d.total_cost_usd)
    const output = new Map()
    for (const [name, u] of Object.entries(isObject(d.modelUsage) ? d.modelUsage : {})) {
      if (!isObject(u)) continue
      // "[1m]" after a model id marks the long context window. The calls carry the id without it.
      const m = name.replace(/\[1m\]$/, '')
      output.set(m, (output.get(m) ?? 0) + num(u.outputTokens))
      if (!this.cost.models.has(m)) this.cost.models.set(m, Object.fromEntries(COUNTED.map((k) => [k, 0])))
      const sum = this.cost.models.get(m)
      for (const k of COUNTED) sum[k] += num(u[k])
    }
    for (const [m, total] of output) {
      const list = calls.filter((r) => r.m === m)
      const more = total - list.reduce((n, r) => n + r.out, 0)
      if (!list.length || more <= 0) continue
      const size = (r) => Math.max(1, this.wrote.get(r))
      const all = list.reduce((n, r) => n + size(r), 0)
      let left = more
      for (const r of list) {
        const share = Math.floor((more * size(r)) / all)
        r.out += share
        left -= share
      }
      list.at(-1).out += left // What rounding down left over.
    }
  }

  /**
   * What the file gave: the calls, and the app's own cost figure for the session if it wrote one.
   * The counts per model are given as an object, because the result is saved as JSON. Each name
   * is set as a key of its own, so a name like "__proto__" is a key like any other.
   */
  result() {
    const costState = this.cost && { total: this.cost.total, models: Object.fromEntries(this.cost.models) }
    return { records: this.records, meta: { costState } }
  }
}
