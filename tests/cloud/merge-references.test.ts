// Tests that mergeCore() in src/cloud/merge.ts checks foreign keys after the whole plan and repairs pointers to deleted memories, and that applyCoreMerge() in src/cloud/client.ts drops the recovery backup of a merge that rolled back.
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { applyCoreMerge } from "../../src/cloud/client.js";
import { applySnapshot, bundleResolver, captureSnapshot, materializeSnapshot } from "../../src/cloud/snapshot.js";
import { stateDirectory } from "../../src/cloud/state.js";
import { rememberProjectMemory } from "../../src/memory/remember.js";
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
const capture = async (root: string) => { const result = await captureSnapshot(root, randomUUID(), 0); return { manifest: result.snapshot, blocks: result.blocks }; };
const memoryIds = (root: string) => withStore(root, store => (store.db.prepare("select id from memories order by id").all() as Array<{ id: string }>).map(row => row.id));
const recoveryFiles = (root: string) => readdirSync(join(root, ".code-butler")).filter(name => name.startsWith("memory.sqlite.recovery-"));
type Row = Record<string, string | number | null>;
function insertRow(store: MemoryStore, table: string, row: Row): void {
  const columns = Object.keys(row);
  store.db.prepare(`insert into ${table} (${columns.map(name => `"${name}"`).join(", ")}) values (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
}
const insertCopy = (store: MemoryStore, table: string, row: Row, change: (row: Row) => Row) => insertRow(store, table, { ...row, ...change(row) });

/** Two checkouts that agreed on three memories, after which the cloud side deleted the first one but kept its candidate. */
async function cloudDeletedKeepingCandidate() {
  vi.stubEnv("CODE_BUTLER_HOME", temp());
  const local = temp(), cloud = temp();
  const ids = [0, 1, 2].map(i => withStore(local, store => rememberProjectMemory(store, { type: "decision", text: `Subsystem ${i} owns its own retry policy.` }).memory!.id));
  mkdirSync(stateDirectory(local), { recursive: true });
  const ancestor = await capture(local);
  withStore(cloud, () => undefined);
  applySnapshot(cloud, materializeSnapshot(ancestor.manifest, bundleResolver(ancestor.blocks)));
  const deleted = ids[0]!;
  withStore(cloud, store => {
    store.db.prepare("update memory_candidates set promoted_memory_id = null where promoted_memory_id = ?").run(deleted);
    store.db.prepare("delete from memories where id = ?").run(deleted);
  });
  return { local, ancestor, remote: await capture(cloud), deleted, kept: ids.slice(1) };
}

it("deletes a memory whose candidate the other device updated rather than deleted", async () => {
  const { local, ancestor, remote, deleted, kept } = await cloudDeletedKeepingCandidate();
  applyCoreMerge(local, remote, ancestor);
  expect(memoryIds(local)).toEqual([...kept].sort());
  // The candidate survives, no longer pointing at the deleted memory.
  expect(withStore(local, store => store.db.prepare("select count(*) n from memory_candidates where promoted_memory_id = ?").get(deleted))).toEqual({ n: 0 });
  expect(withStore(local, store => store.db.prepare("pragma foreign_key_check").all())).toEqual([]);
}, 60000);

it("clears the pointer of a candidate this device kept when the other device deleted its memory", async () => {
  const { local, ancestor, remote, deleted, kept } = await cloudDeletedKeepingCandidate();
  // Both devices edited the same candidate, and this device also added one pointing at the deleted memory.
  withStore(local, store => {
    store.db.prepare("update memory_candidates set updated_at = ? where promoted_memory_id = ?").run(new Date(Date.now() + 60_000).toISOString(), deleted);
    insertCopy(store, "memory_candidates", store.db.prepare("select * from memory_candidates where promoted_memory_id = ?").get(deleted) as Row,
      row => ({ id: randomUUID(), dedupe_key: `${String(row.dedupe_key)}:local-copy` }));
  });
  applyCoreMerge(local, remote, ancestor);
  expect(memoryIds(local)).toEqual([...kept].sort());
  expect(withStore(local, store => store.db.prepare("select count(*) n from memory_candidates where promoted_memory_id = ?").get(deleted))).toEqual({ n: 0 });
  expect(withStore(local, store => store.db.prepare("pragma foreign_key_check").all())).toEqual([]);
}, 60000);

it("fails a merge that leaves a reference it cannot repair, rolls it back and keeps no backup", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp());
  const local = temp(), cloud = temp();
  const memory = withStore(local, store => rememberProjectMemory(store, { type: "decision", text: "Subsystem 0 owns its own retry policy." }).memory!.id);
  const resolution = randomUUID();
  withStore(local, store => insertRow(store, "memory_review_resolutions", { id: resolution, memory_id: memory, category: "promoted", layer: "core",
    memory_version: "v1", context_fingerprint: "f", action: "verify", reason: "Checked.", reviewed_at: new Date().toISOString(), actor: "cli" }));
  mkdirSync(stateDirectory(local), { recursive: true });
  const ancestor = await capture(local);
  withStore(cloud, () => undefined);
  applySnapshot(cloud, materializeSnapshot(ancestor.manifest, bundleResolver(ancestor.blocks)));
  withStore(cloud, store => store.db.prepare("delete from memory_review_resolutions where id = ?").run(resolution));
  const remote = await capture(cloud);
  // This device reverted the review the other device deleted.
  withStore(local, store => insertRow(store, "memory_review_resolution_compensations", { id: randomUUID(), resolution_id: resolution, memory_id: memory,
    category: "promoted", layer: "core", reason: "Undone.", reverted_at: new Date().toISOString(), actor: "cli" }));
  expect(() => applyCoreMerge(local, remote, ancestor)).toThrow(/rolled back: .*memory_review_resolution_compensations .*memory_review_resolutions/);
  expect(withStore(local, store => store.db.prepare("select count(*) n from memory_review_resolutions where id = ?").get(resolution))).toEqual({ n: 1 });
  expect(recoveryFiles(local)).toEqual([]);
}, 60000);
