// Test harness: starts server.ts with a scratch config (its own workspace, repo folder, approvals and log under
// %TEMP%/m365-agent-tests/<name>-<pid>-<n>/, outside this repo, since writes inside the agent's own folder are
// protected and would ask) and the fake Copilot (fake-bridge.mjs), listens to its events and talks to its API.
//   const s = await startServer({ replies: [...], approvals: ["once"] });
//   await s.post("/api/send", { message: "...", tools: ["list_dir"] });
//   const done = await s.waitFor((e) => e.type === "done");
//   s.asks()  // what Copilot was sent, in order
//   await s.stop();
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TMP = path.join(os.tmpdir(), "m365-agent-tests");
let seq = 0;

// rules: saved "Always allow" rules to start with, as a list or a function of { workspace, repo } (written to approvals.json)
export async function startServer({ replies = [], config = {}, approvals = [], rules = [], name = "t" } = {}) {
  if (!seq) { // the scratch folders of earlier runs go; this run's stay for a look after a failure
    try { for (const d of readdirSync(TMP)) if (!d.includes(`-${process.pid}-`)) rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch { /* no .tmp yet */ }
  }
  const dir = path.join(TMP, `${name}-${process.pid}-${++seq}`);
  rmSync(dir, { recursive: true, force: true });
  const workspace = path.join(dir, "workspace"), repo = path.join(dir, "repo");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const cfg = {
    port: 0, workspace: "workspace", projects: [repo], readRoots: [], maxSteps: 12, maxResult: 8000,
    bridgeScript: path.join(ROOT, "tests", "fake-bridge.mjs"), logFile: path.join(dir, "agent.log"), ...config,
  };
  const configFile = path.join(dir, "config.json");
  writeFileSync(configFile, JSON.stringify(cfg, null, 2));
  const saved = typeof rules === "function" ? rules({ workspace, repo }) : rules;
  if (saved.length) writeFileSync(path.join(dir, "approvals.json"), JSON.stringify(saved.map((r) => ({ added: new Date().toISOString(), ...r })), null, 2));
  const repliesFile = path.join(dir, "replies.json");
  writeFileSync(repliesFile, JSON.stringify(replies));

  const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.ts"], {
    cwd: ROOT, windowsHide: true,
    env: { ...process.env, M365_AGENT_CONFIG: configFile, FAKE_DIR: dir, FAKE_REPLIES_FILE: repliesFile },
  });
  let output = "";
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start in 30 s: ${output}`)), 30_000);
    proc.stdout.on("data", (d) => { output += d; const m = output.match(/127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
    proc.stderr.on("data", (d) => (output += d));
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited with ${code}: ${output}`)); });
  });
  const base = `http://127.0.0.1:${port}`;

  // the event stream, read from before the first request so nothing is missed (the connect-time busy/idle state is
  // kept apart, so waiting for "idle" waits for a task's end)
  const events = [];
  const waiters = [];
  // decisions for approval cards, applied in order: "once" | "task" | "always" | "deny", or { decision, kind, reason }
  const policy = [...approvals];
  const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });
  const get = (p) => fetch(base + p);
  let first = true;
  const onEvent = (ev) => {
    if (first) { first = false; return; }
    events.push(ev);
    for (const w of [...waiters]) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
    if (ev.type === "approve" && policy.length) { const p = policy.shift(); post("/api/approve", { id: ev.id, ...(typeof p === "string" ? { decision: p } : p) }); }
  };
  const sse = await fetch(base + "/api/events");
  const reader = sse.body.getReader();
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split("\n")) if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)));
      }
    }
  })().catch(() => {});

  return {
    port, base, dir, workspace, repo, events, post, get,
    /** the next event matching pred (events already received count too, from `after` on) */
    waitFor(pred, { timeout = 20_000, after = 0 } = {}) {
      const seen = events.slice(after).find(pred);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`no event matched within ${timeout} ms; last events: ${JSON.stringify(events.slice(-5))}`)); }, timeout);
        const w = { pred, resolve: (ev) => { clearTimeout(timer); resolve(ev); } };
        waiters.push(w);
      });
    },
    /** every message the server sent to (fake) Copilot, in order */
    asks() {
      const f = path.join(dir, "asks.log");
      if (!existsSync(f)) return [];
      return [...readFileSync(f, "utf8").matchAll(/===ASK \d+===\n([\s\S]*?)\n===END===/g)].map((m) => m[1]);
    },
    /** answer the open ask_user question */
    async answer(text) {
      const q = events.findLast((e) => e.type === "question");
      return post("/api/answer", { id: q.id, text });
    },
    log: () => (existsSync(cfg.logFile) ? readFileSync(cfg.logFile, "utf8") : ""),
    async stop() {
      reader.cancel().catch(() => {});
      await new Promise((resolve) => {
        proc.on("exit", resolve);
        if (process.platform === "win32") spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        else proc.kill();
        setTimeout(resolve, 5000);
      });
    },
  };
}
