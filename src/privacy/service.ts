import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  createRecoveryBackup,
  purgeDatabaseBackups,
  removeRecoveryBackup,
  type BackupPurgeResult
} from "./backup.js";
import { redactWithPolicy } from "./policy.js";
import type { RedactionMatch } from "./redaction.js";
import { createEvidenceSignature } from "../memory/evidence-signature.js";
import { auditMemoryConflicts } from "../memory/conflicts.js";
import { auditMemoryQuality } from "../memory/quality.js";
import { hashOperationIdentifier, validateOperationMetadata } from "../operations/log.js";
import { OPERATION_TYPES, type OperationType } from "../operations/types.js";
import {
  PRIVACY_EXPORT_FORMAT,
  PRIVACY_EXPORT_TABLES,
  PRIVACY_EXPORT_VERSION,
  type PrivacyExportDocument
} from "./export-format.js";
import type { MemoryStore } from "../storage/store.js";
import { listStoredEmbeddingProviders } from "../storage/embedding-store.js";
import { retractedLifecycleValues } from "../storage/lifecycle-store.js";
import {
  assertPrivacyDatabaseIntegrity,
  rebuildPrivacyDerivedIndexes,
  validatePrivacyExportLogicalReferences,
  validatePrivacyLogicalReferences
} from "../storage/privacy-maintenance.js";
import { withTransaction } from "../storage/transactions.js";
import type { EvidenceRef, RetentionConfig, SourceType } from "../types.js";

export interface PrivacyAuditFinding {
  table: string;
  field: string;
  type: RedactionMatch["type"];
  ruleName?: string | undefined;
  count: number;
}

export interface PrivacyAuditResult {
  scannedFields: number;
  matches: number;
  findings: PrivacyAuditFinding[];
}

export interface PrivacyScrubOptions {
  now?: () => Date;
  purgeBackups?: boolean;
  afterMutation?: () => void;
  afterCommitVerification?: () => void;
}

export interface PrivacyScrubResult {
  backupPath: string;
  redactions: number;
  purge?: BackupPurgeResult;
}

export interface PrivacyDeleteResult {
  sourceIdHash: string;
  sourceType: SourceType;
  backupPath: string;
  deletedCandidates: number;
  updatedMemories: number;
  retractedMemories: number;
  purge?: BackupPurgeResult;
}

export interface PrivacyPruneResult {
  selected: number;
  deleted: number;
  sourceIdHashes: string[];
  backupPaths: string[];
  purge?: BackupPurgeResult;
}

export class PrivacyRecoveryError extends Error {
  readonly backupPath: string;

  constructor(message: string, backupPath: string, options?: ErrorOptions) {
    super(`${message}. Recovery backup retained at ${backupPath}`, options);
    this.name = "PrivacyRecoveryError";
    this.backupPath = backupPath;
  }
}

export function auditPrivacy(store: MemoryStore): PrivacyAuditResult {
  const counts = new Map<string, PrivacyAuditFinding>();
  let scannedFields = 0;
  let matches = 0;
  for (const table of PRIVACY_EXPORT_TABLES) {
    for (const row of readTable(store, table)) {
      for (const [field, value] of Object.entries(row)) {
        for (const text of stringsInValue(value)) {
          scannedFields += 1;
          const redactions = redactWithPolicy(text, store.contentPolicy.privacyPolicy).redactions;
          matches += redactions.length;
          for (const redaction of redactions) {
            const key = [table, field, redaction.type, redaction.ruleName ?? ""].join("\0");
            const current = counts.get(key);
            if (current) current.count += 1;
            else counts.set(key, {
              table,
              field,
              type: redaction.type,
              ...(redaction.ruleName === undefined ? {} : { ruleName: redaction.ruleName }),
              count: 1
            });
          }
        }
      }
    }
  }
  return {
    scannedFields,
    matches,
    findings: [...counts.values()].sort((left, right) =>
      left.table.localeCompare(right.table) ||
      left.field.localeCompare(right.field) ||
      left.type.localeCompare(right.type) ||
      (left.ruleName ?? "").localeCompare(right.ruleName ?? "")
    )
  };
}

export function exportPrivacy(
  store: MemoryStore,
  input: { outputPath: string; raw?: boolean; confirmedRaw?: boolean; now?: () => Date }
): { outputPath: string; redacted: boolean; tableCounts: Record<string, number> } {
  if (input.raw && !input.confirmedRaw) {
    throw new Error("Raw export requires --confirm-raw-export");
  }
  const redacted = !input.raw;
  const tables: PrivacyExportDocument["tables"] = {};
  const tableCounts: Record<string, number> = {};
  for (const table of PRIVACY_EXPORT_TABLES) {
    const rows = readTable(store, table);
    tables[table] = redacted
      ? rows.map((row) => redactExportValue(row, store) as Record<string, unknown>)
      : rows;
    tableCounts[table] = rows.length;
  }
  const document: PrivacyExportDocument = {
    format: PRIVACY_EXPORT_FORMAT,
    version: PRIVACY_EXPORT_VERSION,
    exportedAt: (input.now?.() ?? new Date()).toISOString(),
    redacted,
    embeddingProviders: readEmbeddingProviders(store).map((provider) => ({
      providerKey: provider.providerKey,
      endpointHash: provider.endpointHash,
      model: redacted ? store.contentPolicy.text(provider.model) : provider.model
    })),
    tables
  };
  writeJsonAtomically(input.outputPath, document);
  const operation = store.beginOperation({
    operationType: "export",
    actor: "cli",
    metadata: { identifier: `export-${Object.values(tableCounts).reduce((sum, count) => sum + count, 0)}`, category: "database" },
    startedAt: document.exportedAt
  });
  store.completeOperation(operation.id, { completedAt: document.exportedAt });
  return { outputPath: input.outputPath, redacted, tableCounts };
}

export function importPrivacy(
  store: MemoryStore,
  input: {
    inputPath: string;
    confirmNonempty?: boolean;
    now?: () => Date;
    afterCommitVerification?: () => void;
  }
): { inputPath: string; tableCounts: Record<string, number> } {
  const document = parseExportDocument(readFileSync(input.inputPath, "utf8"));
  validatePrivacyExportLogicalReferences(document.tables);
  const existing = countImportableRows(store);
  if (existing > 0 && !input.confirmNonempty) {
    throw new Error("Import into non-empty storage requires --confirm-nonempty");
  }
  const timestamp = (input.now?.() ?? new Date()).toISOString();
  const operation = store.beginOperation({
    operationType: "import",
    actor: "cli",
    metadata: { identifier: "import-0", category: "database" },
    startedAt: timestamp
  });
  const tableCounts: Record<string, number> = {};
  let backupPath: string | undefined;
  let committed = false;
  try {
    if (existing > 0) backupPath = createRecoveryBackup(store.paths.databasePath, new Date(timestamp));
    withTransaction(store.db, () => {
      clearImportTables(store, operation.id);
      for (const table of importOrder()) {
        const rows = document.tables[table] ?? [];
        tableCounts[table] = rows.length;
        for (const row of rows) insertRow(store, table, row);
      }
      scrubStoredContent(store);
      rebuildPrivacyDerivedIndexes(store.db);
      for (const provider of document.embeddingProviders ?? []) {
        store.reconcileEmbeddingJobs({
          providerKey: provider.providerKey,
          endpointHash: provider.endpointHash,
          model: provider.model
        });
      }
      validatePrivacyLogicalReferences(store.db);
      assertPrivacyDatabaseIntegrity(store.db);
    });
    committed = true;
    input.afterCommitVerification?.();
    assertPrivacyDatabaseIntegrity(store.db);
    store.completeOperation(operation.id, { completedAt: timestamp });
    if (backupPath) removeRecoveryBackup(backupPath);
    return { inputPath: input.inputPath, tableCounts };
  } catch (error) {
    try {
      store.failOperation(operation.id, { completedAt: timestamp });
    } catch {
      // Preserve the original import failure.
    }
    if (!backupPath) throw error;
    if (committed) restoreCommittedFailure(store, backupPath, operation.id, timestamp);
    throw new PrivacyRecoveryError(
      error instanceof Error ? error.message : String(error),
      backupPath,
      { cause: error }
    );
  }
}

export function scrubPrivacy(store: MemoryStore, options: PrivacyScrubOptions = {}): PrivacyScrubResult {
  const timestamp = (options.now?.() ?? new Date()).toISOString();
  const operation = store.beginOperation({
    operationType: "redaction",
    actor: "cli",
    metadata: { category: "database" },
    startedAt: timestamp
  });
  let backupPath: string | undefined;
  let redactions = 0;
  let committed = false;
  try {
    backupPath = createRecoveryBackup(store.paths.databasePath, new Date(timestamp));
    withTransaction(store.db, () => {
      redactions = scrubStoredContent(store);
      rebuildPrivacyDerivedIndexes(store.db);
      reconcileStoredEmbeddings(store);
      auditMemoryConflicts(store, { fix: true, now: timestamp });
      auditMemoryQuality(store, { fix: true, now: timestamp });
      options.afterMutation?.();
      assertPrivacyDatabaseIntegrity(store.db);
    });
    committed = true;
    options.afterCommitVerification?.();
    assertPrivacyDatabaseIntegrity(store.db);
    store.completeOperation(operation.id, { completedAt: timestamp });
    const purge = options.purgeBackups
      ? purgeDatabaseBackups(store.paths.databasePath)
      : undefined;
    if (!options.purgeBackups) removeRecoveryBackup(backupPath);
    return {
      backupPath,
      redactions,
      ...(purge === undefined ? {} : { purge })
    };
  } catch (error) {
    try {
      store.failOperation(operation.id, { completedAt: timestamp });
    } catch {
      // Preserve the original recovery failure.
    }
    if (!backupPath) throw error;
    if (committed) {
      try {
        restoreCommittedFailure(store, backupPath, operation.id, timestamp);
      } catch (restoreError) {
        throw new PrivacyRecoveryError(
          `Privacy scrub failed and recovery restoration also failed: ${
            restoreError instanceof Error ? restoreError.message : String(restoreError)
          }`,
          backupPath,
          { cause: error }
        );
      }
    }
    throw new PrivacyRecoveryError(
      error instanceof Error ? error.message : String(error),
      backupPath,
      { cause: error }
    );
  }
}

export function deletePrivacySource(
  store: MemoryStore,
  input: {
    sourceId: string;
    confirmSourceId: string;
    purgeBackups?: boolean;
    now?: () => Date;
    afterMutation?: () => void;
    afterCommitVerification?: () => void;
  }
): PrivacyDeleteResult {
  if (input.confirmSourceId !== input.sourceId) {
    throw new Error("Confirmation must exactly match source ID");
  }
  const source = store.readSource(input.sourceId);
  if (!source || !source.id) throw new Error(`Unknown source: ${input.sourceId}`);
  const sourceId = source.id;
  const timestamp = (input.now?.() ?? new Date()).toISOString();
  const sourceIdHash = hashOperationIdentifier(sourceId);
  const operation = store.beginOperation({
    operationType: "deletion",
    actor: "cli",
    metadata: { sourceType: source.type, sourceIdHash },
    startedAt: timestamp
  });
  let backupPath: string | undefined;
  let counts = { deletedCandidates: 0, updatedMemories: 0, retractedMemories: 0 };
  let committed = false;
  try {
    backupPath = createRecoveryBackup(store.paths.databasePath, new Date(timestamp));
    withTransaction(store.db, () => {
      counts = deleteSourceData(store, {
        sourceId,
        sourceType: source.type,
        sourceIdHash,
        sourceOrigin: source.origin,
        timestamp,
        operationId: operation.id
      });
      rebuildPrivacyDerivedIndexes(store.db);
      reconcileStoredEmbeddings(store);
      auditMemoryConflicts(store, { fix: true, now: timestamp });
      auditMemoryQuality(store, { fix: true, now: timestamp });
      input.afterMutation?.();
      assertPrivacyDatabaseIntegrity(store.db);
    });
    committed = true;
    input.afterCommitVerification?.();
    assertPrivacyDatabaseIntegrity(store.db);
    store.completeOperation(operation.id, { completedAt: timestamp });
    const purge = input.purgeBackups ? purgeDatabaseBackups(store.paths.databasePath) : undefined;
    if (!input.purgeBackups) removeRecoveryBackup(backupPath);
    return {
      sourceIdHash,
      sourceType: source.type,
      backupPath,
      ...counts,
      ...(purge === undefined ? {} : { purge })
    };
  } catch (error) {
    try {
      store.failOperation(operation.id, { completedAt: timestamp });
    } catch {
      // Preserve the original deletion failure.
    }
    if (!backupPath) throw error;
    if (committed) restoreCommittedFailure(store, backupPath, operation.id, timestamp);
    throw new PrivacyRecoveryError(
      error instanceof Error ? error.message : String(error),
      backupPath,
      { cause: error }
    );
  }
}

export function prunePrivacySources(
  store: MemoryStore,
  retention: RetentionConfig,
  options: {
    apply: boolean;
    purgeBackups?: boolean;
    now?: () => Date;
  }
): PrivacyPruneResult {
  const now = options.now?.() ?? new Date();
  const rows = store.db.prepare(
    "select id, type, origin, metadata_json, created_at from sources order by created_at, id"
  ).all() as Array<{
    id: string;
    type: SourceType;
    origin: string;
    metadata_json: string;
    created_at: string;
  }>;
  const overrides = new Map(retention.overrides.map((override) => [override.sourceId, override.maxAgeDays]));
  const selected = rows.filter((source) => {
    const adapter = classifyRetentionAdapter(source);
    const maxAgeDays = overrides.has(source.id)
      ? overrides.get(source.id)
      : adapter === "unknown" ? undefined : retention.sources[adapter].maxAgeDays;
    if (maxAgeDays === undefined || maxAgeDays === null) return false;
    const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    return source.created_at <= cutoff;
  });
  const result: PrivacyPruneResult = {
    selected: selected.length,
    deleted: 0,
    sourceIdHashes: selected.map((source) => hashOperationIdentifier(source.id)),
    backupPaths: []
  };
  if (!options.apply) return result;
  const timestamp = now.toISOString();
  const operation = store.beginOperation({
    operationType: "retention_prune",
    actor: "cli",
    metadata: { count: selected.length, category: "sources" },
    startedAt: timestamp
  });
  let backupPath: string | undefined;
  let committed = false;
  try {
    if (selected.length > 0) {
      backupPath = createRecoveryBackup(store.paths.databasePath, now);
      result.backupPaths.push(backupPath);
      withTransaction(store.db, () => {
        for (const source of selected) {
          deleteSourceData(store, {
            sourceId: source.id,
            sourceType: source.type,
            sourceIdHash: hashOperationIdentifier(source.id),
            sourceOrigin: source.origin,
            timestamp,
            operationId: operation.id
          });
          result.deleted += 1;
        }
        rebuildPrivacyDerivedIndexes(store.db);
        reconcileStoredEmbeddings(store);
        auditMemoryConflicts(store, { fix: true, now: timestamp });
        auditMemoryQuality(store, { fix: true, now: timestamp });
        assertPrivacyDatabaseIntegrity(store.db);
      });
      committed = true;
      assertPrivacyDatabaseIntegrity(store.db);
    }
    store.completeOperation(operation.id, { completedAt: timestamp });
    if (options.purgeBackups) {
      result.purge = purgeDatabaseBackups(store.paths.databasePath);
    } else if (backupPath) {
      removeRecoveryBackup(backupPath);
    }
    return result;
  } catch (error) {
    try {
      store.failOperation(operation.id, { completedAt: timestamp });
    } catch {
      // Preserve the original retention failure.
    }
    if (!backupPath) throw error;
    if (committed) restoreCommittedFailure(store, backupPath, operation.id, timestamp);
    throw new PrivacyRecoveryError(
      error instanceof Error ? error.message : String(error),
      backupPath,
      { cause: error }
    );
  }
}

function readTable(store: MemoryStore, table: string): Array<Record<string, unknown>> {
  const columns = PRIVACY_EXPORT_COLUMNS[table];
  if (!columns) throw new Error(`Unsupported privacy export table: ${table}`);
  return store.db.prepare(
    `select ${columns.map(quoteIdentifier).join(", ")} from ${quoteIdentifier(table)}`
  ).all() as unknown as Array<Record<string, unknown>>;
}

function parseExportDocument(raw: string): PrivacyExportDocument {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid privacy export document");
  }
  const document = value as Partial<PrivacyExportDocument>;
  if (document.format !== PRIVACY_EXPORT_FORMAT || document.version !== PRIVACY_EXPORT_VERSION) {
    throw new Error("Unsupported privacy export format or version");
  }
  if (!document.tables || typeof document.tables !== "object" || Array.isArray(document.tables)) {
    throw new Error("Privacy export tables are required");
  }
  for (const table of PRIVACY_EXPORT_TABLES) {
    const rows = document.tables[table];
    if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new Error(`Invalid privacy export table: ${table}`);
    }
  }
  if (document.embeddingProviders !== undefined && (
    !Array.isArray(document.embeddingProviders) ||
    document.embeddingProviders.some((provider) =>
      !provider || typeof provider !== "object" ||
      typeof provider.providerKey !== "string" ||
      typeof provider.endpointHash !== "string" ||
      typeof provider.model !== "string"
    )
  )) {
    throw new Error("Invalid privacy export embedding providers");
  }
  return document as PrivacyExportDocument;
}

function countImportableRows(store: MemoryStore): number {
  return PRIVACY_EXPORT_TABLES
    .filter((table) => table !== "operation_log" && table !== "private_identity_mappings")
    .reduce((total, table) => {
      const row = store.db.prepare(`select count(*) as count from ${table}`).get() as { count: number };
      return total + row.count;
    }, 0);
}

function clearImportTables(store: MemoryStore, preserveOperationId: string): void {
  for (const table of [...importOrder()].reverse()) {
    if (table === "operation_log") {
      store.db.prepare("delete from operation_log where id <> ?").run(preserveOperationId);
    } else {
      store.db.prepare(`delete from ${table}`).run();
    }
  }
  store.db.prepare("delete from chunks_fts").run();
  store.db.prepare("delete from temporary_memories_fts").run();
  store.db.prepare("delete from embedding_vectors").run();
  store.db.prepare("delete from embedding_jobs").run();
}

function importOrder(): readonly string[] {
  return [
    "operation_log",
    "private_identity_mappings",
    "sources",
    "chunks",
    "commits",
    "decisions",
    "relations",
    "sync_sources",
    "sync_cursors",
    "memories",
    "memory_candidates",
    "memory_links",
    "temporary_memories",
    "temporary_memory_links",
    "memory_relations",
    "source_failures",
    "source_tombstones"
  ];
}

const PRIVACY_EXPORT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  sources: ["id", "type", "title", "origin", "raw_content", "metadata_json", "created_at"],
  chunks: ["id", "source_id", "chunk_index", "text", "metadata_json"],
  commits: ["hash", "author_name", "author_email", "authored_at", "message", "changed_files_json", "diff_summary"],
  decisions: ["id", "topic", "decision", "reason", "status", "evidence_json", "created_at"],
  relations: ["id", "from_type", "from_id", "relation", "to_type", "to_id", "locator"],
  sync_sources: ["source", "enabled", "last_sync_at", "last_success_at", "last_error", "metadata_json"],
  sync_cursors: ["source", "cursor_key", "cursor_value", "updated_at"],
  memory_candidates: [
    "id", "type", "title", "summary", "reason", "confidence", "evidence_json",
    "related_files_json", "dedupe_key", "promotion_state", "promoted_memory_id",
    "evidence_signature", "quality_status", "quality_reasons_json", "last_verified_at",
    "created_at", "updated_at"
  ],
  memories: [
    "id", "type", "title", "summary", "reason", "confidence", "evidence_json",
    "related_files_json", "dedupe_key", "evidence_signature", "source", "quality_status",
    "quality_reasons_json", "last_verified_at", "subject_key", "lifecycle_status",
    "valid_from", "valid_until", "status_reason", "status_changed_at",
    "lifecycle_generation", "created_at", "promoted_at"
  ],
  memory_links: ["id", "owner_kind", "owner_id", "target_type", "target_id", "locator", "metadata_json"],
  temporary_memories: [
    "id", "project_id", "thread_id", "session_id", "source_adapter", "kind", "title",
    "summary", "details", "related_files_json", "evidence_json", "confidence", "created_at",
    "updated_at", "expires_at"
  ],
  temporary_memory_links: ["id", "memory_id", "target_type", "target_id", "locator", "metadata_json"],
  memory_relations: ["id", "from_memory_id", "to_memory_id", "relation_type", "created_at", "reason"],
  source_failures: [
    "id", "adapter", "path", "error_code", "message", "first_occurred_at",
    "last_occurred_at", "attempts", "resolved_at"
  ],
  source_tombstones: ["source_type", "source_id_hash", "deleted_at", "operation_id"],
  private_identity_mappings: ["raw_hash", "stored_identity", "created_at"],
  operation_log: ["id", "operation_type", "status", "started_at", "completed_at", "actor", "metadata_json"]
};

const RESTORE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  ...PRIVACY_EXPORT_COLUMNS,
  schema_migrations: ["version", "name", "applied_at"],
  embedding_jobs: [
    "owner_kind", "owner_id", "content_hash", "provider_key", "endpoint_hash", "model",
    "provider_fingerprint", "state", "attempts", "last_error", "created_at", "updated_at",
    "completed_at", "owner_version", "index_generation", "target_fingerprint"
  ],
  embedding_vectors: [
    "owner_kind", "owner_id", "content_hash", "provider_key", "endpoint_hash", "model",
    "provider_fingerprint", "dimension", "vector_blob", "created_at", "updated_at", "owner_version"
  ]
};

const RESTORE_TABLE_ORDER = [
  "schema_migrations",
  "operation_log",
  "private_identity_mappings",
  "sources",
  "chunks",
  "commits",
  "decisions",
  "relations",
  "sync_sources",
  "sync_cursors",
  "memories",
  "memory_candidates",
  "memory_links",
  "temporary_memories",
  "temporary_memory_links",
  "memory_relations",
  "source_failures",
  "source_tombstones",
  "embedding_jobs",
  "embedding_vectors"
] as const;

function insertRow(store: MemoryStore, table: string, row: Record<string, unknown>): void {
  if (table === "operation_log") row = validateImportedOperation(row);
  row = redactExportValue(row, store) as Record<string, unknown>;
  const columns = Object.keys(row);
  if (columns.length === 0) throw new Error(`Empty row in privacy export table: ${table}`);
  const knownColumns = new Set(
    (store.db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name)
  );
  const unknown = columns.find((column) => !knownColumns.has(column));
  if (unknown) throw new Error(`Unknown column ${table}.${unknown}`);
  const names = columns.map(quoteIdentifier).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  store.db.prepare(`insert into ${quoteIdentifier(table)} (${names}) values (${placeholders})`)
    .run(...columns.map((column) => normalizeImportedValue(row[column])));
}

function validateImportedOperation(row: Record<string, unknown>): Record<string, unknown> {
  const operationType = row.operation_type;
  if (typeof operationType !== "string" || !OPERATION_TYPES.includes(operationType as OperationType)) {
    throw new Error("Invalid imported operation type");
  }
  if (typeof row.metadata_json !== "string") throw new Error("Invalid imported operation metadata");
  const metadata = validateOperationMetadata(
    operationType as OperationType,
    JSON.parse(row.metadata_json) as unknown
  );
  return { ...row, metadata_json: JSON.stringify(metadata) };
}

function normalizeImportedValue(value: unknown): string | number | bigint | Uint8Array | null {
  if (value === null || typeof value === "string" || typeof value === "number" ||
      typeof value === "bigint" || value instanceof Uint8Array) return value;
  throw new Error("Privacy export contains an unsupported database value");
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function scrubStoredContent(store: MemoryStore): number {
  store.db.exec("pragma defer_foreign_keys = on");
  let redactions = rekeySensitiveSourceIdentifiers(store);
  const text = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    const original = String(value);
    const next = store.contentPolicy.text(original);
    if (next !== original) redactions += 1;
    return next;
  };
  const json = (value: unknown): string => {
    const original = String(value ?? "{}");
    let next: string;
    try {
      next = JSON.stringify(store.contentPolicy.json(JSON.parse(original)));
    } catch {
      next = store.contentPolicy.text(original);
    }
    if (next !== original) redactions += 1;
    return next;
  };
  const update = (
    table: string,
    key: string | readonly string[],
    fields: Readonly<Record<string, "text" | "json">>
  ): void => {
    const keys = typeof key === "string" ? [key] : [...key];
    const columns = [...keys, ...Object.keys(fields)];
    const rows = store.db.prepare(
      `select ${columns.map(quoteIdentifier).join(", ")} from ${quoteIdentifier(table)}`
    ).all() as Array<Record<string, unknown>>;
    const statement = store.db.prepare(
      `update ${quoteIdentifier(table)} set ${
        Object.keys(fields).map((field) => `${quoteIdentifier(field)} = ?`).join(", ")
      } where ${keys.map((field) => `${quoteIdentifier(field)} = ?`).join(" and ")}`
    );
    for (const row of rows) {
      const values = Object.entries(fields).map(([field, kind]) =>
        kind === "json" ? json(row[field]) : text(row[field])
      );
      statement.run(...values, ...keys.map((field) => row[field] as string | number));
    }
  };

  update("sources", "id", {
    title: "text", origin: "text", raw_content: "text", metadata_json: "json"
  });
  update("chunks", "id", { text: "text", metadata_json: "json" });
  update("commits", "hash", {
    author_name: "text", author_email: "text", message: "text",
    changed_files_json: "json", diff_summary: "text"
  });
  update("decisions", "id", {
    topic: "text", decision: "text", reason: "text", status: "text", evidence_json: "json"
  });
  update("relations", "id", { relation: "text", locator: "text" });
  update("memory_candidates", "id", {
    title: "text", summary: "text", reason: "text", evidence_json: "json",
    related_files_json: "json", quality_reasons_json: "json"
  });
  update("memories", "id", {
    title: "text", summary: "text", reason: "text", evidence_json: "json",
    related_files_json: "json", quality_reasons_json: "json", status_reason: "text"
  });
  update("memory_links", "id", { locator: "text", metadata_json: "json" });
  update("temporary_memories", "id", {
    project_id: "text", thread_id: "text", session_id: "text", source_adapter: "text",
    title: "text", summary: "text", details: "text",
    related_files_json: "json", evidence_json: "json"
  });
  update("temporary_memory_links", "id", { locator: "text", metadata_json: "json" });
  update("memory_relations", "id", { reason: "text" });
  update("source_failures", "id", { path: "text", message: "text" });
  update("sync_sources", "source", { last_error: "text", metadata_json: "json" });
  update("sync_cursors", ["source", "cursor_key"], { cursor_value: "text" });
  redactFileTargets(store, "relations", "id", "to_type", "to_id", () => { redactions += 1; });
  redactFileTargets(store, "memory_links", "id", "target_type", "target_id", () => { redactions += 1; });
  redactFileTargets(
    store,
    "temporary_memory_links",
    "id",
    "target_type",
    "target_id",
    () => { redactions += 1; }
  );
  return redactions;
}

function rekeySensitiveSourceIdentifiers(store: MemoryStore): number {
  let changed = 0;
  const sourceRows = store.db.prepare("select id, type from sources order by id")
    .all() as Array<{ id: string; type: SourceType }>;
  for (const source of sourceRows) {
    const nextId = store.contentPolicy.identifier(source.id);
    if (nextId === source.id) continue;
    store.db.prepare(
      `insert into sources (id, type, title, origin, raw_content, metadata_json, created_at)
       select ?, type, title, origin, raw_content, metadata_json, created_at
       from sources where id = ?`
    ).run(nextId, source.id);
    store.db.prepare("update chunks set source_id = ? where source_id = ?").run(nextId, source.id);
    if (source.type === "commit") {
      store.db.prepare(
        `insert into commits
           (hash, author_name, author_email, authored_at, message, changed_files_json, diff_summary)
         select ?, author_name, author_email, authored_at, message, changed_files_json, diff_summary
         from commits where hash = ?`
      ).run(nextId, source.id);
      store.db.prepare("delete from commits where hash = ?").run(source.id);
    }
    if (source.type === "decision") {
      store.db.prepare(
        `insert into decisions (id, topic, decision, reason, status, evidence_json, created_at)
         select ?, topic, decision, reason, status, evidence_json, created_at
         from decisions where id = ?`
      ).run(nextId, source.id);
      store.db.prepare("delete from decisions where id = ?").run(source.id);
    }
    store.db.prepare(
      `update relations set from_id = ?
       where from_id = ? and from_type in ('source', ?)`
    ).run(nextId, source.id, source.type);
    store.db.prepare(
      "update relations set to_id = ? where to_id = ? and to_type = ?"
    ).run(nextId, source.id, source.type);
    store.db.prepare(
      "update memory_links set target_id = ? where target_id = ? and target_type = ?"
    ).run(nextId, source.id, source.type);
    store.db.prepare(
      "update temporary_memory_links set target_id = ? where target_id = ? and target_type = ?"
    ).run(nextId, source.id, source.type);
    remapEvidenceReferences(store, source.type, source.id, nextId);
    store.db.prepare("delete from sources where id = ?").run(source.id);
    changed += 1;
  }

  const chunks = store.db.prepare("select id from chunks order by id").all() as Array<{ id: string }>;
  for (const chunk of chunks) {
    const nextId = store.contentPolicy.locator(chunk.id);
    if (nextId === chunk.id) continue;
    store.db.prepare(
      `insert into chunks (id, source_id, chunk_index, text, metadata_json)
       select ?, source_id, chunk_index, text, metadata_json from chunks where id = ?`
    ).run(nextId, chunk.id);
    store.db.prepare(
      "update relations set from_id = ? where from_type = 'chunk' and from_id = ?"
    ).run(nextId, chunk.id);
    store.db.prepare(
      "update relations set to_id = ? where to_type = 'chunk' and to_id = ?"
    ).run(nextId, chunk.id);
    store.db.prepare(
      "update memory_links set locator = ? where locator = ?"
    ).run(nextId, chunk.id);
    store.db.prepare(
      "update temporary_memory_links set locator = ? where locator = ?"
    ).run(nextId, chunk.id);
    store.db.prepare(
      "update embedding_jobs set owner_id = ? where owner_kind = 'chunk' and owner_id = ?"
    ).run(nextId, chunk.id);
    store.db.prepare(
      "update embedding_vectors set owner_id = ? where owner_kind = 'chunk' and owner_id = ?"
    ).run(nextId, chunk.id);
    remapEvidenceLocators(store, chunk.id, nextId);
    store.db.prepare("delete from chunks where id = ?").run(chunk.id);
    changed += 1;
  }
  return changed;
}

function remapEvidenceReferences(
  store: MemoryStore,
  sourceType: SourceType,
  sourceId: string,
  nextSourceId: string
): void {
  for (const table of ["memory_candidates", "memories", "temporary_memories"] as const) {
    const rows = store.db.prepare(`select id, evidence_json from ${table}`)
      .all() as Array<{ id: string; evidence_json: string }>;
    const update = store.db.prepare(`update ${table} set evidence_json = ? where id = ?`);
    for (const row of rows) {
      const evidence = parseEvidence(row.evidence_json);
      let changed = false;
      const next = evidence.map((item) => {
        if (!evidenceMatchesSource(item, sourceType, sourceId)) return item;
        changed = true;
        return {
          ...item,
          sourceId: nextSourceId,
          ...(item.locator === undefined
            ? {}
            : { locator: item.locator.replace(sourceId, nextSourceId) })
        };
      });
      if (changed) update.run(JSON.stringify(next), row.id);
    }
  }
}

function remapEvidenceLocators(store: MemoryStore, locator: string, nextLocator: string): void {
  for (const table of ["memory_candidates", "memories", "temporary_memories"] as const) {
    const rows = store.db.prepare(`select id, evidence_json from ${table}`)
      .all() as Array<{ id: string; evidence_json: string }>;
    const update = store.db.prepare(`update ${table} set evidence_json = ? where id = ?`);
    for (const row of rows) {
      const evidence = parseEvidence(row.evidence_json);
      let changed = false;
      const next = evidence.map((item) => {
        if (item.locator !== locator) return item;
        changed = true;
        return { ...item, locator: nextLocator };
      });
      if (changed) update.run(JSON.stringify(next), row.id);
    }
  }
  recomputeEvidenceSignatures(store);
}

function recomputeEvidenceSignatures(store: MemoryStore): void {
  for (const table of ["memory_candidates", "memories"] as const) {
    const rows = store.db.prepare(`select id, evidence_json from ${table}`)
      .all() as Array<{ id: string; evidence_json: string }>;
    const update = store.db.prepare(`update ${table} set evidence_signature = ? where id = ?`);
    for (const row of rows) update.run(createEvidenceSignature(parseEvidence(row.evidence_json)), row.id);
  }
}

function redactFileTargets(
  store: MemoryStore,
  table: string,
  keyColumn: string,
  typeColumn: string,
  valueColumn: string,
  changed: () => void
): void {
  const rows = store.db.prepare(
    `select ${quoteIdentifier(keyColumn)} as row_key, ${quoteIdentifier(valueColumn)} as value
     from ${quoteIdentifier(table)}
     where ${quoteIdentifier(typeColumn)} = 'file'`
  ).all() as Array<{ row_key: string; value: string }>;
  const update = store.db.prepare(
    `update ${quoteIdentifier(table)} set ${quoteIdentifier(valueColumn)} = ?
     where ${quoteIdentifier(keyColumn)} = ?`
  );
  for (const row of rows) {
    const next = store.contentPolicy.path(row.value);
    if (next === row.value) continue;
    update.run(next, row.row_key);
    changed();
  }
}

function reconcileStoredEmbeddings(store: MemoryStore): void {
  const providers = readEmbeddingProviders(store);
  for (const provider of providers) {
    store.reconcileEmbeddingJobs(provider);
  }
}

function readEmbeddingProviders(store: MemoryStore): Array<{
  providerKey: string;
  endpointHash: string;
  model: string;
}> {
  return listStoredEmbeddingProviders(store.db);
}

function readEvidenceOwners(
  store: MemoryStore,
  table: "memory_candidates" | "memories" | "temporary_memories",
  sourceId: string,
  sourceType: SourceType
): Array<{ id: string; evidence: EvidenceRef[] }> {
  const rows = store.db.prepare(
    `select id, evidence_json from ${quoteIdentifier(table)}`
  ).all() as Array<{ id: string; evidence_json: string }>;
  return rows.flatMap((row) => {
    const evidence = parseEvidence(row.evidence_json);
    return evidence.some((item) => evidenceMatchesSource(item, sourceType, sourceId))
      ? [{ id: row.id, evidence }]
      : [];
  });
}

function deleteSourceData(
  store: MemoryStore,
  input: {
    sourceId: string;
    sourceType: SourceType;
    sourceIdHash: string;
    sourceOrigin: string;
    timestamp: string;
    operationId: string;
  }
): { deletedCandidates: number; updatedMemories: number; retractedMemories: number } {
  let deletedCandidates = 0;
  let updatedMemories = 0;
  let retractedMemories = 0;
  const affectedCandidates = readEvidenceOwners(
    store,
    "memory_candidates",
    input.sourceId,
    input.sourceType
  );
  for (const candidate of affectedCandidates) {
    store.db.prepare("delete from memory_links where owner_kind = 'candidate' and owner_id = ?")
      .run(candidate.id);
    deletedCandidates += Number(
      store.db.prepare("delete from memory_candidates where id = ?").run(candidate.id).changes
    );
  }

  const affectedMemoriesById = new Map(
    readEvidenceOwners(store, "memories", input.sourceId, input.sourceType)
      .map((memory) => [memory.id, memory])
  );
  if (input.sourceType === "decision") {
    const manualMemory = store.db.prepare(
      `select id, evidence_json from memories
       where id = ? or dedupe_key = ?`
    ).get(
      `memory-manual-${input.sourceId}`,
      `manual-decision:${input.sourceId}`
    ) as { id: string; evidence_json: string } | undefined;
    if (manualMemory) {
      affectedMemoriesById.set(manualMemory.id, {
        id: manualMemory.id,
        evidence: parseEvidence(manualMemory.evidence_json)
      });
    }
  }
  const affectedMemories = [...affectedMemoriesById.values()];
  for (const memory of affectedMemories) {
    const remaining = memory.evidence.filter((evidence) =>
      !evidenceMatchesSource(evidence, input.sourceType, input.sourceId)
    );
    if (remaining.length === 0) {
      const lifecycle = retractedLifecycleValues(input.timestamp);
      store.db.prepare(
        `update memories set evidence_json = '[]', evidence_signature = ?,
           lifecycle_status = 'retracted', valid_until = ?, status_reason = ?,
           status_changed_at = ?, lifecycle_generation = ?
         where id = ?`
      ).run(
        createEvidenceSignature([]),
        lifecycle.validUntil,
        lifecycle.statusReason,
        lifecycle.statusChangedAt,
        lifecycle.lifecycleGeneration,
        memory.id
      );
      retractedMemories += 1;
    } else {
      store.db.prepare(
        `update memories set evidence_json = ?, evidence_signature = ?, lifecycle_generation = ?
         where id = ?`
      ).run(JSON.stringify(remaining), createEvidenceSignature(remaining), randomUUID(), memory.id);
    }
    rebuildMemoryEvidenceLinks(store, memory.id, remaining);
    updatedMemories += 1;
  }

  for (const temporary of readEvidenceOwners(
    store,
    "temporary_memories",
    input.sourceId,
    input.sourceType
  )) {
    const remaining = temporary.evidence.filter((evidence) =>
      !evidenceMatchesSource(evidence, input.sourceType, input.sourceId)
    );
    if (remaining.length === 0) {
      store.db.prepare("delete from temporary_memories where id = ?").run(temporary.id);
    } else {
      store.db.prepare("update temporary_memories set evidence_json = ? where id = ?")
        .run(JSON.stringify(remaining), temporary.id);
      rebuildTemporaryEvidenceLinks(store, temporary.id, remaining);
    }
  }

  const chunks = store.db.prepare("select id from chunks where source_id = ?")
    .all(input.sourceId) as Array<{ id: string }>;
  for (const chunk of chunks) {
    store.db.prepare("delete from embedding_jobs where owner_kind = 'chunk' and owner_id = ?").run(chunk.id);
    store.db.prepare("delete from embedding_vectors where owner_kind = 'chunk' and owner_id = ?").run(chunk.id);
  }
  for (const memory of affectedMemories) {
    store.db.prepare("delete from embedding_jobs where owner_kind = 'memory' and owner_id = ?").run(memory.id);
    store.db.prepare("delete from embedding_vectors where owner_kind = 'memory' and owner_id = ?").run(memory.id);
  }
  store.db.prepare("delete from chunks_fts where source_id = ?").run(input.sourceId);
  store.db.prepare(
    `delete from relations
     where (from_type = 'source' and from_id = ?)
        or (from_type = ? and from_id = ?)
        or (to_type = ? and to_id = ?)`
  ).run(input.sourceId, input.sourceType, input.sourceId, input.sourceType, input.sourceId);
  for (const chunk of chunks) {
    store.db.prepare(
      "delete from relations where (from_type = 'chunk' and from_id = ?) or (to_type = 'chunk' and to_id = ?)"
    ).run(chunk.id, chunk.id);
  }
  store.db.prepare("delete from source_failures where path = ?").run(input.sourceOrigin);
  store.db.prepare("delete from sync_cursors where cursor_key = ?").run(input.sourceOrigin);
  if (input.sourceType === "commit") store.db.prepare("delete from commits where hash = ?").run(input.sourceId);
  if (input.sourceType === "decision") store.db.prepare("delete from decisions where id = ?").run(input.sourceId);
  store.db.prepare("delete from sources where id = ?").run(input.sourceId);
  store.db.prepare(
    `insert into source_tombstones (source_type, source_id_hash, deleted_at, operation_id)
     values (?, ?, ?, ?)
     on conflict(source_type, source_id_hash) do update set
       deleted_at = excluded.deleted_at, operation_id = excluded.operation_id`
  ).run(input.sourceType, input.sourceIdHash, input.timestamp, input.operationId);
  return { deletedCandidates, updatedMemories, retractedMemories };
}

function evidenceMatchesSource(evidence: EvidenceRef, sourceType: SourceType, sourceId: string): boolean {
  return evidence.sourceType === sourceType && evidence.sourceId === sourceId;
}

function parseEvidence(value: string): EvidenceRef[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item): EvidenceRef[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (
      (record.sourceType !== "conversation" && record.sourceType !== "commit" && record.sourceType !== "decision") ||
      typeof record.sourceId !== "string"
    ) return [];
    return [{
      sourceType: record.sourceType,
      sourceId: record.sourceId,
      ...(typeof record.locator === "string" ? { locator: record.locator } : {})
    }];
  });
}

function rebuildMemoryEvidenceLinks(store: MemoryStore, memoryId: string, evidence: EvidenceRef[]): void {
  store.db.prepare(
    `delete from memory_links
     where owner_kind = 'memory' and owner_id = ? and target_type <> 'file'`
  ).run(memoryId);
  const insert = store.db.prepare(
    `insert into memory_links (id, owner_kind, owner_id, target_type, target_id, locator, metadata_json)
     values (?, 'memory', ?, ?, ?, ?, '{}')`
  );
  for (const item of evidence) {
    insert.run(randomUUID(), memoryId, item.sourceType, item.sourceId, item.locator ?? null);
  }
}

function rebuildTemporaryEvidenceLinks(
  store: MemoryStore,
  memoryId: string,
  evidence: EvidenceRef[]
): void {
  store.db.prepare(
    `delete from temporary_memory_links
     where memory_id = ? and target_type <> 'file'`
  ).run(memoryId);
  const insert = store.db.prepare(
    `insert into temporary_memory_links (id, memory_id, target_type, target_id, locator, metadata_json)
     values (?, ?, ?, ?, ?, '{}')`
  );
  for (const item of evidence) {
    insert.run(randomUUID(), memoryId, item.sourceType, item.sourceId, item.locator ?? null);
  }
}

function restoreCommittedFailure(
  store: MemoryStore,
  backupPath: string,
  operationId: string,
  failedAt: string
): void {
  store.db.prepare("attach database ? as recovery").run(backupPath);
  try {
    withTransaction(store.db, () => {
      store.db.exec("pragma defer_foreign_keys = on");
      store.db.prepare("delete from chunks_fts").run();
      store.db.prepare("delete from temporary_memories_fts").run();
      for (const table of [...RESTORE_TABLE_ORDER].reverse()) {
        store.db.prepare(`delete from main.${quoteIdentifier(table)}`).run();
      }
      for (const table of RESTORE_TABLE_ORDER) {
        const columns = RESTORE_COLUMNS[table]!;
        store.db.prepare(
          `insert into main.${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")})
           select ${columns.map(quoteIdentifier).join(", ")}
           from recovery.${quoteIdentifier(table)}`
        ).run();
      }
      rebuildPrivacyDerivedIndexes(store.db);
      store.db.prepare(
        `update operation_log set status = 'failed', completed_at = ?
         where id = ? and status = 'started'`
      ).run(failedAt, operationId);
      assertPrivacyDatabaseIntegrity(store.db);
    });
  } finally {
    store.db.prepare("detach database recovery").run();
  }
}

function classifyRetentionAdapter(source: {
  origin: string;
  metadata_json: string;
}): keyof RetentionConfig["sources"] | "unknown" {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(source.metadata_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    // Fall back to the origin classification.
  }
  const explicit = metadata.adapter ?? metadata.sourceAdapter ?? metadata.source_adapter;
  const candidate = typeof explicit === "string" ? explicit.toLowerCase() : source.origin.toLowerCase();
  if (candidate.includes("git")) return "git";
  if (candidate.includes("codex")) return "codex";
  if (candidate.includes("claude")) return "claude";
  if (candidate.includes("manual") || candidate.includes("decision")) return "manual";
  return "unknown";
}

function redactExportValue(value: unknown, store: MemoryStore): unknown {
  if (typeof value === "string") return redactWithPolicy(value, store.contentPolicy.privacyPolicy).text;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map((item) => redactExportValue(item, store));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactExportValue(item, store)])
  );
}

function stringsInValue(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return [value, ...stringsInJson(JSON.parse(value))];
    } catch {
      return [value];
    }
  }
  return [value];
}

function stringsInJson(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsInJson);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [key, ...stringsInJson(item)]);
}

function writeJsonAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}
