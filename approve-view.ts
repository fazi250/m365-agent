// What the approval card shows besides the call itself (no side effects; server.ts calls it before emitting the
// card): for write_file and edit_file the change as a diff against the file as it is now, so the user sees what the
// step does to the file instead of a blob of text. A new file needs no diff: the card shows its content as code.
import { existsSync, readFileSync } from "node:fs";
import { diffLines, type DiffLine } from "./agent-core.ts";
import { applyEdits, parseEdits } from "./tools/edit_file.ts";
import { writable, type ToolContext } from "./tools/_lib.ts";

export type Show =
  | { kind: "diff"; path: string; lines: DiffLine[]; more: number } // more: diff lines left out after the first 600
  | { kind: "note"; text: string }; // why there is no diff (the edits do not apply: the tool will say the same)

const MAX_LINES = 600;

export function approveView(tool: string, args: Record<string, any>, ctx: ToolContext): Show | null {
  if (tool !== "write_file" && tool !== "edit_file") return null;
  let full: string;
  try { full = writable(String(args.path ?? ""), ctx).full; } catch { return null; }
  if (!existsSync(full)) return null; // a new file: its content is on the card already
  let current: string;
  try { current = readFileSync(full, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n"); } catch { return null; }
  let after: string;
  if (tool === "write_file") {
    if (typeof args.content !== "string") return null;
    let content = args.content.replace(/\r\n?/g, "\n");
    if (content && !content.endsWith("\n")) content += "\n";
    after = args.append ? current + content : content;
  } else {
    if (typeof args.edits !== "string") return null;
    const parsed = parseEdits(args.edits);
    if (parsed.error) return { kind: "note", text: parsed.error };
    const applied = applyEdits(current.split("\n"), parsed.edits);
    if (applied.error) return { kind: "note", text: applied.error };
    after = applied.lines.join("\n");
  }
  const lines = diffLines(current, after);
  return { kind: "diff", path: full, lines: lines.slice(0, MAX_LINES), more: Math.max(0, lines.length - MAX_LINES) };
}
