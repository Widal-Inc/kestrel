// Hidden checks of task h3: every command is fast on a file of 200,000 rows, and nothing else changes.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The time a command may take on the large file, in milliseconds. The fixed commands need well under a second. */
const LIMIT = 5000
const ROWS = 200_000
const CATEGORIES = ['food', 'travel', 'office', 'software', 'rent', 'phone', 'health', 'gifts']

// The large file, made the same way every time. The days are in the middle of a month, so that
// the time zone of the computer does not matter here.
let seed = 11
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const lines = ['date,category,amount,note']
const byCategory = new Map()
const byMonth = new Map()
const add = (map, key, cents) => {
  const g = map.get(key) ?? { count: 0, cents: 0 }
  g.count += 1
  g.cents += cents
  map.set(key, g)
}
for (let i = 0; i < ROWS; i++) {
  const month = String(1 + Math.floor(random() * 12)).padStart(2, '0')
  const day = String(10 + Math.floor(random() * 10))
  const category = CATEGORIES[Math.floor(random() * CATEGORIES.length)]
  const cents = 100 + Math.floor(random() * 50000)
  lines.push(`2026-${month}-${day},${category},${(cents / 100).toFixed(2)},row ${i}`)
  add(byCategory, category, cents)
  add(byMonth, `2026-${month}`, cents)
}
const dir = mkdtempSync(join(tmpdir(), 'bench-h3-'))
const big = join(dir, 'big.csv')
writeFileSync(big, `${lines.join('\n')}\n`)
const small = join(dir, 'small.csv')
writeFileSync(small, ['date,category,amount,note', '2026-01-12,food,12.50,lunch', ' 2026-01-18 , travel ,40.00, train ', '', '2026-02-10,food,7.25', '2026-02-14,office,3.10,pens,extra', ''].join('\n'))

/** The text of a report, as the project prints it. */
function expected(map) {
  const money = (cents) => `$${(cents / 100).toFixed(2)}`
  const keys = [...map.keys()].sort()
  const width = Math.max(5, ...keys.map((key) => key.length))
  const out = [`${'key'.padEnd(width)}  count  total`]
  for (const key of keys) out.push(`${key.padEnd(width)}  ${String(map.get(key).count).padStart(5)}  ${money(map.get(key).cents)}`)
  out.push(`${'total'.padEnd(width)}  ${String(ROWS).padStart(5)}  ${money([...map.values()].reduce((n, g) => n + g.cents, 0))}`)
  return out.join('\n')
}

/** Runs a command on the large file, and fails when it takes longer than the limit. */
function fast(cli, assert, args) {
  const r = cli(args, { timeout: LIMIT })
  assert.ok(r.status !== null && r.ms < LIMIT, `the command took longer than ${LIMIT / 1000} seconds: ledger ${args.map((a) => (a === big ? '<file of 200,000 rows>' : a)).join(' ')}`)
  assert.equal(r.status, 0)
  return r.stdout.trimEnd()
}

export default [
  ['"report" by category is fast on 200,000 rows, and right', ({ cli, assert }) => {
    assert.equal(fast(cli, assert, ['report', big]), expected(byCategory))
  }],
  ['"report --by month" is fast on 200,000 rows, and right', ({ cli, assert }) => {
    assert.equal(fast(cli, assert, ['report', big, '--by', 'month']), expected(byMonth))
  }],
  ['"list" is fast on 200,000 rows', ({ cli, assert }) => {
    const out = fast(cli, assert, ['list', big, '--page', '3', '--size', '5']).split('\n')
    assert.match(out.at(-1), /^page 3 of \d+, 200000 rows$/)
    assert.ok(out[0].endsWith('row 10'))
  }],
  ['"check" is fast on 200,000 rows', ({ cli, assert }) => {
    assert.equal(fast(cli, assert, ['check', big]), 'all 200000 rows are complete')
  }],
  ['the output of every command is the same as before on a small file', ({ cli, assert, start }) => {
    for (const args of [['report', small], ['report', small, '--by', 'month'], ['report', small, '--from', '2026-01-15', '--to', '2026-02-12'], ['report', small, '--from', '2030-01-01'], ['list', small], ['list', small, '--page', '2', '--size', '2'], ['check', small], ['help'], ['report', small, '--by', 'week']]) {
      const now = cli(args)
      const before = cli(args, { from: start })
      assert.equal(now.status, before.status, `the exit code of: ledger ${args.join(' ')}`)
      assert.equal(now.stdout, before.stdout, `the output of: ledger ${args.join(' ')}`)
    }
  }],
  ['parseCsv returns the same rows as before', async ({ load, loadStart, assert }) => {
    const { parseCsv } = await load('src/csv.mjs')
    const before = await loadStart('src/csv.mjs')
    for (const text of ['', 'a,b\n', 'a,b\n1,2\n3,4\n', ' a , b \n 1 , 2 \n\n3\n4,5,6\n', 'a,b\r\n1,2\r\n', 'date,category,amount,note\n2026-01-12,food,12.50,lunch']) {
      assert.deepEqual(parseCsv(text), before.parseCsv(text))
    }
    assert.ok(Array.isArray(parseCsv('a\n1\n')))
  }],
  ['buildReport returns the same text as before, also for a row that is passed twice', async ({ load, loadStart, assert }) => {
    const { buildReport } = await load('src/report.mjs')
    const before = await loadStart('src/report.mjs')
    const a = { date: '2026-01-12', category: 'food', amount: '12.50', note: 'lunch' }
    const b = { date: '2026-02-10', category: 'travel', amount: '40.00', note: 'train' }
    const same = { ...a }
    for (const rows of [[a, b], [a, a, b, a], [a, same, b], [b, a, b], []]) {
      for (const options of [undefined, { by: 'month' }, { from: '2026-02-01' }]) assert.equal(buildReport(rows, options), before.buildReport(rows, options))
    }
    assert.throws(() => buildReport([a], { by: 'week' }), RangeError)
  }],
  ['buildReport does not change the rows or the list it is given', async ({ load, assert }) => {
    const { buildReport } = await load('src/report.mjs')
    const a = { date: '2026-01-12', category: 'food', amount: '12.50', note: 'lunch' }
    const rows = [a, a, { ...a }]
    const copy = JSON.stringify(rows)
    buildReport(rows)
    assert.equal(JSON.stringify(rows), copy)
    assert.equal(rows.length, 3)
    assert.deepEqual(Object.keys(a), ['date', 'category', 'amount', 'note'])
  }],
]
