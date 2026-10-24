import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fullPath, isSkippedDir as skipped, pathWarning, trustedForRead, type Tool } from "./_lib.ts";

const MAX = 400;
// a file's size, so Copilot can tell what fits in one read_file (or a batch) before asking for it
const size = (file: string) => { try { const b = statSync(file).size; return b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`; } catch { return ""; } };

const tool: Tool = {
  name: "list_dir",
  description:
    'List a folder anywhere on the PC (workspace path or absolute path; outside the trusted folders needs approval). ' +
    'Folders end with /, files show their size. recursive: true lists the whole tree (skips node_modules, .git, .venv, build output) to understand a repo.',
  args: '{"path": "C:/devl/my-repo", "recursive": true}',
  approvalHint: "your folders run on their own; elsewhere asks first",
  readOnly: true,
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
    const entry = (dir: string, e: { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }, rel = e.name) =>
      e.isSymbolicLink() ? `${rel} (link)` : e.isDirectory() ? `${rel}/` : `${rel}  ${size(path.join(dir, e.name))}`;
    if (!args.recursive) {
      return readdirSync(root, { withFileTypes: true }).map((e) => entry(root, e)).join("\n") || "(empty folder)";
    }
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= MAX) return;
        const rel = path.relative(root, path.join(dir, e.name)).replace(/\\/g, "/");
        if (e.isDirectory() && !e.isSymbolicLink()) {
          if (skipped(e.name)) { out.push(`${rel}/ (skipped)`); continue; }
          out.push(`${rel}/`);
          walk(path.join(dir, e.name));
        } else out.push(entry(dir, e, rel));
      }
    };
    walk(root);
    return (out.join("\n") || "(empty folder)") + (out.length >= MAX ? `\n…(stopped at ${MAX} entries)` : "");
  },
};
export default tool;
