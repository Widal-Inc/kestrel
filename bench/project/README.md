# ledger

A small command line tool that reads a CSV file of expenses and prints reports.

## Install

It needs Node.js 22 or later and nothing else. Run it from this folder:

```
node src/cli.mjs help
```

## Commands

- `ledger report <file> [--by category]`: totals per category
- `ledger list <file>`: the rows
- `ledger export <file>`: writes the report as a spreadsheet

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
