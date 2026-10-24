// GitHub CLI (gh) for looking things up in any repo. Read-only commands run on their own; anything that could
// change something on GitHub (create, edit, merge, delete, POST api calls, ...) waits for the user's approval.
import { commandEnv, runProcess, type Tool } from "./_lib.ts";

// "<command> <subcommand>" pairs that only read
const READ_ONLY = new Set([
  "repo view", "repo list",
  "search repos", "search code", "search issues", "search prs", "search commits",
  "issue list", "issue view", "pr list", "pr view", "pr diff", "pr checks",
  "release list", "release view", "run list", "run view", "workflow list", "workflow view",
  "label list", "gist list", "gist view",
]);

// gh api is read-only only as a plain GET to a GitHub path
function isReadOnlyApi(argv: string[]): boolean {
  const endpoint = argv.slice(1).find((a) => !a.startsWith("-"));
  if (!endpoint || endpoint.includes("://")) return false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (/^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a)) return false; // these turn the call into a POST
    if (/^(-X|--method)$/.test(a) && argv[i + 1]?.toUpperCase() !== "GET") return false;
    if (/^--method=/.test(a) && a.slice(9).toUpperCase() !== "GET") return false;
  }
  return true;
}

function argvOf(args: Record<string, any>): string[] {
  const a = args.args;
  if (Array.isArray(a)) return a.map(String);
  if (typeof a === "string") return a.match(/"[^"]*"|\S+/g)?.map((s) => s.replace(/^"|"$/g, "")) ?? [];
  return [];
}

const tool: Tool = {
  name: "github",
  processOutput: true,
  description:
    "Run the GitHub CLI (gh) to get references from any GitHub repo. Pass the gh arguments as a list. " +
    'Examples: ["repo","view","cli/cli"] · ["search","repos","playwright mcp","--limit","5"] · ' +
    '["api","repos/OWNER/REPO/contents/PATH","-H","Accept: application/vnd.github.raw"] for a file\'s text · ' +
    '["api","repos/OWNER/REPO/git/trees/HEAD?recursive=1","--jq",".tree[].path"] for the file list.',
  args: '{"args": ["repo", "view", "microsoft/playwright"]}',
  approvalHint: "lookups run on their own; changes ask first",
  alwaysRule: (args) => {
    const argv = argvOf(args);
    return { key: JSON.stringify(argv), label: `gh ${argv.join(" ")}` };
  },
  needsApproval: (args) => {
    const argv = argvOf(args);
    if (argv[0] === "api") return !isReadOnlyApi(argv);
    if (argv[0] === "auth" && /^(login|refresh)$/.test(argv[1] ?? "")) return false; // refused without running
    if (argv[0] === "auth" && argv[1] === "status") return false; // only reads
    return !READ_ONLY.has(`${argv[0]} ${argv[1]}`);
  },
  run: async (args, ctx) => {
    const argv = argvOf(args);
    if (!argv.length) return 'give the gh arguments as a list, e.g. {"args": ["repo","view","cli/cli"]}';
    // a sign-in waits for someone to type or confirm in a browser; nobody can here, and it is the user's own step
    if (argv[0] === "auth" && /^(login|refresh)$/.test(argv[1] ?? "")) {
      return `not run: gh auth ${argv[1]} needs the user to sign in. Ask the user to run "gh auth ${argv[1]}" in their own ` +
        'terminal and tell you when it is done, then check with ["auth","status"].';
    }
    const out = await runProcess("gh", argv, { cwd: ctx.workspace, timeoutMs: 60_000, env: commandEnv(ctx) }); // finds a gh installed after the server started
    if (out.includes("[not found: gh]")) {
      return "GitHub CLI is not installed on this PC. Ask the user to run: winget install --id GitHub.cli, then gh auth login";
    }
    return out;
  },
};
export default tool;
