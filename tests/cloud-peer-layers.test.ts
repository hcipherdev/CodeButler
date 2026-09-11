import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";

import { CloudService, createCloudHttpServer } from "../src/cloud/service.js";
import { cloudSync } from "../src/cloud/client.js";
import { runCloudCommand } from "../src/cloud/cli.js";
import { atomicJson, binding, connectionPath } from "../src/cloud/state.js";
import { openConfiguredMemoryStore } from "../src/storage/open-configured-store.js";
import { rememberProjectMemory } from "../src/memory/remember.js";
import { updateMemoryLayer } from "../src/memory/layer-service.js";
import { updateMemoryStatus } from "../src/memory/lifecycle-service.js";
import { deviceLayer, layerLabel } from "../src/memory/layer.js";
import { planAutomaticPromotions } from "../src/memory/automatic-promotion.js";
import type { ProjectConfig } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

function promotionConfig(repoPath: string): ProjectConfig {
  return {
    promotion: {
      confidenceThreshold: 0.85,
      requireCommitAndConversation: true,
      minSourceCategories: 2,
      automatic: { enabled: true, mode: "conservative", minScore: 0.85, mergedBranches: true, deviceMemories: true }
    },
    sources: { git: { repoPath } }
  } as unknown as ProjectConfig;
}

const roots: string[] = []; const services: CloudService[] = []; const servers: ReturnType<typeof createCloudHttpServer>[] = [];
const temp = () => { const p = makeTempDir(); roots.push(p); return p; };
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
  for (const s of services.splice(0)) s.close();
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  for (const p of roots.splice(0)) cleanupTempDir(p);
});
function initialize(root: string) { const s = openConfiguredMemoryStore(root); s.init(); s.close(); }
function rememberLayered(root: string, text: string, layer: string) {
  const s = openConfiguredMemoryStore(root);
  try { s.init(); return rememberProjectMemory(s, { type: "decision", text, layer }).memory!; } finally { s.close(); }
}

/**
 * The shared-home fixture gives both checkouts one installation identity, which is the
 * right model for two checkouts of one machine but cannot express a peer. Partitions
 * are keyed by installation, so a peer test needs a distinct global home — and
 * therefore a distinct device.json — per device.
 */
async function twoDevices() {
  const service = new CloudService(temp()); services.push(service);
  const access = service.issue(); const server = createCloudHttpServer(service); servers.push(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const homeA = temp(), homeB = temp(), a = temp(), b = temp();
  const use = (home: string) => {
    vi.stubEnv("CODE_BUTLER_HOME", home);
    atomicJson(connectionPath(), { server: origin, secret: access.secret, vaultId: access.vaultId });
  };
  use(homeA); initialize(a);
  use(homeB); initialize(b);
  return { service, access, a, b, homeA, homeB, use };
}

it("shares a device's own layer with a peer read-only, and never the other way round", async () => {
  const { a, b, homeA, homeB, use } = await twoDevices();
  use(homeA);
  await runCloudCommand(["enable"], a, () => {});
  const projectId = binding(a)!.projectId;
  // Layers are shareable only when they name their writer, which the real device-layer
  // default always does.
  const ownLayer = deviceLayer();
  const localA = rememberLayered(a, "Device A is bisecting the retrieval regression.", ownLayer);
  await cloudSync(a);
  use(homeB);
  await runCloudCommand(["enable", "--project", projectId], b, () => {});
  await cloudSync(b);

  const received = openConfiguredMemoryStore(b);
  try {
    received.init();
    // Present, attributed to A's layer, and marked as another device's.
    const peer = received.listMemories({ owner: "peer", lifecycleStatus: "all", qualityStatus: "all", limit: null });
    expect(peer.map(memory => memory.id)).toContain(localA.id);
    expect(peer[0]!.layer).toBe(ownLayer);
    expect(layerLabel(peer[0]!.layer!)).toContain("Device-local");
    expect(received.db.prepare("select count(*) as n from peer_partitions").get()).toEqual({ n: 1 });

    // Default retrieval is unchanged: a peer's local note is not project truth here.
    const own = received.listMemories({ lifecycleStatus: "all", qualityStatus: "all", limit: null });
    expect(own.map(memory => memory.id)).not.toContain(localA.id);

    // Read-only: every write path refuses, because A republishes the partition itself.
    expect(() => updateMemoryLayer(received, { memoryId: localA.id, category: "promoted", layer: "core", reason: "Try to steal it." }))
      .toThrow("read-only");
    expect(() => updateMemoryStatus(received, { memoryId: localA.id, status: "retracted", reason: "Try to retract it.", now: new Date().toISOString() }))
      .toThrow("read-only");
    // Nor may automatic promotion adopt it.
    expect(planAutomaticPromotions(received, promotionConfig(b), { repoPath: b }).decisions
      .some(decision => decision.memoryId === localA.id)).toBe(false);
  } finally { received.close(); }

  // B publishing its own partition does not disturb A's, and neither conflicts.
  const localB = rememberLayered(b, "Device B holds the staging credentials.", deviceLayer());
  await cloudSync(b);
  expect(binding(b)!.status).not.toBe("conflict");
  use(homeA);
  await cloudSync(a);
  expect(binding(a)!.status).not.toBe("conflict");
  const backOnA = openConfiguredMemoryStore(a);
  try {
    backOnA.init();
    // A still owns its own rows, and now reads B's.
    expect(backOnA.listMemories({ lifecycleStatus: "all", qualityStatus: "all", limit: null }).map(memory => memory.id))
      .toContain(localA.id);
    expect(backOnA.listMemories({ owner: "peer", lifecycleStatus: "all", qualityStatus: "all", limit: null }).map(memory => memory.id))
      .toContain(localB.id);
  } finally { backOnA.close(); }
});

it("keeps every non-core row local when sharing is turned off", async () => {
  const { a, b, homeA, homeB, use } = await twoDevices();
  use(homeA);
  await runCloudCommand(["enable"], a, () => {});
  const projectId = binding(a)!.projectId;
  const path = join(a, ".code-butler", "config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.sync = { ...(config.sync ?? {}), shareLocalLayers: "none" };
  writeFileSync(path, JSON.stringify(config));

  const localA = rememberLayered(a, "Device A keeps this strictly local.", deviceLayer());
  await cloudSync(a);
  use(homeB);
  await runCloudCommand(["enable", "--project", projectId], b, () => {});
  await cloudSync(b);

  const received = openConfiguredMemoryStore(b);
  try {
    received.init();
    expect(received.listMemories({ owner: "any", lifecycleStatus: "all", qualityStatus: "all", limit: null })
      .map(memory => memory.id)).not.toContain(localA.id);
    expect(received.db.prepare("select count(*) as n from peer_partitions").get()).toEqual({ n: 0 });
  } finally { received.close(); }
});

