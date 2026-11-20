// The check before a push, as git runs it. "widal connect" sets git's global core.hooksPath to a
// folder of Widal.Code's (see git-hooks.mjs), so git runs its pre-push script before every push from
// this computer, whatever started the push: an agent with hooks, an agent without (Aider), a script,
// or a person in a terminal. The script runs "widal hook pre-push <remote> <address>", with the refs
// that git gives a pre-push hook on its input: one line "<local ref> <local id> <remote ref> <remote
// id>" for each ref.
//
// What the check does:
//   1. It checks the commits that the push sends: those the remote does not have yet, as far as this
//      repository knows (not below the remote's ref, nor on any branch of that remote here). Every
//      line those commits add goes through Widal.Code's own rules, and every Terraform file they
//      change through the rules for Terraform. A key that one commit adds and the next one takes out
//      again is found too: the push sends it in the history. The findings go to the findings file,
//      with the scope "push:<repository>". No scanner runs: a scanner can call the network, and take
//      a minute.
//   2. It takes the open high findings of the code and the actions of the repository, as the gate
//      before a shell command does (security.mjs). With none, the push goes ahead and nothing is
//      printed.
//   3. With one or more:
//      - the push goes ahead when the person already said yes to it at the question of an agent's
//        own hook (see noteAsked), so that one push gets one question;
//      - in a person's terminal, it asks, and the push goes ahead on "y";
//      - else (the shell of an agent, a script) it stops the push, and names the risks and the
//        command that lists them. It never says how to skip the check.
//
// It calls no network, starts no program but git, and writes nothing but the findings file. A time
// limit holds the whole check. A check that does not finish says so in one line. Then only the
// findings that were open before count, so a check that fails never stops a push on its own.
import { execFileSync } from 'node:child_process'
import { closeSync, fstatSync, mkdirSync, openSync, readSync, statSync, writeSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { LIMITS, ownLineRules, terraformRules } from './check-code.mjs'
import { config, readJson, writeJson } from './config.mjs'
import { openFindings, saveFindings } from './findings.mjs'
import { plain } from './format.mjs'
import { repoOf } from './git.mjs'
import { home } from './paths.mjs'
import { makeFinding } from './rules.mjs'
import { frameworksFor, securityConfig } from './settings.mjs'

/**
 * The exit code of "widal hook pre-push" that stops the push. The hook's script turns it into 1 for
 * git. Any other code but 0 means that the check itself failed, and the script lets the push go.
 */
export const STOP = 10

/** The limits of the check: at most so many files, so many bytes of added lines per file, and so much time for the whole check. */
export const PUSH_LIMITS = { files: LIMITS.files, bytes: LIMITS.bytes, ms: 10e3 }

/** How long the question of an agent's hook counts for a push. */
export const ASKED_FOR = 15 * 60e3

/**
 * The variables that agents set in the shell where they run commands. A shell with one of them
 * counts as no terminal, also when the agent runs it in a terminal of its own: the agent, not the
 * person, would get the question.
 */
export const AGENT_SHELL = ['CLAUDECODE', 'GEMINI_CLI', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED']

const ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const NONE = /^0+$/
const NODE_MODULES = /(^|\/)node_modules(\/|$)/

/** The refs of a push, from the input git gives a pre-push hook. A ref that the push deletes sends no commit, and is left out. */
export function pushedRefs(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const [localRef, local, remoteRef, remote] = line.trim().split(' ')
    if (!localRef || !remoteRef || !ID.test(local ?? '') || !ID.test(remote ?? '') || NONE.test(local)) continue
    out.push({ localRef, local, remoteRef, remote })
  }
  return out
}

/** Runs git in a repository within `timeout` milliseconds, and gives its output. It throws when git fails or runs out of time. A repository's own config cannot start a program here. */
function git(repo, args, { timeout, input } = {}) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-C', repo, ...args], {
    encoding: 'utf8',
    input,
    timeout: Math.max(1, Math.ceil(timeout)),
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
  })
}

/** A path as git quotes it in a patch ("a\tb" with C escapes), as the text it stands for. */
function unquote(quoted) {
  const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
  const chars = [...quoted.slice(1, -1)]
  const bytes = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== '\\') {
      bytes.push(...Buffer.from(chars[i]))
      continue
    }
    const c = chars[++i]
    if (c === undefined) break
    if (/[0-7]/.test(c)) {
      // Three octal digits: one byte of a letter that git did not print as it is.
      bytes.push(parseInt(chars.slice(i, i + 3).join(''), 8) & 0xff)
      i += 2
    } else bytes.push(...Buffer.from(c in ESCAPES ? String.fromCharCode(ESCAPES[c]) : c))
  }
  return Buffer.from(bytes).toString('utf8')
}

/** The path in a "+++ b/<path>" line of a patch, or undefined for a file that the commit deletes. git ends a path with a space in it with a tab. */
function pathOf(header) {
  let p = header.replace(/\t$/, '')
  if (p === '/dev/null') return undefined
  if (p.startsWith('"') && p.endsWith('"')) p = unquote(p)
  return p.startsWith('b/') ? p.slice(2) : undefined
}

/**
 * The lines that the commits of a patch add (the output of "git log -p --unified=0" with a line
 * "\0<commit>" before each commit): `{ files, skipped }`. `files` maps each path to `{ commit,
 * lines }`, `commit` the newest commit that adds to the file, `lines` its added lines as [line
 * number, text]. Files below node_modules are left out. A file beyond the first `limits.files`, or
 * whose added lines pass `limits.bytes`, is left out and counted in `skipped`. The counts in each
 * hunk's header say which lines belong to it, so an added line that starts with "++" is a line too.
 */
export function addedLines(patch, limits = PUSH_LIMITS) {
  const files = new Map()
  const over = new Set()
  let commit
  let path
  let oldLeft = 0
  let newLeft = 0
  let at = 0
  const take = (text) => {
    if (path === undefined || over.has(path) || NODE_MODULES.test(path)) return
    let f = files.get(path)
    if (!f) {
      if (files.size >= limits.files) {
        over.add(path)
        return
      }
      f = { commit, lines: [], bytes: 0 }
      files.set(path, f)
    }
    f.bytes += Buffer.byteLength(text) + 1
    if (f.bytes > limits.bytes) {
      over.add(path)
      files.delete(path)
      return
    }
    f.lines.push([at, text])
  }
  for (const line of patch.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0]
      if (c === '+' && newLeft > 0) {
        newLeft--
        take(line.slice(1))
        at++
        continue
      }
      if (c === '-' && oldLeft > 0) {
        oldLeft--
        continue
      }
      if (c === ' ' && oldLeft > 0 && newLeft > 0) {
        oldLeft--
        newLeft--
        at++
        continue
      }
      if (c === '\\') continue
      // A line that is not one of the hunk's: the hunk is over.
      oldLeft = newLeft = 0
    }
    if (line.startsWith('\0')) {
      commit = line.slice(1).trim()
      path = undefined
    } else if (line.startsWith('diff --git ')) path = undefined
    else if (line.startsWith('+++ ')) path = pathOf(line.slice(4))
    else {
      const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (hunk) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1])
        at = Number(hunk[2])
        newLeft = hunk[3] === undefined ? 1 : Number(hunk[3])
      }
    }
  }
  return { files, skipped: over.size }
}

/** Of the remote's ids, the commits this repository has: the push sends nothing below them. An annotated tag counts as its commit. */
function knownHere(repo, ids, timeout) {
  const wanted = [...new Set(ids.filter((id) => !NONE.test(id)))]
  if (!wanted.length) return []
  const out = git(repo, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { timeout, input: wanted.map((id) => `${id}^{commit}\n`).join('') })
  return out.split('\n').map((l) => l.split(' ')).filter(([id, type]) => ID.test(id) && type === 'commit').map(([id]) => id)
}

/** Whether a name is a remote of the repository, and not an address. */
function isRemote(repo, name, timeout) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) return false
  try {
    return git(repo, ['config', '--get', `remote.${name}.url`], { timeout }).trim() !== ''
  } catch {
    return false
  }
}

/**
 * Checks the commits that a push sends, within the time limit: `{ done, findings, files, skipped }`.
 * `done` is false when the check did not finish, and `why` then says why in words: out of time, too
 * large, or git failed. Then it found nothing.
 * The commits are those below the local ids and not below what the remote has: the remote's ids that
 * this repository knows, and the branches of the remote here (of every remote when `remote` is an
 * address). For a new branch that is everything since it left a branch of the remote.
 */
export function scanPush({ repo, remote, refs, frameworks = [], limits = PUSH_LIMITS, started = Date.now() }) {
  const left = () => limits.ms - (Date.now() - started)
  const outOfTime = { done: false, why: `in ${limits.ms / 1000} seconds` }
  const scope = `push:${repo}`
  const findings = []
  const add = (rule, file, line, extra, opts) => findings.push(makeFinding(rule, {
    key: `${scope}:${file}:${line ?? 0}${extra ? `:${extra}` : ''}`,
    scope,
    frameworks,
    where: { repo, file, ...(line && { line }) },
    ...opts,
    detail: `${opts.detail} In a commit of a push.`,
  }))
  try {
    const locals = [...new Set(refs.map((r) => r.local))]
    const below = knownHere(repo, refs.map((r) => r.remote), left())
    const others = isRemote(repo, remote, left()) ? `--remotes=${remote}` : '--remotes'
    const patch = git(repo, ['log', '-p', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-show-signature', '--src-prefix=a/', '--dst-prefix=b/', '--format=%x00%H', ...locals, '--not', ...below, others], { timeout: left() })
    const { files, skipped } = addedLines(patch, limits)
    for (const [path, f] of files) {
      if (left() <= 0) return outOfTime
      ownLineRules(path, f.lines, { frameworks, add: (rule, line, extra, opts) => add(rule, path, line, extra, opts) })
    }
    // Terraform's rules look at whole blocks, so they read each file as its newest commit has it.
    for (const [path, f] of files) {
      if (!path.endsWith('.tf')) continue
      const text = git(repo, ['cat-file', 'blob', `${f.commit}:${path}`], { timeout: left() })
      if (Buffer.byteLength(text) > limits.bytes) continue
      for (const [check, line, words, severity] of terraformRules(text)) add('code.iac', path, line, check, { severity, detail: `${words}, found by Widal.Code's own rules for Terraform.` })
    }
    if (left() <= 0) return outOfTime
    return { done: true, findings: [...new Map(findings.map((x) => [x.id, x])).values()], files: files.size, skipped }
  } catch (e) {
    if (e?.code === 'ETIMEDOUT' || left() <= 0) return outOfTime
    return { done: false, why: e?.code === 'ENOBUFS' ? 'because the push is too large to read' : 'because git could not read the commits' }
  }
}

/** The open high findings of the code and the actions in these repositories: the risks before which the gate and the check before a push ask. */
export const highRisks = (repos) => openFindings({ least: 'high' }).filter((f) => (f.kind === 'code' || f.kind === 'actions') && repos.has(f.where?.repo))

/** The risks in lines: how many are open, one line for each of the first five with its file, and the command that lists them. */
export function riskLines(high) {
  const rows = high.slice(0, 5).map((f) => {
    const file = f.where?.file ? `: ${plain(f.where.file)}${f.where.line ? `:${f.where.line}` : ''}` : ''
    return `  ${plain(f.title)}${file}`
  })
  if (high.length > 5) rows.push(`  and ${high.length - 5} more`)
  return [`${high.length === 1 ? '1 high risk is' : `${high.length} high risks are`} open in this repository:`, ...rows, 'See them with: widal check']
}

// The questions of an agent's hook before a push.
//
// The gate (security.mjs) asks in the agent before a push while a high risk is open. When the person
// says yes there, the push runs, and git runs this check: it must not ask again or stop the push. A
// hook only asks. It never learns the answer. So the gate notes each question: the repository, the
// time, the agent's log and the id of the tool call. The check counts a note while the tool call is
// still running, that is while the log holds no result for it yet. When the person says no, the agent
// writes that answer as the call's result, and the note no longer counts: a push from another command
// after a "no" is checked as any other. A note counts for 15 minutes at most.
const askedFile = () => join(home(), 'push-asked.json')
const CALL_ID = /^[A-Za-z0-9_-]{1,100}$/
// Of an agent's log, at most this much after the question is read.
const MOST = 32 * 1024 * 1024

const readAsked = () => {
  const raw = readJson(askedFile(), {})
  return Array.isArray(raw?.asked) ? raw.asked.filter((a) => a && typeof a.repo === 'string' && Number.isFinite(a.at)) : []
}

/**
 * Notes that an agent's hook asked the person about a push from these repositories, in the tool call
 * `toolUseId` of the log `transcript`. Without both, nothing is noted, and the check before the push
 * asks again. Returns whether it noted the question.
 */
export function noteAsked({ repos, toolUseId, transcript, now = Date.now() }) {
  if (!CALL_ID.test(toolUseId ?? '') || typeof transcript !== 'string' || !isAbsolute(transcript) || !transcript.endsWith('.jsonl')) return false
  let offset
  try {
    offset = statSync(transcript).size
  } catch {
    return false
  }
  const kept = readAsked().filter((a) => a.at <= now && now - a.at < ASKED_FOR)
  for (const repo of repos) kept.push({ repo, at: now, toolUseId, transcript, offset })
  mkdirSync(home(), { recursive: true })
  writeJson(askedFile(), { asked: kept.slice(-50) })
  return true
}

/**
 * Whether the tool call of a note still runs: the agent's log holds no result for it after the place
 * where the log ended at the question. A log that cannot be read, or that grew by more than 32 MB
 * since, says no.
 */
export function callRunning({ transcript, toolUseId, offset }) {
  if (!CALL_ID.test(toolUseId ?? '') || typeof transcript !== 'string') return false
  let fd
  try {
    fd = openSync(transcript, 'r')
  } catch {
    return false
  }
  try {
    const size = fstatSync(fd).size
    const from = Number.isInteger(offset) && offset >= 0 && offset <= size ? offset : 0
    if (size - from > MOST) return false
    const buf = Buffer.alloc(size - from)
    let done = 0
    while (done < buf.length) {
      const n = readSync(fd, buf, done, buf.length - done, from + done)
      if (n <= 0) break
      done += n
    }
    for (const line of buf.toString('utf8', 0, done).split('\n')) {
      if (!line.includes(toolUseId)) continue
      let d
      try {
        d = JSON.parse(line)
      } catch {
        continue
      }
      const content = d?.message?.content
      if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result' && b.tool_use_id === toolUseId)) return false
    }
    return true
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}

/** Whether an agent's hook asked the person about a push from this repository, in a tool call that still runs. */
export const askedBefore = (repo, now = Date.now()) => readAsked().some((a) => a.repo === repo && a.at <= now && now - a.at < ASKED_FOR && callRunning(a))

/**
 * The person's terminal, when the push runs in one: `{ ask(text) }`, which writes the question and
 * gives the line typed. Undefined when git's error output is not a terminal, when there is no
 * terminal to read from, and in the shell of an agent (AGENT_SHELL).
 */
export function personTerminal(env = process.env) {
  if (!process.stderr.isTTY || AGENT_SHELL.some((name) => env[name])) return undefined
  let fd
  try {
    fd = openSync('/dev/tty', 'r+')
  } catch {
    return undefined
  }
  return {
    ask(text) {
      try {
        writeSync(fd, text)
        let answer = ''
        const buf = Buffer.alloc(64)
        while (!answer.includes('\n') && answer.length < 256) {
          const n = readSync(fd, buf, 0, buf.length, null)
          if (n <= 0) break
          answer += buf.toString('utf8', 0, n)
        }
        return answer
      } catch {
        return ''
      } finally {
        closeSync(fd)
      }
    },
  }
}

/** The frameworks for a repository: its own file's, else the person's. A broken file counts as none. */
function frameworksOf(cfg, repo) {
  try {
    return frameworksFor(cfg, repo).on
  } catch {
    return securityConfig(cfg).frameworks
  }
}

/**
 * "widal hook pre-push <remote> <address>": the check before a push. `input` is what git gives the
 * hook on its input, and `cwd` the folder git runs it in: the top of the working tree. Returns `{
 * code, say }`: the exit code (0, or STOP to stop the push), and the lines to print on stderr.
 * `terminal` stands in for the person's terminal in a test.
 */
export function prePush({ remote, input, cwd = process.cwd(), env = process.env, now = Date.now(), cfg = config(), limits = PUSH_LIMITS, terminal = personTerminal } = {}) {
  const say = []
  // The gate before a push, in Claude Code and here, is one setting.
  if (!securityConfig(cfg).checks.push) return { code: 0, say }
  const repo = repoOf(cwd)
  const refs = pushedRefs(input)
  if (!repo || !refs.length) return { code: 0, say }
  const scan = scanPush({ repo, remote, refs, frameworks: frameworksOf(cfg, repo), limits })
  if (scan.done) saveFindings(scan.findings, { scope: `push:${repo}`, kind: 'code', now })
  else say.push(`Widal.Code: the check of this push's commits did not finish ${scan.why}. Only the risks found before count.`)
  const high = highRisks(new Set([repo]))
  if (!high.length || askedBefore(repo, now)) return { code: 0, say }
  const lines = riskLines(high)
  const tty = terminal(env)
  if (tty) {
    const answer = tty.ask(`Widal.Code: ${lines.join('\n')}\nPush anyway? [y/N] `)
    if (/^\s*y(es)?\s*$/i.test(answer)) return { code: 0, say }
    return { code: STOP, say: [...say, 'Widal.Code stopped this push.'] }
  }
  return { code: STOP, say: [...say, `Widal.Code stopped this push. ${lines[0]}`, ...lines.slice(1)] }
}
