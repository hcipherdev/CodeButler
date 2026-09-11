import type { DatabaseSync } from "node:sqlite";

import { normalizeMemorySummary, type ComparableMemoryFact } from "../memory/conflicts.js";
import { parseScope } from "../memory/scope.js";
import type { EvidenceRef, MemoryType } from "../types.js";

/**
 * A row-level three-way merge of the shared `core` database.
 *
 * Comparing two databases only tells you they differ, which is why resolving a conflict
 * has meant discarding one side. The common ancestor — the revision both devices last
 * agreed on — turns "different" into "who changed what", so disjoint edits both survive
 * and only genuinely competing edits need a human.
 *
 * The ancestor is also what makes deletion safe. A union of both sides would resurrect
 * rows a device deliberately removed, undoing a privacy deletion; present-in-ancestor
 * and absent-on-one-side is a delete, and deletes win.
 */
export type MergeAction = "take_remote" | "keep_local" | "insert_remote" | "delete_local" | "flag_conflict";

export interface MergeRowDecision {
  table: string;
  key: string;
  action: MergeAction;
  /** Set for `flag_conflict`: why the two edits could not be reconciled. */
  reason?: string | undefined;
}

export interface MergeCoreResult {
  /** Rows adopted from the other device, either new or updated. */
  adopted: number;
  /** Rows the other device recorded under a different id for a fact already held here. */
  converged: number;
  /** Rows kept as they are here, because only this device changed them. */
  retained: number;
  /** Rows the other device deleted, removed here too. */
  deleted: number;
  /** Rows both devices changed in ways that cannot be reconciled automatically. */
  flagged: number;
  /** Memory ids marked `needs_review` for an explicit decision. */
  reviewMemoryIds: string[];
  decisions: MergeRowDecision[];
  complete: true;
}

/**
 * Tables merged by primary key, parents before children so an inserted row's
 * references already exist. FTS tables are derived and rebuilt afterwards; embedding
 * rows are device- and provider-specific and are reconciled rather than merged; the
 * operation log is each device's own history and is unioned.
 */
const MERGE_TABLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["sources", ["id"]],
  ["chunks", ["id"]],
  ["commits", ["hash"]],
  ["decisions", ["id"]],
  ["memories", ["id"]],
  ["memory_candidates", ["id"]],
  ["memory_links", ["id"]],
  ["memory_relations", ["id"]],
  ["relations", ["id"]],
  ["temporary_memories", ["id"]],
  ["temporary_memory_links", ["id"]]
];
/**
 * Secondary uniqueness keys. Two devices that independently record the same fact derive
 * the same dedupe key under different row ids, so adopting the remote row would collide
 * here rather than on the primary key — the single most likely thing to happen in a real
 * merge. Matching on the natural key lets the two identities converge instead.
 */
const NATURAL_KEYS: Readonly<Record<string, readonly string[]>> = {
  memories: ["dedupe_key", "evidence_signature", "source", "scope_key", "layer"],
  memory_candidates: ["dedupe_key", "scope_key", "layer"],
  temporary_memories: ["base_id", "scope_key", "layer"],
  memory_relations: ["from_memory_id", "to_memory_id", "relation_type"]
};
const MEMORY_TABLES = new Set(["memories", "memory_candidates"]);
/** Only shared rows are merged; a local layer belongs to its own device. */
const LAYERED_TABLES = new Set(["memories", "memory_candidates", "temporary_memories"]);
const CONFLICT_QUALITY_REASON = "cloud_merge_conflict";

type Row = Record<string, unknown>;

export function mergeCore(
  local: DatabaseSync,
  remote: DatabaseSync,
  ancestor: DatabaseSync
): MergeCoreResult {
  const result: MergeCoreResult = {
    adopted: 0,
    converged: 0,
    retained: 0,
    deleted: 0,
    flagged: 0,
    reviewMemoryIds: [],
    decisions: [],
    complete: true
  };

  interface PlannedRow {
    table: string;
    key: readonly string[];
    columns: readonly string[];
    id: string;
    action: MergeAction;
    row?: Row | undefined;
    localId?: string | undefined;
  }
  const planned: PlannedRow[] = [];

  for (const [table, key] of MERGE_TABLES) {
    const columns = tableColumns(local, table);
    if (columns.length === 0) continue;
    const localRows = readRows(local, table, key, columns);
    const remoteRows = readRows(remote, table, key, columns);
    const ancestorRows = readRows(ancestor, table, key, columns);
    const keys = [...new Set([...localRows.keys(), ...remoteRows.keys(), ...ancestorRows.keys()])].sort();

    for (const id of keys) {
      const here = localRows.get(id);
      const there = remoteRows.get(id);
      const base = ancestorRows.get(id);
      const decision = decideRow(table, here, there, base);
      if (decision === "unchanged") continue;
      result.decisions.push({ table, key: id, action: decision.action, reason: decision.reason });
      planned.push({
        table,
        key,
        columns,
        id,
        action: decision.action,
        ...(there === undefined ? {} : { row: there }),
        ...(here === undefined ? {} : { localId: String(here.id ?? id) })
      });
    }
  }

  /*
   * Order matters in two opposite directions, so the plan is applied in two passes.
   * Deletions go child-first: removing a memory while a candidate still points at it
   * fails the foreign key. Insertions go parent-first, so an adopted row's references
   * already exist. Deciding everything before writing anything also means the decisions
   * are taken against one consistent view of all three databases.
   */
  const order = new Map(MERGE_TABLES.map(([table], index) => [table, index]));
  const byTable = (left: PlannedRow, right: PlannedRow): number =>
    (order.get(left.table) ?? 0) - (order.get(right.table) ?? 0);

  for (const item of [...planned].sort((left, right) => byTable(right, left))) {
    if (item.action !== "delete_local") continue;
    deleteRow(local, item.table, item.key, item.id);
    result.deleted += 1;
  }
  for (const item of [...planned].sort(byTable)) {
    if (item.action === "insert_remote" || item.action === "take_remote") {
      // Guaranteed by decideRow: neither action is reachable without a remote row.
      if (item.row === undefined) throw new Error("Cloud merge cannot adopt a missing row");
      if (heldUnderAnotherId(local, item.table, item.key, item.row)) {
        result.decisions.push({ table: item.table, key: item.id, action: "keep_local", reason: "converged_existing_identity" });
        result.converged += 1;
        continue;
      }
      writeRow(local, item.table, item.key, item.columns, item.row);
      result.adopted += 1;
    } else if (item.action === "flag_conflict") {
      result.flagged += 1;
      if (MEMORY_TABLES.has(item.table) && item.localId !== undefined) result.reviewMemoryIds.push(item.localId);
    } else if (item.action === "keep_local") {
      result.retained += 1;
    }
  }

  // Each device's operation log is its own history; neither supersedes the other.
  unionOperationLog(local, remote);
  return result;
}

/** Marks both sides of an unreconcilable edit for an explicit decision. */
export function flagMergeConflicts(local: DatabaseSync, memoryIds: readonly string[], now: string): number {
  let flagged = 0;
  for (const table of ["memories", "memory_candidates"]) {
    for (const id of memoryIds) {
      const row = local.prepare(`select quality_reasons_json from ${table} where id = ?`).get(id) as
        { quality_reasons_json: string } | undefined;
      if (!row) continue;
      const reasons = new Set<string>(parseReasons(row.quality_reasons_json));
      reasons.add(CONFLICT_QUALITY_REASON);
      local.prepare(`update ${table} set quality_status = 'needs_review', quality_reasons_json = ?, last_verified_at = ? where id = ?`)
        .run(JSON.stringify([...reasons].sort()), now, id);
      flagged += 1;
    }
  }
  return flagged;
}

type RowDecision = "unchanged" | { action: MergeAction; reason?: string | undefined };

function decideRow(table: string, here: Row | undefined, there: Row | undefined, base: Row | undefined): RowDecision {
  const sameSides = here !== undefined && there !== undefined && identical(here, there);
  if (sameSides) return "unchanged";
  if (here === undefined && there === undefined) return "unchanged";

  if (base === undefined) {
    // Absent from the ancestor: an addition on whichever side has it.
    if (there === undefined) return { action: "keep_local" };
    if (here === undefined) return { action: "insert_remote" };
    return conflict(table, here, there, "both_added_same_key");
  }

  // Present in the ancestor and gone on one side: that side deleted it, and a delete is
  // never undone by the other side's copy. This is unconditional on purpose. The reason
  // a row disappears is usually a privacy deletion, so treating a concurrent local edit
  // as grounds to keep the row would silently resurrect deleted content — the exact
  // failure the ancestor exists to prevent. The pre-merge recovery backup is what makes
  // the discarded local edit retrievable.
  if (here === undefined) return "unchanged";
  if (there === undefined) {
    return identical(here, base)
      ? { action: "delete_local" }
      : { action: "delete_local", reason: "deleted_remotely_edited_locally" };
  }

  if (identical(here, base)) return { action: "take_remote" };
  if (identical(there, base)) return { action: "keep_local" };
  return conflict(table, here, there, "edited_on_both_sides");
}

/**
 * Both sides edited the same row.
 *
 * Note this deliberately does *not* use `memoryFactsConflict`, which answers a
 * different question: whether two separate facts about one subject contradict each
 * other, treating a shared evidence signature as the same observation seen twice. Here
 * the two rows are the same memory by id, and two devices rewriting its text are in
 * conflict whether or not the evidence behind it changed. So equivalence is judged on
 * the wording alone: identical meaning converges on the newer copy, anything else is a
 * competing edit that a person has to settle.
 */
function conflict(table: string, here: Row, there: Row, reason: string): { action: MergeAction; reason: string } {
  if (MEMORY_TABLES.has(table)) {
    const left = comparable(here);
    const right = comparable(there);
    const equivalent = left.type === right.type &&
      normalizeMemorySummary(left.title) === normalizeMemorySummary(right.title) &&
      normalizeMemorySummary(left.summary) === normalizeMemorySummary(right.summary);
    if (equivalent) {
      // Same fact, differing only in bookkeeping: last writer wins, which is a
      // convergence rather than a choice between two claims.
      return newer(there, here)
        ? { action: "take_remote", reason: "converged_equivalent_fact" }
        : { action: "keep_local", reason: "converged_equivalent_fact" };
    }
    return { action: "flag_conflict", reason };
  }
  // Evidence rows are effectively immutable once written, so a divergence here is a
  // timestamp difference at worst; the newer copy wins and nothing is discarded.
  return newer(there, here) ? { action: "take_remote", reason } : { action: "keep_local", reason };
}

function newer(candidate: Row, against: Row): boolean {
  for (const column of ["status_changed_at", "updated_at", "promoted_at", "created_at"]) {
    const left = candidate[column];
    const right = against[column];
    if (typeof left === "string" && typeof right === "string" && left !== right) return left > right;
  }
  return false;
}

function comparable(row: Row): ComparableMemoryFact {
  return {
    type: String(row.type) as MemoryType,
    title: String(row.title ?? ""),
    summary: String(row.summary ?? ""),
    scope: parseScope(typeof row.scope_json === "string" ? row.scope_json : undefined),
    evidence: parseEvidence(row.evidence_json),
    ...(typeof row.subject_key === "string" ? { subjectKey: row.subject_key } : {})
  };
}

function parseEvidence(value: unknown): EvidenceRef[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as EvidenceRef[] : [];
  } catch {
    return [];
  }
}

function identical(left: Row, right: Row): boolean {
  return serialize(left) === serialize(right);
}

function serialize(row: Row): string {
  return JSON.stringify(Object.keys(row).sort().map((key) => [key, normalizeValue(row[key])]));
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return value;
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`pragma table_info(${quote(table)})`).all() as Array<{ name: string }>).map((column) => column.name);
}

function readRows(db: DatabaseSync, table: string, key: readonly string[], columns: readonly string[]): Map<string, Row> {
  const rows = new Map<string, Row>();
  const scoped = LAYERED_TABLES.has(table) && columns.includes("layer");
  const sql = `select ${columns.map(quote).join(", ")} from ${quote(table)}${scoped ? " where layer = 'core'" : ""}`;
  for (const row of db.prepare(sql).all() as Row[]) {
    rows.set(key.map((column) => String(row[column])).join(" "), row);
  }
  return rows;
}

/** True when this fact already exists locally under a different row id. */
function heldUnderAnotherId(db: DatabaseSync, table: string, key: readonly string[], row: Row): boolean {
  const natural = NATURAL_KEYS[table];
  if (!natural || !natural.every((column) => column in row)) return false;
  const conditions = natural.map((column) => `${quote(column)} is ?`).join(" and ");
  const excluded = key.map((column) => `${quote(column)} is not ?`).join(" and ");
  const found = db.prepare(`select 1 from ${quote(table)} where ${conditions} and ${excluded} limit 1`)
    .get(...natural.map((column) => sqlValue(row[column])), ...key.map((column) => sqlValue(row[column])));
  return found !== undefined;
}

function writeRow(db: DatabaseSync, table: string, key: readonly string[], columns: readonly string[], row: Row): void {
  const names = columns.filter((column) => column in row);
  db.prepare(
    `insert into ${quote(table)} (${names.map(quote).join(", ")}) values (${names.map(() => "?").join(", ")})
     on conflict(${key.map(quote).join(", ")}) do update set ${names.filter((column) => !key.includes(column)).map((column) => `${quote(column)} = excluded.${quote(column)}`).join(", ")}`
  ).run(...names.map((column) => sqlValue(row[column])));
}

function deleteRow(db: DatabaseSync, table: string, key: readonly string[], id: string): void {
  const parts = id.split(" ");
  db.prepare(`delete from ${quote(table)} where ${key.map((column) => `${quote(column)} = ?`).join(" and ")}`).run(...parts);
}

function unionOperationLog(local: DatabaseSync, remote: DatabaseSync): void {
  const columns = tableColumns(local, "operation_log");
  if (columns.length === 0) return;
  for (const row of remote.prepare(`select ${columns.map(quote).join(", ")} from operation_log`).all() as Row[]) {
    local.prepare(
      `insert or ignore into operation_log (${columns.map(quote).join(", ")}) values (${columns.map(() => "?").join(", ")})`
    ).run(...columns.map((column) => sqlValue(row[column])));
  }
}

function parseReasons(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((reason): reason is string => typeof reason === "string") : [];
  } catch {
    return [];
  }
}

function sqlValue(value: unknown): string | number | bigint | null | Uint8Array {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") return value;
  return JSON.stringify(value);
}

function quote(name: string): string { return `"${name.replaceAll('"', '""')}"`; }

export { CONFLICT_QUALITY_REASON };
