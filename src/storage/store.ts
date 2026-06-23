import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  CommitRecord,
  DecisionRecord,
  DurableMemory,
  EvidenceRef,
  ExtractedMemory,
  InvestigationEntityLink,
  InvestigationEntityRef,
  MemoryCandidate,
  MemoryChunk,
  MemoryPromotionState,
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
  lastSyncAt?: string;
  syncSources: Partial<Record<SyncSourceName, SyncStatus>>;
}

export interface MemoryStore {
  init(): void;
  close(): void;
  addSourceWithChunks(input: AddSourceInput): string;
  readSource(sourceId: string): MemorySource | undefined;
  readChunkWindow(sourceId: string, chunkIndex: number, before: number, after: number): MemoryChunk[];
  readConversationWindow(sourceId: string, anchorChunkId: string, before: number, after: number): MemoryChunk[];
  search(input: { query: string; sourceTypes?: string[]; limit?: number }): SearchResult[];
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
  upsertMemoryCandidate(
    memory: ExtractedMemory,
    options?: { promotionState?: MemoryPromotionState }
  ): MemoryCandidate;
  promoteMemoryCandidate(candidateId: string, source?: DurableMemory["source"]): DurableMemory;
  upsertManualDecisionMemory(decision: DecisionRecord): DurableMemory;
  listMemoryCandidates(input?: {
    type?: MemoryType;
    promotionState?: MemoryPromotionState;
    query?: string;
    limit?: number;
  }): MemoryCandidate[];
  listMemories(input?: {
    type?: MemoryType;
    status?: "promoted" | "candidate";
    query?: string;
    limit?: number;
  }): DurableMemory[];
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
    limit?: number;
  }): MemorySearchResult[];
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

const TEMPORARY_MEMORY_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const TEMPORARY_MEMORY_MAX_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export function openMemoryStore(rootDir: string): MemoryStore {
  const dataDir = basename(rootDir) === ".code-butler" ? rootDir : join(rootDir, ".code-butler");
  const conversationsDir = join(dataDir, "imports", "conversations");
  const decisionsDir = join(dataDir, "decisions");
  const databasePath = join(dataDir, "memory.sqlite");
  mkdirSync(dataDir, { recursive: true });

  const db = new DatabaseSync(databasePath);
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
      runMigrations(db);
    },
    close() {
      db.close();
    },
    addSourceWithChunks(input) {
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
    addCommit(commit) {
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
        .map<MemorySearchResult>((memory) => ({
          kind: "promoted",
          id: memory.id,
          type: memory.type,
          title: memory.title,
          summary: memory.summary,
          reason: memory.reason,
          confidence: memory.confidence,
          evidence: memory.evidence,
          relatedFiles: memory.relatedFiles
        }));
      const candidates = store
        .listMemoryCandidates({ limit: normalizedLimit * 2 })
        .filter((memory) =>
          memory.evidence.some((evidence) => evidence.sourceType === sourceType && evidence.sourceId === sourceId)
        )
        .map<MemorySearchResult>((memory) => ({
          kind: "candidate",
          id: memory.id,
          type: memory.type,
          title: memory.title,
          summary: memory.summary,
          reason: memory.reason,
          confidence: memory.confidence,
          evidence: memory.evidence,
          relatedFiles: memory.relatedFiles
        }));
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
    upsertMemoryCandidate(memory, options) {
      const now = new Date().toISOString();
      const existing = db
        .prepare(
          `select id, type, title, summary, reason, confidence, evidence_json, related_files_json,
                  dedupe_key, promotion_state, created_at, updated_at
           from memory_candidates
           where dedupe_key = ?`
        )
        .get(memory.dedupeKey) as MemoryCandidateRow | undefined;
      const candidateId = existing?.id ?? `candidate-${randomUUID()}`;
      const promotionState = options?.promotionState ?? existing?.promotion_state ?? "candidate";
      db.prepare(
        `insert into memory_candidates
           (id, type, title, summary, reason, confidence, evidence_json, related_files_json,
            dedupe_key, promotion_state, evidence_signature, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        normalizeEvidenceSignature(memory.evidence),
        existing?.created_at ?? now,
        now
      );
      rebuildMemoryLinks(db, "candidate", candidateId, memory.evidence, memory.relatedFiles);
      const row = db
        .prepare(
          `select id, type, title, summary, reason, confidence, evidence_json, related_files_json,
                  dedupe_key, promotion_state, created_at, updated_at
           from memory_candidates
           where id = ?`
        )
        .get(candidateId) as unknown as MemoryCandidateRow;
      return memoryCandidateFromRow(row);
    },
    promoteMemoryCandidate(candidateId, source = "auto") {
      const candidate = db
        .prepare(
          `select id, type, title, summary, reason, confidence, evidence_json, related_files_json,
                  dedupe_key, promotion_state, created_at, updated_at
           from memory_candidates
           where id = ?`
        )
        .get(candidateId) as MemoryCandidateRow | undefined;
      if (!candidate) {
        throw new Error(`Unknown memory candidate: ${candidateId}`);
      }
      const memory = upsertMemoryRow(db, {
        type: candidate.type,
        title: candidate.title,
        summary: candidate.summary,
        reason: candidate.reason,
        confidence: candidate.confidence,
        evidence: parseEvidenceJson(candidate.evidence_json),
        relatedFiles: parseJsonArray(candidate.related_files_json),
        dedupeKey: candidate.dedupe_key,
        source,
        createdAt: candidate.created_at
      });
      db.prepare(
        `update memory_candidates
         set promotion_state = 'promoted', updated_at = ?
         where id = ?`
      ).run(new Date().toISOString(), candidateId);
      return memory;
    },
    upsertManualDecisionMemory(decision) {
      return upsertMemoryRow(db, {
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
        createdAt: decision.createdAt
      });
    },
    listMemoryCandidates(input = {}) {
      const rows = db
        .prepare(
          `select id, type, title, summary, reason, confidence, evidence_json, related_files_json,
                  dedupe_key, promotion_state, created_at, updated_at
           from memory_candidates
           order by updated_at desc, created_at desc`
        )
        .all() as unknown as MemoryCandidateRow[];
      return rows
        .map(memoryCandidateFromRow)
        .filter((candidate) => {
          if (input.type && candidate.type !== input.type) return false;
          if (input.promotionState && candidate.promotionState !== input.promotionState) return false;
          return matchesMemoryQuery(candidate, input.query);
        })
        .slice(0, normalizeLimit(input.limit));
    },
    listMemories(input = {}) {
      if (input.status === "candidate") return [];
      const rows = db
        .prepare(
          `select id, type, title, summary, reason, confidence, evidence_json, related_files_json,
                  dedupe_key, source, created_at, promoted_at
           from memories
           order by promoted_at desc, created_at desc`
        )
        .all() as unknown as MemoryRow[];
      return rows
        .map(memoryFromRow)
        .filter((memory) => {
          if (input.type && memory.type !== input.type) return false;
          return matchesMemoryQuery(memory, input.query);
        })
        .slice(0, normalizeLimit(input.limit));
    },
    upsertTemporaryMemory(input) {
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
    },
    searchMemoryLayer(input = {}) {
      const limit = normalizeLimit(input.limit);
      const promotedInput: Parameters<typeof store.listMemories>[0] = {
        status: "promoted",
        limit
      };
      if (input.type !== undefined) promotedInput.type = input.type;
      if (input.query !== undefined) promotedInput.query = input.query;
      const promoted =
        input.status === "candidate"
          ? []
          : store.listMemories(promotedInput);
      const candidateInput: Parameters<typeof store.listMemoryCandidates>[0] = { limit };
      if (input.type !== undefined) candidateInput.type = input.type;
      if (input.query !== undefined) candidateInput.query = input.query;
      const candidates =
        input.status === "promoted"
          ? []
          : store.listMemoryCandidates(candidateInput);

      return [
        ...promoted.map<MemorySearchResult>((memory) => ({
          kind: "promoted",
          id: memory.id,
          type: memory.type,
          title: memory.title,
          summary: memory.summary,
          reason: memory.reason,
          confidence: memory.confidence,
          evidence: memory.evidence,
          relatedFiles: memory.relatedFiles
        })),
        ...candidates.map<MemorySearchResult>((candidate) => ({
          kind: "candidate",
          id: candidate.id,
          type: candidate.type,
          title: candidate.title,
          summary: candidate.summary,
          reason: candidate.reason,
          confidence: candidate.confidence,
          evidence: candidate.evidence,
          relatedFiles: candidate.relatedFiles
        }))
      ].slice(0, limit);
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
        syncSources
      };
      if (lastSyncAt !== undefined) summary.lastSyncAt = lastSyncAt;
      return summary;
    }
  };

  return store;
}

function runMigrations(db: DatabaseSync): void {
  db.exec(`
    create table if not exists sources (
      id text primary key,
      type text not null check (type in ('conversation', 'commit', 'decision')),
      title text not null,
      origin text not null,
      raw_content text not null,
      metadata_json text not null default '{}',
      created_at text not null
    );

    create table if not exists chunks (
      id text primary key,
      source_id text not null references sources(id) on delete cascade,
      chunk_index integer not null,
      text text not null,
      metadata_json text not null default '{}'
    );

    create virtual table if not exists chunks_fts using fts5(
      chunk_id unindexed,
      source_id unindexed,
      source_type unindexed,
      title,
      text
    );

    create table if not exists commits (
      hash text primary key,
      author_name text not null,
      author_email text not null,
      authored_at text not null,
      message text not null,
      changed_files_json text not null,
      diff_summary text not null
    );

    create table if not exists decisions (
      id text primary key,
      topic text not null,
      decision text not null,
      reason text not null,
      status text not null,
      evidence_json text not null,
      created_at text not null
    );

    create table if not exists relations (
      id text primary key,
      from_type text not null,
      from_id text not null,
      relation text not null,
      to_type text not null,
      to_id text not null,
      locator text
    );

    create table if not exists sync_sources (
      source text primary key check (source in ('git', 'codex', 'claude')),
      enabled integer not null,
      last_sync_at text,
      last_success_at text,
      last_error text,
      metadata_json text not null default '{}'
    );

    create table if not exists sync_cursors (
      source text not null check (source in ('git', 'codex', 'claude')),
      cursor_key text not null,
      cursor_value text not null,
      updated_at text not null,
      primary key (source, cursor_key)
    );

    create table if not exists memory_candidates (
      id text primary key,
      type text not null check (type in ('decision', 'bug_fix', 'constraint', 'rejected_approach')),
      title text not null,
      summary text not null,
      reason text not null,
      confidence real not null,
      evidence_json text not null,
      related_files_json text not null,
      dedupe_key text not null unique,
      promotion_state text not null check (promotion_state in ('candidate', 'promoted')),
      evidence_signature text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists memories (
      id text primary key,
      type text not null check (type in ('decision', 'bug_fix', 'constraint', 'rejected_approach')),
      title text not null,
      summary text not null,
      reason text not null,
      confidence real not null,
      evidence_json text not null,
      related_files_json text not null,
      dedupe_key text not null,
      evidence_signature text not null,
      source text not null check (source in ('auto', 'manual')),
      created_at text not null,
      promoted_at text not null,
      unique (dedupe_key, evidence_signature, source)
    );

    create table if not exists memory_links (
      id text primary key,
      owner_kind text not null check (owner_kind in ('candidate', 'memory')),
      owner_id text not null,
      target_type text not null,
      target_id text not null,
      locator text,
      metadata_json text not null default '{}'
    );

    create table if not exists temporary_memories (
      id text primary key,
      project_id text not null,
      thread_id text,
      session_id text,
      source_adapter text,
      kind text not null check (kind in (
        'task_state',
        'open_question',
        'working_hypothesis',
        'recent_test',
        'file_context',
        'user_instruction'
      )),
      title text not null,
      summary text not null,
      details text not null,
      related_files_json text not null,
      evidence_json text not null,
      confidence real not null,
      created_at text not null,
      updated_at text not null,
      expires_at text not null
    );

    create table if not exists temporary_memory_links (
      id text primary key,
      memory_id text not null references temporary_memories(id) on delete cascade,
      target_type text not null,
      target_id text not null,
      locator text,
      metadata_json text not null default '{}'
    );

    create virtual table if not exists temporary_memories_fts using fts5(
      memory_id unindexed,
      project_id unindexed,
      thread_id unindexed,
      session_id unindexed,
      kind unindexed,
      title,
      summary,
      details
    );
  `);
}

function upsertMemoryRow(
  db: DatabaseSync,
  input: {
    id?: string;
    type: MemoryType;
    title: string;
    summary: string;
    reason: string;
    confidence: number;
    evidence: EvidenceRef[];
    relatedFiles: string[];
    dedupeKey: string;
    source: DurableMemory["source"];
    createdAt: string;
  }
): DurableMemory {
  const evidenceSignature = normalizeEvidenceSignature(input.evidence);
  const existing = db
    .prepare(
      `select id, type, title, summary, reason, confidence, evidence_json, related_files_json,
              dedupe_key, source, created_at, promoted_at
       from memories
       where dedupe_key = ? and evidence_signature = ? and source = ?`
    )
    .get(input.dedupeKey, evidenceSignature, input.source) as MemoryRow | undefined;
  const id = input.id ?? existing?.id ?? `memory-${randomUUID()}`;
  const promotedAt = existing?.promoted_at ?? new Date().toISOString();
  db.prepare(
    `insert into memories
       (id, type, title, summary, reason, confidence, evidence_json, related_files_json,
        dedupe_key, evidence_signature, source, created_at, promoted_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(dedupe_key, evidence_signature, source) do update set
       title = excluded.title,
       summary = excluded.summary,
       reason = excluded.reason,
       confidence = excluded.confidence,
       evidence_json = excluded.evidence_json,
       related_files_json = excluded.related_files_json`
  ).run(
    id,
    input.type,
    input.title,
    input.summary,
    input.reason,
    input.confidence,
    JSON.stringify(input.evidence),
    JSON.stringify(input.relatedFiles),
    input.dedupeKey,
    evidenceSignature,
    input.source,
    input.createdAt,
    promotedAt
  );
  rebuildMemoryLinks(db, "memory", id, input.evidence, input.relatedFiles);
  const row = db
    .prepare(
      `select id, type, title, summary, reason, confidence, evidence_json, related_files_json,
              dedupe_key, source, created_at, promoted_at
       from memories
       where id = ?`
    )
    .get(id) as unknown as MemoryRow;
  return memoryFromRow(row);
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

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`select count(*) as count from ${table}`).get() as { count: number };
  return row.count;
}

function normalizeLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 10;
  return Math.max(1, Math.min(Math.floor(limit), 100));
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
    createdAt: row.created_at,
    promotedAt: row.promoted_at
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

function normalizeEvidenceSignature(evidence: EvidenceRef[]): string {
  return evidence
    .map((item) => `${item.sourceType}:${item.sourceId}:${item.locator ?? ""}`)
    .sort()
    .join("|");
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
