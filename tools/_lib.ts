// Shared types and helpers for tools. Files in tools/ whose name starts with "_" are not loaded as tools.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export type ToolContext = {
  workspace: string; // the agent's own folder: relative paths resolve here; default cwd for commands
  projects: string[]; // folders holding your repos: the agent may create and change files in them (asks first)
  readRoots: string[]; // folders read_file / list_dir may look into (workspace and projects included)
  root: string; // the project folder
  python: string; // the project's venv Python (.venv), for the document tools
  browserChannel: string; // "chrome" or "msedge"
  // call before changing or creating a file: the server keeps its original so the page can offer Keep / Undo
  trackWrite: (fullPath: string) => void;
};

export type Tool = {
  name: string;
  description: string; // one or two lines, shown to Copilot
  args: string; // example args object, shown to Copilot, e.g. '{"path": "notes.md"}'
  needsApproval: (args: Record<string, any>, ctx: ToolContext) => boolean; // true: wait for Allow / Deny in the page
  approvalHint?: string; // shown in the page when approval depends on the args
  // what "Always allow" remembers for a call: calls with the same key run without asking again.
  // Keep it narrow (an exact command, one host). Default: the exact args.
  alwaysRule?: (args: Record<string, any>, ctx: ToolContext) => { key: string; label: string };
  // optional "Allow for this task": calls with the same key run without asking until the current task ends
  // (e.g. every file written in one repo folder while the agent builds it)
  taskRule?: (args: Record<string, any>, ctx: ToolContext) => { key: string; label: string };
  // optional red line on the approval card (e.g. "SENSITIVE FILE", "outside your trusted folders")
  warning?: (args: Record<string, any>, ctx: ToolContext) => string | null;
  // the tool runs code (a command, a script): while files changed by the agent are waiting for Keep / Undo, it asks
  // even if you chose Always allow, since it could run that unreviewed code
  runsCode?: boolean;
  // an argument that may come from the fenced code block after the JSON call instead of inside it
  blockArg?: string;
  run: (args: Record<string, any>, ctx: ToolContext) => Promise<string>;
};

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

// Stop in the page: ends every program a tool is running now; their steps finish with "[stopped]".
export function stopProcesses(): number {
  for (const p of running) { stopped.add(p); killTree(p); }
  return running.size;
}

// Runs a program with an argument list (no shell in between) and returns stdout + stderr.
export function runProcess(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, env: opts.env });
    running.add(p);
    let out = "";
    const t = setTimeout(() => { killTree(p); out += "\n[killed: timeout]"; }, opts.timeoutMs ?? 120_000);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e: NodeJS.ErrnoException) => {
      out += e.code === "ENOENT" ? `\n[not found: ${cmd}]` : `\n[error: ${e.message}]`;
    });
    p.on("close", (code) => {
      clearTimeout(t);
      running.delete(p);
      if (stopped.has(p)) out += "\n[stopped by the user]";
      resolve(`${out.trim()}${code ? `\n[exit code ${code}]` : ""}` || "(no output)");
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
// the variable as "Path"; replace it under its own name.
export function commandEnv(ctx: ToolContext): NodeJS.ProcessEnv {
  const env = { ...process.env };
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

// the approval card's warning line for a path, or null
export function pathWarning(full: string, trusted: boolean): string | null {
  const parts = [];
  if (isSensitive(full)) parts.push("SENSITIVE FILE (keys, passwords or tokens may be in it)");
  if (!trusted) parts.push("outside your trusted folders");
  return parts.length ? `${parts.join(", ")}: what is read goes into the Copilot chat` : null;
}

// the narrow "Always allow" rule for a path: its folder, or the exact file when it is sensitive
export function pathRule(full: string, verb: string): { key: string; label: string } {
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
