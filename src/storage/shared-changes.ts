import type { DatabaseSync } from "node:sqlite";

/**
 * Per-device bookkeeping: stripped from every snapshot, left out of its fingerprint and
 * carried across a restore, never synced. `cloud_change_counter` is one of them, so counting
 * shared writes is itself never a shared write.
 */
export const LOCAL_TABLES = ["sync_sources", "sync_cursors", "extraction_jobs", "extraction_status", "branch_triage_reviews", "promotion_decisions", "layer_retention_decisions", "peer_partitions", "cloud_change_counter"];
/** Every table a snapshot's fingerprint ignores: the local ones plus logs and derived journals. */
export const NON_SNAPSHOT_TABLES = [...LOCAL_TABLES, "operation_log", "schema_migrations", "retrieval_identity", "retrieval_changes"];

const TRIGGER_PREFIX = "cloud_change_";
const OPERATIONS = ["insert", "update", "delete"] as const;

/**
 * Counts writes to tables a snapshot carries, so "has this project changed since its last
 * sync?" ignores bookkeeping such as each watcher pass's last-synced time. Runs on every store
 * init: tables added by later migrations, and a database rebuilt from a snapshot, get their
 * triggers and counter row back. Idempotent and cheap when nothing is missing.
 */
export function ensureSharedChangeTriggers(db: DatabaseSync): void {
  if (!db.prepare("select 1 from sqlite_master where type = 'table' and name = 'cloud_change_counter'").get()) return;
  // A snapshot arrives with local rows stripped; without the row every trigger would count nothing.
  db.exec("insert or ignore into cloud_change_counter (id, shared_writes) values (1, 0)");
  const existing = new Set((db.prepare("select name from sqlite_master where type = 'trigger' and name like 'cloud\\_change\\_%' escape '\\'").all() as Array<{ name: string }>).map(row => row.name));
  const tables = (db.prepare("pragma table_list").all() as Array<{ name: string; type: string; schema: string }>)
    .filter(table => table.schema === "main" && table.type === "table" && !table.name.startsWith("sqlite_") && !NON_SNAPSHOT_TABLES.includes(table.name))
    .map(table => table.name);
  for (const table of tables) {
    for (const operation of OPERATIONS) {
      const name = `${TRIGGER_PREFIX}${table}_${operation}`;
      if (existing.has(name)) continue;
      db.exec(`create trigger if not exists "${name}" after ${operation} on "${table}" begin
        update cloud_change_counter set shared_writes = shared_writes + 1 where id = 1; end;`);
    }
  }
}

/**
 * The shared-write count and schema version of a project database, read without the store
 * (no lock, no migration). Undefined when the database predates the counter or cannot be read,
 * so callers fall back to coarser signals.
 */
export function readSharedChangeSignal(db: DatabaseSync): string | undefined {
  try {
    const row = db.prepare("select (select shared_writes from cloud_change_counter where id = 1) as writes, (select max(version) from schema_migrations) as version").get() as { writes: number | null; version: number | null } | undefined;
    if (row?.writes === null || row?.writes === undefined) return undefined;
    return `shared:${row.writes}:${row.version ?? 0}`;
  } catch { return undefined; }
}
