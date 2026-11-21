import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import { cliCandidates, cliChildEnv, cliCommand, cliPath, windowsDirectories, type AiClient, type CliMachine } from "../ai/cli-locator.js";
import { globalConfigDir, loadGlobalAiSettings } from "../config.js";
import { probeMcpLauncher, type McpProbeResult } from "./mcp-probe.js";
import { missingCodexConfig, parseCodexConfig, writeCodexConfig } from "./codex-config.js";
import { backupClientConfig, readClientConfig, writeClientConfig } from "./client-config-write.js";
import { storeLauncher } from "../store-runtime.js";

export type { AiClient };
/** `failing` means registered, but the installed code-butler command does not start as an MCP server. */
export type AiClientState = "connected" | "configured" | "custom" | "partial" | "outdated" | "missing" | "unknown" | "failing";
export interface AiClientConnection {
  client: AiClient;
  label: string;
  cliFound: boolean;
  state: AiClientState;
  detail: string;
  /** Shell command a person can run themselves when the desktop cannot. */
  manualCommand: string;
  canConnect: boolean;
  connectTarget?: "claude-desktop";
  /** The person turned the entry off in the client; automatic setup leaves it alone. */
  disabled?: boolean;
}
export interface AiClientStatus { launcherInstalled: boolean; clients: AiClientConnection[]; serverCheck?: McpProbeResult }

type Run = (command: string, args: string[], options: { encoding: "utf8"; timeout: number; env: NodeJS.ProcessEnv; windowsHide: true; windowsVerbatimArguments?: boolean }) => Pick<SpawnSyncReturns<string>, "status" | "stdout">;
export interface AiClientOptions {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: Run;
  exists?: (path: string) => boolean;
  listDirectories?: CliMachine["listDirectories"];
  readText?: (path: string) => string | undefined;
  backup?: (path: string) => void;
  writeConfig?: (path: string, previous: string | undefined, next: string, backup: (path: string) => void) => void;
  /** The selected project, so a project-scoped Claude Code entry counts for it. */
  root?: string;
  probe?: (launcher: Launcher) => Promise<McpProbeResult>;
  /** Wait before the one retry of a failed start check. */
  probeRetryDelayMs?: number;
  /** Where automatic setup records the clients it already connected once. */
  autoConnectMarker?: string;
}
interface Context extends CliMachine { run: Run; exists: (path: string) => boolean; readText: (path: string) => string | undefined; backup: (path: string) => void; root?: string }
interface Launcher { command: string; args: string[] }
interface Entry { command?: string; args?: string[]; env?: Record<string, string> }

const SERVER = "code-butler";
const LABELS: Record<AiClient, string> = { claude: "Claude Code", codex: "Codex" };

function context(options: AiClientOptions): Context {
  return {
    home: options.home ?? homedir(), platform: options.platform ?? process.platform, env: options.env ?? process.env,
    run: options.run ?? ((command, args, spawnOptions) => spawnSync(command, args, spawnOptions)),
    exists: options.exists ?? existsSync,
    ...(options.listDirectories ? { listDirectories: options.listDirectories } : {}),
    readText: options.readText ?? (path => { try { return readFileSync(path, "utf8"); } catch { return undefined; } }),
    backup: options.backup ?? backupClientConfig,
    ...(options.root ? { root: options.root } : {})
  };
}

const pathFor = cliPath;

/** Mirrors defaultLocalAppData() in runtime-installer.ts, which must not be imported into the request host. */
function dataRoot(ctx: Context): string {
  const path = pathFor(ctx);
  if (ctx.platform === "win32") return ctx.env.LOCALAPPDATA ?? path.join(ctx.home, "AppData", "Local");
  return ctx.env.XDG_DATA_HOME ?? path.join(ctx.home, ".local", "share");
}

/** The stable command the installer keeps current across releases. Windows uses Node directly: a .cmd needs a shell. */
export function stableLauncher(options: AiClientOptions = {}): Launcher {
  const ctx = context(options), path = pathFor(ctx), legacy = path.join(dataRoot(ctx), "CodeButler", "node24");
  const store = storeLauncher(ctx.platform, ctx.env);
  if (store) return { command: store, args: ["mcp"] };
  if (ctx.platform === "win32") return { command: path.join(legacy, "node.exe"), args: [path.join(legacy, "node_modules", "code-butler", "dist", "cli.js"), "mcp"] };
  if (ctx.platform === "darwin" && ctx.exists("/usr/local/bin/code-butler")) return { command: "/usr/local/bin/code-butler", args: ["mcp"] };
  return { command: path.join(legacy, "code-butler"), args: ["mcp"] };
}

function launcherInstalled(ctx: Context, launcher: Launcher): boolean {
  // The native Store entry point confirms package identity. Its execution alias
  // can run even when Node cannot stat the AppExecLink (EACCES); MCP probing
  // below still checks whether the registered command actually starts.
  if (launcher.command === storeLauncher(ctx.platform, ctx.env)) return true;
  return ctx.exists(launcher.command) && launcher.args.slice(0, -1).every(arg => ctx.exists(arg));
}

/** Any stable launcher an installer has written, including the ones older releases registered. */
function isStableEntry(entry: Entry, launcher: Launcher): boolean {
  const command = entry.command ?? "", args = entry.args ?? [];
  if (command === launcher.command && JSON.stringify(args) === JSON.stringify(launcher.args)) return true;
  if (/[\\/]Microsoft[\\/]WindowsApps[\\/]code-butler\.exe$/i.test(launcher.command)) return false;
  if (JSON.stringify(args) !== '["mcp"]') return false;
  return command === "/usr/local/bin/code-butler" || /[\\/]CodeButler[\\/]node24[\\/]code-butler(\.cmd)?$/i.test(command);
}

function runCli(ctx: Context, cli: string, args: string[], timeout: number): Pick<SpawnSyncReturns<string>, "status" | "stdout"> {
  const command = cliCommand(ctx, cli, args);
  const options = { encoding: "utf8" as const, timeout, env: cliChildEnv(ctx, cli), windowsHide: true as const };
  return ctx.run(command.command, command.args, command.windowsVerbatimArguments ? { ...options, windowsVerbatimArguments: true } : options);
}

function findCli(ctx: Context, client: AiClient): string | undefined {
  const path = pathFor(ctx);
  const runs = (candidate: string) => runCli(ctx, candidate, ["--version"], 5_000).status === 0;
  const cli = cliCandidates(ctx, client).find(candidate => (!path.isAbsolute(candidate) || ctx.exists(candidate)) && runs(candidate));
  if (cli || client !== "claude") return cli;
  return configuredClaudePaths().find(candidate => path.isAbsolute(candidate) && ctx.exists(candidate) && runs(candidate));
}

function configuredClaudePaths(): string[] {
  try {
    const connections = Object.values(loadGlobalAiSettings()?.connections ?? {});
    return connections.flatMap(connection => connection.kind === "claude-code" && connection.cliPath?.trim() ? [connection.cliPath.trim()] : []);
  } catch { return []; }
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

const CLAUDE_DESKTOP_CONFIG = "claude_desktop_config.json";
const CLAUDE_DESKTOP_CONFIG_HINT = "In Claude Desktop, open Settings → Developer → Edit Config, then select Check again in Code Butler.";
const CLAUDE_DESKTOP_LABEL = "Claude Desktop";

function macClaudeDesktopConfig(ctx: Context): string {
  return pathFor(ctx).join(ctx.home, "Library", "Application Support", "Claude", CLAUDE_DESKTOP_CONFIG);
}

/** Installation evidence and a writable settings target are separate, especially for MSIX. */
function claudeDesktopTarget(ctx: Context): { path?: string } | undefined {
  const path = pathFor(ctx);
  if (ctx.platform === "darwin") {
    const folders = ["/Applications", path.join(ctx.home, "Applications")];
    return folders.some(folder => ctx.exists(path.join(folder, "Claude.app", "Contents", "MacOS", "Claude")))
      ? { path: macClaudeDesktopConfig(ctx) } : undefined;
  }
  if (ctx.platform !== "win32") return undefined;
  const powershell = path.join(ctx.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const query = "(Get-AppxPackage -Name Claude | Select-Object -ExpandProperty PackageFamilyName -Unique) -join [Environment]::NewLine";
  const result = ctx.run(powershell, ["-NoProfile", "-NonInteractive", "-Command", query],
    { encoding: "utf8", timeout: 5_000, env: ctx.env, windowsHide: true });
  if (result.status !== 0) return undefined;
  const families = result.stdout.trim().split(/\r?\n/).filter(name => /^Claude_[a-z0-9]+$/i.test(name));
  if (families.length === 0) return undefined;
  if (families.length !== 1) return {};
  const family = families[0]!;
  const local = dataRoot(ctx);
  const candidates = [
    path.join(local, "Packages", family, "LocalCache", "Roaming", "Claude", CLAUDE_DESKTOP_CONFIG),
    path.join(local, "Claude-Data", family, CLAUDE_DESKTOP_CONFIG)
  ].filter(ctx.exists);
  return candidates.length === 1 ? { path: candidates[0]! } : {};
}

function parseClaudeDesktopConfig(text: string | undefined): Record<string, unknown> & { mcpServers?: Record<string, unknown> } {
  try {
    const value = text === undefined ? {} : JSON.parse(text.replace(/^\uFEFF/, ""));
    const isObject = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
    if (!isObject(value) || (Object.hasOwn(value, "mcpServers") && !isObject(value.mcpServers))) throw new Error();
    return value;
  } catch {
    throw new Error("Claude Desktop settings are invalid or have an unsupported MCP layout. Review them in Claude Desktop before connecting.");
  }
}

function readClaudeDesktopTarget(ctx: Context, target: string): ReturnType<typeof parseClaudeDesktopConfig> | null {
  try {
    const text = ctx.readText(target);
    return text === undefined && ctx.exists(target) ? null : parseClaudeDesktopConfig(text);
  } catch { return null; }
}

function readClaudeDesktopConfig(ctx: Context): Record<string, unknown> | undefined | null {
  const path = pathFor(ctx);
  if (ctx.platform === "darwin") return readJson(ctx, macClaudeDesktopConfig(ctx));
  if (ctx.platform !== "win32") return undefined;
  const roaming = ctx.env.APPDATA ?? path.join(ctx.home, "AppData", "Roaming");
  // Windows MSIX can redirect Claude's roaming settings into the package's private cache.
  const packages = path.join(dataRoot(ctx), "Packages");
  const candidates = windowsDirectories(ctx, packages).filter(directory => /^Claude_[a-z0-9]+$/i.test(directory))
    .map(directory => path.join(packages, directory, "LocalCache", "Roaming", "Claude", CLAUDE_DESKTOP_CONFIG));
  candidates.push(path.join(roaming, "Claude", CLAUDE_DESKTOP_CONFIG));
  for (const candidate of candidates) {
    const config = readJson(ctx, candidate);
    if (config !== undefined) return config;
    if (ctx.exists(candidate)) return null;
  }
  return undefined;
}

function serverEntry(container: unknown): Entry | undefined {
  const servers = (container as { mcpServers?: Record<string, Entry> } | undefined)?.mcpServers;
  const entry = servers && typeof servers === "object" ? servers[SERVER] : undefined;
  return entry && typeof entry === "object" ? entry : undefined;
}

function claudeStatus(ctx: Context, launcher: Launcher, installed: boolean, resolvedTarget?: { path: string }): AiClientConnection {
  const cli = findCli(ctx, "claude");
  const base = { client: "claude" as const, label: LABELS.claude, cliFound: !!cli, manualCommand: manualCommand("claude", launcher), canConnect: !!cli && installed };
  const config = readJson(ctx, claudeConfigPath(ctx));
  const user = serverEntry(config);
  if (user) return isStableEntry(user, launcher)
    ? { ...base, state: "connected", detail: "Connected for all projects." }
    : { ...base, state: "custom", detail: "Connected with a custom command. Repair switches it to the installed Code Butler." };
  const target = cli ? undefined : resolvedTarget ?? claudeDesktopTarget(ctx);
  const desktopConfig = target ? (target.path ? readClaudeDesktopTarget(ctx, target.path) : undefined) : readClaudeDesktopConfig(ctx);
  const desktop = serverEntry(desktopConfig) as (Entry & { enabled?: boolean }) | undefined;
  if (desktop) {
    const readOnly = { ...base, label: CLAUDE_DESKTOP_LABEL, canConnect: false, manualCommand: "" };
    if (desktop.enabled === false) return { ...readOnly, state: "outdated", disabled: true, detail: "The Code Butler entry is disabled. Review it in Claude Desktop settings." };
    if (typeof desktop.command !== "string" || !desktop.command.trim() || (desktop.args !== undefined && (!Array.isArray(desktop.args) || desktop.args.some(arg => typeof arg !== "string"))))
      return { ...readOnly, state: "unknown", detail: "The Code Butler entry in Claude Desktop settings could not be verified." };
    return isStableEntry(desktop, launcher)
      ? { ...readOnly, state: "configured", detail: "Registered for local Claude Desktop sessions." }
      : { ...readOnly, state: "custom", detail: "Claude Desktop uses a custom Code Butler command. Review it in Claude Desktop settings." };
  }
  if (config === null) return { ...base, state: "unknown", detail: "Claude Code settings could not be read." };
  const projects = Object.values((config?.projects ?? {}) as Record<string, unknown>).filter(project => serverEntry(project)).length;
  const sharedHere = ctx.root ? serverEntry(readJson(ctx, pathFor(ctx).join(ctx.root, ".mcp.json")) ?? undefined) : undefined;
  if (projects || sharedHere) {
    const where = [projects ? `${projects} project${projects === 1 ? "" : "s"}` : "", sharedHere ? "this project's .mcp.json" : ""].filter(Boolean).join(" and ");
    return { ...base, state: "partial", detail: `Connected only in ${where}. Connect to make it available everywhere.` };
  }
  if (target) {
    const desktopBase = { ...base, label: CLAUDE_DESKTOP_LABEL, manualCommand: "", connectTarget: "claude-desktop" as const };
    if (!target.path) return { ...desktopBase, state: "unknown", detail: CLAUDE_DESKTOP_CONFIG_HINT };
    if (desktopConfig === null || Object.hasOwn((desktopConfig?.mcpServers ?? {}) as object, SERVER))
      return { ...desktopBase, state: "unknown", detail: "Review the existing settings in Claude Desktop before connecting." };
    return { ...desktopBase, state: "missing", canConnect: installed, detail: "Connect Code Butler for local sessions in Claude Desktop’s Code tab." };
  }
  if (desktopConfig === null && !cli)
    return { ...base, state: "unknown", manualCommand: "", detail: "Claude Desktop settings could not be read." };
  const missingCli = "Code Butler could not find the Claude Code CLI. For a custom install, set its full path in AI models.";
  return { ...base, state: "missing", detail: cli ? "Not connected." : installed ? missingCli + " If Claude works in your terminal, you can also run the command below." : missingCli };
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
  const base = { client: "codex" as const, label: LABELS.codex, cliFound: !!cli, manualCommand: manualCommand("codex", launcher), canConnect: installed };
  if (!cli) {
    try {
      const path = codexConfigPath(ctx), text = ctx.readText(path);
      if (text === undefined && ctx.exists(path)) throw new Error("Codex config.toml could not be read. Check file permissions, then try again.");
      const config = parseCodexConfig(text), entry = config.mcp_servers?.[SERVER];
      if (entry === undefined) return { ...base, state: "missing", detail: "No Codex CLI was found. Connect can add Code Butler to Codex settings directly." };
      const settings = entry as Entry & { enabled?: boolean; cwd?: string; url?: string; type?: string };
      if (!settings || typeof settings !== "object" || settings.enabled === false) return { ...base, state: "outdated", canConnect: false, ...(settings?.enabled === false ? { disabled: true } : {}), detail: "An existing Code Butler entry needs review in Codex settings. Direct setup leaves it unchanged." };
      return typeof settings.command === "string" && (settings.args === undefined || (Array.isArray(settings.args) && settings.args.every(arg => typeof arg === "string")))
        && (settings.enabled === undefined || settings.enabled === true) && (settings.type === undefined || settings.type === "stdio")
        && isStableEntry(settings, launcher) && !settings.cwd && !settings.url
        ? { ...base, canConnect: false, state: "configured", detail: "Configured for all projects. The Codex CLI is unavailable for verification." }
        : { ...base, canConnect: false, state: "unknown", detail: "A custom Code Butler entry exists. Review it in Codex settings; direct setup leaves it unchanged." };
    } catch (error) { return { ...base, canConnect: false, state: "unknown", detail: error instanceof Error ? error.message : "Codex settings could not be read." }; }
  }
  const entry = codexEntry(ctx, cli);
  if (!entry) return { ...base, state: "missing", detail: "Not connected." };
  if (entry.enabled === false) return { ...base, state: "outdated", disabled: true, detail: "Registered but disabled in Codex." };
  if (entry.type !== "stdio" || entry.cwd) return { ...base, state: "outdated", detail: "Registered with settings Code Butler does not use. Repair replaces them." };
  return isStableEntry(entry, launcher)
    ? { ...base, state: "connected", detail: "Connected for all projects." }
    : { ...base, state: "custom", detail: "Connected with a custom command. Repair switches it to the installed Code Butler." };
}

export function aiClientStatus(options: AiClientOptions = {}): AiClientStatus {
  const ctx = context(options), launcher = stableLauncher(options), installed = launcherInstalled(ctx, launcher);
  return { launcherInstalled: installed, clients: [claudeStatus(ctx, launcher, installed), codexStatus(ctx, launcher, installed)] };
}

/** Direct setup is an explicit desktop action. Automatic CLI setup never calls this. */
export function connectClaudeDesktop(options: AiClientOptions = {}): { changed: boolean } {
  const ctx = context(options), launcher = stableLauncher(options);
  if (!launcherInstalled(ctx, launcher)) throw new Error("The Code Butler command is not installed yet. Reinstall the app, then try again.");
  const target = claudeDesktopTarget(ctx)?.path;
  if (!target) throw new Error(CLAUDE_DESKTOP_CONFIG_HINT);
  let previous: string | undefined;
  try { previous = options.readText ? ctx.readText(target) : readClientConfig(target); }
  catch { throw new Error("Could not read Claude Desktop settings as a regular file. Review them in Claude Desktop before connecting."); }
  if (previous === undefined && (ctx.platform === "win32" || ctx.exists(target))) throw new Error(CLAUDE_DESKTOP_CONFIG_HINT);
  const config = parseClaudeDesktopConfig(previous);
  if (config.mcpServers && Object.hasOwn(config.mcpServers, SERVER)) {
    const entry = config.mcpServers[SERVER] as (Entry & { enabled?: boolean }) | undefined;
    if (entry && (entry.enabled === undefined || entry.enabled === true) && entry.command === launcher.command && JSON.stringify(entry.args) === JSON.stringify(launcher.args))
      return { changed: false };
    throw new Error("A Code Butler entry already exists. Review it in Claude Desktop settings.");
  }
  // Use the same eligibility check on a fresh snapshot, including CLI or project registrations.
  const status = claudeStatus(ctx, launcher, true, { path: target });
  if (status.connectTarget !== "claude-desktop" || !status.canConnect) throw new Error("Claude setup changed. Check again before connecting.");
  const eol = previous?.includes("\r\n") ? "\r\n" : "\n";
  const next = JSON.stringify({ ...config, mcpServers: { ...config.mcpServers, [SERVER]: launcher } }, null, 2).replace(/\n/g, eol) + eol;
  try { (options.writeConfig ?? writeClientConfig)(target, previous, next, ctx.backup); }
  catch (error) {
    if (error instanceof Error && /changed during setup|regular file/.test(error.message)) throw error;
    throw new Error("Could not save Claude Desktop settings. Check permissions and available disk space, then try Connect again.");
  }
  return { changed: true };
}

/** Register the stable launcher for one client. Never echoes arguments or settings: they may hold credentials. */
export function connectAiClient(client: AiClient, options: AiClientOptions = {}): AiClientConnection {
  const ctx = context(options), launcher = stableLauncher(options);
  if (!launcherInstalled(ctx, launcher)) throw new Error("The Code Butler command is not installed yet. Reinstall the app, then try again.");
  const cli = findCli(ctx, client);
  if (!cli && client === "codex") {
    const path = codexConfigPath(ctx), previous = ctx.readText(path);
    if (previous === undefined && ctx.exists(path)) throw new Error("Codex config.toml could not be read. Check file permissions, then try again.");
    const current = codexStatus(ctx, launcher, true);
    if (current.state === "configured") return current;
    const next = missingCodexConfig(previous, launcher);
    try { (options.writeConfig ?? writeCodexConfig)(path, previous, next, ctx.backup); }
    catch (error) {
      if (error instanceof Error && /changed during setup|regular file/.test(error.message)) throw error;
      throw new Error("Could not save Codex settings. Check permissions and available disk space, then try Connect again.");
    }
    const saved = codexStatus(ctx, launcher, true);
    if (saved.state !== "configured") throw new Error("Codex settings could not be verified after setup. Review the code-butler entry in Codex settings.");
    return saved;
  }
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


const linked = (client: AiClientConnection) => ["connected", "configured", "partial"].includes(client.state);

/** Registration status plus a real start of the stable launcher, which every registered client runs. */
export async function checkedAiClientStatus(options: AiClientOptions = {}): Promise<AiClientStatus> {
  const status = aiClientStatus(options);
  if (!status.launcherInstalled || !status.clients.some(linked)) return status;
  const probe = () => (options.probe ?? probeMcpLauncher)(stableLauncher(options));
  let serverCheck = await probe();
  if (!serverCheck.ok && serverCheck.reason !== "timeout") {
    // One retry: an update briefly swaps the runtime the launcher points to, and a
    // start during that window should not flag every registered client. A timeout
    // already waited long enough, so it is not repeated.
    await new Promise(resolve => setTimeout(resolve, options.probeRetryDelayMs ?? 2_000));
    serverCheck = await probe();
  }
  if (serverCheck.ok) {
    const clients = status.clients.map(client => client.client === "claude" && client.state === "configured"
      ? { ...client, state: "connected" as const, detail: `${client.detail} Code Butler started successfully.` }
      : client);
    return { ...status, serverCheck, clients };
  }
  return { ...status, serverCheck, clients: status.clients.map(client => linked(client)
    ? { ...client, state: "failing" as const, detail: `Registered, but Code Butler does not start: ${serverCheck.detail} ${serverCheck.fix}` }
    : client) };
}

export interface AutoConnectOutcome { client: AiClient; label: string; outcome: "connected" | "already" | "skipped" | "failed"; detail: string }

/**
 * Connect each installed client that does not use the stable launcher yet, once per client.
 * A client connected before is not connected again, so removing Code Butler from it sticks;
 * custom commands, unreadable settings and entries turned off in the client are left alone.
 */
export function autoConnectAiClients(options: AiClientOptions = {}, missingOnly = false): AutoConnectOutcome[] {
  const markerPath = options.autoConnectMarker ?? pathFor(context(options)).join(globalConfigDir(), "clients", "auto-connected.json");
  let marker: Record<string, string> = {};
  try { marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, string>; } catch { /* First run, or an unreadable marker: start fresh. */ }
  const before = JSON.stringify(marker);
  const status = aiClientStatus(options);
  const outcomes = status.clients.map((client): AutoConnectOutcome => {
    const base = { client: client.client, label: client.label };
    if (client.state === "connected" || client.state === "configured") {
      marker[client.client] ??= new Date().toISOString();
      return { ...base, outcome: "already", detail: client.detail };
    }
    if (!client.cliFound) return { ...base, outcome: "skipped", detail: client.detail };
    if (marker[client.client]) return { ...base, outcome: "skipped", detail: `Already set up once; connect ${client.label} from Code Butler to set it up again.` };
    if ((missingOnly && client.state !== "missing") || !["missing", "partial", "outdated"].includes(client.state) || client.disabled) return { ...base, outcome: "skipped", detail: client.detail };
    if (!status.launcherInstalled) return { ...base, outcome: "skipped", detail: "The code-butler command is not installed yet." };
    try {
      connectAiClient(client.client, options);
      marker[client.client] = new Date().toISOString();
      return { ...base, outcome: "connected", detail: `Restart ${client.label} to load Code Butler.` };
    } catch (error) {
      return { ...base, outcome: "failed", detail: error instanceof Error ? error.message : `${client.label} could not be connected.` };
    }
  });
  if (JSON.stringify(marker) !== before) {
    mkdirSync(pathFor(context(options)).dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  }
  return outcomes;
}
