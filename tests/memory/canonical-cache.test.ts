// Tests the revision-keyed caches behind readCanonicalTierPage() in src/retrieval/tiers.ts and revisionCached() in src/retrieval/canonical-revision.ts.
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "../../src/storage/store.js";
import { rememberProjectMemory } from "../../src/memory/remember.js";
import { resolveMemoryReview } from "../../src/memory/review.js";
import { readCanonicalTierPage, clearCanonicalIndexCache } from "../../src/retrieval/tiers.js";
import { canonicalRevision, clearRevisionCache, revisionCached } from "../../src/retrieval/canonical-revision.js";
import { makeTempDir, cleanupTempDir } from "../helpers/temp.js";
const stores: ReturnType<typeof openMemoryStore>[] = [], roots: string[] = [];
afterEach(() => {
    clearCanonicalIndexCache();
    clearRevisionCache();
    for (const store of stores.splice(0))
        store.close();
    for (const root of roots.splice(0))
        cleanupTempDir(root);
});
const now = "2026-10-01T12:00:00.000Z";
function fixture() { const root = makeTempDir(); roots.push(root); const store = openMemoryStore(root); store.init(); stores.push(store); return { root, store }; }
function save(store: ReturnType<typeof openMemoryStore>, text: string, promote = true) {
    return rememberProjectMemory(store, { type: "decision", text, scope: { kind: "project" }, layer: "core", promote }, { actor: "desktop" });
}
function uncached(store: ReturnType<typeof openMemoryStore>, input: Parameters<typeof readCanonicalTierPage>[1], at = now) {
    // A caller-owned transaction always builds a fresh index, which is the reference result.
    store.db.exec("begin");
    try { return readCanonicalTierPage(store, input, at); }
    finally { store.db.exec("rollback"); }
}
describe("canonical tier index cache", () => {
    it("serves the same page as a fresh build while the revision is unchanged", () => {
        const { store } = fixture();
        save(store, "Use SQLite for project storage.");
        save(store, "Consider a second desktop theme.", false);
        for (const input of [{ tier: "durable" as const }, { tier: "candidates" as const }, { tier: "durable" as const, query: "sqlite" }]) {
            const first = readCanonicalTierPage(store, input, now);
            const second = readCanonicalTierPage(store, input, now);
            expect(second).toEqual(first);
            expect(second).toEqual(uncached(store, input));
        }
    });
    it("rebuilds after a memory write and after a review", () => {
        const { store } = fixture();
        save(store, "Use SQLite for project storage.");
        expect(readCanonicalTierPage(store, { tier: "durable" }, now).total).toBe(1);
        save(store, "Use signed backup envelopes.");
        expect(readCanonicalTierPage(store, { tier: "durable" }, now).total).toBe(2);
        const candidate = save(store, "Try another theme layout.", false).candidate;
        expect(readCanonicalTierPage(store, { tier: "candidates" }, now).total).toBe(1);
        resolveMemoryReview(store, { memoryId: candidate.id, category: "candidate", action: "discard", reason: "No longer needed" }, "desktop");
        expect(readCanonicalTierPage(store, { tier: "candidates" }, now).total).toBe(0);
    });
    it("rebuilds after a direct SQL change because triggers journal it", () => {
        const { store } = fixture();
        const memory = save(store, "Use SQLite for project storage.").memory!;
        const before = canonicalRevision(store);
        expect(readCanonicalTierPage(store, { tier: "durable" }, now).total).toBe(1);
        store.db.prepare("update memories set lifecycle_status='superseded' where id=?").run(memory.id);
        expect(canonicalRevision(store)).not.toBe(before);
        expect(readCanonicalTierPage(store, { tier: "durable" }, now).total).toBe(0);
    });
    it("ignores last-sync stamps, which every watcher pass writes", () => {
        const { store } = fixture();
        save(store, "Use SQLite for project storage.");
        const before = canonicalRevision(store);
        store.db.prepare("insert into sync_sources (source, enabled, last_sync_at, last_success_at, last_error, metadata_json) values ('git', 1, ?, ?, null, '{}') on conflict(source) do update set last_sync_at = excluded.last_sync_at").run(now, now);
        expect(store.db.prepare("select count(*) n from retrieval_changes where entity = 'sync_sources'").get()).toMatchObject({ n: 1 });
        expect(canonicalRevision(store)).toBe(before);
    });
    it("expires working rows from a cached index at query time", () => {
        const { store } = fixture();
        store.upsertTemporaryMemory({ id: "soon", kind: "open_question", title: "Soon", summary: "An open project question.", createdAt: now, updatedAt: now, expiresAt: "2026-10-01T12:01:00.000Z" });
        store.upsertTemporaryMemory({ id: "later", kind: "open_question", title: "Later", summary: "Another open project question.", createdAt: now, updatedAt: now, expiresAt: "2026-10-01T13:00:00.000Z" });
        expect(readCanonicalTierPage(store, { tier: "working" }, now).total).toBe(2);
        const later = readCanonicalTierPage(store, { tier: "working" }, "2026-10-01T12:02:00.000Z");
        expect(later.items.map(item => item.id)).toEqual(["later"]);
        expect(later.counts.working).toBe(1);
    });
    it("does not keep an index built inside a caller's transaction", () => {
        const { store } = fixture();
        save(store, "Use SQLite for project storage.");
        store.db.exec("begin");
        save(store, "An uncommitted decision that is rolled back.");
        expect(readCanonicalTierPage(store, { tier: "durable" }, now).total).toBe(2);
        store.db.exec("rollback");
        expect(readCanonicalTierPage(store, { tier: "durable" }, now).total).toBe(1);
    });
});
describe("revisionCached", () => {
    it("reuses a value until a canonical change and bypasses the cache inside a transaction", () => {
        const { store } = fixture();
        let runs = 0;
        const read = () => revisionCached(store, "probe", () => ++runs);
        expect(read()).toBe(1);
        expect(read()).toBe(1);
        save(store, "Use SQLite for project storage.");
        expect(read()).toBe(2);
        store.db.exec("begin");
        try { expect(read()).toBe(3); expect(read()).toBe(4); }
        finally { store.db.exec("rollback"); }
        expect(read()).toBe(2);
    });
    it("keeps memory health counts current across reviews", () => {
        const { store } = fixture();
        const candidate = save(store, "Try another theme layout.", false).candidate;
        const before = store.getProjectSummary().memoryHealth!;
        resolveMemoryReview(store, { memoryId: candidate.id, category: "candidate", action: "discard", reason: "No longer needed" }, "desktop");
        const after = store.getProjectSummary().memoryHealth!;
        expect(after.retired).toBe(before.retired + 1);
    });
});
