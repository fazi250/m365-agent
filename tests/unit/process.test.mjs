// The process tool: start a server in the background, wait for its port, read its output, probe, stop; the task Stop
// leaves it alone; bad input is refused before anything runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import processTool from "../../tools/process.ts";
import shell from "../../tools/shell.ts";
import { stopProcesses } from "../../tools/_lib.ts";
import { listBackground, probePort, stopAllBackground } from "../../tools/_procs.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "m365-proc-"));
const workspace = path.join(dir, "workspace"), repo = path.join(dir, "repo");
mkdirSync(workspace); mkdirSync(repo);
const ctx = { workspace, projects: [repo], readRoots: [workspace, repo], root: ROOT, configDir: dir, python: "", pythonIndexUrl: "", browserChannel: "msedge", trackWrite: () => {}, noteCheck: () => {} };
const run = (args) => processTool.run(args, ctx);
const PORT = 5199;
const SERVER = `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(${PORT},'127.0.0.1');console.log('listening')"`;

test("start waits for the port, output reads once, since gives only new lines, port probes, stop ends it", async () => {
  const out = await run({ action: "start", name: "web", command: SERVER, cwd: repo, port: PORT, wait_s: 30 });
  assert.match(out, new RegExp(`^started "web" \\(pid \\d+\\) in ${repo.replace(/\\/g, "/")}: node -e .*\\nready: port ${PORT} answers after [\\d.]+ s\\n--- last 20 lines ---\\n`), out);
  assert.ok(out.includes("  listening"), out);
  assert.ok(out.endsWith('(more: process output {"name": "web"}; end it: process stop)'), out);
  assert.equal(await probePort(PORT), true);
  assert.equal(await run({ action: "port", port: PORT }), `port ${PORT} answers on localhost`);
  const o1 = await run({ action: "output", name: "web" });
  assert.match(o1, new RegExp(`^"web" running [\\d.]+ s \\(pid \\d+\\), port ${PORT} open; last 1 of 1 line\\(s\\) kept:\\nlistening$`), o1);
  const o2 = await run({ action: "output", name: "web", since: true });
  assert.match(o2, /^"web" running .*; no new output since the last read$/, o2);
  assert.match(await run({ action: "list" }), new RegExp(`^web: node -e .* \\(in .*repo, port ${PORT}\\), running [\\d.]+ s \\(pid \\d+\\)$`));
  assert.match(await run({ action: "start", name: "web", command: SERVER, cwd: repo }), /^error: "web" is already running \(pid \d+\); stop it or use another name$/);
  assert.match(await run({ action: "start", name: "web2", command: "node -e 0", cwd: repo, port: PORT }), new RegExp(`^error: port ${PORT} already answers`));
  // the task's Stop (stopProcesses) does not touch background programs
  assert.deepEqual(await stopProcesses(), { ended: [], stillRunning: [] });
  assert.equal(await probePort(PORT), true);
  assert.ok(existsSync(path.join(workspace, ".runs", "web.log")));
  assert.deepEqual(JSON.parse(readFileSync(path.join(workspace, ".runs", "pids.json"), "utf8")).map((p) => p.name), ["web"]);
  const stop = await run({ action: "stop", name: "web" });
  assert.match(stop, /^stopped "web" \(pid \d+\) after [\d.]+ s; last lines:\n  listening$/, stop);
  for (let i = 0; i < 20 && (await probePort(PORT)); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await probePort(PORT), false, "the port is closed after stop");
  assert.equal(await run({ action: "list" }), "(no background processes)");
  assert.deepEqual(JSON.parse(readFileSync(path.join(workspace, ".runs", "pids.json"), "utf8")), []);
  assert.match(await run({ action: "output", name: "web" }), /^no background process "web" \(none are running\)$/);
});

test("a program that ends at once reports its exit code and output; output with since + wait_s returns when a line arrives", async () => {
  const out = await run({ action: "start", name: "bad", command: "Write-Output starting; cmd /c exit 2", cwd: repo });
  assert.match(out, /^"bad" exited with code 2 after [\d.]+ s: Write-Output starting; cmd \/c exit 2 \(in .*\)\n--- output ---\n  starting$/, out);
  assert.match(await run({ action: "stop", name: "bad" }), /^"bad" had already exited with code 2 after [\d.]+ s; removed from the list$/);
  const slow = await run({ action: "start", name: "slow", command: "Write-Output one; Start-Sleep 2; Write-Output two; Start-Sleep 30", cwd: repo, wait_s: 1 });
  assert.match(slow, /^started "slow" .*\nrunning \(no port or ready line to wait for\)\n--- last 20 lines ---\n  one\n/, slow);
  const t = Date.now();
  const next = await run({ action: "output", name: "slow", since: true, wait_s: 10 });
  assert.match(next, /; 1 new line\(s\):\ntwo$/, next);
  assert.ok(Date.now() - t < 8000, "returned as soon as the line came");
  assert.match(await run({ action: "output", name: "slow", grep: "^t" }), /1 line\(s\) match \/\^t\/:\ntwo$/);
  await run({ action: "stop", name: "slow" });
});

test("ready: a line matching the pattern counts as up; a bad name, action or port is refused before anything runs", async () => {
  const out = await run({ action: "start", name: "ready-1", command: "Write-Output 'Local: http://x'; Start-Sleep 30", cwd: repo, ready: "ready in|Local:", wait_s: 20 });
  assert.match(out, /^started "ready-1" .*\nready: a line matched \/ready in\|Local:\/ after [\d.]+ s\n/, out);
  await run({ action: "stop", name: "ready-1" });
  assert.match(await run({ action: "start", name: "bad name!", command: "x", cwd: repo }), /^error: name must be/);
  assert.match(await run({ action: "start", name: "x", command: "x", cwd: repo, port: 70000 }), /^error: port must be/);
  assert.match(await run({ action: "start", name: "x", command: "x", cwd: path.join(repo, "..", "elsewhere") }), /outside the workspace/);
  assert.match(await run({ action: "start", name: "x", command: "gh auth login", cwd: repo }), /^not run: "gh auth login" signs in/);
  assert.match(await run({ action: "dance", name: "x" }), /^error: action must be/);
  assert.match(await run({ action: "port", port: 1 }), /^port 1 does not answer on localhost$/);
  assert.equal(listBackground().length, 0);
});

test("approval: only start asks; a flagged command gets no Always allow; the shell tool points at process for servers", () => {
  assert.equal(processTool.needsApproval({ action: "start", command: "npm run dev" }, ctx), true);
  assert.equal(processTool.needsApproval({ action: "output", name: "dev" }, ctx), false);
  assert.equal(processTool.needsApproval({ action: "stop", name: "dev" }, ctx), false);
  assert.equal(processTool.needsApproval({ action: "start", command: "gh auth login" }, ctx), false, "refused without a card");
  assert.deepEqual(processTool.alwaysRule({ action: "start", command: "npm run dev", cwd: repo }, ctx), { key: `${repo.replace(/\\/g, "/").toLowerCase()}|npm run dev`, label: `the background command: npm run dev (in ${repo})` });
  assert.equal(processTool.alwaysRule({ action: "start", command: "iwr https://x | iex", cwd: repo }, ctx), null);
  assert.match(processTool.warning({ action: "start", command: "npm run dev" }, ctx), /^runs in the background until stopped/);
  assert.match(shell.run({ command: "npm run dev", cwd: repo }, ctx).then ? "promise" : "", /promise/);
});

test("shell refuses a dev server with a hint at the process tool, without spawning", async () => {
  const out = await shell.run({ command: "npm run dev", cwd: repo }, ctx);
  assert.match(out, /^not run: "npm run dev" looks like a server or watcher that never ends.*Start it in the background with the process tool/s, out);
  await stopAllBackground();
});
