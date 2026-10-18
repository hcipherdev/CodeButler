import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installationDeviceId } from "../memory/origin.js";
import { AccountClient } from "./account-client.js";
import { EncryptionError } from "./crypto-helper.js";
import { EncryptedTransport, type PreparedPublication } from "./encrypted-client.js";
import type { ProjectTrust } from "./encrypted-snapshot.js";
import { documentHash, verifyDocument, type SignedDocument, type SignedVaultRecord } from "./identity-protocol.js";
import type { SecurityStatus } from "./native-security.js";
import { atomicJson, readJson, sha256 } from "./state.js";
import type { VaultState } from "./protocol-types.js";
import { classifyAccountResource, secretsParentProjectId } from "./resource-identity.js";
import { SecretTransport } from "../secrets/transport.js";

export function projectTrust(status: SecurityStatus, projectId: string, staged = false): ProjectTrust {
  const records = staged && status.staged ? [...status.records,status.staged] : status.records;
  const membership = records.at(-1);
  const epoch = membership?.record.projects[projectId];
  if (!membership || !epoch) throw new EncryptionError("enrollment-required");
  return {projectId,epoch,membership:documentHash(membership),records,...(staged ? {staged:true} : {})};
}
export async function createEncryptedProject(client: AccountClient, id: string = randomUUID()): Promise<string> {
  let status = await client.refreshVault();
  if(status.projects[id]) return id;
  let staged = status.staged;
  if (staged && staged.record.action !== "project") throw new EncryptionError("conflict");
  if(staged && staged.record.parent !== documentHash(status.records.at(-1)!)) {
    await client.security.invoke("stage-abandon"); staged = null;
  }
  if(staged && !staged.record.projects[id]) throw new EncryptionError("conflict");
  staged ??= (await client.security.invoke<{record:SignedVaultRecord}>("project-stage",{projectId:id})).record;
  const projectId = Object.keys(staged.record.projects).find(project => !status.projects[project]);
  if (!projectId || projectId !== id) throw new EncryptionError("conflict");
  try { await client.request(`${client.vaultBase}/activate`,"POST",{record:staged,replacements:[]}); }
  catch (error) {
    // Another enrolled device may have created the same reserved UUID. Accept
    // only that exact project, and discard a stale stage after it is confirmed.
    const refreshed = await client.refreshVault();
    if (!refreshed.projects[id]) throw error;
    if (refreshed.staged && refreshed.staged.record.parent !== documentHash(refreshed.records.at(-1)!)) await client.security.invoke("stage-abandon");
    return id;
  }
  status = await client.security.invoke("stage-commit",{commitment:documentHash(staged)});
  if (!status.projects[projectId]) throw new EncryptionError("verification-failed"); return projectId;
}
interface RotationJournal { commitment: string; publications: Array<{envelope: PreparedPublication["envelope"];receipt:PreparedPublication["receipt"];objects:Record<string,string>}> }
/** Journal ciphertext before upload. A lost activation response is replayed exactly. */
export async function rotateVault(client: AccountClient, removeDeviceId?: string, recovery = false): Promise<void> {
  let status = recovery ? await client.security.status() : await client.refreshVault();
  if (!recovery && status.device?.id === removeDeviceId) throw new Error("Remove this device from another enrolled computer, or use recovery to replace all devices");
  if(!recovery && !status.records.at(-1)!.record.devices.some(d=>d.id===removeDeviceId)) {
    if(status.records.some(r=>r.record.devices.some(d=>d.id===removeDeviceId))) return;
    throw new EncryptionError("verification-failed");
  }
  if(!recovery && status.staged && status.staged.record.parent !== documentHash(status.records.at(-1)!)) {
    await client.security.invoke("stage-abandon"); status=await client.security.status();
  }
  const staged = status.staged ?? await client.security.invoke<SignedVaultRecord>("rotation-stage",{removeDeviceId});
  if (staged.record.action !== (recovery ? "recover" : "revoke") || (!recovery && staged.record.devices.some(d => d.id === removeDeviceId))) throw new EncryptionError("conflict");
  status = await client.security.status();
  const path = join(client.security.directory,"rotation.json"), hash = documentHash(staged);
  let journal = readJson<RotationJournal>(path);
  if (journal && journal.commitment !== hash) journal = undefined;
  if(journal) for(const publication of journal.publications) {
    const parent = secretsParentProjectId(publication.envelope.projectId,Object.keys(status.projects));
    const head=await (parent ? new SecretTransport(AccountClient.forAccountSecrets(client.server,parent,client.security),projectTrust(status,publication.envelope.projectId)) : new EncryptedTransport(client,projectTrust(status,publication.envelope.projectId))).head();
    if(head.commitment !== publication.receipt.record.commitment && (head.revision!==publication.envelope.revision-1 || head.commitment!==publication.envelope.parentCommitment)) {journal=undefined;break;}
  }
  if (!journal) {
    journal = {commitment:hash,publications:[]};
    const projectIds = Object.keys(status.projects), hasSecrets = projectIds.some(id => classifyAccountResource(id,status.descriptor!.vaultId,projectIds) === "secrets");
    const active = await client.request<Array<{id:string}>>(hasSecrets ? "/v2/projects/resources" : "/v2/projects");
    const missing = Object.keys(status.projects).filter(id => !active.some(p => p.id === id));
    if (missing.length) {
      const receipts = await client.request<Array<{id:string;membership:string;proof:SignedDocument<Record<string,unknown>>}>>("/v2/projects/deleted");
      // A server omission alone is never authority to exclude a project from
      // rotation. Require a deletion request signed by an enrolled device.
      for (const id of missing) {
        const receipt = receipts.find(r => r.id === id);
        const record = status.records.find(r => documentHash(r) === receipt?.membership);
        const proof = receipt?.proof, p = proof?.record;
        const device = record?.record.devices.find(d => d.id === p?.deviceId);
        if (!proof || !p || !device || !record?.record.projects[id] || p.kind !== "proof" || p.accountId !== status.descriptor?.accountId
          || p.method !== "DELETE" || p.path !== `/v2/projects/${secretsParentProjectId(id,projectIds) ?? id}` || p.bodyHash !== sha256(Buffer.alloc(0))) throw new EncryptionError("verification-failed");
        verifyDocument(proof, device.signingKey);
      }
    }
    for(const id of Object.keys(status.projects).filter(id => !missing.includes(id))) {
      const parent = secretsParentProjectId(id,projectIds);
      if (parent) {
        const secretClient = AccountClient.forAccountSecrets(client.server,parent,client.security);
        const current = await new SecretTransport(secretClient,projectTrust(status,id)).pull();
        if (!current) continue;
        const next = new SecretTransport(secretClient,projectTrust(status,id,true));
        const prepared = (await next.prepare({ ...current.bundle, manifest:{...current.bundle.manifest,parentRevision:current.pin.revision,installationId:status.device!.installationId} },current,true))!;
        journal.publications.push({envelope:prepared.envelope,receipt:prepared.receipt,objects:Object.fromEntries([...prepared.objects].map(([address,bytes])=>[address,bytes.toString("base64")]))});
        continue;
      }
      const old = new EncryptedTransport(client,projectTrust(status,id));
      const current = await old.pull();
      if (!current) continue;
      const next = new EncryptedTransport(client,projectTrust(status,id,true));
      const bundle = { ...current.bundle, manifest:{...current.bundle.manifest,parentRevision:current.pin.revision,installationId:status.device!.installationId,checkoutId:randomUUID()} };
      const prepared = (await next.prepare(bundle,current,true))!;
      journal.publications.push({envelope:prepared.envelope,receipt:prepared.receipt,objects:Object.fromEntries([...prepared.objects].map(([id,bytes])=>[id,bytes.toString("base64")]))});
    }
    atomicJson(path,journal);
  }
  const upload=async(index:number):Promise<void>=>{
    const publication=journal!.publications[index];
    if(!publication){await client.request(recovery ? "/v2/vault/recover" : "/v2/vault/activate","POST",{record:staged,replacements:journal!.publications.map(({envelope,receipt})=>({envelope,receipt}))},!recovery);return;}
    const parent = secretsParentProjectId(publication.envelope.projectId,Object.keys(status.projects));
    const transport=parent ? new SecretTransport(AccountClient.forAccountSecrets(client.server,parent,client.security),projectTrust(status,publication.envelope.projectId,true)) : new EncryptedTransport(client,projectTrust(status,publication.envelope.projectId,true));
    await transport.withUploaded({...publication,objects:new Map(Object.entries(publication.objects).map(([id,b])=>[id,Buffer.from(b,"base64")]))},()=>upload(index+1));
  };
  await upload(0);
  await client.security.invoke("stage-commit",{commitment:hash});
}
export async function restoreRecovery(client: AccountClient, kitPath: string, code: string, label: string): Promise<void> {
  if (!label.trim() || label.length > 100) throw new Error("Device labels must contain 1–100 characters");
  const tokens = await client.tokens();
  const state = await client.request<VaultState>("/v2/vault/state","GET",undefined,false);
  await client.security.invoke("recovery-load",{kit:JSON.parse(readFileSync(kitPath,"utf8")),code,accountId:tokens.accountId,records:state.records,deviceId:randomUUID(),installationId:installationDeviceId(),label});
  await rotateVault(client,undefined,true);
}
