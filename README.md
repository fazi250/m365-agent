# M365 Agent

A local web app that turns the **Microsoft 365 Copilot desktop app** into a chat and agent engine for your PC.

- **Your Copilot chats, synced.** The chats in Copilot's sidebar show up in the web app. Open one to read it and keep talking in it.
- **Agent mode, like GitHub Copilot's.** Ask a question and Copilot just answers; ask it to do something and it works through the tools step by step on your PC: drive a browser, write Word / PowerPoint files, run Python, install the Python packages it needs into the framework, read files, run PowerShell, look things up on GitHub, or any tool you add. Chat and tasks mix freely in one conversation. **Chat** mode sends messages as they are.
- **Repos, with Keep / Undo.** Ask it to create a repo from scratch or change an existing one under your `projects` folder (e.g. `C:/devl`). It writes whole files, like GitHub Copilot's agent, without asking; every changed file shows up under **Files changed** with its diff and **Keep** / **Undo**.
- **Files anywhere on your PC, like GitHub Copilot.** It can read and write files anywhere with absolute paths. Inside your trusted folders (the workspace, `projects`, and `readRoots` for reading) it goes ahead on its own; anywhere else it asks you first, and sensitive files (`.env`, SSH keys, credentials, browser password stores ...) always ask, with a red warning on the card.
- **One workspace folder.** Everything else the agent makes (reports, decks, screenshots, scripts) goes into `workspace/`.
- **Behind the scenes.** The Copilot app stays minimized in the taskbar and never pops up. You only use `http://127.0.0.1:4317`.

No API keys and no GPU: it reuses the Copilot app you are already signed in to.

> This is an unofficial tool, not affiliated with Microsoft. It drives the Copilot app's window through Windows UI Automation. Check that your organization's policies allow automating Microsoft 365 Copilot before you use it at work.

## How it works

```
 your browser ──► server.ts (127.0.0.1:4317) ──► bridge.ps1 ──► Microsoft 365 Copilot app (minimized)
                     │   ▲                          types the message, reads the reply
                     ▼   │
                 tools/*.ts  (run on your PC, results go back to Copilot)
                     ├─ browser       its own Microsoft Edge window (playwright-core)
                     └─ make_docx / make_pptx   Python in .venv (python-docx, python-pptx)
```

- `bridge.ps1` uses Windows UI Automation to list chats, open a chat, read its messages, send a message and delete chats. To type, it activates the minimized Copilot window for well under a second (keyboard input only reaches the active window) and then gives focus straight back to your window. Windows only lets a background program activate a window right after an Alt key press, so the bridge sends one (Alt down, activate, Alt up). It sends a key only after checking that Windows' keyboard focus is inside Copilot's page and on the right control: a key that reaches the bare minimized window would restore it (Enter does), and Copilot's own title-bar buttons (Maximize, Close) are page buttons too. If Copilot still brings its window up, it is minimized again at once. Reading needs no focus. If the app is not running, it starts it and minimizes it.
- When tools are ticked, the first message tells Copilot which tools exist and asks it to answer with one JSON tool call per turn, for example `{"tool": "browser", "args": {"action": "click", "target": "e12", "evidence": true}}`. `server.ts` runs the tool, pastes the result back to Copilot, and repeats until Copilot answers with `done`. Copilot can also call `ask_user` to stop and ask you something (sign in first, pick one, a detail it doesn't have); the task waits for your answer. The first `done` of a task that used tools is sent back once with "verify every part of the request first", so Copilot checks its work (reads the page, the screen, the files it made) before it finishes, and its final `done` lists what it checked.

## Requirements

- Windows 10 or 11
- **Microsoft 365 Copilot** app (from the Microsoft Store), signed in. Use your **work account** if your organization's Copilot licence is the one you want: personal accounts have a daily usage limit.
- **Node.js 23.6 or newer** (Node 24 LTS recommended). It runs the TypeScript files directly. Check with `node -v`.
- **Microsoft Edge** (or Google Chrome, see `browser` below) for the `browser` tool; the installed browser is used, nothing is downloaded.
- **Python 3.10 or newer** for the document tools (`uv` is used when installed, otherwise `python -m venv`).
- Optional: **GitHub CLI** for the `github` tool:
  ```
  winget install --id GitHub.cli
  gh auth login
  ```

## Install and run

```
git clone <this repo> m365-agent
cd m365-agent
npm run setup
```

`npm run setup` (or `powershell -ExecutionPolicy Bypass -File setup.ps1`) installs `playwright-core`, creates the Python venv in `.venv` with `python-docx`, `python-pptx` and `pillow` from `requirements.txt`, and creates `config.json` from `config.example.json`. Check `config.json` (see [Configuration](#configuration)), then start it:

On a company PC where PyPI is blocked and Python packages come from your organization's index (Artifactory, Nexus ...), give its URL once; it is saved as `pythonIndexUrl` in `config.json` and used by the setup and by `install_package` from then on:

```
npm run setup -- --index-url https://artifactory.example.com/api/pypi/pypi/simple
```

`npm start -- --index-url <url>`, `npm start --index-url=<url>` and `start.cmd --index-url <url>` work too. A URL with a user name and token in it is shown with the token hidden; `config.json` stays out of git.

```
npm start
```

or double-click `start.cmd`, which also opens the page. Open <http://127.0.0.1:4317>.

## Using it

- **Sidebar.** Your Copilot chats, newest first. **Sync** re-reads them; they also refresh every minute and after you send a message. Click a chat to open it in Copilot and see its messages here.
- **Closing Copilot.** The minute-by-minute sync never starts the Copilot app: close it and it stays closed. It opens again, minimized, when you send a message, open a chat or press **Sync** (and when the server starts). To stop everything, close the `start.cmd` window (or Ctrl+C in it).
- **New chat.** Starts a fresh Copilot chat with your next message.
- **Agent / Chat.** Agent (the default) gives Copilot the ticked tools: it answers questions directly and uses tools when you ask it to do something, in the same chat. Chat sends your message to Copilot as it is.
- **Tools row.** All tools are ticked the first time; untick what you don't want Copilot to use. Each tool shows whether it runs on its own or asks first.
- **Allow once / Always allow / Deny.** A step that could change something outside the workspace or run code (a PowerShell command, Python, installing a package, writing a script, opening a new site, a GitHub change), or that reads or writes a file outside your trusted folders, waits for you. Read what Copilot wants to run first.
  - **Allow once** runs it this time.
  - **Always allow** runs it and remembers that exact thing, so it won't ask again: the same PowerShell command, the same script text, the same package, pages on the same site, the same `gh` command, reading (or writing) files in that one folder, or just that one file when it is sensitive. It never allows a whole tool. The card says what will be remembered.
  - **Deny** skips it and tells Copilot you declined.
- **Files changed** (above the message box) lists every file the agent created or replaced since you last kept or undid it, with `+added −removed` lines. **Diff** shows the change; **Keep** accepts it; **Undo** puts the original back (or removes a file the agent created). **Keep all** / **Undo all** do every file. The list survives a server restart (it lives in `workspace/.changes`). While files are waiting here, `shell` and `run_python` ask even for commands you allowed before, since they could run that unreviewed code.
- **Allowed always** (bottom of the sidebar) lists what you allowed for good. **Remove** one and it asks again next time. The list is saved in `approvals.json` next to `config.json`.
- **Copilot is asking you** (an amber card; the tab title shows ❓): Copilot needs you, for example to sign in to a site in the agent's Edge window. Do it, then press **Continue** (or type an answer and press Enter); the task goes on from there. The browser tool spots sign-in pages by themselves (address, title or a password box) and tells Copilot to ask you; it never types into a password box.
- **Done** shows Copilot's answer and **What Copilot checked**: one line per part of your request, saying how it knows that part is done (or that it isn't).
- **Stop** ends the current task right away: a command that is still running (PowerShell, Python, an install) is ended together with every program it started, and its step reports "stopped by the user".
- **Delete one chat:** the 🗑 next to a chat in the sidebar (shown on hover and for the open chat), or **Delete chat** at the top of an open chat. It asks first; the chat is deleted in Copilot itself and cannot be recovered.
- **Delete all chats** (bottom of the sidebar) deletes every chat in Microsoft 365 Copilot itself, one by one, through each chat's *More > Delete* menu. You have to type `DELETE` to start it, it cannot be undone, and **Stop** halts it after the chat in progress. To check the menu path without deleting anything: `powershell -STA -File bridge.ps1 delete -Id <chat id> -DryRun`.

While a message is being sent, the Copilot window is active for a moment. Don't type during that moment, or a few keystrokes can land in Copilot.

Example: a repo from scratch, then a change to it (tick everything, Agent mode):

> Create a new Playwright TypeScript repo from scratch at C:/devl/pw-demo: package.json, playwright.config.ts that uses the installed Chrome (channel: 'chrome'), tests/example.spec.ts that checks example.com's title, and a README.md. Then install the dependencies and run the tests.

> In the existing repo C:/devl/pw-demo: rewrite README.md properly and add tests/practice.spec.ts that ticks Option1 on https://rahulshettyacademy.com/AutomationPractice/ and asserts it. Then run the tests.

Copilot lists the repo, reads the files it changes, writes whole files, asks before `npm install` / `npm test`, and the files land under **Files changed** for you to Keep or Undo.

Example: a missing package. Ask "Create sales.xlsx with columns Product and Qty and three sample rows"; Copilot writes a `run_python` script, sees `ModuleNotFoundError: openpyxl`, asks to `install_package openpyxl` (you allow it), runs the script again and `workspace/sales.xlsx` is there. `openpyxl` is now in `.venv` and in `requirements.txt`.

Example: manual testing of a desktop app with evidence:

> Manual testing of POST http://127.0.0.1:8000/createOrder in Postman with the payload {"product": "pen", "qty": 2}: open Postman maximized, put a cURL for it on my clipboard and ask me to paste it into a new tab's URL box, snap with the URL and method highlighted, then the Body tab with the payload highlighted, then ask me to click Send and snap with the status highlighted. Then create manual-test-report.docx with a heading per step, what was done, and its snap.

Opening Postman asks first. Copilot puts the cURL (or a payload) on your clipboard with `screen clipboard`; pasting a cURL into Postman's URL box fills the method, URL, headers and body. Each hand step then shows up as a card with your step in red ("YOU do this step yourself"); do it in Postman, come back, press **Allow once**, and the snap (`screenshots/step-NN.png`, full screen with the taskbar) is taken with **red boxes** around the texts Copilot asked to highlight: the request name, the URL, the payload lines, the status. The boxes are found by reading the snap with Windows' own OCR, and the result tells Copilot exactly what was boxed (and what wasn't found), so the report captions stay true. The report is built from the snaps at the end.

Example task with the browser:

> Open https://rahulshettyacademy.com/AutomationPractice/ and tick the Option1 checkbox, capturing click evidence. Then create report.docx with a heading per step, a short description, and the evidence screenshot.

Edge opens in its own window, `workspace/screenshots/step-01.png` is a full-screen snap (Edge in front, taskbar included) with a red box around the ticked checkbox, and `workspace/report.docx` holds the steps and the screenshot.

Copilot is told to do as much as it can itself: when no tool does a step directly, it proposes a PowerShell command (`shell`) or a Python script (`run_python`) for it, installing what it needs, and you approve each one. It asks you (`ask_user`) only for what needs you: signing in, passwords and codes, a decision, details it doesn't have.

## Tools

| Tool | What it does | Approval |
|---|---|---|
| `browser` | The installed Microsoft Edge in its own window, with its own profile (`.browser-profile-msedge`): sign in to a site there once and it stays signed in. Your everyday Edge profile and its logins are not used. `open` (`new_tab: true` keeps the current page in its tab), `tabs` (list, or `index` to switch), `elements` (numbered list of the page's controls; Copilot picks one by id), `click` / `type` / `select` (with `evidence: true`: a snap right after the action, `"before"` for one before it), `screenshot` (`target`, `highlight` texts), `read`, `back`, `close`. Evidence and screenshots are full-screen snaps like a tester's: the Edge window brought to the front and maximized, the taskbar included, a red box around the control (a checkbox together with its label) and around each highlight text; `page_only: true` gives just the page. If you close the window, the next step opens a new one and tells Copilot its pages are gone. The browser's sandbox stays on. Results say a control's state right after an action (now checked, the value now in a box) and flag sign-in pages, so Copilot can check each step; it never types into password boxes | opening a new site asks first; clicks and typing run on their own |
| `screen` | Desktop apps for manual testing: `windows` lists the open windows; `open {app, maximize}` starts an installed app by its Start-menu name (Postman, Calculator, Excel ...); `snap {window, maximize, ask, highlight}` brings that app to the front and saves a full-screen PNG at the screen's resolution, taskbar included, with a red box around each `highlight` text (a text, several lines such as a JSON payload as one box, or `{text, pick}` for one of several places); `read {window}` returns the text Windows' OCR reads in that window, with positions; `clipboard` puts a text (a payload, a cURL) on your clipboard. It never clicks or types in apps: with `ask` the card shows the step for you ("Paste the payload into Body > raw"), you do it and press **Allow once**, and the snap is taken | `open` and `read` ask first (Always allow is per app); snaps and clipboard run on their own, with `ask` they wait for you |
| `make_docx` | Word document from headings, paragraphs, bullets, images (screenshots), tables | runs on its own, writes only in the workspace |
| `make_pptx` | 16:9 PowerPoint deck: title slide, slides with bullets and/or an image, speaker notes | runs on its own, writes only in the workspace |
| `write_file` | Creates or replaces a whole text file anywhere on the PC (the content comes in a code block after the JSON call) | runs on its own in the workspace and `projects`; elsewhere, and for sensitive files, asks first; you Keep or Undo each change |
| `run_python` | Runs Python in the framework's `.venv` with the workspace as current folder (code is saved as `scripts/<name>.py`) | always asks; Always allow covers that exact script text |
| `install_package` | Installs what a task needs: `pip` (default) PyPI packages into `.venv`, added to `requirements.txt` so they stay part of the framework; `npm` packages and their commands (newman ...) into `workspace/package.json`; `winget` Windows programs and command-line tools by exact id (`{"manager": "winget", "search": "jq"}` finds the id). `shell` can use what was installed right away | always asks (a winget search doesn't); Always allow is per package |
| `read_file` | Reads a text file anywhere on the PC; long files come in parts (`start_line`). `.docx`, `.pptx` and `.xlsx` come as their text (headings, `[image]` markers, captions, tables, slides, sheets), so Copilot can check a report it made | runs on its own in the workspace, `projects` and `readRoots`; elsewhere, and for sensitive files, asks first |
| `list_dir` | Lists a folder anywhere on the PC; `recursive: true` gives a repo's tree (skips node_modules, .git, build output) | runs on its own in the workspace, `projects` and `readRoots`; elsewhere asks first |
| `github` | Runs `gh` with the given arguments: view repos, search, read files through `gh api`. `gh auth login` is not run: signing in is yours, in your own terminal (`auth status` checks it) | lookups run on their own; anything that changes GitHub asks first |
| `shell` | Runs a PowerShell command (npm, npx, git ...) in the workspace or in a repo folder (`cwd`). Commands from `install_package` work here: `workspace/node_modules/.bin` and the venv come first on its PATH, and the PATH is read again from Windows before each command. Nobody can type into it, so sign-ins and prompts (`gh auth login`, `npm login`, `az login`, `Read-Host` ...) are not run: Copilot asks you to run them in your own terminal | always asks |

Handy `github` calls Copilot can make:

```
["repo", "view", "OWNER/REPO"]
["search", "repos", "playwright mcp", "--limit", "5"]
["api", "repos/OWNER/REPO/git/trees/HEAD?recursive=1", "--jq", ".tree[].path"]     file list
["api", "repos/OWNER/REPO/contents/PATH", "-H", "Accept: application/vnd.github.raw"]   a file's text
```

### Adding a tool

1. Copy `tools/_template.ts` to `tools/<name>.ts` (files starting with `_` are not loaded).
2. Fill in `name`, `description` and an example `args` object. Copilot only sees these, so describe the tool clearly.
3. Write `run(args, ctx)`. It returns the text Copilot should see. Helpers in `_lib.ts`: `runProcess(cmd, argsArray, { cwd, input })` calls a program without a shell in between; `inWorkspace(path, ctx)` resolves a path inside the workspace and refuses anything outside it. `ctx.python` is the venv's Python, for tools written in Python (see `tools/py/`); add their packages to `requirements.txt`.
4. Set `needsApproval(args)`. Return `true` for anything that changes something outside the workspace.
5. Optional: `alwaysRule(args)` returns `{ key, label }`, what **Always allow** remembers for a call. Calls with the same key run without asking. Keep it narrow; by default it is the exact args. `warning(args)` can return a line shown in red on the approval card. For file paths, `_lib.ts` has `fullPath`, `trustedForRead` / `trustedForWrite`, `isSensitive`, `pathRule` and `pathWarning`.
6. Restart the server. The new tool appears in the tools row.

## Configuration

`config.json` (all keys optional):

| Key | Default | Meaning |
|---|---|---|
| `port` | `4317` | Port of the web app (always bound to 127.0.0.1) |
| `workspace` | `workspace` | Folder for what the agent makes for you (reports, screenshots, scripts), relative to `config.json`; default working folder for `shell` and `gh` |
| `projects` | `[]` | Trusted folders holding your repos (e.g. `["C:/devl"]`): the agent reads, creates and changes files in them without asking, with Keep / Undo, and runs commands there |
| `readRoots` | `[]` | Extra folders `read_file` and `list_dir` read without asking (the workspace and `projects` always are). Other folders can still be read, after you allow it |
| `browser` | `msedge` | `msedge` (Microsoft Edge) or `chrome` (Google Chrome, profile in `.browser-profile`); there is no switch to the other one if it is missing |
| `maxSteps` | `40` | Tool steps per task before it stops |
| `maxResult` | `8000` | Characters of tool output sent back to Copilot |
| `pythonIndexUrl` | `""` | Your organization's Python package index (Artifactory or Nexus PyPI mirror) for the setup and `install_package`; empty = PyPI (or pip's own settings). Set it with `--index-url` (see [Install and run](#install-and-run)) |
| `bridgeScript` | `bridge.ps1` | Another bridge script (relative to the config file), e.g. a fake one for testing without Copilot |

To run a second copy with other settings, point `M365_AGENT_CONFIG` at another config file; its `approvals.json` is kept next to that file.

## Safety

- Copilot also reads your mail, chats and files. Text it saw there can try to steer it into running something. That is why tools that run code or reach outside the workspace ask first (unless you chose **Always allow** for that exact command, script text, package or site), why **Always allow** never covers a whole tool, why writing a script asks even inside the workspace (an allowed command could otherwise be made to run anything), and why reading or writing files outside your trusted folders asks first. Keep it that way when you add tools.
- Whatever the agent reads goes into your Copilot chat, which lives in Microsoft's cloud under your account. Sensitive files (`.env`, keys, certificates, `.ssh`, `.aws`, credential and password files, browser login stores) always ask, even inside a trusted folder, and **Always allow** then covers only that one file. Allow them only when the task really needs it.
- Packages are installed by name only (PyPI, npm, or an exact winget id; no URLs, paths or options). Check the name before you allow it: a typo can install a different package. A winget install puts a program on your PC and accepts its license terms; npm install scripts run.
- The server only listens on 127.0.0.1 and refuses POST requests from other web pages.
- Your clipboard is used to paste messages. Its **text** is put back afterwards; images or files on the clipboard are lost.

## Limitations

- It depends on the Copilot app's current layout. An app update that renames things like the chat box can break it until `bridge.ps1` is updated.
- One message at a time, since it drives a single Copilot window.
- Very long chats are read by scrolling through them, which takes a few seconds. Long messages that Copilot shows collapsed ("See more") can come back shortened.
- Copilot's usage limits and notices still apply; when Copilot shows one, the app shows it as an error.
- The `screen` tool can only bring windows to the front, not activate them (Windows keeps that for you). A Store app it starts (Calculator, ...) can stay on its splash screen until you click it once; regular apps like Postman draw right away.
- Red boxes need the text to be on screen and readable: scrolled-away, cut-off or very faint text, and text inside selections, may not be found (the result then says "NOT boxed"). Braces and other lines without letters or digits are not looked for, so a JSON payload's box goes around its fields.
- Postman's Lightweight API Client (not signed in) has no collections: requests can't be saved or renamed there, only worked on in tabs.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Microsoft 365 Copilot app did not open …` / `… opened, but its chat screen did not appear …` / `… is not installed …` | Run `npm run diag` in this folder (or `powershell -STA -ExecutionPolicy Bypass -File bridge.ps1 diag`). It lists the Copilot apps and packages on the PC, starts the app, waits for its window and chat screen, and shows what it found (window, page, control ids, sign-in texts). The same text is saved in `diag.txt`: send that or a screenshot of it. Often the fix is to open the app once by hand, sign in with the work account and close it. |
| `chat box not found` | Open the Copilot app once, make sure it is signed in and shows a chat. |
| `Copilot: You've reached your daily limit` | Wait for the time shown, or sign in with your work account. |
| `could not start a new chat in Copilot` / `New chat button not found` | Restore the Copilot window once and expand its sidebar, then minimize it again. |
| `the message did not reach Copilot` | Close any dialog open in the Copilot app. |
| `the Python tools are not installed` | Run `npm run setup`. |
| The browser tool can't start | Check that Edge is installed (or set `"browser": "chrome"` in `config.json`); close a stuck agent browser window and try again. |
| Delete all stops with `no Delete button in the confirmation (…)` | Copilot changed its "Delete chat?" dialog. The error lists the buttons it found; update the names in the `delete` command of `bridge.ps1`. |
| Delete stops with `Copilot put chat … back` | Copilot's server refused the delete; try again later, one chat at a time. |
| Delete all stops with `could not put focus on the Delete button` or `still in the sidebar` | Run `bridge.ps1 delete -Id <id> -DryRun` to see which step fails; it answers Cancel, so nothing is deleted. |
| The `github` tool says gh is not installed | `winget install --id GitHub.cli`, then `gh auth login`, then restart the server. |

## Project layout

```
server.ts            web server, chat sync and the agent loop
bridge.ps1           Windows UI Automation for the Copilot app
index.html           the web app
tools/               one file per tool; _lib.ts has shared helpers, _template.ts is a starting point
tools/py/            Python scripts behind make_docx and make_pptx (run in .venv)
tools/ps/            PowerShell behind the screen tool (window list, full-screen snaps, OCR red boxes)
setup.ps1            npm install + Python venv + config.json
requirements.txt     Python packages for the venv (install_package adds to it)
config.example.json  copied to config.json by setup
start.cmd            starts the server and opens the page
workspace/           everything the agent creates (not in git)
approvals.json       your "Always allow" list (created on first use, not in git)
```
