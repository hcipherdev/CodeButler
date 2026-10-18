import { EncryptionError } from "./crypto-helper.js";
import { saveBinding, type Binding } from "./state.js";

export type CloudSyncCondition =
  | "synced"
  | "offline-network"
  | "deferred"
  | "authentication"
  | "conflict"
  | "upgrade-required"
  | "integrity-failure"
  | "unbound"
  | "disabled";

export interface ClassifiedCloudSyncError {
  condition: Exclude<CloudSyncCondition, "synced" | "unbound" | "disabled">;
  message: string;
}

export function classifyCloudSyncError(error: unknown): ClassifiedCloudSyncError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof EncryptionError) {
    if (error.state === "conflict") return { condition: "conflict", message };
    if (error.state === "upgrade-required" || error.state === "incompatible-format") {
      return { condition: "upgrade-required", message };
    }
    if (error.state === "verification-failed") return { condition: "integrity-failure", message };
    if (["authentication-required", "enrollment-required", "revoked", "recovery-required", "locked"].includes(error.state)) {
      return { condition: "authentication", message };
    }
    return { condition: "deferred", message };
  }
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return { condition: "authentication", message };
  if (status === 409) return { condition: "conflict", message };
  if (/schema version|upgrade required|newer schema|incompatible (?:schema|format)/i.test(message)) {
    return { condition: "upgrade-required", message };
  }
  if (/checksum|fingerprint mismatch|integrity|corrupt|verification failed|foreign_key_check|quick_check/i.test(message)) {
    return { condition: "integrity-failure", message };
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (
    (typeof code === "string" && ["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EAI_AGAIN"].includes(code)) ||
    /offline|unavailable|network|timed out|timeout|fetch failed/i.test(message)
  ) {
    return { condition: "offline-network", message };
  }
  return { condition: "deferred", message };
}

export function recordCloudSyncError(root: string, state: Binding, error: unknown): ClassifiedCloudSyncError {
  const classified = classifyCloudSyncError(error);
  state.status = classified.condition;
  state.syncCondition = classified.condition;
  state.syncError = classified.message.slice(0, 1_000);
  saveBinding(root, state);
  return classified;
}

export function recordCloudSyncSuccess(root: string, state: Binding): void {
  state.syncCondition = "synced";
  delete state.syncError;
  saveBinding(root, state);
}
