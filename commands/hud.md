---
description: Change what the Kestrel status line shows, in your own words, for example "show agents", "only two lines", "hide the names" or "go back"
argument-hint: what the status line should show, in your own words
allowed-tools: 'Bash(node "${CLAUDE_PLUGIN_ROOT}/cli/kestrel.mjs" hud:*)'
disable-model-invocation: true
---

The person wants to change what the Kestrel status line shows. In their own words: $ARGUMENTS

1. Run `node "${CLAUDE_PLUGIN_ROOT}/cli/kestrel.mjs" hud` with the Bash tool. It prints the settings, a preview of the status line, what each line shows, and the commands that change it.
2. Pick the one command from that list that does what the person asked. For example:
   - "show agents": the line `work` shows them. Run `hud lines` with `work` in the list when the line is missing, or `hud names on` when the names are off.
   - "only two lines": `hud lines` with the two lines the person means, for example `hud lines session,plan`.
   - "hide the names": `hud names off`.
   - "no bars": `hud bars off`.
   - "one line" or "as before": `hud one`.
   - "go back" or "undo": `hud undo`.
3. Run that one command with the Bash tool: `node "${CLAUDE_PLUGIN_ROOT}/cli/kestrel.mjs" hud` and its words.
4. Show the preview that it prints, exactly as it is, in one code block.
5. Say that `/kestrel:hud undo` takes the change back.

When the person asked for nothing, or for something that no command does, run no second command. Show the output of step 1 in one code block, and say in one sentence what the commands can change.

Never change Claude Code's settings for this, and run no other command. Kestrel keeps these settings in its own file, and the status line shows the change at its next run.
