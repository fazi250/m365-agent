// Writes a whole file, like GitHub Copilot's agent: in the workspace or a projects folder without asking, anywhere
// else on the PC (and any sensitive file) after you allow it. Every change is listed in the page with Keep / Undo
// (Undo puts the original back, or removes a file the agent created). Long new files come in parts (append: true),
// since Copilot cuts long replies; the RESULT says what arrived (line count, last line) and ends with the syntax
// check, so a cut or broken file is seen at once. Part of a file that exists: edit_file.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { syntaxCheck } from "./_check.ts";
import { isSensitive, pathRule, pathWarning, writable, type Tool } from "./_lib.ts";

const fwd = (p: string) => p.replace(/\\/g, "/");
const lastLineOf = (text: string) => text.trimEnd().split("\n").at(-1)!.replace(/[`\r]/g, "").slice(0, 80);
// content pasted from a numbered read_file: "  12| line"
const numbered = (text: string) => {
  const nums = text.split("\n").map((l) => l.match(/^\s*(\d+)\| /)?.[1]).filter(Boolean).map(Number);
  return nums.length >= 3 && nums.every((n, i) => !i || n > nums[i - 1]);
};

const tool: Tool = {
  name: "write_file",
  description:
    "Create or replace a whole text file (code, config, markdown, csv, json ...) anywhere on the PC; relative paths go in " +
    "the workspace, absolute paths outside the trusted folders need the user's approval. Send the content in a fenced " +
    "code block right after the JSON (see the rules). Keep one call under ~150 lines / ~6000 characters: Copilot cuts " +
    'long replies. Longer new files go in parts: the first write_file, then write_file with "append": true for each ' +
    'next part ("more": true on every part but the last), giving expect_lines (the lines in that part). To change part ' +
    "of an existing file use edit_file.",
  args: '{"path": "C:/devl/my-repo/tests/login.spec.ts"}',
  approvalHint: "your folders run on their own; elsewhere and sensitive files ask first; Keep or Undo each change",
  blockArg: "content",
  changesFiles: true,
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
    if (numbered(content)) return 'error: this looks like numbered read_file output; send the file without the "NN| " prefixes (nothing was written)';
    const existed = existsSync(full);
    const append = !!args.append && existed;
    // the file's own line ends when adding to it; a code block drops the file's final newline
    const eol = append && /\r\n/.test(readFileSync(full, "utf8").slice(0, 20_000)) ? "\r\n" : "\n";
    content = content.replace(/\r\n?/g, "\n");
    if (content && !content.endsWith("\n")) content += "\n";
    content = content.replace(/\n/g, eol);
    const lines = content ? content.split(eol).length - 1 : 0;
    ctx.trackWrite(full); // before writing: the server keeps the original for Undo
    mkdirSync(path.dirname(full), { recursive: true });
    if (append) appendFileSync(full, content, "utf8");
    else writeFileSync(full, content, "utf8");
    const total = append ? readFileSync(full, "utf8").split(/\r?\n/).length - 1 : lines;
    const out = [append
      ? `appended ${lines} lines to ${fwd(full)} (now ${total} lines; last line: "${lastLineOf(content)}")`
      : `${existed ? "replaced" : "created"} ${fwd(full)} (${lines} lines; last line: "${lastLineOf(content)}")`];
    const expect = Number(args.expect_lines);
    if (expect > 0 && Math.abs(expect - lines) > 1) out.push(`WARNING: you expected ${expect} lines but ${lines} arrived: the block was probably cut by Copilot's length limit; append the rest (append: true)`);
    if (args.more) {
      ctx.noteCheck(full, null); // a part: the check runs after the last one (and the ledger counts the file as written)
      out.push("(part written; the syntax check runs after the last part)");
    } else {
      const check = await syntaxCheck(full, ctx);
      ctx.noteCheck(full, check.status === "error" ? check.text.split("\n")[0] : null);
      if (check.text) out.push(check.text);
      if (check.status === "error") out.push("The file is written but broken: fix it (edit_file, or write_file again) before using it.");
    }
    return out.join("\n");
  },
};
export default tool;
