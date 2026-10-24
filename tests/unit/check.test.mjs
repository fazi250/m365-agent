// The syntax check behind write_file / edit_file / run_python's precheck: parse only, one verdict line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jsonErrorPos, syntaxCheck } from "../../tools/_check.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "m365-check-"));
const python = path.join(ROOT, ".venv", "Scripts", "python.exe");
const ctx = { workspace: dir, projects: [], readRoots: [dir], root: ROOT, python, pythonIndexUrl: "", browserChannel: "msedge", trackWrite: () => {}, noteCheck: () => {} };
const f = (name, text) => { const p = path.join(dir, name); writeFileSync(p, text); return p; };
const check = (name, text) => syntaxCheck(f(name, text), ctx);

test("JSON: good, bad with line and column, cut at the end", async () => {
  assert.equal((await check("a.json", '{"a": [1, 2]}')).text, "check: OK (JSON)");
  const bad = await check("b.json", '{"a": 1,\n  "b": }\n');
  assert.equal(bad.status, "error");
  assert.match(bad.text, /^SYNTAX ERROR \(JSON\) line 2 col 8: /);
  const cut = await check("c.json", '{"a": 1,\n  "b": [1, 2');
  assert.ok(cut.text.includes("your reply was probably cut"), cut.text);
  assert.equal(jsonErrorPos('{"a": 1}'), -1);
  assert.equal(jsonErrorPos('{"a": 1,}'), 8);
  assert.equal(jsonErrorPos('[1, 2'), 5);
});

test("JavaScript: good and bad, the message names the line", async () => {
  assert.equal((await check("a.mjs", "export const x = 1;\n")).text, "check: OK (node --check)");
  assert.equal((await check("a.cjs", "module.exports = { x: 1 };\n")).status, "ok");
  const bad = await check("b.mjs", "const x = 1;\nlet = ;\nconst y = 2;\n");
  assert.equal(bad.status, "error");
  assert.match(bad.text, /^SYNTAX ERROR \(node --check\) line 2:\nlet = ;\n/);
  assert.ok(!/\n\s+at /.test(bad.text), "no stack trace");
  assert.ok(!bad.text.includes("probably cut"));
  const cut = await check("cut.mjs", "export function f(a) {\n  return a +");
  assert.ok(cut.text.includes("probably cut"), cut.text);
});

test("TypeScript: types are stripped and the result checked; ESM cut mid-function is reported; enum is skipped", async () => {
  assert.equal((await check("a.ts", "export const x: number = 1;\nfunction g(): void {}\n")).text, "check: OK (TypeScript parser + node --check)");
  const cut = await check("cut.ts", "import x from 'y';\nexport function f(a: number) {\n  return a +");
  assert.equal(cut.status, "error");
  assert.match(cut.text, /^SYNTAX ERROR \(TypeScript parser\)/);
  assert.ok(cut.text.includes("probably cut"), cut.text);
  const cjsShape = await check("c.ts", "const x: number = require('a');\nmodule.exports = x;\n");
  assert.equal(cjsShape.status, "ok", cjsShape.text);
  const en = await check("e.ts", "enum E { A }\n");
  assert.equal(en.status, "skipped");
  assert.equal(en.text, "check: not checked (TS-only syntax such as enum or namespace)");
  const esmBad = await check("esm.ts", "export const a: number = 1;\nexport function f() {\n  return (;\n}\n");
  assert.equal(esmBad.status, "error");
  assert.match(esmBad.text, /^SYNTAX ERROR \(TypeScript parser\) /);
  assert.ok(!esmBad.text.includes("probably cut"), esmBad.text);
  assert.ok(!readdirSync(os.tmpdir()).some((n) => n.startsWith(`m365-check-${process.pid}-`)), "temp files removed");
});

test("Python: ast.parse, good and bad; from text without a file", { skip: !existsSync(python) && "no venv" }, async () => {
  assert.equal((await check("a.py", "def f():\n    return 1\n")).text, "check: OK (Python ast)");
  const bad = await syntaxCheck("x.py", ctx, "def f(:\n    pass\n");
  assert.equal(bad.status, "error");
  assert.match(bad.text, /^SYNTAX ERROR \(Python ast\) line 1: /);
  assert.ok(!existsSync(path.join(dir, "__pycache__")));
});

test("PowerShell: the parser, good and bad", async () => {
  assert.equal((await check("a.ps1", "Write-Output 'hi'\nif ($x) { 1 }\n")).text, "check: OK (PowerShell 5.1 parser)");
  const bad = await check("b.ps1", "if ($x) {\n  Write-Output 1\n");
  assert.equal(bad.status, "error");
  assert.match(bad.text, /^SYNTAX ERROR \(PowerShell 5.1 parser\) line \d+:\d+ /);
});

test("other files are not checked and say nothing", async () => {
  const r = await check("a.txt", "anything");
  assert.equal(r.status, "skipped");
  assert.equal(r.text, "");
});
