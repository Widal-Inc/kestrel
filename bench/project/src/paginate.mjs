/** One page of a list. Pages count from 1. */
export function paginate(items, page = 1, size = 10) {
  const pages = Math.floor(items.length / size)
  const start = (page - 1) * size
  return { items: items.slice(start, start + size - 1), page, pages, total: items.length }
}
