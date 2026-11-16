// The rules of Kestrel's own security checks: what each one looks for, how severe it is, which
// controls it touches in each framework, and the fix when Kestrel has one.
//
// A rule is { id, kind, severity, title, controls, fix, only, raise }:
//   - `controls` maps a framework id to control ids of the catalog in controls.mjs;
//   - `fix` names an action of actions.mjs, applied with "kestrel apply <fix>";
//   - `only` lists frameworks of which one has to be on for the rule to run at all;
//   - `raise` makes the rule more severe while one of its frameworks is on.
//
// The checks that use these rules are in check-settings.mjs, check-log.mjs and check-code.mjs. A
// finding never holds what was matched: see the comment at the top of findings.mjs.
import { controlsFor } from './controls.mjs'

// Control lists that several rules share, so that one change reaches each of them.
const ACCESS = {
  hipaa: ['164.312(a)'], soc2: ['CC6.1'], iso27001: ['A.5.15'], part11: ['11.10(d)', '11.10(g)'], annex11: ['12'],
  pci: ['7'], glba: ['314.4'], nydfs: ['500.7'], dora: ['Art. 9'], gdpr: ['Art. 32'],
}
const SECRETS = {
  hipaa: ['164.312(a)', '164.312(d)'], soc2: ['CC6.1'], iso27001: ['A.5.15', 'A.8.24'], part11: ['11.10(d)'], annex11: ['12'],
  pci: ['3', '8'], glba: ['314.4'], nydfs: ['500.7'], dora: ['Art. 9'], gdpr: ['Art. 32'],
}
const TRANSIT = {
  hipaa: ['164.312(e)'], soc2: ['CC6.1'], iso27001: ['A.8.24'], pci: ['4'], glba: ['314.4'], nydfs: ['500.15'], dora: ['Art. 9'], gdpr: ['Art. 32'],
}
const CHANGE = {
  hipaa: ['164.312(c)'], soc2: ['CC8.1'], iso27001: ['A.8.32'], part11: ['11.10(e)', '11.10(k)'], annex11: ['10'], dora: ['Art. 9'], glba: ['314.4'],
}
const THIRD_PARTY = {
  hipaa: ['164.312(e)'], soc2: ['CC6.1'], gdpr: ['Art. 28'], dora: ['Art. 28'], glba: ['314.4'],
}
const KEPT_TEXT = {
  hipaa: ['164.312(a)(2)(iv)'], soc2: ['CC6.1'], iso27001: ['A.8.10'], part11: ['11.10(d)'], gdpr: ['Art. 5(1)(e)', 'Art. 32'], pci: ['3'], glba: ['314.4'],
}

// The AI agents group, for the rules about what an agent may do and what it can leak.
const AGENT_POWER = { 'owasp-agentic': ['ASI02', 'ASI03'], 'owasp-llm': ['LLM06'], 'nist-ai-rmf': ['MANAGE'], iso42001: [null] }
const AGENT_LEAK = { 'owasp-agentic': ['ASI03'], 'owasp-llm': ['LLM02'], 'nist-ai-rmf': ['MANAGE'], iso42001: [null] }
const AGENT_SUPPLY = { 'owasp-agentic': ['ASI04'], 'owasp-llm': ['LLM03'], 'nist-ai-rmf': ['MAP'], iso42001: [null] }
const AGENT_CODE = { 'owasp-agentic': ['ASI05'], 'owasp-llm': ['LLM05'], 'nist-ai-rmf': ['MEASURE'], iso42001: [null] }

const rule = (id, kind, severity, title, controls, more = {}) => ({ id, kind, severity, title, controls, fix: null, ...more })

/** Every rule, by id. */
export const RULES = Object.fromEntries([
  // Settings: what Claude Code and Codex let an agent do without asking.

  // In bypass mode every tool call runs without a question, so nothing stands between a wrong
  // step of the agent and its effect. Auto mode lets a classifier decide in the person's place.
  // A true skipDangerousModePermissionPrompt means the person accepted bypass mode once, and it can
  // start without the warning.
  rule('set.bypass-mode', 'settings', 'high', 'Claude Code may run tool calls without asking you', { ...ACCESS, ...AGENT_POWER }, { fix: 'no-bypass' }),
  // An allow rule for every shell command lets the agent run any program, also one that deletes or
  // sends data, without a question.
  rule('set.allow-any-shell', 'settings', 'high', 'Claude Code may run any shell command without asking you', { ...ACCESS, ...AGENT_POWER }),
  // Without a deny rule, the agent can read .env files and private keys like any other file, and
  // their content then goes to the model and into the transcript.
  rule('set.no-secret-deny', 'settings', 'medium', 'Nothing stops Claude Code from reading .env files and private keys', { ...SECRETS, ...AGENT_LEAK }, { fix: 'deny-secret-files' }),
  // Without the sandbox, a shell command that the agent runs reaches every file and the whole
  // network that the person can reach.
  rule('set.sandbox-off', 'settings', 'medium', 'Shell commands of Claude Code run outside the sandbox', { ...ACCESS, 'owasp-agentic': ['ASI05'], 'owasp-llm': ['LLM06'], 'nist-ai-rmf': ['MANAGE'], iso42001: [null] }),
  // Every MCP server that a repository names in .mcp.json starts without a question. A server is a
  // program from outside, and a repository can come from anyone.
  rule('set.all-project-mcp', 'settings', 'medium', 'Claude Code starts every MCP server that a repository names, without asking', { ...THIRD_PARTY, ...AGENT_SUPPLY }),
  // A remote MCP server receives what the agent sends to its tools, which can be code and data.
  rule('set.remote-mcp', 'settings', 'low', 'An MCP server on another host gets what the agent sends to it', { ...THIRD_PARTY, ...AGENT_SUPPLY, 'owasp-agentic': ['ASI04', 'ASI07'] }),
  // Claude Code's HIPAA configuration covers sessions on Anthropic's own API. Sessions through
  // Amazon Bedrock, Google Vertex AI or another base URL go to another provider, under that
  // provider's terms.
  rule('set.provider-not-hipaa', 'settings', 'medium', 'Sessions go through a provider that Claude Code\'s HIPAA configuration does not cover', { hipaa: ['164.308(b)', '164.312(e)'], ...AGENT_LEAK }, { only: ['hipaa'] }),
  // Transcripts are plain text on disk: every prompt, every file the agent read and every command
  // output. Claude Code keeps them 30 days unless a setting says otherwise, and keeps the
  // transcripts of desktop and Cowork sessions without an end.
  rule('set.transcripts-kept', 'settings', 'low', 'Session transcripts stay on disk in plain text for a long time', { ...KEPT_TEXT, ...AGENT_LEAK }, { fix: 'transcript-days', raise: { to: 'medium', when: ['hipaa', 'pci', 'part11', 'gdpr'] } }),
  // These two variables make Claude Code send the text of prompts or the details of tool calls to
  // the telemetry collector, which is one more place that holds them.
  rule('set.otel-prompts', 'settings', 'medium', 'Prompts or tool details go to the telemetry collector', { ...TRANSIT, gdpr: ['Art. 28', 'Art. 32'], dora: ['Art. 28'], pci: ['3'], ...AGENT_LEAK }),
  // Codex with approval_policy "never" runs every command without a question.
  rule('codex.approval-never', 'settings', 'high', 'Codex runs commands without asking you', { ...ACCESS, ...AGENT_POWER }),
  // Codex with sandbox_mode "danger-full-access" runs commands without any sandbox.
  rule('codex.full-access', 'settings', 'high', 'Codex runs commands with full access to the computer', { ...ACCESS, 'owasp-agentic': ['ASI05'], 'owasp-llm': ['LLM06'], 'nist-ai-rmf': ['MANAGE'], iso42001: [null] }),
  // Network access inside Codex's sandbox lets a command send data out.
  rule('codex.network', 'settings', 'medium', 'Commands in Codex\'s sandbox can reach the network', { ...TRANSIT, ...AGENT_LEAK, 'owasp-agentic': ['ASI02'] }),
  // A full history keeps every prompt in a file on disk.
  rule('codex.history', 'settings', 'low', 'Codex keeps every prompt in its history file', { ...KEPT_TEXT, ...AGENT_LEAK }),

  // Actions: what an agent did in a session, from the end of its log.

  // An agent that read a secret file has sent its content to the model, and it is in the
  // transcript now.
  rule('act.read-secret-file', 'actions', 'high', 'An agent read a file that holds secrets', { ...SECRETS, ...AGENT_LEAK }),
  // An agent that edits its own settings, MCP servers or hooks can widen what it may do.
  rule('act.self-config', 'actions', 'medium', 'An agent changed the settings, the MCP servers or the hooks of an agent', { ...CHANGE, part11: ['11.10(g)'], 'owasp-agentic': ['ASI03', 'ASI10'], 'owasp-llm': ['LLM06'], 'nist-ai-rmf': ['GOVERN'], iso42001: [null] }),
  // An upload or a copy to another host can take code or data out of the computer.
  rule('act.send-out', 'actions', 'medium', 'An agent sent files to another host', { ...TRANSIT, ...AGENT_LEAK, 'owasp-agentic': ['ASI02'] }),
  // A force push rewrites the history of a branch on the server, which is the record of changes.
  rule('act.force-push', 'actions', 'medium', 'An agent rewrote the history of a branch with a force push', { ...CHANGE, annex11: ['9', '10'], ...AGENT_POWER, 'owasp-agentic': ['ASI02', 'ASI08'] }),
  // These commands delete infrastructure, data or a deployment, or ship to production.
  rule('act.destroy', 'actions', 'high', 'An agent ran a command that deletes infrastructure or data, or deploys to production', { ...CHANGE, part11: ['11.10(c)', '11.10(e)'], ...AGENT_POWER, 'owasp-agentic': ['ASI02', 'ASI08'] }),
  // --no-verify skips the checks that a repository runs before a commit or a push.
  rule('act.no-verify', 'actions', 'low', 'An agent skipped the repository\'s checks with --no-verify', { ...CHANGE, iso27001: ['A.8.28', 'A.8.32'], ...AGENT_POWER }),

  // Code: the files an agent changed in the session's repository.

  // Infrastructure code with a public bucket, an open port or a database without encryption
  // exposes data once it is deployed.
  rule('code.iac', 'code', 'medium', 'Infrastructure code has a risky setting', { hipaa: ['164.312(a)', '164.312(a)(2)(iv)'], soc2: ['CC6.1', 'CC8.1'], iso27001: ['A.8.28'], pci: ['3', '4'], glba: ['314.4'], dora: ['Art. 9'], gdpr: ['Art. 32'], nydfs: ['500.15'], ...AGENT_CODE }),
  // A key in the code goes to every copy of the repository, and stays in its history.
  rule('code.secret', 'code', 'high', 'A secret key is in the code', { ...SECRETS, iso27001: ['A.8.24', 'A.8.28'], ...AGENT_LEAK, 'owasp-llm': ['LLM02', 'LLM05'] }),
  // Code that turns off the check of TLS certificates accepts any server, also one in the middle.
  rule('code.tls-off', 'code', 'high', 'The code turns off the check of TLS certificates', { ...TRANSIT, iso27001: ['A.8.24', 'A.8.28'], ...AGENT_CODE }),
  // A log line with a patient's or a person's identifiers puts them into log files and log services.
  rule('code.phi-log', 'code', 'medium', 'The code writes a person\'s identifiers to a log', { hipaa: ['164.514(b)(2)(i)', '164.312(b)'], gdpr: ['Art. 32'], iso27001: ['A.8.15'], 'owasp-llm': ['LLM02', 'LLM05'], 'nist-ai-rmf': ['MEASURE'], iso42001: [null] }, { only: ['hipaa', 'gdpr'] }),
  // A card number in the code is stored account data in every copy of the repository.
  rule('code.card-number', 'code', 'medium', 'A card number is in the code', { pci: ['3'], 'owasp-llm': ['LLM02', 'LLM05'], 'nist-ai-rmf': ['MEASURE'], iso42001: [null] }, { only: ['pci'] }),
  // A plain http:// address to another host sends data without encryption.
  rule('code.http', 'code', 'low', 'A config file names a plain http:// address on another host', { ...TRANSIT, ...AGENT_CODE }),

  // Data: what the text of a session holds, only when the person switched this check on.

  // The transcript holds the number in plain text on disk, for as long as Claude Code keeps it.
  rule('data.us-ssn', 'data', 'high', 'A US social security number is in a session\'s transcript', { hipaa: ['164.514(b)(2)(i)', '164.312(a)(2)(iv)'], gdpr: ['Art. 32'], glba: ['314.4'], soc2: ['CC6.1'], ...AGENT_LEAK }, { fix: 'transcript-days' }),
  rule('data.card-number', 'data', 'high', 'A card number is in a session\'s transcript', { pci: ['3'], gdpr: ['Art. 32'], glba: ['314.4'], ...AGENT_LEAK }, { fix: 'transcript-days' }),
  rule('data.secret', 'data', 'high', 'A secret key is in a session\'s transcript', { ...SECRETS, ...AGENT_LEAK }, { fix: 'transcript-days' }),
].map((r) => [r.id, r]))

/** Whether a rule runs with these frameworks on: always, unless it names frameworks of which none is on. */
export const ruleOn = (r, frameworks) => !r.only || r.only.some((f) => frameworks.includes(f))

/** The severity of a rule with these frameworks on. */
export const severityOf = (r, frameworks) => (r.raise && r.raise.when.some((f) => frameworks.includes(f)) ? r.raise.to : r.severity)

/**
 * A finding of one of these rules, in the shape that findings.mjs keeps. `key` makes the id stable:
 * the rule id, then the key (where it was found). `fix` replaces the rule's fix, and null means none.
 * `severity`, `title` and `source` replace the rule's.
 */
export function makeFinding(ruleId, { key, scope, where = {}, detail, frameworks = [], severity, title, source = 'kestrel', fix }) {
  const r = RULES[ruleId]
  const action = fix === undefined ? r.fix : fix
  const finding = {
    id: key ? `${r.id}:${key}` : r.id,
    rule: r.id,
    kind: r.kind,
    severity: severity ?? severityOf(r, frameworks),
    title: title ?? r.title,
    where,
    scope,
    controls: controlsFor(r.controls, frameworks),
    fix: action ? { action, words: `kestrel apply ${action}` } : null,
    source,
  }
  if (detail) finding.detail = detail
  return finding
}
