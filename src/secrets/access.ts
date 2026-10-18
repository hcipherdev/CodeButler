import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { z } from "zod";
import { installationDeviceId } from "../memory/origin.js";
import { AccountClient } from "../cloud/account-client.js";
import { EncryptionError } from "../cloud/crypto-helper.js";
import { documentHash, type SignedVaultRecord } from "../cloud/identity-protocol.js";
import { UUID } from "../cloud/state.js";
import { projectTrust } from "../cloud/vault-client.js";
import { selectedSecretServer, secretBinding } from "./state.js";
import { secretsRecoveryFile } from "./sync.js";
import { SecretTransport, type PreparedSecretPublication } from "./transport.js";
import { binding as memoryBinding } from "../cloud/state.js";

const requestBundleSchema = z.object({ version: z.literal(1), accountId: UUID, deviceId: UUID,
  requests: z.array(z.object({ vaultId: UUID, requestId: UUID, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(10),
  enrolled: z.array(UUID).max(10) }).strict();
type RequestBundle = z.infer<typeof requestBundleSchema>;
const account = () => new AccountClient(selectedSecretServer());
async function vaultIds(): Promise<string[]> { return (await account().request<string[]>("/v2/secrets/vaults", "GET", undefined, false)).map(id => UUID.parse(id)); }
export const listSecretsVaults = vaultIds;
const secretClient = (id: string) => AccountClient.forSecretVault(selectedSecretServer(), id);

export interface SecretsAccessStatus {
  vaults: number;
  accessible: number;
  devices: Array<{ id: string; label: string; projects: number }>;
}
/** Report incomplete enrollment or revocation across projects after app restarts. */
export async function secretsAccessStatus(): Promise<SecretsAccessStatus> {
  const ids = await vaultIds();
  const devices = new Map<string, { id: string; label: string; projects: number }>();
  let accessible = 0;
  for (const vaultId of ids) {
    const client = secretClient(vaultId);
    try {
      const status = await client.refreshVault(); accessible++;
      const members = status.records.at(-1)?.record.devices ?? [];
      for (const member of members) {
        const previous = devices.get(member.id);
        devices.set(member.id, { id: member.id, label: member.label, projects: (previous?.projects ?? 0) + 1 });
      }
    } catch { /* A partial approval is shown by its accessible project count. */ }
  }
  return { vaults: ids.length, accessible,
    devices: [...devices.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)) };
}
export async function listSecretsDevices(): Promise<SecretsAccessStatus["devices"]> { return (await secretsAccessStatus()).devices; }

/** A single transferable code requests enrollment in every existing secrets vault. */
export async function requestAllSecretsAccess(label = hostname()): Promise<{ code: string; requested: number; alreadyEnrolled: number }> {
  const memory = await account().refreshVault();
  if (!memory.device || !memory.descriptor) throw new EncryptionError("enrollment-required");
  const ids = await vaultIds(), requests: RequestBundle["requests"] = [], enrolled: string[] = [];
  for (const vaultId of ids) {
    const client = secretClient(vaultId);
    try { await client.refreshVault(); enrolled.push(vaultId); continue; }
    catch (error) { if (!(error instanceof EncryptionError) || error.state !== "enrollment-required") throw error; }
    const local = await client.security.status().catch(() => null);
    const pending = local?.pendingRequest;
    if (pending?.vaultId === vaultId && pending.accountId === memory.descriptor.accountId && pending.expiresAt > Date.now()) {
      requests.push({ vaultId, requestId: pending.requestId, fingerprint: pending.fingerprint });
    } else {
      const request = await client.enrollmentRequest(label, memory.device.id);
      requests.push({ vaultId, ...request });
    }
  }
  const payload: RequestBundle = { version: 1, accountId: memory.descriptor.accountId, deviceId: memory.device.id, requests, enrolled };
  return { code: Buffer.from(JSON.stringify(payload)).toString("base64url"), requested: requests.length, alreadyEnrolled: enrolled.length };
}
function parseRequestCode(code: string): RequestBundle {
  if (code.length > 16000 || !/^[A-Za-z0-9_-]+$/.test(code)) throw new EncryptionError("verification-failed");
  try { return requestBundleSchema.parse(JSON.parse(Buffer.from(code, "base64url").toString("utf8"))); }
  catch { throw new EncryptionError("verification-failed"); }
}
export async function approveAllSecretsAccess(code: string): Promise<{ approved: number; pending: number; failedVaults: string[] }> {
  const bundle = parseRequestCode(code), memory = await account().refreshVault();
  if (bundle.accountId !== memory.descriptor?.accountId) throw new EncryptionError("verification-failed");
  const ids = await vaultIds();
  if (JSON.stringify([...bundle.requests.map(r => r.vaultId), ...bundle.enrolled].sort()) !== JSON.stringify([...ids].sort())) throw new EncryptionError("conflict");
  const failedVaults: string[] = []; let approved = 0;
  for (const vaultId of bundle.enrolled) {
    const state = await secretClient(vaultId).request<{ records: SignedVaultRecord[] }>(`/v2/secrets/vaults/${vaultId}/state`, "GET", undefined, false);
    if (!state.records.at(-1)?.record.devices.some(d => d.id === bundle.deviceId)) throw new EncryptionError("verification-failed");
  }
  for (const request of bundle.requests) {
    try {
      const client = secretClient(request.vaultId);
      const pending = await client.request<{ request: { record: { device: { id: string } } } }>(`${client.vaultBase}/enrollment/${request.requestId}`, "GET", undefined, false);
      if (pending.request.record.device.id !== bundle.deviceId) throw new EncryptionError("verification-failed");
      await client.approve(request.requestId, request.fingerprint); approved++;
    } catch { failedVaults.push(request.vaultId); }
  }
  return { approved, pending: failedVaults.length, failedVaults };
}
export async function completeAllSecretsAccess(): Promise<{ enrolled: number; pending: number }> {
  let enrolled = 0, pending = 0;
  for (const vaultId of await vaultIds()) {
    const client = secretClient(vaultId);
    try {
      try { await client.refreshVault(); enrolled++; continue; }
      catch (error) { if (!(error instanceof EncryptionError) || !["enrollment-required", "locked"].includes(error.state)) throw error; }
      const status = await client.security.status(), request = status.pendingRequest;
      if (request?.vaultId === vaultId) {
        const state = await client.request<{ descriptor: unknown }>(`${client.vaultBase}/state`, "GET", undefined, false);
        await client.complete(request.requestId, documentHash(state.descriptor));
      } else throw new EncryptionError("enrollment-required");
      enrolled++;
    } catch { pending++; }
  }
  return { enrolled, pending };
}

/** Re-encrypts the current head under a new epoch before committing a revocation or recovery. */
export async function rotateSecretVault(client: AccountClient, removeDeviceId?: string, recovery = false): Promise<void> {
  if (client.security.domain !== "secrets") throw new EncryptionError("verification-failed");
  let status = recovery ? await client.security.status() : await client.refreshVault();
  if (!status.descriptor) throw new EncryptionError("enrollment-required");
  if (!recovery && !status.records.at(-1)!.record.devices.some(d => d.id === removeDeviceId)) return;
  if (!recovery && status.device?.id === removeDeviceId) throw new Error("Revoke this device from another approved computer.");
  const staged = status.staged ?? await client.security.invoke<SignedVaultRecord>("rotation-stage", { removeDeviceId });
  if (staged.record.action !== (recovery ? "recover" : "revoke")) throw new EncryptionError("conflict");
  status = await client.security.status();
  if (!status.descriptor) throw new EncryptionError("enrollment-required");
  const projectId = status.descriptor.vaultId;
  const old = new SecretTransport(client, projectTrust(status, projectId)), current = await old.pull();
  let prepared: PreparedSecretPublication | undefined;
  if (current) {
    if (!status.device) throw new EncryptionError("enrollment-required");
    const next = new SecretTransport(client, projectTrust(status, projectId, true));
    prepared = await next.prepare({ ...current.bundle, manifest: { ...current.bundle.manifest,
      parentRevision: current.pin.revision, installationId: status.device.installationId } }, current, true);
  }
  const activate = async () => client.request(`${client.vaultBase}/${recovery ? "recover" : "activate"}`, "POST",
    { record: staged, replacements: prepared ? [{ envelope: prepared.envelope, receipt: prepared.receipt }] : [] }, !recovery);
  if (prepared) await new SecretTransport(client, projectTrust(status, projectId, true)).withUploaded(prepared, activate);
  else await activate();
  await client.security.invoke("stage-commit", { commitment: documentHash(staged) });
}
export async function revokeSecretsDevice(deviceId: string): Promise<{ revoked: number; pending: number; failedVaults: string[] }> {
  UUID.parse(deviceId);
  const failedVaults: string[] = []; let revoked = 0;
  for (const vaultId of await vaultIds()) {
    try { await rotateSecretVault(secretClient(vaultId), deviceId); revoked++; }
    catch { failedVaults.push(vaultId); }
  }
  return { revoked, pending: failedVaults.length, failedVaults };
}
export async function restoreSecretsProject(root: string, filePath: string, code: string, label = hostname()): Promise<void> {
  (await import("../cloud/checkout-path.js")).assertCheckoutReady(root);
  const binding = secretBinding(root);
  if (!binding) throw new EncryptionError("enrollment-required");
  if (binding.version === 2) throw new Error("Use Account Center account recovery for account-managed secrets.");
  filePath = secretsRecoveryFile(root, filePath);
  const info = lstatSync(filePath);
  if (!info.isFile() || info.size > 1024 * 1024) throw new EncryptionError("verification-failed");
  const memory = await account().refreshVault();
  if (!memory.device) throw new EncryptionError("enrollment-required");
  const client = secretClient(binding.vaultId), tokens = await client.tokens();
  const state = await client.request<{ records: SignedVaultRecord[] }>(`${client.vaultBase}/state`, "GET", undefined, false);
  await client.security.invoke("recovery-load", { kit: JSON.parse(readFileSync(filePath, "utf8")), code,
    accountId: tokens.accountId, records: state.records, deviceId: memory.device.id, installationId: installationDeviceId(), label });
  if (memoryBinding(root)?.encryptionVersion === 2) {
    // A legacy kit can decrypt its retained frozen source without changing its old membership or head.
    if (binding.enabled) await (await import("./sync.js")).setSecretsSyncEnabled(root,true);
    return;
  }
  await rotateSecretVault(client, undefined, true);
  if ((await vaultIds())[0] === binding.vaultId) {
    await AccountClient.forSecretVault(binding.server, binding.vaultId).secretIdentity!.invoke("identity-adopt", {
      sourceDirectory: client.security.directory, accountId: tokens.accountId, deviceId: memory.device.id
    });
  }
}
