#!/usr/bin/env node
// Builds the two files for the Claude desktop app, in dist/, or in the folder given as the first
// argument:
//   - kestrel.mcpb, the desktop extension: a zip with manifest.json, icon.png, package.json, cli/
//     and src/ at its top, as the extension format asks. A person drags it onto Settings,
//     Extensions in the app.
//   - kestrel-skill.zip, the skill: a zip with the folder widal-code/ at its top and SKILL.md in it,
//     for an upload under Customize, Skills.
// It uses the system's zip command. Nothing else goes in: no tests, no research files, no .git.
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tools } from '../src/mcp.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const json = (file) => JSON.parse(readFileSync(file, 'utf8'))

function fail(message) {
  console.error(`build-desktop: ${message}`)
  process.exit(1)
}

// The manifest repeats two things that are kept elsewhere: the version, and the names and
// descriptions of the tools. A build that would ship them out of step stops here.
const manifest = json(join(ROOT, 'desktop', 'manifest.json'))
const { version } = json(join(ROOT, 'package.json'))
if (manifest.version !== version) fail(`desktop/manifest.json has the version ${manifest.version}, and package.json has ${version}. Make them the same.`)
const served = tools().map(({ name, description }) => ({ name, description }))
if (JSON.stringify(manifest.tools) !== JSON.stringify(served)) fail('The tools in desktop/manifest.json are not those of src/mcp.mjs, with the same names and descriptions in the same order.')

/** Makes the zip `file` in the folder `cwd`, with `entries` and everything below them. */
function zip(file, cwd, entries) {
  // -r: a folder with everything in it. -X: no extra file attributes. -D: no entries for the
  // folders themselves, only for the files.
  const r = spawnSync('zip', ['-q', '-r', '-X', '-D', file, ...entries, '-x', '*.DS_Store'], { cwd, encoding: 'utf8' })
  if (r.error || r.status !== 0) fail(`zip failed: ${r.error?.message ?? r.stderr.trim()}`)
}

const out = resolve(process.argv[2] ?? join(ROOT, 'dist'))
mkdirSync(out, { recursive: true })
// The files are put together in a new temp folder first, for two reasons: the icon has another
// name in the extension, and zip adds to an archive that is already there instead of making a
// new one. The temp folder is left in the system's temp folder.
const stage = mkdtempSync(join(tmpdir(), 'widal-code-desktop-'))
const bundle = join(stage, 'widal-code')
mkdirSync(bundle)
copyFileSync(join(ROOT, 'desktop', 'manifest.json'), join(bundle, 'manifest.json'))
copyFileSync(join(ROOT, 'assets', 'widal-code-512.png'), join(bundle, 'icon.png'))
copyFileSync(join(ROOT, 'package.json'), join(bundle, 'package.json'))
// Hidden files, such as .DS_Store on a Mac, stay out.
for (const dir of ['cli', 'src']) cpSync(join(ROOT, dir), join(bundle, dir), { recursive: true, filter: (path) => !basename(path).startsWith('.') })
zip(join(stage, 'kestrel.mcpb'), bundle, ['.'])
zip(join(stage, 'kestrel-skill.zip'), join(ROOT, 'desktop', 'skill'), ['widal-code'])
for (const name of ['kestrel.mcpb', 'kestrel-skill.zip']) {
  copyFileSync(join(stage, name), join(out, name))
  console.log(`${join(out, name)}  ${statSync(join(out, name)).size} bytes`)
}
