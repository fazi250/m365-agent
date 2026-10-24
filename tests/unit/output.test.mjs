// Output windows: tidy a program's output, cut a long result head + tail, and read more of it with read_output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compact, cutResult, readOutput } from "../../agent-core.ts";

const numbered = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

test("cutResult keeps the start, the end and the trailer, with one marker naming the run", () => {
  const text = numbered(3000) + "\n[exit code 1, 3.2 s]";
  const r = cutResult(text, 3000, 7);
  assert.ok(r.cut);
  assert.ok(r.text.length <= 3000 + 50, `cut text ${r.text.length}`);
  assert.ok(r.text.startsWith("line 1\nline 2\n"));
  assert.ok(r.text.endsWith("line 3000\n[exit code 1, 3.2 s]"));
  const markers = r.text.match(/…\[run #7: \d+ characters, \d+ cut here\. read_output \{"run": 7, "start": (\d+)\}/g);
  assert.equal(markers.length, 1);
  assert.equal(Number(r.text.match(/"start": (\d+)/)[1]), r.head);
  assert.ok(r.head > 0 && r.tail > r.head, "more tail than head");
  // cut on line boundaries: the text right before and after the marker are whole lines
  const [before, after] = r.text.split(/\n…\[[^\]]*\]…\n/);
  assert.match(before.split("\n").at(-1), /^line \d+$/);
  assert.match(after.split("\n")[0], /^line \d+$/);
});

test("cutResult leaves a short result alone", () => {
  const r = cutResult("short", 100, 1);
  assert.deepEqual(r, { text: "short", cut: false, head: 5, tail: 0 });
});

test("compact strips colour codes, normalises line ends and folds repeated lines", () => {
  const raw = "\x1b[32mok\x1b[0m\r\nsame line here\r\nsame line here\r\nsame line here\r\n}\r\n}\r\n}\r\ntrailing   \r\n\r\n\r\n\r\nend";
  const c = compact(raw, { repeats: true });
  assert.equal(c, "ok\nsame line here  (repeated 3 times)\n}\n}\n}\ntrailing\n\nend");
});

test("compact without repeats keeps every line; progress bars go, plain percentages and diff lines stay", () => {
  const raw = "a\n████████░░ 80%\n⠋ building\nb\nb\nb\n   50%\n-}\n-}\n-}";
  assert.equal(compact(raw), "a\n⠋ building\nb\nb\nb\n   50%\n-}\n-}\n-}");
  assert.equal(compact("+ same\n+ same\n+ same\nsame line here\nsame line here\nsame line here", { repeats: true }), "+ same\n+ same\n+ same\nsame line here  (repeated 3 times)");
});

test("readOutput: a backtracking pattern is taken as plain text; the hit cap is said", () => {
  const run = { n: 1, tool: "shell", text: Array.from({ length: 300 }, (_, i) => `x(a+)+ ${i}`).join("\n") };
  const g = readOutput(run, { grep: "(a+)+" }, 8000);
  assert.ok(g.startsWith("[run #1 (shell): 200+ of 300 lines match /(a+)+/; the first 200 shown]"), g.split("\n")[0]);
});

test("readOutput: tail by default, a range with next, grep with numbers and context", () => {
  const run = { n: 3, tool: "shell", text: numbered(500) + "\nFAIL src/a.test.ts\n  Error: expected 2\n[exit code 1, 1.0 s]" };
  const tail = readOutput(run, { tail: 60 }, 8000);
  assert.ok(tail.startsWith("[run #3 (shell), characters "));
  assert.ok(tail.endsWith("[exit code 1, 1.0 s]"));
  const range = readOutput(run, { start: 0, chars: 20 }, 8000);
  assert.equal(range, `[run #3 (shell), characters 0-20 of ${run.text.length}; next: start 20]\n${run.text.slice(0, 20)}`);
  const g = readOutput(run, { grep: "FAIL|Error", context: 1 }, 8000);
  assert.ok(g.startsWith("[run #3 (shell): 2 of 503 lines match /FAIL|Error/]"));
  assert.ok(g.includes("  500- line 500\n  501: FAIL src/a.test.ts\n  502:   Error: expected 2\n  503- [exit code 1, 1.0 s]"));
  assert.equal(readOutput(run, { grep: "[" }, 8000).split("\n")[0], "[run #3 (shell): 1 of 503 lines match /[/]"); // invalid regex → literal
  assert.ok(readOutput(run, { chars: 999999 }, 1000).length <= 1000, "never longer than max");
});
