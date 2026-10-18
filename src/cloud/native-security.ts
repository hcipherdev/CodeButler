import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { globalConfigDir } from "../config.js";
import { CryptoHelper, EncryptionError } from "./crypto-helper.js";
import type { DeviceIdentity, SignedDocument, SignedVaultRecord, VaultDescriptor } from "./identity-protocol.js";
import type { RevisionPin } from "./encrypted-protocol.js";
import { sha256 } from "./state.js";

export interface SecurityStatus {
  device: DeviceIdentity | null; descriptor: VaultDescriptor | null;
  records: SignedVaultRecord[]; projects: Record<string, number>; pins: Record<string, RevisionPin>; recoveryReady: boolean;
  staged: SignedVaultRecord | null;
  recoveryLoaded?: boolean;
  pendingRequest: { requestId: string; accountId: string; vaultId: string; expiresAt: number; fingerprint: string; kind?: string; version?: number } | null;
}
export interface ProjectKeyRef { projectId: string; epoch: number; staged?: boolean }
export interface DeviceKeyRef { deviceId: string }
export function nativeExecutable(): string {
  const name = process.platform === "win32" ? "butler-crypto.exe" : "butler-crypto";
  const packaged = fileURLToPath(new URL(`../native/${process.platform}-${process.arch}/${name}`, import.meta.url));
  if (existsSync(packaged)) {
    try { const manifest=JSON.parse(readFileSync(join(packaged,"..","manifest.json"),"utf8")) as {sha256:string}; if(sha256(readFileSync(packaged))!==manifest.sha256) throw new Error(); return packaged; }
    catch {throw new EncryptionError("verification-failed");}
  }
  // Development resolution is relative to this module, never an arbitrary user's cwd.
  const development = fileURLToPath(new URL(`../../native/butler-crypto/target/debug/${name}`,import.meta.url));
  if (existsSync(development)) return development;
  throw new EncryptionError("locked");
}
/** All private keys stay in Rust. The only references crossing IPC are IDs and epochs. */
export class NativeSecurity extends CryptoHelper {
  constructor(readonly directory: string, readonly executablePath = nativeExecutable(), readonly domain: "memory" | "secrets" = "memory", readonly parentProjectId?: string) { super(executablePath); }
  static forServer(server: string): NativeSecurity { return new NativeSecurity(join(globalConfigDir(), "cloud", "security", sha256(server))); }
  static forAccountSecrets(server: string, parentProjectId: string): NativeSecurity {
    return new NativeSecurity(join(globalConfigDir(), "cloud", "security", sha256(server)), nativeExecutable(), "secrets", parentProjectId);
  }
  asAccountSecrets(parentProjectId: string): NativeSecurity {
    return new NativeSecurity(this.directory, this.executablePath, "secrets", parentProjectId);
  }
  static forSecretsVault(server: string, vaultId: string): NativeSecurity {
    return new NativeSecurity(join(globalConfigDir(), "cloud", "secrets-security", sha256(server), vaultId), nativeExecutable(), "secrets");
  }
  static forSecretsDevice(server: string): NativeSecurity {
    return new NativeSecurity(join(globalConfigDir(), "cloud", "secrets-device", sha256(server)), nativeExecutable(), "secrets");
  }
  async invoke<T>(operation: string, input: object = {}): Promise<T> {
    for(let attempt=0;;attempt++) {
      try {return (await this.call({ directory: this.directory, operation, ...input, domain: this.parentProjectId ? "memory" : this.domain })).result as T;}
      catch(error){if(!(error instanceof EncryptionError)||error.state!=="locked"||attempt>=3)throw error;await delay(100*(attempt+1));}
    }
  }
  status(): Promise<SecurityStatus> { return this.invoke("status"); }
  async sealOrOpen(operation: "seal" | "open", ref: ProjectKeyRef, purpose: "block" | "manifest", items: Buffer[]): Promise<Buffer[]> {
    const result = await this.invoke<{ items: string[] }>(this.parentProjectId ? "secrets-crypto" : "crypto", { mode: operation, projectId:ref.projectId, ...(this.parentProjectId ? { parentProjectId: this.parentProjectId } : {}), epoch:ref.epoch,staged:ref.staged??false, purpose, items: items.map(b => b.toString("base64")) });
    if (result.items.length !== items.length) throw new EncryptionError("verification-failed");
    return result.items.map(item => Buffer.from(item, "base64"));
  }
  async signEnvelope(ref: ProjectKeyRef, message: Buffer): Promise<{ publicKey: string; signature: string }> {
    return this.invoke(this.parentProjectId ? "secrets-crypto" : "crypto", { mode: "sign", projectId:ref.projectId, ...(this.parentProjectId ? { parentProjectId: this.parentProjectId } : {}), epoch:ref.epoch,staged:ref.staged??false, purpose: "manifest", items: [message.toString("base64")] });
  }
  async verifyEnvelope(ref: ProjectKeyRef, publicKey: string, signature: string, message: Buffer): Promise<void> {
    await this.invoke(this.parentProjectId ? "secrets-crypto" : "crypto", { mode: "verify", projectId:ref.projectId, ...(this.parentProjectId ? { parentProjectId: this.parentProjectId } : {}), epoch:ref.epoch, publicKey, signature, purpose: "manifest", items: [message.toString("base64")] });
  }
  signDocument<T>(record: T): Promise<SignedDocument<T>> { return this.invoke("document-sign", { record }); }
  verifyDocument(signed: SignedDocument, publicKey: string): Promise<unknown> { return this.invoke("document-verify", { signed, publicKey }); }
}
