import { commandEnv, runProcess, workingDir, type Tool } from "./_lib.ts";

// Programs installed while the server runs (install_package with winget) change the PATH in the registry only; read
// it again before each command so they can be used right away.
const FRESH_PATH =
  "$env:Path = $env:Path + ';' + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'); ";

// Sign-ins and prompts wait for someone to type or confirm, and this hidden shell has no one at the keyboard: the step
// would hang until its timeout. Signing in is the user's own step anyway, so these are not run at all.
const SIGN_IN = new RegExp(
  "\\b(gh\\s+auth\\s+(login|refresh)|(npm|pnpm|yarn)\\s+(login|adduser)|az\\s+login|docker\\s+login|postman\\s+login|" +
  "firebase\\s+login|vercel\\s+login|netlify\\s+login|heroku\\s+login|wrangler\\s+login|gcloud\\s+auth\\s+(application-default\\s+)?login|" +
  "aws\\s+(configure|sso\\s+login)|Connect-(AzAccount|MgGraph|ExchangeOnline|MicrosoftTeams|PnPOnline)|Get-Credential|Read-Host)\\b",
  "i",
);
const command = (args: Record<string, any>) => String(args.command ?? "").trim();

const tool: Tool = {
  name: "shell",
  description:
    "Run a PowerShell command and get its output (npm, npx, git, ...). Also the way to do what no other tool does: " +
    "write the command for it (windows, files, APIs, converters ...). cwd: the folder to run in (a repo under the " +
    "projects folders, or the workspace by default). Commands installed with install_package work here. Always " +
    "waits for the user's approval. Nobody can type into it: sign-ins (gh auth login, npm login, az login ...) and " +
    "commands that ask questions can't run here; ask me to run those in my own terminal, then check (gh auth status).",
  args: '{"command": "npm install -D @playwright/test", "cwd": "C:/devl/my-repo"}',
  needsApproval: (args) => !SIGN_IN.test(command(args)), // a sign-in is refused without running, so nothing to approve
  runsCode: true,
  alwaysRule: (args) => {
    return { key: `${String(args.cwd ?? "").toLowerCase()}|${command(args)}`, label: `the command: ${command(args)}${args.cwd ? ` (in ${args.cwd})` : ""}` };
  },
  run: async (args, ctx) => {
    const sign = SIGN_IN.exec(command(args));
    if (sign) {
      return `not run: "${sign[0]}" signs in or asks for input, and this hidden shell has no one to type or confirm, so it ` +
        "would only hang. Signing in is the user's own step: ask the user to run it in their own terminal and tell you when " +
        "it is done, then check (for GitHub: gh auth status).";
    }
    return runProcess("powershell", ["-NoProfile", "-Command", FRESH_PATH + command(args)], {
      cwd: workingDir(args.cwd, ctx), timeoutMs: 600_000, env: commandEnv(ctx),
    });
  },
};
export default tool;
