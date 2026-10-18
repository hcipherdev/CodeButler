#!/usr/bin/env node
import { runCloudCommand } from "./cloud/cli.js";
import { binding } from "./cloud/state.js";
import { secretBinding } from "./secrets/state.js";
import { encryptedSecretsSync } from "./secrets/sync.js";
import { localCloudChangeStamp, projectOperation, startCloudScheduler, syncQuietly } from "./cloud/client.js";
import { automaticSyncPending, requestLocalChangeSync } from "./cloud/sync-owner.js";
import { queueAutomaticConnection } from "./cloud/auto-connect.js";
import { errorOutcome, type OperationOutcome, type OperationStage } from "./cloud/outcome.js";
import { buildInfo, newRuntimeRecord, registerRuntime, runtimeDiagnostics } from "./runtime.js";
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ensureGlobalConfig, ensureProjectConfig, loadProjectConfig, migrateSharedConfigToLocal } from "./config.js";
import { runEmbeddingsCommand } from "./cli/commands/embeddings.js";
import { runMemoryCommand } from "./cli/commands/memory.js";
import { runPrivacyCommand } from "./cli/commands/privacy.js";
import { runSourcesCommand } from "./cli/commands/sources.js";
import { runExtractionCommand } from "./cli/commands/extraction.js";
import { addDecision, importDecisionMarkdown } from "./decisions/store.js";
import { runDoctor } from "./doctor/service.js";
import type { EmbeddingServiceOptions } from "./embeddings/service.js";
import { parseConversationFile } from "./ingest/conversation.js";
import { ingestGitRepository } from "./ingest/git.js";
import { auditMemoryConflicts } from "./memory/conflicts.js";
import { updateMemoryStatus } from "./memory/lifecycle-service.js";
import { auditMemoryQuality } from "./memory/quality.js";
import { rememberProjectMemory } from "./memory/remember.js";
import { inspectArtifactMaintenance, runArtifactMaintenance, type ArtifactMaintenanceResult } from "./maintenance/artifacts.js";
import {
  getProjectSummaryStatus,
  createFallbackProjectSummaryGenerator,
  readProjectBrief,
  refreshProjectSummary,
  refreshProjectSummaryIfDue,
  relativeSummaryPath,
  type ProjectSummaryGenerator,
  type ProjectSummaryOperationOptions
} from "./project-summary/service.js";
import { initializeProjectMemory } from "./project-initialization.js";
import { validateProjectSetupPaths } from "./project-setup.js";
import { resolveProjectRoot } from "./project-root.js";
import { globalWatchStatus, registerWatchedProject, runGlobalWatch, unregisterWatchedProject } from "./global-watch.js";
import { startServer as startProjectMemoryServer, type ProjectMemoryServerOptions } from "./server.js";
import { openConfiguredMemoryStore } from "./storage/open-configured-store.js";
import type { MemoryStore } from "./storage/store.js";
import { syncProjectMemory, syncWatchedProjectMemory } from "./sync/service.js";
import type { DoctorCheckCategory, DoctorReport, DoctorStatus, EvidenceRef, MemoryLifecycleStatus, MemoryType, SyncSourceName } from "./types.js";
import {
  getWatchServiceStatus,
  installWatchService,
  uninstallWatchService,
  type WatchServiceCommandRunner,
  type WatchServiceResult
} from "./watch-service.js";

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
  watchServiceCommandRunner?: WatchServiceCommandRunner | undefined;
  cliPath?: string | undefined;
  embeddingServiceOptions?: EmbeddingServiceOptions | undefined;
}

export async function runCli(args = process.argv.slice(2), options: CliOptions = {}): Promise<number> {
  const root = options.cwd ?? process.cwd();
  const command = args[0] ?? "help";
  try {
    const reconciliationMutation = command === "memory" && args[1] === "reconcile" &&
      (args[2] === "apply" || args[2] === "revert");
    if (binding(root)?.enabled && !reconciliationMutation && !["rules", "cloud", "watch", "mcp", "serve", "runtime", "--version", "help", "--help", "-h"].includes(command)) {
      return await projectOperation(root, () => runCliOperation(args, options), { name: command === "sync" ? "Memory sync" : "CLI project operation" });
    }
    return await runCliOperation(args, options);
  } catch (error) {
    (options.stderr ?? console.error)(error instanceof Error ? error.message : "Cloud coordination failed");
    return 1;
  }
}

async function runCliOperation(args: string[], options: CliOptions): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const [command, ...rest] = args;
  const startServer = options.startServer ?? startProjectMemoryServer;

  try {
    if (command === "--version") { stdout(JSON.stringify(buildInfo)); return 0; }
    if (command === "runtime") { stdout(JSON.stringify({ build: buildInfo, processes: runtimeDiagnostics() }, null, 2)); return 0; }
    if (!command || command === "help" || command === "--help" || command === "-h") {
      stdout(usage());
      return 0;
    }

    if (command === "rules") {
      const result = await (await import("./cli/commands/rules.js")).runRulesCommand(rest, cwd, stdout);
      if (result === 0 && rest[0] === "sync" && rest[1] === "enable") {
        const watchOptions = { ...watchServiceOptions(cwd, options), global: true };
        if (!getWatchServiceStatus(watchOptions).installed) installWatchService(watchOptions);
      }
      return result;
    }
    (await import("./rules/identity.js")).assertOrdinaryProject(cwd);
    if (command === "cloud") return await runCloudCommand(rest, cwd, stdout);

    if (command === "init") {
      const installed = await initializeProjectMemory(cwd, {
        ...projectSummaryOperationOptions(options),
        warn: stdout
      });
      stdout(`Initialized project memory at ${join(cwd, ".code-butler")}`);
      stdout(`Project summary ready at ${relativeSummaryPath(cwd, installed.summaryPath)}`);
      if (installed.backupFiles.length) {
        stdout(`Backed up agent files: ${installed.backupFiles.map((file) => relativeSummaryPath(cwd, file)).join(", ")}`);
      }
      try {
        const watcher = installWatchService(watchServiceOptions(cwd, options));
        stdout(`Background watcher installed: ${watcher.label}`);
        stdout(watchServiceLocationLine(watcher));
        stdout(`logs=${watcher.logsDir}`);
      } catch (error) {
        stdout(`Warning: Failed to install Code Butler background watcher: ${error instanceof Error ? error.message : String(error)}`);
        stdout("Code Butler is ready for manual and MCP use. Run `code-butler watch install` after fixing scheduler permissions, or keep `code-butler watch` running in a terminal.");
      }
      return 0;
    }

    if (command === "config") {
      return runConfig(rest, cwd, stdout);
    }

    if (command === "maintenance") {
      return runMaintenance(rest, cwd, stdout, { now: options.now });
    }

    if (command === "ingest") {
      return runIngest(rest, cwd, stdout);
    }

    if (command === "decision") {
      return runDecision(rest, cwd, stdout);
    }

    if (command === "memory") {
      return await runMemoryCommand(rest, cwd, stdout, { now: options.now });
    }

    if (command === "doctor") {
      return runDoctorCli(rest, cwd, stdout, { now: options.now });
    }

    if (command === "embeddings") {
      return await runEmbeddingsCommand(rest, cwd, stdout, options.embeddingServiceOptions);
    }

    if (command === "privacy") {
      return runPrivacyCommand(rest, cwd, stdout);
    }

    if (command === "sync") {
      return await runSync(rest, cwd, stdout);
    }

    if (command === "extraction") {
      return await runExtractionCommand(rest, cwd, stdout);
    }

    if (command === "sources") {
      return await runSourcesCommand(rest, cwd, stdout);
    }

    if (command === "watch") {
      return await runWatch(rest, cwd, stdout, {
        signal: options.signal,
        projectSummaryGenerator: options.projectSummaryGenerator,
        now: options.now,
        watchServiceHomeDir: options.watchServiceHomeDir,
        watchServicePlatform: options.watchServicePlatform,
        watchServiceLaunchctl: options.watchServiceLaunchctl,
        watchServiceCommandRunner: options.watchServiceCommandRunner,
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
  const unknownFlag = args.find((arg) => arg.startsWith("--") && arg !== "--project-root" && arg !== "--init-here" && arg !== "--no-auto-init");
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

  validateProjectSetupPaths(resolved.rootDir, false);
  await projectOperation(resolved.rootDir, () => {
    validateProjectSetupPaths(resolved.rootDir, false);
    const store = openConfiguredMemoryStore(resolved.rootDir);
    try { store.init(); } finally { store.close(); }
    ensureProjectConfig(resolved.rootDir);
  });

  stderr(`Starting Code Butler MCP for project ${resolved.rootDir}`);
  await options.startServer({
    rootDir: resolved.rootDir,
    autoInit: !args.includes("--no-auto-init"),
    startupMetadata: {
      configCreated,
      databaseCreated
    }
  });
  return 0;
}

async function runConfig(args: string[], cwd: string, stdout: (line: string) => void): Promise<number> {
  const [subcommand, nested, ...rest] = args;
  if (subcommand === "init" && nested === undefined) {
    ensureGlobalConfig();
    const configPath = ensureProjectConfig(cwd);
    stdout(`Initialized project config at ${configPath}`);
    return 0;
  }
  if (subcommand === "global" && nested === "init" && args.length === 2) {
    const configPath = ensureGlobalConfig();
    stdout(`Initialized global config at ${configPath}`);
    return 0;
  }
  if (subcommand === "migrate-local") {
    const json = args.includes("--json");
    const dryRun = args.includes("--dry-run");
    const apply = args.includes("--apply");
    const unknown = args.find((arg) => arg.startsWith("--") && arg !== "--json" && arg !== "--dry-run" && arg !== "--apply");
    if (unknown) throw new Error(`Unknown config migrate-local option: ${unknown}`);
    if (nested && !nested.startsWith("--")) throw new Error("Usage: code-butler config migrate-local [--dry-run|--apply] [--json]");
    if (rest.some((arg) => !arg.startsWith("--"))) throw new Error("Usage: code-butler config migrate-local [--dry-run|--apply] [--json]");
    if (dryRun === apply) throw new Error("Usage: code-butler config migrate-local [--dry-run|--apply] [--json]");
    const result = migrateSharedConfigToLocal(cwd, { apply });
    if (json) stdout(JSON.stringify(result, null, 2));
    else printConfigMigration(result, cwd, stdout);
    return 0;
  }
  throw new Error("Usage: code-butler config <init|global init|migrate-local>");
}

function printConfigMigration(
  result: ReturnType<typeof migrateSharedConfigToLocal>,
  cwd: string,
  stdout: (line: string) => void
): void {
  stdout(result.dryRun ? "Config local migration dry run" : "Config local migration applied");
  stdout(`shared=${relativeSummaryPath(cwd, result.sharedConfigPath)}`);
  stdout(`local=${relativeSummaryPath(cwd, result.localConfigPath)}`);
  stdout(`moved=${result.moved.length} unchanged=${result.unchanged.length} conflicts=${result.conflicts.length}`);
  for (const path of result.moved) stdout(`  move ${path}`);
  for (const path of result.unchanged) stdout(`  keep-local ${path}`);
  for (const path of result.conflicts) stdout(`  conflict ${path}`);
}

function runMaintenance(
  args: string[],
  cwd: string,
  stdout: (line: string) => void,
  options: Pick<CliOptions, "now"> = {}
): number {
  const [subcommand, ...rest] = args;
  if (!subcommand || !["status", "prune"].includes(subcommand)) {
    throw new Error("Usage: code-butler maintenance <status|prune> [--dry-run|--apply] [--json]");
  }
  const json = rest.includes("--json");
  const dryRun = rest.includes("--dry-run");
  const apply = rest.includes("--apply");
  const unknown = rest.find((arg) => arg !== "--json" && arg !== "--dry-run" && arg !== "--apply");
  if (unknown) throw new Error(`Unknown maintenance option: ${unknown}`);
  if (subcommand === "status" && (dryRun || apply)) throw new Error("Usage: code-butler maintenance status [--json]");
  if (subcommand === "prune" && dryRun === apply) throw new Error("Usage: code-butler maintenance prune <--dry-run|--apply> [--json]");
  const config = loadProjectConfig(cwd);
  const now = options.now?.() ?? new Date();
  const result = subcommand === "status"
    ? inspectArtifactMaintenance(cwd, config.retention!.artifacts, { now })
    : runArtifactMaintenance(cwd, config.retention!.artifacts, { apply, now });
  if (json) stdout(JSON.stringify(result, null, 2));
  else printMaintenanceResult(result, stdout);
  return 0;
}

function printMaintenanceResult(result: ArtifactMaintenanceResult, stdout: (line: string) => void): void {
  stdout(result.dryRun ? "Maintenance status" : "Maintenance applied");
  stdout(`scanned=${result.scanned} planned=${result.items.length} removed=${result.removed} rotated=${result.rotated}`);
  for (const item of result.items) stdout(`  ${item.action} ${item.path} (${item.reason})`);
  for (const warning of result.warnings) stdout(`warning=${warning}`);
}

async function runIngest(args: string[], cwd: string, stdout: (line: string) => void): Promise<number> {
  const [kind, target, ...rest] = args;
  if (!kind || !target) {
    throw new Error("Usage: code-butler ingest <conversation|git> <path>");
  }

  const store = openConfiguredMemoryStore(cwd);
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

  const store = openConfiguredMemoryStore(cwd);
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

  const store = openConfiguredMemoryStore(cwd);
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

async function runProjectSummary(
  args: string[],
  cwd: string,
  stdout: (line: string) => void,
  options: Pick<CliOptions, "projectSummaryGenerator" | "now"> = {}
): Promise<number> {
  const [subcommand, ...rest] = args;
  if (!subcommand || !["refresh", "status"].includes(subcommand)) {
    throw new Error("Usage: code-butler project-summary <refresh|status> [--force] [--fallback]");
  }

  if (subcommand === "status") {
    const statusOptions: { now?: () => Date } = {};
    if (options.now !== undefined) statusOptions.now = options.now;
    const store = openConfiguredMemoryStore(cwd);
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
      stdout(`manualEditsDetected=${status.manualEditsDetected}`);
      stdout(`outputBaselineMissing=${status.outputBaselineMissing}`);
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

  const store = openConfiguredMemoryStore(cwd);
  store.init();
  try {
    const config = loadProjectConfig(cwd);
    const force = rest.includes("--force");
    const fallback = rest.includes("--fallback");
    const unknownFlag = rest.find((arg) => arg !== "--force" && arg !== "--fallback");
    if (unknownFlag) throw new Error(`Unknown project-summary refresh option: ${unknownFlag}`);
    if (fallback && !force) throw new Error("Usage: code-butler project-summary refresh --force --fallback");
    const operationOptions = projectSummaryOperationOptions(options);
    if (fallback) {
      operationOptions.generator = createFallbackProjectSummaryGenerator(new Error("local fallback requested"));
    }
    const result = await refreshProjectSummary(store, config, {
      ...operationOptions,
      force
    });
    if (result.generated) {
      stdout(`Refreshed project summary at ${relativeSummaryPath(cwd, result.summaryPath)}`);
    } else {
      stdout(`Project summary unchanged at ${relativeSummaryPath(cwd, result.summaryPath)}`);
      if (result.skippedReason) stdout(`reason=${result.skippedReason}`);
    }
    if (result.backupPath) stdout(`backupPath=${relativeSummaryPath(cwd, result.backupPath)}`);
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
    | "signal"
    | "projectSummaryGenerator"
    | "now"
    | "watchServiceHomeDir"
    | "watchServicePlatform"
    | "watchServiceLaunchctl"
    | "watchServiceCommandRunner"
    | "cliPath"
  > = {}
): Promise<number> {
  if (args.includes("--global")) return runGlobalWatchCommand(args, cwd, stdout, options);
  const [subcommand, ...subcommandRest] = args;
  if (subcommand === "install") return runWatchInstall(subcommandRest, cwd, stdout, options);
  if (subcommand === "uninstall") return runWatchUninstall(cwd, stdout, options);
  if (subcommand === "status") return runWatchStatus(cwd, stdout, options);

  const source = parseSyncSourceFlag(args);
  const intervalSeconds = parseNumberFlag(args, "--interval") ?? 30;
  const cloudOnly = args.includes("--cloud-only");
  if (cloudOnly && (!args.includes("--once") || !process.env.CODE_BUTLER_WATCH_TOKEN)) throw new Error("Cloud-only watch jobs require the global watcher");
  let stages: Partial<Record<OperationStage, OperationOutcome>> = {};
  const report = (result: OperationOutcome): void => {
    const previous = stages[result.stage];
    // A successful retry clears a deferral, but cannot hide a real error in this pass.
    if (previous?.outcome !== "failed") stages[result.stage] = result;
    if (result.reason) stdout(result.reason);
  };
  const role = process.env.CODE_BUTLER_WATCH_TOKEN ? "watcher" : "legacy-watcher";
  const unregister = registerRuntime(newRuntimeRecord(role, cwd));
  // Global watcher children reserve cloud work for dedicated cloud jobs.
  const stopCloud = startCloudScheduler(cwd, () => {}, { role, automatic: false });
  let running = false;
  const controller = options.signal ? undefined : new AbortController();
  const activeSignal = options.signal ?? controller!.signal;
  const handleProcessSignal = (): void => {
    controller?.abort();
  };
  const handleParentMessage = (message: unknown): void => {
    if (message && typeof message === "object" && "type" in message && message.type === "watch-stop") handleProcessSignal();
  };
  if (process.env.CODE_BUTLER_WATCH_TOKEN) {
    process.on("message", handleParentMessage);
    process.once("disconnect", handleProcessSignal);
    process.channel?.unref();
  }
  if (!options.signal) {
    process.once("SIGINT", handleProcessSignal);
    process.once("SIGTERM", handleProcessSignal);
  }

  async function runOnce(): Promise<void> {
    if (running) return;
    running = true;
    const managedPass = !!process.env.CODE_BUTLER_WATCH_TOKEN;
    let beforeStamp: string | undefined;
    try {
      stages = {};
      if (cloudOnly) {
        await (await import("./cloud/project-connections.js")).retryCatalogMaintenance(cwd);
        // A job started for secrets or catalog upkeep syncs memory only when that was asked for too, so it
        // cannot publish local changes the publish interval is still holding back.
        if (binding(cwd)?.enabled && automaticSyncPending(cwd)) report(await stopCloud.run());
        if (secretBinding(cwd)?.enabled) {
          try {
            const status = await encryptedSecretsSync(cwd);
            report({ outcome: status.status === "conflict" ? "deferred" : "success", stage: "cloud",
              ...(status.status === "conflict" ? { reason: "Secrets sync needs conflict resolution" } : {}) });
          } catch {
            // The native binding records a bounded error state; never write secret paths or values to watcher logs.
            report({ outcome: "failed", stage: "cloud", reason: "Secrets sync failed; open Sync in the desktop app" });
          }
        }
        return;
      }
      if (!managedPass) report(await stopCloud.run());
      if (managedPass && binding(cwd)?.enabled) beforeStamp = localCloudChangeStamp(cwd);
      runArtifactMaintenanceQuietly(cwd, stdout, options.now);
      let projectBriefExists = false;
      const config = loadProjectConfig(cwd);
      const result = await syncWatchedProjectMemory(cwd, config, { source });
      for (const [name, resultSource] of Object.entries(result.sources)) {
        if (resultSource.error) report({ outcome: "failed", stage: "ingestion", reason: `${name} sync failed: ${resultSource.error}` });
      }
      if (result.memories.error) report({ outcome: "failed", stage: "ingestion", reason: `Memory extraction failed: ${result.memories.error}` });
      else if (result.memories.pending) report({ outcome: "deferred", stage: "ingestion", reason: `${result.memories.pending} memory extraction item(s) pending` });
      else report({ outcome: "success", stage: "ingestion" });
      stdout(
        `Synced project memory at ${result.completedAt} (git=${result.sources.git.imported}, codex=${result.sources.codex.imported}, claude=${result.sources.claude.imported}, promoted=${result.memories.promoted})`
      );
      projectBriefExists = readProjectBrief(config.sources.git.repoPath).exists;
      if (projectBriefExists) {
        try {
          // Summary generation can call a remote provider; the database handle
          // guard still blocks unsafe restores without holding the project gate.
          const store = openConfiguredMemoryStore(cwd);
          try {
            store.init();
            const config = loadProjectConfig(cwd);
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
            report({ outcome: "success", stage: "summary" });
          } finally { store.close(); }
        } catch (error) {
          report(errorOutcome(error, "summary"));
        }
      }
    } catch (error) {
      report(errorOutcome(error, "ingestion"));
    } finally {
      if (!cloudOnly && !activeSignal.aborted) {
        if (managedPass) {
          if (beforeStamp && beforeStamp !== localCloudChangeStamp(cwd)) requestLocalChangeSync(cwd);
        } else report(await stopCloud.run());
      }
      running = false;
    }
  }

  try {
    await runOnce();
    if (args.includes("--once")) {
      const results = Object.values(stages);
      const result = results.find(item => item.outcome === "failed") ?? results.find(item => item.outcome === "deferred") ?? { outcome: "success", stage: "watcher" };
      if (process.env.CODE_BUTLER_WATCH_TOKEN && process.send) await new Promise<void>((resolve, reject) => process.send!({ type: "watch-result", ...result, stages }, error => error ? reject(error) : resolve()));
      return result.outcome === "failed" ? 1 : result.outcome === "deferred" ? 75 : 0;
    }
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
    process.removeListener("message", handleParentMessage);
    process.removeListener("disconnect", handleProcessSignal);
    try { await stopCloud(); } finally { unregister(); }
  }
}

/** Portable folders registered from the CLI reconnect through the watcher's automatic setup, like desktop additions. */
function reportAutomaticConnection(root: string, stdout: (line: string) => void): void {
  const setup = queueAutomaticConnection(root);
  if (setup.state === "pending") stdout("Encrypted sync will connect automatically once this computer is signed in and enrolled.");
  else if (setup.state === "review-required") stdout(`Encrypted sync needs review: ${setup.reason ?? "check this folder's connection."}`);
}

async function runGlobalWatchCommand(args: string[], cwd: string, stdout: (line: string) => void,
  options: Pick<CliOptions, "signal" | "watchServiceHomeDir" | "watchServicePlatform" | "watchServiceLaunchctl" | "watchServiceCommandRunner" | "cliPath">
): Promise<number> {
  const command = args[0];
  const root = parseStringFlag(args, "--project-root") ?? cwd;
  const intervalSeconds = parseNumberFlag(args, "--interval") ?? 30;
  const source = parseSyncSourceFlag(args);
  const serviceOptions = { ...watchServiceOptions(cwd, options, { intervalSeconds, source }), global: true };
  if (command === "add") {
    const registered = registerWatchedProject(root).root;
    stdout(`Registered project: ${registered}`);
    reportAutomaticConnection(registered, stdout);
    return 0;
  }
  if (command === "remove") {
    unregisterWatchedProject(root);
    stdout(`Removed project: ${root}`);
    return 0;
  }
  if (command === "install") {
    if (existsSync(join(root, ".code-butler", "config.json"))) reportAutomaticConnection(registerWatchedProject(root).root, stdout);
    const service = installWatchService(serviceOptions);
    stdout(`Installed global Code Butler watcher: ${service.label}`);
    stdout(`logs=${service.logsDir}`);
    return 0;
  }
  if (command === "uninstall") {
    uninstallWatchService(serviceOptions);
    stdout("Uninstalled global Code Butler watcher; project registrations retained.");
    return 0;
  }
  if (command === "status") {
    const service = getWatchServiceStatus(serviceOptions);
    stdout(JSON.stringify({ ...service, ...globalWatchStatus() }, null, 2));
    return 0;
  }
  if (command && !command.startsWith("--")) throw new Error(`Unknown global watch command: ${command}`);
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (!options.signal) { process.once("SIGINT", stop); process.once("SIGTERM", stop); }
  try {
    await runGlobalWatch({ cliPath: options.cliPath ?? fileURLToPath(import.meta.url), intervalSeconds, source,
      once: args.includes("--once"), signal: options.signal ?? controller.signal, log: stdout });
  } finally {
    if (!options.signal) { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  }
  return 0;
}

function runArtifactMaintenanceQuietly(
  cwd: string,
  stdout: (line: string) => void,
  now: (() => Date) | undefined
): void {
  try {
    const config = loadProjectConfig(cwd);
    const result = runArtifactMaintenance(cwd, config.retention!.artifacts, {
      apply: true,
      now: now?.() ?? new Date()
    });
    if (result.rotated > 0 || result.removed > 0) {
      stdout(`Pruned Code Butler artifacts (removed=${result.removed}, rotated=${result.rotated})`);
    }
  } catch (error) {
    stdout(`Artifact cleanup skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runWatchInstall(
  args: string[],
  cwd: string,
  stdout: (line: string) => void,
  options: Pick<CliOptions, "watchServiceHomeDir" | "watchServicePlatform" | "watchServiceLaunchctl" | "watchServiceCommandRunner" | "cliPath"> = {}
): Promise<number> {
  const source = parseSyncSourceFlag(args);
  const intervalSeconds = parseNumberFlag(args, "--interval") ?? 30;
  const service = installWatchService(watchServiceOptions(cwd, options, { intervalSeconds, source }));
  stdout(`Installed Code Butler watch service ${service.label}`);
  stdout(watchServiceLocationLine(service));
  stdout(`logs=${service.logsDir}`);
  return 0;
}

async function runWatchUninstall(
  cwd: string,
  stdout: (line: string) => void,
  options: Pick<CliOptions, "watchServiceHomeDir" | "watchServicePlatform" | "watchServiceLaunchctl" | "watchServiceCommandRunner" | "cliPath"> = {}
): Promise<number> {
  const service = uninstallWatchService(watchServiceOptions(cwd, options));
  stdout(`Uninstalled Code Butler watch service ${service.label}`);
  return 0;
}

async function runWatchStatus(
  cwd: string,
  stdout: (line: string) => void,
  options: Pick<CliOptions, "watchServiceHomeDir" | "watchServicePlatform" | "watchServiceLaunchctl" | "watchServiceCommandRunner" | "cliPath"> = {}
): Promise<number> {
  const service = getWatchServiceStatus(watchServiceOptions(cwd, options));
  stdout("Code Butler Watch Status");
  stdout(`label=${service.label}`);
  stdout(watchServiceLocationLine(service));
  stdout(`installed=${service.installed}`);
  return 0;
}

function watchServiceOptions(
  cwd: string,
  options: Pick<CliOptions, "watchServiceHomeDir" | "watchServicePlatform" | "watchServiceLaunchctl" | "watchServiceCommandRunner" | "cliPath">,
  overrides: { intervalSeconds?: number; source?: SyncSourceName | "all" } = {}
): Parameters<typeof installWatchService>[0] {
  return {
    cwd,
    homeDir: options.watchServiceHomeDir,
    platform: options.watchServicePlatform,
    cliPath: options.cliPath ?? fileURLToPath(import.meta.url),
    intervalSeconds: overrides.intervalSeconds,
    source: overrides.source,
    commandRunner: options.watchServiceCommandRunner,
    runCommands: options.watchServiceLaunchctl !== false
  };
}

function watchServiceLocationLine(service: WatchServiceResult): string {
  if (service.servicePath && service.platform === "darwin") return `plist=${service.servicePath}`;
  if (service.servicePath) return `service=${service.servicePath}`;
  if (service.taskName) return `task=${service.taskName}`;
  return `platform=${service.platform}`;
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

function parseRepeatedStringFlag(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue;
    const value = args[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    values.push(value);
  }
  return values;
}

function parseMemoryTypeFlag(args: string[], flag: string): MemoryType | undefined {
  const value = parseStringFlag(args, flag);
  if (value === undefined) return undefined;
  if (value === "decision" || value === "constraint" || value === "bug_fix" || value === "rejected_approach") {
    return value;
  }
  throw new Error(`${flag} must be one of decision, constraint, bug_fix, rejected_approach`);
}

function parseMemoryLifecycleStatusFlag(args: string[], flag: string): MemoryLifecycleStatus | undefined {
  const value = parseStringFlag(args, flag);
  if (value === undefined) return undefined;
  if (value === "current" || value === "superseded" || value === "retracted") return value;
  throw new Error(`${flag} must be one of current, superseded, retracted`);
}

function validateFlagArguments(
  args: string[],
  input: { command: string; valueFlags: Set<string>; booleanFlags: Set<string> }
): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (input.booleanFlags.has(argument)) continue;
    if (!input.valueFlags.has(argument)) {
      if (!argument.startsWith("--")) throw new Error(`Unexpected ${input.command} argument: ${argument}`);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    index += 1;
  }
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

function printDoctorReport(report: DoctorReport, stdout: (line: string) => void): void {
  stdout("Code Butler Doctor");
  stdout(`Project: ${report.projectRoot}`);
  stdout(`Generated: ${report.generatedAt}`);
  stdout(`Overall: ${report.status}`);

  const categories: DoctorCheckCategory[] = ["project", "storage", "sources", "sync", "summary", "extractor", "retrieval", "memory", "maintenance"];
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
    "  code-butler rules path|list|show <id>|match|conflicts|resolve <id>|attestations|attest <id>|revoke <id>|sync status|enable|disable|now",
    "  code-butler init",
    "  code-butler config init",
    "  code-butler config global init",
    "  code-butler config migrate-local <--dry-run|--apply> [--json]",
    "  code-butler cloud <register|login> --server <https-origin> --email <email>",
    "  code-butler cloud logout",
    "  code-butler cloud init --recovery-file <path> [--label <name>] [--recovery-code-file <path>]",
    "  code-butler cloud device request [--label <name>]",
    "  code-butler cloud device approve --fingerprint <sha256>",
    "  code-butler cloud device complete  # check and finish pending enrollment",
    "  code-butler cloud device cancel --request <uuid>",
    "  code-butler cloud device list",
    "  code-butler cloud device revoke --device <uuid>",
    "  code-butler cloud recovery <export|verify|restore> --file <path>",
    "  code-butler cloud projects",
    "  code-butler cloud enable [--project <uuid> | --new] [--name <name>] [--continue-existing]",
    "  code-butler cloud make-portable [--continue-existing]",
    "  code-butler cloud separate-identity",
    "  code-butler cloud status",
    "  code-butler cloud storage",
    "  code-butler cloud local-size",
    "  code-butler cloud sync",
    "  code-butler cloud disable",
    "  code-butler cloud resolve --keep <local|cloud|merge>",
    "  code-butler ingest conversation <file>",
    "  code-butler ingest git <repo> [--max-commits <n>]",
    "  code-butler decision add --topic <topic> --decision <decision> --reason <reason> [--status <status>] [--evidence <type:id#locator>]",
    "  code-butler decision import <markdown-file>",
    "  code-butler memory audit [--fix] [--json]",
    "  code-butler memory export [--dry-run] [--json] [--force]",
    "  code-butler memory review --id <id> --category <candidate|promoted> --action <verify|correct|discard> [--reason <text>] [--review-token <token>] [--correction-json <json>] [--json]",
    "  code-butler memory reconcile plan [--queue <actionable|legacy|all>] [--quality <quarantined|needs_review>] [--limit <n|all>] [--max-requests <n>] [--token-budget <n>] [--concurrency <1..4>] [--json]",
    "  code-butler memory reconcile status --run <id> [--json]",
    "  code-butler memory reconcile replan --run <id> [--stale-only] [--retry-failed] [--retry-uncertain] [--json]",
    "  code-butler memory reconcile apply --run <id> [--apply-corrections] [--force-offline] [--json]",
    "  code-butler memory reconcile revert --run <id> [--force-offline] [--json]",
    "  code-butler memory remember --type <decision|constraint|bug_fix|rejected_approach> --text <text> [--title <title>] [--reason <reason>] [--related-file <path>] [--candidate] [--supersedes <memory-id>] [--scope-json <json>] [--layer <layer>] [--json]",
    "  code-butler memory scope --id <id> --category <candidate|promoted|temporary> --scope-json <json> --reason <text> [--json]",
    "  code-butler memory layer --id <id> --category <candidate|promoted|temporary> --layer <layer> --reason <text> [--json]",
    "  code-butler memory promotions [--layer <core|device|branch|all>] [--min-score <0..1>] [--min-confidence <0..1>] [--limit <n>] [--promoted-only] [--json]",
    "  code-butler memory promotions --plan [--json]              # preview automatic promotion; writes nothing",
    "  code-butler memory promotions --apply [--min-score <0..1>] [--json]",
    "  code-butler memory promotions --history [--id <id>] [--limit <n>] [--json]",
    "  code-butler memory promotions --undo (--since <ISO time> | --id <candidate-id>) [--json]",
    "  code-butler memory retention [--apply] [--history] [--id <id>] [--limit <n>] [--json]",
    "  code-butler memory branch-triage [--branch <name>] [--include-active] [--stale-days <n>] [--include-reviewed] [--limit <n>] [--json]",
    "  code-butler memory branch-resolve --id <id> --category <candidate|promoted> --action <promote_to_core|discard|retain_branch> --reason <text> [--supersedes <memory-id>] [--json]",
    "  code-butler memory status --id <id> --status <current|superseded|retracted> --reason <text> [--replacement <id>]",
    "  code-butler memory conflicts [--fix] [--json]",
    "  code-butler doctor [--json] [--strict]",
    "  code-butler maintenance status [--json]",
    "  code-butler maintenance prune <--dry-run|--apply> [--json]",
    "  code-butler embeddings build [--json]",
    "  code-butler embeddings status [--json]",
    "  code-butler privacy audit [--json]",
    "  code-butler privacy export --output <file> [--raw --confirm-raw-export] [--json]",
    "  code-butler privacy import --input <file> [--confirm-nonempty] [--json]",
    "  code-butler privacy scrub [--purge-backups] [--json]",
    "  code-butler privacy delete --source-id <id> --confirm-delete <id> [--purge-backups] [--json]",
    "  code-butler privacy prune <--dry-run|--apply> [--purge-backups] [--json]",
    "  code-butler sync [--source <git|codex|claude|all>]",
    "  code-butler sources status",
    "  code-butler sources failures [--json]",
    "  code-butler extraction report [--since <date>] [--limit <n>] [--json]",
    "  code-butler extraction dry-run [--since <date>] [--limit <n>] [--json]",
    "  code-butler extraction requeue --since <date> [--json]",
    "  code-butler watch [--interval <seconds>] [--source <git|codex|claude|all>]",
    "  code-butler runtime",
    "  code-butler --version",
    "  code-butler watch status",
    "  code-butler watch uninstall",
    "  code-butler watch --global [--interval <seconds>]",
    "  code-butler watch <install|status|uninstall> --global",
    "  code-butler watch <add|remove> --global --project-root <path>",
    "  code-butler project-summary refresh [--force] [--fallback]",
    "  code-butler project-summary status",
    "  code-butler hooks install",
    "  code-butler mcp [--project-root <path>] [--init-here] [--no-auto-init]",
    "  code-butler serve"
  ].join("\n");
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  (process.argv.includes("--retrieval-worker") ? import("./retrieval/worker.js").then(m=>m.runRetrievalWorker()).then(()=>0) : runCli()).then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
