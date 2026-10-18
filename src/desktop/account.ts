import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { AccountClient } from "../cloud/account-client.js";
import { EncryptionError } from "../cloud/crypto-helper.js";
import { NativeSecurity } from "../cloud/native-security.js";
import { restoreRecovery, rotateVault } from "../cloud/vault-client.js";
import { atomicJson, readJson, serverUrl } from "../cloud/state.js";
import { globalConfigDir } from "../config.js";
import { automaticSyncStatus } from "./bootstrap.js";

interface AccountSelection { server: string; email?: string }
export interface DesktopAccountStatus {
  server?: string;
  email?: string;
  signedIn: boolean;
  verified: boolean;
  connection: "signed-out" | "online" | "offline" | "expired";
  device: "none" | "setup-pending" | "not-enrolled" | "enrolled" | "revoked";
  accountId?: string;
  createdAt?: number;
  projectCount?: number;
  deviceCount?: number;
  usedBytes?: number;
  limitBytes?: number;
  passwordSet?: boolean;
  passkeyCount?: number;
  pendingRequest?: { requestId: string; fingerprint: string; expiresAt: number };
  automaticSync?: import("./bootstrap.js").AccountBootstrapResult;
}

const selectionPath = () => join(globalConfigDir(), "cloud", "account.json");
const selected = (): AccountSelection | undefined => readJson<AccountSelection>(selectionPath());
function clientForSelected(): AccountClient {
  const selection = selected();
  if (!selection?.server) throw new EncryptionError("authentication-required");
  return new AccountClient(selection.server);
}
function recoveryPath(filePath: string): string {
  if (!isAbsolute(filePath)) throw new Error("Choose an absolute recovery file path.");
  return resolve(filePath);
}
function readRecoveryKit(filePath: string): unknown {
  const path = recoveryPath(filePath);
  const info = lstatSync(path);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error("Choose a valid recovery file smaller than 1 MiB.");
  const raw = readFileSync(path);
  if (raw.length > 1024 * 1024) throw new Error("The recovery file is too large.");
  return JSON.parse(raw.toString("utf8"));
}
function writeRecoveryKit(filePath: string, kit: unknown): void {
  const path = recoveryPath(filePath);
  const value = JSON.stringify(kit);
  if (existsSync(path)) {
    if (!lstatSync(path).isFile()) throw new Error("Choose a regular recovery file path.");
    if (readFileSync(path, "utf8") === value) return;
    throw new Error("The recovery file already exists. Choose a new file.");
  }
  writeFileSync(path, value, { flag: "wx", mode: 0o600 });
}

export async function localAccountStatus(): Promise<DesktopAccountStatus> {
  const selection = selected();
  if (!selection?.server) return { signedIn: false, verified: false, connection: "signed-out", device: "none" };
  const server = serverUrl(selection.server);
  const security = NativeSecurity.forServer(server);
  const tokens = await security.invoke<{ accountId: string } | null>("tokens-read");
  const local = await security.status();
  const sameAccount = tokens && local.descriptor?.accountId === tokens.accountId;
  const device = sameAccount && local.descriptor && local.device
    ? local.recoveryReady && local.records.length ? "enrolled" : "setup-pending"
    : local.device ? "not-enrolled" : "none";
  const pending = tokens && local.pendingRequest?.accountId === tokens.accountId
    ? { requestId: local.pendingRequest.requestId, fingerprint: local.pendingRequest.fingerprint, expiresAt: local.pendingRequest.expiresAt }
    : undefined;
  const automaticSync = tokens ? automaticSyncStatus(server, tokens.accountId) : undefined;
  return { server, ...(selection.email ? { email: selection.email } : {}), signedIn: Boolean(tokens), verified: false,
    connection: tokens ? "offline" : "signed-out", device, ...(tokens ? { accountId: tokens.accountId } : {}), ...(automaticSync ? { automaticSync } : {}), ...(pending ? { pendingRequest: pending } : {}) };
}

export async function accountSummary(): Promise<DesktopAccountStatus> {
  const local = await localAccountStatus();
  if (!local.signedIn || !local.server) return local;
  const client = new AccountClient(local.server, NativeSecurity.forServer(local.server), 8000);
  try {
    const profile = await client.profile();
    atomicJson(selectionPath(), { server: local.server, email: profile.email });
    const result: DesktopAccountStatus = { ...local, email: profile.email, accountId: profile.id, createdAt: profile.createdAt,
      passwordSet: profile.passwordSet, passkeyCount: profile.passkeyCount, verified: true, connection: "online" };
    try {
      const vaultState = await client.request<{ descriptor: { vaultId: string } }>("/v2/vault/state", "GET", undefined, false);
      const localState = await client.security.status();
      if (localState.descriptor?.vaultId !== vaultState.descriptor.vaultId || localState.descriptor?.accountId !== profile.id) {
        result.device = "not-enrolled";
        if (localState.pendingRequest?.vaultId !== vaultState.descriptor.vaultId) delete result.pendingRequest;
        return result;
      }
      await client.refreshVault();
      const vault = await client.vaultSummary();
      Object.assign(result, { device: "enrolled", ...vault });
    } catch (error) {
      if (error instanceof EncryptionError && error.state === "revoked") result.device = "revoked";
      else if (error instanceof EncryptionError && error.state === "enrollment-required") {
        result.device = local.pendingRequest ? "not-enrolled" : local.device === "setup-pending" ? "setup-pending" : "none";
      }
      else if (local.device === "enrolled") result.verified = false;
    }
    return result;
  } catch (error) {
    return { ...local, connection: error instanceof EncryptionError && error.state === "authentication-required" ? "expired" : "offline" };
  }
}

export function accountCapabilities(server: string): Promise<{ registrationEnabled: boolean; passwordEnabled: boolean; passkeyEnabled: boolean }> {
  return new AccountClient(serverUrl(server)).capabilities();
}
export function accountChallenge(server: string, email: string, purpose: "register" | "login" | "reset"): Promise<{ challengeId: string; expiresAt: number }> {
  return new AccountClient(serverUrl(server)).challenge(email, purpose);
}
export async function accountVerify(server: string, email: string, challengeId: string, code: string): Promise<DesktopAccountStatus> {
  const normalizedServer = serverUrl(server);
  const client = new AccountClient(normalizedServer);
  await client.login(challengeId, code);
  atomicJson(selectionPath(), { server: normalizedServer, email: email.trim().toLowerCase() });
  return accountSummary();
}
export async function accountRegister(server: string, email: string, challengeId: string, code: string, password: string): Promise<DesktopAccountStatus> {
  const normalizedServer = serverUrl(server), client = new AccountClient(normalizedServer);
  await client.register(challengeId, code, password);
  atomicJson(selectionPath(), { server: normalizedServer, email: email.trim().toLowerCase() });
  return accountSummary();
}
export async function accountPasswordLogin(server: string, email: string, password: string): Promise<DesktopAccountStatus> {
  const normalizedServer = serverUrl(server), client = new AccountClient(normalizedServer);
  await client.passwordLogin(email, password);
  atomicJson(selectionPath(), { server: normalizedServer, email: email.trim().toLowerCase() });
  return accountSummary();
}
export async function accountSetPassword(password: string, currentPassword?: string): Promise<DesktopAccountStatus> {
  await clientForSelected().setPassword(password, currentPassword);
  return accountSummary();
}
export function accountResetVerify(server: string, challengeId: string, code: string): Promise<{ resetToken: string; expiresAt: number }> {
  return new AccountClient(serverUrl(server)).verifyReset(challengeId, code);
}
export async function accountResetComplete(server: string, resetToken: string, password: string): Promise<{ reset: true }> {
  await new AccountClient(serverUrl(server)).resetPassword(resetToken, password);
  return { reset: true };
}
export async function accountPasskeyStart(server: string, kind: "login" | "add", redirectUri: string, label?: string): Promise<{ url: string; verifier: string; state: string }> {
  const selectedServer = kind === "add" ? clientForSelected().server : serverUrl(server);
  return new AccountClient(selectedServer).passkeyStart(kind, redirectUri, label);
}
export async function accountPasskeyExchange(server: string, kind: "login" | "add", code: string, verifier: string, state: string): Promise<DesktopAccountStatus> {
  const selectedServer = kind === "add" ? clientForSelected().server : serverUrl(server);
  const client = new AccountClient(selectedServer);
  await client.passkeyExchange(kind, code, verifier, state);
  const profile = await client.profile();
  atomicJson(selectionPath(), { server: selectedServer, email: profile.email });
  return accountSummary();
}
export function accountPasskeys(): Promise<Array<{ id: string; name: string; createdAt: number; lastUsed?: number }>> {
  return clientForSelected().listPasskeys();
}
export async function accountPasskeyRemove(id: string): Promise<{ removed: true }> {
  await clientForSelected().removePasskey(id);
  return { removed: true };
}
export async function accountLogout(): Promise<{ remoteRevoked: boolean }> {
  const selection = selected();
  if (!selection?.server) return { remoteRevoked: true };
  return { remoteRevoked: await new AccountClient(selection.server).logout() };
}
export async function vaultPrepare(filePath: string, label = hostname()): Promise<{ code: string }> {
  const client = clientForSelected();
  const local = await client.security.status();
  const tokens = await client.tokens();
  if (local.descriptor && local.descriptor.accountId !== tokens.accountId) {
    throw new Error("This computer has secure vault state for another account on this server. Use its recovery file on a separate device profile.");
  }
  try {
    await client.request("/v2/vault/state", "GET", undefined, false);
    throw new Error("This account already has a vault. Enroll this device or restore access.");
  } catch (error) {
    if (!(error instanceof EncryptionError && error.state === "enrollment-required")) throw error;
  }
  const status = await client.initialize(label);
  if (status.recoveryReady) throw new Error("This vault is already initialized.");
  const exported = await client.security.invoke<{ kit: unknown; code: string }>("recovery-export");
  writeRecoveryKit(filePath, exported.kit);
  return { code: exported.code };
}
export async function vaultConfirm(filePath: string, code: string): Promise<{ initialized: true }> {
  const client = clientForSelected();
  await client.security.invoke("recovery-confirm", { kit: readRecoveryKit(filePath), code });
  await client.publishInitialization();
  return { initialized: true };
}
export async function deviceRequest(label = hostname()): Promise<{ requestId: string; fingerprint: string; expiresAt: number }> {
  const result = await clientForSelected().enrollmentRequestAnchored(label);
  return { ...result, expiresAt: Date.now() + 590000 };
}
export function deviceApprove(fingerprint: string): Promise<{ approved: true }> {
  return clientForSelected().approveFingerprint(fingerprint);
}
export function enrollmentPoll(): Promise<{ status: "none" | "pending" | "enrolled" | "cancelled" | "expired" | "revoked"; expiresAt?: number }> {
  return clientForSelected().enrollmentProgress();
}
export async function accountDevices(): Promise<Array<{ id: string; label: string; current: boolean }>> {
  const client = clientForSelected(), state = await client.refreshVault();
  return (state.records.at(-1)?.record.devices ?? []).map(device => ({ id: device.id, label: device.label, current: device.id === state.device?.id }));
}
export async function accountDeviceRevoke(deviceId: string): Promise<{ revoked: true }> {
  await rotateVault(clientForSelected(), deviceId);
  return { revoked: true };
}
export async function deviceComplete(requestId: string, fingerprint: string): Promise<{ enrolled: true }> {
  await clientForSelected().complete(requestId, fingerprint);
  return { enrolled: true };
}
export async function deviceCancel(requestId: string): Promise<{ status: "none" | "pending" | "enrolled" | "cancelled" | "expired" | "revoked"; expiresAt?: number }> {
  const client = clientForSelected();
  return client.cancelEnrollment(requestId);
}
export async function recoveryRestore(filePath: string, code: string, label = hostname()): Promise<{ restored: true }> {
  await restoreRecovery(clientForSelected(), recoveryPath(filePath), code, label);
  return { restored: true };
}
