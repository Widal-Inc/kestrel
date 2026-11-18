// The words for a security finding: where it is, which controls it touches, and the prompt that
// hands it to the agent. The pane in Claude Code, "widal cloud-check" and the desktop
// extension all say these the same way.
//
// This file imports nothing, because the pane runs inside Claude Code without Node and may only
// import files that import nothing. It works on a finding's own fields (see src/findings.mjs), and
// a finding never holds what was matched.

/** The sentence that goes with every list of findings. */
export const CHECK_NOTE = 'Widal.Code checks technical controls and flags risks. It does not make a company compliant or certify it.'

/** The names of the cloud providers, as a person reads them. */
export const PROVIDERS = { aws: 'AWS', vercel: 'Vercel', github: 'GitHub' }

// HITRUST has no control ids of its own in Widal.Code. Its findings come through the controls it
// shares with HIPAA and ISO 27001.
const HITRUST_SHARES = ['hipaa', 'iso27001']
export const HITRUST_NOTE = 'HITRUST: through the controls it shares with HIPAA and ISO 27001'

/** Text that is safe on one line: no control characters, and at most `max` characters. */
export function clean(value, max = 200) {
  const text = String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

/**
 * Where a finding is, in plain words: a file and line in a repository, a session, or a cloud
 * resource with its provider, account, project and region. Only the fields that are there.
 */
export function placeOf(where = {}) {
  const w = where && typeof where === 'object' ? where : {}
  const parts = []
  if (w.file) parts.push(`${clean(w.file)}${Number.isInteger(w.line) ? `:${w.line}` : ''}${w.repo ? ` in ${clean(w.repo)}` : ''}`)
  else if (w.repo) parts.push(clean(w.repo))
  if (w.session) parts.push(`session ${clean(w.session, 12)}`)
  if (w.provider || w.account || w.project) {
    const cloud = [PROVIDERS[w.provider] ?? clean(w.provider), w.account && `account ${clean(w.account)}`, w.project && `project ${clean(w.project)}`].filter(Boolean)
    parts.push(cloud.join(' '))
  }
  if (w.resource) parts.push(clean(w.resource))
  if (w.region) parts.push(`region ${clean(w.region, 40)}`)
  return parts.join(', ') || 'no place named'
}

/**
 * The controls of a finding that are shown: those of the frameworks that are on. With HITRUST on,
 * the HIPAA and ISO 27001 controls count too. A finding that touches none of them shows its
 * controls of `fallback`, the AI agents group.
 */
export function controlsShown(finding, on = [], fallback = []) {
  const list = Array.isArray(finding?.controls) ? finding.controls.filter((c) => c && typeof c === 'object') : []
  const counted = new Set(on)
  if (counted.has('hitrust')) for (const id of HITRUST_SHARES) counted.add(id)
  const mine = list.filter((c) => counted.has(c.framework))
  return mine.length ? mine : list.filter((c) => fallback.includes(c.framework))
}

/** One control in words: the framework, its id and label, and "(id to check)" when the id is not confirmed. */
export function controlWords(control, labels = {}) {
  const name = labels[control.framework] ?? clean(control.framework, 40)
  const label = control.label ? ` ${clean(control.label, 80)}` : ''
  return `${name} ${clean(control.id, 40)}${label}${control.confirmed === true ? '' : ' (id to check)'}`
}

/**
 * The controls of a finding as one line, as `controlsShown` picks them, or '' when there are
 * none. With HITRUST on and a HIPAA or ISO 27001 control among them, the HITRUST sentence follows.
 */
export function controlsLine(finding, { on = [], labels = {}, fallback = [] } = {}) {
  const shown = controlsShown(finding, on, fallback)
  const words = shown.map((c) => controlWords(c, labels))
  if (on.includes('hitrust') && shown.some((c) => HITRUST_SHARES.includes(c.framework))) words.push(HITRUST_NOTE)
  return words.join('; ')
}

/**
 * The prompt that hands a finding to the agent in the session. It holds only the finding's own
 * fields: its title, where it is and its controls. A finding never holds what was matched.
 */
export function handPrompt(finding, controls) {
  return `Widal.Code found: ${clean(finding.title)} in ${placeOf(finding.where)}. Controls: ${controls || 'none named'}. Please fix it, explain what you changed, and do not print any secret.`
}
