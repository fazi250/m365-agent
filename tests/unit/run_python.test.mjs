// run_python: scripts and modules in a chosen folder with arguments, UTF-8 output, exit codes. Needs the venv
// (npm run setup); skipped without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import run_python from "../../tools/run_python.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const python = path.join(ROOT, ".venv", "Scripts", "python.exe");
const dir = mkdtempSync(path.join(os.tmpdir(), "m365-py-"));
const workspace = path.join(dir, "workspace"), repo = path.join(dir, "repo");
mkdirSync(workspace); mkdirSync(repo);
const ctx = { workspace, projects: [repo], readRoots: [workspace, repo], root: ROOT, python, pythonIndexUrl: "", browserChannel: "msedge", trackWrite: () => {} };
const run = (args) => run_python.run(args, ctx);
const lastLine = (s) => s.trimEnd().split("\n").at(-1);
const venv = existsSync(python);

test("code runs in cwd with argv and UTF-8 output; the exit code is kept", { skip: !venv && "no venv" }, async () => {
  const out = await run({ name: "probe", cwd: repo, argv: ["a", "b"], code: "import os, sys\nprint(os.getcwd(), sys.argv[1:], '✓')\nsys.exit(4)\n" });
  assert.ok(out.startsWith(`ran scripts/probe.py a b in ${repo.replace(/\\/g, "/")} (`), out);
  assert.ok(out.includes(`${repo} ['a', 'b'] ✓`), out);
  assert.match(lastLine(out), /^\[exit code 4, [\d.]+ s\]$/);
  assert.ok(existsSync(path.join(workspace, "scripts", "probe.py")));
});

test("a repo module imports from cwd", { skip: !venv && "no venv" }, async () => {
  writeFileSync(path.join(repo, "helper.py"), "VALUE = 42\n");
  const out = await run({ name: "imp", cwd: repo, code: "import helper\nprint(helper.VALUE)\n" });
  assert.ok(out.includes("\n42\n"), out);
  assert.match(lastLine(out), /^\[exit 0, /);
});

test("module: python -m json.tool on a missing file fails", { skip: !venv && "no venv" }, async () => {
  const out = await run({ module: "json.tool", argv: ["nope.json"], cwd: repo });
  assert.ok(out.startsWith("ran python -m json.tool nope.json in "), out);
  assert.match(lastLine(out), /^\[exit code [1-9]/);
});

test("code with a path outside workspace/scripts is refused: no repo file is overwritten", async () => {
  const target = path.join(repo, "keep.py");
  writeFileSync(target, "ORIGINAL = 1\n");
  const out = await run({ path: target.replace(/\\/g, "/"), code: "print('overwritten')" });
  assert.match(out, /^error: code is saved under scripts\/ in the workspace; .*keep\.py is not there/);
  assert.equal(readFileSync(target, "utf8"), "ORIGINAL = 1\n");
  assert.notEqual(run_python.alwaysRule({ name: "a", code: "print(1)" }, ctx).key, run_python.alwaysRule({ path: "scripts/b.py", code: "print(1)" }, ctx).key, "the key names the file");
});

test("bad arguments are refused before anything runs", async () => {
  assert.match(await run({ name: "x", code: "print(1)", cwd: "C:/Windows" }), /outside the workspace/);
  assert.match(await run({ name: "x", code: "print(1)", argv: "a b" }), /^error: argv must be a JSON array/);
  assert.match(await run({ name: "x", code: "print(1)", module: "pytest" }), /^error: send either code/);
  assert.match(await run({ module: "x; rm" }), /^error: module must be/);
  assert.match(await run({ name: "x", code: "print(1)", python: "C:/Windows/py.exe" }), /^error: python must be/);
});

test("rule keys change with the code, the module, cwd and argv", () => {
  const k = (a) => run_python.alwaysRule(a, ctx).key;
  assert.notEqual(k({ name: "a", code: "print(1)" }), k({ name: "a", code: "print(2)" }));
  assert.equal(k({ name: "a", code: "print(1)" }), k({ name: "a", code: "print(1)", cwd: workspace }));
  assert.notEqual(k({ name: "a", code: "print(1)" }), k({ name: "b", code: "print(1)" }), "the script's file is part of the key");
  assert.notEqual(k({ module: "pytest" }), k({ module: "pytest", argv: ["-q"] }));
  assert.notEqual(k({ module: "pytest", cwd: repo }), k({ module: "pytest" }));
  assert.match(run_python.alwaysRule({ module: "pytest", argv: ["-q"], cwd: repo }, ctx).label, /^python -m pytest -q in /);
});
