// Hidden checks of task t6: the month of a date and the range of dates, in any time zone.
const WEST = 'America/Los_Angeles'
const EAST = 'Asia/Tokyo'
const FAR_EAST = 'Pacific/Kiritimati'

const monthIn = (inZone, tz, date) => inZone(tz, `import { monthKey } from './src/dates.mjs'; console.log(monthKey('${date}'))`)
const rangeIn = (inZone, tz, date, from, to) =>
  inZone(tz, `import { inRange } from './src/dates.mjs'; console.log(inRange('${date}', ${from ? `'${from}'` : 'undefined'}, ${to ? `'${to}'` : 'undefined'}))`)

/** The lines of a report as { key, count }, without the head line. */
const rows = (text) => text.trim().split('\n').slice(1).map((line) => line.trim().split(/\s+/)).map(([key, count]) => ({ key, count: Number(count) }))

export default [
  ['the first day of a month is in that month, west of Greenwich', ({ inZone, assert }) => {
    assert.equal(monthIn(inZone, WEST, '2026-01-01'), '2026-01')
    assert.equal(monthIn(inZone, WEST, '2026-03-01'), '2026-03')
  }],
  ['the last day of a month is in that month, east of Greenwich', ({ inZone, assert }) => {
    assert.equal(monthIn(inZone, EAST, '2026-01-31'), '2026-01')
    assert.equal(monthIn(inZone, FAR_EAST, '2026-12-31'), '2026-12')
    assert.equal(monthIn(inZone, FAR_EAST, '2026-01-01'), '2026-01')
  }],
  ['the report by month has no month of 2025, west of Greenwich', ({ cli, assert }) => {
    const r = cli(['report', 'data/sample.csv', '--by', 'month'], { tz: WEST })
    assert.equal(r.status, 0)
    assert.deepEqual(rows(r.stdout), [
      { key: '2026-01', count: 7 }, { key: '2026-02', count: 6 }, { key: '2026-03', count: 7 },
      { key: '2026-04', count: 6 }, { key: '2026-05', count: 7 }, { key: '2026-06', count: 6 }, { key: 'total', count: 39 },
    ])
  }],
  ['the last day of a range is inside it', ({ inZone, assert }) => {
    for (const tz of [WEST, EAST, 'UTC']) assert.equal(rangeIn(inZone, tz, '2026-01-31', '2026-01-01', '2026-01-31'), 'true')
  }],
  ['the first day of a range is inside it, and the days around the range are not', ({ inZone, assert }) => {
    for (const tz of [WEST, EAST]) {
      assert.equal(rangeIn(inZone, tz, '2026-01-01', '2026-01-01', '2026-01-31'), 'true')
      assert.equal(rangeIn(inZone, tz, '2026-02-01', '2026-01-01', '2026-01-31'), 'false')
      assert.equal(rangeIn(inZone, tz, '2025-12-31', '2026-01-01', '2026-01-31'), 'false')
    }
  }],
  ['a range with an open end works', ({ inZone, assert }) => {
    assert.equal(rangeIn(inZone, WEST, '2026-01-15'), 'true')
    assert.equal(rangeIn(inZone, WEST, '2026-01-15', '2026-01-15'), 'true')
    assert.equal(rangeIn(inZone, WEST, '2026-01-14', '2026-01-15'), 'false')
    assert.equal(rangeIn(inZone, WEST, '2026-01-15', undefined, '2026-01-15'), 'true')
    assert.equal(rangeIn(inZone, WEST, '2026-01-16', undefined, '2026-01-15'), 'false')
  }],
  ['the report of January has all seven expenses, also those of the 31st', ({ cli, assert }) => {
    for (const tz of [WEST, EAST]) {
      const r = cli(['report', 'data/sample.csv', '--from', '2026-01-01', '--to', '2026-01-31'], { tz })
      assert.equal(r.status, 0)
      assert.equal(rows(r.stdout).at(-1).count, 7)
    }
  }],
  ['the reports are the same in every time zone', ({ cli, assert }) => {
    for (const args of [['--by', 'month'], ['--by', 'month', '--from', '2026-02-01', '--to', '2026-04-30'], ['--from', '2026-03-31', '--to', '2026-05-01']]) {
      const west = cli(['report', 'data/sample.csv', ...args], { tz: WEST })
      for (const tz of [EAST, FAR_EAST, 'UTC']) assert.equal(cli(['report', 'data/sample.csv', ...args], { tz }).stdout, west.stdout)
    }
  }],
  ['the data file is not changed', ({ read, readStart, assert }) => {
    assert.equal(read('data/sample.csv'), readStart('data/sample.csv'))
  }],
]
