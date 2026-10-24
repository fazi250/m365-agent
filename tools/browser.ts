// Browser tool: the installed Microsoft Edge (or Chrome, see "browser" in config.json) in its own window, with its
// own profile, separate from the browser this app runs in. Sign in to a site there once and it stays signed in.
// Copilot reads a numbered list of the page's controls and picks one by id. Evidence screenshots are full-screen
// snaps like a tester's: the browser window brought to the front, the taskbar included, a red box around the control
// (or page_only: just the page), saved in the workspace for reports.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";
import { nextScreenshot, screenDriver, type Tool, type ToolContext } from "./_lib.ts";

let context: BrowserContext | null = null;
let page: Page | null = null;
let closedByUser = false; // the window was closed since the last step: the next step opens a fresh, empty one

const BROWSER_NAME: Record<string, string> = { msedge: "Microsoft Edge", chrome: "Google Chrome" };

// one profile per browser (Edge and Chrome can't share one); Chrome keeps the original folder and its sign-ins
const profileDir = (ctx: ToolContext) =>
  path.join(ctx.root, ctx.browserChannel === "chrome" ? ".browser-profile" : `.browser-profile-${ctx.browserChannel}`);

async function getPage(ctx: ToolContext): Promise<Page> {
  if (context && page && !page.isClosed()) return page;
  if (!context) {
    const channel = ctx.browserChannel;
    const dir = profileDir(ctx);
    try {
      // chromiumSandbox: keep the browser's sandbox on (Playwright turns it off by default; it browses real sites)
      context = await chromium.launchPersistentContext(dir, { channel, headless: false, viewport: null, chromiumSandbox: true, args: ["--start-maximized"] });
    } catch (e) {
      // no silent switch to the other browser: you chose this one
      throw new Error(`could not start ${BROWSER_NAME[channel] ?? channel}: ${String(e instanceof Error ? e.message : e).split("\n")[0]}`);
    }
    context.on("close", () => { context = null; page = null; closedByUser = true; });
    context.on("page", (p) => { page = p; }); // follow tabs the site opens
  }
  page = context.pages().filter((p) => !p.isClosed()).at(-1) ?? (await context.newPage());
  await page.bringToFront();
  return page;
}

// Tags the page's controls with data-agent="eN" and returns one line per control.
async function listControls(p: Page, filter: string): Promise<string[]> {
  return p.evaluate((filter) => {
    const SEL = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],' +
      '[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=textbox],' +
      '[role=searchbox],[contenteditable=""],[contenteditable=true],[onclick]';
    const clean = (s) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 70);
    document.querySelectorAll("[data-agent]").forEach((e) => e.removeAttribute("data-agent"));
    const lines = [];
    let n = 0;
    for (const el of document.querySelectorAll(SEL)) {
      const r = el.getBoundingClientRect(), st = getComputedStyle(el);
      const tag = el.tagName.toLowerCase(), type = (el.getAttribute("type") ?? "").toLowerCase();
      const toggle = tag === "input" && (type === "checkbox" || type === "radio");
      if (r.width < 2 || r.height < 2 || st.visibility === "hidden" || st.display === "none" || (st.opacity === "0" && !toggle)) continue;
      const role = el.getAttribute("role") ?? (tag === "a" ? "link" : tag === "button" || tag === "summary" ? "button" :
        tag === "select" ? "select" : tag === "textarea" || el.isContentEditable ? "textbox" :
        tag === "input" ? (["submit", "button", "reset", "image"].includes(type) ? "button" : toggle ? type : "textbox") : tag);
      let name = el.getAttribute("aria-label") ?? "";
      if (!name && el.labels?.[0]) name = el.labels[0].innerText;
      if (!name && toggle) name = el.closest("label")?.innerText ?? ""; // <label><input> Option1</label>
      if (!name && !["textbox", "select"].includes(role)) name = el.innerText;
      if (!name) name = el.getAttribute("title") ?? el.getAttribute("alt") ?? el.getAttribute("name") ?? el.getAttribute("value") ?? el.id ?? "";
      const extra = [el.getAttribute("placeholder") ? `placeholder "${clean(el.getAttribute("placeholder"))}"` : "",
        toggle && el.checked ? "checked" : "", el.disabled ? "disabled" : "",
        r.bottom < 0 || r.top > innerHeight ? "off-screen" : ""].filter(Boolean).join(", ");
      const line = `${role} "${clean(name)}"${extra ? ` (${extra})` : ""}`;
      if (filter && !line.toLowerCase().includes(filter.toLowerCase())) continue;
      const id = `e${++n}`;
      el.setAttribute("data-agent", id);
      lines.push(`${id} ${line}`);
      if (n >= 150) break;
    }
    return lines;
  }, filter);
}

function target(p: Page, t: string): Locator {
  return /^e\d+$/.test(t) ? p.locator(`[data-agent="${t}"]`).first() : p.getByText(t, { exact: false }).first();
}

// The whole page as text, one line per element that matters (landmarks, headings, text, links, buttons, boxes),
// indented like the page's structure, with the same eN ids elements gives, so Copilot can see where a control sits
// and what is around it when the controls list alone is not enough. Saved in the workspace (pages/<name>.txt): long
// pages are read in parts with read_file or searched with search_files.
async function domText(p: Page): Promise<{ text: string; controls: number }> {
  await listControls(p, ""); // tags the controls with data-agent ids first
  return p.evaluate(() => {
    const INTERACTIVE = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable=true],[onclick]';
    const LANDMARK: Record<string, string> = { nav: "nav", main: "main", header: "header", footer: "footer", form: "form", aside: "aside", section: "section", article: "article", dialog: "dialog", table: "table", ul: "list", ol: "list", li: "item", tr: "row", th: "cell", td: "cell" };
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    const lines: string[] = [];
    let controls = 0;
    const visible = (el: Element) => {
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 || r.height > 0 || el.childElementCount > 0;
    };
    const walk = (el: Element, depth: number) => {
      if (lines.length > 4000) return;
      const tag = el.tagName.toLowerCase();
      if (["script", "style", "noscript", "svg", "template", "head"].includes(tag) || !visible(el)) return;
      const pad = "  ".repeat(Math.min(depth, 12));
      const id = el.getAttribute("data-agent");
      const role = el.getAttribute("role");
      const r = el.getBoundingClientRect();
      const off = r.bottom < 0 || r.top > innerHeight ? " (off-screen)" : "";
      let line = "";
      if (el.matches(INTERACTIVE)) {
        controls++;
        const kind = role ?? (tag === "a" ? "link" : tag === "button" || tag === "summary" ? "button" : tag === "select" ? "select" : tag === "input" ? (el.getAttribute("type") || "text") : tag);
        const name = clean(el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("value") || el.getAttribute("name") || el.id).slice(0, 80);
        const href = tag === "a" ? ` → ${(el as HTMLAnchorElement).getAttribute("href")?.slice(0, 100) ?? ""}` : "";
        const state = (el as HTMLInputElement).checked ? " [checked]" : (el as HTMLInputElement).disabled ? " [disabled]" : "";
        line = `${pad}${kind} "${name}"${id ? ` [${id}]` : ""}${href}${state}${off}`;
      } else if (/^h[1-6]$/.test(tag)) {
        line = `${pad}${tag} "${clean((el as HTMLElement).innerText).slice(0, 120)}"${off}`;
      } else if (tag === "img") {
        const alt = clean(el.getAttribute("alt") || el.getAttribute("title"));
        if (alt) line = `${pad}img "${alt.slice(0, 80)}"`;
      } else if (LANDMARK[tag] || (role && ["dialog", "alertdialog", "navigation", "main", "region", "tablist", "menu", "list", "listitem", "row", "cell", "grid", "table", "alert", "status"].includes(role))) {
        const label = clean(el.getAttribute("aria-label") || el.getAttribute("title") || el.id);
        line = `${pad}[${role ?? LANDMARK[tag]}${label ? ` "${label.slice(0, 60)}"` : ""}]${off}`;
      } else {
        // the element's own text (not its children's), so each piece of text appears once, where it is
        const own = clean([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" "));
        if (own) line = `${pad}"${own.slice(0, 160)}"${off}`;
      }
      if (line) lines.push(line);
      if (el.matches(INTERACTIVE) && tag !== "form") return; // a control's insides are its label
      for (const c of el.children) walk(c, line ? depth + 1 : depth);
    };
    walk(document.body, 0);
    return { text: lines.join("\n"), controls };
  });
}

// A click that gets through: a normal click, then (something over the element, or it is not where the browser
// thinks) a forced click, then the element's own click handler. Says which one it took.
async function robustClick(loc: Locator): Promise<string> {
  if (await loc.click({ timeout: 8000 }).then(() => true, () => false)) return "";
  await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  if (await loc.click({ force: true, timeout: 3000 }).then(() => true, () => false)) return "needed a forced click: something was over it or it was not visible";
  if (await loc.dispatchEvent("click", undefined, { timeout: 3000 }).then(() => true, () => false)) return "the normal click did not land, its click event was sent directly: check the page state";
  throw new Error("could not click it: not visible, covered, or gone. Run elements or dom again and pick the right control, scroll to it first, or close what covers it");
}

// The browser window maximized (and restored first if minimized), so a red box placed now stays where it belongs
async function maximize(p: Page) {
  try {
    const cdp = await p.context().newCDPSession(p);
    const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget");
    if (bounds.windowState === "minimized") await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    if (bounds.windowState !== "maximized") await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "maximized" } });
    await cdp.detach();
    await p.waitForTimeout(300);
  } catch { /* the snap still works, the box may just sit off if the window changes size */ }
}

// Saves an evidence screenshot in workspace/screenshots and returns "<path>" plus what was boxed. By default a
// full-screen snap like a tester's: this browser window in front, maximized, the taskbar included; page_only: just
// the page. `highlight`: a red box around that control; `texts`: red boxes around those texts (found on the screen).
async function screenshot(p: Page, ctx: ToolContext, highlight: Locator | null, opts: { name?: string; pageOnly?: boolean; texts?: unknown[] } = {}): Promise<string> {
  const { full, rel } = nextScreenshot(ctx, opts.name);
  if (!opts.pageOnly) await maximize(p);
  let boxed = false;
  if (highlight) {
    await highlight.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    // a checkbox or radio is boxed together with its label ("☑ Option1"), as a tester would mark it
    const b = await highlight.evaluate((el: any) => {
      let r = el.getBoundingClientRect();
      const toggle = el.tagName === "INPUT" && /^(checkbox|radio)$/i.test(el.type);
      const label = toggle ? el.closest("label") ?? el.labels?.[0] : null;
      if (label) {
        const l = label.getBoundingClientRect();
        if (label.contains(el) || (Math.abs(l.top - r.top) < 30 && Math.abs(l.left - r.right) < 300)) {
          const x = Math.min(r.left, l.left), y = Math.min(r.top, l.top);
          r = { x, y, width: Math.max(r.right, l.right) - x, height: Math.max(r.bottom, l.bottom) - y };
        }
      }
      return r.width || r.height ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    }, null, { timeout: 3000 }).catch(() => null);
    if (b) {
      await p.evaluate((b) => {
        const d = document.createElement("div");
        d.id = "__agent_highlight";
        Object.assign(d.style, { position: "fixed", left: `${b.x - 5}px`, top: `${b.y - 5}px`, width: `${b.width + 10}px`,
          height: `${b.height + 10}px`, border: "3px solid red", borderRadius: "4px", zIndex: "2147483647", pointerEvents: "none" });
        document.body.appendChild(d);
      }, b);
      boxed = true;
    }
  }
  let note = "";
  try {
    if (opts.pageOnly) await p.screenshot({ path: full });
    else {
      const text = await screenDriver(ctx, { action: "snap", profile: profileDir(ctx), maximize: true, wait: 500, out: full, highlight: opts.texts ?? [] });
      note = text.split("\n").slice(1).join("\n"); // the red boxes around texts, if any
    }
  } finally {
    if (boxed) await p.evaluate(() => document.getElementById("__agent_highlight")?.remove()).catch(() => {});
  }
  const kind = opts.pageOnly ? "page only" : "full screen with the browser in front and the taskbar";
  return `${rel.replace(/\\/g, "/")} (${kind}${highlight ? (boxed ? ", red box around the control" : ", the control was not visible: no box") : ""})` +
    (note ? `\n${note}` : "");
}

async function settle(p: Page, urlBefore: string) {
  await p.waitForURL((u) => u.toString() !== urlBefore, { timeout: 2500, waitUntil: "commit" }).catch(() => {});
  await p.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
  await p.waitForTimeout(400);
}

const where = async (p: Page) => `"${await p.title().catch(() => "")}" ${p.url()}`;

// A sign-in page (by its address, its title, or a visible password box): Copilot must not go around it, and the
// agent never types passwords, so it gets told to ask you to sign in and wait.
async function signInNote(p: Page): Promise<string> {
  let u: URL | null = null;
  try { u = new URL(p.url()); } catch { /* about:blank and the like */ }
  const title = await p.title().catch(() => "");
  const byUrl = !!u && (/^(identity|login|signin|auth|accounts|sso)\./i.test(u.hostname) ||
    /(^|\/)(log-?in|sign-?in|signup|sign-?up|auth|oauth2?|sso)(\/|$|\?)/i.test(u.pathname));
  const byTitle = /\b(sign[ -]?in|log[ -]?in)\b/i.test(title);
  const password = await p.locator("input[type=password]:visible").count().catch(() => 0);
  if (!byUrl && !byTitle && !password) return "";
  return "\nSIGN-IN PAGE: this site wants me to sign in, and the agent never types passwords or codes. Use ask_user to ask " +
    "me to sign in in the browser window, wait for my answer, then check you are signed in (read or elements) and go on " +
    "with the task here. Don't skip this or switch to another app.";
}

// The control's state right after an action, so a click or typing can be checked: checked or not, the value now in
// a box, the option now selected. Empty when the control is gone (the page changed).
async function stateOf(loc: Locator): Promise<string> {
  return loc.evaluate((el: any) => {
    const tag = el.tagName.toLowerCase(), type = (el.getAttribute("type") ?? "").toLowerCase();
    if (tag === "input" && (type === "checkbox" || type === "radio")) return el.checked ? "now checked" : "now NOT checked";
    if (el.getAttribute("aria-checked") != null) return `aria-checked is now ${el.getAttribute("aria-checked")}`;
    if (tag === "select") return `selected now: "${el.selectedOptions?.[0]?.text?.trim() ?? ""}"`;
    if (tag === "input" || tag === "textarea") return type === "password" ? "" : `value now: "${String(el.value).slice(0, 120)}"`;
    if (el.isContentEditable) return `text now: "${String(el.innerText).trim().slice(0, 120)}"`;
    return "";
  }, null, { timeout: 1500 }).catch(() => "");
}

const tool: Tool = {
  name: "browser",
  description:
    "Drive my Microsoft Edge in its own window (its own profile: sites I signed in to there stay signed in). Actions: " +
    "open {url, new_tab?: true} (new_tab keeps the current page in its tab) · tabs lists the tabs, tabs {index} switches " +
    "to one · elements {filter?} lists the page's controls as e1, e2 ... · dom {name?} saves the WHOLE page as text " +
    "(structure, headings, texts, every control with its eN id) in pages/<name>.txt and returns its start: use it when " +
    "elements is not enough to know what to click or to check what the page shows; read the rest with read_file or " +
    "search_files · click {target: \"e5\", evidence?: true} (a covered control gets a forced click; the result says so) · " +
    "type {target, text, enter?: true, evidence?: true} · select {target, option} · screenshot {target?, highlight?: " +
    "[texts], name?, page_only?: true} · read {chars?} page text · back · close. Run elements again after the page " +
    "changes. Evidence and screenshots are full-screen snaps for manual-testing reports: the browser window brought " +
    "to the front and maximized, the taskbar included, a red box around the target (and around each highlight text), " +
    "saved in the workspace (screenshots/...). evidence is taken right after the action (the checkbox shows checked); " +
    "evidence: \"before\" takes it before. page_only: just the page, no taskbar. Results tell the control's state " +
    "after an action (now checked, the value now in a box) and when a page is a SIGN-IN PAGE: then use ask_user so I " +
    "sign in myself (it never types passwords).",
  args: '{"action": "click", "target": "e5", "evidence": true}',
  approvalHint: "opening a new site asks first; clicks and typing run on their own",
  needsApproval: (args) => args.action === "open",
  alwaysRule: (args) => {
    let host = String(args.url ?? "");
    try { host = new URL(/^https?:\/\//.test(host) ? host : `https://${host}`).host; } catch { /* keep as given */ }
    return { key: host, label: `opening pages on ${host}` };
  },
  run: async (args, ctx) => {
    const action = String(args.action ?? "");
    if (action === "close") {
      await context?.close();
      closedByUser = false;
      return "browser closed";
    }
    // the window was closed (by you) since the last step: say so, since its pages are gone
    const reopened = closedByUser && !context;
    closedByUser = false;
    const result = await act(action, args, ctx);
    return reopened
      ? `(the browser window had been closed, so a new one was opened${action === "open" ? "" : ": its earlier pages are gone, open the page again"})\n${result}`
      : result;
  },
};

async function act(action: string, args: Record<string, any>, ctx: ToolContext): Promise<string> {
  let p = await getPage(ctx);
  switch (action) {
    case "open": {
      const url = String(args.url ?? args.target ?? "");
      if (args.new_tab && p.url() !== "about:blank") {
        p = await p.context().newPage();
        page = p;
        await p.bringToFront();
      }
      await p.goto(/^https?:\/\//.test(url) ? url : `https://${url}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await p.waitForTimeout(800); // sites that send you to their sign-in page do it right after loading
      return `opened ${await where(p)}${await signInNote(p)}`;
    }
    case "tabs": {
      const all = p.context().pages().filter((x) => !x.isClosed());
      if (args.index != null) {
        const t = all[Number(args.index) - 1];
        if (!t) return `no tab ${args.index}; there are ${all.length}`;
        page = t;
        await t.bringToFront();
        return `switched to tab ${args.index}: ${await where(t)}`;
      }
      const lines = await Promise.all(all.map(async (t, i) => `${i + 1}${t === p ? " *" : ""} ${await where(t)}`));
      return `Tabs (* = the one in use; tabs {index} switches):\n${lines.join("\n")}`;
    }
    case "elements": {
      const lines = await listControls(p, String(args.filter ?? ""));
      return `${await where(p)}${await signInNote(p)}\n${lines.join("\n") || "(no matching controls)"}`;
    }
    case "dom": {
      const { text, controls } = await domText(p);
      const dir = path.join(ctx.workspace, "pages");
      mkdirSync(dir, { recursive: true });
      const name = (String(args.name ?? "").replace(/[^\w.-]+/g, "_") || `page-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`).replace(/\.txt$/i, "") + ".txt";
      const file = path.join(dir, name);
      writeFileSync(file, `${await where(p)}\n${text}\n`, "utf8");
      const lines = text.split("\n").length;
      const head = text.slice(0, 5000);
      return `${await where(p)}${await signInNote(p)}\nsaved pages/${name} (${lines} lines, ${controls} controls with eN ids; click/type/select take those ids)` +
        `\n${head}${text.length > head.length ? `\n…[${lines - head.split("\n").length} more lines: read_file pages/${name} with start_line, or search_files {"path": "pages", "text": "..."}]` : ""}`;
    }
    case "click":
    case "type":
    case "select": {
      if (!args.target) return 'give a target: an id from elements ("e5") or the visible text';
      const loc = target(p, String(args.target));
      if (!(await loc.count())) return `no element ${args.target} on the page: run elements (or dom for the whole page) again and use an id from it`;
      if (action === "type" && (await loc.getAttribute("type", { timeout: 1500 }).catch(() => ""))?.toLowerCase() === "password") {
        return "not typed: that is a password box. The user signs in themselves: use ask_user to ask them, then wait.";
      }
      const before = args.evidence === "before";
      const proofOpts = { pageOnly: !!args.page_only, name: args.name };
      let proof = before ? await screenshot(p, ctx, loc, proofOpts) : "";
      const urlBefore = p.url();
      let how = "";
      if (action === "click") how = await robustClick(loc);
      else if (action === "select") await loc.selectOption({ label: String(args.option ?? args.text ?? "") }, { timeout: 8000 });
      else {
        await loc.fill(String(args.text ?? ""), { timeout: 8000 });
        if (args.enter) await loc.press("Enter");
      }
      await settle(p, urlBefore);
      const samePage = p.url() === urlBefore;
      const state = samePage ? await stateOf(loc) : "";
      // evidence after the action: the result on screen, with the box around the control while it is still there
      if (args.evidence && !before) {
        const still = samePage && (await loc.count().catch(() => 0)) ? loc : null;
        proof = await screenshot(p, ctx, still, proofOpts);
      }
      return `${action === "click" ? "clicked" : action === "select" ? "selected in" : "typed into"} ${args.target}` +
        `${state ? ` (${state})` : ""}${how ? ` (${how})` : ""} → ${await where(p)}` + (proof ? `\nevidence: ${proof}` : "") + (await signInNote(p));
    }
    case "screenshot": {
      const loc = args.target ? target(p, String(args.target)) : null;
      const texts = args.highlight == null ? [] : Array.isArray(args.highlight) ? args.highlight : [args.highlight];
      const shot = await screenshot(p, ctx, loc && (await loc.count()) ? loc : null, { name: args.name, pageOnly: !!args.page_only, texts });
      return `saved ${shot}\npage: ${await where(p)}`;
    }
    case "read": {
      const text = (await p.locator("body").innerText()).replace(/\n{3,}/g, "\n\n").trim();
      return `${await where(p)}${await signInNote(p)}\n${text.slice(0, Number(args.chars ?? 3000))}`;
    }
    case "back": {
      const urlBefore = p.url();
      await p.evaluate(() => history.back());
      await settle(p, urlBefore);
      return `back → ${await where(p)}${await signInNote(p)}`;
    }
    default:
      return `unknown action "${action}"; use open, tabs, elements, dom, click, type, select, screenshot, read, back or close`;
  }
}
export default tool;
