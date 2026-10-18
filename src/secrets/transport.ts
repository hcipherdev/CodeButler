import { z } from "zod";
import { AccountClient } from "../cloud/account-client.js";
import { EncryptionError } from "../cloud/crypto-helper.js";
import { commitment, decodeEnvelope, EMPTY_PIN, encodeEnvelope, HASH, type EncryptedEnvelope, type RevisionPin } from "../cloud/encrypted-protocol.js";
import type { EncryptedBundle, ProjectTrust } from "../cloud/encrypted-snapshot.js";
import { canonical, documentHash } from "../cloud/identity-protocol.js";
import { receiptAuthority, receiptRecord, receiptSchema, type RevisionReceipt } from "../cloud/revision-receipt.js";
import { TransferClient } from "../cloud/transfer-client.js";
import { transferBatches } from "../cloud/encrypted-client.js";
import { openSecretFolder, sealSecretFolder, type VerifiedSecrets } from "./encrypted-files.js";
import { SECRET_BLOCK_SIZE, type SecretBundle } from "./files.js";
import { secretsParentProjectId } from "../cloud/resource-identity.js";

const headSchema = z.object({ revision: z.number().int().nonnegative(), commitment: z.union([HASH, z.literal("")]) }).strict();
export interface PreparedSecretPublication extends EncryptedBundle { receipt: RevisionReceipt }

/** Opaque transport shared with memory's storage service, but decoded only as a secrets manifest. */
export class SecretTransport {
  readonly path: string;
  readonly transfer: TransferClient;
  constructor(readonly client: AccountClient, readonly trust: ProjectTrust) {
    if (client.security.domain !== "secrets") throw new EncryptionError("verification-failed");
    const parent = secretsParentProjectId(trust.projectId, Object.keys(trust.records.at(-1)!.record.projects));
    this.path = client.vaultBase === "/v2/vault" && parent ? `/v2/projects/${parent}/secrets` : `/v2/secrets/projects/${trust.projectId}`;
    this.transfer = new TransferClient(client, this.path);
  }
  async head(): Promise<RevisionPin> { return headSchema.parse(await this.client.request(`${this.path}/head`)); }
  async pull(previous?: VerifiedSecrets): Promise<VerifiedSecrets | undefined> {
    const status = await this.client.security.status(), pinned = status.pins[this.trust.projectId] ?? EMPTY_PIN;
    const start = previous && previous.pin.revision > pinned.revision ? previous.pin : pinned;
    const head = await this.head();
    if ((head.revision === 0) !== (head.commitment === "") || head.revision < start.revision
      || head.revision === start.revision && head.commitment !== start.commitment) throw new EncryptionError("verification-failed");
    if (!head.revision) return undefined;
    let accepted = start, lastMembership = 0;
    while (accepted.revision < head.revision) {
      const before = accepted.revision;
      const receipts = z.array(receiptSchema).max(1000).parse(await this.client.request(`${this.path}/receipts`, "POST", { after: accepted.revision }));
      if (!receipts.length) throw new EncryptionError("verification-failed");
      for (const receipt of receipts) {
        const r = receipt.record;
        if (r.revision > head.revision) break;
        receiptAuthority(receipt, this.trust.records);
        const membership = this.trust.records.find(m => documentHash(m) === r.membership)!;
        if (r.projectId !== this.trust.projectId || r.revision !== accepted.revision + 1
          || r.parentCommitment !== (accepted.commitment || null) || membership.record.sequence < lastMembership) throw new EncryptionError("verification-failed");
        await this.client.security.verifyDocument(receipt, r.writer);
        lastMembership = membership.record.sequence; accepted = { revision: r.revision, commitment: r.commitment };
      }
      if (accepted.revision === before) throw new EncryptionError("verification-failed");
    }
    if (accepted.commitment !== head.commitment) throw new EncryptionError("verification-failed");
    if (previous?.pin.commitment === head.commitment) {
      if (previous.envelope.epoch !== this.trust.epoch) throw new EncryptionError("verification-failed");
      return previous;
    }
    const modern = await this.transfer.available();
    const download = async (lease?: string, leased?: unknown): Promise<VerifiedSecrets> => {
      const envelope = decodeEnvelope(encodeEnvelope((leased ?? await this.client.request<EncryptedEnvelope>(`${this.path}/revision`, "POST", { revision: head.revision })) as EncryptedEnvelope));
      if (commitment(envelope) !== accepted.commitment || envelope.epoch !== this.trust.epoch) throw new EncryptionError("verification-failed");
      const objects = new Map<string, Buffer>();
      const missing = envelope.objects.filter(address => { const cached = previous?.objects.get(address); if (cached) objects.set(address, cached); return !cached; });
      for (const batch of transferBatches(missing, () => SECRET_BLOCK_SIZE)) {
        const result = z.record(HASH, z.string()).parse(lease
          ? await this.transfer.request({ action: "read", lease, addresses: batch })
          : await this.client.request(`${this.path}/objects`, "POST", { addresses: batch }));
        if (canonical(Object.keys(result).sort()) !== canonical([...batch].sort())) throw new EncryptionError("verification-failed");
        for (const [address, bytes] of Object.entries(result)) objects.set(address, Buffer.from(bytes, "base64"));
      }
      return openSecretFolder(this.client.security, this.trust, { envelope, objects }, undefined, accepted);
    };
    return modern ? this.transfer.using({ action: "begin-read", revision: head.revision }, (lease, result) => download(lease, result.envelope)) : download();
  }
  async prepare(bundle: SecretBundle, previous?: VerifiedSecrets, force = false): Promise<PreparedSecretPublication | undefined> {
    if (!force && previous && canonical(bundle.manifest.files) === canonical(previous.bundle.manifest.files)) return undefined;
    const encrypted = await sealSecretFolder(this.client.security, this.trust, bundle, previous);
    const status = await this.client.security.status();
    const receipt = await this.client.security.signDocument(receiptRecord(status.descriptor!.vaultId, encrypted.envelope));
    return { ...encrypted, receipt };
  }
  async withUploaded<T>(prepared: PreparedSecretPublication, work: () => Promise<T>): Promise<T> {
    if (!await this.transfer.available()) {
      for (const batch of transferBatches(prepared.envelope.objects, address => prepared.objects.get(address)!.length)) {
        await this.client.request(`${this.path}/objects`, "PUT", Object.fromEntries(batch.map(address => [address, prepared.objects.get(address)!.toString("base64")])));
      }
      return work();
    }
    return this.transfer.using({ action: "begin-upload", envelope: prepared.envelope, receipt: prepared.receipt,
      ...(this.trust.staged ? { record: this.trust.records.at(-1) } : {}) }, async (lease, result) => {
      const missing = z.array(HASH).parse(result.missing);
      if (missing.some(address => !prepared.objects.has(address))) throw new EncryptionError("verification-failed");
      for (const batch of transferBatches(missing, address => prepared.objects.get(address)!.length)) {
        await this.transfer.request({ action: "upload", lease, objects: Object.fromEntries(batch.map(address => [address, prepared.objects.get(address)!.toString("base64")])) });
      }
      return work();
    });
  }
  async publish(prepared: PreparedSecretPublication, previous?: VerifiedSecrets): Promise<VerifiedSecrets> {
    const verified = await openSecretFolder(this.client.security, this.trust, prepared, previous);
    const publish = async (lease?: string, missing?: string[]): Promise<RevisionPin> => {
      const addresses = missing ?? prepared.envelope.objects.filter(address => !previous?.objects.has(address));
      if (addresses.some(address => !prepared.objects.has(address))) throw new EncryptionError("verification-failed");
      for (const batch of transferBatches(addresses, address => prepared.objects.get(address)!.length)) {
        const objects = Object.fromEntries(batch.map(address => [address, prepared.objects.get(address)!.toString("base64")]));
        if (lease) await this.transfer.request({ action: "upload", lease, objects });
        else await this.client.request(`${this.path}/objects`, "PUT", objects);
      }
      return headSchema.parse(lease
        ? await this.transfer.request({ action: "publish", lease, envelope: prepared.envelope, receipt: prepared.receipt })
        : await this.client.request(`${this.path}/publish`, "POST", { envelope: prepared.envelope, receipt: prepared.receipt }));
    };
    const pin = await this.transfer.available()
      ? await this.transfer.using({ action: "begin-upload", envelope: prepared.envelope, receipt: prepared.receipt }, (lease, result) => publish(lease, z.array(HASH).parse(result.missing)))
      : await publish();
    if (canonical(pin) !== canonical(verified.pin)) throw new EncryptionError("verification-failed");
    return verified;
  }
}
