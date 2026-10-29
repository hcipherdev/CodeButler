import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, posix, win32 } from "node:path";

export type AiClient = "claude" | "codex";
export type AiClientState = "connected" | "custom" | "partial" | "outdated" | "missing" | "unknown";
export interface AiClientConnection {
  client: AiClient;
  label: string;
  cliFound: boolean;
  state: AiClientState;
  detail: string;
  /** Shell command a person can run themselves when the desktop cannot. */
  manualCommand: string;
  canConnect: boolean;
}
export interface AiClientStatus { launcherInstalled: boolean; clients: AiClientConnection[] }

type Run = (command: string, args: string[], options: { encoding: "utf8"; timeout: number; env: NodeJS.ProcessEnv; windowsHide: true; windowsVerbatimArguments?: boolean }) => Pick<SpawnSyncReturns<string>, "status" | "stdout">;
export interface AiClientOptions {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: Run;
  exists?: (path: string) => boolean;
  readText?: (path: string) => string | undefined;
  backup?: (path: string) => void;
  /** The selected project, so a project-scoped Claude Code entry counts for it. */
  root?: string;
}
interface Context { home: string; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; run: Run; exists: (path: string) => boolean; readText: (path: string) => string | undefined; backup: (path: string) => void; root?: string }
interface Launcher { command: string; args: string[] }
interface Entry { command?: string; args?: string[]; env?: Record<string, string> }

const SERVER = "code-butler";
const LABELS: Record<AiClient, string> = { claude: "Claude Code", codex: "Codex" };

function context(options: AiClientOptions): Context {
  return {
    home: options.home ?? homedir(), platform: options.platform ?? process.platform, env: options.env ?? process.env,
    run: options.run ?? ((command, args, spawnOptions) => spawnSync(command, args, spawnOptions)),
    exists: options.exists ?? existsSync,
    readText: options.readText ?? (path => { try { return readFileSync(path, "utf8"); } catch { return undefined; } }),
    backup: options.backup ?? (path => { const copy = `${path}.before-code-butler-${Date.now()}.bak`; copyFileSync(path, copy); chmodSync(copy, 0o600); }),
    ...(options.root ? { root: options.root } : {})
  };
}

const pathFor = (ctx: Context) => ctx.platform === "win32" ? win32 : posix;

/** Mirrors defaultLocalAppData() in runtime-installer.ts, which must not be imported into the request host. */
function dataRoot(ctx: Context): string {
  const path = pathFor(ctx);
  if (ctx.platform === "win32") return ctx.env.LOCALAPPDATA ?? path.join(ctx.home, "AppData", "Local");
  return ctx.env.XDG_DATA_HOME ?? path.join(ctx.home, ".local", "share");
}

/** The stable command the installer keeps current across releases. Windows uses Node directly: a .cmd needs a shell. */
export function stableLauncher(options: AiClientOptions = {}): Launcher {
  const ctx = context(options), path = pathFor(ctx), legacy = path.join(dataRoot(ctx), "CodeButler", "node24");
  if (ctx.platform === "win32") return { command: path.join(legacy, "node.exe"), args: [path.join(legacy, "node_modules", "code-butler", "dist", "cli.js"), "mcp"] };
  if (ctx.platform === "darwin" && ctx.exists("/usr/local/bin/code-butler")) return { command: "/usr/local/bin/code-butler", args: ["mcp"] };
  return { command: path.join(legacy, "code-butler"), args: ["mcp"] };
}

function launcherInstalled(ctx: Context, launcher: Launcher): boolean {
  return ctx.exists(launcher.command) && launcher.args.slice(0, -1).every(arg => ctx.exists(arg));
}

/** Any stable launcher an installer has written, including the ones older releases registered. */
function isStableEntry(entry: Entry, launcher: Launcher): boolean {
  const command = entry.command ?? "", args = entry.args ?? [];
  if (command === launcher.command && JSON.stringify(args) === JSON.stringify(launcher.args)) return true;
  if (JSON.stringify(args) !== '["mcp"]') return false;
  return command === "/usr/local/bin/code-butler" || /[\\/]CodeButler[\\/]node24[\\/]code-butler(\.cmd)?$/i.test(command);
}

function cliCandidates(ctx: Context, client: AiClient): string[] {
  const path = pathFor(ctx);
  if (ctx.platform === "win32") {
    const appData = ctx.env.APPDATA ?? path.join(ctx.home, "AppData", "Roaming");
    return client === "claude"
      ? [path.join(ctx.home, ".local", "bin", "claude.exe"), path.join(appData, "npm", "claude.cmd")]
      : [path.join(appData, "npm", "codex.cmd")];
  }
  return client === "claude"
    ? [path.join(ctx.home, ".claude", "local", "claude"), path.join(ctx.home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "claude"]
    : ["/Applications/Codex.app/Contents/Resources/codex", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      "/opt/homebrew/bin/codex", "/usr/local/bin/codex", path.join(ctx.home, ".local", "bin", "codex"), "codex"];
}

/** A GUI-launched app only gets launchd's minimal PATH; npm-installed CLIs also need `node` on it. */
function childEnv(ctx: Context, cli: string): NodeJS.ProcessEnv {
  const path = pathFor(ctx);
  const extra = ctx.platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", path.join(ctx.home, ".local", "bin")];
  const dirs = [...(path.isAbsolute(cli) ? [path.dirname(cli)] : []), ...extra, ...(ctx.env.PATH ?? "").split(ctx.platform === "win32" ? ";" : delimiter)];
  return { ...ctx.env, PATH: [...new Set(dirs.filter(Boolean))].join(ctx.platform === "win32" ? ";" : ":") };
}

function runCli(ctx: Context, cli: string, args: string[], timeout: number): Pick<SpawnSyncReturns<string>, "status" | "stdout"> {
  const options = { encoding: "utf8" as const, timeout, env: childEnv(ctx, cli), windowsHide: true as const };
  if (ctx.platform === "win32" && /\.cmd$/i.test(cli)) {
    // Node refuses to spawn .cmd files without a shell; quote every argument for cmd.exe ourselves.
    const line = [cli, ...args].map(part => `"${part}"`).join(" ");
    return ctx.run(ctx.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { ...options, windowsVerbatimArguments: true });
  }
  return ctx.run(cli, args, options);
}

function findCli(ctx: Context, client: AiClient): string | undefined {
  return cliCandidates(ctx, client).find(candidate =>
    (!pathFor(ctx).isAbsolute(candidate) || ctx.exists(candidate)) && runCli(ctx, candidate, ["--version"], 5_000).status === 0);
}

function quote(part: string): string { return /^[\w@%+=:,./\\-]+$/.test(part) ? part : `"${part}"`; }
function manualCommand(client: AiClient, launcher: Launcher): string {
  const target = [launcher.command, ...launcher.args].map(quote).join(" ");
  return client === "claude" ? `claude mcp add --scope user ${SERVER} -- ${target}` : `codex mcp add ${SERVER} -- ${target}`;
}

function claudeConfigPath(ctx: Context): string {
  return pathFor(ctx).join(ctx.env.CLAUDE_CONFIG_DIR ?? ctx.home, ".claude.json");
}

function readJson(ctx: Context, path: string): Record<string, unknown> | undefined | null {
  const text = ctx.readText(path);
  if (text === undefined) return undefined;
  try { const value = JSON.parse(text) as unknown; return value && typeof value === "object" ? value as Record<string, unknown> : null; }
  catch { return null; }
}

function serverEntry(container: unknown): Entry | undefined {
  const servers = (container as { mcpServers?: Record<string, Entry> } | undefined)?.mcpServers;
  const entry = servers && typeof servers === "object" ? servers[SERVER] : undefined;
  return entry && typeof entry === "object" ? entry : undefined;
}

function claudeStatus(ctx: Context, launcher: Launcher, installed: boolean): AiClientConnection {
  const cli = findCli(ctx, "claude");
  const base = { client: "claude" as const, label: LABELS.claude, cliFound: !!cli, manualCommand: manualCommand("claude", launcher), canConnect: !!cli && installed };
  const config = readJson(ctx, claudeConfigPath(ctx));
  if (config === null) return { ...base, state: "unknown", detail: "Claude Code settings could not be read." };
  const user = serverEntry(config);
  if (user) return isStableEntry(user, launcher)
    ? { ...base, state: "connected", detail: "Connected for all projects." }
    : { ...base, state: "custom", detail: "Connected with a custom command. Repair switches it to the installed Code Butler." };
  const projects = Object.values((config?.projects ?? {}) as Record<string, unknown>).filter(project => serverEntry(project)).length;
  const sharedHere = ctx.root ? serverEntry(readJson(ctx, pathFor(ctx).join(ctx.root, ".mcp.json")) ?? undefined) : undefined;
  if (projects || sharedHere) {
    const where = [projects ? `${projects} project${projects === 1 ? "" : "s"}` : "", sharedHere ? "this project's .mcp.json" : ""].filter(Boolean).join(" and ");
    return { ...base, state: "partial", detail: `Connected only in ${where}. Connect to make it available everywhere.` };
  }
  return { ...base, state: "missing", detail: cli || config ? "Not connected." : "Claude Code was not found on this computer." };
}

function codexEntry(ctx: Context, cli: string): (Entry & { enabled?: boolean; cwd?: string; type?: string }) | undefined {
  const result = runCli(ctx, cli, ["mcp", "get", SERVER, "--json"], 10_000);
  if (result.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { enabled?: boolean; transport?: { type?: string; command?: string; args?: string[]; env?: Record<string, string>; cwd?: string } };
    return { ...parsed.transport, ...(parsed.enabled === false ? { enabled: false } : {}) };
  } catch { return undefined; }
}

function codexConfigPath(ctx: Context): string {
  return pathFor(ctx).join(ctx.env.CODEX_HOME ?? pathFor(ctx).join(ctx.home, ".codex"), "config.toml");
}

function codexStatus(ctx: Context, launcher: Launcher, installed: boolean): AiClientConnection {
  const cli = findCli(ctx, "codex");
  const base = { client: "codex" as const, label: LABELS.codex, cliFound: !!cli, manualCommand: manualCommand("codex", launcher), canConnect: !!cli && installed };
  if (!cli) {
    const configured = /^\s*\[mcp_servers\.(?:"code-butler"|code-butler)\]/m.test(ctx.readText(codexConfigPath(ctx)) ?? "");
    return configured
      ? { ...base, state: "unknown", detail: "Configured in Codex settings, but the Codex CLI was not found to verify it." }
      : { ...base, state: "missing", detail: "Codex was not found on this computer." };
  }
  const entry = codexEntry(ctx, cli);
  if (!entry) return { ...base, state: "missing", detail: "Not connected." };
  if (entry.enabled === false) return { ...base, state: "outdated", detail: "Registered but disabled in Codex." };
  if (entry.type !== "stdio" || entry.cwd) return { ...base, state: "outdated", detail: "Registered with settings Code Butler does not use. Repair replaces them." };
  return isStableEntry(entry, launcher)
    ? { ...base, state: "connected", detail: "Connected for all projects." }
    : { ...base, state: "custom", detail: "Connected with a custom command. Repair switches it to the installed Code Butler." };
}

export function aiClientStatus(options: AiClientOptions = {}): AiClientStatus {
  const ctx = context(options), launcher = stableLauncher(options), installed = launcherInstalled(ctx, launcher);
  return { launcherInstalled: installed, clients: [claudeStatus(ctx, launcher, installed), codexStatus(ctx, launcher, installed)] };
}

/** Register the stable launcher for one client. Never echoes arguments or settings: they may hold credentials. */
export function connectAiClient(client: AiClient, options: AiClientOptions = {}): AiClientConnection {
  const ctx = context(options), launcher = stableLauncher(options);
  if (!launcherInstalled(ctx, launcher)) throw new Error("The Code Butler command is not installed yet. Reinstall the app, then try again.");
  const cli = findCli(ctx, client);
  if (!cli) throw new Error(`${LABELS[client]} was not found on this computer. Install it, or run the command shown in Code Butler yourself.`);
  const target = ["--", launcher.command, ...launcher.args];
  if (client === "codex") {
    const existing = codexEntry(ctx, cli);
    if (ctx.exists(codexConfigPath(ctx))) ctx.backup(codexConfigPath(ctx));
    const env = Object.entries(existing?.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    if (runCli(ctx, cli, ["mcp", "add", SERVER, ...env, ...target], 30_000).status !== 0)
      throw new Error("Codex registration failed; the previous Codex settings were backed up.");
  } else {
    const configPath = claudeConfigPath(ctx);
    const existing = serverEntry(readJson(ctx, configPath) ?? undefined);
    if (ctx.exists(configPath)) ctx.backup(configPath);
    if (existing) runCli(ctx, cli, ["mcp", "remove", SERVER, "--scope", "user"], 30_000);
    const env = Object.entries(existing?.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    if (runCli(ctx, cli, ["mcp", "add", "--scope", "user", SERVER, ...env, ...target], 30_000).status !== 0)
      throw new Error("Claude Code registration failed; the previous Claude Code settings were backed up.");
  }
  const status = aiClientStatus(options).clients.find(item => item.client === client)!;
  if (status.state !== "connected") throw new Error(`${LABELS[client]} did not report the new connection. Its settings were backed up; try again or run the command yourself.`);
  return status;
}

