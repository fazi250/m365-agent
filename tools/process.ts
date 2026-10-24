// Long-running programs in the background: a dev server, a watcher, anything the shell tool would wait for in vain.
// start runs it and returns the first output (waiting for its port or a ready line), output reads what it printed
// since, port probes a port, list and stop manage them. They outlive the step, so the browser tool can test against
// them, and the page shows them with a Stop button each. The registry lives in _procs.ts.
import { SIGN_IN, commandFlags, workingDir, type Tool } from "./_lib.ts";
import { describe, fmtTime, getBackground, listBackground, probePort, readBackground, startBackground, stopBackground, waitReady } from "./_procs.ts";

const fwd = (p: string) => p.replace(/\\/g, "/");
const action = (args: Record<string, any>) => String(args.action ?? "").trim().toLowerCase();
const command = (args: Record<string, any>) => String(args.command ?? "").trim();
const nameOf = (args: Record<string, any>) => String(args.name ?? "").trim();
const NAME = /^[\w-]{1,40}$/;
const cwdKey = (args: Record<string, any>, ctx: any) => { try { return fwd(workingDir(args.cwd, ctx)).toLowerCase(); } catch { return String(args.cwd ?? "").toLowerCase(); } };
const lastLines = (text: string, n: number) => { const l = text.split("\n").filter((x, i, a) => i < a.length - 1 || x !== ""); return (l.length > n ? l.slice(-n) : l).map((x) => `  ${x}`).join("\n") || "  (no output yet)"; };

const tool: Tool = {
  name: "process",
  description:
    "Start a long-running command in the background (a dev server, a watcher) and read its output later; one-shot " +
    'commands belong to shell. start {"name", "command", "cwd", "port", "ready", "wait_s"}: runs it and returns the first ' +
    "output, waiting up to wait_s (max 90) for the port to answer or a line to match ready (a regex). output " +
    '{"name", "tail": 80} or {"name", "since": true, "wait_s": 10} (new lines only, waiting up to wait_s for them) or ' +
    '{"name", "grep": "error"}. list. stop {"name"}. port {"port": 8000, "wait_s": 10}. Then check the app with browser ' +
    "open http://localhost:PORT. Leave servers running unless the user asks to stop them; the page has a Stop button for each.",
  args: '{"action": "start", "name": "dev", "command": "npm run dev", "cwd": "C:/devl/my-repo", "port": 5173, "ready": "ready in|Local:", "wait_s": 60}',
  approvalHint: "start asks (it runs code); output, list, stop and port run on their own",
  runsCode: true,
  processOutput: true,
  needsApproval: (args) => action(args) === "start" && !SIGN_IN.test(command(args)), // a sign-in is refused without running
  flags: (args, ctx) => (action(args) === "start" ? commandFlags(command(args), ctx, { cwd: args.cwd }) : []),
  warning: (args) => (action(args) === "start" ? "runs in the background until stopped; a watcher re-runs files the agent changes later without asking" : null),
  alwaysRule: (args, ctx) => {
    if (action(args) !== "start" || commandFlags(command(args), ctx, { cwd: args.cwd }).length) return null;
    return { key: `${cwdKey(args, ctx)}|${command(args)}`, label: `the background command: ${command(args)}${args.cwd ? ` (in ${args.cwd})` : ""}` };
  },
  taskRule: (args, ctx) => tool.alwaysRule!(args, ctx),
  run: async (args, ctx) => {
    const a = action(args);
    if (!["start", "output", "list", "stop", "port"].includes(a)) return 'error: action must be start, output, list, stop or port';
    if (a === "list") {
      const all = listBackground();
      return all.length ? all.map(describe).join("\n") : "(no background processes)";
    }
    if (a === "port") {
      const port = Number(args.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return "error: port must be a number between 1 and 65535";
      const until = Date.now() + Math.min(Math.max(Number(args.wait_s) || 0, 0), 90) * 1000;
      do { if (await probePort(port)) return `port ${port} answers on localhost`; await new Promise((r) => setTimeout(r, 400)); } while (Date.now() < until);
      return `port ${port} does not answer on localhost${args.wait_s ? ` (waited ${Math.min(Number(args.wait_s), 90)} s)` : ""}`;
    }
    const name = nameOf(args);
    if (!NAME.test(name)) return 'error: name must be 1-40 letters, digits, _ or - (e.g. "dev")';
    if (a === "start") {
      const cmd = command(args);
      if (!cmd) return 'error: nothing to start: send {"action": "start", "name": "dev", "command": "npm run dev", "cwd": "..."}';
      const sign = SIGN_IN.exec(cmd);
      if (sign) return `not run: "${sign[0]}" signs in or asks for input; nobody can type into a background process. Ask the user to run it in their own terminal.`;
      let cwd: string;
      try { cwd = workingDir(args.cwd, ctx); } catch (e) { return `error: ${e instanceof Error ? e.message : e}`; }
      const port = args.port == null ? undefined : Number(args.port);
      if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) return "error: port must be a number between 1 and 65535";
      let ready: RegExp | null = null;
      if (args.ready != null) { try { ready = new RegExp(String(args.ready).slice(0, 200), "i"); } catch { return `error: ready is not a valid regex: ${String(args.ready).slice(0, 80)}`; } }
      if (port && (await probePort(port))) return `error: port ${port} already answers: something is running there (process list shows what this agent started; otherwise it is another program)`;
      let p;
      try { p = startBackground(ctx, { name, command: cmd, cwd, port }); } catch (e) { return `error: ${e instanceof Error ? e.message : e}`; }
      const waitMs = Math.min(Math.max(Number(args.wait_s) || (port || ready ? 60 : 3), 1), 90) * 1000;
      const how = await waitReady(p, { port, ready, timeoutMs: waitMs });
      const secs = ((Date.now() - p.startedAt) / 1000).toFixed(1);
      if (how === "exit") return `"${name}" exited with code ${p.exit} after ${secs} s: ${cmd} (in ${fwd(cwd)})\n--- output ---\n${lastLines(p.buf, 40)}`;
      const head = `started "${name}" (pid ${p.pid}) in ${fwd(cwd)}: ${cmd}`;
      const state = how === "port" ? `ready: port ${port} answers after ${secs} s`
        : how === "ready" ? `ready: a line matched /${ready!.source}/ after ${secs} s`
        : port || ready ? `"${name}" is running but after ${Math.round(waitMs / 1000)} s ${[port ? `port ${port} does not answer` : "", ready ? `no line matched /${ready.source}/` : ""].filter(Boolean).join(" and ")}`
        : `running (no port or ready line to wait for)`;
      readBackground(p); // start's output counts as read: the next output {since: true} gives what comes after
      return `${head}\n${state}\n--- last 20 lines ---\n${lastLines(p.buf, 20)}\n(more: process output {"name": "${name}"}; end it: process stop)`;
    }
    const p = getBackground(name);
    if (!p) { const names = listBackground().map((x) => x.name); return `no background process "${name}"${names.length ? ` (running: ${names.join(", ")})` : " (none are running)"}`; }
    if (a === "output") {
      const waitMs = Math.min(Math.max(Number(args.wait_s) || 0, 0), 90) * 1000;
      if (args.since && waitMs) { const until = Date.now() + waitMs; while (Date.now() < until && p.total <= p.cursor && p.exit == null) await new Promise((r) => setTimeout(r, 300)); }
      const r = readBackground(p, { tail: args.tail, since: !!args.since, grep: args.grep == null ? undefined : String(args.grep) });
      const portNote = p.port ? `, port ${p.port} ${(await probePort(p.port)) ? "open" : "not answering"}` : "";
      const state = p.exit == null ? `running ${fmtTime(Date.now() - p.startedAt)} (pid ${p.pid})${portNote}` : `${p.stoppedByUser ? "stopped" : `exited with code ${p.exit}`} after ${fmtTime((p.endedAt ?? Date.now()) - p.startedAt)}`;
      if (args.since && !r.lines) return `"${name}" ${state}; no new output since the last read`;
      const what = args.grep != null ? `${r.lines} line(s) match /${String(args.grep).slice(0, 80)}/` : args.since ? `${r.lines} new line(s)` : `last ${Math.min(r.lines, Math.min(Math.max(Number(args.tail) || 80, 1), 500))} of ${r.lines} line(s) kept`;
      return `"${name}" ${state}; ${what}${r.dropped ? " (older output was dropped from the buffer; the full log is in workspace/.runs/)" : ""}:\n${r.text}`;
    }
    if (a === "stop") {
      const age = fmtTime((p.endedAt ?? Date.now()) - p.startedAt);
      const was = p.exit != null;
      await stopBackground(name);
      return was ? `"${name}" had already ${p.stoppedByUser ? "been stopped" : `exited with code ${p.exit}`} after ${age}; removed from the list` : `stopped "${name}" (pid ${p.pid}) after ${age}; last lines:\n${lastLines(p.buf, 10)}`;
    }
    return "error: unreachable";
  },
};
export default tool;
