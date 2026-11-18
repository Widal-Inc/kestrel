// The open security findings as text: for the desktop extension's tool security_check, and for
// what "widal cloud-check" prints after a run. Each finding shows its severity, kind, title,
// where it is, the controls of the frameworks that are on, and the command that fixes it. Nothing
// that was matched is in a finding, so nothing of it can be in this text.
import { openFindings } from './findings.mjs'
import { when } from './format.mjs'
import { CHECK_NOTE, HITRUST_NOTE, clean, controlWords, controlsLine, placeOf } from './finding-words.mjs'
import { FRAMEWORKS, securityConfig } from './settings.mjs'

/** The label of each framework, by its key. */
export const FRAMEWORK_LABELS = Object.fromEntries(FRAMEWORKS.flatMap(([, list]) => list))
/** The frameworks of the AI agents group: their controls show for a finding that touches no framework that is on. */
export const AGENT_FRAMEWORKS = FRAMEWORKS.find(([group]) => group === 'AI agents')[1].map(([id]) => id)

/** The counts by severity in words: "1 high, 2 medium, 0 low, 0 info". */
export const countsWords = (counts) => ['high', 'medium', 'low', 'info'].map((s) => `${counts[s] ?? 0} ${s}`).join(', ')

/**
 * Controls that are already the ones to show, as one line. The HITRUST entry of a rule's controls
 * is its sentence. A finding with a list of its own (a cloud finding) has no such entry: with
 * HITRUST on and a HIPAA or ISO 27001 control among them, the sentence follows.
 */
function computedLine(controls = [], on = [], labels = FRAMEWORK_LABELS) {
  const list = Array.isArray(controls) ? controls.filter((c) => c && typeof c === 'object') : []
  const words = list.map((c) => (c.framework === 'hitrust' && c.id == null ? clean(c.label, 120) : controlWords(c, labels)))
  if (on.includes('hitrust') && !list.some((c) => c.framework === 'hitrust') && list.some((c) => c.framework === 'hipaa' || c.framework === 'iso27001')) words.push(HITRUST_NOTE)
  return words.join('; ')
}

/**
 * The lines of one finding. With `computed`, the finding's controls are already those to show, as
 * "widal check" picks them (see reportData in security.mjs), and they are shown as they are.
 */
export function findingLines(f, { on, labels = FRAMEWORK_LABELS, computed = false } = {}) {
  const lines = [`${f.severity.toUpperCase()}  ${clean(f.title)} (${f.kind})`, `  Where: ${placeOf(f.where)}`]
  if (f.detail) lines.push(`  What: ${clean(f.detail, 1000)}`)
  const controls = computed ? computedLine(f.controls, on, labels) : controlsLine(f, { on, labels, fallback: AGENT_FRAMEWORKS })
  if (controls) lines.push(`  Controls: ${controls}`)
  if (Array.isArray(f.reported) && f.reported.length) lines.push(`  Frameworks the tool reported: ${f.reported.map((r) => clean(r, 80)).join(', ')}`)
  lines.push(`  Fix: ${f.fix?.words ? clean(f.fix.words) : 'none that Widal.Code makes. The finding says what to change.'}`)
  if (f.firstSeen) lines.push(`  First seen ${when(f.firstSeen)}, last seen ${when(f.lastSeen ?? f.firstSeen)}.`)
  return lines
}

/**
 * The open findings as text, the most severe first, with the frameworks that are on and the
 * sentence that Widal.Code does not certify. `findings` and `frameworks` stand in for the store and
 * the person's settings. `computed` says that each finding's controls are already the ones to show.
 */
export function findingsText({ findings = openFindings(), frameworks = securityConfig().frameworks, computed = false } = {}) {
  const counts = { high: 0, medium: 0, low: 0, info: 0 }
  for (const f of findings) counts[f.severity]++
  const out = [
    `Widal.Code's security checks: ${findings.length} open ${findings.length === 1 ? 'finding' : 'findings'} (${countsWords(counts)}).`,
    `Frameworks that are on: ${frameworks.length ? frameworks.map((id) => FRAMEWORK_LABELS[id] ?? id).join(', ') : 'none'}.`,
  ]
  if (!findings.length) out.push('', 'No check has found anything open.')
  for (const f of findings) out.push('', ...findingLines(f, { on: frameworks, computed }))
  out.push('', CHECK_NOTE)
  return out.join('\n')
}
