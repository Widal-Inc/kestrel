// Hidden checks of task s1: three questions about the code, answered in ANSWERS.md.
const has = (text, words) => words.filter((word) => !text.includes(word))

export default [
  ['ANSWERS.md is there and has an answer of some length', ({ read, assert }) => {
    const text = read('ANSWERS.md')
    assert.ok(text, 'no ANSWERS.md')
    assert.ok(text.length >= 600, 'the answers are shorter than 600 characters')
  }],
  ['the dates: both functions, their file, and the code that calls them', ({ read, assert }) => {
    assert.deepEqual(has(read('ANSWERS.md') ?? '', ['monthKey', 'inRange', 'dates.mjs', 'buildReport', 'report.mjs']), [])
  }],
  ['the amounts: both directions and their file', ({ read, assert }) => {
    assert.deepEqual(has(read('ANSWERS.md') ?? '', ['toCents', 'formatCents', 'money.mjs']), [])
  }],
  ['the commands: the functions that they run', ({ read, assert }) => {
    assert.deepEqual(has(read('ANSWERS.md') ?? '', ['parseCsv', 'paginate', 'buildReport', 'cli.mjs', 'csv.mjs', 'paginate.mjs']), [])
  }],
  ['all four commands are named', ({ read, assert }) => {
    const text = read('ANSWERS.md') ?? ''
    for (const command of ['report', 'list', 'check', 'help']) assert.match(text, new RegExp('\\b' + command + '\\b'))
  }],
  ['no other file is changed', ({ changed, assert }) => {
    assert.deepEqual(changed.filter((file) => file !== 'ANSWERS.md'), [])
  }],
]
