/** The rows of a CSV text, as objects keyed by the names in the header line. */
export function parseCsv(text) {
  const lines = []
  let cells = []
  let cell = ''
  let inQuotes = false
  let quoted = false
  let content = false
  const endCell = () => {
    cells.push(quoted ? cell : cell.trim())
    cell = ''
    quoted = false
  }
  const endLine = () => {
    endCell()
    if (content) lines.push(cells)
    cells = []
    content = false
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch !== '"') cell += ch
      else if (text[i + 1] === '"') {
        cell += '"'
        i++
      } else inQuotes = false
    } else if (ch === '"' && !quoted && cell.trim() === '') {
      inQuotes = true
      quoted = true
      content = true
      cell = ''
    } else if (ch === ',') {
      endCell()
      content = true
    } else if (ch === '\n') endLine()
    else if (ch === '\r' && text[i + 1] === '\n') continue
    else if (quoted && ch.trim() === '') continue
    else {
      cell += ch
      if (ch.trim() !== '') content = true
    }
  }
  if (inQuotes) throw new SyntaxError('a quote is never closed')
  endLine()
  if (!lines.length) return []
  const [header, ...rows] = lines
  return rows.map((row) => Object.fromEntries(header.map((name, i) => [name, row[i] ?? ''])))
}
