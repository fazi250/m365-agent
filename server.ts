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
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stopProcesses, type Tool, type ToolContext } from "./tools/_lib.ts";
import { CopilotWeb } from "./copilot-web.ts";
import { MARK, agentPrompt, askUserResultMessage, checksMissFailures, compact, correctionMessage, cutResult, diffLines, factLines, parseCall, readOutput, resultMessage, statusOf, verifyPrompt, type Call, type Ledger, type LedgerRun } from "./agent-core.ts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ── config: config.json (or the file in M365_AGENT_CONFIG) over these defaults ──
// bridgeScript: a fake Copilot for testing (a PowerShell script answering list / read / open / ask / delete with one
// JSON line), used instead of the website.
const defaults = {
  port: 4317, workspace: "workspace", projects: [] as string[], readRoots: [] as string[], maxSteps: 40, maxResult: 8000,
  bridgeScript: "", browser: "msedge", pythonIndexUrl: "", copilotUrl: "https://m365.cloud.microsoft/chat",
  replyTimeoutSec: 240, // how long to wait for one Copilot reply
  logFile: "", // the trace (default agent.log next to server.ts; relative to the config file)
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
  noteCheck: (full, error) => noteCheck(full, error),
};
const FAKE_BRIDGE = config.bridgeScript ? path.resolve(path.dirname(configFile), config.bridgeScript) : "";
const copilot = new CopilotWeb({ root: ROOT, url: config.copilotUrl, channel: config.browser, replyTimeoutSec: Number(config.replyTimeoutSec) || 240 });

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

// ── agent.log: a trace of every task, Copilot command, tool call and error, to see afterwards what went wrong
//    (npm run diag shows its end). Messages are cut to their start; file contents are not logged. ──
const LOG_FILE = config.logFile ? path.resolve(path.dirname(configFile), config.logFile) : path.join(ROOT, "agent.log");
function log(line: string) {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 1_000_000) renameSync(LOG_FILE, LOG_FILE + ".old");
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch { /* logging must never break the app */ }
}
const short = (s: unknown, n = 120) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
function tail(file: string, n: number): string[] {
  try { return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-n); } catch { return []; }
}
process.on("uncaughtException", (e) => { log(`CRASH ${e instanceof Error ? e.stack : e}`); console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { log(`UNHANDLED ${e instanceof Error ? e.stack : e}`); console.error(e); });

// ── server-sent events to the page ──
const clients = new Set<http.ServerResponse>();
function emit(ev: Record<string, unknown>) {
  if (ev.type === "error") log(`page shows error: ${short(ev.text, 400)}`);
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.write(line);
}

// ── after a failed Copilot command: the page's state, a screenshot and the log's end, in diag/ (newest 15 kept) ──
const DIAG_DIR = path.join(ROOT, "diag");
async function captureFailure(cmd: string, error: string) {
  try {
    mkdirSync(DIAG_DIR, { recursive: true });
    const base = path.join(DIAG_DIR, `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${cmd}`);
    const state = await copilot.capture(base + ".png");
    writeFileSync(base + ".txt", [`copilot ${cmd} failed: ${error}`, ...state, "", "== agent.log, last 30 lines", ...tail(LOG_FILE, 30)].join("\n") + "\n", "utf8");
    log(`  captured ${path.relative(ROOT, base)}.txt / .png`);
    const old = readdirSync(DIAG_DIR).map((f) => f.replace(/\.(txt|png)$/, "")).filter((v, i, a) => a.indexOf(v) === i).sort().slice(0, -15);
    for (const o of old) for (const ext of [".txt", ".png"]) rmSync(path.join(DIAG_DIR, o + ext), { force: true });
  } catch { /* a capture must never break the app */ }
}

// ── Copilot: one command at a time, since it is one page ──
type Chat = { id: string; title: string };
type Msg = { role: "user" | "copilot"; text: string };
type BridgeResult = { ok: boolean; error?: string; text?: string; chatId?: string; chats?: Chat[]; messages?: Msg[]; closed?: boolean; via?: string };
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
    // for ask: how the reply was taken as finished (via button = its Copy Response button; stable30 / progress60 = its
    // text just stopped changing) and its length, to tell slow replies from slow detection
    const how = cmd === "ask" && r.ok ? ` via ${r.via ?? "-"}, ${(r.text ?? "").length} chars` : "";
    log(`copilot ${cmd}${opts.id ? ` ${opts.id}` : ""}${opts.newChat ? " -New" : ""} ${Date.now() - started}ms -> ${r.ok ? `ok${how}` : `ERROR ${r.error}`}`);
    if (!r.ok && !FAKE_BRIDGE) await captureFailure(cmd, String(r.error));
    return r;
  };
  const p = bridgeQueue.then(run, run);
  bridgeQueue = p;
  return p;
}

// the fake Copilot for tests (config bridgeScript): one call per command (a PowerShell script, or a Node .mjs
// script like tests/fake-bridge.mjs), the message on stdin, one JSON line back
function fakeBridge(cmd: BridgeCmd, opts: BridgeOpts): Promise<BridgeResult> {
  return new Promise((resolve) => {
    const node = FAKE_BRIDGE.endsWith(".mjs");
    const args = node ? [FAKE_BRIDGE, cmd] : ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", FAKE_BRIDGE, cmd];
    if (opts.newChat) args.push("-New");
    if (opts.id) args.push("-Id", opts.id);
    if (opts.noLaunch) args.push("-NoLaunch");
    const ps = spawn(node ? process.execPath : "powershell", args, { windowsHide: true });
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
let taskSeq = 0; // one per message sent in agent mode

// background: the timer's sync. It never opens the Copilot window: if you closed it, it stays closed until you send
// a message, open a chat or press Sync.
async function refreshChats(background = false): Promise<void> {
  const r = await bridge("list", { noLaunch: background });
  if (!r.ok) return emit({ type: "error", text: `could not read Copilot chats: ${r.error}` });
  if (r.closed) return emit({ type: "copilot-closed" }); // keep the last known list
  chats = r.chats ?? [];
  emit({ type: "chats", chats });
}

// ── tool calls: the prompt, the parser and the messages back to Copilot live in agent-core.ts (shared with tests and
//    the page). ──
const blockArgOf = (name: string) => tools.get(name)?.blockArg;

// The full output of the last 20 tool runs (numbered, up to 2 MB each): a long RESULT goes to Copilot cut in the
// middle, and read_output gives it the rest on request, in the same chat only (what one chat was allowed to read
// stays there). Not kept across a server restart.
type Run = { n: number; tool: string; text: string; step: number; at: string; chat: string };
const runs = new Map<number, Run>();
let runSeq = 0;
function keepRun(tool: string, text: string, step: number, chat: string): Run {
  const run = { n: ++runSeq, tool, text: text.slice(0, 2_000_000), step, at: new Date().toISOString(), chat };
  runs.set(run.n, run);
  while (runs.size > 20) runs.delete(runs.keys().next().value!);
  return run;
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

function ruleOf(t: Tool, args: Record<string, any>): { key: string; label: string } {
  try { if (t.alwaysRule) return t.alwaysRule(args, ctx); } catch { /* fall back to the exact args */ }
  return { key: JSON.stringify(args), label: `this exact ${t.name} call` };
}

async function approve(t: Tool, c: Call): Promise<boolean> {
  if (stopRequested) return false; // Stop was pressed while Copilot was answering: nothing more runs
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
// original: base64 of the old bytes, null = new file; check: the syntax check's error line after the last write
type Change = { path: string; original: string | null; at: string; check?: string | null };
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
let lastWritten = ""; // the file the last write_file / edit_file touched (for the project-checks hint)
function noteCheck(full: string, error: string | null) {
  lastWritten = full;
  const c = changes.find((x) => samePath(x.path, full));
  if (!c) return;
  c.check = error;
  saveChanges();
}

// ── the task ledger (agent-core Ledger): files written, commands run with their last status, declined steps ──
type Book = { writes: Map<string, { path: string; tool: string; step: number }>; runs: Map<string, LedgerRun>; declined: string[]; asked: number; mutatingRuns: number; verifyAsked: boolean };
const newBook = (): Book => ({ writes: new Map(), runs: new Map(), declined: [], asked: 0, mutatingRuns: 0, verifyAsked: false });
// what a call was, in a few words, for the ledger and the Facts
function summarize(tool: string, args: Record<string, any>): string {
  if (tool === "shell") return args.script ? `script ${args.name ?? ""} (${createHash("sha256").update(String(args.script)).digest("hex").slice(0, 8)})`.replace("  ", " ") : `${args.command ?? ""}${args.cwd ? ` (in ${args.cwd})` : ""}`;
  if (tool === "run_python") return `${args.module ? `python -m ${args.module}` : String(args.path ?? `scripts/${args.name ?? "script"}.py`)}${Array.isArray(args.argv) && args.argv.length ? ` ${args.argv.join(" ")}` : ""}${args.cwd ? ` (in ${args.cwd})` : ""}`;
  if (tool === "github") return `gh ${Array.isArray(args.args) ? args.args.join(" ") : ""}`;
  if (tool === "install_package") return `${args.manager ?? "pip"} ${[].concat(args.packages ?? args.package ?? []).join(" ")}`;
  if (tool === "browser") return `${args.action ?? ""} ${args.url ?? args.target ?? ""}`.trim();
  if (tool === "screen") return `${args.action ?? ""} ${args.app ?? args.window ?? ""}`.trim();
  return JSON.stringify(args).slice(0, 80);
}
// the ledger with what the disk says now about the files Copilot wrote
function ledgerOf(b: Book): Ledger {
  return {
    writes: [...b.writes.values()].map((w) => {
      const exists = existsSync(w.path);
      const lines = exists ? readText(w.path).split(/\r?\n/).filter((_l, i, a) => i < a.length - 1 || _l !== "").length : 0;
      return { ...w, exists, lines, check: changes.find((c) => samePath(c.path, w.path))?.check ?? null };
    }),
    runs: [...b.runs.values()], declined: b.declined, asked: b.asked, mutatingRuns: b.mutatingRuns, verifyAsked: b.verifyAsked,
  };
}

// Once per repo folder per task: the checks a repo defines (npm scripts, pytest), so Copilot runs them when the
// change is complete.
const hinted = new Set<string>();
function projectChecksHint(full: string): string {
  if (full.toLowerCase().startsWith(workspace.toLowerCase() + path.sep)) return ""; // the agent's own files, not a repo
  const root = projects.find((p) => full.toLowerCase().startsWith(p.toLowerCase() + path.sep));
  if (!root) return "";
  for (let dir = path.dirname(full); dir.length >= root.length; dir = path.dirname(dir)) {
    const checks: string[] = [];
    const pkg = path.join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const scripts = JSON.parse(readFileSync(pkg, "utf8")).scripts ?? {};
        for (const s of ["lint", "typecheck", "build", "test"]) if (scripts[s]) checks.push(s === "test" ? "npm test" : `npm run ${s}`);
      } catch { /* not a readable package.json */ }
    }
    if (existsSync(path.join(dir, "pytest.ini")) || (existsSync(path.join(dir, "pyproject.toml")) && /\[tool\.pytest/.test(readText(path.join(dir, "pyproject.toml"))))) checks.push("python -m pytest");
    if (checks.length) {
      if (hinted.has(dir.toLowerCase())) return "";
      hinted.add(dir.toLowerCase());
      return `project checks: ${checks.join(", ")} (in ${dir.replace(/\\/g, "/")}): run them with shell when the change is complete`;
    }
    if (dir === root || path.dirname(dir) === dir) break;
  }
  return "";
}

const readText = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

function changeSummary() {
  return changes.map((c) => {
    const before = c.original == null ? "" : Buffer.from(c.original, "base64").toString("utf8");
    const d = diffLines(before, readText(c.path));
    return {
      path: c.path, kind: c.original == null ? "new" : existsSync(c.path) ? "modified" : "deleted",
      added: d.filter((l) => l.t === "+").length, removed: d.filter((l) => l.t === "-").length, check: c.check ?? null,
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
  hinted.clear();
  taskSeq++;
  emit({ type: "busy" });
  emit({ type: "user", text: message });
  log(`task: ${chatId ? `chat ${chatId}` : "new chat"}, tools: ${toolNames.join(",") || "none (chat mode)"}: "${short(message, 80)}"`);
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
      log(`task end: reply (${(r.text ?? "").length} characters)`);
    } else {
      let out = agentPrompt(selected, message, { workspace, projects });
      let badCalls = 0, toolRuns = 0;
      const book = newBook();
      const facts = () => factLines(ledgerOf(book));
      const chatKey = () => chatId ?? startedId ?? `task-${taskSeq}`; // the chat the runs belong to (a new chat has its id after the first reply)
      for (let step = 1; step <= config.maxSteps && !stopRequested; step++) {
        emit({ type: "status", text: `step ${step}: waiting for Copilot…` });
        const r = await ask(out, newChat && step === 1);
        if (stopRequested) break; // Stop was pressed while waiting: the reply is dropped
        if (!r.ok) return emit({ type: "error", text: String(r.error), facts: toolRuns ? facts() : [] });
        const reply = r.text ?? "";
        const { call, error: parseError } = parseCall(reply, blockArgOf);
        if (!call) {
          // a reply that tried to be a tool call but isn't valid JSON gets one more chance (twice at most)
          if (/"tool"\s*:/.test(reply) && ++badCalls <= 2) {
            log(`  not a valid tool call (${parseError}): "${short(reply, 160)}"`);
            emit({ type: "status", text: `not a valid tool call (${parseError}); asking Copilot again` });
            out = correctionMessage(parseError);
            continue;
          }
          // plain text after tool runs: once, ask for a proper ending (done, ask_user or the next call), with the facts;
          // otherwise plain text is an answer (a question, an explanation), like a chat reply
          if (toolRuns && !book.verifyAsked) {
            book.verifyAsked = true;
            log(`  plain text after ${toolRuns} tool run(s): asking for done`);
            emit({ type: "note", text: "Copilot answered in text instead of done: asking it to finish properly" });
            out = verifyPrompt(ledgerOf(book), { nudge: true });
            continue;
          }
          log(`task end: plain reply (${reply.length} characters)${toolRuns ? " without done" : ""}`);
          if (toolRuns) emit({ type: "note", text: "Copilot stopped without done" });
          return emit({ type: "reply", text: reply, facts: toolRuns ? facts() : [] });
        }
        badCalls = 0;
        if (call.tool === "done") {
          if (toolRuns && !book.verifyAsked && book.mutatingRuns) { // like a careful engineer: check the whole task once before finishing
            book.verifyAsked = true;
            emit({ type: "note", text: "Copilot says it is done: asking it to verify every part of the task first" });
            out = verifyPrompt(ledgerOf(book));
            continue;
          }
          const checks = Array.isArray(call.args.checks) ? call.args.checks.map(String) : call.args.checks ? [String(call.args.checks)] : [];
          const f = toolRuns ? facts() : [];
          const warning = checksMissFailures(f, checks) ? "Copilot's checks do not mention these failures." : null;
          log(`task end: done, ${checks.length} checks${toolRuns && !book.mutatingRuns ? " (read-only task: no verify round)" : ""}${warning ? "; checks miss the failures in the facts" : ""}`);
          return emit({ type: "done", text: String(call.args.answer ?? ""), checks, facts: f, warning });
        }
        if (call.tool === "ask_user") {
          if (stopRequested) break;
          emit({ type: "call", call });
          log(`  ask_user: "${short(call.args.question, 100)}"`);
          const answer = await askUser(String(call.args.question ?? call.args.text ?? "").trim() || "(Copilot asked without a question)");
          if (answer === null || stopRequested) break;
          book.asked++;
          const result = answer.trim() ? `The user answered: ${answer.trim()}` : "The user pressed Continue: the step you asked for is done.";
          emit({ type: "result", tool: "ask_user", text: result });
          out = askUserResultMessage(result);
          continue;
        }
        if (call.tool === "read_output") { // more of an earlier run's output of THIS chat (no approval: it was already shown here)
          emit({ type: "call", call });
          const run = runs.get(Number(call.args.run));
          const mine = [...runs.values()].filter((x) => x.chat === chatKey()).map((x) => x.n);
          const result = run && run.chat === chatKey() ? readOutput(run, call.args, config.maxResult)
            : `no run #${call.args.run ?? "?"} to read in this chat (its runs: ${mine.join(", ") || "none"}; runs of other chats or before a server restart are not kept)`;
          log(`  read_output ${short(JSON.stringify(call.args), 120)} -> ${result.length} characters`);
          emit({ type: "result", tool: "read_output", text: result });
          out = resultMessage("read_output", result);
          continue;
        }
        const t = selected.find((x) => x.name === call.tool);
        emit({ type: "call", call });
        let result: string, run: Run | null = null, refused: string | null = null;
        try { refused = (await t?.precheck?.(call.args, ctx)) ?? null; } catch { /* a failing precheck never blocks the call */ }
        if (!t) {
          result = `tool "${call.tool}" is not enabled in this chat; use one of: ${selected.map((x) => x.name).join(", ")}, ask_user, read_output, done`;
        } else if (refused) { // a script with a syntax error: refused before the approval card
          result = refused;
          log(`  tool ${call.tool} refused before approval: ${short(refused, 160)}`);
        } else if (await approve(t, call)) {
          emit({ type: "status", text: `step ${step}: running ${t.name}… (Stop ends it)` });
          toolRuns++;
          const t1 = Date.now();
          lastWritten = "";
          try { result = await t.run(call.args, ctx); } catch (e) { result = `error: ${e instanceof Error ? e.message : e}`; }
          if (t.processOutput) result = compact(result, { repeats: true });
          const { problem, exit } = statusOf(result, { data: !!t.readOnly });
          if (t.changesFiles && lastWritten && !problem && !result.includes("SYNTAX ERROR")) { const hint = projectChecksHint(lastWritten); if (hint) result += `\n${hint}`; }
          run = keepRun(call.tool, result, step, chatKey());
          log(`  tool ${call.tool} ${short(JSON.stringify(call.args), 160)} ${Date.now() - t1}ms -> ${problem ? `PROBLEM ${short(result, 240)}` : `ok (${result.length} characters)`} [run #${run.n}]`);
          // the ledger: files written, and every run by what it was (the last status of a repeated command wins)
          if (t.changesFiles && lastWritten) book.writes.set(lastWritten.toLowerCase(), { path: lastWritten, tool: t.name, step });
          else { const summary = summarize(t.name, call.args); book.runs.set(`${t.name}|${summary}`, { tool: t.name, summary, step, problem, exit }); }
          if (!t.readOnly) book.mutatingRuns++;
          if (t.changesFiles) emitChanges(); // the Keep / Undo list in the page
        } else {
          result = "The user declined to run this. Choose another way or use done.";
          if (!stopRequested) book.declined.push(`${t.name} ${summarize(t.name, call.args)}`);
          log(`  tool ${call.tool} ${stopRequested ? "not run: stopped" : "declined by the user"}`);
        }
        if (stopRequested) break;
        // Copilot gets the start and the end of a long result; the page gets all of it (up to 200 KB)
        const shown = cutResult(result, config.maxResult, run?.n ?? 0);
        emit({ type: "result", tool: call.tool, text: shown.text, run: run?.n, ...(shown.cut ? { full: result.slice(0, 200_000), total: result.length, head: shown.head, tail: shown.tail } : {}) });
        out = resultMessage(call.tool, shown.text);
      }
      emit({ type: "error", text: stopRequested ? "stopped" : `stopped after ${config.maxSteps} steps`, facts: toolRuns ? facts() : [] });
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
        await new Promise((ok) => setTimeout(ok, 2000)); // give Copilot time between deletes (it refuses ones that come too fast; remove() also waits for the sidebar to settle)
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

let port: number = config.port; // the port in use ("port": 0 in the config = any free one, for tests)
const server = http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // only this page may call the API (stops other sites open in your browser from posting tasks)
    if (req.method === "POST" && req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`) return json(res, 403);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(readFileSync(path.join(ROOT, "index.html")));
    }
    if (req.method === "GET" && url.pathname === "/agent-core.js") { // the page parses Copilot's replies with the server's own code
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(stripTypeScriptTypes(readFileSync(path.join(ROOT, "agent-core.ts"), "utf8")));
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
    // npm run diag asks here while the server runs (the Copilot window is this server's). POST, so other web pages
    // can't trigger it; ask: also one test message in a new chat, only while no task is running.
    if (req.method === "POST" && url.pathname === "/api/diag") {
      const { ask } = await readBody(req);
      if (ask && busy) return json(res, 409, { error: "a task is running: run diag --ask when it is done" });
      const head = [`server: busy ${busy}, ${chats.length} chats known, open chat ${currentChat ?? "none"}, ${pending.size} approval(s) and ${questions.size} question(s) waiting`];
      if (FAKE_BRIDGE) return json(res, 200, { lines: [...head, `fake Copilot in use (bridgeScript ${FAKE_BRIDGE})`] });
      const run = () => copilot.diagnose({ ask: !!ask, screenshot: path.join(ROOT, "diag.png") });
      const p = bridgeQueue.then(run, run); // between Copilot commands, never in the middle of one
      bridgeQueue = p.catch(() => {});
      return json(res, 200, { lines: [...head, ...(await p.catch((e) => [`diag failed: ${e instanceof Error ? e.message : e}`]))] });
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
  });
server.listen(config.port, "127.0.0.1", () => {
  port = (server.address() as { port: number }).port;
  console.log(`M365 Agent → http://127.0.0.1:${port}   tools: ${[...tools.keys()].join(", ")}`);
  log(`server start: node ${process.version}, port ${port}, copilot ${FAKE_BRIDGE ? `FAKE ${FAKE_BRIDGE}` : config.copilotUrl}, browser ${config.browser}`);
  refreshChats();
  setInterval(() => { if (!busy) refreshChats(true); }, 60_000); // keep the sidebar in sync, without reopening Copilot
});
