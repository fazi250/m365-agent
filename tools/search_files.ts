// Finds text or files in a folder tree in one step (grep + glob), like an editor's search: the enabler for precise
// edits (find the place, read those lines, edit_file). Read-only; runs in a child process (tools/js/search.mjs) so
// Stop and its 5 s budget bind it. Trusted folders run on their own; elsewhere it asks (Always allow per folder).
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fullPath, isSensitive, pathWarning, runProcess, trustedForRead, type Tool } from "./_lib.ts";

const SKIP_DIRS = ["node_modules", "venv", "__pycache__", "dist", "build", "test-results", "playwright-report", "backups", "coverage", "out", "target"];
// the same files read_file always asks for: here they are listed by name and never searched
const SENSITIVE = "[\\\\/]\\.(ssh|gnupg|aws|azure|kube)([\\\\/]|$)|(^|[\\\\/])\\.env(\\.[\\w-]+)?$|\\.(pem|key|pfx|p12|kdbx|ppk|jks|keystore)$|(^|[\\\\/])id_(rsa|dsa|ecdsa|ed25519)(\\.pub)?$|(^|[\\\\/])\\.(npmrc|pypirc|netrc|git-credentials)$|credentials|secret|password|[\\\\/](Login Data|Cookies|Web Data|Local State)$";
const wide = (full: string) => /^[A-Za-z]:[\\/]?$/.test(full) || full.toLowerCase() === (process.env.USERPROFILE ?? "").toLowerCase();

const tool: Tool = {
  name: "search_files",
  description:
    "Find text or files in a folder tree in one step (like grep). text: a literal (regex: true for a regular " +
    "expression; double every backslash because the call is JSON, e.g. \"\\\\bfoo\"; case-insensitive unless case: true) " +
    'searched in every text file; glob: only file names matching it ("**/*.ts", "src/**/*.{py,md}"); no text = list the ' +
    "files that match the glob. Results are path:line: text with the line numbers read_file uses; context: lines " +
    "around each match. Skips node_modules, .git, build output; sensitive files are listed by name only.",
  args: '{"path": "C:/devl/my-repo", "text": "loginUser(", "glob": "**/*.ts", "context": 1, "max": 50}',
  approvalHint: "your folders run on their own; elsewhere asks first",
  readOnly: true,
  // a sensitive folder itself (.ssh, a secrets/ folder) asks even inside the trusted folders, like read_file would
  needsApproval: (args, ctx) => { const full = fullPath(args.path, ctx); return !trustedForRead(full, ctx) || isSensitive(full); },
  alwaysRule: (args, ctx) => {
    const full = fullPath(args.path, ctx);
    return { key: `dir:${full.toLowerCase()}`, label: `searching in ${full}` };
  },
  taskRule: (args, ctx) => {
    const full = fullPath(args.path, ctx);
    return { key: `dir:${full.toLowerCase()}`, label: `searching in ${full}` };
  },
  warning: (args, ctx) => {
    const full = fullPath(args.path, ctx);
    const parts = [pathWarning(full, trustedForRead(full, ctx)), wide(full) ? "this is a drive root or your user profile: a wide search" : null].filter(Boolean);
    return parts.length ? parts.join("; ") : null;
  },
  run: async (args, ctx) => {
    const root = fullPath(args.path, ctx);
    if (!args.text && !args.glob) return "error: give text (what to find) or glob (which files), or both";
    if (!existsSync(root) || !statSync(root).isDirectory()) return `error: no folder at ${root.replace(/\\/g, "/")}`;
    const request = {
      root, text: args.text == null ? "" : String(args.text), regex: !!args.regex, case: !!args.case, glob: args.glob == null ? "" : String(args.glob),
      context: Number(args.context) || 0, max: Number(args.max) || 50, skipDirs: SKIP_DIRS, sensitive: SENSITIVE,
    };
    const out = await runProcess(process.execPath, [path.join(ctx.root, "tools", "js", "search.mjs")], { cwd: root, timeoutMs: 8000, input: JSON.stringify(request) });
    return out.replace(/\n\[exit code \d+\]$/, (m) => `\nerror: the search failed ${m.trim()}`);
  },
};
export default tool;
