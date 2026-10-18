import { existsSync } from "node:fs";
import path from "node:path";
import { runProcess, type Tool } from "./_lib.ts";

const tool: Tool = {
  name: "make_pptx",
  description:
    "Create a PowerPoint deck (16:9) in the workspace. Optional title slide (title, subtitle), then slides: " +
    "{title, bullets: [...], image: \"screenshots/step-01.png\", notes}. Bullets + image = text left, picture right.",
  args: '{"path": "deck.pptx", "title": "Test run", "slides": [{"title": "Step 1", "bullets": ["Clicked Login"], "image": "screenshots/step-01.png"}]}',
  needsApproval: () => false, // writes only inside the workspace
  run: async (args, ctx) => {
    if (!existsSync(ctx.python)) return "the Python tools are not installed: ask the user to run setup.ps1";
    return runProcess(ctx.python, [path.join(ctx.root, "tools", "py", "make_pptx.py"), ctx.workspace], {
      cwd: ctx.workspace, input: JSON.stringify(args), timeoutMs: 60_000,
    });
  },
};
export default tool;
