// Hidden checks of task t7: buildReport split into groupRows and formatTable.

// Days in the middle of a month, so that the time zone of the computer does not matter here.
const ROWS = [
  { date: '2026-02-10', category: 'travel', amount: '40.00', note: 'train' },
  { date: '2026-01-15', category: 'food', amount: '12.50', note: 'lunch' },
  { date: '2026-02-12', category: 'food', amount: '7.25', note: 'coffee' },
  { date: '2026-03-20', category: 'subscriptions', amount: '9.99', note: 'news' },
]

export default [
  ['groupRows and formatTable are exported', async ({ load, assert }) => {
    const report = await load('src/report.mjs')
    assert.equal(typeof report.groupRows, 'function')
    assert.equal(typeof report.formatTable, 'function')
    assert.equal(typeof report.buildReport, 'function')
  }],
  ['groupRows by category gives a Map in the order in which the keys first appear', async ({ load, assert }) => {
    const { groupRows } = await load('src/report.mjs')
    const groups = groupRows(ROWS, 'category')
    assert.ok(groups instanceof Map)
    assert.deepEqual([...groups], [['travel', { count: 1, totalCents: 4000 }], ['food', { count: 2, totalCents: 1975 }], ['subscriptions', { count: 1, totalCents: 999 }]])
  }],
  ['groupRows by month', async ({ load, assert }) => {
    const { groupRows } = await load('src/report.mjs')
    assert.deepEqual([...groupRows(ROWS, 'month')], [['2026-02', { count: 2, totalCents: 4725 }], ['2026-01', { count: 1, totalCents: 1250 }], ['2026-03', { count: 1, totalCents: 999 }]])
  }],
  ['groupRows refuses another value of "by", and gives an empty Map for no rows', async ({ load, assert }) => {
    const { groupRows } = await load('src/report.mjs')
    assert.throws(() => groupRows(ROWS, 'week'), RangeError)
    assert.equal(groupRows([], 'category').size, 0)
  }],
  ['formatTable prints the head line, the keys sorted, and the total line', async ({ load, assert }) => {
    const { formatTable } = await load('src/report.mjs')
    const groups = new Map([['travel', { count: 1, totalCents: 4000 }], ['food', { count: 2, totalCents: 1975 }], ['subscriptions', { count: 1, totalCents: 999 }]])
    assert.equal(formatTable(groups), ['key            count  total', 'food               2  $19.75', 'subscriptions      1  $9.99', 'travel             1  $40.00', 'total              4  $69.74'].join('\n'))
  }],
  ['formatTable of an empty Map prints the head line and a total of nothing', async ({ load, loadStart, assert }) => {
    const { formatTable } = await load('src/report.mjs')
    const before = await loadStart('src/report.mjs')
    assert.equal(formatTable(new Map()), before.buildReport([]))
  }],
  ['buildReport returns the same text as before', async ({ load, loadStart, assert }) => {
    const { buildReport } = await load('src/report.mjs')
    const before = await loadStart('src/report.mjs')
    for (const options of [undefined, {}, { by: 'month' }, { by: 'category', from: '2026-02-01' }, { by: 'month', from: '2026-01-20', to: '2026-03-01' }, { from: '2030-01-01' }]) {
      assert.equal(buildReport(ROWS, options), before.buildReport(ROWS, options))
    }
    assert.equal(buildReport([]), before.buildReport([]))
    assert.throws(() => buildReport(ROWS, { by: 'week' }), RangeError)
  }],
  ['buildReport uses the two new functions', ({ read, assert }) => {
    const source = read('src/report.mjs')
    assert.ok((source.match(/\bgroupRows\s*\(/g) ?? []).length >= 2, 'groupRows is defined but not called')
    assert.ok((source.match(/\bformatTable\s*\(/g) ?? []).length >= 2, 'formatTable is defined but not called')
  }],
]
