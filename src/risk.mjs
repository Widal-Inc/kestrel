// The part of the status line about the security findings. It is in a file of its own so that the
// status line loads only this and the store of findings, never the checks themselves.
import { readFindings } from './findings.mjs'
import { repoOf } from './git.mjs'

/**
 * The part of the status line as [text, tone]: a red "2 high risks", or a yellow "1 medium risk",
 * when open findings of the settings or of the repository of `cwd` exist. Undefined when there are
 * none. It reads only the findings file, and a missing or broken file has none.
 */
export function riskPart(cwd) {
  const repo = typeof cwd === 'string' ? repoOf(cwd) : undefined
  let high = 0
  let medium = 0
  for (const f of readFindings()) {
    if (f.status !== 'open' || !(f.kind === 'settings' || (repo && f.where?.repo === repo))) continue
    if (f.severity === 'high') high++
    else if (f.severity === 'medium') medium++
  }
  if (high) return [`${high} high ${high === 1 ? 'risk' : 'risks'}`, 'bad']
  if (medium) return [`${medium} medium ${medium === 1 ? 'risk' : 'risks'}`, 'warn']
  return undefined
}
