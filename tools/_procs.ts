// Background programs the agent starts with the process tool (dev servers, watchers): they outlive the step, keep
// their output in a ring buffer and in workspace/.runs/<name>.log, and end through process stop, the Stop button next
// to them in the page, or when this server exits. They are NOT in runProcess's "running" set, so the page's task Stop
// leaves them alone. Not loaded as a tool (the leading "_").
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { PS_PRELUDE, commandEnv, type ToolContext } from "./_lib.ts";

export const MARKER = "# m365-agent-run"; // ends every background command line, so leftovers of an earlier server can be found
const PS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
const RING = 256 * 1024; // characters of output kept in memory per process
const LOG_MAX = 20 * 1024 * 1024; // bytes per log file

export type Proc = {
  name: string; pid: number; command: string; cwd: string; port?: number; startedAt: number;
  exit: number | null; endedAt?: number; stoppedByUser: boolean;
  child: ChildProcess; buf: string; total: number; cursor: number; logFile: string; logBytes: number;
};
const procs = new Map<string, Proc>();
let onChange: (() => void) | null = null; // the server's hook: a process started, exited or was stopped
export const setBackgroundListener = (fn: () => void) => { onChange = fn; };
const changed = () => { try { onChange?.(); } catch { /* the page's problem */ } };

export const fmtTime = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
const fwd = (p: string) => p.replace(/\\/g, "/");
const runsDir = (ctx: ToolContext) => path.join(ctx.workspace, ".runs");
const pidsFile = (ctx: ToolContext) => path.join(runsDir(ctx), "pids.json");

function savePids(ctx: ToolContext) {
  try {
    mkdirSync(runsDir(ctx), { recursive: true });
    const live = [...procs.values()].filter((p) => p.exit == null).map((p) => ({ name: p.name, pid: p.pid, command: p.command, startedAt: new Date(p.startedAt).toISOString() }));
    writeFileSync(pidsFile(ctx), JSON.stringify(live, null, 2), "utf8");
  } catch { /* the sweep is best effort */ }
}

let cleanupInstalled = false;
// when this server ends (Ctrl+C, closed window, crash), its background programs end too: one synchronous pass
function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on("exit", () => { for (const p of procs.values()) if (p.exit == null) killTreeSync(p.pid); });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) process.on(sig, () => process.exit(130));
}
const killTreeSync = (pid: number) => { try { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 }); } catch { /* gone already */ } };

/** the live processes (and the ones that ended since the last list, for their exit codes) */
export const listBackground = () => [...procs.values()];
export const getBackground = (name: string) => procs.get(name);

export function startBackground(ctx: ToolContext, o: { name: string; command: string; cwd: string; port?: number }): Proc {
  installCleanup();
  const old = procs.get(o.name);
  if (old && old.exit == null) throw new Error(`"${o.name}" is already running (pid ${old.pid}); stop it or use another name`);
  mkdirSync(runsDir(ctx), { recursive: true });
  const logFile = path.join(runsDir(ctx), `${o.name}.log`);
  writeFileSync(logFile, `# ${new Date().toISOString()} ${o.command} (in ${o.cwd})\n`, "utf8");
  const env = { ...commandEnv(ctx, { ci: true }), FORCE_COLOR: "0" };
  // the command, then (own line: the command may end in a comment) its exit code passed on, then the marker
  const child = spawn("powershell", [...PS, "-Command", `${PS_PRELUDE}${o.command}\nif ($LASTEXITCODE) { exit $LASTEXITCODE } ${MARKER} ${o.name}`], { cwd: o.cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const p: Proc = { name: o.name, pid: child.pid ?? 0, command: o.command, cwd: o.cwd, port: o.port, startedAt: Date.now(), exit: null, stoppedByUser: false, child, buf: "", total: 0, cursor: 0, logFile, logBytes: 0 };
  procs.set(o.name, p);
  const dec = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };
  const take = (s: string) => {
    const text = s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n?/g, "\n");
    p.total += text.length;
    p.buf = (p.buf + text).slice(-RING);
    if (p.logBytes < LOG_MAX) { try { appendFileSync(logFile, text, "utf8"); p.logBytes += Buffer.byteLength(text); } catch { /* keep the ring */ } }
  };
  child.stdout.on("data", (d) => take(dec.out.write(d)));
  child.stderr.on("data", (d) => take(dec.err.write(d)));
  child.on("error", (e) => take(`\n[error: ${e.message}]\n`));
  child.on("close", (code) => {
    take(dec.out.end() + dec.err.end());
    p.exit = code ?? -1;
    p.endedAt = Date.now();
    savePids(ctx);
    changed();
  });
  savePids(ctx);
  changed();
  return p;
}

/** ends a process with everything it started; resolves when it is gone (or after 3 s) */
export async function stopBackground(name: string): Promise<Proc | null> {
  const p = procs.get(name);
  if (!p) return null;
  if (p.exit == null) {
    p.stoppedByUser = true;
    const gone = new Promise<void>((resolve) => { p.child.once("close", () => resolve()); setTimeout(resolve, 3000); });
    spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await gone;
  }
  procs.delete(name); // ended: it leaves the list (its log file stays)
  changed();
  return p;
}
export async function stopAllBackground(): Promise<Proc[]> {
  const out: Proc[] = [];
  for (const name of [...procs.keys()]) { const p = await stopBackground(name); if (p) out.push(p); }
  return out;
}

/** the output: the last `tail` lines, or only what came since the last read (since), or the lines matching grep */
export function readBackground(p: Proc, o: { tail?: number; since?: boolean; grep?: string } = {}): { text: string; lines: number; dropped: boolean } {
  const start = p.total - p.buf.length; // absolute position of buf[0]
  let text: string, dropped = false;
  if (o.since) {
    dropped = p.cursor < start;
    text = p.buf.slice(Math.max(0, p.cursor - start));
  } else text = p.buf;
  p.cursor = p.total;
  let lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (o.grep) {
    let re: RegExp;
    try { re = new RegExp(o.grep.slice(0, 200), "i"); } catch { re = new RegExp(o.grep.slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
    lines = lines.filter((l) => re.test(l));
  }
  const n = lines.length;
  const tail = Math.min(Math.max(Number(o.tail) || 80, 1), 500);
  if (lines.length > tail) lines = [`…(${lines.length - tail} earlier lines left out)`, ...lines.slice(-tail)];
  return { text: lines.join("\n"), lines: n, dropped };
}

/** does something answer on this port (127.0.0.1, then ::1)? */
export function probePort(port: number, host?: string): Promise<boolean> {
  const one = (h: string) => new Promise<boolean>((resolve) => {
    const s = net.connect({ port, host: h });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(1000, () => done(false));
  });
  return host ? one(host) : one("127.0.0.1").then((ok) => ok || one("::1"));
}

/** waits until the port answers, a line matches ready, the process ends, or the time is up */
export async function waitReady(p: Proc, o: { port?: number; ready?: RegExp | null; timeoutMs: number }): Promise<"port" | "ready" | "exit" | "timeout"> {
  const until = Date.now() + o.timeoutMs;
  while (Date.now() < until) {
    if (p.exit != null) return "exit";
    if (o.ready && o.ready.test(p.buf)) return "ready";
    if (o.port && (await probePort(o.port))) return "port";
    await new Promise((r) => setTimeout(r, 400));
  }
  return p.exit != null ? "exit" : "timeout";
}

/** at server start: ends background programs an earlier server left behind (listed in pids.json, still carrying the marker) */
export function sweepLeftovers(ctx: ToolContext): string[] {
  const file = pidsFile(ctx);
  if (!existsSync(file)) return [];
  let old: { name: string; pid: number }[] = [];
  try { old = JSON.parse(readFileSync(file, "utf8")); } catch { old = []; }
  const ended: string[] = [];
  for (const o of old) {
    if (!Number.isInteger(o.pid) || o.pid <= 0) continue;
    try {
      const line = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${o.pid}").CommandLine`], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
      if (!line.includes(MARKER)) continue; // the pid belongs to something else now
      killTreeSync(o.pid);
      ended.push(`${o.name} (pid ${o.pid})`);
    } catch { /* not there any more */ }
  }
  try { writeFileSync(file, "[]", "utf8"); } catch { /* fine */ }
  return ended;
}

/** one line per process, for the page, the prompt and the list action */
export function describe(p: Proc): string {
  const age = fmtTime((p.endedAt ?? Date.now()) - p.startedAt);
  const state = p.exit == null ? `running ${age} (pid ${p.pid})` : p.stoppedByUser ? `stopped after ${age}` : `exited with code ${p.exit} after ${age}`;
  return `${p.name}: ${p.command} (in ${fwd(p.cwd)}${p.port ? `, port ${p.port}` : ""}), ${state}`;
}
