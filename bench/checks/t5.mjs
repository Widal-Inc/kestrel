// Hidden checks of task t5: the class LruCache.

/** A clock that the check moves by hand. */
function clock(start = 1000) {
  let t = start
  const now = () => t
  now.add = (ms) => {
    t += ms
  }
  return now
}

export default [
  ['"max" must be a whole number of 1 or more', async ({ load, assert }) => {
    const { LruCache } = await load('src/cache.mjs')
    for (const max of [0, -1, 1.5, NaN, undefined]) assert.throws(() => new LruCache({ max }), RangeError)
    assert.ok(new LruCache({ max: 1 }))
  }],
  ['set and get keep a value, and a miss gives undefined', async ({ load, assert }) => {
    const { LruCache } = await load('src/cache.mjs')
    const cache = new LruCache({ max: 2 })
    cache.set('a', 1)
    assert.equal(cache.get('a'), 1)
    assert.equal(cache.get('b'), undefined)
  }],
  ['set returns the cache', async ({ load, assert }) => {
    const { LruCache } = await load('src/cache.mjs')
    const cache = new LruCache({ max: 2 })
    assert.equal(cache.set('a', 1), cache)
    assert.equal(cache.set('b', 2).set('c', 3).get('c'), 3)
  }],
  ['the least recently used entry is removed when the cache is full', async ({ load, assert }) => {
    const { LruCache } = await load('src/cache.mjs')
    const cache = new LruCache({ max: 2 })
    cache.set('a', 1).set('b', 2).set('c', 3)
    assert.equal(cache.has('a'), false)
    assert.equal(cache.get('b'), 2)
    assert.equal(cache.get('c'), 3)
  }],
  ['a hit of get makes the key the most recently used one', async ({ load, assert }) => {
    const { LruCache } = await load('src/cache.mjs')
    const cache = new LruCache({ max: 2 })
    cache.set('a', 1).set('b', 2)
    cache.get('a')
    cache.set('c', 3)
    assert.equal(cache.has('a'), true)
    assert.equal(cache.has('b'), false)
  }],
  ['has does not change which key was used last', async ({ load, assert }) => {
    const { LruCache } = await load('src/cache.mjs')
    const cache = new LruCache({ max: 2 })
    cache.set('a', 1).set('b', 2)
    assert.equal(cache.has('a'), true)
    cache.set('c', 3)
    assert.equal(cache.has('a'), false)
    assert.equal(cache.has('b'), true)
  }],
  ['set of a key that is there replaces the value and makes it the most recently used', async ({ load, assert }) => {
    const { LruCache } = await load('src/cache.mjs')
    const cache = new LruCache({ max: 2 })
    cache.set('a', 1).set('b', 2).set('a', 10)
    assert.equal(cache.size, 2)
    cache.set('c', 3)
    assert.equal(cache.get('a'), 10)
    assert.equal(cache.has('b'), false)
  }],
  ['delete removes an entry and says whether there was one', async ({ load, assert }) => {
    const { LruCache } = await load('src/cache.mjs')
    const cache = new LruCache({ max: 2 })
    cache.set('a', 1)
    assert.equal(cache.delete('a'), true)
    assert.equal(cache.delete('a'), false)
    assert.equal(cache.get('a'), undefined)
    assert.equal(cache.size, 0)
  }],
  ['size is a getter that counts the entries', async ({ load, assert }) => {
    const { LruCache } = await load('src/cache.mjs')
    const cache = new LruCache({ max: 3 })
    assert.equal(cache.size, 0)
    cache.set('a', 1).set('b', 2)
    assert.equal(cache.size, 2)
    cache.set('c', 3).set('d', 4)
    assert.equal(cache.size, 3)
  }],
  ['keys go from the least recently used to the most recently used', async ({ load, assert }) => {
    const { LruCache } = await load('src/cache.mjs')
    const cache = new LruCache({ max: 3 })
    cache.set('a', 1).set('b', 2).set('c', 3)
    cache.get('a')
    const keys = cache.keys()
    assert.ok(Array.isArray(keys))
    assert.deepEqual(keys, ['b', 'c', 'a'])
  }],
  ['an entry expires at the time it was set plus ttlMs, not later', async ({ load, assert }) => {
    const { LruCache } = await load('src/cache.mjs')
    const now = clock()
    const cache = new LruCache({ max: 2, ttlMs: 100, now })
    cache.set('a', 1)
    now.add(99)
    assert.equal(cache.get('a'), 1)
    now.add(1)
    assert.equal(cache.get('a'), undefined)
    assert.equal(cache.has('a'), false)
  }],
  ['get does not make an entry live longer', async ({ load, assert }) => {
    const { LruCache } = await load('src/cache.mjs')
    const now = clock()
    const cache = new LruCache({ max: 2, ttlMs: 100, now })
    cache.set('a', 1)
    now.add(60)
    assert.equal(cache.get('a'), 1)
    now.add(60)
    assert.equal(cache.get('a'), undefined)
  }],
  ['set starts the lifetime again', async ({ load, assert }) => {
    const { LruCache } = await load('src/cache.mjs')
    const now = clock()
    const cache = new LruCache({ max: 2, ttlMs: 100, now })
    cache.set('a', 1)
    now.add(60)
    cache.set('a', 2)
    now.add(60)
    assert.equal(cache.get('a'), 2)
  }],
  ['an expired entry never pushes out a live one', async ({ load, assert }) => {
    const { LruCache } = await load('src/cache.mjs')
    const now = clock()
    const cache = new LruCache({ max: 2, ttlMs: 100, now })
    cache.set('a', 1)
    now.add(50)
    cache.set('b', 2)
    now.add(10)
    // "a" is now the most recently used key, and it expires first.
    cache.get('a')
    now.add(50)
    cache.set('c', 3)
    assert.equal(cache.get('b'), 2)
    assert.equal(cache.get('c'), 3)
    assert.equal(cache.size, 2)
  }],
  ['expired entries are not counted, not listed and not deleted as live, and entries without ttlMs stay', async ({ load, assert }) => {
    const { LruCache } = await load('src/cache.mjs')
    const now = clock()
    const cache = new LruCache({ max: 3, ttlMs: 100, now })
    cache.set('a', 1)
    now.add(50)
    cache.set('b', 2)
    now.add(60)
    assert.equal(cache.size, 1)
    assert.deepEqual(cache.keys(), ['b'])
    assert.equal(cache.delete('a'), false)
    const forever = new LruCache({ max: 2, now })
    forever.set('x', 1)
    now.add(1e12)
    assert.equal(forever.get('x'), 1)
    const real = new LruCache({ max: 1, ttlMs: 60_000 })
    assert.equal(real.set('y', 5).get('y'), 5)
  }],
]
