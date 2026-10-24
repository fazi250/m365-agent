// copilot-web.ts splices a code block's exact text into the reply with String.replace. With a string as the
// replacement, "$&", "$$", "$`" and "$'" inside the code are replacement patterns and the file comes out wrong
// (a bash "$$", a PowerShell "$'..." or a JS template with "$&"); a function replacer inserts the text as it is.
// readMessages runs inside the page, so this pins the rule it relies on rather than the function itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const code = 'echo "pid $$"; x=$&; y=$`z';

test("copilot-web.ts splices with a function replacer", () => {
  const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "copilot-web.ts"), "utf8");
  assert.ok(src.includes("text.replace(shown, () => block)"), "the function replacer is in readMessages");
  assert.ok(!src.includes("text.replace(shown, block)"), "no string replacer");
});
const shown = "SHOWN";
const text = `before ${shown} after`;

test("a string replacer corrupts code with dollar patterns", () => {
  assert.notEqual(text.replace(shown, code), `before ${code} after`);
});

test("a function replacer keeps the code byte for byte (what copilot-web.ts uses)", () => {
  assert.equal(text.replace(shown, () => code), `before ${code} after`);
});
