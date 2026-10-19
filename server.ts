// M365 Agent: a local web app (http://127.0.0.1:4317) that uses Microsoft 365 Copilot (the website, in its own
// minimized Edge window: see copilot-web.ts) as its chat and planning engine.
//
//   chats   the Copilot sidebar is synced here; open one to see its messages and keep talking in it
//   tools   tick tools for a chat and your message becomes a task: Copilot answers with one JSON tool call per turn,
//           this server runs it on your PC and pastes the result back, until Copilot says "done"
//
// Human in the loop: Copilot also reads your mail and files, so text it saw there can steer it. A tool that can
// change something outside the workspace (shell, GitHub changes, opening a new site, ...) waits for Allow / Deny
// in the page. Everything the agent creates goes into the workspace folder.
//
// Run: node server.ts   (Node 23.6+ runs TypeScript directly)
import http from "node:http";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stopProcesses, type Tool, type ToolContext } from "./tools/_lib.ts";
import { CopilotWeb } from "./copilot-web.ts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ── config: config.json (or the file in M365_AGENT_CONFIG) over these defaults ──
// bridgeScript: a fake Copilot for testing (a PowerShell script answering list / read / open / ask / delete with one
// JSON line), used instead of the website.
const defaults = {
  port: 4317, workspace: "workspace", projects: [] as string[], readRoots: [] as string[], maxSteps: 40, maxResult: 8000,
  bridgeScript: "", browser: "msedge", pythonIndexUrl: "", copilotUrl: "https://m365.cloud.microsoft/chat",
};
const configFile = process.env.M365_AGENT_CONFIG ? path.resolve(process.env.M365_AGENT_CONFIG) : path.join(ROOT, "config.json");
const config = { ...defaults, ...(existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {}) };

// Your organization's Python package index (an Artifactory or Nexus PyPI mirror), when PyPI itself is blocked:
//   npm start -- --index-url <url>   ·   npm start --index-url=<url>   ·   "pythonIndexUrl" in config.json
// Given on the command line, it is saved in config.json, so later starts (and setup.ps1) keep using it.
function indexUrlFromCommandLine(): string {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--index-url(?:=(.+))?$/i);
    if (m) return m[1] ?? argv[i + 1] ?? "";
  }
  const npmFlag = process.env.npm_config_index_url; // npm start --index-url=<url> (or "true" + the url as an argument)
  if (npmFlag && npmFlag !== "true") return npmFlag;
  return npmFlag === "true" ? argv.find((a) => /^https?:\/\//i.test(a)) ?? "" : "";
}
// a URL with a user name and token in it, shown without the token
const hideSecret = (url: string) => url.replace(/\/\/([^/@:]+):[^/@]+@/, "//$1:***@");
const cliIndexUrl = indexUrlFromCommandLine();
if (cliIndexUrl && cliIndexUrl !== config.pythonIndexUrl) {
  config.pythonIndexUrl = cliIndexUrl;
  const saved = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
  writeFileSync(configFile, JSON.stringify({ ...saved, pythonIndexUrl: cliIndexUrl }, null, 2) + "\n", "utf8");
  console.log(`Python packages now come from ${hideSecret(cliIndexUrl)} (saved as pythonIndexUrl in ${configFile})`);
}
const workspace = path.resolve(path.dirname(configFile), config.workspace); // relative to the config file
mkdirSync(workspace, { recursive: true });
const projects: string[] = config.projects.map((r: string) => path.resolve(r));
const ctx: ToolContext = {
  workspace,
  projects,
  readRoots: [workspace, ...projects, ...config.readRoots.map((r: string) => path.resolve(r))],
  root: ROOT,
  python: path.join(ROOT, ".venv", "Scripts", "python.exe"),
  pythonIndexUrl: String(config.pythonIndexUrl ?? ""),
  browserChannel: config.browser,
  trackWrite: (full) => trackWrite(full),
};
const FAKE_BRIDGE = config.bridgeScript ? path.resolve(path.dirname(configFile), config.bridgeScript) : "";
const copilot = new CopilotWeb({ root: ROOT, url: config.copilotUrl, channel: config.browser });

// ── tools: every tools/*.ts except _*.ts ──
const tools = new Map<string, Tool>();
for (const f of readdirSync(path.join(ROOT, "tools")).filter((f) => f.endsWith(".ts") && !f.startsWith("_")).sort()) {
  const t: Tool = (await import(pathToFileURL(path.join(ROOT, "tools", f)).href)).default;
  if (t?.name && typeof t.run === "function") tools.set(t.name, t);
  else console.warn(`tools/${f}: no default export with name and run(); skipped`);
}

function approvalLabel(t: Tool): string {
  if (t.approvalHint) return t.approvalHint;
  try { return t.needsApproval({}, ctx) ? "asks first" : "runs on its own"; } catch { return "asks first"; }
}

// ── agent.log: one line per Copilot step and per error, to see afterwards what went wrong ──
const LOG_FILE = path.join(ROOT, "agent.log");
function log(line: string) {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 1_000_000) renameSync(LOG_FILE, LOG_FILE + ".old");
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch { /* logging must never break the app */ }
}

// ── server-sent events to the page ──
const clients = new Set<http.ServerResponse>();
function emit(ev: Record<string, unknown>) {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.write(line);
}

// ── Copilot: one command at a time, since it is one page ──
type Chat = { id: string; title: string };
type Msg = { role: "user" | "copilot"; text: string };
type BridgeResult = { ok: boolean; error?: string; text?: string; chatId?: string; chats?: Chat[]; messages?: Msg[]; closed?: boolean };
type BridgeCmd = "list" | "read" | "open" | "ask" | "delete";
type BridgeOpts = { input?: string; newChat?: boolean; id?: string; noLaunch?: boolean };

let bridgeQueue: Promise<unknown> = Promise.resolve();
function bridge(cmd: BridgeCmd, opts: BridgeOpts = {}): Promise<BridgeResult> {
  const run = async (): Promise<BridgeResult> => {
    const started = Date.now();
    let r: BridgeResult;
    try {
      r = FAKE_BRIDGE ? await fakeBridge(cmd, opts)
        : cmd === "list" ? await copilot.list(opts.noLaunch)
        : cmd === "read" ? await copilot.read()
        : cmd === "open" ? await copilot.open(String(opts.id))
        : cmd === "ask" ? await copilot.ask(opts.input ?? "", !!opts.newChat)
        : await copilot.remove(String(opts.id));
    } catch (e) {
      r = { ok: false, error: (e instanceof Error ? e.message : String(e)).split("\n")[0] };
    }
    log(`copilot ${cmd}${opts.id ? ` ${opts.id}` : ""}${opts.newChat ? " -New" : ""} ${Date.now() - started}ms -> ${r.ok ? "ok" : `ERROR ${r.error}`}`);
    return r;
  };
  const p = bridgeQueue.then(run, run);
  bridgeQueue = p;
  return p;
}

// the fake Copilot for tests (config bridgeScript): one PowerShell call per command, the message on stdin
function fakeBridge(cmd: BridgeCmd, opts: BridgeOpts): Promise<BridgeResult> {
  return new Promise((resolve) => {
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", FAKE_BRIDGE, cmd];
    if (opts.newChat) args.push("-New");
    if (opts.id) args.push("-Id", opts.id);
    if (opts.noLaunch) args.push("-NoLaunch");
    const ps = spawn("powershell", args, { windowsHide: true });
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.stderr.on("data", (d) => (out += d));
    ps.on("close", () => {
      const line = out.trim().split(/\r?\n/).filter((l) => l.startsWith("{")).at(-1);
      try { resolve(JSON.parse(line ?? "")); } catch { resolve({ ok: false, error: out.trim().slice(0, 500) || "fake bridge gave no output" }); }
    });
    ps.stdin.end(opts.input ?? "", "utf8");
  });
}

// Sends a message. When nothing was sent (the chat box or a new chat wasn't ready), trying once more is safe.
async function askCopilot(input: string, newChat: boolean): Promise<BridgeResult> {
  const r = await bridge("ask", { input, newChat });
  if (r.ok || !/nothing was sent/.test(String(r.error))) return r;
  await new Promise((res) => setTimeout(res, 1500));
  return bridge("ask", { input, newChat });
}

// ── chats ──
let chats: Chat[] = [];
let currentChat: string | null = null; // the chat open in Copilot, as far as this server knows
let busy = false;

// background: the timer's sync. It never opens the Copilot window: if you closed it, it stays closed until you send
// a message, open a chat or press Sync.
async function refreshChats(background = false): Promise<void> {
  const r = await bridge("list", { noLaunch: background });
  if (!r.ok) return emit({ type: "error", text: `could not read Copilot chats: ${r.error}` });
  if (r.closed) return emit({ type: "copilot-closed" }); // keep the last known list
  chats = r.chats ?? [];
  emit({ type: "chats", chats });
}

// ── tool calls ──
type Call = { tool: string; args: Record<string, any>; why?: string };
const MARK = "[local-agent]"; // starts every message this app sends in agent mode, so the page can render old ones
let lastParseError = "";

// Copilot writes Windows paths with single backslashes ("C:\devl"), which is invalid JSON; double the stray ones.
function parseLenient(s: string): any {
  try {
    return JSON.parse(s);
  } catch (e) {
    try {
      // take each escape as a unit so an already valid "\\" pair is left alone
      return JSON.parse(s.replace(/\\(["\\/bfnrtu]?)/g, (m, c) => (c ? m : "\\\\")));
    } catch {
      lastParseError = e instanceof Error ? e.message : String(e);
      return null;
    }
  }
}

// first balanced {...} in the text (honouring strings) that parses as a tool call
function findCall(text: string): Call | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      const obj = parseLenient(text.slice(start, i + 1));
      if (obj && typeof obj.tool === "string") return { tool: obj.tool, args: obj.args ?? {}, why: obj.why };
      if (obj) lastParseError = 'missing "tool"';
      return null;
    }
  }
  return null;
}

// A reply is a JSON tool call, optionally followed by a fenced code block that carries a file or a script (so code
// never has to be escaped inside JSON). The call is looked for outside the code blocks first, then inside them (some
// replies fence the JSON itself); a tool's blockArg (write_file: content, run_python: code) is taken from the block.
function parseCall(reply: string): Call | null {
  lastParseError = "no JSON object found";
  const blocks: string[] = [];
  // a block ends at a fence of the same kind and length (``` / ```` / ~~~), so a README holding ``` samples stays whole
  const outside = reply.replace(/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?^\1[ \t]*$/gm, (_m, _f, code) => { blocks.push(code); return "\n"; });
  let call = findCall(outside), used = -1;
  for (let i = 0; !call && i < blocks.length; i++) if ((call = findCall(blocks[i]))) used = i;
  if (!call) return null;
  const arg = tools.get(call.tool)?.blockArg;
  if (arg && call.args[arg] == null) {
    const block = blocks.find((_b, i) => i !== used);
    if (block != null) call.args[arg] = block;
  }
  return call;
}

// The task goes first so Copilot titles the chat after it; the page splits stored messages at "\n\n[local-agent] ".
function agentPrompt(selected: Tool[], task: string): string {
  const list = selected.map((t) => `- ${t.name}: ${t.description}\n  args example: ${t.args}`).join("\n");
  return `${task}

${MARK} You are the agent for the message above, working on my Windows PC through the tools below. If it is a question or chat that needs no tool (explain, compare, advise), just answer it in plain text. If it asks you to do something, do it with the tools: each turn I run ONE tool for you and paste its result back.
For a tool step, reply with ONLY one JSON object and no other text:
{"tool": "<name>", "args": {...}, "why": "<short reason>"}

Tools:
${list}
- ask_user: stop and ask me something, then wait: my answer comes back as the RESULT. Use it whenever you need me: a sign-in or login page, a code or captcha, a choice between options, details you don't have, or a step only I can do.
  args example: {"question": "Postman shows its sign-in page in the Edge window. Please sign in there, then press Continue."}
- done: finish and give me the answer, with what you checked.
  args example: {"answer": "<final answer>", "checks": ["Option1 is checked: the click RESULT says checked", "report.docx has 4 steps and 4 images: read_file shows them"]}

Rules:
- One tool per reply; wait for the RESULT before the next step; use done when the task is finished or cannot be done.
- Do as much as you can yourself, so I have as little to do as possible. If no tool does a step directly, write a PowerShell command (shell) or a Python script (run_python) that does it, and install what it needs (install_package): I approve each one, so you have my permission to propose them. Examples: bring a window to the front or resize it, copy or rename files, call an API, convert a file, check a port.
- ask_user only for what really needs me: signing in, passwords and codes, a decision between options, details you don't have. Never ask me to do something a tool or a command can do (bring the browser to the front, take a snap, open a page again, find a file). When a step needs me, ask, wait for my answer and go on from there; never skip it, and never switch to another app, site or way of doing it without asking me.
- Check every step like a careful engineer: read each RESULT and make sure the step did what you wanted (the right page opened, not a sign-in or error page; the box is now checked; the file was written; the response is the expected one). If it didn't, fix it, try another way or ask me; don't build on a step that failed.
- Before done, verify the whole task: go through every part of my request and check it against the RESULTs, and check with a tool what you haven't seen yet (browser read or elements, screen read, list_dir, read_file of the files you made: it reads .docx, .pptx and .xlsx too). In done, checks has one line per part of my request: how you know it is done, or that it is not done and why.
- Be honest. Say only what the tool RESULTs show: never write (in done, a report, a caption) that something was typed, clicked, highlighted, sent or verified unless a RESULT shows it. When a step could not be done or a tool cannot do it, say so plainly instead of describing it as done.
- Do not use your own code execution, file creation or web browsing: they don't reach my PC. Use the tools.
- Files you make for me (reports, decks, screenshots, notes) go in the workspace folder ${workspace.replace(/\\/g, "/")}: give paths relative to it (report.docx, screenshots/step-01.png).
${projects.length ? `- Code repos live in ${projects.map((p) => p.replace(/\\/g, "/")).join(", ")}: create a new repo as a folder there (e.g. ${projects[0].replace(/\\/g, "/")}/my-repo) and change existing repos there, using absolute paths.\n` : ""}- You may read and write files anywhere on my PC with absolute paths; outside my trusted folders I approve each one, so only touch what the task needs.
- To create or change a file, write the WHOLE file with write_file (never a fragment). Before changing an existing file, read it fully with read_file. To understand a repo, start with list_dir recursive.
- If a package or command-line tool is missing (a Python or npm package, a Windows program), install it with install_package, then use it.
- Manual testing with evidence, like a tester documenting by hand, one step at a time, with a full-screen snap (window in front, taskbar included) right after each step that red-boxes exactly what the step changed or shows (the checkbox, request name, URL, method, payload lines, status code). In a web page (Postman Web too): do the step with the browser tool and use evidence: true (or browser screenshot with target / highlight). In a desktop app, which no tool can click or type in: put what I have to paste on the clipboard (screen clipboard: a payload, or a cURL for Postman's URL box), give me the hand step in the ask of a screen snap with highlight. Use browser read or screen read to check what is shown. Then make_docx: per step a heading, what was done and by whom, the snap, and a caption naming what the red box marks (only boxes the RESULT reported).
- Write Windows paths with forward slashes (C:/devl/x) so the JSON stays valid.
- write_file and run_python: do NOT put the file or the code inside the JSON. Reply with the JSON line, then the complete file or code in ONE fenced code block right after it, for example:
{"tool": "write_file", "args": {"path": "C:/devl/my-repo/package.json"}, "why": "project manifest"}
\`\`\`json
{ "name": "my-repo" }
\`\`\`
  Label the block \`\`\`text (or the code's language), never \`\`\`markdown or \`\`\`html: those show a preview and I lose the raw file.
  If the file itself contains \`\`\` lines (a README with code samples), fence it with ~~~~text instead.`;
}

// ── approvals: Allow once / Allow for this task / Always allow / Deny ──
// "Always allow" saves a narrow rule (the tool's alwaysRule: an exact command, one file path, ...) in approvals.json;
// a later call with the same tool and key runs without asking. Rules are listed and removed in the page.
// "Allow for this task" (tools with a taskRule, e.g. writing files in one repo) lasts until the current task ends.
type Decision = "once" | "task" | "always" | "deny";
const taskGrants = new Set<string>(); // "<tool>|<key>", cleared when a new message is sent
type Rule = { tool: string; key: string; label: string; added: string };
const RULES_FILE = path.join(path.dirname(configFile), "approvals.json"); // next to the config in use
let rules: Rule[] = existsSync(RULES_FILE) ? JSON.parse(readFileSync(RULES_FILE, "utf8")) : [];
const saveRules = () => writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2) + "\n", "utf8");

const pending = new Map<string, (d: Decision) => void>();
let stopRequested = false;

// ── ask_user: Copilot asks you something (sign in first, pick one, ...) and the task waits for your answer ──
const questions = new Map<string, (answer: string | null) => void>(); // null: the task was stopped
function askUser(question: string): Promise<string | null> {
  const id = Math.random().toString(36).slice(2);
  emit({ type: "question", id, text: question });
  return new Promise((resolve) => questions.set(id, resolve));
}

// Copilot's first "done" in a task that used tools gets this once: check every part of the request before finishing.
const VERIFY = `${MARK} Before you finish, verify the task like a careful engineer. Go through every part of my request (at the top of this chat) one by one and find the RESULT that shows it is done. Whatever no RESULT shows yet, check it now with a tool (browser read or elements, screen read, list_dir, read_file of the files you made). If something is missing or wrong, do or fix it now, or use ask_user if you need me. Then send done again with "checks": one line per part of my request saying how you know it is done, or that it is not done and why.`;

function ruleOf(t: Tool, args: Record<string, any>): { key: string; label: string } {
  try { if (t.alwaysRule) return t.alwaysRule(args, ctx); } catch { /* fall back to the exact args */ }
  return { key: JSON.stringify(args), label: `this exact ${t.name} call` };
}

async function approve(t: Tool, c: Call): Promise<boolean> {
  let ask = true;
  try { ask = t.needsApproval(c.args, ctx); } catch { /* malformed args: ask */ }
  if (!ask) return true;
  const rule = ruleOf(t, c.args);
  const saved = rules.find((r) => r.tool === t.name && r.key === rule.key);
  // a command or script may run files the agent changed and you haven't kept yet: then even a saved rule asks
  const unkept = t.runsCode ? changes.length : 0;
  if (saved && !unkept) {
    emit({ type: "allowed", text: `${t.name}: ${saved.label}` });
    return true;
  }
  let task: { key: string; label: string } | null = null;
  try { task = t.taskRule?.(c.args, ctx) ?? null; } catch { /* no task-wide option for this call */ }
  if (task && taskGrants.has(`${t.name}|${task.key}`)) {
    emit({ type: "allowed", text: `${t.name}: ${task.label}` });
    return true;
  }
  const id = Math.random().toString(36).slice(2);
  let warning: string | null = null;
  try { warning = t.warning?.(c.args, ctx) ?? null; } catch { /* no warning line */ }
  emit({ type: "approve", id, call: c, always: `${t.name}: ${rule.label}`, task: task ? `${t.name}: ${task.label}` : null, unkept, warning });
  const d = await new Promise<Decision>((resolve) => pending.set(id, resolve));
  if (d === "task" && task) taskGrants.add(`${t.name}|${task.key}`);
  if (d === "always") {
    rules.push({ tool: t.name, key: rule.key, label: rule.label, added: new Date().toISOString() });
    saveRules();
    emit({ type: "rules", rules });
  }
  return d !== "deny";
}

// ── Keep / Undo: files the agent changed, until you keep or undo them ──
// The first time the agent writes a file, its original (or "didn't exist") is saved in workspace/.changes, so Undo
// can put it back however many times the agent rewrote it. Keep forgets the original. Survives a server restart.
type Change = { path: string; original: string | null; at: string }; // original: base64 of the old bytes, null = new file
const CHANGES_FILE = path.join(workspace, ".changes", "index.json");
let changes: Change[] = existsSync(CHANGES_FILE) ? JSON.parse(readFileSync(CHANGES_FILE, "utf8")) : [];
const saveChanges = () => {
  mkdirSync(path.dirname(CHANGES_FILE), { recursive: true });
  writeFileSync(CHANGES_FILE, JSON.stringify(changes), "utf8");
};
const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function trackWrite(full: string) {
  if (changes.some((c) => samePath(c.path, full))) return; // keep the very first original
  changes.push({ path: full, original: existsSync(full) ? readFileSync(full).toString("base64") : null, at: new Date().toISOString() });
  saveChanges();
}

const readText = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

// Line diff (longest common subsequence); big files fall back to "all removed, all added".
type DiffLine = { t: " " | "+" | "-"; s: string };
function diffLines(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split(/\r?\n/), b = after === "" ? [] : after.split(/\r?\n/);
  if (a.length * b.length > 4_000_000) return [...a.map((s) => ({ t: "-" as const, s })), ...b.map((s) => ({ t: "+" as const, s }))];
  const w = b.length + 1, lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ t: " ", s: a[i] }); i++; j++; }
    else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) out.push({ t: "-", s: a[i++] });
    else out.push({ t: "+", s: b[j++] });
  }
  while (i < a.length) out.push({ t: "-", s: a[i++] });
  while (j < b.length) out.push({ t: "+", s: b[j++] });
  return out;
}

function changeSummary() {
  return changes.map((c) => {
    const before = c.original == null ? "" : Buffer.from(c.original, "base64").toString("utf8");
    const d = diffLines(before, readText(c.path));
    return {
      path: c.path, kind: c.original == null ? "new" : existsSync(c.path) ? "modified" : "deleted",
      added: d.filter((l) => l.t === "+").length, removed: d.filter((l) => l.t === "-").length,
    };
  });
}
const emitChanges = () => emit({ type: "changes", changes: changeSummary() });

function undoChange(c: Change) {
  if (c.original == null) { if (existsSync(c.path)) rmSync(c.path); } // the agent created it: remove it
  else { mkdirSync(path.dirname(c.path), { recursive: true }); writeFileSync(c.path, Buffer.from(c.original, "base64")); }
}

// ── sending: Chat mode (or no tools) sends the message as it is; Agent mode wraps it with the tool instructions,
//    and Copilot either answers in plain text or works through the tools ──
async function send(chatId: string | null, message: string, toolNames: string[]) {
  busy = true;
  stopRequested = false;
  taskGrants.clear(); // "Allow for this task" ends with the task
  emit({ type: "busy" });
  emit({ type: "user", text: message });
  // the chat a new conversation got in Copilot (its id comes with the first reply; the sidebar can lag behind)
  let startedId: string | undefined;
  const ask = async (text: string, fresh: boolean) => {
    const r = await askCopilot(text, fresh);
    if (fresh && r.ok && r.chatId) startedId = r.chatId;
    return r;
  };
  try {
    const newChat = !chatId;
    if (chatId && chatId !== currentChat) {
      emit({ type: "status", text: "opening the chat in Copilot…" });
      const r = await bridge("open", { id: chatId });
      if (!r.ok) return emit({ type: "error", text: `could not open the chat: ${r.error}` });
      currentChat = chatId;
    }
    const selected = toolNames.map((n) => tools.get(n)).filter((t): t is Tool => !!t);

    if (!selected.length) {
      emit({ type: "status", text: "waiting for Copilot…" });
      const r = await ask(message, newChat);
      if (!r.ok) return emit({ type: "error", text: String(r.error) });
      emit({ type: "reply", text: r.text ?? "" });
    } else {
      let out = agentPrompt(selected, message);
      let badCalls = 0, toolRuns = 0, verifyAsked = false;
      for (let step = 1; step <= config.maxSteps && !stopRequested; step++) {
        emit({ type: "status", text: `step ${step}: waiting for Copilot…` });
        const r = await ask(out, newChat && step === 1);
        if (!r.ok) return emit({ type: "error", text: String(r.error) });
        const reply = r.text ?? "";
        const call = parseCall(reply);
        if (!call) {
          // plain text is an answer (a question, an explanation, or Copilot's own wrap-up), like a chat reply;
          // a reply that tried to be a tool call but isn't valid JSON gets one more chance (twice at most)
          if (!/"tool"\s*:/.test(reply) || ++badCalls > 2) return emit({ type: "reply", text: reply });
          emit({ type: "status", text: `not a valid tool call (${lastParseError}); asking Copilot again` });
          out = `${MARK} Your reply was not one valid JSON tool call (${lastParseError}). Reply with ONLY {"tool": ..., "args": {...}, "why": ...}. Write Windows paths with forward slashes.`;
          continue;
        }
        badCalls = 0;
        if (call.tool === "done") {
          if (toolRuns && !verifyAsked) { // like a careful engineer: check the whole task once before finishing
            verifyAsked = true;
            emit({ type: "note", text: "Copilot says it is done: asking it to verify every part of the task first" });
            out = VERIFY;
            continue;
          }
          const checks = Array.isArray(call.args.checks) ? call.args.checks.map(String) : call.args.checks ? [String(call.args.checks)] : [];
          return emit({ type: "done", text: String(call.args.answer ?? ""), checks });
        }
        if (call.tool === "ask_user") {
          emit({ type: "call", call });
          const answer = await askUser(String(call.args.question ?? call.args.text ?? "").trim() || "(Copilot asked without a question)");
          if (answer === null || stopRequested) break;
          const result = answer.trim() ? `The user answered: ${answer.trim()}` : "The user pressed Continue: the step you asked for is done.";
          emit({ type: "result", tool: "ask_user", text: result });
          out = `${MARK} RESULT of ask_user:\n${result}\n\nNext tool call (JSON only), or done; check first that what you asked for really happened.`;
          continue;
        }
        const t = selected.find((x) => x.name === call.tool);
        emit({ type: "call", call });
        let result: string;
        if (!t) {
          result = `tool "${call.tool}" is not enabled in this chat; use one of: ${selected.map((x) => x.name).join(", ")}, ask_user, done`;
        } else if (await approve(t, call)) {
          emit({ type: "status", text: `step ${step}: running ${t.name}… (Stop ends it)` });
          toolRuns++;
          try { result = await t.run(call.args, ctx); } catch (e) { result = `error: ${e instanceof Error ? e.message : e}`; }
          if (call.tool === "write_file") emitChanges(); // the Keep / Undo list in the page
        } else {
          result = "The user declined to run this. Choose another way or use done.";
        }
        if (stopRequested) break;
        if (result.length > config.maxResult) result = result.slice(0, config.maxResult) + `\n…[${result.length - config.maxResult} more characters cut]`;
        emit({ type: "result", tool: call.tool, text: result });
        out = `${MARK} RESULT of ${call.tool}:\n${result}\n\nNext tool call (JSON only), or done; if this RESULT shows the step did not work, fix that first.`;
      }
      emit({ type: "error", text: stopRequested ? "stopped" : `stopped after ${config.maxSteps} steps` });
    }
  } finally {
    const known = new Set(chats.map((c) => c.id));
    await refreshChats(); // order (and a new chat's title) changed
    // the chat this message started, if any
    const created = chatId ? undefined : startedId ? { id: startedId, title: message.slice(0, 60) } : chats.find((c) => !known.has(c.id));
    if (created && !chats.some((c) => c.id === created.id)) { // not in the sidebar yet: show it until the next sync
      chats = [created, ...chats];
      emit({ type: "chats", chats });
    }
    if (created) {
      currentChat = created.id;
      emit({ type: "created", id: created.id });
    }
    busy = false;
    emit({ type: "idle" });
  }
}

// ── delete every chat in Copilot, one by one (the sidebar can load more as it empties) ──
async function deleteAll() {
  busy = true;
  stopRequested = false;
  emit({ type: "busy" });
  let deleted = 0, error = "";
  try {
    for (let round = 0; round < 50 && !stopRequested && !error; round++) {
      await refreshChats();
      if (!chats.length) break;
      const before = deleted;
      for (const c of [...chats]) {
        if (stopRequested) break;
        emit({ type: "status", text: `deleting chat ${deleted + 1}: ${c.title}` });
        const r = await bridge("delete", { id: c.id });
        if (!r.ok) { error = String(r.error); break; }
        deleted++;
        await new Promise((ok) => setTimeout(ok, 3000)); // give Copilot time between deletes (it refuses ones that come too fast)
      }
      if (deleted === before) break; // nothing went away: don't loop
    }
  } finally {
    currentChat = null;
    await refreshChats();
    emit({ type: "deleted", count: deleted, error: error || (stopRequested ? "stopped" : ""), left: chats.length });
    log(`delete all: ${deleted} deleted, ${chats.length} left${error ? `, stopped: ${error}` : ""}`);
    busy = false;
    emit({ type: "idle" });
  }
}

// ── http (127.0.0.1 only) ──
function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => {
      try { resolve(JSON.parse(s || "{}")); } catch { resolve({}); }
    });
  });
}
function json(res: http.ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // only this page may call the API (stops other sites open in your browser from posting tasks)
    if (req.method === "POST" && req.headers.origin && req.headers.origin !== `http://127.0.0.1:${config.port}`) return json(res, 403);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(readFileSync(path.join(ROOT, "index.html")));
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: busy ? "busy" : "idle" })}\n\n`);
      clients.add(res);
      return req.on("close", () => clients.delete(res));
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      return json(res, 200, {
        chats, current: currentChat, busy, rules, changes: changeSummary(),
        tools: [...tools.values()].map((t) => ({ name: t.name, description: t.description, approval: approvalLabel(t) })),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/changes/diff") {
      const c = changes.find((x) => samePath(x.path, url.searchParams.get("path") ?? ""));
      if (!c) return json(res, 404, { error: "no such change" });
      const before = c.original == null ? "" : Buffer.from(c.original, "base64").toString("utf8");
      return json(res, 200, { path: c.path, lines: diffLines(before, readText(c.path)) });
    }
    if (req.method === "POST" && (url.pathname === "/api/changes/keep" || url.pathname === "/api/changes/undo")) {
      const { path: p } = await readBody(req); // no path: all of them
      const undo = url.pathname.endsWith("/undo");
      const done: Change[] = [];
      let error = "";
      for (const c of changes.filter((x) => !p || samePath(x.path, p))) {
        try {
          if (undo) undoChange(c);
          done.push(c);
        } catch (e) {
          error = `${c.path}: ${e instanceof Error ? e.message : e}`; // stays in the list
        }
      }
      changes = changes.filter((c) => !done.includes(c));
      saveChanges();
      emitChanges();
      return error ? json(res, 500, { error, done: done.length }) : json(res, 200, { done: done.length });
    }
    if (req.method === "POST" && url.pathname === "/api/rules/remove") {
      const { tool, key } = await readBody(req);
      rules = rules.filter((r) => !(r.tool === tool && r.key === key));
      saveRules();
      emit({ type: "rules", rules });
      return json(res, 200, { rules });
    }
    if (req.method === "POST" && url.pathname === "/api/chats/refresh") {
      if (busy) return json(res, 409, { error: "busy" });
      await refreshChats();
      return json(res, 200, { chats });
    }
    if (req.method === "POST" && url.pathname === "/api/chats/delete") {
      const { id } = await readBody(req);
      if (typeof id !== "string" || !id) return json(res, 400, { error: "missing chat id" });
      if (busy) return json(res, 409, { error: "busy" });
      busy = true;
      emit({ type: "busy" });
      try {
        const r = await bridge("delete", { id });
        if (!r.ok) return json(res, 500, { error: r.error });
        if (currentChat === id) currentChat = null;
        await refreshChats();
        return json(res, 200, { ok: true });
      } finally {
        busy = false;
        emit({ type: "idle" });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/chats/delete-all") {
      const { confirm } = await readBody(req);
      if (confirm !== "DELETE") return json(res, 400, { error: 'send {"confirm": "DELETE"}' });
      if (busy) return json(res, 409, { error: "busy" });
      deleteAll();
      return json(res, 202);
    }
    if (req.method === "POST" && url.pathname === "/api/open") {
      const { id } = await readBody(req);
      if (busy) return json(res, 409, { error: "busy" });
      busy = true;
      emit({ type: "busy" });
      try {
        const r = await bridge("open", { id });
        if (!r.ok) return json(res, 500, { error: r.error });
        currentChat = id;
        return json(res, 200, { id, messages: r.messages ?? [] });
      } finally {
        busy = false;
        emit({ type: "idle" });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/send") {
      const { chatId, message, tools: toolNames } = await readBody(req);
      if (busy) return json(res, 409, { error: "busy" });
      if (!String(message ?? "").trim()) return json(res, 400, { error: "empty message" });
      send(chatId || null, String(message).trim(), Array.isArray(toolNames) ? toolNames : []);
      return json(res, 202);
    }
    if (req.method === "POST" && url.pathname === "/api/approve") {
      const { id, decision } = await readBody(req);
      if (!["once", "task", "always", "deny"].includes(decision)) return json(res, 400, { error: "decision: once | task | always | deny" });
      pending.get(id)?.(decision);
      pending.delete(id);
      return json(res, 204);
    }
    if (req.method === "POST" && url.pathname === "/api/answer") {
      const { id, text } = await readBody(req);
      const resolve = questions.get(id);
      if (!resolve) return json(res, 404, { error: "no such question (answered or stopped)" });
      questions.delete(id);
      resolve(String(text ?? ""));
      return json(res, 204);
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      stopRequested = true;
      for (const [id, resolve] of pending) { resolve("deny"); pending.delete(id); }
      for (const [id, resolve] of questions) { resolve(null); questions.delete(id); }
      const ended = stopProcesses(); // a command still running (a login waiting for input, a long npm install) ends now
      if (ended) log(`stop: ended ${ended} running program(s)`);
      return json(res, 204);
    }
    json(res, 404);
  })
  .listen(config.port, "127.0.0.1", () => {
    console.log(`M365 Agent → http://127.0.0.1:${config.port}   tools: ${[...tools.keys()].join(", ")}`);
    refreshChats();
    setInterval(() => { if (!busy) refreshChats(true); }, 60_000); // keep the sidebar in sync, without reopening Copilot
  });
