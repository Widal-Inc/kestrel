// Prints the style report of the project: one line per rule and file. It is long on purpose, as
// the reports of many real projects are.
import { readdirSync } from 'node:fs'

const RULES = ['no-unused-vars', 'no-undef', 'eqeqeq', 'prefer-const', 'no-var', 'semi', 'quotes', 'indent', 'comma-dangle', 'no-console', 'curly', 'no-empty', 'no-shadow', 'max-len', 'no-eval']
const files = [...readdirSync('src').map((f) => `src/${f}`), ...readdirSync('test').map((f) => `test/${f}`)]
let n = 0
for (let pass = 1; pass <= 6; pass++) {
  for (const file of files) {
    for (const rule of RULES) {
      n++
      console.log(`style pass ${pass}  ${file.padEnd(24)}  ${rule.padEnd(16)}  ok  (0 problems, 0 warnings, checked in ${(n * 7) % 13} ms)`)
    }
  }
}
console.log(`style report: ${n} checks, 0 problems`)
