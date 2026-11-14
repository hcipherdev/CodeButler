import { isNetworkUnavailable } from "./network.js";
import { EncryptionError } from "./crypto-helper.js";
export type OperationStage = "cloud" | "ingestion" | "summary" | "watcher";
/** `network` marks a pass that could not reach the network at all, so the watcher can pause instead of retrying. */
export interface OperationOutcome { outcome: "success" | "deferred" | "failed"; stage: OperationStage; reason?: string; network?: true }
export class OperationDeferredError extends Error {
  constructor(message: string, readonly stage: OperationStage = "cloud") { super(message); this.name = "OperationDeferredError"; }
}
export function errorOutcome(error: unknown, stage: OperationStage): OperationOutcome {
  return { outcome: error instanceof OperationDeferredError || (error instanceof EncryptionError && error.state === "lease-expired") ? "deferred" : "failed", stage,
    reason: error instanceof Error ? error.message : String(error), ...(isNetworkUnavailable(error) ? { network: true as const } : {}) };
}
