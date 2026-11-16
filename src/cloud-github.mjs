// "kestrel cloud-check github": read-only checks of one GitHub repository, with the person's own
// sign-in of the GitHub CLI (gh). Without --repo it is the repository of the current folder.
//
// The checks, each with "gh api":
//   - The default branch needs at least one approving review before a merge: by a ruleset
//     (GET repos/{o}/{r}/rules/branches/{branch}, the rules that apply to the branch, readable
//     with read access) or by branch protection (GET .../branches/{branch}/protection, which needs
//     admin rights to read).
//   - Secret scanning and push protection are on (GET repos/{o}/{r}, "security_and_analysis",
//     which GitHub shows only to admins), and the count of open secret scanning alerts, asked with
//     hide_secret=true. Only the count is kept.
//   - The count of open Dependabot alerts of severity high and critical.
//   - The count of open code scanning alerts, and "not enabled" when GitHub answers 403 or 404.
//   - For a repository of an organisation: two-factor sign-in is required (GET orgs/{org}, which
//     GitHub shows only to owners).
// What Kestrel may not read is said in one sentence, and is no finding.
//
// Facts from GitHub's documentation and the source of gh, read on 14 Nov 2026: on an HTTP error,
// "gh api" writes the answer's body to standard output and "gh: <message> (HTTP <status>)" to
// standard error, and ends with exit code 1. It ends with exit code 4 when nobody is signed in.
// "--paginate --slurp" gives an array of pages.
import { CALL_LIMIT, cloudFinding, findProgram, firstLine, parseJson, runProgram } from './cloud.mjs'

/** The HTTP status and message of a failed "gh api", from its standard error. */
export function httpError(stderr) {
  const m = String(stderr).match(/^gh: (.*) \(HTTP (\d{3})\)$/m)
  return m ? { status: Number(m[2]), message: m[1] } : { status: undefined, message: firstLine(stderr) }
}

/** Checks one GitHub repository. See src/cloud.mjs for what it returns. */
export async function githubCheck(options, { env }) {
  const gh = findProgram('gh', env)
  if (!gh) throw new Error('The GitHub command line tool (gh) is not installed, so Kestrel cannot read GitHub. Install it and sign in with "gh auth login", then run this again.')
  const run = (args) => {
    const r = runProgram(gh, args, { env })
    if (r.timedOut) throw new Error(`The GitHub command line tool did not answer within ${CALL_LIMIT / 1000} seconds. Nothing was saved. Try again later.`)
    if (r.failed) throw new Error(`The GitHub command line tool could not start: ${firstLine(r.failed)}.`)
    if (r.status === 4) throw new Error('The GitHub command line tool is not signed in. Sign in with "gh auth login", then run this again.')
    return r
  }
  /** One call of the REST API: `{ ok, body }` or `{ ok: false, status, message }`. A sign-in that GitHub refuses stops the run. */
  const api = (path, paginate = false) => {
    const r = run(['api', ...(paginate ? ['--paginate', '--slurp'] : []), '-H', 'Accept: application/vnd.github+json', path])
    if (r.status === 0) {
      const body = parseJson(r.stdout)
      if (body === undefined) throw new Error(`GitHub gave an answer that Kestrel could not read (${path.split('?')[0]}). Nothing was saved.`)
      return { ok: true, body }
    }
    const e = httpError(r.stderr)
    if (e.status === 401) throw new Error('GitHub did not accept the sign-in of the GitHub command line tool. Sign in again with "gh auth login", then run this again.')
    if (!e.status) throw new Error(`The GitHub command line tool failed: ${e.message || `exit code ${r.status}`}. Nothing was saved.`)
    return { ok: false, ...e }
  }
  /** The number of items over all pages of a list. */
  const total = (pages) => (Array.isArray(pages) ? pages.reduce((n, page) => n + (Array.isArray(page) ? page.length : 0), 0) : 0)

  let name = options.repo
  if (!name) {
    const view = run(['repo', 'view', '--json', 'nameWithOwner'])
    name = parseJson(view.stdout)?.nameWithOwner
    if (view.status !== 0 || !name) throw new Error('This folder is not a GitHub repository that gh knows. Name one: kestrel cloud-check github --repo <owner/name>')
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error(`"${name}" is not a repository name. Use owner/name, for example: --repo octo-org/web`)
  const repo = api(`repos/${name}`)
  if (!repo.ok) throw new Error(repo.status === 404 ? `GitHub has no repository ${name} that this sign-in can see.` : `GitHub could not give the repository ${name}: ${repo.message}. Nothing was saved.`)
  const r = repo.body
  const scope = `cloud:github:${name}`
  const where = { provider: 'github', project: name }
  const findings = []
  const notes = []
  const add = (rule, severity, title, detail, key = name) => findings.push(cloudFinding({ rule, key, scope, severity, title, detail, where, source: 'github' }))

  // A review before a merge into the default branch: a ruleset, or branch protection.
  const branch = String(r.default_branch ?? '')
  if (branch) {
    const path = `repos/${name}/branches/${encodeURIComponent(branch)}`
    const rules = api(`repos/${name}/rules/branches/${encodeURIComponent(branch)}?per_page=100`)
    const byRuleset = rules.ok && Array.isArray(rules.body) && rules.body.some((rule) => rule?.type === 'pull_request' && rule.parameters?.required_approving_review_count >= 1)
    const protection = api(`${path}/protection`)
    const byProtection = protection.ok && protection.body?.required_pull_request_reviews?.required_approving_review_count >= 1
    // A 404 says "Branch not protected" when there is none, and "Not Found" when this sign-in may not read it.
    const unprotected = protection.ok || /not protected/i.test(protection.message ?? '')
    if (!byRuleset && !byProtection) {
      if (unprotected) add('cloud.github.no-review', 'high', `The default branch ${branch} can be changed without an approving review`, 'Add a ruleset or branch protection for it that requires at least one approving review of a pull request.')
      else notes.push(`No ruleset requires a review on ${branch}, and Kestrel may not read its branch protection: that needs admin rights to the repository.`)
    }
  }

  // Secret scanning and push protection, which GitHub shows only to admins.
  const security = r.security_and_analysis
  if (security && typeof security === 'object') {
    if (security.secret_scanning?.status !== 'enabled') add('cloud.github.secret-scanning-off', 'high', 'Secret scanning is off', 'Turn it on under Settings, Advanced Security (Code security) of the repository.')
    if (security.secret_scanning_push_protection?.status !== 'enabled') add('cloud.github.push-protection-off', 'medium', 'Push protection for secrets is off', 'With it on, GitHub blocks a push that holds a known kind of secret. Turn it on under Settings, Advanced Security.')
  } else notes.push('GitHub shows whether secret scanning and push protection are on only to admins of the repository, so Kestrel could not check them.')
  // The literal secrets stay out of the answer, and only the count is kept.
  const secrets = api(`repos/${name}/secret-scanning/alerts?state=open&per_page=100&hide_secret=true`, true)
  if (secrets.ok) {
    const n = total(secrets.body)
    if (n) add('cloud.github.secret-alerts', 'high', `${n} open secret scanning ${n === 1 ? 'alert' : 'alerts'}`, 'GitHub found secrets in the repository. Revoke each one at its provider, then close the alert. Kestrel kept only the count.')
  }

  // Dependabot alerts of severity high and critical: the count only.
  const deps = api(`repos/${name}/dependabot/alerts?state=open&severity=critical,high&per_page=100`, true)
  if (deps.ok) {
    const n = total(deps.body)
    if (n) add('cloud.github.dependabot-alerts', 'high', `${n} open Dependabot ${n === 1 ? 'alert' : 'alerts'} of severity high or critical`, 'Update the dependencies that the alerts name. Kestrel kept only the count.')
  } else if (/disabled/i.test(deps.message ?? '')) add('cloud.github.dependabot-off', 'medium', 'Dependabot alerts are off', 'Turn them on under Settings, Advanced Security, so that GitHub says when a dependency has a known vulnerability.')
  else notes.push(`Kestrel may not read the Dependabot alerts (${deps.message}).`)

  // Code scanning: the count of open alerts, or "not enabled" on 403 or 404.
  const code = api(`repos/${name}/code-scanning/alerts?state=open&per_page=100`, true)
  if (code.ok) {
    const n = total(code.body)
    if (n) add('cloud.github.code-scanning-alerts', 'medium', `${n} open code scanning ${n === 1 ? 'alert' : 'alerts'}`, 'Look at them under Security, Code scanning of the repository. Kestrel kept only the count.')
  } else if (code.status === 403 || code.status === 404) add('cloud.github.code-scanning-off', 'low', 'Code scanning is not enabled', `GitHub answered ${code.status}: ${String(code.message).replace(/\.$/, '')}. Set it up under Security, Code scanning, for example with CodeQL's default setup.`)
  else notes.push(`Kestrel could not read the code scanning alerts (${code.message}).`)

  // An organisation: two-factor sign-in required. GitHub shows it only to owners.
  if (r.owner?.type === 'Organization' && r.owner.login) {
    const org = api(`orgs/${r.owner.login}`)
    const required = org.ok ? org.body?.two_factor_requirement_enabled : undefined
    if (required === false) add('cloud.github.org-2fa-off', 'high', `The organisation ${r.owner.login} does not require two-factor sign-in`, 'An owner turns it on under the organisation\'s Settings, Authentication security.', `${r.owner.login}:${name}`)
    else if (required !== true) notes.push(`GitHub shows whether ${r.owner.login} requires two-factor sign-in only to its owners, so Kestrel could not check it.`)
  }

  const kind = r.owner?.type === 'Organization' ? `of the organisation ${r.owner.login}` : 'of a personal account'
  return { what: `GitHub repository ${name} (${r.private ? 'private' : 'public'}, ${kind})`, runs: [{ scope, findings }], notes }
}
