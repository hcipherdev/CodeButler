import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { MemoryQualityStatus } from "../types.js";

export const LOCAL_MEMORY_SCHEMA_VERSION = 3;

export interface LocalMemoryQualityRow {
  category: "candidate" | "promoted";
  memoryId: string;
  memoryVersion: string;
  assessmentFingerprint: string;
  policyVersion: number;
  qualityStatus: MemoryQualityStatus;
  qualityReasons: string[];
  lastVerifiedAt?: string | undefined;
  assessedAt: string;
}

export function openLocalMemoryDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  initializeLocalMemorySchema(db);
  return db;
}

export function initializeLocalMemorySchema(db: DatabaseSync): void {
  db.exec(`
    create table if not exists memory_wording_runs(id text primary key,data_json text not null,updated_at text not null);
    create table if not exists extraction_runs (
      id text primary key,
      started_at text not null,
      finished_at text not null,
      channel text not null,
      provider text,
      model text,
      source_ids_json text not null,
      returned integer not null,
      candidates integer not null,
      promoted integer not null,
      rejections_json text not null default '{}',
      error text
    );
    create index if not exists idx_extraction_runs_started on extraction_runs(started_at);
    create table if not exists local_schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );
    create table if not exists memory_quality_cache (
      category text not null check (category in ('candidate', 'promoted')),
      memory_id text not null,
      memory_version text not null,
      assessment_fingerprint text not null,
      policy_version integer not null,
      quality_status text not null check (quality_status in ('active', 'needs_review', 'quarantined')),
      quality_reasons_json text not null default '[]',
      last_verified_at text,
      assessed_at text not null,
      primary key (category, memory_id)
    );
    create index if not exists idx_memory_quality_cache_status
      on memory_quality_cache(quality_status, category, memory_id);
    create table if not exists memory_reconciliation_runs (
      id text primary key,
      queue text not null check (queue in ('actionable', 'legacy', 'all')),
      status text not null check (status in ('planning', 'planned', 'partial', 'applied', 'reverted', 'failed')),
      policy_version text not null,
      provider text,
      model text,
      item_limit integer,
      max_requests integer not null,
      token_budget integer not null,
      concurrency integer not null,
      request_count integer not null default 0,
      token_count integer not null default 0,
      created_at text not null,
      updated_at text not null,
      completed_at text,
      error text,
      offline_override integer not null default 0 check (offline_override in (0, 1)),
      parent_run_id text,
      shared_backup_path text,
      local_backup_path text,
      warning text
    );
    create table if not exists memory_reconciliation_items (
      run_id text not null references memory_reconciliation_runs(id) on delete cascade,
      item_id text not null,
      category text not null check (category in ('candidate', 'promoted')),
      memory_id text not null,
      memory_version text not null,
      review_token text not null,
      proposal_version integer not null default 1,
      state text not null check (state in (
        'pending', 'planned', 'uncertain', 'failed', 'awaiting_correction_approval',
        'applied', 'stale', 'skipped', 'reverted', 'revert_blocked'
      )),
      verdict text check (verdict is null or verdict in ('current', 'changed', 'obsolete', 'low_value', 'uncertain')),
      confidence real,
      rationale text,
      citation_ids_json text not null default '[]',
      cited_observation_hashes_json text not null default '{}',
      all_observation_hashes_json text not null default '{}',
      correction_json text,
      input_hash text,
      deterministic integer not null default 0 check (deterministic in (0, 1)),
      request_tokens integer not null default 0,
      resolution_id text,
      replacement_memory_id text,
      apply_fingerprint text,
      applied_at text,
      reverted_at text,
      error text,
      created_at text not null,
      updated_at text not null,
      primary key (run_id, item_id)
    );
    create index if not exists idx_memory_reconciliation_items_memory
      on memory_reconciliation_items(memory_id, category, created_at desc);
    create index if not exists idx_memory_reconciliation_items_state
      on memory_reconciliation_items(run_id, state, item_id);
    create table if not exists memory_evidence_observations (
      hash text primary key,
      kind text not null,
      citation_id text not null,
      label text not null,
      content text not null,
      metadata_json text not null default '{}',
      created_at text not null
    );
  `);
  const row = db.prepare("select max(version) as version from local_schema_migrations").get() as { version: number | null };
  if ((row.version ?? 0) > LOCAL_MEMORY_SCHEMA_VERSION) {
    throw new Error(`Device-local memory database uses newer schema version ${row.version}`);
  }
  if ((row.version ?? 0) < LOCAL_MEMORY_SCHEMA_VERSION) {
    if ((row.version ?? 0) < 2) {
      ensureLocalColumn(db, "memory_reconciliation_runs", "parent_run_id", "text");
      ensureLocalColumn(db, "memory_reconciliation_runs", "shared_backup_path", "text");
      ensureLocalColumn(db, "memory_reconciliation_runs", "local_backup_path", "text");
      ensureLocalColumn(db, "memory_reconciliation_runs", "warning", "text");
    }
    db.prepare("insert into local_schema_migrations(version, name, applied_at) values (?, ?, ?)")
      .run(LOCAL_MEMORY_SCHEMA_VERSION, "add local wording proposal runs", new Date().toISOString());
  }
}

export function readLocalMemoryQuality(
  db: DatabaseSync,
  category: LocalMemoryQualityRow["category"],
  memoryId: string
): LocalMemoryQualityRow | undefined {
  const row = db.prepare(
    `select category, memory_id, memory_version, assessment_fingerprint, policy_version,
            quality_status, quality_reasons_json, last_verified_at, assessed_at
       from memory_quality_cache where category = ? and memory_id = ?`
  ).get(category, memoryId) as {
    category: LocalMemoryQualityRow["category"];
    memory_id: string;
    memory_version: string;
    assessment_fingerprint: string;
    policy_version: number;
    quality_status: MemoryQualityStatus;
    quality_reasons_json: string;
    last_verified_at: string | null;
    assessed_at: string;
  } | undefined;
  if (!row) return undefined;
  return {
    category: row.category,
    memoryId: row.memory_id,
    memoryVersion: row.memory_version,
    assessmentFingerprint: row.assessment_fingerprint,
    policyVersion: row.policy_version,
    qualityStatus: row.quality_status,
    qualityReasons: parseStringArray(row.quality_reasons_json),
    lastVerifiedAt: row.last_verified_at ?? undefined,
    assessedAt: row.assessed_at
  };
}

export function writeLocalMemoryQuality(db: DatabaseSync, row: LocalMemoryQualityRow): void {
  db.prepare(
    `insert into memory_quality_cache
       (category, memory_id, memory_version, assessment_fingerprint, policy_version,
        quality_status, quality_reasons_json, last_verified_at, assessed_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(category, memory_id) do update set
       memory_version = excluded.memory_version,
       assessment_fingerprint = excluded.assessment_fingerprint,
       policy_version = excluded.policy_version,
       quality_status = excluded.quality_status,
       quality_reasons_json = excluded.quality_reasons_json,
       last_verified_at = excluded.last_verified_at,
       assessed_at = excluded.assessed_at`
  ).run(
    row.category,
    row.memoryId,
    row.memoryVersion,
    row.assessmentFingerprint,
    row.policyVersion,
    row.qualityStatus,
    JSON.stringify([...new Set(row.qualityReasons)].sort()),
    row.lastVerifiedAt ?? null,
    row.assessedAt
  );
}

/** Preserve v19's last-known labels only as stale input; the v20 resolver re-assesses them. */
export function seedLegacyMemoryQuality(main: DatabaseSync, local: DatabaseSync): void {
  for (const [table, category, preferredVersionColumn, fallbackVersionColumn] of [
    ["memory_candidates", "candidate", "updated_at", "created_at"],
    ["memories", "promoted", "lifecycle_generation", "promoted_at"]
  ] as const) {
    if (!hasColumn(main, table, "quality_status")) continue;
    const versionColumn = hasColumn(main, table, preferredVersionColumn)
      ? preferredVersionColumn
      : fallbackVersionColumn;
    const rows = main.prepare(
      `select id, ${versionColumn} as memory_version, quality_status, quality_reasons_json, last_verified_at
         from ${table}`
    ).all() as Array<{
      id: string;
      memory_version: string;
      quality_status: MemoryQualityStatus;
      quality_reasons_json: string;
      last_verified_at: string | null;
    }>;
    const insert = local.prepare(
      `insert into memory_quality_cache
         (category, memory_id, memory_version, assessment_fingerprint, policy_version,
          quality_status, quality_reasons_json, last_verified_at, assessed_at)
       values (?, ?, ?, '', 0, ?, ?, ?, ?)
       on conflict(category, memory_id) do nothing`
    );
    const now = new Date().toISOString();
    for (const row of rows) {
      insert.run(
        category,
        row.id,
        row.memory_version,
        row.quality_status,
        JSON.stringify(parseStringArray(row.quality_reasons_json)),
        row.last_verified_at,
        now
      );
    }
  }
}

export function invalidateLocalMemoryQuality(db: DatabaseSync): void {
  db.prepare("update memory_quality_cache set assessment_fingerprint = '', policy_version = 0").run();
}

export function pruneLocalMemoryQuality(main: DatabaseSync, local: DatabaseSync): number {
  const rows = local.prepare("select category, memory_id from memory_quality_cache").all() as Array<{
    category: "candidate" | "promoted";
    memory_id: string;
  }>;
  const remove = local.prepare("delete from memory_quality_cache where category = ? and memory_id = ?");
  let removed = 0;
  for (const row of rows) {
    const table = row.category === "candidate" ? "memory_candidates" : "memories";
    if (main.prepare(`select 1 from ${table} where id = ?`).get(row.memory_id)) continue;
    removed += Number(remove.run(row.category, row.memory_id).changes);
  }
  return removed;
}

export function localContentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  try {
    return (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
  } catch {
    return false;
  }
}

function ensureLocalColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  if (!hasColumn(db, table, column)) db.exec(`alter table ${table} add column ${column} ${definition}`);
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
