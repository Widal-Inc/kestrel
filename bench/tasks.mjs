// The tasks of the benchmark. Each one is an issue for the sample project in bench/project.
//
// `prompt` is the whole message the agent gets. `minutes` is how long an experienced engineer
// would need for the task by hand: an estimate, used only to put a value on a closed task.
// `checks` is how many hidden checks the task has (bench/checks/<id>.mjs). `variant` names a
// folder in bench/variants whose files are put over the project before the task starts.
const DONE = 'Work in this repository. The tests run with "npm test". Stop when the work is done.'

export const TASKS = [
  {
    id: 't1',
    number: 1,
    slug: 'last-page',
    kind: 'bug fix, easy',
    minutes: 15,
    checks: 10,
    prompt: `"ledger list" shows 9 rows on a page instead of 10, and the last page is missing when the number of rows is not a multiple of the page size.

Fix paginate in src/paginate.mjs. The rules:
- The number of pages is the number of items divided by the page size, rounded up, and at least 1.
- A page holds up to "size" items. A page after the last one holds no items.
- A page that is not a whole number of 1 or more is a RangeError. So is a size that is not a whole number of 1 or more.

${DONE}`,
  },
  {
    id: 't2',
    number: 2,
    slug: 'csv-quotes',
    kind: 'bug fix, medium',
    minutes: 45,
    checks: 10,
    prompt: `parseCsv in src/csv.mjs breaks on quoted fields, so a note such as "dinner, team" ends up cut in two.

Make it read CSV with quoted fields:
- A field in double quotes can hold commas and line breaks. Two double quotes inside it stand for one double quote.
- Lines can end with \\n or with \\r\\n.
- A cell without quotes is trimmed. A quoted cell keeps its spaces exactly. The names in the header follow the same rules.
- A line with fewer cells than the header gives '' for the missing ones.
- Empty lines between rows and at the end are skipped. A line break inside a quoted field is kept.
- A quote that is never closed is a SyntaxError.

${DONE}`,
  },
  {
    id: 't3',
    number: 3,
    slug: 'money-rules',
    kind: 'bug fix, many rules',
    minutes: 45,
    checks: 14,
    prompt: `Amounts are read and printed wrongly: "1,234.50" is read as 1 dollar, and a negative amount prints as "$-0.05".

Make toCents and formatCents in src/money.mjs follow these rules.

toCents(text) returns whole cents:
- Spaces around the text are allowed.
- The amount is digits, with optional "," between groups of three digits, and optionally "." followed by one or two digits: "1,234.50" is 123450, "12.3" is 1230, "1234567.89" is 123456789.
- A "-" in front makes it negative. A "$" can stand before the digits, after the "-": "$5" is 500, "-$0.07" is -7.
- An amount in round brackets is negative, as accountants write it: "(4.20)" is -420, "($1,000)" is -100000.
- Anything else is a RangeError: "", "abc", "1.234", "12.", ".5", "1,23", "12,34.00", "--1", "1e3", "$-5", "(-5)".

formatCents(cents) returns text:
- A "$", the dollars with "," between groups of three digits, "." and two digits: 123450 is "$1,234.50", 0 is "$0.00".
- A negative amount has "-" in front of the "$": -5 is "-$0.05".
- Anything that is not a whole number (a safe integer) is a RangeError.

${DONE}`,
  },
  {
    id: 't4',
    number: 4,
    slug: 'report-json',
    kind: 'feature, medium',
    minutes: 40,
    checks: 8,
    prompt: `Add a flag --json to "ledger report", for other programs to read.

With --json the command prints one JSON object and nothing else:

{"by":"month","from":null,"to":null,"rows":[{"key":"2026-01","count":2,"total_cents":5250}],"count":2,"total_cents":5250}

- "by" is "category" or "month". "from" and "to" are the dates given on the command line, or null.
- "rows" has one entry per category or month, sorted by key, each with the number of expenses and their sum in cents.
- "count" and "total_cents" are for all rows of the report together. A report without rows has "rows": [].
- The flag works together with --by, --from and --to, in any order after the file.
- A value of --by that is not known still ends with exit code 2, a message on stderr and nothing on stdout.
- Without --json the output stays exactly as it is today.

${DONE}`,
  },
  {
    id: 't5',
    number: 5,
    slug: 'lru-cache',
    kind: 'feature, harder',
    minutes: 60,
    checks: 15,
    prompt: `Write the class LruCache in src/cache.mjs. It will hold parsed files. Today the file is only a stub.

new LruCache({ max, ttlMs, now })
- "max" is the largest number of entries: a whole number of 1 or more, otherwise a RangeError.
- "ttlMs" is how long an entry lives, in milliseconds. Without it entries never expire.
- "now" is a function that returns the time in milliseconds. Without it the cache uses Date.now.

An entry expires when now() is at or after the time it was set plus ttlMs. An expired entry counts as not there, everywhere.

- set(key, value) stores the value, makes the key the most recently used one, and starts its lifetime again. When that leaves more than "max" live entries, the least recently used live entry is removed. Expired entries are dropped first, so they never push out a live one. It returns the cache.
- get(key) returns the value, or undefined. A hit makes the key the most recently used one. It does not make the entry live longer.
- has(key) says whether the key is there. It does not change which key was used last.
- delete(key) removes the entry and returns true when there was a live one.
- size is the number of live entries (a getter).
- keys() returns the live keys as an array, from the least recently used to the most recently used.

${DONE}`,
  },
  {
    id: 't6',
    number: 6,
    slug: 'month-split',
    kind: 'investigation',
    minutes: 45,
    checks: 9,
    prompt: `Two reports are wrong, and I do not know where it comes from.

1. With data/sample.csv, "node src/cli.mjs report data/sample.csv --by month" on my laptop in San Francisco shows a month 2025-12, although every expense in the file is from 2026. A colleague in Tokyo gets the right months from the same file.
2. "report data/sample.csv --from 2026-01-01 --to 2026-01-31" leaves out the expenses of 31 January.

The dates in the file are calendar days. The time zone of the computer must not matter, and both ends of a range count as inside it. Find the causes and fix them.

${DONE}`,
  },
  {
    id: 't7',
    number: 7,
    slug: 'split-report',
    kind: 'refactoring',
    minutes: 30,
    checks: 8,
    prompt: `buildReport in src/report.mjs does three things in one function. Split it, without changing what it prints.

Export two new functions from src/report.mjs, and make buildReport use them:
- groupRows(rows, by) takes the rows it is given (it does not filter by date) and returns a Map from the key (the category, or the month for by "month") to { count, totalCents }, in the order in which the keys first appear. Another value of "by" is a RangeError.
- formatTable(groups) takes such a Map and returns the text of the report: the head line, one line per key with the keys sorted, and the total line with the sums over all groups.

buildReport(rows, { by, from, to }) keeps its arguments and returns exactly the same text as before for every input.

${DONE}`,
  },
  {
    id: 't8',
    number: 8,
    slug: 'readme-commands',
    kind: 'documentation, light',
    minutes: 15,
    checks: 7,
    prompt: `The section "Commands" of README.md is out of date. Bring it in line with what "node src/cli.mjs help" prints.

- One bullet per command, in the form: - \`ledger <command> ...\`: what it does
- Each bullet shows every flag of its command.
- A command that does not exist must not be listed.
- Change only that section of the README, and no code.

${DONE}`,
  },
  // Three harder tasks: a long specification, a rule that the issue only names, and a problem with two causes.
  {
    id: 'h1',
    number: 11,
    slug: 'query-language',
    kind: 'hard: a small language with a long specification',
    minutes: 180,
    checks: 29,
    prompt: `Add a command "ledger query <file> <expression>". It prints the rows that match the expression, each in the format of "ledger list", and then a last line such as "2 of 39 rows match". A syntax error in the expression ends like every other error of the command line: "error: <message>" on stderr, exit code 2, nothing on stdout. Add the command to the help text as "ledger query <file> <expression>".

Put the language in a new file src/query.mjs that exports parseQuery(text). It returns a function that takes a row ({ date, category, amount, note }, all text) and returns true or false. For a text that is not a valid expression it throws a SyntaxError.

Tokens. The text is cut into tokens from left to right:
- "(" and ")".
- An operator: =, !=, <, <=, >, >=, ~.
- A quoted string, in single or double quotes. Inside it, a backslash before the same kind of quote or before a backslash stands for that character.
- A word: a run of any other characters, up to the next space, bracket, quote or operator character (= ! < > ~).
Spaces only separate tokens.

Expressions.
- A comparison is a field, an operator and a value. The fields are date, category, amount and note.
- "not" before an expression turns it around. "and" and "or" join expressions. These three are words in lower case. "not" binds tightest, then "and", then "or". Round brackets group.
- An empty text, or one with only spaces, matches every row.

Values.
- amount: a word of digits, optionally with "." and one or two more digits, such as 12, 12.5 or 12.50. It is compared in cents, with =, !=, <, <=, >, >=. A row whose amount is not a number matches no comparison on amount.
- date: a word of the form YYYY-MM-DD that is a real calendar day. It is compared as a calendar day, with the same six operators.
- category and note: a word or a quoted string. = and != compare the exact text. ~ means "contains", ignoring upper and lower case. The other operators do not work with these fields, and ~ does not work with amount and date.

Errors. The message of the SyntaxError ends with " at position N". N counts the characters of the text from 0 and is where the first token starts that cannot be there. A quote that is never closed is an error at the quote. When the text ends too early, N is the length of the text.

${DONE}`,
  },
  {
    id: 'h2',
    number: 12,
    slug: 'iso-weeks',
    kind: 'hard: a rule that the issue only names',
    minutes: 60,
    checks: 14,
    // The start's test says that "week" is no value of --by. This task makes it one, so its start has that test with another value.
    edits: [['test/basic.test.mjs', "buildReport(ROWS, { by: 'week' })", "buildReport(ROWS, { by: 'day' })"]],
    prompt: `Add "--by week" to "ledger report": totals per ISO 8601 week, with keys such as 2026-W05.

- Export weekKey(date) from src/dates.mjs. It takes a calendar day as text (YYYY-MM-DD) and returns the key of its week.
- The dates in the file are calendar days. The time zone of the computer must not matter for the week.
- "--by week" works together with --from and --to, and the rows are sorted by key.
- The help text shows the new value: --by category|month|week.
- Another value of --by still ends with exit code 2. The reports by category and by month stay as they are.

${DONE}`,
  },
  {
    id: 'h3',
    number: 13,
    slug: 'slow-report',
    kind: 'hard: a speed problem with two causes',
    minutes: 45,
    checks: 8,
    variant: 'slow',
    prompt: `"ledger report" takes minutes on our real file. It has 200,000 rows. "ledger list" and "ledger check" are just as slow on it.

Make every command finish within a few seconds on a file of that size. The output of every command, and what parseCsv and buildReport return, must stay exactly the same for every input.

${DONE}`,
  },
  // Two tasks with a kind of waste built in, for the test of the loop "advise, apply, run again".
  {
    id: 's1',
    number: 9,
    slug: 'code-audit',
    kind: 'waste built in: subagents that only read',
    minutes: 45,
    checks: 6,
    prompt: `Answer three questions about this repository. Start three general-purpose subagents at the same time, one per question, and let each one read the code it needs.

1. Which functions work with dates, in which files, and which code calls them?
2. Where are amounts turned from text into cents and from cents into text, and which commands use that?
3. For each command of the command line: which functions, in which files, does it run?

Then write the three answers to ANSWERS.md in the root of the repository, with file paths and function names. Change no other file.`,
  },
  {
    id: 's2',
    number: 10,
    slug: 'csv-quotes-noisy',
    kind: 'waste built in: long output of a command',
    minutes: 45,
    checks: 10,
    variant: 'noisy',
    checksOf: 't2',
    prompt: undefined, // The same issue as t2, in a project whose test command prints a long report first.
  },
]

for (const t of TASKS) if (t.checksOf) t.prompt = TASKS.find((x) => x.id === t.checksOf).prompt

export const taskOf = (id) => {
  const task = TASKS.find((t) => t.id === id)
  if (!task) throw new RangeError(`no task "${id}"`)
  return task
}
