// Wire types and errors shared by the sync client and the hosted service.
// Client modules import these definitions from here, never from the service
// implementation, which is not part of this package.
import type { RevisionPin } from "./encrypted-protocol.js";
import type { EnrollmentRequest, SignedVaultRecord, VaultDescriptor } from "./identity-protocol.js";

export type SecurityState = "authentication-required" | "enrollment-required" | "locked" | "revoked" | "recovery-required" | "conflict" | "incompatible-format" | "verification-failed" | "upgrade-required";
export class SecurityError extends Error {
  constructor(readonly status: number, readonly state: SecurityState, message = state as string) { super(message); }
}

export interface AccountSession { id: string; accountId: string; deviceId: string | null; createdAt: number }
export interface AccountProfile { id: string; email: string; createdAt: number; passwordSet: boolean; passkeyCount: number }
export interface SessionTokens { accessToken: string; refreshToken: string; accessExpiresAt: number; accountId: string }

export interface VaultState { descriptor: VaultDescriptor; records: SignedVaultRecord[] }
/** Only the records after `after`: the caller already holds the chain up to that sequence. */
export interface VaultStateUpdate extends VaultState { after: number }
export type EnrollmentStatus = "pending" | "approved" | "complete" | "cancelled" | "expired";
export interface EnrollmentState { request: EnrollmentRequest; status: EnrollmentStatus; approval: string | null }

export interface SecretsMigrationIntent {
  legacyVaultId: string; parentProjectId: string; resourceId: string;
  sourcePin: RevisionPin; state: "preparing" | "migrated"; destinationPin?: RevisionPin;
}

/** Response of `GET /v2/projects/{id}/storage`. */
export interface StorageUsageReport {
  project: {
    id: string; currentSnapshotBytes: number; retainedRevisions: number; referencedBytes: number; activeUploadBytes: number;
    reclaimableBytes: number; objectBytes: number; metadataBytes: number; totalBytes: number; acceleratedCleanup: boolean;
  };
  vault: { usageBytes: number; limitBytes: number };
  global: { usageBytes: number; limitBytes: number };
  retainedRevisionLimit: number;
}
