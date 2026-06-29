#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ensureGlobalConfig, ensureProjectConfig, loadProjectConfig } from "./config.js";
import { addDecision, importDecisionMarkdown } from "./decisions/store.js";
import { runDoctor } from "./doctor/service.js";
import { parseConversationFile } from "./ingest/conversation.js";
import { ingestGitRepository } from "./ingest/git.js";
import { auditMemoryQuality } from "./memory/quality.js";
import {
  getProjectSummaryStatus,
  initializeProjectSummary,
  readProjectBrief,
  refreshProjectSummary,
  refreshProjectSummaryIfDue,
  relativeSummaryPath,
  type ProjectSummaryGenerator,
  type ProjectSummaryOperationOptions
} from "./project-summary/service.js";
import { resolveProjectRoot } from "./project-root.js";
import { startServer as startProjectMemoryServer, type ProjectMemoryServerOptions } from "./server.js";
import { getClaudeSourceStatus, getCodexSourceStatus } from "./sources/codex.js";
import { openMemoryStore } from "./storage/store.js";
import { syncProjectMemory } from "./sync/service.js";
import type { DoctorCheckCategory, DoctorReport, DoctorStatus, EvidenceRef, SyncSourceName } from "./types.js";

type ServerStarter = (options: ProjectMemoryServerOptions) => Promise<unknown>;

export interface CliOptions {
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  signal?: AbortSignal | undefined;
  projectSummaryGenerator?: ProjectSummaryGenerator | undefined;
  now?: (() => Date) | undefined;
  env?: Partial<Pick<NodeJS.ProcessEnv, "CODE_BUTLER_PROJECT_ROOT">> | undefined;
  startServer?: ServerStarter | undefined;
  watchServiceHomeDir?: string | undefined;
  watchServicePlatform?: NodeJS.Platform | undefined;
  watchServiceLaunchctl?: boolean | undefined;
  cliPath?: string | undefined;
}

export async function runCli(args = process.argv.slice(2), options: CliOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const [command, ...rest] = args;
  const startServer = options.startServer ?? startProjectMemoryServer;

  try {
    if (!command || command === "help" || command === "--help" || command === "-h") {
      stdout(usage());
      return 0;
    }

    if (command === "init") {
      const store = openMemoryStore(cwd);
      store.init();
      try {
        const config = loadProjectConfig(cwd);
        const installed = await initializeProjectSummary(store, config, {
          ...projectSummaryOperationOptions(options),
          warn: stdout
        });
        stdout(`Initialized project memory at ${join(cwd, ".code-butler")}`);
        stdout(`Project summary ready at ${relativeSummaryPath(cwd, installed.summaryPath)}`);
        if (installed.backupFiles?.length) {
          stdout(`Backed up agent files: ${installed.backupFiles.map((file) => relativeSummaryPath(cwd, file)).join(", ")}`);
        }
        return 0;
      } finally {
        store.close();
      }
    }

    if (command === "config") {
      return runConfig(rest, cwd, stdout);
    }

    if (command === "ingest") {
      return runIngest(rest, cwd, stdout);
    }

    if (command === "decision") {
      return runDecision(rest, cwd, stdout);
    }

    if (command === "memory") {
      return runMemory(rest, cwd, stdout);
    }

    if (command === "doctor") {
      return runDoctorCli(rest, cwd, stdout, { now: options.now });
    }

    if (command === "sync") {
      return await runSync(rest, cwd, stdout);
    }

    if (command === "sources") {
      return await runSources(rest, cwd, stdout);
    }

    if (command === "watch") {
      return await runWatch(rest, cwd, stdout, {
        signal: options.signal,
        projectSummaryGenerator: options.projectSummaryGenerator,
        now: options.now,
        watchServiceHomeDir: options.watchServiceHomeDir,
        watchServicePlatform: options.watchServicePlatform,
        watchServiceLaunchctl: options.watchServiceLaunchctl,
        cliPath: options.cliPath
      });
    }

    if (command === "project-summary") {
      return await runProjectSummary(rest, cwd, stdout, {
        projectSummaryGenerator: options.projectSummaryGenerator,
        now: options.now
      });
    }

    if (command === "hooks") {
      return await runHooks(rest, cwd, stdout);
    }

    if (command === "mcp") {
      return await runMcp(rest, cwd, stderr, {
        env: options.env,
        startServer
      });
    }

    if (command === "serve") {
      await startServer({ rootDir: cwd });
      return 0;
    }

    stderr(`Unknown command: ${command}`);
    stderr(usage());
    return 1;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function isCliEntrypoint(importMetaUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argvPath);
  } catch {
    return importMetaUrl === pathToFileURL(argvPath).href;
  }
}

async function runMcp(
  args: string[],
  cwd: string,
  stderr: (line: string) => void,
  options: { env: Partial<Pick<NodeJS.ProcessEnv, "CODE_BUTLER_PROJECT_ROOT">> | undefined; startServer: ServerStarter }
): Promise<number> {
  const projectRoot = parseStringFlag(args, "--project-root");
  const initHere = args.includes("--init-here");
  const unknownFlag = args.find((arg) => arg.startsWith("--") && arg !== "--project-root" && arg !== "--init-here");
  if (unknownFlag) throw new Error(`Unknown mcp option: ${unknownFlag}`);

  const resolved = resolveProjectRoot({
    cwd,
    projectRoot,
    initHere,
    env: options.env
  });

  const configPath = join(resolved.rootDir, ".code-butler", "config.json");
  const databasePath = join(resolved.rootDir, ".code-butler", "memory.sqlite");
  const configCreated = !existsSync(configPath);
  const databaseCreated = !existsSync(databasePath);

  const store = openMemoryStore(resolved.rootDir);
  store.init();
  store.close();
  ensureProjectConfig(resolved.rootDir);

  stderr(`Starting Code Butler MCP for project ${resolved.rootDir}`);
  await options.startServer({
    rootDir: resolved.rootDir,
    startupMetadata: {
      configCreated,
      databaseCreated
    }
  });
  return 0;
}

async function runConfig(args: string[], cwd: string, stdout: (line: string) => void): Promise<number> {
  const [subcommand, nested] = args;
  if (subcommand === "init" && nested === undefined) {
    const configPath = ensureProjectConfig(cwd);
    stdout(`Initialized project config at ${configPath}`);
    return 0;
  }
  if (subcommand === "global" && nested === "init" && args.length === 2) {
    const configPath = ensureGlobalConfig();
    stdout(`Initialized global config at ${configPath}`);
    return 0;
  }
  throw new Error("Usage: code-butler config <init|global init>");
}

async function runIngest(args: string[], cwd: string, stdout: (line: string) => void): Promise<number> {
  const [kind, target, ...rest] = args;
  if (!kind || !target) {
    throw new Error("Usage: code-butler ingest <conversation|git> <path>");
  }

  const store = openMemoryStore(cwd);
  store.init();
  try {
    if (kind === "conversation") {
      const parsed = parseConversationFile(target);
      const importedCopy = join(store.paths.conversationsDir, basename(target));
      copyFileSync(target, importedCopy);
      const sourceId = store.addSourceWithChunks(parsed);
      stdout(`Imported conversation ${sourceId} from ${target}`);
      return 0;
    }

    if (kind === "git") {
      const maxCommits = parseNumberFlag(rest, "--max-commits") ?? 100;
      const result = ingestGitRepository(store, target, { maxCommits });
      stdout(`Imported ${result.importedCommits} git commits from ${target}`);
      return 0;
    }

    throw new Error(`Unsupported ingest type: ${kind}`);
  } finally {
    store.close();
  }
}

async function runDecision(args: string[], cwd: string, stdout: (line: string) => void): Promise<number> {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    throw new Error("Usage: code-butler decision <add|import> ...");
  }

  const store = openMemoryStore(cwd);
  store.init();
  try {
    if (subcommand === "import") {
      const [filePath] = rest;
      if (!filePath) throw new Error("Usage: code-butler decision import <markdown-file>");
      const decision = importDecisionMarkdown(store, filePath);
      stdout(`Imported decision ${decision.id}`);
      return 0;
    }

    if (subcommand === "add") {
      const topic = parseStringFlag(rest, "--topic");
      const decisionText = parseStringFlag(rest, "--decision");
      const reason = parseStringFlag(rest, "--reason");
      const status = parseStringFlag(rest, "--status") ?? "accepted";
      if (!topic || !decisionText || !reason) {
        throw new Error(
          "Usage: code-butler decision add --topic <topic> --decision <decision> --reason <reason> [--status <status>] [--evidence <type:id#locator>]"
        );
      }
      const decision = addDecision(store, {
        topic,
        decision: decisionText,
        reason,
        status,
        evidence: parseEvidenceFlags(rest)
      });
      stdout(`Added decision ${decision.id}`);
      return 0;
    }

    throw new Error(`Unsupported decision command: ${subcommand}`);
  } finally {
    store.close();
  }
}

async function runMemory(args: string[], cwd: string, stdout: (line: string) => void): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "audit") {
    throw new Error("Usage: code-butler memory audit [--fix] [--json]");
  }
  const fix = rest.includes("--fix");
  const json = rest.includes("--json");
  const unknownFlag = rest.find((arg) => arg.startsWith("--") && arg !== "--fix" && arg !== "--json");
  if (unknownFlag) throw new Error(`Unknown memory audit option: ${unknownFlag}`);

  const store = openMemoryStore(cwd);
  store.init();
  try {
    const result = auditMemoryQuality(store, { fix });
    if (json) {
      stdout(JSON.stringify(result, null, 2));
      return 0;
    }
    stdout("Memory Audit");
    stdout(`scanned=${result.scanned} active=${result.active} needs_review=${result.needsReview} quarantined=${result.quarantined} updated=${result.updated}`);
    for (const reason of result.topReasons) {
      stdout(`reason ${reason.reason}=${reason.count}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

function runDoctorCli(
  args: string[],
  cwd: string,
  stdout: (line: string) => void,
  options: Pick<CliOptions, "now"> = {}
): number {
  const json = args.includes("--json");
  const strict = args.includes("--strict");
  const unknownFlag = args.find((arg) => arg.startsWith("--") && arg !== "--json" && arg !== "--strict");
  if (unknownFlag) throw new Error(`Unknown doctor option: ${unknownFlag}\nUsage: code-butler doctor [--json] [--strict]`);

  const doctorOptions = options.now === undefined ? {} : { now: options.now };
  const report = runDoctor(cwd, doctorOptions);
  if (json) {
    stdout(JSON.stringify(report, null, 2));
  } else {
    printDoctorReport(report, stdout);
  }
  return report.status === "error" || (strict && report.status === "warning") ? 1 : 0;
}

async function runSync(args: string[], cwd: string, stdout: (line: string) => void): Promise<number> {
  const source = parseSyncSourceFlag(args);

  const store = openMemoryStore(cwd);
  store.init();
  try {
    const config = loadProjectConfig(cwd);
    const result = await syncProjectMemory(store, config, { source });
    stdout(
      `Synced project memory (git=${result.sources.git.imported}, codex=${result.sources.codex.imported}, claude=${result.sources.claude.imported}, promoted=${result.memories.promoted})`
    );
    return 0;
  } finally {
    store.close();
  }
}

async function runSources(args: string[], cwd: string, stdout: (line: string) => void): Promise<number> {
  const [subcommand] = args;
  if (subcommand !== "status") {
    throw new Error("Usage: code-butler sources status");
  }

  const store = openMemoryStore(cwd);
  store.init();
  try {
    const config = loadProjectConfig(cwd);
    const codex = getCodexSourceStatus(store, config.sources.codex, config.sources.git.repoPath);
    const claude = getClaudeSourceStatus(store, config.sources.claude, config.sources.git.repoPath);
    const conversationCount = countWhere(store, "sources", "type = 'conversation'");
    const chunkCount = countRows(store, "chunks");
    const promotedCount = countRows(store, "memories");
    const candidateCount = countRows(store, "memory_candidates");

    stdout("Source Status");
    stdout(`Project root: ${config.sources.git.repoPath}`);
    stdout(`Conversations in SQLite: ${conversationCount}`);
    stdout(`Chunks in SQLite: ${chunkCount}`);
    stdout(`Memories in SQLite: promoted=${promotedCount}, candidates=${candidateCount}`);
    stdout(formatConversationStatus(codex.source, codex.enabled, codex.projectOnly, codex.totals));
    for (const root of codex.roots) stdout(formatRootStatus(root));
    stdout(formatConversationStatus(claude.source, claude.enabled, claude.projectOnly, claude.totals));
    for (const root of claude.roots) stdout(formatRootStatus(root));
    return 0;
  } finally {
    store.close();
  }
}

async function runProjectSummary(
  args: string[],
  cwd: string,
  stdout: (line: string) => void,
  options: Pick<CliOptions, "projectSummaryGenerator" | "now"> = {}
): Promise<number> {
  const [subcommand, ...rest] = args;
  if (!subcommand || !["refresh", "status"].includes(subcommand)) {
    throw new Error("Usage: code-butler project-summary <refresh|status> [--force]");
  }

  if (subcommand === "status") {
    const statusOptions: { now?: () => Date } = {};
    if (options.now !== undefined) statusOptions.now = options.now;
    const store = openMemoryStore(cwd);
    store.init();
    try {
      const config = loadProjectConfig(cwd);
      const status = getProjectSummaryStatus(cwd, { ...statusOptions, store, config });
      stdout("Project Summary Status");
      stdout(`Project root: ${cwd}`);
      stdout(`summaryPath=${relativeSummaryPath(cwd, status.summaryPath)}`);
      stdout(`metaPath=${relativeSummaryPath(cwd, status.metaPath)}`);
      stdout(`exists=${status.exists}`);
      stdout(`due=${status.due} stale=${status.stale}`);
      stdout(`fingerprint=${status.fingerprint ?? "none"}`);
      if (status.currentFingerprint) stdout(`currentFingerprint=${status.currentFingerprint}`);
      stdout(`lastGeneratedAt=${status.lastGeneratedAt ?? "never"}`);
      stdout(`lastCheckedAt=${status.lastCheckedAt ?? "never"}`);
      if (status.provider) stdout(`provider=${status.provider}`);
      return 0;
    } finally {
      store.close();
    }
  }

  const store = openMemoryStore(cwd);
  store.init();
  try {
    const config = loadProjectConfig(cwd);
    const operationOptions = projectSummaryOperationOptions(options);
    const result = await refreshProjectSummary(store, config, {
      ...operationOptions,
      force: rest.includes("--force")
    });
    if (result.generated) {
      stdout(`Refreshed project summary at ${relativeSummaryPath(cwd, result.summaryPath)}`);
    } else {
      stdout(`Project summary unchanged at ${relativeSummaryPath(cwd, result.summaryPath)}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

async function runWatch(
  args: string[],
  cwd: string,
  stdout: (line: string) => void,
  options: Pick<
    CliOptions,
    "signal" | "projectSummaryGenerator" | "now" | "watchServiceHomeDir" | "watchServicePlatform" | "watchServiceLaunchctl" | "cliPath"
  > = {}
): Promise<number> {
  const [subcommand, ...subcommandRest] = args;
  if (subcommand === "install") return runWatchInstall(subcommandRest, cwd, stdout, options);
  if (subcommand === "uninstall") return runWatchUninstall(cwd, stdout, options);
  if (subcommand === "status") return runWatchStatus(cwd, stdout, options);

  const source = parseSyncSourceFlag(args);
  const intervalSeconds = parseNumberFlag(args, "--interval") ?? 30;
  const store = openMemoryStore(cwd);
  store.init();
  const config = loadProjectConfig(cwd);
  let running = false;
  const controller = options.signal ? undefined : new AbortController();
  const activeSignal = options.signal ?? controller!.signal;
  const handleProcessSignal = (): void => {
    controller?.abort();
  };
  if (!options.signal) {
    process.once("SIGINT", handleProcessSignal);
    process.once("SIGTERM", handleProcessSignal);
  }

  async function runOnce(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const result = await syncProjectMemory(store, config, { source });
      stdout(
        `Synced project memory at ${result.completedAt} (git=${result.sources.git.imported}, codex=${result.sources.codex.imported}, claude=${result.sources.claude.imported}, promoted=${result.memories.promoted})`
      );
      if (readProjectBrief(config.sources.git.repoPath).exists) {
        try {
          const summaryResult = await refreshProjectSummaryIfDue(store, config, {
            ...projectSummaryOperationOptions(options)
          });
          if (summaryResult.checked) {
            stdout(
              summaryResult.generated
                ? `Refreshed project summary at ${relativeSummaryPath(cwd, summaryResult.summaryPath)}`
                : `Checked project summary at ${relativeSummaryPath(cwd, summaryResult.summaryPath)}`
            );
          }
        } catch (error) {
          stdout(`Project summary refresh skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      running = false;
    }
  }

  const close = (): void => {
    store.close();
  };

  try {
    await runOnce();
    while (!activeSignal.aborted) {
      await waitForInterval(intervalSeconds * 1000, activeSignal);
      if (activeSignal.aborted) break;
      await runOnce();
    }
    return 0;
  } finally {
    if (!options.signal) {
      process.removeListener("SIGINT", handleProcessSignal);
      process.removeListener("SIGTERM", handleProcessSignal);
    }
    close();
  }
}

async function runWatchInstall(
  args: string[],
  cwd: string,
  stdout: (line: string) => void,
  options: Pick<CliOptions, "watchServiceHomeDir" | "watchServicePlatform" | "watchServiceLaunchctl" | "cliPath"> = {}
): Promise<number> {
  const platform = options.watchServicePlatform ?? process.platform;
  if (platform !== "darwin") throw new Error("code-butler watch install currently supports macOS launchd only.");
  const source = parseSyncSourceFlag(args);
  const intervalSeconds = parseNumberFlag(args, "--interval") ?? 30;
  const service = watchService(cwd, options);
  mkdirSync(join(cwd, ".code-butler", "logs"), { recursive: true });
  mkdirSync(join(service.homeDir, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(service.plistPath, watchPlist(cwd, service.label, intervalSeconds, source, options.cliPath));
  if (options.watchServiceLaunchctl !== false) {
    loadLaunchAgent(service.plistPath);
  }
  stdout(`Installed Code Butler watch service ${service.label}`);
  stdout(`plist=${service.plistPath}`);
  stdout(`logs=${join(cwd, ".code-butler", "logs")}`);
  return 0;
}

async function runWatchUninstall(
  cwd: string,
  stdout: (line: string) => void,
  options: Pick<CliOptions, "watchServiceHomeDir" | "watchServicePlatform" | "watchServiceLaunchctl"> = {}
): Promise<number> {
  const platform = options.watchServicePlatform ?? process.platform;
  if (platform !== "darwin") throw new Error("code-butler watch uninstall currently supports macOS launchd only.");
  const service = watchService(cwd, options);
  if (existsSync(service.plistPath) && options.watchServiceLaunchctl !== false) {
    unloadLaunchAgent(service.plistPath);
  }
  rmSync(service.plistPath, { force: true });
  stdout(`Uninstalled Code Butler watch service ${service.label}`);
  return 0;
}

async function runWatchStatus(
  cwd: string,
  stdout: (line: string) => void,
  options: Pick<CliOptions, "watchServiceHomeDir" | "watchServicePlatform"> = {}
): Promise<number> {
  const platform = options.watchServicePlatform ?? process.platform;
  if (platform !== "darwin") throw new Error("code-butler watch status currently supports macOS launchd only.");
  const service = watchService(cwd, options);
  stdout("Code Butler Watch Status");
  stdout(`label=${service.label}`);
  stdout(`plist=${service.plistPath}`);
  stdout(`installed=${existsSync(service.plistPath)}`);
  return 0;
}

function watchService(
  cwd: string,
  options: Pick<CliOptions, "watchServiceHomeDir"> = {}
): { homeDir: string; label: string; plistPath: string } {
  const homeDir = options.watchServiceHomeDir ?? homedir();
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const label = `com.codebutler.watch.${hash}`;
  return {
    homeDir,
    label,
    plistPath: join(homeDir, "Library", "LaunchAgents", `${label}.plist`)
  };
}

function watchPlist(cwd: string, label: string, intervalSeconds: number, source: SyncSourceName | "all", cliPath?: string): string {
  const cli = cliPath ?? process.argv[1] ?? join(cwd, "dist", "cli.js");
  const logsDir = join(cwd, ".code-butler", "logs");
  const args = [process.execPath, cli, "watch", "--interval", String(intervalSeconds), "--source", source];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...args.map((arg) => `    <string>${xmlEscape(arg)}</string>`),
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xmlEscape(cwd)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(join(logsDir, "watch.out.log"))}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(join(logsDir, "watch.err.log"))}</string>`,
    "</dict>",
    "</plist>"
  ].join("\n") + "\n";
}

function loadLaunchAgent(plistPath: string): void {
  const domain = `gui/${process.getuid?.() ?? ""}`;
  try {
    execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "ignore" });
  } catch {
    execFileSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
    execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "ignore" });
  }
}

function unloadLaunchAgent(plistPath: string): void {
  const domain = `gui/${process.getuid?.() ?? ""}`;
  try {
    execFileSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
  } catch {
    // Already unloaded.
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function projectSummaryOperationOptions(
  options: Pick<CliOptions, "projectSummaryGenerator" | "now">
): ProjectSummaryOperationOptions {
  const operationOptions: ProjectSummaryOperationOptions = {};
  if (options.projectSummaryGenerator !== undefined) operationOptions.generator = options.projectSummaryGenerator;
  if (options.now !== undefined) operationOptions.now = options.now;
  return operationOptions;
}

async function runHooks(args: string[], cwd: string, stdout: (line: string) => void): Promise<number> {
  const [subcommand] = args;
  if (subcommand !== "install") {
    throw new Error("Usage: code-butler hooks install");
  }

  const config = loadProjectConfig(cwd);
  const hooksDir = join(config.sources.git.repoPath, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "post-commit");
  const hookScript = [
    "#!/usr/bin/env bash",
    "# Purpose: keep Code Butler Git memory in sync after each local commit.",
    "# Usage: installed by `code-butler hooks install`; Git runs this automatically after `git commit`.",
    `"${process.execPath}" "${join(cwd, "dist", "cli.js")}" sync --source git >/dev/null 2>&1 || true`
  ].join("\n");
  writeFileSync(hookPath, `${hookScript}\n`);
  chmodSync(hookPath, 0o755);
  stdout(`Installed Git post-commit hook at ${hookPath}`);
  return 0;
}

function parseStringFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

function parseNumberFlag(args: string[], flag: string): number | undefined {
  const value = parseStringFlag(args, flag);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseSyncSourceFlag(args: string[]): SyncSourceName | "all" {
  const source = (parseStringFlag(args, "--source") ?? "all") as SyncSourceName | "all";
  const validSources = new Set(["git", "codex", "claude", "all"]);
  if (!validSources.has(source)) {
    throw new Error("--source must be one of git, codex, claude, all");
  }
  return source;
}

function waitForInterval(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function countRows(store: ReturnType<typeof openMemoryStore>, table: string): number {
  const row = store.db.prepare(`select count(*) as count from ${table}`).get() as { count: number };
  return row.count;
}

function countWhere(store: ReturnType<typeof openMemoryStore>, table: string, where: string): number {
  const row = store.db.prepare(`select count(*) as count from ${table} where ${where}`).get() as { count: number };
  return row.count;
}

function formatConversationStatus(
  source: string,
  enabled: boolean,
  projectOnly: boolean,
  totals: { found: number; indexed: number; pending: number; ignored: number; parseFailures: number }
): string {
  return `${source}: enabled=${enabled} projectOnly=${projectOnly} found=${totals.found} indexed=${totals.indexed} pending=${totals.pending} ignored=${totals.ignored} parseFailures=${totals.parseFailures}`;
}

function formatRootStatus(root: {
  root: string;
  exists: boolean;
  found: number;
  indexed: number;
  pending: number;
  ignored: number;
  parseFailures: number;
  latestLogAt?: string | undefined;
}): string {
  const latest = root.latestLogAt ? ` latest=${root.latestLogAt}` : "";
  return `  root=${root.root} exists=${root.exists} found=${root.found} indexed=${root.indexed} pending=${root.pending} ignored=${root.ignored} parseFailures=${root.parseFailures}${latest}`;
}

function printDoctorReport(report: DoctorReport, stdout: (line: string) => void): void {
  stdout("Code Butler Doctor");
  stdout(`Project: ${report.projectRoot}`);
  stdout(`Generated: ${report.generatedAt}`);
  stdout(`Overall: ${report.status}`);

  const categories: DoctorCheckCategory[] = ["project", "storage", "sources", "sync", "summary", "extractor", "memory"];
  for (const category of categories) {
    const checks = report.checks.filter((check) => check.category === category);
    if (checks.length === 0) continue;
    stdout("");
    stdout(category);
    for (const check of checks) {
      stdout(`  ${doctorMarker(check.status)} ${check.title}: ${check.detail}`);
    }
  }

  stdout("");
  stdout("Next actions:");
  if (report.nextActions.length === 0) {
    stdout("  none");
    return;
  }
  for (const [index, action] of report.nextActions.entries()) {
    stdout(`  ${index + 1}. [${action.priority}] ${action.command} - ${action.reason}`);
  }
}

function doctorMarker(status: DoctorStatus): string {
  if (status === "warning") return "[warn]";
  return `[${status}]`;
}

function parseEvidenceFlags(args: string[]): EvidenceRef[] {
  const evidence: EvidenceRef[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--evidence") continue;
    const value = args[index + 1];
    if (!value) throw new Error("--evidence requires a value");
    evidence.push(parseEvidence(value));
  }
  return evidence;
}

function parseEvidence(value: string): EvidenceRef {
  const match = value.match(/^(conversation|commit|decision):([^#]+)(?:#(.+))?$/);
  if (!match?.[1] || !match[2]) {
    throw new Error(`Invalid evidence ref: ${value}`);
  }
  const sourceType = match[1] as EvidenceRef["sourceType"];
  const sourceId = match[2];
  const locator = match[3];
  return locator ? { sourceType, sourceId, locator } : { sourceType, sourceId };
}

function usage(): string {
  return [
    "Usage:",
    "  code-butler init",
    "  code-butler config init",
    "  code-butler config global init",
    "  code-butler ingest conversation <file>",
    "  code-butler ingest git <repo> [--max-commits <n>]",
    "  code-butler decision add --topic <topic> --decision <decision> --reason <reason> [--status <status>] [--evidence <type:id#locator>]",
    "  code-butler decision import <markdown-file>",
    "  code-butler memory audit [--fix] [--json]",
    "  code-butler doctor [--json] [--strict]",
    "  code-butler sync [--source <git|codex|claude|all>]",
    "  code-butler sources status",
    "  code-butler watch [--interval <seconds>] [--source <git|codex|claude|all>]",
    "  code-butler watch install [--interval <seconds>] [--source <git|codex|claude|all>]",
    "  code-butler watch status",
    "  code-butler watch uninstall",
    "  code-butler project-summary refresh [--force]",
    "  code-butler project-summary status",
    "  code-butler hooks install",
    "  code-butler mcp [--project-root <path>] [--init-here]",
    "  code-butler serve"
  ].join("\n");
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  runCli().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
