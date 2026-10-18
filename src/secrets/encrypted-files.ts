import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";
import { EncryptionError } from "../cloud/crypto-helper.js";
import { commitment, decodeEnvelope, EMPTY_PIN, HASH, unsignedEnvelope, type EncryptedEnvelope, type RevisionPin } from "../cloud/encrypted-protocol.js";
import { verifyAdvance, verifyEnvelope, writerInstallation, type EncryptedBundle, type ProjectTrust } from "../cloud/encrypted-snapshot.js";
import type { NativeSecurity } from "../cloud/native-security.js";
import { sha256 } from "../cloud/state.js";
import { SECRET_BLOCK_SIZE, materializeSecretFiles, validateSecretManifest, type SecretBundle } from "./files.js";

const metadataSchema = z.object({ manifest: z.unknown(), blocks: z.record(HASH, HASH) }).strict();
export interface VerifiedSecrets extends EncryptedBundle { bundle: SecretBundle; pin: RevisionPin }
function fail(): never { throw new EncryptionError("verification-failed"); }

export async function sealSecretFolder(helper: NativeSecurity, trust: ProjectTrust, bundle: SecretBundle, previous?: VerifiedSecrets): Promise<EncryptedBundle> {
  if (helper.domain !== "secrets") fail();
  const manifest = validateSecretManifest(bundle.manifest);
  materializeSecretFiles(bundle);
  if (manifest.projectId !== trust.projectId || manifest.parentRevision !== (previous?.pin.revision ?? 0)) fail();
  const identity = await helper.signEnvelope(trust, Buffer.alloc(0));
  if (!trust.records.at(-1)?.record.devices.some(d => d.signingKey === identity.publicKey && d.installationId === manifest.installationId)) fail();
  const reusable = previous?.envelope.epoch === trust.epoch ? await readMetadata(helper, trust, previous.envelope) : undefined;
  const mapping: Record<string, string> = {}, objects = new Map<string, Buffer>();
  const hashes = [...new Set(manifest.files.flatMap(file => file.blocks))];
  const fresh: Array<[string, Buffer]> = [];
  for (const hash of hashes) {
    const plain = bundle.blocks.get(hash);
    if (!plain || plain.length > SECRET_BLOCK_SIZE || sha256(plain) !== hash) fail();
    const address = reusable?.blocks[hash], cached = address ? previous?.objects.get(address) : undefined;
    if (address && cached && sha256(cached) === address) { mapping[hash] = address; objects.set(address, cached); }
    else fresh.push([hash, gzipSync(plain)]);
  }
  for (let i = 0; i < fresh.length; i += 128) {
    const batch = fresh.slice(i, i + 128);
    const sealed = await helper.sealOrOpen("seal", trust, "block", batch.map(([, bytes]) => bytes));
    sealed.forEach((bytes, j) => { const address = sha256(bytes); mapping[batch[j]![0]] = address; objects.set(address, bytes); });
  }
  const [ciphertext] = await helper.sealOrOpen("seal", trust, "manifest", [gzipSync(Buffer.from(JSON.stringify({ manifest, blocks: mapping })))]);
  const unsigned: Omit<EncryptedEnvelope, "signature"> = {
    format: "code-butler-encrypted", version: 2, suite: "HKDF-SHA256/ChaCha20-Poly1305/Ed25519",
    projectId: trust.projectId, epoch: trust.epoch, membership: trust.membership, revision: manifest.parentRevision + 1,
    parentCommitment: previous?.pin.commitment ?? null, writer: identity.publicKey,
    objects: [...objects.keys()].sort(), manifest: ciphertext!.toString("base64")
  };
  const { signature } = await helper.signEnvelope(trust, unsignedEnvelope(unsigned));
  return { envelope: { ...unsigned, signature }, objects };
}

async function readMetadata(helper: NativeSecurity, trust: ProjectTrust, envelope: EncryptedEnvelope): Promise<z.infer<typeof metadataSchema>> {
  try {
    const [bytes] = await helper.sealOrOpen("open", { ...trust, epoch: envelope.epoch }, "manifest", [Buffer.from(envelope.manifest, "base64")]);
    return metadataSchema.parse(JSON.parse(gunzipSync(bytes!, { maxOutputLength: 16 * 1024 * 1024 }).toString()));
  } catch { return fail(); }
}

export async function openSecretFolder(helper: NativeSecurity, trust: ProjectTrust, encrypted: EncryptedBundle, previous?: VerifiedSecrets, authenticatedPin?: RevisionPin): Promise<VerifiedSecrets> {
  if (helper.domain !== "secrets") fail();
  const envelope = decodeEnvelope(Buffer.from(JSON.stringify(encrypted.envelope)));
  if (envelope.projectId !== trust.projectId) fail();
  const pin = authenticatedPin ?? await verifyAdvance(helper, trust, previous?.pin ?? EMPTY_PIN, [envelope]);
  await verifyEnvelope(helper, trust, envelope);
  if (pin.revision !== envelope.revision || pin.commitment !== commitment(envelope)) fail();
  const metadata = await readMetadata(helper, trust, envelope), manifest = validateSecretManifest(metadata.manifest);
  if (manifest.projectId !== trust.projectId || manifest.parentRevision !== envelope.revision - 1
    || writerInstallation(trust, envelope) !== manifest.installationId) fail();
  const hashes = [...new Set(manifest.files.flatMap(file => file.blocks))];
  if (hashes.length !== Object.keys(metadata.blocks).length || hashes.some(hash => !metadata.blocks[hash])) fail();
  if (JSON.stringify([...new Set(Object.values(metadata.blocks))].sort()) !== JSON.stringify(envelope.objects)) fail();
  const blocks = new Map<string, Buffer>();
  for (let i = 0; i < hashes.length; i += 128) {
    const batch = hashes.slice(i, i + 128), ciphertext = batch.map(hash => {
      const address = metadata.blocks[hash]!, bytes = encrypted.objects.get(address);
      if (!bytes || sha256(bytes) !== address) return fail();
      return bytes;
    });
    const opened = await helper.sealOrOpen("open", { ...trust, epoch: envelope.epoch }, "block", ciphertext);
    try { opened.forEach((bytes, j) => { const plain = gunzipSync(bytes, { maxOutputLength: SECRET_BLOCK_SIZE }); if (sha256(plain) !== batch[j]) fail(); blocks.set(batch[j]!, plain); }); }
    catch { return fail(); }
  }
  const bundle = { manifest, blocks };
  materializeSecretFiles(bundle);
  return { envelope, objects: encrypted.objects, bundle, pin };
}
