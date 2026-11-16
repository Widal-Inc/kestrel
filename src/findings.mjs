// The security and compliance findings of Kestrel, in one small file: ~/.kestrel/findings.json.
//
// Every check (of the agents' settings, of what they did, of the code they changed, of session
// text when the person turned that on, and of cloud accounts on request) writes its findings here.
// The status line, the hooks, "kestrel check", the pane and the desktop extension read them.
//
// A finding never holds what was matched: no secret, no patient data, no command, no text of a
// session. It says what kind of thing was found and where (a file and line, a project, a cloud
// resource), and which controls of the switched-on frameworks it touches.
//
// A finding:
// {
//   id: "code.tls-off:/work/app:src/client.py:12",   stable: the rule and where, so a check run again finds the same one
//   rule: "code.tls-off",                             the rule's id
//   kind: "settings" | "actions" | "code" | "data" | "cloud",
//   severity: "high" | "medium" | "low" | "info",
//   title: "TLS checks are turned off",               one plain sentence
//   detail: "requests.get(..., verify=False)",        optional: plain words about the kind of thing, never the matched text itself
//   where: { file, line, repo, project, session, account, provider, resource },   only the fields that apply
//   scope: "settings" | "repo:/work/app" | "session:<id>" | "cloud:aws:<account>" | ...,   what one run of a check covers
//   controls: [ { framework: "hipaa", id: "164.312(e)", confirmed: true, label: "Transmission security" } ],
//   fix: { action: "no-bypass", words: "kestrel apply no-bypass" } | null,
//   source: "kestrel" | "checkov" | "trivy" | "kics" | "gitleaks" | "prowler" | "aws-config" | "security-hub" | "vercel" | "github",
//   status: "open" | "resolved",
//   firstSeen, lastSeen, resolvedAt: times in milliseconds
// }
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson } from './config.mjs'
import { home } from './paths.mjs'

export const findingsFile = () => join(home(), 'findings.json')

export const SEVERITIES = ['high', 'medium', 'low', 'info']
export const KINDS = ['settings', 'actions', 'code', 'data', 'cloud']

// Fields that would hold what was matched. A finding with one of them is refused, so that no
// check can store a secret or patient data by mistake.
const FORBIDDEN = ['match', 'matched', 'text', 'value', 'secret', 'snippet', 'line_text', 'command']

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Whether a finding has the shape above and holds nothing that was matched. */
export function validFinding(f) {
  if (!isObject(f) || typeof f.id !== 'string' || !f.id || typeof f.rule !== 'string' || !f.rule) return false
  if (!KINDS.includes(f.kind) || !SEVERITIES.includes(f.severity) || typeof f.title !== 'string' || !f.title) return false
  if (typeof f.scope !== 'string' || !f.scope) return false
  if (FORBIDDEN.some((k) => k in f)) return false
  if (f.where !== undefined && (!isObject(f.where) || FORBIDDEN.some((k) => k in f.where))) return false
  if (f.controls !== undefined && !Array.isArray(f.controls)) return false
  return true
}

/** All findings in the file, open and resolved. A file that is missing or broken gives none. */
export function readFindings() {
  const raw = readJson(findingsFile(), {})
  return Array.isArray(raw?.findings) ? raw.findings.filter(validFinding) : []
}

/**
 * Saves the findings of one run of a check that covers `scope` (for example "settings" or
 * "repo:/work/app"). A finding that this run found again keeps its `firstSeen` and is open. A
 * finding of the same scope and kind that this run did not find is resolved. Findings of other
 * scopes and kinds stay as they are. Invalid findings are left out. Returns the findings of the run.
 */
export function saveFindings(found, { scope, kind, now = Date.now() }) {
  const all = readFindings()
  const fresh = new Map()
  for (const f of found) {
    if (!validFinding(f) || f.scope !== scope || f.kind !== kind) continue
    fresh.set(f.id, f)
  }
  const out = []
  for (const old of all) {
    if (old.scope !== scope || old.kind !== kind) {
      out.push(old)
      continue
    }
    const again = fresh.get(old.id)
    if (again) {
      out.push({ ...again, status: 'open', firstSeen: old.firstSeen ?? now, lastSeen: now, resolvedAt: undefined })
      fresh.delete(old.id)
    } else if (old.status === 'open') {
      out.push({ ...old, status: 'resolved', resolvedAt: now })
    } else {
      out.push(old)
    }
  }
  for (const f of fresh.values()) out.push({ ...f, status: 'open', firstSeen: now, lastSeen: now })
  // Resolved findings older than 30 days are dropped, so the file stays small.
  const kept = out.filter((f) => f.status === 'open' || !(f.resolvedAt < now - 30 * 86400e3))
  mkdirSync(home(), { recursive: true })
  writeJson(findingsFile(), { at: now, findings: kept })
  return kept.filter((f) => f.scope === scope && f.kind === kind && f.status === 'open')
}

/**
 * The open findings, the most severe first, then the newest, then by id. `repo` keeps those of one repository and those that
 * are not tied to a repository (settings, cloud). `least` is the least severity to keep.
 */
export function openFindings({ repo, least = 'info' } = {}) {
  const max = SEVERITIES.indexOf(least)
  return readFindings()
    .filter((f) => f.status === 'open' && SEVERITIES.indexOf(f.severity) <= max)
    .filter((f) => repo === undefined || !f.where?.repo || f.where.repo === repo)
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** How many open findings there are of each severity: `{ high, medium, low, info }`. */
export function countOpen(options) {
  const counts = { high: 0, medium: 0, low: 0, info: 0 }
  for (const f of openFindings(options)) counts[f.severity]++
  return counts
}
