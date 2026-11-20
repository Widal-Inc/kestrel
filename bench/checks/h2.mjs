// Hidden checks of task h2: the ISO 8601 week of a date, and "report --by week".
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WEST = 'America/Los_Angeles'
const EAST = 'Asia/Tokyo'
const FAR_EAST = 'Pacific/Kiritimati'

/** The weeks of several dates, worked out in a process in one time zone. */
const weeksIn = (inZone, tz, dates) => JSON.parse(inZone(tz, `import { weekKey } from './src/dates.mjs'; console.log(JSON.stringify(${JSON.stringify(dates)}.map((d) => weekKey(d))))`))

/** A check that the dates have these weeks, in each of the time zones. */
const weeks = (pairs, zones = ['UTC']) => ({ inZone, assert }) => {
  for (const tz of zones) assert.deepEqual(weeksIn(inZone, tz, pairs.map(([date]) => date)), pairs.map(([, week]) => week), `the weeks in the time zone ${tz}`)
}

const YEAR_ENDS = [
  ['2026-01-01', '2026-W01'], ['2025-12-29', '2026-W01'], ['2025-12-28', '2025-W52'], ['2027-01-01', '2026-W53'], ['2027-01-03', '2026-W53'], ['2027-01-04', '2027-W01'],
  ['2024-12-30', '2025-W01'], ['2024-12-29', '2024-W52'], ['2021-01-03', '2020-W53'], ['2020-12-31', '2020-W53'], ['2021-01-04', '2021-W01'],
]

// The week does not depend on the range bug of the start: no row is on an end of a range below.
const CSV = ['date,category,amount,note', '2025-12-30,food,10.00,a', '2026-01-02,food,2.50,b', '2026-01-07,travel,40.00,c', '2026-07-15,food,1.00,d', '2026-07-17,office,3.00,e', '2026-12-30,food,5.00,f', ''].join('\n')
const file = join(mkdtempSync(join(tmpdir(), 'bench-h2-')), 'expenses.csv')
writeFileSync(file, CSV)
const BY_WEEK = ['key       count  total', '2026-W01      2  $12.50', '2026-W02      1  $40.00', '2026-W29      2  $4.00', '2026-W53      1  $5.00', 'total         6  $61.50'].join('\n')

export default [
  ['a week goes from Monday to Sunday', weeks([['2026-06-15', '2026-W25'], ['2026-06-21', '2026-W25'], ['2026-06-22', '2026-W26'], ['2026-06-14', '2026-W24']])],
  ['the number of the week has two digits', weeks([['2026-02-02', '2026-W06'], ['2026-01-05', '2026-W02'], ['2026-03-01', '2026-W09']])],
  ['the first days of January can be in week 1 of that year', weeks([['2026-01-01', '2026-W01'], ['2026-01-04', '2026-W01']])],
  ['the last days of December can be in week 1 of the next year', weeks([['2025-12-29', '2026-W01'], ['2024-12-30', '2025-W01'], ['2025-12-28', '2025-W52'], ['2024-12-29', '2024-W52']])],
  ['the first days of January can be in the last week of the year before', weeks([['2027-01-01', '2026-W53'], ['2027-01-03', '2026-W53'], ['2027-01-04', '2027-W01'], ['2021-01-03', '2020-W53'], ['2021-01-04', '2021-W01']])],
  ['a year can have 53 weeks', weeks([['2026-12-28', '2026-W53'], ['2026-12-31', '2026-W53'], ['2020-12-31', '2020-W53'], ['2032-12-31', '2032-W53'], ['2028-12-31', '2028-W52']])],
  ['a leap day has its week', weeks([['2024-02-29', '2024-W09'], ['2024-03-03', '2024-W09'], ['2024-03-04', '2024-W10']])],
  ['the weeks are the same west of Greenwich', weeks([...YEAR_ENDS, ['2026-06-15', '2026-W25'], ['2026-06-21', '2026-W25']], [WEST])],
  ['the weeks are the same east of Greenwich', weeks([...YEAR_ENDS, ['2026-06-15', '2026-W25'], ['2026-06-21', '2026-W25']], [EAST, FAR_EAST])],
  ['the days on which the clocks change have their week', weeks([['2026-03-08', '2026-W10'], ['2026-03-09', '2026-W11'], ['2026-11-01', '2026-W44'], ['2026-11-02', '2026-W45'], ['2026-03-29', '2026-W13'], ['2026-03-30', '2026-W14'], ['2026-10-25', '2026-W43'], ['2026-10-26', '2026-W44']], [WEST, 'Europe/Berlin'])],
  ['"report --by week" prints one line per week, sorted, in every time zone', ({ cli, assert }) => {
    for (const tz of [WEST, EAST, 'UTC']) {
      const r = cli(['report', file, '--by', 'week'], { tz })
      assert.equal(r.status, 0)
      assert.equal(r.stdout.trimEnd(), BY_WEEK)
    }
  }],
  ['"--by week" works together with --from and --to', ({ cli, assert }) => {
    const r = cli(['report', file, '--by', 'week', '--from', '2026-01-05', '--to', '2026-08-01'])
    assert.equal(r.status, 0)
    assert.equal(r.stdout.trimEnd(), ['key       count  total', '2026-W02      1  $40.00', '2026-W29      2  $4.00', 'total         3  $44.00'].join('\n'))
  }],
  ['another value of --by still ends with exit code 2, and the help text shows the new value', ({ cli, assert }) => {
    const r = cli(['report', file, '--by', 'day'])
    assert.equal(r.status, 2)
    assert.equal(r.stdout.trim(), '')
    assert.ok(cli(['help']).stdout.includes('--by category|month|week'))
  }],
  ['the reports by category and by month stay as they are', ({ cli, assert, start }) => {
    // Days in the middle of a month, so that the time zone of the computer does not matter here.
    const middle = join(mkdtempSync(join(tmpdir(), 'bench-h2-')), 'middle.csv')
    writeFileSync(middle, ['date,category,amount,note', '2026-01-12,food,12.50,lunch', '2026-01-18,travel,40.00,train', '2026-02-10,food,7.25,coffee', ''].join('\n'))
    for (const args of [[], ['--by', 'month'], ['--by', 'category', '--from', '2026-01-15']]) {
      assert.equal(cli(['report', middle, ...args]).stdout, cli(['report', middle, ...args], { from: start }).stdout)
    }
  }],
]
