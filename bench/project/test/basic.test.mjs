import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCsv } from '../src/csv.mjs'
import { inRange, monthKey } from '../src/dates.mjs'
import { formatCents, sumCents, toCents } from '../src/money.mjs'
import { paginate } from '../src/paginate.mjs'
import { buildReport } from '../src/report.mjs'

const ROWS = [
  { date: '2026-01-15', category: 'food', amount: '12.50', note: 'lunch' },
  { date: '2026-01-20', category: 'travel', amount: '40.00', note: 'train' },
  { date: '2026-02-10', category: 'food', amount: '7.25', note: 'coffee' },
]

test('a CSV text becomes rows keyed by the header', () => {
  assert.deepEqual(parseCsv('date,category,amount,note\n2026-01-15,food,12.50,lunch\n'), [ROWS[0]])
})

test('amounts are read and printed in cents', () => {
  assert.equal(toCents('12.34'), 1234)
  assert.equal(formatCents(1234), '$12.34')
  assert.equal(sumCents([100, 250]), 350)
})

test('the month of a date in the middle of a month', () => {
  assert.equal(monthKey('2026-03-15'), '2026-03')
  assert.equal(inRange('2026-03-15', '2026-03-10', '2026-03-20'), true)
  assert.equal(inRange('2026-04-15', '2026-03-10', '2026-03-20'), false)
})

test('a page says how many items there are', () => {
  const page = paginate([1, 2, 3, 4, 5], 1, 2)
  assert.equal(page.total, 5)
  assert.equal(page.page, 1)
})

test('the report groups by category and by month', () => {
  assert.equal(buildReport(ROWS), ['key     count  total', 'food        2  $19.75', 'travel      1  $40.00', 'total       3  $59.75'].join('\n'))
  assert.equal(buildReport(ROWS, { by: 'month' }), ['key      count  total', '2026-01      2  $52.50', '2026-02      1  $7.25', 'total        3  $59.75'].join('\n'))
  assert.throws(() => buildReport(ROWS, { by: 'week' }), RangeError)
})
