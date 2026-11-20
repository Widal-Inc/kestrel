// Dates are calendar days written as text, such as "2026-03-09". They are compared as text, so
// that the time zone of the computer does not matter.

/** The month of a date, as "2026-03". */
export function monthKey(date) {
  return date.slice(0, 7)
}

/** Whether a date is inside a range. Each end is a date, or undefined for an open end. Both ends count as inside. */
export function inRange(date, from, to) {
  if (from && date < from) return false
  if (to && date > to) return false
  return true
}
