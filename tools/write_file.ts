// Writes a whole file (no partial edits), like GitHub Copilot's agent: in the workspace or a projects folder without
// asking, anywhere else on the PC (and any sensitive file) after you allow it. Every change is listed in the page
// with Keep / Undo (Undo puts the original back, or removes a file the agent created).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isSensitive, pathRule, pathWarning, writable, type Tool } from "./_lib.ts";

const tool: Tool = {
  name: "write_file",
  description:
    "Create or replace a whole text file anywhere on the PC (code, config, markdown, csv, json ...). Always the complete " +
    "file, never a fragment. Relative paths go in the workspace; absolute paths outside the trusted folders need the " +
    "user's approval. Send the content in a fenced code block right after the JSON (see the rules).",
  args: '{"path": "C:/devl/my-repo/tests/login.spec.ts"}',
  approvalHint: "your folders run on their own; elsewhere and sensitive files ask first; Keep or Undo each change",
  blockArg: "content",
  needsApproval: (args, ctx) => {
    const { full, trusted } = writable(args.path, ctx);
    return !trusted || isSensitive(full);
  },
  alwaysRule: (args, ctx) => pathRule(writable(args.path, ctx).full, "writing"),
  warning: (args, ctx) => {
    const { full, trusted } = writable(args.path, ctx);
    return pathWarning(full, trusted)?.replace("what is read goes into the Copilot chat", "the file will be created or replaced") ?? null;
  },
  run: async (args, ctx) => {
    if (args.content == null) return "no content: put the whole file in a fenced code block right after the JSON";
    const { full } = writable(String(args.path ?? ""), ctx);
    let content = String(args.content);
    if (content && !content.endsWith("\n")) content += "\n"; // a code block drops the file's final newline
    const existed = existsSync(full);
    ctx.trackWrite(full); // before writing: the server keeps the original for Undo
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
    const lines = content ? content.split(/\r?\n/).length - 1 : 0; // content always ends with a newline here
    return `${existed ? "replaced" : "created"} ${full} (${lines} lines)`;
  },
};
export default tool;
