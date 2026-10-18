// Template for a new tool. Copy this file to tools/<name>.ts (no leading "_"), fill it in and restart the server.
// The page lists every tool in tools/; tick it to give it to Copilot in a chat.
import { runProcess, type Tool } from "./_lib.ts";

const tool: Tool = {
  name: "my_tool", // what Copilot writes in {"tool": "my_tool", ...}
  description: "What it does and when to use it, in one or two lines.",
  args: '{"query": "example value"}', // an example of the args object Copilot should send
  // true = the page shows Run/Skip before it runs. Keep it true for anything that changes files, accounts or data.
  needsApproval: () => true,
  // optional: what "Always allow" remembers for a call (same key = no question next time). Default: the exact args.
  alwaysRule: (args) => ({ key: String(args.query ?? ""), label: `searching for ${args.query}` }),
  run: async (args, ctx) => {
    // return the text Copilot should see; long output is cut to maxResult characters
    return runProcess("some-cli", ["search", String(args.query ?? "")], { cwd: ctx.workspace });
  },
};
export default tool;
