// The reports: what was spent, what the money paid for, and what could be avoided.
import { labelOf, readAccounts } from './accounts.mjs'
import { KIND_NAMES, READING, analyze, compactionsOf, effortOf, kindOf, median, repeatedToolCalls, simpleOnStrong, totals } from './analyze.mjs'
import { clock, count, day, model, money, pct, plain, project, table, tok, when } from './format.mjs'
import { rates } from './prices.mjs'
import { ticketOf } from './ticket.mjs'

const sourceName = { claude: 'Claude Code', codex: 'Codex', cowork: 'Cowork' }
/** Printed where the sources are named, when there are Cowork logs. The logs hold only the sessions that ran on this computer. */
export const COWORK_NOTE = "Cowork sessions that ran in Anthropic's cloud are not on this computer, so they are not counted."
const group = (list, key) => {
  const m = new Map()
  for (const x of list) {
    const k = key(x)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(x)
  }
  return m
}
const sum = (list, f) => list.reduce((n, x) => n + f(x), 0)
const tokensOf = (e) => e.ctx + e.r.out

/** The lines that say what the money paid for. */
function paidFor(t) {
  const rows = [
    ['Carrying context', money(t.carried), pct(t.carried, t.total), 'text that was sent again on a later call'],
    ['  of that, lost cache', money(t.waste), pct(t.waste, t.total), 'written again because the cache was gone'],
    ['New context', money(t.fresh), pct(t.fresh, t.total), 'tool results, files and messages entering'],
    ['Model output', money(t.out), pct(t.out, t.total), 'what the model wrote'],
    ['  of that, thinking', money(t.think), pct(t.think, t.total), ''],
  ]
  if (t.web > 0) rows.push(['Web search fees', money(t.web), pct(t.web, t.total), ''])
  return table(rows, [1, 2])
}

function unknownNote(calls) {
  const unknown = calls.filter((e) => !e.c.known)
  if (!unknown.length) return ''
  // The name of a model comes from a log, and this note is not a table: the name is printed
  // without control characters, so that it cannot add a line or change the terminal.
  const models = [...new Set(unknown.map((e) => plain(e.r.m ?? '')))].join(', ')
  return `\nNo price is known for ${models}: ${count(unknown.length)} calls, ${tok(sum(unknown, tokensOf))} tokens, not in the dollar figures.\nAdd prices in ~/.kestrel/prices.json.\n`
}

export function summary(records, { days }) {
  const { calls } = analyze(records)
  if (!calls.length) return `No model calls in the last ${days} days.`
  const t = totals(calls)
  const out = [`Agent spend, last ${days} days. List prices, so an estimate. On a subscription this is what the same use would cost by the token.`, '']
  const rows = [['Total', money(t.total), `${count(t.calls)} model calls`]]
  for (const [s, list] of group(calls, (e) => e.r.s)) {
    const st = totals(list)
    rows.push([`  ${sourceName[s] ?? s}`, st.unknown === list.length ? 'no price' : money(st.total), `${count(list.length)} calls, ${tok(sum(list, tokensOf))} tokens`])
  }
  out.push(table(rows, [1]))
  if (calls.some((e) => e.r.s === 'cowork')) out.push(COWORK_NOTE)
  out.push(unknownNote(calls), 'What the money paid for', paidFor(t), '')

  const section = (title, key, label, top = 8) => {
    const g = [...group(calls, key)].map(([k, list]) => ({ k, t: totals(list), list })).sort((a, b) => b.t.total - a.t.total || b.list.length - a.list.length)
    out.push(title, table(g.slice(0, top).map((x) => [`  ${label(x.k)}`, money(x.t.total), pct(x.t.total, t.total), `${count(x.list.length)} calls`]), [1, 2, 3]), '')
  }
  // A person can use more than one account. With more than one in the period, each gets its row,
  // with the person's own label or the organisation's name (see accounts.mjs).
  const accountOf = (e) => (typeof e.r.acct === 'string' ? e.r.acct : 'unknown')
  if (new Set(calls.map(accountOf)).size > 1) {
    const state = readAccounts()
    section('By account', accountOf, (k) => labelOf(k, state))
  }
  section('By day', (e) => day(e.r.ts), (k) => k, 14)
  section('By project', (e) => project(e.r.cwd), (k) => k)
  section('By model', (e) => e.r.m, model)
  out.push('Next: "kestrel findings" for what can be done, "kestrel session" for the latest session.')
  return out.join('\n')
}

/**
 * The spend of the period and of today as data ("kestrel summary --json"), for the pane in Claude
 * Code: dollars at list prices, tokens, calls and sessions, then the same per day (newest first)
 * and per tool. `now` says which local day is today. `unpriced` counts the calls of a model
 * without a price, which are not in the dollars.
 */
export function summaryData(records, { days, now = Date.now() }) {
  const { calls } = analyze(records)
  const part = (list) => {
    const t = totals(list)
    return { cost: t.total, tokens: sum(list, tokensOf), calls: list.length, sessions: new Set(list.map((e) => e.r.ses).filter(Boolean)).size, unpriced: t.unknown }
  }
  const today = day(now)
  return {
    days,
    period: part(calls),
    today: part(calls.filter((e) => day(e.r.ts) === today)),
    byDay: [...group(calls, (e) => day(e.r.ts))].sort(([a], [b]) => (a < b ? 1 : -1)).map(([d, list]) => ({ day: d, ...part(list) })),
    byTool: [...group(calls, (e) => e.r.s)].map(([s, list]) => ({ tool: sourceName[s] ?? s, ...part(list) })),
  }
}

const NO_KIND = '(kind not logged)'

/**
 * The figures of the "models" report. Every table splits the same calls another way, so the cost
 * of the rows of each table adds up to `total`.
 */
export function modelsData(records) {
  const { calls } = analyze(records)
  const t = totals(calls)
  const costOf = (list) => sum(list, (e) => e.c.total)
  const largestFirst = (a, b) => b.cost - a.cost || b.calls - a.calls

  const byModelEffort = [...group(calls, (e) => `${e.r.m} ${effortOf(e.r)}`).values()]
    .map((list) => ({ model: list[0].r.m, effort: effortOf(list[0].r), calls: list.length, cost: costOf(list), known: list[0].c.known }))
    .sort(largestFirst)

  const kinds = group(calls, (e) => kindOf(e.r))
  const byKind = KIND_NAMES.map((kind) => {
    const list = kinds.get(kind) ?? []
    return { kind, calls: list.length, cost: costOf(list), main: costOf(list.filter((e) => !e.r.agent)), sub: costOf(list.filter((e) => e.r.agent)) }
  }).sort(largestFirst)

  const bySubagent = [...group(calls.filter((e) => e.r.agent), (e) => e.r.at ?? NO_KIND)]
    .map(([kind, list]) => ({
      kind, calls: list.length, cost: costOf(list), reading: costOf(list.filter((e) => kindOf(e.r) === READING)),
      // The models this kind ran on, the one with the most cost first.
      models: [...group(list, (e) => e.r.m)].map(([m, l]) => ({ m, cost: costOf(l), calls: l.length })).sort(largestFirst).map((x) => x.m),
    }))
    .sort(largestFirst)

  const simple = calls.filter((e) => simpleOnStrong(e.r))
  return { total: t.total, calls: calls.length, note: unknownNote(calls), byModelEffort, byKind, bySubagent, simple: { calls: simple.length, cost: costOf(simple) } }
}

/** Spend by model and effort level, by kind of work, and by kind of subagent. */
export function models(records, { days }) {
  const d = modelsData(records)
  if (!d.calls) return `No model calls in the last ${days} days.`
  const share = (x) => pct(x, d.total)
  const out = [
    `Spend by model, effort level and kind of work, last ${days} days. List prices, so an estimate.`,
    'The kind of work of a call comes from the tools it used. The whole cost of the call counts to that kind. Shares are of all cost.',
    '',
    table([['Total', money(d.total), `${count(d.calls)} model calls`]], [1]),
    d.note,
    'By model and effort',
    table([
      ['  model', 'effort', 'calls', 'cost', 'share'],
      ...d.byModelEffort.map((x) => [`  ${model(x.model)}`, x.effort, count(x.calls), x.known ? money(x.cost) : 'no price', x.known ? share(x.cost) : '']),
    ], [2, 3, 4]),
    '',
    'By kind of work',
    table([
      ['', 'cost', 'share', 'in main sessions', 'share', 'in subagents', 'share'],
      ...d.byKind.map((x) => [`  ${x.kind}`, money(x.cost), share(x.cost), money(x.main), share(x.main), money(x.sub), share(x.sub)]),
    ], [1, 2, 3, 4, 5, 6]),
    '',
  ]
  if (d.bySubagent.length) {
    const names = (list) => `${list.slice(0, 3).map(model).join(', ')}${list.length > 3 ? ` and ${list.length - 3} more` : ''}`
    out.push(
      'By kind of subagent',
      table([
        ['', 'calls', 'cost', 'model', 'share of its cost that is reading and searching'],
        ...d.bySubagent.map((x) => [`  ${x.kind}`, count(x.calls), money(x.cost), names(x.models), pct(x.reading, x.cost)]),
      ], [1, 2]),
      '',
    )
  }
  out.push(
    'Simple work on a strong model at high effort',
    `${count(d.simple.calls)} calls read, searched or ran commands at effort high or above, on a model whose output costs more than Claude Sonnet 5.5's: they cost ${money(d.simple.cost)}, ${share(d.simple.cost) || '0%'} of all cost.`,
  )
  return out.join('\n')
}

/** The session whose id starts with `id`, or the one with the latest call. */
function pick(calls, id) {
  const sessions = group(calls, (e) => e.r.ses)
  if (id && id !== 'latest') {
    const key = [...sessions.keys()].find((k) => k.startsWith(id))
    return key ? [key, sessions.get(key)] : undefined
  }
  return [...sessions].sort((a, b) => b[1].at(-1).r.ts - a[1].at(-1).r.ts)[0]
}

export function session(records, { id }) {
  const { calls, blocks } = analyze(records)
  const found = pick(calls, id)
  if (!found) return `No session found${id ? ` that starts with ${id}` : ''}.`
  const [ses, list] = found
  const t = totals(list)
  const main = list.filter((e) => !e.r.agent)
  const last = (main.length ? main : list).at(-1)
  const ctx = main.map((e) => e.ctx).sort((a, b) => a - b)
  const at = (q) => ctx[Math.min(ctx.length - 1, Math.floor(q * ctx.length))] ?? 0
  // The id of a session is the name of its log, or comes from a line of it. This is a plain
  // line and not a table, so the id is printed without control characters.
  const out = [`Session ${plain(ses.slice(0, 8))}  ${project(last.r.cwd)}  (${sourceName[last.r.s] ?? last.r.s})`]
  out.push(`${when(list[0].r.ts)} to ${when(list.at(-1).r.ts)}, ${count(list.length)} model calls, ${new Set(list.filter((e) => e.r.agent).map((e) => e.r.f)).size} subagent runs`)
  out.push(`Cost     ${money(t.total)}`)
  out.push(`Context  half of the calls under ${tok(at(0.5))} tokens, 9 in 10 under ${tok(at(0.9))}, largest ${tok(ctx.at(-1) ?? 0)}, summarized ${main.filter((e) => e.r.ac).length} times`)
  const rt = rates(last.r)
  if (rt) out.push(`Next call  about ${money(last.ctx * rt.read)} to read the context from the cache, ${money(last.ctx * rt.w1)} if the cache is gone`)
  out.push(unknownNote(list), 'What the money paid for', paidFor(t), '')

  const misses = list.filter((e) => e.miss)
  if (misses.length) {
    out.push(`The cache was lost ${misses.length} times. Writing the context again cost ${money(t.waste)}.`)
    out.push(table([...group(misses, (e) => e.miss)].map(([k, l]) => [`  ${k}`, `${l.length} times`, money(sum(l, (e) => e.waste))]), [1, 2]), '')
  }

  const mine = blocks.filter((b) => b.ses === ses)
  const byLabel = [...group(mine, (b) => b.label)]
    .map(([label, l]) => ({ label, n: l.length, tokens: sum(l, (b) => b.tokens), entry: sum(l, (b) => b.entry), carry: sum(l, (b) => b.carry) }))
    .sort((a, b) => b.entry + b.carry - (a.entry + a.carry))
  out.push('What filled the context: the cost when it entered, plus the cost of carrying it on later calls')
  out.push(table([
    ['', 'pieces', 'tokens', 'entering', 'carrying', 'together', ''],
    ...byLabel.slice(0, 14).map((x) => [`  ${x.label}`, count(x.n), tok(x.tokens), money(x.entry), money(x.carry), money(x.entry + x.carry), pct(x.entry + x.carry, t.total)]),
  ], [1, 2, 3, 4, 5, 6]), '')

  const single = mine.filter((b) => !b.label.startsWith('(system') && !b.label.startsWith('(summary')).sort((a, b) => b.entry + b.carry - (a.entry + a.carry)).slice(0, 10)
  out.push('The 10 most expensive single pieces')
  out.push(table(single.map((b) => [`  ${b.label}`, `${tok(b.tokens)} tokens`, `carried ${count(b.carriedCalls)} calls`, money(b.entry + b.carry), when(b.ts)]), [1, 2, 3]))
  return out.join('\n')
}

const branchKey = (e) => `${project(e.r.cwd)} @ ${e.r.br}`

/** Spend per git branch, largest first. The agents write the branch into their session logs. */
export function branches(records, { days, inRepo = () => true }) {
  const { calls } = analyze(records)
  const withBranch = calls.filter((e) => e.r.br && inRepo(e.r.cwd, e.r.br))
  if (!withBranch.length) return `No model calls with a git branch in the last ${days} days.`
  const t = totals(calls)
  const rows = [...group(withBranch, branchKey)]
    .map(([k, l]) => ({ k, t: totals(l), l }))
    .sort((a, b) => b.t.total - a.t.total)
    .slice(0, 20)
    .map((x) => [`  ${x.k}`, money(x.t.total), pct(x.t.total, t.total), `${count(x.l.length)} calls`, `${new Set(x.l.map((e) => e.r.ses)).size} sessions`, `${day(x.l[0].r.ts)} to ${day(x.l.at(-1).r.ts)}`])
  const rest = totals(calls.filter((e) => !(e.r.br && inRepo(e.r.cwd, e.r.br))))
  return [
    `Spend per project folder and git branch, last ${days} days, list prices.`,
    'A call counts to a branch when the log names the branch and the folder of the call is in a repository that has it.', '',
    table(rows, [1, 2, 3, 4]), '',
    `Not on a known branch (a folder outside a repository, a branch that is gone, or no branch): ${money(rest.total)}, ${pct(rest.total, t.total)}.`,
    'One branch in detail: kestrel branch <name>',
  ].join('\n')
}

/**
 * Spend per ticket: tokens, cost at list prices and sessions, most tokens first. A call counts to
 * the ticket in the name of the git branch that its log names ("user/abc-322-x" gives ABC-322).
 * The calls without a ticket get one line at the end.
 */
export function tickets(records, { days }) {
  const { calls } = analyze(records)
  if (!calls.length) return `No model calls in the last ${days} days.`
  const byTicket = group(calls, (e) => ticketOf(e.r.br) ?? '')
  const none = byTicket.get('') ?? []
  byTicket.delete('')
  if (!byTicket.size) return `No model call of the last ${days} days has a ticket: the ticket comes from the git branch name, so a branch named user/abc-322-the-plugin gives ABC-322.`
  const sessions = (list) => {
    const n = new Set(list.map((e) => e.r.ses)).size
    return `${count(n)} ${n === 1 ? 'session' : 'sessions'}`
  }
  const costOf = (list) => {
    const t = totals(list)
    return t.unknown === list.length ? 'no price' : money(t.total)
  }
  const rows = [...byTicket]
    .map(([ticket, list]) => ({ ticket, list, tokens: sum(list, tokensOf) }))
    .sort((a, b) => b.tokens - a.tokens || a.ticket.localeCompare(b.ticket))
    .map((x) => [`  ${x.ticket}`, tok(x.tokens), costOf(x.list), sessions(x.list)])
  const out = [
    `Spend per ticket, last ${days} days, list prices. A call counts to the ticket in the name of the git branch that its log names.`,
    '',
    table([['  ticket', 'tokens', 'cost', 'sessions'], ...rows], [1, 2]),
    '',
  ]
  if (none.length) out.push(`Without a ticket: ${tok(sum(none, tokensOf))} tokens, ${costOf(none)}, ${sessions(none)}.`)
  out.push(unknownNote(calls))
  return out.join('\n').trimEnd()
}

/** One branch: what it cost, what the money paid for, and a line for the pull request. */
export function branch(records, { days, name, inRepo = () => true }) {
  const { calls } = analyze(records)
  const list = calls.filter((e) => e.r.br === name && inRepo(e.r.cwd, name))
  if (!list.length) return `No model calls on the branch "${plain(name)}" in the last ${days} days. See: kestrel branches`
  const t = totals(list)
  const sessions = new Set(list.map((e) => e.r.ses)).size
  const span = `${day(list[0].r.ts)} to ${day(list.at(-1).r.ts)}`
  const out = [`Branch ${plain(name)}, last ${days} days`, `Cost     ${money(t.total)} at list prices, ${count(list.length)} model calls in ${sessions} sessions, ${span}`]
  const folders = [...group(list, (e) => project(e.r.cwd))].map(([k, l]) => `${k} ${money(totals(l).total)}`)
  if (folders.length > 1) out.push(`Folders  ${folders.join(', ')}. A branch with the same name in another repository is counted together with this one.`)
  out.push(unknownNote(list), 'What the money paid for', paidFor(t), '')
  out.push('A line for the pull request:', `Model spend on this branch: ${money(t.total)} at list prices (${count(list.length)} model calls in ${sessions} sessions, ${span}). Measured with Kestrel.`)
  out.push('', 'Not counted: work on this branch from another machine, sessions older than the agents keep their logs, and calls a session made in folders outside this repository.')
  out.push('A session that started on this branch and later worked on something else in the same repository is still counted here.')
  return out.join('\n')
}

/**
 * One line per model call, as its cells. `e` is an analyzed call. "kestrel live" prints the
 * cells without a table, so each cell is given without control characters: the name of a model
 * or of a tool comes from the log.
 */
export function callLine(e) {
  const entered = [...group(e.r.add, (a) => a[0])].map(([label, l]) => [label, sum(l, (a) => a[1])]).sort((a, b) => b[1] - a[1]).slice(0, 3)
  const what = e.miss ? `CACHE LOST (${e.miss}), ${money(e.waste)} to write it again` : e.r.ac ? 'context summarized' : entered.map(([l]) => l).join(', ')
  return [
    clock(e.r.ts), `${model(e.r.m)}${e.r.agent ? ' (subagent)' : ''}`, tok(e.ctx), `+${tok(e.newTokens)}`,
    e.ctx ? `${Math.round((100 * e.r.cr) / e.ctx)}%` : '', tok(e.r.out), e.c.known ? money(e.c.total) : 'no price', what,
  ].map(plain)
}
export const CALL_HEAD = ['time', 'model', 'context', 'new', 'cached', 'output', 'cost', 'what entered']
export const CALL_RIGHT = [2, 3, 4, 5, 6]

export function callsReport(records, { id, n }) {
  const { calls } = analyze(records)
  const found = pick(calls, id)
  if (!found) return 'No session found.'
  return table([CALL_HEAD, ...found[1].slice(-n).map(callLine)], CALL_RIGHT)
}

export function findings(records, { days }) {
  const { calls, blocks } = analyze(records)
  const t = totals(calls)
  if (!t.total) return `No priced model calls in the last ${days} days.`
  const out = [`Where the money went and what can be done, last ${days} days. Total spend ${money(t.total)} at list prices.`, 'The amounts overlap, so they do not add up. Not all of an amount can be saved.', '']
  const found = []

  const misses = calls.filter((e) => e.miss)
  if (t.waste > 0) {
    const causes = [...group(misses, (e) => e.miss)].map(([k, l]) => `${k}: ${l.length} times, ${money(sum(l, (e) => e.waste))}`).join('; ')
    const worst = misses.sort((a, b) => b.waste - a.waste).slice(0, 3).map((e) => `${when(e.r.ts)} ${project(e.r.cwd)} ${money(e.waste)} (${tok(e.ctx)} tokens)`).join('; ')
    const sub = misses.filter((e) => e.r.agent)
    const cheaper = misses.filter((e) => e.keepAlive != null && e.keepAlive < e.waste)
    const lines = []
    if (sub.length) lines.push(`${count(sub.length)} of them were in subagents, ${money(sum(sub, (e) => e.waste))}. A subagent's cache lasts 5 minutes, so a command or a wait that runs longer loses it.`)
    if (cheaper.length) lines.push(`Keeping the cache alive through ${count(cheaper.length)} of the gaps (one read of the context every 4 minutes, for gaps up to 2 hours) would have cost about ${money(sum(cheaper, (e) => e.keepAlive))} instead of ${money(sum(cheaper, (e) => e.waste))}.`)
    found.push([t.waste, `The cache was lost ${misses.length} times`, [
      `Causes. ${causes}.`,
      `Largest. ${worst}.`,
      ...lines,
      'A provider keeps your context in its cache for a short time (5 minutes or 1 hour). After a longer gap it is gone, and the whole context is written again at the high price.',
      'A gap is a break of yours, or a command that runs longer than the cache lasts, such as a long test run or a wait for CI.',
      'Before a long break, summarize the context (/compact) or finish the task. After a break, start a new session if the old context is not needed.',
    ]])
  }

  const CAP = 200_000
  const above = sum(calls, (e) => (e.carried > CAP ? (e.carriedCost * (e.carried - CAP)) / e.carried : 0))
  if (above > 0) {
    found.push([above, `Carrying context above ${tok(CAP)} tokens`, [
      `${count(calls.filter((e) => e.carried > CAP).length)} calls carried more than ${tok(CAP)} tokens. The part above that cost ${money(above)}.`,
      'Every call pays again for everything in the context. Summarize earlier, or use one session per task.',
    ]])
  }

  const tools = [...group(blocks.filter((b) => !b.label.startsWith('(')), (b) => b.label)]
    .map(([label, l]) => ({ label, n: l.length, cost: sum(l, (b) => b.entry + b.carry), tokens: sum(l, (b) => b.tokens), max: l.reduce((n, b) => Math.max(n, b.tokens), 0) }))
    .sort((a, b) => b.cost - a.cost)
  if (tools.length) {
    const top = tools.slice(0, 5)
    found.push([sum(top, (x) => x.cost), 'Tool results in the context', [
      ...top.map((x) => `${plain(x.label)}: ${count(x.n)} results, ${tok(x.tokens)} tokens, ${money(x.cost)} with carrying. Largest single result ${tok(x.max)} tokens.`),
      'A large result is paid for on every later call. Read parts of files, filter command output, and give large reads to a subagent that returns a summary.',
    ]])
  }

  const repeats = repeatedToolCalls(calls)
  if (repeats.length) {
    repeats.sort((a, b) => b.n - a.n)
    found.push([0, 'The same tool call, with the same input, many times', [
      ...repeats.slice(0, 5).map((x) => `${plain(x.tool)} ran ${x.n} times with the same input in session ${plain(x.ses.slice(0, 8))} (${project(x.cwd)}).`),
      'This can be a loop, or a check that is repeated on purpose. The cost is not estimated here.',
    ]])
  }

  const sub = calls.filter((e) => e.r.agent)
  if (sub.length) {
    const st = totals(sub)
    found.push([0, 'Subagents', [`Subagents made ${count(sub.length)} of ${count(calls.length)} calls and cost ${money(st.total)}, ${pct(st.total, t.total)} of the total. This is a figure to know, not waste by itself.`]])
  }

  found.sort((a, b) => b[0] - a[0])
  found.forEach(([amount, title, lines], i) => {
    out.push(`${i + 1}. ${title}${amount > 0 ? `: ${money(amount)}, ${pct(amount, t.total)} of the total` : ''}`)
    for (const l of lines) out.push(`   ${l}`)
    out.push('')
  })
  return out.join('\n')
}

// A compaction came in the middle of work when its session made a model call this short before it.
const MIDDLE_OF_WORK = 5 * 60e3
// Claude Code compacts an idle session on its own shortly before its 1 hour cache ends. In the log
// such a compaction comes about an hour after the last model call of its own conversation.
const IDLE_RULE_FROM = 50 * 60e3
const IDLE_RULE_TO = 70 * 60e3
// The report names this many sessions, the ones with the most compactions.
const MOST_COMPACTED = 5

/**
 * The compactions of a period: how many there were, how large the context was before and after,
 * how many of the automatic ones came in the middle of work, and the sessions that had the most.
 * `records` are the model calls and `metas` what `load()` gives next to them. `since` is the
 * start of the period in milliseconds. A log holds older compactions too, so they are left out
 * here. The calls may start earlier than the period: a call shortly before `since` says whether
 * a compaction right after it came in the middle of work.
 */
export function compactions(records, metas, { days, since }) {
  const all = compactionsOf(metas).filter((c) => c.ts >= since)
  if (!all.length) return `No compaction in the last ${days} days.`
  const auto = all.filter((c) => c.trigger === 'auto')
  const byHand = all.filter((c) => c.trigger === 'manual')
  // The median of some numbers of tokens, and the smallest and the largest of them.
  const sizes = (list) => `${tok(median(list))} (${tok(Math.min(...list))} to ${tok(Math.max(...list))})`
  const row = (name, list) => (list.length ? [
    name, count(list.length), sizes(list.map((c) => c.pre)), sizes(list.map((c) => c.post)),
    `${Math.round(median(list.map((c) => (100 * (c.pre - c.post)) / c.pre)))}%`, `${Math.round(median(list.map((c) => c.sec)))} seconds`,
  ] : [name, '0'])
  const out = [
    `Compactions, last ${days} days. A compaction replaces a long conversation with a summary.`,
    'Tokens before and after: the median, then the smallest to the largest. Smaller by, and took: the median.',
    '',
    table([['', 'how many', 'tokens before', 'tokens after', 'smaller by', 'took'], row('All', all), row('Automatic', auto), row('By hand', byHand)], [1]),
    '',
  ]

  // The times of the model calls of each session, to see what came shortly before a compaction.
  const callTimes = group(records, (r) => r.ses)
  const atWork = (c) => (callTimes.get(c.ses) ?? []).some((r) => r.ts < c.ts && c.ts - r.ts <= MIDDLE_OF_WORK)
  out.push(auto.length
    ? `Of the automatic compactions, ${count(auto.filter(atWork).length)} of ${count(auto.length)} came in the middle of work (the session had made a model call in the 5 minutes before).`
    : 'No compaction was automatic.')
  // The time from the last model call in the compaction's own log to the compaction. A subagent has
  // a log of its own, so its calls do not count for the main conversation, and the other way round.
  const ownCalls = group(records, (r) => r.f)
  const sinceOwnCall = (c) => {
    let last = 0
    for (const r of ownCalls.get(c.f) ?? []) if (r.ts < c.ts && r.ts > last) last = r.ts
    return last ? c.ts - last : null
  }
  const idle = auto.filter((c) => {
    const gap = sinceOwnCall(c)
    return gap !== null && gap >= IDLE_RULE_FROM && gap <= IDLE_RULE_TO
  })
  if (idle.length) out.push(`${count(idle.length)} of ${count(auto.length)} came 50 to 70 minutes after the last model call of their own conversation. That is how Claude Code's idle rule looks: it compacts an idle session of about 200,000 tokens or more shortly before its 1 hour cache ends.`)
  out.push('')

  const sessions = [...group(all, (c) => c.ses).values()]
    .map((list) => ({ cwd: list[0].cwd, n: list.length, largest: Math.max(...list.map((c) => c.pre)) }))
    .sort((a, b) => b.n - a.n || b.largest - a.largest)
  out.push('The sessions with the most compactions')
  out.push(table(sessions.slice(0, MOST_COMPACTED).map((x) => [`  ${project(x.cwd)}`, `${count(x.n)} ${x.n === 1 ? 'compaction' : 'compactions'}`, `largest before: ${tok(x.largest)}`])), '')
  out.push('There is no percent to aim for. The size after is about the same each time, so the percent only says how large the context was allowed to get.')
  return out.join('\n')
}
