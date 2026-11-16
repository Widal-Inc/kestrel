// Assigns every dollar of a session to what caused it.
//
// An agent sends its whole context to the model on every call. So a piece of text that enters the
// context is paid for when it enters, and again on every later call, until the context is
// summarized or the piece is cleared. This file follows each piece (a "block") through the calls:
//
//   - A block enters at one call. Its entry cost is its share of what that call paid for new input.
//   - On each later call the block is carried. If the provider still has it in its cache, it is
//     read at the low cache price. If not, it is written again at the high price.
//   - A block ends when the context is summarized (compaction) or when the agent clears old tool
//     results. The oldest results are cleared first.
//
// The provider reports exact token counts per call, so the totals are exact. The split of one
// call's new tokens between the blocks that entered at that call is an estimate, by their size in
// characters.
import { cost, priceOf, rates } from './prices.mjs'

// Only used to notice that the agent cleared old results. Never used for money.
const CHARS_PER_TOKEN = 3.6
const BASE = '(system prompt, tools and first message)'
const SUMMARY = '(summary after compaction)'
const OWN = "(the model's earlier output)"

/**
 * @param {object[]} records The model calls, as the parsers return them.
 * @returns {{calls: object[], blocks: object[]}} Each call with its cost and what it carried, and
 *   each block with its entry cost and its carry cost.
 */
export function analyze(records) {
  const chains = new Map()
  for (const r of records) {
    if (!chains.has(r.f)) chains.set(r.f, [])
    chains.get(r.f).push(r)
  }
  const calls = []
  const blocks = []
  for (const list of chains.values()) chain(list.sort((a, b) => a.ts - b.ts), calls, blocks)
  calls.sort((a, b) => a.r.ts - b.r.ts)
  return { calls, blocks }
}

function chain(list, calls, blocks) {
  let live = [] // The blocks in the context, oldest first.
  let head = 0 // The first block that clearing may remove. Blocks before it are fixed.
  let liveTokens = 0
  let cum = 0 // The sum, over the calls so far, of the price of carrying one token.
  let prev
  let wrote1h = false

  const close = (b, tokens, index) => {
    // A block that entered at call `enter` and ends before call `index` was carried on the calls between.
    blocks.push({ ...b, tokens, carry: tokens * (cum - b.start), carriedCalls: Math.max(0, index - b.enter - 1) })
  }
  const closeAll = (index) => {
    for (let k = 0; k < live.length; k++) if (live[k]) close(live[k], live[k].tokens, index)
    live = []
    head = 0
    liveTokens = 0
  }
  const enter = (label, tokens, entry, r, index) => {
    live.push({ label, tokens, entry, start: cum, enter: index, ses: r.ses, f: r.f, cwd: r.cwd, ts: r.ts, known: !!rates(r) })
    liveTokens += tokens
  }

  list.forEach((r, i) => {
    const c = cost(r)
    const rt = rates(r)
    const ctx = r.in + r.w5 + r.w1 + r.cr
    const inputCost = c.in + c.write + c.read
    const e = { r, c, ctx, carried: 0, carriedCost: 0, newTokens: ctx, newCost: inputCost, gap: prev ? r.ts - prev.r.ts : 0 }
    if (r.w1 > 0) wrote1h = true

    if (!prev || r.ac) {
      // A new context: the session's start, or the summary that replaced the old context.
      closeAll(i)
      enter(prev ? SUMMARY : BASE, ctx, inputCost, r, i)
      head = 1
    } else {
      // Did the agent clear old tool results? Then the context is clearly smaller than what was
      // carried over plus the model's last answer plus what was added.
      const added = r.add.reduce((n, a) => n + a[1], 0) / CHARS_PER_TOKEN
      let cleared = liveTokens + prev.r.out + added - ctx
      if (ctx < liveTokens + prev.r.out && cleared > Math.max(4000, 0.05 * liveTokens)) {
        while (cleared > 0 && head < live.length) {
          const b = live[head]
          const take = Math.min(b.tokens, cleared)
          close(b, take, i)
          b.tokens -= take
          liveTokens -= take
          cleared -= take
          if (b.tokens <= 0) live[head++] = undefined
        }
      }
      const carried = Math.min(liveTokens, ctx)
      const read = Math.min(r.cr, carried)
      const rewritten = carried - read
      const fresh = r.in + r.w5 + r.w1
      const writeRate = rt ? (fresh > 0 ? (c.in + c.write) / fresh : rt.w5) : 0
      const carriedCost = rt ? Math.min(inputCost, read * rt.read + rewritten * writeRate) : 0
      if (liveTokens > 0) cum += carriedCost / liveTokens
      e.carried = carried
      e.carriedCost = carriedCost
      e.newTokens = Math.max(0, ctx - carried)
      e.newCost = inputCost - carriedCost

      // A cache miss: most of what was sent before had to be written to the cache again.
      if (rt && prev.ctx > 8000 && r.cr < 0.5 * Math.min(prev.ctx, ctx)) {
        e.miss =
          r.m !== prev.r.m ? 'the model changed'
          : e.gap > 3600e3 ? 'idle for over 1 hour'
          : e.gap > 300e3 && !wrote1h ? 'idle for over 5 minutes'
          : 'the start of the prompt changed'
        e.waste = rewritten * (writeRate - rt.read)
        // What it would have cost to keep the cache alive through the gap instead: one read of the
        // context every 4 minutes. Only for gaps up to 2 hours: longer ones are real breaks.
        if (e.gap > 300e3 && e.gap <= 7200e3) e.keepAlive = Math.floor(e.gap / 240e3) * carried * rt.read
      }

      // What is new in this call: the model's last answer, which is now part of the context (its
      // size is known), and what entered since (split by size in characters).
      if (e.newTokens > 0) {
        const own = Math.min(prev.r.out, e.newTokens)
        const rest = e.newTokens - own
        const perToken = e.newCost / e.newTokens
        if (own > 0) enter(OWN, own, own * perToken, r, i)
        const chars = r.add.reduce((n, a) => n + a[1], 0)
        if (rest > 0) {
          if (chars > 0) for (const [label, size] of r.add) enter(label, (rest * size) / chars, (rest * perToken * size) / chars, r, i)
          else enter('(other new context)', rest, rest * perToken, r, i)
        }
      }
    }
    calls.push(e)
    prev = e
  })
  closeAll(list.length)
}

/** Sums of money by what was paid for, over a list of analyzed calls. */
export function totals(calls) {
  const t = { calls: calls.length, total: 0, in: 0, write: 0, read: 0, out: 0, think: 0, web: 0, carried: 0, fresh: 0, waste: 0, unknown: 0 }
  for (const e of calls) {
    if (!e.c.known) {
      t.unknown++
      continue
    }
    t.total += e.c.total
    t.in += e.c.in
    t.write += e.c.write
    t.read += e.c.read
    t.out += e.c.out
    t.think += e.c.think
    t.web += e.c.web
    t.carried += e.carriedCost
    t.fresh += e.newCost
    t.waste += e.waste ?? 0
  }
  return t
}

// The kinds of work, with the tools of each. The kind of a call comes from the names of the tools
// it used, never from text. The order decides: a call that used tools of two kinds counts as the
// kind that comes first. The names are those of Claude Code, then those of Codex.
//
// Codex's "exec" is not listed on purpose. It runs a script that can read files, change files or
// run commands, and its name does not say which. So it counts as another tool.
export const READING = 'reading and searching'
export const COMMANDS = 'running commands'
const CHANGING = 'changing files'
const OTHER_TOOLS = 'other tools'
export const NO_TOOL = 'thinking and answering'
const KINDS = [
  [CHANGING, ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']],
  [COMMANDS, ['Bash', 'BashOutput', 'KillShell', 'shell', 'exec_command', 'local_shell']],
  ['handing work to a subagent', ['Agent', 'Task', 'Workflow', 'SendMessage', 'spawn_agent', 'send_message', 'followup_task']],
  [READING, ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'NotebookRead', 'read_file', 'list_dir', 'grep_files', 'view_image']],
]
const KIND_OF_TOOL = new Map(KINDS.flatMap(([, tools], i) => tools.map((name) => [name, i])))

/** Every kind of work, in the order that decides. */
export const KIND_NAMES = [...KINDS.map(([kind]) => kind), OTHER_TOOLS, NO_TOOL]

/** The kind of work of one model call. `r` is a call as the parsers return it. */
export function kindOf(r) {
  const tools = r.tools ?? []
  if (!tools.length) return NO_TOOL
  let first = KINDS.length
  for (const [name] of tools) first = Math.min(first, KIND_OF_TOOL.get(name) ?? KINDS.length)
  return first < KINDS.length ? KINDS[first][0] : OTHER_TOOLS
}

/** The middle value of a list of numbers. With an even number of values it is the mean of the two in the middle. 0 for an empty list. */
export function median(list) {
  const sorted = [...list].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (!sorted.length) return 0
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * The compactions of all sessions, the oldest first. `metas` is what `load()` in store.mjs gives
 * next to the calls: for each log, what its parser kept about the session. Only Claude Code's
 * parser keeps compactions. Each is `{ ts, trigger, pre, post, sec, ses, agent, cwd }`: the
 * time, "auto" or "manual", the tokens before and after, the seconds it took, the session, the
 * subagent when it was one, and the folder.
 *
 * A session that was resumed can repeat its earlier lines in a second log. So a compaction with
 * the same time and the same sizes as one before is counted once.
 */
export function compactionsOf(metas) {
  const seen = new Set()
  const all = []
  for (const [file, meta] of metas?.entries() ?? []) {
    for (const c of Array.isArray(meta?.compactions) ? meta.compactions : []) {
      const key = `${c.ts} ${c.pre} ${c.post}`
      if (seen.has(key)) continue
      seen.add(key)
      // `f` is the log the compaction is in, so that it can be set next to the calls of that log.
      all.push({ ...c, f: file })
    }
  }
  return all.sort((a, b) => a.ts - b.ts)
}

// Some calls have no effort level in the log.
const NOT_LOGGED = '(not logged)'

/** The effort level of a call, as the agent logged it. */
export const effortOf = (r) => (typeof r.ef === 'string' && r.ef ? r.ef : NOT_LOGGED)

// The effort levels, lowest first. Claude Code's highest is "max", Codex's is "ultra".
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

/** True when a call ran at effort "high" or above. A call without a logged effort does not count. */
export const highEffort = (r) => EFFORTS.indexOf(r.ef) >= EFFORTS.indexOf('high')

/** The effort levels below a level, the nearest first. None for a level that is not known. */
export const lowerEfforts = (ef) => EFFORTS.slice(0, Math.max(0, EFFORTS.indexOf(ef))).reverse()

// The model the advice compares with. A model whose output price is above this model's counts as a strong model.
const COMPARED = 'claude-sonnet-5-5'

/** True when the call's model has a price and its output price is above Claude Sonnet 5.5's. */
export function strongModel(r) {
  const p = priceOf(r.m)
  return !!p && p.out > priceOf(COMPARED).out
}

/**
 * Simple work on a strong model at high effort: the call read, searched or ran commands, at
 * effort "high" or above, on a strong model. Such a call is a first place to look for a lower
 * effort or a cheaper model.
 */
export function simpleOnStrong(r) {
  const kind = kindOf(r)
  return (kind === READING || kind === COMMANDS) && highEffort(r) && strongModel(r)
}

const groupBy = (list, key) => {
  const m = new Map()
  for (const x of list) {
    const k = key(x)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(x)
  }
  return m
}
const kindOfTool = (name) => KINDS[KIND_OF_TOOL.get(name)]?.[0]

/**
 * Tool calls that ran 4 times or more with the same input in one session. This can be a loop, or
 * a check that is repeated on purpose. One entry per tool and input, with the number of times.
 * `calls` are analyzed calls.
 */
export function repeatedToolCalls(calls) {
  const repeats = []
  for (const [ses, list] of groupBy(calls, (e) => e.r.ses)) {
    const seen = new Map()
    for (const e of list) for (const [name, sig] of e.r.tools ?? []) seen.set(`${name} ${sig}`, (seen.get(`${name} ${sig}`) ?? 0) + 1)
    for (const [k, n] of seen) if (n >= 4) repeats.push({ ses, tool: k.split(' ')[0], n, cwd: list[0].r.cwd })
  }
  return repeats
}

/**
 * Rounds of fixing: a command failed, a later call changed files, and a still later call ran the
 * same command again (the same tool with the same input). Each such third step is one round.
 * Counted inside one log, because a session and each of its subagents work on their own.
 * `calls` are analyzed calls, in the order of time.
 */
function fixRounds(calls) {
  let rounds = 0
  for (const list of groupBy(calls, (e) => e.r.f).values()) {
    // A command that failed is "failed". Once files were changed after it, it is "changed".
    const commands = new Map()
    for (const e of list) {
      const tools = e.r.tools ?? []
      for (const [name, sig] of tools) {
        if (commands.get(`${name} ${sig}`) !== 'changed') continue
        rounds++
        commands.delete(`${name} ${sig}`)
      }
      if (tools.some(([name]) => kindOfTool(name) === CHANGING)) for (const k of commands.keys()) commands.set(k, 'changed')
      for (const [name, sig, failed] of tools) if (failed && kindOfTool(name) === COMMANDS) commands.set(`${name} ${sig}`, 'failed')
    }
  }
  return rounds
}

/**
 * What a group of calls cost, and signs of how the work went: tool errors, rounds of fixing,
 * interrupts by the person and repeated tool calls. Each is a rate, so that two groups of
 * different size can be compared. None of them is proof that the work was good or bad.
 * `calls` are analyzed calls with a price, in the order of time.
 */
export function measures(calls) {
  const sum = (f) => calls.reduce((n, e) => n + f(e), 0)
  const sessions = new Set(calls.map((e) => e.r.ses)).size
  const cost = sum((e) => e.c.total)
  const per1000 = (x) => (calls.length ? (1000 * x) / calls.length : 0)
  const perSession = (x) => (sessions ? x / sessions : 0)
  return {
    calls: calls.length,
    sessions,
    cost: per1000(cost),
    costPerSession: perSession(cost),
    callsPerSession: perSession(calls.length),
    errors: per1000(sum((e) => e.r.err ?? 0)),
    fixRounds: per1000(fixRounds(calls)),
    interrupts: per1000(sum((e) => e.r.intr ?? 0)),
    repeats: per1000(repeatedToolCalls(calls).reduce((n, x) => n + x.n, 0)),
  }
}
