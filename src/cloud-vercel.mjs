// "widal cloud-check vercel": read-only checks of one Vercel project, with the person's own
// sign-in of the Vercel CLI.
//
// The checks, and where each one reads:
//   - Deployment protection on previews and on production deployment URLs, and whether a password
//     protects them: "vercel project protection <project> --json". Its answer also holds the
//     project's protection bypass, which Widal.Code never keeps or prints.
//   - The Vercel Firewall on or off: "vercel firewall status --json --project <project>".
//   - Trusted IPs, and environment variables that are readable (Config, not Secret) while their
//     name looks like a secret's: only Vercel's REST API answers these, GET /v9/projects/<id>.
//     Widal.Code calls it only with a token that the person puts in the environment variable
//     VERCEL_TOKEN, sends it only to api.vercel.com, and never writes it anywhere. Of each
//     variable it reads the name and the kind, never the value. Without the token these checks
//     are skipped, the run says so, and their findings from an earlier run stay as they were.
//   - With HIPAA on: one finding of severity info, that Vercel signs a BAA only on Pro with the
//     paid add-on and on Enterprise, for the person to check.
//
// Facts from Vercel's documentation and the CLI's source, read on 14 Nov 2026:
//   - The CLI reads VERCEL_TOKEN itself. --scope picks a team by its slug or id. Without
//     --project a command takes the project that the folder is linked to.
//   - "vercel whoami --json" ends with exit code 1 when nobody is signed in.
//   - Environment variables have the types encrypted, plain, secret, sensitive and system, and a
//     newer field "visibility" that is "config" or "secret". Config values stay readable for the
//     team's members; Secret values are write-only. A variable without "visibility" is a Config
//     value when its type is encrypted or plain.
//   - Deployment protection names its reach with deploymentType: "all", "all_except_custom_domains"
//     (Standard Protection), "prod_deployment_urls_and_all_previews" (the older Standard
//     Protection) and "preview". Trusted IPs can also have "production".
import { cloudFinding, findProgram, firstLine, parseJson, runProgram, CALL_LIMIT } from './cloud.mjs'

export const API = 'https://api.vercel.com'

// Which deployment types protect previews, and which protect the URLs of production deployments.
const PREVIEWS = ['all', 'all_except_custom_domains', 'prod_deployment_urls_and_all_previews', 'preview']
const PRODUCTION_URLS = ['all', 'all_except_custom_domains', 'prod_deployment_urls_and_all_previews', 'production']
const METHODS = [['ssoProtection', 'Vercel Authentication'], ['passwordProtection', 'Password Protection'], ['trustedIps', 'Trusted IPs']]

/** Whether a name looks like a secret's: it ends in _KEY, _SECRET or _TOKEN, or holds PASSWORD. */
export const secretName = (name) => /_(KEY|SECRET|TOKEN)$/i.test(name) || /PASSWORD/i.test(name)
/** Whether a variable is readable after it is saved: a Config value. */
export const readable = (v) => (v.visibility ? v.visibility === 'config' : ['encrypted', 'plain'].includes(v.type))

/** Checks one Vercel project. See src/cloud.mjs for what it returns. */
export async function vercelCheck(options, { env, frameworks, fetch }) {
  const vercel = findProgram('vercel', env)
  if (!vercel) throw new Error('The Vercel command line tool (vercel) is not installed, so Widal.Code cannot read Vercel. Install it with "npm i -g vercel" and sign in with "vercel login", then run this again.')
  const scope = options.team ? ['--scope', options.team] : []
  const call = (args, what) => {
    const r = runProgram(vercel, [...args, ...scope], { env })
    if (r.timedOut) throw new Error(`The Vercel command line tool did not answer within ${CALL_LIMIT / 1000} seconds (${what}). Nothing was saved. Try again later.`)
    if (r.failed) throw new Error(`The Vercel command line tool could not start: ${firstLine(r.failed)}.`)
    return r
  }

  const who = call(['whoami', '--json'], 'vercel whoami')
  let me = parseJson(who.stdout)
  // An older Vercel CLI (seen: 49.2.0) knows no "--json" for whoami. Ask it without, and say plainly
  // that it is too old, instead of saying that nobody is signed in.
  const tooOld = who.status !== 0 && /unknown or unexpected option/i.test(`${who.stderr}${who.stdout}`)
  if (tooOld) {
    const plainWho = call(['whoami'], 'vercel whoami')
    if (plainWho.status !== 0) throw new Error('The Vercel command line tool is not signed in. Sign in with "vercel login", or set VERCEL_TOKEN, then run this again.')
    throw new Error(`The Vercel command line tool on this computer is too old for these checks (${firstLine(`${who.stderr}${who.stdout}`).match(/Vercel CLI [0-9.]+/)?.[0] ?? 'an older version'}): it has no "--json" answers and no "vercel project protection". Update it with "npm i -g vercel", then run this again. Nothing was saved.`)
  }
  if (who.status !== 0 || me?.loggedIn === false) throw new Error('The Vercel command line tool is not signed in. Sign in with "vercel login", or set VERCEL_TOKEN, then run this again.')
  const teamId = options.team ?? me?.team?.id ?? undefined

  const shown = call(['project', 'protection', ...(options.project ? [options.project] : []), '--json'], 'vercel project protection')
  if (shown.status !== 0) {
    const said = firstLine(shown.stderr)
    if (/not linked/i.test(said)) throw new Error('This folder is not linked to a Vercel project. Name one: widal cloud-check vercel --project <name>')
    throw new Error(`The Vercel command line tool could not read the project's deployment protection: ${said || `exit code ${shown.status}`}. A newer Vercel CLI may be needed (npm i -g vercel). Nothing was saved.`)
  }
  const protection = parseJson(shown.stdout)
  if (!protection?.projectId) throw new Error('The Vercel command line tool gave an answer about the project that Widal.Code could not read. Nothing was saved.')
  const projectId = String(protection.projectId)
  const name = String(protection.name ?? options.project ?? projectId)
  const projectScope = `cloud:vercel:${projectId}`
  const where = { provider: 'vercel', project: name, ...(teamId ? { account: teamId } : {}) }

  const firewall = call(['firewall', 'status', '--json', '--project', projectId], 'vercel firewall status')
  const wall = firewall.status === 0 ? parseJson(firewall.stdout) : undefined
  if (typeof wall?.firewallEnabled !== 'boolean') throw new Error(`The Vercel command line tool could not read the firewall of ${name}: ${firstLine(firewall.stderr) || 'its answer could not be read'}. A newer Vercel CLI may be needed (npm i -g vercel). Nothing was saved.`)

  // The checks that need the REST API, with the person's token only.
  const notes = []
  let api
  const token = env.VERCEL_TOKEN
  if (token) api = await projectFromApi(fetch, token, projectId, teamId)
  else notes.push('The checks of trusted IPs and of environment variables were skipped: they need Vercel\'s REST API, and VERCEL_TOKEN is not set. Their findings from an earlier run stay as they were.')

  // Only the three methods are taken from the answer: it also holds the protection bypass, which stays out.
  const method = { ssoProtection: protection.ssoProtection, passwordProtection: protection.passwordProtection, trustedIps: api?.trustedIps }
  const covering = (types) => METHODS.filter(([field]) => types.includes(method[field]?.deploymentType)).map(([, label]) => label)
  const findings = []
  const previews = covering(PREVIEWS)
  const production = covering(PRODUCTION_URLS)
  const fix = 'In the project\'s settings on vercel.com, Deployment Protection: turn on Vercel Authentication with Standard Protection.'
  if (!previews.length) {
    findings.push(cloudFinding({
      rule: 'cloud.vercel.previews-open', key: projectId, scope: projectScope, severity: 'high', where, source: 'vercel',
      title: 'Preview deployments are open to anyone with the link',
      detail: `No deployment protection covers the previews${api ? '' : ' (trusted IPs were not checked)'}. ${fix}`,
    }))
  }
  if (!production.length) {
    findings.push(cloudFinding({
      rule: 'cloud.vercel.production-urls-open', key: projectId, scope: projectScope, severity: 'medium', where, source: 'vercel',
      title: 'The URLs of production deployments are open to anyone with the link',
      detail: `Production domains are public on purpose for most sites, but the generated URLs of each production deployment need no sign-in either${api ? '' : ' (trusted IPs were not checked)'}. ${fix}`,
    }))
  }
  if (!wall.firewallEnabled) {
    findings.push(cloudFinding({
      rule: 'cloud.vercel.firewall-off', key: projectId, scope: projectScope, severity: 'medium', where, source: 'vercel',
      title: 'The Vercel Firewall is off for this project',
      detail: 'Turn it on in the project\'s Firewall tab on vercel.com. "vercel firewall status" shows its rules.',
    }))
  }
  for (const v of api?.env ?? []) {
    if (!readable(v) || !secretName(v.key)) continue
    findings.push(cloudFinding({
      rule: 'cloud.vercel.readable-secret', key: `${projectId}:${v.key}`, scope: projectScope, severity: 'high', source: 'vercel',
      where: { ...where, resource: `environment variable ${v.key}` },
      title: 'An environment variable that looks like a secret is readable (Config, not Secret)',
      detail: 'Widal.Code judged it by its name only and never read its value. Make it a Secret (sensitive) variable in the project\'s settings, so that nobody can read it after it is saved.',
    }))
  }
  const methods = METHODS.filter(([field]) => method[field]).map(([field, label]) => `${label} (${method[field].deploymentType ?? 'set'})`)
  notes.push(`${name}: ${methods.length ? `protected by ${methods.join(', ')}` : 'no deployment protection is set'}; the firewall is ${wall.firewallEnabled ? 'on' : 'off'}.`)

  const runs = [{ scope: projectScope, findings, keep: api ? [] : ['cloud.vercel.readable-secret'] }]
  // The note about Vercel's BAA is about the team, not one project.
  const teamScope = `cloud:vercel:${teamId ?? 'personal'}`
  runs.push({
    scope: teamScope,
    findings: frameworks.includes('hipaa') ? [cloudFinding({
      // The board reads the source "kestrel" as this tool's own checks, so it stays as it was.
      rule: 'cloud.vercel.hipaa-baa', key: teamId ?? 'personal', scope: teamScope, severity: 'info', source: 'kestrel',
      where: { provider: 'vercel', ...(teamId ? { account: teamId } : {}) },
      title: 'Check that your Vercel team has a signed HIPAA BAA',
      detail: 'Vercel signs a Business Associate Agreement only on Pro with the HIPAA BAA add-on (bought in the team\'s Billing settings) and on Enterprise. Widal.Code cannot see whether yours is signed. See vercel.com/docs/security/compliance.',
    })] : [],
  })
  return { what: `Vercel project ${name}${teamId ? ` of the team ${teamId}` : ''}${api ? ', with the REST API' : ''}`, runs, notes }
}

/**
 * The trusted IPs and the environment variables of a project, from Vercel's REST API with the
 * person's token. Of each variable only the name, the type and the visibility are kept. The value
 * is never read.
 */
async function projectFromApi(fetch, token, projectId, teamId) {
  const url = `${API}/v9/projects/${encodeURIComponent(projectId)}${teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''}`
  let response
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(CALL_LIMIT) })
  } catch (e) {
    throw new Error(`Vercel's REST API could not be reached: ${firstLine(e?.message ?? e)}. Nothing was saved.`)
  }
  const body = parseJson(await response.text())
  if (response.status === 401 || response.status === 403) throw new Error(`Vercel's REST API did not accept VERCEL_TOKEN (${response.status}${body?.error?.message ? `: ${firstLine(body.error.message)}` : ''}). Make a token in your account settings on vercel.com with access to this team, then run this again. Nothing was saved.`)
  if (!response.ok || !body || typeof body !== 'object') throw new Error(`Vercel's REST API answered with status ${response.status}${body?.error?.message ? `: ${firstLine(body.error.message)}` : ''}. Nothing was saved.`)
  const env = (Array.isArray(body.env) ? body.env : [])
    .filter((v) => v && typeof v.key === 'string')
    .map((v) => ({ key: v.key, type: v.type, visibility: v.visibility }))
  return { trustedIps: body.trustedIps ?? null, env }
}
