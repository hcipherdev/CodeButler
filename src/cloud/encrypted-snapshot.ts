import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";
import { EncryptionError } from "./crypto-helper.js";
import { NativeSecurity } from "./native-security.js";
import { documentHash, type SignedVaultRecord } from "./identity-protocol.js";
import { commitment, decodeEnvelope, EMPTY_PIN, HASH, unsignedEnvelope, type EncryptedEnvelope, type RevisionPin } from "./encrypted-protocol.js";
import { bundleResolver, decodeSnapshot, materializeSnapshot, verifySnapshotDatabase, BLOCK_SIZE, SMALL_CORE_BLOCK_SIZE, type Snapshot, type SnapshotBundle } from "./snapshot.js";
import { partitionCheckout } from "./partition.js";
import { sha256 } from "./state.js";

/** Authenticated by Rust against the locally pinned descriptor and registry chain. */
export interface ProjectTrust {
  projectId: string;
  epoch: number;
  membership: string;
  records: SignedVaultRecord[];
  staged?: boolean;
}
export interface EncryptedBundle { envelope: EncryptedEnvelope; objects: Map<string, Buffer> }
export interface VerifiedSnapshot extends EncryptedBundle { bundle: SnapshotBundle; pin: RevisionPin }
const metadataSchema = z.object({ snapshot: z.unknown(), blocks: z.record(HASH, HASH) }).strict();

function verificationFailed(): never { throw new EncryptionError("verification-failed"); }
function assertTrust(trust: ProjectTrust): void {
  if (!trust.records.length) throw new EncryptionError("enrollment-required");
}
export function writerInstallation(trust: ProjectTrust, envelope: EncryptedEnvelope): string | undefined {
  const membership = trust.records.find(r => documentHash(r) === envelope.membership);
  if (membership?.record.projects[trust.projectId] !== envelope.epoch) return undefined;
  return membership.record.devices.find(d => d.signingKey === envelope.writer)?.installationId;
}
export async function verifyEnvelope(helper: NativeSecurity, trust: ProjectTrust, envelope: EncryptedEnvelope): Promise<void> {
  assertTrust(trust);
  decodeEnvelope(Buffer.from(JSON.stringify(envelope)));
  if (envelope.projectId !== trust.projectId || !writerInstallation(trust, envelope)) verificationFailed();
  await helper.verifyEnvelope({ projectId: trust.projectId, epoch: envelope.epoch }, envelope.writer, envelope.signature, unsignedEnvelope(envelope));
}

/** All supplied links must be signed, contiguous, and rooted at the local pin. */
export async function verifyAdvance(helper: NativeSecurity, trust: ProjectTrust, pin: RevisionPin, chain: EncryptedEnvelope[]): Promise<RevisionPin> {
  let accepted = pin;
  for (const envelope of chain) {
    await verifyEnvelope(helper, trust, envelope);
    const hash = commitment(envelope);
    if (envelope.revision === accepted.revision && hash === accepted.commitment) continue;
    if (envelope.revision !== accepted.revision + 1 || envelope.parentCommitment !== (accepted.commitment || null)) verificationFailed();
    accepted = { revision: envelope.revision, commitment: hash };
  }
  return accepted;
}

/** Validate peer ownership on the client, before signing or applying a transition. */
export function assertPartitionTransition(previous: Snapshot | undefined, next: Snapshot): void {
  const owns = (segment: Snapshot["segments"][number]) => segment.kind === "partition"
    && segment.writerInstallationId === next.installationId
    && partitionCheckout(segment.id) === next.checkoutId;
  const peers = (snapshot: Snapshot | undefined) => new Map((snapshot?.segments ?? [])
    .filter(segment => segment.kind === "partition" && !owns(segment))
    .map(segment => [segment.id, JSON.stringify(segment)]));
  const before = peers(previous), after = peers(next);
  if (before.size !== after.size || [...before].some(([id, value]) => after.get(id) !== value)) verificationFailed();
}

/** Carry every other checkout's partition forward; the server cannot perform this. */
export function rebasePartitions(local: SnapshotBundle, head: VerifiedSnapshot, allowCoreEdit = false): SnapshotBundle {
  if (local.manifest.projectId !== head.bundle.manifest.projectId) verificationFailed();
  // This is a partition-only rebase, never an implicit choice between core edits.
  if (!allowCoreEdit && local.manifest.fingerprint !== head.bundle.manifest.fingerprint) throw new Error("Encrypted core conflict requires a local merge");
  const owns = (segment: Snapshot["segments"][number]) => segment.kind === "partition"
    && segment.writerInstallationId === local.manifest.installationId
    && partitionCheckout(segment.id) === local.manifest.checkoutId;
  const manifest: Snapshot = {
    ...local.manifest, parentRevision: head.pin.revision,
    segments: [
      ...local.manifest.segments.filter(segment => segment.kind !== "partition" || owns(segment)),
      ...head.bundle.manifest.segments.filter(segment => segment.kind === "partition" && !owns(segment))
    ]
  };
  assertPartitionTransition(head.bundle.manifest, manifest);
  return { manifest, blocks: new Map([...head.bundle.blocks, ...local.blocks]) };
}

function validateBundle(bundle: SnapshotBundle): void {
  const materialized = materializeSnapshot(bundle.manifest, bundleResolver(bundle.blocks));
  const directory = mkdtempSync(join(tmpdir(), "butler-verify-"));
  try {
    const path = join(directory, "memory.sqlite");
    writeFileSync(path, materialized.files.find(file => file.path === "memory.sqlite")!.data, { mode: 0o600 });
    verifySnapshotDatabase(bundle.manifest, path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export async function sealSnapshot(helper: NativeSecurity, trust: ProjectTrust, bundle: SnapshotBundle, previous?: VerifiedSnapshot): Promise<EncryptedBundle> {
  assertTrust(trust);
  const snapshot = decodeSnapshot(gzipSync(Buffer.from(JSON.stringify(bundle.manifest))));
  if (snapshot.projectId !== trust.projectId || snapshot.parentRevision !== (previous?.pin.revision ?? 0)) verificationFailed();
  if (previous && previous.envelope.projectId !== trust.projectId) verificationFailed();
  assertPartitionTransition(previous?.bundle.manifest, snapshot);
  validateBundle(bundle);
  const identity = await helper.signEnvelope(trust, Buffer.alloc(0));
  if (!trust.records.at(-1)!.record.devices.some(d => d.signingKey === identity.publicKey && d.installationId === snapshot.installationId)) verificationFailed();
  const mapping: Record<string, string> = {};
  const objects = new Map<string, Buffer>();
  // The previous authenticated mapping is reconstructed from its verified plaintext.
  const reusable = previous && previous.envelope.epoch === trust.epoch ? await readMetadata(helper, trust, previous.envelope) : undefined;
  const hashes = [...new Set(snapshot.segments.flatMap(segment => segment.blocks))];
  const fresh: Array<[string, Buffer]> = [];
  for (const hash of hashes) {
    const plain = bundle.blocks.get(hash);
    if (!plain || plain.length > BLOCK_SIZE || sha256(plain) !== hash) verificationFailed();
    const address = reusable?.blocks[hash];
    const reused = address ? previous?.objects.get(address) : undefined;
    if (address && reused && sha256(reused) === address) { mapping[hash] = address; objects.set(address, reused); }
    else fresh.push([hash, gzipSync(plain)]);
  }
  for (let i = 0; i < fresh.length; i += 128) {
    const batch = fresh.slice(i, i + 128);
    const sealed = await helper.sealOrOpen("seal", trust, "block", batch.map(([, data]) => data));
    sealed.forEach((data, j) => { const address = sha256(data); mapping[batch[j]![0]] = address; objects.set(address, data); });
  }
  const metadata = gzipSync(Buffer.from(JSON.stringify({ snapshot, blocks: mapping })));
  const [encrypted] = await helper.sealOrOpen("seal", trust, "manifest", [metadata]);
  const unsigned: Omit<EncryptedEnvelope, "signature"> = {
    format: "code-butler-encrypted", version: 2, suite: "HKDF-SHA256/ChaCha20-Poly1305/Ed25519",
    projectId: trust.projectId, epoch: trust.epoch, membership: trust.membership, revision: (previous?.pin.revision ?? 0) + 1,
    parentCommitment: previous?.pin.commitment ?? null, writer: identity.publicKey,
    objects: [...objects.keys()].sort(), manifest: encrypted!.toString("base64")
  };
  const { signature } = await helper.signEnvelope(trust, unsignedEnvelope(unsigned));
  return { envelope: { ...unsigned, signature }, objects };
}

async function readMetadata(helper: NativeSecurity, trust: ProjectTrust, envelope: EncryptedEnvelope): Promise<z.infer<typeof metadataSchema>> {
  const [bytes] = await helper.sealOrOpen("open", { ...trust, epoch: envelope.epoch }, "manifest", [Buffer.from(envelope.manifest, "base64")]);
  try { return metadataSchema.parse(JSON.parse(gunzipSync(bytes!, { maxOutputLength: 16 * 1024 * 1024 }).toString())); }
  catch { return verificationFailed(); }
}

/** Gzip stored-block and AEAD framing a sealed block can add over its plaintext. */
const SEALED_OVERHEAD = 128;
/**
 * Each object's encrypted size, estimated so download batches can be sized before the bytes
 * arrive. Fixed-size segments give an upper bound: a segment of more than one block used small
 * core blocks exactly when its bytes fit in that many of them. A v4 core gives its average.
 */
export function objectSizeEstimates(manifest: Snapshot, addresses: Record<string, string>): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const segment of manifest.segments) {
    const count = segment.blocks.length;
    // A v4 core is cut on content: blocks vary up to BLOCK_SIZE, so a batch is sized by their average instead.
    const block = count === 1 ? Math.min(segment.bytes, BLOCK_SIZE)
      : manifest.version === 4 && segment.kind === "core" ? Math.ceil(segment.bytes / count)
      : segment.bytes <= count * SMALL_CORE_BLOCK_SIZE ? SMALL_CORE_BLOCK_SIZE : BLOCK_SIZE;
    for (const hash of segment.blocks) {
      const address = addresses[hash];
      if (address) sizes.set(address, Math.max(sizes.get(address) ?? 0, block + SEALED_OVERHEAD));
    }
  }
  return sizes;
}
/** Reads the sealed manifest ahead of the objects it names; openSnapshot still verifies everything. */
export async function readObjectSizeEstimates(helper: NativeSecurity, trust: ProjectTrust, envelope: EncryptedEnvelope): Promise<Map<string, number>> {
  const metadata = await readMetadata(helper, trust, envelope);
  let manifest: Snapshot;
  try { manifest = decodeSnapshot(gzipSync(Buffer.from(JSON.stringify(metadata.snapshot)))); }
  catch { return verificationFailed(); }
  return objectSizeEstimates(manifest, metadata.blocks);
}

/** Decrypt, validate the manifest, every block, SQLite, and ownership before returning. */
export async function openSnapshot(helper: NativeSecurity, trust: ProjectTrust, encrypted: EncryptedBundle, previous?: VerifiedSnapshot, authenticatedPin?: RevisionPin): Promise<VerifiedSnapshot> {
  if (previous && previous.envelope.projectId !== trust.projectId) verificationFailed();
  const envelope = decodeEnvelope(Buffer.from(JSON.stringify(encrypted.envelope)));
  const pin = authenticatedPin ?? await verifyAdvance(helper, trust, previous?.pin ?? EMPTY_PIN, [envelope]);
  await verifyEnvelope(helper, trust, envelope);
  if (pin.revision !== envelope.revision || pin.commitment !== commitment(envelope)) verificationFailed();
  const metadata = await readMetadata(helper, trust, envelope);
  let manifest: Snapshot;
  try { manifest = decodeSnapshot(gzipSync(Buffer.from(JSON.stringify(metadata.snapshot)))); }
  catch { return verificationFailed(); }
  if (manifest.projectId !== trust.projectId || manifest.parentRevision !== envelope.revision - 1
    || writerInstallation(trust, envelope) !== manifest.installationId) verificationFailed();
  if (!authenticatedPin && (!previous || previous.pin.commitment !== pin.commitment)) assertPartitionTransition(previous?.bundle.manifest, manifest);
  const hashes = [...new Set(manifest.segments.flatMap(segment => segment.blocks))];
  if (hashes.length !== Object.keys(metadata.blocks).length || hashes.some(hash => !metadata.blocks[hash])) verificationFailed();
  const addresses = [...new Set(Object.values(metadata.blocks))].sort();
  if (JSON.stringify(addresses) !== JSON.stringify(envelope.objects)) verificationFailed();
  const blocks = new Map<string, Buffer>();
  for (let i = 0; i < hashes.length; i += 128) {
    const batch = hashes.slice(i, i + 128);
    const ciphertext = batch.map(hash => {
      const address = metadata.blocks[hash]!, data = encrypted.objects.get(address);
      if (!data || sha256(data) !== address) return verificationFailed();
      return data;
    });
    const opened = await helper.sealOrOpen("open", { ...trust, epoch: envelope.epoch }, "block", ciphertext);
    try {
      opened.forEach((data, j) => {
        const plain = gunzipSync(data, { maxOutputLength: BLOCK_SIZE });
        if (sha256(plain) !== batch[j]) verificationFailed();
        blocks.set(batch[j]!, plain);
      });
    } catch { return verificationFailed(); }
  }
  const bundle = { manifest, blocks };
  try { validateBundle(bundle); } catch { return verificationFailed(); }
  return { envelope, objects: encrypted.objects, bundle, pin };
}
