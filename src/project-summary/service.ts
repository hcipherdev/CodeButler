import { assembleHumanSummary, selectSummaryMemories } from "./memory-sections.js";
import { GLOBAL_RULES_INSTRUCTIONS, LEGACY_GLOBAL_RULES_INSTRUCTIONS } from "../rules/match.js";
import { atomicWrite } from "../cloud/state.js";
import type { ProjectSetupStatus } from "../project-setup.js";
import { runArtifactMaintenance } from "../maintenance/artifacts.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gitExecutable } from "../git-executable.js";
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
const SUMMARY_FORMAT = 2;
const DAILY_REFRESH_MS = 24 * 60 * 60 * 1000;
/** Memory-only changes keep the prose until it is this old; then the next refresh rewrites it. */
const MEMORY_ONLY_PROSE_MAX_AGE_MS = 7 * DAILY_REFRESH_MS;
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
  generate(input: ProjectSummaryGeneratorInput, signal?: AbortSignal): Promise<string>;
}

export interface ProjectSummaryMeta {
  version: 1;
  format?: number;
  summaryPath: string;
  fingerprint: string;
  outputContentHash?: string;
  lastGeneratedAt?: string;
  lastCheckedAt?: string;
  provider?: string;
  /** Set when the current file was adopted rather than generated: who authored it and when. */
  contentSource?: "git" | "edited";
  contentUpdatedAt?: string;
  contentCommit?: string;
  /** What a generated narrative was built from, so later checks can say what changed since. */
  inputDigest?: ProjectSummaryInputDigest;
  /** The newest commit a generated narrative was built from; decides which of two devices' narratives is current. */
  basis?: ProjectSummaryBasis;
  /** When the memory sections were last re-rendered around unchanged prose; `lastGeneratedAt` still dates the prose. */
  memorySectionsUpdatedAt?: string;
}

export interface ProjectSummaryBasis {
  commit: string;
  committedAt: string;
}

export interface ProjectSummaryInputDigest {
  commits: string[];
  /** Short hash per narrative memory, over the same fields the fingerprint uses. */
  memories: Record<string, string>;
  files: string;
}

/** Counted against the inputs the narrative was written from; `memories` and `files` are unknown without a digest. */
export interface ProjectSummaryChanges {
  commits: number;
  commitsCapped: boolean;
  memories?: number;
  files?: boolean;
}

export interface ProjectBrief {
  exists: boolean;
  summaryPath: string;
  summary: string;
  meta?: ProjectSummaryMeta;
  setup?: ProjectSetupStatus;
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
  contentSource?: "git" | "edited";
  contentUpdatedAt?: string;
  contentCommit?: string;
  /** When the text in the file was written: the adopted commit or edit, otherwise the generation. */
  writtenAt?: string;
  changesSince?: ProjectSummaryChanges;
  /** Stale and not rewritten for a day, which the daily refresh would normally have done. */
  refreshRecommended: boolean;
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
  /** Only memories changed, so the memory sections were re-rendered and the prose kept. */
  memorySectionsOnly?: boolean;
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
  /** Repair missing bootstrap files without replacing later user edits. */
  preserveExistingAgentFiles?: boolean;
  /** Wraps the model call, e.g. so the MCP server can release the project lock while it waits. */
  aroundModelCall?: <T>(call: () => Promise<T>) => Promise<T>;
}

interface ProjectSummaryInputOptions {
  omitAgentHints?: boolean;
  projectState?: ProjectSummary;
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
  options: { store?: MemoryStore; config?: ProjectConfig; now?: () => Date; projectState?: ProjectSummary } = {}
): ProjectSummaryStatus {
  const paths = projectSummaryPaths(rootDir);
  const meta = readProjectSummaryMeta(rootDir);
  const now = (options.now ?? (() => new Date()))();
  let currentInput: ProjectSummaryGeneratorInput | undefined;
  if (options.store && options.config) {
    currentInput = collectProjectSummaryInputInternal(options.store, options.config, {
      ...(options.projectState ? { projectState: options.projectState } : {})
    });
  }
  const currentFingerprint = currentInput?.fingerprint;
  const stale =
    !existsSync(paths.summaryPath) ||
    meta === undefined || meta.format !== SUMMARY_FORMAT ||
    (currentFingerprint !== undefined && meta.fingerprint !== currentFingerprint);
  const outputHash = existsSync(paths.summaryPath) ? hashFile(paths.summaryPath) : undefined;
  const outputBaselineMissing = existsSync(paths.summaryPath) && meta?.outputContentHash === undefined;
  // Adopted uncommitted edits stay protected; content adopted from a git commit may be replaced.
  const manualEditsDetected =
    outputHash !== undefined &&
    meta?.outputContentHash !== undefined &&
    (outputHash !== meta.outputContentHash || meta.contentSource === "edited");
  const status: ProjectSummaryStatus = {
    exists: existsSync(paths.summaryPath),
    summaryPath: paths.summaryPath,
    metaPath: paths.metaPath,
    due: isSummaryRefreshDue(meta, now),
    stale,
    manualEditsDetected,
    outputBaselineMissing,
    refreshRecommended: false
  };
  if (meta?.fingerprint !== undefined) status.fingerprint = meta.fingerprint;
  if (currentFingerprint !== undefined) status.currentFingerprint = currentFingerprint;
  if (meta?.lastGeneratedAt !== undefined) status.lastGeneratedAt = meta.lastGeneratedAt;
  if (meta?.lastCheckedAt !== undefined) status.lastCheckedAt = meta.lastCheckedAt;
  if (meta?.provider !== undefined) status.provider = meta.provider;
  if (meta?.contentSource !== undefined && outputHash === meta.outputContentHash) {
    status.contentSource = meta.contentSource;
    if (meta.contentUpdatedAt !== undefined) status.contentUpdatedAt = meta.contentUpdatedAt;
    if (meta.contentCommit !== undefined) status.contentCommit = meta.contentCommit;
  }
  const writtenAt = status.contentUpdatedAt ?? meta?.lastGeneratedAt;
  if (writtenAt !== undefined) status.writtenAt = writtenAt;
  // The digest describes generated content only; adopted or edited text is dated, not diffed.
  if (currentInput) status.changesSince = summaryChangesSince(currentInput, status.contentSource ? undefined : meta?.inputDigest, writtenAt);
  const writtenMs = Date.parse(writtenAt ?? "");
  status.refreshRecommended = status.exists && stale && (!Number.isFinite(writtenMs) || now.getTime() - writtenMs >= DAILY_REFRESH_MS);
  return status;
}

/** Commits, narrative memories and project files that differ from what the narrative was written from. */
function summaryChangesSince(input: ProjectSummaryGeneratorInput, digest: ProjectSummaryInputDigest | undefined, writtenAt: string | undefined): ProjectSummaryChanges {
  const commits = input.codeContext.commits;
  const capped = (count: number) => ({ commits: count, commitsCapped: count >= commits.length && commits.length >= SUMMARY_INPUT_COMMITS });
  if (!digest) {
    const since = Date.parse(writtenAt ?? "");
    return capped(Number.isFinite(since) ? commits.filter(commit => Date.parse(commit.authoredAt) > since).length : 0);
  }
  const known = new Set(digest.commits), current = summaryInputDigest(input);
  const ids = new Set([...Object.keys(digest.memories), ...Object.keys(current.memories)]);
  return {
    ...capped(commits.filter(commit => !known.has(commit.hash)).length),
    memories: [...ids].filter(id => digest.memories[id] !== current.memories[id]).length,
    files: digest.files !== current.files
  };
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
  const bootstrapPlan = planAgentBootstrapFiles(rootDir, nowDate(options), options.preserveExistingAgentFiles);
  const summarySnapshot = snapshotProjectSummaryFiles(rootDir);
  const existing = readProjectBrief(rootDir);
  let refreshed: ProjectSummaryRefreshResult = { checked: false, generated: false, summaryPath: existing.summaryPath };
  let fallback = false;
  let bootstrap: ProjectSummaryBootstrapResult;
  try {
    if (existing.exists && existing.summary.trim()) {
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
            generator: fallbackGenerator
          },
          { omitAgentHints: true }
        );
        const message = fallbackSummaryWarning(error);
        options.warn?.(message);
      }
    }
    bootstrap = applyAgentBootstrapPlan(bootstrapPlan, options);
  } catch (error) {
    // The summary writer already rolls back failed writes. Only undo our completed
    // generation; a user may have edited a preserved summary while bootstrap failed.
    if (refreshed.generated && refreshed.meta?.outputContentHash &&
      existsSync(refreshed.summaryPath) && hashFile(refreshed.summaryPath) === refreshed.meta.outputContentHash &&
      existsSync(projectSummaryPaths(rootDir).metaPath) &&
      hashFile(projectSummaryPaths(rootDir).metaPath) === hashBytes(Buffer.from(serializeProjectSummaryMeta(refreshed.meta)))) {
      restoreProjectSummaryFiles(summarySnapshot);
    }
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
  const contentChanged =
    Boolean(existing.summary.trim()) &&
    existingOutputHash !== undefined &&
    existing.meta?.outputContentHash !== undefined &&
    existingOutputHash !== existing.meta.outputContentHash;
  const hasContent = Boolean(existing.summary.trim());
  const outputBaselineMissing = hasContent && existing.meta?.outputContentHash === undefined;
  // The file on disk wins: record unrecognized content as the new baseline before deciding whether it may be replaced.
  const unrecorded = contentChanged || (outputBaselineMissing && existing.meta?.fingerprint !== input.fingerprint);
  const baseline = !options.force && unrecorded ? adoptExistingSummary(rootDir, existing.meta, existingOutputHash!, now) : existing.meta;
  // Only uncommitted edits are protected; a committed summary stays recoverable from git, so it is replaced with a backup.
  const replacingCommitted = hasContent && baseline?.contentSource === "git";

  if (!options.force && hasContent && baseline?.contentSource === "edited") {
    return {
      checked: true,
      generated: false,
      summaryPath: paths.summaryPath,
      fingerprint: input.fingerprint,
      ...(baseline ? { meta: baseline } : {}),
      ...(outputBaselineMissing
        ? { skippedReason: "output_baseline_missing" }
        : { skippedReason: "manual_edits_detected", manualEditsDetected: true })
    };
  }

  if (!options.force && existing.summary.trim() && existing.meta?.fingerprint === input.fingerprint && existing.meta.format === SUMMARY_FORMAT) {
    // Unchanged inputs are exactly what the narrative was built from, so an older meta gains its digest here.
    const meta = normalizeMeta({
      ...existing.meta,
      summaryPath: paths.summaryPath,
      ...(existingOutputHash ? { outputContentHash: existingOutputHash } : {}),
      lastCheckedAt: now.toISOString(),
      ...(existing.meta.contentSource === undefined ? { inputDigest: summaryInputDigest(input), ...summaryBasis(input) } : {})
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

  // A concurrent edit wins over either write; the caller reports it as a manual edit.
  const commitOutputs = (content: string, meta: ProjectSummaryMeta, expected: ExpectedProjectSummaryOutput): boolean => {
    try {
      writeProjectSummaryOutputsAtomically(
        rootDir,
        [
          { path: paths.summaryPath, content },
          { path: paths.metaPath, content: serializeProjectSummaryMeta(meta) }
        ],
        options,
        expected
      );
      return true;
    } catch (error) {
      if (!(error instanceof ConcurrentProjectSummaryEditError)) throw error;
      return false;
    }
  };
  const editedDuringRefresh = (backupPath?: string): ProjectSummaryRefreshResult => ({
    checked: true,
    generated: false,
    summaryPath: paths.summaryPath,
    fingerprint: input.fingerprint,
    ...(existing.meta ? { meta: existing.meta } : {}),
    skippedReason: "manual_edits_detected",
    manualEditsDetected: true,
    ...(backupPath ? { backupPath } : {})
  });

  // Memories alone moved: re-render the sections built from them and keep the prose, unless it is a week old.
  const digest = summaryInputDigest(input);
  const proseWrittenMs = Date.parse(existing.meta?.lastGeneratedAt ?? "");
  if (!options.force && hasContent && existingOutputHash !== undefined && existing.meta !== undefined &&
    baseline === existing.meta && existing.meta.contentSource === undefined && existing.meta.format === SUMMARY_FORMAT &&
    isMemoryOnlyChange(existing.meta.inputDigest, digest) &&
    Number.isFinite(proseWrittenMs) && now.getTime() - proseWrittenMs < MEMORY_ONLY_PROSE_MAX_AGE_MS) {
    const content = `${store.contentPolicy.text(assembleHumanSummary(input.codeContext.memories, existing.summary)).trim()}\n`;
    const meta = normalizeMeta({
      ...existing.meta,
      summaryPath: paths.summaryPath,
      fingerprint: input.fingerprint,
      outputContentHash: hashBytes(Buffer.from(content)),
      lastCheckedAt: now.toISOString(),
      inputDigest: digest,
      memorySectionsUpdatedAt: now.toISOString()
    });
    if (!commitOutputs(content, meta, { exists: true, contentHash: existingOutputHash })) return editedDuringRefresh();
    return {
      checked: true,
      generated: true,
      memorySectionsOnly: true,
      summaryPath: paths.summaryPath,
      fingerprint: input.fingerprint,
      meta
    };
  }

  let backupPath: string | undefined;
  if (existing.exists && (replacingCommitted ||
    (options.force && (contentChanged || outputBaselineMissing || existing.meta?.contentSource !== undefined)))) {
    backupPath = backupProjectSummary(paths.summaryPath, paths.dataDir, now);
  }

  const generator = options.generator ?? createConfiguredProjectSummaryGenerator(config);
  const generate = () => generator.generate(input);
  const generated = (await (options.aroundModelCall ? options.aroundModelCall(generate) : generate())).trim();
  const summary = generated ? store.contentPolicy.text(assembleHumanSummary(input.codeContext.memories, generated)).trim() : "";
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
  // Stamp the write, not the start of the refresh: generation can take minutes.
  const generatedAt = nowDate(options).toISOString();
  const metaInput: ProjectSummaryMeta = {
    version: SUMMARY_VERSION,
    format: SUMMARY_FORMAT,
    summaryPath: paths.summaryPath,
    fingerprint: input.fingerprint,
    outputContentHash: hashBytes(Buffer.from(summaryContent)),
    lastGeneratedAt: generatedAt,
    lastCheckedAt: generatedAt,
    inputDigest: digest,
    ...summaryBasis(input)
  };
  if (generator.name !== undefined) metaInput.provider = generator.name;
  const meta = normalizeMeta(metaInput);
  if (!commitOutputs(summaryContent, meta, {
    exists: outputExistsBeforeCommit,
    ...(outputHashBeforeCommit ? { contentHash: outputHashBeforeCommit } : {})
  })) return editedDuringRefresh(backupPath);
  try {
    runArtifactMaintenance(rootDir, config.retention!.artifacts, { apply: true, now });
  } catch {
    // Summary refresh is already committed; artifact cleanup is best effort.
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

const SUMMARY_OUTPUT_PATHS = new Set([".code-butler/project-summary.md", ".code-butler/project-summary.meta.json"]);

/**
 * The recent commits a summary is built from. Commits that only record the summary itself are left out:
 * they say nothing about the project, and counting them would make every committed summary stale.
 */
const SUMMARY_INPUT_COMMITS = 20;
export function findSummaryInputCommits(store: Pick<MemoryStore, "findCommits">, limit = SUMMARY_INPUT_COMMITS): CommitRecord[] {
  return store.findCommits({ limit: limit * 5 })
    .filter(commit => !(commit.changedFiles.length > 0 &&
      commit.changedFiles.every(path => SUMMARY_OUTPUT_PATHS.has(path.replaceAll("\\", "/").replace(/^\.\//, "")))))
    .slice(0, limit);
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
  const memories = selectSummaryMemories(store);
  // File selection can use other current memories without publishing their claims
  // in the project-wide decision and constraint sections.
  const codeMemories = store.listMemories({ lifecycleStatus: "current", layer: "all", owner: "self", qualityStatus: "all", limit: null });
  const commits = findSummaryInputCommits(store);
  const agentHints = options.omitAgentHints ? [] : readAgentHints(rootDir, trackedPaths);
  const notes = readProjectSummaryNotes(rootDir);
  const codeContext: ProjectSummaryCodeContext = {
    manifests,
    docs,
    codeFiles: collectProjectSummaryCodeFiles(rootDir, { manifests, memories: codeMemories, commits }, trackedPaths),
    inventory: listProjectSummarySafeTrackedPaths(rootDir, trackedPaths, MAX_INVENTORY_ENTRIES),
    memories,
    commits,
    projectState: options.projectState ?? store.getProjectSummary()
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

/**
 * Whether another device's narrative should replace this one, and the metadata to store with it. The one built
 * from later commits wins; the write time only settles narratives built from the same commit, or one without a
 * recorded basis. Text edited here by hand, or a pair whose text does not match its own record, never wins.
 */
export function preferIncomingNarrative(
  rootDir: string,
  incoming: { summary?: Buffer | undefined; meta?: Buffer | undefined }
): { take: false } | { take: true; meta: ProjectSummaryMeta } {
  if (!incoming.summary || !incoming.meta) return { take: false };
  let theirs: ProjectSummaryMeta;
  try { theirs = normalizeMeta(JSON.parse(incoming.meta.toString("utf8")) as Partial<ProjectSummaryMeta>); } catch { return { take: false }; }
  // A pair whose text does not match its own record was edited without one, so its date says nothing.
  if (theirs.outputContentHash !== hashBytes(incoming.summary)) return { take: false };
  const paths = projectSummaryPaths(rootDir);
  const take = { take: true as const, meta: normalizeMeta({ ...theirs, summaryPath: paths.summaryPath }) };
  const writtenAt = (meta: ProjectSummaryMeta) => Date.parse(meta.contentUpdatedAt ?? meta.lastGeneratedAt ?? "");
  const theirTime = writtenAt(theirs);
  if (!existsSync(paths.summaryPath)) return Number.isFinite(theirTime) ? take : { take: false };
  const ours = readProjectSummaryMeta(rootDir);
  if (ours?.contentSource === "edited" || hashFile(paths.summaryPath) !== ours?.outputContentHash) return { take: false };
  const order = basisOrder(rootDir, ours.basis, theirs.basis);
  if (order !== 0) return order > 0 ? take : { take: false };
  const ourTime = writtenAt(ours);
  if (!Number.isFinite(theirTime) || theirTime <= (Number.isFinite(ourTime) ? ourTime : Number.NEGATIVE_INFINITY)) return { take: false };
  return take;
}

/** Positive when `theirs` was built from later commits, negative when `ours` was, 0 when unknown or the same. */
function basisOrder(rootDir: string, ours: ProjectSummaryBasis | undefined, theirs: ProjectSummaryBasis | undefined): number {
  if (!ours || !theirs || ours.commit === theirs.commit) return 0;
  if (isAncestorCommit(rootDir, ours.commit, theirs.commit)) return 1;
  if (isAncestorCommit(rootDir, theirs.commit, ours.commit)) return -1;
  // Diverged, or a commit this checkout has not fetched: the later commit is the better guess.
  const difference = Date.parse(theirs.committedAt) - Date.parse(ours.committedAt);
  return Number.isFinite(difference) ? Math.sign(difference) : 0;
}

function isAncestorCommit(rootDir: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync(gitExecutable(), ["-C", rootDir, "merge-base", "--is-ancestor", ancestor, descendant], {
      stdio: "ignore", timeout: 5000, windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * A cloud merge republishes this device's files, so a narrative another device wrote more recently would be
 * replaced by an older one. Takes the other side's narrative and metadata as one pair when
 * preferIncomingNarrative() says so. Returns whether the pair was taken.
 */
export function adoptNewerNarrative(rootDir: string, incoming: { summary?: Buffer | undefined; meta?: Buffer | undefined }): boolean {
  const decision = preferIncomingNarrative(rootDir, incoming);
  if (!decision.take) return false;
  const paths = projectSummaryPaths(rootDir);
  const localHash = existsSync(paths.summaryPath) ? hashFile(paths.summaryPath) : undefined;
  try {
    writeProjectSummaryOutputsAtomically(rootDir, [
      { path: paths.summaryPath, content: incoming.summary!.toString("utf8") },
      { path: paths.metaPath, content: serializeProjectSummaryMeta(decision.meta) }
    ], {}, { exists: localHash !== undefined, ...(localHash ? { contentHash: localHash } : {}) });
    return true;
  } catch (error) {
    // Edited while merging: the edit wins, as it would anywhere else.
    if (error instanceof ConcurrentProjectSummaryEditError) return false;
    throw error;
  }
}

/**
 * Records a summary that Code Butler did not generate as the current baseline. The fingerprint is
 * cleared because the content was never produced from the current inputs, so the summary stays stale.
 */
function adoptExistingSummary(rootDir: string, previous: ProjectSummaryMeta | undefined, contentHash: string, now: Date): ProjectSummaryMeta {
  const paths = projectSummaryPaths(rootDir);
  const meta = normalizeMeta({
    ...(previous?.lastGeneratedAt !== undefined ? { lastGeneratedAt: previous.lastGeneratedAt } : {}),
    ...(previous?.provider !== undefined ? { provider: previous.provider } : {}),
    version: SUMMARY_VERSION,
    format: SUMMARY_FORMAT,
    summaryPath: paths.summaryPath,
    fingerprint: "",
    outputContentHash: contentHash,
    lastCheckedAt: now.toISOString(),
    ...summaryContentOrigin(rootDir, paths.summaryPath, now)
  });
  writeProjectSummaryMeta(rootDir, meta);
  return meta;
}

/** Dates adopted content by its last commit when the file matches it, otherwise by when the edit was noticed. */
function summaryContentOrigin(rootDir: string, summaryPath: string, now: Date): Pick<ProjectSummaryMeta, "contentSource" | "contentUpdatedAt" | "contentCommit"> {
  const path = relative(rootDir, summaryPath).split(sep).join("/");
  const git = (args: string[]) => execFileSync(gitExecutable(), ["-C", rootDir, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true
  }).trim();
  try {
    git(["ls-files", "--error-unmatch", "--", path]);
    git(["diff", "--quiet", "HEAD", "--", path]);
    const [commit, committedAt] = git(["log", "-1", "--format=%h%n%cI", "--", path]).split("\n");
    const date = committedAt ? new Date(committedAt) : undefined;
    if (commit && date && Number.isFinite(date.getTime())) {
      return { contentSource: "git", contentUpdatedAt: date.toISOString(), contentCommit: commit };
    }
  } catch {
    // Untracked, changed since the last commit, or Git unavailable.
  }
  return { contentSource: "edited", contentUpdatedAt: now.toISOString() };
}

function writeProjectSummaryMeta(rootDir: string, meta: ProjectSummaryMeta): void {
  const paths = projectSummaryPaths(rootDir);
  writeProjectSummaryOutputsAtomically(rootDir, [
    { path: paths.metaPath, content: serializeProjectSummaryMeta(meta) }
  ]);
}

export function serializeProjectSummaryMeta(meta: ProjectSummaryMeta): string {
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
  if (typeof input.format === "number") meta.format = input.format;
  if (input.lastGeneratedAt !== undefined) meta.lastGeneratedAt = input.lastGeneratedAt;
  if (input.lastCheckedAt !== undefined) meta.lastCheckedAt = input.lastCheckedAt;
  if (input.provider !== undefined) meta.provider = input.provider;
  if (input.contentSource === "git" || input.contentSource === "edited") meta.contentSource = input.contentSource;
  if (typeof input.contentUpdatedAt === "string") meta.contentUpdatedAt = input.contentUpdatedAt;
  if (typeof input.contentCommit === "string") meta.contentCommit = input.contentCommit;
  if (typeof input.outputContentHash === "string" && /^[a-f0-9]{64}$/.test(input.outputContentHash)) {
    meta.outputContentHash = input.outputContentHash;
  }
  if (typeof input.memorySectionsUpdatedAt === "string") meta.memorySectionsUpdatedAt = input.memorySectionsUpdatedAt;
  if (isInputDigest(input.inputDigest)) meta.inputDigest = input.inputDigest;
  const basis = input.basis as Partial<ProjectSummaryBasis> | null | undefined;
  if (basis && typeof basis.commit === "string" && typeof basis.committedAt === "string") meta.basis = { commit: basis.commit, committedAt: basis.committedAt };
  return meta;
}

function isInputDigest(value: unknown): value is ProjectSummaryInputDigest {
  const digest = value as Partial<ProjectSummaryInputDigest> | null | undefined;
  return !!digest && typeof digest === "object" && typeof digest.files === "string" &&
    Array.isArray(digest.commits) && digest.commits.every(hash => typeof hash === "string") &&
    !!digest.memories && typeof digest.memories === "object" && Object.values(digest.memories).every(hash => typeof hash === "string");
}

function isSummaryRefreshDue(meta: ProjectSummaryMeta | undefined, now: Date): boolean {
  if (meta?.format !== SUMMARY_FORMAT || !meta.lastCheckedAt) return true;
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

function planAgentBootstrapFiles(rootDir: string, now: Date, preserveExisting = false): ProjectSummaryBootstrapPlan {
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
    if (preserveExisting && current.trim()) continue;
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
    file.backupBasePath = join(rootDir, `${fileName}.code-butler-backup-${timestamp}`);
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

export function createFallbackProjectSummaryGenerator(_error: unknown): ProjectSummaryGenerator {
  return { ...createLocalProjectSummaryGenerator(), name: "fallback" };
}

/** A readable initial summary, built from repository facts without a provider. */
export function createLocalProjectSummaryGenerator(): ProjectSummaryGenerator {
  return {
    name: "local",
    async generate(input) {
      const context = input.codeContext;
      const manifests = context.manifests.filter(f => f.path.endsWith("package.json")).flatMap(f => {
        try { return [{ path: f.path, value: JSON.parse(f.content) as Record<string, unknown> }]; } catch { return []; }
      });
      const rootManifest = manifests.find(m => m.path === "package.json")?.value;
      const description = typeof rootManifest?.description === "string" ? rootManifest.description : undefined;
      const readme = context.docs.find(f => f.path === "README.md")?.content;
      const paragraph = readme?.split(/\r?\n\s*\r?\n/).find(p => p.trim() && !/^(?:#|!\[|\[!\[|<!--|\x60\x60\x60|[-*] )/.test(p.trim()));
      const directories = [...new Set(context.inventory.filter(p => p.includes("/")).map(p => p.split("/")[0]!))]
        .filter(p => !p.startsWith(".")).slice(0, 12);
      const scripts = rootManifest?.scripts && typeof rootManifest.scripts === "object"
        ? Object.keys(rootManifest.scripts).filter(k => /^(?:test|build|typecheck|lint)$/.test(k)) : [];
      return [
        "## What this is", description || paragraph?.trim() || "A project whose purpose has not been documented yet.", "",
        "## How it's built",
        context.manifests.length ? "Build and dependency definitions: " + context.manifests.filter(f => !/lock/.test(f.path)).map(f => "\x60" + f.path + "\x60").join(", ") + "." : "Build details have not been documented yet.",
        directories.length ? "Repository areas: " + directories.map(p => "\x60" + p + "/\x60").join(", ") + "." : "", "",
        "## Where things stand",
        context.commits.length ? context.commits.slice(0, 5).map(c => "- " + c.message.split("\n")[0]).join("\n") : "No recent project changes have been recorded.", "",
        "## Open risks and questions", "Check the project issue tracker and current work for open questions.", "",
        "## How to verify changes",
        scripts.length ? scripts.map(k => "- \x60npm run " + k + "\x60").join("\n") : "Use the verification commands documented in the repository."
      ].join("\n");
    }
  };
}

/** Commit already generated content while retaining concurrent-edit checks. */
export function commitPreparedProjectSummary(
  root: string, input: ProjectSummaryGeneratorInput, summary: string, provider: string,
  expectedHash: string, options: ProjectSummaryOperationOptions = {}
): void {
  preflightProjectSummaryOutputs(root);
  if (!summary.trim()) throw new Error("Project summary generator returned empty content");
  const paths = projectSummaryPaths(root);
  const content = `${assembleHumanSummary(input.codeContext.memories, summary).trim()}\n`;
  const now = nowDate(options).toISOString();
  const meta: ProjectSummaryMeta = {
    version: 1, format: SUMMARY_FORMAT, summaryPath: paths.summaryPath, fingerprint: input.fingerprint,
    outputContentHash: hashBytes(Buffer.from(content)), lastGeneratedAt: now,
    lastCheckedAt: now, provider, inputDigest: summaryInputDigest(input), ...summaryBasis(input)
  };
  writeProjectSummaryOutputsAtomically(root, [
    { path: paths.summaryPath, content },
    { path: paths.metaPath, content: serializeProjectSummaryMeta(meta) }
  ], options, { exists: true, contentHash: expectedHash });
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

/** The parts of a memory the narrative is written from; the fingerprint and the digest both use exactly these. */
function summaryMemoryFields(memory: MemorySearchResult) {
  return {
    kind: memory.kind,
    id: memory.id,
    type: memory.type,
    title: memory.title,
    scope: memory.scope,
    applicability: memory.applicability,
    summary: memory.summary,
    statement: memory.statement,
    layer: memory.layer,
    reason: memory.reason,
    relatedFiles: memory.relatedFiles
  };
}

function shortHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/** Same commits and files, different memories: the prose was written from everything that still matches. */
function isMemoryOnlyChange(previous: ProjectSummaryInputDigest | undefined, current: ProjectSummaryInputDigest): boolean {
  if (!previous || previous.files !== current.files || previous.commits.length !== current.commits.length ||
    previous.commits.some((hash, index) => hash !== current.commits[index])) return false;
  const ids = new Set([...Object.keys(previous.memories), ...Object.keys(current.memories)]);
  return [...ids].some(id => previous.memories[id] !== current.memories[id]);
}

export function summaryInputDigest(input: Omit<ProjectSummaryGeneratorInput, "fingerprint">): ProjectSummaryInputDigest {
  return {
    commits: input.codeContext.commits.map(commit => commit.hash),
    memories: Object.fromEntries(input.codeContext.memories.map(memory => [memory.id, shortHash(summaryMemoryFields(memory))])),
    files: shortHash({
      agentHints: input.agentHints, notes: input.notes, manifests: input.codeContext.manifests, docs: input.codeContext.docs,
      codeFiles: input.codeContext.codeFiles, inventory: input.codeContext.inventory
    })
  };
}

/** The newest commit the inputs hold; commits arrive newest first, with summary-only commits already left out. */
function summaryBasis(input: Omit<ProjectSummaryGeneratorInput, "fingerprint">): { basis?: ProjectSummaryBasis } {
  const newest = input.codeContext.commits[0];
  return newest ? { basis: { commit: newest.hash, committedAt: newest.authoredAt } } : {};
}

function fingerprintProjectSummaryInputs(input: Omit<ProjectSummaryGeneratorInput, "fingerprint">): string {
  // Operational counters and temporary expiry do not change narrative content.
  return createHash("sha256")
    .update(
      JSON.stringify({
        format: SUMMARY_FORMAT,
        projectRoot: input.projectRoot,
        agentHints: input.agentHints,
        notes: input.notes,
        manifests: input.codeContext.manifests,
        docs: input.codeContext.docs,
        codeFiles: input.codeContext.codeFiles,
        inventory: input.codeContext.inventory,
        memories: input.codeContext.memories.map(summaryMemoryFields),
        commits: input.codeContext.commits.map((commit) => ({
          hash: commit.hash,
          authoredAt: commit.authoredAt,
          message: commit.message,
          changedFiles: commit.changedFiles,
          diffSummary: commit.diffSummary
        }))
      })
    )
    .digest("hex");
}

export function legacyAgentBootstrapText(fileName: "AGENTS.md" | "CLAUDE.md"): string {
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
    "- Read the available completed memory index first. Use `sync_project_memory` explicitly when you need to wait for ingestion and index publication; ordinary retrieval refreshes in the background.",
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

export const BOOTSTRAP_TEMPLATE_VERSION = 3;
export interface AgentFileBaseline { templateVersion: number; contentHash: string; managedContentHash?: string }
export function agentBootstrapText(fileName: "AGENTS.md" | "CLAUDE.md"): string {
  const content = legacyAgentBootstrapText(fileName) + "\n## Global Rules\n- " + GLOBAL_RULES_INSTRUCTIONS + "\n";
  const hash = hashBytes(Buffer.from(content));
  return `<!-- code-butler:begin v=${BOOTSTRAP_TEMPLATE_VERSION} sha256=${hash} -->\n${content}<!-- code-butler:end -->\n`;
}
/** Upgrade only verified generated bytes. Markers alone never establish ownership. */
export function upgradeAgentBootstraps(root: string, baselines: Record<string, AgentFileBaseline> = {}) {
  const agentFiles: Record<string, AgentFileBaseline> = {}, customized: string[] = [], backupFiles: string[] = [];
  for (const name of ["AGENTS.md", "CLAUDE.md"] as const) {
    const path = join(root, name); if (!existsSync(path)) continue;
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error("Bootstrap must be a regular file");
    const current = readFileSync(path, "utf8"), desired = agentBootstrapText(name);
    let next: string | undefined;
    const block = /<!-- code-butler:begin v=(\d+) sha256=([a-f0-9]{64}) -->\n([\s\S]*?)<!-- code-butler:end -->\n?/.exec(current);
    const desiredBlockHash = /sha256=([a-f0-9]{64})/.exec(desired)![1]!;
    const previousBlockHash = hashBytes(Buffer.from(legacyAgentBootstrapText(name) + "\n## Global Rules\n- " + LEGACY_GLOBAL_RULES_INSTRUCTIONS + "\n"));
    if (block && current.split("<!-- code-butler:begin").length === 2 && hashBytes(Buffer.from(block[3]!)) === block[2] && (block[2] === desiredBlockHash || block[2] === previousBlockHash || block[2] === baselines[name]?.managedContentHash)) next = current.replace(block[0], desired);
    else if (current === legacyAgentBootstrapText(name) || current === legacyAgentBootstrapText(name).replace(/\n/g, "\r\n") || baselines[name]?.contentHash === hashBytes(Buffer.from(current))) next = desired;
    if (next === undefined) { customized.push(name); continue; }
    if (next !== current) {
      const backup = join(root, ".code-butler", "backups", "bootstrap", `${name}.${Date.now()}.${hashBytes(Buffer.from(current)).slice(0, 12)}.md`);
      atomicWrite(backup, current);
      if (readFileSync(path, "utf8") !== current) throw new Error("Bootstrap changed during upgrade; retry");
      atomicWrite(path, next); backupFiles.push(backup);
    }
    agentFiles[name] = { templateVersion: BOOTSTRAP_TEMPLATE_VERSION, contentHash: hashBytes(Buffer.from(next)), managedContentHash: desiredBlockHash };
  }
  return { agentFiles, customized, backupFiles };
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
