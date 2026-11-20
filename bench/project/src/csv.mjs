/** The rows of a CSV text, as objects keyed by the names in the header line. */
export function parseCsv(text) {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (!lines.length) return []
  const header = lines[0].split(',').map((name) => name.trim())
  return lines.slice(1).map((line) => {
    const cells = line.split(',')
    return Object.fromEntries(header.map((name, i) => [name, (cells[i] ?? '').trim()]))
  })
}
