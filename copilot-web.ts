// Microsoft 365 Copilot website (m365.cloud.microsoft/chat) in its own Edge window, as this app's chat engine.
// It is the same web app the Copilot desktop app shows, but driven through its page with playwright-core: messages
// are put into the chat box and replies read straight from the page, so nothing needs keyboard focus, the clipboard
// or the desktop app. The window has its own profile (.copilot-web-profile): sign in there once and it stays signed
// in. It is kept minimized; Playwright keeps a hidden page working, so the window never has to come up.
import path from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";

export type Chat = { id: string; title: string };
export type Msg = { role: "user" | "copilot"; text: string };
export type Result = {
  ok: boolean; error?: string; text?: string; chatId?: string; chats?: Chat[]; messages?: Msg[]; closed?: boolean; gone?: boolean; dryRun?: boolean;
  via?: "button" | "stable30" | "progress60"; // how a reply was taken as finished (ask): its Copy Response button, or text unchanged for 30 s / 60 s
  // ask: where the round trip's time went, in ms (ready: the page; newChat; send: until the message was in the chat;
  // first: until the reply's first text; button: until its Copy button; settle: until the text was seen unchanged;
  // chatId: finding a new chat's id), so a slow laptop's timeouts can be told from a slow Copilot
  timing?: Record<string, number>;
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGN_IN = /(^|\.)(login\.microsoftonline\.com|login\.microsoft\.com|login\.live\.com|account\.live\.com|login\.windows\.net)$/i;

// What the engine looks for in the page, several ways each (the first that matches wins), so a renamed id or label
// in a Copilot update is one line here. Seen layouts: the 2025 chat (editor id, "Copy Response") and the late-2025
// "latest Copilot" composer (fai-SendButton, "Add and manage sources").
const SEL = {
  editor: ["#m365-chat-editor-target-element", "[role=textbox][contenteditable=true][aria-label*='Message' i]", "[contenteditable=true][data-lexical-editor=true]", "textarea[aria-label*='Message' i]"],
  send: ["button[aria-label='Send' i]", "button.fai-SendButton", "button[type=submit][aria-label*='send' i]", "button[data-testid*='send' i]"],
  newChat: ["a[aria-label='New chat' i]", "button[aria-label='New chat' i]", "[role=link][aria-label*='New chat' i]"],
  article: ["[role=article]"],
  copyResponse: ["button[aria-label='Copy Response' i]", "button[aria-label='Copy' i]", "[role=button][aria-label='Copy Response' i]"],
  more: (id: string) => [`[data-chat-history-more-button-conversation-id="${id}"]`, `a[id="${id}"] ~ button[aria-label='More' i]`, `a[id="${id}"] + button`],
};
const EDITOR = SEL.editor.join(", ");
// signing the broken session out brings the real sign-in page back (the chat page itself keeps rendering from its
// cache with a dead session and never redirects)
const LOGOUT_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/logout?post_logout_redirect_uri=" + encodeURIComponent("https://m365.cloud.microsoft/chat");

// Copilot's page sometimes has a layer over its controls that makes a normal click wait in vain (seen on the
// sidebar's More buttons and its menus): a normal click first, then one that skips Playwright's checks, then a plain
// click event.
async function press(loc: Locator) {
  if (await loc.click({ timeout: 2500 }).then(() => true, () => false)) return;
  if (await loc.click({ force: true, timeout: 2500 }).then(() => true, () => false)) return;
  // only while it is still there: a click that did land often closes it (a menu item), which is not a failure
  if (await loc.count()) await loc.dispatchEvent("click", undefined, { timeout: 2500 }).catch(() => {});
}

// ── read in the page: every message as {key, role, text}. key is the message's place in the chat (aria-posinset),
// so pages read while scrolling a long chat can be stitched together. Code blocks come out as markdown fences around
// their exact text, longer than any backtick run inside, the way the agent's parser expects them. ──
function readMessages() {
  const fenceFor = (code: string) => { let f = "```"; while (code.includes(f)) f += "`"; return f; };
  const codeOf = (group: Element) => {
    const ed = group.querySelector('[role=textbox][aria-label="Code editor"]') as HTMLElement | null;
    if (!ed) return null;
    // one div per line ([data-line-index], indentation intact) after an empty line-number div ([data-line-number]);
    // an empty line is drawn as a lone no-break space
    const lines = [...ed.querySelectorAll("[data-line-index]")].map((l) => (l as HTMLElement).innerText.replace(/ /g, " "))
      .map((l) => (l.trim() ? l : ""));
    return lines.length ? lines.join("\n") : ed.innerText.replace(/ /g, " ").replace(/\n$/, "");
  };
  return [...document.querySelectorAll("[role=article]")].map((a, i) => {
    const ids = (a.getAttribute("aria-labelledby") ?? "").split(/\s+/);
    const role = ids.some((x) => x.startsWith("copilot-message-")) ? "copilot" : ids.some((x) => x.startsWith("user-message-")) ? "user" : "";
    const bodyId = ids.find((x) => /-message-/.test(x) && !x.endsWith("-title"));
    const body = ((bodyId && document.getElementById(bodyId)) || a) as HTMLElement;
    let text: string;
    if (role === "user") {
      text = ((body.querySelector("[data-testid=chatOutput]") as HTMLElement | null) ?? body).innerText;
    } else {
      text = body.innerText;
      // status lines inside the reply ("Reasoned for 1s", "Coding and executing") are not part of the answer
      for (const s of body.querySelectorAll("[role=status]")) { const t = (s as HTMLElement).innerText.trim(); if (t) text = text.replace(t, ""); }
      for (const g of body.querySelectorAll('[role=group][aria-label="Code Preview"]')) {
        const code = codeOf(g), shown = (g as HTMLElement).innerText;
        if (code == null) continue;
        const fence = fenceFor(code);
        const block = `\n${fence}\n${code}\n${fence}\n`;
        // a function replacer: with a string, "$&", "$$" or "$'" inside the code would be taken as replacement patterns
        text = shown && text.includes(shown) ? text.replace(shown, () => block) : text + block;
      }
    }
    text = text.replace(/^\s*(You|Copilot) said:\s*/, "").replace(/\n{3,}/g, "\n\n").trim();
    // finished = its Copy button is there ("Copy Response" in the 2025 layout; "Copy" in the latest one)
    const done = !![...a.querySelectorAll("button,[role=button]")].find((b) => /^copy( response)?$/i.test((b.getAttribute("aria-label") || b.getAttribute("title") || "").trim()));
    const pos = Number(a.getAttribute("aria-posinset")) || 0; // the message's number in the whole chat (1, 2, ...)
    return { key: pos ? String(pos) : `i${i}`, pos, role, text, done };
  }).filter((m) => m.role);
}

export class CopilotWeb {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private o: { root: string; url: string; channel: string; replyTimeoutSec?: number };
  // when the page's silent sign-in (token refresh) was refused: with a dead session the page still renders but
  // nothing can be sent (the Send button stays disabled) and deletes do not stick
  private authFails: number[] = [];
  private authBroken() { const since = Date.now() - 60_000; this.authFails = this.authFails.filter((t) => t > since); return this.authFails.length >= 3; }

  constructor(o: { root: string; url: string; channel: string; replyTimeoutSec?: number }) { this.o = o; }

  /** the Copilot window is open (closing it ends it; the background sync then leaves it closed) */
  isOpen() { return !!this.context && !!this.page && !this.page.isClosed(); }

  async close() { await this.context?.close().catch(() => {}); }

  private async start(): Promise<Page> {
    if (this.isOpen()) return this.page!;
    if (!this.context) {
      const dir = path.join(this.o.root, ".copilot-web-profile");
      try {
        // a fixed page size keeps Copilot's full layout (sidebar included) however small or hidden the window is
        this.context = await chromium.launchPersistentContext(dir, {
          channel: this.o.channel, headless: false, viewport: { width: 1400, height: 900 }, chromiumSandbox: true,
          args: ["--window-size=1420,1020"],
        });
      } catch (e) {
        throw new Error(`could not start Edge for Copilot: ${String(e instanceof Error ? e.message : e).split("\n")[0]}`);
      }
      this.context.on("close", () => { this.context = null; this.page = null; });
    }
    this.page = this.context.pages().find((p) => !p.isClosed()) ?? (await this.context.newPage());
    this.page.on("response", (r) => {
      if (r.status() >= 400 && /\/oauth2\/v2\.0\/token|login\.live\.com\/oauth20_token/i.test(r.url())) this.authFails.push(Date.now());
    });
    return this.page;
  }

  // The session is dead (its sign-in server refuses the token refresh): sign it out so the real sign-in page comes
  // back, bring the window up and tell the user. Always ends in an error for the current command.
  private async reauth(p: Page): Promise<never> {
    this.authFails = [];
    await this.setWindow("normal");
    await p.goto(LOGOUT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    // Microsoft's sign-out page may ask which account: the signed-in one
    const tile = p.getByText(/^Signed in$/i).first();
    if (await tile.waitFor({ timeout: 5000 }).then(() => true, () => false)) await press(tile);
    await p.waitForTimeout(4000);
    throw new Error("Microsoft 365 Copilot's sign-in had expired (its sign-in server refused the session, so nothing could be sent). " +
      "The Copilot window is up: sign in there again, then press Sync");
  }

  private async setWindow(state: "minimized" | "normal") {
    const p = this.page;
    if (!p) return;
    try {
      const cdp = await p.context().newCDPSession(p);
      const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget");
      if (bounds.windowState !== state) await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: state } });
      await cdp.detach();
      if (state === "normal") await p.bringToFront();
    } catch { /* only looks */ }
  }

  // Copilot open with its chat box. A sign-in page is left alone (you may be signing in right now): the window comes
  // up and the error says what to do. Single sign-on usually passes through the sign-in pages on its own, so they get
  // a few seconds first.
  private async ready(): Promise<Page> {
    const p = await this.start();
    const home = new URL(this.o.url);
    const host = () => { try { return new URL(p.url()).hostname; } catch { return ""; } };
    if (host() !== home.hostname && !SIGN_IN.test(host())) {
      await p.goto(this.o.url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    }
    const started = Date.now();
    let signInSince = 0;
    while (Date.now() - started < 60_000) {
      if (await p.locator(EDITOR).count().catch(() => 0)) {
        await this.dismissPopups(p);
        await this.setWindow("minimized");
        return p;
      }
      if (SIGN_IN.test(host())) {
        signInSince ||= Date.now();
        if (Date.now() - signInSince > 15_000) {
          await this.setWindow("normal");
          throw new Error("Microsoft 365 Copilot wants you to sign in: sign in (work account) in the Copilot window that just came up, then press Sync");
        }
      } else {
        signInSince = 0;
        const notice = await this.notice(p);
        if (/limit|unavailable|not available|access/i.test(notice)) throw new Error(`Copilot: ${notice}`);
      }
      await p.waitForTimeout(500);
    }
    await this.setWindow("normal");
    throw new Error(`the Copilot chat box did not appear (page ${p.url().split("?")[0]}); have a look at the Copilot window`);
  }

  // Copilot's own notices (daily limit, errors), shown in status regions outside the messages
  private notice(p: Page): Promise<string> {
    return p.evaluate(() => [...document.querySelectorAll("[role=status],[role=alert]")]
      .filter((e) => !e.closest("[role=article]")).map((e) => (e as HTMLElement).innerText.trim()).filter(Boolean).join(" ")).catch(() => "");
  }

  // Copilot's own pop-ups ("Meet the latest Copilot", an announcement, a survey) sit over the page and swallow every
  // click underneath (seen: Delete all stopped at the second chat). They are closed through their Close / Not now
  // button or Escape, never through their call to action (which could move the page to another experience). The
  // "Delete chat?" confirmation is this app's own and is left alone.
  private async dismissPopups(p: Page): Promise<string[]> {
    const closed: string[] = [];
    for (const d of await p.locator("[role=dialog],[role=alertdialog]").all()) {
      const text = (await d.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (/Delete chat/i.test(text) || !(await d.isVisible().catch(() => false))) continue;
      const close = d.getByRole("button", { name: /^(close|dismiss|close dialog)$/i }).first();
      const soft = d.getByRole("button", { name: /not now|maybe later|skip|got it|no thanks|remind me later|dismiss/i }).first();
      if (await close.count()) await press(close);
      else if (await soft.count()) await press(soft);
      else await p.keyboard.press("Escape");
      await d.waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});
      closed.push(text.slice(0, 60));
    }
    return closed;
  }

  // the sidebar reloads for a while after a change ("Getting your chats…"): wait until it has settled
  private async sidebarSettled(p: Page, timeoutMs = 20_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until && /Getting your chats/i.test(await this.notice(p))) await p.waitForTimeout(500);
  }

  private chats(p: Page): Promise<Chat[]> {
    return p.evaluate((src) => {
      const guid = new RegExp(src, "i"), seen = new Set<string>();
      return [...document.querySelectorAll("a[id]")].filter((a) => guid.test(a.id) && !seen.has(a.id) && seen.add(a.id))
        .map((a) => ({ id: a.id, title: ((a.getAttribute("aria-label") || (a as HTMLElement).innerText) ?? "").replace(/\s+/g, " ").trim() }));
    }, GUID.source);
  }

  // all messages of the open chat; a long chat is scrolled through from the top and its pages stitched by place
  private async messages(p: Page): Promise<Msg[]> {
    const found = new Map<string, Msg>();
    const order: string[] = [];
    const take = async () => {
      for (const m of await p.evaluate(readMessages)) {
        if (!found.has(m.key)) order.push(m.key);
        found.set(m.key, { role: m.role as Msg["role"], text: m.text });
      }
    };
    const pages = await p.evaluate(() => {
      const feed = document.querySelector('[role=feed][aria-label="Chat conversation"]');
      let el = feed as HTMLElement | null;
      while (el && !(el.scrollHeight > el.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
      if (!el) return 0;
      (window as any).__agentScroller = el;
      return Math.ceil(el.scrollHeight / (el.clientHeight * 0.8));
    }).catch(() => 0);
    if (!pages) { await take(); return order.map((k) => found.get(k)!); }
    for (let i = 0; i <= pages; i++) {
      await p.evaluate((i) => { const s = (window as any).__agentScroller; s.scrollTop = i * s.clientHeight * 0.8; }, i);
      await p.waitForTimeout(250);
      await take();
    }
    await p.evaluate(() => { const s = (window as any).__agentScroller; s.scrollTop = s.scrollHeight; });
    return [...order].sort((a, b) => Number(a) - Number(b) || 0).map((k) => found.get(k)!);
  }

  // ── the commands the server uses ──

  async list(noLaunch = false): Promise<Result> {
    if (noLaunch && !this.isOpen()) return { ok: true, closed: true, chats: [] };
    const p = await this.ready();
    let chats: Chat[] = [];
    for (let i = 0; i < 20; i++) { // the sidebar fills in a moment after loading
      chats = await this.chats(p);
      if (chats.length || (await p.getByText(/^No chats yet/).count())) break;
      await p.waitForTimeout(300);
    }
    return { ok: true, chats };
  }

  async read(): Promise<Result> {
    const p = await this.ready();
    return { ok: true, messages: await this.messages(p) };
  }

  async open(id: string): Promise<Result> {
    if (!GUID.test(id)) throw new Error(`not a chat id: ${id}`);
    const p = await this.ready();
    const link = p.locator(`a[id="${id}"]`).first();
    if (await link.count()) await press(link);
    else await p.goto(new URL(`/chat/conversation/${id}`, this.o.url).href, { waitUntil: "domcontentloaded" });
    await p.waitForURL((u) => u.pathname.includes(id), { timeout: 15_000 }).catch(() => {});
    await p.locator(EDITOR).waitFor({ timeout: 20_000 });
    await p.locator("[role=article]").first().waitFor({ timeout: 8000 }).catch(() => {}); // an empty chat has none
    await p.waitForTimeout(400);
    return { ok: true, messages: await this.messages(p) };
  }

  async ask(message: string, newChat: boolean): Promise<Result> {
    if (!message.trim()) throw new Error("empty message");
    const timing: Record<string, number> = {};
    let markAt = Date.now();
    const mark = (phase: string) => { const now = Date.now(); timing[phase] = now - markAt; markAt = now; };
    const p = await this.ready();
    mark("ready");
    const articles = p.locator("[role=article]");
    if (this.authBroken()) await this.reauth(p);
    if (newChat) {
      // a fresh chat, and make sure it really is empty, so the message can never land in the previous one
      for (let attempt = 1; attempt <= 2 && (await articles.count()); attempt++) {
        const link = p.locator(SEL.newChat.join(", ")).first();
        if (attempt === 1 && (await link.count())) await press(link);
        else await p.goto(this.o.url, { waitUntil: "domcontentloaded" });
        await p.locator(EDITOR).waitFor({ timeout: 20_000 });
        for (let i = 0; i < 20 && (await articles.count()); i++) await p.waitForTimeout(200);
      }
      if (await articles.count()) throw new Error("could not start a new chat in Copilot (nothing was sent)");
    }
    mark("newChat");
    const chatsBefore = new Set((await this.chats(p)).map((c) => c.id));
    // New messages are told apart by their number in the chat (aria-posinset): higher than any before. Counting the
    // messages in the page is not enough, since Copilot can take messages far above the view out of the page.
    const before = await p.evaluate(readMessages);
    const numbered = before.every((m) => m.pos > 0);
    const posBefore = Math.max(0, ...before.map((m) => m.pos));
    const countBefore = { user: before.filter((m) => m.role === "user").length, copilot: before.filter((m) => m.role === "copilot").length };
    const newOnes = (list: typeof before, role: "user" | "copilot") => {
      const mine = list.filter((m) => m.role === role);
      return numbered && mine.every((m) => m.pos > 0) ? mine.filter((m) => m.pos > posBefore) : mine.slice(countBefore[role]);
    };

    // put the message in the chat box as a paste (keeps its line breaks), check it is there, then send it with the
    // Send button (Enter when there is none)
    const box = p.locator(EDITOR).first();
    const send = p.locator(SEL.send.join(", ")).first();
    // enabled, and still the Send button: while Copilot answers, the same button is "Stop generating"
    const sendEnabled = async () => (await send.count()) > 0 && (await send.isEnabled().catch(() => false)) && (await send.getAttribute("aria-disabled")) !== "true"
      && !/stop/i.test((await send.getAttribute("aria-label").catch(() => "")) ?? "");
    let sent = false;
    for (let attempt = 1; attempt <= 2 && !sent; attempt++) {
      if (attempt > 1) await this.dismissPopups(p); // a pop-up may have taken the first attempt's clicks
      await press(box);
      await p.keyboard.press("Control+A");
      await p.keyboard.press("Delete");
      await box.evaluate((el, text) => {
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      }, message);
      await p.waitForTimeout(250);
      const typed = (await box.innerText()).replace(/\s+/g, "");
      if (typed.length < Math.min(20, message.replace(/\s+/g, "").length)) {
        await p.keyboard.insertText(message); // the paste was not taken: type it instead
        await p.waitForTimeout(250);
      }
      // the Send button wakes up once the editor took the text; a button that stays off with text in the box means
      // the page cannot send at all (a dead session), not that the text is missing
      let ready = !(await send.count());
      for (let i = 0; i < 16 && !ready; i++) { ready = await sendEnabled(); if (!ready) await p.waitForTimeout(250); }
      if (!ready) {
        if (this.authBroken()) await this.reauth(p);
        if (attempt === 2) break;
        continue;
      }
      // one plain click only: a second click (press()'s fallbacks) would land on the same button once it has turned
      // into "Stop generating" and cut Copilot's answer short
      if (await send.count()) { if (!(await send.click({ timeout: 5000 }).then(() => true, () => false))) await p.keyboard.press("Enter"); }
      else await p.keyboard.press("Enter");
      // Sent = the new message shows up in the chat. The page takes the text out of the box the moment it accepts
      // the message, and can draw it in the chat seconds later when the service is slow: an empty box means sent
      // (wait longer, never send again); text still in the box means it was not taken (try once more).
      const boxEmpty = async () => !(await box.innerText().catch(() => "")).replace(/[\s​‌﻿]/g, "");
      for (let i = 0; i < 25 && !sent; i++) {
        await p.waitForTimeout(200);
        sent = newOnes(await p.evaluate(readMessages), "user").length > 0;
      }
      if (!sent && (await boxEmpty())) {
        for (let i = 0; i < 100 && !sent; i++) { // up to 20 s more for the chat to show it
          await p.waitForTimeout(200);
          sent = newOnes(await p.evaluate(readMessages), "user").length > 0;
        }
        if (!sent) sent = true; // taken, not drawn: go on to the reply, which is told by its number anyway
      }
      if (!sent && !(await boxEmpty()) && (await send.count()) && (await sendEnabled())) { await p.keyboard.press("Enter"); await p.waitForTimeout(1500); sent = newOnes(await p.evaluate(readMessages), "user").length > 0 || (await boxEmpty()); }
    }
    if (!sent) {
      if (this.authBroken()) await this.reauth(p);
      throw new Error("the message did not reach Copilot (nothing was sent; the Send button stayed off: is a dialog open in the Copilot window, or does Copilot show a notice?)");
    }
    mark("send");

    // done = the new reply has its "Copy Response" button and its text stopped changing. A notice that never gets
    // that button is taken once unchanged for 30 s, unless it is a progress line ("Lining things up...": 60 s).
    const timeout = this.o.replyTimeoutSec ?? 240;
    const deadline = Date.now() + timeout * 1000;
    let last = "", stable = 0, seen: { text: string; done: boolean } | null = null, notice = "";
    while (Date.now() < deadline) {
      await p.waitForTimeout(700);
      notice = await this.notice(p);
      if (/limit/i.test(notice)) throw new Error(`Copilot: ${notice}`);
      const r = newOnes(await p.evaluate(readMessages), "copilot").at(-1);
      if (!r) continue;
      if (!seen) mark("first"); // the reply's first text
      if (r.done && timing.button == null) mark("button"); // its Copy button: the reply is complete
      if (r.done) await this.showCode(p); // Markdown / HTML blocks open as a preview: switch them to their code
      const text = r.done ? (newOnes(await p.evaluate(readMessages), "copilot").at(-1)?.text ?? r.text) : r.text;
      seen = { text, done: r.done };
      stable = text && text === last ? stable + 1 : 0;
      last = text;
      // the progress-line rule only while the button is missing: a finished reply may well end in "..."
      const progress = !r.done && /(\.\.\.|…)\s*$/.test(text);
      if (progress && stable < 85) continue;
      if ((r.done && stable >= 1) || stable >= 43) {
        const via = r.done ? "button" : progress ? "progress60" : "stable30";
        mark("settle");
        const chatId = await this.chatIdNow(p, chatsBefore);
        mark("chatId");
        return { ok: true, text, chatId, via, timing };
      }
    }
    throw new Error(`no reply from Copilot within ${timeout} s (${await this.whatWasThere(p, seen, notice)})`);
  }

  // for a timeout: what the page showed, and a screenshot of it next to the server (copilot-timeout.png)
  private async whatWasThere(p: Page, seen: { text: string; done: boolean } | null, notice: string): Promise<string> {
    const all = await p.evaluate(readMessages).catch(() => []);
    const parts = [seen
      ? `its reply so far: "${seen.text.replace(/\s+/g, " ").slice(0, 160)}"${seen.done ? "" : ", without a Copy Response button"}`
      : `no new reply in the page; it shows ${all.length} messages, the last from ${all.at(-1)?.role ?? "nobody"} (#${all.at(-1)?.pos ?? "-"})`];
    if (notice) parts.push(`Copilot says: ${notice.slice(0, 200)}`);
    const file = path.join(this.o.root, "copilot-timeout.png");
    if (await p.screenshot({ path: file, timeout: 10_000 }).then(() => true, () => false)) parts.push(`screenshot of the Copilot page: ${file}`);
    return parts.join("; ");
  }

  // the open chat's id: from the address, or (a new chat gets its address and sidebar entry a moment after the
  // reply) the sidebar link that wasn't there before the message
  private async chatIdNow(p: Page, before: Set<string>): Promise<string | undefined> {
    let fromUrl: string | undefined;
    for (let i = 0; i < 16; i++) {
      // the address can still name the chat that was open before New chat was pressed: only an id that was not in the
      // sidebar before the message is the new chat's
      fromUrl = p.url().match(/conversation\/([0-9a-f-]{36})/i)?.[1];
      if (fromUrl && !before.has(fromUrl)) return fromUrl;
      const added = (await this.chats(p)).find((c) => !before.has(c.id));
      if (added) return added.id;
      await p.waitForTimeout(500);
    }
    return fromUrl;
  }

  // a code block shown as a rendered preview (Markdown, HTML) has a "Code" toggle: press it to see the raw text
  private async showCode(p: Page) {
    for (const t of await p.locator('[id="preview-toggle-button"]').all()) {
      const name = ((await t.getAttribute("aria-label")) || (await t.innerText().catch(() => ""))).trim();
      if (name !== "Code" || (await t.getAttribute("aria-pressed")) === "true" || (await t.getAttribute("aria-selected")) === "true") continue;
      await press(t);
    }
  }

  // ── diagnostics. They name no chats and quote no messages (those can hold work data). ──

  // what the Copilot page shows right now, as report lines
  private async pageState(p: Page): Promise<string[]> {
    const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ""; } };
    const edge = (await p.evaluate(() => navigator.userAgent).catch(() => "")).match(/Edg\/([\d.]+)/)?.[1] ?? "?";
    const chats = await this.chats(p).catch(() => []);
    const msgs = await p.evaluate(readMessages).catch(() => []);
    const last = msgs.at(-1);
    return [
      `page: ${p.url().split("?")[0]} ("${await p.title().catch(() => "")}")${SIGN_IN.test(hostOf(p.url())) ? "  <== a SIGN-IN page" : ""}; Edge ${edge}`,
      `chat box: ${(await p.locator(EDITOR).count().catch(() => 0)) ? "there" : "NOT there"}; sidebar chats: ${chats.length}; New chat link: ${(await p.locator(SEL.newChat.join(", ")).count().catch(() => 0)) ? "there" : "NOT there"}`,
      `open chat: ${msgs.length} messages in the page` + (last ? `; the last is from ${last.role} (#${last.pos || "?"}, ${last.text.length} characters)` +
        (last.role === "copilot" ? (last.done ? ", with its Copy Response button" : ", WITHOUT a Copy Response button") : "") : ""),
      `Copilot notices: ${(await this.notice(p)) || "(none)"}`,
      `pop-ups over the page: ${(await p.locator("[role=dialog],[role=alertdialog]").allInnerTexts().catch(() => [] as string[])).map((t) => `"${t.replace(/\s+/g, " ").trim().slice(0, 60)}"`).join(", ") || "(none)"}`,
      `Send button: ${(await p.locator(SEL.send.join(", ")).count().catch(() => 0)) ? ((await p.locator(SEL.send.join(", ")).first().isEnabled().catch(() => false)) ? "there, enabled" : "there, disabled (normal while the box is empty)") : "NOT there"}; sign-in token refusals in the last minute: ${this.authFails.filter((t) => t > Date.now() - 60_000).length}${this.authBroken() ? "  <== the session is dead: sign in again" : ""}`,
    ];
  }

  /** after a failed command: the page's state and a screenshot (file), without opening Copilot if it is closed */
  async capture(file: string): Promise<string[]> {
    if (!this.isOpen()) return ["the Copilot window is not open"];
    const p = this.page!;
    const lines = await this.pageState(p).catch((e) => [`page state unavailable: ${e instanceof Error ? e.message : e}`]);
    const shot = await p.screenshot({ path: file, timeout: 10_000 }).then(() => `screenshot: ${file}`, () => "no screenshot");
    return [...lines, shot];
  }

  /** npm run diag: reaching Copilot step by step; ask: also one test message in a new chat, timed */
  async diagnose(opts: { ask?: boolean; screenshot?: string } = {}): Promise<string[]> {
    const out: string[] = [];
    const say = (s: string) => out.push(s);
    const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];
    const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ""; } };
    const t0 = Date.now();
    const secs = (from = t0) => `${((Date.now() - from) / 1000).toFixed(1)} s`;
    say(`Copilot page ${this.o.url}, browser ${this.o.channel}, profile ${path.join(this.o.root, ".copilot-web-profile")}`);
    let p: Page;
    try {
      const was = this.isOpen();
      p = await this.start();
      say(was ? "Edge window: already open" : `Edge window: started in ${secs()}`);
    } catch (e) {
      say(`Edge window: FAILED: ${why(e)}`);
      return out;
    }
    const hosts: string[] = [];
    const onNav = (f: any) => { if (f === p.mainFrame()) { const h = hostOf(f.url()); if (h && hosts.at(-1) !== h) hosts.push(h); } };
    p.on("framenavigated", onNav);
    try { await this.ready(); say(`ready: yes (${secs()})`); } catch (e) { say(`ready: NO: ${why(e)}`); }
    p.off("framenavigated", onNav);
    if (hosts.length) say(`pages on the way: ${hosts.join(" > ")}`);
    out.push(...(await this.pageState(p)));
    if (opts.ask) {
      const t1 = Date.now();
      try {
        const r = await this.ask("Reply with only the word OK.", true);
        say(`test message in a new chat: reply in ${secs(t1)}: "${String(r.text).slice(0, 40)}"`);
      } catch (e) { say(`test message: FAILED after ${secs(t1)}: ${why(e)}`); }
    }
    if (opts.screenshot) {
      say(await p.screenshot({ path: opts.screenshot, timeout: 10_000 }).then(() => `screenshot of the Copilot page: ${opts.screenshot}`, (e) => `screenshot failed: ${why(e)}`));
    }
    return out;
  }

  async remove(id: string, dryRun = false): Promise<Result> {
    if (!GUID.test(id)) throw new Error(`not a chat id: ${id}`);
    const p = await this.ready();
    await this.sidebarSettled(p); // right after a delete the sidebar is reloading and its buttons do nothing
    const link = p.locator(`a[id="${id}"]`).first();
    if (!(await link.count())) return { ok: true, gone: true };
    // the chat's "More" button (next to its link in the sidebar, marked with the chat's id; drawn when the row is
    // hovered); then More > Delete > "Delete chat?" > Delete
    if (this.authBroken()) await this.reauth(p); // with a dead session a delete only looks done and comes back
    const more = p.locator(SEL.more(id).join(", ")).first();
    let dialog = null;
    for (let attempt = 1; attempt <= 3 && !dialog; attempt++) {
      if (attempt > 1) { await this.dismissPopups(p); await this.sidebarSettled(p); }
      if (!(await more.count())) throw new Error(`no More button next to chat ${id}`);
      await link.hover({ timeout: 2000 }).catch(() => {});
      await press(more);
      const item = p.getByRole("menuitem", { name: "Delete" }).first();
      if (!(await item.waitFor({ timeout: 3000 }).then(() => true, () => false))) { await p.keyboard.press("Escape"); continue; }
      await press(item);
      const d = p.locator("[role=dialog],[role=alertdialog]").filter({ hasText: /Delete chat/i }).first(); // a Fluent alert dialog
      if (await d.waitFor({ timeout: 4000 }).then(() => true, () => false)) dialog = d;
    }
    if (!dialog) {
      const popups = await p.locator("[role=dialog],[role=alertdialog]").allInnerTexts().catch(() => [] as string[]);
      const over = popups.map((t) => t.replace(/\s+/g, " ").trim().slice(0, 50)).filter(Boolean);
      throw new Error(`the chat menu has no Delete item, or its confirmation did not open${over.length ? ` (a pop-up is over the page: "${over.join('" / "')}")` : ""}`);
    }
    if (dryRun) {
      await press(dialog.getByRole("button", { name: "Cancel" }));
      return { ok: true, dryRun: true };
    }
    await press(dialog.getByRole("button", { name: "Delete", exact: true }));
    await dialog.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
    if (!(await link.waitFor({ state: "detached", timeout: 10_000 }).then(() => true, () => false))) {
      throw new Error(`chat ${id} is still in the sidebar after Delete`);
    }
    // Copilot removes the chat at once and puts it back if its server refuses the delete
    await p.waitForTimeout(2500);
    if (await p.locator(`a[id="${id}"]`).count()) throw new Error(`Copilot put chat ${id} back: its server did not accept the delete`);
    return { ok: true };
  }
}
