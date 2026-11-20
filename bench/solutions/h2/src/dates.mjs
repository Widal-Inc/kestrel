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

/** The ISO 8601 week of a date, as "2026-W05". Week 1 is the week with the year's first Thursday. */
export function weekKey(date) {
  const [year, month, day] = date.split('-').map(Number)
  const t = new Date(Date.UTC(year, month - 1, day))
  // Move to the Thursday of the same week. Monday is 1 and Sunday is 7.
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
  const weekYear = t.getUTCFullYear()
  const week = Math.ceil(((t.getTime() - Date.UTC(weekYear, 0, 1)) / 86400000 + 1) / 7)
  return `${weekYear}-W${String(week).padStart(2, '0')}`
}
