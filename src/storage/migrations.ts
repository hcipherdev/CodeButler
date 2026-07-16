import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryType } from "../types.js";
import { recordCompletedMigrationOperation } from "../operations/log.js";

export interface SchemaMigration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

export interface MigrationStatus {
  currentVersion: number;
  latestVersion: number;
  pendingVersions: number[];
  latestBackup?: string;
}

interface AppliedMigrationRow {
  version: number;
  name: string;
}

const BASE_SCHEMA = `
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
    chunk_id unindexed, source_id unindexed, source_type unindexed, title, text
  );
  create table if not exists commits (
    hash text primary key, author_name text not null, author_email text not null,
    authored_at text not null, message text not null, changed_files_json text not null,
    diff_summary text not null
  );
  create table if not exists decisions (
    id text primary key, topic text not null, decision text not null, reason text not null,
    status text not null, evidence_json text not null, created_at text not null
  );
  create table if not exists relations (
    id text primary key, from_type text not null, from_id text not null, relation text not null,
    to_type text not null, to_id text not null, locator text
  );
  create table if not exists sync_sources (
    source text primary key check (source in ('git', 'codex', 'claude')),
    enabled integer not null, last_sync_at text, last_success_at text, last_error text,
    metadata_json text not null default '{}'
  );
  create table if not exists sync_cursors (
    source text not null check (source in ('git', 'codex', 'claude')),
    cursor_key text not null, cursor_value text not null, updated_at text not null,
    primary key (source, cursor_key)
  );
  create table if not exists memory_candidates (
    id text primary key,
    type text not null check (type in ('decision', 'bug_fix', 'constraint', 'rejected_approach')),
    title text not null, summary text not null, reason text not null, confidence real not null,
    evidence_json text not null, related_files_json text not null, dedupe_key text not null unique,
    promotion_state text not null check (promotion_state in ('candidate', 'promoted')),
    promoted_memory_id text references memories(id),
    evidence_signature text not null,
    quality_status text not null default 'active' check (quality_status in ('active', 'needs_review', 'quarantined')),
    quality_reasons_json text not null default '[]', last_verified_at text,
    created_at text not null, updated_at text not null
  );
  create table if not exists memories (
    id text primary key,
    type text not null check (type in ('decision', 'bug_fix', 'constraint', 'rejected_approach')),
    title text not null, summary text not null, reason text not null, confidence real not null,
    evidence_json text not null, related_files_json text not null, dedupe_key text not null,
    evidence_signature text not null, source text not null check (source in ('auto', 'manual')),
    quality_status text not null default 'active' check (quality_status in ('active', 'needs_review', 'quarantined')),
    quality_reasons_json text not null default '[]', last_verified_at text,
    subject_key text not null,
    lifecycle_status text not null default 'current' check (lifecycle_status in ('current', 'superseded', 'retracted')),
    valid_from text not null, valid_until text, status_reason text, status_changed_at text not null,
    created_at text not null, promoted_at text not null,
    unique (dedupe_key, evidence_signature, source)
  );
  create table if not exists memory_links (
    id text primary key, owner_kind text not null check (owner_kind in ('candidate', 'memory')),
    owner_id text not null, target_type text not null, target_id text not null, locator text,
    metadata_json text not null default '{}'
  );
  create table if not exists temporary_memories (
    id text primary key, project_id text not null, thread_id text, session_id text, source_adapter text,
    kind text not null check (kind in ('task_state', 'open_question', 'working_hypothesis',
      'recent_test', 'file_context', 'user_instruction')),
    title text not null, summary text not null, details text not null,
    related_files_json text not null, evidence_json text not null, confidence real not null,
    created_at text not null, updated_at text not null, expires_at text not null
  );
  create table if not exists temporary_memory_links (
    id text primary key, memory_id text not null references temporary_memories(id) on delete cascade,
    target_type text not null, target_id text not null, locator text,
    metadata_json text not null default '{}'
  );
  create virtual table if not exists temporary_memories_fts using fts5(
    memory_id unindexed, project_id unindexed, thread_id unindexed, session_id unindexed,
    kind unindexed, title, summary, details
  );
  create table if not exists memory_relations (
    id text primary key,
    from_memory_id text not null references memories(id) on delete cascade,
    to_memory_id text not null references memories(id) on delete cascade,
    relation_type text not null check (relation_type in ('supersedes', 'potentially_contradicts')),
    created_at text not null, reason text,
    check (from_memory_id <> to_memory_id),
    unique (from_memory_id, to_memory_id, relation_type)
  );
  create index if not exists idx_memory_relations_from on memory_relations(from_memory_id, relation_type);
  create index if not exists idx_memory_relations_to on memory_relations(to_memory_id, relation_type);
  create index if not exists idx_memory_relations_type on memory_relations(relation_type, from_memory_id, to_memory_id);
`;

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    name: "create base memory schema",
    up(db) {
      db.exec(BASE_SCHEMA);
    }
  },
  {
    version: 2,
    name: "add memory quality metadata",
    up(db) {
      ensureColumn(db, "memory_candidates", "quality_status", "text not null default 'active'");
      ensureColumn(db, "memory_candidates", "quality_reasons_json", "text not null default '[]'");
      ensureColumn(db, "memory_candidates", "last_verified_at", "text");
      ensureColumn(db, "memories", "quality_status", "text not null default 'active'");
      ensureColumn(db, "memories", "quality_reasons_json", "text not null default '[]'");
      ensureColumn(db, "memories", "last_verified_at", "text");
    }
  },
  {
    version: 3,
    name: "add durable memory lifecycle schema",
    up(db) {
      ensureColumn(db, "memory_candidates", "promoted_memory_id", "text references memories(id)");
      ensureColumn(db, "memories", "subject_key", "text not null default ''");
      ensureColumn(db, "memories", "lifecycle_status", "text not null default 'current'");
      ensureColumn(db, "memories", "valid_from", "text not null default ''");
      ensureColumn(db, "memories", "valid_until", "text");
      ensureColumn(db, "memories", "status_reason", "text");
      ensureColumn(db, "memories", "status_changed_at", "text not null default ''");
      const memories = db.prepare("select id, type, title from memories where subject_key = ''").all() as Array<{
        id: string;
        type: MemoryType;
        title: string;
      }>;
      const updateSubject = db.prepare("update memories set subject_key = ? where id = ?");
      for (const memory of memories) {
        updateSubject.run(createV3MemorySubjectKey(memory.type, memory.title), memory.id);
      }
      db.exec(`
        update memories
        set lifecycle_status = case
              when lifecycle_status is null or lifecycle_status = '' then 'current'
              else lifecycle_status
            end,
            valid_from = case when valid_from = '' then created_at else valid_from end,
            status_changed_at = case when status_changed_at = '' then promoted_at else status_changed_at end;
        update memory_candidates
        set promoted_memory_id = (
          select memory.id
          from memories memory
          where memory.dedupe_key = memory_candidates.dedupe_key
            and memory.evidence_signature = memory_candidates.evidence_signature
          limit 1
        )
        where promotion_state = 'promoted'
          and promoted_memory_id is null
          and (
            select count(*)
            from memories memory
            where memory.dedupe_key = memory_candidates.dedupe_key
              and memory.evidence_signature = memory_candidates.evidence_signature
          ) = 1;
        create table if not exists memory_relations (
          id text primary key,
          from_memory_id text not null references memories(id) on delete cascade,
          to_memory_id text not null references memories(id) on delete cascade,
          relation_type text not null check (relation_type in ('supersedes', 'potentially_contradicts')),
          created_at text not null, reason text,
          check (from_memory_id <> to_memory_id),
          unique (from_memory_id, to_memory_id, relation_type)
        );
        create index if not exists idx_memories_lifecycle_status on memories(lifecycle_status);
        create index if not exists idx_memories_subject_key on memories(subject_key);
        create index if not exists idx_memory_relations_from on memory_relations(from_memory_id, relation_type);
        create index if not exists idx_memory_relations_to on memory_relations(to_memory_id, relation_type);
        create index if not exists idx_memory_relations_type on memory_relations(relation_type, from_memory_id, to_memory_id);
        create trigger if not exists validate_memories_lifecycle_status_insert
        before insert on memories when new.lifecycle_status not in ('current', 'superseded', 'retracted')
        begin select raise(abort, 'invalid memory lifecycle status'); end;
        create trigger if not exists validate_memories_lifecycle_status_update
        before update of lifecycle_status on memories when new.lifecycle_status not in ('current', 'superseded', 'retracted')
        begin select raise(abort, 'invalid memory lifecycle status'); end;
      `);
    }
  },
  {
    version: 4,
    name: "add embedding storage schema",
    up(db) {
      db.exec(`
        create table if not exists embedding_jobs (
          owner_kind text not null check (owner_kind in ('chunk', 'memory')),
          owner_id text not null,
          content_hash text not null,
          provider_key text not null,
          endpoint_hash text not null,
          model text not null,
          provider_fingerprint text,
          state text not null check (state in ('pending', 'complete', 'failed')),
          attempts integer not null default 0 check (attempts >= 0),
          last_error text,
          created_at text not null,
          updated_at text not null,
          completed_at text,
          check (
            (state = 'complete' and provider_fingerprint is not null and completed_at is not null)
            or (state <> 'complete' and provider_fingerprint is null and completed_at is null)
          ),
          unique (owner_kind, owner_id, content_hash, provider_key)
        );
        create table if not exists embedding_vectors (
          owner_kind text not null check (owner_kind in ('chunk', 'memory')),
          owner_id text not null,
          content_hash text not null,
          provider_key text not null,
          endpoint_hash text not null,
          model text not null,
          provider_fingerprint text not null,
          dimension integer not null check (dimension > 0),
          vector_blob blob not null,
          created_at text not null,
          updated_at text not null,
          unique (owner_kind, owner_id, content_hash, provider_fingerprint)
        );
        create index if not exists idx_embedding_jobs_owner
          on embedding_jobs(owner_kind, owner_id);
        create index if not exists idx_embedding_jobs_provider_state
          on embedding_jobs(provider_key, state, updated_at);
        create index if not exists idx_embedding_vectors_owner
          on embedding_vectors(owner_kind, owner_id);
        create index if not exists idx_embedding_vectors_provider
          on embedding_vectors(provider_fingerprint, owner_kind, owner_id);
      `);
    }
  },
  {
    version: 5,
    name: "add embedding owner generations",
    up(db) {
      ensureColumn(db, "embedding_jobs", "owner_version", "text not null default ''");
      ensureColumn(db, "embedding_vectors", "owner_version", "text not null default ''");
    }
  },
  {
    version: 6,
    name: "add collision-proof memory lifecycle generations",
    up(db) {
      ensureColumn(db, "memories", "lifecycle_generation", "text not null default ''");
      const memories = db.prepare(
        "select id from memories where lifecycle_generation = ''"
      ).all() as Array<{ id: string }>;
      const updateGeneration = db.prepare(
        "update memories set lifecycle_generation = ? where id = ? and lifecycle_generation = ''"
      );
      for (const memory of memories) updateGeneration.run(randomUUID(), memory.id);
    }
  },
  {
    version: 7,
    name: "add embedding index rebuild generations",
    up(db) {
      ensureColumn(db, "embedding_jobs", "index_generation", "text not null default ''");
      ensureColumn(db, "embedding_jobs", "target_fingerprint", "text");
    }
  },
  {
    version: 8,
    name: "add persistent source failures",
    up(db) {
      db.exec(`
        create table if not exists source_failures (
          id text primary key,
          adapter text not null check (adapter in ('git', 'codex', 'claude')),
          path text not null,
          error_code text not null,
          message text not null,
          first_occurred_at text not null,
          last_occurred_at text not null,
          attempts integer not null default 1 check (attempts > 0),
          resolved_at text,
          unique (adapter, path, error_code)
        );
        create index if not exists idx_source_failures_unresolved
          on source_failures(resolved_at, last_occurred_at desc);
        create index if not exists idx_source_failures_adapter
          on source_failures(adapter, resolved_at, last_occurred_at desc);
      `);
    }
  },
  {
    version: 9,
    name: "add privacy-safe operation log",
    up(db) {
      db.exec(`
        create table if not exists operation_log (
          id text primary key,
          operation_type text not null check (operation_type in (
            'migration', 'lifecycle_change', 'redaction', 'deletion', 'export', 'import',
            'retention_prune', 'recovery'
          )),
          status text not null check (status in ('started', 'completed', 'failed')),
          started_at text not null,
          completed_at text,
          actor text not null check (actor in ('cli', 'mcp', 'system')),
          metadata_json text not null default '{}',
          check (
            (status = 'started' and completed_at is null)
            or (status in ('completed', 'failed') and completed_at is not null)
          )
        );
        create table if not exists source_tombstones (
          source_type text not null check (source_type in ('conversation', 'commit', 'decision')),
          source_id_hash text not null check (
            length(source_id_hash) = 64 and source_id_hash not glob '*[^0-9a-f]*'
          ),
          deleted_at text not null,
          operation_id text not null references operation_log(id),
          primary key (source_type, source_id_hash)
        );
        create index if not exists idx_operation_log_type_started
          on operation_log(operation_type, started_at desc);
        create index if not exists idx_operation_log_status_started
          on operation_log(status, started_at desc);
        create index if not exists idx_source_tombstones_operation
          on source_tombstones(operation_id);
      `);
    }
  },
  {
    version: 10,
    name: "add stable private identity mappings",
    up(db) {
      db.exec(`
        create table if not exists private_identity_mappings (
          raw_hash text primary key check (
            length(raw_hash) = 64 and raw_hash not glob '*[^0-9a-f]*'
          ),
          stored_identity text not null,
          created_at text not null
        );
        create unique index if not exists idx_private_identity_stored
          on private_identity_mappings(stored_identity);
      `);
    }
  }
] as const;

export const CURRENT_SCHEMA_VERSION = SCHEMA_MIGRATIONS.at(-1)?.version ?? 0;

export function createV3MemorySubjectKey(type: MemoryType, title: string): string {
  const normalizedTitle = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `${type}:${normalizedTitle || "untitled"}`;
}

export function initializeSchema(
  db: DatabaseSync,
  databasePath: string,
  options: { migrations?: readonly SchemaMigration[]; backupRetention?: number } = {}
): void {
  const migrations = validateMigrations(options.migrations ?? SCHEMA_MIGRATIONS);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    create table if not exists schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    )
  `);

  db.exec("BEGIN IMMEDIATE");
  let backupPath: string | undefined;
  try {
    const applied = validateAppliedMigrations(readAppliedMigrations(db), migrations);
    const pending = migrations.filter((migration) => !applied.has(migration.version));
    if (pending.length === 0) {
      db.exec("COMMIT");
      return;
    }

    if (hasDataToProtect(db)) backupPath = createDatabaseBackup(databasePath);
    for (const migration of pending) {
      migration.up(db);
      const appliedAt = new Date().toISOString();
      db.prepare("insert into schema_migrations (version, name, applied_at) values (?, ?, ?)").run(
        migration.version,
        migration.name,
        appliedAt
      );
      if (migration.version >= 9 && tableExists(db, "operation_log")) {
        recordCompletedMigrationOperation(db, migration.version, appliedAt);
      }
    }
    db.exec("COMMIT");
    if (backupPath) pruneMigrationBackups(databasePath, options.backupRetention ?? 2);
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function getMigrationStatus(
  db: DatabaseSync,
  databasePath: string,
  migrations: readonly SchemaMigration[] = SCHEMA_MIGRATIONS
): MigrationStatus {
  const applied = tableExists(db, "schema_migrations")
    ? validateAppliedMigrations(readAppliedMigrations(db), migrations)
    : new Set<number>();
  const latestVersion = migrations.at(-1)?.version ?? 0;
  const status: MigrationStatus = {
    currentVersion: applied.size === 0 ? 0 : Math.max(...applied),
    latestVersion,
    pendingVersions: migrations.filter(({ version }) => !applied.has(version)).map(({ version }) => version)
  };
  const latestBackup = listMigrationBackups(databasePath).at(0);
  if (latestBackup) status.latestBackup = latestBackup;
  return status;
}

export function listMigrationBackups(databasePath: string): string[] {
  const directory = dirname(databasePath);
  const prefix = `${basename(databasePath)}.backup-`;
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".sqlite"))
    .map((name) => join(directory, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs || right.localeCompare(left));
}

function createDatabaseBackup(databasePath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${databasePath}.backup-${timestamp}-${randomUUID()}.sqlite`;
  const script = `
    const { backup, DatabaseSync } = require('node:sqlite');
    const source = new DatabaseSync(process.argv[1], { readOnly: true });
    backup(source, process.argv[2]).then(() => source.close());
  `;
  execFileSync(process.execPath, ["-e", script, databasePath, backupPath], { stdio: "ignore" });
  return backupPath;
}

function pruneMigrationBackups(databasePath: string, retention: number): void {
  for (const backupPath of listMigrationBackups(databasePath).slice(Math.max(0, retention))) {
    unlinkSync(backupPath);
  }
}

function hasDataToProtect(db: DatabaseSync): boolean {
  const row = db.prepare(
    `select count(*) as count from sqlite_master
     where type in ('table', 'view') and name not like 'sqlite_%' and name <> 'schema_migrations'`
  ).get() as { count: number };
  return row.count > 0;
}

function validateMigrations(migrations: readonly SchemaMigration[]): readonly SchemaMigration[] {
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (!migration || migration.version !== index + 1) {
      throw new Error("Schema migrations must have contiguous ordered versions starting at 1");
    }
  }
  return migrations;
}

function readAppliedMigrations(db: DatabaseSync): AppliedMigrationRow[] {
  return db.prepare("select version, name from schema_migrations order by version").all() as unknown as AppliedMigrationRow[];
}

function validateAppliedMigrations(
  applied: AppliedMigrationRow[],
  migrations: readonly SchemaMigration[]
): Set<number> {
  const latestVersion = migrations.at(-1)?.version ?? 0;
  const future = applied.find(({ version }) => version > latestVersion);
  if (future) {
    throw new Error(
      `Database uses newer schema version ${future.version}; this Code Butler supports up to ${latestVersion}`
    );
  }
  for (const [index, row] of applied.entries()) {
    const expected = migrations[index];
    if (!expected || row.version !== expected.version) {
      throw new Error("Applied schema migrations must be a contiguous prefix of known versions");
    }
    if (row.name !== expected.name) {
      throw new Error(`Schema migration ${row.version} has incompatible name ${JSON.stringify(row.name)}`);
    }
  }
  return new Set(applied.map(({ version }) => version));
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare("select name from sqlite_master where type = 'table' and name = ?").get(table) !== undefined;
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  if (!tableExists(db, table)) return;
  const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((row) => row.name === column)) return;
  db.exec(`alter table ${table} add column ${column} ${definition}`);
}
