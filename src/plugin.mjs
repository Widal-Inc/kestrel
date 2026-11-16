// The hooks that the plugin carries, and the rule that keeps a hook from acting twice.
//
// The plugin carries six of this tool's hooks in hooks/hooks.json, so that they also run where
// Claude Code's settings file is not read, as in Cowork. Each one calls the tool with the hook's
// name and the word --plugin. Three are about the cache and compaction, and three start the
// security checks or ask before a push (see security.mjs).
//
// The same hooks can be in Claude Code's settings too, put there by "kestrel apply" or, for the
// three of the security checks, by "kestrel install". Claude Code
// runs both: it keeps a plugin's hook apart from the same hook in the settings. So with --plugin
// the tool first looks at the settings file. When it holds the tool's own hook for the same
// event, the plugin's hook prints nothing. The one in the settings is in charge.
//
// The person can turn each plugin hook off and on with "kestrel hooks". The choice is kept in this
// tool's config, as "pluginHooks". A hook is on until it is turned off: a person who installs the
// plugin asked for its hooks.
import { config, saveConfig } from './config.mjs'
import { hookSet } from './install.mjs'

/**
 * The plugin's hooks by name: the event Claude Code runs each one at, that event in words, and the
 * change of "kestrel apply" that puts the same hook into the settings. `undo` is the command that
 * takes the same hook out of the settings, when that is not "kestrel undo <change>".
 */
export const PLUGIN_HOOKS = {
  'compact-keep': { event: 'PreCompact', when: 'before a compaction', change: 'compact-keep' },
  'cold-start': { event: 'UserPromptSubmit', when: 'when you send a prompt', change: 'cold-start-warn' },
  'model-switch': { event: 'PreModelSwitch', when: 'before a change of model', change: 'model-switch-cost' },
  'check-settings': { event: 'SessionStart', when: 'when a session starts', undo: 'kestrel uninstall' },
  'check-turn': { event: 'Stop', when: "when an agent's turn ends", undo: 'kestrel uninstall' },
  'push-gate': { event: 'PreToolUse', when: 'before a shell command', undo: 'kestrel uninstall' },
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The choices the person made, by hook name. A config that is missing or broken holds none. */
function choices(cfg = config()) {
  return isObject(cfg) && isObject(cfg.pluginHooks) ? cfg.pluginHooks : {}
}

/** Whether the plugin's hook with this name is on: it is, unless the person turned it off. */
export const pluginHookOn = (name) => choices()[name] !== false

/** Whether Claude Code's settings hold this tool's own hook with this name, for its event. A settings file that cannot be read holds none. */
export function inSettings(name) {
  try {
    return hookSet(PLUGIN_HOOKS[name].event, name)
  } catch {
    return false
  }
}

/**
 * Whether the plugin's hook with this name is to act now: it is one of the plugin's hooks, it is
 * on, and Claude Code's settings do not hold the same hook. It never fails: a broken settings
 * file counts as one without the hook, and a broken config as one without a choice.
 */
export const pluginHookRuns = (name) => Object.hasOwn(PLUGIN_HOOKS, name) && pluginHookOn(name) && !inSettings(name)

/** Where the hook with this name runs from: "settings", "plugin", or "off" when the plugin's hook is off and the settings do not hold it. */
export const hookPlace = (name) => (inSettings(name) ? 'settings' : pluginHookOn(name) ? 'plugin' : 'off')

/** Keeps the person's choice for one plugin hook in this tool's config. The other settings stay. */
export function setPluginHook(name, on) {
  const cfg = config()
  const base = isObject(cfg) ? cfg : {}
  saveConfig({ ...base, pluginHooks: { ...choices(base), [name]: on } })
}
