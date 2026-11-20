# ledger

A small command line tool that reads a CSV file of expenses and prints reports.

## Install

It needs Node.js 22 or later and nothing else. Run it from this folder:

```
node src/cli.mjs help
```

## Commands

- `ledger report <file> [--by category|month] [--from YYYY-MM-DD] [--to YYYY-MM-DD]`: totals per category or per month
- `ledger list <file> [--page N] [--size N]`: the rows, one page at a time
- `ledger check <file>`: says whether every row has a date, a category and an amount
- `ledger help`: the list of commands

## Data format

The file has a header line and one expense per line:

```
date,category,amount,note
2026-01-15,food,12.50,lunch
```

Dates are calendar days written as YYYY-MM-DD. Amounts are dollars.

## Tests

```
npm test
```
