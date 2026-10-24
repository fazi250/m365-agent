// The parser for Copilot's replies: one JSON tool call, outside or inside a fence, with a file block after it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { batchCalls, parseCall, findCall, findCalls, parseLenient } from "../../agent-core.ts";

const blockArgOf = (tool) => ({ write_file: "content", run_python: "code", edit_file: "edits" })[tool];

test("recovery: an example object before the real call, a trailing comma, a raw line break, a path ending in a backslash", () => {
  const r = parseCall('For example {"name": "x"} is not a call. Here is mine:\n{"tool": "list_dir", "args": {"path": "C:/x"}}', blockArgOf);
  assert.equal(r.call?.tool, "list_dir");
  assert.deepEqual(parseCall('{"tool": "shell", "args": {"command": "npm test",}, "why": "x",}', blockArgOf).call?.args, { command: "npm test" });
  assert.deepEqual(parseCall('{"tool": "shell", "args": {"command": "echo a\nb", "cwd": "C:/x"}}', blockArgOf).call?.args, { command: "echo a\nb", cwd: "C:/x" });
  assert.deepEqual(parseCall('{"tool": "shell", "args": {"cwd": "C:\\devl\\", "command": "npm test"}}', blockArgOf).call?.args, { cwd: "C:\\devl\\", command: "npm test" });
  assert.deepEqual(parseCall('{"tool": "shell", "args": {"command": "echo \\"a\\", \\"b\\""}}', blockArgOf).call?.args, { command: 'echo "a", "b"' }, "escaped quotes before a comma still parse");
  assert.equal(parseCall('Sure:\n```json\n{"tool": "list_dir", "args": {"path": "C:/x"}}\n```\nDone.', blockArgOf).usedBlock, 0);
});

test("recovery: two real calls are refused, a cut object or fence says so, the error names where it broke", () => {
  const two = parseCall('{"tool": "list_dir", "args": {}}\n{"tool": "read_file", "args": {"path": "a"}}', blockArgOf);
  assert.equal(two.call, null);
  assert.equal(two.error, "your reply held 2 tool calls; send exactly one");
  assert.equal(findCalls('{"tool": "a", "args": {}} {"tool": "b", "args": {}}').calls.length, 2);
  const cutObj = parseCall('{"tool": "write_file", "args": {"path": "C:/x/a.txt", "content": "half', blockArgOf);
  assert.equal(cutObj.call, null);
  assert.match(cutObj.error, /not closed \(the reply was probably cut\)/);
  const cutFence = parseCall('```text\nhalf a file', blockArgOf);
  assert.equal(cutFence.call, null);
  assert.equal(cutFence.error, "your reply was cut (a code block has no closing fence): send a shorter file or use append: true");
  assert.equal(cutFence.cut, true);
  const bad = parseCall('{"tool": "shell", "args": {"command": "x" "cwd": "C:/x"}}', blockArgOf);
  assert.equal(bad.call, null);
  assert.match(bad.error, /near: ".*"command": "x" "cwd"/);
  assert.equal(parseCall("{}", blockArgOf).error, 'missing "tool"');
});

test("batchCalls: sub-calls get the spare blocks in order; forbidden tools, too many or malformed calls are refused", () => {
  const reply = '{"tool": "batch", "args": {"calls": [{"tool": "write_file", "args": {"path": "a.txt"}}, {"tool": "list_dir", "args": {"path": "."}}, {"tool": "write_file", "args": {"path": "b.txt"}}]}}\n```text\nAAA\n```\n```text\nBBB\n```';
  const p = parseCall(reply, blockArgOf);
  assert.equal(p.call?.tool, "batch");
  assert.equal(p.call?.args.calls.length, 3, "the batch itself takes no block");
  const b = batchCalls(p.call, p.blocks, p.usedBlock, blockArgOf, 6);
  assert.equal(b.error, "");
  assert.deepEqual(b.calls.map((c) => [c.tool, c.args]), [["write_file", { path: "a.txt", content: "AAA" }], ["list_dir", { path: "." }], ["write_file", { path: "b.txt", content: "BBB" }]]);
  const fenced = parseCall('```json\n{"tool": "batch", "args": {"calls": [{"tool": "write_file", "args": {"path": "a.txt"}}, {"tool": "write_file", "args": {"path": "b.txt"}}]}}\n```\n```text\nonly one\n```', blockArgOf);
  const one = batchCalls(fenced.call, fenced.blocks, fenced.usedBlock, blockArgOf, 6);
  assert.deepEqual(one.calls.map((c) => c.args.content), ["only one", undefined], "the second write gets no block, never the wrong one");
  assert.match(batchCalls({ tool: "batch", args: { calls: [{ tool: "done", args: {} }] } }, [], -1, blockArgOf, 6).error, /^error: done cannot be part of a batch \(call 1\)/);
  assert.match(batchCalls({ tool: "batch", args: { calls: Array.from({ length: 7 }, () => ({ tool: "list_dir", args: {} })) } }, [], -1, blockArgOf, 6).error, /at most 6 calls \(you sent 7\)/);
  assert.match(batchCalls({ tool: "batch", args: {} }, [], -1, blockArgOf, 6).error, /^error: batch needs "calls"/);
  assert.match(batchCalls({ tool: "batch", args: { calls: [{ args: {} }] } }, [], -1, blockArgOf, 6).error, /call 1 is not a tool call/);
});

test("a plain JSON call", () => {
  const r = parseCall('{"tool": "list_dir", "args": {"path": "C:/x"}, "why": "look"}', blockArgOf);
  assert.deepEqual(r.call, { tool: "list_dir", args: { path: "C:/x" }, why: "look" });
  assert.equal(r.error, "");
  assert.deepEqual(r.blocks, []);
  assert.equal(r.usedBlock, -1);
});

test("prose before the JSON is ignored", () => {
  const r = parseCall('Sure, I will list it.\n{"tool": "list_dir", "args": {}}', blockArgOf);
  assert.equal(r.call?.tool, "list_dir");
});

test("the JSON inside a ```json fence", () => {
  const r = parseCall('```json\n{"tool": "list_dir", "args": {"path": "C:/x"}}\n```', blockArgOf);
  assert.equal(r.call?.tool, "list_dir");
  assert.equal(r.usedBlock, 0);
});

test("a file block after the JSON fills the blockArg", () => {
  const r = parseCall('{"tool": "write_file", "args": {"path": "C:/x/a.txt"}}\n```text\nhello\n  world\n```', blockArgOf);
  assert.equal(r.call?.args.content, "hello\n  world");
});

test("two blocks: the JSON's own block is not taken as the file", () => {
  const r = parseCall('```json\n{"tool": "write_file", "args": {"path": "a.txt"}}\n```\n```text\nfile text\n```', blockArgOf);
  assert.equal(r.usedBlock, 0);
  assert.equal(r.call?.args.content, "file text");
});

test("a ~~~~text fence keeps ``` lines inside the file", () => {
  const file = "# README\n```bash\nnpm test\n```\ndone";
  const r = parseCall(`{"tool": "write_file", "args": {"path": "README.md"}}\n~~~~text\n${file}\n~~~~`, blockArgOf);
  assert.equal(r.call?.args.content, file);
});

test("a longer backtick fence keeps a ``` sample whole", () => {
  const file = "a\n```\nb\n```\nc";
  const r = parseCall(`{"tool": "write_file", "args": {"path": "x.md"}}\n\`\`\`\`text\n${file}\n\`\`\`\``, blockArgOf);
  assert.equal(r.call?.args.content, file);
});

test("Windows backslashes in paths are repaired", () => {
  const r = parseCall('{"tool": "read_file", "args": {"path": "C:\\devl\\x\\a.ts"}}', blockArgOf);
  assert.equal(r.call?.args.path, "C:\\devl\\x\\a.ts");
});

test("a valid escape stays an escape", () => {
  assert.equal(parseLenient('{"a": "x\\ny"}').value.a, "x\ny");
  assert.equal(parseLenient('{"a": "C:\\\\x"}').value.a, "C:\\x");
});

test("an unterminated fence: the block is not closed, the JSON outside still parses", () => {
  const r = parseCall('{"tool": "write_file", "args": {"path": "a.txt"}}\n```text\nhalf a file', blockArgOf);
  assert.equal(r.call?.tool, "write_file");
  assert.equal(r.call?.args.content, undefined);
});

test("no JSON at all", () => {
  const r = parseCall("Just an answer in words.", blockArgOf);
  assert.equal(r.call, null);
  assert.equal(r.error, "no JSON object found");
});

test("JSON without a tool field", () => {
  const r = parseCall('{"name": "x"}', blockArgOf);
  assert.equal(r.call, null);
  assert.equal(r.error, 'missing "tool"');
});

test("broken JSON reports the parser's reason (a trailing comma is repaired, a missing colon is not)", () => {
  assert.deepEqual(parseCall('{"tool": "shell", "args": {"command": "x",}}', blockArgOf).call?.args, { command: "x" });
  const r = parseCall('{"tool": "shell", "args": {"command" "x"}}', blockArgOf);
  assert.equal(r.call, null);
  assert.match(r.error, /JSON|token|Expected/i);
});

test("braces inside strings do not end the object", () => {
  const r = findCall('{"tool": "shell", "args": {"command": "echo }{"}}');
  assert.equal(r.call?.args.command, "echo }{");
});

test("args default to an empty object, also when they are not an object", () => {
  assert.deepEqual(parseCall('{"tool": "done"}', blockArgOf).call?.args, {});
  const r = parseCall('{"tool": "write_file", "args": "C:/x/a.txt"}\n```text\nhello\n```', blockArgOf);
  assert.deepEqual(r.call?.args, { content: "hello" });
});
