// The language of "ledger query": comparisons on the fields of a row, joined with not, and, or.
import { toCents } from './money.mjs'

const FIELDS = ['date', 'category', 'amount', 'note']
const TEXT_FIELDS = ['category', 'note']
const fail = (message, position) => new SyntaxError(`${message} at position ${position}`)

/** The tokens of an expression: { type, value, at }. */
function tokens(text) {
  const out = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) i++
    else if (ch === '(' || ch === ')') out.push({ type: ch, at: i++ })
    else if (ch === '"' || ch === "'") {
      let value = ''
      let j = i + 1
      for (;;) {
        if (j >= text.length) throw fail('a quote is never closed', i)
        if (text[j] === '\\' && (text[j + 1] === ch || text[j + 1] === '\\')) {
          value += text[j + 1]
          j += 2
        } else if (text[j] === ch) break
        else value += text[j++]
      }
      out.push({ type: 'string', value, at: i })
      i = j + 1
    } else if ('=!<>~'.includes(ch)) {
      const two = text.slice(i, i + 2)
      if (two === '<=' || two === '>=' || two === '!=') {
        out.push({ type: 'op', value: two, at: i })
        i += 2
      } else if (ch === '!') throw fail('"!" is not an operator', i)
      else out.push({ type: 'op', value: ch, at: i++ })
    } else {
      let j = i
      while (j < text.length && !/[\s()"'=!<>~]/.test(text[j])) j++
      out.push({ type: 'word', value: text.slice(i, j), at: i })
      i = j
    }
  }
  return out
}

const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate()

/** Whether a text is a real calendar day written as YYYY-MM-DD. */
function isDay(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!m) return false
  const [year, month, day] = m.slice(1).map(Number)
  return month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month)
}

const COMPARE = {
  '=': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
}

/** The cents of a row's amount, or undefined when it is not a number. */
function centsOf(text) {
  try {
    const cents = toCents(text)
    return Number.isFinite(cents) ? cents : undefined
  } catch {
    return undefined
  }
}

/** A function that says whether a row matches the expression. */
export function parseQuery(text) {
  const list = tokens(text)
  let p = 0
  const isWord = (token, word) => token?.type === 'word' && token.value === word
  const early = () => fail('the expression ends too early', text.length)

  function comparison() {
    const field = list[p++]
    if (field.type !== 'word' || !FIELDS.includes(field.value)) throw fail('a field must stand here (date, category, amount or note)', field.at)
    const op = list[p++]
    if (!op) throw early()
    if (op.type !== 'op') throw fail('an operator must stand here', op.at)
    const isText = TEXT_FIELDS.includes(field.value)
    if (isText ? !['=', '!=', '~'].includes(op.value) : op.value === '~') throw fail(`"${op.value}" does not work with ${field.value}`, op.at)
    const value = list[p++]
    if (!value) throw early()
    if (value.type !== 'word' && value.type !== 'string') throw fail('a value must stand here', value.at)
    const name = field.value
    if (isText) {
      if (op.value === '~') {
        const part = value.value.toLowerCase()
        return (row) => String(row[name]).toLowerCase().includes(part)
      }
      return (row) => COMPARE[op.value](row[name], value.value)
    }
    if (name === 'amount') {
      const m = value.type === 'word' && /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.value)
      if (!m) throw fail('an amount such as 12 or 12.50 must stand here', value.at)
      const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
      return (row) => {
        const own = centsOf(row.amount)
        return own !== undefined && COMPARE[op.value](own, cents)
      }
    }
    if (value.type !== 'word' || !isDay(value.value)) throw fail('a date such as 2026-01-31 must stand here', value.at)
    return (row) => COMPARE[op.value](row.date, value.value)
  }

  function unary() {
    const token = list[p]
    if (!token) throw early()
    if (isWord(token, 'not')) {
      p++
      const inner = unary()
      return (row) => !inner(row)
    }
    if (token.type === '(') {
      p++
      const inner = or()
      const close = list[p]
      if (!close) throw early()
      if (close.type !== ')') throw fail('")" must stand here', close.at)
      p++
      return inner
    }
    return comparison()
  }

  function and() {
    let left = unary()
    while (isWord(list[p], 'and')) {
      p++
      const a = left
      const b = unary()
      left = (row) => a(row) && b(row)
    }
    return left
  }

  function or() {
    let left = and()
    while (isWord(list[p], 'or')) {
      p++
      const a = left
      const b = and()
      left = (row) => a(row) || b(row)
    }
    return left
  }

  if (!list.length) return () => true
  const test = or()
  if (p < list.length) throw fail('this cannot stand here', list[p].at)
  return test
}
