---
name: widal
description: Shows what the person's AI coding agents spend and where the tokens go, with the Widal.Code tool. Use it when the person asks what Claude Code, Codex or Cowork cost, where their tokens or their money go, why a session was expensive, or how to spend less.
---

# What the agents spend

Widal.Code reads the session logs of Claude Code, Codex and Cowork on this computer, and prints numbers: tokens, dollars at list prices, and counts. The reports send nothing anywhere. (A computer that the person linked to a Widal.Code board sends its numbers to that board on its own, never the text of a session.)

**Never open, read or quote a session log.** Do not read, search or list the files in `~/.claude/projects/`, `~/.codex/sessions/` or the Cowork folder. The tool reads the logs itself and prints only numbers. Use only what it prints.

## Run the report that fits the question

Run one of these with the Bash tool:

| The person asks | Command |
|---|---|
| What did I spend, and on what? | `node "${CLAUDE_PLUGIN_ROOT}/cli/widal.mjs" summary` |
| Where did the money go, and what can be done? | `node "${CLAUDE_PLUGIN_ROOT}/cli/widal.mjs" findings` |
| Why was a session expensive? | `node "${CLAUDE_PLUGIN_ROOT}/cli/widal.mjs" session` (the latest session, or add the first characters of a session's id) |
| Which models and effort levels cost what? | `node "${CLAUDE_PLUGIN_ROOT}/cli/widal.mjs" models` |
| How often did my sessions compact? | `node "${CLAUDE_PLUGIN_ROOT}/cli/widal.mjs" compactions` |
| How can I spend less? | `node "${CLAUDE_PLUGIN_ROOT}/cli/widal.mjs" advise` |
| What did each git branch cost? | `node "${CLAUDE_PLUGIN_ROOT}/cli/widal.mjs" branches` |
| What did each ticket cost? | `node "${CLAUDE_PLUGIN_ROOT}/cli/widal.mjs" tickets` (the ticket comes from the git branch name) |
| What did each of my accounts spend, and how much of each plan is used? | `node "${CLAUDE_PLUGIN_ROOT}/cli/widal.mjs" accounts` |
| What are my agents doing right now? Which session waits for me? | `node "${CLAUDE_PLUGIN_ROOT}/cli/widal.mjs" top --once --no-names` (always with `--no-names`: the names of tasks are for the person's own screen only) |
| What is set up, and how do I pay? | `node "${CLAUDE_PLUGIN_ROOT}/cli/widal.mjs" doctor` |
| What security risks did Widal.Code find? | `node "${CLAUDE_PLUGIN_ROOT}/cli/widal.mjs" check` (the open findings, each with where it is, its controls and its fix) |

The reports take `--days` and a number of days, for example `--days 30`.

## A prompt that is only a Widal.Code command

When the person's whole prompt is `widal` and a command, such as `widal findings`, `widal session` or `widal summary --days 30`, run exactly that command with the Bash tool, with the tool in the plugin's folder as in the table above. Then show its output to the person exactly as it is, in one code block. Add no summary and no comment. This holds for the reports. For a command that changes something, follow "Changes are the person's choice" below.

## Pass on the numbers

- Give the numbers that answer the question: the totals, the largest items, and what the report says can be done.
- Say what the dollars are, as the report says. For an account that pays by the token they are spend. On a subscription they are API value: what the same use would cost by the token, not what the person pays. The block "Plans" sets the API value next to the plan's price.
- Do not guess numbers that the report does not print.

## The lines of the status line

The status line shows up to four lines: the session, the plan's limits, the work (the task in progress, the agents that run, the other sessions) and the hints. When the person wants it to show something else, tell them to type `/widal:hud` with what they want in their own words, for example `/widal:hud hide the names`. `/widal:hud undo` takes the change back.

## The pane and the settings

`/widal:open` opens the Widal.Code pane beside the chat, on the sessions that run now. `/widal:settings` opens it on the settings, with a checkbox for each one: the status line, the hints and the security frameworks. When the person wants to change one of those, tell them to type `/widal:settings`.

## Security findings and cloud checks

A finding says what kind of thing was found and where, never the secret or the data itself. Pass on the title, where it is, the controls and the fix. A control marked "(id to check)" is Widal.Code's own mapping. Widal.Code checks technical controls and flags risks: never say that it makes anyone compliant or certifies anything.

`widal cloud-check aws`, `widal cloud-check vercel` and `widal cloud-check github` read a cloud account with the person's own sign-in, and can take minutes. Run one only when the person asks for that cloud check. They only read, and they save what they find, so that `widal check` shows it too.

## Changes are the person's choice

Do not run `connect`, `disconnect`, `apply`, `undo`, `limit`, `migrate`, `hooks` or `settings set`, unless the person asks for that change. They change Claude Code's settings, git's global config (`connect` and `disconnect`) or Widal.Code's. Name the command that `advise` proposes, and let the person decide.
