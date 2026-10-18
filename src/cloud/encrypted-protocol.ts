import { z } from "zod";
import { sha256, UUID } from "./state.js";
import { EncryptionError } from "./crypto-helper.js";

export const MAX_ENCRYPTED_OBJECT = 64 * 1024 + 1024;
export const MAX_ENVELOPE = 16 * 1024 * 1024;
export const HASH = z.string().regex(/^[a-f0-9]{64}$/);
const base64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const envelopeSchema = z.object({
  format: z.literal("code-butler-encrypted"), version: z.literal(2),
  suite: z.literal("HKDF-SHA256/ChaCha20-Poly1305/Ed25519"),
  projectId: UUID, epoch: z.number().int().positive(), membership: HASH,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  parentCommitment: HASH.nullable(),
  writer: base64.length(44),
  objects: z.array(HASH).max(32768),
  manifest: base64.min(80).max(MAX_ENVELOPE),
  signature: base64.length(88)
}).strict();
export type EncryptedEnvelope = z.infer<typeof envelopeSchema>;
export interface RevisionPin { revision: number; commitment: string }
export const EMPTY_PIN: RevisionPin = { revision: 0, commitment: "" };

/** Explicit field order is the cross-language signing contract. */
export function unsignedEnvelope(envelope: Omit<EncryptedEnvelope, "signature">): Buffer {
  return Buffer.from(JSON.stringify({
    format: envelope.format, version: envelope.version, suite: envelope.suite,
    projectId: envelope.projectId, epoch: envelope.epoch, membership: envelope.membership, revision: envelope.revision,
    parentCommitment: envelope.parentCommitment, writer: envelope.writer,
    objects: envelope.objects, manifest: envelope.manifest
  }));
}
export function encodeEnvelope(envelope: EncryptedEnvelope): Buffer {
  return Buffer.from(JSON.stringify({ ...JSON.parse(unsignedEnvelope(envelope).toString()), signature: envelope.signature }));
}
export function commitment(envelope: EncryptedEnvelope): string { return sha256(encodeEnvelope(envelope)); }
export function decodeEnvelope(bytes: Buffer): EncryptedEnvelope {
  try {
    if (bytes.length > MAX_ENVELOPE) throw new Error();
    const value: unknown = JSON.parse(bytes.toString());
    if (!value || typeof value !== "object" || !("format" in value) || value.format !== "code-butler-encrypted" || !("version" in value) || value.version !== 2) throw new EncryptionError("incompatible-format");
    const parsed = envelopeSchema.parse(value);
    if ((parsed.revision === 1) !== (parsed.parentCommitment === null)) throw new Error();
    if (parsed.objects.some((hash, i) => i > 0 && hash <= parsed.objects[i - 1]!)) throw new Error();
    // One canonical wire form prevents commitment aliases, including whitespace.
    if (!encodeEnvelope(parsed).equals(bytes)) throw new Error();
    return parsed;
  } catch (error) {
    if (error instanceof EncryptionError) throw error;
    throw new EncryptionError("verification-failed");
  }
}
