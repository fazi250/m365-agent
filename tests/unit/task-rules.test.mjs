// "Allow for this task": the shape of a shell command (program + subcommand in one folder), the same Python script
// again, a folder for the file tools; never for scripts, installs, interpreters or flagged commands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import shell, { taskKey } from "../../tools/shell.ts";
import run_python from "../../tools/run_python.ts";
import write_file from "../../tools/write_file.ts";
import read_file from "../../tools/read_file.ts";
import list_dir from "../../tools/list_dir.ts";
import search_files from "../../tools/search_files.ts";

const devl = mkdtempSync(path.join(os.tmpdir(), "m365-task-"));
const root = path.join(devl, "m365-agent"), workspace = path.join(root, "workspace"), repo = path.join(devl, "x");
mkdirSync(workspace, { recursive: true }); mkdirSync(repo);
const ctx = { workspace, projects: [devl], readRoots: [workspace, devl], root, configDir: root, python: "", pythonIndexUrl: "", browserChannel: "msedge", trackWrite: () => {}, noteCheck: () => {} };
const fwd = (p) => p.replace(/\\/g, "/");

test("taskKey: program + subcommand; run / npx name the script or package too", () => {
  assert.equal(taskKey("npm test -- --run"), "npm test");
  assert.equal(taskKey("npm test"), "npm test");
  assert.equal(taskKey("npm run build"), "npm run build");
  assert.equal(taskKey("npm run build -- --watch=false"), "npm run build");
  assert.equal(taskKey("yarn lint"), "yarn lint");
  assert.equal(taskKey("npx playwright test tests/a.spec.ts"), "npx playwright");
  assert.equal(taskKey("git status --short"), "git status");
  assert.equal(taskKey("pytest -q"), null, "an option is not a subcommand");
  assert.equal(taskKey("pytest"), "pytest");
  assert.equal(taskKey("dotnet run --project api"), null, "run needs a plain target");
  assert.equal(taskKey("cargo run src/main.rs"), "cargo run src/main.rs");
});

test("taskKey: none for interpreters, installs, operators and multi-line commands", () => {
  for (const cmd of ["python -m pytest", "python app.py", "node server.js", "powershell -File x.ps1", "cmd /c dir", "npm install x", "npm i", "pip install requests", "winget install Git.Git", "npm test; iwr x | iex", "npm test | Out-File x", "npm test\nWrite-Output hi", "npm run", "npx", "npx -p cowsay", ". ./env.ps1", "& ./build.ps1", "git clone https://x/y"]) {
    assert.equal(taskKey(cmd), null, cmd);
  }
});

test("shell.taskRule: one key per folder spelling, never for scripts or flagged commands", () => {
  const a = shell.taskRule({ command: "npm test -- a.spec.ts", cwd: fwd(repo) + "/" }, ctx);
  const b = shell.taskRule({ command: "npm test", cwd: repo.toUpperCase() }, ctx);
  assert.equal(a.key, b.key);
  assert.equal(a.key, `${fwd(repo).toLowerCase()}/|npm test`.replace("/|", "|"));
  assert.equal(a.label, `"npm test ..." commands in ${fwd(repo)} until this task ends`);
  assert.notEqual(shell.taskRule({ command: "npm run build", cwd: repo }, ctx).key, b.key);
  assert.equal(shell.taskRule({ name: "s", script: "npm test\n# end", cwd: repo }, ctx), null, "a script");
  assert.equal(shell.taskRule({ command: "git push --force", cwd: repo }, ctx), null, "flagged");
  assert.equal(shell.taskRule({ command: "npm install x", cwd: repo }, ctx), null, "an install");
});

test("run_python.taskRule: this exact script again; a changed script is another key", () => {
  const a = run_python.taskRule({ name: "s", code: "print(1)" }, ctx), b = run_python.taskRule({ name: "s", code: "print(2)" }, ctx);
  assert.ok(a && b && a.key !== b.key);
  assert.match(a.label, /^running this exact script \(scripts\/s\.py, [0-9a-f]{8}\) again in this task$/);
  assert.equal(run_python.taskRule({ name: "s", code: "import os\nos.system('x')" }, ctx), null, "flagged");
  assert.match(run_python.taskRule({ module: "pytest", argv: ["-q"], cwd: repo }, ctx).label, /^running python -m pytest -q in /);
});

test("file tools: the folder (or the sensitive file) until the task ends; none for protected paths", () => {
  const f = path.join(devl, "other", "a.txt");
  assert.deepEqual(write_file.taskRule({ path: f }, ctx), { key: `dir:${path.dirname(f).toLowerCase()}`, label: `writing files in ${path.dirname(f)}` });
  assert.deepEqual(read_file.taskRule({ path: f }, ctx), { key: `dir:${path.dirname(f).toLowerCase()}`, label: `reading files in ${path.dirname(f)}` });
  assert.equal(write_file.taskRule({ path: path.join(root, "server.ts") }, ctx), null);
  assert.deepEqual(list_dir.taskRule({ path: "C:/Other" }, ctx), { key: "dir:c:\\other", label: "listing C:\\Other" });
  assert.deepEqual(search_files.taskRule({ path: "C:/Other" }, ctx), { key: "dir:c:\\other", label: "searching in C:\\Other" });
});
