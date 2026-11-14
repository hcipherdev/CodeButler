// Tests ensureSharedChangeTriggers() and readSharedChangeSignal() in src/storage/shared-changes.ts: only writes a snapshot carries move the counter.
import { afterEach, describe, expect, it, vi } from "vitest";

import { rememberProjectMemory } from "../src/memory/remember.js";
import { openConfiguredMemoryStore } from "../src/storage/open-configured-store.js";
import { ensureSharedChangeTriggers, readSharedChangeSignal } from "../src/storage/shared-changes.js";
import type { MemoryStore } from "../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(cleanupTempDir); });

function withStore<T>(work: (store: MemoryStore) => T): T {
  const home = makeTempDir(); roots.push(home); vi.stubEnv("CODE_BUTLER_HOME", home);
  const root = makeTempDir(); roots.push(root);
  const store = openConfiguredMemoryStore(root);
  try { store.init(); return work(store); } finally { store.close(); }
}
const writes = (store: MemoryStore) => (store.db.prepare("select shared_writes as n from cloud_change_counter").get() as { n: number }).n;

describe("shared change counter", () => {
  it("counts writes to synced tables and ignores per-device bookkeeping", () => withStore(store => {
    const start = writes(store);
    store.db.prepare("insert or replace into sync_sources (source, enabled, last_sync_at) values ('git', 1, ?)").run(new Date().toISOString());
    store.db.prepare("insert or replace into sync_cursors (source, cursor_key, cursor_value, updated_at) values ('git', 'head', 'abc', ?)").run(new Date().toISOString());
    store.db.prepare("update sync_sources set last_success_at = ? where source = 'git'").run(new Date().toISOString());
    expect(writes(store)).toBe(start);
    rememberProjectMemory(store, { type: "decision", text: "Counted: memories are synced." });
    expect(writes(store)).toBeGreaterThan(start);
  }));

  it("brings back its row and covers tables added after the migration", () => withStore(store => {
    store.db.exec("delete from cloud_change_counter");
    store.db.exec("create table later_shared (id text primary key, note text)");
    ensureSharedChangeTriggers(store.db);
    expect(writes(store)).toBe(0);
    store.db.exec("insert into later_shared values ('a', 'b')");
    expect(writes(store)).toBe(1);
    // Idempotent: a second run adds nothing and counts nothing.
    const triggers = (store.db.prepare("select count(*) as n from sqlite_master where type = 'trigger' and name like 'cloud_change_%'").get() as { n: number }).n;
    ensureSharedChangeTriggers(store.db);
    expect((store.db.prepare("select count(*) as n from sqlite_master where type = 'trigger' and name like 'cloud_change_%'").get() as { n: number }).n).toBe(triggers);
    expect(writes(store)).toBe(1);
  }));

  it("reports no signal for a database without the counter, so callers fall back", () => withStore(store => {
    expect(readSharedChangeSignal(store.db)).toMatch(/^shared:\d+:26$/);
    store.db.exec("delete from cloud_change_counter");
    expect(readSharedChangeSignal(store.db)).toBeUndefined();
  }));
});
