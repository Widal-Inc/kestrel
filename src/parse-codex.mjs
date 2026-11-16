// Reads a Codex session log and returns one record per model call.
//
// Codex writes each session as JSON lines in ~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl.
// Newer versions write a "token_usage_record" line per model call. Older ones only write
// "token_count" events, whose "last_token_usage" is the usage of the latest call.
// In OpenAI's usage, cached input is a part of input, and thinking is a part of output.
//
// Two signs of how the work went are kept as a count and a flag. Codex writes an "item_completed"
// event for each command, file change or connector call it ran, with the status "failed" when it
// failed. It writes a "turn_aborted" event with the reason "interrupted" when the person stops the
// agent. A failed item does not name the tool call it belongs to (a command runs inside a script
// of the "exec" tool), so a tool call cannot be marked as failed here.
//
// The account: a Codex log names no account. Some of its "token_count" events name the plan the
// person is on ("rate_limits.plan_type", such as "free" or "plus"). So the calls of a log count to
// the account "codex:<plan type>", with the last plan type the log names, or to "codex:unknown"
// when it names none. Codex's sign-in file is never read.
//
// The log format is internal to Codex and changes between versions. The type of each value that
// is kept is checked. A name that is not text, or a count that is not a number, would make every
// report fail for as long as that log is read.
import { createHash } from 'node:crypto'
import { basename } from 'node:path'

// A plan type becomes a part of a key, so it is taken only when it is a plain word.
const PLAN = /^[A-Za-z0-9_-]{1,40}$/

// A count that is not a number is taken as 0, so that it cannot turn a sum into text or into "not a number".
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
/** A value when it is text that is not empty, else undefined. */
const text = (v) => (typeof v === 'string' && v ? v : undefined)

const size = (v) => (typeof v === 'string' ? v.length : Array.isArray(v) ? v.reduce((n, b) => n + size(b?.text ?? b?.output ?? ''), 0) : 0)

export class CodexParser {
  constructor(file) {
    this.file = file
    this.session = basename(file, '.jsonl')
    this.records = []
    this.pending = []
    this.pendingTools = []
    this.callName = new Map()
    this.model = undefined
    this.effort = undefined
    this.cwd = undefined
    this.afterCompact = false
    this.errors = 0
    this.interrupted = false
    this.hasRecords = false
    this.lastTotal = -1
    this.limits = undefined
    this.n = 0
  }

  /** Takes the next line of the log. It never throws: a line it cannot read is skipped. */
  feed(line) {
    try {
      this.#line(JSON.parse(line))
    } catch {
      // A line that is still being written, broken, or not in the shape this reader knows.
    }
  }

  #line(d) {
    const p = d?.payload
    if (!p || typeof p !== 'object') return
    if (d.type === 'session_meta') {
      this.session = text(p.session_id) ?? text(p.id) ?? this.session
      this.cwd = text(p.cwd) ?? this.cwd
      this.branch = text(p.git?.branch) ?? this.branch
    } else if (d.type === 'turn_context') {
      this.model = text(p.model) ?? this.model
      this.effort = p.effort ?? undefined
      this.cwd = text(p.cwd) ?? this.cwd
    } else if (d.type === 'compacted') {
      this.afterCompact = true
    } else if (d.type === 'token_usage_record') {
      this.hasRecords = true
      this.#call(d, p.usage, p.response_id)
    } else if (d.type === 'event_msg' && p.type === 'item_completed') {
      if (p.item?.status === 'failed') this.errors++
    } else if (d.type === 'event_msg' && p.type === 'turn_aborted') {
      if (p.reason === 'interrupted') this.interrupted = true
    } else if (d.type === 'event_msg' && p.type === 'token_count') {
      if (p.rate_limits?.primary) this.limits = { plan: p.rate_limits.plan_type, ...p.rate_limits.primary }
      if (typeof p.rate_limits?.plan_type === 'string' && PLAN.test(p.rate_limits.plan_type)) this.plan = p.rate_limits.plan_type
      const total = p.info?.total_token_usage?.total_tokens
      // The same count is written more than once. A new total is a new call.
      if (!this.hasRecords && p.info?.last_token_usage && total !== this.lastTotal) {
        this.lastTotal = total
        this.#call(d, p.info.last_token_usage)
      }
    } else if (d.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        // A tool call whose name is not text is not one this reader knows. Its output, if one
        // comes, counts as the output of an unknown tool.
        if (!text(p.name)) return
        this.callName.set(p.call_id, p.name)
        const sig = createHash('sha1').update(String(p.name)).update(String(p.arguments ?? p.input ?? '')).digest('hex').slice(0, 8)
        // Codex writes a call's tool requests before the call's usage: they belong to the next record.
        this.pendingTools.push([p.name, sig])
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        this.pending.push([this.callName.get(p.call_id) ?? '(unknown tool)', size(p.output)])
      } else if (p.type === 'message' && p.role === 'user') {
        this.pending.push(['(your messages)', size(p.content)])
      }
    }
  }

  #call(d, u, id) {
    if (!u || typeof u !== 'object') return
    const cached = num(u.cached_input_tokens)
    // Input written to the cache is a part of input too, billed at the write price on newer models.
    const written = num(u.cache_write_input_tokens)
    const r = {
      s: 'codex', f: this.file, ses: this.session, cwd: this.cwd, br: this.branch, ts: Date.parse(d.timestamp) || 0,
      id: text(id) ?? `${this.session}:${this.n++}`, m: this.model, ef: this.effort,
      in: Math.max(0, num(u.input_tokens) - cached - written), w5: written, w1: 0, cr: cached,
      out: num(u.output_tokens), th: num(u.reasoning_output_tokens), web: 0, tools: this.pendingTools, add: this.pending,
    }
    if (this.afterCompact) r.ac = true
    // What happened before this call: items that failed, and an interrupt by the person.
    if (this.errors) r.err = this.errors
    if (this.interrupted) r.intr = 1
    this.pendingTools = []
    this.pending = []
    this.afterCompact = false
    this.errors = 0
    this.interrupted = false
    this.records.push(r)
  }

  /** What the file gave: the calls, each with the account of the log, and the plan's limits that the log gave last. */
  result() {
    const acct = `codex:${this.plan ?? 'unknown'}`
    for (const r of this.records) r.acct = acct
    return { records: this.records, meta: { limits: this.limits } }
  }
}
