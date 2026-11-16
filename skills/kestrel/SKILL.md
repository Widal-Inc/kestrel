---
name: kestrel
description: Shows what the person's AI coding agents spend and where the tokens go, with the Kestrel tool. Use it when the person asks what Claude Code, Codex or Cowork cost, where their tokens or their money go, why a session was expensive, or how to spend less.
---

# What the agents spend

Kestrel reads the session logs of Claude Code, Codex and Cowork on this computer, and prints numbers: tokens, dollars at list prices, and counts. The reports send nothing anywhere. (A computer that the person linked to a Kestrel board sends its numbers to that board on its own, never the text of a session.)

**Never open, read or quote a session log.** Do not read, search or list the files in `~/.claude/projects/`, `~/.codex/sessions/` or the Cowork folder. The tool reads the logs itself and prints only numbers. Use only what it prints.

## Run the report that fits the question

Run one of these with the Bash tool:

| The person asks | Command |
|---|---|
| What did I spend, and on what? | `node "${CLAUDE_PLUGIN_ROOT}/cli/kestrel.mjs" summary` |
| Where did the money go, and what can be done? | `node "${CLAUDE_PLUGIN_ROOT}/cli/kestrel.mjs" findings` |
| Why was a session expensive? | `node "${CLAUDE_PLUGIN_ROOT}/cli/kestrel.mjs" session` (the latest session, or add the first characters of a session's id) |
| Which models and effort levels cost what? | `node "${CLAUDE_PLUGIN_ROOT}/cli/kestrel.mjs" models` |
| How often did my sessions compact? | `node "${CLAUDE_PLUGIN_ROOT}/cli/kestrel.mjs" compactions` |
| How can I spend less? | `node "${CLAUDE_PLUGIN_ROOT}/cli/kestrel.mjs" advise` |
| What did each git branch cost? | `node "${CLAUDE_PLUGIN_ROOT}/cli/kestrel.mjs" branches` |
| What did each ticket cost? | `node "${CLAUDE_PLUGIN_ROOT}/cli/kestrel.mjs" tickets` (the ticket comes from the git branch name) |
| What did each of my accounts spend, and how much of each plan is used? | `node "${CLAUDE_PLUGIN_ROOT}/cli/kestrel.mjs" accounts` |
| What are my agents doing right now? Which session waits for me? | `node "${CLAUDE_PLUGIN_ROOT}/cli/kestrel.mjs" top --once --no-names` (always with `--no-names`: the names of tasks are for the person's own screen only) |
| What is set up, and how do I pay? | `node "${CLAUDE_PLUGIN_ROOT}/cli/kestrel.mjs" status` |
| What security risks did Kestrel find? | `node "${CLAUDE_PLUGIN_ROOT}/cli/kestrel.mjs" check` (the open findings, each with where it is, its controls and its fix) |

The reports take `--days` and a number of days, for example `--days 30`.

## Pass on the numbers

- Give the numbers that answer the question: the totals, the largest items, and what the report says can be done.
- Say that the dollar figures are list prices. On a subscription they say what the same use would cost by the token, not what the person pays.
- Do not guess numbers that the report does not print.

## The lines of the status line

The status line shows up to four lines: the session, the plan's limits, the work (the task in progress, the agents that run, the other sessions) and the hints. When the person wants it to show something else, tell them to type `/kestrel:hud` with what they want in their own words, for example `/kestrel:hud hide the names`. `/kestrel:hud undo` takes the change back.

## The pane and the settings

`/kestrel:open` opens the Kestrel pane beside the chat, on the sessions that run now. `/kestrel:settings` opens it on the settings, with a checkbox for each one: the status line, the hints and the security frameworks. When the person wants to change one of those, tell them to type `/kestrel:settings`.

## Security findings and cloud checks

A finding says what kind of thing was found and where, never the secret or the data itself. Pass on the title, where it is, the controls and the fix. A control marked "(id to check)" is Kestrel's own mapping. Kestrel checks technical controls and flags risks: never say that it makes anyone compliant or certifies anything.

`kestrel cloud-check aws`, `kestrel cloud-check vercel` and `kestrel cloud-check github` read a cloud account with the person's own sign-in, and can take minutes. Run one only when the person asks for that cloud check. They only read, and they save what they find, so that `kestrel check` shows it too.

## Changes are the person's choice

Do not run `install`, `uninstall`, `apply`, `undo`, `limit`, `migrate`, `hooks` or `settings set`, unless the person asks for that change. They change Claude Code's settings or Kestrel's. Name the command that `advise` proposes, and let the person decide.
