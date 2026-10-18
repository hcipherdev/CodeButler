// Tests connection and catalog maintenance serialization against an in-flight encrypted sync coordinator.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withProjectGate, withProjectGateSync } from "../../src/cloud/gate.js";
import { atomicJson, binding, saveBinding, stateDirectory } from "../../src/cloud/state.js";
import { ensureProjectIdentity, readProjectIdentity } from "../../src/cloud/project-identity.js";
import { setEncryptedCloudSyncEnabled } from "../../src/cloud/sync-toggle.js";
import { retryCatalogMaintenance, separateProjectIdentity } from "../../src/cloud/project-connections.js";
import { openConfiguredMemoryStore } from "../../src/storage/open-configured-store.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const roots: string[] = [];
const temp = () => { const root = makeTempDir(); roots.push(root); return root; };
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) cleanupTempDir(root); });
it("waits for the coordinator before disabling or separating its active connection", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const root = temp(), store = openConfiguredMemoryStore(root);
  store.init(); store.close(); const marker = ensureProjectIdentity(root);
  saveBinding(root, { encryptionVersion: 2, projectIdentity: marker.projectIdentity, projectId: randomUUID(), vaultId: randomUUID(), checkoutId: randomUUID(), server: "http://127.0.0.1", enabled: true, status: "ready", revision: 0, fingerprint: "" });
  const pendingPath = join(stateDirectory(root), "catalog-maintenance.json");
  atomicJson(pendingPath, { ...binding(root), projectId: randomUUID() });
  for (const action of [() => setEncryptedCloudSyncEnabled(root, false), () => retryCatalogMaintenance(root), () => separateProjectIdentity(root)]) {
    let release!: () => void, started!: () => void;
    const ready = new Promise<void>(done => { started = done; }), blocked = new Promise<void>(done => { release = done; });
    const coordinator = withProjectGate(stateDirectory(root), async () => { started(); await blocked; }); await ready;
    let finished = false; const changing = action().finally(() => { finished = true; });
    try {
      await new Promise(done => setTimeout(done, 40)); expect(finished).toBe(false);
      expect(readProjectIdentity(root)!.projectIdentity).toBe(marker.projectIdentity);
    } finally { release(); await coordinator; await changing; }
  }
  expect(existsSync(pendingPath)).toBe(false);
  expect(binding(root)!.enabled).toBe(false); expect(binding(root)!.status).toBe("detached"); expect(readProjectIdentity(root)!.projectIdentity).not.toBe(marker.projectIdentity);
});

it("does not reclaim a synchronous gate held by a live operation", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const root = temp(); let called = false;
  let release!: () => void, acquired!: () => void;
  const ready = new Promise<void>(done => { acquired = done; }), blocked = new Promise<void>(done => { release = done; });
  const operation = withProjectGate(root, async () => { acquired(); await blocked; }); await ready;
  try { expect(() => withProjectGateSync(root, () => { called = true; }, "Interrupted migration retry")).toThrow("another local operation"); expect(called).toBe(false); }
  finally { release(); await operation; }
  expect(withProjectGateSync(root, () => "resumed", "Migration retry")).toBe("resumed");
});
