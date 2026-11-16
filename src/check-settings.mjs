// The check of the agents' settings: what Claude Code and Codex let an agent do without asking,
// where transcripts and prompts end up, and which MCP servers get the agent's data.
//
// It reads files only, and changes nothing:
//   - Claude Code's user settings (settings.json in its config folder) and the managed settings of
//     the organization, when they are there and readable;
//   - the project files of the folder the check runs for: .claude/settings.json,
//     .claude/settings.local.json and .mcp.json, in the folder and at the top of its repository;
//   - the file .claude.json, for the MCP servers it names. Of a server only its name, its type
//     and the host of its address are taken: never its headers, its environment or its command;
//   - Codex's config.toml.
//
// The rules about what a person has set for all their projects (bypass mode, the deny rules, the
// sandbox, the transcripts, telemetry, the provider) look at the user and the managed settings
// only, so that their findings do not change with the folder the check runs in. The project files
// add their own findings, each tied to its folder.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { plain } from './format.mjs'
import { repoOf } from './git.mjs'
import { claudeDir, claudeJsonOf, codexDir, realPath, shortPath } from './paths.mjs'
import { makeFinding, ruleOn, RULES } from './rules.mjs'

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A JSON file that holds an object, or undefined: missing, broken and other values all give undefined. */
function readObject(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return isObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * The file of the organization's managed settings on this system. KESTREL_MANAGED_SETTINGS names
 * another file instead: the tests use it, so that they never depend on the computer they run on.
 */
export function managedSettingsFile(env = process.env, platform = process.platform) {
  if (env.KESTREL_MANAGED_SETTINGS) return env.KESTREL_MANAGED_SETTINGS
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json'
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
  return '/etc/claude-code/managed-settings.json'
}

/**
 * The managed settings as one object: the file and the files of the folder managed-settings.d next
 * to it, merged by their top-level keys. Undefined when none can be read.
 */
function readManaged(file) {
  const parts = []
  const main = readObject(file)
  if (main) parts.push(main)
  try {
    const dir = join(file, '..', 'managed-settings.d')
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      const part = readObject(join(dir, name))
      if (part) parts.push(part)
    }
  } catch {
    // No folder of drop-in files.
  }
  return parts.length ? Object.assign({}, ...parts) : undefined
}

/**
 * The settings files that count for all of a person's projects, the highest first: managed, then
 * user. Each is `{ level, file, data }`. The place of the managed file comes from the real
 * environment, like KESTREL_HOME: it is no setting of an agent.
 */
export function personFiles() {
  const out = []
  const managedFile = managedSettingsFile()
  const managed = readManaged(managedFile)
  if (managed) out.push({ level: 'managed', file: managedFile, data: managed })
  const userFile = join(claudeDir(), 'settings.json')
  const user = readObject(userFile)
  if (user) out.push({ level: 'user', file: userFile, data: user })
  return out
}

/** The project folders the check looks at for a folder: the folder and the top of its repository, each once. Never the home folder. */
export function projectFolders(cwd) {
  if (typeof cwd !== 'string' || !cwd) return []
  const home = realPath(homedir())
  return [...new Set([realPath(cwd), repoOf(cwd)].filter(Boolean))].filter((dir) => dir !== home && join(dir, '.claude') !== realPath(claudeDir()))
}

/** The settings files of the project folders, the higher precedence first: local, then shared. */
function projectFiles(folders) {
  const out = []
  for (const folder of folders) {
    for (const [level, name] of [['local', 'settings.local.json'], ['project', 'settings.json']]) {
      const file = join(folder, '.claude', name)
      const data = readObject(file)
      if (data) out.push({ level, file, data, project: folder })
    }
  }
  return out
}

/** The first value that the files give, from the highest one down, with its file. */
function first(files, get) {
  for (const f of files) {
    const v = get(f.data)
    if (v !== undefined) return { value: v, file: f }
  }
  return undefined
}

// Values that turn a switch of the environment off.
const OFF = new Set(['', '0', 'false', 'no', 'off'])
const isOn = (v) => v !== undefined && v !== null && !OFF.has(String(v).trim().toLowerCase())

/** Where a variable is set, in a finding's words and fields: the first settings file that sets it, else the environment. */
function variableAt(name, files, env) {
  const inFile = first(files, (d) => (isObject(d.env) && isOn(d.env[name]) ? d.env[name] : undefined))
  if (inFile) return { value: inFile.value, where: { file: shortPath(inFile.file.file) }, words: `in ${shortPath(inFile.file.file)}` }
  if (isOn(env[name])) return { value: env[name], where: {}, words: 'in the environment' }
  return undefined
}

// The hosts that are this computer.
const LOCAL_HOST = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|::1|\[::1\]|[^.]+\.localhost|[^.]+\.local)$/i
export const isLocalHost = (host) => LOCAL_HOST.test(host)

/** The host of an address, or undefined when it is not one. */
function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

/** The MCP servers of one place that have an address on another host: [name, type, host]. Only those three are taken. */
function remoteServers(servers) {
  if (!isObject(servers)) return []
  const out = []
  for (const [name, s] of Object.entries(servers)) {
    if (!isObject(s) || typeof s.url !== 'string') continue
    const host = hostOf(s.url)
    if (!host || isLocalHost(host)) continue
    out.push([plain(name).slice(0, 60), typeof s.type === 'string' ? plain(s.type).slice(0, 20) : 'http', plain(host).slice(0, 100)])
  }
  return out
}

/**
 * Codex's config.toml as `{ root, tables }`. A small reader that takes what the rules need: keys
 * with text, true or false, or a number as their value, at the top and in [tables]. A dotted key
 * at the top goes to its table. Lists and everything else are left out.
 */
export function readToml(text) {
  const root = {}
  const tables = {}
  let at = root
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '')
    if (!line || line.startsWith('#')) continue
    const table = /^\[([^[\]]+)\]\s*(#.*)?$/.exec(line)
    if (table) {
      const name = table[1].trim().split('.').map((p) => p.trim().replace(/^"(.*)"$/, '$1')).join('.')
      at = tables[name] ??= {}
      continue
    }
    if (line.startsWith('[[')) {
      // An array of tables: nothing the rules need is in one.
      at = {}
      continue
    }
    const pair = /^("[^"]*"|[\w.-]+)\s*=\s*(.+)$/.exec(line)
    if (!pair) continue
    const key = pair[1].replace(/^"(.*)"$/, '$1')
    const rest = pair[2].trim()
    let value
    const quoted = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(rest)
    if (quoted) value = quoted[1] ?? quoted[2]
    else if (/^(true|false)\b/.test(rest)) value = rest.startsWith('true')
    else if (/^-?\d+(\.\d+)?\b/.test(rest)) value = Number(/^-?\d+(\.\d+)?/.exec(rest)[0])
    else continue
    const dot = key.lastIndexOf('.')
    if (at === root && dot > 0) (tables[key.slice(0, dot)] ??= {})[key.slice(dot + 1)] = value
    else at[key] = value
  }
  return { root, tables }
}

/** The days that Claude Code keeps transcripts, from the user and the managed settings: `{ cleanup, desktop }`, each a number or undefined. */
export function transcriptDays(files) {
  const num = (v) => (Number.isFinite(v) ? v : undefined)
  return {
    cleanup: num(first(files, (d) => d.cleanupPeriodDays)?.value),
    desktop: num(first(files, (d) => d.desktopSessionCleanupPeriodDays)?.value),
  }
}

// A rule's allow entry that lets every shell command run: "Bash", "Bash(*)" and the forms with "**" or ":*".
const ANY_SHELL = /^Bash(\((\*|\*\*|:\*)\))?$/
// A deny rule that covers reading .env files: a bare "Read", or a Read rule whose pattern names .env.
const DENIES_ENV = (r) => r === 'Read' || /^Read\(.*\.env.*\)$/.test(r)
// A deny rule that covers private keys: a bare "Read", or a Read rule for .pem files, id_rsa or the .ssh folder.
const DENIES_KEYS = (r) => r === 'Read' || /^Read\(.*(\.pem|id_rsa|\.ssh).*\)$/.test(r)

/**
 * The findings of the settings, for the folder `cwd`. `frameworks` are the person's switched-on
 * frameworks. `env` stands in for the environment. Returns `{ findings, projects }`: `projects` are
 * the project folders that were looked at.
 */
export function checkSettings({ cwd, env = process.env, frameworks = [] } = {}) {
  const findings = []
  const add = (rule, opts) => findings.push(makeFinding(rule, { scope: 'settings', frameworks, ...opts }))
  const person = personFiles()
  const projects = projectFolders(cwd)
  const local = projectFiles(projects)
  const all = [...person, ...local]
  const fileWords = (f) => shortPath(f.file)
  const whereOf = (f) => (f.project ? { file: shortPath(f.file), project: f.project } : { file: shortPath(f.file) })

  // Bypass mode. A "disable" in any file keeps bypass mode from starting, and the same for auto mode.
  const bypassOff = all.some((f) => f.data.permissions?.disableBypassPermissionsMode === 'disable')
  const autoOff = all.some((f) => f.data.disableAutoMode === 'disable' || f.data.permissions?.disableAutoMode === 'disable')
  const mode = first(person, (d) => (typeof d.permissions?.defaultMode === 'string' ? d.permissions.defaultMode : undefined))
  if (mode?.value === 'bypassPermissions' && !bypassOff) {
    add('set.bypass-mode', { key: `defaultMode:${fileWords(mode.file)}`, where: whereOf(mode.file), detail: `permissions.defaultMode is bypassPermissions in ${fileWords(mode.file)}: every tool call runs without a question.` })
  }
  if (mode?.value === 'auto' && !autoOff) {
    add('set.bypass-mode', { key: `defaultMode:${fileWords(mode.file)}`, where: whereOf(mode.file), fix: null, detail: `permissions.defaultMode is auto in ${fileWords(mode.file)}: a classifier decides in your place which tool calls run.` })
  }
  // The key counts from the user, the local and the managed settings.
  for (const f of all.filter((x) => x.level !== 'project' && x.data.skipDangerousModePermissionPrompt === true)) {
    if (bypassOff) break
    add('set.bypass-mode', {
      key: `skip:${fileWords(f)}`, where: whereOf(f), fix: f.level === 'user' ? undefined : null,
      detail: `skipDangerousModePermissionPrompt is true in ${fileWords(f)}: bypass mode was accepted once, and starts without a warning.`,
    })
  }

  for (const f of all) {
    const allow = Array.isArray(f.data.permissions?.allow) ? f.data.permissions.allow : []
    if (allow.some((r) => typeof r === 'string' && ANY_SHELL.test(r.trim()))) add('set.allow-any-shell', { key: fileWords(f), where: whereOf(f), detail: `An allow rule in ${fileWords(f)} names every shell command.` })
    if (f.data.enableAllProjectMcpServers === true) add('set.all-project-mcp', { key: fileWords(f), where: whereOf(f), detail: `enableAllProjectMcpServers is true in ${fileWords(f)}.` })
  }

  const userFile = join(claudeDir(), 'settings.json')
  const deny = person.flatMap((f) => (Array.isArray(f.data.permissions?.deny) ? f.data.permissions.deny : [])).filter((r) => typeof r === 'string').map((r) => r.trim())
  const missing = [deny.some(DENIES_ENV) ? null : '.env files', deny.some(DENIES_KEYS) ? null : 'private keys'].filter(Boolean)
  if (missing.length) add('set.no-secret-deny', { key: 'person', where: { file: shortPath(userFile) }, detail: `Your user and managed settings have no deny rule for reading ${missing.join(' or ')}.` })

  if (first(person, (d) => (isObject(d.sandbox) && typeof d.sandbox.enabled === 'boolean' ? d.sandbox.enabled : undefined))?.value !== true) {
    add('set.sandbox-off', { key: 'person', where: { file: shortPath(userFile) }, detail: 'sandbox.enabled is not true in your user or managed settings. A project can still turn it on in its own settings.' })
  }

  // MCP servers with an address on another host: in the settings files, in .claude.json (for all
  // projects and for these project folders) and in the project folders' .mcp.json.
  const claudeJson = claudeJsonOf(claudeDir())
  const places = all.map((f) => [f.file, f.data.mcpServers, f.project])
  const cj = readObject(claudeJson)
  if (cj) {
    places.push([claudeJson, cj.mcpServers])
    for (const folder of projects) places.push([claudeJson, isObject(cj.projects) ? cj.projects[folder]?.mcpServers : undefined, folder])
  }
  for (const folder of projects) places.push([join(folder, '.mcp.json'), readObject(join(folder, '.mcp.json'))?.mcpServers, folder])
  for (const [file, servers, project] of places) {
    for (const [name, type, host] of remoteServers(servers)) {
      add('set.remote-mcp', { key: `${shortPath(file)}:${project ?? ''}:${name}`, where: project ? { file: shortPath(file), project } : { file: shortPath(file) }, detail: `The MCP server "${name}" (${type}) is on ${host}.` })
    }
  }

  if (ruleOn(RULES['set.provider-not-hipaa'], frameworks)) {
    for (const name of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
      const at = variableAt(name, person, env)
      if (at) add('set.provider-not-hipaa', { key: name, where: at.where, detail: `${name} is set ${at.words}.` })
    }
    const base = variableAt('ANTHROPIC_BASE_URL', person, env)
    if (base && hostOf(String(base.value)) !== 'api.anthropic.com') add('set.provider-not-hipaa', { key: 'ANTHROPIC_BASE_URL', where: base.where, detail: `ANTHROPIC_BASE_URL is set ${base.words} and points to another host than api.anthropic.com.` })
  }

  // Claude Code deletes a transcript once it is older than cleanupPeriodDays (30 when it is not
  // set). The transcripts of desktop and Cowork sessions also wait for desktopSessionCleanupPeriodDays,
  // which keeps them without an end when it is missing or 0.
  const days = transcriptDays(person)
  const long = []
  if (days.cleanup === undefined) long.push('cleanupPeriodDays is not set, so Claude Code keeps transcripts for 30 days')
  else if (days.cleanup > 7) long.push(`cleanupPeriodDays is ${days.cleanup}, so Claude Code keeps transcripts for ${days.cleanup} days`)
  if (!(days.desktop > 0)) long.push('desktopSessionCleanupPeriodDays is not set, so the transcripts of desktop and Cowork sessions are kept without an end')
  else if (days.desktop > 7) long.push(`desktopSessionCleanupPeriodDays is ${days.desktop}, so the transcripts of desktop and Cowork sessions are kept for ${Math.max(days.desktop, days.cleanup ?? 30)} days`)
  if (long.length) add('set.transcripts-kept', { key: 'person', where: { file: shortPath(userFile) }, detail: `${long.join('. ')}. They are plain text on disk.` })

  for (const name of ['OTEL_LOG_USER_PROMPTS', 'OTEL_LOG_TOOL_DETAILS']) {
    const at = variableAt(name, person, env)
    if (at) add('set.otel-prompts', { key: name, where: at.where, detail: `${name} is set ${at.words}.` })
  }

  // Codex. A profile can set the same keys as the top of the file.
  const codexFile = join(codexDir(), 'config.toml')
  if (existsSync(codexFile)) {
    let toml
    try {
      toml = readToml(readFileSync(codexFile, 'utf8'))
    } catch {
      toml = undefined
    }
    if (toml) {
      const where = { file: shortPath(codexFile) }
      const places = [['at the top', toml.root], ...Object.entries(toml.tables).filter(([name]) => name.startsWith('profiles.')).map(([name, t]) => [`in the profile ${plain(name.slice(9)).slice(0, 40)}`, t])]
      const at = (key, value) => places.filter(([, t]) => t[key] === value).map(([words]) => words)
      const never = at('approval_policy', 'never')
      if (never.length) add('codex.approval-never', { key: 'codex', where, detail: `approval_policy is "never" ${never.join(' and ')} of ${shortPath(codexFile)}.` })
      const full = at('sandbox_mode', 'danger-full-access')
      if (full.length) add('codex.full-access', { key: 'codex', where, detail: `sandbox_mode is "danger-full-access" ${full.join(' and ')} of ${shortPath(codexFile)}.` })
      if (toml.tables.sandbox_workspace_write?.network_access === true) add('codex.network', { key: 'codex', where, detail: `sandbox_workspace_write.network_access is true in ${shortPath(codexFile)}.` })
      if (toml.tables.history?.persistence === 'save-all') add('codex.history', { key: 'codex', where, detail: `history.persistence is "save-all" in ${shortPath(codexFile)}.` })
    }
  }
  return { findings, projects }
}
