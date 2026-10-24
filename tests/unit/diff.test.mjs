import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines } from "../../agent-core.ts";

const render = (d) => d.map((l) => l.t + l.s).join("|");

test("a changed line in the middle", () => {
  assert.equal(render(diffLines("a\nb\nc", "a\nB\nc")), " a|-b|+B| c");
});

test("a new file is all added, a removed file all removed", () => {
  assert.equal(render(diffLines("", "x\ny")), "+x|+y");
  assert.equal(render(diffLines("x\ny", "")), "-x|-y");
  assert.deepEqual(diffLines("", ""), []);
});

test("CRLF and LF compare line by line", () => {
  assert.equal(render(diffLines("a\r\nb", "a\nb\nc")), " a| b|+c");
});

test("an insertion keeps the common lines", () => {
  const d = diffLines("1\n2\n3\n4", "1\n2\nx\n3\n4");
  assert.equal(d.filter((l) => l.t === "+").length, 1);
  assert.equal(d.filter((l) => l.t === "-").length, 0);
  assert.equal(d.length, 5);
});
