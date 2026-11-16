// The catalog of controls: for each security framework that a person can switch on (the keys in
// settings.mjs), the controls that Kestrel's findings point to.
//
// Each control has an id, a plain label, and `confirmed`. `confirmed` is true only for an id that
// was checked against the framework's own text: the HIPAA Security Rule 45 CFR 164.312(a),
// (a)(2)(i), (a)(2)(iv), (b), (c), (d), (e) and 164.514(b)(2)(i); 21 CFR 11.10(a), (c), (d), (e),
// (g) and (k); PCI DSS 6.4.3 and 11.6.1; GLBA 16 CFR 314.4; DORA Art. 28; and the ids of the OWASP
// Top 10 for LLM Applications 2025. Every other id is shown with "(id to check)", so that nobody
// takes it for a checked reference.
//
// HITRUST has no ids of its own here. A finding names the HIPAA and ISO 27001 controls it touches,
// and says that HITRUST is reached through the controls it shares with those two.
//
// ISO/IEC 42001 has no ids here either: a finding names the framework and what it is about.
//
// Kestrel checks technical controls and flags risks. A control in this catalog says what a finding
// is about. It never says that a company meets the control.
import { FRAMEWORKS } from './settings.mjs'

/** The framework ids with their labels, in the order of the settings. */
export const FRAMEWORK_LABEL = Object.fromEntries(FRAMEWORKS.flatMap(([, list]) => list))
const ORDER = FRAMEWORKS.flatMap(([, list]) => list.map(([id]) => id))

/** The frameworks of the AI agents group. A finding that touches none of the switched-on frameworks keeps its controls of this group. */
export const AI_GROUP = ['owasp-agentic', 'owasp-llm', 'nist-ai-rmf', 'iso42001']

// [id, label, confirmed]
export const CONTROLS = {
  hipaa: [
    ['164.312(a)', 'Access control', true],
    ['164.312(a)(2)(i)', 'Unique user identification', true],
    ['164.312(a)(2)(iv)', 'Encryption and decryption', true],
    ['164.312(b)', 'Audit controls', true],
    ['164.312(c)', 'Integrity', true],
    ['164.312(d)', 'Person or entity authentication', true],
    ['164.312(e)', 'Transmission security', true],
    ['164.514(b)(2)(i)', 'The identifiers that de-identified data must not hold, such as names, dates of birth and record numbers', true],
    ['164.308(b)', 'Business associate contracts', false],
  ],
  soc2: [
    ['CC6.1', 'Logical access security', false],
    ['CC7.2', 'Monitoring for anomalies and security events', false],
    ['CC8.1', 'Change management', false],
  ],
  iso27001: [
    ['A.5.15', 'Access control', false],
    ['A.8.10', 'Information deletion', false],
    ['A.8.15', 'Logging', false],
    ['A.8.24', 'Use of cryptography', false],
    ['A.8.28', 'Secure coding', false],
    ['A.8.32', 'Change management', false],
  ],
  part11: [
    ['11.10(a)', 'Validation of systems', true],
    ['11.10(c)', 'Protection of records', true],
    ['11.10(d)', 'Limiting system access to authorized individuals', true],
    ['11.10(e)', 'Audit trails', true],
    ['11.10(g)', 'Authority checks', true],
    ['11.10(k)', 'Controls over systems documentation', true],
  ],
  annex11: [
    ['7', 'Data storage', false],
    ['9', 'Audit trails', false],
    ['10', 'Change and configuration management', false],
    ['12', 'Security', false],
  ],
  gdpr: [
    ['Art. 5(1)(e)', 'Storage limitation', false],
    ['Art. 28', 'Processor', false],
    ['Art. 32', 'Security of processing', false],
  ],
  pci: [
    ['3', 'Protect stored account data', false],
    ['4', 'Protect cardholder data with strong cryptography during transmission', false],
    ['6.4.3', 'Scripts on payment pages are managed', true],
    ['7', 'Restrict access to what the business needs', false],
    ['8', 'Identify users and authenticate access', false],
    ['10', 'Log and monitor all access', false],
    ['11.6.1', 'Unauthorized changes to payment pages are detected', true],
  ],
  glba: [
    ['314.4', 'Elements of the information security program', true],
  ],
  nydfs: [
    ['500.7', 'Access privileges and management', false],
    ['500.12', 'Multi-factor authentication', false],
    ['500.15', 'Encryption of nonpublic information', false],
  ],
  dora: [
    ['Art. 9', 'Protection and prevention', false],
    ['Art. 28', 'Managing ICT third-party risk', true],
  ],
  // The names come from a secondary list, not from OWASP's own document.
  'owasp-agentic': [
    ['ASI01', 'Agent goal hijack', false],
    ['ASI02', 'Tool misuse and exploitation', false],
    ['ASI03', 'Identity and privilege abuse', false],
    ['ASI04', 'Agentic supply chain vulnerabilities', false],
    ['ASI05', 'Unexpected code execution', false],
    ['ASI06', 'Memory and context poisoning', false],
    ['ASI07', 'Insecure inter-agent communication', false],
    ['ASI08', 'Cascading failures', false],
    ['ASI09', 'Human-agent trust exploitation', false],
    ['ASI10', 'Rogue agents', false],
  ],
  'owasp-llm': [
    ['LLM01', 'Prompt injection', true],
    ['LLM02', 'Sensitive information disclosure', true],
    ['LLM03', 'Supply chain', true],
    ['LLM04', 'Data and model poisoning', true],
    ['LLM05', 'Improper output handling', true],
    ['LLM06', 'Excessive agency', true],
    ['LLM07', 'System prompt leakage', true],
    ['LLM08', 'Vector and embedding weaknesses', true],
    ['LLM09', 'Misinformation', true],
    ['LLM10', 'Unbounded consumption', true],
  ],
  // The four functions of the NIST AI RMF, by name.
  'nist-ai-rmf': [
    ['GOVERN', 'Govern: rules and responsibility for the risks of AI', false],
    ['MAP', 'Map: the context and the risks', false],
    ['MEASURE', 'Measure: assess and follow the risks', false],
    ['MANAGE', 'Manage: act on the risks', false],
  ],
  // ISO/IEC 42001 has no control ids here.
  iso42001: [
    [null, 'AI management system', false],
  ],
}

/** The sentence that goes with HITRUST, which reaches a finding through HIPAA and ISO 27001. */
export const HITRUST_WORDS = 'HITRUST: through the controls it shares with HIPAA and ISO 27001'

/** One control as a finding holds it: `{ framework, id, confirmed, label }`, or undefined when the catalog has no such id. */
export function control(framework, id) {
  const found = CONTROLS[framework]?.find(([cid]) => cid === id)
  return found ? { framework, id: found[0], confirmed: found[2], label: found[1] } : undefined
}

/** The label of a control, for a builder that maps controls of its own: the catalog's label, or undefined. */
export const controlLabel = (framework, id) => control(framework, id)?.label

const same = (a, b) => a.framework === b.framework && a.id === b.id

/**
 * The controls of a rule for the frameworks that are on. `map` is the rule's controls: framework id
 * to a list of control ids. Only switched-on frameworks count. With HITRUST on, the rule's HIPAA and
 * ISO 27001 controls are named, and one entry with the HITRUST sentence follows them. When none of
 * the frameworks that are on touches the rule, the rule's controls of the AI agents group are kept,
 * so that a finding never stands without any.
 */
export function controlsFor(map, frameworks) {
  const on = new Set(frameworks)
  const out = []
  const add = (framework, id) => {
    const c = control(framework, id)
    if (c && !out.some((x) => same(x, c))) out.push(c)
  }
  for (const framework of ORDER) {
    if (!on.has(framework) || framework === 'hitrust') continue
    for (const id of map[framework] ?? []) add(framework, id)
  }
  if (on.has('hitrust')) {
    const shared = [...(map.hipaa ?? []).map((id) => ['hipaa', id]), ...(map.iso27001 ?? []).map((id) => ['iso27001', id])]
    for (const [framework, id] of shared) add(framework, id)
    if (shared.length) out.push({ framework: 'hitrust', id: null, confirmed: false, label: HITRUST_WORDS })
  }
  if (!out.length) for (const framework of AI_GROUP) for (const id of map[framework] ?? []) add(framework, id)
  return out
}

/**
 * The controls of a finding that came with its own list (a cloud finding, for example), for the
 * frameworks that are on: those of switched-on frameworks, or else those of the AI agents group.
 * With HITRUST on, its HIPAA and ISO 27001 controls count too.
 */
export function storedControlsFor(controls, frameworks) {
  const list = Array.isArray(controls) ? controls.filter((c) => c && typeof c.framework === 'string') : []
  const on = new Set(frameworks)
  if (on.has('hitrust')) for (const f of ['hipaa', 'iso27001']) on.add(f)
  const shown = list.filter((c) => on.has(c.framework))
  return shown.length ? shown : list.filter((c) => AI_GROUP.includes(c.framework))
}

/** One control in words: "HIPAA 164.312(e) Transmission security", with "(id to check)" for an id that was not checked. */
export function controlWords(c) {
  if (c.framework === 'hitrust' && c.id == null) return c.label
  const name = FRAMEWORK_LABEL[c.framework] ?? c.framework
  if (c.id == null) return `${name}: ${c.label}`
  return `${name} ${c.id} ${c.label}${c.confirmed === true ? '' : ' (id to check)'}`
}
