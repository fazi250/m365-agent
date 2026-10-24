// write_file: whole files, parts with append, what the RESULT reports, and the syntax check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import write_file from "../../tools/write_file.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "m365-write-"));
const workspace = path.join(dir, "workspace"), repo = path.join(dir, "repo");
mkdirSync(workspace); mkdirSync(repo);
const tracked = [], checks = [];
const ctx = { workspace, projects: [repo], readRoots: [workspace, repo], root: ROOT, python: path.join(ROOT, ".venv", "Scripts", "python.exe"), pythonIndexUrl: "", browserChannel: "msedge", trackWrite: (p) => tracked.push(p), noteCheck: (p, e) => checks.push([p, e]) };
const run = (args) => write_file.run(args, ctx);
const f = (name) => path.join(repo, name);

test("create: line count, last line and the check", async () => {
  const out = await run({ path: f("a.json"), content: '{\n  "x": 1\n}' });
  assert.equal(out, `created ${f("a.json").replace(/\\/g, "/")} (3 lines; last line: "}")\ncheck: OK (JSON)`);
  assert.equal(readFileSync(f("a.json"), "utf8"), '{\n  "x": 1\n}\n');
});

test("append keeps the file's CRLF and tracks one original; a part skips the check", async () => {
  writeFileSync(f("big.ts"), "const a = 1;\r\n");
  tracked.length = 0;
  const part = await run({ path: f("big.ts"), append: true, more: true, expect_lines: 2, content: "const b = 2;\nconst c = 3;" });
  assert.ok(part.startsWith(`appended 2 lines to ${f("big.ts").replace(/\\/g, "/")} (now 3 lines; last line: "const c = 3;")`), part);
  assert.ok(part.includes("(part written; the syntax check runs after the last part)"));
  const last = await run({ path: f("big.ts"), append: true, expect_lines: 5, content: "export {};" });
  assert.ok(last.includes("WARNING: you expected 5 lines but 1 arrived"), last);
  assert.ok(last.endsWith("check: OK (TypeScript parser + node --check)"), last);
  assert.equal(readFileSync(f("big.ts"), "utf8"), "const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\nexport {};\r\n");
  assert.deepEqual(tracked, [f("big.ts"), f("big.ts")]);
});

test("append to a file that does not exist creates it", async () => {
  const out = await run({ path: f("new.txt"), append: true, content: "x" });
  assert.ok(out.startsWith("created "), out);
  assert.equal(readFileSync(f("new.txt"), "utf8"), "x\n");
});

test("numbered content is refused before anything is tracked or written", async () => {
  tracked.length = 0;
  const out = await run({ path: f("num.txt"), content: " 1| a\n 2| b\n 3| c" });
  assert.match(out, /^error: this looks like numbered read_file output/);
  assert.equal(tracked.length, 0);
  assert.ok(!existsSync(f("num.txt")));
});

test("a broken TypeScript file is written, flagged and noted", async () => {
  checks.length = 0;
  const out = await run({ path: f("broken.ts"), content: "export function f(a: number) {\n  return a +" });
  assert.match(out, /SYNTAX ERROR \(TypeScript parser\)/);
  assert.ok(out.includes("The file is written but broken"));
  assert.ok(existsSync(f("broken.ts")));
  assert.ok(checks.at(-1)[1].startsWith("SYNTAX ERROR"));
});

test("no content: nothing happens", async () => {
  assert.match(await run({ path: f("x.txt") }), /^no content/);
});
