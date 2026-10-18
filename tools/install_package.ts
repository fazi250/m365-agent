// Installs what a task needs so the agent can then use it. Always asks: it downloads and runs code.
//   pip (default)  Python packages into the project's venv (.venv), recorded in requirements.txt so they stay part of
//                  the framework (setup.ps1 installs them again on a new machine)
//   npm            Node packages and their commands (newman, ...) into the workspace (workspace/package.json); the
//                  shell tool has workspace/node_modules/.bin on its PATH
//   winget         Windows programs and command-line tools by their exact winget id; search finds the id (no install)
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runProcess, type Tool } from "./_lib.ts";

// plain names only: no URLs, paths, flags or shell characters
const PIP_SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?((==|>=|<=|~=|!=|>|<)[A-Za-z0-9.*+!-]+)?$/;
const NPM_SPEC = /^(@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9.^~*+-]+)?$/;
const WINGET_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const SPEC: Record<string, RegExp> = { pip: PIP_SPEC, npm: NPM_SPEC, winget: WINGET_ID };

const pipName = (spec: string) => spec.split(/[\[<>=!~]/)[0].toLowerCase().replace(/_/g, "-");
const keyName = (manager: string, spec: string) =>
  manager === "pip" ? pipName(spec) : manager === "npm" ? spec.replace(/(.)@.*$/, "$1").toLowerCase() : spec.toLowerCase();
const managerOf = (args: Record<string, any>) => String(args.manager ?? "pip").trim().toLowerCase();
const list = (args: Record<string, any>): string[] =>
  (Array.isArray(args.packages) ? args.packages : String(args.packages ?? args.package ?? "").split(/[\s,]+/))
    .map((s: unknown) => String(s).trim()).filter(Boolean);

// winget draws progress bars and spinners; keep the readable lines
const tidy = (out: string) =>
  out.split(/[\r\n]+/).map((l) => l.trimEnd()).filter((l) => l && !/[█▒]/.test(l) && !/^[\s\-\\|/]*$/.test(l)).join("\n");

const tool: Tool = {
  name: "install_package",
  description:
    "Install something a step needs, then use it. manager \"pip\" (default): Python packages into this framework's " +
    "venv for run_python (added to requirements.txt). manager \"npm\": Node packages and their commands (newman, " +
    "...) into the workspace; run the commands with shell. manager \"winget\": Windows programs and command-line " +
    "tools by exact winget id (jqlang.jq, Git.Git ...); find the id first with {\"manager\": \"winget\", \"search\": " +
    "\"jq\"}. I approve every install.",
  args: '{"packages": ["openpyxl"]}  or  {"manager": "npm", "packages": ["newman"]}  or  {"manager": "winget", "packages": ["jqlang.jq"]}',
  approvalHint: "every install asks; a winget search runs on its own",
  needsApproval: (args) => !(managerOf(args) === "winget" && args.search != null && !list(args).length),
  alwaysRule: (args) => {
    const m = managerOf(args);
    const names = list(args).map((p) => keyName(m, p)).sort();
    return { key: `${m}:${names.join(" ")}`, label: `installing ${names.join(", ")} with ${m}` };
  },
  warning: (args) =>
    managerOf(args) === "winget"
      ? "installs a program on your PC (Windows may ask for admin rights) and accepts its license terms for you"
      : managerOf(args) === "npm"
        ? "downloads packages from npm into the workspace; their install scripts run"
        : null,
  run: async (args, ctx) => {
    const m = managerOf(args);
    if (!SPEC[m]) return 'manager must be "pip", "npm" or "winget"';

    if (m === "winget" && args.search != null && !list(args).length) {
      const q = String(args.search).trim();
      if (!/^[\w .+-]{2,60}$/.test(q)) return "search for a plain name, e.g. jq";
      return tidy(await runProcess("winget", ["search", q, "--source", "winget", "--accept-source-agreements", "--disable-interactivity"], { cwd: ctx.root, timeoutMs: 120_000 }));
    }

    const pkgs = list(args);
    if (!pkgs.length) return 'give the packages, e.g. {"packages": ["openpyxl"]}';
    const bad = pkgs.filter((p) => !SPEC[m].test(p));
    if (bad.length) return `not a plain ${m} package name: ${bad.join(", ")} (no URLs, paths or options)`;

    if (m === "npm") {
      // its own package.json, or npm would walk up and install into this framework's folder
      const manifest = path.join(ctx.workspace, "package.json");
      if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ name: "agent-workspace", private: true }, null, 2) + "\n", "utf8");
      // npm is a .cmd script, which needs a shell; the names were checked above and are quoted
      const out = await runProcess("powershell", ["-NoProfile", "-Command", `npm install --no-fund --no-audit ${pkgs.map((p) => `'${p}'`).join(" ")}`], { cwd: ctx.workspace, timeoutMs: 300_000 });
      if (/\[exit code \d+\]/.test(out)) return out;
      return `${out.split(/\r?\n/).slice(-6).join("\n")}\ninstalled in the workspace (package.json); their commands run in shell`;
    }

    if (m === "winget") {
      const results: string[] = [];
      for (const id of pkgs) {
        const out = await runProcess("winget", [
          "install", "--id", id, "--exact", "--source", "winget", "--silent",
          "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity",
        ], { cwd: ctx.root, timeoutMs: 900_000 });
        results.push(`${id}:\n${tidy(out).split("\n").slice(-8).join("\n")}`);
      }
      return `${results.join("\n\n")}\nnew commands are on the shell tool's PATH from now on`;
    }

    if (!existsSync(ctx.python)) return "the venv is missing: ask the user to run setup.ps1";
    const viaUv = await runProcess("uv", ["pip", "install", "--python", ctx.python, ...pkgs], { cwd: ctx.root, timeoutMs: 300_000 });
    const out = viaUv.includes("[not found: uv]")
      ? await runProcess(ctx.python, ["-m", "pip", "install", ...pkgs], { cwd: ctx.root, timeoutMs: 300_000 })
      : viaUv;
    if (/\[exit code \d+\]/.test(out)) return out;
    // keep them in the framework: add what requirements.txt doesn't list yet
    const reqFile = path.join(ctx.root, "requirements.txt");
    const have = new Set((existsSync(reqFile) ? readFileSync(reqFile, "utf8") : "").split(/\r?\n/).map((l) => pipName(l.trim())).filter(Boolean));
    const added = pkgs.filter((p) => !have.has(pipName(p)));
    if (added.length) appendFileSync(reqFile, added.map((p) => p + "\n").join(""), "utf8");
    return `${out.split(/\r?\n/).slice(-6).join("\n")}\n${added.length ? `added to requirements.txt: ${added.join(", ")}` : "already in requirements.txt"}`;
  },
};
export default tool;
