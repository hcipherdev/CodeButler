// Tests localCloudChangeStamp() in src/cloud/client.ts with real databases: bookkeeping is no change, synced writes and project files are, and snapshots strip the counter.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { localCloudChangeStamp } from "../../src/cloud/client.js";
import { bundleResolver, captureSnapshot, materializeSnapshot } from "../../src/cloud/snapshot.js";
import { rememberProjectMemory } from "../../src/memory/remember.js";
import { openConfiguredMemoryStore } from "../../src/storage/open-configured-store.js";
import { ensureSharedChangeTriggers } from "../../src/storage/shared-changes.js";
import type { MemoryStore } from "../../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(cleanupTempDir); });
function project(): string {
  const home = makeTempDir(); roots.push(home); vi.stubEnv("CODE_BUTLER_HOME", home);
  const root = makeTempDir(); roots.push(root);
  withStore(root, () => undefined);
  return root;
}
function withStore<T>(root: string, work: (store: MemoryStore) => T): T {
  const store = openConfiguredMemoryStore(root);
  try { store.init(); return work(store); } finally { store.close(); }
}

describe("local cloud change stamp", () => {
  it("ignores a watcher pass recording its last-synced time", () => {
    const root = project();
    const before = localCloudChangeStamp(root);
    withStore(root, store => store.db.prepare("insert or replace into sync_sources (source, enabled, last_sync_at) values ('codex', 1, ?)").run(new Date().toISOString()));
    expect(localCloudChangeStamp(root)).toBe(before);
  });

  it("changes for a remembered memory and for edited project files", () => {
    const root = project();
    const start = localCloudChangeStamp(root);
    withStore(root, store => rememberProjectMemory(store, { type: "decision", text: "Stamped: a synced write." }));
    const remembered = localCloudChangeStamp(root);
    expect(remembered).not.toBe(start);
    writeFileSync(join(root, ".code-butler", "project-summary.md"), "# Summary\nEdited.\n");
    expect(localCloudChangeStamp(root)).not.toBe(remembered);
  });

  it("falls back to file times for a database without the counter, and still sees a write", () => {
    const root = project();
    const db = new DatabaseSync(join(root, ".code-butler", "memory.sqlite"));
    try { db.exec("delete from cloud_change_counter"); } finally { db.close(); }
    const before = localCloudChangeStamp(root);
    const raw = new DatabaseSync(join(root, ".code-butler", "memory.sqlite"));
    try { raw.exec("insert or replace into sync_sources (source, enabled, last_sync_at) values ('git', 1, 'later')"); } finally { raw.close(); }
    expect(localCloudChangeStamp(root)).not.toBe(before);
  });

  it("ships snapshots without the counter row, and a restored database counts again after init", async () => {
    const root = project();
    withStore(root, store => rememberProjectMemory(store, { type: "decision", text: "Travels: the memory, not the counter." }));
    const captured = await captureSnapshot(root, randomUUID(), 0);
    const restored = join(makeTempDir(), "restored.sqlite"); roots.push(join(restored, ".."));
    writeFileSync(restored, materializeSnapshot(captured.snapshot, bundleResolver(captured.blocks)).files.find(file => file.path === "memory.sqlite")!.data);
    const db = new DatabaseSync(restored);
    try {
      expect(db.prepare("select count(*) as n from cloud_change_counter").get()).toEqual({ n: 0 });
      ensureSharedChangeTriggers(db);
      db.exec("update memories set summary = summary || ' (edited)'");
      expect((db.prepare("select shared_writes as n from cloud_change_counter").get() as { n: number }).n).toBeGreaterThan(0);
    } finally { db.close(); }
  }, 60_000);
});
