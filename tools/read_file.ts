import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fullPath, isSensitive, pathRule, pathWarning, runProcess, trustedForRead, type Tool } from "./_lib.ts";

const OFFICE = /\.(docx|pptx|xlsx)$/i; // read as text through tools/py/read_office.py, to check documents the agent made

const CHUNK = 7000; // characters per read: what fits in one message back to Copilot

// Like GitHub Copilot: any file on the PC; your trusted folders without asking, anywhere else (and any sensitive
// file) after you allow it.
const tool: Tool = {
  name: "read_file",
  description:
    "Read a text file anywhere on the PC: a workspace path (relative) or an absolute path. Files outside the trusted " +
    "folders need the user's approval. Long files come in parts: the reply says which lines you got; ask again with " +
    "start_line for the next part. Read a file fully before replacing it. .docx, .pptx and .xlsx files come as their " +
    "text ([Heading 1] ..., [image] where a picture is, tables, slides, sheets): use it to check a document you made.",
  args: '{"path": "C:/devl/my-repo/playwright.config.ts", "start_line": 1}',
  approvalHint: "your folders run on their own; elsewhere and sensitive files ask first",
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
    let text: string;
    if (OFFICE.test(full)) {
      if (!existsSync(full)) return `no file at ${full}`;
      if (!existsSync(ctx.python)) return "the Python tools are not installed: ask the user to run setup.ps1";
      text = await runProcess(ctx.python, [path.join(ctx.root, "tools", "py", "read_office.py"), full], { cwd: ctx.root, timeoutMs: 60_000 });
    } else {
      text = readFileSync(full, "utf8");
    }
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, Number(args.start_line ?? 1));
    let end = start - 1, size = 0;
    while (end < lines.length && size + lines[end].length + 1 <= CHUNK) size += lines[end++].length + 1;
    if (end === start - 1 && end < lines.length) end++; // a single very long line
    const body = lines.slice(start - 1, end).join("\n");
    const whole = start === 1 && end >= lines.length;
    return whole ? body : `[lines ${start}-${end} of ${lines.length}${end < lines.length ? `; next: start_line ${end + 1}` : ""}]\n${body}`;
  },
};
export default tool;
