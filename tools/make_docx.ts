import { existsSync } from "node:fs";
import path from "node:path";
import { runProcess, type Tool } from "./_lib.ts";

const tool: Tool = {
  name: "make_docx",
  description:
    "Create a Word document in the workspace. blocks: {heading, level} · {text} · {bullets: [...]} · {numbered: [...]} · " +
    "{image: \"screenshots/step-01.png\", width: 6, caption} · {table: [[header...], [row...]]} · {page_break: true}.",
  args: '{"path": "report.docx", "title": "Test report", "blocks": [{"heading": "Step 1", "level": 1}, {"text": "Clicked Login"}, {"image": "screenshots/step-01.png"}]}',
  needsApproval: () => false, // writes only inside the workspace
  run: async (args, ctx) => {
    if (!existsSync(ctx.python)) return "the Python tools are not installed: ask the user to run setup.ps1";
    return runProcess(ctx.python, [path.join(ctx.root, "tools", "py", "make_docx.py"), ctx.workspace], {
      cwd: ctx.workspace, input: JSON.stringify(args), timeoutMs: 60_000,
    });
  },
};
export default tool;
