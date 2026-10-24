// Protected paths: the agent's own code, settings, Keep / Undo store, .git folders and browser profiles always ask,
// with a reason and without Always allow, even inside a trusted folder; everything else keeps the old rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalPath, pathRule, pathWarning, protectedPath } from "../../tools/_lib.ts";
import write_file from "../../tools/write_file.ts";
import read_file from "../../tools/read_file.ts";

// a stand-in for C:/devl/m365-agent with C:/devl as the trusted projects folder (the real layout in config.json)
const devl = mkdtempSync(path.join(os.tmpdir(), "m365-devl-"));
const root = path.join(devl, "m365-agent"), workspace = path.join(root, "workspace"), repo = path.join(devl, "pw-demo");
for (const d of [path.join(root, "tools"), path.join(workspace, ".changes"), path.join(repo, ".git", "hooks"), path.join(repo, "src"), path.join(repo, ".github", "workflows"), path.join(root, ".copilot-web-profile", "Default"), path.join(root, "diag")]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(root, "approvals.json"), "[]");
writeFileSync(path.join(root, "config.json"), "{}");
writeFileSync(path.join(root, "server.ts"), "// server");
writeFileSync(path.join(root, "tools", "shell.ts"), "// shell");
writeFileSync(path.join(root, "agent.log"), "");
const ctx = { workspace, projects: [devl], readRoots: [workspace, devl], root, configDir: root, python: "", pythonIndexUrl: "", browserChannel: "msedge", trackWrite: () => {}, noteCheck: () => {} };
const w = (p) => protectedPath(p, ctx, "write"), r = (p) => protectedPath(p, ctx, "read");

test("writes to the agent's own files, the Keep/Undo store, .git and browser profiles are protected", () => {
  assert.match(w(path.join(root, "approvals.json")), /^the agent's own settings \(approvals\.json\): a change takes effect at the next server start$/);
  assert.match(w(path.join(root, "config.json")), /^the agent's own settings \(config\.json\)/);
  assert.match(w(path.join(root, "tools", "shell.ts")), /^the agent's own code and settings/);
  assert.match(w(path.join(root, "server.ts")), /^the agent's own code and settings/);
  assert.match(w(path.join(workspace, ".changes", "index.json")), /^the Keep \/ Undo store/);
  assert.match(w(path.join(repo, ".git", "hooks", "pre-commit")), /^git hooks and config run code/);
  assert.match(w(path.join(repo, ".git", "config")), /^git hooks and config/);
  assert.match(w(path.join(root, ".copilot-web-profile", "Default", "Local Storage", "leveldb", "000003.log")), /^a signed-in browser profile/);
  assert.match(w("C:/Users/me/AppData/Local/Microsoft/Edge/User Data/Default/Cookies"), /^a signed-in browser profile/);
});

test("other spellings of a protected path are caught: trailing dot, upper case, forward slashes", () => {
  assert.ok(w(path.join(root, "approvals.json.")), "trailing dot");
  assert.ok(w(path.join(root, "APPROVALS.JSON")), "upper case");
  assert.ok(w(root.replace(/\\/g, "/") + "/tools/shell.ts"), "forward slashes");
  assert.ok(w(path.join(root, "tools", "..", "approvals.json")), "a .. segment");
  assert.equal(canonicalPath(path.join(root, "approvals.json.")), path.join(root, "approvals.json"));
});

test("ordinary files in the workspace and in repos are not protected", () => {
  assert.equal(w(path.join(workspace, "report.docx")), null);
  assert.equal(w(path.join(workspace, "scripts", "x.py")), null);
  assert.equal(w(path.join(repo, "src", "a.ts")), null);
  assert.equal(w(path.join(repo, ".github", "workflows", "ci.yml")), null);
  assert.equal(w(path.join(repo, "approvals.json")), null, "only the agent's own approvals.json");
  assert.equal(w(path.join(repo, ".gitignore")), null, "a .gitignore is not the .git folder");
});

test("reading: the agent's source is free, its config, trace, captures, store and profiles ask", () => {
  assert.equal(r(path.join(root, "server.ts")), null);
  assert.equal(r(path.join(root, "approvals.json")), null);
  assert.match(r(path.join(root, "config.json")), /^the agent's own settings \(config\.json; it can hold a package index token\)$/);
  assert.match(r(path.join(root, "agent.log")), /^the agent's own trace/);
  assert.match(r(path.join(root, "agent.log.old")), /^the agent's own trace/);
  assert.match(r(path.join(root, "diag", "2026-x.txt")), /^the agent's own captures/);
  assert.match(r(path.join(workspace, ".changes", "index.json")), /^the Keep \/ Undo store/);
  assert.match(r(path.join(root, ".copilot-web-profile", "Default", "Cookies")), /^a signed-in browser profile/);
});

test("pathRule gives no Always allow for a protected path; pathWarning names the reason in red", () => {
  assert.equal(pathRule(path.join(root, "approvals.json"), "writing", ctx), null);
  assert.deepEqual(pathRule(path.join(repo, "src", "a.ts"), "writing", ctx), { key: `dir:${path.join(repo, "src").toLowerCase()}`, label: `writing files in ${path.join(repo, "src")}` });
  assert.deepEqual(pathRule(path.join(repo, ".env"), "reading", ctx), { key: `file:${path.join(repo, ".env").toLowerCase()}`, label: `reading the file ${path.join(repo, ".env")}` });
  assert.equal(pathWarning(path.join(repo, "src", "a.ts"), true), null);
  assert.equal(pathWarning(path.join(root, "approvals.json"), true, { protectedWhy: w(path.join(root, "approvals.json")), tail: "the file will be created or replaced" }),
    "PROTECTED, the agent's own settings (approvals.json): a change takes effect at the next server start: the file will be created or replaced");
  assert.equal(pathWarning("C:/elsewhere/.env", false), "SENSITIVE FILE (keys, passwords or tokens may be in it); outside your trusted folders: what is read goes into the Copilot chat");
});

test("write_file and read_file ask for protected paths inside the trusted folders, with no Always allow", () => {
  assert.equal(write_file.needsApproval({ path: path.join(repo, "src", "a.ts") }, ctx), false);
  assert.equal(write_file.needsApproval({ path: path.join(root, "tools", "shell.ts") }, ctx), true);
  assert.equal(write_file.alwaysRule({ path: path.join(root, "tools", "shell.ts") }, ctx), null);
  assert.match(write_file.warning({ path: path.join(repo, ".git", "hooks", "pre-commit") }, ctx), /^PROTECTED, git hooks/);
  assert.equal(read_file.needsApproval({ path: path.join(root, "server.ts") }, ctx), false);
  assert.equal(read_file.needsApproval({ path: path.join(root, "config.json") }, ctx), true);
  assert.equal(read_file.alwaysRule({ path: path.join(root, "config.json") }, ctx), null);
  assert.ok(read_file.alwaysRule({ path: path.join(root, "server.ts") }, ctx));
});
