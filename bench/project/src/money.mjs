// Amounts are kept in cents, as whole numbers.

/** The cents of an amount written as text, such as "12.34". */
export function toCents(text) {
  return Math.round(parseFloat(text) * 100)
}

/** An amount in cents as text, such as "$12.34". */
export function formatCents(cents) {
  return '$' + (cents / 100).toFixed(2)
}

/** The sum of amounts in cents. */
export function sumCents(list) {
  return list.reduce((a, b) => a + b, 0)
}
