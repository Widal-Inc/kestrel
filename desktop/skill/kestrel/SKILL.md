---
name: kestrel
description: Use for questions like "what did my agents spend?", tokens, usage, limits, the cost of Claude Code, Cowork or Codex, and "how do I use less of my plan?"
---

# Kestrel: what your agents spend, and how to use less of your plan

Kestrel is a desktop extension for the Claude desktop app. It reads the logs that Claude Code, Codex and Cowork keep on the person's computer, and answers with numbers only. This skill says how to answer questions about spend, usage and limits: with Kestrel's tools when they are there, and with tips when they are not.

## First: are Kestrel's tools there?

Kestrel's tools are named `what_kestrel_sees`, `spend_summary`, `plan_limits`, `spend_advice`, `compactions`, `spend_by_model`, `whats_running`, `spend_by_ticket`, `spend_by_account` and `security_check`.

- If they are there, follow "With Kestrel's tools".
- If they are not (on claude.ai, on the phone, or before the extension is installed), follow "Without Kestrel's tools".

## Never

- Never ask the person to paste a log, a session file or a transcript.
- Never open, read or search a log file yourself, also when a file tool could reach it. Kestrel reads the logs and returns numbers only. That is how the text of a session stays private.
- Never say that Kestrel changed or can change a setting. In the desktop app it only reads.
- Never say that Kestrel makes anyone compliant or certifies anything. It checks technical controls and flags risks.

## With Kestrel's tools

### Which tool answers which question

| The person asks | Tool |
|---|---|
| What is there? Why is an answer empty? Does Kestrel see my Cowork sessions? | `what_kestrel_sees` |
| What did my agents spend this week? Which project costs the most? | `spend_summary` (argument `days`, 1 to 90, default 7) |
| How much of my plan is used? Am I on a subscription? When does my limit reset? | `plan_limits` |
| Where can I save? How do I use less of my plan? | `spend_advice` (`days`, default 30) |
| Which model or effort level costs the most? What kind of work costs the most? | `spend_by_model` (`days`, default 30) |
| How often were my sessions compacted? How long do my sessions get? | `compactions` (`days`, default 30) |
| What are my agents doing right now? Which session waits for me? What should I do next? | `whats_running` |
| What did each ticket cost? Which ticket used the most tokens this week? | `spend_by_ticket` (`days`, default 7) |
| Which of my accounts used the most? How much of the plan does each account have left? | `spend_by_account` (`days`, default 7) |
| What security risks did Kestrel find? Is my setup a risk for HIPAA or SOC 2? | `security_check` |

- When unsure what there is, call `what_kestrel_sees` first.
- A question about the last month: set `days` to 30. A question about "today": set `days` to 1.
- A question such as "what did my agents spend, and where can I save?" takes two calls: `spend_summary`, then `spend_advice`.
- `whats_running` ends with a line "Next:" when one session needs the person soon. Give that step first.
- `spend_by_ticket` takes the ticket from the git branch name, for example the branch user/abc-322-login gives ABC-322. When it finds no ticket, say that.
- `spend_by_account` gives one row per account: a work and a personal Claude account, Cowork, Codex. Each account has limits of its own. Name an account by the name the tool gives, never by an email address.
- `security_check` lists the open findings of Kestrel's checks, the most severe first, each with where it is, the controls of the frameworks that are on and the fix. Give the high ones first. A control marked "(id to check)" is Kestrel's mapping, not yet checked against the framework's own text: say so. A fix with a `kestrel apply` command is made in a terminal, by the person. Cloud findings are as new as the last `kestrel cloud-check`, which the person runs in a terminal. End with the tool's sentence that Kestrel certifies nothing.

### How to give the answer

- Give the numbers plainly and rounded, with the period they cover. For example: "In the last 7 days your agents used about [total] at list prices: [amount] in Claude Code and [amount] in Cowork." Fill in the numbers that the tool gave.
- Use the tool's words for the dollars. When the person pays by the token they are spend. On a subscription (Pro, Max or Ultra, a Team seat, a ChatGPT plan) they are API value: what the same use would cost when every token is paid for. The person does not pay that, and the block "Plans" sets it next to the plan's price. There the plan's percent is what counts. `plan_limits` gives the percent when Kestrel knows it, and the Claude app shows it under Settings, Usage.
- Name the largest one or two parts (a project, a model), not every row.
- If the person asked how to save, end with the one or two proposals from `spend_advice` that save the most, each with its reason and its expected saving. Keep the words of the risk.
- A proposal can name a command such as `kestrel apply effort-default`. Say that the person runs it in a terminal, if they want the change. Kestrel in the desktop app never changes a setting.
- Do not add numbers that the tools did not give.

### When a tool says something else

- **"Still reading the session logs ... for the first time":** the first read of many logs takes a while. Tell the person, and say that asking again in a minute will work.
- **"Kestrel found no logs ...":** the person only chats, or runs the agents on another computer. Say that Claude does not keep chat usage on the computer, that the plan's percent is in the Claude app under Settings, Usage, and that the numbers start once they use Cowork, Claude Code or Codex on this computer. Then offer the tips below.
- **"No model calls in the last 7 days":** ask whether to look further back, up to 90 days.
- **An error:** say in one sentence that Kestrel could not answer, and give the tips below if they help.

### What Kestrel cannot see

- Chat on claude.ai, in the Claude app and on the phone, and ChatGPT.
- Sessions that ran in the cloud and not on this computer.
- Other computers.

So Kestrel's dollars cover the agents on this computer only. The plan's percent counts everything, because chat, Cowork and Claude Code share one plan.

## Without Kestrel's tools

Say in one sentence: "The numbers need the Kestrel extension in the Claude desktop app, on the computer where your agents run."

Then give the tips that fit the question. Pick a few, not all. Do not add numbers to them.

### Tips for chat

- **Start a new chat for each new topic.** Every new message is answered together with the whole conversation so far. So a message late in a long chat uses more of the plan than the same message in a new chat.
- **Files and long pastes count every time.** A file or a long paste becomes part of the conversation, so it counts again with every later message. Paste only the part that matters.
- **Put shared files in a project.** A project holds files that you use again and again. Content in a project is cached and counts less against the limits when it is used again.
- **Use a smaller model for simple questions,** and a lower effort level. Turn thinking off for simple questions, on models that have the switch. Higher effort uses more.
- **Ask related questions in one message,** and say when a quick answer is enough.
- **Turn off tools and connectors you do not need.** They use many tokens.
- **Chat, Cowork and Claude Code share one plan.** What one uses, the others cannot use.
- **Settings, Usage shows the percent** of the 5 hour limit and of the weekly limit.

### Tips for Cowork and Claude Code

- **Compact at a break, and say what to keep.** In Claude Code, `/compact` replaces the long conversation with a summary. Add your own words after it, for example: `/compact keep the plan, the open steps, the files that changed and what not to do`. Do it at a break between tasks, not in the middle of one.
- **A new session or `/clear` for a new task.** The old context is then not sent with every message.
- **After a long break, the cache is gone.** The next message then counts the whole context in full. Before a long break, compact or finish the task.
- **Sonnet for routine work, Haiku for quick and simple tasks.** A stronger model uses more of the plan.
- **Point to a file instead of pasting it.** Pasted text stays in the context for the whole session.
- **Keep CLAUDE.md short.** It is sent with every turn.
- **In Cowork, group related work into one task,** and start a new task for unrelated work.

## Where the tips come from

- Anthropic's help pages: "How do usage and length limits work?", "Usage limit best practices", "Models, usage, and limits in Claude Code" and "Get started with Claude Cowork".
- Kestrel's guide (the README of the Kestrel repository): an agent sends its whole context on every call, chat, Cowork and Claude Code draw from one pool, and what a summary has to keep.
