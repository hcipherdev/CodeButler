import { createHash } from "node:crypto";

import type { MemoryStore } from "../storage/store.js";
import type { ExtractionConfig } from "../types.js";
import type { ExtractionJob } from "../storage/store.js";

/**
 * How far this device has extracted each conversation. Session logs only grow, and
 * chunk ids are message positions, so the messages below the cursor are unchanged and
 * need no second model call. The cursor is device-local like the job queue.
 */
export interface ExtractionCursor {
  extractedChunks: number;
  /** When the cursor last moved; absent when it was never written. */
  updatedAt?: string | undefined;
}

interface CursorRow {
  extracted_chunks: number;
  last_chunk_hash: string;
  updated_at: string;
}

export function chunkTextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The cursor for one conversation, checked against its stored messages. A cursor past
 * the end, or one whose last message no longer matches, means the log was rewritten,
 * so extraction starts over. A missing cursor is seeded from the extraction run log.
 */
export function readExtractionCursor(store: MemoryStore, sourceId: string): ExtractionCursor {
  const total = chunkCount(store, sourceId);
  const row = store.localDb.prepare(
    "select extracted_chunks, last_chunk_hash, updated_at from conversation_extraction_cursors where source_id = ?"
  ).get(sourceId) as CursorRow | undefined;
  if (!row) return { extractedChunks: Math.min(seedFromRunLog(store, sourceId), total) };
  if (row.extracted_chunks <= 0) return { extractedChunks: 0, updatedAt: row.updated_at };
  if (row.extracted_chunks > total || chunkHashAt(store, sourceId, row.extracted_chunks - 1) !== row.last_chunk_hash) {
    return { extractedChunks: 0 };
  }
  return { extractedChunks: row.extracted_chunks, updatedAt: row.updated_at };
}

/** Records that messages below `extractedChunks` have been extracted. */
export function advanceExtractionCursor(store: MemoryStore, sourceId: string, extractedChunks: number, now = new Date().toISOString()): void {
  const hash = extractedChunks > 0 ? chunkHashAt(store, sourceId, extractedChunks - 1) : "";
  if (hash === undefined) return;
  store.localDb.prepare(
    `insert into conversation_extraction_cursors (source_id, extracted_chunks, last_chunk_hash, updated_at)
     values (?, ?, ?, ?)
     on conflict(source_id) do update set
       extracted_chunks = excluded.extracted_chunks,
       last_chunk_hash = excluded.last_chunk_hash,
       updated_at = excluded.updated_at`
  ).run(sourceId, extractedChunks, hash, now);
}

/**
 * Called before a conversation's messages are replaced by a newer copy of its log. A
 * source with no pending job was fully extracted at its previous length, so that length
 * becomes its cursor; the hash is of the message that is about to stay in place.
 */
export function seedExtractionCursorBeforeReimport(store: MemoryStore, sourceId: string, now = new Date().toISOString()): void {
  if (store.localDb.prepare("select 1 from conversation_extraction_cursors where source_id = ?").get(sourceId)) return;
  if (store.db.prepare("select 1 from extraction_jobs where source_type = 'conversation' and source_id = ?").get(sourceId)) return;
  const total = chunkCount(store, sourceId);
  // Without proof that extraction ever ran here (say the extractor was configured later),
  // the history stays unextracted rather than being skipped.
  if (total === 0 || !wasExtracted(store, sourceId)) return;
  advanceExtractionCursor(store, sourceId, total, now);
}

/**
 * Rewinds cursors so the next extraction of these conversations reads them in full. A
 * zero row rather than no row, so the run-log seed cannot fast-forward it again.
 */
export function resetExtractionCursors(store: MemoryStore, sourceIds: readonly string[], now = new Date().toISOString()): void {
  for (const sourceId of sourceIds) advanceExtractionCursor(store, sourceId, 0, now);
}

/** Drops the cursors of deleted conversations. */
export function forgetExtractionCursors(store: MemoryStore, sourceIds: readonly string[]): void {
  const remove = store.localDb.prepare("delete from conversation_extraction_cursors where source_id = ?");
  for (const sourceId of sourceIds) remove.run(sourceId);
}

export interface ExtractionReadiness {
  /** Waits for a quiet log, a long wait, or a large backlog; off for explicit syncs. */
  honorQuietWindow: boolean;
  now?: Date | undefined;
}

/**
 * Whether a conversation job should be extracted now. An active session keeps
 * re-queueing itself, so the watcher waits until it has been quiet for a while,
 * unless it has waited long enough or has many new messages.
 */
export function readyForExtraction(
  store: MemoryStore,
  job: ExtractionJob,
  policy: ExtractionConfig,
  readiness: ExtractionReadiness
): boolean {
  if (job.sourceType !== "conversation" || !readiness.honorQuietWindow) return true;
  const now = (readiness.now ?? new Date()).getTime();
  const minutesSince = (value: string | undefined) => {
    const at = Date.parse(value ?? "");
    return Number.isFinite(at) ? (now - at) / 60_000 : undefined;
  };
  if ((minutesSince(job.enqueuedAt) ?? Infinity) >= policy.conversationQuietMinutes) return true;
  const cursor = readExtractionCursor(store, job.sourceId);
  const waited = minutesSince(cursor.updatedAt);
  if (waited !== undefined && waited >= policy.conversationMaxWaitMinutes) return true;
  return chunkCount(store, job.sourceId) - cursor.extractedChunks >= policy.maxDeltaChunks;
}

export function chunkCount(store: MemoryStore, sourceId: string): number {
  return (store.db.prepare("select count(*) as count from chunks where source_id = ?").get(sourceId) as { count: number }).count;
}

function chunkHashAt(store: MemoryStore, sourceId: string, chunkIndex: number): string | undefined {
  const row = store.db.prepare("select text from chunks where source_id = ? and chunk_index = ?")
    .get(sourceId, chunkIndex) as { text: string } | undefined;
  return row ? chunkTextHash(row.text) : undefined;
}

/**
 * For conversations queued before cursors existed: the leading messages older than the
 * last successful extraction run that covered the source were already extracted.
 */
function seedFromRunLog(store: MemoryStore, sourceId: string): number {
  const ranAt = Date.parse(lastSuccessfulRun(store, sourceId) ?? "");
  if (!Number.isFinite(ranAt)) return 0;
  const rows = store.db.prepare("select metadata_json from chunks where source_id = ? order by chunk_index")
    .all(sourceId) as Array<{ metadata_json: string }>;
  let covered = 0;
  for (const row of rows) {
    let timestamp: unknown;
    try { timestamp = (JSON.parse(row.metadata_json) as { timestamp?: unknown }).timestamp; } catch { timestamp = undefined; }
    const at = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
    if (!Number.isFinite(at) || at > ranAt) break;
    covered += 1;
  }
  return covered;
}

function lastSuccessfulRun(store: MemoryStore, sourceId: string): string | undefined {
  try {
    const row = store.localDb.prepare(
      `select started_at from extraction_runs
        where error is null and source_ids_json like ? escape '\\'
        order by started_at desc limit 1`
    ).get(`%${JSON.stringify(sourceId).replace(/[\\%_]/g, (match) => `\\${match}`)}%`) as { started_at: string } | undefined;
    return row?.started_at;
  } catch {
    return undefined;
  }
}

function wasExtracted(store: MemoryStore, sourceId: string): boolean {
  if (lastSuccessfulRun(store, sourceId) !== undefined) return true;
  return store.db.prepare("select 1 from memory_links where target_type = 'conversation' and target_id = ? limit 1").get(sourceId) !== undefined;
}
