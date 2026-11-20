// Hidden checks of task h1: the language of "ledger query".
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROWS = [
  { date: '2026-01-15', category: 'food', amount: '12.50', note: 'lunch' },
  { date: '2026-01-20', category: 'travel', amount: '40.00', note: 'Train to Berlin' },
  { date: '2026-02-10', category: 'food', amount: '7.25', note: 'dinner, team' },
  { date: '2026-02-14', category: 'home-office', amount: '0.30', note: "it's a pen" },
  { date: '2026-03-01', category: 'android', amount: '1.10', note: 'say "hi"' },
  { date: '2026-03-05', category: 'food', amount: 'n/a', note: 'a_b \\ c' },
]
const ALL = [0, 1, 2, 3, 4, 5]

/** A check that each expression matches the rows with these indexes. */
const matches = (cases) => async ({ load, assert }) => {
  const { parseQuery } = await load('src/query.mjs')
  for (const [text, rows] of cases) {
    const test = parseQuery(text)
    assert.deepEqual(ROWS.map((row, i) => (test(row) === true ? i : -1)).filter((i) => i >= 0), rows, `the rows that match: ${text}`)
  }
}

/** A check that each expression is a SyntaxError whose message ends with the position. */
const errors = (cases) => async ({ load, assert }) => {
  const { parseQuery } = await load('src/query.mjs')
  for (const [text, position] of cases) {
    let error
    try {
      parseQuery(text)
    } catch (e) {
      error = e
    }
    assert.ok(error instanceof SyntaxError, `must be a SyntaxError: ${text}`)
    assert.equal(/ at position (\d+)$/.exec(error.message)?.[1], String(position), `the position of the error in: ${text}`)
  }
}

const CSV = ['date,category,amount,note', '2026-01-15,food,12.50,lunch', '2026-01-20,travel,40.00,train', '2026-02-10,food,7.25,coffee', '2026-02-14,office,3.10,pens', '2026-03-15,food,21.05,dinner', ''].join('\n')
const file = join(mkdtempSync(join(tmpdir(), 'bench-h1-')), 'expenses.csv')
writeFileSync(file, CSV)

export default [
  ['= and != on a text field', matches([['category = food', [0, 2, 5]], ['category != food', [1, 3, 4]]])],
  ['amounts are compared in cents', matches([['amount = 12.5', [0]], ['amount = 12.50', [0]], ['amount >= 7.25', [0, 1, 2]], ['amount < 1.1', [3]], ['amount > 1.1', [0, 1, 2]], ['amount = 0.3', [3]], ['amount <= 0.30', [3]]])],
  ['dates are compared as calendar days', matches([['date >= 2026-02-10', [2, 3, 4, 5]], ['date < 2026-01-20', [0]], ['date = 2026-03-01', [4]], ['date != 2026-03-01', [0, 1, 2, 3, 5]], ['date <= 2026-01-20', [0, 1]], ['date > 2026-03-01', [5]]])],
  ['~ means "contains", ignoring upper and lower case', matches([['note ~ train', [1]], ['note ~ TEAM', [2]], ['category ~ OO', [0, 2, 5]], ['note ~ "to berlin"', [1]]])],
  ['= on a text field compares the exact text', matches([['note = lunch', [0]], ['note = Lunch', []], ['note = lun', []], ['note = "Train to Berlin"', [1]]])],
  ['a quoted string in single or double quotes', matches([['note = "dinner, team"', [2]], ["note = 'dinner, team'", [2]], ['note = "it\'s a pen"', [3]], ["note = 'say \"hi\"'", [4]]])],
  ['a backslash before the quote or before a backslash', matches([["note = 'it\\'s a pen'", [3]], ['note = "say \\"hi\\""', [4]], ["note = 'a_b \\\\ c'", [5]]])],
  ['a word can hold a dash and an underscore', matches([['category = home-office', [3]], ['note ~ a_b', [5]], ['category != home-office', [0, 1, 2, 4, 5]]])],
  ['a word that starts like "and", "or" or "not" is a word', matches([['category = android', [4]], ['category = android or category = travel', [1, 4]], ['note ~ notary', []], ['category=order', []], ['not category = android', [0, 1, 2, 3, 5]]])],
  ['"and" binds tighter than "or"', matches([['category = travel or category = food and amount > 10', [0, 1]], ['category = food and amount > 10 or category = travel', [0, 1]], ['category = android or category = travel or category = food and amount < 10', [1, 2, 4]]])],
  ['"not" binds tightest', matches([['not category = food and amount > 10', [1]], ['amount > 10 and not category = food', [1]], ['not category = food or amount > 10', [0, 1, 3, 4]]])],
  ['round brackets group', matches([['(category = travel or category = food) and amount > 10', [0, 1]], ['not (category = food and amount > 10)', [1, 2, 3, 4, 5]], ['category = food and (amount > 10 or date > 2026-02-01)', [0, 2, 5]]])],
  ['brackets inside brackets, and "not" twice', matches([['not not category = food', [0, 2, 5]], ['((category = food))', [0, 2, 5]], ['not (not (amount < 1) or date < 2026-01-01)', [3]]])],
  ['spaces are not needed around operators and brackets', matches([['amount>=7.25 and(category=food or category=travel)', [0, 1, 2]], ['  category   =   food  ', [0, 2, 5]], ['not(category=food)', [1, 3, 4]]])],
  ['an empty text matches every row', matches([['', ALL], ['    ', ALL]])],
  ['a row whose amount is not a number matches no comparison on amount', matches([['amount != 5', [0, 1, 2, 3, 4]], ['amount > 0', [0, 1, 2, 3, 4]], ['not amount > 0', [5]], ['amount < 1000 or amount >= 1000', [0, 1, 2, 3, 4]]])],
  ['a field that does not exist is an error where it starts', errors([['price > 3', 0], ['category = food and price > 3', 20], ['(price = food)', 1]])],
  ['a text that ends too early is an error at its length', errors([['category =', 10], ['category', 8], ['category = food and', 19], ['not', 3], ['category = food or  ', 20]])],
  ['brackets that do not match are errors', errors([['(category = food', 16], ['category = food)', 15], ['()', 1], ['((category = food)', 18]])],
  ['a quote that is never closed is an error at the quote', errors([['note = "open', 7], ["note = 'a\\'", 7], ['note = "a" or note = \'b', 21]])],
  ['an operator that does not work with the field is an error at the operator', errors([['note < a', 5], ['category >= b', 9], ['amount ~ 1', 7], ['date ~ 2026', 5]])],
  ['a value that is not an amount is an error at the value', errors([['amount > abc', 9], ['amount > 1.234', 9], ['amount = "5"', 9], ['amount > -5', 9], ['amount = 1,000', 9], ['amount = 5.', 9]])],
  ['a value that is not a real calendar day is an error at the value', errors([['date = 2026-02-30', 7], ['date = 2026-2-1', 7], ['date > 2025-02-29', 7], ['date = 2026-13-01', 7], ['date = "2026-01-01"', 7]])],
  ['a leap day is a real calendar day', matches([['date > 2024-02-29', ALL], ['date < 2028-02-29', ALL]])],
  ['"AND", "OR" and "NOT" in upper case are not the joining words', errors([['category = food AND amount > 1', 16], ['NOT category = food', 0], ['category = food OR category = travel', 16]])],
  ['text that is left over, a "!" alone and a missing operator are errors', errors([['category = food food', 16], ['category = food amount > 1', 16], ['category ! food', 9], ['category food', 9], ['category = = food', 11]])],
  ['the command prints the matching rows as "list" does, and how many match', ({ cli, assert, start }) => {
    const r = cli(['query', file, 'category = food and amount > 10'])
    assert.equal(r.status, 0)
    const listed = cli(['list', file, '--size', '100'], { from: start }).stdout.split('\n')
    assert.equal(r.stdout.trimEnd(), [listed[0], listed[4], '2 of 5 rows match'].join('\n'))
    assert.equal(cli(['query', file, 'amount > 1000']).stdout.trimEnd(), '0 of 5 rows match')
  }],
  ['a syntax error ends the command with "error:" on stderr, exit code 2 and nothing on stdout', ({ cli, assert }) => {
    const r = cli(['query', file, 'category = food and'])
    assert.equal(r.status, 2)
    assert.equal(r.stdout.trim(), '')
    assert.match(r.stderr, /^error: .* at position 19\s*$/)
  }],
  ['the help text lists the command', ({ cli, assert }) => {
    assert.ok(cli(['help']).stdout.includes('ledger query <file> <expression>'))
  }],
]
