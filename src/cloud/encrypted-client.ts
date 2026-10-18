import { z } from "zod";
import { AccountClient } from "./account-client.js";
import { EncryptionError } from "./crypto-helper.js";
import { commitment, decodeEnvelope, EMPTY_PIN, encodeEnvelope, HASH, type EncryptedEnvelope, type RevisionPin } from "./encrypted-protocol.js";
import { openSnapshot, readObjectSizeEstimates, sealSnapshot, type EncryptedBundle, type ProjectTrust, type VerifiedSnapshot } from "./encrypted-snapshot.js";
import { canonical, documentHash } from "./identity-protocol.js";
import { receiptAuthority, receiptRecord, receiptSchema, type RevisionReceipt } from "./revision-receipt.js";
import { BLOCK_SIZE, type SnapshotBundle } from "./snapshot.js";

import { TransferClient } from "./transfer-client.js";

const headSchema = z.object({revision:z.number().int().nonnegative(),commitment:z.union([HASH,z.literal("")])}).strict();
export interface PreparedPublication extends EncryptedBundle { receipt: RevisionReceipt }
/** Called after each uploaded batch with the encrypted bytes sent so far and the total still missing at the start. */
export type UploadProgress = (sentBytes: number, totalBytes: number) => void;
function progressReporter(prepared: PreparedPublication, addresses: readonly string[], onProgress?: UploadProgress): (batch: readonly string[]) => void {
  if (!onProgress) return () => {};
  const size = (a: string) => prepared.objects.get(a)?.length ?? 0;
  const total = addresses.reduce((sum, a) => sum + size(a), 0);
  let sent = 0; onProgress(0, total);
  return batch => { sent += batch.reduce((sum, a) => sum + size(a), 0); onProgress(sent, total); };
}
/** Batches in flight at once: overlaps transfer with server work while staying far below the server's nonce cap. */
const TRANSFER_CONCURRENCY = 3;
/** The server's per-request object cap. */
const TRANSFER_BATCH_ITEMS = 128;
/**
 * Encrypted bytes per request (about 2.7 MB once base64-encoded). A full 128-block batch
 * is roughly 11 MB on the wire, which a distant server cannot always receive within one
 * request's timeout while two other batches share the link; a lost batch is resent whole.
 */
export const TRANSFER_BATCH_BYTES = 2 * 1024 * 1024;
/** Slices items into batches of at most 128 items and TRANSFER_BATCH_BYTES; an oversized item travels alone. */
export function transferBatches<T>(items: readonly T[], sizeOf: (item: T) => number): T[][] {
  const batches: T[][] = []; let current: T[] = [], bytes = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (current.length && (current.length >= TRANSFER_BATCH_ITEMS || bytes + size > TRANSFER_BATCH_BYTES)) { batches.push(current); current = []; bytes = 0; }
    current.push(item); bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}
/** Runs `work` over byte-bounded batches, a few at a time; on failure, waits for in-flight batches before rethrowing. */
async function inBatches<T>(items: readonly T[], work: (batch: T[]) => Promise<void>, sizeOf: (item: T) => number): Promise<void> {
  const batches = transferBatches(items, sizeOf);
  let next = 0, failed = false;
  const lane = async () => { while (!failed && next < batches.length) { try { await work(batches[next++]!); } catch (error) { failed = true; throw error; } } };
  const failure = (await Promise.allSettled(Array.from({ length: Math.min(TRANSFER_CONCURRENCY, batches.length) }, lane))).find(r => r.status === "rejected");
  if (failure) throw failure.reason;
}
export class EncryptedTransport {
  readonly path: string;
  readonly transfer: TransferClient;
  constructor(readonly client: AccountClient, readonly trust: ProjectTrust) { this.path = `/v2/projects/${trust.projectId}`; this.transfer=new TransferClient(client,this.path); }
  async head(): Promise<RevisionPin> { return headSchema.parse(await this.client.request(`${this.path}/head`)); }
  async pull(previous?: VerifiedSnapshot): Promise<VerifiedSnapshot | undefined> {
    const status = await this.client.security.status();
    const pinned = status.pins[this.trust.projectId] ?? EMPTY_PIN;
    const start = previous && previous.pin.revision > pinned.revision ? previous.pin : pinned;
    const head = await this.head();
    if ((head.revision === 0) !== (head.commitment === "") || head.revision < start.revision || (head.revision === start.revision && head.commitment !== start.commitment)) throw new EncryptionError("verification-failed");
    if (!head.revision) return undefined;
    let accepted = start, lastMembership = 0;
    while (accepted.revision < head.revision) {
      const before = accepted.revision;
      const receipts = z.array(receiptSchema).max(1000).parse(await this.client.request(`${this.path}/receipts`,"POST",{after:accepted.revision}));
      if (!receipts.length) throw new EncryptionError("verification-failed");
      for (const receipt of receipts) {
        const r = receipt.record;
        if (r.revision > head.revision) break;
        receiptAuthority(receipt,this.trust.records);
        const membership = this.trust.records.find(m => documentHash(m) === r.membership)!;
        if (r.projectId !== this.trust.projectId || r.revision !== accepted.revision + 1 || r.parentCommitment !== (accepted.commitment || null) || membership.record.sequence < lastMembership) throw new EncryptionError("verification-failed");
        await this.client.security.verifyDocument(receipt,r.writer);
        lastMembership = membership.record.sequence; accepted = {revision:r.revision,commitment:r.commitment};
      }
      if (accepted.revision === before) throw new EncryptionError("verification-failed");
    }
    if (accepted.commitment !== head.commitment) throw new EncryptionError("verification-failed");
    if (previous?.pin.commitment === head.commitment) {
      if(previous.envelope.epoch!==this.trust.epoch) throw new EncryptionError("verification-failed"); return previous;
    }
    const modern=await this.transfer.available();
    const download=async (lease?:string,leased?:unknown):Promise<VerifiedSnapshot>=>{
      const envelope=decodeEnvelope(encodeEnvelope((leased ?? await this.client.request<EncryptedEnvelope>(this.path+"/revision","POST",{revision:head.revision})) as EncryptedEnvelope));
      if(commitment(envelope)!==accepted.commitment || envelope.epoch!==this.trust.epoch)throw new EncryptionError("verification-failed");
      const objects=new Map<string,Buffer>();
      const missing=envelope.objects.filter(a=>{const cached=previous?.objects.get(a);if(cached)objects.set(a,cached);return !cached;});
      // Small core blocks are a quarter of BLOCK_SIZE; sizing batches from the manifest packs four times as many per request.
      const sizes=missing.length?await readObjectSizeEstimates(this.client.security,this.trust,envelope):new Map<string,number>();
      await inBatches(missing,async batch=>{
        const result=lease?await this.transfer.read(lease,batch)
          :new Map(Object.entries(z.record(HASH,z.string()).parse(await this.client.request(this.path+"/objects","POST",{addresses:batch}))).map(([address,bytes])=>[address,Buffer.from(bytes,"base64")]));
        if(canonical([...result.keys()].sort())!==canonical([...batch].sort()))throw new EncryptionError("verification-failed");
        for(const [address,bytes]of result)objects.set(address,bytes);
      },a=>sizes.get(a) ?? BLOCK_SIZE);
      return openSnapshot(this.client.security,this.trust,{envelope,objects},undefined,accepted);
    };
    return modern?this.transfer.using({action:"begin-read",revision:head.revision},(lease,result)=>download(lease,result.envelope)):download();
  }

  async prepare(bundle: SnapshotBundle, previous?: VerifiedSnapshot, force = false): Promise<PreparedPublication | undefined> {
    const logical = (b:SnapshotBundle) => canonical({core:b.manifest.fingerprint,partitions:b.manifest.segments.filter(s=>s.kind==="partition").map(s=>[s.id,s.fingerprint]).sort()});
    if (!force && previous && logical(bundle) === logical(previous.bundle)) return undefined;
    const encrypted = await sealSnapshot(this.client.security,this.trust,bundle,previous);
    const status = await this.client.security.status();
    const receipt = await this.client.security.signDocument(receiptRecord(status.descriptor!.vaultId,encrypted.envelope));
    return {...encrypted,receipt};
  }
  async upload(prepared: PreparedPublication, previous?: VerifiedSnapshot, onProgress?: UploadProgress): Promise<void> {
    const known = new Set(previous?.envelope.objects ?? []);
    const addresses = prepared.envelope.objects.filter(a => !known.has(a));
    const report = progressReporter(prepared, addresses, onProgress);
    await inBatches(addresses,async batch=>{
      await this.client.request(`${this.path}/objects`,"PUT",Object.fromEntries(batch.map(a => [a,prepared.objects.get(a)!.toString("base64")])));
      report(batch);
    }, a => prepared.objects.get(a)!.length);
  }
  async withUploaded<T>(prepared:PreparedPublication,work:()=>Promise<T>):Promise<T> {
    if(!await this.transfer.available()){await this.upload(prepared);return work();}
    return this.transfer.using({action:"begin-upload",envelope:prepared.envelope,receipt:prepared.receipt,...(this.trust.staged?{record:this.trust.records.at(-1)}:{})},async(lease,result)=>{
      const missing=z.array(HASH).parse(result.missing);
      if(missing.some(a=>!prepared.objects.has(a)))throw new EncryptionError("verification-failed");
      await inBatches(missing,async batch=>{await this.transfer.upload(lease,batch.map(a=>[a,prepared.objects.get(a)!] as const));},a=>prepared.objects.get(a)!.length);
      return work();
    });
  }
  async publish(prepared: PreparedPublication, previous?: VerifiedSnapshot, onProgress?: UploadProgress): Promise<VerifiedSnapshot> {
    const verified = await openSnapshot(this.client.security,this.trust,prepared,previous);
    const pin = await this.transfer.available() ? await this.transfer.using({action:"begin-upload",envelope:prepared.envelope,receipt:prepared.receipt},async(lease,result)=>{
      const missing=z.array(HASH).parse(result.missing);
      if(missing.some(a=>!prepared.objects.has(a)))throw new EncryptionError("verification-failed");
      const report=progressReporter(prepared,missing,onProgress);
      await inBatches(missing,async batch=>{await this.transfer.upload(lease,batch.map(a=>[a,prepared.objects.get(a)!] as const));report(batch);},a=>prepared.objects.get(a)!.length);
      // The lease keeps the envelope sent with begin-upload, about 1 MB for a large project; send it once.
      return headSchema.parse(await this.transfer.request({action:"publish",lease,...(this.transfer.keepsEnvelope?{}:{envelope:prepared.envelope}),receipt:prepared.receipt}));
    }) : await (async()=>{await this.upload(prepared,previous,onProgress);return headSchema.parse(await this.client.request(this.path+"/publish","POST",{envelope:prepared.envelope,receipt:prepared.receipt}));})();
    if (canonical(pin) !== canonical(verified.pin)) throw new EncryptionError("verification-failed"); return verified;
  }
}
