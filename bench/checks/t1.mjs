// Hidden checks of task t1: paginate.
const list = (n) => Array.from({ length: n }, (_, i) => i + 1)

export default [
  ['a full page holds "size" items', async ({ load, assert }) => {
    const { paginate } = await load('src/paginate.mjs')
    assert.deepEqual(paginate(list(25), 1, 10).items, list(10))
    assert.deepEqual(paginate(list(25), 2, 10).items, list(20).slice(10))
  }],
  ['the last page holds the rest', async ({ load, assert }) => {
    const { paginate } = await load('src/paginate.mjs')
    assert.deepEqual(paginate(list(25), 3, 10).items, [21, 22, 23, 24, 25])
  }],
  ['the number of pages is rounded up', async ({ load, assert }) => {
    const { paginate } = await load('src/paginate.mjs')
    assert.equal(paginate(list(25), 1, 10).pages, 3)
    assert.equal(paginate(list(1), 1, 10).pages, 1)
  }],
  ['a whole number of pages is not rounded further', async ({ load, assert }) => {
    const { paginate } = await load('src/paginate.mjs')
    assert.equal(paginate(list(20), 1, 10).pages, 2)
    assert.equal(paginate(list(20), 2, 10).items.length, 10)
  }],
  ['an empty list has one page without items', async ({ load, assert }) => {
    const { paginate } = await load('src/paginate.mjs')
    const page = paginate([], 1, 10)
    assert.equal(page.pages, 1)
    assert.deepEqual(page.items, [])
    assert.equal(page.total, 0)
  }],
  ['a page after the last one holds no items', async ({ load, assert }) => {
    const { paginate } = await load('src/paginate.mjs')
    const page = paginate(list(25), 4, 10)
    assert.deepEqual(page.items, [])
    assert.equal(page.pages, 3)
  }],
  ['a page below 1 is a RangeError', async ({ load, assert }) => {
    const { paginate } = await load('src/paginate.mjs')
    assert.throws(() => paginate(list(5), 0, 2), RangeError)
    assert.throws(() => paginate(list(5), -1, 2), RangeError)
  }],
  ['a page that is not a whole number is a RangeError', async ({ load, assert }) => {
    const { paginate } = await load('src/paginate.mjs')
    assert.throws(() => paginate(list(5), 1.5, 2), RangeError)
    assert.throws(() => paginate(list(5), NaN, 2), RangeError)
  }],
  ['a size that is not a whole number of 1 or more is a RangeError', async ({ load, assert }) => {
    const { paginate } = await load('src/paginate.mjs')
    assert.throws(() => paginate(list(5), 1, 0), RangeError)
    assert.throws(() => paginate(list(5), 1, 2.5), RangeError)
    assert.throws(() => paginate(list(5), 1, -3), RangeError)
  }],
  ['the defaults stay, and the list is not changed', async ({ load, assert }) => {
    const { paginate } = await load('src/paginate.mjs')
    const items = list(12)
    const page = paginate(items)
    assert.equal(page.page, 1)
    assert.equal(page.total, 12)
    assert.equal(page.items.length, 10)
    assert.deepEqual(items, list(12))
  }],
]
