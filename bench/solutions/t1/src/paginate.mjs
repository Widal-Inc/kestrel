/** One page of a list. Pages count from 1. */
export function paginate(items, page = 1, size = 10) {
  if (!Number.isInteger(page) || page < 1) throw new RangeError('the page must be a whole number of 1 or more')
  if (!Number.isInteger(size) || size < 1) throw new RangeError('the size must be a whole number of 1 or more')
  const pages = Math.max(1, Math.ceil(items.length / size))
  const start = (page - 1) * size
  return { items: items.slice(start, start + size), page, pages, total: items.length }
}
