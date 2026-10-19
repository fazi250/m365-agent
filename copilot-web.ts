// Microsoft 365 Copilot website (m365.cloud.microsoft/chat) in its own Edge window, as this app's chat engine.
// It is the same web app the Copilot desktop app shows, but driven through its page with playwright-core: messages
// are put into the chat box and replies read straight from the page, so nothing needs keyboard focus, the clipboard
// or the desktop app. The window has its own profile (.copilot-web-profile): sign in there once and it stays signed
// in. It is kept minimized; Playwright keeps a hidden page working, so the window never has to come up.
import path from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";

export type Chat = { id: string; title: string };
export type Msg = { role: "user" | "copilot"; text: string };
export type Result = { ok: boolean; error?: string; text?: string; chatId?: string; chats?: Chat[]; messages?: Msg[]; closed?: boolean; gone?: boolean; dryRun?: boolean };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDITOR = "#m365-chat-editor-target-element";
const SIGN_IN = /(^|\.)(login\.microsoftonline\.com|login\.microsoft\.com|login\.live\.com|account\.live\.com|login\.windows\.net)$/i;

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
        text = shown && text.includes(shown) ? text.replace(shown, block) : text + block;
      }
    }
    text = text.replace(/^\s*(You|Copilot) said:\s*/, "").replace(/\n{3,}/g, "\n\n").trim();
    const done = !![...a.querySelectorAll("button,[role=button]")].find((b) => b.getAttribute("aria-label") === "Copy Response");
    return { key: a.getAttribute("aria-posinset") ?? `i${i}`, role, text, done };
  }).filter((m) => m.role);
}

export class CopilotWeb {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private o: { root: string; url: string; channel: string; replyTimeoutSec?: number };

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
    return this.page;
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
      if (await p.locator(EDITOR).count().catch(() => 0)) { await this.setWindow("minimized"); return p; }
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
    const p = await this.ready();
    const articles = p.locator("[role=article]");
    if (newChat) {
      // a fresh chat, and make sure it really is empty, so the message can never land in the previous one
      for (let attempt = 1; attempt <= 2 && (await articles.count()); attempt++) {
        const link = p.getByRole("link", { name: "New chat", exact: true }).first();
        if (attempt === 1 && (await link.count())) await press(link);
        else await p.goto(this.o.url, { waitUntil: "domcontentloaded" });
        await p.locator(EDITOR).waitFor({ timeout: 20_000 });
        for (let i = 0; i < 20 && (await articles.count()); i++) await p.waitForTimeout(200);
      }
      if (await articles.count()) throw new Error("could not start a new chat in Copilot (nothing was sent)");
    }
    const chatsBefore = new Set((await this.chats(p)).map((c) => c.id));
    const before = await p.evaluate(readMessages);
    const userBefore = before.filter((m) => m.role === "user").length;
    const copilotBefore = before.filter((m) => m.role === "copilot").length;

    // put the message in the chat box as a paste (keeps its line breaks), check it is there, then Enter
    const box = p.locator(EDITOR).first();
    let sent = false;
    for (let attempt = 1; attempt <= 2 && !sent; attempt++) {
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
      await p.keyboard.press("Enter");
      for (let i = 0; i < 25 && !sent; i++) {
        await p.waitForTimeout(200);
        sent = (await p.evaluate(readMessages)).filter((m) => m.role === "user").length > userBefore;
      }
    }
    if (!sent) throw new Error("the message did not reach Copilot (nothing was sent; is a dialog open in the Copilot window?)");

    // done = the new reply has its "Copy Response" button and its text stopped changing. A notice that never gets
    // that button is taken once unchanged for 30 s, unless it is a progress line ("Lining things up...").
    const deadline = Date.now() + (this.o.replyTimeoutSec ?? 240) * 1000;
    let last = "", stable = 0;
    while (Date.now() < deadline) {
      await p.waitForTimeout(700);
      const notice = await this.notice(p);
      if (/limit/i.test(notice)) throw new Error(`Copilot: ${notice}`);
      const replies = (await p.evaluate(readMessages)).filter((m) => m.role === "copilot");
      if (replies.length <= copilotBefore) continue;
      const r = replies[replies.length - 1];
      if (r.done) await this.showCode(p); // Markdown / HTML blocks open as a preview: switch them to their code
      const text = r.done ? ((await p.evaluate(readMessages)).filter((m) => m.role === "copilot").at(-1)?.text ?? r.text) : r.text;
      stable = text && text === last ? stable + 1 : 0;
      last = text;
      const progress = /(\.\.\.|…)\s*$/.test(text);
      if (progress && stable < 85) continue;
      if ((r.done && stable >= 1) || stable >= 43) return { ok: true, text, chatId: await this.chatIdNow(p, chatsBefore) };
    }
    throw new Error(`no reply from Copilot within ${this.o.replyTimeoutSec ?? 240} s`);
  }

  // the open chat's id: from the address, or (a new chat gets its address and sidebar entry a moment after the
  // reply) the sidebar link that wasn't there before the message
  private async chatIdNow(p: Page, before: Set<string>): Promise<string | undefined> {
    for (let i = 0; i < 16; i++) {
      const fromUrl = p.url().match(/conversation\/([0-9a-f-]{36})/i)?.[1];
      if (fromUrl) return fromUrl;
      const added = (await this.chats(p)).find((c) => !before.has(c.id));
      if (added) return added.id;
      await p.waitForTimeout(500);
    }
    return undefined;
  }

  // a code block shown as a rendered preview (Markdown, HTML) has a "Code" toggle: press it to see the raw text
  private async showCode(p: Page) {
    for (const t of await p.locator('[id="preview-toggle-button"]').all()) {
      const name = ((await t.getAttribute("aria-label")) || (await t.innerText().catch(() => ""))).trim();
      if (name !== "Code" || (await t.getAttribute("aria-pressed")) === "true" || (await t.getAttribute("aria-selected")) === "true") continue;
      await press(t);
    }
  }

  async remove(id: string, dryRun = false): Promise<Result> {
    if (!GUID.test(id)) throw new Error(`not a chat id: ${id}`);
    const p = await this.ready();
    const link = p.locator(`a[id="${id}"]`).first();
    if (!(await link.count())) return { ok: true, gone: true };
    // the chat's "More" button (next to its link in the sidebar, marked with the chat's id); then More > Delete >
    // "Delete chat?" > Delete
    const more = p.locator(`[data-chat-history-more-button-conversation-id="${id}"]`).first();
    let dialog = null;
    for (let attempt = 1; attempt <= 3 && !dialog; attempt++) {
      if (!(await more.count())) throw new Error(`no More button next to chat ${id}`);
      await press(more);
      const item = p.getByRole("menuitem", { name: "Delete" }).first();
      if (!(await item.waitFor({ timeout: 3000 }).then(() => true, () => false))) { await p.keyboard.press("Escape"); continue; }
      await press(item);
      const d = p.locator("[role=dialog],[role=alertdialog]").filter({ hasText: /Delete chat/i }).first(); // a Fluent alert dialog
      if (await d.waitFor({ timeout: 4000 }).then(() => true, () => false)) dialog = d;
    }
    if (!dialog) throw new Error("the chat menu has no Delete item, or its confirmation did not open");
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
