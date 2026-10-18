import { readdirSync } from "node:fs";
import path from "node:path";
import { fullPath, pathWarning, trustedForRead, type Tool } from "./_lib.ts";

const SKIP = new Set(["node_modules", "venv", "__pycache__", "dist", "build", "test-results", "playwright-report", "backups"]);
const KEEP_DOT = new Set([".github", ".vscode", ".husky"]); // other dot-folders (.git, .venv, profiles, caches) are skipped
const skipped = (name: string) => SKIP.has(name) || (name.startsWith(".") && !KEEP_DOT.has(name));
const MAX = 400;

const tool: Tool = {
  name: "list_dir",
  description:
    'List a folder anywhere on the PC (workspace path or absolute path; outside the trusted folders needs approval). ' +
    'Folders end with /. recursive: true lists the whole tree (skips node_modules, .git, .venv, build output) to understand a repo.',
  args: '{"path": "C:/devl/my-repo", "recursive": true}',
  approvalHint: "your folders run on their own; elsewhere asks first",
  needsApproval: (args, ctx) => !trustedForRead(fullPath(args.path, ctx), ctx),
  // a folder rule: the listed folder itself
  alwaysRule: (args, ctx) => {
    const full = fullPath(args.path, ctx);
    return { key: `dir:${full.toLowerCase()}`, label: `listing ${full}` };
  },
  warning: (args, ctx) => {
    const full = fullPath(args.path, ctx);
    return trustedForRead(full, ctx) ? null : pathWarning(full, false);
  },
  run: async (args, ctx) => {
    const root = fullPath(args.path, ctx);
    if (!args.recursive) {
      return readdirSync(root, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(empty folder)";
    }
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= MAX) return;
        const rel = path.relative(root, path.join(dir, e.name)).replace(/\\/g, "/");
        if (e.isDirectory()) {
          if (skipped(e.name)) { out.push(`${rel}/ (skipped)`); continue; }
          out.push(`${rel}/`);
          walk(path.join(dir, e.name));
        } else out.push(rel);
      }
    };
    walk(root);
    return (out.join("\n") || "(empty folder)") + (out.length >= MAX ? `\n…(stopped at ${MAX} entries)` : "");
  },
};
export default tool;
