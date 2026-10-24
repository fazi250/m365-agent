// Syntax check of a file the agent wrote (not loaded as a tool: the leading "_"). It parses only, never runs the
// file, and gives one verdict line that write_file / edit_file put at the end of their RESULT, so Copilot sees a
// broken file at once, like an editor's red squiggle:
//   check: OK (JSON)  ·  SYNTAX ERROR (TypeScript parser) line 12: ...  ·  check: not checked (TS-only syntax)
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { runProcess, type ToolContext } from "./_lib.ts";

export type Check = { status: "ok" | "error" | "skipped"; label: string; text: string };

const ok = (label: string): Check => ({ status: "ok", label, text: `check: OK (${label})` });
const skipped = (label: string, why: string): Check => ({ status: "skipped", label, text: why ? `check: not checked (${why})` : "" });
const error = (label: string, detail: string, cutHint = false): Check => ({
  status: "error", label,
  text: `SYNTAX ERROR (${label}) ${detail}` + (cutHint ? "\nThe content ends mid-way: your reply was probably cut by Copilot's length limit; write a shorter version or append the rest." : ""),
});
const AT_EOF = /eof|end of (file|input|json)|unexpected end|unterminated/i;
const LINE_IN = (s: string) => Number(s.match(/line (\d+)/i)?.[1] ?? s.match(/:(\d+):\d+/)?.[1] ?? 0);
// one program's output, cut before any stack trace, at most 8 lines
const trim = (s: string, file?: string) => {
  const lines = s.replace(/\r/g, "").split("\n").filter((l) => l.trim() && !/^\s+at /.test(l) && !/^\[exit code|^Node\.js v/.test(l));
  return lines.slice(0, 8).join("\n").replace(file ? new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") : /$^/, "<file>").trim();
};

// line and column of a character offset
function lineCol(text: string, pos: number): string {
  const before = text.slice(0, pos);
  const line = before.split("\n").length, col = pos - before.lastIndexOf("\n");
  return `line ${line} col ${col}`;
}

// where a JSON text stops being valid (Node's own message names no position): a small validator that returns the
// offset of the first wrong character, or -1 when the text is fine
export function jsonErrorPos(s: string): number {
  let i = 0;
  const ws = () => { while (i < s.length && /[ \t\n\r]/.test(s[i])) i++; };
  const fail = (at: number): never => { throw at; };
  const str = () => {
    if (s[i] !== '"') fail(i);
    i++;
    while (i < s.length && s[i] !== '"') {
      if (s[i] === "\\") { i++; if (s[i] === "u") { if (!/^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) fail(i); i += 4; } else if (!/["\\/bfnrt]/.test(s[i] ?? "")) fail(i); }
      else if (s.charCodeAt(i) < 0x20) fail(i);
      i++;
    }
    if (s[i] !== '"') fail(i);
    i++;
  };
  const value = (): void => {
    ws();
    const c = s[i];
    if (c === "{") {
      i++; ws();
      if (s[i] === "}") { i++; return; }
      for (;;) { ws(); str(); ws(); if (s[i] !== ":") fail(i); i++; value(); ws(); if (s[i] === ",") { i++; continue; } if (s[i] === "}") { i++; return; } fail(i); }
    }
    if (c === "[") {
      i++; ws();
      if (s[i] === "]") { i++; return; }
      for (;;) { value(); ws(); if (s[i] === ",") { i++; continue; } if (s[i] === "]") { i++; return; } fail(i); }
    }
    if (c === '"') return str();
    const m = s.slice(i).match(/^(-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?|true|false|null)/);
    if (!m) fail(i);
    i += m![0].length;
  };
  try { value(); ws(); if (i < s.length) return i; return -1; } catch (at) { return typeof at === "number" ? at : i; }
}

const PY_AST = "import ast, sys\nsrc = sys.stdin.read()\ntry:\n    ast.parse(src)\n    print('OK')\nexcept SyntaxError as e:\n    print(f'SYNTAX ERROR line {e.lineno}: {e.msg}')\n";

/** text: the content to check (default: the file's); only the file's extension and the text are used */
export async function syntaxCheck(full: string, ctx: ToolContext, text?: string): Promise<Check> {
  const ext = path.extname(full).toLowerCase();
  const content = () => (text ?? readFileSync(full, "utf8")).replace(/^\uFEFF/, "");
  try {
    if (ext === ".json") {
      const src = content();
      try { JSON.parse(src); return ok("JSON"); } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).replace(/,\s*"[\s\S]*" is not valid JSON$/, "").replace(/ in JSON at position \d+.*$/, "");
        const pos = jsonErrorPos(src);
        const where = pos >= 0 ? lineCol(src, pos) + ": " : "";
        return error("JSON", where + msg, AT_EOF.test(msg) || pos >= src.trimEnd().length);
      }
    }
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return await nodeCheck("node --check", full, text, ext);
    if (ext === ".ts" || ext === ".mts" || ext === ".cts") {
      const src = content();
      let stripped: string;
      try {
        stripped = stripTypeScriptTypes(src, { mode: "strip" });
      } catch (e: any) {
        if (e?.code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") return skipped("TypeScript parser", "TS-only syntax such as enum or namespace");
        // the parser names no line; a file that does not end like a finished one was probably cut
        const msg = String(e?.message ?? e).split("\n")[0];
        return error("TypeScript parser", msg, AT_EOF.test(msg) || !/[;}\])]\s*$/.test(src));
      }
      // the stripped text (same line numbers) through node --check: a CommonJS script only when it looks like one
      const esm = ext === ".mts" || ext !== ".cts" && !(/\b(require\s*\(|module\.exports|exports\.\w+\s*=)/.test(stripped) && !/^\s*(import|export)\b/m.test(stripped));
      const tmp = path.join(os.tmpdir(), `m365-check-${process.pid}-${Date.now()}${esm ? ".mjs" : ".cjs"}`);
      writeFileSync(tmp, stripped, "utf8");
      try {
        const r = await nodeCheck("TypeScript parser + node --check", tmp, undefined, esm ? ".mjs" : ".cjs");
        return { ...r, text: r.text.replace(tmp.replace(/\\/g, "/"), "<file>").replace(tmp, "<file>") };
      } finally { rmSync(tmp, { force: true }); }
    }
    if (ext === ".py") {
      if (!ctx.python || !readable(ctx.python)) return skipped("Python", "Python tools not installed");
      // -X utf8: with -I Python ignores PYTHONIOENCODING, and the script comes in on stdin
      const out = await runProcess(ctx.python, ["-I", "-X", "utf8", "-c", PY_AST], { cwd: ctx.root, timeoutMs: 20_000, input: content() });
      const line = out.trim().split("\n").find((l) => l.startsWith("SYNTAX ERROR") || l === "OK") ?? out.trim();
      if (line === "OK") return ok("Python ast");
      const m = line.match(/^SYNTAX ERROR line (\d+): (.*)$/);
      if (!m) return skipped("Python ast", `could not check: ${trim(out).split("\n")[0]}`);
      const src = content(), at = Number(m[1]);
      return error("Python ast", `line ${at}: ${m[2]}`, AT_EOF.test(m[2]) || (src.length > 5000 && at >= src.split("\n").length - 1));
    }
    if (ext === ".ps1" || ext === ".psm1" || ext === ".psd1") {
      const script = path.join(ctx.root, "tools", "ps", "check.ps1");
      const target = text == null ? full : (() => { const t = path.join(os.tmpdir(), `m365-check-${process.pid}-${Date.now()}.ps1`); writeFileSync(t, "\uFEFF" + text, "utf8"); return t; })();
      try {
        const out = await runProcess("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, target], { cwd: ctx.root, timeoutMs: 30_000 });
        const line = out.trim().split("\n")[0]?.trim();
        if (line === "OK") return ok("PowerShell 5.1 parser");
        if (!line?.startsWith("SYNTAX ERROR")) return skipped("PowerShell 5.1 parser", `could not check: ${trim(out).split("\n")[0]}`);
        const detail = out.trim().split("\n").slice(1, 4).map((l) => l.trim()).join("; ");
        return error("PowerShell 5.1 parser", detail, AT_EOF.test(detail) || /missing closing/i.test(detail));
      } finally { if (target !== full) rmSync(target, { force: true }); }
    }
    return skipped("", "");
  } catch (e) {
    return skipped(ext, `could not check: ${e instanceof Error ? e.message : e}`);
  }
}

function readable(p: string): boolean { try { readFileSync(p, { flag: "r" }); return true; } catch { return false; } }

async function nodeCheck(label: string, full: string, text: string | undefined, ext: string): Promise<Check> {
  let target = full, tmp = "";
  if (text != null) { tmp = target = path.join(os.tmpdir(), `m365-check-${process.pid}-${Date.now()}${ext}`); writeFileSync(tmp, text, "utf8"); }
  try {
    const out = await runProcess(process.execPath, ["--check", target], { cwd: path.dirname(target), timeoutMs: 20_000 });
    if (!/\[exit code \d+\]/.test(out)) return ok(label);
    const detail = trim(out, target).replace(/^<file>:(\d+)\n/, "line $1:\n");
    const src = text ?? readFileSync(full, "utf8");
    const at = Number(out.match(/:(\d+)\n/)?.[1] ?? 0);
    return error(label, detail, AT_EOF.test(detail) || (src.length > 5000 && at > 0 && at >= src.split("\n").length - 1));
  } finally { if (tmp) rmSync(tmp, { force: true }); }
}
