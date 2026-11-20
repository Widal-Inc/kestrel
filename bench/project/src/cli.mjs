#!/usr/bin/env node
// The command line of ledger.
import { readFileSync } from 'node:fs'
import { parseCsv } from './csv.mjs'
import { formatCents, toCents } from './money.mjs'
import { paginate } from './paginate.mjs'
import { buildReport } from './report.mjs'

const HELP = `ledger: reports on a CSV file of expenses

  ledger report <file> [--by category|month] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
      totals per category or per month
  ledger list <file> [--page N] [--size N]
      the rows, one page at a time
  ledger check <file>
      says whether every row has a date, a category and an amount
  ledger help
      this text`

/** The flags of a command line as an object, and the words that are not flags. */
function parseArgs(args) {
  const flags = {}
  const words = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('--')) words.push(arg)
    else if (args[i + 1] === undefined || args[i + 1].startsWith('--')) flags[arg.slice(2)] = true
    else flags[arg.slice(2)] = args[++i]
  }
  return { flags, words }
}

function load(file) {
  if (!file) throw new RangeError('this command needs a file')
  return parseCsv(readFileSync(file, 'utf8'))
}

function main(argv) {
  const [command, ...rest] = argv
  const { flags, words } = parseArgs(rest)
  if (!command || command === 'help') return HELP
  if (command === 'report') {
    return buildReport(load(words[0]), { by: flags.by ?? 'category', from: flags.from, to: flags.to })
  }
  if (command === 'list') {
    const page = paginate(load(words[0]), Number(flags.page ?? 1), Number(flags.size ?? 10))
    const lines = page.items.map((row) => `${row.date}  ${row.category.padEnd(10)}  ${formatCents(toCents(row.amount)).padStart(10)}  ${row.note}`)
    lines.push(`page ${page.page} of ${page.pages}, ${page.total} rows`)
    return lines.join('\n')
  }
  if (command === 'check') {
    const rows = load(words[0])
    const bad = rows.filter((row) => !row.date || !row.category || !row.amount)
    return bad.length ? `${bad.length} of ${rows.length} rows are incomplete` : `all ${rows.length} rows are complete`
  }
  throw new RangeError(`unknown command "${command}"`)
}

try {
  console.log(main(process.argv.slice(2)))
} catch (e) {
  console.error(`error: ${e.message}`)
  process.exitCode = 2
}
