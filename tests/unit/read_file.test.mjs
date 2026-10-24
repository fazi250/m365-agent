// read_file: line ranges with headers, numbered lines, outlines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import read_file from "../../tools/read_file.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "m365-read-"));
const workspace = path.join(dir, "workspace"), repo = path.join(dir, "repo");
mkdirSync(workspace); mkdirSync(repo);
const ctx = { workspace, projects: [repo], readRoots: [workspace, repo], root: ROOT, python: "", pythonIndexUrl: "", browserChannel: "msedge", trackWrite: () => {}, noteCheck: () => {} };
const run = (args) => read_file.run(args, ctx);
const f = (name, text) => { const p = path.join(repo, name); writeFileSync(p, text); return p; };

test("a whole short file comes as it is; a range gets a header and where to continue", async () => {
  const p = f("a.txt", Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"));
  assert.equal(await run({ path: p }), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"));
  assert.equal(await run({ path: p, start_line: 3, end_line: 5 }), "[lines 3-5 of 20; next: start_line 6]\nline 3\nline 4\nline 5");
  assert.equal(await run({ path: p, start_line: 19 }), "[lines 19-20 of 20]\nline 19\nline 20");
  assert.equal(await run({ path: p, start_line: 2, end_line: 3, numbered: true }), "[lines 2-3 of 20; next: start_line 4]\n 2| line 2\n 3| line 3");
});

test("a long file is chunked by characters with a next pointer", async () => {
  const p = f("long.txt", Array.from({ length: 2000 }, (_, i) => `line number ${i + 1}`).join("\n"));
  const out = await run({ path: p });
  assert.match(out, /^\[lines 1-\d+ of 2000; next: start_line \d+\]\n/);
  assert.ok(out.length <= 7000 + 60);
});

test("outline of TypeScript, Python and Markdown files", async () => {
  const ts = f("o.ts", "import x from 'y';\n\nexport async function loginUser(email: string) {\n  return 1;\n}\nconst helper = (a) => a;\nexport class Auth {\n  constructor() {}\n  async check(token: string): Promise<boolean> {\n    return true;\n  }\n}\ntype T = { a: 1 };\n");
  const out = await run({ path: ts, outline: true });
  assert.ok(out.startsWith("[outline of 14 lines, 5 entries; read the body with start_line/end_line]"), out);
  assert.ok(out.includes("    3: export async function loginUser(email: string) {"), out);
  assert.ok(out.includes("    9: async check(token: string): Promise<boolean> {"), out);
  assert.ok(out.includes("   13: type T = { a: 1 };"), out);
  const py = f("o.py", "import os\n\nclass A:\n    def f(self):\n        pass\n\nasync def main():\n    pass\n");
  assert.ok((await run({ path: py, outline: true })).includes("    3: class A:\n    4: def f(self):\n    7: async def main():"));
  const md = f("o.md", "# Title\ntext\n## Part\n### Sub\n");
  assert.ok((await run({ path: md, outline: true })).includes("    1: # Title\n    3: ## Part\n    4: ### Sub"));
  assert.ok((await run({ path: f("o.docx", "x"), outline: true })).startsWith("documents have no outline"));
});

test("outline_from continues a long outline", async () => {
  const p = f("many.py", Array.from({ length: 900 }, (_, i) => `def function_number_${i + 1}_with_a_long_name_to_fill_the_outline_budget():\n    pass`).join("\n"));
  const first = await run({ path: p, outline: true });
  const m = first.match(/…and (\d+) more; continue with outline_from: (\d+)/);
  assert.ok(m, first.slice(-200));
  const second = await run({ path: p, outline: true, outline_from: Number(m[2]) });
  assert.ok(second.includes(`(from line ${m[2]})`));
  assert.ok(second.includes(`${m[2]}: def function_number_`));
});

test("a missing file says so", async () => {
  assert.match(await run({ path: path.join(repo, "nope.txt") }), /^no file at /);
});
