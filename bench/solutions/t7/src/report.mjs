import { inRange, monthKey } from './dates.mjs'
import { formatCents, toCents } from './money.mjs'

/** The rows grouped by category or by month: a Map from the key to { count, totalCents }. */
export function groupRows(rows, by) {
  if (by !== 'category' && by !== 'month') throw new RangeError(`cannot group by "${by}"`)
  const groups = new Map()
  for (const row of rows) {
    const key = by === 'month' ? monthKey(row.date) : row.category
    if (!groups.has(key)) groups.set(key, { count: 0, totalCents: 0 })
    const group = groups.get(key)
    group.count += 1
    group.totalCents += toCents(row.amount)
  }
  return groups
}

/** The text of the report for such a Map: the head line, one line per key, and the total line. */
export function formatTable(groups) {
  const keys = [...groups.keys()].sort()
  const width = Math.max(5, ...keys.map((key) => key.length))
  const line = (key, count, cents) => `${key.padEnd(width)}  ${String(count).padStart(5)}  ${formatCents(cents)}`
  const lines = [`${'key'.padEnd(width)}  count  total`]
  let count = 0
  let total = 0
  for (const key of keys) {
    const group = groups.get(key)
    lines.push(line(key, group.count, group.totalCents))
    count += group.count
    total += group.totalCents
  }
  lines.push(line('total', count, total))
  return lines.join('\n')
}

/**
 * The report of expenses as text: one line per category or per month, then the total.
 * `rows` are the rows of the CSV file: { date, category, amount, note }.
 */
export function buildReport(rows, { by = 'category', from, to } = {}) {
  return formatTable(groupRows(rows.filter((row) => inRange(row.date, from, to)), by))
}
