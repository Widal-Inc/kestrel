import { inRange, monthKey } from './dates.mjs'
import { formatCents, toCents } from './money.mjs'

/** The report of expenses as data, for the flag --json. */
export function reportData(rows, { by = 'category', from, to } = {}) {
  if (by !== 'category' && by !== 'month') throw new RangeError(`cannot group by "${by}"`)
  const groups = new Map()
  for (const row of rows) {
    if (!inRange(row.date, from, to)) continue
    const key = by === 'month' ? monthKey(row.date) : row.category
    if (!groups.has(key)) groups.set(key, { key, count: 0, total_cents: 0 })
    const group = groups.get(key)
    group.count += 1
    group.total_cents += toCents(row.amount)
  }
  const list = [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : 1))
  return { by, from: from ?? null, to: to ?? null, rows: list, count: list.reduce((n, g) => n + g.count, 0), total_cents: list.reduce((n, g) => n + g.total_cents, 0) }
}

/**
 * The report of expenses as text: one line per category or per month, then the total.
 * `rows` are the rows of the CSV file: { date, category, amount, note }.
 */
export function buildReport(rows, { by = 'category', from, to } = {}) {
  if (by !== 'category' && by !== 'month') throw new RangeError(`cannot group by "${by}"`)
  const groups = new Map()
  let count = 0
  let total = 0
  for (const row of rows) {
    if (!inRange(row.date, from, to)) continue
    const key = by === 'month' ? monthKey(row.date) : row.category
    const cents = toCents(row.amount)
    if (!groups.has(key)) groups.set(key, { count: 0, totalCents: 0 })
    const group = groups.get(key)
    group.count += 1
    group.totalCents += cents
    count += 1
    total += cents
  }
  const keys = [...groups.keys()].sort()
  const width = Math.max(5, ...keys.map((key) => key.length))
  const lines = [`${'key'.padEnd(width)}  count  total`]
  for (const key of keys) {
    const group = groups.get(key)
    lines.push(`${key.padEnd(width)}  ${String(group.count).padStart(5)}  ${formatCents(group.totalCents)}`)
  }
  lines.push(`${'total'.padEnd(width)}  ${String(count).padStart(5)}  ${formatCents(total)}`)
  return lines.join('\n')
}
