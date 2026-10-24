// search_files over a temp tree: literal and regex text, globs, skipped folders, sensitive and binary files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import search_files from "../../tools/search_files.ts";
import { globToRegExp } from "../../tools/_lib.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "m365-search-"));
const workspace = path.join(dir, "workspace"), repo = path.join(dir, "repo");
mkdirSync(workspace);
for (const d of ["src/auth", "tests", "node_modules/x", "config"]) mkdirSync(path.join(repo, d), { recursive: true });
writeFileSync(path.join(repo, "a.ts"), "root level\n");
writeFileSync(path.join(repo, "src/auth/login.ts"), "import x from 'y';\nexport async function loginUser(email: string) {\n  return email;\n}\n");
writeFileSync(path.join(repo, "tests/login.spec.ts"), 'import { loginUser } from "../src/auth/login";\ntest("x", () => loginUser("a"));\n');
writeFileSync(path.join(repo, "node_modules/x/index.js"), "loginUser in a dependency\n");
writeFileSync(path.join(repo, ".env"), "SECRET=loginUser\n");
writeFileSync(path.join(repo, "config/secrets.json"), '{"loginUser": 1}\n');
writeFileSync(path.join(repo, "bin.dat"), Buffer.from([0x6c, 0x6f, 0x67, 0x69, 0x6e, 0x55, 0x73, 0x65, 0x72, 0x00, 0x01]));
writeFileSync(path.join(repo, "utf16.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("loginUser wide\n", "utf16le")]));
const ctx = { workspace, projects: [repo], readRoots: [workspace, repo], root: ROOT, python: "", pythonIndexUrl: "", browserChannel: "msedge", trackWrite: () => {}, noteCheck: () => {} };
const run = (args) => search_files.run({ path: repo, ...args }, ctx);

test("a literal search: summary first, path:line: text, context lines, sensitive files by name only", async () => {
  const out = await run({ text: "loginUser(", glob: "**/*.ts", context: 1 });
  const lines = out.split("\n");
  assert.match(lines[0], /^2 matches in 2 files \(searched \d+ files; stopped at max 50: no\)$/);
  assert.ok(out.includes("src/auth/login.ts:2: export async function loginUser(email: string) {"), out);
  assert.ok(out.includes("src/auth/login.ts-3-   return email;"), out);
  assert.ok(out.includes("tests/login.spec.ts:2: "), out);
  assert.ok(!out.includes("node_modules"), "node_modules skipped");
  assert.ok(!out.includes("SECRET="), "sensitive content never shown");
});

test("without a glob: binary skipped, UTF-16 searched, .env and secrets listed as skipped", async () => {
  const out = await run({ text: "loginuser" });
  assert.ok(out.includes("utf16.txt:1: loginUser wide"), out);
  assert.ok(!out.includes("bin.dat"), out);
  assert.match(out, /sensitive files skipped \(read them with read_file if needed\): .*\.env/);
  assert.ok(out.includes("config/secrets.json"));
});

test("regex and case flags; an invalid regex is reported", async () => {
  assert.ok((await run({ text: "login\\w+\\(", regex: true })).includes("loginUser("));
  assert.ok((await run({ text: "LOGINUSER(", case: true })).startsWith("0 matches"));
  assert.match(await run({ text: "(", regex: true }), /^invalid regular expression: /);
});

test("glob only lists files, **/*.ts matches a root-level a.ts; max caps the matches", async () => {
  const out = await run({ glob: "**/*.ts" });
  assert.match(out, /^3 files match "\*\*\/\*\.ts"\n/);
  assert.ok(out.includes("a.ts\n"));
  const capped = await run({ text: "login", max: 1 });
  assert.match(capped, /^1 match in 1 file \(searched \d+ files; stopped at max 1: yes\)/);
  assert.match(await run({}), /^error: give text/);
});

test("a missing folder and a sensitive root", async () => {
  assert.match(await search_files.run({ path: path.join(repo, "nope"), text: "x" }, ctx), /^error: no folder at /);
  assert.equal(search_files.needsApproval({ path: path.join(repo, "config") }, ctx), false);
  assert.equal(search_files.needsApproval({ path: path.join(repo, "secrets") }, ctx), true, "a sensitive folder name asks");
  const out = await search_files.run({ path: path.join(repo, "config"), text: "loginUser" }, ctx);
  assert.ok(out.includes("sensitive files skipped"), "files under a plain root are still filtered by their own names");
});

test("globToRegExp", () => {
  assert.ok(globToRegExp("{*.ts,*.js}").test("a.js") && !globToRegExp("{*.ts,*.js}").test("a.py"));
  assert.ok(globToRegExp("**/*.ts").test("a.ts") && globToRegExp("**/*.ts").test("src/x/a.ts"));
  assert.ok(globToRegExp("src/**/*.{py,md}").test("src/a/b.md") && !globToRegExp("src/**/*.{py,md}").test("src/a/b.ts"));
  assert.ok(globToRegExp("a?.txt").test("a1.txt") && !globToRegExp("a?.txt").test("a12.txt"));
  assert.ok(globToRegExp("*.ts").test("A.TS") && !globToRegExp("*.ts").test("x/a.ts"));
});
