// Tests automaticMergeHold() and the temporary-memory path masking in src/cloud/merge.ts, applyCoreMerge() hold/keepBackup options in src/cloud/client.ts, and retainMergeBackup() in src/privacy/backup.ts.
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyCoreMerge } from "../../src/cloud/client.js";
import { automaticMergeHold, MergeHeldError } from "../../src/cloud/merge.js";
import { applySnapshot, bundleResolver, captureSnapshot, materializeSnapshot } from "../../src/cloud/snapshot.js";
import { stateDirectory } from "../../src/cloud/state.js";
import { rememberProjectMemory } from "../../src/memory/remember.js";
import { retainMergeBackup } from "../../src/privacy/backup.js";
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
const memoryCount = (root: string) => withStore(root, store => Number((store.db.prepare("select count(*) n from memories").get() as { n: number }).n));
const recoveryFiles = (root: string) => readdirSync(join(root, ".code-butler")).filter(name => name.startsWith("memory.sqlite.recovery-") && name.endsWith(".sqlite"));
const recoverySidecars = (root: string) => readdirSync(join(root, ".code-butler")).filter(name => name.startsWith("memory.sqlite.recovery-") && !name.endsWith(".sqlite"));

/** Two checkouts that agreed on `count` memories, after which the cloud side deleted `deleted` of them. */
async function cloudDeleted(count: number, deleted: number) {
  vi.stubEnv("CODE_BUTLER_HOME", temp());
  const local = temp(), cloud = temp();
  const ids = Array.from({ length: count }, (_, i) => withStore(local, store => rememberProjectMemory(store, { type: "decision", text: `Subsystem ${i} owns its own retry policy.` }).memory!.id));
  mkdirSync(stateDirectory(local), { recursive: true });
  const ancestor = await capture(local);
  withStore(cloud, () => undefined);
  applySnapshot(cloud, materializeSnapshot(ancestor.manifest, bundleResolver(ancestor.blocks)));
  withStore(cloud, store => { for (const id of ids.slice(0, deleted)) {
    store.db.prepare("delete from memory_candidates where promoted_memory_id = ?").run(id);
    store.db.prepare("delete from memories where id = ?").run(id);
  } });
  return { local, ancestor, remote: await capture(cloud) };
}

describe("automatic merge hold", () => {
  it("holds at 20 or more deletions above 15% of shared memories, or 30% below 50 memories", () => {
    expect(automaticMergeHold({ shared: 200, deleted: 19 })).toBeUndefined();
    expect(automaticMergeHold({ shared: 200, deleted: 30 })).toBeUndefined();
    expect(automaticMergeHold({ shared: 200, deleted: 31 })).toBe("large-deletion");
    expect(automaticMergeHold({ shared: 100, deleted: 20 })).toBe("large-deletion");
    expect(automaticMergeHold({ shared: 150, deleted: 20 })).toBeUndefined();
    expect(automaticMergeHold({ shared: 49, deleted: 19 })).toBeUndefined();
    expect(automaticMergeHold({ shared: 49, deleted: 20 })).toBe("large-deletion");
  });

  it("rolls back a held merge and leaves no backup behind", async () => {
    const { local, ancestor, remote } = await cloudDeleted(25, 20);
    let held: unknown;
    try { applyCoreMerge(local, remote, ancestor, { hold: automaticMergeHold, keepBackup: true }); } catch (error) { held = error; }
    expect(held).toBeInstanceOf(MergeHeldError);
    // Each remembered memory also has the candidate it was promoted from, so both counts include candidates.
    const { shared, deleted } = (held as MergeHeldError).summary;
    expect(deleted / shared).toBeCloseTo(20 / 25);
    expect(memoryCount(local)).toBe(25);
    expect(recoveryFiles(local)).toEqual([]);
  }, 60000);

  it("applies a merge below the hold and keeps its pre-merge backup", async () => {
    const { local, ancestor, remote } = await cloudDeleted(25, 2);
    const result = applyCoreMerge(local, remote, ancestor, { hold: automaticMergeHold, keepBackup: true });
    expect(memoryCount(local)).toBe(23);
    expect(result.backup).toMatch(/memory\.sqlite\.recovery-merge-/);
    expect(recoveryFiles(local)).toEqual([result.backup!.split(/[\\/]/).at(-1)]);
    expect(recoverySidecars(local).every(name => name.startsWith("memory.sqlite.recovery-merge-"))).toBe(true);
  }, 60000);
});

it("treats temporary memories that differ only in checkout path as unchanged, and keeps this checkout's path", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp());
  const local = temp(), cloud = temp();
  const insert = (root: string) => withStore(root, store => store.db.prepare(`insert into temporary_memories (id, project_id, kind, title, summary, details, related_files_json, evidence_json, confidence, created_at, updated_at, expires_at)
    values ('temporary-1', ?, 'task_state', 't', 's', 'd', '[]', '[]', 0.5, '2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`).run(root));
  insert(local); insert(cloud);
  mkdirSync(stateDirectory(local), { recursive: true });
  const ancestor = await capture(local), remote = await capture(cloud);
  const result = applyCoreMerge(local, remote, ancestor);
  expect(result.decisions.filter(d => d.table === "temporary_memories")).toEqual([]);
  expect(withStore(local, store => (store.db.prepare("select project_id from temporary_memories").get() as { project_id: string }).project_id)).toBe(local);
}, 60000);

it("keeps only the newest three merge backups", () => {
  const dir = temp(), database = join(dir, "memory.sqlite"), now = Date.now() / 1000;
  writeFileSync(join(dir, "memory.sqlite.recovery-unrelated.sqlite"), "");
  const kept = Array.from({ length: 5 }, (_, i) => {
    const backup = join(dir, `memory.sqlite.recovery-2026-10-14T0${i}-00-00-000Z-${randomUUID()}.sqlite`);
    writeFileSync(backup, ""); utimesSync(backup, now + i, now + i);
    const path = retainMergeBackup(database, backup); utimesSync(path, now + i, now + i); return path;
  });
  const names = readdirSync(dir);
  expect(names).toContain("memory.sqlite.recovery-unrelated.sqlite");
  expect(names.filter(name => name.startsWith("memory.sqlite.recovery-merge-")).sort()).toEqual(kept.slice(2).map(path => path.split(/[\\/]/).at(-1)).sort());
});
