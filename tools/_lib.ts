// Shared types and helpers for tools. Files in tools/ whose name starts with "_" are not loaded as tools.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export type ToolContext = {
  workspace: string; // the agent's own folder: relative paths resolve here; default cwd for commands
  projects: string[]; // folders holding your repos: the agent may create and change files in them (asks first)
  readRoots: string[]; // folders read_file / list_dir may look into (workspace and projects included)
  root: string; // the project folder
  configDir?: string; // the folder of the config.json in use (approvals.json lives next to it); default: root
  python: string; // the project's venv Python (.venv), for the document tools
  pythonIndexUrl: string; // your organization's PyPI mirror (Artifactory ...) for pip installs; "" = PyPI / pip's own settings
  browserChannel: string; // "chrome" or "msedge"
  // call before changing or creating a file: the server keeps its original so the page can offer Keep / Undo
  trackWrite: (fullPath: string) => void;
  // after a write: the syntax check's error line for that file (null = it passed), shown in the Files changed list
  noteCheck: (fullPath: string, error: string | null) => void;
};

export type Tool = {
  name: string;
  description: string; // one or two lines, shown to Copilot
  args: string; // example args object, shown to Copilot, e.g. '{"path": "notes.md"}'
  needsApproval: (args: Record<string, any>, ctx: ToolContext) => boolean; // true: wait for Allow / Deny in the page
  approvalHint?: string; // shown in the page when approval depends on the args
  // what "Always allow" remembers for a call: calls with the same key run without asking again.
  // Keep it narrow (an exact command, one host). Default: the exact args. null: no Always allow for this call (the
  // page shows Allow once / Deny only), e.g. a protected path or a flagged command.
  alwaysRule?: (args: Record<string, any>, ctx: ToolContext) => { key: string; label: string } | null;
  // optional "Allow for this task": calls with the same key run without asking until the current task ends
  // (e.g. every file written in one repo folder while the agent builds it)
  taskRule?: (args: Record<string, any>, ctx: ToolContext) => { key: string; label: string };
  // optional red line on the approval card (e.g. "SENSITIVE FILE", "outside your trusted folders")
  warning?: (args: Record<string, any>, ctx: ToolContext) => string | null;
  // optional red flag lines for a command or script (downloads, deletes, encoded commands, ...; see commandFlags):
  // information for the user, and with any flag Always allow is not offered
  flags?: (args: Record<string, any>, ctx: ToolContext) => string[];
  // the tool runs code (a command, a script): while files changed by the agent are waiting for Keep / Undo, it asks
  // even if you chose Always allow, since it could run that unreviewed code
  runsCode?: boolean;
  // an argument that may come from the fenced code block after the JSON call instead of inside it
  blockArg?: string;
  // the result is a program's output: the server tidies it (colour codes, repeated lines) before Copilot sees it
  processOutput?: boolean;
  // the tool creates or changes files: after it ran, the page's Files changed list (Keep / Undo) is refreshed
  changesFiles?: boolean;
  // the tool only reads (list_dir, read_file, search_files): a task made of such steps needs no verify round
  readOnly?: boolean;
  // runs BEFORE the approval card: a string is the result (the call is refused with that text, nothing runs and the
  // user is not asked); null lets it go on. For a check that needs no approval, like a script's syntax.
  precheck?: (args: Record<string, any>, ctx: ToolContext) => Promise<string | null>;
  run: (args: Record<string, any>, ctx: ToolContext) => Promise<string>;
};

// folders a repo listing or search leaves out: dependencies, build output, caches, and dot-folders other than a few
const SKIP_DIRS = new Set(["node_modules", "venv", "__pycache__", "dist", "build", "test-results", "playwright-report", "backups", "coverage", "out", "target"]);
const KEEP_DOT = new Set([".github", ".vscode", ".husky"]); // other dot-folders (.git, .venv, profiles, caches) are skipped
export const isSkippedDir = (name: string) => SKIP_DIRS.has(name) || (name.startsWith(".") && !KEEP_DOT.has(name));

// a glob ("**/*.ts", "src/**/*.{py,md}", "a?.txt") as a case-insensitive RegExp over a forward-slash relative path
export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globSource(glob)}$`, "i");
}
function globSource(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") { const j = glob.indexOf("}", i); if (j > i) { re += `(?:${glob.slice(i + 1, j).split(",").map(globSource).join("|")})`; i = j; } else re += "\\{"; } // {a*,b?} keeps its wildcards
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return re;
}

// Sign-ins and prompts wait for someone to type or confirm, and the agent's hidden shells have no one at the
// keyboard: the step would hang until its timeout. Signing in is the user's own step anyway, so these are not run.
export const SIGN_IN = new RegExp(
  "\\b(gh\\s+auth\\s+(login|refresh)|(npm|pnpm|yarn)\\s+(login|adduser)|az\\s+login|docker\\s+login|postman\\s+login|" +
  "firebase\\s+login|vercel\\s+login|netlify\\s+login|heroku\\s+login|wrangler\\s+login|gcloud\\s+auth\\s+(application-default\\s+)?login|" +
  "aws\\s+(configure|sso\\s+login)|Connect-(AzAccount|MgGraph|ExchangeOnline|MicrosoftTeams|PnPOnline)|Get-Credential|Read-Host)\\b",
  "i",
);

// Programs installed while the server runs (install_package with winget) change the PATH in the registry only; read
// it again before each command so they can be used right away.
export const FRESH_PATH =
  "$env:Path = $env:Path + ';' + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'); ";

// The start of every PowerShell the agent runs: UTF-8 in and out (so "héllo ✓" survives), no progress bars in the
// captured output, the fresh PATH.
export const PS_PRELUDE =
  "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Text.UTF8Encoding]::new($false); $ProgressPreference = 'SilentlyContinue'; " +
  FRESH_PATH;

// Programs started by runProcess that are still running, so Stop in the page can end them.
const running = new Set<ChildProcess>();
const stopped = new WeakSet<ChildProcess>();

// Ends a program with everything it started. p.kill() would end only the shell, and a program it started (gh, npm,
// a login waiting for input) would keep running and keep the output open, so the step would never finish.
function killTree(p: ChildProcess) {
  if (p.pid == null || p.exitCode != null) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else p.kill();
}

// Stop in the page: ends every program a tool is running now (with what it started); their steps finish with
// "[stopped by the user]". Reports what it ended ("powershell 23456") and what was still there 2 s later.
export async function stopProcesses(): Promise<{ ended: string[]; stillRunning: string[] }> {
  const ended: string[] = [], stillRunning: string[] = [];
  await Promise.all([...running].map(async (p) => {
    stopped.add(p);
    const name = `${path.basename(p.spawnfile).replace(/\.exe$/i, "")} ${p.pid ?? "?"}`;
    const gone = new Promise<boolean>((resolve) => { p.once("close", () => resolve(true)); setTimeout(() => resolve(false), 2000); });
    killTree(p);
    ((await gone) || p.exitCode != null) ? ended.push(name) : stillRunning.push(name);
  }));
  return { ended, stillRunning };
}

// Runs a program with an argument list (no shell in between) and returns stdout + stderr (decoded as UTF-8).
// trailer: true ends the output with exactly one line saying how it ended and how long it took:
//   [exit 0, 2.3 s] · [exit code 1, 14.2 s] · [killed: timeout after 600 s] · [stopped by the user after 4.0 s]
// (without it: "[exit code N]" only when non-zero, as the tools that parse their program's output expect)
export function runProcess(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv; trailer?: boolean },
): Promise<string> {
  return new Promise((resolve) => {
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? 120_000;
    if (!existsSync(opts.cwd)) { // spawn would blame the program ("not found: powershell") for a missing folder
      return resolve(`error: the folder ${opts.cwd} does not exist${opts.trailer ? "\n[exit code 1, 0.0 s]" : "\n[exit code 1]"}`);
    }
    const p = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, env: opts.env });
    running.add(p);
    const out = new StringDecoder("utf8"), err = new StringDecoder("utf8");
    let text = "", timedOut = false;
    const t = setTimeout(() => { timedOut = true; killTree(p); if (!opts.trailer) text += "\n[killed: timeout]"; }, timeoutMs);
    p.stdout.on("data", (d) => (text += out.write(d)));
    p.stderr.on("data", (d) => (text += err.write(d)));
    p.on("error", (e: NodeJS.ErrnoException) => {
      text += e.code === "ENOENT" ? `\n[not found: ${cmd}]` : `\n[error: ${e.message}]`;
    });
    p.on("close", (code) => {
      clearTimeout(t);
      running.delete(p);
      text += out.end() + err.end();
      if (opts.trailer) {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        const end = stopped.has(p) ? `[stopped by the user after ${secs} s]`
          : timedOut ? `[killed: timeout after ${Math.round(timeoutMs / 1000)} s]`
          : code ? `[exit code ${code}, ${secs} s]` : `[exit 0, ${secs} s]`;
        return resolve(`${text.trim() || "(no output)"}\n${end}`);
      }
      if (stopped.has(p)) text += "\n[stopped by the user]";
      resolve(`${text.trim()}${code ? `\n[exit code ${code}]` : ""}` || "(no output)");
    });
    p.stdin.end(opts.input ?? "", "utf8");
  });
}

// The PATH Windows has now (machine + user): a program installed while the server runs (winget) is only there, not in
// the PATH the server started with. Read again at most every 15 s.
let windowsPath = { at: 0, value: "" };
function currentWindowsPath(): string {
  if (process.platform !== "win32") return "";
  if (Date.now() - windowsPath.at > 15_000) {
    try {
      const value = execFileSync("powershell", ["-NoProfile", "-Command",
        "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"],
      { encoding: "utf8", windowsHide: true, timeout: 10_000 }).trim();
      windowsPath = { at: Date.now(), value };
    } catch { /* keep the last one */ }
  }
  return windowsPath.value;
}

// The environment for commands the agent runs: what install_package installed comes first on the PATH (npm commands
// in the workspace, the venv's scripts), and programs installed since the server started are found too. Windows keeps
// the variable as "Path"; replace it under its own name. Output is plain UTF-8 without colours, nothing prompts for
// input. ci: true (test runners) makes them run once instead of in watch mode; never set it for builds (CRA turns
// lint warnings into errors under CI).
export function commandEnv(ctx: ToolContext, o: { ci?: boolean } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1",
    NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb", GIT_TERMINAL_PROMPT: "0", npm_config_color: "false",
  };
  if (o.ci) env.CI = "true";
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "Path";
  const extra = [path.join(ctx.workspace, "node_modules", ".bin"), path.dirname(ctx.python)];
  env[key] = [...extra, env[key] ?? "", currentWindowsPath()].filter(Boolean).join(path.delimiter);
  return env;
}

// Runs tools/ps/screen.ps1 (windows, open, snap, read, clipboard) with one request; returns its text or throws.
export async function screenDriver(ctx: ToolContext, request: Record<string, unknown>): Promise<string> {
  const raw = await runProcess(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ctx.root, "tools", "ps", "screen.ps1")],
    { cwd: ctx.root, timeoutMs: 90_000, input: JSON.stringify(request) },
  );
  let res: { ok?: boolean; text?: string; error?: string };
  try { res = JSON.parse(raw.trim().split(/\r?\n/).at(-1) ?? ""); } catch { throw new Error(`screen driver failed: ${raw.slice(0, 500)}`); }
  if (!res.ok) throw new Error(String(res.error));
  return String(res.text);
}

// A new screenshot file in workspace/screenshots: <name>.png, or the next free step-NN.png (shared by the browser and
// screen tools, so evidence from both lines up and nothing is overwritten).
export function nextScreenshot(ctx: ToolContext, name?: unknown): { full: string; rel: string } {
  const dir = path.join(ctx.workspace, "screenshots");
  mkdirSync(dir, { recursive: true });
  let file = name ? String(name).replace(/^.*[\\/]/, "").replace(/[^\w.-]+/g, "_") : "";
  if (file && !file.toLowerCase().endsWith(".png")) file += ".png";
  if (!file) {
    let n = 1;
    while (existsSync(path.join(dir, `step-${String(n).padStart(2, "0")}.png`))) n++;
    file = `step-${String(n).padStart(2, "0")}.png`;
  }
  return { full: path.join(dir, file), rel: `screenshots/${file}` };
}

function inside(full: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), full);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// A path for reading: relative paths are taken from the workspace; anything outside the read roots is refused.
// (Used by tools that only work inside your folders; read_file / list_dir / write_file use the helpers below.)
export function insideRoots(p: string, ctx: ToolContext): string {
  const full = path.resolve(ctx.workspace, String(p));
  if (!ctx.readRoots.some((r) => inside(full, r))) {
    throw new Error(`${full} is outside the allowed folders (${ctx.readRoots.join(", ")}); see readRoots in config.json`);
  }
  return full;
}

// ── file access like GitHub Copilot's agent: anywhere on the PC, but only your trusted folders without asking ──
// trusted for reading: workspace, projects, readRoots. trusted for writing: workspace, projects.
// Anything else asks first (Allow once / Always allow for that folder). Sensitive files always ask, even in a
// trusted folder, and "Always allow" then covers that one file only.
export const fullPath = (p: unknown, ctx: ToolContext) => path.resolve(ctx.workspace, String(p ?? "."));
export const trustedForRead = (full: string, ctx: ToolContext) => ctx.readRoots.some((r) => inside(full, r));
export const trustedForWrite = (full: string, ctx: ToolContext) => [ctx.workspace, ...ctx.projects].some((r) => inside(full, r));

const SENSITIVE = [
  /[\\/]\.ssh([\\/]|$)/i, /[\\/]\.gnupg([\\/]|$)/i, /[\\/]\.aws([\\/]|$)/i, /[\\/]\.azure([\\/]|$)/i, /[\\/]\.kube([\\/]|$)/i,
  /(^|[\\/])\.env(\.[\w-]+)?$/i, /\.(pem|key|pfx|p12|kdbx|ppk|jks|keystore)$/i, /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|[\\/])\.(npmrc|pypirc|netrc|git-credentials)$/i, /credentials/i, /secret/i, /password/i,
  /[\\/](Login Data|Cookies|Web Data|Local State)$/i, // browser profile stores
  /[\\/]AppData[\\/]Roaming[\\/]Microsoft[\\/](Credentials|Protect|Crypto)([\\/]|$)/i,
  /^[A-Za-z]:[\\/]Windows[\\/]System32[\\/]config([\\/]|$)/i,
];
export const isSensitive = (full: string) => SENSITIVE.some((re) => re.test(full));

// ── the agent's own files: protected paths always ask, with a red reason and no Always allow, even inside a trusted
//    folder (config.json puts the agent's own repo under projects). Writing its code or settings changes what runs at
//    the next start; a tampered Keep / Undo store turns Undo into an arbitrary write; .git hooks run at the next git
//    command; a browser profile holds signed-in cookies and tokens. ──
// the path as Windows will open it: trailing dots and spaces dropped from each segment, the deepest existing ancestor
// through realpath (8.3 names, letter case, junctions), so "approvals.json." or "M365-A~1" cannot slip past
export function canonicalPath(full: string): string {
  const parsed = path.parse(path.resolve(full));
  const segs = parsed.dir.slice(parsed.root.length).split(/[\\/]/).concat(parsed.base).filter(Boolean).map((s) => s.replace(/[. ]+$/, "") || s);
  let known = parsed.root, i = 0;
  for (; i < segs.length; i++) {
    const next = path.join(known, segs[i]);
    if (!existsSync(next)) break;
    known = next;
  }
  try { known = realpathSync.native(known); } catch { /* keep the resolved spelling */ }
  return path.join(known, ...segs.slice(i));
}
const underDir = (full: string, dir: string) => inside(full, canonicalPath(dir));
const PROFILE = /[\\/](\.copilot-web-profile|\.browser-profile[^\\/]*)([\\/]|$)|[\\/]AppData[\\/]Local[\\/](Microsoft[\\/]Edge|Google[\\/]Chrome)[\\/]User Data([\\/]|$)/i;

// why a path is protected for that verb, or null. Write: the agent's code (root outside the workspace), its config
// and approvals, the Keep / Undo store, any .git segment, browser profiles. Read: the config (it can hold a token),
// the trace and captures, the Keep / Undo store, the profiles; the agent's own source stays free to read.
export function protectedPath(full: string, ctx: ToolContext, verb: "read" | "write"): string | null {
  const p = canonicalPath(full);
  const configDir = ctx.configDir ?? ctx.root;
  const name = path.basename(p).toLowerCase();
  const inDir = (dir: string) => path.dirname(p).toLowerCase() === canonicalPath(dir).toLowerCase();
  if (PROFILE.test(p)) return "a signed-in browser profile (cookies and tokens)";
  if (underDir(p, path.join(ctx.workspace, ".changes"))) return "the Keep / Undo store: a changed entry would make Undo write any file";
  if (inDir(configDir) && (name === "config.json" || (verb === "write" && name === "approvals.json"))) {
    return verb === "write" ? `the agent's own settings (${name}): a change takes effect at the next server start` : `the agent's own settings (${name}; it can hold a package index token)`;
  }
  if (verb === "write") {
    if (/[\\/]\.git([\\/]|$)/i.test(p)) return "git hooks and config run code on the next git command";
    if (underDir(p, ctx.root) && !underDir(p, ctx.workspace)) return "the agent's own code and settings: a change takes effect at the next server start";
  } else {
    if (/^agent\.log(\.old)?$/.test(name) && (inDir(ctx.root) || inDir(configDir))) return "the agent's own trace (what every chat did and saw)";
    if (underDir(p, path.join(ctx.root, "diag"))) return "the agent's own captures (what other chats did and saw)";
  }
  return null;
}

// the approval card's warning line for a path, or null. protectedWhy: protectedPath()'s reason; tail: what happens
// with the file (default: it is read into the Copilot chat)
export function pathWarning(full: string, trusted: boolean, o: { protectedWhy?: string | null; tail?: string } = {}): string | null {
  const parts = [];
  if (o.protectedWhy) parts.push(`PROTECTED, ${o.protectedWhy}`);
  if (isSensitive(full)) parts.push("SENSITIVE FILE (keys, passwords or tokens may be in it)");
  if (!trusted) parts.push("outside your trusted folders");
  return parts.length ? `${parts.join("; ")}: ${o.tail ?? "what is read goes into the Copilot chat"}` : null;
}

// the narrow "Always allow" rule for a path: its folder, or the exact file when it is sensitive; none for a
// protected path (ctx and verb given), which asks every time
export function pathRule(full: string, verb: "reading" | "writing", ctx?: ToolContext): { key: string; label: string } | null {
  if (ctx && protectedPath(full, ctx, verb === "reading" ? "read" : "write")) return null;
  return isSensitive(full)
    ? { key: `file:${full.toLowerCase()}`, label: `${verb} the file ${full}` }
    : { key: `dir:${path.dirname(full).toLowerCase()}`, label: `${verb} files in ${path.dirname(full)}` };
}

// A path for writing: relative paths are taken from the workspace, and the result must stay inside it.
export function inWorkspace(p: string, ctx: ToolContext): string {
  const full = path.resolve(ctx.workspace, String(p));
  if (!inside(full, ctx.workspace)) throw new Error(`${full} is outside the workspace ${ctx.workspace}; write files there`);
  return full;
}

export const isInWorkspace = (full: string, ctx: ToolContext) => inside(full, ctx.workspace);

// Where a file is written: anywhere on the PC; trusted (workspace / projects) writes don't ask, others do (see above).
export function writable(p: string, ctx: ToolContext): { full: string; trusted: boolean } {
  const full = fullPath(p, ctx);
  return { full, trusted: trustedForWrite(full, ctx) };
}

// A working folder for commands: the workspace, a projects folder, or a folder inside one of them.
export function workingDir(p: string | undefined, ctx: ToolContext): string {
  if (!p) return ctx.workspace;
  const full = path.resolve(ctx.workspace, String(p));
  if ([ctx.workspace, ...ctx.projects].some((r) => inside(full, r))) return full;
  throw new Error(`${full} is outside the workspace and the projects folders`);
}

// ── red flag lines for a command or script (shell, run_python, process): what to look at twice before allowing.
//    They are information, not a block: the step still runs when allowed, but Always allow is not offered. ──
const FLAGS: [RegExp, string][] = [
  [/\|\s*(iex|Invoke-Expression|powershell(\.exe)?|pwsh(\.exe)?|cmd(\.exe)?|sh|bash)\b|(^|[\s;(])(iex|Invoke-Expression)\b/im, "runs text as code (iex / Invoke-Expression / piped into a shell)"],
  [/\b(iwr|curl|wget|Invoke-WebRequest|Invoke-RestMethod|DownloadString|DownloadFile|Start-BitsTransfer)\b/i, "downloads from the internet"],
  [/\b(Remove-Item|rm|ri|del|erase)\b[^\n|;]*\s-(r|rf|Recurse)\b|(^|[\s;|(])(rd|rmdir)\s|\bdel\s+\/s\b|\bFormat-Volume\b|\bClear-Content\b|\bgit\s+(clean\s+-\w*f|reset\s+--hard|push\s[^\n;|]*(-f\b|--force)|checkout\s+--\s|restore\s|stash\s+drop|branch\s+-D\b)/im, "deletes or discards work; this cannot be undone"],
  [/\breg(\.exe)?\s+(add|delete|import)\b|\bSet-ItemProperty\b[^\n]*\bHK(LM|CU)\b|\bNew-Service\b|\bsc(\.exe)?\s+create\b|\bschtasks\b|\bRegister-ScheduledTask\b|\bnetsh\b|\b(Set|Add)-MpPreference\b|\bSet-ExecutionPolicy\b|\bNew-NetFirewallRule\b/i, "changes Windows settings, Defender, the firewall, services or what runs at startup"],
  [/\bStart-Process\b|-Verb\s+RunAs\b|\brunas\b/i, "starts another program, or asks for administrator rights"],
];
// after powershell / pwsh: -e, -en, ... -EncodedCommand (a base64 command nobody can read on the card)
const ENCODED = new RegExp(`\\b(powershell|pwsh)(\\.exe)?\\b[^\\n|;]*\\s-e${"ncodedcommand".split("").reduceRight((rest, ch) => `(${ch}${rest})?`, "")}(\\s|$)`, "im");
const PY_FLAGS: [RegExp, string][] = [
  [/\b(subprocess|os\.system|os\.popen|os\.exec\w*|os\.spawn\w*)\b/, "runs other programs (subprocess / os.system)"],
  [/\bshutil\.rmtree\b|\bos\.(remove|unlink|rmdir|removedirs)\b|\.unlink\(/, "deletes files or folders"],
  [/\bwinreg\b/, "changes the Windows registry"],
  [/(^|[^\w.])(exec|eval)\s*\(/m, "runs text as code (exec / eval)"],
  [/\b(urllib|requests|httpx|urlopen|aiohttp)\b[\s\S]*\b(exec|eval|subprocess|os\.system)\b|\b(exec|eval|subprocess|os\.system)\b[\s\S]*\b(urllib|requests|httpx|urlopen|aiohttp)\b/, "downloads and runs"],
];
const WRITES = /\b(Set-Content|Out-File|Add-Content|Copy-Item|Move-Item|New-Item|Rename-Item|cp|mv|copy|move|mkdir|md|ni|tee)\b|(^|[^>])>{1,2}(?!&)/im;
const PATHISH = /^[A-Za-z]:[\\/]|^\.{1,2}[\\/]|^~[\\/]|[\\/]/;
const SWITCH = /^\/[A-Za-z][\w-]*$/; // a cmd-style option (/s, /create), not a path
// quote-aware tokens of a command (quotes removed)
export function commandTokens(text: string): string[] {
  return (text.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^(["'])(.*)\1$/, "$2"));
}
/** flag lines for a PowerShell command or script (o.python: Python code); cwd resolves relative paths */
export function commandFlags(text: string, ctx: ToolContext, o: { cwd?: string; python?: boolean } = {}): string[] {
  const out: string[] = [];
  if (!o.python && ENCODED.test(text)) out.push("runs an encoded command (base64 that nobody can read here)");
  for (const [re, why] of o.python ? [...PY_FLAGS, ...FLAGS.slice(1)] : FLAGS) if (re.test(text)) out.push(why);
  // tokens that are paths: a protected or sensitive one, or a write outside the trusted folders
  let cwd = ctx.workspace;
  try { cwd = o.cwd ? workingDir(o.cwd, ctx) : ctx.workspace; } catch { /* the tool refuses it anyway */ }
  const writes = !o.python && WRITES.test(text);
  const seen = new Set<string>();
  for (const tok of commandTokens(text)) {
    const t = tok.replace(/^[-/]+\w+[:=]/, "").replace(/[;,)]+$/, ""); // -Path:C:/x, "x," → the path
    if (!PATHISH.test(t) || SWITCH.test(t) || /^[\\/]{2}|^[a-z][a-z0-9+.-]*:\/\//i.test(t) || t.length > 300) continue;
    let full: string;
    try { full = path.resolve(cwd, t.replace(/^~(?=[\\/])/, process.env.USERPROFILE ?? "~")); } catch { continue; }
    if (seen.has(full.toLowerCase())) continue;
    seen.add(full.toLowerCase());
    const why = protectedPath(full, ctx, "write");
    if (why) out.push(`names a protected path (${tok}): ${why}`);
    else if (isSensitive(full)) out.push(`names a sensitive file (${tok}): keys, passwords or tokens may be in it`);
    else if (writes && !trustedForWrite(full, ctx) && !/^[A-Za-z]:[\\/]?$/.test(full)) out.push(`may write outside your trusted folders (${tok})`);
  }
  return [...new Set(out)];
}
