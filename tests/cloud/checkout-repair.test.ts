// Tests filesystem identity, lossless checkout migration, crash recovery, alias conflicts, and unchanged rejected repairs.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicJson, binding, canonicalRoot, readJson, sha256, stateDirectory, type Binding } from "../../src/cloud/state.js";
import { checkoutNeedsRepair, checkoutRepairPath, normalizeWindowsRoot, type CheckoutRepairRecord } from "../../src/cloud/checkout-path.js";
import { migrateCheckout, migrateRegisteredCheckouts, reviewCheckoutRepair } from "../../src/cloud/checkout-repair.js";
import { setEncryptedCloudSyncEnabled } from "../../src/cloud/sync-toggle.js";
import { separateProjectIdentity, inspectProjectConnection } from "../../src/cloud/project-connections.js";
import { secretBinding } from "../../src/secrets/state.js";
import { ensureProjectConfig } from "../../src/config.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

let home: string, root: string, state: Binding;
beforeEach(() => {
  home = makeTempDir(); root = makeTempDir(); vi.stubEnv("CODE_BUTLER_HOME", home); ensureProjectConfig(root);
  state = { encryptionVersion: 2, projectId: randomUUID(), vaultId: randomUUID(), checkoutId: randomUUID(), enabled: true, revision: 42, fingerprint: "a".repeat(64), server: "https://example.test", status: "conflict", pending: { uploadId: randomUUID(), fingerprint: "b".repeat(64), parentRevision: 42 } };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); cleanupTempDir(home); cleanupTempDir(root); });
const alias = () => canonicalRoot(root).replace(/^[A-Z](?=:)/, c => c.toLowerCase());
const legacyDirectory = () => join(home,"cloud","checkouts",sha256(alias()));
function legacy() {
  const dir = legacyDirectory(); atomicJson(join(dir,"binding.json"),state);
  atomicJson(join(dir,"secrets-binding.json"),{version:1,checkoutId:randomUUID(),vaultId:randomUUID(),server:state.server,enabled:false,status:"disabled",revision:7});
  writeFileSync(join(dir,"pending-encrypted.bin"),Buffer.from([0,1,2,255]));
  mkdirSync(join(dir,"cache")); writeFileSync(join(dir,"cache","encrypted.bin"),Buffer.from([4,5,6]));
  atomicJson(join(dir,"conflict.json"),{revision:41});
  atomicJson(join(home,"watch","projects",`${sha256(alias().toLowerCase())}.json`),{root:alias(),registeredAt:"2020-01-01"});
  return dir;
}

describe("canonical checkout paths", () => {
  it("normalizes extended Windows prefixes without folding folder case", () => {
    expect(normalizeWindowsRoot("\\\\?\\c:\\Projects\\CaseSensitive")).toBe("C:\\Projects\\CaseSensitive");
    expect(normalizeWindowsRoot("\\\\?\\UNC\\server\\share\\Case")).toBe("\\\\server\\share\\Case");
    expect(normalizeWindowsRoot("C:\\Projects\\caseSensitive")).not.toBe(normalizeWindowsRoot("C:\\Projects\\CaseSensitive"));
  });
  it.runIf(process.platform === "win32")("resolves drive/folder case, separators and extended paths to one physical checkout", () => {
    const expected = stateDirectory(root);
    for (const path of [alias(), root.toUpperCase(), root.replace(/\\/g,"/"), `\\\\?\\${root}`]) expect(stateDirectory(path)).toBe(expected);
  });
});

describe.runIf(process.platform === "win32")("legacy checkout migration", () => {
  it("backs up and restores all state exactly once, including IDs, pending work and secrets opt-in", () => {
    const old = legacy(), secret = secretBinding(root)!;
    expect(checkoutNeedsRepair(root)).toBe(true); expect(binding(root)).toMatchObject({enabled:true,status:"connection-repair-required"});
    migrateRegisteredCheckouts();
    expect(binding(root)).toEqual(state); expect(binding(alias())).toEqual(state);
    expect(secretBinding(root)).toMatchObject({checkoutId:secret.checkoutId,enabled:false,revision:7,status:"disabled"});
    const dir = stateDirectory(root); expect(readFileSync(join(dir,"pending-encrypted.bin"))).toEqual(Buffer.from([0,1,2,255]));
    expect(readFileSync(join(dir,"cache","encrypted.bin"))).toEqual(Buffer.from([4,5,6])); expect(readJson(join(dir,"conflict.json"))).toEqual({revision:41});
    expect(checkoutNeedsRepair(root)).toBe(false); expect(existsSync(join(old,"binding.json"))).toBe(false);
    const record = readJson<CheckoutRepairRecord>(checkoutRepairPath(root))!;
    expect(readJson(join(record.backup,record.selected,"binding.json"))).toEqual(state);
    const backups = readdirSync(join(home,"cloud","checkout-recovery-backups")); migrateRegisteredCheckouts();
    expect(readdirSync(join(home,"cloud","checkout-recovery-backups"))).toEqual(backups); expect(binding(root)).toEqual(state);
  });
  it("keeps conflicting bindings paused and rejects stale choices without changing either side", async () => {
    const old = legacy(), current = {...state,projectId:randomUUID(),checkoutId:randomUUID(),revision:99}; atomicJson(join(stateDirectory(root),"binding.json"),current);
    migrateCheckout(root); const review = reviewCheckoutRepair(root);
    expect(review.candidates).toHaveLength(2); expect(review.recommended).toBe(sha256(canonicalRoot(root)));
    expect((await inspectProjectConnection(root)).recognition).toBe("repair-required");
    await expect(setEncryptedCloudSyncEnabled(root,true,{createNew:true})).rejects.toThrow("Connection needs review");
    await expect(separateProjectIdentity(root)).rejects.toThrow("Connection needs review");
    atomicJson(join(old,"conflict.json"),{revision:43});
    expect(() => migrateCheckout(root,{key:review.recommended!,fingerprint:review.fingerprint})).toThrow("changed since the review");
    expect(readJson(join(old,"binding.json"))).toEqual(state); expect(readJson(join(stateDirectory(root),"binding.json"))).toEqual(current);
    const refreshed = reviewCheckoutRepair(root); migrateCheckout(root,{key:refreshed.recommended!,fingerprint:refreshed.fingerprint});
    expect(binding(root)).toEqual(current); expect(existsSync(join(old,"archived-connection.json"))).toBe(true);
    const record = readJson<CheckoutRepairRecord>(checkoutRepairPath(root))!; expect(readJson(join(record.backup,sha256(alias()),"binding.json"))).toEqual(state);
  });
  it("resumes a prepared migration and its dead operation gates before allowing sync", () => {
    const old = legacy(), backup = join(home,"cloud","checkout-recovery-backups",randomUUID()); mkdirSync(backup,{recursive:true});
    const selected = sha256(alias()); cpSync(old,join(backup,selected),{recursive:true});
    const files=["binding.json","pending-encrypted.bin","secrets-binding.json","conflict.json","cache/encrypted.bin"];
    const record: CheckoutRepairRecord = {version:1,root:canonicalRoot(root),phase:"prepared",candidates:[selected],selected,backup,files,sources:Object.fromEntries(files.map(path=>[path,selected])),hashes:Object.fromEntries(files.map(path=>[path,sha256(readFileSync(join(backup,selected,path)))])),fingerprint:reviewCheckoutRepair(root).fingerprint};
    atomicJson(checkoutRepairPath(root),record); atomicJson(join(stateDirectory(root),"binding.json"),{broken:true});
    const stopped = spawnSync(process.execPath,["-e","process.exit(0)"],{windowsHide:true});
    expect(stopped.status).toBe(0);
    for (const directory of [root, old, stateDirectory(root), join(home,"cloud","checkout-migration")]) {
      atomicJson(join(directory,".code-butler",".cloud-operation.lock"),{pid:stopped.pid,token:randomUUID(),startedAt:new Date().toISOString()});
    }
    expect(checkoutNeedsRepair(root)).toBe(true); migrateCheckout(root); expect(binding(root)).toEqual(state);
    expect(readJson<CheckoutRepairRecord>(checkoutRepairPath(root))!.phase).toBe("complete");
    for (const directory of [root, old, stateDirectory(root), join(home,"cloud","checkout-migration")]) expect(existsSync(join(directory,".code-butler",".cloud-operation.lock"))).toBe(false);
  });
  it("does not infer missing or unrelated folders from display names", () => {
    const dir=legacyDirectory(); atomicJson(join(dir,"binding.json"),state);
    atomicJson(join(home,"watch","projects",`${sha256("missing")}.json`),{root:resolve(root,"missing"),registeredAt:"2020",name:root});
    migrateRegisteredCheckouts(); expect(existsSync(join(dir,"binding.json"))).toBe(true);
  });
  it("leaves abandoned scratch captures in place while backing up every persistent state file", () => {
    const old=legacy(),name=`capture-123-${randomUUID()}.sqlite-shm`;writeFileSync(join(old,name),"Transient SQLite scratch bytes");
    migrateCheckout(root);const record=readJson<CheckoutRepairRecord>(checkoutRepairPath(root))!;
    expect(binding(root)).toEqual(state);expect(existsSync(join(old,name))).toBe(true);expect(existsSync(join(record.backup,record.selected,name))).toBe(false);
  });
  it("consolidates one memory binding with complementary secrets settings without importing unbound legacy memory", () => {
    const memory=stateDirectory(root),old=legacyDirectory();atomicJson(join(memory,"binding.json"),state);
    const secrets={version:1,checkoutId:randomUUID(),vaultId:randomUUID(),server:state.server,enabled:false,status:"recovery-required",revision:0};atomicJson(join(old,"secrets-binding.json"),secrets);
    writeFileSync(join(old,"memory-local.sqlite"),"Unbound legacy cache");
    mkdirSync(join(old,"secrets-cache"));writeFileSync(join(old,"secrets-cache","encrypted.bin"),Buffer.from([7,8]));
    migrateCheckout(root);expect(binding(root)).toEqual(state);expect(secretBinding(root)).toEqual(secrets);expect(existsSync(join(memory,"memory-local.sqlite"))).toBe(false);
    expect(readFileSync(join(memory,"secrets-cache","encrypted.bin"))).toEqual(Buffer.from([7,8]));
    const record=readJson<CheckoutRepairRecord>(checkoutRepairPath(root))!;expect(readFileSync(join(record.backup,sha256(alias()),"memory-local.sqlite"),"utf8")).toBe("Unbound legacy cache");
  });
});
