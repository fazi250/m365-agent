// The parser for Copilot's replies: one JSON tool call, outside or inside a fence, with a file block after it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCall, findCall, parseLenient } from "../../agent-core.ts";

const blockArgOf = (tool) => ({ write_file: "content", run_python: "code" })[tool];

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

test("broken JSON reports the parser's reason", () => {
  const r = parseCall('{"tool": "shell", "args": {"command": "x",}}', blockArgOf);
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
