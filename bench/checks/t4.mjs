// Hidden checks of task t4: "ledger report --json".
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Days in the middle of a month, so that the time zone of the computer does not matter here.
const CSV = ['date,category,amount,note', '2026-01-12,food,12.50,lunch', '2026-01-18,travel,40.00,train', '2026-02-10,food,7.25,coffee', '2026-02-14,office,3.10,pens', '2026-03-15,food,1.05,tea', ''].join('\n')
const file = join(mkdtempSync(join(tmpdir(), 'bench-t4-')), 'expenses.csv')
writeFileSync(file, CSV)

const json = (cli, args) => {
  const r = cli(['report', file, ...args])
  if (r.status !== 0) throw new Error(`exit code ${r.status}: ${r.stderr.trim().slice(0, 120)}`)
  return JSON.parse(r.stdout)
}
const BY_CATEGORY = [{ key: 'food', count: 3, total_cents: 2080 }, { key: 'office', count: 1, total_cents: 310 }, { key: 'travel', count: 1, total_cents: 4000 }]
const BY_MONTH = [{ key: '2026-01', count: 2, total_cents: 5250 }, { key: '2026-02', count: 2, total_cents: 1035 }, { key: '2026-03', count: 1, total_cents: 105 }]

export default [
  ['--json prints one JSON object with the named fields', ({ cli, assert }) => {
    const data = json(cli, ['--json'])
    assert.deepEqual(Object.keys(data).sort(), ['by', 'count', 'from', 'rows', 'to', 'total_cents'])
    assert.equal(data.by, 'category')
    assert.equal(data.from, null)
    assert.equal(data.to, null)
  }],
  ['the rows per category are sorted and summed in cents', ({ cli, assert }) => {
    const data = json(cli, ['--json'])
    assert.deepEqual(data.rows, BY_CATEGORY)
    assert.equal(data.count, 5)
    assert.equal(data.total_cents, 6390)
  }],
  ['--by month works with --json', ({ cli, assert }) => {
    const data = json(cli, ['--by', 'month', '--json'])
    assert.equal(data.by, 'month')
    assert.deepEqual(data.rows, BY_MONTH)
  }],
  ['the flags work in any order after the file', ({ cli, assert }) => {
    assert.deepEqual(json(cli, ['--json', '--by', 'month']), json(cli, ['--by', 'month', '--json']))
    assert.deepEqual(json(cli, ['--from', '2026-02-01', '--json', '--by', 'month']).rows, BY_MONTH.slice(1))
  }],
  ['--from and --to are in the object, and the rows are those of the range', ({ cli, assert }) => {
    const data = json(cli, ['--json', '--from', '2026-01-15', '--to', '2026-03-01'])
    assert.equal(data.from, '2026-01-15')
    assert.equal(data.to, '2026-03-01')
    assert.deepEqual(data.rows, [{ key: 'food', count: 1, total_cents: 725 }, { key: 'office', count: 1, total_cents: 310 }, { key: 'travel', count: 1, total_cents: 4000 }])
    assert.equal(data.count, 3)
    assert.equal(data.total_cents, 5035)
  }],
  ['a report without rows has an empty list', ({ cli, assert }) => {
    const data = json(cli, ['--json', '--from', '2030-01-01'])
    assert.deepEqual(data.rows, [])
    assert.equal(data.count, 0)
    assert.equal(data.total_cents, 0)
  }],
  ['a value of --by that is not known ends with exit code 2 and nothing on stdout', ({ cli, assert }) => {
    const r = cli(['report', file, '--by', 'week', '--json'])
    assert.equal(r.status, 2)
    assert.equal(r.stdout.trim(), '')
    assert.notEqual(r.stderr.trim(), '')
  }],
  ['without --json the output is the same as before', ({ cli, assert, start }) => {
    for (const args of [[], ['--by', 'month'], ['--from', '2026-01-15', '--to', '2026-03-01'], ['--by', 'month', '--from', '2030-01-01']]) {
      const now = cli(['report', file, ...args])
      const before = cli(['report', file, ...args], { from: start })
      assert.equal(now.status, 0)
      assert.equal(now.stdout, before.stdout)
    }
  }],
]
