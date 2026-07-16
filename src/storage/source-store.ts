import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { findSourceTombstone } from "../operations/log.js";
import type { MemoryChunk, MemorySource, SourceType } from "../types.js";
import type { AddSourceInput } from "./store.js";
import type { StorageContentPolicy } from "./content-policy.js";
import { withTransaction } from "./transactions.js";

interface SourceRow {
  id: string;
  type: SourceType;
  title: string;
  origin: string;
  raw_content: string;
  metadata_json: string;
}

interface ChunkRow {
  id: string;
  source_id: string;
  chunk_index: number;
  text: string;
  metadata_json: string;
}

export function shouldSuppressSourceWrite(
  db: DatabaseSync,
  sourceType: SourceType,
  sourceId: string | undefined,
  canonicalize: (sourceId: string) => string
): boolean {
  return sourceId !== undefined &&
    findSourceTombstone(db, sourceType, canonicalize(sourceId)) !== undefined;
}

export function addSourceWithChunks(
  db: DatabaseSync,
  contentPolicy: StorageContentPolicy,
  input: AddSourceInput
): string {
  return withTransaction(db, () => {
    if (shouldSuppressSourceWrite(
      db,
      input.source.type,
      input.source.id,
      contentPolicy.identifier
    )) {
      return contentPolicy.identifier(input.source.id!);
    }
    const source = sanitizeSource(contentPolicy, input.source);
    const chunks = input.chunks.map((chunk) => ({
      text: contentPolicy.text(chunk.text),
      metadata: contentPolicy.json(chunk.metadata ?? {})
    }));
    const sourceId = source.id ?? `${source.type}-${randomUUID()}`;
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
      source.type,
      source.title,
      source.origin,
      source.rawContent,
      JSON.stringify(source.metadata ?? {}),
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
    for (const [index, chunk] of chunks.entries()) {
      const chunkId = `${sourceId}:chunk:${index}`;
      insertChunk.run(chunkId, sourceId, index, chunk.text, JSON.stringify(chunk.metadata ?? {}));
      insertFts.run(chunkId, sourceId, source.type, source.title, chunk.text);
    }
    rebuildSourceRelations(db, sourceId, source, chunks);
    return sourceId;
  });
}

export function readSource(
  db: DatabaseSync,
  contentPolicy: StorageContentPolicy,
  sourceId: string
): MemorySource | undefined {
  const row = db.prepare(
    "select id, type, title, origin, raw_content, metadata_json from sources where id = ?"
  ).get(contentPolicy.identifier(sourceId)) as SourceRow | undefined;
  return row ? {
    id: row.id,
    type: row.type,
    title: row.title,
    origin: row.origin,
    rawContent: row.raw_content,
    metadata: parseJsonObject(row.metadata_json)
  } : undefined;
}

export function readChunkWindow(
  db: DatabaseSync,
  contentPolicy: StorageContentPolicy,
  sourceId: string,
  chunkIndex: number,
  before: number,
  after: number
): MemoryChunk[] {
  const canonicalSourceId = contentPolicy.identifier(sourceId);
  const start = Math.max(0, chunkIndex - Math.max(0, before));
  const end = chunkIndex + Math.max(0, after);
  const rows = db.prepare(
    `select id, source_id, chunk_index, text, metadata_json
     from chunks
     where source_id = ? and chunk_index between ? and ?
     order by chunk_index asc`
  ).all(canonicalSourceId, start, end) as unknown as ChunkRow[];
  return rows.map(chunkFromRow);
}

export function readConversationWindow(
  db: DatabaseSync,
  contentPolicy: StorageContentPolicy,
  sourceId: string,
  anchorChunkId: string,
  before: number,
  after: number
): MemoryChunk[] {
  const canonicalSourceId = contentPolicy.identifier(sourceId);
  const canonicalChunkId = contentPolicy.locator(anchorChunkId);
  const anchor = db.prepare(
    `select chunk_index from chunks where id = ? and source_id = ?`
  ).get(canonicalChunkId, canonicalSourceId) as { chunk_index: number } | undefined;
  return anchor
    ? readChunkWindow(db, contentPolicy, canonicalSourceId, anchor.chunk_index, before, after)
    : [];
}

export function findSourcesMentioningFile(
  db: DatabaseSync,
  contentPolicy: StorageContentPolicy,
  filePath: string,
  limit?: number
): MemorySource[] {
  const rows = db.prepare(
    `select distinct s.id, s.type, s.title, s.origin, s.raw_content, s.metadata_json
     from relations r
     join sources s on s.id = r.from_id
     where r.from_type = 'source' and r.relation = 'mentions' and r.to_type = 'file' and r.to_id = ?
     order by s.created_at desc, s.id asc
     limit ?`
  ).all(contentPolicy.path(filePath), normalizeLimit(limit)) as unknown as SourceRow[];
  return rows.map(sourceFromRow);
}

function sanitizeSource(policy: StorageContentPolicy, source: MemorySource): MemorySource {
  return {
    ...(source.id === undefined ? {} : { id: policy.identifier(source.id) }),
    type: source.type,
    title: policy.text(source.title),
    origin: policy.text(source.origin),
    rawContent: policy.text(source.rawContent),
    metadata: policy.json(source.metadata ?? {})
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

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
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

function detectMentionedFiles(text: string, metadata?: Record<string, unknown>): string[] {
  const mentioned = new Set<string>();
  const metadataFilePath = typeof metadata?.filePath === "string" ? metadata.filePath : undefined;
  if (metadataFilePath) mentioned.add(normalizeDetectedFilePath(metadataFilePath));
  const metadataChangedFiles = Array.isArray(metadata?.changedFiles)
    ? metadata.changedFiles.filter((item): item is string => typeof item === "string")
    : [];
  for (const filePath of metadataChangedFiles) mentioned.add(normalizeDetectedFilePath(filePath));
  for (const match of text.match(/(?:[\w.-]+\/)+[\w.-]+/g) ?? []) {
    mentioned.add(normalizeDetectedFilePath(match));
  }
  return [...mentioned].filter((filePath) => filePath.length > 0);
}

function normalizeDetectedFilePath(filePath: string): string {
  return filePath.replace(/^[("'`]+/, "").replace(/[.,;:!?)"'`]+$/, "");
}

function normalizeLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 10;
  return Math.max(1, Math.min(Math.floor(limit), 100));
}
