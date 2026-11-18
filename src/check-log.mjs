// The checks that read a session's log: what the agent did (actions), and, only when the person
// switched it on, what the text of the session holds (data).
//
// The log is read as a whole, line by line, a piece of 1 MB at a time, so that a long session's first
// prompt counts too (the hints read only the last 256 KB, which a long session outgrows). These
// checks run in the background after a turn, so reading the whole log costs the person no time. A
// log larger than 200 MB is read only up to that size.
//
// The privacy rule (the owner allowed a look at the start of a command on 13 Nov 2026, and the
// rest on 14 Nov 2026). For
// the actions, Widal.Code looks at three things in a tool call: the name of the tool, the path of a
// file, and the words of a shell command, which it splits as a shell does. It compares them with the
// rules below, and keeps only which rule matched, when, how often, and for a file its path inside
// the repository. It never keeps, prints or stores a command or any other text. A word that only
// stands in a quoted argument is one word, so `git commit -m "no --force"` is no force push.
//
// The data check reads the user messages and the tool results of the same log, and
// counts what looks like a US social security number, a card number or a secret key. It keeps the
// kind and the count, never what it found.
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { basename } from 'node:path'
import { clock } from './format.mjs'
import { shortPath } from './paths.mjs'
import { makeFinding } from './rules.mjs'

/**
 * A shell command as its simple commands, each a list of words. Quotes and backslashes are taken
 * as a shell takes them, so a quoted argument is one word. The commands of a line are split at
 * "&&", "||", ";", "|", "&" and line breaks. Nothing else of the shell is understood: a command in
 * $(...) stays inside the word it is in.
 */
export function shellCommands(text) {
  const commands = []
  let words = []
  let word = ''
  let inWord = false
  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) commands.push(words)
    words = []
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      word += end < 0 ? text.slice(i + 1) : text.slice(i + 1, end)
      inWord = true
      i = end < 0 ? text.length : end
    } else if (c === '"') {
      inWord = true
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) i++
        word += text[i]
      }
    } else if (c === '\\' && i + 1 < text.length) {
      if (text[i + 1] !== '\n') word += text[i + 1]
      inWord = true
      i++
    } else if (c === ' ' || c === '\t') endWord()
    else if (c === '\n' || c === ';' || c === '|' || c === '&') {
      endCommand()
      if ((c === '|' || c === '&') && text[i + 1] === c) i++
    } else if (c === '#' && !inWord) {
      // A comment runs to the end of the line.
      while (i + 1 < text.length && text[i + 1] !== '\n') i++
    } else {
      word += c
      inWord = true
    }
  }
  endCommand()
  return commands
}

// Words in front of a program that start another program: "sudo rm", "env X=1 git", "npx prisma".
const WRAPPERS = new Set(['sudo', 'command', 'env', 'nohup', 'time', 'exec', 'nice', 'npx', 'bunx', 'pnpx'])

/** A simple command without the assignments and the wrappers in front: `{ program, args }`, the program without its folder. */
export function programOf(words) {
  let i = 0
  for (; i < words.length; i++) {
    const w = words[i]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue
    if (WRAPPERS.has(basename(w))) {
      // The options of a wrapper come before the program, for example "sudo -u x" or "npx -y".
      while (words[i + 1]?.startsWith('-')) i += words[i + 1] === '-u' || words[i + 1] === '-p' ? 2 : 1
      continue
    }
    break
  }
  return { program: words[i] === undefined ? '' : basename(words[i]), args: words.slice(i + 1) }
}

/** The first argument that is no option, and its place, or undefined. Options of git that take a value ("-C dir", "-c k=v") are skipped with it. */
function subcommand(args, withValue = []) {
  for (let i = 0; i < args.length; i++) {
    if (withValue.includes(args[i])) {
      i++
      continue
    }
    if (!args[i].startsWith('-')) return { name: args[i], at: i }
  }
  return undefined
}

// The options of the AWS command line that take a value.
const AWS_VALUE = new Set(['--profile', '--region', '--output', '--endpoint-url', '--query', '--color', '--ca-bundle', '--cli-read-timeout', '--cli-connect-timeout'])

/** Whether a list of arguments has a short option letter, alone ("-f") or among others ("-fu"). */
const shortFlag = (args, letter) => args.some((a) => /^-[A-Za-z]+$/.test(a) && a.slice(1).includes(letter))

// The options of "git commit" and "git push" that take a value in the next word, long and short.
const GIT_VALUE = {
  commit: { long: ['--message', '--file', '--author', '--date', '--template', '--fixup', '--squash', '--cleanup', '--trailer', '--reuse-message', '--reedit-message'], short: 'mFcCt' },
  push: { long: ['--push-option', '--repo', '--receive-pack', '--exec'], short: 'o' },
}

/**
 * The options among the arguments of "git commit" or "git push", without the values of the options
 * that take one: in `git commit -m "--no-verify"` the message is a value, not an option.
 */
function gitOptions(sub, args) {
  const takes = GIT_VALUE[sub] ?? { long: [], short: '' }
  const out = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('-')) continue
    out.push(a)
    if (takes.long.includes(a)) i++
    // A group of short options whose last letter takes a value: "-am" is followed by the message.
    else if (/^-[A-Za-z]+$/.test(a) && takes.short.includes(a.at(-1))) i++
  }
  return out
}

/**
 * The rules about commands that a simple command matches: a list of [rule id, label]. The label is
 * Widal.Code's own name for what matched, such as "Terraform destroy", never words of the command.
 */
export function commandRules(words) {
  const { program, args } = programOf(words)
  const out = []
  if (program === 'git') {
    const sub = subcommand(args, ['-C', '-c', '--git-dir', '--work-tree'])
    const rest = sub ? gitOptions(sub.name, args.slice(sub.at + 1)) : []
    if (sub?.name === 'push' && (rest.includes('--force') || shortFlag(rest, 'f'))) out.push(['act.force-push', 'git push --force'])
    // For "git commit", -n is short for --no-verify. For "git push" it means a dry run.
    if ((sub?.name === 'commit' || sub?.name === 'push') && (rest.includes('--no-verify') || (sub.name === 'commit' && shortFlag(rest, 'n')))) out.push(['act.no-verify', `git ${sub.name} --no-verify`])
  } else if (program === 'curl') {
    const upload = args.some((a, i) => a === '-T' || a === '--upload-file' || a.startsWith('--upload-file=') || a === '-F' || a === '--form' || a.startsWith('--form=')
      || (/^-[A-Za-z]+$/.test(a) && /[TF]/.test(a.slice(1)))
      || (['-d', '--data', '--data-binary', '--data-urlencode'].includes(a) && args[i + 1]?.startsWith('@'))
      || /^(-d|--data|--data-binary|--data-urlencode)=?@/.test(a))
    if (upload) out.push(['act.send-out', 'curl upload'])
  } else if (program === 'scp') out.push(['act.send-out', 'scp'])
  else if (program === 'rsync') {
    // To a host: the last argument that is no option names a host ("host:path", "user@host:path" or "rsync://").
    const target = args.filter((a) => !a.startsWith('-')).at(-1)
    if (target && (/^[^/]*[^/:]:/.test(target) || target.startsWith('rsync://'))) out.push(['act.send-out', 'rsync to a host'])
  } else if (program === 'nc' || program === 'ncat' || program === 'netcat') out.push(['act.send-out', 'nc'])
  else if (program === 'terraform' || program === 'tofu') {
    const sub = subcommand(args)
    if (sub?.name === 'destroy' || (sub?.name === 'apply' && args.includes('-destroy'))) out.push(['act.destroy', 'Terraform destroy'])
  } else if (program === 'kubectl' && subcommand(args, ['-n', '--namespace', '--context'])?.name === 'delete') out.push(['act.destroy', 'kubectl delete'])
  else if (program === 'aws') {
    // The global options that take a value come before the service, for example "--profile work".
    const plain = args.filter((a, i) => !a.startsWith('-') && !AWS_VALUE.has(args[i - 1]))
    const [service, action] = plain
    if (action?.startsWith('delete-') || (service === 's3' && (action === 'rm' || action === 'rb')) || (service === 's3api' && action === 'put-bucket-acl')) out.push(['act.destroy', 'an AWS delete'])
  } else if (program === 'gcloud' && args.filter((a) => !a.startsWith('-')).includes('delete')) out.push(['act.destroy', 'gcloud delete'])
  else if (program === 'vercel') {
    const sub = subcommand(args)
    if (sub?.name === 'rm' || sub?.name === 'remove') out.push(['act.destroy', 'vercel rm'])
    else if (args.includes('--prod')) out.push(['act.destroy', 'a Vercel production deploy'])
  } else if (program === 'prisma') {
    const plain = args.filter((a) => !a.startsWith('-'))
    if (plain[0] === 'migrate' && plain[1] === 'reset') out.push(['act.destroy', 'prisma migrate reset'])
  } else if (program === 'dropdb') out.push(['act.destroy', 'dropdb'])
  return out
}

// Programs that show or load what is in a file. With a secret file as an argument, they read it.
const READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'bat', 'strings', 'xxd', 'od', 'nl', 'base64', 'source', '.', 'vi', 'vim', 'nano'])

/**
 * Whether a path names a file that holds secrets. Examples of a .env file (.env.example, .env.sample,
 * .env.template, .env.dist) hold none, and neither does a public key (.pub).
 */
export function secretFile(path) {
  if (typeof path !== 'string' || !path) return false
  const name = basename(path)
  if (/^\.env(\..+)?$/.test(name)) return !/^\.env\.(example|sample|template|dist)$/.test(name)
  if (/\.(pem|p12)$/i.test(name) || name === '.npmrc' || name === '.netrc') return true
  if (/^id_rsa/.test(name)) return !name.endsWith('.pub')
  return /(^|\/)\.aws\/credentials$/.test(path)
}

/** Whether a path names the settings, the MCP servers or the hooks of an agent. */
export function agentConfigFile(path) {
  if (typeof path !== 'string' || !path) return false
  return /(^|\/)\.claude\/settings[^/]*\.json$/.test(path) || basename(path) === '.mcp.json' || /(^|\/)\.codex\/config\.toml$/.test(path)
    || /(^|\/)hooks\/hooks\.json$/.test(path) || /(^|\/)\.claude\/hooks\//.test(path) || /(^|\/)\.git\/hooks\//.test(path)
}

/** A path for a finding: inside the repository relative to it, in the home folder with "~", else as it is. */
export function pathFor(path, repo, home = homedir()) {
  if (repo && path.startsWith(`${repo}/`)) return path.slice(repo.length + 1)
  return shortPath(path, home)
}

const FILE_TOOLS_READ = new Set(['Read'])
const FILE_TOOLS_WRITE = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const timeOf = (d) => (typeof d?.timestamp === 'string' && Number.isFinite(Date.parse(d.timestamp)) ? Date.parse(d.timestamp) : undefined)

const PIECE = 1 << 20
const MOST = 200 * PIECE

/**
 * The lines of a whole log as objects, one at a time. The file is read a piece at a time, so a long
 * log never sits in memory as a whole. A line that is not JSON is skipped. A log that cannot be read
 * has none.
 */
export function* logLines(transcript) {
  let fd
  try {
    if (!statSync(transcript).isFile()) return
    fd = openSync(transcript, 'r')
  } catch {
    return
  }
  try {
    const buf = Buffer.alloc(PIECE)
    // A letter of more than one byte can sit across the end of a piece: the decoder keeps its first bytes for the next piece.
    const text = new StringDecoder('utf8')
    let rest = ''
    let done = 0
    while (done < MOST) {
      const n = readSync(fd, buf, 0, PIECE, null)
      if (n <= 0) break
      done += n
      const lines = (rest + text.write(buf.subarray(0, n))).split('\n')
      rest = lines.pop()
      for (const line of lines) {
        const d = parse(line)
        if (d !== undefined) yield d
      }
    }
    const d = parse(rest + text.end())
    if (d !== undefined) yield d
  } finally {
    closeSync(fd)
  }
}

/** One line as an object, or undefined for an empty line or one that is not JSON (broken, or still being written). */
function parse(line) {
  if (!line) return undefined
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/**
 * The findings of what the agent did in a session, from its log. `session` is the
 * session's id, `repo` the top folder of its repository (or undefined), `frameworks` the frameworks
 * that count. Each finding of a file names the file. Each finding of a command says how often and
 * when last, and never the command.
 */
export function checkActions({ transcript, session, repo, frameworks = [] }) {
  const scope = `session:${session}`
  const files = new Map()
  const commands = new Map()
  const seen = new Set()
  const note = (map, key, value) => {
    const had = map.get(key)
    map.set(key, had ? { ...value, count: had.count + 1, at: Math.max(had.at ?? 0, value.at ?? 0) || undefined } : { ...value, count: 1 })
  }
  // A read or an edit of a file whose result is an error (denied by a permission rule, or failed)
  // read or changed nothing: it waits here until its result is known. Only the error flag of the
  // result is looked at, never its text. A shell command counts also when it failed, because it may
  // have done part of its work first.
  const pending = []
  const failed = new Set()
  const fileNote = (id, key, at) => (id == null ? note(files, key, { at }) : pending.push({ id, key, at }))
  for (const d of logLines(transcript)) {
    if (d?.type === 'user' && Array.isArray(d.message?.content)) {
      for (const b of d.message.content) if (b?.type === 'tool_result' && b.is_error === true && b.tool_use_id != null) failed.add(b.tool_use_id)
      continue
    }
    if (d?.type !== 'assistant' || !Array.isArray(d.message?.content)) continue
    const at = timeOf(d)
    for (const b of d.message.content) {
      if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue
      if (b.id != null) {
        if (seen.has(b.id)) continue
        seen.add(b.id)
      }
      const path = b.input?.file_path ?? b.input?.notebook_path
      if (FILE_TOOLS_READ.has(b.name) && secretFile(path)) fileNote(b.id, `act.read-secret-file\n${pathFor(path, repo)}`, at)
      else if (FILE_TOOLS_WRITE.has(b.name) && agentConfigFile(path)) fileNote(b.id, `act.self-config\n${pathFor(path, repo)}`, at)
      else if (b.name === 'Bash' && typeof b.input?.command === 'string') {
        for (const words of shellCommands(b.input.command)) {
          for (const [rule, label] of commandRules(words)) note(commands, rule, { at, label })
          const { program, args } = programOf(words)
          if (READERS.has(program)) for (const a of args.filter(secretFile)) note(files, `act.read-secret-file\n${pathFor(a, repo)}`, { at })
        }
      }
    }
  }
  for (const p of pending) if (!failed.has(p.id)) note(files, p.key, { at: p.at })
  const found = []
  const base = repo ? { session, repo } : { session }
  const times = (n) => (n === 1 ? 'once' : `${n} times`)
  for (const [key, v] of files) {
    const [rule, file] = key.split('\n')
    found.push(makeFinding(rule, { key: `${session}:${file}`, scope, frameworks, where: { ...base, file, ...(v.at && { at: v.at }) }, detail: `${times(v.count)} in this session${v.at ? `, the last at ${clock(v.at)}` : ''}.` }))
  }
  for (const [rule, v] of commands) {
    found.push(makeFinding(rule, { key: session, scope, frameworks, where: { ...base, ...(v.at && { at: v.at }) }, detail: `${v.label}: ${times(v.count)} in this session${v.at ? `, the last at ${clock(v.at)}` : ''}.` }))
  }
  return found
}

// The kinds of secret keys that Widal.Code knows without a scanner. Anthropic's keys come before
// OpenAI's, because both start with "sk-".
export const KEY_PATTERNS = [
  ['AWS access key id', /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})\b/g],
  ['Anthropic API key', /\bsk-ant-[a-z]+\d*-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI API key', /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}|\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}/g],
  ['Slack token', /\bxox[abposr]-[0-9A-Za-z-]{10,}/g],
]

/** The kinds of secret keys in a text, each with its count: a Map of kind to count. */
export function keysIn(text) {
  const out = new Map()
  for (const [kind, re] of KEY_PATTERNS) {
    const n = text.match(re)?.length ?? 0
    if (n) out.set(kind, n)
  }
  return out
}

/** Whether a number passes the Luhn check, which every card number passes. */
export function luhn(digits) {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

/**
 * The card numbers in a text: 13 to 19 digits, alone or in groups split by single spaces or dashes,
 * that pass the Luhn check and start like a card of the large networks (2 to 6). A time in
 * milliseconds has 13 digits too, but starts with 1.
 */
export function cardNumbers(text) {
  let n = 0
  for (const m of text.matchAll(/(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g)) {
    const digits = m[0].replace(/[ -]/g, '')
    if (digits.length >= 13 && digits.length <= 19 && /^[2-6]/.test(digits) && luhn(digits)) n++
  }
  return n
}

// A US social security number: three, two and four digits with dashes, without the numbers that are never given out.
const SSN = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g

/** The texts of a user line: what the person wrote and what the tools gave back. */
function userTexts(d) {
  const c = d?.message?.content
  if (typeof c === 'string') return [c]
  if (!Array.isArray(c)) return []
  const out = []
  for (const b of c) {
    if (b?.type === 'text' && typeof b.text === 'string') out.push(b.text)
    else if (b?.type === 'tool_result') {
      if (typeof b.content === 'string') out.push(b.content)
      else if (Array.isArray(b.content)) for (const x of b.content) if (x?.type === 'text' && typeof x.text === 'string') out.push(x.text)
    }
  }
  return out
}

/**
 * The findings of what the text of a session holds, from its log: US social security
 * numbers, card numbers and secret keys, each as a kind and a count. `days` is how long Claude
 * Code keeps the transcript, for the finding's words. The texts stay in memory for this one look.
 */
export function checkData({ transcript, session, repo, frameworks = [], days }) {
  const scope = `session:${session}`
  let ssn = 0
  let cards = 0
  const keys = new Map()
  for (const d of logLines(transcript)) {
    if (d?.type !== 'user') continue
    for (const text of userTexts(d)) {
      ssn += text.match(SSN)?.length ?? 0
      cards += cardNumbers(text)
      for (const [kind, n] of keysIn(text)) keys.set(kind, (keys.get(kind) ?? 0) + n)
    }
  }
  const where = { session, file: shortPath(transcript), ...(repo && { repo }) }
  const kept = days === undefined ? 'Claude Code keeps it for 30 days unless cleanupPeriodDays says otherwise' : `Claude Code keeps it for ${days} days (cleanupPeriodDays)`
  const words = (n, what, kinds = '') => `${n === 1 ? `One ${what}` : `${n} ${what}s`}${kinds} in the user messages and tool results of this session. The transcript holds ${n === 1 ? 'it' : 'them'} in plain text at ${shortPath(transcript)}. ${kept}. Shorten that with: widal apply transcript-days`
  const found = []
  if (ssn) found.push(makeFinding('data.us-ssn', { key: session, scope, frameworks, where, detail: words(ssn, 'US social security number') }))
  if (cards) found.push(makeFinding('data.card-number', { key: session, scope, frameworks, where, detail: words(cards, 'card number') }))
  const nKeys = [...keys.values()].reduce((a, b) => a + b, 0)
  if (nKeys) found.push(makeFinding('data.secret', { key: session, scope, frameworks, where, detail: words(nKeys, 'secret key', ` (${[...keys.keys()].join(', ')})`) }))
  return found
}
