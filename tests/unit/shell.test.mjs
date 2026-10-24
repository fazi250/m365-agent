// The shell tool on this Windows PC: exit codes that tell the truth, UTF-8, prompts that fail at once, scripts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import shell from "../../tools/shell.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "m365-shell-"));
const workspace = path.join(dir, "workspace"), repo = path.join(dir, "repo");
mkdirSync(workspace); mkdirSync(repo);
const ctx = { workspace, projects: [repo], readRoots: [workspace, repo], root: ROOT, python: path.join(ROOT, ".venv", "Scripts", "python.exe"), pythonIndexUrl: "", browserChannel: "msedge", trackWrite: () => {} };
const run = (args) => shell.run(args, ctx);
const lastLine = (s) => s.trimEnd().split("\n").at(-1);

test("a native program's exit code survives", async () => {
  assert.match(lastLine(await run({ command: "cmd /c exit 3" })), /^\[exit code 3, [\d.]+ s\]$/);
});

test("a failed step before a successful one is not forgotten", async () => {
  const out = await run({ command: "cmd /c exit 3; Write-Output done" });
  assert.ok(out.includes("done"));
  assert.match(lastLine(out), /^\[exit code 3, /);
});

test("a failed cmdlet gives exit code 1", async () => {
  assert.match(lastLine(await run({ command: "Get-Item C:\\this-folder-does-not-exist-m365" })), /^\[exit code 1, /);
});

test("success ends with exit 0 and a trailing comment is harmless", async () => {
  const out = await run({ command: "Write-Output ok # a comment" });
  assert.equal(out, `ok\n${lastLine(out)}`);
  assert.match(lastLine(out), /^\[exit 0, [\d.]+ s\]$/);
});

test("non-ASCII text round-trips as UTF-8", async () => {
  const out = await run({ command: "Write-Output 'héllo ✓ ünïcödé'" });
  assert.equal(out.split("\n")[0], "héllo ✓ ünïcödé");
});

test("a prompt fails at once instead of hanging (Read-Host itself is refused before running)", async () => {
  const out = await run({ command: "$x = $Host.UI.ReadLine()", timeout_s: 20 });
  assert.match(out, /NonInteractive/);
  assert.match(lastLine(out), /^\[exit code 1, /);
  assert.match(await run({ command: "$x = Read-Host 'name'" }), /^not run: "Read-Host"/);
});

test("sign-ins are refused without running", async () => {
  assert.equal(shell.needsApproval({ command: "gh auth login" }, ctx), false);
  assert.match(await run({ command: "gh auth login" }), /^not run: "gh auth login"/);
});

test("servers and watchers are refused with a hint", async () => {
  assert.equal(shell.needsApproval({ command: "npm run dev" }, ctx), false);
  assert.match(await run({ command: "npm run dev", cwd: repo }), /^not run: "npm run dev" looks like a server/);
  assert.equal(shell.needsApproval({ command: "npm test" }, ctx), true);
});

test("a script block runs in cwd with its own variables and keeps the last exit code", async () => {
  const script = "mkdir sub | Out-Null\ncd sub\n$x = 1 + 1\nWrite-Output \"x=$x in $((Get-Location).Path)\"\ncmd /c exit 7\n# end";
  const out = await run({ name: "steps", cwd: repo, script });
  assert.ok(out.startsWith(`ran script steps (.runs/steps-`), out);
  assert.ok(out.includes(`x=2 in ${path.join(repo, "sub")}`), out);
  assert.match(lastLine(out), /^\[exit code 7, /);
  assert.ok(existsSync(path.join(workspace, ".runs")));
});

test("a script stops at a failing cmdlet", async () => {
  const out = await run({ name: "stop", cwd: repo, script: "Get-Item C:\\nope-m365\nWrite-Output 'not reached'\n# end" });
  assert.ok(!out.includes("not reached"));
  assert.match(lastLine(out), /^\[exit code 1, /);
});

test("a script without its # end line is not run", async () => {
  assert.match(await run({ name: "cut", script: "Write-Output 1\nWrite-Output 2" }), /^error: script incomplete/);
  assert.match(await run({ command: "x", script: "y\n# end" }), /^error: send either/);
  assert.match(await run({}), /^error: nothing to run/);
});

test("a script may start with param(...); stderr redirections are refused without a card", async () => {
  const out = await run({ name: "params", cwd: repo, script: "param([int]$n = 5)\nWrite-Output \"n=$n\"\n# end" });
  assert.ok(out.includes("\nn=5\n"), out);
  assert.match(lastLine(out), /^\[exit 0, /);
  assert.match(await run({ command: "git clone x 2>&1" }), /^not run: remove "2>&1"/);
  assert.equal(shell.needsApproval({ command: "npm install 2>$null" }, ctx), false);
  assert.match(await run({ name: "r", script: "cmd /c dir 2>&1 | Out-Null\n# end" }), /^not run: remove "2>&1"/);
  assert.equal(shell.needsApproval({ command: "npm install nodemon" }, ctx), true, "an install is not a watcher");
  assert.equal(shell.needsApproval({ command: "vitest --watch=false" }, ctx), true);
  assert.match(await run({ command: "Write-Output hi", cwd: path.join(repo, "nope") }), /outside the workspace|does not exist/);
});

test("a missing folder is reported as such, not as a missing program", async () => {
  mkdirSync(path.join(repo, "gone"));
  const out = await (async () => { const { rmSync } = await import("node:fs"); rmSync(path.join(repo, "gone"), { recursive: true }); return run({ command: "Write-Output hi", cwd: path.join(repo, "gone") }); })();
  assert.match(out, /^error: the folder .*gone does not exist\n\[exit code 1, 0\.0 s\]$/);
});

test("rule keys: the same folder spelt differently is one key; a script's key is its hash", () => {
  const a = shell.alwaysRule({ command: "npm test", cwd: repo.replace(/\\/g, "/") + "/" }, ctx);
  const b = shell.alwaysRule({ command: "npm test", cwd: repo.toUpperCase() }, ctx);
  assert.equal(a.key, b.key);
  const s1 = shell.alwaysRule({ name: "s", script: "Write-Output 1\n# end" }, ctx), s2 = shell.alwaysRule({ name: "s", script: "Write-Output 2\n# end" }, ctx);
  assert.ok(s1.key.startsWith("script:") && s1.key !== s2.key);
  assert.match(s1.label, /^this exact script \(s, [0-9a-f]{8}\)$/);
});

test("a test runner gets CI=true; watch mode off and a runner named only in a comment do not", async () => {
  const ci = await run({ command: 'if ($false) { npm test }; Write-Output "CI=$env:CI"' });
  assert.ok(ci.startsWith("CI=true"), ci);
  const noCi = await run({ command: 'if ($false) { vitest run }; Write-Output "CI=$env:CI"' });
  assert.ok(noCi.startsWith("CI=\n") || noCi.startsWith("CI=false"), noCi);
  const comment = await run({ command: 'Write-Output "CI=$env:CI" # npm test' });
  assert.ok(comment.startsWith("CI=\n") || comment.startsWith("CI=false"), comment);
});
