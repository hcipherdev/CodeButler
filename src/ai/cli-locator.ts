import { readdirSync, statSync } from "node:fs";
import { posix, win32, delimiter } from "node:path";

export type AiClient = "claude" | "codex";
/** The machine facts CLI lookup depends on, injectable so tests never touch the real one. */
export interface CliMachine {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  listDirectories?: (root: string) => string[];
}

export const cliPath = (machine: Pick<CliMachine, "platform">) => machine.platform === "win32" ? win32 : posix;

export function windowsDirectories(machine: CliMachine, root: string): string[] {
  if (machine.listDirectories) return machine.listDirectories(root);
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(({ name }) => {
        let modified = 0;
        try { modified = statSync(win32.join(root, name), { throwIfNoEntry: false })?.mtimeMs ?? 0; }
        catch { /* An update can remove or replace a runtime during lookup. */ }
        return { name, modified };
      })
      .sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name))
      .map(entry => entry.name);
  } catch { return []; }
}

/** Where each client's installers put the CLI, most specific first; a bare name means "search PATH". */
export function cliCandidates(machine: CliMachine, client: AiClient): string[] {
  const path = cliPath(machine);
  if (machine.platform === "win32") {
    const appData = machine.env.APPDATA ?? path.join(machine.home, "AppData", "Roaming");
    const localAppData = machine.env.LOCALAPPDATA ?? path.join(machine.home, "AppData", "Local");
    if (client === "claude") {
      // Resolve PATH entries explicitly so a project's working directory is never searched.
      const pathCandidates = (machine.env.PATH ?? machine.env.Path ?? "").split(";").map(dir => dir.trim().replace(/^"|"$/g, ""))
        .filter(dir => path.isAbsolute(dir)).flatMap(dir => [path.join(dir, "claude.exe"), path.join(dir, "claude.cmd")]);
      const wingetUser = path.join(localAppData, "Microsoft", "WinGet", "Links", "claude.exe");
      const wingetMachine = path.join(machine.env.ProgramFiles ?? "C:\\Program Files", "WinGet", "Links", "claude.exe");
      return [...new Set([path.join(machine.home, ".local", "bin", "claude.exe"), path.join(appData, "npm", "claude.cmd"),
        ...pathCandidates, wingetUser, wingetMachine])];
    }
    // Codex Desktop can keep its CLI in a versioned per-user directory outside PATH.
    const runtimeRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
    const desktopCandidates = windowsDirectories(machine, runtimeRoot)
      .map(directory => path.join(runtimeRoot, directory, "codex.exe"));
    return [path.join(appData, "npm", "codex.cmd"), "codex.exe", "codex.cmd", ...desktopCandidates];
  }
  return client === "claude"
    ? [path.join(machine.home, ".claude", "local", "claude"), path.join(machine.home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "claude"]
    : ["/Applications/Codex.app/Contents/Resources/codex", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      "/opt/homebrew/bin/codex", "/usr/local/bin/codex", path.join(machine.home, ".local", "bin", "codex"), "codex"];
}

/** A GUI-launched app only gets launchd's minimal PATH; npm-installed CLIs also need `node` on it. */
export function cliChildEnv(machine: CliMachine, cli: string): NodeJS.ProcessEnv {
  const path = cliPath(machine);
  const extra = machine.platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", path.join(machine.home, ".local", "bin")];
  const inherited = machine.env.PATH ?? (machine.platform === "win32" ? machine.env.Path : undefined);
  const dirs = [...(path.isAbsolute(cli) ? [path.dirname(cli)] : []), ...extra, ...(inherited ?? "").split(machine.platform === "win32" ? ";" : delimiter)];
  return { ...machine.env, PATH: [...new Set(dirs.filter(Boolean))].join(machine.platform === "win32" ? ";" : ":") };
}

/** Node refuses to spawn .cmd files without a shell; quote every argument for cmd.exe ourselves. */
export function cliCommand(machine: CliMachine, cli: string, args: string[]): { command: string; args: string[]; windowsVerbatimArguments?: true } {
  if (machine.platform === "win32" && /\.cmd$/i.test(cli)) {
    const line = [cli, ...args].map(part => `"${part}"`).join(" ");
    return { command: machine.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
  }
  return { command: cli, args };
}
