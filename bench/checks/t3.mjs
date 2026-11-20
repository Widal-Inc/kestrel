// Hidden checks of task t3: toCents and formatCents.
const rejects = (list) => async ({ load, assert }) => {
  const { toCents } = await load('src/money.mjs')
  for (const text of list) assert.throws(() => toCents(text), RangeError, `toCents(${JSON.stringify(text)}) must be a RangeError`)
}

export default [
  ['toCents reads plain amounts', async ({ load, assert }) => {
    const { toCents } = await load('src/money.mjs')
    assert.equal(toCents('12.34'), 1234)
    assert.equal(toCents('5'), 500)
    assert.equal(toCents('12.3'), 1230)
    assert.equal(toCents('0.07'), 7)
  }],
  ['toCents allows spaces around the text', async ({ load, assert }) => {
    const { toCents } = await load('src/money.mjs')
    assert.equal(toCents('  7.25 '), 725)
    assert.equal(toCents('  1,000  '), 100000)
  }],
  ['toCents reads "," between groups of three digits', async ({ load, assert }) => {
    const { toCents } = await load('src/money.mjs')
    assert.equal(toCents('1,234.50'), 123450)
    assert.equal(toCents('1,234,567.89'), 123456789)
    assert.equal(toCents('1234567.89'), 123456789)
  }],
  ['toCents reads a "-" in front', async ({ load, assert }) => {
    const { toCents } = await load('src/money.mjs')
    assert.equal(toCents('-5'), -500)
    assert.equal(toCents('-1,234.50'), -123450)
  }],
  ['toCents reads a "$" before the digits', async ({ load, assert }) => {
    const { toCents } = await load('src/money.mjs')
    assert.equal(toCents('$5'), 500)
    assert.equal(toCents('-$0.07'), -7)
    assert.equal(toCents('$1,000'), 100000)
  }],
  ['toCents reads an amount in round brackets as negative', async ({ load, assert }) => {
    const { toCents } = await load('src/money.mjs')
    assert.equal(toCents('(4.20)'), -420)
    assert.equal(toCents('($1,000)'), -100000)
  }],
  ['toCents gives exact cents', async ({ load, assert }) => {
    const { toCents } = await load('src/money.mjs')
    for (const [text, cents] of [['0.29', 29], ['1.15', 115], ['4.35', 435], ['19.99', 1999], ['1,000,000.01', 100000001], ['8.7', 870]]) assert.equal(toCents(text), cents)
  }],
  ['toCents refuses text that is not an amount', rejects(['', '   ', 'abc', '12abc', '1.234', '12.', '.5'])],
  ['toCents refuses groups that are not three digits, and other number forms', rejects(['1,23', '12,34.00', ',123', '1,2345', '--1', '1e3', '0x10', '1.2.3'])],
  ['toCents refuses a sign in the wrong place', rejects(['$-5', '(-5)', '(5', '5)', '5-', '$$5'])],
  ['formatCents prints "," between groups of three digits', async ({ load, assert }) => {
    const { formatCents } = await load('src/money.mjs')
    assert.equal(formatCents(123450), '$1,234.50')
    assert.equal(formatCents(100000000), '$1,000,000.00')
    assert.equal(formatCents(99999), '$999.99')
  }],
  ['formatCents prints small amounts with two digits', async ({ load, assert }) => {
    const { formatCents } = await load('src/money.mjs')
    assert.equal(formatCents(0), '$0.00')
    assert.equal(formatCents(5), '$0.05')
    assert.equal(formatCents(100), '$1.00')
    assert.equal(formatCents(1234), '$12.34')
  }],
  ['formatCents puts "-" in front of the "$"', async ({ load, assert }) => {
    const { formatCents } = await load('src/money.mjs')
    assert.equal(formatCents(-5), '-$0.05')
    assert.equal(formatCents(-123456789), '-$1,234,567.89')
  }],
  ['formatCents refuses what is not a whole number', async ({ load, assert }) => {
    const { formatCents } = await load('src/money.mjs')
    for (const value of [1.5, NaN, Infinity, 2 ** 53]) assert.throws(() => formatCents(value), RangeError, `formatCents(${value}) must be a RangeError`)
  }],
]
