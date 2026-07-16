import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";

import {
  collectProjectSummaryCodeFiles,
  listProjectSummarySafeTrackedPaths,
  MAX_PROJECT_SUMMARY_FILE_CHARS,
  readProjectSummaryTrackedFile,
  readTrackedPaths,
  type ProjectSummaryCodeFile
} from "./code-context.js";
import { createConfiguredProjectSummaryGenerator } from "./providers.js";
import type { MemoryStore, ProjectSummary } from "../storage/store.js";
import type { CommitRecord, MemorySearchResult, ProjectConfig } from "../types.js";

const SUMMARY_VERSION = 1;
const DAILY_REFRESH_MS = 24 * 60 * 60 * 1000;
const MAX_INVENTORY_ENTRIES = 200;
const MAX_MANIFEST_FILES = 100;
const MAX_MANIFEST_CONTENT_CHARS = 120_000;
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
const NESTED_MANIFEST_BASENAMES = new Set(["Cargo.toml", "go.mod", "package.json", "pyproject.toml"]);
export interface ProjectSummaryTextFile {
  path: string;
  content: string;
  contentHash?: string;
  originalBytes?: number;
  truncated?: boolean;
}

export interface ProjectSummaryAgentHint {
  fileName: "AGENTS.md" | "CLAUDE.md";
  content: string;
  contentHash?: string;
  originalBytes?: number;
  truncated?: boolean;
}

export interface ProjectSummaryCodeContext {
  manifests: ProjectSummaryTextFile[];
  docs: ProjectSummaryTextFile[];
  codeFiles: ProjectSummaryCodeFile[];
  inventory: string[];
  memories: MemorySearchResult[];
  commits: CommitRecord[];
  projectState: ProjectSummary;
}

export interface ProjectSummaryGeneratorInput {
  projectRoot: string;
  fingerprint: string;
  agentHints: ProjectSummaryAgentHint[];
  notes?: ProjectSummaryTextFile;
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
  outputContentHash?: string;
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
  manualEditsDetected: boolean;
  outputBaselineMissing: boolean;
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
  manualEditsDetected?: boolean;
  backupPath?: string;
}

export interface ProjectSummaryInstallResult extends ProjectSummaryRefreshResult {
  agentFiles: string[];
  backupDir?: string;
  backupFiles?: string[];
}

export interface ProjectSummaryOperationOptions {
  generator?: ProjectSummaryGenerator;
  now?: () => Date;
  force?: boolean;
  warn?: (line: string) => void;
  bootstrapApplyFile?: (stagedPath: string, destinationPath: string) => void;
  summaryApplyFile?: (stagedPath: string, destinationPath: string) => void;
  summaryBeforeCommit?: (destinationPath: string) => void;
}

interface ProjectSummaryInputOptions {
  omitAgentHints?: boolean;
}

export interface ProjectSummaryInstalledResult extends ProjectSummaryRefreshResult {
  agentFiles: string[];
  backupDir?: string;
  backupFiles?: string[];
  fallback: boolean;
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
  const outputHash = existsSync(paths.summaryPath) ? hashFile(paths.summaryPath) : undefined;
  const outputBaselineMissing = existsSync(paths.summaryPath) && meta?.outputContentHash === undefined;
  const manualEditsDetected =
    outputHash !== undefined &&
    meta?.outputContentHash !== undefined &&
    outputHash !== meta.outputContentHash;
  const status: ProjectSummaryStatus = {
    exists: existsSync(paths.summaryPath),
    summaryPath: paths.summaryPath,
    metaPath: paths.metaPath,
    due: isSummaryRefreshDue(meta, now),
    stale,
    manualEditsDetected,
    outputBaselineMissing
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
  preflightProjectSummaryOutputs(rootDir);
  const bootstrapPlan = planAgentBootstrapFiles(rootDir, nowDate(options));
  const summarySnapshot = snapshotProjectSummaryFiles(rootDir);
  let refreshed: ProjectSummaryRefreshResult;
  let bootstrap: ProjectSummaryBootstrapResult;
  try {
    refreshed = await refreshProjectSummaryInternal(store, config, options, { omitAgentHints: true });
    bootstrap = applyAgentBootstrapPlan(bootstrapPlan, options);
  } catch (error) {
    restoreProjectSummaryFiles(summarySnapshot);
    throw error;
  }

  const result: ProjectSummaryInstallResult = {
    ...refreshed,
    agentFiles: AGENT_FILE_NAMES.map((fileName) => join(rootDir, fileName))
  };
  if (bootstrap.backupDir !== undefined) result.backupDir = bootstrap.backupDir;
  if (bootstrap.backupFiles.length > 0) result.backupFiles = bootstrap.backupFiles;
  return result;
}

export async function initializeProjectSummary(
  store: MemoryStore,
  config: ProjectConfig,
  options: ProjectSummaryOperationOptions = {}
): Promise<ProjectSummaryInstalledResult> {
  const rootDir = projectRoot(config, store);
  preflightProjectSummaryOutputs(rootDir);
  const bootstrapPlan = planAgentBootstrapFiles(rootDir, nowDate(options));
  const summarySnapshot = snapshotProjectSummaryFiles(rootDir);
  const existing = readProjectBrief(rootDir);
  let refreshed: ProjectSummaryRefreshResult;
  let fallback = false;
  let bootstrap: ProjectSummaryBootstrapResult;
  try {
    if (existing.exists) {
      refreshed = {
        checked: false,
        generated: false,
        summaryPath: existing.summaryPath
      };
      if (existing.meta?.fingerprint !== undefined) refreshed.fingerprint = existing.meta.fingerprint;
      if (existing.meta !== undefined) refreshed.meta = existing.meta;
    } else {
      try {
        refreshed = await refreshProjectSummaryInternal(store, config, options, { omitAgentHints: true });
      } catch (error) {
        fallback = true;
        const fallbackGenerator = createFallbackProjectSummaryGenerator(error);
        refreshed = await refreshProjectSummaryInternal(
          store,
          config,
          {
            ...options,
            generator: fallbackGenerator,
            force: true
          },
          { omitAgentHints: true }
        );
        const message = fallbackSummaryWarning(error);
        options.warn?.(message);
      }
    }
    bootstrap = applyAgentBootstrapPlan(bootstrapPlan, options);
  } catch (error) {
    restoreProjectSummaryFiles(summarySnapshot);
    throw error;
  }
  return {
    ...refreshed,
    fallback,
    agentFiles: AGENT_FILE_NAMES.map((fileName) => join(rootDir, fileName)),
    ...(bootstrap.backupDir ? { backupDir: bootstrap.backupDir } : {}),
    ...(bootstrap.backupFiles.length > 0 ? { backupFiles: bootstrap.backupFiles } : {})
  };
}

export async function refreshProjectSummary(
  store: MemoryStore,
  config: ProjectConfig,
  options: ProjectSummaryOperationOptions = {}
): Promise<ProjectSummaryRefreshResult> {
  return refreshProjectSummaryInternal(store, config, options);
}

async function refreshProjectSummaryInternal(
  store: MemoryStore,
  config: ProjectConfig,
  options: ProjectSummaryOperationOptions,
  inputOptions: ProjectSummaryInputOptions = {}
): Promise<ProjectSummaryRefreshResult> {
  const rootDir = projectRoot(config, store);
  preflightProjectSummaryOutputs(rootDir);
  const paths = projectSummaryPaths(rootDir);
  const now = nowDate(options);
  const input = collectProjectSummaryInputInternal(store, config, inputOptions);
  const existing = readProjectBrief(rootDir);
  const existingOutputHash = existing.exists ? hashFile(paths.summaryPath) : undefined;
  const manualEditsDetected =
    existingOutputHash !== undefined &&
    existing.meta?.outputContentHash !== undefined &&
    existingOutputHash !== existing.meta.outputContentHash;
  const outputBaselineMissing = existing.exists && existing.meta?.outputContentHash === undefined;

  if (!options.force && manualEditsDetected) {
    return {
      checked: true,
      generated: false,
      summaryPath: paths.summaryPath,
      fingerprint: input.fingerprint,
      ...(existing.meta ? { meta: existing.meta } : {}),
      skippedReason: "manual_edits_detected",
      manualEditsDetected: true
    };
  }

  if (
    !options.force &&
    outputBaselineMissing &&
    existing.meta?.fingerprint !== input.fingerprint
  ) {
    return {
      checked: true,
      generated: false,
      summaryPath: paths.summaryPath,
      fingerprint: input.fingerprint,
      ...(existing.meta ? { meta: existing.meta } : {}),
      skippedReason: "output_baseline_missing"
    };
  }

  if (!options.force && existing.exists && existing.meta?.fingerprint === input.fingerprint) {
    const meta = normalizeMeta({
      ...existing.meta,
      summaryPath: paths.summaryPath,
      ...(existingOutputHash ? { outputContentHash: existingOutputHash } : {}),
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

  let backupPath: string | undefined;
  if (options.force && existing.exists && (manualEditsDetected || outputBaselineMissing)) {
    backupPath = backupProjectSummary(paths.summaryPath, paths.dataDir, now);
  }

  const generator = options.generator ?? createConfiguredProjectSummaryGenerator(config);
  const summary = (await generator.generate(input)).trim();
  if (!summary) {
    throw new Error("Project summary generator returned empty content");
  }

  const outputExistsBeforeCommit = existsSync(paths.summaryPath);
  const outputHashBeforeCommit = outputExistsBeforeCommit ? hashFile(paths.summaryPath) : undefined;
  const outputChangedDuringGeneration = existing.exists
    ? !outputExistsBeforeCommit || outputHashBeforeCommit !== existingOutputHash
    : outputExistsBeforeCommit;
  if (outputChangedDuringGeneration) {
    if (!options.force) {
      return {
        checked: true,
        generated: false,
        summaryPath: paths.summaryPath,
        fingerprint: input.fingerprint,
        ...(existing.meta ? { meta: existing.meta } : {}),
        skippedReason: existing.exists ? "manual_edits_detected" : "output_baseline_missing",
        ...(existing.exists ? { manualEditsDetected: true } : {})
      };
    }
    if (outputExistsBeforeCommit) {
      backupPath = backupProjectSummary(paths.summaryPath, paths.dataDir, now);
    }
  }

  const summaryContent = `${summary}\n`;
  const metaInput: ProjectSummaryMeta = {
    version: SUMMARY_VERSION,
    summaryPath: paths.summaryPath,
    fingerprint: input.fingerprint,
    outputContentHash: hashBytes(Buffer.from(summaryContent)),
    lastGeneratedAt: now.toISOString(),
    lastCheckedAt: now.toISOString()
  };
  if (generator.name !== undefined) metaInput.provider = generator.name;
  const meta = normalizeMeta(metaInput);
  try {
    writeProjectSummaryOutputsAtomically(
      rootDir,
      [
        { path: paths.summaryPath, content: `${summary}\n` },
        { path: paths.metaPath, content: serializeProjectSummaryMeta(meta) }
      ],
      options,
      {
        exists: outputExistsBeforeCommit,
        ...(outputHashBeforeCommit ? { contentHash: outputHashBeforeCommit } : {})
      }
    );
  } catch (error) {
    if (!(error instanceof ConcurrentProjectSummaryEditError)) throw error;
    return {
      checked: true,
      generated: false,
      summaryPath: paths.summaryPath,
      fingerprint: input.fingerprint,
      ...(existing.meta ? { meta: existing.meta } : {}),
      skippedReason: "manual_edits_detected",
      manualEditsDetected: true,
      ...(backupPath ? { backupPath } : {})
    };
  }
  return {
    checked: true,
    generated: true,
    summaryPath: paths.summaryPath,
    fingerprint: input.fingerprint,
    meta,
    ...(backupPath ? { backupPath } : {})
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
  return collectProjectSummaryInputInternal(store, config);
}

function collectProjectSummaryInputInternal(
  store: MemoryStore,
  config: ProjectConfig,
  options: ProjectSummaryInputOptions = {}
): ProjectSummaryGeneratorInput {
  const rootDir = projectRoot(config, store);
  const trackedPaths = readTrackedPaths(rootDir);
  const manifests = readTrackedManifestFiles(rootDir, discoverManifestPaths(trackedPaths), trackedPaths);
  const docs = readTrackedTextFiles(rootDir, DOC_PATHS, trackedPaths);
  const memories = store.searchMemoryLayer({ status: "promoted", limit: 50 });
  const commits = store.findCommits({ limit: 20 });
  const agentHints = options.omitAgentHints ? [] : readAgentHints(rootDir, trackedPaths);
  const notes = readProjectSummaryNotes(rootDir);
  const codeContext: ProjectSummaryCodeContext = {
    manifests,
    docs,
    codeFiles: collectProjectSummaryCodeFiles(rootDir, { manifests, memories, commits }),
    inventory: listProjectSummarySafeTrackedPaths(rootDir, trackedPaths, MAX_INVENTORY_ENTRIES),
    memories,
    commits,
    projectState: store.getProjectSummary()
  };
  const fingerprint = fingerprintProjectSummaryInputs({
    projectRoot: rootDir,
    agentHints,
    ...(notes ? { notes } : {}),
    codeContext
  });
  return {
    projectRoot: rootDir,
    fingerprint,
    agentHints,
    ...(notes ? { notes } : {}),
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

function readProjectSummaryNotes(rootDir: string): ProjectSummaryTextFile | undefined {
  const rootRealPath = realpathSync(rootDir);
  const notesPath = join(rootRealPath, ".code-butler", "project-summary-notes.md");
  if (!existsSync(notesPath)) return undefined;
  try {
    const before = lstatSync(notesPath);
    if (!before.isFile() || before.isSymbolicLink()) return undefined;
    if (!isInsideRoot(rootRealPath, realpathSync(notesPath))) return undefined;
    const noFollowFlag = (fsConstants as typeof fsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    const descriptor = openSync(notesPath, fsConstants.O_RDONLY | noFollowFlag);
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return undefined;
      const bytes = readFileSync(descriptor);
      const fullContent = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return {
        path: ".code-butler/project-summary-notes.md",
        content: fullContent.slice(0, MAX_PROJECT_SUMMARY_FILE_CHARS),
        contentHash: hashBytes(bytes),
        originalBytes: bytes.byteLength,
        truncated: fullContent.length > MAX_PROJECT_SUMMARY_FILE_CHARS
      };
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return undefined;
  }
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
  writeProjectSummaryOutputsAtomically(rootDir, [
    { path: paths.metaPath, content: serializeProjectSummaryMeta(meta) }
  ]);
}

function serializeProjectSummaryMeta(meta: ProjectSummaryMeta): string {
  return `${JSON.stringify(meta, null, 2)}\n`;
}

interface ProjectSummaryOutputWrite {
  path: string;
  content: string;
}

interface AppliedProjectSummaryOutput {
  path: string;
  rollbackPath?: string;
  installed: boolean;
}

interface ExpectedProjectSummaryOutput {
  exists: boolean;
  contentHash?: string;
}

class ConcurrentProjectSummaryEditError extends Error {}

function preflightProjectSummaryOutputs(rootDir: string): void {
  const rootRealPath = realpathSync(rootDir);
  const paths = projectSummaryPaths(rootDir);
  const expectedDataDir = join(rootRealPath, ".code-butler");
  if (!isInsideRoot(rootRealPath, expectedDataDir)) {
    throw new Error("Project summary data directory escapes the project root: .code-butler");
  }
  if (existsSync(paths.dataDir)) validateProjectSummaryDataDir(paths.dataDir, rootRealPath);
  for (const path of [paths.summaryPath, paths.metaPath]) {
    if (!existsSync(path)) continue;
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Project summary destination must be a regular non-symlink file: ${path}`);
    }
    if (!isInsideRoot(rootRealPath, realpathSync(path))) {
      throw new Error(`Project summary destination escapes the project root: ${path}`);
    }
  }
}

function validateProjectSummaryDataDir(dataDir: string, rootRealPath: string): void {
  const stats = lstatSync(dataDir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Project summary data directory must be a regular non-symlink directory: ${dataDir}`);
  }
  if (!isInsideRoot(rootRealPath, realpathSync(dataDir))) {
    throw new Error(`Project summary data directory escapes the project root: ${dataDir}`);
  }
}

function writeProjectSummaryOutputsAtomically(
  rootDir: string,
  writes: ProjectSummaryOutputWrite[],
  options: Pick<ProjectSummaryOperationOptions, "summaryApplyFile" | "summaryBeforeCommit"> = {},
  expectedSummary?: ExpectedProjectSummaryOutput
): void {
  const rootRealPath = realpathSync(rootDir);
  const paths = projectSummaryPaths(rootDir);
  if (!existsSync(paths.dataDir)) mkdirSync(paths.dataDir);
  validateProjectSummaryDataDir(paths.dataDir, rootRealPath);

  const stagedDir = mkdtempSync(join(paths.dataDir, ".project-summary-write-"));
  const staged = new Map<string, string>();
  const modes = new Map<string, number>();
  const applied: AppliedProjectSummaryOutput[] = [];
  try {
    for (const [index, write] of writes.entries()) {
      if (write.path !== paths.summaryPath && write.path !== paths.metaPath) {
        throw new Error(`Unsafe project summary destination: ${write.path}`);
      }
      if (existsSync(write.path)) {
        const stats = lstatSync(write.path);
        if (!stats.isSymbolicLink()) {
          if (!stats.isFile()) {
            throw new Error(`Project summary destination must be a regular file or replaceable symlink: ${write.path}`);
          }
          if (!isInsideRoot(rootRealPath, realpathSync(write.path))) {
            throw new Error(`Project summary destination escapes the project root: ${write.path}`);
          }
          modes.set(write.path, stats.mode);
        }
      }
      const stagedPath = join(stagedDir, `output-${index}`);
      writeFileSync(stagedPath, write.content, { flag: "wx" });
      const mode = modes.get(write.path);
      if (mode !== undefined) chmodSync(stagedPath, mode);
      staged.set(write.path, stagedPath);
    }

    for (const [index, write] of writes.entries()) {
      const stagedPath = staged.get(write.path);
      if (!stagedPath) throw new Error(`Missing staged project summary output: ${write.path}`);
      if (write.path === paths.summaryPath && expectedSummary) {
        options.summaryBeforeCommit?.(write.path);
        validateExpectedProjectSummaryOutput(write.path, expectedSummary);
      }
      let rollbackPath: string | undefined;
      if (existsSync(write.path)) {
        rollbackPath = join(stagedDir, `.rollback-${index}`);
        renameSync(write.path, rollbackPath);
      }
      const appliedOutput: AppliedProjectSummaryOutput = {
        path: write.path,
        ...(rollbackPath ? { rollbackPath } : {}),
        installed: false
      };
      applied.push(appliedOutput);
      if (write.path === paths.summaryPath && expectedSummary) {
        if (expectedSummary.exists) {
          if (!rollbackPath || hashFile(rollbackPath) !== expectedSummary.contentHash) {
            throw new ConcurrentProjectSummaryEditError("Project summary changed during refresh commit");
          }
        } else if (rollbackPath) {
          throw new ConcurrentProjectSummaryEditError("Project summary appeared during refresh commit");
        }
      }
      if (options.summaryApplyFile) {
        options.summaryApplyFile(stagedPath, write.path);
        appliedOutput.installed = true;
      } else {
        try {
          linkSync(stagedPath, write.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST" && write.path === paths.summaryPath) {
            throw new ConcurrentProjectSummaryEditError("Project summary changed during refresh commit");
          }
          throw error;
        }
        appliedOutput.installed = true;
        unlinkSync(stagedPath);
      }
    }
  } catch (error) {
    for (const output of applied.reverse()) {
      if (output.installed) rmSync(output.path, { force: true, recursive: true });
      if (output.rollbackPath && existsSync(output.rollbackPath)) {
        if (!existsSync(output.path)) {
          renameSync(output.rollbackPath, output.path);
        } else if (output.path === paths.summaryPath) {
          backupProjectSummary(output.rollbackPath, paths.dataDir, new Date());
        }
      }
    }
    throw error;
  } finally {
    rmSync(stagedDir, { force: true, recursive: true });
  }
}

function validateExpectedProjectSummaryOutput(
  summaryPath: string,
  expected: ExpectedProjectSummaryOutput
): void {
  if (!expected.exists) {
    if (existsSync(summaryPath)) {
      throw new ConcurrentProjectSummaryEditError("Project summary appeared during refresh commit");
    }
    return;
  }
  if (!existsSync(summaryPath) || hashFile(summaryPath) !== expected.contentHash) {
    throw new ConcurrentProjectSummaryEditError("Project summary changed during refresh commit");
  }
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
  if (typeof input.outputContentHash === "string" && /^[a-f0-9]{64}$/.test(input.outputContentHash)) {
    meta.outputContentHash = input.outputContentHash;
  }
  return meta;
}

function isSummaryRefreshDue(meta: ProjectSummaryMeta | undefined, now: Date): boolean {
  if (!meta?.lastCheckedAt) return true;
  const lastCheckedAt = Date.parse(meta.lastCheckedAt);
  if (!Number.isFinite(lastCheckedAt)) return true;
  return now.getTime() - lastCheckedAt >= DAILY_REFRESH_MS;
}

interface ProjectSummaryBootstrapFilePlan {
  fileName: "AGENTS.md" | "CLAUDE.md";
  path: string;
  content: string;
  existed: boolean;
  originalContent?: Buffer;
  originalDev?: bigint;
  originalIno?: bigint;
  originalSize?: bigint;
  originalMtimeNs?: bigint;
  originalHash?: string;
  mode?: number;
  backupBasePath?: string;
}

interface ProjectSummaryBootstrapPlan {
  rootDir: string;
  files: ProjectSummaryBootstrapFilePlan[];
}

interface ProjectSummaryBootstrapResult {
  backupDir?: string;
  backupFiles: string[];
}

interface ProjectSummaryFileSnapshot {
  path: string;
  content?: Buffer;
}

function planAgentBootstrapFiles(rootDir: string, now: Date): ProjectSummaryBootstrapPlan {
  const rootRealPath = realpathSync(rootDir);
  const timestamp = timestampForBackup(now);
  const files: ProjectSummaryBootstrapFilePlan[] = [];
  for (const fileName of AGENT_FILE_NAMES) {
    const path = join(rootDir, fileName);
    if (!isInsideRoot(rootRealPath, join(rootRealPath, fileName))) {
      throw new Error(`Unsafe bootstrap destination: ${fileName}`);
    }
    const content = agentBootstrapText(fileName);
    if (!existsSync(path)) {
      files.push({ fileName, path, content, existed: false });
      continue;
    }
    const stats = lstatSync(path, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Bootstrap destination must be a regular non-symlink file: ${fileName}`);
    }
    if (!isInsideRoot(rootRealPath, realpathSync(path))) {
      throw new Error(`Bootstrap destination escapes the project root: ${fileName}`);
    }
    const originalContent = readFileSync(path);
    const current = originalContent.toString("utf8");
    if (current === content) continue;
    const file: ProjectSummaryBootstrapFilePlan = {
      fileName,
      path,
      content,
      existed: true,
      originalContent,
      originalDev: stats.dev,
      originalIno: stats.ino,
      originalSize: stats.size,
      originalMtimeNs: stats.mtimeNs,
      originalHash: hashBytes(originalContent),
      mode: Number(stats.mode)
    };
    if (!isGeneratedBootstrap(current)) {
      file.backupBasePath = join(rootDir, `${fileName}.code-butler-backup-${timestamp}`);
    }
    files.push(file);
  }
  return { rootDir, files };
}

function applyAgentBootstrapPlan(
  plan: ProjectSummaryBootstrapPlan,
  options: ProjectSummaryOperationOptions
): ProjectSummaryBootstrapResult {
  if (plan.files.length === 0) return { backupFiles: [] };
  const stagingDir = mkdtempSync(join(plan.rootDir, ".code-butler-bootstrap-"));
  const staged = new Map<string, string>();
  const backupFiles: string[] = [];
  const appliedFiles: Array<{ file: ProjectSummaryBootstrapFilePlan; rollbackPath?: string }> = [];
  try {
    for (const file of plan.files) {
      const stagedPath = join(stagingDir, file.fileName);
      writeFileSync(stagedPath, file.content);
      if (file.mode !== undefined) chmodSync(stagedPath, file.mode);
      staged.set(file.path, stagedPath);
    }
    for (const file of plan.files) {
      validateBootstrapIdentity(file);
      const stagedPath = staged.get(file.path);
      if (!stagedPath) throw new Error(`Missing staged bootstrap: ${file.fileName}`);
      let rollbackPath: string | undefined;
      if (file.existed) {
        rollbackPath = join(stagingDir, `.rollback-${file.fileName}`);
        renameSync(file.path, rollbackPath);
        if (hashFile(rollbackPath) !== file.originalHash) {
          renameSync(rollbackPath, file.path);
          throw new Error(`Bootstrap destination changed during install: ${file.fileName}`);
        }
      }
      appliedFiles.push({ file, ...(rollbackPath ? { rollbackPath } : {}) });
      if (file.backupBasePath && rollbackPath) {
        backupFiles.push(createCollisionSafeBackup(rollbackPath, file.backupBasePath));
      }
      (options.bootstrapApplyFile ?? renameSync)(stagedPath, file.path);
    }
  } catch (error) {
    for (const applied of appliedFiles.reverse()) restoreAppliedBootstrapFile(applied);
    for (const backupPath of backupFiles) rmSync(backupPath, { force: true });
    throw error;
  } finally {
    rmSync(stagingDir, { force: true, recursive: true });
  }
  return backupFiles.length > 0 ? { backupDir: plan.rootDir, backupFiles } : { backupFiles };
}

function validateBootstrapIdentity(file: ProjectSummaryBootstrapFilePlan): void {
  if (!file.existed) {
    if (existsSync(file.path)) throw new Error(`Bootstrap destination changed during install: ${file.fileName}`);
    return;
  }
  const stats = lstatSync(file.path, { bigint: true });
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.dev !== file.originalDev ||
    stats.ino !== file.originalIno ||
    stats.size !== file.originalSize ||
    stats.mtimeNs !== file.originalMtimeNs
  ) {
    throw new Error(`Bootstrap destination changed during install: ${file.fileName}`);
  }
}

function restoreAppliedBootstrapFile(applied: {
  file: ProjectSummaryBootstrapFilePlan;
  rollbackPath?: string;
}): void {
  rmSync(applied.file.path, { force: true, recursive: true });
  if (applied.rollbackPath && existsSync(applied.rollbackPath)) {
    renameSync(applied.rollbackPath, applied.file.path);
  }
}

function createCollisionSafeBackup(sourcePath: string, basePath: string): string {
  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? basePath : `${basePath}-${suffix}`;
    try {
      copyFileSync(sourcePath, candidate, fsConstants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function backupProjectSummary(summaryPath: string, dataDir: string, now: Date): string {
  const backupRoot = join(dataDir, "backups");
  const backupDir = join(backupRoot, "project-summary");
  ensureContainedDirectory(dataDir, backupRoot);
  ensureContainedDirectory(dataDir, backupDir);
  const basePath = join(backupDir, `project-summary-${timestampForBackup(now)}.md`);
  return createCollisionSafeBackup(summaryPath, basePath);
}

function ensureContainedDirectory(dataDir: string, path: string): void {
  const dataDirRealPath = realpathSync(dataDir);
  if (!existsSync(path)) mkdirSync(path);
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !isInsideRoot(dataDirRealPath, realpathSync(path))) {
    throw new Error(`Project summary backup directory is unsafe: ${path}`);
  }
}

function hashBytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function hashFile(path: string): string {
  return hashBytes(readFileSync(path));
}

function snapshotProjectSummaryFiles(rootDir: string): ProjectSummaryFileSnapshot[] {
  const paths = projectSummaryPaths(rootDir);
  return [paths.summaryPath, paths.metaPath].map((path) => ({
    path,
    ...(existsSync(path) ? { content: readFileSync(path) } : {})
  }));
}

function restoreProjectSummaryFiles(snapshots: ProjectSummaryFileSnapshot[]): void {
  for (const snapshot of snapshots) {
    rmSync(snapshot.path, { force: true, recursive: true });
    if (snapshot.content) writeFileSync(snapshot.path, snapshot.content);
  }
}

function isInsideRoot(rootRealPath: string, candidatePath: string): boolean {
  const pathFromRoot = relative(rootRealPath, candidatePath);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function createFallbackProjectSummaryGenerator(error: unknown): ProjectSummaryGenerator {
  return {
    name: "fallback",
    async generate(input): Promise<string> {
      const manifests = input.codeContext.manifests.map((file) => `- ${file.path}`).join("\n") || "- none indexed";
      const docs = input.codeContext.docs.map((file) => `- ${file.path}`).join("\n") || "- none indexed";
      const inventory = input.codeContext.inventory.slice(0, 30).map((entry) => `- ${entry}`).join("\n") || "- none indexed";
      const memories = input.codeContext.memories
        .slice(0, 10)
        .map((memory) => `- ${memory.type}: ${memory.title} - ${memory.summary}`)
        .join("\n") || "- none indexed";
      const commits = input.codeContext.commits
        .slice(0, 10)
        .map((commit) => `- ${commit.hash.slice(0, 12)} ${commit.message}`)
        .join("\n") || "- none indexed";
      return [
        "# Fallback Project Summary",
        "",
        "This is a limited fallback summary created without an API-backed model.",
        "Add the configured project-summary API key, then run `code-butler project-summary refresh --force` to regenerate a richer summary.",
        "",
        `Project root: ${input.projectRoot}`,
        "",
        "## Why This Fallback Was Used",
        fallbackErrorMessage(error),
        "",
        "## Indexed Manifests",
        manifests,
        "",
        "## Indexed Docs",
        docs,
        "",
        "## Project Inventory",
        inventory,
        "",
        "## Durable Memories",
        memories,
        "",
        "## Recent Commits",
        commits,
        "",
        "## Agent Usage",
        "Use Code Butler MCP tools such as `sync_project_memory`, `summarize_project_brief`, `summarize_active_context`, `search_project_memory`, and `explain_code_change` for current project context."
      ].join("\n");
    }
  };
}

function fallbackSummaryWarning(error: unknown): string {
  return [
    `Code Butler fallback summary was created because the configured project-summary provider was unavailable: ${fallbackErrorMessage(error)}`,
    "After adding the required API key, run `code-butler project-summary refresh --force` to regenerate the richer summary."
  ].join(" ");
}

function fallbackErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectRoot(config: ProjectConfig, store: MemoryStore): string {
  return config.sources.git.repoPath || store.paths.rootDir;
}

function readAgentHints(rootDir: string, trackedPaths: ReadonlySet<string>): ProjectSummaryAgentHint[] {
  const hints: ProjectSummaryAgentHint[] = [];
  for (const fileName of AGENT_FILE_NAMES) {
    const file = readProjectSummaryTrackedFile(rootDir, fileName, trackedPaths);
    if (!file || isGeneratedBootstrap(file.content)) continue;
    hints.push({
      fileName,
      content: file.content,
      contentHash: file.contentHash,
      originalBytes: file.originalBytes,
      truncated: file.truncated
    });
  }
  return hints;
}

function isGeneratedBootstrap(content: string): boolean {
  return (
    content.includes("This file tells") &&
    content.includes("Code Butler") &&
    content.includes(".code-butler/project-summary.md") &&
    content.includes("summarize_project_brief")
  );
}

function readTrackedTextFiles(
  rootDir: string,
  relativePaths: readonly string[],
  trackedPaths: ReadonlySet<string>
): ProjectSummaryTextFile[] {
  const files: ProjectSummaryTextFile[] = [];
  for (const relativePath of relativePaths) {
    const file = readProjectSummaryTrackedFile(rootDir, relativePath, trackedPaths);
    if (!file) continue;
    files.push({
      path: file.path,
      content: file.content,
      contentHash: file.contentHash,
      originalBytes: file.originalBytes,
      truncated: file.truncated
    });
  }
  return files;
}

function readTrackedManifestFiles(
  rootDir: string,
  relativePaths: readonly string[],
  trackedPaths: ReadonlySet<string>
): ProjectSummaryTextFile[] {
  const files: ProjectSummaryTextFile[] = [];
  let transmittedChars = 0;
  for (const relativePath of relativePaths) {
    if (files.length >= MAX_MANIFEST_FILES || transmittedChars >= MAX_MANIFEST_CONTENT_CHARS) break;
    const remainingChars = MAX_MANIFEST_CONTENT_CHARS - transmittedChars;
    const file = readProjectSummaryTrackedFile(
      rootDir,
      relativePath,
      trackedPaths,
      Math.min(MAX_PROJECT_SUMMARY_FILE_CHARS, remainingChars)
    );
    if (!file) continue;
    files.push({
      path: file.path,
      content: file.content,
      contentHash: file.contentHash,
      originalBytes: file.originalBytes,
      truncated: file.truncated
    });
    transmittedChars += file.content.length;
  }
  return files;
}

function discoverManifestPaths(trackedPaths: ReadonlySet<string>): string[] {
  const fixedPaths: string[] = [];
  const fixedPathSet = new Set<string>();
  for (const path of MANIFEST_PATHS) {
    if (!trackedPaths.has(path)) continue;
    fixedPaths.push(path);
    fixedPathSet.add(path);
  }
  const nestedPaths: string[] = [];
  for (const path of trackedPaths) {
    if (!fixedPathSet.has(path) && NESTED_MANIFEST_BASENAMES.has(posix.basename(path))) {
      nestedPaths.push(path);
    }
  }
  return [...fixedPaths, ...nestedPaths.sort()];
}

function fingerprintProjectSummaryInputs(input: Omit<ProjectSummaryGeneratorInput, "fingerprint">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        projectRoot: input.projectRoot,
        agentHints: input.agentHints,
        notes: input.notes,
        manifests: input.codeContext.manifests,
        docs: input.codeContext.docs,
        codeFiles: input.codeContext.codeFiles,
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
    "- If Code Butler MCP tools are not visible, use the client's tool discovery for `code-butler` or `current_project` before falling back to files or git.",
    "- When the user asks to remember, save, or note a project memory, call `current_project`, then `remember_project_memory`, then verify with `find_memories`; do not inspect or write SQLite directly.",
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

export function relativeSummaryPath(rootDir: string, absolutePath: string): string {
  const relativePath = relative(rootDir, absolutePath);
  return relativePath.startsWith("..") ? absolutePath : relativePath;
}
