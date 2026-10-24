// Task summaries from agent.log, for npm run diag: one line per task with its round trips (how many, how long,
// how each reply was taken as finished), its tool calls and how it ended. Only numbers and categories come out:
// no task text, tool arguments or results, so a summary can be sent to whoever helps. Pure: no file access.
export type TaskSummary = {
  at: string; // when the task started (ISO)
  tools: string[]; // the tools given to Copilot (none: chat mode)
  asks: number[]; // every Copilot round trip, in ms
  via: Record<string, number>; // how replies were taken as finished: button / stable30 / progress60 / -
  phases: Record<string, number[]>; // the ask() timing breakdown per round trip, when the log has it (ready, send, first, button, settle, chatId)
  calls: number; // tool calls run
  problems: number; // tool calls whose result read as a problem
  approvals: Record<string, number>; // once / task / always / deny
  ending: "done" | "reply" | "stopped" | "steps" | "error" | "crash" | "cut off"; // cut off: the log ends or a new task / server start follows
};

const LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/;

export function parseLog(text: string): TaskSummary[] {
  const tasks: TaskSummary[] = [];
  let cur: TaskSummary | null = null;
  const close = (ending: TaskSummary["ending"]) => { if (cur) { cur.ending = ending; cur = null; } };
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(LINE);
    if (!m) continue;
    const [, at, line] = m;
    if (line.startsWith("task: ")) {
      close("cut off");
      const tools = line.match(/tools: ([^:]*?):/)?.[1] ?? "";
      cur = { at, tools: /^none/.test(tools) ? [] : tools.split(",").filter(Boolean), asks: [], via: {}, phases: {}, calls: 0, problems: 0, approvals: {}, ending: "cut off" };
      tasks.push(cur);
      continue;
    }
    if (line.startsWith("server start:")) { close("cut off"); continue; }
    if (/^(CRASH|UNHANDLED)\b/.test(line)) { close("crash"); continue; }
    if (!cur) continue;
    let r: RegExpMatchArray | null;
    if ((r = line.match(/^copilot ask(?: -New)? (\d+)ms -> (ok|ERROR)(?: via (\S+?),)?/))) {
      cur.asks.push(Number(r[1]));
      if (r[2] === "ok") cur.via[r[3] ?? "-"] = (cur.via[r[3] ?? "-"] ?? 0) + 1;
      const breakdown = line.match(/\((ready \d+[^)]*)\)/)?.[1];
      if (breakdown) for (const part of breakdown.split(", ")) { const [k, v] = part.split(" "); if (k && /^\d+$/.test(v ?? "")) (cur.phases[k] ??= []).push(Number(v)); }
      continue;
    }
    if (/^tool \S+ .*-> (ok|PROBLEM)/.test(line.trim())) { cur.calls++; if (/-> PROBLEM/.test(line)) cur.problems++; continue; }
    if ((r = line.trim().match(/^approval \S+: (once|task|always|deny)\b/))) { cur.approvals[r[1]] = (cur.approvals[r[1]] ?? 0) + 1; continue; }
    if (line.startsWith("task end: done")) { close("done"); continue; }
    if (line.startsWith("task end:")) { close("reply"); continue; }
    if (line.startsWith("page shows error: stopped after")) { close("steps"); continue; }
    if (line.startsWith("page shows error: stopped")) { close("stopped"); continue; }
    if (line.startsWith("page shows error:")) { close("error"); continue; }
  }
  return tasks;
}

const stats = (xs: number[]) => {
  if (!xs.length) return "none";
  const s = [...xs].sort((a, b) => a - b);
  const med = s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
  return `${xs.length} (min ${(s[0] / 1000).toFixed(1)} s, median ${(med / 1000).toFixed(1)} s, max ${(s[s.length - 1] / 1000).toFixed(1)} s)`;
};
const hist = (h: Record<string, number>) => Object.entries(h).map(([k, v]) => `${k} ${v}`).join(", ") || "none";

/** report lines for the tasks in a log (newest last), at most `limit` tasks */
export function summarizeLog(text: string, limit = 20): string[] {
  const tasks = parseLog(text).slice(-limit);
  if (!tasks.length) return ["(no tasks in the log)"];
  return tasks.map((t) => {
    const phases = Object.keys(t.phases).length ? `; phases median: ${Object.entries(t.phases).map(([k, v]) => `${k} ${(([...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]) / 1000).toFixed(1)} s`).join(", ")}` : "";
    return `${t.at.slice(0, 19).replace("T", " ")}  ${t.tools.length ? `${t.tools.length} tools` : "chat"}: ${t.asks.length ? `round trips ${stats(t.asks)}, via ${hist(t.via)}` : "no round trips"}` +
      `; tool calls ${t.calls}${t.problems ? ` (${t.problems} with a problem)` : ""}; approvals ${hist(t.approvals)}; ended: ${t.ending}${phases}`;
  });
}
