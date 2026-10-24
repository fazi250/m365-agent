// The agent loop end to end against the fake Copilot: tool calls, approvals, Keep / Undo, verify gate, ask_user,
// Stop, and the API's guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, startServer } from "../harness.mjs";

const call = (tool, args, block) => JSON.stringify({ tool, args, why: "test" }) + (block ? `\n\`\`\`text\n${block}\n\`\`\`` : "");
const fwd = (p) => p.replace(/\\/g, "/");

test("list_dir → write_file → shell (allowed once) → done → verify → done with checks; Undo restores the original", async () => {
  const s = await startServer({ name: "loop", approvals: ["once"] });
  try {
    const target = path.join(s.repo, "a.txt");
    writeFileSync(target, "one\r\ntwo"); // CRLF, no final newline: Undo must bring back these exact bytes
    writeFileSync(path.join(s.dir, "replies.json"), JSON.stringify([
      call("list_dir", { path: fwd(s.repo) }),
      call("write_file", { path: fwd(target) }, "hello\nworld"),
      call("shell", { command: "Write-Output hi", cwd: fwd(s.repo) }),
      call("done", { answer: "first done" }),
      call("done", { answer: "all good", checks: ["a.txt rewritten: write_file RESULT says replaced"] }),
    ]));
    const r = await s.post("/api/send", { message: "Rewrite a.txt and say hi", tools: ["list_dir", "write_file", "shell"] });
    assert.equal(r.status, 202);
    const done = await s.waitFor((e) => e.type === "done" || e.type === "error" || e.type === "reply", { timeout: 60_000 });
    assert.equal(done.type, "done", JSON.stringify(done));
    assert.equal(done.text, "all good");
    assert.deepEqual(done.checks, ["a.txt rewritten: write_file RESULT says replaced"]);

    const types = s.events.map((e) => e.type);
    assert.ok(types.includes("approve"), "the shell step asked");
    assert.ok(types.includes("note"), "the first done was sent back to verify");
    const asks = s.asks();
    assert.equal(asks.length, 5);
    assert.ok(asks[0].startsWith("Rewrite a.txt and say hi\n\n[local-agent] You are the agent"));
    assert.ok(asks[1].startsWith("[local-agent] RESULT of list_dir:\na.txt"));
    assert.ok(asks[2].startsWith("[local-agent] RESULT of write_file:\nreplaced "));
    assert.ok(asks[3].startsWith("[local-agent] RESULT of shell:\nhi"));
    assert.ok(asks[4].startsWith("[local-agent] Before you finish"));
    assert.equal(readFileSync(target, "utf8"), "hello\nworld\n");

    const state = await (await s.get("/api/state")).json();
    assert.equal(state.changes.length, 1);
    assert.equal(state.changes[0].kind, "modified");
    const diff = await (await s.get("/api/changes/diff?path=" + encodeURIComponent(target))).json();
    assert.deepEqual(diff.lines.map((l) => l.t + l.s), ["-one", "-two", "+hello", "+world", "+"]); // the written file ends with a newline
    const undo = await s.post("/api/changes/undo", { path: target });
    assert.equal(undo.status, 200);
    assert.equal(readFileSync(target, "utf8"), "one\r\ntwo");
    assert.equal((await (await s.get("/api/state")).json()).changes.length, 0);
  } finally { await s.stop(); }
});

test("a declined step tells Copilot so; no tool ran, so done is final at once", async () => {
  const s = await startServer({ name: "deny", approvals: ["deny"], replies: [
    call("shell", { command: "Write-Output no" }),
    call("done", { answer: "gave up" }),
  ] });
  try {
    await s.post("/api/send", { message: "run it", tools: ["shell"] });
    const done = await s.waitFor((e) => e.type === "done" || e.type === "error" || e.type === "reply", { timeout: 30_000 });
    assert.equal(done.type, "done");
    const asks = s.asks();
    assert.equal(asks.length, 2);
    assert.ok(asks[1].startsWith("[local-agent] RESULT of shell:\nThe user declined to run this."));
    assert.ok(!s.events.some((e) => e.type === "note"), "no verify gate without a tool run");
  } finally { await s.stop(); }
});

test("ask_user waits for the answer; the API refuses a second send while busy and a foreign origin", async () => {
  const s = await startServer({ name: "ask", replies: [
    call("ask_user", { question: "Which one?" }),
    call("done", { answer: "chose it" }),
  ] });
  try {
    await s.post("/api/send", { message: "pick", tools: ["list_dir"] });
    const q = await s.waitFor((e) => e.type === "question");
    assert.equal(q.text, "Which one?");
    assert.equal((await s.post("/api/send", { message: "again", tools: [] })).status, 409);
    assert.equal((await s.post("/api/send", { message: "x", tools: [] }, { Origin: "http://evil.example" })).status, 403);
    assert.equal((await s.answer("the second")).status, 204);
    const done = await s.waitFor((e) => e.type === "done" || e.type === "error");
    assert.equal(done.type, "done");
    assert.ok(s.asks()[1].startsWith("[local-agent] RESULT of ask_user:\nThe user answered: the second"));
    await s.waitFor((e) => e.type === "idle");
    assert.equal((await s.post("/api/answer", { id: q.id, text: "late" })).status, 404);
  } finally { await s.stop(); }
});

test("Stop ends a running command and the task", async () => {
  const s = await startServer({ name: "stop", approvals: ["once"], replies: [
    call("shell", { command: "Start-Sleep 60; Write-Output late" }),
    call("done", { answer: "should not get here" }),
  ] });
  try {
    await s.post("/api/send", { message: "sleep", tools: ["shell"] });
    await s.waitFor((e) => e.type === "status" && /running shell/.test(e.text), { timeout: 30_000 });
    const t = Date.now();
    assert.equal((await s.post("/api/stop")).status, 204);
    const end = await s.waitFor((e) => e.type === "error" || e.type === "done", { timeout: 15_000 });
    assert.equal(end.type, "error");
    assert.equal(end.text, "stopped");
    assert.ok(Date.now() - t < 10_000, "stopped quickly");
    await s.waitFor((e) => e.type === "idle");
    assert.equal(s.asks().length, 1, "nothing more was sent to Copilot");
  } finally { await s.stop(); }
});

test("a bad reply gets a correction, then a plain answer ends the task as a reply", async () => {
  const s = await startServer({ name: "bad", replies: [
    '{"tool": "list_dir", "args": {"path": "x",}}',
    "I cannot do that, sorry.",
  ] });
  try {
    await s.post("/api/send", { message: "hmm", tools: ["list_dir"] });
    const end = await s.waitFor((e) => e.type === "reply" || e.type === "done" || e.type === "error");
    assert.equal(end.type, "reply");
    assert.equal(end.text, "I cannot do that, sorry.");
    assert.ok(s.asks()[1].startsWith("[local-agent] Your reply was not one valid JSON tool call ("));
  } finally { await s.stop(); }
});

test("a long command output reaches Copilot cut in the middle, read_output gives the rest, the page gets it all", async () => {
  const s = await startServer({ name: "output", approvals: ["once", "once"], config: { maxResult: 3000 }, replies: [
    call("shell", { command: '1..600 | ForEach-Object { "line $_" }' }),
    call("read_output", { run: 1, grep: "line 300$" }),
    call("read_output", { run: 9 }),
    call("shell", { command: "cmd /c exit 3" }),
    call("done", { answer: "d1" }),
    call("done", { answer: "d2", checks: ["x"] }),
  ] });
  try {
    await s.post("/api/send", { message: "print a lot", tools: ["shell"] });
    const done = await s.waitFor((e) => e.type === "done" || e.type === "error" || e.type === "reply", { timeout: 60_000 });
    assert.equal(done.type, "done", JSON.stringify(done));
    const asks = s.asks();
    const first = asks[1];
    assert.ok(first.startsWith("[local-agent] RESULT of shell:\nline 1\nline 2\n"), first.slice(0, 200));
    assert.ok(first.includes('…[run #1: ') && first.includes('read_output {"run": 1, "start": '), "the cut marker");
    assert.ok(first.includes("line 600\n[exit 0, "), "the end and the trailer survive");
    assert.ok(first.length < 3000 + 400, `sent ${first.length} characters`);
    assert.ok(asks[2].startsWith("[local-agent] RESULT of read_output:\n[run #1 (shell): 1 of 601 lines match /line 300$/]\n  300: line 300"), asks[2].slice(0, 200));
    assert.ok(asks[3].startsWith("[local-agent] RESULT of read_output:\nno run #9 to read in this chat (its runs: 1;"), asks[3].slice(0, 200));
    assert.match(asks[4], /^\[local-agent\] RESULT of shell:\n\(no output\)\n\[exit code 3, [\d.]+ s\]\n/);
    const result = s.events.find((e) => e.type === "result" && e.tool === "shell");
    assert.equal(result.run, 1);
    assert.ok(result.full.includes("line 350\n"), "the page gets the full text");
    assert.ok(result.head > 0 && result.tail > 0);
    assert.match(s.log(), /tool shell .*cmd \/c exit 3.* -> PROBLEM /);
  } finally { await s.stop(); }
});

test("edit_file changes a repo file with Keep/Undo; a Python script with a syntax error is refused before approval", async () => {
  const s = await startServer({ name: "edit", replies: [] });
  try {
    const target = path.join(s.repo, "app.py");
    writeFileSync(target, "def main():\n    print('v1')\n\nmain()\n");
    writeFileSync(path.join(s.repo, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node -e 0", lint: "node -e 0" } }));
    writeFileSync(path.join(s.dir, "replies.json"), JSON.stringify([
      JSON.stringify({ tool: "edit_file", args: { path: fwd(target) }, why: "bump" }) + "\n```text\n<<<<<<< SEARCH\n    print('v1')\n=======\n    print('v2')\n>>>>>>> REPLACE\n```",
      call("run_python", { name: "bad" }, "def f(:\n    pass"),
      call("done", { answer: "d1" }),
      call("done", { answer: "edited", checks: ["app.py prints v2"] }),
    ]));
    await s.post("/api/send", { message: "change v1 to v2", tools: ["edit_file", "run_python"] });
    const done = await s.waitFor((e) => e.type === "done" || e.type === "error" || e.type === "reply", { timeout: 60_000 });
    assert.equal(done.type, "done", JSON.stringify(done));
    assert.equal(readFileSync(target, "utf8"), "def main():\n    print('v2')\n\nmain()\n");
    const asks = s.asks();
    assert.ok(asks[1].startsWith(`[local-agent] RESULT of edit_file:\nedited ${fwd(target)}: 1 edit(s), -1 +1 lines (now 4 lines)\n--- lines 1-3 after edit #1 ---\n`), asks[1].slice(0, 300));
    assert.ok(asks[1].includes("\ncheck: OK (Python ast)\nproject checks: npm run lint, npm test (in "), asks[1].slice(0, 500));
    assert.ok(asks[2].startsWith("[local-agent] RESULT of run_python:\nnot run: scripts/bad.py has a SYNTAX ERROR (Python ast) line 1: "), asks[2].slice(0, 200));
    assert.ok(!s.events.some((e) => e.type === "approve"), "no approval card for a broken script");
    const changes = s.events.filter((e) => e.type === "changes").at(-1).changes;
    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, "modified");
    assert.equal(changes[0].added, 1);
    assert.equal(changes[0].removed, 1);
    assert.equal(changes[0].check, null);
    const diff = await (await s.get("/api/changes/diff?path=" + encodeURIComponent(target))).json();
    assert.deepEqual(diff.lines.filter((l) => l.t !== " ").map((l) => l.t + l.s), ["-    print('v1')", "+    print('v2')"]);
    assert.ok(asks[0].includes("To change part of an existing file use edit_file with SEARCH/REPLACE blocks"), "the edit rule is in the prompt");
  } finally { await s.stop(); }
});

test("the verify round carries the facts; the Done card shows them and warns when the checks ignore failures", async () => {
  const s = await startServer({ name: "ledger", approvals: ["once"] });
  try {
    const bad = path.join(s.repo, "bad.json");
    writeFileSync(path.join(s.dir, "replies.json"), JSON.stringify([
      call("write_file", { path: fwd(bad) }, '{"a": }'),
      call("shell", { command: "Write-Output x; exit 1" }),
      call("done", { answer: "d1" }),
      call("done", { answer: "all good", checks: ["everything fine"] }),
    ]));
    await s.post("/api/send", { message: "write and run", tools: ["write_file", "shell"] });
    const done = await s.waitFor((e) => e.type === "done" || e.type === "error" || e.type === "reply", { timeout: 60_000 });
    assert.equal(done.type, "done", JSON.stringify(done));
    const verify = s.asks()[3];
    assert.ok(verify.startsWith("[local-agent] Before you finish, verify the task like a careful engineer. Facts from my side"), verify.slice(0, 200));
    assert.ok(verify.includes(`- files you wrote: ${fwd(bad)} (1 lines, SYNTAX ERROR (JSON) line 1 col 7: `), verify);
    assert.ok(verify.includes('- commands you ran: shell "Write-Output x; exit 1" -> last run [exit code 1]'), verify);
    assert.deepEqual(done.facts.filter((f) => f.problem).map((f) => f.text), ["1 file written, 1 with a syntax error: bad.json", 'last "Write-Output x; exit 1" (shell): exit code 1']);
    assert.equal(done.warning, "Copilot's checks do not mention these failures.");
  } finally { await s.stop(); }
});

test("a read-only task needs no verify round; text after tool runs gets one nudge, then ends as a reply with facts", async () => {
  const s = await startServer({ name: "readonly", replies: [
    call("list_dir", { path: "." }),
    call("done", { answer: "listed", checks: ["list_dir ran"] }),
  ] });
  try {
    await s.post("/api/send", { message: "what is there", tools: ["list_dir"] });
    const done = await s.waitFor((e) => e.type === "done" || e.type === "error" || e.type === "reply");
    assert.equal(done.type, "done");
    assert.equal(s.asks().length, 2, "no verify round");
    assert.deepEqual(done.facts, [{ text: "1 command ran OK", problem: false }, { text: "verify round: no (nothing was changed)", problem: false }]);
  } finally { await s.stop(); }
  const t = await startServer({ name: "prose", approvals: ["once"], replies: [
    call("shell", { command: "Write-Output ok" }),
    "I have run the command; you can take it from here.",
    "Still just text.",
  ] });
  try {
    await t.post("/api/send", { message: "run it", tools: ["shell"] });
    const end = await t.waitFor((e) => e.type === "done" || e.type === "error" || e.type === "reply", { timeout: 60_000 });
    assert.equal(end.type, "reply");
    assert.equal(end.text, "Still just text.");
    assert.ok(end.facts.some((f) => f.text === "1 command ran OK"));
    const asks = t.asks();
    assert.equal(asks.length, 3);
    assert.ok(asks[2].startsWith("[local-agent] You ended with text, not with done."), asks[2].slice(0, 100));
    assert.ok(asks[2].includes('- commands you ran: shell "Write-Output ok" -> ok'));
    assert.ok(t.events.some((e) => e.type === "note" && /asking it to finish properly/.test(e.text)));
    assert.ok(t.events.some((e) => e.type === "note" && e.text === "Copilot stopped without done"));
  } finally { await t.stop(); }
});

test("Stop while Copilot is answering drops the reply: nothing runs, no card appears", async () => {
  const s = await startServer({ name: "stopwait", replies: [
    { text: call("list_dir", { path: "." }), delayMs: 2500 },
    call("done", { answer: "should not get here" }),
  ] });
  try {
    await s.post("/api/send", { message: "slow", tools: ["list_dir"] });
    await s.waitFor((e) => e.type === "status" && /step 1: waiting/.test(e.text));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await s.post("/api/stop")).status, 204);
    const end = await s.waitFor((e) => e.type === "error" || e.type === "done" || e.type === "result", { timeout: 15_000 });
    assert.equal(end.type, "error");
    assert.equal(end.text, "stopped");
    await s.waitFor((e) => e.type === "idle");
    assert.ok(!s.events.some((e) => e.type === "call" || e.type === "result" || e.type === "approve"), JSON.stringify(s.events.map((e) => e.type)));
    assert.equal(s.asks().length, 1);
  } finally { await s.stop(); }
});

test("read_output only serves runs of the same chat", async () => {
  const s = await startServer({ name: "scope", replies: [
    call("list_dir", { path: "." }),
    call("done", { answer: "one" }),
    call("read_output", { run: 1, tail: 100 }),
    call("done", { answer: "two" }),
  ] });
  try {
    await s.post("/api/send", { message: "first chat", tools: ["list_dir"] });
    await s.waitFor((e) => e.type === "done");
    await s.waitFor((e) => e.type === "idle");
    await s.post("/api/send", { message: "second chat", tools: ["list_dir"] });
    await s.waitFor((e) => e.type === "done" && e.text === "two", { timeout: 30_000 });
    assert.ok(s.asks()[3].startsWith("[local-agent] RESULT of read_output:\nno run #1 to read in this chat (its runs: none;"), s.asks()[3].slice(0, 200));
  } finally { await s.stop(); }
});

test("a PowerShell fake bridge still works (the .ps1 spawn path)", async () => {
  const s = await startServer({ name: "ps", config: { bridgeScript: path.join(ROOT, "tests", "fake-bridge.ps1") } });
  try {
    await s.post("/api/send", { message: "héllo ✓ from the test", tools: ["list_dir"] });
    const done = await s.waitFor((e) => e.type === "done" || e.type === "error" || e.type === "reply", { timeout: 60_000 });
    assert.equal(done.type, "done", JSON.stringify(done));
    assert.match(done.text, /^ps fake: \d+ characters received$/);
    await s.waitFor((e) => e.type === "created");
  } finally { await s.stop(); }
});

test("the page gets the parser as JavaScript", async () => {
  const s = await startServer({ name: "core" });
  try {
    const r = await s.get("/agent-core.js");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /javascript/);
    const js = await r.text();
    assert.ok(!/:\s*string\b/.test(js), "types stripped");
    const file = path.join(s.dir, "agent-core.mjs");
    writeFileSync(file, js);
    const core = await import("file://" + file.replace(/\\/g, "/"));
    assert.equal(core.parseCall('{"tool": "done", "args": {"answer": "x"}}', () => undefined).call.args.answer, "x");
    assert.ok(existsSync(path.join(s.dir, "agent.log")), "the log went to the test's logFile");
  } finally { await s.stop(); }
});
