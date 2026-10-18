import { registerDatabaseHandle } from "../cloud/gate.js";
import { cachedRead, hasCachedRead } from "../retrieval/read-cache.js";
import { stateDirectory } from "../cloud/state.js";
import { normalizeScope, parseScope, sanitizeScope, scopeKey, assessApplicability } from "../memory/scope.js";
import { CORE_LAYER, deviceLayer, matchesLayerFilter, normalizeLayer, sanitizeLayer } from "../memory/layer.js";

/**
 * Peer layers are read from storage rather than derived, so a retrieval filter and the
 * write guards agree on exactly the same set.
 */
function importedPeerLayers(db: DatabaseSync): string[] {
  try {
    return (db.prepare("select layer from peer_partitions order by layer").all() as Array<{ layer: string }>)
      .map((row) => row.layer);
  } catch {
    return [];
  }
}
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { claimText, createStatement, memoryContentText, parseStatement } from "../memory/statement.js";
import { presentMemory } from "../memory/presentation.js";
import { parseMemoryOrigin, sanitizeMemoryOrigin } from "../memory/origin.js";
import {
  confidenceBasis,
  createMemoryReviewContext,
  currentMemoryReview,
  effectiveTerminalMemoryReview,
  trustDisplayStatus
} from "../memory/review-state.js";
import { readMemoryPopulation } from "../memory/quality.js";
import { buildTrustSummary, resolveEvidenceCitations } from "../evidence/citations.js";
import {
  createEmbeddingContentHash,
  createProviderFingerprint,
  createProviderKey
} from "../embeddings/fingerprint.js";
import { createEvidenceSignature } from "../memory/evidence-signature.js";
import { createMemorySubjectKey } from "../memory/lifecycle.js";
import {
  pendingQuality,
  withResolvedQuality,
  writeExplicitMemoryQuality
} from "../memory/quality-cache.js";
import { redactSensitiveText } from "../privacy/redaction.js";
import type { RedactionPolicy } from "../privacy/policy.js";
import {
  beginOperation,
  completeOperation,
  createSourceTombstone,
  failOperation,
  findSourceTombstone,
  listOperations
} from "../operations/log.js";
import { initializeSchema } from "./migrations.js";
import {
  openLocalMemoryDatabase,
  invalidateLocalMemoryQuality,
  pruneLocalMemoryQuality,
  seedLegacyMemoryQuality
} from "./local-memory.js";
import { createStorageContentPolicy, type StorageContentPolicy } from "./content-policy.js";
import { recordMemoryEvent } from "../memory/events.js";
import { moveTopicMemberships } from "../memory/topics.js";
import {
  addSourceWithChunks,
  findSourcesMentioningFile,
  listSourceChunks,
  readChunkWindow,
  readConversationWindow,
  readSource,
  readSourceMetadata,
  shouldSuppressSourceWrite
} from "./source-store.js";
import {
  addMemoryRelation as addStoredMemoryRelation,
  deleteMemoryRelation as deleteStoredMemoryRelation,
  listMemoryRelations as listStoredMemoryRelations,
  updateMemoryLifecycle as updateStoredMemoryLifecycle
} from "./lifecycle-store.js";
import {
  activateEmbeddingIndexRebuild as activateStoredEmbeddingIndexRebuild,
  beginEmbeddingIndexRebuild as beginStoredEmbeddingIndexRebuild,
  listEmbeddingOwners as listStoredEmbeddingOwners,
  reconcileEmbeddingJobs as reconcileStoredEmbeddingJobs
} from "./embedding-store.js";
import { withTransaction } from "./transactions.js";
import type {
  CommitRecord,
  DecisionRecord,
  DurableMemory,
  EmbeddingJob,
  EmbeddingJobState,
  EmbeddingOwner,
  EmbeddingOwnerKind,
  EmbeddingVector,
  EvidenceRef,
  ExtractedMemory,
  InvestigationEntityLink,
  InvestigationEntityRef,
  MemoryCandidate,
  MemoryOrigin,
  MemoryChunk,
  MemoryLayerFilter,
  MemoryLayerOwner,
  MemoryLifecycleStatus,
  MemoryPromotionState,
  MemoryQualityStatus,
  MemoryRelation,
  MemoryRelationType,
  MemorySearchResult,
  MemorySource,
  MemoryType,
  SearchResult,
  SourceFailure,
  SourceType,
  SyncCursor,
  SyncSourceName,
  SyncStatus,
  TemporaryMemory,
  TemporaryMemoryKind,
  TemporaryMemorySearchResult,
  TemporaryMemoryUpsertInput
} from "../types.js";
import type {
  BeginOperationInput,
  CreateSourceTombstoneInput,
  FinishOperationInput,
  ListOperationsInput,
  OperationLogEntry,
  OperationType,
  SourceTombstone
} from "../operations/types.js";

function sanitizeCommit(policy: StorageContentPolicy, commit: CommitRecord): CommitRecord {
  return {
    hash: policy.identifier(commit.hash),
    authorName: policy.text(commit.authorName),
    authorEmail: policy.text(commit.authorEmail),
    authoredAt: commit.authoredAt,
    message: policy.text(commit.message),
    changedFiles: commit.changedFiles.map(policy.path),
    diffSummary: policy.text(commit.diffSummary)
  };
}

function sanitizeDecision(policy: StorageContentPolicy, decision: DecisionRecord): DecisionRecord {
  return {
    scope: sanitizeScope(policy, decision.scope),
    id: policy.identifier(decision.id),
    topic: policy.text(decision.topic),
    decision: policy.text(decision.decision),
    reason: policy.text(decision.reason),
    status: policy.text(decision.status),
    evidence: policy.evidence(decision.evidence),
    createdAt: decision.createdAt
  };
}

function sanitizeExtractedMemory(policy: StorageContentPolicy, memory: ExtractedMemory): ExtractedMemory {
  const parsed = memory.statement === undefined ? undefined : parseStatement(memory.statement, memory.type);
  if (memory.statement !== undefined && !parsed) throw new Error("Invalid memory statement");
  const statement = parsed ? createStatement(policy.text(parsed.text), memory.type, parsed.origin,
    Object.fromEntries(Object.entries(parsed.fields).map(([key, value]) => [key, policy.text(value)]))) : undefined;
  return {
    ...(statement ? { statement } : {}),
    scope: sanitizeScope(policy, memory.scope),
    layer: sanitizeLayer(policy, memory.layer),
    origin: sanitizeMemoryOrigin(policy, memory.origin),
    type: memory.type,
    title: policy.text(memory.title),
    summary: statement?.text ?? policy.text(memory.summary),
    reason: policy.text(memory.reason),
    confidence: memory.confidence,
    evidence: policy.evidence(memory.evidence),
    relatedFiles: memory.relatedFiles.map(policy.path),
    dedupeKey: policy.identifier(memory.dedupeKey)
  };
}

function sanitizeTemporaryMemory(
  policy: StorageContentPolicy,
  input: TemporaryMemoryUpsertInput
): TemporaryMemoryUpsertInput {
  return {
    scope: sanitizeScope(policy, input.scope),
    ...(input.layer === undefined ? {} : { layer: sanitizeLayer(policy, input.layer) }),
    origin: sanitizeMemoryOrigin(policy, input.origin),
    ...(input.id === undefined ? {} : { id: policy.identifier(input.id) }),
    ...(input.projectId === undefined ? {} : { projectId: policy.path(input.projectId) }),
    ...(input.threadId === undefined ? {} : { threadId: policy.identifier(input.threadId) }),
    ...(input.sessionId === undefined ? {} : { sessionId: policy.identifier(input.sessionId) }),
    ...(input.sourceAdapter === undefined ? {} : { sourceAdapter: policy.text(input.sourceAdapter) }),
    kind: input.kind,
    title: policy.text(input.title),
    summary: policy.text(input.summary),
    ...(input.details === undefined ? {} : { details: policy.text(input.details) }),
    ...(input.relatedFiles === undefined ? {} : { relatedFiles: input.relatedFiles.map(policy.path) }),
    ...(input.evidence === undefined ? {} : { evidence: policy.evidence(input.evidence) }),
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt })
  };
}

function sanitizeEntityRef(
  policy: StorageContentPolicy,
  entity: InvestigationEntityRef
): InvestigationEntityRef {
  if (entity.entityType === "file") {
    return { ...entity, entityId: policy.path(entity.entityId) };
  }
  if (entity.entityType === "chunk") {
    return { ...entity, entityId: policy.locator(entity.entityId) };
  }
  return { ...entity, entityId: policy.identifier(entity.entityId) };
}

function sanitizeEmbeddingOwnerId(
  policy: StorageContentPolicy,
  ownerKind: EmbeddingOwnerKind | undefined,
  ownerId: string
): string {
  return ownerKind === "chunk" || /:chunk:\d+$/.test(ownerId)
    ? policy.locator(ownerId)
    : policy.identifier(ownerId);
}

function sanitizeEmbeddingVectorInput<T extends Omit<EmbeddingVector, "createdAt" | "updatedAt">>(
  policy: StorageContentPolicy,
  input: T
): T {
  return {
    ...input,
    ownerId: sanitizeEmbeddingOwnerId(policy, input.ownerKind, input.ownerId),
    model: policy.text(input.model)
  };
}

function createDurableContentPolicy(
  db: DatabaseSync,
  base: StorageContentPolicy
): StorageContentPolicy {
  const identifier = (raw: string): string => {
    const rawHash = createEmbeddingContentHash(raw);
    if (hasPrivateIdentityTable(db)) {
      const existing = db.prepare(
        "select stored_identity from private_identity_mappings where raw_hash = ?"
      ).get(rawHash) as { stored_identity: string } | undefined;
      if (existing) return existing.stored_identity;
    }
    const stored = base.identifier(raw);
    if (stored !== raw && hasPrivateIdentityTable(db)) {
      db.prepare(
        `insert into private_identity_mappings (raw_hash, stored_identity, created_at)
         values (?, ?, ?)
         on conflict(raw_hash) do nothing`
      ).run(rawHash, stored, new Date().toISOString());
    }
    return stored;
  };
  const locator = (raw: string): string => {
    const chunk = /^(.*):chunk:(\d+)$/.exec(raw);
    return chunk ? `${identifier(chunk[1] ?? "")}:chunk:${chunk[2]}` : identifier(raw);
  };
  const json = <T>(value: T): T => sanitizeStoredJson(value, base.text, identifier) as T;
  return Object.freeze({
    privacyPolicy: base.privacyPolicy,
    text: base.text,
    identifier,
    locator,
    path: identifier,
    json,
    evidence: (value: readonly EvidenceRef[]) => value.map((item: EvidenceRef) => ({
      sourceType: item.sourceType,
      sourceId: identifier(item.sourceId),
      ...(item.locator === undefined ? {} : { locator: locator(item.locator) })
    }))
  });
}

function hasPrivateIdentityTable(db: DatabaseSync): boolean {
  return Boolean(db.prepare(
    "select 1 from sqlite_master where type = 'table' and name = 'private_identity_mappings'"
  ).get());
}

function sanitizeStoredJson(
  value: unknown,
  text: (value: string) => string,
  identifier: (value: string) => string
): unknown {
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeStoredJson(item, text, identifier));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      identifier(key),
      sanitizeStoredJson(item, text, identifier)
    ])
  );
}

export interface AddSourceInput {
  source: MemorySource;
  chunks: Array<{
    text: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface ProjectSummary {
  sources: number;
  chunks: number;
  commits: number;
  decisions: number;
  candidateMemories: number;
  promotedMemories: number;
  temporaryMemories?: number;
  memoryHealth?: {
    active: number;
    needsReview: number;
    quarantined: number;
    retired: number;
    replaced: number;
  };
  lastSyncAt?: string;
  syncSources: Partial<Record<SyncSourceName, SyncStatus>>;
  extraction?: ExtractionStatus;
}

export interface ExtractionJob {
  adapter: SyncSourceName;
  sourceType: "conversation" | "commit";
  sourceId: string;
  enqueuedAt: string;
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
}

export interface ExtractionStatus {
  pending: number;
  lastSuccessAt?: string;
}

export type MemoryQualityStatusFilter = MemoryQualityStatus | "all";
export type MemoryLifecycleStatusFilter = MemoryLifecycleStatus | "all";

export interface MemoryStore {
  init(): void;
  close(): void;
  beginOperation<T extends OperationType>(input: BeginOperationInput<T>): OperationLogEntry<T>;
  completeOperation(id: string, input?: FinishOperationInput): OperationLogEntry;
  failOperation(id: string, input?: FinishOperationInput): OperationLogEntry;
  listOperations(input?: ListOperationsInput): OperationLogEntry[];
  createSourceTombstone(input: CreateSourceTombstoneInput): SourceTombstone;
  findSourceTombstone(sourceType: SourceType, sourceId: string): SourceTombstone | undefined;
  addSourceWithChunks(input: AddSourceInput): string;
  readSource(sourceId: string): MemorySource | undefined;
  readSourceMetadata(sourceId: string): Omit<MemorySource, "rawContent"> | undefined;
  prefetchCitationReads(evidence: EvidenceRef[]): void;
  readChunkWindow(sourceId: string, chunkIndex: number, before: number, after: number): MemoryChunk[];
  listSourceChunks(sourceId: string): MemoryChunk[];
  readConversationWindow(sourceId: string, anchorChunkId: string, before: number, after: number): MemoryChunk[];
  search(input: { query: string; sourceTypes?: string[]; limit?: number }): SearchResult[];
  readSearchResultsByChunkIds(chunkIds: string[]): SearchResult[];
  addCommit(commit: CommitRecord): string;
  readCommit(hash: string): CommitRecord | undefined;
  findCommits(input: { query?: string; filePath?: string; limit?: number }): CommitRecord[];
  hasSensitiveGitEvidence(): boolean;
  getEntityLinks(entity: InvestigationEntityRef): InvestigationEntityLink[];
  findSourcesMentioningFile(filePath: string, limit?: number): MemorySource[];
  findMemoriesByEvidence(sourceType: SourceType, sourceId: string, limit?: number): MemorySearchResult[];
  setSyncCursor(source: SyncSourceName, cursorKey: string, cursorValue: string): void;
  getSyncCursor(source: SyncSourceName, cursorKey: string): SyncCursor | undefined;
  recordSyncStatus(status: SyncStatus): void;
  getSyncStatus(source: SyncSourceName): SyncStatus | undefined;
  listSyncStatuses(): SyncStatus[];
  enqueueExtractionEvidence(adapter: SyncSourceName, sourceType: ExtractionJob["sourceType"], sourceId: string): void;
  listPendingExtractionEvidence(sources?: readonly SyncSourceName[], limit?: number): ExtractionJob[];
  completeExtractionEvidence(jobs: readonly ExtractionJob[], completedAt?: string): void;
  discardExtractionEvidence(jobs: readonly ExtractionJob[]): void;
  recordExtractionFailure(jobs: readonly ExtractionJob[], error: string, attemptedAt?: string): void;
  getExtractionStatus(): ExtractionStatus;
  recordSourceFailure(input: {
    adapter: SyncSourceName;
    path: string;
    errorCode: string;
    message: string;
    occurredAt?: string;
  }): SourceFailure;
  resolveSourceFailures(adapter: SyncSourceName, path: string, resolvedAt?: string): number;
  listSourceFailures(input?: {
    adapter?: SyncSourceName;
    resolved?: boolean;
    limit?: number | null;
  }): SourceFailure[];
  listEmbeddingOwners(): EmbeddingOwner[];
  reconcileEmbeddingJobs(input: {
    providerKey: string;
    endpointHash: string;
    model: string;
  }): { enqueued: number; removedJobs: number; removedVectors: number };
  beginEmbeddingIndexRebuild(input: {
    providerKey: string;
    endpointHash: string;
    model: string;
  }): { removedVectors: number; requeued: number; rebuildToken: string };
  activateEmbeddingIndexRebuild(input: {
    providerKey: string;
    rebuildToken: string;
    providerFingerprint: string;
  }): number;
  listEmbeddingJobs(input?: {
    providerKey?: string;
    state?: EmbeddingJobState;
    ownerKind?: EmbeddingOwnerKind;
    ownerId?: string;
  }): EmbeddingJob[];
  recordEmbeddingJobAttempts(inputs: ReadonlyArray<Pick<
    EmbeddingJob,
    "ownerKind" | "ownerId" | "contentHash" | "ownerVersion" | "providerKey" | "indexGeneration" | "targetFingerprint"
  >>): void;
  completeEmbeddingJob(input: Omit<EmbeddingVector, "createdAt" | "updatedAt"> & {
    indexGeneration?: string | undefined;
  }): void;
  markEmbeddingJobFailed(input: {
    ownerKind: EmbeddingOwnerKind;
    ownerId: string;
    contentHash: string;
    ownerVersion: string;
    providerKey: string;
    indexGeneration?: string | undefined;
    targetFingerprint?: string | undefined;
    error: string;
  }): void;
  upsertEmbeddingVector(input: Omit<EmbeddingVector, "createdAt" | "updatedAt">): void;
  listEmbeddingVectors(input?: {
    providerKey?: string;
    providerFingerprint?: string;
    ownerKind?: EmbeddingOwnerKind;
    ownerId?: string;
  }): EmbeddingVector[];
  listActiveEmbeddingVectors(input?: {
    providerKey?: string;
    providerFingerprint?: string;
    ownerKind?: EmbeddingOwnerKind;
    ownerId?: string;
  }): EmbeddingVector[];
  deleteStaleEmbeddingJobsForMemory(memoryId: string): number;
  deleteStaleEmbeddingVectorsForMemory(memoryId: string): number;
  deleteEmbeddingJobsForOwner(ownerKind: EmbeddingOwnerKind, ownerId: string): number;
  deleteEmbeddingVectorsForOwner(ownerKind: EmbeddingOwnerKind, ownerId: string): number;
  upsertMemoryCandidate(
    memory: ExtractedMemory,
    options?: {
      promotionState?: MemoryPromotionState;
      qualityStatus?: MemoryQualityStatus;
      qualityReasons?: string[];
      lastVerifiedAt?: string | undefined;
    }
  ): MemoryCandidate;
  promoteMemoryCandidate(
    candidateId: string,
    source?: DurableMemory["source"],
    options?: { layer?: string | undefined; actor?: import("../types.js").OperationActor | undefined }
  ): DurableMemory;
  upsertManualDecisionMemory(decision: DecisionRecord, origin?: MemoryOrigin): DurableMemory;
  readMemory(id: string): DurableMemory | undefined;
  updateMemoryLifecycle(
    id: string,
    lifecycle: {
      lifecycleStatus: MemoryLifecycleStatus;
      validFrom?: string;
      validUntil?: string | null;
      statusReason?: string | null;
      statusChangedAt?: string;
      actor?: import("../types.js").OperationActor | undefined;
      replacementMemoryId?: string | undefined;
    }
  ): DurableMemory;
  addMemoryRelation(input: {
    fromMemoryId: string;
    toMemoryId: string;
    relationType: MemoryRelationType;
    createdAt?: string;
    reason?: string;
  }): MemoryRelation;
  listMemoryRelations(input?: {
    fromMemoryId?: string;
    toMemoryId?: string;
    relationType?: MemoryRelationType;
  }): MemoryRelation[];
  deleteMemoryRelation(id: string): boolean;
  listMemoryCandidates(input?: {
    type?: MemoryType;
    promotionState?: MemoryPromotionState;
    qualityStatus?: MemoryQualityStatusFilter;
    layer?: MemoryLayerFilter;
    owner?: MemoryLayerOwner;
    query?: string;
    limit?: number | null;
    excludeTerminalReviews?: boolean;
  }): MemoryCandidate[];
  listMemories(input?: {
    type?: MemoryType;
    status?: "promoted" | "candidate";
    lifecycleStatus?: MemoryLifecycleStatusFilter;
    qualityStatus?: MemoryQualityStatusFilter;
    layer?: MemoryLayerFilter;
    owner?: MemoryLayerOwner;
    query?: string;
    limit?: number | null;
  }): DurableMemory[];
  updateMemoryQuality(
    kind: "candidate" | "promoted",
    id: string,
    quality: {
      qualityStatus: MemoryQualityStatus;
      qualityReasons: string[];
      lastVerifiedAt?: string | undefined;
    }
  ): void;
  readTemporaryMemory(id: string): TemporaryMemory | undefined;
  keepTemporaryMemory(id: string, now?: string): TemporaryMemory;
  upsertTemporaryMemory(input: TemporaryMemoryUpsertInput): TemporaryMemory;
  searchTemporaryMemory(input: {
    query: string;
    threadId?: string;
    sessionId?: string;
    now?: string;
    limit?: number;
  }): TemporaryMemorySearchResult[];
  listActiveTemporaryMemory(input?: {
    threadId?: string;
    sessionId?: string;
    now?: string;
    projectOnly?: boolean;
    limit?: number;
  }): TemporaryMemory[];
  deleteExpiredTemporaryMemories(input?: { now?: string; expiredOnly?: boolean }): number;
  searchMemoryLayer(input?: {
    query?: string;
    type?: MemoryType;
    status?: "promoted" | "candidate";
    lifecycleStatus?: MemoryLifecycleStatusFilter;
    qualityStatus?: MemoryQualityStatusFilter;
    layer?: MemoryLayerFilter;
    owner?: MemoryLayerOwner;
    offset?: number;
    limit?: number;
    summaryOnly?: boolean;
  }): MemorySearchResult[];
  readMemorySearchResultsByIds(memoryIds: string[], input?: {
    lifecycleStatus?: MemoryLifecycleStatusFilter;
    includeCandidates?: boolean;
    summaryOnly?: boolean;
  }): MemorySearchResult[];
  getProjectSummary(): ProjectSummary;
  maintainLocalQualityCache(): number;
  readonly contentPolicy: StorageContentPolicy;
  db: DatabaseSync;
  localDb: DatabaseSync;
  paths: {
    rootDir: string;
    dataDir: string;
    databasePath: string;
    localDatabasePath: string;
    conversationsDir: string;
    decisionsDir: string;
  };
}

interface SearchRow {
  chunk_id: string;
  source_id: string;
  source_type: SourceType;
  title: string;
  text: string;
  metadata_json: string;
  score: number;
}

interface CommitRow {
  hash: string;
  author_name: string;
  author_email: string;
  authored_at: string;
  message: string;
  changed_files_json: string;
  diff_summary: string;
}

interface SyncCursorRow {
  source: SyncSourceName;
  cursor_key: string;
  cursor_value: string;
  updated_at: string;
}

interface SyncStatusRow {
  source: SyncSourceName;
  enabled: number;
  last_sync_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  metadata_json: string;
}

interface SourceFailureRow {
  id: string;
  adapter: SyncSourceName;
  path: string;
  error_code: string;
  message: string;
  first_occurred_at: string;
  last_occurred_at: string;
  attempts: number;
  resolved_at: string | null;
}

interface MemoryCandidateRow {
  scope_json: string;
  scope_key: string;
  layer: string;
  origin_json: string | null;
  statement_json: string | null;
  id: string;
  type: MemoryType;
  title: string;
  summary: string;
  reason: string;
  confidence: number;
  evidence_json: string;
  related_files_json: string;
  dedupe_key: string;
  promotion_state: MemoryPromotionState;
  promoted_memory_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MemoryRow {
  scope_json: string;
  scope_key: string;
  layer: string;
  origin_json: string | null;
  statement_json: string | null;
  id: string;
  type: MemoryType;
  title: string;
  summary: string;
  reason: string;
  confidence: number;
  evidence_json: string;
  related_files_json: string;
  dedupe_key: string;
  source: DurableMemory["source"];
  subject_key: string;
  lifecycle_status: MemoryLifecycleStatus;
  valid_from: string;
  valid_until: string | null;
  status_reason: string | null;
  status_changed_at: string;
  lifecycle_generation: string;
  created_at: string;
  promoted_at: string;
}

interface TemporaryMemoryRow {
  base_id: string;
  scope_json: string;
  scope_key: string;
  layer: string;
  origin_json: string | null;
  id: string;
  project_id: string;
  thread_id: string | null;
  session_id: string | null;
  source_adapter: string | null;
  kind: TemporaryMemoryKind;
  title: string;
  summary: string;
  details: string;
  related_files_json: string;
  evidence_json: string;
  confidence: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

interface TemporaryMemorySearchRow extends TemporaryMemoryRow {
  score: number;
}

interface RelationRow {
  from_type: string;
  from_id: string;
  relation: string;
  to_type: string;
  to_id: string;
  locator: string | null;
}

interface EmbeddingJobRow {
  owner_kind: EmbeddingOwnerKind;
  owner_id: string;
  content_hash: string;
  owner_version: string;
  provider_key: string;
  endpoint_hash: string;
  model: string;
  index_generation: string;
  target_fingerprint: string | null;
  provider_fingerprint: string | null;
  state: EmbeddingJobState;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface EmbeddingVectorRow {
  owner_kind: EmbeddingOwnerKind;
  owner_id: string;
  content_hash: string;
  owner_version: string;
  provider_key: string;
  endpoint_hash: string;
  model: string;
  provider_fingerprint: string;
  dimension: number;
  vector_blob: Uint8Array;
  created_at: string;
  updated_at: string;
}

interface ActiveEmbeddingVectorRow extends EmbeddingVectorRow {
  current_chunk_text: string | null;
  current_memory_title: string | null;
  current_memory_summary: string | null;
  current_memory_reason: string | null;
  current_memory_statement: string | null;
  current_memory_type: MemoryType;
}

const TEMPORARY_MEMORY_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const TEMPORARY_MEMORY_MAX_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const SQLITE_READ_BATCH_SIZE = 500;

export interface OpenMemoryStoreOptions {
  readonly privacyPolicy?: RedactionPolicy;
  readonly backupRetention?: number;
  /** Resolves the layer for working context; injectable so tests need no global device identity. */
  readonly deviceLayer?: () => string;
  /** Injectable for tests; configured stores keep this database outside cloud snapshots. */
  readonly localDatabasePath?: string;
}

export class MemoryStoreCheckpointBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryStoreCheckpointBusyError";
  }
}

export function deviceLocalMemoryDatabasePath(rootDir: string): string {
  const dataDir = basename(rootDir) === ".code-butler" ? rootDir : join(rootDir, ".code-butler");
  return process.env.VITEST
    ? join(dataDir, "memory-local.sqlite")
    : join(stateDirectory(basename(rootDir) === ".code-butler" ? join(rootDir, "..") : rootDir), "memory-local.sqlite");
}

export function openMemoryStore(rootDir: string, options: OpenMemoryStoreOptions = {}): MemoryStore {
  const dataDir = basename(rootDir) === ".code-butler" ? rootDir : join(rootDir, ".code-butler");
  const conversationsDir = join(dataDir, "imports", "conversations");
  const decisionsDir = join(dataDir, "decisions");
  const databasePath = join(dataDir, "memory.sqlite");
  const localDatabasePath = options.localDatabasePath ?? deviceLocalMemoryDatabasePath(rootDir);
  mkdirSync(dataDir, { recursive: true });

  const releaseHandle = registerDatabaseHandle(dataDir);
  let db: DatabaseSync;
  try { db = new DatabaseSync(databasePath); }
  catch (error) { releaseHandle(); throw error; }
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  let localDb: DatabaseSync;
  try {
    localDb = openLocalMemoryDatabase(localDatabasePath);
  } catch (error) {
    db.close();
    releaseHandle();
    throw error;
  }
  // Resolved once, and lazily, so opening a store never reaches for the global device identity.
  let resolvedDeviceLayer: string | undefined;
  const workingContextLayer = (): string =>
    resolvedDeviceLayer ??= (options.deviceLayer ?? deviceLayer)();
  const baseContentPolicy = createStorageContentPolicy(options.privacyPolicy);
  const contentPolicy = createDurableContentPolicy(db, baseContentPolicy);
  const backupRetention = options.backupRetention;
  let closed = false;

  const store: MemoryStore = {
    db,
    localDb,
    contentPolicy,
    paths: {
      rootDir,
      dataDir,
      databasePath,
      localDatabasePath,
      conversationsDir,
      decisionsDir
    },
    init() {
      mkdirSync(conversationsDir, { recursive: true });
      mkdirSync(decisionsDir, { recursive: true });
      const before = readMainSchemaVersion(db);
      if (before < 20) seedLegacyMemoryQuality(db, localDb);
      initializeSchema(db, databasePath, backupRetention === undefined ? {} : { backupRetention });
      if (before < 20) {
        invalidateLocalMemoryQuality(localDb);
        pruneLocalMemoryQuality(db, localDb);
      }
    },
    maintainLocalQualityCache() {
      return pruneLocalMemoryQuality(db, localDb);
    },
    close() {
      if (closed) return;
      const busy = (db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number }).busy !== 0 ||
        (localDb.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number }).busy !== 0;
      if (busy) throw new MemoryStoreCheckpointBusyError(
        "Cannot safely close Code Butler memory database: another SQLite reader prevented WAL checkpointing. Close the reader and retry before committing or syncing this project."
      );
      try { localDb.close(); } finally { try { db.close(); } finally { closed = true; releaseHandle(); } }
    },
    beginOperation(input) {
      return beginOperation(db, input);
    },
    completeOperation(id, input = {}) {
      return completeOperation(db, id, input);
    },
    failOperation(id, input = {}) {
      return failOperation(db, id, input);
    },
    listOperations(input = {}) {
      return listOperations(db, input);
    },
    createSourceTombstone(input) {
      return createSourceTombstone(db, {
        ...input,
        sourceId: contentPolicy.identifier(input.sourceId)
      });
    },
    findSourceTombstone(sourceType, sourceId) {
      return findSourceTombstone(db, sourceType, contentPolicy.identifier(sourceId));
    },
    addSourceWithChunks(input) {
      return addSourceWithChunks(db, contentPolicy, input);
    },
    readSource(sourceId) {
      return cachedRead(store,`raw-source:${sourceId}`,()=>readSource(db, contentPolicy, sourceId));
    },
    readSourceMetadata(sourceId) {
      return cachedRead(store, `source:${sourceId}`, () => readSourceMetadata(db, contentPolicy, sourceId));
    },
    prefetchCitationReads(evidence) {
      const sourceIds=[...new Set(evidence.filter(e=>e.sourceType!=="commit").map(e=>contentPolicy.identifier(e.sourceId)))].filter(id=>!hasCachedRead(store,`source:${id}`));
      const chunkIds=[...new Set(evidence.filter(e=>!hasCachedRead(store,JSON.stringify(["window",e.sourceId,e.locator,0,0]))).flatMap(e=>e.locator ? [contentPolicy.identifier(e.locator)] : []))];
      const hashes=[...new Set(evidence.filter(e=>e.sourceType==="commit").map(e=>contentPolicy.identifier(e.sourceId)))].filter(id=>!hasCachedRead(store,`commit:${id}`));
      for(const batch of chunked(sourceIds,SQLITE_READ_BATCH_SIZE)) {
        const rows=db.prepare(`select id,type,title,origin,metadata_json from sources where id in (${batch.map(()=>"?").join(",")})`).all(...batch) as Array<{id:string;type:MemorySource["type"];title:string;origin:string;metadata_json:string}>;
        const byId=new Map(rows.map(r=>[r.id,{id:r.id,type:r.type,title:r.title,origin:r.origin,metadata:parseJsonObject(r.metadata_json)}]));
        for(const id of batch) cachedRead(store,`source:${id}`,()=>byId.get(id));
      }
      for(const batch of chunked(chunkIds,SQLITE_READ_BATCH_SIZE)) {
        const rows=db.prepare(`select * from chunks where id in (${batch.map(()=>"?").join(",")})`).all(...batch) as Array<{id:string;source_id:string;chunk_index:number;text:string;metadata_json:string}>;
        const byId=new Map(rows.map(r=>[r.id,{id:r.id,sourceId:r.source_id,chunkIndex:r.chunk_index,text:r.text,metadata:parseJsonObject(r.metadata_json)}]));
        for(const ref of evidence) if(ref.locator && batch.includes(ref.locator)) {
          const row=byId.get(ref.locator);
          cachedRead(store,JSON.stringify(["window",ref.sourceId,ref.locator,0,0]),()=>row?.sourceId===ref.sourceId ? [row] : []);
        }
      }
      for(const batch of chunked(hashes,SQLITE_READ_BATCH_SIZE)) {
        const rows=db.prepare(`select * from commits where hash in (${batch.map(()=>"?").join(",")})`).all(...batch) as unknown as CommitRow[];
        const byId=new Map(rows.map(r=>[r.hash,commitFromRow(r)]));
        for(const id of batch) cachedRead(store,`commit:${id}`,()=>byId.get(id));
      }
    },
    readChunkWindow(sourceId, chunkIndex, before, after) {
      return readChunkWindow(db, contentPolicy, sourceId, chunkIndex, before, after);
    },
    listSourceChunks(sourceId) {
      return listSourceChunks(db, contentPolicy, sourceId);
    },
    readConversationWindow(sourceId, anchorChunkId, before, after) {
      return cachedRead(store, JSON.stringify(["window", sourceId, anchorChunkId, before, after]), () => readConversationWindow(db, contentPolicy, sourceId, anchorChunkId, before, after));
    },
    search(input) {
      const query = toFtsQuery(input.query);
      const limit = normalizeLimit(input.limit);
      const sourceTypes = input.sourceTypes?.filter(Boolean) ?? [];
      const params: Array<string | number> = [query];
      let sourceTypeClause = "";
      if (sourceTypes.length > 0) {
        sourceTypeClause = `and f.source_type in (${sourceTypes.map(() => "?").join(", ")})`;
        params.push(...sourceTypes);
      }
      params.push(limit);

      const rows = db
        .prepare(
          `select
             f.chunk_id,
             f.source_id,
             f.source_type,
             f.title,
             f.text,
             c.metadata_json,
             bm25(chunks_fts) as score
           from chunks_fts f
           join chunks c on c.id = f.chunk_id
           where chunks_fts match ?
           ${sourceTypeClause}
           order by score asc
           limit ?`
        )
        .all(...params) as unknown as SearchRow[];

      return rows.map((row) => ({
        chunkId: row.chunk_id,
        sourceId: row.source_id,
        sourceType: row.source_type,
        title: row.title,
        text: row.text,
        score: row.score,
        metadata: parseJsonObject(row.metadata_json),
        evidence: {
          sourceType: row.source_type,
          sourceId: row.source_id,
          locator: row.chunk_id
        }
      }));
    },
    readSearchResultsByChunkIds(chunkIds) {
      if (chunkIds.length === 0) return [];
      const rows = chunked(chunkIds, SQLITE_READ_BATCH_SIZE).flatMap((batch) =>
        db.prepare(
          `select c.id as chunk_id, c.source_id, s.type as source_type, s.title, c.text, c.metadata_json
           from chunks c join sources s on s.id = c.source_id
           where c.id in (${batch.map(() => "?").join(", ")})`
        ).all(...batch) as unknown as Array<Omit<SearchRow, "score">>
      );
      const byId = new Map(rows.map((row) => [row.chunk_id, row]));
      return chunkIds.flatMap((chunkId) => {
        const row = byId.get(chunkId);
        return row ? [{
          chunkId: row.chunk_id,
          sourceId: row.source_id,
          sourceType: row.source_type,
          title: row.title,
          text: row.text,
          score: 0,
          metadata: parseJsonObject(row.metadata_json),
          evidence: { sourceType: row.source_type, sourceId: row.source_id, locator: row.chunk_id }
        }] : [];
      });
    },
    addCommit(commit) {
      return withTransaction(db, () => {
        if (shouldSuppressSourceWrite(db, "commit", commit.hash, contentPolicy.identifier)) {
          return contentPolicy.identifier(commit.hash);
        }
        commit = sanitizeCommit(contentPolicy, commit);
        db.prepare(
          `insert into commits
             (hash, author_name, author_email, authored_at, message, changed_files_json, diff_summary)
           values (?, ?, ?, ?, ?, ?, ?)
           on conflict(hash) do update set
             author_name = excluded.author_name,
             author_email = excluded.author_email,
             authored_at = excluded.authored_at,
             message = excluded.message,
             changed_files_json = excluded.changed_files_json,
             diff_summary = excluded.diff_summary`
        ).run(
          commit.hash,
          commit.authorName,
          commit.authorEmail,
          commit.authoredAt,
          commit.message,
          JSON.stringify(commit.changedFiles),
          commit.diffSummary
        );
        const sourceId = store.addSourceWithChunks({
          source: {
            id: commit.hash,
            type: "commit",
            title: commit.message,
            origin: "git",
            rawContent: formatCommitRawContent(commit),
            metadata: {
              hash: commit.hash,
              authorName: commit.authorName,
              authorEmail: commit.authorEmail,
              authoredAt: commit.authoredAt,
              changedFiles: commit.changedFiles
            }
          },
          chunks: [
            {
              text: formatCommitSearchText(commit),
              metadata: { hash: commit.hash, changedFiles: commit.changedFiles }
            }
          ]
        });
        rebuildCommitRelations(db, commit);
        return sourceId;
      });
    },
    readCommit(hash) {
      return cachedRead(store,`commit:${hash}`,()=>{
      hash = contentPolicy.identifier(hash);
      const row = db
        .prepare(
          `select hash, author_name, author_email, authored_at, message, changed_files_json, diff_summary
           from commits
           where hash = ?`
        )
        .get(hash) as CommitRow | undefined;
      return row ? commitFromRow(row) : undefined;
      });
    },
    findCommits(input) {
      const query = input.query?.toLowerCase();
      const filePath = input.filePath === undefined ? undefined : contentPolicy.path(input.filePath);
      const limit = normalizeLimit(input.limit);
      const rows = db.prepare(
        `select hash, author_name, author_email, authored_at, message, changed_files_json, diff_summary
           from commits
          ${filePath ? "where exists (select 1 from json_each(commits.changed_files_json) where value = ?)" : ""}
          order by authored_at desc, rowid asc
          ${query ? "" : "limit ?"}`
      ).iterate(...(filePath ? [filePath] : []), ...(query ? [] : [limit])) as unknown as Iterable<CommitRow>;
      const matches: CommitRecord[] = [];
      for (const row of rows) {
        const commit = commitFromRow(row);
        if (query) {
          const haystack = [commit.hash, commit.message, commit.diffSummary, commit.changedFiles.join(" ")]
            .join(" ").toLowerCase();
          if (!haystack.includes(query)) continue;
        }
        matches.push(commit);
        if (matches.length >= limit) break;
      }
      return matches;
    },
    hasSensitiveGitEvidence() {
      const row = db.prepare(`select exists(
        select 1 from commits c, json_each(c.changed_files_json) f
        where lower(f.value) like 'secrets/%'
      ) as found`).get() as { found: number };
      return row.found !== 0;
    },
    getEntityLinks(entity) {
      entity = sanitizeEntityRef(contentPolicy, entity);
      const relationRows = db
        .prepare(
          `select from_type, from_id, relation, to_type, to_id, locator
           from relations
           where (from_type = ? and from_id = ?) or (to_type = ? and to_id = ?)
           order by from_type asc, relation asc, to_type asc`
        )
        .all(entity.entityType, entity.entityId, entity.entityType, entity.entityId) as unknown as RelationRow[];
      const links = relationRows.map((row) => relationToEntityLink(row, entity));

      if (entity.entityType === "temporary_memory") {
        const temporaryRows = db
          .prepare(
            `select memory_id, target_type, target_id, locator
             from temporary_memory_links
             where memory_id = ?`
          )
          .all(entity.entityId) as Array<{
          memory_id: string;
          target_type: string;
          target_id: string;
          locator: string | null;
        }>;
        links.push(
          ...temporaryRows.map((row) => ({
            sourceType: "temporary_memory",
            sourceId: row.memory_id,
            relation: "references",
            targetType: row.target_type,
            targetId: row.target_id,
            locator: row.locator ?? undefined,
            direction: "outgoing" as const
          }))
        );
      } else if (entity.entityType === "memory" || entity.entityType === "candidate") {
        const ownerKind = entity.entityType === "memory" ? "memory" : "candidate";
        const memoryLinkRows = db
          .prepare(
            `select owner_kind, owner_id, target_type, target_id, locator
             from memory_links
             where owner_kind = ? and owner_id = ?`
          )
          .all(ownerKind, entity.entityId) as Array<{
          owner_kind: "memory" | "candidate";
          owner_id: string;
          target_type: string;
          target_id: string;
          locator: string | null;
        }>;
        links.push(
          ...memoryLinkRows.map((row) => ({
            sourceType: row.owner_kind,
            sourceId: row.owner_id,
            relation: "references",
            targetType: row.target_type,
            targetId: row.target_id,
            locator: row.locator ?? undefined,
            direction: "outgoing" as const
          }))
        );
      } else {
        const memoryLinkRows = db
          .prepare(
            `select owner_kind, owner_id, target_type, target_id, locator
             from memory_links
             where target_type = ? and target_id = ?`
          )
          .all(entity.entityType, entity.entityId) as Array<{
          owner_kind: "memory" | "candidate";
          owner_id: string;
          target_type: string;
          target_id: string;
          locator: string | null;
        }>;
        links.push(
          ...memoryLinkRows.map((row) => ({
            sourceType: row.owner_kind,
            sourceId: row.owner_id,
            relation: "references",
            targetType: row.target_type,
            targetId: row.target_id,
            locator: row.locator ?? undefined,
            direction: "incoming" as const
          }))
        );
        const temporaryRows = db
          .prepare(
            `select memory_id, target_type, target_id, locator
             from temporary_memory_links
             where target_type = ? and target_id = ?`
          )
          .all(entity.entityType, entity.entityId) as Array<{
          memory_id: string;
          target_type: string;
          target_id: string;
          locator: string | null;
        }>;
        links.push(
          ...temporaryRows.map((row) => ({
            sourceType: "temporary_memory",
            sourceId: row.memory_id,
            relation: "references",
            targetType: row.target_type,
            targetId: row.target_id,
            locator: row.locator ?? undefined,
            direction: "incoming" as const
          }))
        );
      }

      return dedupeEntityLinks(links);
    },
    findSourcesMentioningFile(filePath, limit) {
      return findSourcesMentioningFile(db, contentPolicy, filePath, limit);
    },
    findMemoriesByEvidence(sourceType, sourceId, limit) {
      sourceId = contentPolicy.identifier(sourceId);
      const normalizedLimit = normalizeLimit(limit);
      const promoted = store
        .listMemories({ status: "promoted", limit: normalizedLimit * 2 })
        .filter((memory) =>
          memory.evidence.some((evidence) => evidence.sourceType === sourceType && evidence.sourceId === sourceId)
        )
        .map<MemorySearchResult>((memory) => memorySearchResult(store, "promoted", memory));
      const candidates = store
        .listMemoryCandidates({ limit: normalizedLimit * 2 })
        .filter((memory) =>
          memory.evidence.some((evidence) => evidence.sourceType === sourceType && evidence.sourceId === sourceId)
        )
        .map<MemorySearchResult>((memory) => memorySearchResult(store, "candidate", memory));
      return [...promoted, ...candidates].slice(0, normalizedLimit);
    },
    setSyncCursor(source, cursorKey, cursorValue) {
      db.prepare(
        `insert into sync_cursors (source, cursor_key, cursor_value, updated_at)
         values (?, ?, ?, ?)
         on conflict(source, cursor_key) do update set
           cursor_value = excluded.cursor_value,
           updated_at = excluded.updated_at`
      ).run(source, contentPolicy.identifier(cursorKey), contentPolicy.text(cursorValue), new Date().toISOString());
    },
    getSyncCursor(source, cursorKey) {
      cursorKey = contentPolicy.identifier(cursorKey);
      const row = db
        .prepare(
          `select source, cursor_key, cursor_value, updated_at
           from sync_cursors
           where source = ? and cursor_key = ?`
        )
        .get(source, cursorKey) as SyncCursorRow | undefined;
      if (!row) return undefined;
      return {
        source: row.source,
        cursorKey: row.cursor_key,
        cursorValue: row.cursor_value,
        updatedAt: row.updated_at
      };
    },
    recordSyncStatus(status) {
      const lastError = status.lastError === undefined ? undefined : contentPolicy.text(status.lastError);
      const metadata = contentPolicy.json(status.metadata ?? {});
      db.prepare(
        `insert into sync_sources (source, enabled, last_sync_at, last_success_at, last_error, metadata_json)
         values (?, ?, ?, ?, ?, ?)
         on conflict(source) do update set
           enabled = excluded.enabled,
           last_sync_at = excluded.last_sync_at,
           last_success_at = excluded.last_success_at,
           last_error = excluded.last_error,
           metadata_json = excluded.metadata_json`
      ).run(
        status.source,
        status.enabled ? 1 : 0,
        status.lastSyncAt ?? null,
        status.lastSuccessAt ?? null,
        lastError ?? null,
        JSON.stringify(metadata)
      );
    },
    getSyncStatus(source) {
      const row = db
        .prepare(
          `select source, enabled, last_sync_at, last_success_at, last_error, metadata_json
           from sync_sources
           where source = ?`
        )
        .get(source) as SyncStatusRow | undefined;
      return row ? syncStatusFromRow(row) : undefined;
    },
    listSyncStatuses() {
      const rows = db
        .prepare(
          `select source, enabled, last_sync_at, last_success_at, last_error, metadata_json
           from sync_sources
           order by source asc`
        )
        .all() as unknown as SyncStatusRow[];
      return rows.map(syncStatusFromRow);
    },
    enqueueExtractionEvidence(adapter, sourceType, sourceId) {
      db.prepare(
        `insert into extraction_jobs (adapter, source_type, source_id, enqueued_at)
         values (?, ?, ?, ?)
         on conflict(source_type, source_id) do update set
           adapter = excluded.adapter,
           enqueued_at = excluded.enqueued_at,
           attempts = 0,
           last_attempt_at = null,
           last_error = null`
      ).run(adapter, sourceType, contentPolicy.identifier(sourceId), new Date().toISOString());
    },
    listPendingExtractionEvidence(sources, limit = 100) {
      const selected = sources?.filter(Boolean) ?? [];
      const where = selected.length ? `where adapter in (${selected.map(() => "?").join(", ")})` : "";
      const rows = db.prepare(
        `select adapter, source_type, source_id, enqueued_at, attempts, last_attempt_at, last_error
         from extraction_jobs ${where}
         order by attempts, enqueued_at, source_type, source_id limit ?`
      ).all(...selected, Math.max(1, Math.floor(limit))) as unknown as Array<{
        adapter: SyncSourceName; source_type: ExtractionJob["sourceType"]; source_id: string;
        enqueued_at: string; attempts: number; last_attempt_at: string | null; last_error: string | null;
      }>;
      return rows.map(row => ({
        adapter: row.adapter, sourceType: row.source_type, sourceId: row.source_id,
        enqueuedAt: row.enqueued_at, attempts: row.attempts,
        ...(row.last_attempt_at ? { lastAttemptAt: row.last_attempt_at } : {}),
        ...(row.last_error ? { lastError: row.last_error } : {})
      }));
    },
    completeExtractionEvidence(jobs, completedAt = new Date().toISOString()) {
      withTransaction(db, () => {
        const remove = db.prepare("delete from extraction_jobs where source_type = ? and source_id = ?");
        for (const job of jobs) remove.run(job.sourceType, contentPolicy.identifier(job.sourceId));
        db.prepare("insert into extraction_status (id, last_success_at) values (1, ?) on conflict(id) do update set last_success_at = excluded.last_success_at").run(completedAt);
      });
    },
    discardExtractionEvidence(jobs) {
      const remove = db.prepare("delete from extraction_jobs where source_type = ? and source_id = ?");
      withTransaction(db, () => {
        for (const job of jobs) remove.run(job.sourceType, contentPolicy.identifier(job.sourceId));
      });
    },
    recordExtractionFailure(jobs, error, attemptedAt = new Date().toISOString()) {
      const update = db.prepare(
        `update extraction_jobs set attempts = attempts + 1, last_attempt_at = ?, last_error = ?
         where source_type = ? and source_id = ?`
      );
      const safeError = contentPolicy.text(error).slice(0, 500);
      withTransaction(db, () => {
        for (const job of jobs) update.run(attemptedAt, safeError, job.sourceType, contentPolicy.identifier(job.sourceId));
      });
    },
    getExtractionStatus() {
      const pending = (db.prepare("select count(*) as count from extraction_jobs").get() as { count: number }).count;
      const row = db.prepare("select last_success_at from extraction_status where id = 1")
        .get() as { last_success_at: string | null } | undefined;
      return { pending, ...(row?.last_success_at ? { lastSuccessAt: row.last_success_at } : {}) };
    },
    recordSourceFailure(input) {
      const occurredAt = input.occurredAt ?? new Date().toISOString();
      const path = contentPolicy.path(input.path);
      const errorCode = contentPolicy.identifier(input.errorCode);
      const message = contentPolicy.text(sanitizeSourceFailureMessage(input.message));
      db.prepare(
        `insert into source_failures (
           id, adapter, path, error_code, message, first_occurred_at, last_occurred_at, attempts, resolved_at
         ) values (?, ?, ?, ?, ?, ?, ?, 1, null)
         on conflict(adapter, path, error_code) do update set
           message = excluded.message,
           last_occurred_at = excluded.last_occurred_at,
           attempts = source_failures.attempts + 1,
           resolved_at = null`
      ).run(randomUUID(), input.adapter, path, errorCode, message, occurredAt, occurredAt);
      const row = db.prepare(
        `select id, adapter, path, error_code, message, first_occurred_at, last_occurred_at, attempts, resolved_at
         from source_failures where adapter = ? and path = ? and error_code = ?`
      ).get(input.adapter, path, errorCode) as unknown as SourceFailureRow;
      return sourceFailureFromRow(row);
    },
    resolveSourceFailures(adapter, path, resolvedAt) {
      path = contentPolicy.path(path);
      const result = db.prepare(
        `update source_failures set resolved_at = ?
         where adapter = ? and path = ? and resolved_at is null`
      ).run(resolvedAt ?? new Date().toISOString(), adapter, path);
      return Number(result.changes);
    },
    listSourceFailures(input = {}) {
      const conditions: string[] = [];
      const parameters: Array<string | number> = [];
      if (input.adapter !== undefined) {
        conditions.push("adapter = ?");
        parameters.push(input.adapter);
      }
      conditions.push(input.resolved === true ? "resolved_at is not null" : "resolved_at is null");
      const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
      parameters.push(input.limit === null ? -1 : normalizeLimit(input.limit));
      const rows = db.prepare(
        `select id, adapter, path, error_code, message, first_occurred_at, last_occurred_at, attempts, resolved_at
         from source_failures ${where}
         order by last_occurred_at desc, adapter asc, path asc, error_code asc
         limit ?`
      ).all(...parameters) as unknown as SourceFailureRow[];
      return rows.map(sourceFailureFromRow);
    },
    listEmbeddingOwners() {
      return listStoredEmbeddingOwners(db);
    },
    reconcileEmbeddingJobs(input) {
      return reconcileStoredEmbeddingJobs(db, contentPolicy, input);
    },
    beginEmbeddingIndexRebuild(input) {
      return beginStoredEmbeddingIndexRebuild(db, contentPolicy, input);
    },
    activateEmbeddingIndexRebuild(input) {
      return activateStoredEmbeddingIndexRebuild(db, input);
    },
    listEmbeddingJobs(input = {}) {
      const predicates: string[] = [];
      const parameters: string[] = [];
      if (input.providerKey !== undefined) {
        predicates.push("provider_key = ?");
        parameters.push(input.providerKey);
      }
      if (input.state !== undefined) {
        predicates.push("state = ?");
        parameters.push(input.state);
      }
      if (input.ownerKind !== undefined) {
        predicates.push("owner_kind = ?");
        parameters.push(input.ownerKind);
      }
      if (input.ownerId !== undefined) {
        predicates.push("owner_id = ?");
        parameters.push(sanitizeEmbeddingOwnerId(contentPolicy, input.ownerKind, input.ownerId));
      }
      const where = predicates.length > 0 ? `where ${predicates.join(" and ")}` : "";
      const rows = db.prepare(
        `select owner_kind, owner_id, content_hash, owner_version, provider_key, endpoint_hash, model,
                index_generation, target_fingerprint, provider_fingerprint, state, attempts,
                last_error, created_at, updated_at, completed_at
         from embedding_jobs ${where}
         order by owner_kind asc, owner_id asc, content_hash asc, provider_key asc`
      ).all(...parameters) as unknown as EmbeddingJobRow[];
      return rows.map(embeddingJobFromRow);
    },
    recordEmbeddingJobAttempts(inputs) {
      inputs = inputs.map((input) => ({
        ...input,
        ownerId: sanitizeEmbeddingOwnerId(contentPolicy, input.ownerKind, input.ownerId)
      }));
      withTransaction(db, () => {
        const readJob = db.prepare(
          `select owner_version, index_generation, target_fingerprint, state from embedding_jobs
           where owner_kind = ? and owner_id = ? and content_hash = ? and provider_key = ?`
        );
        const recordAttempt = db.prepare(
          `update embedding_jobs
           set attempts = attempts + 1, updated_at = ?
           where owner_kind = ? and owner_id = ? and content_hash = ? and provider_key = ?
             and owner_version = ? and index_generation = ? and state in ('pending', 'failed')`
        );
        const now = new Date().toISOString();
        for (const input of inputs) {
          const job = readJob.get(
            input.ownerKind,
            input.ownerId,
            input.contentHash,
            input.providerKey
          ) as { owner_version: string; index_generation: string; target_fingerprint: string | null; state: EmbeddingJobState } | undefined;
          if (!job) throw new Error("Embedding job not found");
          if (job.owner_version !== input.ownerVersion) {
            throw new Error("Embedding job owner generation does not match attempt generation");
          }
          if (job.index_generation !== input.indexGeneration) {
            throw new Error("Embedding job index generation does not match attempt generation");
          }
          if (job.target_fingerprint !== (input.targetFingerprint ?? null)) {
            throw new Error("Embedding job rebuild target does not match attempt target");
          }
          if (job.state !== "pending" && job.state !== "failed") {
            throw new Error("Embedding job must be pending or failed");
          }
          if (!isCurrentEmbeddingOwner(db, input)) {
            throw new Error("Embedding owner generation is no longer eligible");
          }
          const result = recordAttempt.run(
            now,
            input.ownerKind,
            input.ownerId,
            input.contentHash,
            input.providerKey,
            input.ownerVersion,
            input.indexGeneration
          );
          if (result.changes === 0) throw new Error("Embedding job must be pending or failed");
        }
      });
    },
    completeEmbeddingJob(input) {
      validateEmbeddingVectorInput(input);
      input = sanitizeEmbeddingVectorInput(contentPolicy, input);
      withTransaction(db, () => {
        const job = db.prepare(
          `select endpoint_hash, model, owner_version, index_generation, target_fingerprint, state
           from embedding_jobs
           where owner_kind = ? and owner_id = ? and content_hash = ? and provider_key = ?`
        ).get(
          input.ownerKind,
          input.ownerId,
          input.contentHash,
          input.providerKey
        ) as {
          endpoint_hash: string;
          model: string;
          owner_version: string;
          index_generation: string;
          target_fingerprint: string | null;
          state: EmbeddingJobState;
        } | undefined;
        if (!job) throw new Error("Embedding job not found");
        if (job.owner_version !== input.ownerVersion) {
          throw new Error("Embedding job owner generation does not match completion generation");
        }
        if (job.index_generation !== (input.indexGeneration ?? "")) {
          throw new Error("Embedding job index generation does not match completion generation");
        }
        if (job.index_generation !== "" && job.target_fingerprint === null) {
          throw new Error("Embedding rebuild target fingerprint is not active");
        }
        if (job.target_fingerprint !== null && job.target_fingerprint !== input.providerFingerprint) {
          throw new Error("Embedding completion fingerprint does not match rebuild target");
        }
        if (job.endpoint_hash !== input.endpointHash || job.model !== input.model) {
          throw new Error("Embedding job provider metadata does not match completion metadata");
        }
        if (job.state !== "pending" && job.state !== "failed") {
          throw new Error("Embedding job must be pending or failed");
        }
        if (!isCurrentEmbeddingOwner(db, input)) {
          throw new Error("Embedding owner generation is no longer eligible");
        }

        const now = new Date().toISOString();
        upsertEmbeddingVectorRow(db, input, now);
        const result = db.prepare(
          `update embedding_jobs
           set state = 'complete', provider_fingerprint = ?,
               last_error = null, updated_at = ?, completed_at = ?
           where owner_kind = ? and owner_id = ? and content_hash = ? and provider_key = ?
             and owner_version = ? and index_generation = ? and state in ('pending', 'failed')`
        ).run(
          input.providerFingerprint,
          now,
          now,
          input.ownerKind,
          input.ownerId,
          input.contentHash,
          input.providerKey,
          input.ownerVersion,
          input.indexGeneration ?? ""
        );
        if (result.changes === 0) throw new Error("Embedding job must be pending or failed");
      });
    },
    markEmbeddingJobFailed(input) {
      input = {
        ...input,
        ownerId: sanitizeEmbeddingOwnerId(contentPolicy, input.ownerKind, input.ownerId),
        error: contentPolicy.text(input.error)
      };
      withTransaction(db, () => {
        const job = db.prepare(
          `select owner_version, index_generation, target_fingerprint, state from embedding_jobs
           where owner_kind = ? and owner_id = ? and content_hash = ? and provider_key = ?`
        ).get(
          input.ownerKind,
          input.ownerId,
          input.contentHash,
          input.providerKey
        ) as { owner_version: string; index_generation: string; target_fingerprint: string | null; state: EmbeddingJobState } | undefined;
        if (!job) throw new Error("Embedding job not found");
        if (job.owner_version !== input.ownerVersion) {
          throw new Error("Embedding job owner generation does not match failure generation");
        }
        if (job.index_generation !== (input.indexGeneration ?? "")) {
          throw new Error("Embedding job index generation does not match failure generation");
        }
        if (job.target_fingerprint !== (input.targetFingerprint ?? null)) {
          throw new Error("Embedding job rebuild target does not match failure target");
        }
        if (job.state !== "pending" && job.state !== "failed") {
          throw new Error("Embedding job must be pending or failed");
        }
        if (!isCurrentEmbeddingOwner(db, input)) {
          throw new Error("Embedding owner generation is no longer eligible");
        }
        const result = db.prepare(
          `update embedding_jobs
           set state = 'failed', provider_fingerprint = null,
               last_error = ?, updated_at = ?, completed_at = null
           where owner_kind = ? and owner_id = ? and content_hash = ? and provider_key = ?
             and owner_version = ? and index_generation = ? and state in ('pending', 'failed')`
        ).run(
          sanitizeStoredEmbeddingError(input.error),
          new Date().toISOString(),
          input.ownerKind,
          input.ownerId,
          input.contentHash,
          input.providerKey,
          input.ownerVersion,
          input.indexGeneration ?? ""
        );
        if (result.changes === 0) throw new Error("Embedding job must be pending or failed");
      });
    },
    upsertEmbeddingVector(input) {
      validateEmbeddingVectorInput(input);
      input = sanitizeEmbeddingVectorInput(contentPolicy, input);
      upsertEmbeddingVectorRow(db, input, new Date().toISOString());
    },
    listEmbeddingVectors(input = {}) {
      const predicates: string[] = [];
      const parameters: string[] = [];
      if (input.providerKey !== undefined) {
        predicates.push("provider_key = ?");
        parameters.push(input.providerKey);
      }
      if (input.providerFingerprint !== undefined) {
        predicates.push("provider_fingerprint = ?");
        parameters.push(input.providerFingerprint);
      }
      if (input.ownerKind !== undefined) {
        predicates.push("owner_kind = ?");
        parameters.push(input.ownerKind);
      }
      if (input.ownerId !== undefined) {
        predicates.push("owner_id = ?");
        parameters.push(sanitizeEmbeddingOwnerId(contentPolicy, input.ownerKind, input.ownerId));
      }
      const where = predicates.length > 0 ? `where ${predicates.join(" and ")}` : "";
      const rows = db.prepare(
        `select owner_kind, owner_id, content_hash, owner_version, provider_key, endpoint_hash, model,
                provider_fingerprint, dimension, vector_blob, created_at, updated_at
         from embedding_vectors ${where}
         order by owner_kind asc, owner_id asc, content_hash asc, provider_fingerprint asc`
      ).all(...parameters) as unknown as EmbeddingVectorRow[];
      return rows.map(embeddingVectorFromRow);
    },
    listActiveEmbeddingVectors(input = {}) {
      const predicates: string[] = [];
      const parameters: string[] = [];
      if (input.providerKey !== undefined) {
        predicates.push("ev.provider_key = ?");
        parameters.push(input.providerKey);
      }
      if (input.providerFingerprint !== undefined) {
        predicates.push("ev.provider_fingerprint = ?");
        parameters.push(input.providerFingerprint);
      }
      if (input.ownerKind !== undefined) {
        predicates.push("ev.owner_kind = ?");
        parameters.push(input.ownerKind);
      }
      if (input.ownerId !== undefined) {
        predicates.push("ev.owner_id = ?");
        parameters.push(sanitizeEmbeddingOwnerId(contentPolicy, input.ownerKind, input.ownerId));
      }
      predicates.push(`(
        (ev.owner_kind = 'chunk' and ev.owner_version = '' and c.id is not null)
        or
        (ev.owner_kind = 'memory' and m.id is not null)
      )`);
      const rows = db.prepare(
        `select ev.owner_kind, ev.owner_id, ev.content_hash, ev.owner_version, ev.provider_key,
                ev.endpoint_hash, ev.model, ev.provider_fingerprint, ev.dimension, ev.vector_blob,
                ev.created_at, ev.updated_at,
                c.text as current_chunk_text,
                m.title as current_memory_title, m.summary as current_memory_summary,
                m.reason as current_memory_reason, m.statement_json as current_memory_statement, m.type as current_memory_type
         from embedding_vectors ev
         left join chunks c on ev.owner_kind = 'chunk' and c.id = ev.owner_id
         left join memories m on ev.owner_kind = 'memory' and m.id = ev.owner_id
           and m.lifecycle_status = 'current' and m.lifecycle_generation = ev.owner_version
         where ${predicates.join(" and ")}
         order by ev.owner_kind asc, ev.owner_id asc, ev.content_hash asc, ev.provider_fingerprint asc`
      ).all(...parameters) as unknown as ActiveEmbeddingVectorRow[];
      return rows.flatMap((row) => {
        const text = row.owner_kind === "chunk"
          ? row.current_chunk_text
          : row.current_memory_title === null || row.current_memory_summary === null || row.current_memory_reason === null
            ? null
            : memoryContentText({ title: row.current_memory_title, summary: row.current_memory_summary, reason: row.current_memory_reason, statement: parseStatement(row.current_memory_statement, row.current_memory_type) });
        return text !== null && createEmbeddingContentHash(text) === row.content_hash
          ? [embeddingVectorFromRow(row)]
          : [];
      });
    },
    deleteStaleEmbeddingJobsForMemory(memoryId) {
      return Number(db.prepare(
        `delete from embedding_jobs
         where owner_kind = 'memory' and owner_id = ?
           and not exists (
             select 1 from memories
             where memories.id = embedding_jobs.owner_id
               and memories.lifecycle_status = 'current'
               and memories.lifecycle_generation = embedding_jobs.owner_version
           )`
      ).run(memoryId).changes);
    },
    deleteStaleEmbeddingVectorsForMemory(memoryId) {
      return Number(db.prepare(
        `delete from embedding_vectors
         where owner_kind = 'memory' and owner_id = ?
           and not exists (
             select 1 from memories
             where memories.id = embedding_vectors.owner_id
               and memories.lifecycle_status = 'current'
               and memories.lifecycle_generation = embedding_vectors.owner_version
           )`
      ).run(memoryId).changes);
    },
    deleteEmbeddingJobsForOwner(ownerKind, ownerId) {
      return Number(db.prepare(
        "delete from embedding_jobs where owner_kind = ? and owner_id = ?"
      ).run(ownerKind, sanitizeEmbeddingOwnerId(contentPolicy, ownerKind, ownerId)).changes);
    },
    deleteEmbeddingVectorsForOwner(ownerKind, ownerId) {
      return Number(db.prepare(
        "delete from embedding_vectors where owner_kind = ? and owner_id = ?"
      ).run(ownerKind, sanitizeEmbeddingOwnerId(contentPolicy, ownerKind, ownerId)).changes);
    },
    upsertMemoryCandidate(memory, options) {
      return withTransaction(db, () => {
        memory = sanitizeExtractedMemory(contentPolicy, memory);
        options = options === undefined ? undefined : {
          ...options,
          ...(options.qualityReasons === undefined
            ? {}
            : { qualityReasons: options.qualityReasons.map(contentPolicy.text) })
        };
        const now = new Date().toISOString();
        const layer = sanitizeLayer(contentPolicy, memory.layer);
        const existing = db
          .prepare(
            `select scope_json, scope_key, layer, origin_json, statement_json, id, type, title, summary, reason, confidence, evidence_json, related_files_json,
                    dedupe_key, promotion_state, promoted_memory_id,
                    created_at, updated_at
             from memory_candidates
             where dedupe_key = ? and scope_key = ? and layer = ?`
          )
          .get(memory.dedupeKey, scopeKey(memory.scope), layer) as MemoryCandidateRow | undefined;
        const statement = memory.statement ?? (existing?.summary === memory.summary ? parseStatement(existing.statement_json, memory.type) : undefined);
        const candidateId = existing?.id ?? `candidate-${randomUUID()}`;
        const promotionState = options?.promotionState ?? existing?.promotion_state ?? "candidate";
        db.prepare(
          `insert into memory_candidates
             (scope_json, scope_key, layer, origin_json, statement_json, id, type, title, summary, reason, confidence, evidence_json, related_files_json,
              dedupe_key, promotion_state, evidence_signature, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(dedupe_key, scope_key, layer) do update set
             type = excluded.type,
             statement_json = excluded.statement_json,
             title = excluded.title,
             summary = excluded.summary,
             reason = excluded.reason,
             confidence = excluded.confidence,
             evidence_json = excluded.evidence_json,
             related_files_json = excluded.related_files_json,
             promotion_state = excluded.promotion_state,
             evidence_signature = excluded.evidence_signature,
             updated_at = excluded.updated_at`
        ).run(
          JSON.stringify(normalizeScope(memory.scope)), scopeKey(memory.scope), layer,
          memory.origin ? JSON.stringify(memory.origin) : null,
          statement ? JSON.stringify(statement) : null,
          candidateId,
          memory.type,
          memory.title,
          memory.summary,
          memory.reason,
          memory.confidence,
          JSON.stringify(memory.evidence),
          JSON.stringify(memory.relatedFiles),
          memory.dedupeKey,
          promotionState,
          createEvidenceSignature(memory.evidence),
          existing?.created_at ?? now,
          now
        );
        rebuildMemoryLinks(db, "candidate", candidateId, memory.evidence, memory.relatedFiles);
        const row = db
          .prepare(
            `select scope_json, scope_key, layer, origin_json, statement_json, id, type, title, summary, reason, confidence, evidence_json, related_files_json,
                    dedupe_key, promotion_state, promoted_memory_id,
                    created_at, updated_at
             from memory_candidates
             where id = ?`
          )
          .get(candidateId) as unknown as MemoryCandidateRow;
        const candidate = memoryCandidateFromRow(row);
        if (options?.qualityStatus !== undefined || options?.qualityReasons !== undefined || options?.lastVerifiedAt !== undefined) {
          writeExplicitMemoryQuality(store, "candidate", candidate, {
            qualityStatus: options?.qualityStatus ?? "active",
            qualityReasons: options?.qualityReasons ?? [],
            lastVerifiedAt: options?.lastVerifiedAt
          }, now);
        }
        return withResolvedQuality(store, "candidate", candidate);
      });
    },
    promoteMemoryCandidate(candidateId, source = "auto", options = {}) {
      return withTransaction(db, () => {
        candidateId = contentPolicy.identifier(candidateId);
        const candidate = db
          .prepare(
            `select scope_json, scope_key, layer, origin_json, statement_json, id, type, title, summary, reason, confidence, evidence_json, related_files_json,
                    dedupe_key, promotion_state, promoted_memory_id,
                    created_at, updated_at
             from memory_candidates
             where id = ?`
          )
          .get(candidateId) as MemoryCandidateRow | undefined;
        if (!candidate) {
          throw new Error(`Unknown memory candidate: ${candidateId}`);
        }
        const resolvedCandidate = withResolvedQuality(store, "candidate", memoryCandidateFromRow(candidate));
        const layer = options.layer === undefined ? candidate.layer : sanitizeLayer(contentPolicy, options.layer);
        const previousLayer = candidate.promoted_memory_id ? readMemoryRowRaw(db, candidate.promoted_memory_id)?.layer ?? candidate.layer : candidate.layer;
        let memory = upsertMemoryRow(db, {
          scope: parseScope(candidate.scope_json),
          layer,
          origin: parseMemoryOrigin(candidate.origin_json),
          statement: parseStatement(candidate.statement_json, candidate.type),
          id: candidate.promoted_memory_id ?? undefined,
          type: candidate.type,
          title: candidate.title,
          summary: candidate.summary,
          reason: candidate.reason,
          confidence: candidate.confidence,
          evidence: parseEvidenceJson(candidate.evidence_json),
          relatedFiles: parseJsonArray(candidate.related_files_json),
          dedupeKey: candidate.dedupe_key,
          source,
          actor: options.actor,
          createdAt: candidate.created_at
        });
        if (memory.layer !== layer) {
          db.prepare("update memories set layer=? where id=?").run(layer, memory.id);
          memory = readMemoryRow(db, memory.id)!;
        }
        if (previousLayer !== layer) {
          moveTopicMemberships(store,memory.id,previousLayer,layer);
          recordMemoryEvent(db, contentPolicy, {
          kind: "sharing_changed", memoryId: memory.id, category: "promoted", layer,
          from: previousLayer, to: layer, reason: "Shared while making this candidate durable", actor: options.actor ?? "system"
          });
        }
        db.prepare(
          `update memory_candidates
           set promotion_state = 'promoted', promoted_memory_id = ?, layer = ?, updated_at = ?
           where id = ?`
        ).run(memory.id, layer, new Date().toISOString(), candidateId);
        writeExplicitMemoryQuality(store, "promoted", memory, {
          qualityStatus: resolvedCandidate.qualityStatus,
          qualityReasons: resolvedCandidate.qualityReasons,
          lastVerifiedAt: resolvedCandidate.lastVerifiedAt
        });
        return withResolvedQuality(store, "promoted", memory);
      });
    },
    upsertManualDecisionMemory(decision, origin) {
      return withTransaction(db, () => {
        decision = sanitizeDecision(contentPolicy, decision);
        const memory = upsertMemoryRow(db, {
          scope: decision.scope,
          layer: CORE_LAYER,
          origin: sanitizeMemoryOrigin(contentPolicy, origin),
          id: `memory-manual-${decision.id}${scopeKey(decision.scope) === "unspecified" ? "" : `-scope-${scopeKey(decision.scope)}`}`,
          type: "decision",
          title: decision.topic,
          summary: decision.decision,
          statement: createStatement(decision.decision, "decision", "submitted", { choice: decision.decision, rationale: decision.reason }),
          reason: decision.reason,
          confidence: 1,
          evidence: decision.evidence,
          relatedFiles: [],
          dedupeKey: `manual-decision:${decision.id}`,
          source: "manual",
          createdAt: decision.createdAt
        });
        writeExplicitMemoryQuality(store, "promoted", memory, {
          qualityStatus: "active",
          qualityReasons: [],
          lastVerifiedAt: decision.createdAt
        }, decision.createdAt);
        return withResolvedQuality(store, "promoted", memory);
      });
    },
    readMemory(id) {
      const memory = readMemoryRow(db, contentPolicy.identifier(id));
      return memory ? withResolvedQuality(store, "promoted", memory) : undefined;
    },
    updateMemoryLifecycle(id, lifecycle) {
      return updateStoredMemoryLifecycle(
        db,
        contentPolicy,
        (memoryId) => {
          const memory = readMemoryRow(db, memoryId);
          return memory ? withResolvedQuality(store, "promoted", memory) : undefined;
        },
        id,
        lifecycle
      );
    },
    addMemoryRelation(input) {
      return addStoredMemoryRelation(
        db,
        contentPolicy,
        (memoryId) => {
          const memory = readMemoryRow(db, memoryId);
          return memory ? withResolvedQuality(store, "promoted", memory) : undefined;
        },
        input
      );
    },
    listMemoryRelations(input = {}) {
      return listStoredMemoryRelations(db, contentPolicy, input);
    },
    deleteMemoryRelation(id) {
      return deleteStoredMemoryRelation(db, contentPolicy, id);
    },
    listMemoryCandidates(input = {}) {
      const layer = layerSqlPredicate(input.layer, input.owner, importedPeerLayers(db));
      const rows = db
        .prepare(
          `select scope_json, scope_key, layer, origin_json, statement_json, id, type, title, summary, reason, confidence, evidence_json, related_files_json,
                  dedupe_key, promotion_state, promoted_memory_id,
                  created_at, updated_at
           from memory_candidates
           ${layer.clause}
           order by updated_at desc, created_at desc, rowid desc`
        )
        .iterate(...layer.parameters) as unknown as Iterable<MemoryCandidateRow>;
      const matches: MemoryCandidate[] = [];
      const limit = input.limit === null ? Infinity : normalizeLimit(input.limit);
      for (const row of rows) {
        if (input.type && row.type !== input.type) continue;
        if (input.promotionState && row.promotion_state !== input.promotionState) continue;
        const candidate = withResolvedQuality(store, "candidate", memoryCandidateFromRow(row));
        if (!matchesQualityStatus(candidate.qualityStatus, input.qualityStatus)) continue;
        if (!matchesLayerFilter(candidate.layer, input.layer)) continue;
        if (!matchesMemoryQuery(candidate, input.query)) continue;
        if (input.excludeTerminalReviews && effectiveTerminalMemoryReview(store, "candidate", candidate) !== undefined) continue;
        matches.push(candidate);
        if (matches.length >= limit) break;
      }
      return matches;
    },
    listMemories(input = {}) {
      if (input.status === "candidate") return [];
      const layer = layerSqlPredicate(input.layer, input.owner, importedPeerLayers(db));
      const rows = db
        .prepare(
          `select scope_json, scope_key, layer, origin_json, statement_json, id, type, title, summary, reason, confidence, evidence_json, related_files_json,
                  dedupe_key, source,
                  subject_key, lifecycle_status, valid_from, valid_until, status_reason, status_changed_at,
                  lifecycle_generation,
                  created_at, promoted_at
           from memories
           ${layer.clause}
           order by promoted_at desc, created_at desc`
        )
        .iterate(...layer.parameters) as unknown as Iterable<MemoryRow>;
      const matches: DurableMemory[] = [];
      const limit = input.limit === null ? Infinity : normalizeLimit(input.limit);
      for (const row of rows) {
        if (input.type && row.type !== input.type) continue;
        if (!matchesLifecycleStatus(row.lifecycle_status, input.lifecycleStatus)) continue;
        const memory = withResolvedQuality(store, "promoted", memoryFromRow(row));
        if (!matchesQualityStatus(memory.qualityStatus, input.qualityStatus)) continue;
        if (!matchesLayerFilter(memory.layer, input.layer)) continue;
        if (!matchesMemoryQuery(memory, input.query)) continue;
        matches.push(memory);
        if (matches.length >= limit) break;
      }
      return matches;
    },
    updateMemoryQuality(kind, id, quality) {
      id = contentPolicy.identifier(id);
      const memory = kind === "candidate"
        ? db.prepare(
            `select scope_json, scope_key, layer, origin_json, statement_json, id, type, title, summary, reason, confidence,
                    evidence_json, related_files_json, dedupe_key, promotion_state, promoted_memory_id, created_at, updated_at
               from memory_candidates where id = ?`
          ).get(id) as MemoryCandidateRow | undefined
        : readMemoryRowRaw(db, id);
      if (!memory) return;
      const mapped = kind === "candidate" ? memoryCandidateFromRow(memory as MemoryCandidateRow) : memoryFromRow(memory as MemoryRow);
      writeExplicitMemoryQuality(store, kind, mapped, {
        qualityStatus: quality.qualityStatus,
        qualityReasons: quality.qualityReasons.map(contentPolicy.text),
        lastVerifiedAt: quality.lastVerifiedAt
      });
      db.prepare("insert into retrieval_changes(entity,entity_id,operation) values(?,?, 'quality')").run(kind==="promoted" ? "memories" : "memory_candidates",id);
    },
    readTemporaryMemory(id) {
      const row = db.prepare("select * from temporary_memories where id=? and project_id=?").get(id, store.paths.rootDir) as unknown as TemporaryMemoryRow | undefined;
      if (!row) return undefined;
      const memory = temporaryMemoryFromRow(row);
      memory.citations = resolveEvidenceCitations(store, memory);
      return memory;
    },
    keepTemporaryMemory(id, now = new Date().toISOString()) {
      return withTransaction(db, () => {
        const memory = store.readTemporaryMemory(id);
        if (!memory || Date.parse(memory.expiresAt) <= Date.parse(now)) throw new Error("Working context has expired or is unavailable");
        if (db.prepare("select 1 from peer_partitions where layer=?").get(memory.layer ?? "core")) throw new Error("Another device's working context is read-only");
        const expiry = capTemporaryMemoryExpiry(memory.createdAt, new Date(Math.max(Date.parse(memory.expiresAt), Date.parse(now) + TEMPORARY_MEMORY_DEFAULT_TTL_MS)).toISOString());
        db.prepare("update temporary_memories set expires_at=?,updated_at=? where id=?").run(expiry, now, id);
        return store.readTemporaryMemory(id)!;
      });
    },
    upsertTemporaryMemory(input) {
      return withTransaction(db, () => {
        input = sanitizeTemporaryMemory(contentPolicy, input);
        const now = input.updatedAt ?? new Date().toISOString();
        const existingById = input.id ? db.prepare("select base_id from temporary_memories where id = ?").get(input.id) as { base_id: string } | undefined : undefined;
        const baseId = existingById?.base_id ?? input.id ?? `temporary-${randomUUID()}`;
        const key = scopeKey(input.scope);
        const layer = sanitizeLayer(contentPolicy, input.layer ?? workingContextLayer());
        const existing = db.prepare("select * from temporary_memories where base_id = ? and scope_key = ? and layer = ?").get(baseId, key, layer) as unknown as TemporaryMemoryRow | undefined;
        // Keep the caller's stable id for the primary variant; only a real collision
        // (same base id already stored under another scope or layer) needs a fresh one.
        const idTaken = db.prepare("select 1 from temporary_memories where id = ?").get(baseId) !== undefined;
        const id = existing?.id ?? (key === "unspecified" && !idTaken ? baseId : `temporary-${randomUUID()}`);
        const projectId = input.projectId ?? existing?.project_id ?? store.paths.rootDir;
        const createdAt = input.createdAt ?? existing?.created_at ?? now;
        const defaultExpiresAt = new Date(Date.parse(now) + TEMPORARY_MEMORY_DEFAULT_TTL_MS).toISOString();
        const expiresAt = capTemporaryMemoryExpiry(createdAt, input.expiresAt ?? defaultExpiresAt);
        const details = input.details ?? existing?.details ?? input.summary;
        const relatedFiles = input.relatedFiles ?? parseJsonArray(existing?.related_files_json ?? "[]");
        const evidence = input.evidence ?? parseEvidenceJson(existing?.evidence_json ?? "[]");
        const confidence = input.confidence ?? existing?.confidence ?? 0.7;

        db.prepare(
          `insert into temporary_memories
             (base_id, scope_json, scope_key, layer, origin_json, id, project_id, thread_id, session_id, source_adapter, kind, title, summary, details,
              related_files_json, evidence_json, confidence, created_at, updated_at, expires_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(base_id, scope_key, layer) do update set
             project_id = excluded.project_id,
             thread_id = excluded.thread_id,
             session_id = excluded.session_id,
             source_adapter = excluded.source_adapter,
             kind = excluded.kind,
             title = excluded.title,
             summary = excluded.summary,
             details = excluded.details,
             related_files_json = excluded.related_files_json,
             evidence_json = excluded.evidence_json,
             confidence = excluded.confidence,
             updated_at = excluded.updated_at,
             expires_at = excluded.expires_at`
        ).run(
          baseId, JSON.stringify(normalizeScope(input.scope)), scopeKey(input.scope), layer,
          input.origin ? JSON.stringify(input.origin) : null,
          id,
          projectId,
          input.threadId ?? existing?.thread_id ?? null,
          input.sessionId ?? existing?.session_id ?? null,
          input.sourceAdapter ?? existing?.source_adapter ?? null,
          input.kind,
          input.title,
          input.summary,
          details,
          JSON.stringify(relatedFiles),
          JSON.stringify(evidence),
          confidence,
          createdAt,
          now,
          expiresAt
        );
        rebuildTemporaryMemoryLinks(db, id, evidence, relatedFiles);
        const ftsInput: Parameters<typeof rebuildTemporaryMemoryFts>[1] = {
          id,
          projectId,
          kind: input.kind,
          title: input.title,
          summary: input.summary,
          details
        };
        const threadId = input.threadId ?? existing?.thread_id ?? undefined;
        const sessionId = input.sessionId ?? existing?.session_id ?? undefined;
        if (threadId !== undefined) ftsInput.threadId = threadId;
        if (sessionId !== undefined) ftsInput.sessionId = sessionId;
        rebuildTemporaryMemoryFts(db, ftsInput);
        const row = db
          .prepare(
            `select base_id, scope_json, scope_key, layer, origin_json, id, project_id, thread_id, session_id, source_adapter, kind, title, summary, details,
                    related_files_json, evidence_json, confidence, created_at, updated_at, expires_at
             from temporary_memories
             where id = ?`
          )
          .get(id) as unknown as TemporaryMemoryRow;
        return temporaryMemoryFromRow(row);
      });
    },
    searchTemporaryMemory(input) {
      const query = toFtsQuery(input.query);
      const now = input.now ?? new Date().toISOString();
      const rows = db
        .prepare(
          `select
             m.base_id, m.scope_json, m.scope_key, m.layer, m.origin_json,
             m.id,
             m.project_id,
             m.thread_id,
             m.session_id,
             m.source_adapter,
             m.kind,
             m.title,
             m.summary,
             m.details,
             m.related_files_json,
             m.evidence_json,
             m.confidence,
             m.created_at,
             m.updated_at,
             m.expires_at,
             bm25(temporary_memories_fts) as score
           from temporary_memories_fts f
           join temporary_memories m on m.id = f.memory_id
           where temporary_memories_fts match ?
             and m.project_id = ?
             and m.expires_at > ?
           limit ?`
        )
        .all(query, store.paths.rootDir, now, Math.max(normalizeLimit(input.limit) * 4, 20)) as unknown as TemporaryMemorySearchRow[];
      const rankInput: { threadId?: string; sessionId?: string; limit: number } = {
        limit: normalizeLimit(input.limit)
      };
      if (input.threadId !== undefined) rankInput.threadId = contentPolicy.identifier(input.threadId);
      if (input.sessionId !== undefined) rankInput.sessionId = contentPolicy.identifier(input.sessionId);
      return rankTemporaryMemories(rows, rankInput);
    },
    listActiveTemporaryMemory(input = {}) {
      const now = input.now ?? new Date().toISOString();
      const rows = db
        .prepare(
          `select base_id, scope_json, scope_key, layer, origin_json, id, project_id, thread_id, session_id, source_adapter, kind, title, summary, details,
                  related_files_json, evidence_json, confidence, created_at, updated_at, expires_at
           from temporary_memories
           where project_id = ? and expires_at > ?
           order by updated_at desc, confidence desc, id asc
           limit ?`
        )
        .all(store.paths.rootDir, now, Math.max(normalizeLimit(input.limit) * 4, 20)) as unknown as TemporaryMemoryRow[];
      const rankInput: { threadId?: string; sessionId?: string; limit: number } = {
        limit: normalizeLimit(input.limit)
      };
      if (input.threadId !== undefined) rankInput.threadId = input.threadId;
      if (input.sessionId !== undefined) rankInput.sessionId = input.sessionId;
      return rankTemporaryMemoryRows(rows, rankInput).map(({ score: _score, rank: _rank, ...memory }) => memory);
    },
    deleteExpiredTemporaryMemories(input = {}) {
      return withTransaction(db, () => {
        const expiredOnly = input.expiredOnly ?? true;
        if (!expiredOnly) {
          const count = countRows(db, "temporary_memories");
          db.prepare("delete from temporary_memories_fts").run();
          db.prepare("delete from temporary_memory_links").run();
          db.prepare("delete from temporary_memories").run();
          return count;
        }

        const now = input.now ?? new Date().toISOString();
        const rows = db
          .prepare("select id from temporary_memories where expires_at <= ?")
          .all(now) as Array<{ id: string }>;
        for (const row of rows) {
          db.prepare("delete from temporary_memories_fts where memory_id = ?").run(row.id);
          db.prepare("delete from temporary_memory_links where memory_id = ?").run(row.id);
          db.prepare("delete from temporary_memories where id = ?").run(row.id);
        }
        return rows.length;
      });
    },
    searchMemoryLayer(input = {}) {
      const limit = normalizeLimit(input.limit);
      const offset = normalizeOffset(input.offset);
      const sourceLimit = offset + limit;
      const promotedInput: Parameters<typeof store.listMemories>[0] = {
        status: "promoted",
        limit: sourceLimit
      };
      if (input.type !== undefined) promotedInput.type = input.type;
      if (input.query !== undefined) promotedInput.query = input.query;
      if (input.qualityStatus !== undefined) promotedInput.qualityStatus = input.qualityStatus;
      if (input.lifecycleStatus !== undefined) promotedInput.lifecycleStatus = input.lifecycleStatus;
      if (input.layer !== undefined) promotedInput.layer = input.layer;
      if (input.owner !== undefined) promotedInput.owner = input.owner;
      const promoted =
        input.status === "candidate"
          ? []
          : store.listMemories(promotedInput);
      const candidateInput: Parameters<typeof store.listMemoryCandidates>[0] = {
        limit: sourceLimit,
        promotionState: "candidate",
        excludeTerminalReviews: true
      };
      if (input.type !== undefined) candidateInput.type = input.type;
      if (input.query !== undefined) candidateInput.query = input.query;
      if (input.qualityStatus !== undefined) candidateInput.qualityStatus = input.qualityStatus;
      if (input.layer !== undefined) candidateInput.layer = input.layer;
      if (input.owner !== undefined) candidateInput.owner = input.owner;
      const candidates =
        input.status === "promoted" || promoted.length >= sourceLimit
          ? []
          : store.listMemoryCandidates(candidateInput);

      const matches: Array<{
        kind: MemorySearchResult["kind"];
        memory: MemoryCandidate | DurableMemory;
      }> = [
        ...promoted.map((memory) => ({ kind: "promoted" as const, memory })),
        ...candidates.map((memory) => ({ kind: "candidate" as const, memory }))
      ];
      return matches
        .slice(offset, offset + limit)
        .map(({ kind, memory }) => input.summaryOnly
          ? memorySearchSummaryResult(store, kind, memory)
          : memorySearchResult(store, kind, memory));
    },
    readMemorySearchResultsByIds(memoryIds, input = {}) {
      memoryIds = memoryIds.map(contentPolicy.identifier);
      if (memoryIds.length === 0) return [];
      const memoryRows = chunked(memoryIds, SQLITE_READ_BATCH_SIZE).flatMap((batch) =>
        db.prepare(
          `select scope_json, scope_key, layer, origin_json, statement_json, id, type, title, summary, reason, confidence, evidence_json, related_files_json,
                  dedupe_key, source,
                  subject_key, lifecycle_status, valid_from, valid_until, status_reason, status_changed_at,
                  lifecycle_generation, created_at, promoted_at
           from memories where id in (${batch.map(() => "?").join(", ")})`
        ).all(...batch) as unknown as MemoryRow[]
      );
      const candidateRows = input.includeCandidates ? chunked(memoryIds, SQLITE_READ_BATCH_SIZE).flatMap((batch) =>
        db.prepare(
          `select scope_json, scope_key, layer, origin_json, statement_json, id, type, title, summary, reason, confidence, evidence_json, related_files_json,
                  dedupe_key, promotion_state, promoted_memory_id,
                  created_at, updated_at
           from memory_candidates where promotion_state = 'candidate'
             and id in (${batch.map(() => "?").join(", ")})`
        ).all(...batch) as unknown as MemoryCandidateRow[]
      ) : [];
      const byId = new Map<string, MemorySearchResult>([
        ...candidateRows.map((row) => [
          row.id,
          (input.summaryOnly ? memorySearchSummaryResult : memorySearchResult)(store, "candidate", withResolvedQuality(store, "candidate", memoryCandidateFromRow(row)))
        ] as const),
        ...memoryRows
          .map((row) => withResolvedQuality(store, "promoted", memoryFromRow(row)))
          .filter((memory) => matchesLifecycleStatus(memory.lifecycleStatus, input.lifecycleStatus))
          .map((memory) => [memory.id, (input.summaryOnly ? memorySearchSummaryResult : memorySearchResult)(store, "promoted", memory)] as const)
      ]);
      return memoryIds.flatMap((memoryId) => {
        const memory = byId.get(memoryId);
        return memory ? [memory] : [];
      });
    },
    getProjectSummary() {
      const syncSources = store.listSyncStatuses().reduce<Partial<Record<SyncSourceName, SyncStatus>>>(
        (accumulator, status) => {
          accumulator[status.source] = status;
          return accumulator;
        },
        {}
      );
      const lastSyncAt = Object.values(syncSources)
        .map((status) => status?.lastSyncAt)
        .filter((value): value is string => typeof value === "string")
        .sort()
        .at(-1);
      const summary: ProjectSummary = {
        sources: countRows(db, "sources"),
        chunks: countRows(db, "chunks"),
        commits: countRows(db, "commits"),
        decisions: countRows(db, "decisions"),
        candidateMemories: countRows(db, "memory_candidates"),
        promotedMemories: countRows(db, "memories"),
        temporaryMemories: countRows(db, "temporary_memories"),
        memoryHealth: countMemoryHealth(store),
        syncSources,
        extraction: store.getExtractionStatus()
      };
      if (lastSyncAt !== undefined) summary.lastSyncAt = lastSyncAt;
      return summary;
    }
  };

  return store;
}

function upsertMemoryRow(
  db: DatabaseSync,
  input: {
    scope?: import("../types.js").MemoryScope | undefined;
    layer: string;
    origin?: MemoryOrigin | null;
    statement?: import("../types.js").MemoryStatement | undefined;
    id?: string | undefined;
    type: MemoryType;
    title: string;
    summary: string;
    reason: string;
    confidence: number;
    evidence: EvidenceRef[];
    relatedFiles: string[];
    dedupeKey: string;
    source: DurableMemory["source"];
    actor?: import("../types.js").OperationActor | undefined;
    createdAt: string;
  }
): DurableMemory {
  const evidenceSignature = createEvidenceSignature(input.evidence);
  const existing = input.id
    ? readMemoryRowRaw(db, input.id)
    : db.prepare(
        `select scope_json, scope_key, layer, origin_json, statement_json, id, type, title, summary, reason, confidence, evidence_json, related_files_json,
                dedupe_key, source,
                subject_key, lifecycle_status, valid_from, valid_until, status_reason, status_changed_at,
                lifecycle_generation,
                created_at, promoted_at
         from memories
         where dedupe_key = ? and evidence_signature = ? and source = ? and scope_key = ? and layer = ?`
      ).get(input.dedupeKey, evidenceSignature, input.source, scopeKey(input.scope), input.layer) as MemoryRow | undefined;
  const id = existing?.id ?? input.id ?? `memory-${randomUUID()}`;
  const subjectKey = createMemorySubjectKey(input.type, input.title);
  const statement = input.statement ?? (existing?.summary === input.summary ? parseStatement(existing.statement_json, input.type) : undefined);
  if (existing) {
    db.prepare(
      `update memories set
         type = ?, title = ?, summary = ?, statement_json = ?, reason = ?, confidence = ?, evidence_json = ?,
         related_files_json = ?, dedupe_key = ?, evidence_signature = ?, source = ?, subject_key = ?
       where id = ?`
    ).run(
      input.type, input.title, input.summary, statement ? JSON.stringify(statement) : null, input.reason, input.confidence,
      JSON.stringify(input.evidence), JSON.stringify(input.relatedFiles), input.dedupeKey,
      evidenceSignature, input.source, subjectKey, id
    );
  } else {
    const promotedAt = new Date().toISOString();
    const lifecycleGeneration = randomUUID();
    db.prepare(
      `insert into memories
         (scope_json, scope_key, layer, origin_json, statement_json, id, type, title, summary, reason, confidence, evidence_json, related_files_json,
          dedupe_key, evidence_signature, source, subject_key, lifecycle_status, valid_from, valid_until,
          status_reason, status_changed_at, lifecycle_generation, created_at, promoted_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, null, null, ?, ?, ?, ?)`
    ).run(
      JSON.stringify(normalizeScope(input.scope)), scopeKey(input.scope), input.layer,
      input.origin ? JSON.stringify(input.origin) : null,
      statement ? JSON.stringify(statement) : null,
      id, input.type, input.title, input.summary, input.reason, input.confidence,
      JSON.stringify(input.evidence), JSON.stringify(input.relatedFiles), input.dedupeKey,
      evidenceSignature, input.source, subjectKey, input.createdAt, promotedAt, lifecycleGeneration,
      input.createdAt, promotedAt
    );
    recordMemoryEvent(db,createStorageContentPolicy(),{kind:"made_durable",memoryId:id,category:"promoted",layer:input.layer,at:promotedAt,actor:input.actor ?? "system",key:`made-durable:${id}`});
  }
  rebuildMemoryLinks(db, "memory", id, input.evidence, input.relatedFiles);
  return readMemoryRow(db, id) as DurableMemory;
}

function readMemoryRowRaw(db: DatabaseSync, id: string): MemoryRow | undefined {
  return db.prepare(
    `select scope_json, scope_key, layer, origin_json, statement_json, id, type, title, summary, reason, confidence, evidence_json, related_files_json,
            dedupe_key, source,
            subject_key, lifecycle_status, valid_from, valid_until, status_reason, status_changed_at,
            lifecycle_generation,
            created_at, promoted_at
     from memories where id = ?`
  ).get(id) as MemoryRow | undefined;
}

function readMemoryRow(db: DatabaseSync, id: string): DurableMemory | undefined {
  const row = readMemoryRowRaw(db, id);
  return row ? memoryFromRow(row) : undefined;
}

function rebuildMemoryLinks(
  db: DatabaseSync,
  ownerKind: "candidate" | "memory",
  ownerId: string,
  evidence: EvidenceRef[],
  relatedFiles: string[]
): void {
  db.prepare(`delete from memory_links where owner_kind = ? and owner_id = ?`).run(ownerKind, ownerId);
  const insert = db.prepare(
    `insert into memory_links (id, owner_kind, owner_id, target_type, target_id, locator, metadata_json)
     values (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const evidenceRef of evidence) {
    insert.run(
      randomUUID(),
      ownerKind,
      ownerId,
      evidenceRef.sourceType,
      evidenceRef.sourceId,
      evidenceRef.locator ?? null,
      "{}"
    );
  }
  for (const relatedFile of relatedFiles) {
    insert.run(randomUUID(), ownerKind, ownerId, "file", relatedFile, null, "{}");
  }
}

function rebuildTemporaryMemoryLinks(
  db: DatabaseSync,
  memoryId: string,
  evidence: EvidenceRef[],
  relatedFiles: string[]
): void {
  db.prepare("delete from temporary_memory_links where memory_id = ?").run(memoryId);
  const insert = db.prepare(
    `insert into temporary_memory_links (id, memory_id, target_type, target_id, locator, metadata_json)
     values (?, ?, ?, ?, ?, ?)`
  );
  for (const evidenceRef of evidence) {
    insert.run(
      randomUUID(),
      memoryId,
      evidenceRef.sourceType,
      evidenceRef.sourceId,
      evidenceRef.locator ?? null,
      "{}"
    );
  }
  for (const relatedFile of relatedFiles) {
    insert.run(randomUUID(), memoryId, "file", relatedFile, null, "{}");
  }
}

function rebuildTemporaryMemoryFts(
  db: DatabaseSync,
  input: {
    id: string;
    projectId: string;
    threadId?: string;
    sessionId?: string;
    kind: TemporaryMemoryKind;
    title: string;
    summary: string;
    details: string;
  }
): void {
  db.prepare("delete from temporary_memories_fts where memory_id = ?").run(input.id);
  db.prepare(
    `insert into temporary_memories_fts
       (memory_id, project_id, thread_id, session_id, kind, title, summary, details)
     values (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.projectId,
    input.threadId ?? null,
    input.sessionId ?? null,
    input.kind,
    input.title,
    input.summary,
    input.details
  );
}

function capTemporaryMemoryExpiry(createdAt: string, requestedExpiresAt: string): string {
  const createdMs = Date.parse(createdAt);
  const requestedMs = Date.parse(requestedExpiresAt);
  const safeCreatedMs = Number.isFinite(createdMs) ? createdMs : Date.now();
  const safeRequestedMs = Number.isFinite(requestedMs)
    ? requestedMs
    : safeCreatedMs + TEMPORARY_MEMORY_DEFAULT_TTL_MS;
  return new Date(Math.min(safeRequestedMs, safeCreatedMs + TEMPORARY_MEMORY_MAX_TTL_MS)).toISOString();
}

function rankTemporaryMemories(
  rows: TemporaryMemorySearchRow[],
  input: { threadId?: string; sessionId?: string; limit: number }
): TemporaryMemorySearchResult[] {
  return rankTemporaryMemoryRows(rows, input);
}

function rankTemporaryMemoryRows(
  rows: Array<TemporaryMemoryRow | TemporaryMemorySearchRow>,
  input: { threadId?: string; sessionId?: string; limit: number }
): TemporaryMemorySearchResult[] {
  return rows
    .map((row) => temporaryMemorySearchResultFromRow(row))
    .sort((left, right) => {
      const leftSession = input.sessionId && left.sessionId === input.sessionId ? 1 : 0;
      const rightSession = input.sessionId && right.sessionId === input.sessionId ? 1 : 0;
      if (leftSession !== rightSession) return rightSession - leftSession;

      const leftThread = input.threadId && left.threadId === input.threadId ? 1 : 0;
      const rightThread = input.threadId && right.threadId === input.threadId ? 1 : 0;
      if (leftThread !== rightThread) return rightThread - leftThread;

      const updatedDiff = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      if (Number.isFinite(updatedDiff) && updatedDiff !== 0) return updatedDiff;

      if (left.score !== right.score) return left.score - right.score;
      if (left.confidence !== right.confidence) return right.confidence - left.confidence;
      return left.id.localeCompare(right.id);
    })
    .slice(0, input.limit)
    .map((memory, index) => ({ ...memory, rank: index + 1 }));
}

function isCurrentEmbeddingOwner(
  db: DatabaseSync,
  input: Pick<EmbeddingOwner, "ownerKind" | "ownerId" | "contentHash" | "ownerVersion">
): boolean {
  if (input.ownerKind === "chunk") {
    const chunk = db.prepare("select text from chunks where id = ?").get(input.ownerId) as
      | { text: string }
      | undefined;
    return chunk !== undefined
      && input.ownerVersion === ""
      && createEmbeddingContentHash(chunk.text) === input.contentHash;
  }
  const memory = db.prepare(
    `select type, title, summary, reason, statement_json, lifecycle_generation
     from memories where id = ? and lifecycle_status = 'current'`
  ).get(input.ownerId) as
    | { type: MemoryType; title: string; summary: string; reason: string; statement_json: string | null; lifecycle_generation: string }
    | undefined;
  if (!memory || memory.lifecycle_generation !== input.ownerVersion) return false;
  const text = memoryContentText({ ...memory, statement: parseStatement(memory.statement_json, memory.type) });
  return createEmbeddingContentHash(text) === input.contentHash;
}

function validateProviderKey(input: { providerKey: string; endpointHash: string; model: string }): void {
  if (input.providerKey !== createProviderKey(input.endpointHash, input.model)) {
    throw new Error("providerKey does not match endpointHash and model");
  }
}

function validateEmbeddingVectorInput(
  input: Omit<EmbeddingVector, "createdAt" | "updatedAt">
): void {
  validateProviderKey(input);
  if (!Number.isInteger(input.dimension) || input.dimension <= 0) {
    throw new Error("Embedding vector dimension must be a positive integer");
  }
  if (input.providerFingerprint !== createProviderFingerprint(input.endpointHash, input.model, input.dimension)) {
    throw new Error("providerFingerprint does not match endpointHash, model, and dimension");
  }
  if (input.vectorBlob.byteLength !== input.dimension * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error(
      `Float32 vector byte length ${input.vectorBlob.byteLength} does not match dimension ${input.dimension}`
    );
  }
}

function upsertEmbeddingVectorRow(
  db: DatabaseSync,
  input: Omit<EmbeddingVector, "createdAt" | "updatedAt">,
  now: string
): void {
  db.prepare(
    `insert into embedding_vectors
       (owner_kind, owner_id, content_hash, owner_version, provider_key, endpoint_hash, model,
        provider_fingerprint, dimension, vector_blob, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(owner_kind, owner_id, content_hash, provider_fingerprint) do update set
       owner_version = excluded.owner_version,
       provider_key = excluded.provider_key,
       endpoint_hash = excluded.endpoint_hash,
       model = excluded.model,
       dimension = excluded.dimension,
       vector_blob = excluded.vector_blob,
       updated_at = excluded.updated_at`
  ).run(
    input.ownerKind,
    input.ownerId,
    input.contentHash,
    input.ownerVersion,
    input.providerKey,
    input.endpointHash,
    input.model,
    input.providerFingerprint,
    input.dimension,
    Buffer.from(input.vectorBlob),
    now,
    now
  );
}

function embeddingJobFromRow(row: EmbeddingJobRow): EmbeddingJob {
  return {
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    contentHash: row.content_hash,
    ownerVersion: row.owner_version,
    providerKey: row.provider_key,
    endpointHash: row.endpoint_hash,
    model: row.model,
    indexGeneration: row.index_generation,
    state: row.state,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    providerFingerprint: row.provider_fingerprint ?? undefined,
    targetFingerprint: row.target_fingerprint ?? undefined,
    lastError: row.last_error ?? undefined,
    completedAt: row.completed_at ?? undefined
  };
}

function embeddingVectorFromRow(row: EmbeddingVectorRow): EmbeddingVector {
  const blob = row.vector_blob;
  if (blob.byteLength !== row.dimension * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error(
      `Float32 vector byte length ${blob.byteLength} does not match dimension ${row.dimension}`
    );
  }
  return {
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    contentHash: row.content_hash,
    ownerVersion: row.owner_version,
    providerKey: row.provider_key,
    endpointHash: row.endpoint_hash,
    model: row.model,
    providerFingerprint: row.provider_fingerprint,
    dimension: row.dimension,
    vectorBlob: new Uint8Array(blob),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function sanitizeStoredEmbeddingError(error: string): string {
  const normalized = redactSensitiveText(error).text.replace(/\s+/g, " ").trim();
  return (normalized || "Embedding request failed").slice(0, 1_000);
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`select count(*) as count from ${table}`).get() as { count: number };
  return row.count;
}

function readMainSchemaVersion(db: DatabaseSync): number {
  try {
    const row = db.prepare("select max(version) as version from schema_migrations").get() as { version: number | null };
    return row.version ?? 0;
  } catch {
    return 0;
  }
}

function countMemoryHealth(store: MemoryStore): {
  active: number;
  needsReview: number;
  quarantined: number;
  retired: number;
  replaced: number;
} {
  const population = readMemoryPopulation(store);
  const live = population.live.map(({ memory }) => memory.qualityStatus);
  return {
    active: live.filter((status) => status === "active").length,
    needsReview: live.filter((status) => status === "needs_review").length,
    quarantined: live.filter((status) => status === "quarantined").length,
    retired: population.retired,
    replaced: population.replaced
  };
}

/**
 * Narrows a layer query in SQL so the row limit applies to matching rows only.
 * Filtering after the limit silently hides older non-core memories behind newer
 * core ones. `parseLayer` stays authoritative: `matchesLayerFilter` still runs on
 * the mapped rows, so a malformed stored layer cannot slip through the LIKE.
 */
function layerSqlPredicate(
  filter: MemoryLayerFilter | undefined,
  owner: MemoryLayerOwner | undefined = "self",
  peers: readonly string[] = []
): { clause: string; parameters: string[] } {
  const conditions: string[] = [];
  const parameters: string[] = [];
  if (filter === "core") { conditions.push("layer = ?"); parameters.push(CORE_LAYER); }
  else if (filter !== undefined && filter !== "all") { conditions.push("layer like ?"); parameters.push(`${filter}:%`); }
  // Peer membership is a stored fact, so the predicate is an explicit list rather than
  // a guess from the layer name. With no peers imported, `peer` matches nothing.
  if (owner !== "any" && peers.length > 0) {
    const placeholders = peers.map(() => "?").join(", ");
    conditions.push(owner === "peer" ? `layer in (${placeholders})` : `layer not in (${placeholders})`);
    parameters.push(...peers);
  } else if (owner === "peer") {
    conditions.push("1 = 0");
  }
  return { clause: conditions.length === 0 ? "" : `where ${conditions.join(" and ")}`, parameters };
}

function normalizeLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 10;
  return Math.max(1, Math.min(Math.floor(limit), 100));
}

function normalizeOffset(offset: number | undefined): number {
  if (!offset || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.min(Math.floor(offset), 10_000));
}

function chunked<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    batches.push(items.slice(offset, offset + size));
  }
  return batches;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function parseJsonArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function parseEvidenceJson(value: string): EvidenceRef[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isEvidenceRef);
}

function toFtsQuery(query: string): string {
  const tokens = query.match(/[A-Za-z0-9_./-]+/g) ?? [];
  if (tokens.length === 0) return "\"\"";
  return tokens.map((token) => `"${token.replaceAll("\"", "\"\"")}"`).join(" OR ");
}

function commitFromRow(row: CommitRow): CommitRecord {
  return {
    hash: row.hash,
    authorName: row.author_name,
    authorEmail: row.author_email,
    authoredAt: row.authored_at,
    message: row.message,
    changedFiles: parseJsonArray(row.changed_files_json),
    diffSummary: row.diff_summary
  };
}

function formatCommitRawContent(commit: CommitRecord): string {
  return [
    `commit ${commit.hash}`,
    `Author: ${commit.authorName} <${commit.authorEmail}>`,
    `Date: ${commit.authoredAt}`,
    "",
    commit.message,
    "",
    "Changed files:",
    ...commit.changedFiles.map((file) => `- ${file}`),
    "",
    commit.diffSummary
  ].join("\n");
}

function formatCommitSearchText(commit: CommitRecord): string {
  return [commit.hash, commit.message, commit.changedFiles.join(" "), commit.diffSummary].join("\n");
}

function memoryCandidateFromRow(row: MemoryCandidateRow): MemoryCandidate {
  const quality = pendingQuality();
  const statement = parseStatement(row.statement_json, row.type);
  return {
    scope: parseScope(row.scope_json),
    layer: row.layer,
    applicability: assessApplicability(parseScope(row.scope_json)),
    origin: parseMemoryOrigin(row.origin_json),
    id: row.id,
    type: row.type,
    title: row.title,
    summary: statement?.text ?? row.summary,
    ...(statement ? { statement } : {}),
    reason: row.reason,
    confidence: row.confidence,
    evidence: parseEvidenceJson(row.evidence_json),
    relatedFiles: parseJsonArray(row.related_files_json),
    dedupeKey: row.dedupe_key,
    promotionState: row.promotion_state,
    promotedMemoryId: row.promoted_memory_id ?? undefined,
    qualityStatus: quality.qualityStatus,
    qualityReasons: quality.qualityReasons,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function memoryFromRow(row: MemoryRow): DurableMemory {
  const quality = pendingQuality();
  const statement = parseStatement(row.statement_json, row.type);
  return {
    scope: parseScope(row.scope_json),
    layer: row.layer,
    applicability: assessApplicability(parseScope(row.scope_json)),
    origin: parseMemoryOrigin(row.origin_json),
    id: row.id,
    type: row.type,
    title: row.title,
    summary: statement?.text ?? row.summary,
    ...(statement ? { statement } : {}),
    reason: row.reason,
    confidence: row.confidence,
    evidence: parseEvidenceJson(row.evidence_json),
    relatedFiles: parseJsonArray(row.related_files_json),
    dedupeKey: row.dedupe_key,
    source: row.source,
    qualityStatus: quality.qualityStatus,
    qualityReasons: quality.qualityReasons,
    subjectKey: row.subject_key,
    lifecycleStatus: row.lifecycle_status,
    validFrom: row.valid_from,
    validUntil: row.valid_until ?? undefined,
    statusReason: row.status_reason ?? undefined,
    statusChangedAt: row.status_changed_at,
    lifecycleGeneration: row.lifecycle_generation,
    createdAt: row.created_at,
    promotedAt: row.promoted_at
  };
}


function dbPeer(store:MemoryStore,layer?:string):boolean { return layer!==undefined && layer!=="core" && !!store.db.prepare("select 1 from peer_partitions where layer=?").get(layer); }

function memorySearchResult(
  store: MemoryStore,
  kind: MemorySearchResult["kind"],
  memory: MemoryCandidate | DurableMemory
): MemorySearchResult {
  const reviewContext = createMemoryReviewContext(store, kind, memory);
  const basis = confidenceBasis(memory);
  const review = currentMemoryReview(store, kind, memory, reviewContext);
  const citations = resolveEvidenceCitations(store, {
    evidence: memory.evidence,
    relatedFiles: memory.relatedFiles
  });
  const result: MemorySearchResult = {
    kind,
    scope: normalizeScope(memory.scope),
    layer: normalizeLayer(memory.layer),
    applicability: assessApplicability(memory.scope),
    origin: memory.origin ?? null,
    id: memory.id,
    type: memory.type,
    title: memory.title,
    summary: claimText(memory),
    ...(memory.statement ? { statement: memory.statement } : {}),
    reason: memory.reason,
    confidence: memory.confidence,
    confidenceBasis: basis,
    evidence: memory.evidence,
    relatedFiles: memory.relatedFiles,
    dedupeKey: memory.dedupeKey,
    qualityStatus: memory.qualityStatus,
    qualityReasons: memory.qualityReasons,
    lastVerifiedAt: memory.lastVerifiedAt,
    reviewToken: reviewContext.reviewToken,
    ...(review === undefined ? {} : { review }),
    citations,
    trust: buildTrustSummary({
      status: memory.qualityStatus,
      confidence: memory.confidence,
      evidence: memory.evidence,
      citations,
      reasons: memory.qualityReasons,
      lastVerifiedAt: memory.lastVerifiedAt
    })
  };
  if (result.trust) {
    result.trust.displayStatus = trustDisplayStatus(store, kind, memory);
    result.trust.confidenceBasis = basis;
  }
  if ("lifecycleStatus" in memory) {
    result.subjectKey = memory.subjectKey;
    result.lifecycleStatus = memory.lifecycleStatus;
    result.validFrom = memory.validFrom;
    result.validUntil = memory.validUntil;
    result.statusReason = memory.statusReason;
    result.statusChangedAt = memory.statusChangedAt;
  }
  result.presentation = presentMemory(result, dbPeer(store, memory.layer));
  return result;
}

function memorySearchSummaryResult(
  store: MemoryStore,
  kind: MemorySearchResult["kind"],
  memory: MemoryCandidate | DurableMemory
): MemorySearchResult {
  const result: MemorySearchResult = {
    kind,
    scope: normalizeScope(memory.scope),
    origin: memory.origin ?? null,
    applicability: assessApplicability(memory.scope),
    id: memory.id,
    type: memory.type,
    title: memory.title,
    summary: claimText(memory),
    ...(memory.statement ? { statement: memory.statement } : {}),
    reason: memory.reason,
    confidence: memory.confidence,
    evidence: memory.evidence,
    relatedFiles: memory.relatedFiles,
    dedupeKey: memory.dedupeKey,
    layer: normalizeLayer(memory.layer),
    qualityStatus: memory.qualityStatus,
    qualityReasons: memory.qualityReasons,
    displayStatus: trustDisplayStatus(store, kind, memory)
  };
  if ("lifecycleStatus" in memory) result.lifecycleStatus = memory.lifecycleStatus;
  result.presentation = presentMemory(result, dbPeer(store, memory.layer));
  return result;
}

function temporaryMemoryFromRow(row: TemporaryMemoryRow): TemporaryMemory {
  const memory: TemporaryMemory = {
    scope: parseScope(row.scope_json),
    layer: row.layer,
    applicability: assessApplicability(parseScope(row.scope_json)),
    origin: parseMemoryOrigin(row.origin_json),
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    details: row.details,
    relatedFiles: parseJsonArray(row.related_files_json),
    evidence: parseEvidenceJson(row.evidence_json),
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
  if (row.thread_id !== null) memory.threadId = row.thread_id;
  if (row.session_id !== null) memory.sessionId = row.session_id;
  if (row.source_adapter !== null) memory.sourceAdapter = row.source_adapter;
  return memory;
}

function temporaryMemorySearchResultFromRow(
  row: TemporaryMemoryRow | TemporaryMemorySearchRow
): TemporaryMemorySearchResult {
  const score = "score" in row ? row.score : 0;
  return {
    ...temporaryMemoryFromRow(row),
    score,
    rank: 0
  };
}

function normalizeQualityStatus(status: string | undefined): MemoryQualityStatus {
  if (status === "needs_review" || status === "quarantined") return status;
  return "active";
}

function matchesQualityStatus(
  status: MemoryQualityStatus,
  filter: MemoryQualityStatusFilter | undefined
): boolean {
  if (filter === "all") return true;
  return status === (filter ?? "active");
}

function matchesLifecycleStatus(
  status: MemoryLifecycleStatus,
  filter: MemoryLifecycleStatusFilter | undefined
): boolean {
  if (filter === "all") return true;
  return status === (filter ?? "current");
}

function relationToEntityLink(
  row: RelationRow,
  entity: InvestigationEntityRef
): InvestigationEntityLink {
  if (row.from_type === entity.entityType && row.from_id === entity.entityId) {
    return {
      sourceType: row.from_type,
      sourceId: row.from_id,
      relation: row.relation,
      targetType: row.to_type,
      targetId: row.to_id,
      locator: row.locator ?? undefined,
      direction: "outgoing"
    };
  }
  return {
    sourceType: row.from_type,
    sourceId: row.from_id,
    relation: row.relation,
    targetType: row.to_type,
    targetId: row.to_id,
    locator: row.locator ?? undefined,
    direction: "incoming"
  };
}

function dedupeEntityLinks(links: InvestigationEntityLink[]): InvestigationEntityLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = [
      link.direction,
      link.sourceType,
      link.sourceId,
      link.relation,
      link.targetType,
      link.targetId,
      link.locator ?? ""
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rebuildCommitRelations(db: DatabaseSync, commit: CommitRecord): void {
  db.prepare(
    `delete from relations
     where from_type = 'commit' and from_id = ? and relation = 'touches' and to_type = 'file'`
  ).run(commit.hash);
  const insert = db.prepare(
    `insert into relations (id, from_type, from_id, relation, to_type, to_id, locator)
     values (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const filePath of commit.changedFiles) {
    insert.run(randomUUID(), "commit", commit.hash, "touches", "file", filePath, null);
  }
}

function matchesMemoryQuery(
  value: Pick<MemoryCandidate, "title" | "summary" | "reason" | "relatedFiles" | "statement">,
  query?: string
): boolean {
  if (!query) return true;
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const haystack = [memoryContentText(value), value.relatedFiles.join(" ")]
    .join(" ")
    .toLowerCase();
  return haystack.includes(normalized);
}

function syncStatusFromRow(row: SyncStatusRow): SyncStatus {
  const status: SyncStatus = {
    source: row.source,
    enabled: row.enabled === 1,
    metadata: parseJsonObject(row.metadata_json)
  };
  if (row.last_sync_at !== null) status.lastSyncAt = row.last_sync_at;
  if (row.last_success_at !== null) status.lastSuccessAt = row.last_success_at;
  if (row.last_error !== null) status.lastError = row.last_error;
  return status;
}

function sourceFailureFromRow(row: SourceFailureRow): SourceFailure {
  return {
    id: row.id,
    adapter: row.adapter,
    path: row.path,
    errorCode: row.error_code,
    message: row.message,
    firstOccurredAt: row.first_occurred_at,
    lastOccurredAt: row.last_occurred_at,
    attempts: row.attempts,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at })
  };
}

function sanitizeSourceFailureMessage(message: string): string {
  const redacted = redactSensitiveText(message).text;
  const normalized = redacted.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return (normalized || "Source parsing failed").slice(0, 500);
}

function isEvidenceRef(value: unknown): value is EvidenceRef {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    (record.sourceType === "conversation" || record.sourceType === "commit" || record.sourceType === "decision") &&
    typeof record.sourceId === "string" &&
    (record.locator === undefined || typeof record.locator === "string")
  );
}
