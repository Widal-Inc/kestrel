// The check of the code that an agent changed: the files of the session's repository that differ
// from HEAD, and the files git does not know yet. git's own command gives the list.
//
// At most 200 files and 2 MB per file are read. Binary files and everything below node_modules are
// skipped. The text of a file stays in memory for this one check.
//
// Outside programs check the code when they are installed, and Widal.Code's own rules do it when they
// are not:
//   - infrastructure code (Terraform, CloudFormation, Kubernetes YAML, Dockerfiles): Checkov, Trivy
//     ("trivy config") or KICS, the first one found, with a time limit of 60 seconds. Without one,
//     or when it fails or runs out of time, Widal.Code's own rules for Terraform;
//   - secret keys: gitleaks, with the same time limit, else Widal.Code's own patterns.
// A finding says which program found it. It names the file, the line and the kind of thing, and
// never what was matched. gitleaks runs with --redact, so not even its output holds a key.
import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, openSync, readFileSync, readSync, closeSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, isAbsolute, join, relative } from 'node:path'
import { cardNumbers, keysIn, programOf, shellCommands } from './check-log.mjs'
import { isLocalHost } from './check-settings.mjs'
import { makeFinding, ruleOn, RULES } from './rules.mjs'

export const LIMITS = { files: 200, bytes: 2 * 1024 * 1024, ms: 60e3 }

/** Runs git in a repository and gives its output, or undefined when it fails. A repository's own config cannot start a program here. */
function git(root, args) {
  try {
    return execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return undefined
  }
}

/** Whether the first 8000 bytes of a file hold a zero byte, as binary files do. */
function binary(file) {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(8000)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).includes(0)
  } finally {
    closeSync(fd)
  }
}

/**
 * The files an agent changed in a repository: `{ files, skipped }`. Each file is `{ path, abs, text }`,
 * `path` relative to the repository. Without a first commit, every file that git knows counts.
 * `limits` stands in for the limits in a test.
 */
export function changedFiles(root, limits = LIMITS) {
  const tracked = git(root, ['diff', '--no-ext-diff', '--name-only', '-z', 'HEAD']) ?? git(root, ['ls-files', '-z']) ?? ''
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']) ?? ''
  const names = [...new Set(`${tracked}\0${untracked}`.split('\0').filter(Boolean))].filter((p) => !/(^|\/)node_modules(\/|$)/.test(p)).sort()
  const files = []
  let skipped = Math.max(0, names.length - limits.files)
  for (const path of names.slice(0, limits.files)) {
    const abs = join(root, path)
    try {
      // A link is not followed: it can point outside the repository.
      const st = lstatSync(abs)
      if (!st.isFile() || st.size > limits.bytes || binary(abs)) {
        skipped++
        continue
      }
      files.push({ path, abs, text: readFileSync(abs, 'utf8') })
    } catch {
      // Deleted since, or not readable: nothing to check.
    }
  }
  return { files, skipped }
}

/** The full path of an installed program, from the PATH in `env`, or undefined. This is what "command -v" does. */
export function findProgram(name, env = process.env) {
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const file = join(dir, name)
    try {
      const st = statSync(file)
      if (st.isFile() && st.mode & 0o111) return file
    } catch {
      // Not here.
    }
  }
  return undefined
}

/** Runs an outside program with a time limit: `{ status, stdout, timedOut }`. A program past its time is stopped. */
function runProgram(file, args, { cwd, timeout, env }) {
  const r = spawnSync(file, args, { cwd, env, encoding: 'utf8', timeout: Math.max(1, timeout), killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  return { status: r.status, stdout: r.stdout ?? '', timedOut: r.error?.code === 'ETIMEDOUT', failed: !!r.error }
}

const json = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** A scanner's severity as Widal.Code's. A scanner that gives none (Checkov without its platform) counts as medium. */
export function severityFrom(value) {
  const s = String((typeof value === 'object' && value ? value.name : value) ?? '').toUpperCase()
  if (s === 'CRITICAL' || s === 'HIGH') return 'high'
  if (s === 'MEDIUM') return 'medium'
  if (s === 'LOW') return 'low'
  if (s === 'INFO' || s === 'TRACE' || s === 'UNKNOWN') return 'info'
  return 'medium'
}

const NAMES = { checkov: 'Checkov', trivy: 'Trivy', kics: 'KICS', gitleaks: 'gitleaks', own: "Widal.Code's own rules" }

/**
 * A path that a scanner gave, relative to the repository. A full path inside the repository is made
 * relative. Checkov gives the path from the folder it ran in with a "/" in front ("/main.tf").
 */
function inRepo(root, path) {
  if (typeof path !== 'string' || !path) return undefined
  const p = isAbsolute(path) && path.startsWith(`${root}/`) ? relative(root, path) : path
  return p.replace(/^\.\//, '').replace(/^\/+/, '')
}

/** Whether a changed file is infrastructure code: Terraform, a Dockerfile, CloudFormation or Kubernetes YAML. */
export function isIac(f) {
  if (/\.tf$/.test(f.path) || /(^|\/)(Dockerfile([.-][^/]*)?|[^/]+\.dockerfile)$/i.test(f.path)) return true
  if (!/\.(ya?ml|json|template)$/i.test(f.path)) return false
  return /AWSTemplateFormatVersion|\bAWS::[A-Za-z0-9]+::/.test(f.text) || (/^\s*apiVersion\s*:/m.test(f.text) && /^\s*kind\s*:/m.test(f.text))
}

/**
 * The results of one infrastructure scanner, as `{ items, ok }`. Each item is `{ file, line, id,
 * name, severity }`. `ok` is false when the scanner failed or ran out of time.
 */
function scanIac(name, program, files, { root, env, limitMs }) {
  const start = Date.now()
  const left = () => limitMs - (Date.now() - start)
  const items = []
  if (name === 'checkov') {
    const r = runProgram(program, ['-o', 'json', '--quiet', '--compact', ...files.flatMap((f) => ['-f', f.path])], { cwd: root, timeout: left(), env })
    const out = json(r.stdout)
    // Checkov ends with 1 when a check failed. Several frameworks give a list of reports.
    if (r.timedOut || r.failed || ![0, 1].includes(r.status) || out === undefined) return { items, ok: false, timedOut: r.timedOut }
    for (const report of Array.isArray(out) ? out : [out]) {
      for (const c of report?.results?.failed_checks ?? []) {
        items.push({ file: inRepo(root, c.file_path), line: Array.isArray(c.file_line_range) ? c.file_line_range[0] : undefined, id: c.check_id, name: c.check_name, severity: severityFrom(c.severity) })
      }
    }
    return { items, ok: true }
  }
  if (name === 'trivy') {
    // One run per file: "trivy config" takes one target.
    for (const f of files) {
      if (left() <= 0) return { items, ok: false, timedOut: true }
      const r = runProgram(program, ['config', '--format', 'json', '--quiet', f.path], { cwd: root, timeout: left(), env })
      const out = json(r.stdout)
      if (r.timedOut || r.failed || r.status !== 0 || out === undefined) return { items, ok: false, timedOut: r.timedOut }
      for (const result of out?.Results ?? []) {
        for (const m of result?.Misconfigurations ?? []) {
          if (m?.Status && m.Status !== 'FAIL') continue
          items.push({ file: f.path, line: m?.CauseMetadata?.StartLine, id: m?.ID ?? m?.AVDID, name: m?.Title, severity: severityFrom(m?.Severity) })
        }
      }
    }
    return { items, ok: true }
  }
  // KICS writes its report to a folder. It ends with 20 to 60 when it found something, by the most severe result.
  const dir = mkdtempSync(join(tmpdir(), 'widal-code-kics-'))
  try {
    const r = runProgram(program, ['scan', '-p', files.map((f) => f.path).join(','), '-o', dir, '--report-formats', 'json', '--output-name', 'results', '--no-progress'], { cwd: root, timeout: left(), env })
    let out
    try {
      out = json(readFileSync(join(dir, 'results.json'), 'utf8'))
    } catch {
      out = undefined
    }
    if (r.timedOut || r.failed || ![0, 20, 30, 40, 50, 60].includes(r.status) || out === undefined) return { items, ok: false, timedOut: r.timedOut }
    for (const q of out?.queries ?? []) {
      for (const f of q?.files ?? []) items.push({ file: inRepo(root, f?.file_name), line: f?.line, id: q.query_id, name: q.query_name, severity: severityFrom(q.severity) })
    }
    return { items, ok: true }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The words gitleaks's rule ids stand for. Any other rule id is named as it is: it is the name of a rule, not a key. */
const GITLEAKS_KINDS = { 'aws-access-token': 'AWS access key id', 'private-key': 'private key', 'github-pat': 'GitHub token', 'github-fine-grained-pat': 'GitHub token', 'github-oauth': 'GitHub token', 'github-app-token': 'GitHub token', 'anthropic-api-key': 'Anthropic API key', 'anthropic-admin-api-key': 'Anthropic API key', 'openai-api-key': 'OpenAI API key' }
const gitleaksKind = (id) => GITLEAKS_KINDS[id] ?? (String(id).startsWith('slack-') ? 'Slack token' : String(id).replace(/[^\w.-]/g, '').slice(0, 60) || 'secret')

/** gitleaks on each file, within the time limit: `{ items, done }`. `done` holds the files it checked. */
function scanSecrets(program, files, { env, limitMs }) {
  const start = Date.now()
  const items = []
  const done = new Set()
  for (const f of files) {
    const left = limitMs - (Date.now() - start)
    if (left <= 0) break
    const r = runProgram(program, ['detect', '--no-git', '--source', f.abs, '--report-format', 'json', '--report-path', '-', '--redact', '--no-banner', '--log-level', 'error'], { timeout: left, env })
    // gitleaks ends with 1 when it found a key.
    if (r.timedOut || r.failed || ![0, 1].includes(r.status)) break
    const out = r.stdout.trim() ? json(r.stdout) : []
    if (!Array.isArray(out)) break
    for (const x of out) items.push({ file: f.path, line: x?.StartLine, kind: gitleaksKind(x?.RuleID) })
    done.add(f.path)
  }
  return { items, done }
}

// Widal.Code's own rules for Terraform, used without an infrastructure scanner.

/** The blocks `resource "<type>" "<name>" { ... }` of a Terraform file: `{ type, start, body }`, `start` the offset of the block. */
function resources(text) {
  const out = []
  const head = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g
  for (let m; (m = head.exec(text));) {
    const end = closing(text, head.lastIndex)
    out.push({ type: m[1], start: m.index, body: text.slice(head.lastIndex, end), bodyAt: head.lastIndex })
    head.lastIndex = end
  }
  return out
}

/** The offset of the brace that closes a block whose body starts at `from`, skipping strings and comments. */
function closing(text, from) {
  let depth = 1
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++
    } else if (c === '#' || (c === '/' && text[i + 1] === '/')) {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 1
    } else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return text.length
}

const lineAt = (text, offset) => text.slice(0, offset).split('\n').length
const num = (body, key) => {
  const m = new RegExp(`\\b${key}\\s*=\\s*(-?\\d+)`).exec(body)
  return m ? Number(m[1]) : undefined
}

/** Whether a rule of a security group lets every address reach a port other than 80 and 443. */
function openToAll(body) {
  if (!/"0\.0\.0\.0\/0"|"::\/0"/.test(body)) return false
  if (/\bprotocol\s*=\s*"(-1|all)"/.test(body)) return true
  const from = num(body, 'from_port')
  const to = num(body, 'to_port') ?? from
  if (from === undefined) return true
  return !(from === to && (from === 80 || from === 443))
}

/** The findings of Widal.Code's own rules for one Terraform file: [check, line, words, severity]. */
export function terraformRules(text) {
  const out = []
  const all = resources(text)
  const hasSse = all.some((r) => r.type === 'aws_s3_bucket_server_side_encryption_configuration')
  for (const r of all) {
    const at = (offset) => lineAt(text, r.bodyAt + offset)
    if (r.type === 'aws_s3_bucket' || r.type === 'aws_s3_bucket_acl') {
      const acl = /\bacl\s*=\s*"(public-read|public-read-write|authenticated-read)"/.exec(r.body)
      if (acl) out.push(['s3-public-acl', at(acl.index), 'An S3 bucket has a public ACL', 'high'])
    }
    if (r.type === 'aws_s3_bucket' && !/server_side_encryption_configuration/.test(r.body) && !hasSse) out.push(['s3-no-encryption', lineAt(text, r.start), 'An S3 bucket has no encryption set', 'medium'])
    if (r.type === 'aws_security_group') {
      const ingress = /\bingress\s*\{/g
      for (let m; (m = ingress.exec(r.body));) {
        const end = closing(r.body, ingress.lastIndex)
        if (openToAll(r.body.slice(ingress.lastIndex, end))) out.push(['sg-open', at(m.index), 'A security group lets every address reach a port other than 80 and 443', 'high'])
      }
    }
    if ((r.type === 'aws_security_group_rule' && /\btype\s*=\s*"ingress"/.test(r.body)) || r.type === 'aws_vpc_security_group_ingress_rule') {
      if (openToAll(r.body)) out.push(['sg-open', lineAt(text, r.start), 'A security group rule lets every address reach a port other than 80 and 443', 'high'])
    }
  }
  for (const m of text.matchAll(/\bpublicly_accessible\s*=\s*true\b/g)) out.push(['db-public', lineAt(text, m.index), 'A database can be reached from the internet (publicly_accessible = true)', 'high'])
  for (const m of text.matchAll(/\bstorage_encrypted\s*=\s*false\b/g)) out.push(['storage-unencrypted', lineAt(text, m.index), 'Storage is not encrypted (storage_encrypted = false)', 'medium'])
  return out
}

// Code that turns off the check of TLS certificates.
const TLS_OFF = [
  ['verify=False', /\bverify\s*=\s*False\b/],
  ['rejectUnauthorized: false', /\brejectUnauthorized\s*:\s*false\b/],
  ['NODE_TLS_REJECT_UNAUTHORIZED set to 0', /NODE_TLS_REJECT_UNAUTHORIZED['"]?\s*[=:]\s*['"]?0\b/],
  ['InsecureSkipVerify: true', /\bInsecureSkipVerify\s*:\s*true\b/],
]
// Scripts, where "curl -k" is looked for.
const SCRIPT = /(\.(sh|bash|zsh|ksh|ps1|mk|ya?ml)$)|(^|\/)(Dockerfile[^/]*|Makefile)$/i
// A call that writes a log line or prints.
const LOG_CALL = /\b(?:console\.(?:log|info|warn|error|debug|trace)|print|println|printf|puts|logger\.\w+|logging\.\w+|log\.\w+|Log\.\w+|System\.(?:out|err)\.print\w*|fmt\.(?:Print|Fprint|Sprint)\w*)\s*\(/
// A field named like an identifier of a patient or a person.
const PERSON_FIELD = /(?<![A-Za-z0-9])(?:ssn|dob|date_of_birth|dateOfBirth|mrn|medical_record\w*|medicalRecord\w*|patient_name|patientName|diagnosis|insurance_id|insuranceId)(?![A-Za-z0-9])/i
// Test fixtures, named as such: a card number there is a test number.
const TEST_FIXTURE = /(^|\/)(tests?|__tests__|specs?|fixtures?|__fixtures__|testdata|test-data)(\/|$)|\.(test|spec)\.[^/]+$|_test\.[^/]+$/i
// Config files, where a plain http:// address is looked for.
const CONFIG = (path) => /\.(json|ya?ml|toml|ini|cfg|conf|properties|xml|env)$/i.test(path) || /^\.env/.test(basename(path))
// Hosts of XML namespaces and schemas: their http:// names are names, not addresses that are called.
const NAMESPACE_HOST = /(^|\.)(w3\.org|json-schema\.org|xmlsoap\.org|schemas\.microsoft\.com|schemas\.android\.com|maven\.apache\.org|purl\.org|xmlns\.com)$/i

/** Whether a line of a script runs curl with -k or --insecure. */
const insecureCurl = (line) => shellCommands(line).some((words) => {
  const { program, args } = programOf(words)
  return program === 'curl' && args.some((a) => a === '--insecure' || (/^-[A-Za-z]+$/.test(a) && a.includes('k')))
})

/**
 * Widal.Code's own rules for lines of one file, each line on its own: `lines` is a list of [line
 * number, text]. `keys` is false when gitleaks already checked the file for keys. `add(rule, line,
 * extra, opts)` makes each finding. The check of the changed code uses it for whole files, and the
 * check before a push (pre-push.mjs) for the lines that the pushed commits add.
 */
export function ownLineRules(path, lines, { frameworks = [], keys = true, add }) {
  const phi = ruleOn(RULES['code.phi-log'], frameworks)
  const pci = ruleOn(RULES['code.card-number'], frameworks)
  const script = SCRIPT.test(path)
  const config = CONFIG(path)
  const fixture = TEST_FIXTURE.test(path)
  for (const [line, text] of lines) {
    if (keys) for (const kind of keysIn(text).keys()) add('code.secret', line, kind, { detail: `The kind of key: ${kind}. Found by Widal.Code's own patterns.` })
    for (const [words, re] of TLS_OFF) if (re.test(text)) add('code.tls-off', line, words, { detail: `${words}.` })
    if (script && /\bcurl\b/.test(text) && insecureCurl(text)) add('code.tls-off', line, 'curl -k', { detail: 'curl with -k or --insecure.' })
    if (phi && LOG_CALL.test(text) && PERSON_FIELD.test(text)) add('code.phi-log', line, '', { detail: 'A log or print call in the same line as a field named like an identifier of a person.' })
    if (pci && !fixture && cardNumbers(text)) add('code.card-number', line, '', { detail: 'A number that passes the check of card numbers.' })
    if (config) {
      for (const m of text.matchAll(/http:\/\/([^\s"'<>/:]+)/g)) {
        const host = m[1]
        if (isLocalHost(host) || NAMESPACE_HOST.test(host)) continue
        add('code.http', line, host.slice(0, 100), { detail: `An address on ${host.slice(0, 100)} without TLS.` })
      }
    }
  }
}

/**
 * The findings of the code an agent changed in a repository. `frameworks` are those that count for
 * the repository. `env` stands in for the environment (its PATH finds the scanners), and `limits`
 * for the limits, so that a test can use a short time limit. Returns `{ findings, scanners, files,
 * skipped }`: the programs that checked the code, and how many files were checked and left out.
 */
export function checkCode({ root, frameworks = [], env = process.env, limits = LIMITS }) {
  const scope = `repo:${root}`
  const { files, skipped } = changedFiles(root, limits)
  const findings = []
  const used = new Set()
  const add = (rule, file, line, extra, opts) => findings.push(makeFinding(rule, { key: `${root}:${file}:${line ?? 0}${extra ? `:${extra}` : ''}`, scope, frameworks, where: { repo: root, file, ...(line && { line }) }, ...opts }))

  // Infrastructure code: the first scanner that is installed, else Widal.Code's own rules for Terraform.
  const iac = files.filter(isIac)
  let ownIac = iac.length > 0
  if (iac.length) {
    for (const name of ['checkov', 'trivy', 'kics']) {
      const program = findProgram(name, env)
      if (!program) continue
      const r = scanIac(name, program, iac, { root, env, limitMs: limits.ms })
      if (r.ok) {
        ownIac = false
        used.add(name)
        const wanted = new Set(iac.map((f) => f.path))
        for (const it of r.items) {
          if (!wanted.has(it.file)) continue
          const what = [it.name, it.id].filter(Boolean).map((x) => String(x).replace(/\.$/, ''))
          add('code.iac', it.file, it.line, String(it.id ?? 'check'), { severity: it.severity, source: name, detail: `${what.length > 1 ? `${what[0]} (${what[1]})` : what[0] ?? 'A check failed'}, found by ${NAMES[name]}.` })
        }
      }
      // One scanner is enough. When it failed or ran out of time, Widal.Code's own rules stand in.
      break
    }
  }
  if (ownIac) {
    for (const f of iac.filter((x) => x.path.endsWith('.tf'))) {
      used.add('own')
      for (const [check, line, words, severity] of terraformRules(f.text)) add('code.iac', f.path, line, check, { severity, detail: `${words}, found by Widal.Code's own rules for Terraform.` })
    }
  }

  // Secret keys: gitleaks when it is installed. The files it did not reach in time get Widal.Code's own patterns.
  const gitleaks = findProgram('gitleaks', env)
  let checked = new Set()
  if (gitleaks && files.length) {
    const r = scanSecrets(gitleaks, files, { env, limitMs: limits.ms })
    checked = r.done
    if (r.done.size) used.add('gitleaks')
    for (const it of r.items) add('code.secret', it.file, it.line, it.kind, { source: 'gitleaks', detail: `The kind of key: ${it.kind}. Found by gitleaks.` })
  }

  for (const f of files) {
    const ownKeys = !checked.has(f.path)
    if (ownKeys) used.add('own')
    const lines = f.text.split('\n').map((text, i) => [i + 1, text])
    ownLineRules(f.path, lines, { frameworks, keys: ownKeys, add: (rule, line, extra, opts) => add(rule, f.path, line, extra, opts) })
  }
  // A rule can match a line twice (two keys of one kind): one finding is enough.
  const unique = [...new Map(findings.map((x) => [x.id, x])).values()]
  return { findings: unique, scanners: [...used].map((n) => NAMES[n]), files: files.length, skipped }
}
