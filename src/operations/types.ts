import type { MemoryLifecycleStatus, SourceType } from "../types.js";

export const OPERATION_TYPES = [
  "migration",
  "lifecycle_change",
  "redaction",
  "deletion",
  "export",
  "import",
  "retention_prune",
  "recovery"
] as const;

export const OPERATION_STATUSES = ["started", "completed", "failed"] as const;
export const OPERATION_ACTORS = ["cli", "mcp", "system"] as const;

export type OperationType = typeof OPERATION_TYPES[number];
export type OperationStatus = typeof OPERATION_STATUSES[number];
export type OperationActor = typeof OPERATION_ACTORS[number];

export interface IdentifierCountCategoryMetadata {
  identifier?: string | undefined;
  count?: number | undefined;
  category?: string | undefined;
}

export interface OperationMetadataByType {
  migration: { migrationVersion?: number | undefined };
  lifecycle_change: {
    memoryIdHash?: string | undefined;
    previousStatus?: MemoryLifecycleStatus | undefined;
    newStatus?: MemoryLifecycleStatus | undefined;
    replacementMemoryIdHash?: string | undefined;
  };
  redaction: IdentifierCountCategoryMetadata;
  deletion: {
    sourceType?: SourceType | undefined;
    sourceIdHash?: string | undefined;
    count?: number | undefined;
  };
  export: IdentifierCountCategoryMetadata;
  import: IdentifierCountCategoryMetadata;
  retention_prune: IdentifierCountCategoryMetadata;
  recovery: IdentifierCountCategoryMetadata;
}

export type OperationMetadata = OperationMetadataByType[OperationType];

export interface OperationLogEntry<T extends OperationType = OperationType> {
  id: string;
  operationType: T;
  status: OperationStatus;
  startedAt: string;
  completedAt?: string | undefined;
  actor: OperationActor;
  metadata: OperationMetadataByType[T];
}

export type BeginOperationInput<T extends OperationType = OperationType> = T extends OperationType ? {
    operationType: T;
    actor: OperationActor;
    metadata?: OperationMetadataByType[T] | undefined;
    startedAt?: string | undefined;
  } : never;

export interface FinishOperationInput {
  completedAt?: string | undefined;
}

export interface ListOperationsInput {
  operationType?: OperationType | undefined;
  status?: OperationStatus | undefined;
  actor?: OperationActor | undefined;
  limit?: number | null | undefined;
}

export interface CreateSourceTombstoneInput {
  sourceType: SourceType;
  sourceId: string;
  actor: OperationActor;
  deletedAt?: string | undefined;
}

export interface SourceTombstone {
  sourceType: SourceType;
  sourceIdHash: string;
  deletedAt: string;
  operationId: string;
}
