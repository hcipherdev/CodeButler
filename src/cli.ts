#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { ensureProjectConfig, loadProjectConfig } from "./config.js";
import { addDecision, importDecisionMarkdown } from "./decisions/store.js";
import { parseConversationFile } from "./ingest/conversation.js";
import { ingestGitRepository } from "./ingest/git.js";
import {
  getProjectSummaryStatus,
  installProjectSummary,
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
import type { EvidenceRef, SyncSourceName } from "./types.js";

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
      store.close();
      ensureProjectConfig(cwd);
      stdout(`Initialized project memory at ${join(cwd, ".code-butler")}`);
      return 0;
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
        now: options.now
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
  const [subcommand] = args;
  if (subcommand !== "init") {
    throw new Error("Usage: code-butler config init");
  }
  const configPath = ensureProjectConfig(cwd);
  stdout(`Initialized project config at ${configPath}`);
  return 0;
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
  if (!subcommand || !["install", "refresh", "status"].includes(subcommand)) {
    throw new Error("Usage: code-butler project-summary <install|refresh|status> [--force]");
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
    if (subcommand === "install") {
      await syncProjectMemory(store, config, { source: "all" });
      const result = await installProjectSummary(store, config, operationOptions);
      stdout(`Installed project summary at ${relativeSummaryPath(cwd, result.summaryPath)}`);
      if (result.backupDir) {
        stdout(`Backed up agent files at ${relativeSummaryPath(cwd, result.backupDir)}`);
      }
      return 0;
    }

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
  options: Pick<CliOptions, "signal" | "projectSummaryGenerator" | "now"> = {}
): Promise<number> {
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
    "  code-butler ingest conversation <file>",
    "  code-butler ingest git <repo> [--max-commits <n>]",
    "  code-butler decision add --topic <topic> --decision <decision> --reason <reason> [--status <status>] [--evidence <type:id#locator>]",
    "  code-butler decision import <markdown-file>",
    "  code-butler sync [--source <git|codex|claude|all>]",
    "  code-butler sources status",
    "  code-butler watch [--interval <seconds>] [--source <git|codex|claude|all>]",
    "  code-butler project-summary install",
    "  code-butler project-summary refresh [--force]",
    "  code-butler project-summary status",
    "  code-butler hooks install",
    "  code-butler mcp [--project-root <path>] [--init-here]",
    "  code-butler serve"
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
