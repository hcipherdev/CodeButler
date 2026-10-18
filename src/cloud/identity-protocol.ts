import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { SecurityError } from "./protocol-types.js";
import { sha256, UUID } from "./state.js";
import { isProjectCatalogId, isSecretsResourceId } from "./resource-identity.js";

/** Error text for a missing or expired device nonce; raised before a request has any effect, so clients may retry it. */
export const DEVICE_NONCE_EXPIRED = "Device nonce expired";
export const b64 =z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const deviceSchema = z.object({ id: UUID, installationId: UUID, label: z.string().min(1).max(100), signingKey: b64.length(44), kemKey: b64.length(1624) }).strict();
export const descriptorSchema = z.object({ version: z.literal(1), vaultId: UUID, accountId: UUID, firstDevice: deviceSchema, recoverySigning: b64.length(44), recoveryKem: b64.length(1624),
  rosterSource: z.object({ vaultId: UUID, commitment: hashSchema }).strict().optional() }).strict();
const packageSchema = z.object({ kem: b64.length(1496), ciphertext: b64.min(40).max(2 * 1024 * 1024) }).strict();
export const vaultRecordSchema = z.object({
  version: z.literal(1), kind: z.literal("vault"), vaultId: UUID, accountId: UUID,
  descriptor: hashSchema, sequence: z.number().int().positive().max(10000), parent: hashSchema.nullable(),
  issuer: b64.length(44), action: z.enum(["init", "enroll", "project", "revoke", "recover"]),
  requestHash: hashSchema.nullable(), devices: z.array(deviceSchema).min(1).max(10),
  projects: z.record(UUID, z.number().int().positive()), packages: z.record(UUID, packageSchema), recovery: packageSchema
}).strict().refine(record => {
  const ids = Object.keys(record.projects), parents = ids.filter(id => id[14] === "4");
  return ids.length <= 21 && ids.filter(id => !isProjectCatalogId(id, record.vaultId) && !isSecretsResourceId(id, parents)).length <= 10;
});
export const signedVaultSchema = z.object({ record: vaultRecordSchema, signature: b64.length(88) }).strict();
const enrollmentFields = { accountId: UUID, vaultId: UUID, device: deviceSchema, requestId: UUID, expiresAt: z.number().int().positive() };
export const legacyEnrollmentSchema = z.object({ record: z.object({ kind: z.literal("enrollment"), version: z.literal(1), ...enrollmentFields }).strict(), signature: b64.length(88) }).strict();
// A distinct kind ensures older native helpers cannot approve without checking the descriptor pin.
export const anchoredEnrollmentSchema = z.object({ record: z.object({ kind: z.literal("enrollment-v2"), version: z.literal(2), ...enrollmentFields, descriptorHash: hashSchema }).strict(), signature: b64.length(88) }).strict();
export const enrollmentSchema = z.union([legacyEnrollmentSchema, anchoredEnrollmentSchema]);
export type DeviceIdentity = z.infer<typeof deviceSchema>;
export type VaultDescriptor = z.infer<typeof descriptorSchema>;
export type SignedVaultRecord = z.infer<typeof signedVaultSchema>;
export type EnrollmentRequest = z.infer<typeof enrollmentSchema>;
export interface SignedDocument<T = unknown> { record: T; signature: string }

/** Matches serde_json's sorted object keys. Protocol strings are Unicode, numbers safe integers. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new SecurityError(400, "verification-failed");
  const encoded = JSON.stringify(value); if (encoded === undefined) throw new SecurityError(400, "verification-failed"); return encoded;
}
export const documentHash = (value: unknown) => sha256(canonical(value));
export function verifyDocument(document: SignedDocument, publicKey: string): void {
  try {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(b64.length(44).parse(publicKey), "base64")]), format: "der", type: "spki" });
    if (!verify(null, Buffer.concat([Buffer.from("code-butler/identity/v1\0"), Buffer.from(canonical(document.record))]), key, Buffer.from(b64.length(88).parse(document.signature), "base64"))) throw new Error();
  } catch { throw new SecurityError(400, "verification-failed"); }
}
export function validateVaultRecord(descriptor: VaultDescriptor, signed: SignedVaultRecord, previous?: SignedVaultRecord): void {
  const record = signed.record;
  if (record.descriptor !== documentHash(descriptor) || record.vaultId !== descriptor.vaultId || record.accountId !== descriptor.accountId
    || record.sequence !== (previous?.record.sequence ?? 0) + 1 || record.parent !== (previous ? documentHash(previous) : null)) throw new SecurityError(409, "conflict");
  const ids = new Set(record.devices.map(d => d.id)), signing = new Set(record.devices.map(d => d.signingKey)), kem = new Set(record.devices.map(d => d.kemKey));
  if ([ids.size, signing.size, kem.size].some(n => n !== record.devices.length) || canonical(Object.keys(record.packages).sort()) !== canonical([...ids].sort())) throw new SecurityError(400, "verification-failed");
  if (!previous) {
    if (record.action !== "init" || (!descriptor.rosterSource && canonical(record.devices) !== canonical([descriptor.firstDevice]))
      || descriptor.rosterSource && !record.devices.some(d => canonical(d) === canonical(descriptor.firstDevice))
      || record.issuer !== descriptor.firstDevice.signingKey || Object.keys(record.projects).length) throw new SecurityError(400, "verification-failed");
  } else {
    if (record.action === "init") throw new SecurityError(400, "verification-failed");
    if (record.action === "recover") {
      if (record.issuer !== descriptor.recoverySigning || record.devices.length !== 1) throw new SecurityError(403, "verification-failed");
    } else if (!previous.record.devices.some(d => d.signingKey === record.issuer)) throw new SecurityError(403, "revoked");
    const oldIds = new Set(previous.record.devices.map(d => d.id));
    for (const d of record.devices) {
      const old = previous.record.devices.find(p => p.id === d.id);
      if (old && canonical(old) !== canonical(d)) throw new SecurityError(400, "verification-failed");
    }
    if (record.action === "enroll" && (record.devices.length !== oldIds.size + 1 || previous.record.devices.some(d => !ids.has(d.id)) || canonical(record.projects) !== canonical(previous.record.projects) || !record.requestHash)) throw new SecurityError(400, "verification-failed");
    if (record.action === "project" && (canonical(record.devices) !== canonical(previous.record.devices) || Object.keys(record.projects).length !== Object.keys(previous.record.projects).length + 1 || Object.entries(previous.record.projects).some(([id,epoch]) => record.projects[id] !== epoch) || Object.entries(record.projects).some(([id,epoch]) => !previous.record.projects[id] && epoch !== 1))) throw new SecurityError(400, "verification-failed");
    if (record.action === "revoke" && (record.devices.length !== oldIds.size - 1 || record.devices.some(d => !oldIds.has(d.id)))) throw new SecurityError(400, "verification-failed");
    if (["revoke", "recover"].includes(record.action) && (canonical(Object.keys(record.projects).sort()) !== canonical(Object.keys(previous.record.projects).sort()) || Object.entries(previous.record.projects).some(([id,epoch]) => record.projects[id] !== epoch + 1))) throw new SecurityError(400, "verification-failed");
  }
  verifyDocument(signed, record.issuer);
}
