import { z } from "zod";
import { b64, documentHash, hashSchema, type SignedVaultRecord } from "./identity-protocol.js";
import { UUID } from "./state.js";
import { commitment, type EncryptedEnvelope } from "./encrypted-protocol.js";
import { EncryptionError } from "./crypto-helper.js";

export const receiptSchema = z.object({ record: z.object({
  kind: z.literal("revision"), version: z.literal(1), vaultId: UUID, projectId: UUID,
  epoch: z.number().int().positive(), membership: hashSchema, revision: z.number().int().positive(),
  parentCommitment: hashSchema.nullable(), commitment: hashSchema, writer: b64.length(44)
}).strict(), signature: b64.length(88) }).strict();
export type RevisionReceipt = z.infer<typeof receiptSchema>;
export function receiptRecord(vaultId: string, envelope: EncryptedEnvelope): RevisionReceipt["record"] {
  return { kind: "revision", version: 1, vaultId, projectId: envelope.projectId, epoch: envelope.epoch, membership: envelope.membership,
    revision: envelope.revision, parentCommitment: envelope.parentCommitment, commitment: commitment(envelope), writer: envelope.writer };
}
export function receiptAuthority(receipt: RevisionReceipt, history: SignedVaultRecord[]): void {
  const membership = history.find(r => documentHash(r) === receipt.record.membership);
  if (!membership || membership.record.vaultId !== receipt.record.vaultId || membership.record.projects[receipt.record.projectId] !== receipt.record.epoch
    || !membership.record.devices.some(d => d.signingKey === receipt.record.writer)) throw new EncryptionError("verification-failed");
}
