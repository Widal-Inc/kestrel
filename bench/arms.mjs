// The arms of the benchmark. An arm is one way to run the same tasks: a model, an effort, and
// whether Widal.Code is on. Each arm is a settings file that Claude Code gets with --settings.
//
// `number` goes into the ticket key of each run, so that the spend per ticket can be checked.

/** The settings that every arm has. Claude Code's memory is off, so that one task tells the next one nothing. */
const COMMON = { autoMemoryEnabled: false, env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_AUTOUPDATER: '1' } }

export const ARMS = [
  { id: 'fable-xhigh', number: 1, name: 'Fable 5.2, effort xhigh', settings: { model: 'claude-fable-5-2', effortLevel: 'xhigh' } },
  { id: 'fable-low', number: 2, name: 'Fable 5.2, effort low', settings: { model: 'claude-fable-5-2', effortLevel: 'low' } },
  { id: 'opus-xhigh', number: 3, name: 'Opus 5.5, effort xhigh', settings: { model: 'claude-opus-5-5', effortLevel: 'xhigh' } },
  { id: 'sonnet-xhigh', number: 4, name: 'Sonnet 5.5, effort xhigh', settings: { model: 'claude-sonnet-5-5', effortLevel: 'xhigh' } },
  { id: 'haiku', number: 5, name: 'Haiku 5.5', settings: { model: 'claude-haiku-5-5' } },
  // The baseline with Widal.Code on: its hooks run, and its settings are the baseline's after
  // "widal apply" for every proposal of "widal advise" that the tool can apply itself.
  { id: 'widal-on', number: 6, name: 'Fable 5.2 xhigh, Widal.Code on', from: 'fable-xhigh', plugin: true },
]

/** The arm that the others are compared with. */
export const BASELINE = 'fable-xhigh'

export const armOf = (id) => {
  const arm = ARMS.find((a) => a.id === id)
  if (!arm) throw new RangeError(`no arm "${id}". The arms are: ${ARMS.map((a) => a.id).join(', ')}`)
  return arm
}

/** The settings of an arm as Claude Code reads them. */
export function settingsOf(arm) {
  const own = arm.settings ?? armOf(arm.from).settings
  return { ...COMMON, ...own, env: { ...COMMON.env, ...(own.env ?? {}) } }
}

/**
 * The tools that an agent may use without a person to ask. A run has no person, so every other
 * tool call is refused. The shell is limited to the test command, node and reading commands.
 */
export const TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent',
  'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(node:*)', 'Bash(TZ=*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(grep:*)', 'Bash(wc:*)', 'Bash(printf:*)', 'Bash(echo:*)',
]
