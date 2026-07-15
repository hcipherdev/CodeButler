import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { buildTrustSummary, resolveEvidenceCitations } from "../evidence/citations.js";
import {
  createEmbeddingContentHash,
  createProviderFingerprint,
  createProviderKey
} from "../embeddings/fingerprint.js";
import { createEvidenceSignature } from "../memory/evidence-signature.js";
import { createMemorySubjectKey } from "../memory/lifecycle.js";
import { redactSensitiveText } from "../privacy/redaction.js";
import { initializeSchema } from "./migrations.js";
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
  MemoryChunk,
  MemoryLifecycleStatus,
  MemoryPromotionState,
  MemoryQualityStatus,
  MemoryRelation,
  MemoryRelationType,
  MemorySearchResult,
  MemorySource,
  MemoryType,
  SearchResult,
  SourceType,
  SyncCursor,
  SyncSourceName,
  SyncStatus,
  TemporaryMemory,
  TemporaryMemoryKind,
  TemporaryMemorySearchResult,
  TemporaryMemoryUpsertInput
} from "../types.js";

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
  };
  lastSyncAt?: string;
  syncSources: Partial<Record<SyncSourceName, SyncStatus>>;
}

export type MemoryQualityStatusFilter = MemoryQualityStatus | "all";
export type MemoryLifecycleStatusFilter = MemoryLifecycleStatus | "all";

export interface MemoryStore {
  init(): void;
  close(): void;
  addSourceWithChunks(input: AddSourceInput): string;
  readSource(sourceId: string): MemorySource | undefined;
  readChunkWindow(sourceId: string, chunkIndex: number, before: number, after: number): MemoryChunk[];
  readConversationWindow(sourceId: string, anchorChunkId: string, before: number, after: number): MemoryChunk[];
  search(input: { query: string; sourceTypes?: string[]; limit?: number }): SearchResult[];
  readSearchResultsByChunkIds(chunkIds: string[]): SearchResult[];
  addCommit(commit: CommitRecord): string;
  readCommit(hash: string): CommitRecord | undefined;
  findCommits(input: { query?: string; filePath?: string; limit?: number }): CommitRecord[];
  getEntityLinks(entity: InvestigationEntityRef): InvestigationEntityLink[];
  findSourcesMentioningFile(filePath: string, limit?: number): MemorySource[];
  findMemoriesByEvidence(sourceType: SourceType, sourceId: string, limit?: number): MemorySearchResult[];
  setSyncCursor(source: SyncSourceName, cursorKey: string, cursorValue: string): void;
  getSyncCursor(source: SyncSourceName, cursorKey: string): SyncCursor | undefined;
  recordSyncStatus(status: SyncStatus): void;
  getSyncStatus(source: SyncSourceName): SyncStatus | undefined;
  listSyncStatuses(): SyncStatus[];
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
  promoteMemoryCandidate(candidateId: string, source?: DurableMemory["source"]): DurableMemory;
  upsertManualDecisionMemory(decision: DecisionRecord): DurableMemory;
  readMemory(id: string): DurableMemory | undefined;
  updateMemoryLifecycle(
    id: string,
    lifecycle: {
      lifecycleStatus: MemoryLifecycleStatus;
      validFrom?: string;
      validUntil?: string | null;
      statusReason?: string | null;
      statusChangedAt?: string;
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
    query?: string;
    limit?: number | null;
  }): MemoryCandidate[];
  listMemories(input?: {
    type?: MemoryType;
    status?: "promoted" | "candidate";
    lifecycleStatus?: MemoryLifecycleStatusFilter;
    qualityStatus?: MemoryQualityStatusFilter;
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
    limit?: number;
  }): MemorySearchResult[];
  readMemorySearchResultsByIds(memoryIds: string[]): MemorySearchResult[];
  getProjectSummary(): ProjectSummary;
  db: DatabaseSync;
  paths: {
    rootDir: string;
    dataDir: string;
    databasePath: string;
    conversationsDir: string;
    decisionsDir: string;
  };
}

interface SourceRow {
  id: string;
  type: SourceType;
  title: string;
  origin: string;
  raw_content: string;
  metadata_json: string;
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

interface ChunkRow {
  id: string;
  source_id: string;
  chunk_index: number;
  text: string;
  metadata_json: string;
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

interface MemoryCandidateRow {
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
  quality_status: MemoryQualityStatus;
  quality_reasons_json: string;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MemoryRow {
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
  quality_status: MemoryQualityStatus;
  quality_reasons_json: string;
  last_verified_at: string | null;
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

interface MemoryRelationRow {
  id: string;
  from_memory_id: string;
  to_memory_id: string;
  relation_type: MemoryRelationType;
  created_at: string;
  reason: string | null;
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
}

const TEMPORARY_MEMORY_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const TEMPORARY_MEMORY_MAX_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const SQLITE_READ_BATCH_SIZE = 500;

export function openMemoryStore(rootDir: string): MemoryStore {
  const dataDir = basename(rootDir) === ".code-butler" ? rootDir : join(rootDir, ".code-butler");
  const conversationsDir = join(dataDir, "imports", "conversations");
  const decisionsDir = join(dataDir, "decisions");
  const databasePath = join(dataDir, "memory.sqlite");
  mkdirSync(dataDir, { recursive: true });

  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");

  const store: MemoryStore = {
    db,
    paths: {
      rootDir,
      dataDir,
      databasePath,
      conversationsDir,
      decisionsDir
    },
    init() {
      mkdirSync(conversationsDir, { recursive: true });
      mkdirSync(decisionsDir, { recursive: true });
      initializeSchema(db, databasePath);
    },
    close() {
      db.close();
    },
    addSourceWithChunks(input) {
      return withTransaction(db, () => {
        const sourceId = input.source.id ?? createId(input.source.type);
        const metadataJson = JSON.stringify(input.source.metadata ?? {});
        db.prepare(
          `insert into sources (id, type, title, origin, raw_content, metadata_json, created_at)
           values (?, ?, ?, ?, ?, ?, ?)
           on conflict(id) do update set
             type = excluded.type,
             title = excluded.title,
             origin = excluded.origin,
             raw_content = excluded.raw_content,
             metadata_json = excluded.metadata_json`
        ).run(
          sourceId,
          input.source.type,
          input.source.title,
          input.source.origin,
          input.source.rawContent,
          metadataJson,
          new Date().toISOString()
        );

        db.prepare("delete from chunks_fts where source_id = ?").run(sourceId);
        db.prepare("delete from chunks where source_id = ?").run(sourceId);

        const insertChunk = db.prepare(
          `insert into chunks (id, source_id, chunk_index, text, metadata_json)
           values (?, ?, ?, ?, ?)`
        );
        const insertFts = db.prepare(
          `insert into chunks_fts (chunk_id, source_id, source_type, title, text)
           values (?, ?, ?, ?, ?)`
        );

        for (const [index, chunk] of input.chunks.entries()) {
          const chunkId = `${sourceId}:chunk:${index}`;
          insertChunk.run(
            chunkId,
            sourceId,
            index,
            chunk.text,
            JSON.stringify(chunk.metadata ?? {})
          );
          insertFts.run(chunkId, sourceId, input.source.type, input.source.title, chunk.text);
        }

        rebuildSourceRelations(db, sourceId, input.source, input.chunks);

        return sourceId;
      });
    },
    readSource(sourceId) {
      const row = db
        .prepare("select id, type, title, origin, raw_content, metadata_json from sources where id = ?")
        .get(sourceId) as SourceRow | undefined;
      if (!row) return undefined;
      return {
        id: row.id,
        type: row.type,
        title: row.title,
        origin: row.origin,
        rawContent: row.raw_content,
        metadata: parseJsonObject(row.metadata_json)
      };
    },
    readChunkWindow(sourceId, chunkIndex, before, after) {
      const start = Math.max(0, chunkIndex - Math.max(0, before));
      const end = chunkIndex + Math.max(0, after);
      const rows = db
        .prepare(
          `select id, source_id, chunk_index, text, metadata_json
           from chunks
           where source_id = ? and chunk_index between ? and ?
           order by chunk_index asc`
        )
        .all(sourceId, start, end) as unknown as ChunkRow[];
      return rows.map(chunkFromRow);
    },
    readConversationWindow(sourceId, anchorChunkId, before, after) {
      const anchor = db
        .prepare(
          `select id, source_id, chunk_index, text, metadata_json
           from chunks
           where id = ? and source_id = ?`
        )
        .get(anchorChunkId, sourceId) as ChunkRow | undefined;
      if (!anchor) return [];
      return store.readChunkWindow(sourceId, anchor.chunk_index, before, after);
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
      const row = db
        .prepare(
          `select hash, author_name, author_email, authored_at, message, changed_files_json, diff_summary
           from commits
           where hash = ?`
        )
        .get(hash) as CommitRow | undefined;
      return row ? commitFromRow(row) : undefined;
    },
    findCommits(input) {
      const rows = db
        .prepare(
          `select hash, author_name, author_email, authored_at, message, changed_files_json, diff_summary
           from commits
           order by authored_at desc, rowid asc`
        )
        .all() as unknown as CommitRow[];
      const query = input.query?.toLowerCase();
      const filePath = input.filePath;
      const limit = normalizeLimit(input.limit);

      return rows
        .map(commitFromRow)
        .filter((commit) => {
          if (filePath && !commit.changedFiles.includes(filePath)) return false;
          if (!query) return true;
          const haystack = [
            commit.hash,
            commit.message,
            commit.diffSummary,
            commit.changedFiles.join(" ")
          ]
            .join(" ")
            .toLowerCase();
          return haystack.includes(query);
        })
        .slice(0, limit);
    },
    getEntityLinks(entity) {
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
      const rows = db
        .prepare(
          `select distinct s.id, s.type, s.title, s.origin, s.raw_content, s.metadata_json
           from relations r
           join sources s on s.id = r.from_id
           where r.from_type = 'source' and r.relation = 'mentions' and r.to_type = 'file' and r.to_id = ?
           order by s.created_at desc, s.id asc
           limit ?`
        )
        .all(filePath, normalizeLimit(limit)) as unknown as SourceRow[];
      return rows.map(sourceFromRow);
    },
    findMemoriesByEvidence(sourceType, sourceId, limit) {
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
      ).run(source, cursorKey, cursorValue, new Date().toISOString());
    },
    getSyncCursor(source, cursorKey) {
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
        status.lastError ?? null,
        JSON.stringify(status.metadata ?? {})
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
    listEmbeddingOwners() {
      const chunks = db.prepare(
        `select id, text from chunks order by id asc`
      ).all() as Array<{ id: string; text: string }>;
      const memories = db.prepare(
        `select id, title, summary, reason, lifecycle_generation
         from memories
         where lifecycle_status = 'current'
         order by id asc`
      ).all() as Array<{
        id: string;
        title: string;
        summary: string;
        reason: string;
        lifecycle_generation: string;
      }>;
      return [
        ...chunks.map<EmbeddingOwner>((row) => ({
          ownerKind: "chunk",
          ownerId: row.id,
          text: row.text,
          contentHash: createEmbeddingContentHash(row.text),
          ownerVersion: ""
        })),
        ...memories.map<EmbeddingOwner>((row) => {
          const text = [row.title, row.summary, row.reason].join("\n\n");
          return {
            ownerKind: "memory",
            ownerId: row.id,
            text,
            contentHash: createEmbeddingContentHash(text),
            ownerVersion: row.lifecycle_generation
          };
        })
      ];
    },
    reconcileEmbeddingJobs(input) {
      validateProviderKey(input);
      return withTransaction(db, () => {
        const owners = store.listEmbeddingOwners();
        const eligible = new Map(
          owners.map((owner) => [
            embeddingOwnerIdentity(owner.ownerKind, owner.ownerId, owner.contentHash),
            owner.ownerVersion
          ])
        );
        let removedJobs = 0;
        const jobs = db.prepare(
          `select owner_kind, owner_id, content_hash, owner_version
           from embedding_jobs where provider_key = ?`
        ).all(input.providerKey) as Array<{
          owner_kind: EmbeddingOwnerKind;
          owner_id: string;
          content_hash: string;
          owner_version: string;
        }>;
        const deleteJob = db.prepare(
          `delete from embedding_jobs
           where owner_kind = ? and owner_id = ? and content_hash = ? and provider_key = ?`
        );
        for (const job of jobs) {
          const identity = embeddingOwnerIdentity(job.owner_kind, job.owner_id, job.content_hash);
          if (eligible.get(identity) === job.owner_version) continue;
          removedJobs += Number(deleteJob.run(
            job.owner_kind,
            job.owner_id,
            job.content_hash,
            input.providerKey
          ).changes);
        }

        let removedVectors = 0;
        const vectors = db.prepare(
          `select owner_kind, owner_id, content_hash, owner_version, provider_fingerprint
           from embedding_vectors where provider_key = ?`
        ).all(input.providerKey) as Array<{
          owner_kind: EmbeddingOwnerKind;
          owner_id: string;
          content_hash: string;
          owner_version: string;
          provider_fingerprint: string;
        }>;
        const deleteVector = db.prepare(
          `delete from embedding_vectors
           where owner_kind = ? and owner_id = ? and content_hash = ? and provider_fingerprint = ?`
        );
        for (const vector of vectors) {
          const identity = embeddingOwnerIdentity(vector.owner_kind, vector.owner_id, vector.content_hash);
          if (eligible.get(identity) === vector.owner_version) continue;
          removedVectors += Number(deleteVector.run(
            vector.owner_kind,
            vector.owner_id,
            vector.content_hash,
            vector.provider_fingerprint
          ).changes);
        }

        const now = new Date().toISOString();
        const insert = db.prepare(
          `insert into embedding_jobs
             (owner_kind, owner_id, content_hash, owner_version, provider_key, endpoint_hash, model,
              state, attempts, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
           on conflict(owner_kind, owner_id, content_hash, provider_key) do nothing`
        );
        let enqueued = 0;
        for (const owner of owners) {
          enqueued += Number(insert.run(
            owner.ownerKind,
            owner.ownerId,
            owner.contentHash,
            owner.ownerVersion,
            input.providerKey,
            input.endpointHash,
            input.model,
            now,
            now
          ).changes);
        }
        return { enqueued, removedJobs, removedVectors };
      });
    },
    beginEmbeddingIndexRebuild(input) {
      validateProviderKey(input);
      return withTransaction(db, () => {
        const rebuildToken = randomUUID();
        const removedVectors = Number(db.prepare(
          "delete from embedding_vectors where provider_key = ?"
        ).run(input.providerKey).changes);
        const now = new Date().toISOString();
        const requeue = db.prepare(
          `insert into embedding_jobs
             (owner_kind, owner_id, content_hash, owner_version, provider_key, endpoint_hash, model,
              index_generation, target_fingerprint, state, attempts, provider_fingerprint,
              last_error, created_at, updated_at, completed_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, null, 'pending', 0, null, null, ?, ?, null)
           on conflict(owner_kind, owner_id, content_hash, provider_key) do update set
             owner_version = excluded.owner_version,
             endpoint_hash = excluded.endpoint_hash,
             model = excluded.model,
             index_generation = excluded.index_generation,
             target_fingerprint = null,
             state = 'pending',
             provider_fingerprint = null,
             last_error = null,
             updated_at = excluded.updated_at,
             completed_at = null`
        );
        let requeued = 0;
        for (const owner of store.listEmbeddingOwners()) {
          requeued += Number(requeue.run(
            owner.ownerKind,
            owner.ownerId,
            owner.contentHash,
            owner.ownerVersion,
            input.providerKey,
            input.endpointHash,
            input.model,
            rebuildToken,
            now,
            now
          ).changes);
        }
        return { removedVectors, requeued, rebuildToken };
      });
    },
    activateEmbeddingIndexRebuild(input) {
      if (!input.rebuildToken.trim()) throw new Error("Embedding rebuild token is required");
      if (!/^[a-f0-9]{64}$/.test(input.providerFingerprint)) {
        throw new Error("Embedding rebuild target fingerprint is invalid");
      }
      return withTransaction(db, () => {
        const rows = db.prepare(
          `select distinct target_fingerprint
           from embedding_jobs
           where provider_key = ? and index_generation = ?`
        ).all(input.providerKey, input.rebuildToken) as Array<{ target_fingerprint: string | null }>;
        if (rows.length === 0) throw new Error("Embedding rebuild generation is no longer active");
        if (rows.some((row) => row.target_fingerprint !== null && row.target_fingerprint !== input.providerFingerprint)) {
          throw new Error("Embedding rebuild generation already has a different target fingerprint");
        }
        return Number(db.prepare(
          `update embedding_jobs set target_fingerprint = ?, updated_at = ?
           where provider_key = ? and index_generation = ?`
        ).run(
          input.providerFingerprint,
          new Date().toISOString(),
          input.providerKey,
          input.rebuildToken
        ).changes);
      });
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
        parameters.push(input.ownerId);
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
        parameters.push(input.ownerId);
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
        parameters.push(input.ownerId);
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
                m.reason as current_memory_reason
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
            : [row.current_memory_title, row.current_memory_summary, row.current_memory_reason].join("\n\n");
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
      ).run(ownerKind, ownerId).changes);
    },
    deleteEmbeddingVectorsForOwner(ownerKind, ownerId) {
      return Number(db.prepare(
        "delete from embedding_vectors where owner_kind = ? and owner_id = ?"
      ).run(ownerKind, ownerId).changes);
    },
    upsertMemoryCandidate(memory, options) {
      return withTransaction(db, () => {
        const now = new Date().toISOString();
        const existing = db
          .prepare(
            `select id, type, title, summary, reason, confidence, evidence_json, related_files_json,
                    dedupe_key, promotion_state, promoted_memory_id, quality_status, quality_reasons_json, last_verified_at,
                    created_at, updated_at
             from memory_candidates
             where dedupe_key = ?`
          )
          .get(memory.dedupeKey) as MemoryCandidateRow | undefined;
        const candidateId = existing?.id ?? `candidate-${randomUUID()}`;
        const promotionState = options?.promotionState ?? existing?.promotion_state ?? "candidate";
        const qualityStatus = options?.qualityStatus ?? existing?.quality_status ?? "active";
        const qualityReasons = options?.qualityReasons ?? parseJsonArray(existing?.quality_reasons_json ?? "[]");
        const lastVerifiedAt = options?.lastVerifiedAt ?? existing?.last_verified_at ?? null;
        db.prepare(
          `insert into memory_candidates
             (id, type, title, summary, reason, confidence, evidence_json, related_files_json,
              dedupe_key, promotion_state, evidence_signature, quality_status, quality_reasons_json,
              last_verified_at, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(dedupe_key) do update set
             type = excluded.type,
             title = excluded.title,
             summary = excluded.summary,
             reason = excluded.reason,
             confidence = excluded.confidence,
             evidence_json = excluded.evidence_json,
             related_files_json = excluded.related_files_json,
             promotion_state = excluded.promotion_state,
             evidence_signature = excluded.evidence_signature,
             quality_status = excluded.quality_status,
             quality_reasons_json = excluded.quality_reasons_json,
             last_verified_at = excluded.last_verified_at,
             updated_at = excluded.updated_at`
        ).run(
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
          qualityStatus,
          JSON.stringify(qualityReasons),
          lastVerifiedAt,
          existing?.created_at ?? now,
          now
        );
        rebuildMemoryLinks(db, "candidate", candidateId, memory.evidence, memory.relatedFiles);
        const row = db
          .prepare(
            `select id, type, title, summary, reason, confidence, evidence_json, related_files_json,
                    dedupe_key, promotion_state, promoted_memory_id, quality_status, quality_reasons_json, last_verified_at,
                    created_at, updated_at
             from memory_candidates
             where id = ?`
          )
          .get(candidateId) as unknown as MemoryCandidateRow;
        return memoryCandidateFromRow(row);
      });
    },
    promoteMemoryCandidate(candidateId, source = "auto") {
      return withTransaction(db, () => {
        const candidate = db
          .prepare(
            `select id, type, title, summary, reason, confidence, evidence_json, related_files_json,
                    dedupe_key, promotion_state, promoted_memory_id, quality_status, quality_reasons_json, last_verified_at,
                    created_at, updated_at
             from memory_candidates
             where id = ?`
          )
          .get(candidateId) as MemoryCandidateRow | undefined;
        if (!candidate) {
          throw new Error(`Unknown memory candidate: ${candidateId}`);
        }
        const memory = upsertMemoryRow(db, {
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
          qualityStatus: candidate.quality_status,
          qualityReasons: parseJsonArray(candidate.quality_reasons_json),
          lastVerifiedAt: candidate.last_verified_at ?? undefined,
          createdAt: candidate.created_at
        });
        db.prepare(
          `update memory_candidates
           set promotion_state = 'promoted', promoted_memory_id = ?, updated_at = ?
           where id = ?`
        ).run(memory.id, new Date().toISOString(), candidateId);
        return memory;
      });
    },
    upsertManualDecisionMemory(decision) {
      return withTransaction(db, () => upsertMemoryRow(db, {
        id: `memory-manual-${decision.id}`,
        type: "decision",
        title: decision.topic,
        summary: decision.decision,
        reason: decision.reason,
        confidence: 1,
        evidence: decision.evidence,
        relatedFiles: [],
        dedupeKey: `manual-decision:${decision.id}`,
        source: "manual",
        qualityStatus: "active",
        qualityReasons: [],
        createdAt: decision.createdAt
      }));
    },
    readMemory(id) {
      return readMemoryRow(db, id);
    },
    updateMemoryLifecycle(id, lifecycle) {
      return withTransaction(db, () => {
        const existing = readMemoryRow(db, id);
        if (!existing) throw new Error(`Unknown durable memory: ${id}`);
        db.prepare(
          `update memories
           set lifecycle_status = ?, valid_from = ?, valid_until = ?, status_reason = ?,
               status_changed_at = ?, lifecycle_generation = ?
           where id = ?`
        ).run(
          lifecycle.lifecycleStatus,
          lifecycle.validFrom ?? existing.validFrom,
          lifecycle.validUntil === undefined ? existing.validUntil ?? null : lifecycle.validUntil,
          lifecycle.statusReason === undefined ? existing.statusReason ?? null : lifecycle.statusReason,
          lifecycle.statusChangedAt ?? new Date().toISOString(),
          randomUUID(),
          id
        );
        return readMemoryRow(db, id) as DurableMemory;
      });
    },
    addMemoryRelation(input) {
      return withTransaction(db, () => {
        if (input.fromMemoryId === input.toMemoryId) {
          throw new Error("Memory relations cannot relate a memory to itself");
        }
        if (!readMemoryRow(db, input.fromMemoryId)) {
          throw new Error(`Unknown durable memory: ${input.fromMemoryId}`);
        }
        if (!readMemoryRow(db, input.toMemoryId)) {
          throw new Error(`Unknown durable memory: ${input.toMemoryId}`);
        }
        const id = `memory-relation-${randomUUID()}`;
        db.prepare(
          `insert into memory_relations (id, from_memory_id, to_memory_id, relation_type, created_at, reason)
           values (?, ?, ?, ?, ?, ?)
           on conflict(from_memory_id, to_memory_id, relation_type) do nothing`
        ).run(
          id,
          input.fromMemoryId,
          input.toMemoryId,
          input.relationType,
          input.createdAt ?? new Date().toISOString(),
          input.reason ?? null
        );
        const row = db.prepare(
          `select id, from_memory_id, to_memory_id, relation_type, created_at, reason
           from memory_relations
           where from_memory_id = ? and to_memory_id = ? and relation_type = ?`
        ).get(input.fromMemoryId, input.toMemoryId, input.relationType) as unknown as MemoryRelationRow;
        return memoryRelationFromRow(row);
      });
    },
    listMemoryRelations(input = {}) {
      const predicates: string[] = [];
      const parameters: string[] = [];
      if (input.fromMemoryId !== undefined) {
        predicates.push("from_memory_id = ?");
        parameters.push(input.fromMemoryId);
      }
      if (input.toMemoryId !== undefined) {
        predicates.push("to_memory_id = ?");
        parameters.push(input.toMemoryId);
      }
      if (input.relationType !== undefined) {
        predicates.push("relation_type = ?");
        parameters.push(input.relationType);
      }
      const where = predicates.length > 0 ? `where ${predicates.join(" and ")}` : "";
      const rows = db.prepare(
        `select id, from_memory_id, to_memory_id, relation_type, created_at, reason
         from memory_relations ${where}
         order by created_at asc, id asc`
      ).all(...parameters) as unknown as MemoryRelationRow[];
      return rows.map(memoryRelationFromRow);
    },
    deleteMemoryRelation(id) {
      return withTransaction(db, () => db.prepare("delete from memory_relations where id = ?").run(id).changes > 0);
    },
    listMemoryCandidates(input = {}) {
      const rows = db
        .prepare(
          `select id, type, title, summary, reason, confidence, evidence_json, related_files_json,
                  dedupe_key, promotion_state, promoted_memory_id, quality_status, quality_reasons_json, last_verified_at,
                  created_at, updated_at
           from memory_candidates
           order by updated_at desc, created_at desc, rowid desc`
        )
        .all() as unknown as MemoryCandidateRow[];
      return rows
        .map(memoryCandidateFromRow)
        .filter((candidate) => {
          if (input.type && candidate.type !== input.type) return false;
          if (input.promotionState && candidate.promotionState !== input.promotionState) return false;
          if (!matchesQualityStatus(candidate.qualityStatus, input.qualityStatus)) return false;
          return matchesMemoryQuery(candidate, input.query);
        })
        .slice(0, input.limit === null ? undefined : normalizeLimit(input.limit));
    },
    listMemories(input = {}) {
      if (input.status === "candidate") return [];
      const rows = db
        .prepare(
          `select id, type, title, summary, reason, confidence, evidence_json, related_files_json,
                  dedupe_key, source, quality_status, quality_reasons_json, last_verified_at,
                  subject_key, lifecycle_status, valid_from, valid_until, status_reason, status_changed_at,
                  lifecycle_generation,
                  created_at, promoted_at
           from memories
           order by promoted_at desc, created_at desc`
        )
        .all() as unknown as MemoryRow[];
      return rows
        .map(memoryFromRow)
        .filter((memory) => {
          if (input.type && memory.type !== input.type) return false;
          if (!matchesLifecycleStatus(memory.lifecycleStatus, input.lifecycleStatus)) return false;
          if (!matchesQualityStatus(memory.qualityStatus, input.qualityStatus)) return false;
          return matchesMemoryQuery(memory, input.query);
        })
        .slice(0, input.limit === null ? undefined : normalizeLimit(input.limit));
    },
    updateMemoryQuality(kind, id, quality) {
      const table = kind === "candidate" ? "memory_candidates" : "memories";
      db.prepare(
        `update ${table}
         set quality_status = ?, quality_reasons_json = ?, last_verified_at = ?
         where id = ?`
      ).run(
        quality.qualityStatus,
        JSON.stringify(quality.qualityReasons),
        quality.lastVerifiedAt ?? null,
        id
      );
    },
    upsertTemporaryMemory(input) {
      return withTransaction(db, () => {
        const now = input.updatedAt ?? new Date().toISOString();
        const existing = input.id
          ? db
              .prepare(
                `select id, project_id, thread_id, session_id, source_adapter, kind, title, summary, details,
                        related_files_json, evidence_json, confidence, created_at, updated_at, expires_at
                 from temporary_memories
                 where id = ?`
              )
              .get(input.id) as TemporaryMemoryRow | undefined
          : undefined;
        const id = input.id ?? `temporary-${randomUUID()}`;
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
             (id, project_id, thread_id, session_id, source_adapter, kind, title, summary, details,
              related_files_json, evidence_json, confidence, created_at, updated_at, expires_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(id) do update set
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
            `select id, project_id, thread_id, session_id, source_adapter, kind, title, summary, details,
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
      if (input.threadId !== undefined) rankInput.threadId = input.threadId;
      if (input.sessionId !== undefined) rankInput.sessionId = input.sessionId;
      return rankTemporaryMemories(rows, rankInput);
    },
    listActiveTemporaryMemory(input = {}) {
      const now = input.now ?? new Date().toISOString();
      const rows = db
        .prepare(
          `select id, project_id, thread_id, session_id, source_adapter, kind, title, summary, details,
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
      const promotedInput: Parameters<typeof store.listMemories>[0] = {
        status: "promoted",
        limit
      };
      if (input.type !== undefined) promotedInput.type = input.type;
      if (input.query !== undefined) promotedInput.query = input.query;
      if (input.qualityStatus !== undefined) promotedInput.qualityStatus = input.qualityStatus;
      if (input.lifecycleStatus !== undefined) promotedInput.lifecycleStatus = input.lifecycleStatus;
      const promoted =
        input.status === "candidate"
          ? []
          : store.listMemories(promotedInput);
      const candidateInput: Parameters<typeof store.listMemoryCandidates>[0] = { limit };
      if (input.type !== undefined) candidateInput.type = input.type;
      if (input.query !== undefined) candidateInput.query = input.query;
      if (input.qualityStatus !== undefined) candidateInput.qualityStatus = input.qualityStatus;
      const candidates =
        input.status === "promoted"
          ? []
          : store.listMemoryCandidates(candidateInput);

      return [
        ...promoted.map<MemorySearchResult>((memory) => memorySearchResult(store, "promoted", memory)),
        ...candidates.map<MemorySearchResult>((candidate) => memorySearchResult(store, "candidate", candidate))
      ].slice(0, limit);
    },
    readMemorySearchResultsByIds(memoryIds) {
      if (memoryIds.length === 0) return [];
      const rows = chunked(memoryIds, SQLITE_READ_BATCH_SIZE).flatMap((batch) =>
        db.prepare(
          `select id, type, title, summary, reason, confidence, evidence_json, related_files_json,
                  dedupe_key, source, quality_status, quality_reasons_json, last_verified_at,
                  subject_key, lifecycle_status, valid_from, valid_until, status_reason, status_changed_at,
                  lifecycle_generation, created_at, promoted_at
           from memories where lifecycle_status = 'current'
             and id in (${batch.map(() => "?").join(", ")})`
        ).all(...batch) as unknown as MemoryRow[]
      );
      const byId = new Map(rows.map((row) => [row.id, memoryFromRow(row)]));
      return memoryIds.flatMap((memoryId) => {
        const memory = byId.get(memoryId);
        return memory ? [memorySearchResult(store, "promoted", memory)] : [];
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
        memoryHealth: countMemoryHealth(db),
        syncSources
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
    qualityStatus: MemoryQualityStatus;
    qualityReasons: string[];
    lastVerifiedAt?: string | undefined;
    createdAt: string;
  }
): DurableMemory {
  const evidenceSignature = createEvidenceSignature(input.evidence);
  const existing = input.id
    ? readMemoryRowRaw(db, input.id)
    : db.prepare(
        `select id, type, title, summary, reason, confidence, evidence_json, related_files_json,
                dedupe_key, source, quality_status, quality_reasons_json, last_verified_at,
                subject_key, lifecycle_status, valid_from, valid_until, status_reason, status_changed_at,
                lifecycle_generation,
                created_at, promoted_at
         from memories
         where dedupe_key = ? and evidence_signature = ? and source = ?`
      ).get(input.dedupeKey, evidenceSignature, input.source) as MemoryRow | undefined;
  const id = existing?.id ?? input.id ?? `memory-${randomUUID()}`;
  const subjectKey = createMemorySubjectKey(input.type, input.title);
  if (existing) {
    db.prepare(
      `update memories set
         type = ?, title = ?, summary = ?, reason = ?, confidence = ?, evidence_json = ?,
         related_files_json = ?, dedupe_key = ?, evidence_signature = ?, source = ?, subject_key = ?,
         quality_status = ?, quality_reasons_json = ?, last_verified_at = ?
       where id = ?`
    ).run(
      input.type, input.title, input.summary, input.reason, input.confidence,
      JSON.stringify(input.evidence), JSON.stringify(input.relatedFiles), input.dedupeKey,
      evidenceSignature, input.source, subjectKey, input.qualityStatus,
      JSON.stringify(input.qualityReasons), input.lastVerifiedAt ?? null, id
    );
  } else {
    const promotedAt = new Date().toISOString();
    const lifecycleGeneration = randomUUID();
    db.prepare(
      `insert into memories
         (id, type, title, summary, reason, confidence, evidence_json, related_files_json,
          dedupe_key, evidence_signature, source, quality_status, quality_reasons_json,
          last_verified_at, subject_key, lifecycle_status, valid_from, valid_until,
          status_reason, status_changed_at, lifecycle_generation, created_at, promoted_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, null, null, ?, ?, ?, ?)`
    ).run(
      id, input.type, input.title, input.summary, input.reason, input.confidence,
      JSON.stringify(input.evidence), JSON.stringify(input.relatedFiles), input.dedupeKey,
      evidenceSignature, input.source, input.qualityStatus, JSON.stringify(input.qualityReasons),
      input.lastVerifiedAt ?? null, subjectKey, input.createdAt, promotedAt, lifecycleGeneration,
      input.createdAt, promotedAt
    );
  }
  rebuildMemoryLinks(db, "memory", id, input.evidence, input.relatedFiles);
  return readMemoryRow(db, id) as DurableMemory;
}

function readMemoryRowRaw(db: DatabaseSync, id: string): MemoryRow | undefined {
  return db.prepare(
    `select id, type, title, summary, reason, confidence, evidence_json, related_files_json,
            dedupe_key, source, quality_status, quality_reasons_json, last_verified_at,
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

function embeddingOwnerIdentity(ownerKind: EmbeddingOwnerKind, ownerId: string, contentHash: string): string {
  return `${ownerKind}\0${ownerId}\0${contentHash}`;
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
    `select title, summary, reason, lifecycle_generation
     from memories where id = ? and lifecycle_status = 'current'`
  ).get(input.ownerId) as
    | { title: string; summary: string; reason: string; lifecycle_generation: string }
    | undefined;
  if (!memory || memory.lifecycle_generation !== input.ownerVersion) return false;
  const text = [memory.title, memory.summary, memory.reason].join("\n\n");
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

function countMemoryHealth(db: DatabaseSync): { active: number; needsReview: number; quarantined: number } {
  const rows = [
    ...db.prepare("select quality_status as status from memory_candidates where promotion_state = 'candidate'").all(),
    ...db.prepare("select quality_status as status from memories").all()
  ] as Array<{ status: string }>;
  return {
    active: rows.filter((row) => normalizeQualityStatus(row.status) === "active").length,
    needsReview: rows.filter((row) => normalizeQualityStatus(row.status) === "needs_review").length,
    quarantined: rows.filter((row) => normalizeQualityStatus(row.status) === "quarantined").length
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 10;
  return Math.max(1, Math.min(Math.floor(limit), 100));
}

function chunked<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    batches.push(items.slice(offset, offset + size));
  }
  return batches;
}

function createId(type: SourceType): string {
  return `${type}-${randomUUID()}`;
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

function sourceFromRow(row: SourceRow): MemorySource {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    origin: row.origin,
    rawContent: row.raw_content,
    metadata: parseJsonObject(row.metadata_json)
  };
}

function chunkFromRow(row: ChunkRow): MemoryChunk {
  return {
    id: row.id,
    sourceId: row.source_id,
    chunkIndex: row.chunk_index,
    text: row.text,
    metadata: parseJsonObject(row.metadata_json)
  };
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
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    reason: row.reason,
    confidence: row.confidence,
    evidence: parseEvidenceJson(row.evidence_json),
    relatedFiles: parseJsonArray(row.related_files_json),
    dedupeKey: row.dedupe_key,
    promotionState: row.promotion_state,
    promotedMemoryId: row.promoted_memory_id ?? undefined,
    qualityStatus: normalizeQualityStatus(row.quality_status),
    qualityReasons: parseJsonArray(row.quality_reasons_json),
    lastVerifiedAt: row.last_verified_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function memoryFromRow(row: MemoryRow): DurableMemory {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    reason: row.reason,
    confidence: row.confidence,
    evidence: parseEvidenceJson(row.evidence_json),
    relatedFiles: parseJsonArray(row.related_files_json),
    dedupeKey: row.dedupe_key,
    source: row.source,
    qualityStatus: normalizeQualityStatus(row.quality_status),
    qualityReasons: parseJsonArray(row.quality_reasons_json),
    lastVerifiedAt: row.last_verified_at ?? undefined,
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

function memorySearchResult(
  store: MemoryStore,
  kind: MemorySearchResult["kind"],
  memory: MemoryCandidate | DurableMemory
): MemorySearchResult {
  const citations = resolveEvidenceCitations(store, {
    evidence: memory.evidence,
    relatedFiles: memory.relatedFiles
  });
  const result: MemorySearchResult = {
    kind,
    id: memory.id,
    type: memory.type,
    title: memory.title,
    summary: memory.summary,
    reason: memory.reason,
    confidence: memory.confidence,
    evidence: memory.evidence,
    relatedFiles: memory.relatedFiles,
    dedupeKey: memory.dedupeKey,
    qualityStatus: memory.qualityStatus,
    qualityReasons: memory.qualityReasons,
    lastVerifiedAt: memory.lastVerifiedAt,
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
  if ("lifecycleStatus" in memory) {
    result.subjectKey = memory.subjectKey;
    result.lifecycleStatus = memory.lifecycleStatus;
    result.validFrom = memory.validFrom;
    result.validUntil = memory.validUntil;
    result.statusReason = memory.statusReason;
    result.statusChangedAt = memory.statusChangedAt;
  }
  return result;
}

function memoryRelationFromRow(row: MemoryRelationRow): MemoryRelation {
  return {
    id: row.id,
    fromMemoryId: row.from_memory_id,
    toMemoryId: row.to_memory_id,
    relationType: row.relation_type,
    createdAt: row.created_at,
    reason: row.reason ?? undefined
  };
}

function temporaryMemoryFromRow(row: TemporaryMemoryRow): TemporaryMemory {
  const memory: TemporaryMemory = {
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

function rebuildSourceRelations(
  db: DatabaseSync,
  sourceId: string,
  source: MemorySource,
  chunks: Array<{ text: string; metadata?: Record<string, unknown> }>
): void {
  db.prepare(
    `delete from relations
     where (from_type = 'source' and from_id = ? and relation = 'mentions' and to_type = 'file')
        or (from_type = 'chunk' and from_id like ? and relation = 'mentions' and to_type = 'file')`
  ).run(sourceId, `${sourceId}:chunk:%`);
  const insert = db.prepare(
    `insert into relations (id, from_type, from_id, relation, to_type, to_id, locator)
     values (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const filePath of detectMentionedFiles(source.rawContent, source.metadata)) {
    insert.run(randomUUID(), "source", sourceId, "mentions", "file", filePath, null);
  }
  for (const [index, chunk] of chunks.entries()) {
    const chunkId = `${sourceId}:chunk:${index}`;
    for (const filePath of detectMentionedFiles(chunk.text, chunk.metadata)) {
      insert.run(randomUUID(), "chunk", chunkId, "mentions", "file", filePath, chunkId);
    }
  }
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

function detectMentionedFiles(text: string, metadata?: Record<string, unknown>): string[] {
  const mentioned = new Set<string>();
  const metadataFilePath = typeof metadata?.filePath === "string" ? metadata.filePath : undefined;
  if (metadataFilePath) mentioned.add(normalizeDetectedFilePath(metadataFilePath));
  const metadataChangedFiles = Array.isArray(metadata?.changedFiles)
    ? metadata.changedFiles.filter((item): item is string => typeof item === "string")
    : [];
  for (const filePath of metadataChangedFiles) mentioned.add(normalizeDetectedFilePath(filePath));
  const matches = text.match(/(?:[\w.-]+\/)+[\w.-]+/g) ?? [];
  for (const match of matches) mentioned.add(normalizeDetectedFilePath(match));
  return [...mentioned].filter((filePath) => filePath.length > 0);
}

function normalizeDetectedFilePath(filePath: string): string {
  return filePath.replace(/^[("'`]+/, "").replace(/[.,;:!?)"'`]+$/, "");
}

function matchesMemoryQuery(
  value: Pick<MemoryCandidate, "title" | "summary" | "reason" | "relatedFiles">,
  query?: string
): boolean {
  if (!query) return true;
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const haystack = [value.title, value.summary, value.reason, value.relatedFiles.join(" ")]
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

function isEvidenceRef(value: unknown): value is EvidenceRef {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    (record.sourceType === "conversation" || record.sourceType === "commit" || record.sourceType === "decision") &&
    typeof record.sourceId === "string" &&
    (record.locator === undefined || typeof record.locator === "string")
  );
}
