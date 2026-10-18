import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AccountClient } from "../cloud/account-client.js";
import { EncryptionError } from "../cloud/crypto-helper.js";
import { saveEncryptedCache, readEncryptedCache } from "../cloud/encrypted-coordinator.js";
import { EMPTY_PIN, type RevisionPin } from "../cloud/encrypted-protocol.js";
import { canonical } from "../cloud/identity-protocol.js";
import { NativeSecurity } from "../cloud/native-security.js";
import { withProjectGate } from "../cloud/gate.js";
import type { SecretsMigrationIntent, VaultState } from "../cloud/protocol-types.js";
import { atomicJson, sha256, stateDirectory } from "../cloud/state.js";
import { createEncryptedProject, projectTrust } from "../cloud/vault-client.js";
import { verifiedSecretAccount, ensureAccountSecrets, type SecretAccountContext } from "./account-resource.js";
import { applySecretFiles, captureSecretFolder, materializeSecretFiles, mergeSecretFiles, validateSecretManifest, type SecretBundle } from "./files.js";
import { openSecretFolder } from "./encrypted-files.js";
import { SecretTransport } from "./transport.js";
import { accountSecretCacheDirectory, legacySecretCacheDirectory, saveSecretBinding, secretBinding, selectedSecretServer, type SecretBinding } from "./state.js";
import { publicSecretStatus, encryptedSecretsSync, type SecretSyncStatus } from "./sync.js";

type CacheRef = ReturnType<typeof saveEncryptedCache>;
interface MigrationJournal {
  applied?: CacheRef; remote?: CacheRef; pending?: CacheRef;
  conflicts?: string[]; conflictFingerprint?: string; phase?: "source" | "destination";
  resolutions?: Record<string, "local" | "remote">;
  sourceResolutions?: Record<string,"local"|"remote">; sourceFingerprint?: string;
  destinationResolutions?: Record<string,"local"|"remote">; destinationFingerprint?: string;
  legacyVaultId?: string;
}
function bundleFromFiles(files: Map<string, Buffer>, projectId: string, parentRevision: number, installationId: string): SecretBundle {
  const blocks = new Map<string, Buffer>();
  const manifest = validateSecretManifest({ format:"code-butler-secrets",version:1,projectId,parentRevision,installationId,
    files:[...files].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([path,data]) => {
      const hashes: string[] = [];
      for (let offset = 0; offset < data.length; offset += 65536) { const bytes = data.subarray(offset,offset+65536), hash = sha256(bytes); hashes.push(hash); blocks.set(hash,bytes); }
      return {path,hash:sha256(data),size:data.length,blocks:hashes};
    }) });
  return {manifest,blocks};
}
function review(root: string, source: SecretBinding, message: string): SecretSyncStatus {
  const next: SecretBinding = {...source,enabled:true,status:"migration-required",migration:"review-required",error:message};
  saveSecretBinding(root,next); return publicSecretStatus(next);
}
export async function legacyMigrationStatus(root: string, source: SecretBinding): Promise<SecretSyncStatus> {
  try {
    const journal = await NativeSecurity.forServer(source.server).invoke<MigrationJournal|null>("sync-read",{checkoutId:source.checkoutId});
    return publicSecretStatus(source,journal?.conflicts);
  } catch { return publicSecretStatus(source); }
}

/** Freeze acknowledged legacy writes, then merge and verify encrypted account output before cutover. */
export async function migrateLegacySecrets(root: string, source: SecretBinding, context: SecretAccountContext): Promise<SecretSyncStatus> {
  const account = context.account, client = AccountClient.forSecretVault(source.server,source.vaultId);
  const target = AccountClient.forAccountSecrets(account.server,context.parent.projectId,account.security);
  client.tokens = account.tokens.bind(account);
  target.tokens = account.tokens.bind(account);
  const directory = accountSecretCacheDirectory(root); mkdirSync(directory,{recursive:true,mode:0o700});
  let sourceStatus;
  try {
    const local = await client.security.status();
    if (local.descriptor && (local.descriptor.accountId !== context.status.descriptor!.accountId || local.descriptor.vaultId !== source.vaultId))
      return review(root,source,"This legacy secrets custody belongs to another account or vault. Open Account Center to review its account and folder connection. Its files are preserved.");
    if (local.recoveryLoaded) {
      const remote = await client.request<VaultState>(`${client.vaultBase}/state`,"GET",undefined,false);
      sourceStatus = await client.security.invoke<Awaited<ReturnType<NativeSecurity["status"]>>>("recovery-accept",{records:remote.records});
    } else sourceStatus = await client.refreshVault();
  }
  catch (error) {
    // An unpublished setup has no cloud ciphertext to migrate; account recovery now protects its first upload.
    const local = await client.security.status().catch(() => null);
    if (source.status === "recovery-required" && local?.descriptor && !Object.keys(local.projects).length
      && local.descriptor.accountId === context.status.descriptor!.accountId && local.descriptor.vaultId === source.vaultId
      && error instanceof EncryptionError && error.state === "enrollment-required") {
      await ensureAccountSecrets(context);
      atomicJson(join(stateDirectory(root),`legacy-secrets-${source.vaultId}.json`),source);
      const next: SecretBinding = {version:2,server:source.server,vaultId:context.parent.vaultId,parentProjectId:context.parent.projectId,
        resourceId:context.resourceId,legacyVaultId:source.vaultId,checkoutId:source.checkoutId,enabled:true,status:"ready",revision:0,...(source.warnings ? {warnings:source.warnings} : {})};
      saveSecretBinding(root,next); return encryptedSecretsSync(root,account);
    }
    if (error instanceof EncryptionError && ["enrollment-required","locked","revoked"].includes(error.state))
      return review(root,source,"Open Account Center to import the existing secrets recovery file or use a computer that can already access this legacy vault. Its encrypted files are preserved.");
    throw error;
  }
  if (!sourceStatus.recoveryLoaded && sourceStatus.device?.id !== context.status.device?.id)
    return review(root,source,"This computer's account identity changed after the legacy vault was created. Open Account Center to import its original secrets recovery file before migration. Its files and old custody are preserved.");
  // Older setup can stop after publishing membership, before the first key exists.
  // Its empty source still needs a durable fence so another old device cannot finish setup later.
  const sourceTrust = sourceStatus.projects[source.vaultId] ? projectTrust(sourceStatus,source.vaultId) : undefined;
  const sourceTransport = sourceTrust ? new SecretTransport(client,sourceTrust) : undefined;
  const migrations = await account.request<SecretsMigrationIntent[]>("/v2/projects/secrets-migrations");
  let intent = migrations.find(row => row.legacyVaultId === source.vaultId);
  if (intent && intent.parentProjectId !== context.parent.projectId) return review(root,source,"This legacy vault is associated with another cloud project. Review its folder connection in Account Center.");
  let sourceRemote = await sourceTransport?.pull();
  const sourcePin = sourceRemote?.pin ?? EMPTY_PIN;
  if (!intent) {
    const record = {kind:"secrets-migration",version:1,accountId:context.status.descriptor!.accountId,
      legacyVaultId:source.vaultId,parentProjectId:context.parent.projectId,resourceId:context.resourceId,sourcePin,
      writer:sourceStatus.recoveryLoaded ? sourceStatus.descriptor!.recoverySigning : sourceStatus.device!.signingKey};
    const authorization = sourceStatus.recoveryLoaded ? await client.security.invoke("recovery-document-sign",{record}) : await client.security.signDocument(record);
    intent = await account.request<SecretsMigrationIntent>(`/v2/projects/${context.parent.projectId}/secrets/migration/begin`,"POST",{legacyVaultId:source.vaultId,sourcePin,authorization});
    // Re-read through normal authenticated receipts after the server has fenced concurrent publishers.
    sourceRemote = await sourceTransport?.pull(sourceRemote);
  }
  if (canonical(intent.sourcePin) !== canonical(sourceRemote?.pin ?? EMPTY_PIN)) throw new EncryptionError("verification-failed");
  const active: SecretBinding = {...source,enabled:true,status:"syncing",migration:"pending",phase:"Moving encrypted secrets to account sync"};
  delete active.error; saveSecretBinding(root,active);
  await createEncryptedProject(account,context.resourceId);
  const targetStatus = await target.refreshVault(), targetTrust = projectTrust(targetStatus,context.resourceId), transport = new SecretTransport(target,targetTrust);
  const remote = await transport.pull(), targetPin = remote?.pin ?? EMPTY_PIN;
  const journal = await account.security.invoke<MigrationJournal|null>("sync-read",{checkoutId:source.checkoutId}) ?? {};
  const sourceJournal = await client.security.invoke<{applied?:CacheRef}|null>("sync-read",{checkoutId:source.checkoutId});
  const base = sourceJournal?.applied && sourceTrust ? await openSecretFolder(client.security,sourceTrust,readEncryptedCache(legacySecretCacheDirectory(root),sourceJournal.applied),undefined,sourceJournal.applied.pin) : undefined;
  const installationId = targetStatus.device!.installationId;
  const local = captureSecretFolder(root,source.vaultId,sourcePin.revision,installationId);
  const saveJournal = async () => account.security.invoke("sync-save",{checkoutId:source.checkoutId,projectId:context.resourceId,pin:targetPin,value:journal});
  if (remote) journal.remote = saveEncryptedCache(directory,remote);
  const sourceFingerprint = sha256(canonical([intent.sourcePin,local.manifest.files,"source"]));
  if (journal.sourceFingerprint !== sourceFingerprint) delete journal.sourceResolutions;
  journal.sourceFingerprint = sourceFingerprint;
  const first = mergeSecretFiles(base?.bundle,local,sourceRemote?.bundle,journal.sourceResolutions);
  if (first.conflicts.length) {
    journal.conflicts = first.conflicts; journal.phase = "source"; journal.conflictFingerprint = sourceFingerprint;
    await saveJournal(); const conflict: SecretBinding = {...active,status:"conflict",migration:"conflict"}; delete conflict.phase;
    saveSecretBinding(root,conflict); return publicSecretStatus(conflict,first.conflicts);
  }
  const mergedSource = bundleFromFiles(first.files,context.resourceId,targetPin.revision,installationId);
  const destinationFingerprint = sha256(canonical([intent.sourcePin,targetPin,mergedSource.manifest.files,"destination"]));
  if (journal.destinationFingerprint !== destinationFingerprint) delete journal.destinationResolutions;
  journal.destinationFingerprint = destinationFingerprint;
  const destinationBase = intent.state === "migrated" && sourceRemote ? {...sourceRemote.bundle,manifest:{...sourceRemote.bundle.manifest,projectId:context.resourceId}} : undefined;
  const second = mergeSecretFiles(destinationBase,mergedSource,remote?.bundle,journal.destinationResolutions);
  if (second.conflicts.length) {
    journal.conflicts = second.conflicts; journal.phase = "destination"; journal.conflictFingerprint = destinationFingerprint;
    await saveJournal(); const conflict: SecretBinding = {...active,status:"conflict",migration:"conflict"}; delete conflict.phase;
    saveSecretBinding(root,conflict); return publicSecretStatus(conflict,second.conflicts);
  }
  const bundle = bundleFromFiles(second.files,context.resourceId,targetPin.revision,installationId), prepared = await transport.prepare(bundle,remote);
  if (prepared) { journal.pending = saveEncryptedCache(directory,prepared); await saveJournal(); }
  const accepted = prepared ? await transport.publish(prepared,remote) : remote;
  if (!accepted) throw new EncryptionError("verification-failed");
  const verified = await transport.pull(accepted);
  if (!verified || canonical(verified.bundle.manifest.files) !== canonical(bundle.manifest.files)) throw new EncryptionError("conflict");
  await account.request(`/v2/projects/${context.parent.projectId}/secrets/migration/complete`,"POST",{legacyVaultId:source.vaultId,sourcePin:intent.sourcePin,destinationPin:verified.pin});
  await ensureAccountSecrets(context,source.vaultId);
  // Keep both old native custody and its ciphertext cache. Cutover never deletes legacy recovery data.
  atomicJson(join(stateDirectory(root),`legacy-secrets-${source.vaultId}.json`),source);
  applySecretFiles(root,local,materializeSecretFiles(verified.bundle));
  journal.applied = saveEncryptedCache(directory,verified); journal.remote = journal.applied;
  delete journal.pending; delete journal.conflicts; delete journal.resolutions; delete journal.phase; delete journal.conflictFingerprint;
  delete journal.sourceResolutions; delete journal.destinationResolutions; delete journal.sourceFingerprint; delete journal.destinationFingerprint;
  await account.security.invoke("sync-save",{checkoutId:source.checkoutId,projectId:context.resourceId,pin:verified.pin,value:journal});
  const next: SecretBinding = {version:2,server:source.server,vaultId:context.parent.vaultId,parentProjectId:context.parent.projectId,resourceId:context.resourceId,
    legacyVaultId:source.vaultId,checkoutId:source.checkoutId,enabled:true,status:"synced",revision:verified.pin.revision,lastSync:new Date().toISOString(),...(source.warnings ? {warnings:source.warnings} : {})};
  saveSecretBinding(root,next); return publicSecretStatus(next);
}
export async function resolveLegacyMigration(root: string, source: SecretBinding, path: string, choice:"local"|"remote"): Promise<SecretSyncStatus> {
  return withProjectGate(root,async () => {
  const current = secretBinding(root);
  if (!current?.enabled || current.status !== "conflict" || current.checkoutId !== source.checkoutId
    || current.vaultId !== source.vaultId || current.version !== source.version || !current.migration) throw new EncryptionError("conflict");
  const context = await verifiedSecretAccount(root), journal = await context.account.security.invoke<MigrationJournal|null>("sync-read",{checkoutId:source.checkoutId});
  if (!journal?.conflicts?.includes(path)) throw new EncryptionError("conflict");
  if (journal.phase === "source") journal.sourceResolutions = {...journal.sourceResolutions,[path]:choice};
  else journal.destinationResolutions = {...journal.destinationResolutions,[path]:choice};
  await context.account.security.invoke("sync-save",{checkoutId:source.checkoutId,projectId:context.resourceId,pin:journal.remote?.pin ?? EMPTY_PIN,value:journal});
  return (await import("./sync.js")).setSecretsSyncEnabled(root,true,context.account);
  },{name:"Resolve legacy secrets migration"});
}
export async function listLegacySecretsReview(): Promise<{vaults:Array<{id:string;parentProjectId?:string;status:"unassociated"|"pending"|"migrated"}>}> {
  const account = new AccountClient(selectedSecretServer()); await account.refreshVault();
  const [ids,intents] = await Promise.all([account.request<string[]>("/v2/secrets/vaults","GET",undefined,false),account.request<SecretsMigrationIntent[]>("/v2/projects/secrets-migrations")]);
  return {vaults:ids.map(id => {const intent = intents.find(row => row.legacyVaultId === id);return {id,...(intent ? {parentProjectId:intent.parentProjectId} : {}),status:intent?.state === "migrated" ? "migrated" : intent ? "pending" : "unassociated"};})};
}
