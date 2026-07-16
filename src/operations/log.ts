import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { withTransaction } from "../storage/transactions.js";
import type { MemoryLifecycleStatus, SourceType } from "../types.js";
import {
  OPERATION_ACTORS,
  OPERATION_STATUSES,
  OPERATION_TYPES,
  type BeginOperationInput,
  type CreateSourceTombstoneInput,
  type FinishOperationInput,
  type ListOperationsInput,
  type OperationActor,
  type OperationLogEntry,
  type OperationMetadata,
  type OperationStatus,
  type OperationType,
  type SourceTombstone
} from "./types.js";

interface OperationLogRow {
  id: string;
  operation_type: OperationType;
  status: OperationStatus;
  started_at: string;
  completed_at: string | null;
  actor: OperationActor;
  metadata_json: string;
}

interface SourceTombstoneRow {
  source_type: SourceType;
  source_id_hash: string;
  deleted_at: string;
  operation_id: string;
}

const OPAQUE_IDENTIFIER_PATTERNS = [
  /^(?:operation|memory|source|decision)-[a-f0-9]{8,64}$/i,
  /^(?:operation|memory|source|decision)-[a-f0-9]{8}-[a-f0-9-]{27}$/i,
  /^memory-manual-decision-[a-f0-9]{8}-[a-f0-9-]{27}$/i,
  /^commit-[a-f0-9]{7,64}$/i,
  /^(?:export|import|redaction|retention|recovery|batch)-[0-9]+$/
];
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_TYPES = new Set<SourceType>(["conversation", "commit", "decision"]);
const LIFECYCLE_STATUSES = new Set<MemoryLifecycleStatus>(["current", "superseded", "retracted"]);
const METADATA_CATEGORIES = new Set([
  "all", "candidates", "chunks", "commits", "database", "decisions", "embeddings",
  "memories", "operations", "project", "schema", "sources", "temporary_memories", "tombstones"
]);

const METADATA_KEYS: Record<OperationType, ReadonlySet<string>> = {
  migration: new Set(["migrationVersion"]),
  lifecycle_change: new Set(["memoryIdHash", "previousStatus", "newStatus", "replacementMemoryIdHash"]),
  redaction: new Set(["identifier", "count", "category"]),
  deletion: new Set(["sourceType", "sourceIdHash", "count"]),
  export: new Set(["identifier", "count", "category"]),
  import: new Set(["identifier", "count", "category"]),
  retention_prune: new Set(["identifier", "count", "category"]),
  recovery: new Set(["identifier", "count", "category"])
};

export function beginOperation<T extends OperationType>(
  db: DatabaseSync,
  input: BeginOperationInput<T>
): OperationLogEntry<T> {
  assertEnumValue(input.operationType, OPERATION_TYPES, "operation type");
  assertEnumValue(input.actor, OPERATION_ACTORS, "operation actor");
  const startedAt = input.startedAt ?? new Date().toISOString();
  assertIsoTimestamp(startedAt, "startedAt");
  const metadata = validateOperationMetadata(input.operationType, input.metadata ?? {});
  const id = `operation-${randomUUID()}`;
  db.prepare(
    `insert into operation_log
       (id, operation_type, status, started_at, completed_at, actor, metadata_json)
     values (?, ?, 'started', ?, null, ?, ?)`
  ).run(id, input.operationType, startedAt, input.actor, JSON.stringify(metadata));
  return readOperation(db, id) as OperationLogEntry<T>;
}

export function completeOperation(
  db: DatabaseSync,
  id: string,
  input: FinishOperationInput = {}
): OperationLogEntry {
  return finishOperation(db, id, "completed", input);
}

export function failOperation(
  db: DatabaseSync,
  id: string,
  input: FinishOperationInput = {}
): OperationLogEntry {
  return finishOperation(db, id, "failed", input);
}

export function listOperations(db: DatabaseSync, input: ListOperationsInput = {}): OperationLogEntry[] {
  if (input.operationType !== undefined) assertEnumValue(input.operationType, OPERATION_TYPES, "operation type");
  if (input.status !== undefined) assertEnumValue(input.status, OPERATION_STATUSES, "operation status");
  if (input.actor !== undefined) assertEnumValue(input.actor, OPERATION_ACTORS, "operation actor");
  const predicates: string[] = [];
  const parameters: Array<string | number> = [];
  if (input.operationType !== undefined) {
    predicates.push("operation_type = ?");
    parameters.push(input.operationType);
  }
  if (input.status !== undefined) {
    predicates.push("status = ?");
    parameters.push(input.status);
  }
  if (input.actor !== undefined) {
    predicates.push("actor = ?");
    parameters.push(input.actor);
  }
  const limit = input.limit === null ? Number.MAX_SAFE_INTEGER : normalizeLimit(input.limit);
  parameters.push(limit);
  const where = predicates.length === 0 ? "" : `where ${predicates.join(" and ")}`;
  const rows = db.prepare(
    `select id, operation_type, status, started_at, completed_at, actor, metadata_json
     from operation_log ${where}
     order by started_at desc, id desc
     limit ?`
  ).all(...parameters) as unknown as OperationLogRow[];
  return rows.map(operationFromRow);
}

export function recordCompletedOperation<T extends OperationType>(
  db: DatabaseSync,
  input: BeginOperationInput<T>,
  completedAt?: string
): OperationLogEntry<T> {
  const timestamp = completedAt ?? input.startedAt ?? new Date().toISOString();
  assertIsoTimestamp(timestamp, "completedAt");
  return withTransaction(db, () => {
    const started = beginOperation(db, { ...input, startedAt: input.startedAt ?? timestamp });
    return completeOperation(db, started.id, { completedAt: timestamp }) as OperationLogEntry<T>;
  });
}

export function recordCompletedMigrationOperation(
  db: DatabaseSync,
  migrationVersion: number,
  timestamp: string
): OperationLogEntry<"migration"> {
  return recordCompletedOperation(db, {
    operationType: "migration",
    actor: "system",
    metadata: { migrationVersion },
    startedAt: timestamp
  }, timestamp);
}

export function createSourceTombstone(
  db: DatabaseSync,
  input: CreateSourceTombstoneInput
): SourceTombstone {
  assertSourceType(input.sourceType);
  assertRawSourceId(input.sourceId);
  assertEnumValue(input.actor, OPERATION_ACTORS, "operation actor");
  const deletedAt = input.deletedAt ?? new Date().toISOString();
  assertIsoTimestamp(deletedAt, "deletedAt");
  const sourceIdHash = hashSourceId(input.sourceId);
  return withTransaction(db, () => {
    const existing = readSourceTombstone(db, input.sourceType, sourceIdHash);
    if (existing) return existing;
    const operation = recordCompletedOperation(db, {
      operationType: "deletion",
      actor: input.actor,
      metadata: { sourceType: input.sourceType, sourceIdHash },
      startedAt: deletedAt
    }, deletedAt);
    db.prepare(
      `insert into source_tombstones (source_type, source_id_hash, deleted_at, operation_id)
       values (?, ?, ?, ?)`
    ).run(input.sourceType, sourceIdHash, deletedAt, operation.id);
    return readSourceTombstone(db, input.sourceType, sourceIdHash) as SourceTombstone;
  });
}

export function findSourceTombstone(
  db: DatabaseSync,
  sourceType: SourceType,
  sourceId: string
): SourceTombstone | undefined {
  assertSourceType(sourceType);
  assertRawSourceId(sourceId);
  return readSourceTombstone(db, sourceType, hashSourceId(sourceId));
}

export function hashSourceId(sourceId: string): string {
  assertRawSourceId(sourceId);
  return hashOperationIdentifier(sourceId);
}

export function hashOperationIdentifier(identifier: string): string {
  assertRawSourceId(identifier);
  return createHash("sha256").update(identifier, "utf8").digest("hex");
}

function finishOperation(
  db: DatabaseSync,
  id: string,
  status: Exclude<OperationStatus, "started">,
  input: FinishOperationInput
): OperationLogEntry {
  assertSafeIdentifier(id, "operation id");
  const existing = readOperation(db, id);
  if (!existing) throw new Error(`Unknown operation: ${id}`);
  if (existing.status !== "started") {
    if (existing.status === status) return existing;
    throw new Error(`Operation ${id} is already ${existing.status}`);
  }
  const completedAt = input.completedAt ?? new Date().toISOString();
  assertIsoTimestamp(completedAt, "completedAt");
  if (completedAt < existing.startedAt) throw new Error("completedAt cannot be earlier than startedAt");
  db.prepare("update operation_log set status = ?, completed_at = ? where id = ?")
    .run(status, completedAt, id);
  return readOperation(db, id) as OperationLogEntry;
}

function readOperation(db: DatabaseSync, id: string): OperationLogEntry | undefined {
  const row = db.prepare(
    `select id, operation_type, status, started_at, completed_at, actor, metadata_json
     from operation_log where id = ?`
  ).get(id) as unknown as OperationLogRow | undefined;
  return row ? operationFromRow(row) : undefined;
}

function operationFromRow(row: OperationLogRow): OperationLogEntry {
  return {
    id: row.id,
    operationType: row.operation_type,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    actor: row.actor,
    metadata: JSON.parse(row.metadata_json) as OperationMetadata
  };
}

function readSourceTombstone(
  db: DatabaseSync,
  sourceType: SourceType,
  sourceIdHash: string
): SourceTombstone | undefined {
  const tombstoneTable = db.prepare(
    "select 1 from sqlite_master where type = 'table' and name = 'source_tombstones'"
  ).get();
  if (!tombstoneTable) return undefined;
  const row = db.prepare(
    `select source_type, source_id_hash, deleted_at, operation_id
     from source_tombstones where source_type = ? and source_id_hash = ?`
  ).get(sourceType, sourceIdHash) as unknown as SourceTombstoneRow | undefined;
  return row ? {
    sourceType: row.source_type,
    sourceIdHash: row.source_id_hash,
    deletedAt: row.deleted_at,
    operationId: row.operation_id
  } : undefined;
}

export function validateOperationMetadata<T extends OperationType>(
  operationType: T,
  metadata: unknown
): OperationLogEntry<T>["metadata"] {
  if (!isPlainObject(metadata)) throw new Error(`${operationType} operation metadata must be an object`);
  const allowedKeys = METADATA_KEYS[operationType];
  const canonical = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(metadata)) {
    if (!allowedKeys.has(key)) throw new Error(`${key} is not allowed in ${operationType} operation metadata`);
    const value = metadata[key];
    validateMetadataValue(key, value);
    if (value !== undefined) canonical[key] = value;
  }
  return canonical as OperationLogEntry<T>["metadata"];
}

function validateMetadataValue(key: string, value: unknown): void {
  if (value === undefined) return;
  if (key === "identifier") {
    assertSafeIdentifier(value, `${key} metadata`);
  } else if (key === "category") {
    if (typeof value !== "string" || !METADATA_CATEGORIES.has(value)) {
      throw new Error("category operation metadata must be an allowlisted category");
    }
  } else if (key === "count" || key === "migrationVersion") {
    if (typeof value !== "number" || !Number.isSafeInteger(value) ||
        value < (key === "migrationVersion" ? 1 : 0)) {
      throw new Error(`${key} operation metadata must be a safe non-negative integer`);
    }
  } else if (key === "sourceType") {
    assertSourceType(value);
  } else if (key === "sourceIdHash" || key === "memoryIdHash" || key === "replacementMemoryIdHash") {
    if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
      throw new Error(`${key} operation metadata must be a SHA-256 hex digest`);
    }
  } else if (key === "previousStatus" || key === "newStatus") {
    if (typeof value !== "string" || !LIFECYCLE_STATUSES.has(value as MemoryLifecycleStatus)) {
      throw new Error(`${key} operation metadata must be a lifecycle status`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertSafeIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !OPAQUE_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error(`${label} is not safe content-free metadata`);
  }
}

function assertRawSourceId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384 || value.includes("\0")) {
    throw new Error("sourceId must be a non-empty source identifier");
  }
}

function assertIsoTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
}

function assertSourceType(value: unknown): asserts value is SourceType {
  if (typeof value !== "string" || !SOURCE_TYPES.has(value as SourceType)) {
    throw new Error("sourceType operation metadata is invalid");
  }
}

function assertEnumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`Invalid ${label}: ${String(value)}`);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Operation list limit must be a positive integer");
  return limit;
}
