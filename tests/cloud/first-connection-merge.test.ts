// Tests applyCoreMerge() without an ancestor (first connection) and enforceSourceTombstones() in src/cloud/client.ts and src/privacy/service.ts.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";

import { applyCoreMerge } from "../../src/cloud/client.js";
import { captureSnapshot } from "../../src/cloud/snapshot.js";
import { stateDirectory } from "../../src/cloud/state.js";
import { rememberProjectMemory } from "../../src/memory/remember.js";
import { deletePrivacySource } from "../../src/privacy/service.js";
import { openConfiguredMemoryStore } from "../../src/storage/open-configured-store.js";
import type { MemoryStore } from "../../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const roots: string[] = [];
const temp = () => { const path = makeTempDir(); roots.push(path); return path; };
afterEach(() => { vi.unstubAllEnvs(); for (const path of roots.splice(0)) cleanupTempDir(path); });

function withStore<T>(root: string, work: (store: MemoryStore) => T): T {
  const store = openConfiguredMemoryStore(root);
  try { store.init(); return work(store); } finally { store.close(); }
}
const remember = (root: string, text: string) => withStore(root, store => rememberProjectMemory(store, { type: "decision", text }));
const summaries = (root: string) => withStore(root, store => store
  .listMemories({ layer: "core", lifecycleStatus: "all", qualityStatus: "all", limit: null }).map(memory => memory.summary).sort());
const addSource = (root: string, id: string) => withStore(root, store => store.addSourceWithChunks({
  source: { id, type: "conversation", title: id, origin: `test:${id}`, rawContent: `body of ${id}` }, chunks: [{ text: `body of ${id}` }]
}));
const hasSource = (root: string, id: string) => withStore(root, store => store.readSource(id) !== undefined);
const tombstones = (root: string) => withStore(root, store => Number((store.db.prepare("select count(*) n from source_tombstones").get() as { n: number }).n));

/** Two devices that built memory independently, never sharing a revision. */
function devices() {
  vi.stubEnv("CODE_BUTLER_HOME", temp());
  const local = temp(), remote = temp();
  withStore(local, () => undefined); withStore(remote, () => undefined);
  mkdirSync(stateDirectory(local), { recursive: true }); // The coordinator creates it before any merge.
  return { local, remote, capture: async (root: string) => { const result = await captureSnapshot(root, randomUUID(), 0); return { manifest: result.snapshot, blocks: result.blocks }; } };
}

it("keeps both sides' memories and converges a fact both devices recorded", async () => {
  const { local, remote, capture } = devices();
  remember(local, "Local devices index commits nightly.");
  remember(remote, "Cloud devices keep embeddings local.");
  remember(local, "Retrieval uses reciprocal rank fusion.");
  remember(remote, "Retrieval uses reciprocal rank fusion.");

  const result = applyCoreMerge(local, await capture(remote));

  expect(result.complete).toBe(true);
  const merged = summaries(local);
  expect(merged).toEqual(expect.arrayContaining(["Local devices index commits nightly.", "Cloud devices keep embeddings local."]));
  expect(merged.filter(summary => summary === "Retrieval uses reciprocal rank fusion.")).toHaveLength(1);
});

it("does not resurrect a source the other device forgot", async () => {
  const { local, remote, capture } = devices();
  addSource(local, "shared-chat"); addSource(remote, "shared-chat");
  withStore(remote, store => deletePrivacySource(store, { sourceId: "shared-chat", confirmSourceId: "shared-chat" }));
  expect(hasSource(local, "shared-chat")).toBe(true);

  applyCoreMerge(local, await capture(remote));

  expect(hasSource(local, "shared-chat")).toBe(false);
  expect(tombstones(local)).toBe(1);
});

it("keeps a local privacy deletion when the cloud copy still holds the source", async () => {
  const { local, remote, capture } = devices();
  addSource(local, "private-chat"); addSource(remote, "private-chat");
  withStore(local, store => deletePrivacySource(store, { sourceId: "private-chat", confirmSourceId: "private-chat" }));

  applyCoreMerge(local, await capture(remote));

  expect(hasSource(local, "private-chat")).toBe(false);
});
