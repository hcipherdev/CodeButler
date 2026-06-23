import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join, relative } from "node:path";

import { createConfiguredProjectSummaryGenerator } from "./providers.js";
import type { MemoryStore, ProjectSummary } from "../storage/store.js";
import type { CommitRecord, MemorySearchResult, ProjectConfig } from "../types.js";

const SUMMARY_VERSION = 1;
const DAILY_REFRESH_MS = 24 * 60 * 60 * 1000;
const MAX_CONTEXT_FILE_CHARS = 80_000;
const MAX_INVENTORY_ENTRIES = 200;
const AGENT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
const MANIFEST_PATHS = [
  "Cargo.toml",
  "Cargo.lock",
  "package.json",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "package-lock.json",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "go.sum",
  "pom.xml",
  "build.gradle",
  "settings.gradle",
  "tsconfig.json",
  "vite.config.ts",
  "next.config.js",
  "next.config.mjs"
] as const;
const DOC_PATHS = ["README.md", "docs/README.md", "MEMORY_SYSTEM.md", "PLAYBOOK.md"] as const;
const IGNORED_INVENTORY_NAMES = new Set([
  ".git",
  ".code-butler",
  "node_modules",
  "dist",
  "target",
  "coverage",
  ".next",
  ".turbo",
  ".cache"
]);

export interface ProjectSummaryTextFile {
  path: string;
  content: string;
}

export interface ProjectSummaryCodeContext {
  manifests: ProjectSummaryTextFile[];
  docs: ProjectSummaryTextFile[];
  inventory: string[];
  memories: MemorySearchResult[];
  commits: CommitRecord[];
  projectState: ProjectSummary;
}

export interface ProjectSummaryGeneratorInput {
  projectRoot: string;
  fingerprint: string;
  agentHints: Array<{ fileName: "AGENTS.md" | "CLAUDE.md"; content: string }>;
  codeContext: ProjectSummaryCodeContext;
}

export interface ProjectSummaryGenerator {
  name?: string;
  generate(input: ProjectSummaryGeneratorInput): Promise<string>;
}

export interface ProjectSummaryMeta {
  version: 1;
  summaryPath: string;
  fingerprint: string;
  lastGeneratedAt?: string;
  lastCheckedAt?: string;
  provider?: string;
}

export interface ProjectBrief {
  exists: boolean;
  summaryPath: string;
  summary: string;
  meta?: ProjectSummaryMeta;
}

export interface ProjectSummaryStatus {
  exists: boolean;
  summaryPath: string;
  metaPath: string;
  due: boolean;
  stale: boolean;
  fingerprint?: string;
  currentFingerprint?: string;
  lastGeneratedAt?: string;
  lastCheckedAt?: string;
  provider?: string;
}

export interface ProjectSummaryRefreshResult {
  checked: boolean;
  generated: boolean;
  summaryPath: string;
  fingerprint?: string;
  meta?: ProjectSummaryMeta;
  skippedReason?: string;
}

export interface ProjectSummaryInstallResult extends ProjectSummaryRefreshResult {
  agentFiles: string[];
  backupDir?: string;
}

export interface ProjectSummaryOperationOptions {
  generator?: ProjectSummaryGenerator;
  now?: () => Date;
  force?: boolean;
}

export function readProjectBrief(rootDir: string): ProjectBrief {
  const paths = projectSummaryPaths(rootDir);
  const summary = existsSync(paths.summaryPath) ? readFileSync(paths.summaryPath, "utf8") : "";
  const meta = readProjectSummaryMeta(rootDir);
  const brief: ProjectBrief = {
    exists: existsSync(paths.summaryPath),
    summaryPath: paths.summaryPath,
    summary
  };
  if (meta !== undefined) brief.meta = meta;
  return brief;
}

export function getProjectSummaryStatus(
  rootDir: string,
  options: { store?: MemoryStore; config?: ProjectConfig; now?: () => Date } = {}
): ProjectSummaryStatus {
  const paths = projectSummaryPaths(rootDir);
  const meta = readProjectSummaryMeta(rootDir);
  const now = (options.now ?? (() => new Date()))();
  let currentFingerprint: string | undefined;
  if (options.store && options.config) {
    currentFingerprint = collectProjectSummaryInput(options.store, options.config).fingerprint;
  }
  const stale =
    !existsSync(paths.summaryPath) ||
    meta === undefined ||
    (currentFingerprint !== undefined && meta.fingerprint !== currentFingerprint);
  const status: ProjectSummaryStatus = {
    exists: existsSync(paths.summaryPath),
    summaryPath: paths.summaryPath,
    metaPath: paths.metaPath,
    due: isSummaryRefreshDue(meta, now),
    stale
  };
  if (meta?.fingerprint !== undefined) status.fingerprint = meta.fingerprint;
  if (currentFingerprint !== undefined) status.currentFingerprint = currentFingerprint;
  if (meta?.lastGeneratedAt !== undefined) status.lastGeneratedAt = meta.lastGeneratedAt;
  if (meta?.lastCheckedAt !== undefined) status.lastCheckedAt = meta.lastCheckedAt;
  if (meta?.provider !== undefined) status.provider = meta.provider;
  return status;
}

export async function installProjectSummary(
  store: MemoryStore,
  config: ProjectConfig,
  options: ProjectSummaryOperationOptions = {}
): Promise<ProjectSummaryInstallResult> {
  const rootDir = projectRoot(config, store);
  const refreshed = await refreshProjectSummary(store, config, options);
  const existingAgentFiles = AGENT_FILE_NAMES.map((fileName) => join(rootDir, fileName)).filter(existsSync);
  const backupDir =
    existingAgentFiles.length > 0
      ? join(rootDir, ".code-butler", "backups", "agent-instructions", timestampForBackup(nowDate(options)))
      : undefined;
  if (backupDir) {
    mkdirSync(backupDir, { recursive: true });
    for (const agentFile of existingAgentFiles) {
      copyFileSync(agentFile, join(backupDir, agentFile.endsWith("AGENTS.md") ? "AGENTS.md" : "CLAUDE.md"));
    }
  }

  for (const fileName of AGENT_FILE_NAMES) {
    writeFileSync(join(rootDir, fileName), agentBootstrapText(fileName));
  }

  const result: ProjectSummaryInstallResult = {
    ...refreshed,
    agentFiles: AGENT_FILE_NAMES.map((fileName) => join(rootDir, fileName))
  };
  if (backupDir !== undefined) result.backupDir = backupDir;
  return result;
}

export async function refreshProjectSummary(
  store: MemoryStore,
  config: ProjectConfig,
  options: ProjectSummaryOperationOptions = {}
): Promise<ProjectSummaryRefreshResult> {
  const rootDir = projectRoot(config, store);
  const paths = projectSummaryPaths(rootDir);
  const now = nowDate(options);
  const input = collectProjectSummaryInput(store, config);
  const existing = readProjectBrief(rootDir);

  if (!options.force && existing.exists && existing.meta?.fingerprint === input.fingerprint) {
    const meta = normalizeMeta({
      ...existing.meta,
      summaryPath: paths.summaryPath,
      lastCheckedAt: now.toISOString()
    });
    writeProjectSummaryMeta(rootDir, meta);
    return {
      checked: true,
      generated: false,
      summaryPath: paths.summaryPath,
      fingerprint: input.fingerprint,
      meta
    };
  }

  const generator = options.generator ?? createConfiguredProjectSummaryGenerator(config);
  const summary = (await generator.generate(input)).trim();
  if (!summary) {
    throw new Error("Project summary generator returned empty content");
  }

  mkdirSync(paths.dataDir, { recursive: true });
  writeFileSync(paths.summaryPath, `${summary}\n`);
  const metaInput: ProjectSummaryMeta = {
    version: SUMMARY_VERSION,
    summaryPath: paths.summaryPath,
    fingerprint: input.fingerprint,
    lastGeneratedAt: now.toISOString(),
    lastCheckedAt: now.toISOString()
  };
  if (generator.name !== undefined) metaInput.provider = generator.name;
  const meta = normalizeMeta(metaInput);
  writeProjectSummaryMeta(rootDir, meta);
  return {
    checked: true,
    generated: true,
    summaryPath: paths.summaryPath,
    fingerprint: input.fingerprint,
    meta
  };
}

export async function refreshProjectSummaryIfDue(
  store: MemoryStore,
  config: ProjectConfig,
  options: ProjectSummaryOperationOptions = {}
): Promise<ProjectSummaryRefreshResult> {
  const rootDir = projectRoot(config, store);
  const paths = projectSummaryPaths(rootDir);
  const meta = readProjectSummaryMeta(rootDir);
  if (!options.force && existsSync(paths.summaryPath) && !isSummaryRefreshDue(meta, nowDate(options))) {
    const result: ProjectSummaryRefreshResult = {
      checked: false,
      generated: false,
      summaryPath: paths.summaryPath,
      skippedReason: "not_due"
    };
    if (meta?.fingerprint !== undefined) result.fingerprint = meta.fingerprint;
    if (meta !== undefined) result.meta = meta;
    return result;
  }
  return refreshProjectSummary(store, config, options);
}

export function collectProjectSummaryInput(
  store: MemoryStore,
  config: ProjectConfig
): ProjectSummaryGeneratorInput {
  const rootDir = projectRoot(config, store);
  const agentHints = readAgentHints(rootDir);
  const codeContext: ProjectSummaryCodeContext = {
    manifests: readExistingTextFiles(rootDir, MANIFEST_PATHS),
    docs: readExistingTextFiles(rootDir, DOC_PATHS),
    inventory: readProjectInventory(rootDir),
    memories: store.searchMemoryLayer({ status: "promoted", limit: 50 }),
    commits: store.findCommits({ limit: 20 }),
    projectState: store.getProjectSummary()
  };
  const fingerprint = fingerprintProjectSummaryInputs({
    projectRoot: rootDir,
    agentHints,
    codeContext
  });
  return {
    projectRoot: rootDir,
    fingerprint,
    agentHints,
    codeContext
  };
}

function projectSummaryPaths(rootDir: string): { dataDir: string; summaryPath: string; metaPath: string } {
  const dataDir = join(rootDir, ".code-butler");
  return {
    dataDir,
    summaryPath: join(dataDir, "project-summary.md"),
    metaPath: join(dataDir, "project-summary.meta.json")
  };
}

function readProjectSummaryMeta(rootDir: string): ProjectSummaryMeta | undefined {
  const { metaPath } = projectSummaryPaths(rootDir);
  if (!existsSync(metaPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as Partial<ProjectSummaryMeta>;
    if (parsed.version !== SUMMARY_VERSION || typeof parsed.summaryPath !== "string" || typeof parsed.fingerprint !== "string") {
      return undefined;
    }
    return normalizeMeta(parsed);
  } catch {
    return undefined;
  }
}

function writeProjectSummaryMeta(rootDir: string, meta: ProjectSummaryMeta): void {
  const paths = projectSummaryPaths(rootDir);
  mkdirSync(paths.dataDir, { recursive: true });
  writeFileSync(paths.metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

function normalizeMeta(input: Partial<ProjectSummaryMeta>): ProjectSummaryMeta {
  if (input.version !== SUMMARY_VERSION || typeof input.summaryPath !== "string" || typeof input.fingerprint !== "string") {
    throw new Error("Invalid project summary metadata");
  }
  const meta: ProjectSummaryMeta = {
    version: SUMMARY_VERSION,
    summaryPath: input.summaryPath,
    fingerprint: input.fingerprint
  };
  if (input.lastGeneratedAt !== undefined) meta.lastGeneratedAt = input.lastGeneratedAt;
  if (input.lastCheckedAt !== undefined) meta.lastCheckedAt = input.lastCheckedAt;
  if (input.provider !== undefined) meta.provider = input.provider;
  return meta;
}

function isSummaryRefreshDue(meta: ProjectSummaryMeta | undefined, now: Date): boolean {
  if (!meta?.lastCheckedAt) return true;
  const lastCheckedAt = Date.parse(meta.lastCheckedAt);
  if (!Number.isFinite(lastCheckedAt)) return true;
  return now.getTime() - lastCheckedAt >= DAILY_REFRESH_MS;
}

function projectRoot(config: ProjectConfig, store: MemoryStore): string {
  return config.sources.git.repoPath || store.paths.rootDir;
}

function readAgentHints(rootDir: string): Array<{ fileName: "AGENTS.md" | "CLAUDE.md"; content: string }> {
  const currentHints = readAgentHintFiles(rootDir);
  if (currentHints.length > 0) return currentHints;
  return readLatestBackedUpAgentHints(rootDir);
}

function readAgentHintFiles(rootDir: string): Array<{ fileName: "AGENTS.md" | "CLAUDE.md"; content: string }> {
  const hints: Array<{ fileName: "AGENTS.md" | "CLAUDE.md"; content: string }> = [];
  for (const fileName of AGENT_FILE_NAMES) {
    const path = join(rootDir, fileName);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    if (isGeneratedBootstrap(content)) continue;
    hints.push({ fileName, content: truncate(content, MAX_CONTEXT_FILE_CHARS) });
  }
  return hints;
}

function readLatestBackedUpAgentHints(
  rootDir: string
): Array<{ fileName: "AGENTS.md" | "CLAUDE.md"; content: string }> {
  const backupRoot = join(rootDir, ".code-butler", "backups", "agent-instructions");
  if (!existsSync(backupRoot) || !statSync(backupRoot).isDirectory()) return [];
  const backupDirs = readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const backupDir of backupDirs) {
    const hints = readAgentHintFiles(join(backupRoot, backupDir));
    if (hints.length > 0) return hints;
  }
  return [];
}

function isGeneratedBootstrap(content: string): boolean {
  return (
    content.includes("This file tells") &&
    content.includes("Code Butler") &&
    content.includes(".code-butler/project-summary.md") &&
    content.includes("summarize_project_brief")
  );
}

function readExistingTextFiles(rootDir: string, relativePaths: readonly string[]): ProjectSummaryTextFile[] {
  const files: ProjectSummaryTextFile[] = [];
  for (const relativePath of relativePaths) {
    const path = join(rootDir, relativePath);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    files.push({
      path: relativePath,
      content: truncate(readFileSync(path, "utf8"), MAX_CONTEXT_FILE_CHARS)
    });
  }
  return files;
}

function readProjectInventory(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  const entries: string[] = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (IGNORED_INVENTORY_NAMES.has(entry.name)) continue;
    const suffix = entry.isDirectory() ? "/" : "";
    entries.push(`${entry.name}${suffix}`);
  }

  const srcDir = join(rootDir, "src");
  if (existsSync(srcDir) && statSync(srcDir).isDirectory()) {
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      entries.push(`src/${entry.name}${entry.isDirectory() ? "/" : ""}`);
    }
  }

  const cratesDir = join(rootDir, "crates");
  if (existsSync(cratesDir) && statSync(cratesDir).isDirectory()) {
    for (const entry of readdirSync(cratesDir, { withFileTypes: true })) {
      entries.push(`crates/${entry.name}${entry.isDirectory() ? "/" : ""}`);
    }
  }

  return [...new Set(entries)].sort().slice(0, MAX_INVENTORY_ENTRIES);
}

function fingerprintProjectSummaryInputs(input: Omit<ProjectSummaryGeneratorInput, "fingerprint">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        projectRoot: input.projectRoot,
        agentHints: input.agentHints,
        manifests: input.codeContext.manifests,
        docs: input.codeContext.docs,
        inventory: input.codeContext.inventory,
        memories: input.codeContext.memories.map((memory) => ({
          kind: memory.kind,
          id: memory.id,
          type: memory.type,
          title: memory.title,
          summary: memory.summary,
          reason: memory.reason,
          relatedFiles: memory.relatedFiles
        })),
        commits: input.codeContext.commits.map((commit) => ({
          hash: commit.hash,
          authoredAt: commit.authoredAt,
          message: commit.message,
          changedFiles: commit.changedFiles,
          diffSummary: commit.diffSummary
        })),
        projectState: input.codeContext.projectState
      })
    )
    .digest("hex");
}

function agentBootstrapText(fileName: "AGENTS.md" | "CLAUDE.md"): string {
  const agentName = fileName === "AGENTS.md" ? "Codex" : "Claude";
  return [
    `# ${fileName}`,
    "",
    `This file tells ${agentName} how to use Code Butler for this project. It should stay short and stable.`,
    "",
    "## Code Butler Project Memory",
    "- Use the global Code Butler MCP server named `code-butler` for this repository.",
    "- The global server resolves this repository and uses its project-local `.code-butler/` memory; call `current_project` when you need to confirm which project is active.",
    "- Before coding or answering project-history questions, call `sync_project_memory` when the MCP server is available.",
    "- Start by calling `summarize_project_brief` for the current narrative summary and freshness metadata.",
    "- For continuation questions like \"where were we?\", \"continue\", or after compaction, call `summarize_active_context` first; use `search_temporary_memory` for targeted working context.",
    "- For questions like \"what changed recently and why\", call `summarize_project_state`, then `summarize_recent_activity`; by default this covers the last 3 days. Use git only as secondary corroboration for commits or current uncommitted changes.",
    "- Use `find_memories` and `search_project_memory` for task-specific decisions, constraints, bug fixes, and rejected approaches.",
    "- Use `explain_code_change` for file-specific history and `investigate_project_history` only for deeper follow-up when behavior, ownership, or prior reasoning remains unclear; these investigation tools consider temporary context before durable memory.",
    "- Do not paste durable memory into this file; retrieve it through Butler.",
    "- The narrative summary lives at `.code-butler/project-summary.md`.",
    "- Refresh the narrative with `code-butler project-summary refresh`."
  ].join("\n") + "\n";
}

function nowDate(options: { now?: () => Date }): Date {
  return (options.now ?? (() => new Date()))();
}

function timestampForBackup(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function truncate(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n[truncated ${content.length - maxChars} chars]`;
}

export function relativeSummaryPath(rootDir: string, absolutePath: string): string {
  const relativePath = relative(rootDir, absolutePath);
  return relativePath.startsWith("..") ? absolutePath : relativePath;
}
