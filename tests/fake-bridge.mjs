// A fake Microsoft 365 Copilot for tests (config "bridgeScript"): the server calls it once per command, the message
// on stdin, and reads one JSON line back, like copilot-web.ts would answer.
//   node fake-bridge.mjs list [-NoLaunch] | read | open -Id <id> | delete -Id <id> | ask [-New]
// State lives in $FAKE_DIR (default: the current folder): chats.json (the sidebar), count.json (asks so far),
// asks.log (every message the server sent, in order: the tests read what Copilot would have seen).
// Replies come from $FAKE_REPLIES (a JSON array) or $FAKE_REPLIES_FILE (a file holding one), one per ask, in order:
// a string is Copilot's reply text; {"error": "..."} makes that ask fail like a Copilot error; {"text": "...",
// "delayMs": 3000} answers after a wait (a slow Copilot). After the last one, every ask gets a plain done.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [cmd, ...flags] = process.argv.slice(2);
const dir = process.env.FAKE_DIR || process.cwd();
mkdirSync(dir, { recursive: true });
const file = (name) => path.join(dir, name);
const readJson = (name, fallback) => (existsSync(file(name)) ? JSON.parse(readFileSync(file(name), "utf8")) : fallback);
const writeJson = (name, value) => writeFileSync(file(name), JSON.stringify(value), "utf8");
const option = (name) => { const i = flags.indexOf(name); return i >= 0 ? flags[i + 1] : undefined; };
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

const chats = readJson("chats.json", []);
if (cmd === "list") {
  out({ ok: true, chats });
} else if (cmd === "read") {
  out({ ok: true, messages: readJson("messages.json", []) });
} else if (cmd === "open") {
  const id = option("-Id");
  out(chats.some((c) => c.id === id) ? { ok: true, messages: readJson("messages.json", []) } : { ok: false, error: `no chat ${id}` });
} else if (cmd === "delete") {
  const id = option("-Id");
  writeJson("chats.json", chats.filter((c) => c.id !== id));
  out({ ok: true });
} else if (cmd === "ask") {
  const message = readFileSync(0, "utf8");
  const n = readJson("count.json", 0);
  appendFileSync(file("asks.log"), `\n===ASK ${n + 1}===\n${message}\n===END===\n`, "utf8");
  writeJson("count.json", n + 1);
  const replies = process.env.FAKE_REPLIES ? JSON.parse(process.env.FAKE_REPLIES)
    : process.env.FAKE_REPLIES_FILE && existsSync(process.env.FAKE_REPLIES_FILE) ? JSON.parse(readFileSync(process.env.FAKE_REPLIES_FILE, "utf8")) : [];
  const reply = replies[n] ?? '{"tool": "done", "args": {"answer": "(fake Copilot: out of replies)", "checks": []}}';
  if (reply && typeof reply === "object" && reply.error != null) {
    out({ ok: false, error: String(reply.error) });
  } else {
    const text = reply && typeof reply === "object" ? String(reply.text ?? "") : String(reply);
    if (reply && typeof reply === "object" && reply.delayMs) await new Promise((r) => setTimeout(r, Number(reply.delayMs)));
    let chatId;
    if (flags.includes("-New")) {
      chatId = randomUUID();
      writeJson("chats.json", [{ id: chatId, title: message.split("\n")[0].slice(0, 60) }, ...chats]);
    }
    out({ ok: true, text, ...(chatId ? { chatId } : {}) });
  }
} else {
  out({ ok: false, error: `fake bridge: unknown command ${cmd}` });
}
