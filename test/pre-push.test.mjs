// Tests for the check before a push that git runs: the folder of hooks that "widal connect" sets as
// git's global core.hooksPath, the hooks of a repository that still run through it, the check of the
// commits a push sends, the stop without a terminal, the question in a person's terminal, the
// question of an agent's hook that counts once, a check that does not finish, the repositories that
// set core.hooksPath for themselves, and "widal disconnect". With made-up repositories and remotes in
// temp folders, and real pushes. Run: node --test
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'widal-code-pre-push-test-')))
process.env.HOME = join(dir, 'person')
process.env.WIDAL_HOME = join(dir, 'home')
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
process.env.CODEX_HOME = join(dir, 'codex')
process.env.WIDAL_COWORK_DIR = join(dir, 'cowork')
// git's global config is a file of each test (fresh), and the computer's own config is not read.
process.env.GIT_CONFIG_GLOBAL = join(dir, 'gitconfig')
process.env.GIT_CONFIG_NOSYSTEM = '1'
for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' })) process.env[k] = v
// The shell of an agent counts as no terminal. Each test says for itself whether it runs in one.
for (const name of ['CLAUDECODE', 'GEMINI_CLI', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED']) delete process.env[name]
mkdirSync(process.env.HOME, { recursive: true })

const hooks = await import('../src/git-hooks.mjs')
const prePushModule = await import('../src/pre-push.mjs')
const { prePush, addedLines, askedBefore, noteAsked, PUSH_LIMITS, STOP, ASKED_FOR } = prePushModule
const security = await import('../src/security.mjs')
const { readFindings, saveFindings } = await import('../src/findings.mjs')
const { makeFinding } = await import('../src/rules.mjs')
const { setSetting } = await import('../src/settings.mjs')

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[/\\]$/, '')
const WIDAL = join(ROOT, 'cli', 'widal.mjs')
const NOW = Date.parse('2026-11-20T12:00:00')
// A made-up key, put together here so that this file does not hold it whole.
const AWS_KEY = `AKIA${'Z7X3Q9W2E5R8T1Y4'}`

let n = 0
/** A fresh state: its own folder of Widal.Code, its own config folder of Claude Code, and its own global git config. */
function fresh() {
  const base = join(dir, `state-${++n}`)
  process.env.WIDAL_HOME = join(base, 'widal')
  process.env.CLAUDE_CONFIG_DIR = join(base, 'claude')
  process.env.GIT_CONFIG_GLOBAL = join(base, 'gitconfig')
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
  return base
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function write(root, files) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), text)
  }
}
function commit(root, files, message = 'change') {
  write(root, files)
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', message)
  return git(root, 'rev-parse', 'HEAD')
}
/** A repository with a bare remote "origin" that has its first commit, made before the hooks are set. */
function project(files = { 'README.md': 'hello\n' }) {
  const base = realpathSync(mkdtempSync(join(dir, 'project-')))
  const remote = join(base, 'remote.git')
  const root = join(base, 'work')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  commit(root, files, 'first')
  git(root, 'remote', 'add', 'origin', remote)
  git(root, 'push', '-q', 'origin', 'main')
  return { base, root, remote }
}
/** A hook of the repository's own, in .git/hooks. */
function ownHook(root, name, body, mode = 0o755) {
  const file = join(root, '.git', 'hooks', name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, mode)
}
/** "widal connect" for git, with this checkout's command. */
const connect = (more = {}) => hooks.connectGitHooks({ command: WIDAL, node: process.execPath, cwd: dir, ...more })
/** A push from a script: no terminal. */
function push(root, args = ['origin', 'main'], env = {}) {
  const r = spawnSync('git', ['-C', root, 'push', ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}
/** What the remote has on a branch, or undefined. */
const remoteHas = (remote, branch = 'main') => spawnSync('git', ['-C', remote, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`], { encoding: 'utf8' }).stdout.trim() || undefined
/** The lines Widal.Code printed in what a push printed: each line that starts with its name, and the lines of risks after it. */
function widalLines(text) {
  const lines = text.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('Widal.Code')) continue
    out.push(lines[i])
    while (i + 1 < lines.length && /^( {2}\S|See them with)/.test(lines[i + 1])) out.push(lines[++i])
  }
  return out
}

test('"widal connect" for git: a script for every hook in a folder of its own, git\'s global core.hooksPath set to it, and the value from before put back at "disconnect"', () => {
  fresh()
  const folder = hooks.hooksDir()
  const out = connect()
  assert.equal(hooks.globalHooksPath(), folder)
  assert.match(out[0], /^Set git's global core\.hooksPath to .*git-hooks: git runs the check before a push for every push from this computer, by an agent or by you\. Each repository's own hooks still run\.$/)
  for (const name of [...hooks.HOOKS, hooks.CHECK]) assert.ok(statSync(join(folder, name)).mode & 0o100, name)
  for (const name of ['pre-commit', 'pre-push', 'reference-transaction', 'push-to-checkout', 'post-index-change', 'p4-pre-submit']) assert.ok(hooks.HOOKS.includes(name), name)
  // git never looks for fsmonitor-watchman in a hooks folder.
  assert.equal(existsSync(join(folder, 'fsmonitor-watchman')), false)
  // A second run renews the scripts.
  assert.match(connect()[0], /^The check before a push was already set: git's global core\.hooksPath is .*git-hooks\. Its scripts are renewed\.$/)
  assert.deepEqual(hooks.disconnectGitHooks(), ['Took git\'s global core.hooksPath out again: git runs each repository\'s own hooks.', 'Removed the check before a push.'])
  assert.equal(hooks.globalHooksPath(), undefined)
  assert.equal(existsSync(folder), false)

  // A value from before stays through two runs of connect, and comes back.
  execFileSync('git', ['config', '--global', 'core.hooksPath', '~/my-hooks'])
  assert.ok(connect().includes('It was ~/my-hooks before. The hooks there still run, and "widal disconnect" puts that value back.'))
  assert.equal(connect().some((line) => line.startsWith('It was')), false)
  assert.equal(hooks.disconnectGitHooks()[0], 'Put git\'s global core.hooksPath back to ~/my-hooks.')
  assert.equal(hooks.globalHooksPath(), '~/my-hooks')
  // A value that the person set after connect stays.
  connect()
  execFileSync('git', ['config', '--global', 'core.hooksPath', '/elsewhere'])
  assert.equal(hooks.disconnectGitHooks()[0], 'git\'s global core.hooksPath is /elsewhere now, not Widal.Code\'s folder, so it stays as it is.')
  assert.equal(hooks.globalHooksPath(), '/elsewhere')
  // A file of the person's in the folder stays, and so does the folder.
  execFileSync('git', ['config', '--global', '--unset', 'core.hooksPath'])
  connect()
  writeFileSync(join(folder, 'mine'), 'x')
  hooks.disconnectGitHooks()
  assert.deepEqual(readdirSync(folder), ['mine'])
})

test('the repository\'s own hooks still run, with the same arguments and input: pre-commit and pre-push in .git/hooks, and the hooks of the global core.hooksPath from before', () => {
  fresh()
  const { root, remote } = project()
  const marks = mkdtempSync(join(dir, 'marks-'))
  ownHook(root, 'pre-commit', `echo "pre-commit $#" >> '${marks}/log'`)
  ownHook(root, 'commit-msg', `echo "commit-msg $(cat "$1")" >> '${marks}/log'`)
  ownHook(root, 'pre-push', `echo "pre-push $1 $2" >> '${marks}/log'; cat >> '${marks}/refs'`)
  connect()
  const before = git(root, 'rev-parse', 'HEAD')
  const head = commit(root, { 'a.txt': 'a\n' }, 'add a')
  const r = push(root)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(join(marks, 'log'), 'utf8'), `pre-commit 0\ncommit-msg add a\npre-push origin ${remote}\n`)
  // The refs on the input, exactly as git gave them.
  assert.equal(readFileSync(join(marks, 'refs'), 'utf8'), `refs/heads/main ${head} refs/heads/main ${before}\n`)
  assert.equal(remoteHas(remote), head)
  // The repository's own pre-push stops a push, before the check.
  ownHook(root, 'pre-push', 'echo "own hook says no" >&2; exit 3')
  commit(root, { 'b.txt': 'b\n' })
  const stopped = push(root)
  assert.notEqual(stopped.status, 0)
  assert.match(stopped.stderr, /own hook says no/)
  assert.equal(remoteHas(remote), head)
  // A hook that is not executable is not run, as git does.
  ownHook(root, 'pre-push', 'exit 3', 0o644)
  assert.equal(push(root).status, 0)

  // The hooks of the global core.hooksPath that was set before "widal connect" keep running.
  const base = fresh()
  const theirs = join(base, 'their-hooks')
  mkdirSync(theirs)
  writeFileSync(join(theirs, 'pre-commit'), `#!/bin/sh\necho "their pre-commit" >> '${marks}/theirs'\n`)
  chmodSync(join(theirs, 'pre-commit'), 0o755)
  execFileSync('git', ['config', '--global', 'core.hooksPath', theirs])
  connect()
  commit(root, { 'c.txt': 'c\n' })
  assert.equal(readFileSync(join(marks, 'theirs'), 'utf8'), 'their pre-commit\n')
})

test('a push to a checked-out branch with receive.denyCurrentBranch=updateInstead still updates the working tree there, and is refused while it has changes', () => {
  const base = fresh()
  connect()
  const target = join(base, 'target')
  execFileSync('git', ['init', '-q', '-b', 'main', target])
  commit(target, { 'one.txt': '1\n' })
  git(target, 'config', 'receive.denyCurrentBranch', 'updateInstead')
  const work = join(base, 'clone')
  execFileSync('git', ['clone', '-q', target, work])
  commit(work, { 'two.txt': '2\n' })
  const r = push(work)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(join(target, 'two.txt'), 'utf8'), '2\n')
  writeFileSync(join(target, 'one.txt'), 'changed\n')
  commit(work, { 'three.txt': '3\n' })
  const refused = push(work)
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /Working directory has unstaged changes/)
  assert.equal(existsSync(join(target, 'three.txt')), false)
})

test('a push without a terminal stops while a high risk is in its commits: it names the risks and "widal check", and says nothing of how to skip the check', () => {
  fresh()
  const { root, remote } = project()
  connect()
  const before = remoteHas(remote)
  commit(root, { 'config.js': `const key = '${AWS_KEY}'\n` })
  const r = push(root)
  assert.equal(r.status, 1)
  assert.deepEqual(widalLines(r.stderr), ['Widal.Code stopped this push. 1 high risk is open in this repository:', '  A secret key is in the code: config.js:1', 'See them with: widal check'])
  assert.doesNotMatch(r.stderr, /no-verify|skip|terminal/i)
  assert.equal(remoteHas(remote), before)
  // The finding is in the findings file, without the key, and "widal check" lists it.
  const found = readFindings().filter((f) => f.scope === `push:${root}`)
  assert.deepEqual(found.map((f) => [f.rule, f.kind, f.severity, f.status, f.where.file, f.where.line]), [['code.secret', 'code', 'high', 'open', 'config.js', 1]])
  assert.match(found[0].detail, /^The kind of key: AWS access key id\. Found by Widal\.Code's own patterns\. In a commit of a push\.$/)
  assert.equal(readFileSync(join(process.env.WIDAL_HOME, 'findings.json'), 'utf8').includes(AWS_KEY), false)
  const check = spawnSync(process.execPath, [WIDAL, 'check'], { cwd: root, encoding: 'utf8', env: process.env })
  assert.match(check.stdout, /^ {2}high +A secret key is in the code\n.*In a commit of a push\.\n +where: config\.js:1, in /m)
  // The same from an agent's shell. Once the key is gone from the commits, the push goes ahead and the finding is resolved.
  assert.equal(push(root, ['origin', 'main'], { CLAUDECODE: '1' }).status, 1)
  git(root, 'reset', '-q', '--hard', 'HEAD~1')
  commit(root, { 'config.js': 'const key = process.env.KEY\n' })
  const clean = push(root)
  assert.deepEqual([clean.status, widalLines(clean.stderr)], [0, []])
  assert.deepEqual(readFindings().filter((f) => f.scope === `push:${root}`).map((f) => f.status), ['resolved'])
})

test('the commits a push sends: a key that one commit adds and the next takes out counts, a key the remote already has does not, nor one below node_modules', () => {
  fresh()
  const { root, remote } = project({ 'old.py': `OLD = "${AWS_KEY}"\nx = 1\n` })
  connect()
  // A change of another line of a file whose key the remote already has: nothing new.
  commit(root, { 'old.py': `OLD = "${AWS_KEY}"\nx = 2\n` })
  commit(root, { 'node_modules/pkg/index.js': `module.exports = '${AWS_KEY}'\n` })
  assert.equal(push(root).status, 0)
  // Added and taken out again: the push still sends it in the history.
  commit(root, { 'app.py': `KEY = "${AWS_KEY}"\n` })
  commit(root, { 'app.py': 'KEY = os.environ["KEY"]\n' })
  const r = push(root)
  assert.equal(r.status, 1)
  assert.deepEqual(widalLines(r.stderr).slice(1, 2), ['  A secret key is in the code: app.py:1'])
  // A new branch counts from where it left a branch of the remote: the remote's main is not sent again.
  git(root, 'reset', '-q', '--hard', remoteHas(remote))
  git(root, 'switch', '-q', '-c', 'feature')
  commit(root, { 'feature.txt': 'new\n' })
  const branch = push(root, ['origin', 'feature'])
  assert.equal(branch.status, 0, branch.stderr)
  assert.equal(remoteHas(remote, 'feature'), git(root, 'rev-parse', 'HEAD'))
  // A push that deletes a branch sends no commit.
  assert.equal(push(root, ['origin', '--delete', 'feature']).status, 0)
})

test('with no high risk open the push goes ahead and Widal.Code prints nothing; a medium or low risk does not stop it, and the gate setting turns the check off', () => {
  fresh()
  const { root, remote } = project()
  connect()
  commit(root, { 'settings.json': '{ "url": "http://example.com/api" }\n' })
  const r = push(root)
  assert.deepEqual([r.status, widalLines(r.stderr)], [0, []])
  assert.deepEqual(readFindings().filter((f) => f.scope === `push:${root}`).map((f) => [f.rule, f.severity]), [['code.http', 'low']])
  // Off: no check at all.
  setSetting('security.checks.push', 'off')
  const head = commit(root, { 'key.txt': `${AWS_KEY}\n` })
  assert.equal(push(root).status, 0)
  assert.equal(remoteHas(remote), head)
  setSetting('security.checks.push', 'on')
})

test('a high risk that an agent\'s session found before counts too, though the push itself sends nothing risky', () => {
  fresh()
  const { root } = project()
  connect()
  saveFindings([makeFinding('act.destroy', { key: `${root}:x`, scope: 'session:s1', where: { repo: root, session: 's1' } })], { scope: 'session:s1', kind: 'actions', now: NOW })
  commit(root, { 'a.txt': 'a\n' })
  const r = push(root)
  assert.equal(r.status, 1)
  assert.deepEqual(widalLines(r.stderr), ['Widal.Code stopped this push. 1 high risk is open in this repository:', '  An agent ran a command that deletes infrastructure or data, or deploys to production', 'See them with: widal check'])
})

// The terminal of a person: "script" gives git push one, and types the answer into it.
const hasScript = spawnSync('/bin/sh', ['-c', 'command -v script'], { encoding: 'utf8' }).status === 0
function pushInTerminal(root, answer, env = {}) {
  const command = `git -C '${root}' push origin main`
  const args = process.platform === 'darwin' ? ['-q', '/dev/null', '/bin/sh', '-c', command] : ['-qec', command, '/dev/null']
  const r = spawnSync('script', args, { input: answer, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60e3 })
  return { status: r.status, out: r.stdout.replaceAll('\r', '') }
}

test('in a person\'s terminal the push asks, goes ahead on "y" and stops on anything else; in an agent\'s shell it stops without a question', { skip: !hasScript && 'no "script" program to give git a terminal' }, () => {
  fresh()
  const { root, remote } = project()
  connect()
  const head = commit(root, { 'config.js': `const key = '${AWS_KEY}'\n` })
  const no = pushInTerminal(root, 'n\n')
  assert.match(no.out, /Widal\.Code: 1 high risk is open in this repository:\n {2}A secret key is in the code: config\.js:1\nSee them with: widal check\nPush anyway\? \[y\/N\] /)
  assert.match(no.out, /Widal\.Code stopped this push\./)
  assert.notEqual(remoteHas(remote), head)
  // An agent that runs its commands in a terminal of its own does not get the question.
  const agent = pushInTerminal(root, 'y\n', { CLAUDECODE: '1' })
  assert.doesNotMatch(agent.out, /Push anyway/)
  assert.match(agent.out, /Widal\.Code stopped this push\. 1 high risk is open in this repository:/)
  assert.notEqual(remoteHas(remote), head)
  const yes = pushInTerminal(root, 'y\n')
  assert.match(yes.out, /Push anyway\? \[y\/N\] /)
  assert.equal(yes.status, 0, yes.out)
  assert.equal(remoteHas(remote), head)
})

test('a push that the person allowed at the question of the agent\'s hook goes ahead without a second question; after a "no" the note does not count', () => {
  const base = fresh()
  const { root, remote } = project()
  connect()
  const transcript = join(base, 'session.jsonl')
  const line = (value) => appendFileSync(transcript, `${JSON.stringify(value)}\n`)
  const call = (id, command) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })
  const gate = (id, command = 'git push origin main') => security.gateHook({ tool_name: 'Bash', tool_input: { command }, cwd: root, tool_use_id: id, transcript_path: transcript, hook_event_name: 'PreToolUse' })
  // The first push finds the key and stops: no hook had asked.
  const head = commit(root, { 'config.js': `const key = '${AWS_KEY}'\n` })
  assert.equal(push(root, ['origin', 'main'], { CLAUDECODE: '1' }).status, 1)
  // Now the gate asks in the agent, and notes it. The person says yes: the command runs, and git's check lets the push go.
  call('toolu_01', 'git push origin main')
  assert.equal(gate('toolu_01').hookSpecificOutput.permissionDecision, 'ask')
  const allowed = push(root, ['origin', 'main'], { CLAUDECODE: '1' })
  assert.deepEqual([allowed.status, widalLines(allowed.stderr)], [0, []])
  assert.equal(remoteHas(remote), head)
  // The call ends. A push from another command after it is checked as any other.
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'done' }] } })
  commit(root, { 'more.js': `const key = '${AWS_KEY}'\n` })
  assert.equal(push(root, ['origin', 'main'], { CLAUDECODE: '1' }).status, 1)
  // A "no": the agent writes it as the call's result, so a push from another command after it is stopped.
  call('toolu_02', 'git push origin main')
  assert.ok(gate('toolu_02'))
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: 'The user doesn\'t want to proceed with this tool use.', is_error: true }] } })
  assert.equal(push(root, ['origin', 'main'], { CLAUDECODE: '1' }).status, 1)
  // A note counts for 15 minutes, in the repository it names, and only with the id of a tool call.
  call('toolu_03', 'npm test && git push')
  assert.ok(gate('toolu_03', 'npm test && git push'))
  assert.equal(askedBefore(root), true)
  assert.equal(askedBefore(root, Date.now() + ASKED_FOR + 1000), false)
  assert.equal(askedBefore(join(base, 'other')), false)
  assert.equal(noteAsked({ repos: [root], toolUseId: undefined, transcript }), false)
  assert.equal(noteAsked({ repos: [root], toolUseId: 'toolu_04', transcript: join(base, 'missing.jsonl') }), false)
})

test('a check that does not finish says so in one line and lets the push go, unless a risk found before is open; a check that fails or finds no node lets it go too', () => {
  const base = fresh()
  const { root } = project()
  const head = commit(root, { 'config.js': `const key = '${AWS_KEY}'\n` })
  const input = `refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n`
  const r = prePush({ remote: 'origin', input, cwd: root, limits: { ...PUSH_LIMITS, ms: 0 }, terminal: () => undefined })
  assert.deepEqual(r, { code: 0, say: ['Widal.Code: the check of this push\'s commits did not finish in 0 seconds. Only the risks found before count.'] })
  // A commit that git does not have: the line says so.
  const unknown = prePush({ remote: 'origin', input: `refs/heads/main ${'1'.repeat(40)} refs/heads/main ${'0'.repeat(40)}\n`, cwd: root, terminal: () => undefined })
  assert.deepEqual(unknown, { code: 0, say: ['Widal.Code: the check of this push\'s commits did not finish because git could not read the commits. Only the risks found before count.'] })
  // A finding of the code from before still counts.
  saveFindings([makeFinding('code.tls-off', { key: `${root}:x`, scope: `repo:${root}`, where: { repo: root, file: 'x.py', line: 1 } })], { scope: `repo:${root}`, kind: 'code', now: NOW })
  assert.equal(prePush({ remote: 'origin', input, cwd: root, limits: { ...PUSH_LIMITS, ms: 0 }, terminal: () => undefined }).code, STOP)
  // Through git: a command that fails, and no node at all.
  fresh()
  connect({ command: join(base, 'not-there.mjs') })
  const failed = push(root)
  assert.equal(failed.status, 0)
  assert.match(failed.stderr, /^Widal\.Code: the check before this push did not finish\. The push goes ahead\.$/m)
  // A PATH with git and cat, and no node.
  const noNodePath = mkdtempSync(join(dir, 'path-'))
  for (const program of ['git', 'cat']) symlinkSync(execFileSync('/bin/sh', ['-c', `command -v ${program}`], { encoding: 'utf8' }).trim(), join(noNodePath, program))
  connect({ node: join(base, 'no-node') })
  commit(root, { 'b.txt': 'b\n' })
  const noNode = push(root, ['origin', 'main'], { PATH: noNodePath })
  assert.equal(noNode.status, 0, noNode.stderr)
  assert.match(noNode.stderr, /^Widal\.Code: the check before this push did not run: node was not found\.$/m)
})

test('the check calls no network, starts no program but git, and writes nothing but the findings file', () => {
  fresh()
  const { root } = project()
  const head = commit(root, { 'config.js': `const key = '${AWS_KEY}'\n`, 'main.tf': 'resource "aws_s3_bucket" "b" {\n  acl = "public-read"\n}\n' })
  const source = readFileSync(join(ROOT, 'src', 'pre-push.mjs'), 'utf8')
  assert.doesNotMatch(source, /from 'node:(http|https|net|tls|dns|dgram|http2)'|fetch\(/)
  assert.deepEqual([...source.matchAll(/(?:execFileSync|spawnSync|spawn|execSync|exec)\(\s*'([^']+)'/g)].map((m) => m[1]), ['git'])
  /** Every file below a folder with its size and time of change. */
  const files = (folder) => readdirSync(folder, { recursive: true }).map((name) => join(folder, name)).filter((p) => statSync(p).isFile()).map((p) => `${p} ${statSync(p).size} ${statSync(p).mtimeMs}`).sort()
  mkdirSync(process.env.WIDAL_HOME, { recursive: true })
  const before = { repo: files(root), widal: files(process.env.WIDAL_HOME) }
  const r = spawnSync(process.execPath, [WIDAL, 'hook', 'pre-push', 'origin', 'x'], { cwd: root, input: `refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n`, encoding: 'utf8', env: process.env })
  assert.equal(r.status, STOP)
  assert.deepEqual(files(root), before.repo)
  assert.deepEqual(files(process.env.WIDAL_HOME).map((line) => line.split(' ')[0]), [join(process.env.WIDAL_HOME, 'findings.json')])
  // The Terraform file is read as a whole: its public bucket is found, with its line.
  assert.ok(readFindings().some((f) => f.rule === 'code.iac' && f.where.file === 'main.tf' && f.where.line === 2))
})

test('"widal connect" names a repository that sets its own core.hooksPath and gives the line for its pre-push hook, which runs the check there; "doctor" and "disconnect" through the command', () => {
  const base = fresh()
  const home = join(base, 'person')
  mkdirSync(home, { recursive: true })
  const env = { ...process.env, HOME: home, USERPROFILE: home }
  const husky = project()
  const plain = project()
  git(husky.root, 'config', 'core.hooksPath', '.husky/_')
  // The folders where Claude Code ran, as its .claude.json lists them.
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ projects: { [husky.root]: {}, [plain.root]: {}, '/not/there': {} } }))
  const run = (...args) => spawnSync(process.execPath, [WIDAL, ...args], { cwd: base, encoding: 'utf8', env })
  const r = run('connect')
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.split('\n')
  const at = lines.indexOf('Not covered: this repository sets core.hooksPath for itself (husky does that), so git does not run the check before a push there:')
  assert.ok(at > 0, r.stdout)
  assert.equal(lines[at + 1], `  ${husky.root}`)
  assert.equal(lines[at + 2], 'To run the check there too, add this line to the repository\'s own pre-push hook (with husky: .husky/pre-push). On a computer without Widal.Code it does nothing:')
  const teamLine = lines[at + 3].trim()
  assert.equal(teamLine, hooks.teamLine())
  // The line in the team's own hook, as husky runs it: the check runs there too.
  mkdirSync(join(husky.root, '.husky', '_'), { recursive: true })
  writeFileSync(join(husky.root, '.husky', '_', 'pre-push'), `#!/bin/sh\n${teamLine}\necho "the team's own check" >&2\n`)
  chmodSync(join(husky.root, '.husky', '_', 'pre-push'), 0o755)
  commit(husky.root, { 'config.js': `const key = '${AWS_KEY}'\n` })
  const stopped = spawnSync('git', ['-C', husky.root, 'push', 'origin', 'main'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(stopped.status, 1)
  assert.match(stopped.stderr, /Widal\.Code stopped this push\./)
  assert.doesNotMatch(stopped.stderr, /the team's own check/)
  // "doctor" has a row for the check, and "disconnect" takes it out.
  assert.match(run('doctor').stdout, /^Check before a git push +set: git's global core\.hooksPath is .*git-hooks$/m)
  const gone = run('disconnect')
  assert.match(gone.stdout, /^Took git's global core\.hooksPath out again: git runs each repository's own hooks\.\nRemoved the check before a push\.$/m)
  assert.match(run('doctor').stdout, /^Check before a git push +not set \(run: widal connect\)$/m)
  // Without Widal.Code's folder, the line in the team's hook does nothing.
  const without = spawnSync('git', ['-C', husky.root, 'push', 'origin', 'main'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(without.status, 0, without.stderr)
  assert.match(without.stderr, /the team's own check/)
  // In the home folder, the line names the folder through $HOME, so that it fits every person of a team.
  assert.equal(hooks.teamLine(join(process.env.HOME, '.widal', 'git-hooks')), 'if [ -x "$HOME/.widal/git-hooks/widal-push-check" ]; then "$HOME/.widal/git-hooks/widal-push-check" "$@" || exit $?; fi')
})

test('the lines of a patch: an added line that starts with "++", a path with a space and a quote, a deleted file, and the limits', () => {
  const patch = [
    '\0bbb', '', 'diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', '--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-+++ b/not-a-path',
    '\0aaa', '', 'diff --git a/x.txt b/x.txt', '--- /dev/null', '+++ b/x.txt', '@@ -0,0 +1,2 @@', '+++ looks like a header', '+second',
    'diff --git "a/my \\"file\\".txt" "b/my \\"file\\".txt"', '--- /dev/null', '+++ "b/my \\"file\\".txt"\t', '@@ -0,0 +1 @@', '+x', '\\ No newline at end of file',
    'diff --git a/caf\\303\\251.txt b/caf\\303\\251.txt', '--- a/b', '+++ "b/caf\\303\\251.txt"', '@@ -3,0 +4 @@ ctx', '+at four',
  ].join('\n')
  const { files, skipped } = addedLines(patch)
  assert.deepEqual([...files.entries()].map(([path, f]) => [path, f.commit, f.lines]), [
    ['x.txt', 'aaa', [[1, '++ looks like a header'], [2, 'second']]],
    ['my "file".txt', 'aaa', [[1, 'x']]],
    ['café.txt', 'aaa', [[4, 'at four']]],
  ])
  assert.equal(skipped, 0)
  const few = addedLines(patch, { ...PUSH_LIMITS, files: 1 })
  assert.deepEqual([[...few.files.keys()], few.skipped], [['x.txt'], 2])
  const small = addedLines(patch, { ...PUSH_LIMITS, bytes: 10 })
  assert.deepEqual([[...small.files.keys()], small.skipped], [['my "file".txt', 'café.txt'], 1])
})
