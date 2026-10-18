import { createMemoryOrigin, type OriginFactory } from "../memory/origin.js";
import { createHash } from "node:crypto";
import { projectOperation } from "../cloud/client.js";
import { withProjectGateSync } from "../cloud/gate.js";
import { activeForegroundIntent } from "../cloud/foreground.js";
import { OperationDeferredError } from "../cloud/outcome.js";
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
import { runAutomaticPromotions, type AutomaticPromotionSummary } from "../memory/automatic-promotion.js";
import { runLayerRetention, type LayerRetentionSummary } from "../memory/layer-retention.js";
import type { ExtractionJob, MemoryStore } from "../storage/store.js";
import { discoverConversationFiles, scanClaudeFiles, scanCodexFiles, syncClaudeSource, syncCodexSource, type ConversationFileScan } from "../sources/codex.js";
import { scanGitSource, syncGitSource, type GitSourceScan } from "../sources/git.js";
import type {
  CommitRecord,
  ExtractedMemory,
  EmbeddingProvider,
  ExtractorConversationInput,
  ExtractorContext,
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
}

const EXTRACTION_BATCH_SIZE = 10;
const MAX_EXTRACTION_BATCHES_PER_PASS = 3;

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
  sourceScans?: { git?: GitSourceScan; codex?: ConversationFileScan[]; claude?: ConversationFileScan[] } | undefined;
  sourceScanErrors?: Partial<Record<SyncSourceName, string>> | undefined;
}

export async function syncProjectMemory(
  store: MemoryStore,
  config: ProjectConfig,
  options: SyncProjectMemoryOptions = {}
): Promise<SyncRunResult> {
  (await import("../rules/identity.js")).assertOrdinaryProject(store.paths.rootDir);
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

  const pending = store.listPendingExtractionEvidence(selectedSources, EXTRACTION_BATCH_SIZE * MAX_EXTRACTION_BATCHES_PER_PASS);
  if (pending.length === 0) {
    result.memories = {
      candidates: 0,
      promoted: 0,
      rejected: deterministicProcessed.rejected,
      skipped: true,
      reason: "No new evidence"
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
  for (let offset = 0; offset < pending.length; offset += EXTRACTION_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + EXTRACTION_BATCH_SIZE);
    const { context, missing } = extractionContext(store, batch);
    if (missing.length) store.discardExtractionEvidence(missing);
    const ready = batch.filter(job => !missing.includes(job));
    if (!ready.length) continue;
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
      const processed = processExtractedMemories(store, config, extracted.memories, options.originFactory, defaultCandidateLayer);
      result.memories.candidates += processed.candidates;
      result.memories.promoted += processed.promoted;
      result.memories.rejected += processed.rejected + extracted.rejected.length;
      store.completeExtractionEvidence(ready);
      completedAny = true;
      logExtractionBatch(store, config, "sync", startedAt, ready, { extracted, processed });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.recordExtractionFailure(ready, message);
      firstError ??= message;
      logExtractionBatch(store, config, "sync", startedAt, ready, { extracted, error });
    }
  }
  result.memories.pending = store.getExtractionStatus().pending;
  result.memories.skipped = !completedAny && deterministicProcessed.candidates === 0;
  if (firstError) result.memories.error = firstError;
  if (result.memories.pending > 0 && !firstError) result.memories.reason = "Memory extraction pending";

  return finishSync(store, config, result, options);
}

/** Watcher pass with a project gate only around database import and commit phases. */
export async function syncWatchedProjectMemory(
  root: string,
  config: ProjectConfig,
  options: SyncProjectMemoryOptions = {}
): Promise<SyncRunResult> {
  const sources = options.source && options.source !== "all" ? [options.source] : SOURCE_NAMES;
  const started = performance.now();
  let importMs = 0, modelMs = 0, commitMs = 0, embeddingMs = 0;
  const files = {
    codex: config.sources.codex.enabled && sources.includes("codex") ? discoverConversationFiles(config.sources.codex) : [],
    claude: config.sources.claude.enabled && sources.includes("claude") ? discoverConversationFiles(config.sources.claude) : []
  };
  const cursors = await projectOperation(root, () => {
    const store = openConfiguredMemoryStore(root);
    try {
      store.init();
      return {
        git: store.getSyncCursor("git", "last_commit")?.cursorValue,
        codex: new Map(files.codex.map(path => [path, store.getSyncCursor("codex", path)?.cursorValue ?? ""])),
        claude: new Map(files.claude.map(path => [path, store.getSyncCursor("claude", path)?.cursorValue ?? ""]))
      };
    } finally { store.close(); }
  }, { name: "Watcher source preparation" });
  const sourceScans: NonNullable<SyncProjectMemoryOptions["sourceScans"]> = {};
  const sourceScanErrors: Partial<Record<SyncSourceName, string>> = {};
  if (config.sources.git.enabled && sources.includes("git")) {
    try { sourceScans.git = scanGitSource(config.sources.git, cursors.git); }
    catch (error) { sourceScanErrors.git = error instanceof Error ? error.message : String(error); }
  }
  sourceScans.codex = scanCodexFiles(files.codex, cursors.codex);
  sourceScans.claude = scanClaudeFiles(files.claude, cursors.claude);
  const imported = await projectOperation(root, async () => {
    const phaseStarted = performance.now();
    const store = openConfiguredMemoryStore(root);
    try {
      store.init();
      return await syncProjectMemory(store, config, { ...options, sourceScans, sourceScanErrors, stopAfterImport: true });
    } finally { store.close(); importMs += performance.now() - phaseStarted; }
  }, { name: "Watcher import" });

  const result = imported;
  const extractor = options.extractorProvider ?? buildConfiguredExtractor(config);
  if (!extractor) {
    result.memories.reason = "Extractor not configured";
  } else {
    const attempted = new Set<string>();
    const layer = defaultBranchMemoryLayer(config.sources.git.repoPath);
    for (let batchNumber = 0; batchNumber < MAX_EXTRACTION_BATCHES_PER_PASS; batchNumber += 1) {
      const prepared = await projectOperation(root, () => {
        const store = openConfiguredMemoryStore(root);
        try {
          store.init();
          const jobs = store.listPendingExtractionEvidence(sources, EXTRACTION_BATCH_SIZE * MAX_EXTRACTION_BATCHES_PER_PASS)
            .filter(job => !attempted.has(extractionJobIdentity(job))).slice(0, EXTRACTION_BATCH_SIZE);
          const { context, missing } = extractionContext(store, jobs);
          if (missing.length) store.discardExtractionEvidence(missing);
          return { jobs: jobs.filter(job => !missing.includes(job)), context, hash: contextHash(context) };
        } finally { store.close(); }
      }, { name: "Watcher extraction preparation" });
      if (prepared.jobs.length === 0) break;
      for (const job of prepared.jobs) attempted.add(extractionJobIdentity(job));
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
      const commitStarted = performance.now();
      const committed = await projectOperation(root, () => {
        const store = openConfiguredMemoryStore(root);
        try {
          store.init();
          const current = store.listPendingExtractionEvidence(sources, EXTRACTION_BATCH_SIZE * MAX_EXTRACTION_BATCHES_PER_PASS);
          const currentIds = new Set(current.map(extractionJobIdentity));
          if (!prepared.jobs.every(job => currentIds.has(extractionJobIdentity(job)))) return false;
          if (contextHash(extractionContext(store, prepared.jobs).context) !== prepared.hash) return false;
          if (modelError) {
            store.recordExtractionFailure(prepared.jobs, modelError instanceof Error ? modelError.message : String(modelError));
            logExtractionBatch(store, config, "watch", startedAt, prepared.jobs, { extracted, error: modelError });
          } else {
            const processed = processExtractedMemories(store, config, extracted!.memories, options.originFactory, layer);
            result.memories.candidates += processed.candidates;
            result.memories.promoted += processed.promoted;
            result.memories.rejected += processed.rejected + extracted!.rejected.length;
            store.completeExtractionEvidence(prepared.jobs);
            logExtractionBatch(store, config, "watch", startedAt, prepared.jobs, { extracted, processed });
          }
          return true;
        } finally { store.close(); }
      }, { name: "Watcher extraction commit" });
      commitMs += performance.now() - commitStarted;
      if (modelError && committed) result.memories.error ??= modelError instanceof Error ? modelError.message : String(modelError);
    }
  }

  await projectOperation(root, async () => {
    const store = openConfiguredMemoryStore(root);
    try {
      store.init();
      result.memories.pending = store.getExtractionStatus().pending;
      result.memories.skipped = result.memories.candidates === 0 && result.memories.promoted === 0;
      if (result.memories.pending > 0 && !result.memories.error && !result.memories.reason) result.memories.reason = "Memory extraction pending";
      await finishSync(store, config, result, { ...options, deferEmbeddings: true });
    } finally { store.close(); }
  }, { name: "Watcher maintenance commit" });

  const embeddingStarted = performance.now();
  const openEmbeddingStore = () => projectOperation(root, () => {
    const opened = openConfiguredMemoryStore(root);
    try { opened.init(); return opened; }
    catch (error) { opened.close(); throw error; }
  }, { name: "Watcher embedding preparation" });
  let activeStore: MemoryStore | undefined = await openEmbeddingStore();
  const gatedStore = new Proxy({} as MemoryStore, {
    get(_target, key) {
      const store = activeStore;
      if (!store) throw new OperationDeferredError("Watcher embedding database is between phases");
      const value: unknown = Reflect.get(store, key);
      return typeof value === "function" && key !== "close" && key !== "init"
        ? (...args: unknown[]) => withProjectGateSync(root, () => (value as (...parameters: unknown[]) => unknown).apply(store, args), "Watcher embedding step")
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
    embeddingMs: Math.round(embeddingMs)
  }); } catch { /* Diagnostics never mask sync results. */ }
  return result;
}

function extractionJobIdentity(job: ExtractionJob): string {
  return JSON.stringify([job.adapter, job.sourceType, job.sourceId, job.enqueuedAt]);
}
function contextHash(context: ExtractorContext): string {
  return createHash("sha256").update(JSON.stringify(context)).digest("hex");
}

export function extractionContext(store: MemoryStore, jobs: readonly ExtractionJob[]): { context: ExtractorContext; missing: ExtractionJob[] } {
  const context: ExtractorContext = { conversations: [], commits: [] };
  const missing: ExtractionJob[] = [];
  for (const job of jobs) {
    if (job.sourceType === "commit") {
      const commit = store.readCommit(job.sourceId);
      if (commit) context.commits.push(commit);
      else missing.push(job);
      continue;
    }
    const source = store.readSource(job.sourceId);
    if (!source || source.type !== "conversation") { missing.push(job); continue; }
    context.conversations.push({
      sourceId: job.sourceId,
      title: source.title,
      rawContent: source.rawContent,
      chunks: store.listSourceChunks(job.sourceId),
      ...(source.metadata ? { metadata: source.metadata } : {})
    });
  }
  return { context, missing };
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
  try {
    result.promotions = runAutomaticPromotions(store, config, {
      repoPath: config.sources.git.repoPath
    }, options.actor ?? "system");
  } catch {
    result.promotions = {
      scanned: 0,
      promoted: 0,
      converged: 0,
      deferred: 0,
      skipped: 0,
      warnings: ["Automatic promotion pass failed"]
    };
  }
  // After promotion, so knowledge that has earned core is shared before its
  // branch-local copy can age out.
  try {
    result.retention = runLayerRetention(store, config, {
      repoPath: config.sources.git.repoPath
    }, options.actor ?? "system");
  } catch {
    result.retention = { scanned: 0, archived: 0, skipped: 0, warnings: ["Layer retention pass failed"] };
  }
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
  memories: ExtractedMemory[],
  originFactory: OriginFactory = createMemoryOrigin,
  defaultCandidateLayer?: string | undefined
): { candidates: number; promoted: number; rejected: number; rejectionReasons: string[] } {
  let promoted = 0;
  let candidates = 0;
  let rejected = 0;
  const rejectionReasons: string[] = [];
  for (const memory of memories) {
    const assessment = assessMemoryQuality(store, memory);
    if (assessment.rejected) {
      rejected += 1;
      rejectionReasons.push(...(assessment.reasons.length ? assessment.reasons : ["rejected"]).map(reason => `quality:${reason}`));
      continue;
    }
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
    const candidate = store.upsertMemoryCandidate({ ...candidateInput, origin }, {
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

export function buildConfiguredExtractor(config: ProjectConfig): ExtractorProvider | undefined {
  if (!config.extractor.provider) return undefined;
  if (!hasProviderCredentials(config.extractor)) return undefined;
  if (config.extractor.provider === "anthropic-aws") {
    return createAnthropicAwsExtractor(config.extractor);
  }
  return createOpenAICompatibleExtractor(config.extractor);
}

function hasProviderCredentials(config: ProjectConfig["extractor"]): boolean {
  if (!process.env[config.apiKeyEnv]?.trim()) return false;
  if (config.provider !== "anthropic-aws") return true;
  const workspaceIdEnv = config.workspaceIdEnv ?? "ANTHROPIC_AWS_WORKSPACE_ID";
  const regionEnv = config.regionEnv ?? "AWS_REGION";
  return Boolean(process.env[workspaceIdEnv]?.trim() && process.env[regionEnv]?.trim());
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
