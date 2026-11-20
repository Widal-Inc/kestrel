# The outcome benchmark

This benchmark answers one question: does Widal.Code lead to better outcomes, or only to lower
numbers? It runs real Claude Code sessions on a set of tasks, checks each result with tests that
the agent never sees, and compares the same tasks with different models, efforts, and with
Widal.Code on.

It starts real sessions with your own sign-in. A full run with the commands below is 78 sessions.
The first full run, with Sonnet and Haiku three times each (`--reps 3`), was 130 sessions and $64
at list prices in about 2 hours (on a subscription that is API value: it counts against the plan's
limits).

## What it measures

**The outcome of a task**

| number | what it is |
|---|---|
| Closed | Every hidden check of the task passes, and the tests that the project had at the start still pass. |
| Quality score | The share of the task's hidden checks that pass. |
| Agent cost | What Claude Code reports for the session, at list prices. |
| Cost per closed task | The agent cost of all runs of an arm, divided by the tasks it closed. The runs that failed are paid too. |
| Time | The seconds from the start of the session to its end. |
| Value of a closed task | The minutes an engineer needs for the task by hand, times the hourly rate. An estimate. |
| Net value | The value of the closed tasks, minus the agent cost, minus the time a person needs to look at every result. |
| Work left for a person | The minutes of the tasks that stayed open. |

The hourly rate (`--rate`, $100) and the minutes to look at a result (`--review`, 5) are
assumptions. The minutes per task are estimates in `tasks.mjs`. The counts, costs and times are
measured.

**Whether Widal.Code's numbers are right**

| number | what it is |
|---|---|
| Cost match | Widal.Code's cost of each session against the cost that Claude Code reports itself. |
| Ticket match | Each run works on a branch that names a ticket. The session must count to that ticket. |

**Whether Widal.Code's directions are right**

| number | what it is |
|---|---|
| Proposals | What `widal advise` proposes from the baseline's sessions, and how many of them the tool can apply itself. |
| Expected against measured saving | The saving a proposal names, against the cost of the same tasks after `widal apply`. |
| Outcome after the change | Tasks closed before and after. A saving that closes fewer tasks is not a saving. |
| Signs against quality | Widal.Code's own signs (tool errors, rounds of fixing, repeated calls) next to the measured quality of each arm. |
| Best case per task | The cheapest arm that closes each task. It shows what a model choice per task could reach. |

**What the automation costs and whether it can be taken back**

| number | what it is |
|---|---|
| Hook time | How long each of Widal.Code's hooks ran in the sessions. |
| Undo | Whether `widal undo` puts the settings back exactly. |
| Measure | What `widal measure` says about each change after the runs. |

## The tasks

Thirteen issues for a small sample project (`project/`, a command line tool with no packages). Each
has hidden checks in `checks/` and a reference solution in `solutions/`. The test
`test/bench.test.mjs` proves for every task that it is open at the start, that the project's own
tests pass at the start, and that its reference solution closes it.

| task | kind | by hand |
|---|---|---|
| t1 | bug fix, easy | 15 min |
| t2 | bug fix, medium | 45 min |
| t3 | bug fix with many rules | 45 min |
| t4 | feature, medium | 40 min |
| t5 | feature, harder | 60 min |
| t6 | investigation: two wrong reports, cause not named | 45 min |
| t7 | refactoring | 30 min |
| t8 | documentation | 15 min |
| h1 | hard: a small query language with a long specification (29 checks) | 180 min |
| h2 | hard: ISO 8601 week numbers, a rule that the issue only names | 60 min |
| h3 | hard: a speed problem with two causes, on a file of 200,000 rows | 45 min |
| s1 | questions about the code, with three subagents that only read | 45 min |
| s2 | the same as t2, in a project whose test command prints 75,000 characters first | 45 min |

The last two have a kind of waste built in, so that `widal advise` has something to find.

A task can start from a changed project. The files in `variants/<name>/` are put over the sample
project (`variant` in `tasks.mjs`): s2 gets its long test output that way, and h3 its slow code. A
task can also replace a text in a file (`edits`): h2 does that, so that the project's test does not
forbid the feature the task adds.

## The arms

An arm is one way to run the tasks (`arms.mjs`): Fable 5.2 at effort xhigh (the baseline), Fable
5.2 at effort low, Opus 5.5, Sonnet 5.5, Haiku 5.5, and the baseline with Widal.Code on.

"Widal.Code on" means: `widal advise` reads the baseline's sessions, `widal apply` runs for every
proposal that the tool can apply itself, and Widal.Code's hooks run in the sessions.

## Run it

Give a folder outside any git repository. The steps can be stopped and started again: a run that
has a record is skipped.

```
node bench/run.mjs --out <folder>                      # the five plain arms
node bench/widal-on.mjs --out <folder>                 # advise from the baseline, apply, set up the hooks
node bench/run.mjs --out <folder> --arms widal-on      # the same tasks with Widal.Code on
node bench/widal-on.mjs --out <folder> --undo          # measure, take the changes back, check the settings
node bench/report.mjs --out <folder>                   # the results
```

Useful flags of `run.mjs`: `--arms a,b`, `--tasks t1,t2`, `--reps 3` (each task several times),
`--budget 6` (dollars per session), `--minutes 30` (time limit per session), and `--lane b` (a
second work folder, so that a second command can run other tasks of the same arm at the same
time).

A run that must not count (for example because the task was wrong when it ran) stays in the
folder with a `"void"` reason in its record. The report leaves it out of the outcomes, and still
checks its cost and ticket.

## What it does on your computer

- Each session runs in a new git repository inside the folder you give, with the sample project.
- A session gets a short list of allowed tools (`TOOLS` in `arms.mjs`): reading and editing files,
  the test command, node, and a few reading commands. There is no person to ask, so Claude Code
  refuses every other tool call. No permission is bypassed.
- A session reads none of your own Claude Code settings, plugins, MCP servers or memory. It uses
  your sign-in only.
- Widal.Code runs with a home, a tool folder and a Claude Code folder of its own inside the folder
  you give. It sees only the benchmark's sessions. Your own Widal.Code setup, your settings and
  your board are neither read nor changed.
- Claude Code writes the logs of the sessions to its own folder, as for any session.
- A session may read files outside its own folder, and the folder of the benchmark holds what
  earlier runs left. The report therefore says how many of the lines that two runs of one task
  added are the same. A high share between different arms would be a sign of copying.

## Limits

- One small project in one language. The results say little about a large codebase.
- The tasks say exactly what is wanted. In the first full run every arm closed every task, also
  the three hard ones. So this set shows what a setup costs for the same outcome, and whether a
  change breaks something. It does not yet show where a cheaper model stops being good enough.
  That needs tasks from a larger codebase, with issues that leave things open.
- Most arms run each task once. The same arm can close a task in one run and miss it in the next,
  so small differences between arms mean nothing. Use `--reps` to see the spread.
- The hidden checks test what the issue asks for. They do not judge style or design.
- The dollar value of a closed task rests on the estimates above.
