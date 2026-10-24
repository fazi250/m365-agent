// The task ledger: the verify message built from facts, the Facts list, and the "checks miss the failures" hint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checksMissFailures, exitOf, factLines, verifyPrompt, MARK } from "../../agent-core.ts";

const ledger = (o = {}) => ({ writes: [], runs: [], declined: [], asked: 0, mutatingRuns: 1, verifyAsked: true, ...o });
const w = (path, o = {}) => ({ path, tool: "write_file", step: 1, exists: true, lines: 10, check: null, ...o });

test("verifyPrompt lists files, commands, declined steps and answers, flattened and capped", () => {
  const l = ledger({
    writes: [w("C:\\x\\a.ts", { lines: 120 }), w("C:/x/b.py", { check: "SYNTAX ERROR (Python ast) line 3: invalid syntax" }), w("C:/x/c.md", { exists: false })],
    runs: [{ tool: "shell", summary: "npm test (in C:/x)", step: 4, problem: true, exit: "exit code 1" }, { tool: "shell", summary: "npm install", step: 2, problem: false, exit: "ok" }],
    declined: ["shell Remove-Item C:/x -Recurse"], asked: 1,
  });
  const p = verifyPrompt(l);
  assert.ok(p.startsWith(MARK + " Before you finish, verify the task like a careful engineer. Facts from my side (not your memory):\n"));
  assert.ok(p.includes("- files you wrote: C:/x/a.ts (120 lines, check OK); C:/x/b.py (10 lines, SYNTAX ERROR (Python ast) line 3: invalid syntax, still broken); C:/x/c.md (no longer exists: undone?)"), p);
  assert.ok(p.includes('- commands you ran: shell "npm test (in C:/x)" -> last run [exit code 1]; shell "npm install" -> ok'), p);
  assert.ok(p.includes("- steps I declined: shell Remove-Item C:/x -Recurse\n- my answers to ask_user: 1\n"), p);
  assert.ok(p.includes('Then send done again with "checks"'));
  const many = ledger({ writes: Array.from({ length: 30 }, (_, i) => w(`C:/x/f${i}.txt`)) });
  const line = verifyPrompt(many).split("\n").find((s) => s.startsWith("- files you wrote"));
  assert.equal((line.match(/C:\/x\/f/g) || []).length, 25);
  assert.ok(line.endsWith("; … and 5 more"));
  const nudge = verifyPrompt(ledger(), { nudge: true });
  assert.ok(nudge.startsWith(MARK + " You ended with text, not with done."));
});

test("factLines: problems in red, counts otherwise", () => {
  const f = factLines(ledger({
    writes: [w("C:/x/a.ts"), w("C:/x/b.py", { check: "SYNTAX ERROR x" })],
    runs: [{ tool: "shell", summary: "npm test", step: 1, problem: true, exit: "exit code 1" }, { tool: "run_python", summary: "scripts/a.py", step: 2, problem: false, exit: "ok" }],
    declined: ["shell x"], asked: 2,
  }));
  assert.deepEqual(f, [
    { text: "2 files written, 1 with a syntax error: b.py", problem: true },
    { text: 'last "npm test" (shell): exit code 1', problem: true },
    { text: "1 command ran OK", problem: false },
    { text: "1 step declined by you", problem: false },
    { text: "2 questions you answered", problem: false },
    { text: "verify round: yes", problem: false },
  ]);
  assert.deepEqual(factLines(ledger({ mutatingRuns: 0, verifyAsked: false })), [{ text: "verify round: no (nothing was changed)", problem: false }]);
});

test("exitOf reads the trailer or the problem", () => {
  assert.equal(exitOf("x\n[exit 0, 1.0 s]"), "ok");
  assert.equal(exitOf("x\n[exit code 2, 1.0 s]"), "exit code 2");
  assert.equal(exitOf("x\n[killed: timeout after 600 s]"), "killed: timeout after 600 s");
  assert.equal(exitOf("error: no such file"), "problem: error: no such file");
  assert.equal(exitOf("created x"), "ok");
  assert.equal(exitOf("Error: a file whose first line says so", { data: true }), "ok");
});

test("factLines: the verify line tells a stopped task from a read-only one", () => {
  assert.equal(factLines(ledger({ mutatingRuns: 2, verifyAsked: false })).at(-1).text, "verify round: no");
});

test("checksMissFailures", () => {
  const facts = [{ text: "x", problem: true }];
  assert.equal(checksMissFailures(facts, ["all good"]), true);
  assert.equal(checksMissFailures(facts, ["npm test failed: exit code 1"]), false);
  assert.equal(checksMissFailures([{ text: "x", problem: false }], ["all good"]), false);
});
