// Writes the runs of a benchmark folder as records that may be shared, one per line.
//
//   node bench/export.mjs --out <folder> [--to <file>]
//
// The file is <folder>/records.jsonl unless --to names another one. bench/record.mjs says what a
// record holds. Runs that do not count (a "void" reason) are left out. Nothing is sent anywhere.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ARMS } from './arms.mjs'
import { flags, outDir, paths, readJson, runsOf } from './lib.mjs'
import { publicRecord } from './record.mjs'

const f = flags()
const out = outDir(f)
const P = paths(out)
const to = typeof f.to === 'string' ? f.to : join(out, 'records.jsonl')

const lines = []
for (const arm of ARMS) {
  // A run from before the settings were kept in its record gets them from the arm's settings file.
  const kept = readJson(P.settings(arm.id))
  for (const run of runsOf(out, arm.id)) lines.push(JSON.stringify(publicRecord(run, run.settings ?? kept)))
}
writeFileSync(to, lines.map((line) => `${line}\n`).join(''))
console.log(`${lines.length} records are in ${to}`)
