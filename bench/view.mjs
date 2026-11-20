// What Widal.Code sees of the sessions in its Claude Code folder, as JSON: per session the cost,
// the calls, the ticket, the models and the efforts, and the tool's own signs for all of them.
//
// bench/collect.mjs starts this file in a process whose HOME, WIDAL_HOME and CLAUDE_CONFIG_DIR
// point at a folder of the benchmark run. It reads the logs with Widal.Code's own code and prints
// numbers and names only, never the text of a session.
import { analyze, measures } from '../src/analyze.mjs'
import { load } from '../src/store.mjs'
import { ticketOf } from '../src/ticket.mjs'

if (!process.env.WIDAL_HOME || !process.env.CLAUDE_CONFIG_DIR) throw new Error('bench/view.mjs runs only with WIDAL_HOME and CLAUDE_CONFIG_DIR set: start it through bench/collect.mjs')

const { records } = await load({ since: 0, sources: ['claude'] })
const { calls } = analyze(records)
const sum = (list, f) => list.reduce((n, x) => n + f(x), 0)
const bySession = new Map()
for (const e of calls) {
  if (!bySession.has(e.r.ses)) bySession.set(e.r.ses, [])
  bySession.get(e.r.ses).push(e)
}
const sessions = [...bySession].map(([id, list]) => {
  const main = list.filter((e) => !e.r.agent)
  const sub = list.filter((e) => e.r.agent)
  const models = {}
  for (const e of list) models[e.r.m] = (models[e.r.m] ?? 0) + e.c.total
  return {
    id,
    cost: sum(list, (e) => e.c.total),
    unpriced: list.filter((e) => !e.c.known).length,
    calls: list.length,
    tickets: [...new Set(list.map((e) => ticketOf(e.r.br) ?? ''))],
    mainCost: sum(main, (e) => e.c.total),
    subagentCost: sum(sub, (e) => e.c.total),
    subagentCalls: sub.length,
    subagentModels: [...new Set(sub.map((e) => e.r.m))],
    models,
    efforts: [...new Set(main.map((e) => e.r.ef ?? ''))],
    toolErrors: sum(list, (e) => e.r.err ?? 0),
  }
})
console.log(JSON.stringify({ sessions, signs: measures(calls) }))
