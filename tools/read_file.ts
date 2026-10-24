import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fullPath, isSensitive, pathRule, pathWarning, runProcess, trustedForRead, type Tool } from "./_lib.ts";

const OFFICE = /\.(docx|pptx|xlsx)$/i; // read as text through tools/py/read_office.py, to check documents the agent made

const CHUNK = 7000; // characters per read: what fits in one message back to Copilot

// definition lines per file type, for outline: true (what a file holds, with line numbers, before reading parts of it)
const OUTLINE: [RegExp, RegExp][] = [
  [/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i, /^\s*(export\s+(default\s+)?)?(async\s+)?(function\*?\s+\w+|class\s+\w+|interface\s+\w+|type\s+\w+\s*=|enum\s+\w+|(const|let|var)\s+\w+\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>)|^\s{2,}(public\s+|private\s+|protected\s+)?(static\s+)?(async\s+)?(?!(if|for|while|switch|catch|else|try|do|return|function)\b)\w+\s*\([^)]*\)\s*(:\s*[^{]+)?\{\s*$/],
  [/\.py$/i, /^\s*(async\s+def|def|class)\s+\w+/],
  [/\.(ps1|psm1)$/i, /^\s*function\s+[\w-]+/i],
  [/\.(md|markdown)$/i, /^#{1,6}\s/],
  [/\.(json|ya?ml|toml)$/i, /^ {0,2}"?[\w.-]+"?\s*[:=]/],
  [/\.(cs|java|go|rs|c|cpp|h)$/i, /^\s{0,4}(pub(\(crate\))?\s+)?(public\s+|private\s+|protected\s+|internal\s+|static\s+|func\s+|fn\s+|impl\s+|struct\s+|class\s+|interface\s+|enum\s+|type\s+)[^;]*[{(]/],
];
const FALLBACK = /^\S.*\{\s*$/;

// Like GitHub Copilot: any file on the PC; your trusted folders without asking, anywhere else (and any sensitive
// file) after you allow it.
const tool: Tool = {
  name: "read_file",
  description:
    "Read a text file anywhere on the PC: a workspace path (relative) or an absolute path. Files outside the trusted " +
    "folders need the user's approval. Long files come in parts: start_line and end_line pick the lines (the reply says " +
    "which lines you got and where to continue). outline: true lists the file's definitions (functions, classes, " +
    "headings) with their line numbers: use it first on a long file, then read the lines you need. numbered: true " +
    "prefixes each line with its number. .docx, .pptx and .xlsx files come as their text ([Heading 1] ..., [image] where " +
    "a picture is, tables, slides, sheets): use it to check a document you made.",
  args: '{"path": "C:/devl/my-repo/playwright.config.ts", "start_line": 40, "end_line": 80}',
  approvalHint: "your folders run on their own; elsewhere and sensitive files ask first",
  readOnly: true,
  needsApproval: (args, ctx) => {
    const full = fullPath(args.path, ctx);
    return !trustedForRead(full, ctx) || isSensitive(full);
  },
  alwaysRule: (args, ctx) => pathRule(fullPath(args.path, ctx), "reading"),
  warning: (args, ctx) => {
    const full = fullPath(args.path, ctx);
    return pathWarning(full, trustedForRead(full, ctx));
  },
  run: async (args, ctx) => {
    const full = fullPath(args.path, ctx);
    if (!existsSync(full)) return `no file at ${full.replace(/\\/g, "/")}`;
    let text: string;
    if (OFFICE.test(full)) {
      if (args.outline) return "documents have no outline; read them with start_line";
      if (!existsSync(ctx.python)) return "the Python tools are not installed: ask the user to run setup.ps1";
      text = await runProcess(ctx.python, [path.join(ctx.root, "tools", "py", "read_office.py"), full], { cwd: ctx.root, timeoutMs: 60_000 });
    } else {
      text = readFileSync(full, "utf8").replace(/^\uFEFF/, "");
    }
    const lines = text.split(/\r?\n/);
    if (args.outline) {
      const re = OUTLINE.find(([ext]) => ext.test(full))?.[1] ?? FALLBACK;
      const entries = lines.map((l, i) => (re.test(l) ? `${String(i + 1).padStart(5)}: ${l.trim().slice(0, 120)}` : null)).filter((e): e is string => e != null);
      const from = Math.max(1, Number(args.outline_from) || 1);
      const rest = entries.filter((e) => Number(e.slice(0, 5)) >= from);
      const out = [`[outline of ${lines.length} lines, ${entries.length} entries${from > 1 ? ` (from line ${from})` : ""}; read the body with start_line/end_line]`];
      let size = out[0].length;
      for (const [i, e] of rest.entries()) {
        if (size + e.length + 1 > 6500) { out.push(`…and ${rest.length - i} more; continue with outline_from: ${Number(e.slice(0, 5))}`); break; }
        out.push(e);
        size += e.length + 1;
      }
      if (!entries.length) out.push("(no definitions found; read it with start_line/end_line)");
      return out.join("\n");
    }
    const start = Math.min(Math.max(1, Number(args.start_line) || 1), Math.max(1, lines.length));
    const width = String(lines.length).length;
    const line = (i: number) => (args.numbered ? `${String(i + 1).padStart(width)}| ${lines[i]}` : lines[i]);
    const wanted = Number(args.end_line) ? Math.min(lines.length, Math.max(start, Number(args.end_line))) : lines.length;
    let end = start - 1, size = 0;
    while (end < wanted && size + line(end).length + 1 <= CHUNK) size += line(end++).length + 1;
    if (end === start - 1 && end < wanted) end++; // a single very long line
    const body = lines.slice(start - 1, end).map((_l, i) => line(start - 1 + i)).join("\n");
    const whole = start === 1 && end >= lines.length;
    return whole ? body : `[lines ${start}-${end} of ${lines.length}${end < lines.length ? `; next: start_line ${end + 1}` : ""}]\n${body}`;
  },
};
export default tool;
