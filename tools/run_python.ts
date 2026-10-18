// Runs a Python script with the framework's venv, in the workspace. Give the code (saved as scripts/<name>.py in the
// workspace, so it stays with the work) or the path of a script already in the workspace. Always asks: it runs code.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inWorkspace, runProcess, type Tool } from "./_lib.ts";

const scriptPath = (args: Record<string, any>) => String(args.path ?? `scripts/${String(args.name ?? "script").replace(/[^\w-]+/g, "_")}.py`);

const tool: Tool = {
  name: "run_python",
  description:
    "Run Python in this framework's venv with the workspace as the current folder (create files there). Send " +
    '{"name": "make_chart"} with the code in a fenced code block right after the JSON: it is saved as ' +
    'scripts/make_chart.py and run. {"path": "scripts/x.py"} runs an existing one. If a package is missing, use install_package first.',
  args: '{"name": "count_rows"}',
  needsApproval: () => true,
  runsCode: true,
  blockArg: "code",
  // remembered by content: the same script text runs again without asking; a changed script asks again
  alwaysRule: (args, ctx) => {
    let code = args.code != null ? String(args.code) : "";
    if (args.code == null) {
      try { code = readFileSync(inWorkspace(scriptPath(args), ctx), "utf8"); } catch { code = `missing:${scriptPath(args)}:${Date.now()}`; }
    }
    const hash = createHash("sha256").update(code).digest("hex").slice(0, 16);
    return { key: hash, label: `this exact script (${scriptPath(args)}, ${hash.slice(0, 8)})` };
  },
  run: async (args, ctx) => {
    if (!existsSync(ctx.python)) return "the venv is missing: ask the user to run setup.ps1";
    const file = inWorkspace(scriptPath(args), ctx);
    if (args.code != null) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, String(args.code), "utf8");
    } else if (!existsSync(file)) {
      return `no script at ${path.relative(ctx.workspace, file)}; send the code`;
    }
    const out = await runProcess(ctx.python, [file], { cwd: ctx.workspace, timeoutMs: 300_000 });
    return `ran ${path.relative(ctx.workspace, file)}\n${out}`;
  },
};
export default tool;
