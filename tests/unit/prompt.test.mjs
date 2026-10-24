// The strings the page (index.html) relies on when it renders old chats must stay exactly as the server sends them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MARK, VERIFY, agentPrompt, askUserResultMessage, correctionMessage, isProblem, resultMessage } from "../../agent-core.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const page = readFileSync(path.join(ROOT, "index.html"), "utf8");
const tools = [{ name: "list_dir", description: "List a folder", args: '{"path": "C:/x"}' }];

test("the agent prompt starts with the task and the marker line follows after a blank line", () => {
  const p = agentPrompt(tools, "Do the thing", { workspace: "C:\\a\\workspace", projects: ["C:\\devl"] });
  assert.ok(p.startsWith("Do the thing\n\n" + MARK + " "));
  assert.ok(p.includes("- list_dir: List a folder\n  args example: {\"path\": \"C:/x\"}"));
  assert.ok(p.includes("workspace folder C:/a/workspace:"));
  assert.ok(p.includes("Code repos live in C:/devl:"));
  assert.ok(page.includes('m.text.indexOf("\\n" + MARK + " ")'), "the page splits stored tasks at the marker");
});

test("no projects: no repo rule", () => {
  const p = agentPrompt(tools, "t", { workspace: "C:/w", projects: [] });
  assert.ok(!p.includes("Code repos live in"));
});

test("RESULT messages match what the page parses from history", () => {
  const m = resultMessage("shell", "hi\n[exit code 0]");
  assert.ok(m.startsWith(MARK + " RESULT of shell:\nhi\n[exit code 0]\n\nNext tool call"));
  assert.ok(askUserResultMessage("The user answered: ok").startsWith(MARK + " RESULT of ask_user:\nThe user answered: ok\n\nNext tool call"));
  const re = /^\[local-agent\] RESULT of (\S+):\s*\n([\s\S]*?)\n\s*Next tool call/;
  assert.ok(page.includes("RESULT of (\\S+):"), "the page's history regex");
  assert.deepEqual(m.match(re).slice(1), ["shell", "hi\n[exit code 0]"]);
});

test("the verify and correction messages keep their prefixes", () => {
  assert.ok(VERIFY.startsWith(MARK + " Before you finish"));
  assert.ok(page.includes('MARK + " Before you finish"'));
  assert.ok(correctionMessage("x").startsWith(MARK + " Your reply was not one valid JSON tool call (x)"));
});

test("isProblem spots failed steps from the trailer line, or the first line's wording", () => {
  assert.ok(isProblem("error: boom"));
  assert.ok(isProblem("not run: sign-in"));
  assert.ok(isProblem("npm ERR!\n[exit code 1]"));
  assert.ok(isProblem("x\n[exit code 1, 2.0 s]"));
  assert.ok(!isProblem("created C:/x/a.txt (3 lines)"));
  assert.ok(!isProblem("hi\n"));
  assert.ok(!isProblem("docs mention [exit code 1 in the text\n[exit 0, 1.0 s]"), "the trailer decides");
  assert.ok(!isProblem("Error handling notes\nline 2", { data: true }), "a file's first line means nothing");
  assert.ok(isProblem("error: no such file", { data: false }));
});
