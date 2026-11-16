// "kestrel cloud-check aws": read-only checks of one AWS account, with the person's own sign-in.
//
// First "aws sts get-caller-identity" says which account the sign-in is for. Only the account id
// is kept. Then one of two paths:
//   - When Prowler is installed, Kestrel runs it with the compliance frameworks that match the
//     frameworks that are on (only those Prowler has), within a time limit, and reads its JSON-OCSF
//     output. Prowler only reads.
//   - Otherwise Kestrel reads the results AWS already has: the non-compliant rules of the AWS
//     Config conformance packs that are deployed, and the Security Hub CSPM findings of severity
//     high and critical. When neither is there, or neither may be read, one finding of severity
//     info says what to switch on and what it costs.
//
// Facts from AWS's documentation, read on 14 Nov 2026:
//   - The AWS CLI ends with exit code 253 when its configuration or credentials are missing, and
//     254 when the service answered with an error. Its error line reads "An error occurred
//     (<Code>) when calling the <Operation> operation: <message>".
//   - "get-conformance-pack-compliance-details" is not paginated by the CLI: Kestrel follows its
//     NextToken. "get-findings" is, and --max-items caps it.
//   - Security Hub was renamed Security Hub CSPM in 2025. "get-findings" still gives its findings
//     in the AWS Security Finding Format. The new Security Hub gives OCSF with "get-findings-v2".
//   - The AWS managed policy SecurityAudit allows every read here. sts:GetCallerIdentity needs no
//     permission at all.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CALL_LIMIT, cloudFinding, control, findProgram, firstLine, parseJson, runProgram } from './cloud.mjs'

/** The pages with the prices, for the finding that says what to switch on. */
export const PRICES = {
  securityHub: 'https://aws.amazon.com/security-hub/cspm/pricing/',
  config: 'https://aws.amazon.com/config/pricing/',
}

/**
 * Prowler's compliance frameworks for AWS, for each framework of Kestrel that Prowler has. HITRUST
 * has none: its findings come through the controls it shares with HIPAA and ISO 27001. Prowler
 * has nothing for GLBA or NYDFS. Its DORA file covers several providers, and its results go only
 * to Prowler's own compliance report, not to the findings Kestrel reads, so it is left out.
 */
export const PROWLER_FRAMEWORKS = {
  hipaa: ['hipaa_aws'],
  hitrust: ['hipaa_aws', 'iso27001_2022_aws'],
  soc2: ['soc2_aws'],
  iso27001: ['iso27001_2022_aws'],
  part11: ['gxp_21_cfr_part_11_aws'],
  annex11: ['gxp_eu_annex_11_aws'],
  gdpr: ['gdpr_aws'],
  pci: ['pci_4.0_aws'],
}

// The keys of Prowler's "unmapped.compliance" (its framework, a dash and its version) and of
// AWS's conformance packs and requirements, matched to Kestrel's frameworks by their names.
const PROWLER_KEYS = [[/^HIPAA/i, 'hipaa'], [/^SOC ?2/i, 'soc2'], [/^PCI/i, 'pci'], [/^ISO ?27001/i, 'iso27001'], [/^GDPR/i, 'gdpr'], [/21-CFR-Part-11/i, 'part11'], [/Annex-11/i, 'annex11']]
const PACK_KEYS = [[/hipaa/i, 'hipaa'], [/pci/i, 'pci'], [/21.?cfr|part.?11/i, 'part11'], [/annex.?11/i, 'annex11'], [/glba|gramm/i, 'glba'], [/nydfs/i, 'nydfs'], [/gdpr/i, 'gdpr']]

// The names of Security Hub CSPM's standards, by the start of their StandardsId.
const STANDARDS = [
  [/aws-foundation(al-security)?-best-practices/, 'AWS Foundational Security Best Practices'],
  [/cis-aws-foundations-benchmark\/v\/([\d.]+)/, 'CIS AWS Foundations Benchmark v$1'],
  [/nist-800-53/, 'NIST SP 800-53 Rev. 5'],
  [/nist-800-171/, 'NIST SP 800-171 Rev. 2'],
  [/pci-dss\/v\/([\d.]+)/, 'PCI DSS v$1'],
  [/aws-resource-tagging-standard/, 'AWS Resource Tagging Standard'],
  [/ai-security-best-practices/, 'AWS AI Security Best Practices'],
  [/service-managed-aws-control-tower/, 'AWS Control Tower'],
]
const standardName = (id) => {
  for (const [pattern, name] of STANDARDS) {
    const m = String(id).match(pattern)
    if (m) return name.replace('$1', m[1] ?? '')
  }
  return String(id)
}

// The filter for Security Hub CSPM: findings of its controls (ComplianceStatus FAILED is only on
// those) of severity critical and high, active, and not resolved or suppressed.
export const HUB_FILTER = {
  SeverityLabel: [{ Value: 'CRITICAL', Comparison: 'EQUALS' }, { Value: 'HIGH', Comparison: 'EQUALS' }],
  RecordState: [{ Value: 'ACTIVE', Comparison: 'EQUALS' }],
  WorkflowStatus: [{ Value: 'RESOLVED', Comparison: 'NOT_EQUALS' }, { Value: 'SUPPRESSED', Comparison: 'NOT_EQUALS' }],
  ComplianceStatus: [{ Value: 'FAILED', Comparison: 'EQUALS' }],
}
// The most Security Hub findings one run reads.
const HUB_MOST = 1000

/** The code of an AWS CLI error ("AccessDeniedException"), from its error line, or undefined. */
export const errorCode = (stderr) => String(stderr).match(/An error occurred \(([\w.]+)\)/)?.[1]
const denied = (code) => /AccessDenied|UnauthorizedOperation|AuthorizationError/i.test(code ?? '')

/**
 * A control id as Prowler writes it, in the framework's own way where the two differ: HIPAA's
 * "164_308_a_1_ii_b" as "164.308(a)(1)(ii)(B)", SOC 2's "cc_6_1" as "CC6.1", and 21 CFR Part
 * 11's "11.10-a" as "11.10(a)". Others stay as they are, such as PCI DSS's "1.2.5.1".
 */
export function lawId(framework, id) {
  const text = String(id)
  if (framework === 'part11') {
    const m = text.match(/^(\d+\.\d+)-([a-z])$/i)
    if (m) return `${m[1]}(${m[2].toLowerCase()})`
  }
  if (framework === 'hipaa') {
    const m = text.match(/^(\d{3})_(\d{3})((?:_[a-z0-9]+)*)$/i)
    if (m) {
      const parts = m[3].split('_').filter(Boolean)
      return `${m[1]}.${m[2]}${parts.map((p, i) => `(${i === 3 ? p.toUpperCase() : p.toLowerCase()})`).join('')}`
    }
  }
  if (framework === 'soc2') {
    const m = text.match(/^([a-z]+)_(\d+)_(\d+)$/i)
    if (m) return `${m[1].toUpperCase()}${m[2]}.${m[3]}`
  }
  return text
}

const SEVERITY = { critical: 'high', high: 'high', medium: 'medium', low: 'low', informational: 'info', info: 'info' }

/** The sentence for a sign-in that does not work, from what the AWS CLI said. */
function signInSentence(r, profile) {
  const who = profile ? ` for the profile ${profile}` : ''
  if (r.status === 253 || /credential|expired|sso|token/i.test(r.stderr)) return `The AWS command line tool is not signed in${who}. Sign in (for example with "aws sso login" or "aws configure"), then run this again.`
  return `The AWS command line tool could not say which account it is signed in to${who}: ${firstLine(r.stderr) || `exit code ${r.status}`}.`
}

/** Checks one AWS account. See src/cloud.mjs for what it returns. */
export async function awsCheck(options, { env, frameworks, catalog }) {
  const minutes = options.minutes === undefined ? 20 : Number(options.minutes)
  if (!(minutes > 0 && minutes <= 600)) throw new Error('--minutes is a number of minutes above 0 and at most 600.')
  const aws = findProgram('aws', env)
  if (!aws) throw new Error('The AWS command line tool (aws) is not installed, so Kestrel cannot read AWS. Install it and sign in, then run this again.')
  const place = [...(options.profile ? ['--profile', options.profile] : []), ...(options.region ? ['--region', options.region] : [])]
  // No pager: the CLI would wait for a key. Only JSON on standard output.
  const callEnv = { ...env, AWS_PAGER: '' }
  const call = (args) => {
    const r = runProgram(aws, [...args, ...place, '--output', 'json'], { env: callEnv })
    if (r.timedOut) throw new Error(`The AWS command line tool did not answer within ${CALL_LIMIT / 1000} seconds (${args.slice(0, 2).join(' ')}). Nothing was saved. Try again later.`)
    if (r.failed) throw new Error(`The AWS command line tool could not start: ${firstLine(r.failed)}.`)
    return r
  }
  const who = call(['sts', 'get-caller-identity'])
  if (who.status !== 0) throw new Error(signInSentence(who, options.profile))
  const account = parseJson(who.stdout)?.Account
  if (!/^\d{12}$/.test(String(account ?? ''))) throw new Error('The AWS command line tool did not say which account it is signed in to. Nothing was saved.')
  const scope = `cloud:aws:${account}${options.region ? `:${options.region}` : ''}`
  const prowler = findProgram('prowler', env)
  const base = { account, scope, catalog, frameworks, region: options.region }
  return prowler ? prowlerPath(prowler, options, minutes, base, env) : awsPath(call, base)
}

/**
 * The path without Prowler: the non-compliant rules of each deployed conformance pack, and the
 * Security Hub CSPM findings of severity high and critical.
 */
function awsPath(call, { account, scope, catalog, region }) {
  const findings = []
  const notes = []
  const read = []

  // AWS Config: the conformance packs, and for each its rules that are not compliant.
  let config
  const packs = call(['configservice', 'describe-conformance-packs'])
  if (packs.status !== 0) {
    const code = errorCode(packs.stderr)
    if (!denied(code)) throw new Error(`AWS Config could not be read: ${firstLine(packs.stderr)} Nothing was saved.`)
    config = 'denied'
  } else {
    const list = parseJson(packs.stdout)?.ConformancePackDetails
    if (!Array.isArray(list)) throw new Error('AWS Config gave an answer that Kestrel could not read. Nothing was saved.')
    config = list.length ? 'read' : 'none'
    for (const pack of list) {
      const name = String(pack.ConformancePackName ?? '')
      const packRegion = String(pack.ConformancePackArn ?? '').split(':')[3] || region
      const keys = PACK_KEYS.filter(([pattern]) => pattern.test(name)).map(([, key]) => key)
      let token
      do {
        const r = call(['configservice', 'get-conformance-pack-compliance-details', '--conformance-pack-name', name, '--filters', 'ComplianceType=NON_COMPLIANT', '--limit', '100', ...(token ? ['--next-token', token] : [])])
        if (r.status !== 0) throw new Error(`AWS Config could not give the results of the conformance pack ${name}: ${firstLine(r.stderr)} Nothing was saved.`)
        const page = parseJson(r.stdout)
        if (!Array.isArray(page?.ConformancePackRuleEvaluationResults)) throw new Error(`AWS Config gave an answer about the conformance pack ${name} that Kestrel could not read. Nothing was saved.`)
        for (const result of page.ConformancePackRuleEvaluationResults) {
          const q = result?.EvaluationResultIdentifier?.EvaluationResultQualifier ?? {}
          if (result?.ComplianceType !== 'NON_COMPLIANT' || !q.ConfigRuleName) continue
          // The annotation can hold text about the resource, so it is left out.
          findings.push(cloudFinding({
            rule: `cloud.aws.config.${q.ConfigRuleName}`, key: `${account}:${q.ResourceType}:${q.ResourceId}`, scope, severity: 'medium',
            title: `Not compliant with the AWS Config rule ${q.ConfigRuleName}`,
            detail: `A rule of the conformance pack ${name}. AWS's page of the pack's template says which controls the rule maps to.`,
            where: { provider: 'aws', account, resource: `${q.ResourceType} ${q.ResourceId}`, ...(packRegion ? { region: packRegion } : {}) },
            controls: keys.map((key) => control(catalog, key, q.ConfigRuleName, `AWS Config rule in the conformance pack ${name}`)),
            reported: [`AWS Config conformance pack ${name}`],
            source: 'aws-config',
          }))
        }
        token = page.NextToken
      } while (token)
    }
    if (list.length) read.push(`AWS Config (${list.length} conformance ${list.length === 1 ? 'pack' : 'packs'})`)
  }

  // Security Hub CSPM: the findings of its controls, of severity critical and high.
  let hub
  const r = call(['securityhub', 'get-findings', '--filters', JSON.stringify(HUB_FILTER), '--max-items', String(HUB_MOST)])
  if (r.status !== 0) {
    const code = errorCode(r.stderr)
    if (code === 'InvalidAccessException') hub = 'off'
    else if (denied(code)) hub = 'denied'
    else throw new Error(`Security Hub could not be read: ${firstLine(r.stderr)} Nothing was saved.`)
  } else {
    const answer = parseJson(r.stdout)
    if (!Array.isArray(answer?.Findings)) throw new Error('Security Hub gave an answer that Kestrel could not read. Nothing was saved.')
    hub = 'read'
    read.push('Security Hub CSPM')
    if (answer.NextToken) notes.push(`Security Hub has more than ${HUB_MOST} findings of severity high and critical: Kestrel read the first ${HUB_MOST}.`)
    for (const f of answer.Findings) {
      const controlId = f?.Compliance?.SecurityControlId ?? String(f?.GeneratorId ?? '').split('/').pop()
      if (!f?.Id || !controlId) continue
      const resource = Array.isArray(f.Resources) ? f.Resources[0] : undefined
      const pci = (Array.isArray(f.Compliance?.RelatedRequirements) ? f.Compliance.RelatedRequirements : [])
        .map((req) => String(req).match(/^PCI DSS (v[\d.]+\/|)([\d.]+)$/))
        .filter(Boolean)
      findings.push(cloudFinding({
        rule: `cloud.aws.securityhub.${controlId}`, key: f.Id, scope, severity: SEVERITY[String(f.Severity?.Label).toLowerCase()] ?? 'high',
        title: String(f.Title ?? `Security Hub control ${controlId} failed`),
        detail: `Security Hub CSPM control ${controlId}.${f.Remediation?.Recommendation?.Url ? ` How to fix it: ${f.Remediation.Recommendation.Url}` : ''}`,
        where: { provider: 'aws', account: String(f.AwsAccountId ?? account), ...(resource?.Id ? { resource: String(resource.Id) } : {}), ...(f.Region ? { region: String(f.Region) } : {}) },
        controls: pci.map((m) => control(catalog, 'pci', m[2], `PCI DSS ${m[1] ? m[1].slice(0, -1) : ''}`.trim())),
        reported: (Array.isArray(f.Compliance?.AssociatedStandards) ? f.Compliance.AssociatedStandards : []).map((s) => standardName(s?.StandardsId)),
        source: 'security-hub',
      }))
    }
  }

  const configWords = { none: 'No AWS Config conformance pack is deployed', denied: 'Kestrel may not read AWS Config (the read needs the policy SecurityAudit)' }
  const hubWords = { off: 'Security Hub CSPM is not switched on, or Kestrel may not read it', denied: 'Kestrel may not read Security Hub (the read needs the policy SecurityAudit)' }
  if (config !== 'read' && hub !== 'read') {
    findings.push(cloudFinding({
      rule: 'cloud.aws.nothing-to-read', key: account, scope, severity: 'info',
      title: 'AWS has no compliance results that Kestrel can read',
      detail: `${configWords[config]}, and ${hubWords[hub]}. To get results, switch on Security Hub CSPM with a standard such as AWS Foundational Security Best Practices: it costs about $0.001 per check of one resource in one region, after a 30 day free trial (${PRICES.securityHub}). Or deploy an AWS Config conformance pack, such as the one for HIPAA Security: about $0.001 per rule evaluation and $0.003 per configuration item recorded (${PRICES.config}). Or install Prowler, which is free and reads the account itself.`,
      where: { provider: 'aws', account, ...(region ? { region } : {}) },
      source: 'kestrel',
    }))
  } else {
    if (config !== 'read') notes.push(`${configWords[config]}.`)
    if (hub !== 'read') notes.push(`${hubWords[hub]}.`)
  }
  const what = `AWS account ${account}${region ? ` in ${region}` : ''}${read.length ? `: ${read.join(' and ')}` : ''}`
  return { what, runs: [{ scope, findings }], notes }
}

/**
 * The path with Prowler: it runs with the compliance frameworks that match the frameworks that are
 * on, within the time limit, and writes its findings as JSON-OCSF into a new temp folder. Only the
 * failed checks become findings: the check's title, the resource's id, and the controls of the
 * frameworks that Prowler reported. Prowler's own text about a resource is left out, because it can
 * name what it found.
 */
function prowlerPath(prowler, options, minutes, { account, scope, catalog, frameworks, region }, env) {
  const compliance = [...new Set(frameworks.flatMap((key) => PROWLER_FRAMEWORKS[key] ?? []))]
  const folder = mkdtempSync(join(tmpdir(), 'kestrel-prowler-'))
  const args = [
    'aws', '--output-formats', 'json-ocsf', '--output-directory', folder, '--output-filename', 'kestrel',
    '--status', 'FAIL', '--no-banner', '--ignore-exit-code-3',
    ...(compliance.length ? ['--compliance', ...compliance] : []),
    ...(options.profile ? ['--profile', options.profile] : []),
    ...(region ? ['--region', region] : []),
  ]
  let r
  let results
  // Prowler's file names every resource it checked: it is read once and then deleted with its folder, also after a failed run.
  try {
    r = runProgram(prowler, args, { env, timeoutMs: minutes * 60e3, quiet: true })
    const file = join(folder, 'kestrel.ocsf.json')
    results = r.status === 0 && !r.timedOut && !r.failed && existsSync(file) ? parseJson(readFileSync(file, 'utf8')) : []
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
  if (r.timedOut) throw new Error(`Prowler did not finish within ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, so nothing was saved. Give it more time with --minutes, for example: kestrel cloud-check aws --minutes ${Math.ceil(minutes * 2)}`)
  if (r.failed) throw new Error(`Prowler could not start: ${firstLine(r.failed)}.`)
  if (r.status !== 0) throw new Error(`Prowler ended with exit code ${r.status}: ${firstLine(r.stderr) || 'it said nothing more'}. Nothing was saved.`)
  // Prowler writes the file only when it has findings to write: with --status FAIL, no file
  // after a run that ended well means that no check failed. The folder is new, so no file of an
  // earlier run is there (Prowler would add to it).
  if (!Array.isArray(results)) throw new Error("Prowler's file could not be read. Nothing was saved.")
  const findings = []
  for (const p of results) {
    // A finding that the person muted in Prowler has the status "Suppressed".
    if (p?.status_code !== 'FAIL' || p.status === 'Suppressed') continue
    const check = String(p.metadata?.event_code ?? '')
    if (!check) continue
    const resource = Array.isArray(p.resources) ? p.resources[0] : undefined
    const resourceId = String(resource?.uid ?? resource?.name ?? p.cloud?.region ?? 'account')
    const controls = []
    const reported = []
    for (const [name, ids] of Object.entries(p.unmapped?.compliance ?? {})) {
      const key = PROWLER_KEYS.find(([pattern]) => pattern.test(name))?.[1]
      reported.push(name)
      if (!key || !Array.isArray(ids)) continue
      for (const id of ids) controls.push(control(catalog, key, lawId(key, id), undefined))
    }
    findings.push(cloudFinding({
      rule: `cloud.aws.prowler.${check}`, key: `${account}:${resourceId}`, scope, severity: SEVERITY[String(p.severity).toLowerCase()] ?? 'medium',
      title: String(p.finding_info?.title ?? check),
      detail: `Prowler check ${check}.${p.remediation?.desc ? ` What to change: ${String(p.remediation.desc).slice(0, 300)}` : ''}`,
      where: { provider: 'aws', account: String(p.cloud?.account?.uid ?? account), resource: resourceId, ...((resource?.region ?? p.cloud?.region) ? { region: String(resource?.region ?? p.cloud.region) } : {}) },
      controls: controls.map(({ label, ...c }) => (label ? { ...c, label } : c)),
      reported,
      source: 'prowler',
    }))
  }
  const names = compliance.length ? compliance.join(', ') : 'all its checks, because no framework that is on has one in Prowler'
  return {
    what: `AWS account ${account}${region ? ` in ${region}` : ''} with Prowler (${names})`,
    runs: [{ scope, findings }],
    notes: ["Prowler's own report named every resource it checked, so Kestrel deleted it after reading it. For the full report, run Prowler yourself."],
  }
}
