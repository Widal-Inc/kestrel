// Measures the time that the check before a push adds to a push of 50 changed files, for the
// README. It works in a new temp folder, with a made-up home folder and its own global git config,
// so it changes nothing of the person's. Run: node scripts/measure-pre-push.mjs [rounds]
//
// Each round makes a commit that changes the same 50 files (about 40 lines of code each, one new
// line each) and pushes it to a bare repository on the same disk: once with git's global
// core.hooksPath set to Widal.Code's folder ("widal connect"), once without. The order changes from
// round to round. It prints the median of each, their difference, and the median of the check alone
// ("widal hook pre-push", as the hook's script runs it).
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, platform, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WIDAL = join(ROOT, 'cli', 'widal.mjs')
const rounds = Number(process.argv[2] ?? 21)
const base = mkdtempSync(join(tmpdir(), 'widal-code-measure-'))
// Nothing of the person's: home folder, Widal.Code's folder, Claude Code's folder and git's global config are made up.
Object.assign(process.env, {
  HOME: join(base, 'person'), WIDAL_HOME: join(base, 'widal'), CLAUDE_CONFIG_DIR: join(base, 'claude'), CODEX_HOME: join(base, 'codex'),
  GIT_CONFIG_GLOBAL: join(base, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'm', GIT_AUTHOR_EMAIL: 'm@example.com', GIT_COMMITTER_NAME: 'm', GIT_COMMITTER_EMAIL: 'm@example.com',
})
for (const name of ['CLAUDECODE', 'GEMINI_CLI', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED']) delete process.env[name]
mkdirSync(process.env.HOME, { recursive: true })
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const remote = join(base, 'remote.git')
const work = join(base, 'work')
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
execFileSync('git', ['init', '-q', '-b', 'main', work])
const FILES = Array.from({ length: 50 }, (_, i) => join('src', `module-${String(i).padStart(2, '0')}.js`))
const body = (i) => Array.from({ length: 40 }, (_, k) => `export function f${i}_${k}(x) {\n  return x * ${k} + ${i} // line ${k}\n}`).join('\n')
mkdirSync(join(work, 'src'))
FILES.forEach((f, i) => writeFileSync(join(work, f), `${body(i)}\n`))
git(work, 'add', '-A')
git(work, 'commit', '-qm', 'first')
git(work, 'remote', 'add', 'origin', remote)
git(work, 'push', '-q', 'origin', 'main')

const { connectGitHooks, hooksDir } = await import('../src/git-hooks.mjs')
connectGitHooks({ command: WIDAL, node: process.execPath, cwd: base })
// git ends with 5 when it unsets a value that is not set.
const setHooks = (on) => spawnSync('git', ['config', '--global', ...(on ? ['core.hooksPath', hooksDir()] : ['--unset', 'core.hooksPath'])])

let change = 0
/** A commit that changes all 50 files. */
function commit50() {
  change++
  for (const f of FILES) writeFileSync(join(work, f), `${readFileSync(join(work, f), 'utf8')}// change ${change}\n`)
  git(work, 'commit', '-qam', `change ${change}`)
}
/** The milliseconds of one push. */
function timePush() {
  const start = process.hrtime.bigint()
  const r = spawnSync('git', ['-C', work, 'push', '-q', 'origin', 'main'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0) throw new Error(`push failed: ${r.stderr}`)
  return Number(process.hrtime.bigint() - start) / 1e6
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

const times = { off: [], on: [], check: [] }
try {
  for (let i = 0; i < rounds; i++) {
    for (const mode of i % 2 ? ['on', 'off'] : ['off', 'on']) {
      setHooks(mode === 'on')
      commit50()
      times[mode].push(timePush())
    }
    // The check alone, for the newest commit, as the hook's script runs it.
    setHooks(false)
    commit50()
    const head = git(work, 'rev-parse', 'HEAD')
    const start = process.hrtime.bigint()
    const r = spawnSync(process.execPath, [WIDAL, 'hook', 'pre-push', 'origin', remote], { cwd: work, encoding: 'utf8', input: `refs/heads/main ${head} refs/heads/main ${git(work, 'rev-parse', 'origin/main')}\n` })
    times.check.push(Number(process.hrtime.bigint() - start) / 1e6)
    if (r.status !== 0 || r.stderr) throw new Error(`the check said: ${r.status} ${r.stderr}`)
    git(work, 'push', '-q', 'origin', 'main')
  }
} finally {
  rmSync(base, { recursive: true, force: true })
}

const ms = (x) => `${Math.round(x)} ms`
console.log(`${rounds} rounds, a push of one commit that changes 50 files (${FILES.length} files of about 2.4 KB), to a bare repository on the same disk.`)
console.log(`Without the check: ${ms(median(times.off))}. With the check: ${ms(median(times.on))}. Added: ${ms(median(times.on) - median(times.off))} (medians).`)
console.log(`The check alone ("widal hook pre-push"): ${ms(median(times.check))}.`)
console.log(`Machine: ${cpus()[0]?.model ?? 'unknown CPU'}, ${cpus().length} cores, ${platform()} ${release()}, node ${process.versions.node}, ${execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()}.`)
