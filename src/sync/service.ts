import { hasCredentials } from "../ai/credentials.js";
import { AI_BUDGET_REASON, AiBudgetExceededError, backgroundBudgetPaused } from "../ai/usage.js";
import { createMemoryOrigin, type OriginFactory } from "../memory/origin.js";
import { createHash } from "node:crypto";
import { projectOperation } from "../cloud/client.js";
import { withProjectGateSync } from "../cloud/gate.js";
import { activeForegroundIntent } from "../cloud/foreground.js";
import { OperationDeferredError, type OperationOutcome } from "../cloud/outcome.js";
import { openConfiguredMemoryStore } from "../storage/open-configured-store.js";
import { atomicJson } from "../cloud/state.js";
import { join } from "node:path";
import { defaultBranchMemoryLayer } from "../memory/branch.js";
import { createAnthropicAwsExtractor } from "../extract/anthropic-aws.js";
import { createOpenAICompatibleExtractor } from "../extract/openai.js";
import { extractDeterministicMemories } from "../deterministic/triggers.js";
import { extractTemporaryMemories } from "../deterministic/temporary.js";
import { buildEmbeddings } from "../embeddings/service.js";
import type {
  EmbeddingBuildResult,
  EmbeddingServiceOptions
} from "../embeddings/service.js";
import { createEmbeddingEndpointHash, createProviderKey } from "../embeddings/fingerprint.js";
import { assessMemoryQuality } from "../memory/quality.js";
import { countReasons, recordExtractionRun, rejectionKey } from "../extract/runs.js";
import { advanceExtractionCursor, chunkCount, readExtractionCursor, readyForExtraction } from "../extract/cursor.js";
import { candidateIdentityFor, selectRelatedMemories, type ExistingMemoryTarget } from "../extract/related-memories.js";
import { applyInvalidation, applyPendingInvalidations, type MemoryRef, type PendingInvalidationSummary } from "../memory/invalidation.js";
import { extractionPolicy } from "../config.js";
import { migrateRemoteModelConsent } from "../ai/consent.js";
import { runAutomaticPromotions, type AutomaticPromotionSummary } from "../memory/automatic-promotion.js";
import { runLayerRetention, type LayerRetentionSummary } from "../memory/layer-retention.js";
import { checkMaintenancePass, recordMaintenancePass } from "./maintenance-pass.js";
import type { ExtractionJob, MemoryStore } from "../storage/store.js";
import { discoverConversationFiles, scanClaudeFiles, scanCodexFiles, syncClaudeSource, syncCodexSource, type ConversationFileScan } from "../sources/codex.js";
import { scanGitSource, syncGitSource, type GitSourceScan } from "../sources/git.js";
import type {
  CommitRecord,
  ExtractedMemory,
  EmbeddingProvider,
  ExtractorConversationInput,
  ExtractorContext,
  ExtractorMemory,
  ExtractorProvider,
  ExtractorResult,
  OperationActor,
  ProjectConfig,
  SyncSourceName
} from "../types.js";

export interface SyncSourceResult {
  imported: number;
  enabled: boolean;
  error?: string;
}

export interface SyncMemoryResult {
  candidates: number;
  promoted: number;
  rejected: number;
  skipped: boolean;
  reason?: string;
  error?: string;
  pending?: number;
  /** Of `pending`, conversations held back until their session goes quiet. */
  waiting?: number;
}

const EXTRACTION_BATCH_SIZE = 10;
const MAX_EXTRACTION_BATCHES_PER_PASS = 3;
/** Queued jobs scanned per pass; enough that sessions waiting to go quiet cannot starve the rest. */
const PENDING_EXTRACTION_SCAN_LIMIT = 500;

export interface SyncTemporaryMemoryResult {
  upserted: number;
  deletedExpired: number;
}

export interface SyncRunResult {
  startedAt: string;
  completedAt: string;
  sources: Record<SyncSourceName, SyncSourceResult>;
  memories: SyncMemoryResult;
  temporary: SyncTemporaryMemoryResult;
  promotions?: AutomaticPromotionSummary | undefined;
  retention?: LayerRetentionSummary | undefined;
  /** Durable memories superseded once the newer memory that invalidated them was promoted. */
  invalidations?: PendingInvalidationSummary | undefined;
  /** True when the watcher skipped promotion and retention because nothing they read changed. */
  maintenanceSkipped?: boolean | undefined;
  embeddings?: EmbeddingBuildResult | undefined;
}

export type SyncEmbeddingBuilder = typeof buildEmbeddings;

export interface SyncProjectMemoryOptions {
  originFactory?: OriginFactory;
  source?: SyncSourceName | "all";
  extractorProvider?: ExtractorProvider;
  embeddingProvider?: EmbeddingProvider | undefined;
  embeddingProviderFactory?: EmbeddingServiceOptions["providerFactory"];
  embeddingBuilder?: SyncEmbeddingBuilder | undefined;
  /** Attributed to the automatic promotion pass; defaults to `system`. */
  actor?: OperationActor | undefined;
  /** Watcher import phase; model and embedding work is continued separately. */
  stopAfterImport?: boolean | undefined;
  deferEmbeddings?: boolean | undefined;
  /** Watcher only: skip promotion and retention when nothing they read has changed since the last pass. */
  skipUnchangedMaintenance?: boolean | undefined;
  /**
   * Leave conversations that are still being written for later (`extraction` config).
   * Automatic passes honour it; an explicit sync extracts everything queued. The
   * watcher defaults to true.
   */
  honorQuietWindow?: boolean | undefined;
  sourceScans?: { git?: GitSourceScan; codex?: ConversationFileScan[]; claude?: ConversationFileScan[] } | undefined;
  sourceScanErrors?: Partial<Record<SyncSourceName, string>> | undefined;
}

export async function syncProjectMemory(
  store: MemoryStore,
  config: ProjectConfig,
  options: SyncProjectMemoryOptions = {}
): Promise<SyncRunResult> {
  (await import("../rules/identity.js")).assertOrdinaryProject(store.paths.rootDir);
  config = migrateRemoteModelConsent(store, config);
  const startedAt = new Date().toISOString();
  const selectedSources = options.source && options.source !== "all" ? [options.source] : SOURCE_NAMES;
  const result: SyncRunResult = {
    startedAt,
    completedAt: startedAt,
    sources: {
      git: { imported: 0, enabled: config.sources.git.enabled },
      codex: { imported: 0, enabled: config.sources.codex.enabled },
      claude: { imported: 0, enabled: config.sources.claude.enabled }
    },
    memories: {
      candidates: 0,
      promoted: 0,
      rejected: 0,
      skipped: false
    },
    temporary: {
      upserted: 0,
      deletedExpired: store.deleteExpiredTemporaryMemories({ now: startedAt })
    }
  };

  const importedConversations: ExtractorConversationInput[] = [];
  const importedCommits: CommitRecord[] = [];
  const defaultCandidateLayer = defaultBranchMemoryLayer(config.sources.git.repoPath);
  const extractor = options.extractorProvider ?? buildConfiguredExtractor(config);

  for (const sourceName of SOURCE_NAMES) {
    if (!selectedSources.includes(sourceName)) continue;
    try {
      if (options.sourceScanErrors?.[sourceName]) throw new Error(options.sourceScanErrors[sourceName]);
      if (sourceName === "git") {
        if (!config.sources.git.enabled) {
          recordDisabledSync(store, sourceName, startedAt);
          continue;
        }
        const syncResult = syncGitSource(store, config.sources.git, extractor !== undefined, options.sourceScans?.git);
        importedCommits.push(...syncResult.commits);
        result.sources.git = { imported: syncResult.imported, enabled: true };
        store.recordSyncStatus({
          source: "git",
          enabled: true,
          lastSyncAt: startedAt,
          lastSuccessAt: startedAt,
          metadata: { imported: syncResult.imported, repoPath: config.sources.git.repoPath }
        });
        continue;
      }

      if (sourceName === "codex") {
        if (!config.sources.codex.enabled) {
          recordDisabledSync(store, sourceName, startedAt);
          continue;
        }
        const syncResult = syncCodexSource(store, config.sources.codex, config.sources.git.repoPath, extractor !== undefined, options.sourceScans?.codex);
        importedConversations.push(...syncResult.conversations);
        result.sources.codex = { imported: syncResult.imported, enabled: true };
        store.recordSyncStatus({
          source: "codex",
          enabled: true,
          lastSyncAt: startedAt,
          lastSuccessAt: startedAt,
          metadata: { imported: syncResult.imported, roots: config.sources.codex.roots }
        });
        continue;
      }

      if (!config.sources.claude.enabled) {
        recordDisabledSync(store, sourceName, startedAt);
        continue;
      }
      const syncResult = syncClaudeSource(store, config.sources.claude, config.sources.git.repoPath, extractor !== undefined, options.sourceScans?.claude);
      importedConversations.push(...syncResult.conversations);
      result.sources.claude = { imported: syncResult.imported, enabled: true };
      store.recordSyncStatus({
        source: "claude",
        enabled: true,
        lastSyncAt: startedAt,
        lastSuccessAt: startedAt,
        metadata: { imported: syncResult.imported, roots: config.sources.claude.roots }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.sources[sourceName] = {
        imported: 0,
        enabled: isEnabled(config, sourceName),
        error: message
      };
      store.recordSyncStatus({
        source: sourceName,
        enabled: isEnabled(config, sourceName),
        lastSyncAt: startedAt,
        lastError: message
      });
    }
  }

  result.temporary.upserted = processTemporaryMemories(
    store,
    extractTemporaryMemories(importedConversations, {
      projectId: store.paths.rootDir,
      now: new Date(startedAt)
    }).memories,
    options.originFactory
  );

  const deterministicProcessed = processDeterministicMemories(
    store,
    extractDeterministicMemories(
      {
        conversations: importedConversations,
        commits: importedCommits
      },
      { deterministic: config.deterministic, repoPath: config.sources.git.repoPath }
    ),
    options.originFactory,
    defaultCandidateLayer
  );

  if (options.stopAfterImport) {
    result.memories = {
      candidates: deterministicProcessed.candidates, promoted: deterministicProcessed.promoted,
      rejected: deterministicProcessed.rejected, skipped: deterministicProcessed.candidates === 0,
      pending: store.getExtractionStatus().pending
    };
    return result;
  }

  if (!extractor) {
    result.memories =
      deterministicProcessed.candidates > 0
        ? {
            candidates: deterministicProcessed.candidates,
            promoted: deterministicProcessed.promoted,
            rejected: deterministicProcessed.rejected,
            skipped: false
          }
        : {
            candidates: 0,
            promoted: 0,
            rejected: deterministicProcessed.rejected,
            skipped: true,
            reason: "Extractor not configured"
          };
    result.memories.pending = store.getExtractionStatus().pending;
    return finishSync(store, config, result, options);
  }

  const pending = readyExtractionJobs(store, config, selectedSources, options.honorQuietWindow === true);
  if (pending.length === 0) {
    result.memories = {
      candidates: 0,
      promoted: 0,
      rejected: deterministicProcessed.rejected,
      skipped: true,
      reason: store.getExtractionStatus().pending > 0 ? "Waiting for active sessions to go quiet" : "No new evidence"
    };
    result.memories.pending = store.getExtractionStatus().pending;
    return finishSync(store, config, result, options);
  }

  result.memories = {
    candidates: deterministicProcessed.candidates,
    promoted: deterministicProcessed.promoted,
    rejected: deterministicProcessed.rejected,
    skipped: false
  };
  let firstError: string | undefined;
  let completedAny = false;
  const { overlapChunks, relatedMemories } = extractionPolicy(config);
  let budgetPaused = false;
  for (let offset = 0; offset < pending.length; offset += EXTRACTION_BATCH_SIZE) {
    if (backgroundBudgetPaused()) { budgetPaused = true; break; }
    const batch = pending.slice(offset, offset + EXTRACTION_BATCH_SIZE);
    const { context, missing, units, caughtUp } = extractionContext(store, batch, { overlapChunks });
    if (missing.length) store.discardExtractionEvidence(missing);
    if (caughtUp.length) { commitExtractionUnits(store, [], caughtUp); completedAny = true; }
    const ready = units.map(unit => unit.job);
    if (!ready.length) continue;
    const related = selectRelatedMemories(store, context, relatedMemories);
    if (related.existingMemories.length) context.existingMemories = related.existingMemories;
    const startedAt = new Date().toISOString();
    let extracted: ExtractorResult | undefined;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          extracted = await extractor.extract(context);
          break;
        } catch (error) {
          if (attempt === 1 || !isMalformedExtractorResponse(error)) throw error;
        }
      }
      if (!extracted) throw new Error("Extractor returned no result");
      const processed = processExtractedMemories(store, config, extracted.memories, options.originFactory, defaultCandidateLayer, related.targets);
      result.memories.candidates += processed.candidates;
      result.memories.promoted += processed.promoted;
      result.memories.rejected += processed.rejected + extracted.rejected.length;
      commitExtractionUnits(store, units);
      completedAny = true;
      logExtractionBatch(store, config, "sync", startedAt, ready, { extracted, processed });
    } catch (error) {
      // Over budget is not a failure of this evidence: leave it queued for tomorrow.
      if (error instanceof AiBudgetExceededError) { budgetPaused = true; break; }
      const message = error instanceof Error ? error.message : String(error);
      store.recordExtractionFailure(ready, message);
      firstError ??= message;
      logExtractionBatch(store, config, "sync", startedAt, ready, { extracted, error });
    }
  }
  result.memories.pending = store.getExtractionStatus().pending;
  result.memories.skipped = !completedAny && deterministicProcessed.candidates === 0;
  if (firstError) result.memories.error = firstError;
  if (result.memories.pending > 0 && !firstError) result.memories.reason = budgetPaused ? AI_BUDGET_REASON : "Memory extraction pending";

  return finishSync(store, config, result, options);
}

/** Watcher pass with a project gate only around database import and commit phases. */
/** How a watcher-style pass reports itself; the watcher records the first failure it sees. */
export function ingestionOutcomes(result: SyncRunResult): OperationOutcome[] {
  const outcomes: OperationOutcome[] = [];
  for (const [name, source] of Object.entries(result.sources)) {
    if (source.error) outcomes.push({ outcome: "failed", stage: "ingestion", reason: `${name} sync failed: ${source.error}` });
  }
  const pending = result.memories.pending ?? 0, waiting = result.memories.waiting ?? 0;
  if (result.memories.error) outcomes.push({ outcome: "failed", stage: "ingestion", reason: `Memory extraction failed: ${result.memories.error}` });
  // A spent budget is on schedule, not deferred, or the watcher would retry the project on its backoff all day.
  else if (result.memories.reason === AI_BUDGET_REASON) outcomes.push({ outcome: "success", stage: "ingestion", reason: AI_BUDGET_REASON });
  // A session waiting to go quiet is on schedule, not deferred: reporting it as deferred made the
  // global watcher retry the project on its backoff for as long as the session stayed active.
  else if (pending > waiting) outcomes.push({ outcome: "deferred", stage: "ingestion", reason: `${pending - waiting} memory extraction item(s) pending` });
  else outcomes.push({ outcome: "success", stage: "ingestion" });
  return outcomes;
}

export async function syncWatchedProjectMemory(
  root: string,
  config: ProjectConfig,
  options: SyncProjectMemoryOptions = {}
): Promise<SyncRunResult> {
  const sources = options.source && options.source !== "all" ? [options.source] : SOURCE_NAMES;
  const started = performance.now();
  let importMs = 0, modelMs = 0, commitMs = 0, embeddingMs = 0, preparationMs = 0, extractionPrepMs = 0, maintenanceMs = 0, gateHoldMs = 0;
  // Every phase below that holds the project gate adds its time, so a long hold is visible in the timing file.
  const gated = async <T>(name: string, work: () => T | Promise<T>): Promise<T> => projectOperation(root, async () => {
    const holdStarted = performance.now();
    try { return await work(); }
    finally { gateHoldMs += performance.now() - holdStarted; }
  }, { name });
  const files = {
    codex: config.sources.codex.enabled && sources.includes("codex") ? discoverConversationFiles(config.sources.codex) : [],
    claude: config.sources.claude.enabled && sources.includes("claude") ? discoverConversationFiles(config.sources.claude) : []
  };
  const preparationStarted = performance.now();
  const cursors = await gated("Watcher source preparation", () => {
    const store = openConfiguredMemoryStore(root);
    try {
      store.init();
      config = migrateRemoteModelConsent(store, config);
      return {
        git: store.getSyncCursor("git", "last_commit")?.cursorValue,
        codex: new Map(files.codex.map(path => [path, store.getSyncCursor("codex", path)?.cursorValue ?? ""])),
        claude: new Map(files.claude.map(path => [path, store.getSyncCursor("claude", path)?.cursorValue ?? ""]))
      };
    } finally { store.close(); }
  });
  const sourceScans: NonNullable<SyncProjectMemoryOptions["sourceScans"]> = {};
  const sourceScanErrors: Partial<Record<SyncSourceName, string>> = {};
  if (config.sources.git.enabled && sources.includes("git")) {
    try { sourceScans.git = scanGitSource(config.sources.git, cursors.git); }
    catch (error) { sourceScanErrors.git = error instanceof Error ? error.message : String(error); }
  }
  sourceScans.codex = scanCodexFiles(files.codex, cursors.codex);
  sourceScans.claude = scanClaudeFiles(files.claude, cursors.claude);
  preparationMs = performance.now() - preparationStarted;
  const imported = await gated("Watcher import", async () => {
    const phaseStarted = performance.now();
    const store = openConfiguredMemoryStore(root);
    try {
      store.init();
      return await syncProjectMemory(store, config, { ...options, sourceScans, sourceScanErrors, stopAfterImport: true });
    } finally { store.close(); importMs += performance.now() - phaseStarted; }
  });

  const result = imported;
  const extractor = options.extractorProvider ?? buildConfiguredExtractor(config);
  if (!extractor) {
    result.memories.reason = "Extractor not configured";
  } else {
    const attempted = new Set<string>();
    const layer = defaultBranchMemoryLayer(config.sources.git.repoPath);
    const { overlapChunks, relatedMemories } = extractionPolicy(config);
    for (let batchNumber = 0; batchNumber < MAX_EXTRACTION_BATCHES_PER_PASS; batchNumber += 1) {
      if (backgroundBudgetPaused()) { result.memories.reason = AI_BUDGET_REASON; break; }
      const prepStarted = performance.now();
      const prepared = await gated("Watcher extraction preparation", () => {
        const store = openConfiguredMemoryStore(root);
        try {
          store.init();
          const jobs = readyExtractionJobs(store, config, sources, options.honorQuietWindow ?? true,
            job => attempted.has(extractionJobIdentity(job))).slice(0, EXTRACTION_BATCH_SIZE);
          for (const job of jobs) attempted.add(extractionJobIdentity(job));
          const { context, missing, units, caughtUp } = extractionContext(store, jobs, { overlapChunks });
          if (missing.length) store.discardExtractionEvidence(missing);
          if (caughtUp.length) commitExtractionUnits(store, [], caughtUp);
          const related = units.length ? selectRelatedMemories(store, context, relatedMemories) : undefined;
          if (related?.existingMemories.length) context.existingMemories = related.existingMemories;
          return { jobs: units.map(unit => unit.job), units, context, targets: related?.targets, progressed: caughtUp.length > 0 };
        } finally { store.close(); }
      });
      extractionPrepMs += performance.now() - prepStarted;
      if (prepared.jobs.length === 0) {
        if (prepared.progressed) continue;
        break;
      }
      let extracted: Awaited<ReturnType<ExtractorProvider["extract"]>> | undefined;
      let modelError: unknown;
      const startedAt = new Date().toISOString();
      const modelStarted = performance.now();
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try { extracted = await extractor.extract(prepared.context); break; }
          catch (error) { if (attempt === 1 || !isMalformedExtractorResponse(error)) throw error; }
        }
        if (!extracted) throw new Error("Extractor returned no result");
      } catch (error) { modelError = error; }
      finally { modelMs += performance.now() - modelStarted; }
      // Over budget is not a failure of this evidence: leave it queued for tomorrow.
      if (modelError instanceof AiBudgetExceededError) { result.memories.reason = AI_BUDGET_REASON; break; }
      const commitStarted = performance.now();
      const committed = await gated("Watcher extraction commit", () => {
        const store = openConfiguredMemoryStore(root);
        try {
          store.init();
          if (!prepared.units.every(unit => unitStillCurrent(store, unit))) return false;
          if (modelError) {
            store.recordExtractionFailure(prepared.jobs, modelError instanceof Error ? modelError.message : String(modelError));
            logExtractionBatch(store, config, "watch", startedAt, prepared.jobs, { extracted, error: modelError });
          } else {
            const processed = processExtractedMemories(store, config, extracted!.memories, options.originFactory, layer, prepared.targets);
            result.memories.candidates += processed.candidates;
            result.memories.promoted += processed.promoted;
            result.memories.rejected += processed.rejected + extracted!.rejected.length;
            commitExtractionUnits(store, prepared.units);
            logExtractionBatch(store, config, "watch", startedAt, prepared.jobs, { extracted, processed });
          }
          return true;
        } finally { store.close(); }
      });
      commitMs += performance.now() - commitStarted;
      if (modelError && committed) result.memories.error ??= modelError instanceof Error ? modelError.message : String(modelError);
    }
  }

  const maintenanceStarted = performance.now();
  await gated("Watcher maintenance commit", async () => {
    const store = openConfiguredMemoryStore(root);
    try {
      store.init();
      result.memories.pending = store.getExtractionStatus().pending;
      result.memories.waiting = waitingExtractionJobs(store, config, sources);
      result.memories.skipped = result.memories.candidates === 0 && result.memories.promoted === 0;
      if (result.memories.pending > 0 && !result.memories.error && !result.memories.reason) result.memories.reason = "Memory extraction pending";
      await finishSync(store, config, result, { ...options, deferEmbeddings: true, skipUnchangedMaintenance: true });
    } finally { store.close(); }
  });
  maintenanceMs = performance.now() - maintenanceStarted;

  const embeddingStarted = performance.now();
  const openEmbeddingStore = () => gated("Watcher embedding preparation", () => {
    const opened = openConfiguredMemoryStore(root);
    try { opened.init(); return opened; }
    catch (error) { opened.close(); throw error; }
  });
  let activeStore: MemoryStore | undefined = await openEmbeddingStore();
  const gatedStore = new Proxy({} as MemoryStore, {
    get(_target, key) {
      const store = activeStore;
      if (!store) throw new OperationDeferredError("Watcher embedding database is between phases");
      const value: unknown = Reflect.get(store, key);
      return typeof value === "function" && key !== "close" && key !== "init"
        ? (...args: unknown[]) => withProjectGateSync(root, () => {
            const holdStarted = performance.now();
            try { return (value as (...parameters: unknown[]) => unknown).apply(store, args); }
            finally { gateHoldMs += performance.now() - holdStarted; }
          }, "Watcher embedding step")
        : value;
    }
  });
  try {
    result.embeddings = await (options.embeddingBuilder ?? buildEmbeddings)(gatedStore, config, {
      ...(options.embeddingProvider !== undefined ? { provider: options.embeddingProvider } : {}),
      ...(options.embeddingProviderFactory !== undefined ? { providerFactory: options.embeddingProviderFactory } : {}),
      shouldYield: () => activeForegroundIntent(root) !== undefined,
      runExternalModel: async work => {
        activeStore?.close(); activeStore = undefined;
        try { return await work(); }
        finally { activeStore = await openEmbeddingStore(); }
      }
    });
  } catch (error) {
    if (error instanceof OperationDeferredError) throw error;
    result.embeddings = embeddingFailureStatus(gatedStore, config, error);
  } finally { activeStore?.close(); embeddingMs += performance.now() - embeddingStarted; }
  result.completedAt = new Date().toISOString();
  if (process.env.CODE_BUTLER_RETRIEVAL_ENGINE === "published") {
    const { scheduleRetrieval } = await import("../retrieval/worker.js");
    scheduleRetrieval(root);
  }
  try { atomicJson(join(root, ".code-butler", "watcher-timing.json"), {
    recordedAt: result.completedAt, totalMs: Math.round(performance.now() - started),
    importMs: Math.round(importMs), modelMs: Math.round(modelMs), commitMs: Math.round(commitMs),
    embeddingMs: Math.round(embeddingMs), preparationMs: Math.round(preparationMs),
    extractionPrepMs: Math.round(extractionPrepMs), maintenanceMs: Math.round(maintenanceMs),
    maintenanceSkipped: result.maintenanceSkipped === true, gateHoldMs: Math.round(gateHoldMs)
  }); } catch { /* Diagnostics never mask sync results. */ }
  return result;
}

function extractionJobIdentity(job: ExtractionJob): string {
  return JSON.stringify([job.adapter, job.sourceType, job.sourceId, job.enqueuedAt]);
}

/**
 * What one prepared batch read from a job. A conversation sends messages [sentFrom, to),
 * of which [from, to) are new and [sentFrom, from) are context the cursor already covers.
 */
export interface ExtractionUnit {
  job: ExtractionJob;
  sentFrom: number;
  from: number;
  to: number;
  fingerprint: string;
}

export interface PreparedExtractionContext {
  context: ExtractorContext;
  missing: ExtractionJob[];
  units: ExtractionUnit[];
  /** Conversations whose cursor already covers every message: complete without a model call. */
  caughtUp: ExtractionJob[];
}

/**
 * Builds the extractor input for a set of jobs. With `incremental`, a conversation sends
 * only the messages its cursor has not covered, plus a few earlier ones for context;
 * without it (the dry run) every message is sent.
 */
export function extractionContext(
  store: MemoryStore,
  jobs: readonly ExtractionJob[],
  incremental?: { overlapChunks: number }
): PreparedExtractionContext {
  const context: ExtractorContext = { conversations: [], commits: [] };
  const missing: ExtractionJob[] = [];
  const units: ExtractionUnit[] = [];
  const caughtUp: ExtractionJob[] = [];
  for (const job of jobs) {
    if (job.sourceType === "commit") {
      const commit = store.readCommit(job.sourceId);
      if (commit) {
        context.commits.push(commit);
        units.push({ job, sentFrom: 0, from: 0, to: 0, fingerprint: fingerprintOf(commit) });
      } else missing.push(job);
      continue;
    }
    const source = store.readSource(job.sourceId);
    if (!source || source.type !== "conversation") { missing.push(job); continue; }
    const chunks = store.listSourceChunks(job.sourceId);
    const from = incremental ? readExtractionCursor(store, job.sourceId).extractedChunks : 0;
    if (incremental && from >= chunks.length) { caughtUp.push(job); continue; }
    const sentFrom = incremental ? Math.max(0, from - incremental.overlapChunks) : 0;
    const sent = chunks.slice(sentFrom).map((chunk, offset) => sentFrom + offset < from ? { ...chunk, contextOnly: true } : chunk);
    context.conversations.push({
      sourceId: job.sourceId,
      title: source.title,
      rawContent: source.rawContent,
      chunks: sent,
      ...(source.metadata ? { metadata: source.metadata } : {})
    });
    units.push({ job, sentFrom, from, to: chunks.length, fingerprint: fingerprintOf(sent.map((chunk) => chunk.text)) });
  }
  return { context, missing, units, caughtUp };
}

/** Whether a prepared unit still describes what is stored, so its result may be committed. */
function unitStillCurrent(store: MemoryStore, unit: ExtractionUnit): boolean {
  const row = store.db.prepare("select enqueued_at from extraction_jobs where source_type = ? and source_id = ?")
    .get(unit.job.sourceType, unit.job.sourceId) as { enqueued_at: string } | undefined;
  if (!row) return false;
  if (unit.job.sourceType === "commit") {
    const commit = store.readCommit(unit.job.sourceId);
    return row.enqueued_at === unit.job.enqueuedAt && commit !== undefined && fingerprintOf(commit) === unit.fingerprint;
  }
  // A log that grew while the model ran is fine: the messages it read are unchanged,
  // and the new ones stay queued behind the cursor.
  if (readExtractionCursor(store, unit.job.sourceId).extractedChunks !== unit.from) return false;
  const texts = (store.db.prepare(
    "select text from chunks where source_id = ? and chunk_index >= ? and chunk_index < ? order by chunk_index"
  ).all(unit.job.sourceId, unit.sentFrom, unit.to) as Array<{ text: string }>).map((chunk) => chunk.text);
  return texts.length === unit.to - unit.sentFrom && fingerprintOf(texts) === unit.fingerprint;
}

/** Moves each conversation's cursor and completes only the jobs with nothing left to read. */
function commitExtractionUnits(store: MemoryStore, units: readonly ExtractionUnit[], caughtUp: readonly ExtractionJob[] = []): void {
  const complete: ExtractionJob[] = [...caughtUp];
  for (const unit of units) {
    if (unit.job.sourceType === "commit") { complete.push(unit.job); continue; }
    advanceExtractionCursor(store, unit.job.sourceId, unit.to);
    if (chunkCount(store, unit.job.sourceId) === unit.to) complete.push(unit.job);
  }
  store.completeExtractionEvidence(complete);
}

/** Queued conversations the quiet window is holding back; they are not work left undone. */
function waitingExtractionJobs(store: MemoryStore, config: ProjectConfig, sources: readonly SyncSourceName[]): number {
  const policy = extractionPolicy(config);
  return store.listPendingExtractionEvidence(sources, PENDING_EXTRACTION_SCAN_LIMIT)
    .filter((job) => !readyForExtraction(store, job, policy, { honorQuietWindow: true })).length;
}

/** Jobs to extract now; the watcher skips active sessions until they go quiet. */
function readyExtractionJobs(
  store: MemoryStore,
  config: ProjectConfig,
  sources: readonly SyncSourceName[],
  honorQuietWindow: boolean,
  exclude: (job: ExtractionJob) => boolean = () => false
): ExtractionJob[] {
  const policy = extractionPolicy(config);
  return store.listPendingExtractionEvidence(sources, PENDING_EXTRACTION_SCAN_LIMIT)
    .filter((job) => !exclude(job) && readyForExtraction(store, job, policy, { honorQuietWindow }))
    .slice(0, EXTRACTION_BATCH_SIZE * MAX_EXTRACTION_BATCHES_PER_PASS);
}

function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isMalformedExtractorResponse(error: unknown): boolean {
  return error instanceof SyntaxError || error instanceof Error && error.message === "Invalid extractor response";
}

async function finishSync(
  store: MemoryStore,
  config: ProjectConfig,
  result: SyncRunResult,
  options: SyncProjectMemoryOptions
): Promise<SyncRunResult> {
  // Runs after source ingestion has committed. A failure here must not roll that
  // back, so it becomes a warning and the next sync retries the same decisions.
  const maintenance = options.skipUnchangedMaintenance ? checkMaintenancePass(store, config) : undefined;
  if (maintenance && !maintenance.due) result.maintenanceSkipped = true;
  else runMaintenancePasses(store, config, result, options, maintenance?.inputs);
  if (options.deferEmbeddings) {
    result.completedAt = new Date().toISOString();
    return result;
  }
  const builder = options.embeddingBuilder ?? buildEmbeddings;
  const embeddingOptions: EmbeddingServiceOptions = {};
  if (options.embeddingProvider !== undefined) embeddingOptions.provider = options.embeddingProvider;
  if (options.embeddingProviderFactory !== undefined) {
    embeddingOptions.providerFactory = options.embeddingProviderFactory;
  }
  try {
    result.embeddings = await builder(store, config, embeddingOptions);
  } catch (error) {
    result.embeddings = embeddingFailureStatus(store, config, error);
  }
  result.completedAt = new Date().toISOString();
  if(process.env.CODE_BUTLER_RETRIEVAL_ENGINE==="published" && !process.argv.includes("--retrieval-worker")) {
    const {scheduleRetrieval}=await import("../retrieval/worker.js");scheduleRetrieval(store.paths.rootDir);
  }
  return result;
}

function runMaintenancePasses(
  store: MemoryStore,
  config: ProjectConfig,
  result: SyncRunResult,
  options: SyncProjectMemoryOptions,
  inputs: string | undefined
): void {
  let failed = false;
  try {
    result.promotions = runAutomaticPromotions(store, config, {
      repoPath: config.sources.git.repoPath
    }, options.actor ?? "system");
  } catch {
    failed = true;
    result.promotions = {
      scanned: 0,
      promoted: 0,
      converged: 0,
      deferred: 0,
      skipped: 0,
      warnings: ["Automatic promotion pass failed"]
    };
  }
  // After promotion, so a replacement promoted in this pass supersedes what it invalidated.
  try {
    result.invalidations = applyPendingInvalidations(store);
  } catch {
    failed = true;
    result.invalidations = { superseded: 0, dropped: 0, pending: 0, warnings: ["Pending invalidation pass failed"] };
  }
  // After promotion, so knowledge that has earned core is shared before its
  // branch-local copy can age out.
  try {
    result.retention = runLayerRetention(store, config, {
      repoPath: config.sources.git.repoPath
    }, options.actor ?? "system");
  } catch {
    failed = true;
    result.retention = { scanned: 0, archived: 0, skipped: 0, warnings: ["Layer retention pass failed"] };
  }
  // A failed or partly applied pass is retried next time rather than remembered as done.
  const warned = (result.promotions?.warnings.length ?? 0) + (result.retention?.warnings.length ?? 0) + (result.invalidations?.warnings.length ?? 0) > 0;
  if (inputs !== undefined && !failed && !warned) recordMaintenancePass(store, inputs);
}

function embeddingFailureStatus(
  store: MemoryStore,
  config: ProjectConfig,
  error: unknown
): EmbeddingBuildResult {
  const warning = sanitizeSyncEmbeddingError(error);
  if (!config.embeddings.enabled) {
    return {
      enabled: false,
      eligible: store.listEmbeddingOwners().length,
      activeCoverage: 0,
      pending: 0,
      complete: 0,
      failed: 0,
      attempts: 0,
      warnings: [warning],
      usable: false,
      built: 0,
      retried: 0,
      enqueued: 0,
      removedJobs: 0,
      removedVectors: 0
    };
  }
  let jobs: ReturnType<MemoryStore["listEmbeddingJobs"]> = [];
  let providerKey: string | undefined;
  try {
    const endpointHash = createEmbeddingEndpointHash(config.embeddings.baseUrl);
    providerKey = createProviderKey(endpointHash, config.embeddings.model);
    jobs = store.listEmbeddingJobs({ providerKey });
  } catch {
    // Invalid provider configuration is represented by the sanitized warning.
  }
  return {
    enabled: true,
    eligible: store.listEmbeddingOwners().length,
    activeCoverage: providerKey === undefined
      ? 0
      : new Set(store.listActiveEmbeddingVectors({ providerKey }).map((vector) => `${vector.ownerKind}\0${vector.ownerId}`)).size,
    pending: jobs.filter((job) => job.state === "pending").length,
    complete: jobs.filter((job) => job.state === "complete").length,
    failed: jobs.filter((job) => job.state === "failed").length,
    attempts: jobs.reduce((sum, job) => sum + job.attempts, 0),
    warnings: [warning],
    usable: false,
    ...(providerKey === undefined ? {} : { providerKey }),
    model: config.embeddings.model,
    built: 0,
    retried: 0,
    enqueued: 0,
    removedJobs: 0,
    removedVectors: 0
  };
}

function sanitizeSyncEmbeddingError(_error: unknown): string {
  return "Embedding build failed";
}

const SOURCE_NAMES: SyncSourceName[] = ["git", "codex", "claude"];

function processDeterministicMemories(
  store: MemoryStore,
  extraction: { memories: ExtractedMemory[]; promoteDedupeKeys: string[] },
  originFactory: OriginFactory = createMemoryOrigin,
  defaultCandidateLayer?: string | undefined
): { candidates: number; promoted: number; rejected: number } {
  const promoteDedupeKeys = new Set(extraction.promoteDedupeKeys);
  let promoted = 0;
  let candidates = 0;
  let rejected = 0;
  for (const memory of extraction.memories) {
    const assessment = assessMemoryQuality(store, memory);
    if (assessment.rejected) {
      rejected += 1;
      continue;
    }
    const shouldPromoteMemory = assessment.status === "active" && promoteDedupeKeys.has(memory.dedupeKey);
    const candidateInput = applyDefaultCandidateLayer(memory, defaultCandidateLayer, shouldPromoteMemory);
    const candidate = store.upsertMemoryCandidate({ ...candidateInput, origin: originFactory({ method: "deterministic", channel: "sync" }) }, {
      qualityStatus: assessment.status,
      qualityReasons: assessment.reasons,
      lastVerifiedAt: assessment.lastVerifiedAt
    });
    candidates += 1;
    if (shouldPromoteMemory) {
      store.promoteMemoryCandidate(candidate.id);
      promoted += 1;
    }
  }
  return {
    candidates,
    promoted,
    rejected
  };
}

function processTemporaryMemories(store: MemoryStore, memories: ReturnType<typeof extractTemporaryMemories>["memories"], originFactory: OriginFactory = createMemoryOrigin): number {
  for (const memory of memories) {
    store.upsertTemporaryMemory({ ...memory, origin: originFactory({ method: "deterministic", channel: "sync" }) });
  }
  return memories.length;
}

function processExtractedMemories(
  store: MemoryStore,
  config: ProjectConfig,
  memories: ExtractorMemory[],
  originFactory: OriginFactory = createMemoryOrigin,
  defaultCandidateLayer?: string | undefined,
  targets: ReadonlyMap<string, ExistingMemoryTarget> = new Map()
): { candidates: number; merged: number; promoted: number; rejected: number; rejectionReasons: string[] } {
  let promoted = 0;
  let candidates = 0;
  let merged = 0;
  let rejected = 0;
  const rejectionReasons: string[] = [];
  for (const extracted of memories) {
    const { sameAs: sameAsRef, invalidates, ...plain } = extracted;
    let memory: ExtractedMemory = plain;
    const sameAs = sameAsRef === undefined ? undefined : targets.get(sameAsRef);
    if (sameAsRef !== undefined && !sameAs) rejectionReasons.push("unknown_existing_ref");
    // The model said this restates a known fact: store it under that fact's identity so
    // its evidence joins the existing candidate instead of starting a new one.
    let knownDurable: ExistingMemoryTarget | undefined;
    if (sameAs && sameAs.type === memory.type) {
      const identity = candidateIdentityFor(store, sameAs);
      if (identity) memory = { ...memory, dedupeKey: identity.dedupeKey, scope: identity.scope, layer: identity.layer };
      else if (sameAs.category === "promoted") knownDurable = sameAs;
    }
    const assessment = assessMemoryQuality(store, memory);
    if (assessment.rejected) {
      rejected += 1;
      rejectionReasons.push(...(assessment.reasons.length ? assessment.reasons : ["rejected"]).map(reason => `quality:${reason}`));
      continue;
    }
    let replacement: MemoryRef | undefined = knownDurable ? { category: "promoted", id: knownDurable.id } : undefined;
    if (knownDurable) {
      // A durable fact with no candidate row (a manual memory) is already recorded as it stands.
      rejectionReasons.push("already_known");
    } else {
      const origin = originFactory({
        method: "llm",
        channel: "sync",
        generator: {
          ...(config.extractor.provider ? { provider: config.extractor.provider } : {}),
          ...(config.extractor.model ? { model: config.extractor.model } : {})
        }
      });
      const shouldPromoteMemory = assessment.status === "active" && shouldPromote(memory, config);
      const candidateInput = applyDefaultCandidateLayer(memory, defaultCandidateLayer, shouldPromoteMemory);
      // Re-extracting a fact adds its evidence to the earlier candidate instead of replacing it,
      // which is what lets a fact seen in two sessions reach the independent-sources bar.
      const { candidate, outcome } = store.mergeExtractedMemoryCandidate({ ...candidateInput, origin }, {
        qualityStatus: assessment.status,
        qualityReasons: assessment.reasons,
        lastVerifiedAt: assessment.lastVerifiedAt
      });
      if (outcome === "skipped_withdrawn") {
        rejectionReasons.push("withdrawn_fact");
        continue;
      }
      candidates += 1;
      if (outcome === "merged") merged += 1;
      if (shouldPromoteMemory && (outcome !== "unchanged" || candidate.promotionState !== "promoted")) {
        store.promoteMemoryCandidate(candidate.id);
        promoted += 1;
      }
      replacement = { category: "candidate", id: candidate.id };
    }
    if (invalidates) {
      const target = targets.get(invalidates.ref);
      if (!target) rejectionReasons.push("unknown_existing_ref");
      else if (target.id !== sameAs?.id && replacement) {
        const result = applyInvalidation(store, {
          target: { category: target.category, id: target.id },
          replacement,
          confidence: invalidates.confidence,
          why: invalidates.why,
          source: "extraction"
        });
        rejectionReasons.push(`invalidation:${result.outcome}`);
      }
    }
  }
  return {
    candidates,
    merged,
    promoted,
    rejected,
    rejectionReasons
  };
}

/** Logs one extraction batch to the device-local run log; see src/extract/runs.ts. */
function logExtractionBatch(
  store: MemoryStore,
  config: ProjectConfig,
  channel: "sync" | "watch",
  startedAt: string,
  jobs: readonly ExtractionJob[],
  outcome: { extracted?: ExtractorResult | undefined; processed?: ReturnType<typeof processExtractedMemories> | undefined; error?: unknown }
): void {
  recordExtractionRun(store.paths.localDatabasePath, {
    startedAt, finishedAt: new Date().toISOString(), channel,
    provider: config.extractor.provider, model: config.extractor.model,
    sourceIds: jobs.map(job => job.sourceId),
    returned: (outcome.extracted?.memories.length ?? 0) + (outcome.extracted?.rejected.length ?? 0),
    candidates: outcome.processed?.candidates ?? 0,
    merged: outcome.processed?.merged ?? 0,
    promoted: outcome.processed?.promoted ?? 0,
    rejections: countReasons([...(outcome.extracted?.rejected.map(rejectionKey) ?? []), ...(outcome.processed?.rejectionReasons ?? [])]),
    ...(outcome.error === undefined ? {} : { error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) })
  });
}

function applyDefaultCandidateLayer(
  memory: ExtractedMemory,
  defaultCandidateLayer: string | undefined,
  shouldPromoteMemory: boolean
): ExtractedMemory {
  if (memory.layer !== undefined || defaultCandidateLayer === undefined || shouldPromoteMemory) return memory;
  return { ...memory, layer: defaultCandidateLayer };
}

export function shouldPromote(memory: ExtractedMemory, config: ProjectConfig): boolean {
  if (memory.confidence < config.promotion.confidenceThreshold) return false;
  const categories = new Set(memory.evidence.map((item) => item.sourceType));
  const hasCommitConversation = categories.has("commit") && categories.has("conversation");
  const hasMinCategories = categories.size >= config.promotion.minSourceCategories;
  return config.promotion.requireCommitAndConversation
    ? hasCommitConversation || hasMinCategories
    : hasMinCategories;
}

/**
 * Records commits made since the last pass, without running extraction or other sources, so a manual
 * summary refresh sees work committed moments ago. Never throws: a refresh proceeds on recorded history.
 */
export function importNewGitCommits(store: MemoryStore, config: ProjectConfig): number {
  if (!config.sources.git.enabled) return 0;
  try {
    const at = new Date().toISOString();
    const { imported } = syncGitSource(store, config.sources.git, buildConfiguredExtractor(config) !== undefined);
    store.recordSyncStatus({ source: "git", enabled: true, lastSyncAt: at, lastSuccessAt: at, metadata: { imported, repoPath: config.sources.git.repoPath } });
    return imported;
  } catch {
    return 0;
  }
}

export function buildConfiguredExtractor(config: ProjectConfig): ExtractorProvider | undefined {
  if (!config.extractor.provider) return undefined;
  if (!hasCredentials(config.extractor)) return undefined;
  if (config.extractor.provider === "anthropic-aws" || config.extractor.provider === "anthropic") {
    return createAnthropicAwsExtractor(config.extractor);
  }
  return createOpenAICompatibleExtractor(config.extractor);
}

function recordDisabledSync(store: MemoryStore, sourceName: SyncSourceName, timestamp: string): void {
  store.recordSyncStatus({
    source: sourceName,
    enabled: false,
    lastSyncAt: timestamp,
    lastSuccessAt: timestamp,
    metadata: { imported: 0, disabled: true }
  });
}

function isEnabled(config: ProjectConfig, sourceName: SyncSourceName): boolean {
  if (sourceName === "git") return config.sources.git.enabled;
  if (sourceName === "codex") return config.sources.codex.enabled;
  return config.sources.claude.enabled;
}
