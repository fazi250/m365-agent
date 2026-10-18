// Screen tool: evidence snaps of your desktop apps for manual testing, like a tester documenting by hand. It can
// start an installed app (after you allow it), brings the app's window to the front (restored or maximized) and saves
// a full-screen PNG at the screen's own resolution, taskbar included, in workspace/screenshots, ready for make_docx.
// It can draw red boxes around texts on the snap (found with Windows' OCR in the captured picture), read the text in
// a window, and put a text (a payload) on the clipboard for you to paste. You do the clicking and typing in the app;
// it never clicks or types in it.
import { nextScreenshot, screenDriver, type Tool } from "./_lib.ts";

const appName = (args: Record<string, any>) => String(args.app ?? args.window ?? "").trim();
const highlights = (args: Record<string, any>) => {
  const h = args.highlight ?? args.highlights;
  return h == null || h === "" ? [] : Array.isArray(h) ? h : [h];
};

const tool: Tool = {
  name: "screen",
  description:
    "My desktop apps (Postman, Excel ...) for manual testing with evidence, the way a tester documents by hand. " +
    "Actions: windows lists the open windows · open {app: \"Postman\", maximize?: true} starts an installed app by " +
    "its Start-menu name (I approve it) · snap {window?: \"Postman\", maximize?: true, name?, highlight?, ask?} brings " +
    "that window to the front and saves a full-screen PNG (taskbar included) in the workspace (screenshots/...). " +
    "highlight = texts visible in the app to mark with a RED BOX on the snap (a request name, the URL, the method, " +
    "payload lines, a status like \"201 Created\"): a text with several lines (a JSON payload) gets one box around " +
    "them; the RESULT says what was boxed and where, and when a text shows up in several places, {\"text\": ..., " +
    "\"pick\": n} boxes only place n · read {window} returns the text visible in that window with x,y positions (to " +
    "check a response or choose what to highlight; I approve it per app) · clipboard puts the text of the code block " +
    "after the JSON on my clipboard (a payload, a cURL command: pasting a cURL into Postman's URL box fills the " +
    "method, URL, headers and body). It cannot click or type in apps: a step I must do by hand goes in ask (\"Click " +
    "the URL box in Postman and press Ctrl+V\"); I do it and press Allow, then the snap is taken. Captions: say a box " +
    "marks something only when the RESULT says it was drawn, and write the hand steps as done by me, the user.",
  args: '{"action": "snap", "window": "Postman", "maximize": true, "highlight": ["Create User", {"text": "POST", "pick": 1}, "{\\n  \\"name\\": \\"Faizan\\"\\n}"], "ask": "Paste the payload into Body > raw with Ctrl+V"}',
  approvalHint: "opening an app or reading its text asks first; snaps run on their own, or wait for your step (ask)",
  // open / read: you allow each app; a snap with a step for you waits on the approval card: do the step, then Allow once
  needsApproval: (args) =>
    args.action === "open" || args.action === "read" || (args.action === "snap" && !!String(args.ask ?? "").trim()),
  alwaysRule: (args) =>
    args.action === "open"
      ? { key: `open:${appName(args).toLowerCase()}`, label: `opening the app ${appName(args)}` }
      : args.action === "read"
        ? { key: `read:${appName(args).toLowerCase()}`, label: `reading the text in ${appName(args)} windows` }
        : { key: JSON.stringify(args), label: "this exact screen call" },
  warning: (args) =>
    args.action === "snap" && String(args.ask ?? "").trim()
      ? `YOU do this step yourself in the app (the agent can't click or type there): ${String(args.ask).trim()}. Then press Allow once to take the snap`
      : args.action === "read"
        ? `what is visible in the ${appName(args) || "?"} window goes into the Copilot chat as text`
        : null,
  blockArg: "text", // clipboard: the text comes in the code block after the JSON
  run: async (args, ctx) => {
    const action = String(args.action ?? "");
    if (!["windows", "open", "snap", "read", "clipboard"].includes(action)) return 'unknown action; use "windows", "open", "snap", "read" or "clipboard"';
    if (action === "open" && !appName(args)) return 'give the app: {"action": "open", "app": "Postman"}';
    if (action === "read" && !appName(args)) return 'give the window: {"action": "read", "window": "Postman"}';
    const shot = action === "snap" ? nextScreenshot(ctx, args.name) : null;
    const request = {
      action, app: appName(args), window: args.window ?? args.app ?? "", maximize: !!args.maximize, wait: args.wait,
      out: shot?.full, highlight: action === "snap" ? highlights(args) : undefined, text: action === "clipboard" ? String(args.text ?? "") : undefined,
    };
    let text: string;
    try { text = await screenDriver(ctx, request); } catch (e) { return `error: ${e instanceof Error ? e.message : e}`; }
    return shot ? `saved ${shot.rel}: ${text}` : text;
  },
};
export default tool;
