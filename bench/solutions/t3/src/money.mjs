// Amounts are kept in cents, as whole numbers.

const AMOUNT = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/

/** The cents of an amount written as text, such as "12.34", "-$1,234.50" or "(4.20)". */
export function toCents(text) {
  const no = () => new RangeError(`"${text}" is not an amount`)
  if (typeof text !== 'string') throw no()
  let rest = text.trim()
  let negative = false
  if (rest.startsWith('(') && rest.endsWith(')')) {
    negative = true
    rest = rest.slice(1, -1)
  } else if (rest.startsWith('-')) {
    negative = true
    rest = rest.slice(1)
  }
  if (rest.startsWith('$')) rest = rest.slice(1)
  const match = AMOUNT.exec(rest)
  if (!match) throw no()
  const cents = Number(match[1].replaceAll(',', '')) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return negative && cents ? -cents : cents
}

/** An amount in cents as text, such as "$1,234.50" or "-$0.05". */
export function formatCents(cents) {
  if (!Number.isSafeInteger(cents)) throw new RangeError('the cents must be a whole number')
  const abs = Math.abs(cents)
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${cents < 0 ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`
}

/** The sum of amounts in cents. */
export function sumCents(list) {
  return list.reduce((a, b) => a + b, 0)
}
