// Runs Python with the framework's venv (or a repo's own venv given as "python"). Give the code (saved as
// scripts/<name>.py in the workspace, so it stays with the work), the path of a script in the workspace or a repo, or a
// module (python -m pytest ...). cwd: the folder to run in (workspace by default, or a repo under projects); argv: its
// arguments. Output is UTF-8 and ends with [exit N, T s]. Always asks: it runs code.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { syntaxCheck } from "./_check.ts";
import { commandEnv, fullPath, runProcess, trustedForWrite, workingDir, type Tool, type ToolContext } from "./_lib.ts";

const fwd = (p: string) => p.replace(/\\/g, "/");
// with code: always scripts/<name>.py in the workspace (the only place this tool writes; a repo file is changed with
// edit_file / write_file, with Keep / Undo); without code: any script in the workspace or a repo
const scriptFile = (args: Record<string, any>, ctx: ToolContext) => {
  const name = `scripts/${String(args.name ?? "script").replace(/[^\w-]+/g, "_")}.py`;
  const full = fullPath(args.code != null && args.path == null ? name : String(args.path ?? name), ctx);
  if (!trustedForWrite(full, ctx)) throw new Error(`${full} is outside the workspace and the projects folders`);
  if (args.code != null && !full.toLowerCase().startsWith(path.join(ctx.workspace, "scripts").toLowerCase() + path.sep)) {
    throw new Error(`code is saved under scripts/ in the workspace; ${fwd(full)} is not there. To change that file use edit_file or write_file, then run it with "path" only`);
  }
  return full;
};
const moduleOf = (args: Record<string, any>) => (args.module == null ? "" : String(args.module).trim());
const argvOf = (args: Record<string, any>): string[] | null => (args.argv == null ? [] : Array.isArray(args.argv) ? args.argv.map(String) : null);
// the Python to run: the framework's venv, or one inside the workspace / a repo ("python": "C:/devl/x/.venv/Scripts/python.exe")
const pythonOf = (args: Record<string, any>, ctx: ToolContext) => {
  if (args.python == null) return ctx.python;
  const full = fullPath(args.python, ctx);
  if (!/\.exe$/i.test(full) || !trustedForWrite(full, ctx)) throw new Error(`python must be a python.exe inside the workspace or a projects folder, not ${full}`);
  return full;
};

const tool: Tool = {
  name: "run_python",
  description:
    "Run Python in this framework's venv with the workspace as the current folder (create files there). Send " +
    '{"name": "make_chart"} with the code in a fenced code block right after the JSON: it is saved as ' +
    'scripts/make_chart.py and run. {"path": "scripts/x.py"} runs an existing script (in the workspace or a repo). ' +
    '{"module": "pytest", "argv": ["-q", "tests"], "cwd": "C:/devl/my-repo"} runs python -m <module> there without code. ' +
    "cwd: a repo folder to run in; argv: arguments; timeout_s: default 300. One-shot: no servers or watchers. The output " +
    "ends with [exit N, T s]: non-zero means it failed. A repo's own venv must exist first (shell: python -m venv .venv) " +
    'and is passed as "python"; install packages with install_package, not -m pip. If a package is missing, use install_package first.',
  args: '{"name": "count_rows"}',
  needsApproval: () => true,
  runsCode: true,
  processOutput: true,
  blockArg: "code",
  // a script with a syntax error is refused before the approval card: nothing to approve, nothing written
  precheck: async (args, ctx) => {
    if (args.code == null || moduleOf(args)) return null;
    const check = await syntaxCheck("script.py", ctx, String(args.code));
    return check.status === "error" ? `not run: ${String(args.path ?? `scripts/${args.name ?? "script"}.py`)} has a ${check.text.split("\n")[0]}; fix the code and send it again` : null;
  },
  // remembered by content: the same script text (or module), arguments and folder run again without asking;
  // a changed script asks again
  alwaysRule: (args, ctx) => {
    const mod = moduleOf(args);
    let code = args.code != null ? String(args.code) : "";
    if (!mod && args.code == null) {
      try { code = readFileSync(scriptFile(args, ctx), "utf8"); } catch { code = `missing:${String(args.path ?? args.name)}:${Date.now()}`; }
    }
    let file = "";
    if (!mod) { try { file = fwd(scriptFile(args, ctx)).toLowerCase(); } catch { file = String(args.path ?? args.name ?? ""); } }
    const hash = createHash("sha256").update(mod ? `module:${mod}` : `${file}\n${code}`).digest("hex").slice(0, 16);
    let cwd = "", py = "";
    try { cwd = fwd(workingDir(args.cwd, ctx)).toLowerCase(); } catch { cwd = String(args.cwd ?? "").toLowerCase(); }
    try { py = fwd(pythonOf(args, ctx)).toLowerCase(); } catch { py = String(args.python ?? "").toLowerCase(); }
    const argv = (argvOf(args) ?? []).join(" ");
    const what = mod ? `python -m ${mod}` : `this exact script (${String(args.path ?? `scripts/${args.name ?? "script"}.py`)}, ${hash.slice(0, 8)})`;
    return { key: `${hash}|${mod}|${cwd}|${py}|${argv}`, label: `${what}${argv ? ` ${argv}` : ""}${args.cwd ? ` in ${args.cwd}` : ""}` };
  },
  run: async (args, ctx) => {
    let python: string;
    try { python = pythonOf(args, ctx); } catch (e) { return `error: ${e instanceof Error ? e.message : e}`; }
    if (!existsSync(python)) return args.python == null ? "the venv is missing: ask the user to run setup.ps1" : `error: no Python at ${fwd(python)}`;
    const argv = argvOf(args);
    if (!argv) return "error: argv must be a JSON array of strings";
    if (argv.length > 50 || argv.some((a) => a.length > 500)) return "error: argv: at most 50 arguments of 500 characters each";
    const mod = moduleOf(args);
    if (mod && args.code != null) return "error: send either code (a script) or module, not both";
    if (mod && !/^[\w.]+$/.test(mod)) return "error: module must be a Python module name (pytest, json.tool ...)";
    let cwd: string;
    try { cwd = workingDir(args.cwd, ctx); } catch (e) { return `error: ${e instanceof Error ? e.message : e}`; }
    const env = commandEnv(ctx);
    let cmdArgs: string[], what: string;
    if (mod) {
      cmdArgs = ["-X", "utf8", "-m", mod, ...argv];
      what = `python -m ${mod}`;
    } else {
      let file: string;
      try { file = scriptFile(args, ctx); } catch (e) { return `error: ${e instanceof Error ? e.message : e}`; }
      if (args.code != null) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, String(args.code), "utf8");
      } else if (!existsSync(file)) {
        return `no script at ${fwd(file)}; send the code`;
      }
      // Python puts the script's folder on sys.path, not the working folder: add it, so a repo's modules import
      if (path.dirname(file).toLowerCase() !== cwd.toLowerCase()) env.PYTHONPATH = [cwd, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
      cmdArgs = ["-X", "utf8", file, ...argv];
      what = fwd(path.relative(ctx.workspace, file).startsWith("..") ? file : path.relative(ctx.workspace, file));
    }
    const timeoutMs = Math.min(Math.max(Number(args.timeout_s) || 300, 1), 3600) * 1000;
    const out = await runProcess(python, cmdArgs, { cwd, timeoutMs, env, trailer: true });
    return `ran ${what}${argv.length ? ` ${argv.join(" ")}` : ""} in ${fwd(cwd)} (${fwd(python)} ${cmdArgs.map(fwd).join(" ")})\n${out}`;
  },
};
export default tool;
