// Dates are calendar days written as text, such as "2026-03-09".

/** The month of a date, as "2026-03". */
export function monthKey(date) {
  const d = new Date(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Whether a date is inside a range. Each end is a date, or undefined for an open end. */
export function inRange(date, from, to) {
  const t = new Date(date).getTime()
  if (from && t < new Date(from).getTime()) return false
  if (to && t >= new Date(to).getTime()) return false
  return true
}
