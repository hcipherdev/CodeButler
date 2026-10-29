import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasCredentials } from "./ai/credentials.js";
import { jobModel } from "./ai/models.js";
import { loadProjectConfig, validateProjectConfigFile } from "./config.js";
import type { ProjectConfig } from "./types.js";
import { projectOperation } from "./cloud/client.js";
import { assertProjectNotRemoved } from "./cloud/removal-state.js";
import { openConfiguredMemoryStore } from "./storage/open-configured-store.js";
import {
  collectProjectSummaryInput, commitPreparedProjectSummary, createLocalProjectSummaryGenerator,
  initializeProjectSummary, readProjectBrief,
  upgradeAgentBootstraps, BOOTSTRAP_TEMPLATE_VERSION, type AgentFileBaseline,
  type ProjectSummaryGenerator, type ProjectSummaryOperationOptions
} from "./project-summary/service.js";
import { createConfiguredProjectSummaryGenerator } from "./project-summary/providers.js";

export type ProjectSetupArtifact = "config" | "database" | "summary" | "AGENTS.md" | "CLAUDE.md";
export interface ProjectSetupStatus {
  customizedAgentFiles?: string[];
  status: "pending" | "ready" | "failed";
  missing: ProjectSetupArtifact[];
  summaryQuality: "missing" | "local" | "provider" | "existing";
  backupFiles: string[];
  error?: string;
  enrichment?: { status: "idle" | "running" | "complete" | "failed"; error?: string };
}
interface SetupMetadata {
  bootstrapTemplateVersion?: number;
  agentFiles?: Record<string, AgentFileBaseline>;
  customizedAgentFiles?: string[];
  version: 1;
  completedAt?: string;
  backupFiles: string[];
  error?: string;
  enrichment?: {
    status: "idle" | "running" | "complete" | "failed";
    lastAttemptAt?: string;
    pid?: number;
    error?: string;
  };
}
export interface AutomaticSetupOptions extends ProjectSummaryOperationOptions {
  signal?: AbortSignal;
  enrichmentGenerator?: ProjectSummaryGenerator;
}
const RETRY_MS = 24 * 60 * 60 * 1000;
const markerPath = (root: string) => join(root, ".code-butler", "setup.meta.json");
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
// Source ingestion can target another repo; setup artifacts belong to the selected MCP root.
function setupConfig(root: string): ProjectConfig {
  const config = loadProjectConfig(root);
  return { ...config, sources: { ...config.sources, git: { ...config.sources.git, repoPath: root } } };
}

/** Validate destinations before any config/database helper can follow a link. */
export function validateProjectSetupPaths(root: string, fullSetup = true): void {
  for (const name of [".code-butler", ...(fullSetup ? ["AGENTS.md", "CLAUDE.md"] : []), ...[
    "config.json", "config.local.json", "memory.sqlite", "memory.sqlite-wal", "memory.sqlite-shm",
    ...(fullSetup ? ["project-summary.md", "project-summary.meta.json", "setup.meta.json"] : [])
  ].map(name => `.code-butler/${name}`)]) {
    try {
      const stat = lstatSync(join(root, name));
      if (stat.isSymbolicLink() || (name === ".code-butler" ? !stat.isDirectory() : !stat.isFile())) {
        throw new Error(`Project setup destination must be a regular ${name === ".code-butler" ? "directory" : "file"}: ${name}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function readMetadata(root: string): SetupMetadata | undefined {
  if (!existsSync(markerPath(root))) return undefined;
  const value = JSON.parse(readFileSync(markerPath(root), "utf8")) as SetupMetadata;
  if (!value || value.version !== 1 || !Array.isArray(value.backupFiles) || value.backupFiles.some(x => typeof x !== "string") ||
    (value.completedAt !== undefined && (typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt))))) {
    throw new Error("Invalid Code Butler setup metadata");
  }
  return value;
}
function writeMetadata(root: string, value: SetupMetadata): void {
  validateProjectSetupPaths(root);
  const path = markerPath(root);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

/** File-only inspection shared by desktop and doctor; it never opens SQLite. */
export function inspectProjectSetupArtifacts(root: string): ProjectSetupArtifact[] {
  validateProjectSetupPaths(root);
  const missing: ProjectSetupArtifact[] = [];
  const config = join(root, ".code-butler", "config.json");
  if (!existsSync(config)) missing.push("config");
  else validateProjectConfigFile(JSON.parse(readFileSync(config, "utf8").trim() || "{}"));
  if (!existsSync(join(root, ".code-butler", "memory.sqlite"))) missing.push("database");
  const brief = readProjectBrief(root);
  if (!brief.exists || !brief.summary.trim()) missing.push("summary");
  for (const file of ["AGENTS.md", "CLAUDE.md"] as const) {
    if (!existsSync(join(root, file)) || !readFileSync(join(root, file), "utf8").trim()) missing.push(file);
  }
  return missing;
}

/** Responsive and read-only, including while another process holds the project gate. */
export function readProjectSetupStatus(root: string): ProjectSetupStatus {
  try {
    assertProjectNotRemoved(root);
    const missing = inspectProjectSetupArtifacts(root);
    const metadata = readMetadata(root);
    const brief = readProjectBrief(root);
    const quality = !brief.exists || !brief.summary.trim() ? "missing" :
      brief.meta?.outputContentHash !== digest(brief.summary) ? "existing" :
      ["local", "fallback"].includes(brief.meta?.provider ?? "") ? "local" :
      brief.meta?.provider ? "provider" : "existing";
    const status: ProjectSetupStatus = {
      status: metadata?.error ? "failed" : metadata?.completedAt && !missing.length ? "ready" : "pending",
      missing, summaryQuality: quality, backupFiles: metadata?.backupFiles ?? []
    };
    if (metadata?.error) status.error = metadata.error;
    if (metadata?.customizedAgentFiles?.length) status.customizedAgentFiles = metadata.customizedAgentFiles;
    if (metadata?.enrichment) status.enrichment = {
      status: metadata.enrichment.status === "running" && !alive(metadata.enrichment.pid) ? "idle" : metadata.enrichment.status,
      ...(metadata.enrichment.error ? { error: metadata.enrichment.error } : {})
    };
    return status;
  } catch (error) {
    return { status: "failed", missing: [], summaryQuality: "missing", backupFiles: [], error: setupError(error) };
  }
}

/** Called after explicit init as well, so reconnects do not overwrite later edits. */
export function recordProjectSetupCompletion(root: string, backupFiles: string[], now = new Date()): void {
  const missing = inspectProjectSetupArtifacts(root);
  if (missing.length) throw new Error(`Project setup remains incomplete: ${missing.join(", ")}`);
  const prior = readMetadata(root);
  const bootstrap = upgradeAgentBootstraps(root, prior?.agentFiles);
  writeMetadata(root, {
    version: 1, completedAt: prior?.completedAt ?? now.toISOString(),
    bootstrapTemplateVersion: BOOTSTRAP_TEMPLATE_VERSION, agentFiles: bootstrap.agentFiles, customizedAgentFiles: bootstrap.customized,
    backupFiles: [...new Set([...(prior?.backupFiles ?? []), ...backupFiles, ...bootstrap.backupFiles])],
    ...(prior?.enrichment ? { enrichment: prior.enrichment } : {})
  });
}

/** All local setup happens under one cross-process gate, independently of ingestion. */
export async function ensureAutomaticProjectSetup(root: string, options: AutomaticSetupOptions = {}): Promise<ProjectSetupStatus> {
  assertProjectNotRemoved(root);
  validateProjectSetupPaths(root);
  return projectOperation(root, async () => {
    options.signal?.throwIfAborted();
    validateProjectSetupPaths(root);
    const metadata = readMetadata(root);
    if (metadata?.completedAt && metadata.bootstrapTemplateVersion !== BOOTSTRAP_TEMPLATE_VERSION) {
      const bootstrap = upgradeAgentBootstraps(root, metadata.agentFiles);
      writeMetadata(root, { ...metadata, bootstrapTemplateVersion: BOOTSTRAP_TEMPLATE_VERSION, agentFiles: bootstrap.agentFiles,
        customizedAgentFiles: bootstrap.customized, backupFiles: [...metadata.backupFiles, ...bootstrap.backupFiles] });
    }
    if (metadata?.completedAt && !inspectProjectSetupArtifacts(root).length) {
      if (metadata.error) recordProjectSetupCompletion(root, [], (options.now ?? (() => new Date()))());
      return readProjectSetupStatus(root);
    }
    const store = openConfiguredMemoryStore(root);
    try {
      store.init();
      const installed = await initializeProjectSummary(store, setupConfig(root), {
        ...options, generator: options.generator ?? createLocalProjectSummaryGenerator(),
        preserveExistingAgentFiles: true
      });
      recordProjectSetupCompletion(root, installed.backupFiles ?? [], (options.now ?? (() => new Date()))());
      return readProjectSetupStatus(root);
    } catch (error) {
      // Invalid destinations are reported directly; never write through a bad path.
      writeMetadata(root, { version: 1, ...metadata, backupFiles: metadata?.backupFiles ?? [], error: setupError(error) });
      throw error;
    } finally { store.close(); }
  }, { name: "MCP project setup" });
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function setupError(error: unknown): string {
  return `${error instanceof Error ? error.message : String(error)}. Reconnect after fixing the issue, or run code-butler init.`;
}

/** Capture and commit under short locks; remote generation never holds a DB handle or gate. */
export async function enrichLocalProjectSummary(root: string, options: AutomaticSetupOptions = {}): Promise<void> {
  validateProjectSetupPaths(root);
  const prepared = await projectOperation(root, () => {
    options.signal?.throwIfAborted();
    validateProjectSetupPaths(root);
    const metadata = readMetadata(root);
    const brief = readProjectBrief(root);
    if (!metadata?.completedAt || inspectProjectSetupArtifacts(root).length ||
      brief.meta?.provider !== "local" || brief.meta.outputContentHash !== digest(brief.summary)) return undefined;
    const now = (options.now ?? (() => new Date()))();
    const last = metadata.enrichment;
    if (last?.status === "running" && alive(last.pid)) return undefined;
    if (last?.status !== "running" && last?.lastAttemptAt && now.getTime() - Date.parse(last.lastAttemptAt) < RETRY_MS) return undefined;
    const config = setupConfig(root);
    if (!options.enrichmentGenerator && !hasCredentials(jobModel(config, "summary"))) return undefined;
    const store = openConfiguredMemoryStore(root);
    try {
      store.init();
      const input = collectProjectSummaryInput(store, config);
      const generator = options.enrichmentGenerator ?? createConfiguredProjectSummaryGenerator(config);
      writeMetadata(root, { ...metadata, enrichment: { status: "running", lastAttemptAt: now.toISOString(), pid: process.pid } });
      return { input, generator, hash: digest(brief.summary), attempt: now.toISOString() };
    } finally { store.close(); }
  }, { name: "Prepare project summary enrichment" });
  if (!prepared) return;
  try {
    const summary = await prepared.generator.generate(prepared.input, options.signal);
    options.signal?.throwIfAborted();
    await projectOperation(root, () => {
      options.signal?.throwIfAborted();
      validateProjectSetupPaths(root);
      const metadata = readMetadata(root);
      if (metadata?.enrichment?.lastAttemptAt !== prepared.attempt) return;
      const brief = readProjectBrief(root);
      const store = openConfiguredMemoryStore(root);
      try {
        store.init();
        const current = collectProjectSummaryInput(store, setupConfig(root));
        if (brief.meta?.provider === "local" && digest(brief.summary) === prepared.hash && current.fingerprint === prepared.input.fingerprint) {
          commitPreparedProjectSummary(root, prepared.input, summary, prepared.generator.name ?? "provider", prepared.hash, options);
          writeMetadata(root, { ...metadata, enrichment: { status: "complete", lastAttemptAt: prepared.attempt } });
        } else {
          writeMetadata(root, { ...metadata, enrichment: { status: "idle", lastAttemptAt: prepared.attempt } });
        }
      } finally { store.close(); }
    }, { name: "Commit project summary enrichment" });
  } catch (error) {
    await projectOperation(root, () => {
      const metadata = readMetadata(root);
      if (metadata?.enrichment?.lastAttemptAt !== prepared.attempt) return;
      writeMetadata(root, { ...metadata, enrichment: options.signal?.aborted ? { status: "idle" } :
        { status: "failed", lastAttemptAt: prepared.attempt, error: "Summary enrichment failed; the local summary remains available." } });
    }, { name: "Record summary enrichment outcome" });
    if (!options.signal?.aborted) throw error;
  }
}
