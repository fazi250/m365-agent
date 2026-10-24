// npm run diag  (npm run diag -- --ask: also one test message in a new chat, timed)
// One report on everything that can go wrong, saved in diag.txt: versions, config (secrets hidden), the server,
// reaching Copilot step by step (with a screenshot, diag.png), the end of agent.log, and the newest automatic
// capture from diag/ (the server saves one after every failed Copilot command). Send diag.txt (and the pictures)
// when something doesn't work. It names no chats and quotes no messages.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CopilotWeb } from "./copilot-web.ts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ask = process.argv.includes("--ask") || process.env.npm_config_ask === "true";
const configFile = process.env.M365_AGENT_CONFIG ? path.resolve(process.env.M365_AGENT_CONFIG) : path.join(ROOT, "config.json");
const config = {
  port: 4317, browser: "msedge", copilotUrl: "https://m365.cloud.microsoft/chat", pythonIndexUrl: "", replyTimeoutSec: 240,
  ...(existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {}),
};
const lines: string[] = [];
const say = (s: string) => { lines.push(s); console.log(s); };
const run = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", timeout: 20_000, windowsHide: true }).trim(); } catch { return "(not available)"; } };
const hideSecret = (url: string) => String(url).replace(/\/\/([^/@:]+):[^/@]+@/, "//$1:***@");
const tail = (file: string, n: number) => { try { return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-n); } catch { return []; } };

say(`== M365 Agent diag, ${new Date().toString()}`);
const commit = run("git", ["rev-parse", "--short", "HEAD"]);
const dirty = run("git", ["status", "--porcelain"]);
say(`code: commit ${commit}${dirty && dirty !== "(not available)" ? ` + local changes (${dirty.split("\n").length} files)` : ""}`);
let pw = "?";
try { pw = JSON.parse(readFileSync(path.join(ROOT, "node_modules", "playwright-core", "package.json"), "utf8")).version; } catch { pw = "NOT INSTALLED (run npm run setup)"; }
say(`Windows ${os.release()}, user ${os.userInfo().username}, Node ${process.version}, playwright-core ${pw}`);
const py = path.join(ROOT, ".venv", "Scripts", "python.exe");
say(`Python venv: ${existsSync(py) ? run(py, ["--version"]) : "MISSING (run npm run setup)"}; uv: ${run("uv", ["--version"])}`);
say(`config ${existsSync(configFile) ? configFile : "(none: defaults)"}: port ${config.port}, browser ${config.browser}, copilotUrl ${config.copilotUrl}, ` +
  `pythonIndexUrl ${config.pythonIndexUrl ? hideSecret(config.pythonIndexUrl) : "(PyPI)"}, workspace ${config.workspace ?? "workspace"}, projects ${JSON.stringify(config.projects ?? [])}`);
const profile = path.join(ROOT, ".copilot-web-profile");
say(`Copilot window profile: ${existsSync(profile) ? profile : "not created yet (first start)"}`);

// the server: when it runs, its Copilot window is the one to check (the profile can't be opened twice)
say("== server and Copilot");
const fromServer = await fetch(`http://127.0.0.1:${config.port}/api/diag`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ask }), signal: AbortSignal.timeout(240_000),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }), (e) => ({ status: 0, body: { error: String(e?.cause?.code ?? e?.message ?? e) } }));
if (fromServer.status === 200) {
  say(`server: running on port ${config.port}`);
  for (const l of fromServer.body.lines ?? []) say(l);
} else if (fromServer.status) {
  say(`server: running on port ${config.port}, but diag answered ${fromServer.status}: ${fromServer.body.error ?? ""}`);
} else {
  say(`server: not running on port ${config.port} (${fromServer.body.error}); checking Copilot from here`);
  const w = new CopilotWeb({ root: ROOT, url: config.copilotUrl, channel: config.browser, replyTimeoutSec: Number(config.replyTimeoutSec) || 240 });
  for (const l of await w.diagnose({ ask, screenshot: path.join(ROOT, "diag.png") })) say(l);
  await w.close();
}

say("== agent.log, last 40 lines");
const log = tail(path.join(ROOT, "agent.log"), 40);
for (const l of log.length ? log : ["(empty)"]) say(l);

const diagDir = path.join(ROOT, "diag");
const captures = existsSync(diagDir) ? readdirSync(diagDir).filter((f) => f.endsWith(".txt")).sort() : [];
say(`== automatic captures after failed Copilot commands: ${captures.length}${captures.length ? ` (in ${diagDir})` : ""}`);
if (captures.length) {
  say(`newest: ${captures.at(-1)}`);
  for (const l of readFileSync(path.join(diagDir, captures.at(-1)!), "utf8").split(/\r?\n/).filter(Boolean)) if (!/^\d{4}-\d\d-\d\dT/.test(l)) say(`  ${l}`);
}

const out = path.join(ROOT, "diag.txt");
writeFileSync(out, lines.join("\n") + "\n", "utf8");
console.log(`\n== saved in ${out}. Send that file, diag.png${captures.length ? ` and the newest .png in ${diagDir}` : ""}.`);
