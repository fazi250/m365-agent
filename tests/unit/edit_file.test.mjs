// edit_file: SEARCH/REPLACE blocks applied to a file, all or nothing, with the file's own line ends and BOM kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import edit_file, { applyEdits, parseEdits } from "../../tools/edit_file.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "m365-edit-"));
const workspace = path.join(dir, "workspace"), repo = path.join(dir, "repo");
mkdirSync(workspace); mkdirSync(repo);
const tracked = [], checks = [];
const ctx = { workspace, projects: [repo], readRoots: [workspace, repo], root: ROOT, python: path.join(ROOT, ".venv", "Scripts", "python.exe"), pythonIndexUrl: "", browserChannel: "msedge", trackWrite: (p) => tracked.push(p), noteCheck: (p, e) => checks.push([p, e]) };
const block = (...edits) => edits.map(([s, r]) => `<<<<<<< SEARCH\n${s}\n=======\n${r}\n>>>>>>> REPLACE`).join("\n");
const file = (name, text) => { const p = path.join(repo, name); writeFileSync(p, text); return p; };
const run = (p, edits) => edit_file.run({ path: p, edits }, ctx);

test("parseEdits: a block with two edits; markers out of place are errors", () => {
  const r = parseEdits(block(["a", "b"], ["c\nd", ""]));
  assert.deepEqual(r.edits, [{ search: ["a"], replace: ["b"] }, { search: ["c", "d"], replace: [""] }]);
  assert.match(parseEdits("<<<<<<< SEARCH\na\n<<<<<<< SEARCH\n").error, /marker line inside SEARCH #1 \(line 3/);
  assert.match(parseEdits("hello").error, /text outside the SEARCH\/REPLACE markers at line 1/);
  assert.match(parseEdits("<<<<<<< SEARCH\na\n=======\nb").error, /edit #1 is not closed/);
  assert.match(parseEdits("").error, /no edits/);
  assert.match(parseEdits(block(["", "x"])).error, /SEARCH #1 is empty/);
});

test("one edit in a CRLF file keeps CRLF; trackWrite is called once, before the write", async () => {
  const p = file("a.txt", "one\r\ntwo\r\nthree\r\n");
  tracked.length = 0;
  const out = await run(p, block(["two", "TWO\nand a half"]));
  assert.ok(out.startsWith(`edited ${p.replace(/\\/g, "/")}: 1 edit(s), -1 +2 lines (now 4 lines)`), out);
  assert.ok(out.includes("--- lines 1-4 after edit #1 ---\none\nTWO\nand a half\nthree"), out);
  assert.equal(readFileSync(p, "utf8"), "one\r\nTWO\r\nand a half\r\nthree\r\n");
  assert.deepEqual(tracked, [p]);
});

test("a BOM survives an edit of the first line", async () => {
  const p = file("bom.txt", "\uFEFFfirst\nsecond\n");
  await run(p, block(["first", "FIRST"]));
  assert.equal(readFileSync(p, "utf8"), "\uFEFFFIRST\nsecond\n");
});

test("two edits in one block, positions shift correctly", async () => {
  const p = file("two.txt", "l1\nl2\nl3\nl4\nl5\n");
  const out = await run(p, block(["l4", "L4a\nL4b"], ["l1", ""]));
  assert.equal(readFileSync(p, "utf8"), "\nl2\nl3\nL4a\nL4b\nl5\n");
  assert.ok(out.includes("after edit #1") && out.includes("after edit #2"));
});

test("an ambiguous SEARCH changes nothing and names the places", async () => {
  const p = file("amb.txt", "x\ny\nx\n");
  const out = await run(p, block(["x", "z"]));
  assert.match(out, /^error: SEARCH #1 matches 2 places \(lines 1, 3\)/);
  assert.equal(readFileSync(p, "utf8"), "x\ny\nx\n");
});

test("no match names the closest line; nothing is written", async () => {
  const p = file("nomatch.txt", "function loginUser() {\n  return 1;\n}\n");
  tracked.length = 0;
  const out = await run(p, block(["function loginUser(email) {", "x"]));
  assert.match(out, /^error: no match for SEARCH #1; closest is line 1: "function loginUser\(\) \{"/);
  assert.equal(tracked.length, 0);
});

test("overlapping edits are refused", () => {
  const r = applyEdits(["a", "b", "c"], [{ search: ["a", "b"], replace: ["x"] }, { search: ["b", "c"], replace: ["y"] }]);
  assert.match(r.error, /^error: edits #1 and #2 overlap/);
});

test("the same lines at another indentation match once, with one constant shift for the replacement", async () => {
  const p = file("indent.py", "class A:\n    def f(self):\n        pass\n\n    def g(self):\n        pass\n");
  const out = await run(p, block(["def f(self):\n    pass", "def f(self):\n    return 1"]));
  assert.ok(!out.startsWith("error"), out);
  assert.equal(readFileSync(p, "utf8"), "class A:\n    def f(self):\n        return 1\n\n    def g(self):\n        pass\n");
});

test("a blank first SEARCH line and an indentation-only line in the middle are fine; the shift comes from the first real line", async () => {
  const p = file("blank.py", "class A:\n    x = 1\n\n    def f(self):\n        a = 1\n  \n        return a\n");
  const out = await run(p, block(["\ndef f(self):\n    a = 1\n\n    return a", "\ndef f(self):\n    return 2"]));
  assert.ok(!out.startsWith("error"), out);
  assert.equal(readFileSync(p, "utf8"), "class A:\n    x = 1\n\n    def f(self):\n        return 2\n");
});

test("a SEARCH whose relative indentation does not match the file is refused, and the file is untouched", async () => {
  const text = "export class A {\n  f() {\n    if (x) {\n      return 1;\n    }\n  }\n}\n";
  const p = file("flat.ts", text);
  const out = await run(p, block(["f() {\nif (x) {\nreturn 1;\n}\n}", "f() {\nif (x) {\nreturn 2;\n}\n}"]));
  assert.match(out, /^error: no match for SEARCH #1; closest is line 2: "f\(\) \{"\. the lines match only after ignoring their indentation/);
  assert.equal(readFileSync(p, "utf8"), text);
  const py = file("flat.py", "class A:\n    def f(self):\n        if x:\n            return 1\n");
  assert.match(await run(py, block(["def f(self):\nif x:\nreturn 1", "def f(self):\nreturn 2"])), /^error: no match/);
});

test("non-UTF-8 and UTF-16 files are refused, untouched", async () => {
  const ansi = path.join(repo, "ansi.txt");
  writeFileSync(ansi, Buffer.from([0x68, 0xe9, 0x0a, 0x78, 0x0a])); // "hé\nx\n" in cp1252
  assert.match(await run(ansi, block(["x", "y"])), /^error: .*ansi\.txt is not UTF-8 text/);
  assert.deepEqual([...readFileSync(ansi)], [0x68, 0xe9, 0x0a, 0x78, 0x0a]);
  const wide = path.join(repo, "wide.txt");
  writeFileSync(wide, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("x\n", "utf16le")]));
  assert.match(await run(wide, block(["x", "y"])), /^error: .*wide\.txt is UTF-16 text/);
});

test("counts and labels come from the edits, not a whole-file diff", async () => {
  const p = file("big.txt", Array.from({ length: 3000 }, (_, i) => `row ${i + 1}`).join("\n") + "\n");
  const out = await run(p, block(["row 2900", "ROW 2900"], ["row 10", "ROW 10\nrow 10b"]));
  assert.ok(out.startsWith(`edited ${p.replace(/\\/g, "/")}: 2 edit(s), -2 +3 lines (now 3001 lines)`), out.split("\n")[0]);
  assert.ok(out.indexOf("after edit #2 ---") < out.indexOf("after edit #1 ---"), "labels keep the edit numbers, shown in file order");
});

test("the RESULT ends with the syntax check; a broken file is flagged in noteCheck", async () => {
  const p = file("b.json", '{"a": 1}\n');
  checks.length = 0;
  const bad = await run(p, block(['{"a": 1}', '{"a": 1,}']));
  assert.match(bad, /SYNTAX ERROR \(JSON\) line 1 col \d+: /);
  assert.ok(bad.includes("The file is written but broken"));
  assert.ok(checks[0][1].startsWith("SYNTAX ERROR (JSON)"));
  const good = await run(p, block(['{"a": 1,}', '{"a": 2}']));
  assert.ok(good.endsWith("check: OK (JSON)"), good);
  assert.equal(checks[1][1], null);
});

test("numbered read_file output is refused; a missing file points to write_file", async () => {
  const p = file("n.txt", "a\nb\nc\nd\n");
  assert.match(await run(p, block(["1| a\n2| b\n3| c", "x"])), /^error: the SEARCH lines look like numbered/);
  assert.match(await run(path.join(repo, "missing.txt"), block(["a", "b"])), /^error: no file at .*missing\.txt: use write_file/);
  assert.match(await edit_file.run({ path: p }, ctx), /^no edits/);
});
