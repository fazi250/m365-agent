// Runs PowerShell for the agent: one command, or a script (several steps) sent in a fenced block. The output is
// UTF-8 and ends with one trailer line ([exit 0, 2.3 s] / [exit code 1, 14.2 s] / killed / stopped), and a failed
// step really gives a non-zero code (plain PowerShell forgets a native program's exit code and a cmdlet's failure).
// Always asks; Always allow remembers the exact command (in its folder) or the exact script text.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PS_PRELUDE, SIGN_IN, commandEnv, runProcess, workingDir, type Tool, type ToolContext } from "./_lib.ts";

const command = (args: Record<string, any>) => String(args.command ?? "").trim();
const script = (args: Record<string, any>) => (args.script == null ? "" : String(args.script));
const noComments = (s: string) => s.replace(/(^|\s)#.*$/gm, "$1");

// after a one-line command: a failed native program (its exit code) or a failed cmdlet ($? false) ends with that code
const EXIT_TAIL = "\n$__ok = $?; if ($LASTEXITCODE) { exit $LASTEXITCODE }; if (-not $__ok) { exit 1 }";
// servers and watchers never end: this shell would wait for them until its timeout (only at a command position, so
// "npm install nodemon" is fine; --watch=false is fine)
const LONG_RUNNING = /(^|[;|&(]\s*)((npm|pnpm|yarn)\s+(run\s+)?(dev|serve|start:dev|watch)\b|(npx\s+)?(vite|next|nuxt|astro)\s+dev\b|(npx\s+)?nodemon\b|uvicorn\b|flask\s+run\b|python\S*\s+-m\s+http\.server\b|ng\s+serve\b|dotnet\s+watch\b)|\s--watch(?!\s*=\s*false|All\s*=\s*false)\b/i;
// test runners get CI=true so they run once (no watch mode) and print plainly; not when watch mode is already off
const TEST_RUNNER = /\b(vitest|jest|mocha|ng\s+test|npm\s+(run\s+)?test|pnpm\s+test|yarn\s+test|pytest|playwright\s+test)\b/i;
const WATCH_OFF = /--watch(All)?=false|\bvitest\s+run\b/i;
// PowerShell 5.1 turns a redirected stderr line (git "Cloning into", npm warn, pip WARNING) into an error record
// that fails the step; this shell captures both streams anyway, so the redirection is refused before running
const STDERR_REDIR = /(^|[\s;(|])(2|\*)>{1,2}(&1|\$null|\S)/m;
const PS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const fwd = (p: string) => p.replace(/\\/g, "/");
// the folder a command runs in, as a rule key: the same folder spelt differently gives the same key
const cwdKey = (args: Record<string, any>, ctx: ToolContext) => {
  try { return fwd(workingDir(args.cwd, ctx)).toLowerCase(); } catch { return String(args.cwd ?? "").toLowerCase(); }
};
const timeoutOf = (args: Record<string, any>, fallback: number) => Math.min(Math.max(Number(args.timeout_s) || fallback, 1), 1800) * 1000;
// what is refused without running (and so without an approval card): nothing to approve
function refusal(args: Record<string, any>): string | null {
  const cmd = command(args), code = script(args);
  if (cmd && code) return 'error: send either "command" or a script block, not both';
  if (!cmd && !code) return 'error: nothing to run: send {"command": "..."} or a script in a fenced block';
  const sign = SIGN_IN.exec(cmd + "\n" + code);
  if (sign) {
    return `not run: "${sign[0]}" signs in or asks for input, and this hidden shell has no one to type or confirm, so it ` +
      "would only hang. Signing in is the user's own step: ask the user to run it in their own terminal and tell you when " +
      "it is done, then check (for GitHub: gh auth status).";
  }
  if (cmd && LONG_RUNNING.test(noComments(cmd))) {
    return `not run: "${cmd}" looks like a server or watcher that never ends, and this shell waits for its end. Ask the user ` +
      "(ask_user) to start it in their own terminal and tell you when it is up, then go on (check it with browser open http://localhost:PORT).";
  }
  const redir = STDERR_REDIR.exec(noComments(cmd || code));
  if (redir) {
    return `not run: remove "${redir[0].trim()}": this shell already captures stdout and stderr together, and under PowerShell 5.1 a ` +
      "redirected stderr line (git, npm, pip warnings) becomes an error record that fails the step. Send the command without the redirection.";
  }
  if (code && code.split(/\r?\n/).reverse().find((l) => l.trim())?.trim() !== "# end") {
    return 'error: script incomplete (no "# end" line at the end): the reply was probably cut; send it again, shorter or in two runs';
  }
  return null;
}

const tool: Tool = {
  name: "shell",
  description:
    "Run a PowerShell command and get its output (npm, npx, git, ...). cwd: the folder to run in (a repo under the " +
    "projects folders, or the workspace by default). One line goes in \"command\"; for several steps, quotes, $ variables " +
    'or paths with spaces send {"name": "...", "cwd": "..."} and the script in ONE fenced powershell block ending with a ' +
    "\"# end\" line (PowerShell does not stop on a failed npm/git step: add 'if ($LASTEXITCODE) { exit $LASTEXITCODE }' after " +
    "each step that must succeed). Output is UTF-8, stdout and stderr together (never add 2>&1 or 2>$null); the last line " +
    "is [exit N, T s]: a non-zero code means it failed, read the end of the output first. Commands from install_package work " +
    "here. Prompts (Read-Host, Get-Credential) fail at once and sign-ins (gh auth login, npm login, az login ...) are refused: " +
    "ask me to run those in my own terminal, then check (gh auth status). A test runner gets CI=true (runs once, no watch mode). " +
    "Servers and watchers (npm run dev) never end here: ask me to start them in my terminal. timeout_s: default 600, max 1800. " +
    "Always waits for my approval.",
  args: '{"command": "npm install -D @playwright/test", "cwd": "C:/devl/my-repo"}',
  blockArg: "script",
  runsCode: true,
  processOutput: true,
  needsApproval: (args) => refusal(args) == null, // what is refused never runs, so there is nothing to approve
  alwaysRule: (args, ctx) => {
    const code = script(args);
    if (code && !command(args)) {
      const name = String(args.name ?? "script"), id = sha(code).slice(0, 8);
      return { key: `script:${sha(code).slice(0, 16)}|${cwdKey(args, ctx)}`, label: `this exact script (${name}, ${id})${args.cwd ? ` in ${args.cwd}` : ""}` };
    }
    return { key: `${cwdKey(args, ctx)}|${command(args)}`, label: `the command: ${command(args)}${args.cwd ? ` (in ${args.cwd})` : ""}` };
  },
  run: async (args, ctx) => {
    const refused = refusal(args);
    if (refused) return refused;
    const cmd = command(args), code = script(args);
    let cwd: string;
    try { cwd = workingDir(args.cwd, ctx); } catch (e) { return `error: ${e instanceof Error ? e.message : e}`; }
    const plain = noComments(cmd || code);
    const env = commandEnv(ctx, { ci: TEST_RUNNER.test(plain) && !WATCH_OFF.test(plain) });
    if (cmd) {
      return runProcess("powershell", [...PS, "-Command", PS_PRELUDE + cmd + EXIT_TAIL], { cwd, timeoutMs: timeoutOf(args, 600), env, trailer: true });
    }
    // a script: saved as it is (so a param(...) block stays first) and called from a prelude that sets UTF-8, the
    // fresh PATH and $ErrorActionPreference = 'Stop', so a failed cmdlet ends it; its exit code is passed on
    const name = String(args.name ?? "script").replace(/[^\w-]+/g, "_").slice(0, 40) || "script";
    const dir = path.join(ctx.workspace, ".runs");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}-${sha(code).slice(0, 8)}.ps1`);
    writeFileSync(file, `\uFEFF${code}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }\n`, "utf8"); // UTF-8 with BOM for PowerShell 5.1
    const call = `${PS_PRELUDE}$ErrorActionPreference = 'Stop'; & '${file.replace(/'/g, "''")}'; exit $LASTEXITCODE`;
    const out = await runProcess("powershell", [...PS, "-Command", call], { cwd, timeoutMs: timeoutOf(args, 600), env, trailer: true });
    return `ran script ${name} (${fwd(path.relative(ctx.workspace, file))}) in ${fwd(cwd)}\n${out}`;
  },
};
export default tool;
