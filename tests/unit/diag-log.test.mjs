// The agent.log summariser behind npm run diag: tasks, their round trips and endings, without any quoted text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLog, summarizeLog } from "../../diag-log.ts";

const log = `2026-10-24T03:00:00.000Z server start: node v24.13.0, port 4317, copilot https://m365.cloud.microsoft/chat, browser msedge
2026-10-24T03:00:01.000Z copilot list 900ms -> ok
2026-10-24T03:01:00.000Z task: new chat, tools: list_dir,read_file,shell: "Secret project name here"
2026-10-24T03:01:09.000Z copilot ask -New 9000ms -> ok via button, 120 chars
2026-10-24T03:01:09.100Z   tool list_dir {"path":"C:/devl/secret"} 5ms -> ok (300 characters) [run #1]
2026-10-24T03:01:17.000Z copilot ask 8000ms -> ok via button, 90 chars (ready 110, send 420, first 1900, button 7600, settle 200, chatId 0)
2026-10-24T03:01:17.200Z   approval shell: once
2026-10-24T03:01:19.000Z   tool shell {"command":"npm test"} 1800ms -> PROBLEM npm ERR! [run #2]
2026-10-24T03:01:49.000Z copilot ask 30000ms -> ok via stable30, 40 chars
2026-10-24T03:01:49.100Z task end: done, 2 checks
2026-10-24T03:05:00.000Z task: chat abc, tools: none (chat mode): "hi"
2026-10-24T03:05:07.000Z copilot ask 7000ms -> ok via button, 500 chars
2026-10-24T03:05:07.100Z task end: reply (500 characters)
2026-10-24T03:10:00.000Z task: new chat, tools: shell: "x"
2026-10-24T03:14:00.000Z copilot ask -New 240000ms -> ERROR no reply from Copilot within 240 s (its reply so far: "...")
2026-10-24T03:14:00.100Z page shows error: no reply from Copilot within 240 s
2026-10-24T03:20:00.000Z task: new chat, tools: shell: "y"
2026-10-24T03:20:08.000Z copilot ask -New 8000ms -> ok via button, 100 chars
2026-10-24T03:20:08.100Z   approval shell: deny (ask) "no"
2026-10-24T03:20:08.200Z   tool shell declined by the user (ask)
2026-10-24T03:20:09.000Z page shows error: stopped
2026-10-24T03:30:00.000Z task: new chat, tools: shell: "z"
2026-10-24T03:30:08.000Z copilot ask -New 8000ms -> ok via button, 100 chars
2026-10-24T03:30:09.000Z CRASH Error: boom
2026-10-24T03:40:00.000Z task: new chat, tools: shell: "w"
2026-10-24T03:40:08.000Z copilot ask -New 8000ms -> ok via progress60, 100 chars
`;

test("parseLog: one summary per task with round trips, via, phases, calls, approvals and the ending", () => {
  const t = parseLog(log);
  assert.equal(t.length, 6);
  assert.deepEqual(t[0].tools, ["list_dir", "read_file", "shell"]);
  assert.deepEqual(t[0].asks, [9000, 8000, 30000]);
  assert.deepEqual(t[0].via, { button: 2, stable30: 1 });
  assert.deepEqual(t[0].phases, { ready: [110], send: [420], first: [1900], button: [7600], settle: [200], chatId: [0] });
  assert.equal(t[0].calls, 2);
  assert.equal(t[0].problems, 1);
  assert.deepEqual(t[0].approvals, { once: 1 });
  assert.equal(t[0].ending, "done");
  assert.deepEqual([t[1].tools, t[1].ending], [[], "reply"]);
  assert.deepEqual([t[2].asks, t[2].via, t[2].ending], [[240000], {}, "error"]);
  assert.deepEqual([t[3].approvals, t[3].ending], [{ deny: 1 }, "stopped"]);
  assert.equal(t[4].ending, "crash");
  assert.equal(t[5].ending, "cut off");
});

test("summarizeLog: readable lines, numbers only, nothing quoted from the tasks", () => {
  const lines = summarizeLog(log);
  assert.equal(lines.length, 6);
  assert.equal(lines[0], "2026-10-24 03:01:00  3 tools: round trips 3 (min 8.0 s, median 9.0 s, max 30.0 s), via button 2, stable30 1; tool calls 2 (1 with a problem); approvals once 1; ended: done; phases median: ready 0.1 s, send 0.4 s, first 1.9 s, button 7.6 s, settle 0.2 s, chatId 0.0 s");
  assert.equal(lines[1], "2026-10-24 03:05:00  chat: round trips 1 (min 7.0 s, median 7.0 s, max 7.0 s), via button 1; tool calls 0; approvals none; ended: reply");
  assert.ok(lines[2].endsWith("via none; tool calls 0; approvals none; ended: error"), lines[2]);
  for (const l of lines) for (const word of ["Secret", "secret", "npm test", "boom", "hi\""]) assert.ok(!l.includes(word), `${word} leaked into: ${l}`);
  assert.deepEqual(summarizeLog(""), ["(no tasks in the log)"]);
  assert.equal(summarizeLog(log, 2).length, 2);
});
