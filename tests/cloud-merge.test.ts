import { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";

import { CloudService, createCloudHttpServer } from "../src/cloud/service.js";
import { cloudSync } from "../src/cloud/client.js";
import { runCloudCommand } from "../src/cloud/cli.js";
import { atomicJson, binding, connectionPath } from "../src/cloud/state.js";
import { openConfiguredMemoryStore } from "../src/storage/open-configured-store.js";
import type { MemoryStore } from "../src/storage/store.js";
import { rememberProjectMemory } from "../src/memory/remember.js";
import { updateMemoryStatus } from "../src/memory/lifecycle-service.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

const roots: string[] = []; const services: CloudService[] = []; const servers: ReturnType<typeof createCloudHttpServer>[] = [];
const temp = () => { const p = makeTempDir(); roots.push(p); return p; };
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
  for (const s of services.splice(0)) s.close();
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  for (const p of roots.splice(0)) cleanupTempDir(p);
});

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
  const initialize = (root: string) => { const s = openConfiguredMemoryStore(root); s.init(); s.close(); };
  use(homeA); initialize(a);
  use(homeB); initialize(b);
  return { service, a, b, homeA, homeB, use };
}

function withStore<T>(root: string, work: (store: MemoryStore) => T): T {
  const store = openConfiguredMemoryStore(root);
  try { store.init(); return work(store); } finally { store.close(); }
}

function remember(root: string, text: string): string {
  return withStore(root, store => rememberProjectMemory(store, { type: "decision", text }).memory!.id);
}

function summaries(root: string): string[] {
  return withStore(root, store => store
    .listMemories({ layer: "core", lifecycleStatus: "all", qualityStatus: "all", limit: null })
    .map(memory => memory.summary)
    .sort());
}

/** Both devices in sync, then each edits core offline. */
async function diverge() {
  const devices = await twoDevices();
  const { a, b, homeA, homeB, use } = devices;
  use(homeA);
  await runCloudCommand(["enable"], a, () => {});
  const projectId = binding(a)!.projectId;
  const shared = remember(a, "Retrieval uses reciprocal rank fusion.");
  await cloudSync(a);
  use(homeB);
  await runCloudCommand(["enable", "--project", projectId], b, () => {});
  await cloudSync(b);
  expect(summaries(b)).toEqual(summaries(a));
  return { ...devices, projectId, shared };
}

it("merges disjoint core edits from both devices instead of discarding a side", async () => {
  const { a, b, homeA, homeB, use } = await diverge();

  // Each device adds a different fact while offline from the other.
  use(homeA);
  remember(a, "Deterministic extraction handles typed directives.");
  await cloudSync(a);
  use(homeB);
  remember(b, "Embeddings stay local by default.");
  await expect(cloudSync(b)).resolves.toMatchObject({ status: "conflict" });

  const merged = await cloudSync(b, "merge");
  expect(merged?.status).toBe("synced");
  // Nothing was thrown away: B holds all three facts and publishes them.
  expect(summaries(b)).toEqual([
    "Deterministic extraction handles typed directives.",
    "Embeddings stay local by default.",
    "Retrieval uses reciprocal rank fusion."
  ]);
  use(homeA);
  await cloudSync(a);
  expect(summaries(a)).toEqual(summaries(b));
});

it("does not resurrect a memory the other device retracted", async () => {
  const { a, b, homeA, homeB, use, shared } = await diverge();

  // A retracts the shared fact; B independently adds an unrelated one.
  use(homeA);
  withStore(a, store => updateMemoryStatus(store, {
    memoryId: shared,
    status: "retracted",
    reason: "Superseded by the hybrid design.",
    now: new Date().toISOString()
  }));
  await cloudSync(a);
  use(homeB);
  remember(b, "Embeddings stay local by default.");
  await expect(cloudSync(b)).resolves.toMatchObject({ status: "conflict" });

  await cloudSync(b, "merge");
  // A union would have restored the retraction to `current`; a three-way merge knows
  // the difference between "absent" and "removed".
  const state = withStore(b, store => store.readMemory(shared));
  expect(state?.lifecycleStatus).toBe("retracted");
  expect(summaries(b)).toContain("Embeddings stay local by default.");
});

it("flags a contradiction instead of silently choosing between two claims", async () => {
  const { a, b, homeA, homeB, use } = await diverge();

  // Both devices rewrite the same memory to say different things.
  const edit = (root: string, summary: string) => withStore(root, store => {
    store.db.prepare("update memories set summary = ?, status_changed_at = ? where id = (select id from memories where layer = 'core' limit 1)")
      .run(summary, new Date().toISOString());
  });
  use(homeA);
  edit(a, "Retrieval uses lexical search only.");
  await cloudSync(a);
  use(homeB);
  edit(b, "Retrieval uses dense vectors only.");
  await expect(cloudSync(b)).resolves.toMatchObject({ status: "conflict" });

  await cloudSync(b, "merge");
  const reviewed = withStore(b, store => store
    .listMemories({ layer: "core", lifecycleStatus: "all", qualityStatus: "needs_review", limit: null }));
  expect(reviewed).toHaveLength(1);
  expect(reviewed[0]!.qualityReasons).toContain("cloud_merge_conflict");
  // The local version is kept rather than overwritten, pending an explicit decision.
  expect(reviewed[0]!.summary).toBe("Retrieval uses dense vectors only.");
});

it("refuses to merge once the shared ancestor revision has been pruned", async () => {
  const { a, b, homeA, homeB, use, projectId, service } = await diverge();

  use(homeA);
  remember(a, "Deterministic extraction handles typed directives.");
  await cloudSync(a);
  use(homeB);
  remember(b, "Embeddings stay local by default.");
  await expect(cloudSync(b)).resolves.toMatchObject({ status: "conflict" });

  // The service keeps five revisions; beyond that there is no way to tell an addition
  // from a deletion, so merging is refused rather than guessed.
  service.db.prepare("delete from revisions where project_id = ? and revision <= ?")
    .run(projectId, binding(b)!.revision);
  await expect(cloudSync(b, "merge")).rejects.toThrow("ancestor revision is no longer retained");
  // Choosing a side still works, so a pruned ancestor is never a dead end.
  await expect(cloudSync(b, "local")).resolves.toMatchObject({ status: "synced" });
});

it("keeps a remote deletion even when this device edited the same row", async () => {
  const { a, b, homeA, homeB, use, shared } = await diverge();

  // A deletes the shared memory outright — the shape a privacy deletion takes — while
  // B edits the very same row.
  use(homeA);
  withStore(a, store => {
    store.db.prepare("delete from memory_candidates where promoted_memory_id = ?").run(shared);
    store.db.prepare("delete from memory_links where owner_kind = 'memory' and owner_id = ?").run(shared);
    store.db.prepare("delete from memories where id = ?").run(shared);
  });
  await cloudSync(a);
  use(homeB);
  withStore(b, store => {
    store.db.prepare("update memories set summary = ?, status_changed_at = ? where id = ?")
      .run("Retrieval uses hybrid search.", new Date().toISOString(), shared);
  });
  await expect(cloudSync(b)).resolves.toMatchObject({ status: "conflict" });

  await cloudSync(b, "merge");
  // Resurrecting it would undo a deliberate deletion; the edit is recoverable from the
  // backup the merge takes first.
  expect(withStore(b, store => store.readMemory(shared))).toBeUndefined();
});

it("converges when both devices independently recorded the same fact", async () => {
  const { a, b, homeA, homeB, use } = await diverge();

  // The same text on both sides derives the same dedupe key under different ids, which
  // collides on the uniqueness key rather than on the primary key.
  const same = "Deterministic extraction handles typed directives.";
  use(homeA);
  remember(a, same);
  await cloudSync(a);
  use(homeB);
  remember(b, same);
  await expect(cloudSync(b)).resolves.toMatchObject({ status: "conflict" });

  await expect(cloudSync(b, "merge")).resolves.toMatchObject({ status: "synced" });
  // One fact, once — not a duplicate and not a failed merge.
  expect(summaries(b).filter(summary => summary === same)).toHaveLength(1);
});

it("is idempotent: merging an already merged state changes nothing", async () => {
  const { a, b, homeA, homeB, use } = await diverge();
  use(homeA);
  remember(a, "Deterministic extraction handles typed directives.");
  await cloudSync(a);
  use(homeB);
  remember(b, "Embeddings stay local by default.");
  await expect(cloudSync(b)).resolves.toMatchObject({ status: "conflict" });
  await cloudSync(b, "merge");

  const before = summaries(b);
  const revision = binding(b)!.revision;
  const merges = () => withStore(b, store => store.listOperations({ operationType: "cloud_merge", limit: null }).length);
  const mergeCount = merges();

  // A second sync has nothing to reconcile and nothing to publish.
  await cloudSync(b);
  expect(summaries(b)).toEqual(before);
  expect(binding(b)!.revision).toBe(revision);
  expect(merges()).toBe(mergeCount);
});
