/** A cache that keeps the entries used last, up to a largest number, each for a limited time. */
export class LruCache {
  #max
  #ttl
  #now
  // From the least recently used key to the most recently used one.
  #entries = new Map()

  constructor({ max, ttlMs, now = Date.now } = {}) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError('"max" must be a whole number of 1 or more')
    this.#max = max
    this.#ttl = ttlMs
    this.#now = now
  }

  #expired(entry) {
    return this.#ttl !== undefined && this.#now() >= entry.at + this.#ttl
  }

  #dropExpired() {
    for (const [key, entry] of this.#entries) if (this.#expired(entry)) this.#entries.delete(key)
  }

  set(key, value) {
    this.#entries.delete(key)
    this.#dropExpired()
    this.#entries.set(key, { value, at: this.#now() })
    while (this.#entries.size > this.#max) this.#entries.delete(this.#entries.keys().next().value)
    return this
  }

  get(key) {
    const entry = this.#entries.get(key)
    if (!entry) return undefined
    this.#entries.delete(key)
    if (this.#expired(entry)) return undefined
    this.#entries.set(key, entry)
    return entry.value
  }

  has(key) {
    const entry = this.#entries.get(key)
    return entry !== undefined && !this.#expired(entry)
  }

  delete(key) {
    const entry = this.#entries.get(key)
    if (!entry) return false
    this.#entries.delete(key)
    return !this.#expired(entry)
  }

  get size() {
    this.#dropExpired()
    return this.#entries.size
  }

  keys() {
    this.#dropExpired()
    return [...this.#entries.keys()]
  }
}
