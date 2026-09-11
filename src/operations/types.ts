import type { MemoryLifecycleStatus, SourceType } from "../types.js";

export const OPERATION_TYPES = [
  "migration",
  "lifecycle_change",
  "scope_change",
  "layer_change",
  "branch_triage",
  "automatic_promotion",
  "layer_retention",
  "cloud_merge",
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
export type BranchTriageAction = "promote_to_core" | "discard" | "retain_branch";
export type AutomaticPromotionDecisionKind = "promote" | "converge" | "defer" | "skip";
export type LayerRetentionDecisionKind = "archive" | "skip";

export interface IdentifierCountCategoryMetadata {
  identifier?: string | undefined;
  count?: number | undefined;
  category?: string | undefined;
}

export interface OperationMetadataByType {
  scope_change: { memoryIdHash?: string; reasonHash?: string; category?: string };
  layer_change: { memoryIdHash?: string; reasonHash?: string; category?: string };
  branch_triage: {
    memoryIdHash?: string;
    branchHash?: string;
    reasonHash?: string;
    category?: string;
    action?: BranchTriageAction;
    promotedMemoryIdHash?: string;
    supersedesMemoryIdHash?: string;
  };
  automatic_promotion: {
    memoryIdHash?: string;
    coreMemoryIdHash?: string;
    category?: string;
    decision?: AutomaticPromotionDecisionKind;
    reasonCodesHash?: string;
    policyVersion?: number;
  };
  layer_retention: {
    memoryIdHash?: string;
    category?: string;
    decision?: LayerRetentionDecisionKind;
    reasonCodesHash?: string;
    policyVersion?: number;
  };
  cloud_merge: IdentifierCountCategoryMetadata;
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
