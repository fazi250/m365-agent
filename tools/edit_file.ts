// Changes part of an existing text file without rewriting it, like an editor's find-and-replace with whole lines:
// Copilot sends SEARCH/REPLACE blocks (the lines as they are, then the new lines). Each SEARCH must match exactly
// one place; all edits apply together or none. Keep / Undo and the approval rules are write_file's; the RESULT ends
// with the syntax check, so a broken file is seen at once. UTF-8 files only (nothing else is transcoded by mistake).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syntaxCheck } from "./_check.ts";
import { isSensitive, pathRule, pathWarning, writable, type Tool } from "./_lib.ts";

export type Edit = { search: string[]; replace: string[] };
const fwd = (p: string) => p.replace(/\\/g, "/");
const SEARCH = "<<<<<<< SEARCH", MID = "=======", REPLACE = ">>>>>>> REPLACE";

// the block → edits; any marker out of place is an error (a smaller block or write_file instead)
export function parseEdits(block: string): { edits: Edit[]; error?: string } {
  const edits: Edit[] = [];
  let state: "out" | "search" | "replace" = "out", cur: Edit | null = null;
  const lines = block.replace(/\r\n?/g, "\n").split("\n");
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n], line = n + 1;
    const isMarker = l === SEARCH || l === MID || l === REPLACE;
    if (state === "out") {
      if (l === SEARCH) { cur = { search: [], replace: [] }; state = "search"; continue; }
      if (isMarker) return { edits, error: `error: unexpected "${l}" at line ${line} of your block: each edit is ${SEARCH} / lines / ${MID} / lines / ${REPLACE}` };
      if (l.trim()) return { edits, error: `error: text outside the SEARCH/REPLACE markers at line ${line} of your block ("${l.slice(0, 60)}"): only the edits go in the block` };
      continue;
    }
    if (state === "search") {
      if (l === MID) { state = "replace"; continue; }
      if (isMarker) return { edits, error: `error: marker line inside SEARCH #${edits.length + 1} (line ${line} of your block): put that edit in a smaller block or use write_file` };
      cur!.search.push(l);
      continue;
    }
    if (l === REPLACE) { edits.push(cur!); cur = null; state = "out"; continue; }
    if (isMarker) return { edits, error: `error: marker line inside REPLACE #${edits.length + 1} (line ${line} of your block): put that edit in a smaller block or use write_file` };
    cur!.replace.push(l);
  }
  if (state !== "out") return { edits, error: `error: edit #${edits.length + 1} is not closed (no ${state === "search" ? MID : REPLACE} line): the block was probably cut; send it again, shorter` };
  if (!edits.length) return { edits, error: `error: no edits: the block holds no ${SEARCH} … ${MID} … ${REPLACE} section` };
  for (const [i, e] of edits.entries()) {
    while (e.search.length && !e.search.at(-1)!.trim()) e.search.pop(); // a blank line before ======= is not part of the search
    if (!e.search.length) return { edits, error: `error: SEARCH #${i + 1} is empty: copy the lines to replace into it (use write_file for a new file)` };
  }
  return { edits };
}

const indent = (l: string) => l.match(/^[ \t]*/)![0];
const numbered = (lines: string[]) => {
  const nums = lines.map((l) => l.match(/^\s*(\d+)\| /)?.[1]).filter(Boolean).map(Number);
  return nums.length >= 3 && nums.every((n, i) => !i || n > nums[i - 1]);
};

// the indentation change from a SEARCH line to the file's line, as a function over any line of the edit
function shift(fileIndent: string, searchIndent: string): (l: string) => string {
  if (fileIndent === searchIndent) return (l) => l;
  if (fileIndent.startsWith(searchIndent)) { const add = fileIndent.slice(searchIndent.length); return (l) => (l.trim() ? add + l : l); }
  if (searchIndent.startsWith(fileIndent)) { const drop = searchIndent.slice(fileIndent.length); return (l) => (l.startsWith(drop) ? l.slice(drop.length) : l); }
  return (l) => (l.startsWith(searchIndent) ? fileIndent + l.slice(searchIndent.length) : l); // tabs vs spaces: swap the prefix
}

// where one edit's SEARCH sits in the file: exact lines (trailing spaces ignored), else the same lines at another
// indentation, one constant shift for the whole edit (the replacement is then shifted the same way).
// indentOnly: the lines matched only after ignoring their indentation (for the error message).
function locate(lines: string[], e: Edit): { starts: number[]; reindent: (l: string) => string; indentOnly: boolean } {
  const same = (cmp: (a: string, b: string) => boolean) => {
    const out: number[] = [];
    for (let i = 0; i + e.search.length <= lines.length; i++) {
      let k = 0;
      while (k < e.search.length && cmp(lines[i + k], e.search[k])) k++;
      if (k === e.search.length) out.push(i);
    }
    return out;
  };
  let starts = same((a, b) => a.trimEnd() === b.trimEnd());
  if (starts.length) return { starts, reindent: (l) => l, indentOnly: false };
  const loose = same((a, b) => a.trim() === b.trim());
  const k0 = e.search.findIndex((l) => l.trim()); // parseEdits leaves no all-blank SEARCH
  const found: { start: number; reindent: (l: string) => string }[] = [];
  for (const start of loose) {
    const re = shift(indent(lines[start + k0]), indent(e.search[k0]));
    const whole = e.search.every((l, k) => (!l.trim() ? !lines[start + k].trim() : lines[start + k].trimEnd() === re(l).trimEnd()));
    if (whole) found.push({ start, reindent: re });
  }
  if (found.length === 1) return { starts: [found[0].start], reindent: found[0].reindent, indentOnly: false };
  return { starts: found.map((f) => f.start), reindent: (l) => l, indentOnly: !found.length && loose.length > 0 };
}

// the line in the file most like the first non-blank SEARCH line (for the "no match" message)
function closest(lines: string[], target: string): number {
  const t = target.trim();
  let best = 0, score = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    let k = 0;
    while (k < l.length && k < t.length && l[k] === t[k]) k++;
    const s = l === t ? 1000 : k + (t.length > 12 && l.includes(t.slice(0, 12)) ? 20 : 0);
    if (s > score) { score = s; best = i; }
  }
  return best;
}

export function applyEdits(lines: string[], edits: Edit[]): { lines: string[]; ranges: { edit: number; from: number; to: number }[]; added: number; removed: number; error?: string } {
  const placed: { start: number; end: number; replace: string[]; i: number }[] = [];
  for (const [i, e] of edits.entries()) {
    const { starts, reindent, indentOnly } = locate(lines, e);
    if (!starts.length) {
      const at = closest(lines, e.search.find((l) => l.trim()) ?? e.search[0]);
      const why = indentOnly ? "the lines match only after ignoring their indentation: copy the indentation as read_file shows it (the same shift on every line)" : "copy the lines exactly as read_file shows them";
      return { lines, ranges: [], added: 0, removed: 0, error: `error: no match for SEARCH #${i + 1}; closest is line ${at + 1}: "${lines[at].trim().slice(0, 80)}". ${why} (nothing changed; no edit was applied)` };
    }
    if (starts.length > 1) return { lines, ranges: [], added: 0, removed: 0, error: `error: SEARCH #${i + 1} matches ${starts.length} places (lines ${starts.slice(0, 6).map((s) => s + 1).join(", ")}): add surrounding lines so it matches one place (no edit was applied)` };
    placed.push({ start: starts[0], end: starts[0] + e.search.length, replace: e.replace.map(reindent), i });
  }
  placed.sort((a, b) => a.start - b.start);
  for (let k = 1; k < placed.length; k++) {
    if (placed[k].start < placed[k - 1].end) return { lines, ranges: [], added: 0, removed: 0, error: `error: edits #${placed[k - 1].i + 1} and #${placed[k].i + 1} overlap: merge them into one edit (no edit was applied)` };
  }
  const out = [...lines];
  for (const p of [...placed].reverse()) out.splice(p.start, p.end - p.start, ...p.replace);
  const ranges: { edit: number; from: number; to: number }[] = [];
  let shiftBy = 0, added = 0, removed = 0;
  for (const p of placed) {
    ranges.push({ edit: p.i + 1, from: p.start + shiftBy + 1, to: p.start + shiftBy + p.replace.length });
    shiftBy += p.replace.length - (p.end - p.start);
    added += p.replace.length;
    removed += p.end - p.start;
  }
  return { lines: out, ranges, added, removed };
}

const tool: Tool = {
  name: "edit_file",
  description:
    "Change part of an existing text file without rewriting it. Send the JSON, then ONE fenced block labelled ```text " +
    "(never markdown/html) holding ALL the edits, each as:\n<<<<<<< SEARCH\n(lines exactly as they are in the file)\n=======\n" +
    "(replacement lines; empty = delete)\n>>>>>>> REPLACE\nEach SEARCH must match exactly one place (add surrounding lines " +
    "if not). All edits are applied together or none. Read the lines first (read_file start_line/end_line) and copy them exactly, indentation included.",
  args: '{"path": "C:/devl/my-repo/src/app.ts"}',
  approvalHint: "your folders run on their own; elsewhere and sensitive files ask first; Keep or Undo each change",
  blockArg: "edits",
  changesFiles: true,
  needsApproval: (args, ctx) => {
    const { full, trusted } = writable(args.path, ctx);
    return !trusted || isSensitive(full);
  },
  alwaysRule: (args, ctx) => pathRule(writable(args.path, ctx).full, "writing"),
  warning: (args, ctx) => {
    const { full, trusted } = writable(args.path, ctx);
    return pathWarning(full, trusted)?.replace("what is read goes into the Copilot chat", "the file will be changed") ?? null;
  },
  run: async (args, ctx) => {
    if (args.edits == null) return "no edits: put the SEARCH/REPLACE blocks in a fenced code block right after the JSON";
    const { full } = writable(String(args.path ?? ""), ctx);
    if (!existsSync(full)) return `error: no file at ${fwd(full)}: use write_file to create it`;
    const buf = readFileSync(full);
    if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return `error: ${fwd(full)} is UTF-16 text: edit_file only edits UTF-8 files; convert it first, or use write_file for the whole file (nothing changed)`;
    const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    let body: string;
    try { body = new TextDecoder("utf-8", { fatal: true }).decode(bom ? buf.subarray(3) : buf); }
    catch { return `error: ${fwd(full)} is not UTF-8 text (ANSI/cp1252?): edit_file only edits UTF-8 files; convert it first, or use write_file for the whole file (nothing changed)`; }
    const crlf = (body.match(/\r\n/g) ?? []).length, lf = (body.match(/\n/g) ?? []).length - crlf;
    const eol = crlf > lf ? "\r\n" : "\n";
    const lines = body.split(/\r?\n/);
    const parsed = parseEdits(String(args.edits));
    if (parsed.error) return parsed.error;
    if (numbered(parsed.edits.flatMap((e) => e.search))) return 'error: the SEARCH lines look like numbered read_file output; send the lines without the "NN| " prefixes';
    const applied = applyEdits(lines, parsed.edits);
    if (applied.error) return applied.error;
    const text = (bom ? "\uFEFF" : "") + applied.lines.join(eol);
    ctx.trackWrite(full); // right before the write: the server keeps the original for Undo
    writeFileSync(full, text, "utf8");
    const total = applied.lines.length - (applied.lines.at(-1) === "" ? 1 : 0); // like write_file: the final newline is not a line
    const out = [`edited ${fwd(full)}: ${parsed.edits.length} edit(s), -${applied.removed} +${applied.added} lines (now ${total} lines)`];
    for (const r of applied.ranges) {
      const from = Math.max(1, r.from - 1), to = Math.min(applied.lines.length, Math.max(r.to, r.from) + 1);
      out.push(`--- lines ${from}-${to} after edit #${r.edit} ---`, ...applied.lines.slice(from - 1, Math.min(to, from - 1 + 40)));
      if (to - from + 1 > 40) out.push(`… (${to - from + 1 - 40} more lines)`);
    }
    const check = await syntaxCheck(full, ctx);
    ctx.noteCheck(full, check.status === "error" ? check.text.split("\n")[0] : null);
    if (check.text) out.push(check.text);
    if (check.status === "error") out.push("The file is written but broken: fix it (edit_file again) before using it.");
    return out.join("\n");
  },
};
export default tool;
