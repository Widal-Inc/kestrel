// Tests for the cloud checks ("kestrel cloud-check aws|vercel|github"), the pane's Security tab and
// the desktop tool security_check. Run: node --test
//
// The real aws, prowler, vercel and gh are never reached. Every test puts a folder of stand-in
// programs on PATH, and only that folder: no other folder of the system is on it, because a real
// tool can sit next to Node. Each stand-in starts Node by its full path, logs its arguments, and
// answers from fixtures in the shapes that the providers' documentation shows (the source of each
// shape is named above it). The network is never used: Vercel's REST API is a stand-in function.
//
// A trap watches every file that is opened, in this process and in the command when the test
// starts it: a file in any folder named .aws, other than "config" (a credentials file), is
// recorded, and every stand-in that runs after that fails. The test's own ~/.aws/credentials holds
// a made-up key.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'kestrel-cloud-test-'))
process.env.HOME = join(dir, 'person')
process.env.KESTREL_HOME = join(dir, 'home')
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
process.env.CODEX_HOME = join(dir, 'codex')
process.env.KESTREL_COWORK_DIR = join(dir, 'cowork')
// This process's own PATH holds only the stand-ins too, so that nothing can reach a real tool.
const BIN = join(dir, 'bin')
mkdirSync(BIN, { recursive: true })
process.env.PATH = BIN
for (const name of ['VERCEL_TOKEN', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) delete process.env[name]

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[/\\]$/, '')
const KESTREL = join(ROOT, 'cli', 'kestrel.mjs')
// A word in every place where a provider's answer holds text about a resource, a secret or a
// person. No finding, no printed line and no prompt may hold it.
const MARKER = 'PELICANSECRET'
const NOW = Date.parse('2026-11-14T12:00:00')

// The trap: the file that it writes when a credentials file was opened, and the module that sets
// it in a process that the test starts.
const TRAP = join(dir, 'trap-sprung')
const TRAP_MODULE = join(dir, 'trap.mjs')
const trapSource = `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'
function guard(p) {
  if (typeof p !== 'string' && !(p instanceof URL)) return
  const file = resolve(p instanceof URL ? p.pathname : p)
  if (/\\/\\.aws\\/(?!config$)/.test(file)) {
    fs.writeFileSync(process.env.STANDIN_TRAP, file)
    throw new Error('a credentials file was opened: ' + file)
  }
}
for (const name of ['readFileSync', 'openSync', 'readFile', 'open', 'createReadStream']) {
  const original = fs[name]
  fs[name] = function (p, ...rest) { guard(p); return original.call(this, p, ...rest) }
}
for (const name of ['readFile', 'open']) {
  const original = fs.promises[name]
  fs.promises[name] = function (p, ...rest) { guard(p); return original.call(this, p, ...rest) }
}
syncBuiltinESMExports()
`
writeFileSync(TRAP_MODULE, trapSource)
process.env.STANDIN_TRAP = TRAP
// The same trap in this process, before any module of the tool is loaded.
{
  const fs = createRequire(import.meta.url)('node:fs')
  const guard = (p) => {
    if (typeof p !== 'string' && !(p instanceof URL)) return
    const file = resolve(p instanceof URL ? p.pathname : p)
    if (/\/\.aws\/(?!config$)/.test(file)) {
      fs.writeFileSync(TRAP, file)
      throw new Error(`a credentials file was opened: ${file}`)
    }
  }
  for (const name of ['readFileSync', 'openSync', 'readFile', 'open', 'createReadStream']) {
    const original = fs[name]
    fs[name] = function (p, ...rest) {
      guard(p)
      return original.call(this, p, ...rest)
    }
  }
  syncBuiltinESMExports()
}

// The stand-ins. One runner answers for all four tools: it fails when the trap has sprung, logs
// the call, and answers with the first step of the plan whose pattern fits the arguments. A step
// can sleep first, and for Prowler write its JSON-OCSF file where the arguments say.
const RUNNER = join(dir, 'standin.cjs')
writeFileSync(RUNNER, `const fs = require('fs')
const path = require('path')
module.exports = (tool) => {
  const args = process.argv.slice(2)
  if (fs.existsSync(process.env.STANDIN_TRAP)) {
    process.stderr.write('stand-in: a credentials file was opened before this call\\n')
    process.exitCode = 99
    return
  }
  // The real aws reads its config file. The stand-in does too: that one file is allowed.
  if (tool === 'aws') try { fs.readFileSync(path.join(process.env.HOME, '.aws', 'config')) } catch {}
  fs.appendFileSync(process.env.STANDIN_LOG, JSON.stringify({ tool, args, token: process.env.VERCEL_TOKEN ? 'set' : null }) + '\\n')
  const plan = JSON.parse(fs.readFileSync(process.env.STANDIN_PLAN, 'utf8'))[tool] ?? []
  const step = plan.find((s) => new RegExp(s.when).test(args.join(' ')))
  if (!step) {
    process.stderr.write('stand-in ' + tool + ': no answer for: ' + args.join(' ') + '\\n')
    process.exitCode = 98
    return
  }
  const finish = () => {
    if (step.ocsf) fs.writeFileSync(path.join(args[args.indexOf('--output-directory') + 1], args[args.indexOf('--output-filename') + 1] + '.ocsf.json'), JSON.stringify(step.ocsf))
    if (step.stdout !== undefined) process.stdout.write(typeof step.stdout === 'string' ? step.stdout : JSON.stringify(step.stdout))
    if (step.stderr) process.stderr.write(step.stderr)
    process.exitCode = step.status ?? 0
  }
  if (step.sleepMs) setTimeout(finish, step.sleepMs)
  else finish()
}
`)

const { cloudCheck } = await import('../src/cloud.mjs')
const { HUB_FILTER, PRICES } = await import('../src/cloud-aws.mjs')
const { readFindings, saveFindings } = await import('../src/findings.mjs')
const { CHECK_NOTE } = await import('../src/finding-words.mjs')

let machines = 0
/**
 * A made-up computer with stand-ins for `tools` on its PATH: a home folder with ~/.aws/config and
 * a credentials file that nothing may open, Kestrel's folder, and the stand-ins' plan and log.
 * This process points at it. Returns the environment for the tools and a way to set the plan.
 */
function machine(tools = ['aws', 'prowler', 'vercel', 'gh']) {
  const home = join(dir, `machine-${++machines}`)
  const bin = join(home, 'bin')
  mkdirSync(join(home, '.aws'), { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(home, '.aws', 'config'), '[default]\nregion = eu-west-1\n')
  writeFileSync(join(home, '.aws', 'credentials'), `[default]\naws_access_key_id = AKIAEXAMPLE${MARKER}\naws_secret_access_key = ${MARKER}\n`)
  for (const tool of tools) {
    writeFileSync(join(bin, tool), `#!${process.execPath}\nrequire(${JSON.stringify(RUNNER)})(${JSON.stringify(tool)})\n`)
    chmodSync(join(bin, tool), 0o755)
  }
  const env = {
    PATH: bin, HOME: home, KESTREL_HOME: join(home, '.kestrel'), CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), KESTREL_COWORK_DIR: join(home, 'cowork'),
    STANDIN_PLAN: join(home, 'plan.json'), STANDIN_LOG: join(home, 'calls.jsonl'), STANDIN_TRAP: TRAP, NO_COLOR: '1',
  }
  writeFileSync(env.STANDIN_LOG, '')
  for (const key of ['HOME', 'KESTREL_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'KESTREL_COWORK_DIR']) process.env[key] = env[key]
  const plan = (value) => writeFileSync(env.STANDIN_PLAN, JSON.stringify(value))
  const calls = (tool) => readFileSync(env.STANDIN_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => !tool || c.tool === tool)
  plan({})
  return { home, env, plan, calls }
}
/** Runs the command itself on a made-up computer, with the trap in its process too. */
const kestrel = (m, args, more = {}) => spawnSync(process.execPath, [KESTREL, ...args], { encoding: 'utf8', env: { ...m.env, NODE_OPTIONS: `--import ${pathToFileURL(TRAP_MODULE)}`, ...more } })
/** The findings file as text, to look for what must never be in it. */
const stored = (m) => (existsSync(join(m.env.KESTREL_HOME, 'findings.json')) ? readFileSync(join(m.env.KESTREL_HOME, 'findings.json'), 'utf8') : '')

// A small stand-in of builder A's catalog, src/controls.mjs: a label and whether the id is confirmed.
const CATALOG = {
  hipaa: [{ id: '164.312(a)', label: 'Access control', confirmed: true }, { id: '164.312(d)', label: 'Person or entity authentication', confirmed: true }, { id: '164.308(a)(1)(ii)(B)', label: 'Risk management', confirmed: false }],
  soc2: { 'CC6.1': { label: 'Logical access security', confirmed: false } },
}

// ---- AWS fixtures ----

// aws sts get-caller-identity: the example on docs.aws.amazon.com/cli/latest/reference/sts/get-caller-identity.html
const IDENTITY = { UserId: 'AIDASAMPLEUSERID', Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/DevAdmin' }
// One finding of Prowler's JSON-OCSF output: the example on docs.prowler.com, Reporting (made with
// Prowler 5.3.0), shortened. "message", "status_detail" and "resources[].data" hold text about the
// resource: the marker is there, and must never be kept.
const prowlerFinding = (fields = {}) => ({
  message: `Potential secrets found in ECS task definition ${MARKER}`,
  metadata: { event_code: 'ecs_task_definitions_no_environment_secrets', product: { name: 'Prowler', uid: 'prowler', vendor_name: 'Prowler', version: '5.3.0' }, profiles: ['cloud', 'datetime'], tenant_uid: '', version: '1.3.0' },
  severity_id: 5, severity: 'Critical', status: 'New', status_code: 'FAIL', status_detail: `Potential secrets found in ECS task definition ${MARKER}`, status_id: 1,
  unmapped: {
    related_url: '', categories: ['secrets'], depends_on: [], related_to: [], notes: '', additional_urls: [],
    compliance: { 'MITRE-ATTACK': ['T1552'], HIPAA: ['164_308_a_1_ii_b', '164_312_a_1'], SOC2: ['cc_6_1'], 'ISO27001-2022': ['A.8.12'] },
  },
  activity_name: 'Create', activity_id: 1,
  finding_info: { created_time: 1737995806, created_time_dt: '2025-01-27T17:36:46.855898', desc: 'Check if secrets exists in ECS task definitions environment variables.', product_uid: 'prowler', title: 'Check if secrets exists in ECS task definitions environment variables', types: ['Protect', 'Secure development', 'Credentials not hard-coded'], uid: 'prowler-aws-ecs_task_definitions_no_environment_secrets-123456789012-eu-central-1-manufacturer-api:7' },
  resources: [{ cloud_partition: 'aws', region: 'eu-central-1', data: { details: MARKER }, group: { name: 'ecs' }, labels: [], name: 'manufacturer-api:7', type: 'AwsEcsTaskDefinition', uid: 'arn:aws:ecs:eu-central-1:123456789012:task-definition/manufacturer-api:7' }],
  category_name: 'Findings', category_uid: 2, class_name: 'Detection Finding', class_uid: 2004,
  cloud: { account: { name: '', type: 'AWS Account', type_id: 10, uid: '123456789012', labels: [] }, org: { name: '', uid: '' }, provider: 'aws', region: 'eu-central-1' },
  remediation: { desc: 'Use Secrets Manager or Parameter Store to securely provide credentials to containers.', references: ['https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specifying-sensitive-data.html'] },
  risk_details: 'The use of a hard-coded password increases the possibility of password guessing.',
  time: 1737995806, time_dt: '2025-01-27T17:36:46.855898', type_uid: 200401, type_name: 'Detection Finding: Create',
  ...fields,
})
// aws configservice describe-conformance-packs: the response syntax of DescribeConformancePacks in
// the AWS Config API reference (the CLI page has no example).
const PACKS = { ConformancePackDetails: [{ ConformancePackName: 'Operational-Best-Practices-for-HIPAA-Security', ConformancePackArn: 'arn:aws:config:eu-west-1:123456789012:conformance-pack/Operational-Best-Practices-for-HIPAA-Security/conformance-pack-abcd1234', ConformancePackId: 'conformance-pack-abcd1234', ConformancePackInputParameters: [], LastUpdateRequestedTime: '2026-11-01T10:00:00Z' }] }
// aws configservice get-conformance-pack-compliance-details: the response syntax of
// GetConformancePackComplianceDetails. "Annotation" can hold text about the resource.
const evaluation = (rule, type, id) => ({
  ComplianceType: 'NON_COMPLIANT',
  EvaluationResultIdentifier: { EvaluationResultQualifier: { ConfigRuleName: rule, ResourceType: type, ResourceId: id, EvaluationMode: 'DETECTIVE' }, OrderingTimestamp: '2026-11-14T09:00:00Z', ResourceEvaluationId: 'eval-1' },
  ConfigRuleInvokedTime: '2026-11-14T09:00:00Z', ResultRecordedTime: '2026-11-14T09:00:01Z', Annotation: `The bucket policy allows ${MARKER}`,
})
const DETAILS_1 = { ConformancePackName: 'Operational-Best-Practices-for-HIPAA-Security', ConformancePackRuleEvaluationResults: [evaluation('s3-bucket-public-read-prohibited-conformance-pack-abcd1234', 'AWS::S3::Bucket', 'patient-exports')], NextToken: 'page-2' }
const DETAILS_2 = { ConformancePackName: 'Operational-Best-Practices-for-HIPAA-Security', ConformancePackRuleEvaluationResults: [evaluation('rds-storage-encrypted-conformance-pack-abcd1234', 'AWS::RDS::DBInstance', 'db-records')] }
// aws securityhub get-findings: the sample control finding on docs.aws.amazon.com, Security Hub
// CSPM, "Sample control findings" (CloudTrail.2), with its severity raised to HIGH, shortened.
const HUB = {
  Findings: [{
    SchemaVersion: '2018-10-08', Id: 'arn:aws:securityhub:us-east-1:123456789012:security-control/CloudTrail.2/finding/a1b2c3d4-5678-90ab-cdef-EXAMPLE11111',
    ProductArn: 'arn:aws:securityhub:us-east-1::product/aws/securityhub', ProductName: 'Security Hub', CompanyName: 'AWS', Region: 'us-east-1', GeneratorId: 'security-control/CloudTrail.2', AwsAccountId: '123456789012',
    Types: ['Software and Configuration Checks/Industry and Regulatory Standards'], Severity: { Label: 'HIGH', Normalized: 70, Original: 'HIGH' },
    Title: 'CloudTrail should have encryption at-rest enabled', Description: 'This AWS control checks whether AWS CloudTrail is configured to use the server side encryption (SSE) AWS KMS key encryption.',
    Remediation: { Recommendation: { Text: 'For information on how to correct this issue, consult the AWS Security Hub CSPM controls documentation.', Url: 'https://docs.aws.amazon.com/console/securityhub/CloudTrail.2/remediation' } },
    Resources: [{ Type: 'AwsCloudTrailTrail', Id: 'arn:aws:cloudtrail:us-east-1:123456789012:trail/TestTrail', Partition: 'aws', Region: 'us-east-1', Details: { AwsCloudTrailTrail: { S3BucketName: MARKER } } }],
    Compliance: {
      Status: 'FAILED', SecurityControlId: 'CloudTrail.2',
      RelatedRequirements: ['CIS AWS Foundations Benchmark v1.2.0/2.7', 'NIST.800-171.r2/3.3.8', 'PCI DSS v3.2.1/3.4', 'PCI DSS v4.0.1/10.3.2'],
      AssociatedStandards: [{ StandardsId: 'ruleset/cis-aws-foundations-benchmark/v/1.2.0' }, { StandardsId: 'standards/aws-foundational-security-best-practices/v/1.0.0' }, { StandardsId: 'standards/pci-dss/v/4.0.1' }],
    },
    Workflow: { Status: 'NEW' }, RecordState: 'ACTIVE',
  }],
}
// The error lines of the AWS CLI: "An error occurred (<Code>) when calling the <Operation> operation: <message>".
const awsError = (code, operation, message) => ({ status: 254, stderr: `\nAn error occurred (${code}) when calling the ${operation} operation: ${message}\n` })
const STS = { when: '^sts get-caller-identity', stdout: IDENTITY }

test('aws with Prowler: the compliance flags follow the frameworks that are on, the failed checks become findings with their controls, and nothing of what Prowler said about a resource is kept', async () => {
  const m = machine()
  m.plan({
    aws: [STS],
    prowler: [{ when: '^aws ', ocsf: [
      prowlerFinding(),
      prowlerFinding({ status_code: 'PASS', metadata: { event_code: 'iam_root_mfa_enabled' } }),
      // A finding that the person muted in Prowler.
      prowlerFinding({ status: 'Suppressed', metadata: { event_code: 's3_bucket_public_access' } }),
      prowlerFinding({ severity: 'Low', severity_id: 2, metadata: { event_code: 'cloudtrail_multi_region_enabled' }, finding_info: { title: 'Ensure CloudTrail is enabled in all regions' }, resources: [], unmapped: { compliance: { 'PCI-4.0': ['10.2.1'] } } }),
    ] }],
  })
  const out = await cloudCheck('aws', { profile: 'work', region: 'eu-central-1' }, { env: m.env, frameworks: ['hipaa', 'hitrust', 'soc2', 'owasp-agentic'], now: NOW, catalog: CATALOG })
  const [run] = m.calls('prowler')
  // HITRUST runs through the frameworks it shares with HIPAA and ISO 27001. OWASP has none in Prowler.
  const at = run.args.indexOf('--compliance')
  assert.deepEqual(run.args.slice(at + 1, at + 4), ['hipaa_aws', 'iso27001_2022_aws', 'soc2_aws'])
  for (const pair of [['--output-formats', 'json-ocsf'], ['--output-filename', 'kestrel'], ['--status', 'FAIL'], ['--profile', 'work'], ['--region', 'eu-central-1']]) assert.equal(run.args[run.args.indexOf(pair[0]) + 1], pair[1], pair[0])
  assert.ok(run.args.includes('--ignore-exit-code-3') && run.args.includes('--no-banner'))
  assert.deepEqual(m.calls('aws').map((c) => c.args), [['sts', 'get-caller-identity', '--profile', 'work', '--region', 'eu-central-1', '--output', 'json']])

  const found = readFindings()
  assert.deepEqual(found.map((f) => [f.id, f.severity, f.status]), [
    ['cloud.aws.prowler.ecs_task_definitions_no_environment_secrets:123456789012:arn:aws:ecs:eu-central-1:123456789012:task-definition/manufacturer-api:7', 'high', 'open'],
    ['cloud.aws.prowler.cloudtrail_multi_region_enabled:123456789012:eu-central-1', 'low', 'open'],
  ])
  const [secrets] = found
  assert.equal(secrets.scope, 'cloud:aws:123456789012:eu-central-1')
  assert.equal(secrets.kind, 'cloud')
  assert.equal(secrets.source, 'prowler')
  assert.equal(secrets.title, 'Check if secrets exists in ECS task definitions environment variables')
  assert.deepEqual(secrets.where, { provider: 'aws', account: '123456789012', resource: 'arn:aws:ecs:eu-central-1:123456789012:task-definition/manufacturer-api:7', region: 'eu-central-1' })
  // The controls of the frameworks Prowler reported, with the ids as the law writes them, and the catalog's labels.
  assert.deepEqual(secrets.controls, [
    { framework: 'hipaa', id: '164.308(a)(1)(ii)(B)', confirmed: false, label: 'Risk management' },
    { framework: 'hipaa', id: '164.312(a)(1)', confirmed: false },
    { framework: 'soc2', id: 'CC6.1', confirmed: false, label: 'Logical access security' },
    { framework: 'iso27001', id: 'A.8.12', confirmed: false },
  ])
  assert.deepEqual(secrets.reported, ['MITRE-ATTACK', 'HIPAA', 'SOC2', 'ISO27001-2022'])
  assert.deepEqual(found[1].controls, [{ framework: 'pci', id: '10.2.1', confirmed: false }])
  // What it printed: the findings, where Prowler's report is, and the sentence.
  assert.match(out, /^Checked AWS account 123456789012 in eu-central-1 with Prowler \(hipaa_aws, iso27001_2022_aws, soc2_aws\)\. Read only\./)
  assert.match(out, /Prowler's own report named every resource it checked, so Kestrel deleted it after reading it\./)
  // The folder of the report is gone.
  const folder = m.calls('prowler').at(-1).args.at(m.calls('prowler').at(-1).args.indexOf('--output-directory') + 1)
  assert.equal(existsSync(folder), false)
  assert.match(out, /2 open findings in AWS \(1 high, 0 medium, 1 low, 0 info\)\./)
  assert.match(out, /Controls: HIPAA 164\.308\(a\)\(1\)\(ii\)\(B\) Risk management \(id to check\); HIPAA 164\.312\(a\)\(1\) \(id to check\); SOC 2 CC6\.1 Logical access security \(id to check\); ISO 27001 A\.8\.12 \(id to check\); HITRUST: through the controls it shares with HIPAA and ISO 27001/)
  assert.ok(out.endsWith(CHECK_NOTE))
  assert.ok(!out.includes(MARKER) && !stored(m).includes(MARKER))

  // No framework that is on has one in Prowler: it runs all its checks. No failed check: no file, and no finding.
  m.plan({ aws: [STS], prowler: [{ when: '^aws ' }] })
  const all = await cloudCheck('aws', { region: 'eu-central-1' }, { env: m.env, frameworks: ['owasp-agentic'], now: NOW + 1, catalog: CATALOG })
  assert.ok(!m.calls('prowler').at(-1).args.includes('--compliance'))
  assert.match(all, /with Prowler \(all its checks, because no framework that is on has one in Prowler\)/)
  assert.deepEqual(readFindings().map((f) => f.status), ['resolved', 'resolved'])
})

test('aws with Prowler: the time limit stops it, a failed run says why, and neither saves or resolves anything', async () => {
  const m = machine()
  saveFindings([{ id: 'cloud.aws.prowler.x:1', rule: 'cloud.aws.prowler.x', kind: 'cloud', severity: 'high', title: 'An older finding', scope: 'cloud:aws:123456789012', where: {}, controls: [] }], { scope: 'cloud:aws:123456789012', kind: 'cloud', now: NOW })
  m.plan({ aws: [STS], prowler: [{ when: '^aws ', sleepMs: 5000 }] })
  const started = Date.now()
  await assert.rejects(cloudCheck('aws', { minutes: '0.02' }, { env: m.env, frameworks: ['hipaa'], now: NOW + 1, catalog: CATALOG }), {
    message: 'Prowler did not finish within 0.02 minutes, so nothing was saved. Give it more time with --minutes, for example: kestrel cloud-check aws --minutes 1',
  })
  assert.ok(Date.now() - started < 4500, 'the stand-in was stopped at the limit')
  m.plan({ aws: [STS], prowler: [{ when: '^aws ', status: 1, stderr: 'Traceback (most recent call last):\n  botocore.exceptions.NoCredentialsError\n' }] })
  await assert.rejects(cloudCheck('aws', {}, { env: m.env, frameworks: ['hipaa'], now: NOW + 2, catalog: CATALOG }), { message: 'Prowler ended with exit code 1: Traceback (most recent call last):. Nothing was saved.' })
  assert.deepEqual(readFindings().map((f) => f.status), ['open'])
  await assert.rejects(cloudCheck('aws', { minutes: 'soon' }, { env: m.env, frameworks: [], now: NOW }), { message: '--minutes is a number of minutes above 0 and at most 600.' })
})

test('aws without Prowler: the non-compliant rules of the conformance packs, page after page, and the Security Hub findings of severity high and critical', async () => {
  const m = machine(['aws'])
  m.plan({ aws: [
    STS,
    { when: '^configservice describe-conformance-packs', stdout: PACKS },
    { when: 'get-conformance-pack-compliance-details .*--next-token page-2', stdout: DETAILS_2 },
    { when: '^configservice get-conformance-pack-compliance-details', stdout: DETAILS_1 },
    { when: '^securityhub get-findings', stdout: HUB },
  ] })
  const out = await cloudCheck('aws', {}, { env: m.env, frameworks: ['hipaa', 'pci'], now: NOW, catalog: CATALOG })
  const args = m.calls('aws').map((c) => c.args)
  assert.deepEqual(args[2], ['configservice', 'get-conformance-pack-compliance-details', '--conformance-pack-name', 'Operational-Best-Practices-for-HIPAA-Security', '--filters', 'ComplianceType=NON_COMPLIANT', '--limit', '100', '--output', 'json'])
  assert.deepEqual(args[3].slice(-4), ['--next-token', 'page-2', '--output', 'json'])
  const hub = args.find((a) => a[0] === 'securityhub')
  assert.deepEqual(JSON.parse(hub[hub.indexOf('--filters') + 1]), HUB_FILTER)
  assert.deepEqual(HUB_FILTER.SeverityLabel.map((s) => s.Value), ['CRITICAL', 'HIGH'])
  assert.equal(hub[hub.indexOf('--max-items') + 1], '1000')

  const found = readFindings()
  // The most severe first, then by id.
  assert.deepEqual(found.map((f) => [f.rule, f.severity, f.source]), [
    ['cloud.aws.securityhub.CloudTrail.2', 'high', 'security-hub'],
    ['cloud.aws.config.rds-storage-encrypted-conformance-pack-abcd1234', 'medium', 'aws-config'],
    ['cloud.aws.config.s3-bucket-public-read-prohibited-conformance-pack-abcd1234', 'medium', 'aws-config'],
  ])
  const [hubFinding, , bucket] = found
  assert.deepEqual(bucket.where, { provider: 'aws', account: '123456789012', resource: 'AWS::S3::Bucket patient-exports', region: 'eu-west-1' })
  assert.deepEqual(bucket.controls, [{ framework: 'hipaa', id: 's3-bucket-public-read-prohibited-conformance-pack-abcd1234', confirmed: false, label: 'AWS Config rule in the conformance pack Operational-Best-Practices-for-HIPAA-Security' }])
  assert.deepEqual(hubFinding.controls, [{ framework: 'pci', id: '3.4', confirmed: false, label: 'PCI DSS v3.2.1' }, { framework: 'pci', id: '10.3.2', confirmed: false, label: 'PCI DSS v4.0.1' }])
  assert.deepEqual(hubFinding.reported, ['CIS AWS Foundations Benchmark v1.2.0', 'AWS Foundational Security Best Practices', 'PCI DSS v4.0.1'])
  assert.deepEqual(hubFinding.where, { provider: 'aws', account: '123456789012', resource: 'arn:aws:cloudtrail:us-east-1:123456789012:trail/TestTrail', region: 'us-east-1' })
  assert.match(out, /^Checked AWS account 123456789012: AWS Config \(1 conformance pack\) and Security Hub CSPM\. Read only\./)
  assert.ok(!out.includes(MARKER) && !stored(m).includes(MARKER))
})

test('aws without Prowler: with nothing deployed, or nothing that may be read, one finding of severity info says what to switch on and what it costs', async () => {
  const m = machine(['aws'])
  m.plan({ aws: [
    STS,
    { when: '^configservice describe-conformance-packs', stdout: { ConformancePackDetails: [] } },
    { when: '^securityhub get-findings', ...awsError('InvalidAccessException', 'GetFindings', 'Account 123456789012 is not subscribed to AWS Security Hub') },
  ] })
  const out = await cloudCheck('aws', {}, { env: m.env, frameworks: ['hipaa'], now: NOW, catalog: CATALOG })
  const [info] = readFindings()
  assert.equal(info.id, 'cloud.aws.nothing-to-read:123456789012')
  assert.equal(info.severity, 'info')
  assert.equal(info.title, 'AWS has no compliance results that Kestrel can read')
  assert.match(info.detail, /^No AWS Config conformance pack is deployed, and Security Hub CSPM is not switched on, or Kestrel may not read it\. To get results, switch on Security Hub CSPM/)
  assert.ok(info.detail.includes(PRICES.securityHub) && info.detail.includes(PRICES.config))
  assert.match(info.detail, /about \$0\.001 per check of one resource in one region, after a 30 day free trial/)
  assert.match(out, /1 open finding in AWS \(0 high, 0 medium, 0 low, 1 info\)/)

  // Not allowed: the same finding says that the read needs SecurityAudit. A later run that reads results resolves it.
  m.plan({ aws: [
    STS,
    { when: '^configservice describe-conformance-packs', ...awsError('AccessDeniedException', 'DescribeConformancePacks', 'User is not authorized') },
    { when: '^securityhub get-findings', ...awsError('AccessDeniedException', 'GetFindings', 'User is not authorized') },
  ] })
  await cloudCheck('aws', {}, { env: m.env, frameworks: ['hipaa'], now: NOW + 1, catalog: CATALOG })
  assert.match(readFindings()[0].detail, /^Kestrel may not read AWS Config \(the read needs the policy SecurityAudit\), and Kestrel may not read Security Hub/)
  m.plan({ aws: [STS, { when: '^configservice describe-conformance-packs', stdout: { ConformancePackDetails: [] } }, { when: '^securityhub get-findings', stdout: { Findings: [] } }] })
  const later = await cloudCheck('aws', {}, { env: m.env, frameworks: ['hipaa'], now: NOW + 2, catalog: CATALOG })
  assert.equal(readFindings()[0].status, 'resolved')
  assert.match(later, /No AWS Config conformance pack is deployed\./)
  // Another error of a service is no reason to resolve anything: the run stops and saves nothing.
  m.plan({ aws: [STS, { when: '^configservice describe-conformance-packs', ...awsError('ThrottlingException', 'DescribeConformancePacks', 'Rate exceeded') }] })
  await assert.rejects(cloudCheck('aws', {}, { env: m.env, frameworks: [], now: NOW + 3 }), /^Error: AWS Config could not be read: An error occurred \(ThrottlingException\)/)
})

test('aws: not installed and not signed in are one sentence each, from the command too, with no stack trace and nothing saved', async () => {
  let m = machine([])
  await assert.rejects(cloudCheck('aws', {}, { env: m.env, frameworks: [] }), { message: 'The AWS command line tool (aws) is not installed, so Kestrel cannot read AWS. Install it and sign in, then run this again.' })
  m = machine(['aws', 'prowler'])
  // The AWS CLI's exit code for missing credentials is 253.
  m.plan({ aws: [{ when: '^sts', status: 253, stderr: '\nUnable to locate credentials. You can configure credentials by running "aws configure".\n' }] })
  const r = kestrel(m, ['cloud-check', 'aws', '--profile', 'work'])
  assert.equal(r.status, 1)
  assert.equal(r.stdout, '')
  assert.equal(r.stderr, 'kestrel: The AWS command line tool is not signed in for the profile work. Sign in (for example with "aws sso login" or "aws configure"), then run this again.\n')
  assert.equal(m.calls('prowler').length, 0)
  assert.equal(stored(m), '')
  // Wrong words and options get one sentence too.
  assert.equal(kestrel(m, ['cloud-check']).stderr, 'kestrel: Name a provider: kestrel cloud-check aws, kestrel cloud-check vercel or kestrel cloud-check github.\n')
  assert.equal(kestrel(m, ['cloud-check', 'azure']).stderr, 'kestrel: "azure" is not a provider Kestrel checks. Use one of: kestrel cloud-check aws, kestrel cloud-check vercel, kestrel cloud-check github.\n')
  assert.equal(kestrel(m, ['cloud-check', 'aws', '--repo', 'a/b']).stderr, 'kestrel: --repo is not an option of "kestrel cloud-check aws". Its options are: --profile, --region, --minutes.\n')
  assert.equal(kestrel(m, ['cloud-check', 'github', '--repo']).stderr, 'kestrel: --repo needs a value.\n')
})

// ---- Vercel fixtures ----

// vercel whoami --json: the fields on vercel.com/docs/cli/whoami (username, email, name, team).
const WHOAMI = { username: 'someone', email: `${MARKER}@example.com`, name: MARKER, team: { id: 'team_abc', slug: 'example', name: 'Example', plan: 'pro' } }
// vercel project protection --json: the fields that the CLI's source prints (projectId, name, and
// the protections that are set). The bypass holds secrets, and must never be kept.
const protection = (fields = {}) => ({ projectId: 'prj_web1', name: 'web', ssoProtection: null, passwordProtection: null, protectionBypass: { [MARKER]: { scope: 'automation-bypass' } }, ...fields })
// vercel firewall status --json: the fields that the CLI's source prints.
const firewall = (enabled) => ({ firewallEnabled: enabled, attackMode: { enabled: false, activeUntil: null }, botProtection: { enabled: false, action: 'log' }, rules: { active: 0, inactive: 0, total: 0 }, ipBlocks: 0, draftChanges: 0 })
// GET /v9/projects/{idOrName}: the fields of "Find a project by id or name" in Vercel's REST API reference.
const PROJECT = {
  id: 'prj_web1', name: 'web', ssoProtection: null, passwordProtection: null, trustedIps: null, security: { firewallEnabled: false, attackModeEnabled: false },
  env: [
    { key: 'DB_PASSWORD', type: 'encrypted', visibility: 'config', value: MARKER, target: ['production'] },
    { key: 'STRIPE_SECRET', type: 'sensitive', visibility: 'secret', value: '', target: ['production'] },
    { key: 'NEXT_PUBLIC_SITE_URL', type: 'plain', value: 'https://example.com', target: ['production'] },
    // A variable from before "visibility": plain is readable.
    { key: 'OLD_API_KEY', type: 'plain', value: MARKER, target: ['preview'] },
    { key: 'VERCEL_URL', type: 'system', value: '', target: ['production'] },
  ],
}
const vercelPlan = (fields = {}, wall = false) => ({ vercel: [
  { when: '^whoami --json', stdout: WHOAMI },
  { when: '^project protection', stdout: protection(fields) },
  { when: '^firewall status --json --project prj_web1', stdout: firewall(wall) },
] })
/** A stand-in for fetch that answers Vercel's REST API, and keeps each request. */
function vercelApi(body = PROJECT, status = 200) {
  const requests = []
  const fetch = async (url, init) => {
    requests.push({ url, authorization: init.headers.Authorization })
    return { status, ok: status < 300, text: async () => JSON.stringify(body) }
  }
  return { fetch, requests }
}

test('vercel without VERCEL_TOKEN: deployment protection and the firewall from the CLI, the other checks skipped in one sentence, and their findings kept as they were', async () => {
  const m = machine(['vercel'])
  // An earlier run with the token found a readable secret.
  saveFindings([{ id: 'cloud.vercel.readable-secret:prj_web1:DB_PASSWORD', rule: 'cloud.vercel.readable-secret', kind: 'cloud', severity: 'high', title: 'An environment variable that looks like a secret is readable (Config, not Secret)', scope: 'cloud:vercel:prj_web1', where: { provider: 'vercel', project: 'web' }, controls: [] }], { scope: 'cloud:vercel:prj_web1', kind: 'cloud', now: NOW - 1000 })
  m.plan(vercelPlan())
  const api = vercelApi()
  const out = await cloudCheck('vercel', {}, { env: m.env, frameworks: ['soc2'], now: NOW, fetch: api.fetch, catalog: CATALOG })
  assert.equal(api.requests.length, 0)
  assert.deepEqual(m.calls('vercel').map((c) => c.args.join(' ')), ['whoami --json', 'project protection --json', 'firewall status --json --project prj_web1'])
  const open = readFindings().filter((f) => f.status === 'open')
  assert.deepEqual(open.map((f) => [f.rule, f.severity]).sort(), [
    ['cloud.vercel.firewall-off', 'medium'],
    ['cloud.vercel.previews-open', 'high'],
    ['cloud.vercel.production-urls-open', 'medium'],
    ['cloud.vercel.readable-secret', 'high'],
  ])
  const previews = open.find((f) => f.rule === 'cloud.vercel.previews-open')
  assert.equal(previews.scope, 'cloud:vercel:prj_web1')
  assert.deepEqual(previews.where, { provider: 'vercel', project: 'web', account: 'team_abc' })
  assert.deepEqual(previews.controls.map((c) => `${c.framework} ${c.id} ${c.confirmed}`), ['hipaa 164.312(a) true', 'soc2 CC6.1 false', 'iso27001 A.8.3 false'])
  assert.match(out, /The checks of trusted IPs and of environment variables were skipped: they need Vercel's REST API, and VERCEL_TOKEN is not set\. Their findings from an earlier run stay as they were\./)
  assert.match(out, /web: no deployment protection is set; the firewall is off\./)
  // No HIPAA: no note about Vercel's BAA. Nothing of the sign-in or the bypass is kept or printed.
  assert.ok(!open.some((f) => f.rule === 'cloud.vercel.hipaa-baa'))
  assert.ok(!out.includes(MARKER) && !stored(m).includes(MARKER))
})

test('vercel with VERCEL_TOKEN: trusted IPs and the environment variables from the REST API, judged by their names only; protection that covers previews and production; and the HIPAA note', async () => {
  const m = machine(['vercel'])
  m.plan(vercelPlan({ ssoProtection: { deploymentType: 'all_except_custom_domains' }, passwordProtection: { deploymentType: 'preview' } }, true))
  const api = vercelApi()
  const env = { ...m.env, VERCEL_TOKEN: 'token-of-the-person' }
  const out = await cloudCheck('vercel', { project: 'web', team: 'team_xyz' }, { env, frameworks: ['hipaa'], now: NOW, fetch: api.fetch, catalog: CATALOG })
  // The CLI got the team and the project; the API got the token, to api.vercel.com only.
  assert.deepEqual(m.calls('vercel').map((c) => c.args.join(' ')), ['whoami --json --scope team_xyz', 'project protection web --json --scope team_xyz', 'firewall status --json --project prj_web1 --scope team_xyz'])
  assert.deepEqual(api.requests, [{ url: 'https://api.vercel.com/v9/projects/prj_web1?teamId=team_xyz', authorization: 'Bearer token-of-the-person' }])
  const open = readFindings().filter((f) => f.status === 'open')
  assert.deepEqual(open.map((f) => f.id).sort(), [
    'cloud.vercel.hipaa-baa:team_xyz',
    'cloud.vercel.readable-secret:prj_web1:DB_PASSWORD',
    'cloud.vercel.readable-secret:prj_web1:OLD_API_KEY',
  ])
  const secret = open.find((f) => f.id.endsWith('DB_PASSWORD'))
  assert.deepEqual(secret.where, { provider: 'vercel', project: 'web', account: 'team_xyz', resource: 'environment variable DB_PASSWORD' })
  const baa = open.find((f) => f.rule === 'cloud.vercel.hipaa-baa')
  assert.equal(baa.severity, 'info')
  assert.equal(baa.scope, 'cloud:vercel:team_xyz')
  assert.match(baa.detail, /^Vercel signs a Business Associate Agreement only on Pro with the HIPAA BAA add-on .* and on Enterprise\. Kestrel cannot see whether yours is signed\./)
  assert.match(out, /web: protected by Vercel Authentication \(all_except_custom_domains\), Password Protection \(preview\); the firewall is on\./)
  assert.ok(!out.includes('skipped'))
  // Never the token, a value, or the bypass.
  assert.ok(!stored(m).includes('token-of-the-person') && !stored(m).includes(MARKER) && !out.includes(MARKER))

  // Trusted IPs alone protect production only: the previews are open. With HIPAA off, the note is resolved.
  m.plan(vercelPlan({}, true))
  await cloudCheck('vercel', { project: 'web', team: 'team_xyz' }, { env, frameworks: [], now: NOW + 1, fetch: vercelApi({ ...PROJECT, trustedIps: { deploymentType: 'production', addresses: [{ value: '10.0.0.1' }], protectionMode: 'additional' }, env: [] }).fetch, catalog: CATALOG })
  const now = readFindings()
  assert.deepEqual(now.filter((f) => f.status === 'open').map((f) => f.rule), ['cloud.vercel.previews-open'])
  assert.equal(now.find((f) => f.rule === 'cloud.vercel.hipaa-baa').status, 'resolved')
  // A token that the API refuses: one sentence, and nothing saved.
  await assert.rejects(cloudCheck('vercel', { project: 'web' }, { env, frameworks: [], now: NOW + 2, fetch: vercelApi({ error: { code: 'forbidden', message: 'Not authorized' } }, 403).fetch }), /^Error: Vercel's REST API did not accept VERCEL_TOKEN \(403: Not authorized\)/)
})

test('vercel: not installed, not signed in, and a folder that is not linked are one sentence each', async () => {
  let m = machine([])
  await assert.rejects(cloudCheck('vercel', {}, { env: m.env, frameworks: [] }), /^Error: The Vercel command line tool \(vercel\) is not installed/)
  m = machine(['vercel'])
  // vercel whoami --json without a sign-in: {loggedIn: false, ...} and exit code 1 (the CLI's source).
  m.plan({ vercel: [{ when: '^whoami', status: 1, stdout: { loggedIn: false, cliVersion: '50.0.0' } }] })
  await assert.rejects(cloudCheck('vercel', {}, { env: m.env, frameworks: [] }), { message: 'The Vercel command line tool is not signed in. Sign in with "vercel login", or set VERCEL_TOKEN, then run this again.' })
  m.plan({ vercel: [{ when: '^whoami', stdout: WHOAMI }, { when: '^project protection', status: 1, stderr: 'Error: Your codebase is not linked to a Vercel project. Run link first, then retry project commands.\n' }] })
  await assert.rejects(cloudCheck('vercel', {}, { env: m.env, frameworks: [] }), { message: 'This folder is not linked to a Vercel project. Name one: kestrel cloud-check vercel --project <name>' })
  // An older Vercel CLI (seen live: 49.2.0) knows no "--json" for whoami: it is too old, not signed out.
  m.plan({ vercel: [{ when: '^whoami --json', status: 1, stderr: 'Vercel CLI 49.2.0\nError: unknown or unexpected option: --json\n' }, { when: '^whoami$', stdout: 'someone\n' }] })
  await assert.rejects(cloudCheck('vercel', {}, { env: m.env, frameworks: [] }), { message: 'The Vercel command line tool on this computer is too old for these checks (Vercel CLI 49.2.0): it has no "--json" answers and no "vercel project protection". Update it with "npm i -g vercel", then run this again. Nothing was saved.' })
  // The same old CLI without a sign-in: not signed in.
  m.plan({ vercel: [{ when: '^whoami --json', status: 1, stderr: 'Vercel CLI 49.2.0\nError: unknown or unexpected option: --json\n' }, { when: '^whoami$', status: 1, stderr: 'Error: No existing credentials found.\n' }] })
  await assert.rejects(cloudCheck('vercel', {}, { env: m.env, frameworks: [] }), { message: 'The Vercel command line tool is not signed in. Sign in with "vercel login", or set VERCEL_TOKEN, then run this again.' })
})

// ---- GitHub fixtures ----

// gh repo view --json nameWithOwner: compact JSON (the source of gh).
const VIEW = { nameWithOwner: 'example-org/web' }
// GET /repos/{owner}/{repo}: fields of "Get a repository" in GitHub's REST API reference.
const repository = (fields = {}) => ({
  id: 1, name: 'web', full_name: 'example-org/web', private: true, default_branch: 'main', owner: { login: 'example-org', type: 'Organization' },
  security_and_analysis: { secret_scanning: { status: 'disabled' }, secret_scanning_push_protection: { status: 'disabled' }, dependabot_security_updates: { status: 'enabled' } },
  ...fields,
})
// An error of gh api: the body on standard output, "gh: <message> (HTTP <status>)" on standard error, exit code 1.
const ghError = (status, message) => ({ status: 1, stdout: { message, documentation_url: 'https://docs.github.com/rest', status: String(status) }, stderr: `gh: ${message} (HTTP ${status})\n` })
// A Dependabot alert, shortened from "List Dependabot alerts for a repository". With --paginate --slurp, gh gives an array of pages.
const alert = (n) => ({ number: n, state: 'open', security_advisory: { severity: 'high', summary: MARKER }, security_vulnerability: { severity: 'high' } })
const githubPlan = (overrides = []) => ({ gh: [
  ...overrides,
  { when: '^repo view --json nameWithOwner', stdout: VIEW },
  { when: 'repos/example-org/web/rules/branches/main', stdout: [] },
  { when: 'repos/example-org/web/branches/main/protection', ...ghError(404, 'Branch not protected') },
  { when: 'secret-scanning/alerts\\?state=open&per_page=100&hide_secret=true', stdout: [[{ number: 1, state: 'open', secret_type: 'aws_access_key_id' }]] },
  { when: 'dependabot/alerts\\?state=open&severity=critical,high&per_page=100', stdout: [[alert(1), alert(2)], [alert(3)]] },
  { when: 'code-scanning/alerts', ...ghError(403, 'Code scanning is not enabled for this repository.') },
  { when: 'orgs/example-org$', stdout: { login: 'example-org', two_factor_requirement_enabled: false } },
  { when: 'repos/example-org/web$', stdout: repository() },
] })

test('github, a repository of an organisation: each check, a 403 for code scanning, the counts only, and the command saves what it found', () => {
  const m = machine(['gh'])
  m.plan(githubPlan())
  const r = kestrel(m, ['cloud-check', 'github'])
  assert.equal(r.status, 0, r.stderr)
  const calls = m.calls('gh').map((c) => c.args.join(' '))
  assert.equal(calls[0], 'repo view --json nameWithOwner')
  assert.ok(calls.includes('api --paginate --slurp -H Accept: application/vnd.github+json repos/example-org/web/secret-scanning/alerts?state=open&per_page=100&hide_secret=true'))
  assert.ok(calls.includes('api --paginate --slurp -H Accept: application/vnd.github+json repos/example-org/web/dependabot/alerts?state=open&severity=critical,high&per_page=100'))
  const found = readFindings()
  assert.deepEqual(found.map((f) => [f.rule, f.severity, f.title]), [
    ['cloud.github.dependabot-alerts', 'high', '3 open Dependabot alerts of severity high or critical'],
    ['cloud.github.no-review', 'high', 'The default branch main can be changed without an approving review'],
    ['cloud.github.org-2fa-off', 'high', 'The organisation example-org does not require two-factor sign-in'],
    ['cloud.github.secret-alerts', 'high', '1 open secret scanning alert'],
    ['cloud.github.secret-scanning-off', 'high', 'Secret scanning is off'],
    ['cloud.github.push-protection-off', 'medium', 'Push protection for secrets is off'],
    ['cloud.github.code-scanning-off', 'low', 'Code scanning is not enabled'],
  ])
  assert.ok(found.every((f) => f.scope === 'cloud:github:example-org/web' && f.kind === 'cloud' && f.source === 'github'))
  assert.deepEqual(found.find((f) => f.rule === 'cloud.github.org-2fa-off').controls.map((c) => `${c.framework} ${c.id}`), ['hipaa 164.312(d)', 'soc2 CC6.1', 'iso27001 A.8.5', 'pci 8.4.2'])
  assert.match(r.stdout, /^Checked GitHub repository example-org\/web \(private, of the organisation example-org\)\. Read only\./)
  assert.match(r.stdout, /7 open findings in GitHub \(5 high, 1 medium, 1 low, 0 info\)\./)
  assert.match(r.stdout, /Code scanning is not enabled \(cloud\)\n {2}Where: GitHub project example-org\/web\n {2}What: GitHub answered 403: Code scanning is not enabled for this repository\./)
  assert.ok(!r.stdout.includes(MARKER) && !stored(m).includes(MARKER))
})

test('github, a personal repository with everything on: a ruleset with a review, open code scanning alerts by count, no organisation; and a run that finds less resolves the rest', async () => {
  const m = machine(['gh'])
  m.plan(githubPlan())
  await cloudCheck('github', { repo: 'example-org/web' }, { env: m.env, frameworks: ['soc2'], now: NOW, catalog: CATALOG })
  assert.equal(readFindings().filter((f) => f.status === 'open').length, 7)
  // The same repository later: a ruleset needs a review, scanning is on, the alerts are fixed.
  m.plan(githubPlan([
    // A rule of "Get rules for a branch" (GitHub's REST API reference), of type pull_request.
    { when: 'rules/branches/main', stdout: [{ type: 'pull_request', ruleset_source_type: 'Repository', ruleset_source: 'example-org/web', ruleset_id: 1, parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true } }] },
    { when: 'secret-scanning/alerts', stdout: [] },
    { when: 'dependabot/alerts', stdout: [[]] },
    { when: 'code-scanning/alerts', stdout: [[{ number: 1, state: 'open', rule: { description: MARKER } }, { number: 2, state: 'open' }]] },
    { when: 'repos/example-org/web$', stdout: repository({ owner: { login: 'someone', type: 'User' }, private: false, security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } } }) },
  ]))
  const first = m.calls('gh').length
  const out = await cloudCheck('github', { repo: 'example-org/web' }, { env: m.env, frameworks: ['soc2'], now: NOW + 60e3, catalog: CATALOG })
  const later = m.calls('gh').slice(first)
  assert.ok(!later.some((c) => c.args.join(' ').includes('orgs/')), 'a personal repository has no organisation to ask')
  assert.ok(!m.calls('gh').some((c) => c.args[0] === 'repo'), '--repo names it, so the folder is not asked')
  const all = readFindings()
  assert.deepEqual(all.filter((f) => f.status === 'open').map((f) => [f.rule, f.title]), [['cloud.github.code-scanning-alerts', '2 open code scanning alerts']])
  assert.deepEqual(all.filter((f) => f.status === 'resolved').map((f) => f.rule), ['cloud.github.dependabot-alerts', 'cloud.github.no-review', 'cloud.github.org-2fa-off', 'cloud.github.secret-alerts', 'cloud.github.secret-scanning-off', 'cloud.github.push-protection-off', 'cloud.github.code-scanning-off'])
  assert.ok(all.filter((f) => f.status === 'resolved').every((f) => f.resolvedAt === NOW + 60e3))
  assert.match(out, /^Checked GitHub repository example-org\/web \(public, of a personal account\)\./)
})

test('the catalog of controls as src/controls.mjs holds it: an id that was checked shows as confirmed, every other one does not', async () => {
  const { loadCatalog, control, ownControls } = await import('../src/cloud.mjs')
  const real = await loadCatalog()
  assert.deepEqual(control(real, 'hipaa', '164.312(d)', 'x'), { framework: 'hipaa', id: '164.312(d)', confirmed: true, label: 'Person or entity authentication' })
  assert.equal(control(real, 'soc2', 'CC6.1', 'x').confirmed, false)
  assert.deepEqual(control(real, 'pci', 'no-such-id', 'Own label'), { framework: 'pci', id: 'no-such-id', confirmed: false, label: 'Own label' })
  const twoFactor = ownControls(real, 'cloud.github.org-2fa-off')
  assert.deepEqual(twoFactor.filter((c) => c.confirmed).map((c) => `${c.framework} ${c.id}`), ['hipaa 164.312(d)'])
})

test('github: what only admins and owners may see is one sentence and no finding; not installed and not signed in are one sentence', async () => {
  const m = machine(['gh'])
  m.plan(githubPlan([
    { when: 'branches/main/protection', ...ghError(404, 'Not Found') },
    { when: 'secret-scanning/alerts', ...ghError(404, 'Not Found') },
    { when: 'dependabot/alerts', ...ghError(403, 'Resource not accessible by personal access token') },
    { when: 'code-scanning/alerts', ...ghError(404, 'no analysis found') },
    { when: 'orgs/example-org$', stdout: { login: 'example-org' } },
    { when: 'repos/example-org/web$', stdout: repository({ security_and_analysis: null }) },
  ]))
  const out = await cloudCheck('github', {}, { env: m.env, frameworks: [], now: NOW, catalog: CATALOG })
  assert.deepEqual(readFindings().map((f) => f.rule), ['cloud.github.code-scanning-off'])
  for (const sentence of [
    'No ruleset requires a review on main, and Kestrel may not read its branch protection: that needs admin rights to the repository.',
    'GitHub shows whether secret scanning and push protection are on only to admins of the repository, so Kestrel could not check them.',
    'Kestrel may not read the Dependabot alerts (Resource not accessible by personal access token).',
    'GitHub shows whether example-org requires two-factor sign-in only to its owners, so Kestrel could not check it.',
  ]) assert.ok(out.includes(sentence), sentence)

  // Not signed in: gh ends with exit code 4.
  m.plan({ gh: [{ when: '.', status: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' }] })
  await assert.rejects(cloudCheck('github', { repo: 'example-org/web' }, { env: m.env, frameworks: [] }), { message: 'The GitHub command line tool is not signed in. Sign in with "gh auth login", then run this again.' })
  // A sign-in that GitHub refuses (HTTP 401) stops the run too.
  m.plan({ gh: [{ when: '.', ...ghError(401, 'Bad credentials') }] })
  await assert.rejects(cloudCheck('github', { repo: 'example-org/web' }, { env: m.env, frameworks: [] }), /^Error: GitHub did not accept the sign-in/)
  await assert.rejects(cloudCheck('github', { repo: 'not a repo' }, { env: m.env, frameworks: [] }), /is not a repository name/)
  await assert.rejects(cloudCheck('github', {}, { env: machine([]).env, frameworks: [] }), /^Error: The GitHub command line tool \(gh\) is not installed/)
})

// ---- The pane's Security tab ----
// The stand-in for what Claude Code gives a mod, as in test/pane.test.mjs: elements that check
// their props, $.process.run, $.prompt.submit, and the events of the pane.

const PROPS = {
  Box: ['key', 'flexDirection', 'gap', 'columnGap', 'rowGap', 'padding', 'paddingX', 'paddingY', 'margin', 'marginTop', 'width', 'height', 'borderStyle', 'borderColor', 'children'],
  Text: ['color', 'backgroundColor', 'bold', 'italic', 'underline', 'strikethrough', 'dimColor', 'inverse', 'wrap', 'weight', 'children'],
  Button: ['key', 'label', 'children', 'onPress', 'hotkey', 'plain', 'dimColor', 'autoFocus', 'action', 'variant', 'role'],
  Select: ['key', 'label', 'options', 'value', 'onSelect', 'autoFocus'],
  Input: ['key', 'label', 'placeholder', 'value', 'submitLabel', 'rows', 'onSubmit', 'onInput', 'autoFocus'],
}
const ELEMENTS = Object.fromEntries(Object.entries(PROPS).map(([type, allowed]) => [type, (props) => {
  for (const name of Object.keys(props)) assert.ok(allowed.includes(name), `${type} prop "${name}" is not allowed`)
  const children = props.children ?? []
  if (type === 'Text') for (const child of children) assert.equal(typeof child, 'string', 'a Text holds strings')
  if (type === 'Button') {
    assert.equal(typeof props.onPress, 'function')
    assert.ok(typeof props.label === 'string' && props.label)
    if (props.hotkey !== undefined) assert.match(props.hotkey, /^[0-9a-z]$/)
  }
  return { type, props, children }
}]))
function elements(tree) {
  const all = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    all.push(node)
    for (const child of node.children) walk(child)
  }
  walk(tree)
  const keys = all.filter((n) => ['Button', 'Select', 'Input'].includes(n.type)).map((n) => n.props.key ?? n.props.label)
  assert.equal(new Set(keys).size, keys.length, `a control is drawn twice: ${keys.join(', ')}`)
  return all
}
const words = (tree) => elements(tree).flatMap((n) => (n.type === 'Text' ? [n.children.join('')] : n.type === 'Button' ? [n.props.label] : []))
const control = (tree, key) => elements(tree).find((n) => n.props.key === key)
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))
}
let loads = 0
async function loadMod() {
  const { register } = await import(`../hooks/pane.mjs?cloud=${++loads}`)
  const hooks = {}
  register((event, matcher, hook) => {
    hooks[event] = hook ?? matcher
    return { catch() {} }
  })
  return hooks
}

// The answer of "kestrel check --json" (the contract between the two builds): the frameworks that
// are on, the counts, the open findings the most severe first, and the sentence. One finding has a
// field that would hold matched text, and a detail: neither may go into the prompt.
const FIRST = Date.parse('2026-11-13T09:30:00')
const CHECK = {
  at: NOW, frameworks: ['hipaa', 'owasp-agentic'], counts: { high: 1, medium: 1, low: 0, info: 0 },
  findings: [
    {
      id: 'settings.bypass:settings', rule: 'settings.bypass', kind: 'settings', severity: 'high', title: 'Claude Code may skip every permission prompt', detail: `The setting ${MARKER}-DETAIL is on`,
      where: { file: '/home/someone/.claude/settings.json' }, scope: 'settings', snippet: MARKER,
      controls: [{ framework: 'owasp-agentic', id: 'ASI03', confirmed: false, label: 'Identity and privilege abuse' }, { framework: 'hipaa', id: '164.312(a)', confirmed: true, label: 'Access control' }, { framework: 'soc2', id: 'CC6.1', confirmed: false }],
      fix: { action: 'no-bypass', words: 'kestrel apply no-bypass' }, source: 'kestrel', status: 'open', firstSeen: FIRST, lastSeen: NOW,
    },
    {
      id: 'cloud.vercel.previews-open:prj_web1', rule: 'cloud.vercel.previews-open', kind: 'cloud', severity: 'medium', title: 'Preview deployments are open to anyone with the link',
      where: { provider: 'vercel', project: 'web' }, scope: 'cloud:vercel:prj_web1', controls: [{ framework: 'soc2', id: 'CC6.1', confirmed: false }], fix: null, source: 'vercel', status: 'open', firstSeen: FIRST, lastSeen: NOW,
    },
  ],
  note: 'Kestrel checks technical controls and flags risks. It does not certify anything.',
}
/** The settings as "kestrel settings --json" gives them: here only the frameworks that the tab names. */
const SETTINGS = {
  settings: [
    { key: 'security.frameworks.hipaa', group: 'Frameworks: Healthcare', label: 'HIPAA', kind: 'on-off', values: ['on', 'off'], value: 'on', default: 'off' },
    { key: 'security.frameworks.soc2', group: 'Frameworks: Healthcare', label: 'SOC 2', kind: 'on-off', values: ['on', 'off'], value: 'off', default: 'off' },
    { key: 'security.frameworks.owasp-agentic', group: 'Frameworks: AI agents', label: 'OWASP Top 10 for Agentic Applications', kind: 'on-off', values: ['on', 'off'], value: 'on', default: 'on' },
  ],
  sets: [], frameworks: { on: ['hipaa', 'owasp-agentic'], from: 'person', file: null, project: null }, note: 'The checks run now.', accounts: null, undo: false,
}

function paneStandIn(answers, submit = async ({ text }) => ({ text })) {
  // The Now tab, which the pane opens on, has no session here.
  answers = { 'top --once --json': ok({ at: NOW, count: 0, limits: [], sessions: [], waste: 'Waste today: none.', next: null }), ...answers }
  const calls = { runs: [], prompts: [] }
  const $ = {
    plugin: { name: 'kestrel', root: ROOT },
    ui: { resolve: () => ELEMENTS, open: async () => ({ isPlaced: true }), close: async () => {}, invalidate: () => {} },
    process: {
      run: async (argv, init) => {
        assert.deepEqual(argv.slice(0, 2), ['node', KESTREL])
        assert.ok(init.timeoutMs >= 60e3 && init.timeoutMs <= 600e3)
        calls.runs.push({ args: argv.slice(2), init })
        const answer = answers[argv.slice(2).join(' ')]
        assert.ok(answer, argv.slice(2).join(' '))
        return { stderr: '', ...answer }
      },
    },
    prompt: {
      submit: async (input) => {
        calls.prompts.push(input)
        return submit(input)
      },
    },
    clock: { every: () => ({ cancel() {} }) },
    session: { cwd: async () => '/work/app' },
  }
  return { $, calls }
}
const ok = (value) => ({ exitCode: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value) })
const paneEvent = { plugin: 'kestrel', component: 'Pane', requestId: 'kestrel', surface: 'terminal', viewport: { columns: 320, rows: 50 }, props: { title: 'Kestrel', bodyColumns: 300, placement: 'dock' } }

test('the pane\'s Security tab: the frameworks, the counts and the sentence at the top, a row per finding, its detail, Fix asks then applies and gets Undo, and Run checks', async () => {
  const s = paneStandIn({
    'settings --json': ok(SETTINGS), 'check --json': ok(CHECK),
    'apply no-bypass': ok('Turned off the mode that skips permission prompts in Claude Code\'s settings.\nA backup is in ~/.kestrel/backup/.\n'),
    'undo no-bypass': ok('no-bypass is taken back.\n'),
    'check --run': ok('The checks ran: 2 open findings.\n'),
  })
  const hooks = await loadMod()
  const draw = () => hooks['ui.render'](s.$, paneEvent, async () => ({}))
  await hooks['command.run'](s.$, { command: 'kestrel:open', args: '' }, async () => ({}))
  await settle()
  control(await draw(), 'tab-security').props.onPress({})
  await settle()
  assert.deepEqual(s.calls.runs.slice(-2).map((r) => r.args.join(' ')), ['settings --json', 'check --json'])
  assert.equal(s.calls.runs.at(-1).init.cwd, '/work/app')
  let tree = await draw()
  let shown = words(tree)
  assert.deepEqual(shown.slice(shown.indexOf('Frameworks that are on'), shown.indexOf('Frameworks that are on') + 6), [
    'Frameworks that are on',
    'HIPAA, OWASP Top 10 for Agentic Applications',
    'Open findings: 1 high, 1 medium, 0 low, 0 info',
    'Kestrel checks technical controls and flags risks. It does not certify anything.',
    ' ',
    'HIGH  Claude Code may skip every permission prompt  /home/someone/.claude/settings.json  OWASP Top 10 for Agentic Applications ASI03 Identity and privilege abuse (id to check); HIPAA 164.312(a) Access control',
  ])
  // A finding that touches no framework that is on shows no control: SOC 2 is off.
  assert.equal(control(tree, 'finding-cloud.vercel.previews-open:prj_web1').props.label, 'MEDIUM  Preview deployments are open to anyone with the link  Vercel project web')
  assert.ok(shown.includes('Cloud checks run only when you ask, in a terminal: kestrel cloud-check aws, vercel or github.'))
  assert.ok(!shown.join('\n').includes(MARKER))

  // A row opens the detail: every field, the fix command, first and last seen.
  control(tree, 'finding-settings.bypass:settings').props.onPress({})
  tree = await draw()
  shown = words(tree)
  const head = shown.indexOf('Claude Code may skip every permission prompt')
  const two = (n) => String(n).padStart(2, '0')
  const at = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}` }
  assert.deepEqual(shown.slice(head, head + 13), [
    'Claude Code may skip every permission prompt',
    'Severity: high',
    'Kind: settings',
    'Rule: settings.bypass',
    'Where: /home/someone/.claude/settings.json',
    `What: The setting ${MARKER}-DETAIL is on`,
    'Controls of the frameworks that are on: OWASP Top 10 for Agentic Applications ASI03 Identity and privilege abuse (id to check); HIPAA 164.312(a) Access control',
    'Every control it touches: OWASP Top 10 for Agentic Applications ASI03 (id to check); HIPAA 164.312(a); SOC 2 CC6.1 (id to check)',
    'Found by: kestrel',
    'Fix: kestrel apply no-bypass',
    `First seen: ${at(FIRST)}`,
    `Last seen: ${at(NOW)}`,
    ' ',
  ])
  assert.equal(control(tree, 'finding-hand').props.label, 'Hand to the agent (the only button that uses tokens)')

  // Fix asks once, and runs nothing yet. No takes the question away.
  const before = s.calls.runs.length
  control(tree, 'finding-fix').props.onPress({})
  tree = await draw()
  assert.ok(words(tree).includes('Apply no-bypass? It changes Claude Code\'s settings, with a backup.'))
  assert.equal(s.calls.runs.length, before)
  control(tree, 'security-no').props.onPress({})
  tree = await draw()
  assert.ok(control(tree, 'finding-fix'))
  // Yes runs "kestrel apply", shows its first line, and the fix gets Undo.
  control(tree, 'finding-fix').props.onPress({})
  control(await draw(), 'security-yes').props.onPress({})
  await settle()
  assert.deepEqual(s.calls.runs.at(-1).args, ['apply', 'no-bypass'])
  tree = await draw()
  assert.ok(words(tree).includes('Turned off the mode that skips permission prompts in Claude Code\'s settings.'))
  assert.equal(control(tree, 'finding-undo').props.label, 'Undo no-bypass')
  control(tree, 'finding-undo').props.onPress({})
  await settle()
  assert.deepEqual(s.calls.runs.at(-1).args, ['undo', 'no-bypass'])
  assert.ok(control(await draw(), 'finding-fix'))
  // A finding without a fix has no Fix button. Back returns to the list.
  control(await draw(), 'finding-back').props.onPress({})
  control(await draw(), 'finding-cloud.vercel.previews-open:prj_web1').props.onPress({})
  tree = await draw()
  assert.equal(control(tree, 'finding-fix'), undefined)
  assert.ok(words(tree).includes('Fix: none that Kestrel makes. The finding says what to change.'))
  control(tree, 'finding-back').props.onPress({})

  // Run checks runs "kestrel check --run" for the session's folder, then reads the findings again.
  control(await draw(), 'run-checks').props.onPress({})
  assert.ok(words(await draw()).includes('Running the checks...'))
  await settle()
  const run = s.calls.runs.find((r) => r.args.join(' ') === 'check --run')
  assert.deepEqual([run.init.cwd, run.init.timeoutMs], ['/work/app', 300e3])
  assert.deepEqual(s.calls.runs.slice(-2).map((r) => r.args.join(' ')), ['settings --json', 'check --json'])
  assert.ok(words(await draw()).includes('The checks ran: 2 open findings.'))
  // Nothing of this sent a prompt.
  assert.equal(s.calls.prompts.length, 0)
})

test('the pane\'s Security tab: Hand to the agent asks once, then submits one prompt made of the finding\'s own fields, with no matched text; a refused prompt is one line', async () => {
  let refuse = false
  const s = paneStandIn({ 'settings --json': ok(SETTINGS), 'check --json': ok(CHECK) }, async ({ text }) => (refuse ? { drop: 'A hook of another plugin refused it.' } : { text }))
  const hooks = await loadMod()
  const draw = () => hooks['ui.render'](s.$, paneEvent, async () => ({}))
  await hooks['command.run'](s.$, { command: 'kestrel:open', args: '' }, async () => ({}))
  await settle()
  control(await draw(), 'tab-security').props.onPress({})
  await settle()
  control(await draw(), 'finding-settings.bypass:settings').props.onPress({})
  control(await draw(), 'finding-hand').props.onPress({})
  let tree = await draw()
  assert.ok(words(tree).includes('Send this finding to Claude in this session? It uses tokens.'))
  assert.equal(s.calls.prompts.length, 0)
  control(tree, 'security-yes').props.onPress({})
  await settle()
  assert.equal(s.calls.prompts.length, 1)
  const [{ text, ...rest }] = s.calls.prompts
  assert.deepEqual(rest, {})
  assert.equal(text, 'Kestrel found: Claude Code may skip every permission prompt in /home/someone/.claude/settings.json. Controls: OWASP Top 10 for Agentic Applications ASI03 Identity and privilege abuse (id to check); HIPAA 164.312(a) Access control. Please fix it, explain what you changed, and do not print any secret.')
  assert.ok(!text.includes(MARKER), 'neither the matched text nor the detail goes in')
  tree = await draw()
  assert.ok(words(tree).includes('Sent to Claude in this session. It answers in the chat.'))
  // A prompt that a hook drops: the reason is the line, and nothing else happens.
  refuse = true
  control(tree, 'finding-hand').props.onPress({})
  control(await draw(), 'security-yes').props.onPress({})
  await settle()
  assert.ok(words(await draw()).includes('The prompt was not sent: A hook of another plugin refused it.'))
  // The cloud finding: its place and the control of a framework that is on, here none.
  control(await draw(), 'finding-back').props.onPress({})
  refuse = false
  control(await draw(), 'finding-cloud.vercel.previews-open:prj_web1').props.onPress({})
  control(await draw(), 'finding-hand').props.onPress({})
  control(await draw(), 'security-yes').props.onPress({})
  await settle()
  assert.equal(s.calls.prompts.at(-1).text, 'Kestrel found: Preview deployments are open to anyone with the link in Vercel project web. Controls: none named. Please fix it, explain what you changed, and do not print any secret.')
})

// ---- The desktop tool ----

test('the desktop tool security_check over the server: the open findings with kinds, titles, places, controls and fixes, and never a finding that holds matched text', { timeout: 60e3 }, async (t) => {
  const m = machine([])
  mkdirSync(m.env.KESTREL_HOME, { recursive: true })
  writeFileSync(join(m.env.KESTREL_HOME, 'config.json'), JSON.stringify({ security: { frameworks: ['hipaa', 'hitrust'] } }))
  const finding = (fields) => ({ kind: 'cloud', scope: 'cloud:aws:123456789012', controls: [], fix: null, source: 'kestrel', status: 'open', firstSeen: FIRST, lastSeen: NOW, ...fields })
  writeFileSync(join(m.env.KESTREL_HOME, 'findings.json'), JSON.stringify({ at: NOW, findings: [
    finding({ id: 'a', rule: 'settings.bypass', kind: 'settings', scope: 'settings', severity: 'high', title: 'Claude Code may skip every permission prompt', where: { file: '/home/someone/.claude/settings.json' }, controls: [{ framework: 'hipaa', id: '164.312(a)', confirmed: true, label: 'Access control' }], fix: { action: 'no-bypass', words: 'kestrel apply no-bypass' } }),
    finding({ id: 'b', rule: 'cloud.aws.securityhub.S3.8', severity: 'medium', title: 'S3 general purpose buckets should block public access', where: { provider: 'aws', account: '123456789012', resource: 'arn:aws:s3:::exports', region: 'eu-west-1' }, controls: [{ framework: 'iso27001', id: 'A.8.3', confirmed: false }], reported: ['AWS Foundational Security Best Practices'] }),
    finding({ id: 'c', rule: 'cloud.aws.x', severity: 'low', title: 'A resolved one', where: {}, status: 'resolved', resolvedAt: NOW }),
    // A finding that holds what was matched is refused by the store, so it never shows.
    finding({ id: 'd', rule: 'code.secret', severity: 'high', title: 'A secret in the code', where: {}, match: MARKER }),
  ] }))
  const child = spawn(process.execPath, [KESTREL, 'mcp'], { env: m.env, stdio: ['pipe', 'pipe', 'pipe'] })
  // A failed assertion must not leave the server waiting on its input: the test run would never end.
  t.after(() => child.kill())
  const lines = []
  const waiting = new Map()
  let rest = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    rest += chunk
    for (let i = rest.indexOf('\n'); i >= 0; i = rest.indexOf('\n')) {
      const line = rest.slice(0, i)
      rest = rest.slice(i + 1)
      lines.push(line)
      const message = JSON.parse(line)
      waiting.get(message.id)?.(message)
    }
  })
  const request = (id, method, params) => new Promise((resolve) => {
    waiting.set(id, resolve)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  await request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  const { tools } = (await request(2, 'tools/list', {})).result
  const tool = tools.find((t) => t.name === 'security_check')
  assert.deepEqual(tool.inputSchema, { type: 'object', additionalProperties: false })
  assert.deepEqual(tool.annotations, { readOnlyHint: true, openWorldHint: false })
  const result = (await request(3, 'tools/call', { name: 'security_check', arguments: {} })).result
  assert.equal(result.isError, false)
  const text = result.content[0].text
  const two = (n) => String(n).padStart(2, '0')
  const at = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}` }
  assert.equal(text, [
    "Kestrel's security checks: 2 open findings (1 high, 1 medium, 0 low, 0 info).",
    'Frameworks that are on: HIPAA, HITRUST CSF.',
    '',
    'HIGH  Claude Code may skip every permission prompt (settings)',
    '  Where: /home/someone/.claude/settings.json',
    '  Controls: HIPAA 164.312(a) Access control; HITRUST: through the controls it shares with HIPAA and ISO 27001',
    '  Fix: kestrel apply no-bypass',
    `  First seen ${at(FIRST)}, last seen ${at(NOW)}.`,
    '',
    'MEDIUM  S3 general purpose buckets should block public access (cloud)',
    '  Where: AWS account 123456789012, arn:aws:s3:::exports, region eu-west-1',
    '  Controls: ISO 27001 A.8.3 (id to check); HITRUST: through the controls it shares with HIPAA and ISO 27001',
    '  Frameworks the tool reported: AWS Foundational Security Best Practices',
    '  Fix: none that Kestrel makes. The finding says what to change.',
    `  First seen ${at(FIRST)}, last seen ${at(NOW)}.`,
    '',
    CHECK_NOTE,
    '',
    'A change with a "kestrel apply" command is made in a terminal, with that command: Kestrel in the desktop app never changes a setting.',
  ].join('\n'))
  assert.ok(!lines.join('\n').includes(MARKER))
  child.stdin.end()
  await new Promise((resolve) => child.on('exit', resolve))
})

test('no credentials file was opened by any check, and no new file of this part has a dash character', () => {
  // The trap writes this file when anything opened a file under ~/.aws other than config.
  assert.equal(existsSync(TRAP), false, existsSync(TRAP) ? readFileSync(TRAP, 'utf8') : '')
  // The trap itself works: opening the made-up credentials file springs it.
  const home = join(dir, 'machine-1')
  const credentials = join(home, '.aws', 'credentials')
  assert.doesNotThrow(() => readFileSync(join(home, '.aws', 'config')))
  // In a process that the test starts, as for the command: the stand-ins would fail after this.
  const other = join(dir, 'trap-of-a-child')
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(TRAP_MODULE).href, '-e', `require('node:fs').readFileSync(${JSON.stringify(credentials)})`], { encoding: 'utf8', env: { HOME: home, STANDIN_TRAP: other } })
  assert.notEqual(child.status, 0)
  assert.equal(readFileSync(other, 'utf8'), credentials)
  // In this process.
  assert.throws(() => readFileSync(credentials), /a credentials file was opened/)
  assert.equal(existsSync(TRAP), true)
  const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`)
  for (const file of ['src/cloud.mjs', 'src/cloud-aws.mjs', 'src/cloud-vercel.mjs', 'src/cloud-github.mjs', 'src/finding-words.mjs', 'src/findings-text.mjs', 'hooks/pane.mjs', 'test/cloud.test.mjs']) {
    assert.doesNotMatch(readFileSync(join(ROOT, file), 'utf8'), dashes, file)
  }
})

test('"kestrel check --cloud github" runs the same check as "kestrel cloud-check github"', () => {
  // A PATH with only an empty folder: gh is not there, so both commands give the same one sentence.
  const empty = mkdtempSync(join(dir, 'empty-path-'))
  const env = { ...process.env, PATH: empty, HOME: join(dir, 'person'), KESTREL_HOME: join(dir, 'home-alias'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'codex'), KESTREL_COWORK_DIR: join(dir, 'cowork') }
  const run = (args) => spawnSync(process.execPath, [KESTREL, ...args], { encoding: 'utf8', env })
  const alias = run(['check', '--cloud', 'github', '--repo', 'example/repo'])
  const direct = run(['cloud-check', 'github', '--repo', 'example/repo'])
  assert.match(alias.stdout + alias.stderr, /The GitHub command line tool \(gh\) is not installed/)
  assert.equal(alias.stdout + alias.stderr, direct.stdout + direct.stderr)
})
