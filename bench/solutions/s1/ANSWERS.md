# Answers

## 1. The functions that work with dates

Both are in `src/dates.mjs`:

- `monthKey(date)` gives the month of a date. `buildReport` in `src/report.mjs` calls it to group the rows by month.
- `inRange(date, from, to)` says whether a date is inside a range. `buildReport` in `src/report.mjs` calls it for every row, to leave out the rows outside `--from` and `--to`.

The command line in `src/cli.mjs` does not call them itself. It passes `--from`, `--to` and `--by` to `buildReport`.

## 2. Amounts from text to cents and back

Both directions are in `src/money.mjs`:

- `toCents(text)` turns text such as "12.34" into cents. `buildReport` in `src/report.mjs` uses it for every row, and the command `list` in `src/cli.mjs` uses it before it prints a row.
- `formatCents(cents)` turns cents into text such as "$12.34". `buildReport` uses it for each line and for the total, and the command `list` uses it for each row.

So the commands `report` and `list` use both. The commands `check` and `help` use neither.

## 3. What each command runs

All commands start in `main` in `src/cli.mjs`, which calls `parseArgs` for the flags.

- `report`: `load` in `src/cli.mjs`, which calls `parseCsv` in `src/csv.mjs`, then `buildReport` in `src/report.mjs`, which calls `inRange` and `monthKey` in `src/dates.mjs` and `toCents` and `formatCents` in `src/money.mjs`.
- `list`: `load` and `parseCsv`, then `paginate` in `src/paginate.mjs`, then `toCents` and `formatCents` in `src/money.mjs` for each row.
- `check`: `load` and `parseCsv`, then it counts the rows without a date, a category or an amount.
- `help`: no function. It returns the help text.
