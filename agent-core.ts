// The pure part of the agent loop: the prompt Copilot gets, the parser for its replies, the messages the server
// sends back, and the line diff. No file, network or Copilot access, so tests import it directly and the page gets
// the same code as /agent-core.js (server.ts strips the types with node:module; keep to plain TypeScript syntax:
// no enums, namespaces or parameter properties).
export const MARK = "[local-agent]"; // starts every message this app sends in agent mode, so the page can render old ones

export type Call = { tool: string; args: Record<string, any>; why?: string };
export type ToolInfo = { name: string; description: string; args: string }; // what the prompt says about a tool

// Copilot writes Windows paths with single backslashes ("C:\devl"), which is invalid JSON; double the stray ones.
export function parseLenient(s: string): { value: any; error: string } {
  try {
    return { value: JSON.parse(s), error: "" };
  } catch (e) {
    try {
      // take each escape as a unit so an already valid "\\" pair is left alone
      return { value: JSON.parse(s.replace(/\\(["\\/bfnrtu]?)/g, (m, c) => (c ? m : "\\\\"))), error: "" };
    } catch {
      return { value: null, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

// first balanced {...} in the text (honouring strings) that parses as a tool call; error says why there is none
export function findCall(text: string): { call: Call | null; error: string } {
  const start = text.indexOf("{");
  if (start < 0) return { call: null, error: "" };
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      const { value: obj, error } = parseLenient(text.slice(start, i + 1));
      if (obj && typeof obj.tool === "string") {
        const args = obj.args && typeof obj.args === "object" && !Array.isArray(obj.args) ? obj.args : {};
        return { call: { tool: obj.tool, args, why: obj.why }, error: "" };
      }
      return { call: null, error: obj ? 'missing "tool"' : error };
    }
  }
  return { call: null, error: "" };
}

// A reply is a JSON tool call, optionally followed by a fenced code block that carries a file or a script (so code
// never has to be escaped inside JSON). The call is looked for outside the code blocks first, then inside them (some
// replies fence the JSON itself); a tool's blockArg (write_file: content, run_python: code) is taken from the block.
// blocks: every fenced block's text; usedBlock: the one that held the JSON (-1 = none).
export function parseCall(reply: string, blockArgOf: (tool: string) => string | undefined): { call: Call | null; error: string; blocks: string[]; usedBlock: number } {
  let error = "no JSON object found";
  const blocks: string[] = [];
  // a block ends at a fence of the same kind and length (``` / ```` / ~~~), so a README holding ``` samples stays whole
  const outside = reply.replace(/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?^\1[ \t]*$/gm, (_m, _f, code) => { blocks.push(code); return "\n"; });
  let found = findCall(outside), used = -1;
  if (found.error) error = found.error;
  for (let i = 0; !found.call && i < blocks.length; i++) {
    found = findCall(blocks[i]);
    if (found.error) error = found.error;
    if (found.call) used = i;
  }
  const call = found.call;
  if (!call) return { call: null, error, blocks, usedBlock: -1 };
  const arg = blockArgOf(call.tool);
  if (arg && call.args[arg] == null) {
    const block = blocks.find((_b, i) => i !== used);
    if (block != null) call.args[arg] = block;
  }
  return { call, error: "", blocks, usedBlock: used };
}

// The task goes first so Copilot titles the chat after it; the page splits stored messages at "\n\n[local-agent] ".
export function agentPrompt(selected: ToolInfo[], task: string, o: { workspace: string; projects: string[] }): string {
  const list = selected.map((t) => `- ${t.name}: ${t.description}\n  args example: ${t.args}`).join("\n");
  const workspace = o.workspace.replace(/\\/g, "/");
  const projects = o.projects.map((p) => p.replace(/\\/g, "/"));
  const has = (name: string) => selected.some((t) => t.name === name);
  // how to work on files, from the tools in this chat
  const fileRule = "- To create a new file, or to rewrite most of one, use write_file with the WHOLE file (under ~150 lines per call; longer new files in parts with append: true and expect_lines)." +
    (has("edit_file")
      ? " To change part of an existing file use edit_file with SEARCH/REPLACE blocks: find the place first (read_file with outline: true, then start_line/end_line) and copy the lines into SEARCH exactly. Never send a fragment to write_file."
      : " Before changing an existing file, read it fully with read_file.") +
    (has("search_files")
      ? " To find where something is in a repo, use search_files first (text or glob), then read_file only the lines around the matches; list_dir recursive only for an overview."
      : " To understand a repo, start with list_dir recursive.");
  return `${task}

${MARK} You are the agent for the message above, working on my Windows PC through the tools below. If it is a question or chat that needs no tool (explain, compare, advise), just answer it in plain text. If it asks you to do something, do it with the tools: each turn I run ONE tool for you and paste its result back.
For a tool step, reply with ONLY one JSON object and no other text:
{"tool": "<name>", "args": {...}, "why": "<short reason>"}

Tools:
${list}
- ask_user: stop and ask me something, then wait: my answer comes back as the RESULT. Use it whenever you need me: a sign-in or login page, a code or captcha, a choice between options, details you don't have, or a step only I can do.
  args example: {"question": "Postman shows its sign-in page in the Edge window. Please sign in there, then press Continue."}
- done: finish and give me the answer, with what you checked.
  args example: {"answer": "<final answer>", "checks": ["Option1 is checked: the click RESULT says checked", "report.docx has 4 steps and 4 images: read_file shows them"]}
- read_output: read more of an earlier RESULT that was cut (its run number is in the cut line): its end, a range, or the lines matching a pattern.
  args example: {"run": 7, "tail": 4000} · {"run": 7, "start": 2800, "chars": 6000} · {"run": 7, "grep": "FAIL|Error", "context": 2}

Rules:
- One tool per reply; wait for the RESULT before the next step; use done when the task is finished or cannot be done.
- Long RESULTs are cut in the middle; the cut line tells you how to read the rest with read_output. Test and build summaries are at the end: read the tail before you conclude anything. A command's last line [exit N, T s] is its exit code: non-zero means it failed, whatever the text above says.
- Do as much as you can yourself, so I have as little to do as possible. If no tool does a step directly, write the code for it yourself without hesitating: a PowerShell command (shell) or a Python script (run_python), and install what it needs (install_package). I approve each one, so you have my permission to propose them. Examples: bring a window to the front or resize it, copy or rename files, call an API, convert a file, check a port, parse a file, drive a program from its command line.
- In the browser: find controls with elements (or dom for the whole page as text when you need to see what is around them), click and type by their eN ids, and read (or elements/dom again) after each step to check it did what you wanted; evidence: true gives the snap for a report. When a click does nothing or an element is not listed, run dom and pick the right id; don't give up on the page and don't hand the clicking to me.
- ask_user only for what really needs me: signing in, passwords and codes, a decision between options, details you don't have. Never ask me to do something a tool or a command can do (bring the browser to the front, take a snap, open a page again, find a file). When a step needs me, ask, wait for my answer and go on from there; never skip it, and never switch to another app, site or way of doing it without asking me.
- Check every step like a careful engineer: read each RESULT and make sure the step did what you wanted (the right page opened, not a sign-in or error page; the box is now checked; the file was written; the response is the expected one). If it didn't, fix it, try another way or ask me; don't build on a step that failed.
- Before done, verify the whole task: go through every part of my request and check it against the RESULTs, and check with a tool what you haven't seen yet (browser read or elements, screen read, list_dir, read_file of the files you made: it reads .docx, .pptx and .xlsx too). In done, checks has one line per part of my request: how you know it is done, or that it is not done and why.
- Be honest. Say only what the tool RESULTs show: never write (in done, a report, a caption) that something was typed, clicked, highlighted, sent or verified unless a RESULT shows it. When a step could not be done or a tool cannot do it, say so plainly instead of describing it as done.
- Do not use your own code execution, file creation or web browsing: they don't reach my PC. Use the tools.
- Files you make for me (reports, decks, screenshots, notes) go in the workspace folder ${workspace}: give paths relative to it (report.docx, screenshots/step-01.png).
${projects.length ? `- Code repos live in ${projects.join(", ")}: create a new repo as a folder there (e.g. ${projects[0]}/my-repo) and change existing repos there, using absolute paths.\n` : ""}- You may read and write files anywhere on my PC with absolute paths; outside my trusted folders I approve each one, so only touch what the task needs.
${fileRule}
- Every write_file / edit_file RESULT ends with a check line: SYNTAX ERROR means the file is broken; fix it before anything else and never report it as done. A RESULT with the line count, last line and a passing check is proof the file was written: read it again only to check its content against a requirement.
- If a package or command-line tool is missing (a Python or npm package, a Windows program), install it with install_package, then use it.
- Manual testing with evidence, like a tester documenting by hand, one step at a time, with a full-screen snap (window in front, taskbar included) right after each step that red-boxes exactly what the step changed or shows (the checkbox, request name, URL, method, payload lines, status code). In a web page (Postman Web too): do the step with the browser tool and use evidence: true (or browser screenshot with target / highlight). In a desktop app, which no tool can click or type in: put what I have to paste on the clipboard (screen clipboard: a payload, or a cURL for Postman's URL box), give me the hand step in the ask of a screen snap with highlight. Use browser read or screen read to check what is shown. Then make_docx: per step a heading, what was done and by whom, the snap, and a caption naming what the red box marks (only boxes the RESULT reported).
- Write Windows paths with forward slashes (C:/devl/x) so the JSON stays valid.
- write_file and run_python: do NOT put the file or the code inside the JSON. Reply with the JSON line, then the complete file or code in ONE fenced code block right after it, for example:
{"tool": "write_file", "args": {"path": "C:/devl/my-repo/package.json"}, "why": "project manifest"}
\`\`\`json
{ "name": "my-repo" }
\`\`\`
  Label the block \`\`\`text (or the code's language), never \`\`\`markdown or \`\`\`html: those show a preview and I lose the raw file.
  If the file itself contains \`\`\` lines (a README with code samples), fence it with ~~~~text instead.`;
}

// ── the task ledger: what really happened on this PC during a task (the server fills it; Copilot's memory is not
//    trusted for it). It grounds the verify round and the Facts on the Done card. ──
export type LedgerWrite = { path: string; tool: string; step: number; exists: boolean; lines: number; check: string | null };
export type LedgerRun = { tool: string; summary: string; step: number; problem: boolean; exit: string };
export type Ledger = { writes: LedgerWrite[]; runs: LedgerRun[]; declined: string[]; asked: number; mutatingRuns: number; verifyAsked: boolean };

const fwd = (p: string) => p.replace(/\\/g, "/");
const flat = (s: string, n = 160) => s.replace(/\s+/g, " ").trim().slice(0, n);

// how a run ended, from its result: the trailer line, or whether the result read as a problem (see statusOf)
export const exitOf = (result: string, o: { data?: boolean } = {}) => statusOf(result, o).exit;

// the Facts list for the page (problem: shown in red)
export function factLines(l: Ledger): { text: string; problem: boolean }[] {
  const out: { text: string; problem: boolean }[] = [];
  if (l.writes.length) {
    const broken = l.writes.filter((w) => w.check), gone = l.writes.filter((w) => !w.exists);
    out.push({
      text: `${l.writes.length} file${l.writes.length === 1 ? "" : "s"} written` +
        (broken.length ? `, ${broken.length} with a syntax error: ${broken.map((w) => w.path.replace(/^.*[\\/]/, "")).join(", ")}` : "") +
        (gone.length ? `, ${gone.length} no longer there: ${gone.map((w) => w.path.replace(/^.*[\\/]/, "")).join(", ")}` : ""),
      problem: broken.length > 0 || gone.length > 0,
    });
  }
  const bad = l.runs.filter((r) => r.problem), good = l.runs.length - bad.length;
  for (const r of bad) out.push({ text: `last "${flat(r.summary, 80)}" (${r.tool}): ${r.exit}`, problem: true });
  if (good) out.push({ text: `${good} command${good === 1 ? "" : "s"} ran OK`, problem: false });
  if (l.declined.length) out.push({ text: `${l.declined.length} step${l.declined.length === 1 ? "" : "s"} declined by you`, problem: false });
  if (l.asked) out.push({ text: `${l.asked} question${l.asked === 1 ? "" : "s"} you answered`, problem: false });
  out.push({ text: `verify round: ${l.verifyAsked ? "yes" : l.mutatingRuns ? "no" : "no (nothing was changed)"}`, problem: false });
  return out;
}

// Copilot's first "done" in a task that changed something gets this once: the facts from this PC, then "check every
// part of the request before finishing". nudge: Copilot ended in prose instead of done (one extra round).
export function verifyPrompt(l: Ledger, o: { nudge?: boolean } = {}): string {
  const facts: string[] = [];
  const cap = (items: string[], label: string) => {
    if (!items.length) return;
    facts.push(`- ${label}: ${items.slice(0, 25).map((s) => flat(s)).join("; ")}${items.length > 25 ? `; … and ${items.length - 25} more` : ""}`);
  };
  cap(l.writes.map((w) => `${fwd(w.path)} (${w.exists ? `${w.lines} lines, ${w.check ? `${w.check.replace(/^SYNTAX ERROR\s*/, "SYNTAX ERROR ")}, still broken` : "check OK"}` : "no longer exists: undone?"})`), "files you wrote");
  cap(l.runs.map((r) => `${r.tool} "${r.summary}" -> ${r.exit === "ok" ? "ok" : `last run [${r.exit}]`}`), "commands you ran");
  cap(l.declined, "steps I declined");
  if (l.asked) facts.push(`- my answers to ask_user: ${l.asked}`);
  const head = o.nudge
    ? `${MARK} You ended with text, not with done. If the task is finished, send done with checks; if you need me, use ask_user; otherwise send the next tool call (JSON only). Before you finish, verify the task like a careful engineer.`
    : `${MARK} Before you finish, verify the task like a careful engineer.`;
  return `${head} Facts from my side (not your memory):\n${facts.join("\n")}\nGo through every part of my request (at the top of this chat) one by one and find the RESULT that shows it is done. Whatever no RESULT shows yet, check it now with a tool (browser read or elements, screen read, list_dir, read_file of the files you made). Fix what the facts above show as broken, or say in checks that it is not done and why; use ask_user if you need me. Then send done again with "checks": one line per part of my request saying how you know it is done, or that it is not done and why.`;
}

// Copilot's checks say nothing about a problem the facts show (a hint for the page, by keywords)
export const checksMissFailures = (facts: { problem: boolean }[], checks: string[]) =>
  facts.some((f) => f.problem) && !checks.some((c) => /not done|fail|broken|error|missing|could not|undone|declined/i.test(c));

// kept for pages that render old chats: the verify message starts with this
export const VERIFY = `${MARK} Before you finish, verify the task like a careful engineer.`;

// what goes back to Copilot after a tool ran
export const resultMessage = (tool: string, result: string) =>
  `${MARK} RESULT of ${tool}:\n${result}\n\nNext tool call (JSON only), or done; if this RESULT shows the step did not work (an error, a non-zero [exit code N] line), fix that first.`;

// after the user answered an ask_user question (or pressed Continue)
export const askUserResultMessage = (result: string) =>
  `${MARK} RESULT of ask_user:\n${result}\n\nNext tool call (JSON only), or done; check first that what you asked for really happened.`;

// a reply that tried to be a tool call but isn't valid JSON
export const correctionMessage = (error: string) =>
  `${MARK} Your reply was not one valid JSON tool call (${error}). Reply with ONLY {"tool": ..., "args": {...}, "why": ...}. Write Windows paths with forward slashes.`;

// How a tool result ended, one source of truth for the log, the ledger and the page: a command's trailer line
// ([exit 0, T s] / [exit code N, T s] / killed / stopped, the last line) decides when there is one; otherwise the
// first line's wording (error:, not run:, no file ...). data: the result is a file's or page's content, whose first
// line means nothing (read_file, read_output, browser read).
export function statusOf(result: string, o: { data?: boolean } = {}): { problem: boolean; exit: string } {
  const last = result.trimEnd().split("\n").at(-1) ?? "";
  const end = last.match(/\[(exit 0|exit code \d+|killed[^\],]*|stopped[^\],]*)(?:, [\d.]+ s)?\]$/);
  if (end) return end[1] === "exit 0" ? { problem: false, exit: "ok" } : { problem: true, exit: end[1] };
  const problem = !o.data && /^(error|not run|not typed|no |unknown|could not|screen tool failed)/i.test(result);
  return { problem, exit: problem ? `problem: ${result.replace(/\s+/g, " ").trim().slice(0, 80)}` : "ok" };
}
export const isProblem = (result: string, o: { data?: boolean } = {}) => statusOf(result, o).problem;

// ── a program's output, tidied before Copilot sees it: no colour codes, LF line ends, no trailing spaces, at most
//    one blank line in a row, no progress-bar lines; with repeats, runs of 3+ identical lines (with real content) become
//    one line + "(repeated N times)". Not for file contents or page text, which must stay exact. ──
export function compact(text: string, o: { repeats?: boolean } = {}): string {
  let lines = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").split("\n");
  // progress bars and spinners only: a line of block or braille glyphs (and maybe a percentage), nothing else
  lines = lines.filter((l) => !/^[\s▀-▟⠀-⣿]*[▀-▟⠀-⣿][\s▀-▟⠀-⣿]*(\d{1,3}%)?\s*$/.test(l));
  if (o.repeats) {
    const out: string[] = [];
    for (let i = 0; i < lines.length;) {
      let j = i + 1;
      while (j < lines.length && lines[j] === lines[i]) j++;
      // not diff lines (+/-), whose repeats are real content
      if (j - i >= 3 && lines[i].replace(/\s/g, "").length >= 4 && !/^[+-]/.test(lines[i])) { out.push(`${lines[i]}  (repeated ${j - i} times)`); i = j; }
      else out.push(lines[i++]);
    }
    lines = out;
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

// ── a long result, cut in the middle: the first ~35 % and the last ~65 % of max (on line boundaries), with a marker
//    naming the run so Copilot can read the rest with read_output. The end survives, where test and build summaries and
//    the [exit N] line are. ──
export function cutResult(text: string, max: number, run: number): { text: string; cut: boolean; head: number; tail: number } {
  if (text.length <= max) return { text, cut: false, head: text.length, tail: 0 };
  const noPair = (i: number) => (i > 0 && /[\uD800-\uDBFF]/.test(text[i - 1]) ? i - 1 : i); // never between a surrogate pair
  const budget = Math.max(200, max - 220);
  const headWant = Math.floor(budget * 0.35), tailWant = budget - headWant;
  let head = text.lastIndexOf("\n", headWant);
  if (head < headWant / 2) head = noPair(headWant);
  let tailAt = text.indexOf("\n", text.length - tailWant);
  tailAt = tailAt < 0 || tailAt > text.length - tailWant / 2 ? noPair(text.length - tailWant) : tailAt + 1;
  const marker = `\n…[run #${run}: ${text.length} characters, ${tailAt - head} cut here. read_output {"run": ${run}, "start": ${head}} shows the rest; {"run": ${run}, "grep": "FAIL|Error"} finds lines]…\n`;
  return { text: text.slice(0, head) + marker + text.slice(tailAt), cut: true, head, tail: text.length - tailAt };
}

// ── read_output: part of a kept run's full output. tail (default 4000 characters), start + chars, or grep (a pattern,
//    case-insensitive; context lines around each match). Never longer than max. ──
export function readOutput(run: { n: number; tool: string; text: string }, args: Record<string, any>, max: number): string {
  const text = run.text, lines = text.split("\n");
  const limit = Math.max(500, max - 200);
  const noPair = (i: number) => (i > 0 && i < text.length && /[\uDC00-\uDFFF]/.test(text[i]) ? i - 1 : i); // never between a surrogate pair
  if (args.grep != null) {
    const pat = String(args.grep).slice(0, 200);
    const literal = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    let re: RegExp;
    // a pattern that can backtrack without end ((a+)+, (.*)*) is taken as plain text: a RegExp runs on this server's thread
    if (/\([^)]*[+*][^)]*\)\s*[+*{]/.test(pat) || /[+*]\??[+*]/.test(pat)) re = literal;
    else { try { re = new RegExp(pat, "i"); } catch { re = literal; } }
    const context = Math.min(Math.max(Number(args.context) || 0, 0), 5);
    const hits: number[] = [];
    let i = 0;
    for (; i < lines.length && hits.length < 200; i++) if (re.test(lines[i].slice(0, 500))) hits.push(i);
    const capped = hits.length >= 200 && i < lines.length;
    const show = new Set<number>();
    for (const h of hits) for (let k = Math.max(0, h - context); k <= Math.min(lines.length - 1, h + context); k++) show.add(k);
    const hitSet = new Set(hits);
    const out = [`[run #${run.n} (${run.tool}): ${capped ? "200+" : hits.length} of ${lines.length} lines match /${pat}/${capped ? "; the first 200 shown" : ""}]`];
    let size = out[0].length, prev = -1;
    for (const i of [...show].sort((a, b) => a - b)) {
      const line = `${String(i + 1).padStart(5)}${hitSet.has(i) ? ":" : "-"} ${lines[i].slice(0, 300)}`;
      if (size + line.length + 1 > limit) { out.push(`…(more matches; narrow the pattern or use start/chars)`); break; }
      if (prev >= 0 && i > prev + 1 && context) out.push("     …");
      out.push(line);
      size += line.length + 1;
      prev = i;
    }
    return out.join("\n");
  }
  let start: number, end: number;
  if (args.start != null || args.chars != null) {
    start = noPair(Math.min(Math.max(Number(args.start) || 0, 0), text.length));
    end = noPair(Math.min(text.length, start + Math.min(Math.max(Number(args.chars) || 6000, 1), limit)));
  } else {
    const tail = Math.min(Math.max(Number(args.tail) || 4000, 1), limit);
    start = noPair(Math.max(0, text.length - tail));
    end = text.length;
  }
  const more = end < text.length ? `; next: start ${end}` : "";
  return `[run #${run.n} (${run.tool}), characters ${start}-${end} of ${text.length}${more}]\n${text.slice(start, end)}`;
}

// Line diff (longest common subsequence); big files fall back to "all removed, all added".
export type DiffLine = { t: " " | "+" | "-"; s: string };
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split(/\r?\n/), b = after === "" ? [] : after.split(/\r?\n/);
  if (a.length * b.length > 4_000_000) return [...a.map((s) => ({ t: "-" as const, s })), ...b.map((s) => ({ t: "+" as const, s }))];
  const w = b.length + 1, lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ t: " ", s: a[i] }); i++; j++; }
    else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) out.push({ t: "-", s: a[i++] });
    else out.push({ t: "+", s: b[j++] });
  }
  while (i < a.length) out.push({ t: "-", s: a[i++] });
  while (j < b.length) out.push({ t: "+", s: b[j++] });
  return out;
}
