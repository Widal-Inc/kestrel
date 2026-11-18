// "widal cloud-check <aws|vercel|github>": read-only compliance checks of a cloud account, run
// only when the person asks, never on a timer.
//
// Widal.Code uses the sign-ins the person already has, through the providers' own command line tools
// (aws, prowler, vercel, gh). It never reads a credentials file and never keeps a key. The one
// secret it may use is a Vercel token that the person puts in the environment variable
// VERCEL_TOKEN, for the checks that only Vercel's REST API answers. It sends that token to Vercel
// only, and never writes it anywhere.
//
// Each check becomes a finding of kind "cloud" (see src/findings.mjs), saved with saveFindings
// under the scope of what one run covers: "cloud:<provider>:<account or project>", with
// ":<region>" after an AWS account when the person named a region. So a later run of the same
// scope resolves what was fixed since. A run that could not finish (a time limit, a
// tool that failed in the middle) saves nothing, so that it resolves nothing by mistake.
//
// A finding never holds what was matched: no secret, no value of an environment variable, no
// text that a scanner printed about a resource. It holds the check's own title, the resource's id,
// and the controls of the frameworks that the provider's tool reported.
import { accessSync, constants, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { readFindings, saveFindings } from './findings.mjs'
import { findingLines, countsWords } from './findings-text.mjs'
import { CHECK_NOTE, PROVIDERS } from './finding-words.mjs'
import { securityConfig } from './settings.mjs'

/** The longest a call of a provider's command line tool may take, in milliseconds. Prowler has its own limit. */
export const CALL_LIMIT = 60e3
// The most findings one run keeps. A large account can have thousands; the most severe are kept,
// and the run says how many it left out, so that Widal.Code's small file of findings stays small.
export const MOST = 500

const SEVERITY_RANK = { high: 0, medium: 1, low: 2, info: 3 }

/**
 * The full path of a program on the PATH of `env`, or undefined when it is not there. Widal.Code
 * starts a provider's tool by this full path, so the PATH it was given is the only place it looks.
 */
export function findProgram(name, env = process.env) {
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const file = join(dir, name)
    try {
      accessSync(file, constants.X_OK)
      if (statSync(file).isFile()) return file
    } catch {
      // Not in this folder.
    }
  }
  return undefined
}

/**
 * Runs a program with an argument list and no shell, with a time limit. Returns `{ status,
 * stdout, stderr, timedOut, failed }`: `failed` holds the reason when the program could not start.
 * `quiet` throws its standard output away (Prowler prints a long report there).
 */
export function runProgram(file, args, { env = process.env, timeoutMs = CALL_LIMIT, cwd, quiet = false } = {}) {
  const r = spawnSync(file, args, {
    env, cwd, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', quiet ? 'ignore' : 'pipe', 'pipe'],
  })
  const timedOut = r.error?.code === 'ETIMEDOUT' || (r.signal === 'SIGTERM' && r.status === null)
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut, failed: timedOut ? undefined : r.error?.message }
}

/** The first line of a text that is not empty, without control characters, cut to fit one sentence. */
export function firstLine(text) {
  const line = String(text ?? '').split('\n').map((l) => l.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim()).find(Boolean) ?? ''
  return line.length > 200 ? `${line.slice(0, 197)}...` : line
}

/** JSON from a program's output, or undefined when it is not JSON. */
export function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The most severe findings first, at most `MOST`. Returns `{ kept, left }`: left is how many were left out. */
export function mostSevere(findings) {
  const sorted = [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.id < b.id ? -1 : 1))
  return { kept: sorted.slice(0, MOST), left: Math.max(0, sorted.length - MOST) }
}

/**
 * A finding of kind "cloud", with the fields every cloud check fills. `rule` is the check's id,
 * `key` makes the id unique within the rule (a resource), `scope` is the run's scope.
 */
export function cloudFinding({ rule, key, scope, severity, title, detail, where, controls = [], reported, source, fix = null }) {
  const f = { id: key ? `${rule}:${key}` : rule, rule, kind: 'cloud', severity, title, scope, where, controls, fix, source }
  if (detail) f.detail = detail
  if (reported?.length) f.reported = [...new Set(reported)]
  return f
}

/**
 * The catalog of controls, src/controls.mjs: per framework key, a list of `[id, label, confirmed]`.
 * The cloud checks take the controls that the provider's tool reported, and use the catalog for the
 * label and for whether the id was checked against the framework's own text (`confirmed`).
 */
export async function loadCatalog() {
  try {
    return (await import('./controls.mjs')).CONTROLS ?? {}
  } catch {
    return {}
  }
}
/**
 * One control of a catalog, as `{ id, label, confirmed }`, or undefined. A framework's list holds
 * `[id, label, confirmed]` as src/controls.mjs does; a test's stand-in may hold `{ id, label,
 * confirmed }` in a list or an object by id.
 */
export function catalogEntry(catalog, framework, id) {
  const list = catalog?.[framework]
  if (Array.isArray(list)) {
    for (const c of list) {
      if (Array.isArray(c) && c[0] === id) return { id, label: c[1], confirmed: c[2] }
      if (c?.id === id) return c
    }
    return undefined
  }
  if (list && typeof list === 'object') return list[id]
  return undefined
}
/** One control as a finding holds it, with the catalog's label and `confirmed` when the catalog has the id. */
export function control(catalog, framework, id, label) {
  const known = catalogEntry(catalog, framework, id)
  return { framework, id, confirmed: known?.confirmed === true, label: known?.label ?? label }
}

// The controls of Widal.Code's own cloud checks of Vercel and GitHub, which no provider's tool maps:
// [framework, id, label]. An id counts as confirmed only when the catalog of controls says so;
// every other one shows with "(id to check)". HITRUST shows through HIPAA and ISO 27001.
const ACCESS = [['hipaa', '164.312(a)', 'Access control'], ['soc2', 'CC6.1', 'Logical access security'], ['iso27001', 'A.8.3', 'Information access restriction']]
const SECRETS = [['hipaa', '164.312(a)', 'Access control'], ['soc2', 'CC6.1', 'Logical access security'], ['iso27001', 'A.5.17', 'Authentication information']]
const VULNERABILITIES = [['soc2', 'CC7.1', 'Detection of vulnerabilities'], ['iso27001', 'A.8.8', 'Management of technical vulnerabilities'], ['pci', '6.3.3', 'Known vulnerabilities are patched']]
export const OWN_CONTROLS = {
  'cloud.vercel.previews-open': ACCESS,
  'cloud.vercel.production-urls-open': ACCESS,
  'cloud.vercel.firewall-off': [['soc2', 'CC6.6', 'Protection against threats from outside the system'], ['iso27001', 'A.8.20', 'Networks security']],
  'cloud.vercel.readable-secret': SECRETS,
  'cloud.vercel.hipaa-baa': [['hipaa', '164.308(b)(1)', 'Business associate contracts']],
  'cloud.github.no-review': [['soc2', 'CC8.1', 'Change management'], ['iso27001', 'A.8.32', 'Change management']],
  'cloud.github.secret-scanning-off': SECRETS,
  'cloud.github.push-protection-off': SECRETS,
  'cloud.github.secret-alerts': SECRETS,
  'cloud.github.dependabot-alerts': VULNERABILITIES,
  'cloud.github.dependabot-off': VULNERABILITIES,
  'cloud.github.code-scanning-alerts': [['soc2', 'CC7.1', 'Detection of vulnerabilities'], ['iso27001', 'A.8.28', 'Secure coding']],
  'cloud.github.code-scanning-off': [['soc2', 'CC7.1', 'Detection of vulnerabilities'], ['iso27001', 'A.8.28', 'Secure coding']],
  'cloud.github.org-2fa-off': [['hipaa', '164.312(d)', 'Person or entity authentication'], ['soc2', 'CC6.1', 'Logical access security'], ['iso27001', 'A.8.5', 'Secure authentication'], ['pci', '8.4.2', 'Multi-factor authentication for all access']],
}
/** The controls of one of Widal.Code's own cloud checks, by its rule. */
export const ownControls = (catalog, rule) => (OWN_CONTROLS[rule] ?? []).map(([framework, id, label]) => control(catalog, framework, id, label))

const PROVIDER_CHECKS = {
  aws: () => import('./cloud-aws.mjs').then((m) => m.awsCheck),
  vercel: () => import('./cloud-vercel.mjs').then((m) => m.vercelCheck),
  github: () => import('./cloud-github.mjs').then((m) => m.githubCheck),
}

/**
 * Runs one provider's check, saves its findings, and returns the text to print. `options` are the
 * command's options (profile, region, minutes, project, team, repo). `env` is the environment the
 * tools run with, `frameworks` the frameworks that are on, `now` the time of the run, `fetch`
 * stands in for the network in a test, and `catalog` for src/controls.mjs.
 *
 * A provider's check returns `{ what, runs: [{ scope, findings, keep }], notes }`: what it checked
 * in words, each scope it covered with that scope's findings, and sentences about what it skipped.
 * `keep` names the rules of checks that the run skipped: their open findings stay as they were.
 * It throws an Error with one plain sentence when its tool is not installed, not signed in, or
 * could not finish.
 */
export async function cloudCheck(provider, options = {}, { env = process.env, frameworks = securityConfig().frameworks, now = Date.now(), fetch = globalThis.fetch, catalog } = {}) {
  const load = Object.hasOwn(PROVIDER_CHECKS, provider ?? '') ? PROVIDER_CHECKS[provider] : undefined
  if (!load) throw new Error(`"${provider ?? ''}" is not a provider Widal.Code checks. Use one of: widal cloud-check aws, widal cloud-check vercel, widal cloud-check github.`)
  const check = await load()
  const controls = catalog ?? (await loadCatalog())
  const result = await check(options, { env, frameworks, now, fetch, catalog: controls })
  // Widal.Code's own checks get their controls here, by their rule.
  for (const run of result.runs) for (const f of run.findings) if (!f.controls.length && OWN_CONTROLS[f.rule]) f.controls = ownControls(controls, f.rule)
  const open = []
  const lines = [`Checked ${result.what}. Read only.`]
  for (const run of result.runs) {
    // The open findings of a check that this run skipped (`keep` names their rules) stay open as they were.
    const carried = run.keep?.length
      ? readFindings().filter((f) => f.status === 'open' && f.scope === run.scope && f.kind === 'cloud' && run.keep.includes(f.rule)).map(({ status, firstSeen, lastSeen, resolvedAt, ...f }) => f)
      : []
    const { kept, left } = mostSevere([...run.findings, ...carried])
    open.push(...saveFindings(kept, { scope: run.scope, kind: 'cloud', now }))
    if (left) lines.push(`Widal.Code keeps the ${MOST} most severe findings of ${run.scope}, and left out ${left} more.`)
  }
  lines.push(...result.notes)
  const counts = { high: 0, medium: 0, low: 0, info: 0 }
  for (const f of open) counts[f.severity]++
  open.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.id < b.id ? -1 : 1))
  lines.push('', `${open.length} open ${open.length === 1 ? 'finding' : 'findings'} in ${PROVIDERS[provider]} (${countsWords(counts)}).`)
  for (const f of open) lines.push('', ...findingLines(f, { on: frameworks }))
  lines.push('', 'They are saved, so "widal check" shows them too. A later run resolves what was fixed.', CHECK_NOTE)
  return lines.join('\n')
}

/**
 * The command "widal cloud-check". `words` are the words after "cloud-check", `flags` the
 * options the command line gave: profile, region, minutes, project, team and repo.
 */
export function cloudCommand(words, flags, context) {
  const [provider, ...rest] = words
  if (!provider) throw new Error('Name a provider: widal cloud-check aws, widal cloud-check vercel or widal cloud-check github.')
  if (rest.length) throw new Error(`"widal cloud-check ${provider}" takes options only, and "${rest[0]}" was given.`)
  const allowed = { aws: ['profile', 'region', 'minutes'], vercel: ['project', 'team'], github: ['repo'] }[provider] ?? []
  for (const [name, value] of Object.entries(flags)) {
    if (value === undefined) continue
    if (!allowed.includes(name)) throw new Error(`--${name} is not an option of "widal cloud-check ${provider}".${allowed.length ? ` Its options are: ${allowed.map((a) => `--${a}`).join(', ')}.` : ''}`)
    if (value === true || value === '') throw new Error(`--${name} needs a value.`)
  }
  return cloudCheck(provider, flags, context)
}
