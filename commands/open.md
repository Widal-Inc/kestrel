---
description: Open the Kestrel pane on the agent sessions that run now. Where no pane can show, print them as text, without the names of tasks
allowed-tools: 'Bash(node "${CLAUDE_PLUGIN_ROOT}/cli/kestrel.mjs" top --once --no-names)'
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/cli/kestrel.mjs" top --once --no-names`

Show the output above to the person exactly as it is, in one code block. Add no summary and no comment.
