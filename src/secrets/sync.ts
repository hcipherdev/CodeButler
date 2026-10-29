import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertOrdinaryProject } from "../rules/identity.js";
import { AccountClient } from "../cloud/account-client.js";
import { EncryptionError } from "../cloud/crypto-helper.js";
import { readEncryptedCache, saveEncryptedCache } from "../cloud/encrypted-coordinator.js";
import { EMPTY_PIN, type RevisionPin } from "../cloud/encrypted-protocol.js";
import type { EncryptedBundle } from "../cloud/encrypted-snapshot.js";
import { withProjectGate } from "../cloud/gate.js";
import { classifyCloudSyncError } from "../cloud/condition.js";
import { OperationDeferredError } from "../cloud/outcome.js";
import { assertCheckoutReady } from "../cloud/checkout-path.js";
import { NativeSecurity } from "../cloud/native-security.js";
import { UUID, atomicJson, stateDirectory, readJson, sha256 } from "../cloud/state.js";
import { createEncryptedProject, projectTrust } from "../cloud/vault-client.js";
import { captureSecretFolder, applySecretFiles, mergeSecretFiles, validateSecretPath } from "./files.js";
import { openSecretFolder, type VerifiedSecrets } from "./encrypted-files.js";
import { SecretTransport } from "./transport.js";
import { restrictSecretFile } from "./permissions.js";
import { ensureSecretsGitGuard, saveSecretBinding, secretBinding, secretCacheDirectory, selectedSecretServer, type SecretBinding } from "./state.js";
import { SecretFolderError } from "./folder-error.js";
import { auditSecretsExposure } from "./audit.js";
import { binding as memoryBinding } from "../cloud/state.js";
import { verifiedSecretAccount, ensureAccountSecrets } from "./account-resource.js";

interface CacheRef { hash: string; pin: RevisionPin; epoch?: number; membership?: string }
interface SecretJournal { applied?: CacheRef; remote?: CacheRef; conflicts?: string[]; conflictPin?: RevisionPin; conflictLocalFingerprint?: string; resolutions?: Record<string, "local" | "remote"> }
export interface SecretSyncStatus { enabled: boolean; status: string; revision: number; lastSync?: string; vaultId?: string; resourceId?: string; migration?: string; conflicts?: string[]; error?: string; warnings?: string[]; phase?: string }
export const publicSecretStatus = (value?: SecretBinding, conflicts?: string[]): SecretSyncStatus => ({
  enabled: value?.enabled ?? false, status: value?.status ?? "disabled", revision: value?.revision ?? 0,
  ...(value?.lastSync ? { lastSync: value.lastSync } : {}), ...(value?.vaultId ? { vaultId: value.vaultId } : {}),
  ...(conflicts?.length ? { conflicts } : {}), ...(value?.error ? { error: value.error } : {}),
  ...(value?.warnings?.length ? { warnings: value.warnings } : {}), ...(value?.phase ? { phase: value.phase } : {}),
  ...(value?.resourceId ? { resourceId: value.resourceId } : {}), ...(value?.migration ? { migration: value.migration } : {})
});
const publicStatus = publicSecretStatus;
export function clientForSecretBinding(binding: SecretBinding, capturedAccount?: AccountClient): AccountClient {
  const client = binding.version === 2
    ? AccountClient.forAccountSecrets(binding.server,binding.parentProjectId!,capturedAccount?.security) : AccountClient.forSecretVault(binding.server, binding.vaultId);
  if (capturedAccount) client.tokens = capturedAccount.tokens.bind(capturedAccount);
  return client;
}
const clientFor = clientForSecretBinding;
export const secretBindingResourceId = (value: SecretBinding): string => value.version === 2 ? value.resourceId! : value.vaultId;
async function pruneSecretCache(directory: string, security: NativeSecurity): Promise<void> {
  const refs = await security.invoke<string[]>("sync-list-cache-refs");
  if (!Array.isArray(refs) || refs.some(ref => !/^[a-f0-9]{64}$/.test(ref))) return;
  const retained = new Set(refs);
  for (const name of readdirSync(directory)) {
    if (/^[a-f0-9]{64}\.encrypted\.gz$/.test(name) && !retained.has(name.slice(0, 64))) unlinkSync(join(directory, name));
  }
}

export async function secretsSyncStatus(root: string): Promise<SecretSyncStatus> {
  assertOrdinaryProject(root);
  const state = secretBinding(root);
  if (!state) return publicStatus();
  if (state.migration) return (await import("./migration.js")).legacyMigrationStatus(root,state);
  try {
    const journal = await clientFor(state).security.invoke<SecretJournal | null>("sync-read", { checkoutId: state.checkoutId });
    return publicStatus(state, journal?.conflicts);
  } catch { return publicStatus(state); }
}

/** One opt-in uses existing account enrollment and recovery, never a second setup ceremony. */
export async function setSecretsSyncEnabled(root: string, enabled: boolean, capturedAccount?: AccountClient): Promise<SecretSyncStatus> {
  assertCheckoutReady(root);
  assertOrdinaryProject(root);
  return withProjectGate(root, async () => {
    assertCheckoutReady(root);
    const current = secretBinding(root);
    if (!enabled) {
      if (!current) return publicStatus();
      const next: SecretBinding = { ...current, enabled: false, status: "disabled" };
      saveSecretBinding(root, next); return publicStatus(next);
    }
    ensureSecretsGitGuard(root);
    const warnings = auditSecretsExposure(root);
    const server = selectedSecretServer();
    if (!current || current.version === 2 || memoryBinding(root)?.encryptionVersion === 2) {
      const context = await verifiedSecretAccount(root,capturedAccount);
      if (current?.server && current.server !== context.account.server) throw new EncryptionError("authentication-required");
      if (current?.version === 1) return (await import("./migration.js")).migrateLegacySecrets(root,{...current,enabled:true,warnings},context);
      if (current && (current.vaultId !== context.parent.vaultId || current.parentProjectId !== context.parent.projectId || current.resourceId !== context.resourceId)) throw new EncryptionError("verification-failed");
      await ensureAccountSecrets(context);
      const next: SecretBinding = { ...current,version:2,server,vaultId:context.parent.vaultId,parentProjectId:context.parent.projectId,
        resourceId:context.resourceId,checkoutId:current?.checkoutId ?? randomUUID(),enabled:true,status:current?.status === "conflict" ? "conflict" : "ready",revision:current?.revision ?? 0,warnings };
      delete next.error; saveSecretBinding(root,next);
      return encryptedSecretsSync(root,context.account);
    }
    const account = new AccountClient(server), memory = await account.refreshVault();
    if (!memory.device || !memory.descriptor) throw new EncryptionError("enrollment-required");
    if (current) {
      if (current.server !== server) throw new EncryptionError("authentication-required");
      const client = clientFor(current), local = await client.security.status().catch(() => null);
      if (current.status === "recovery-required") {
        if (!local?.descriptor) throw new EncryptionError("verification-failed");
        if (!local.recoveryReady) return publicStatus(current);
        // Resume safely if initialization or project creation was interrupted after kit verification.
        await client.publishInitialization();
        await createEncryptedProject(client, current.vaultId);
        const resumed: SecretBinding = { ...current, enabled: true, status: "ready", warnings };
        saveSecretBinding(root, resumed); return publicStatus(resumed);
      }
      try { await client.refreshVault(); }
      catch (error) {
        if (error instanceof EncryptionError && ["enrollment-required", "locked"].includes(error.state)) {
          const waiting: SecretBinding = { ...current, enabled: false, status: "approval-required", warnings };
          saveSecretBinding(root, waiting); return publicStatus(waiting);
        }
        throw error;
      }
      const next: SecretBinding = { ...current, enabled: true, status: "ready", warnings };
      saveSecretBinding(root, next); return publicStatus(next);
    }
    throw new Error("Connect this folder to its existing cloud project before enabling secrets sync.");
  }, { name: "Configure secrets sync" });
}

export function secretsRecoveryFile(root: string, filePath: string): string {
  if (!isAbsolute(filePath)) throw new Error("Choose an absolute recovery file path.");
  const path = resolve(filePath), inside = relative(root, path);
  if (inside === "" || inside !== ".." && !inside.startsWith(".." + sep) && !isAbsolute(inside))
    throw new Error("Keep the recovery file outside the project folder.");
  return path;
}
export async function prepareSecretsRecovery(root: string, filePath: string): Promise<{ code: string }> {
  assertCheckoutReady(root);
  const binding = secretBinding(root);
  if (!binding || binding.status !== "recovery-required") throw new EncryptionError("recovery-required");
  const path = secretsRecoveryFile(root, filePath);
  const client = clientFor(binding), exported = await client.security.invoke<{ kit: unknown; code: string }>("recovery-export");
  const encoded = JSON.stringify(exported.kit);
  if (existsSync(path)) {
    if (!lstatSync(path).isFile() || readFileSync(path, "utf8") !== encoded) throw new Error("Choose a new recovery file path.");
  } else writeFileSync(path, encoded, { flag: "wx", mode: 0o600 });
  restrictSecretFile(path);
  return { code: exported.code };
}
export async function confirmSecretsRecovery(root: string, filePath: string, code: string): Promise<SecretSyncStatus> {
  assertCheckoutReady(root);
  const binding = secretBinding(root);
  if (!binding || binding.status !== "recovery-required") throw new EncryptionError("recovery-required");
  const path = secretsRecoveryFile(root, filePath), stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new EncryptionError("verification-failed");
  const client = clientFor(binding), kit = JSON.parse(readFileSync(path, "utf8"));
  await client.security.invoke("recovery-confirm", { kit, code });
  await client.publishInitialization();
  await createEncryptedProject(client, binding.vaultId);
  const next: SecretBinding = { ...binding, enabled: true, status: "ready" };
  saveSecretBinding(root, next); return publicStatus(next);
}

/** Link an existing opaque secrets vault without enabling sync or downloading files. */
export async function linkSecretsVault(root: string, vaultId: string): Promise<SecretSyncStatus> {
  assertCheckoutReady(root);
  assertOrdinaryProject(root); UUID.parse(vaultId);
  return withProjectGate(root, async () => {
    assertCheckoutReady(root);
    const context = await verifiedSecretAccount(root), current = secretBinding(root);
    const mappings = await context.account.request<Array<{legacyVaultId:string;parentProjectId:string}>>("/v2/projects/secrets-migrations");
    if (mappings.some(row => row.legacyVaultId === vaultId && row.parentProjectId !== context.parent.projectId))
      throw new Error("This legacy secrets vault belongs to another cloud project. Choose its matching folder in Account Center.");
    if (current?.version === 2 && current.legacyVaultId === vaultId) return publicStatus(current);
    if (current?.version === 1 && current.vaultId === vaultId) return publicStatus(current);
    const server = selectedSecretServer(), client = AccountClient.forSecretVault(server, vaultId);
    await client.request(`${client.vaultBase}/state`, "GET", undefined, false);
    if (current) atomicJson(join(stateDirectory(root),`secrets-association-backup-${current.version === 2 ? current.resourceId : current.vaultId}-${current.checkoutId}.json`),current);
    const previous = readJson<SecretBinding>(join(stateDirectory(root),`legacy-secrets-${vaultId}.json`));
    const next: SecretBinding = { version: 1, server, vaultId,checkoutId:previous?.version === 1 ? previous.checkoutId : randomUUID(),
      enabled:current?.enabled ?? false,status:"migration-required",migration:"review-required",revision:previous?.revision ?? 0,
      error:"Legacy vault associated. Import its recovery file in Account Center if this computer cannot access it, then enable secrets sync for this folder." };
    saveSecretBinding(root, next); return publicStatus(next);
  }, { name: "Link secrets vault" });
}

/**
 * Why a secrets sync stopped without anything being wrong with the secrets: another Butler operation
 * held the project, or the cloud could not be reached. Both clear on their own, so they are retried
 * rather than shown as an error.
 */
export type SecretsSyncInterruption = "busy" | "offline";
export function secretsSyncInterruption(error: unknown): SecretsSyncInterruption | undefined {
  if (error instanceof OperationDeferredError || error instanceof EncryptionError && error.state === "lease-expired") return "busy";
  if (error instanceof EncryptionError || error instanceof SecretFolderError) return undefined;
  return classifyCloudSyncError(error).condition === "offline-network" ? "offline" : undefined;
}
/** Error states that name a condition and never a path or value, so they are safe to keep in local state. */
const NAMED_FAILURES = new Set(["authentication", "conflict", "upgrade-required", "integrity-failure"]);

export async function encryptedSecretsSync(root: string, capturedAccount?: AccountClient): Promise<SecretSyncStatus> {
  assertCheckoutReady(root);
  const initial = secretBinding(root);
  if (!initial?.enabled) return publicStatus(initial);
  if (initial.version === 1 && memoryBinding(root)?.encryptionVersion === 2)
    return await resumeAccountSecrets(root,capturedAccount) ?? publicStatus(secretBinding(root));
  try {
    return await withProjectGate(root, async () => {
      assertCheckoutReady(root);
      const state = secretBinding(root);
      if (!state?.enabled || state.vaultId !== initial.vaultId) return publicStatus(state);
      let account = capturedAccount;
      if (state.version === 2) {
        const context = await verifiedSecretAccount(root,capturedAccount);
        if (context.resourceId !== state.resourceId || context.parent.vaultId !== state.vaultId) throw new EncryptionError("verification-failed");
        account = context.account;
      }
      const resourceId = secretBindingResourceId(state);
      state.status = "syncing"; state.phase = "Checking encrypted vault"; delete state.error; saveSecretBinding(root, state);
      const client = clientFor(state,account), security = client.security;
      const cache = secretCacheDirectory(root); mkdirSync(cache, { recursive: true, mode: 0o700 });
      const journal = await security.invoke<SecretJournal | null>("sync-read", { checkoutId: state.checkoutId }) ?? {};
      const localStatus = await client.refreshVault(), trust = projectTrust(localStatus, resourceId), transport = new SecretTransport(client, trust);
      const decode = async (ref?: CacheRef): Promise<VerifiedSecrets | undefined> => ref
        ? openSecretFolder(security, trust, readEncryptedCache(cache, ref) as EncryptedBundle, undefined, ref.pin)
        : undefined;
      const ancestor = await decode(journal.applied), cached = await decode(journal.remote ?? journal.applied);
      const remote = await transport.pull(cached), pin = remote?.pin ?? EMPTY_PIN;
      state.phase = "Checking local files"; saveSecretBinding(root, state);
      if (remote) journal.remote = saveEncryptedCache(cache, remote);
      if (journal.conflictPin && (journal.conflictPin.revision !== pin.revision || journal.conflictPin.commitment !== pin.commitment)) {
        delete journal.resolutions;
      }
      const persist = async () => {
        await security.invoke("sync-save", { checkoutId: state.checkoutId, projectId: resourceId, pin, value: journal });
        state.revision = journal.applied?.pin.revision ?? 0;
        if (state.status === "synced") state.lastSync = new Date().toISOString();
        saveSecretBinding(root, state);
      };
      const installationId = localStatus.device?.installationId;
      if (!installationId) throw new EncryptionError("enrollment-required");
      const local = captureSecretFolder(root, resourceId, pin.revision, installationId);
      const localFingerprint = sha256(JSON.stringify(local.manifest.files));
      if (journal.conflicts?.length && journal.conflictLocalFingerprint !== localFingerprint) delete journal.resolutions;
      const merged = mergeSecretFiles(ancestor?.bundle, local, remote?.bundle, journal.resolutions);
      if (merged.conflicts.length) {
        journal.conflicts = merged.conflicts; journal.conflictPin = pin; journal.conflictLocalFingerprint = localFingerprint;
        state.status = "conflict"; delete state.phase; await persist(); return publicStatus(state, merged.conflicts);
      }
      await persist();
      applySecretFiles(root, local, merged.files);
      state.phase = "Uploading encrypted changes"; saveSecretBinding(root, state);
      const next = captureSecretFolder(root, resourceId, pin.revision, installationId);
      const prepared = await transport.prepare(next, remote);
      const accepted = prepared ? await transport.publish(prepared, remote) : remote;
      if (accepted) journal.applied = saveEncryptedCache(cache, accepted);
      if (journal.applied) journal.remote = journal.applied;
      else delete journal.remote;
      delete journal.conflicts; delete journal.conflictPin; delete journal.conflictLocalFingerprint; delete journal.resolutions;
      state.status = "synced"; delete state.phase; await persist();
      try { await pruneSecretCache(cache, security); } catch { /* Cleanup retries after the next successful sync. */ }
      return publicStatus(state);
    }, { name: "Encrypted secrets sync" });
  } catch (error) {
    const current = secretBinding(root);
    const interruption = secretsSyncInterruption(error);
    if (current?.enabled && current.vaultId === initial.vaultId && current.status !== "conflict") {
      if (interruption) {
        // Nothing failed: put back what the binding said before this attempt and let the next one run.
        current.status = initial.status === "syncing" ? "ready" : initial.status;
        if (initial.error === undefined) delete current.error; else current.error = initial.error;
      } else {
        // A folder problem keeps its explanation; it stays in local state and the desktop card, never watcher logs.
        const classified = classifyCloudSyncError(error).condition;
        current.status = "error";
        current.error = error instanceof SecretFolderError ? error.message : error instanceof EncryptionError ? error.state
          : NAMED_FAILURES.has(classified) ? classified : "sync-failed";
      }
      delete current.phase;
      saveSecretBinding(root, current);
    }
    throw error;
  }
}

export async function resolveSecretsConflict(root: string, path: string, choice: "local" | "remote"): Promise<SecretSyncStatus> {
  assertCheckoutReady(root);
  validateSecretPath(path);
  const state = secretBinding(root);
  if (state?.migration) return (await import("./migration.js")).resolveLegacyMigration(root,state,path,choice);
  if (!state?.enabled || state.status !== "conflict") throw new EncryptionError("conflict");
  await withProjectGate(root, async () => {
    assertCheckoutReady(root);
    const security = clientFor(state).security;
    const journal = await security.invoke<SecretJournal | null>("sync-read", { checkoutId: state.checkoutId });
    if (!journal?.conflicts?.includes(path)) throw new EncryptionError("conflict");
    journal.resolutions = { ...journal.resolutions, [path]: choice };
    const pin = journal.remote?.pin ?? EMPTY_PIN;
    await security.invoke("sync-save", { checkoutId: state.checkoutId, projectId: secretBindingResourceId(state), pin, value: journal });
  }, { name: "Resolve secrets conflict" });
  return encryptedSecretsSync(root);
}

/** Account bootstrap resumes only an already opted-in local secrets binding. */
export async function resumeAccountSecrets(root: string, capturedAccount?: AccountClient): Promise<SecretSyncStatus | undefined> {
  return withProjectGate(root,async()=>{
    const state = secretBinding(root);
    if (!state?.enabled || memoryBinding(root)?.encryptionVersion !== 2) return undefined;
    return setSecretsSyncEnabled(root,true,capturedAccount);
  },{name:"Resume opted-in account secrets"});
}
