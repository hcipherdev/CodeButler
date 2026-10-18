import { EncryptionError } from "./crypto-helper.js";
export type OperationStage = "cloud" | "ingestion" | "summary" | "watcher";
export interface OperationOutcome { outcome: "success" | "deferred" | "failed"; stage: OperationStage; reason?: string }
export class OperationDeferredError extends Error {
  constructor(message: string, readonly stage: OperationStage = "cloud") { super(message); this.name = "OperationDeferredError"; }
}
export function errorOutcome(error: unknown, stage: OperationStage): OperationOutcome {
  return { outcome: error instanceof OperationDeferredError || (error instanceof EncryptionError && error.state === "lease-expired") ? "deferred" : "failed", stage,
    reason: error instanceof Error ? error.message : String(error) };
}
