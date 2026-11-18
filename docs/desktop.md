# Widal.Code in the Claude desktop app

Widal.Code shows what your AI agents spend: Claude Code, Codex and Cowork. It reads the logs that these agents keep on your computer, and answers your questions about them in a chat in the Claude desktop app. It only reads: it sends nothing anywhere, and it changes nothing.

You do not need a terminal, Node or Claude Code for this. You need the Claude desktop app and one file.

## Install

1. Download [`kestrel.mcpb`](https://github.com/Widal-Inc/kestrel/releases/latest/download/kestrel.mcpb) from the newest release on GitHub.
2. Open the Claude desktop app, and open **Settings**, then **Extensions**. (In newer versions of the app: **Settings**, then **Desktop app**, then **Manage** next to Extensions.)
3. Drag `kestrel.mcpb` onto that page, and choose **Install**.

That is all. The app runs Widal.Code with the copy of Node that it brings along.

- If dragging does nothing: on the Extensions page, open **Advanced settings**, choose **Install Extension**, and pick the file.
- **If the Extensions page is missing,** your organisation has turned extensions off. Ask the person who runs Claude for your organisation.
- **On Windows the app does not install Widal.Code yet.** Some parts of Widal.Code expect the folder names of macOS and Linux, and nobody has checked it on Windows. So the extension says that it is for macOS and Linux.

## What to ask

Open a new chat and ask, for example:

- "What did my agents spend this week, and where can I save?"
- "How much of my plan have I used, and when does it reset?"
- "Which project cost the most in the last 30 days?"
- "Which model and effort level cost me the most this month?"
- "Which of my agent sessions run now, which wait for me, and what should I do next?"
- "What did each ticket cost this week?"
- "Which of my accounts used the most this week, and how much of each plan is used?"
- "What does Widal.Code see on this computer?"
- "Which security risks did Widal.Code find, and which touch HIPAA?"

The answer about the sessions that run now is the view of `widal top` (see the README, "All agents at once"), without the names of tasks. The ticket comes from the name of the git branch: the branch `user/abc-322-login` gives ABC-322.

The answer about your accounts is the table of `widal accounts` (see the README, "More than one account"): one row for each Claude account, each Cowork account and Codex, with the tokens and the cost, and the plan's limits of each account. An account shows with the name you gave it, else with the name of its organisation. Widal.Code never shows an email address or a person's name.

The answer about security risks is the list of open findings of Widal.Code's security checks (see the README, "Cloud checks"): for each its kind, title, where it is, the controls of the frameworks that are on, and the fix. A fix with a `widal apply` command is made in a terminal, by you. The cloud findings are as new as the last `widal cloud-check` that you ran in a terminal: the desktop app does not run cloud checks. Widal.Code checks technical controls and flags risks. It does not make anyone compliant, and it certifies nothing.

The app may ask you once to allow Widal.Code's tools. Widal.Code's tools only read, so allowing them is safe.

**The first answer can take a while.** The first time, Widal.Code reads the logs of the last 90 days. With thousands of logs that takes minutes. If Claude says that Widal.Code is still reading, ask again in a minute. Later answers are quick, because Widal.Code keeps what it read.

**Dollars are list prices.** When you pay by the token they are your spend. On a subscription (Pro, Max or Ultra, a Team seat, a ChatGPT plan) they are API value: what the same use would cost when every token is paid for. You do not pay that, and the answers set it next to your plan's price. There the plan's percent is what counts. The Claude app shows it under **Settings**, **Usage**.

## What Widal.Code sees, and what it never sees or does

Widal.Code sees the logs of the last 90 days of:

- Claude Code,
- Codex,
- Cowork sessions that ran on this computer.

From them it takes numbers only: the tokens of each call, the model, the name of the project folder, the ticket in the name of the git branch, the account, and the time.

It never sees:

- **Chat** on claude.ai, in the Claude app and on the phone, and ChatGPT. Claude does not keep chat usage on your computer.
- **Sessions in the cloud,** such as Cowork sessions that ran in Anthropic's cloud.
- **Other computers.** Widal.Code reads only the logs on the computer where it is installed.

It never does any of these:

- **Change a setting.** Some answers propose a change and name a command for it, such as `widal apply effort-default`. That command is run in a terminal, by you, if you want the change. Widal.Code in the app runs no command.
- **Show the text of a session.** No prompt, no answer, no command, no file name and no name of a task ever comes back from Widal.Code's reports of spend. Claude gets numbers, model names, project folder names, ticket names and dates. The security findings name where a risk is, such as a file and line, a cloud resource or a repository, and never what was found there.
- **Send anything anywhere on its own.** Widal.Code in the app uses no network. The one exception is a computer that you linked to your team's Widal.Code board with `widal board login` in a terminal: Widal.Code then sends its numbers to that board, never the text of a session. See "The Widal.Code board" in the README.

Widal.Code keeps the numbers it read in a folder named `.widal` in your home folder, so that later answers are quick.

If you only chat and do not use Cowork, Claude Code or Codex, Widal.Code finds no logs and says so. The numbers start once you use one of those agents on this computer.

## The skill, for the web and the phone

The skill teaches Claude how to answer questions about spend, usage and limits.

- **With the extension,** it makes the answers better: Claude picks the right tool, gives the numbers plainly, and ends with the proposals that save the most.
- **Without the extension,** for example on claude.ai or on the phone, Claude says that the numbers need the extension in the desktop app. Then it gives tips to use less of your plan, taken from Anthropic's help pages and from Widal.Code's guide.

To add it:

1. Get the file `kestrel-skill.zip`. Do not unpack it.
2. In Claude, open **Customize**, then **Skills**.
3. Choose **+**, then **Create skill**, then **Upload a skill**, and pick the file.
4. Turn the skill on in the list.

Skills need code execution. If the upload is not offered, turn on code execution and file creation under **Settings**, **Capabilities**. On a Team or Enterprise plan, an owner may have to allow skills first.

## For the developer: how the two files are built

```
npm run build:desktop
```

This runs `scripts/build-desktop.mjs`, which uses the system's `zip`. It makes two files in `dist/`, or in the folder given as its first argument:

- `kestrel.mcpb`, the desktop extension. A zip with `manifest.json` (from `desktop/manifest.json`), `icon.png` (from `assets/widal-code-512.png`), `package.json`, `cli/` and `src/` at its top. Nothing else goes in.
- `kestrel-skill.zip`, the skill. A zip with the folder `widal-code/` at its top and `SKILL.md` in it (from `desktop/skill/widal-code/`), as the skill upload asks.

The script stops when the version in `desktop/manifest.json` is not the version in `package.json`, or when the tools in the manifest are not those of the server, with the same names and descriptions.

**The server** is `widal desktop-mcp` (`src/mcp.mjs`), a Model Context Protocol server over standard input and output, written without dependencies. The extension starts it as `node ${__dirname}/cli/widal.mjs desktop-mcp`.

- It speaks the protocol with the handshake (`initialize`, versions 2025-11-25 back to 2024-11-05), and the newest version without one (2026-07-28, with `server/discover` and the version in each request's `_meta`). It is not known yet which one the app uses.
- Its ten tools only read: `what_widal_code_sees`, `spend_summary`, `plan_limits`, `spend_advice`, `compactions`, `spend_by_model`, `whats_running`, `spend_by_ticket`, `spend_by_account` and `security_check`. Each answers with the text of one of Widal.Code's reports. `security_check` gives the open findings from Widal.Code's small file of findings, `~/.widal/findings.json`, and reads no log: it answers also on a computer without agent logs. A finding never holds what was found. `spend_by_account` gives the text of `widal accounts`, and reads the name of the account signed in now from Claude Code's file `.claude.json`, as that command does. `whats_running` gives the view of `widal top --once` without the TASK column, whatever the setting `hud.names` says. When today's numbers are missing or older than 5 minutes, it works them out first, within the same wait as the other tools.
- It starts reading the logs of the last 90 days right after the handshake. A tool call waits for that read for at most 40 seconds, then says how far the read is. The read goes on, and its result is kept in Widal.Code's cache, as for the command. A read that ended less than a minute ago is used again.
- `WIDAL_MCP_WAIT_MS` makes that wait shorter. Only the tests set it.
- Standard output carries protocol messages only.

The tests are in `test/mcp.test.mjs`. They start the server as a child process with made-up logs and made-up home folders, and they build both files into a temp folder and look inside.

**Node.** Anthropic's help page says that the desktop app brings its own Node, and the extension format's README says that Node ships with Claude for macOS and Windows. Neither names the version. Widal.Code needs Node 22, so the manifest asks for `>=22.0.0`. A first install in the real app will show whether the app's Node is new enough.

## What is not checked yet

- The extension has not run in the real desktop app.
- Which version of the protocol the app uses, and which Node it brings.
- Whether the phone app uses skills that were uploaded on the web. Anthropic's help page on skills does not say.
- Windows: see "Install".
