// The search behind tools/search_files.ts, in its own process so Stop and the time budget bind it. One JSON request
// on stdin, the result text on stdout:
//   {"root", "text", "regex", "case", "glob", "context", "max", "skipDirs": [...], "sensitive": "<regex source>"}
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const req = JSON.parse(await readStdin());
let root = path.resolve(req.root);
try { root = await realpath(root); } catch { console.log(`error: no folder at ${root.replace(/\\/g, "/")}`); process.exit(0); }
const skip = new Set(req.skipDirs ?? []);
const isSkipped = (name) => skip.has(name) || (name.startsWith(".") && !/^\.(github|vscode|husky)$/.test(name));
const sensitive = req.sensitive ? new RegExp(req.sensitive, "i") : null;
const glob = req.glob ? globToRegExp(String(req.glob)) : null;
let re = null;
if (req.text) {
  const t = String(req.text);
  if (req.regex) {
    try { re = new RegExp(t, req.case ? "" : "i"); } catch (e) { console.log(`invalid regular expression: ${e.message}`); process.exit(0); }
  } else re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), req.case ? "" : "i");
}
const max = Math.min(Math.max(Number(req.max) || 50, 1), 500);
const context = Math.min(Math.max(Number(req.context) || 0, 0), 5);
const started = Date.now();
const BUDGET_MS = 5000, MAX_FILES = 2000, MAX_BYTES = 2 * 1024 * 1024, MAX_CHARS = 6500;

const files = []; // relative, forward slashes
let stoppedEarly = "";
async function walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (files.length >= MAX_FILES) { stoppedEarly = `stopped at ${MAX_FILES} files`; return; }
    if (Date.now() - started > BUDGET_MS) { stoppedEarly = "stopped after 5 s"; return; }
    if (e.isSymbolicLink()) continue; // junctions and links: never leave the tree
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!isSkipped(e.name)) await walk(full); continue; }
    if (!e.isFile()) continue;
    const rel = path.relative(root, full).replace(/\\/g, "/");
    if (glob && !glob.test(rel)) continue;
    files.push(rel);
  }
}
await walk(root);

const out = [], skippedSensitive = [];
if (!re) { // glob only: the matching files
  const shown = files.slice(0, 400);
  console.log(`${files.length} file${files.length === 1 ? "" : "s"} match ${JSON.stringify(req.glob)}${files.length > 400 ? " (first 400 shown)" : ""}${stoppedEarly ? `; ${stoppedEarly}` : ""}`);
  console.log(shown.join("\n"));
  process.exit(0);
}

let matches = 0, inFiles = 0, searched = 0, chars = 0, hitMax = false;
const lines = [];
for (const rel of files) {
  if (hitMax || Date.now() - started > BUDGET_MS) { if (!hitMax) stoppedEarly = "stopped after 5 s"; break; }
  const full = path.join(root, rel);
  if (sensitive && sensitive.test("/" + rel)) { skippedSensitive.push(rel); continue; } // the path below the root (the root itself is the tool's call)
  let st;
  try { st = await lstat(full); } catch { continue; }
  if (st.size > MAX_BYTES) continue;
  try { if (!(await realpath(full)).toLowerCase().startsWith(root.toLowerCase())) continue; } catch { continue; }
  let buf;
  try { buf = await readFile(full); } catch { continue; }
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString("utf16le", 2);
  else { if (buf.subarray(0, 512).includes(0)) continue; text = buf.toString("utf8"); }
  searched++;
  const fileLines = text.split(/\r?\n/);
  let any = false;
  for (let i = 0; i < fileLines.length; i++) {
    if (!re.test(fileLines[i])) continue;
    matches++;
    any = true;
    for (let c = Math.max(0, i - context); c <= Math.min(fileLines.length - 1, i + context); c++) {
      const line = `${rel}${c === i ? ":" : "-"}${c + 1}${c === i ? ": " : "- "}${fileLines[c].slice(0, 2000)}`;
      lines.push(line);
      chars += line.length + 1;
    }
    if (matches >= max || chars >= MAX_CHARS) { hitMax = true; break; }
  }
  if (any) inFiles++;
}
const summary = matches
  ? `${matches} match${matches === 1 ? "" : "es"} in ${inFiles} file${inFiles === 1 ? "" : "s"} (searched ${searched} files; stopped at max ${max}: ${hitMax ? "yes" : "no"}${stoppedEarly ? `; ${stoppedEarly}` : ""})`
  : `0 matches in ${searched} files for ${JSON.stringify(req.text)}${stoppedEarly ? ` (${stoppedEarly})` : ""} (try regex: true, double backslashes, or a shorter text)`;
out.push(summary);
out.push(...lines);
if (skippedSensitive.length) out.push(`sensitive files skipped (read them with read_file if needed): ${skippedSensitive.slice(0, 20).join(", ")}${skippedSensitive.length > 20 ? ", …" : ""}`);
console.log(out.join("\n"));

function readStdin() {
  return new Promise((resolve) => { let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => resolve(s)); });
}
function globToRegExp(g) {
  return new RegExp(`^${globSource(g)}$`, "i");
}
function globSource(g) {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { if (g[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; } }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") { const j = g.indexOf("}", i); if (j > i) { re += `(?:${g.slice(i + 1, j).split(",").map(globSource).join("|")})`; i = j; } else re += "\\{"; }
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return re;
}
