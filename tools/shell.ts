// Runs PowerShell for the agent: one command, or a script (several steps) sent in a fenced block. The output is
// UTF-8 and ends with one trailer line ([exit 0, 2.3 s] / [exit code 1, 14.2 s] / killed / stopped), and a failed
// step really gives a non-zero code (plain PowerShell forgets a native program's exit code and a cmdlet's failure).
// Always asks. Always allow is offered only for a plain command (one allowlisted program, no operators, no code
// arguments, no URL) and remembers it with its folder; scripts and flagged commands ask every time.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PS_PRELUDE, SIGN_IN, commandEnv, commandFlags, commandTokens, runProcess, workingDir, type Tool, type ToolContext } from "./_lib.ts";

const command = (args: Record<string, any>) => String(args.command ?? "").trim();
const script = (args: Record<string, any>) => (args.script == null ? "" : String(args.script));
const noComments = (s: string) => s.replace(/(^|\s)#.*$/gm, "$1");

// the shape Always allow may remember: one call of a build / test / repo program, nothing that chains, redirects,
// expands or evaluates text, no code given on the command line, no URL
const PLAIN_PROGRAMS = new Set(["npm", "npx", "pnpm", "yarn", "node", "python", "py", "pytest", "dotnet", "cargo", "go", "gh", "git"]);
export function plainCommand(cmd: string): boolean {
  if (/[;|&><`$\r\n]|@\(/.test(cmd)) return false;
  const toks = commandTokens(cmd);
  if (!toks.length) return false;
  if (!PLAIN_PROGRAMS.has(toks[0].toLowerCase().replace(/\.(exe|cmd)$/, ""))) return false;
  return !toks.some((t) => /^-(e|c|ec|eval|command)$/i.test(t) || /^--(eval|command|print)(=|$)/i.test(t) || /^-p$/.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t));
}

// "Allow for this task" remembers the shape of a command, not its exact text: the program and its subcommand (npm test,
// git status, npm run build: one script, not every script) in one folder, so an edit → test → edit loop asks once.
// Never for operators, interpreters and launchers (they run anything), installs, or a command with a flag line.
const INTERPRETERS = new Set(["powershell", "pwsh", "cmd", "node", "python", "py", "python3", "bash", "sh", "wsl", "start", "iex", "invoke-expression", "deno", "bun", "ruby", "perl"]);
const INSTALLERS = new Set(["pip", "pip3", "winget", "choco", "scoop", "uv"]);
const INSTALL_VERBS = new Set(["install", "i", "add", "uninstall", "remove", "rm", "un", "upgrade", "update", "ci", "link", "publish", "exec", "x", "create", "init"]);
const WITH_TARGET = new Set(["npm run", "pnpm run", "yarn run", "dotnet run", "cargo run", "go run"]); // the key names the script / file too
export function taskKey(cmd: string): string | null {
  if (/[;|&><`$\r\n]|@\(/.test(cmd) || /^[.&]/.test(cmd.trim())) return null;
  const toks = commandTokens(cmd);
  if (!toks.length || toks.some((t) => /^[a-z][a-z0-9+.-]*:\/\//i.test(t))) return null; // a URL names what to fetch: ask each time
  const prog = toks[0].toLowerCase().replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|ps1)$/, "");
  if (!/^[a-z][\w.-]*$/.test(prog) || INTERPRETERS.has(prog) || INSTALLERS.has(prog)) return null;
  const sub = toks[1];
  if (prog === "npx") return sub && /^[@\w][\w./@-]*$/.test(sub) && !/^-/.test(sub) ? `npx ${sub}` : null; // one package, whatever it is given
  if (sub == null) return prog;
  if (!/^[a-z][\w:.-]*$/i.test(sub) || INSTALL_VERBS.has(sub.toLowerCase())) return null;
  let key = `${prog} ${sub.toLowerCase()}`;
  if (WITH_TARGET.has(key)) {
    const target = toks[2];
    if (!target || !/^[@\w][\w./:@-]*$/.test(target) || /^-/.test(target)) return null;
    key += ` ${target}`;
  }
  return key;
}

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
    return `not run: "${cmd}" looks like a server or watcher that never ends, and this shell waits for its end. Start it in the ` +
      'background with the process tool instead ({"action": "start", "name": "dev", "command": "...", "cwd": "...", "port": N}), then check it ' +
      "with process output or browser open http://localhost:PORT. If the process tool is not in this chat, ask the user (ask_user) to start it in their own terminal.";
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
    "Servers and watchers (npm run dev) never end here: start them with the process tool. timeout_s: default 600, max 1800. " +
    "Always waits for my approval.",
  args: '{"command": "npm install -D @playwright/test", "cwd": "C:/devl/my-repo"}',
  approvalHint: "always asks; Always allow only for a plain command in its folder, Allow for this task for a command shape",
  blockArg: "script",
  runsCode: true,
  processOutput: true,
  needsApproval: (args) => refusal(args) == null, // what is refused never runs, so there is nothing to approve
  // red lines on the card: downloads, deletes, encoded commands, protected paths ... (and then no Always allow)
  flags: (args, ctx) => commandFlags(command(args) || script(args), ctx, { cwd: args.cwd }),
  // only a plain command (see plainCommand) in its folder; a script or anything else asks every time
  alwaysRule: (args, ctx) => {
    const cmd = command(args);
    if (!cmd || script(args) || !plainCommand(cmd) || commandFlags(cmd, ctx, { cwd: args.cwd }).length) return null;
    return { key: `${cwdKey(args, ctx)}|${cmd}`, label: `the command: ${cmd}${args.cwd ? ` (in ${args.cwd})` : ""}` };
  },
  // "Allow for this task": the same program and subcommand in this folder until the task ends (see taskKey)
  taskRule: (args, ctx) => {
    const cmd = command(args);
    const key = cmd && !script(args) ? taskKey(cmd) : null;
    if (!key || commandFlags(cmd, ctx, { cwd: args.cwd }).length) return null;
    let where = "";
    try { where = workingDir(args.cwd, ctx).replace(/\\/g, "/"); } catch { where = String(args.cwd ?? ""); }
    return { key: `${cwdKey(args, ctx)}|${key}`, label: `"${key} ..." commands in ${where} until this task ends` };
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
