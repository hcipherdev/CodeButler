// Tests published memory tiers, filter/count agreement, expiry cursors, and working-context actions.
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "../../src/storage/store.js";
import { rememberProjectMemory } from "../../src/memory/remember.js";
import { resolveMemoryReview } from "../../src/memory/review.js";
import { createWorkingCandidate } from "../../src/memory/working.js";
import { publishRetrieval, closeRetrievalReaders, withPublishedIndex } from "../../src/retrieval/index.js";
import { readPublishedTierPage, readPublishedTiers, readCanonicalTierPage, readCanonicalFreshness } from "../../src/retrieval/tiers.js";
import { makeTempDir, cleanupTempDir } from "../helpers/temp.js";
const stores: ReturnType<typeof openMemoryStore>[] = [], roots: string[] = [];
afterEach(() => {
    closeRetrievalReaders();
    for (const store of stores.splice(0))
        store.close();
    for (const root of roots.splice(0))
        cleanupTempDir(root);
});
const now = "2026-10-01T12:00:00.000Z";
function fixture() { const root = makeTempDir(); roots.push(root); const store = openMemoryStore(root); store.init(); stores.push(store); return { root, store }; }
function save(store: ReturnType<typeof openMemoryStore>, text: string, promote = true, layer = "core") {
    return rememberProjectMemory(store, { type: "decision", text, scope: { kind: "project" }, layer, promote }, { actor: "desktop" });
}
describe("memory tiers", () => {
    it("counts current rows and separates candidate, durable, history and human verification", () => {
        const { root, store } = fixture();
        const current = save(store, "Use SQLite for project storage.").memory!;
        save(store, "Consider a second desktop theme.", false);
        const discarded = save(store, "Try another theme layout.", false).candidate;
        resolveMemoryReview(store, { memoryId: discarded.id, category: "candidate", action: "discard", reason: "No longer needed" }, "desktop");
        const old = save(store, "Use an old backup format.").memory!;
        store.updateMemoryLifecycle(old.id, { lifecycleStatus: "superseded" });
        const verified = save(store, "Use signed backup envelopes.", false).candidate;
        store.upsertMemoryCandidate({ ...verified, confidence: 0.55 });
        const durable = store.promoteMemoryCandidate(verified.id);
        resolveMemoryReview(store, { memoryId: durable.id, category: "promoted", action: "verify" }, "desktop");
        store.upsertTemporaryMemory({ kind: "task_state", title: "Sync work", summary: "Investigating an encrypted sync failure.", createdAt: now, updatedAt: now, expiresAt: "2026-10-02T12:00:00.000Z" });
        publishRetrieval(store, root, "fixture");
        const counts = readPublishedTiers(root, now).counts;
        expect(counts).toMatchObject({ working: 1, candidates: 1, durable: 2, verified: 1, replaced: 1 });
        expect(readPublishedTierPage(root, { tier: "durable" }, now).items.map(m => m.id).sort()).toEqual([current.id, durable.id].sort());
        expect(readPublishedTierPage(root, { tier: "durable", history: true }, now).total).toBe(3);
        expect(readPublishedTierPage(root, { tier: "verified" }, now).items.map(m => m.id)).toEqual([durable.id]);
        expect(readPublishedTierPage(root, { tier: "durable", history: true, verifiedOnly: true }, now).items.map(m => m.id)).toEqual([durable.id]);
        expect(readPublishedTierPage(root, { tier: "candidates" }, now).total).toBe(1);
    });
    it("applies reach, owner, quality, type and query before paging and counting", () => {
        const { root, store } = fixture();
        const peer = "device:11111111-1111-4111-8111-111111111111";
        save(store, "Use SQLite offline.");
        save(store, "Use SQLite for branch work.", true, "branch:topic:device:22222222-2222-4222-8222-222222222222");
        save(store, "Use SQLite on another machine.", true, peer);
        store.db.prepare("insert into peer_partitions values('peer',?,'writer','fingerprint',?)").run(peer, now);
        publishRetrieval(store, root, "fixture");
        for (const reach of ["all", "project", "device", "branch", "branch_device"] as const)
            for (const owner of ["self", "peer", "any"] as const) {
                const input = { tier: "durable" as const, reach, owner, query: "sqlite", qualityStatus: "all" as const, type: "decision", limit: 1 };
                const page = readPublishedTierPage(root, input, now);
                const all = readPublishedTierPage(root, { ...input, limit: 100 }, now);
                expect(page.total).toBe(all.items.length);
                if (page.nextCursor)
                    expect(readPublishedTierPage(root, { ...input, cursor: page.nextCursor }, now).items[0]?.id).toBe(all.items[1]?.id);
            }
    });
    it("expires working rows and restarts their cursor even without a new publication", () => {
        const { root, store } = fixture();
        for (const [id, expiry] of [["a", "2026-10-01T12:01:00.000Z"], ["b", "2026-10-01T13:00:00.000Z"]] as const) {
            store.upsertTemporaryMemory({ id, kind: "open_question", title: id!, summary: "An open project question.", createdAt: now, updatedAt: now, expiresAt: expiry });
        }
        publishRetrieval(store, root, "fixture");
        const page = readPublishedTierPage(root, { tier: "working", limit: 1 }, now);
        expect(page.total).toBe(2);
        expect(page.freshness.nextExpiryAt).toBe("2026-10-01T12:01:00.000Z");
        expect(readPublishedTierPage(root, { tier: "working", limit: 1, cursor: page.nextCursor! }, "2026-10-01T12:02:00.000Z").restart).toBe(true);
        expect(readPublishedTiers(root, "2026-10-01T12:02:00.000Z").counts.working).toBe(1);
        expect(readPublishedTiers(root, "2026-10-01T12:02:00.000Z").freshness.revision).toBe(page.freshness.revision);
    });
    it("preserves the original creation time and caps repeated Keep actions at three days", () => {
        const { store } = fixture();
        const original = store.upsertTemporaryMemory({ id: "keep", kind: "task_state", title: "Task", summary: "Working on project sync.", createdAt: now, updatedAt: now, expiresAt: "2026-10-02T12:00:00.000Z" });
        const extended = store.keepTemporaryMemory(original.id, "2026-10-02T11:00:00.000Z");
        expect(extended.createdAt).toBe(original.createdAt);
        expect(extended.expiresAt).toBe("2026-10-03T11:00:00.000Z");
        const capped = store.keepTemporaryMemory(original.id, "2026-10-03T10:00:00.000Z");
        expect(capped.expiresAt).toBe("2026-10-04T10:00:00.000Z");
        expect(store.keepTemporaryMemory(original.id, "2026-10-04T09:00:00.000Z").expiresAt).toBe("2026-10-04T12:00:00.000Z");
        expect(() => store.keepTemporaryMemory(original.id, "2026-10-04T12:00:00.000Z")).toThrow("expired");
    });
    it("keeps source evidence and applicability when creating a candidate, without consuming the working row", () => {
        const { store } = fixture();
        const source = save(store, "Use device-owned encryption keys.").candidate.evidence[0]!;
        const temporary = store.upsertTemporaryMemory({ id: "convert", kind: "task_state", title: "Windows packaging", summary: "Keep packaging keys on the device.",
            scope: { kind: "conditional", platforms: ["win32"] }, layer: "branch:packaging", evidence: [source], createdAt: now, updatedAt: now });
        const result = createWorkingCandidate(store, { id: temporary.id, type: "constraint", text: temporary.summary, destination: "branch", fields: { requirement: temporary.summary } }, now);
        expect(result.candidate.layer).toBe(temporary.layer);
        expect(result.candidate.scope).toEqual(temporary.scope);
        expect(result.candidate.evidence).toContainEqual(source);
        expect(result.candidate.promotionState).toBe("candidate");
        expect(result.candidate.origin?.channel).toBe("desktop");
        expect(store.readSource(result.sourceId)?.metadata).toMatchObject({ sourceTemporaryId: temporary.id });
        expect(store.readTemporaryMemory(temporary.id)).toBeDefined();
        const repeat = createWorkingCandidate(store, { id: temporary.id, type: "constraint", text: temporary.summary, destination: "branch" }, now);
        expect(repeat.candidate.id).toBe(result.candidate.id);
    });
    it("rejects actions on expired or peer working context", () => {
        const { store } = fixture();
        const peer = "device:11111111-1111-4111-8111-111111111111";
        const temporary = store.upsertTemporaryMemory({ id: "peer", kind: "task_state", title: "Task", summary: "Working on project sync.", layer: peer, createdAt: now, updatedAt: now });
        store.db.prepare("insert into peer_partitions values('peer',?,'writer','fingerprint',?)").run(peer, now);
        expect(() => store.keepTemporaryMemory(temporary.id, now)).toThrow("read-only");
        expect(() => createWorkingCandidate(store, { id: temporary.id, type: "decision", text: temporary.summary, destination: "project" }, now)).toThrow("read-only");
        expect(() => createWorkingCandidate(store, { id: temporary.id, type: "decision", text: temporary.summary, destination: "project" }, "2026-10-03T12:00:00.000Z")).toThrow("expired");
    });
    it("matches canonical and published tier counts, filters and statement search", () => {
        const { root, store } = fixture();
        save(store, "Use local project storage.");
        save(store, "Evaluate a branch prototype.", false, "branch:prototype");
        rememberProjectMemory(store, {
            type: "decision", text: "Use structured project memory.", scope: { kind: "project" },
            statement: { fields: { rationale: "Support offline reasoning." } }
        });
        store.upsertTemporaryMemory({
            id: "parity", kind: "open_question", title: "Storage question",
            summary: "Decide how to persist working context.", createdAt: now, updatedAt: now,
            expiresAt: "2026-10-01T12:01:00.000Z"
        });
        publishRetrieval(store, root, "fixture");
        for (const tier of ["working", "candidates", "durable", "verified"] as const) {
            for (const reach of ["all", "project", "device", "branch", "branch_device"] as const) {
                for (const query of ["", "offline reasoning", "context"]) {
                    const input = { tier, reach, query, limit: 1 };
                    const canonical = readCanonicalTierPage(store, input, now);
                    const published = readPublishedTierPage(root, input, now);
                    expect(canonical.items.map(item => item.id)).toEqual(published.items.map(item => item.id));
                    expect(canonical.total).toBe(published.total);
                    expect(canonical.counts).toEqual(published.counts);
                }
            }
        }
        const first = readCanonicalTierPage(store, { tier: "durable", limit: 1 }, now);
        expect(first.nextCursor).toBeDefined();
        save(store, "Use revision-aware cursors.");
        expect(readCanonicalTierPage(store, { tier: "durable", limit: 1, cursor: first.nextCursor! }, now).restart).toBe(true);
        expect(readCanonicalFreshness(store, now).nextExpiryAt).toBe("2026-10-01T12:01:00.000Z");
        expect(readCanonicalTierPage(store, { tier: "working" }, "2026-10-01T12:02:00.000Z").total).toBe(0);
    });
    it("uses one canonical snapshot when another writer changes memory during a page read", () => {
        const { store } = fixture();
        const saved = save(store, "Use consistent memory snapshots.").memory!;
        const original = store.listMemories;
        const writer = new DatabaseSync(store.paths.databasePath);
        try {
            store.listMemories = input => {
                const rows = original(input);
                writer.prepare("update memories set title=? where id=?").run("Updated by another writer", saved.id);
                return rows;
            };
            const page = readCanonicalTierPage(store, { tier: "durable" }, now);
            expect(page.items[0]?.title).toBe(saved.title);
            expect(page.freshness.revision).not.toBe(readCanonicalFreshness(store, now).revision);
            expect(store.db.isTransaction).toBe(false);
        }
        finally {
            store.listMemories = original;
            writer.close();
        }
    });
    it("rebuilds an old-format index atomically instead of publishing a partial upgrade", async () => {
        const { root, store } = fixture();
        const memory = save(store, "Use complete index publications.").memory!;
        await rebuildRetrieval(root);
        const prior = withPublishedIndex(root, (_db, p) => p.revision);
        closeRetrievalReaders();
        // Simulate an earlier publication descriptor while leaving its completed records intact.
        const { database } = requirePaths(root);
        const db = new DatabaseSync(database);
        const row = db.prepare("select value from publication").get() as {
            value: string;
        };
        const publication = JSON.parse(row.value);
        delete publication.format;
        db.prepare("update publication set value=?").run(JSON.stringify(publication));
        db.close();
        await rebuildRetrieval(root);
        expect(readPublishedTierPage(root, { tier: "durable" }, now).items[0]?.id).toBe(memory.id);
        expect(readPublishedTiers(root, now).freshness.revision).not.toBe(prior);
    });
});
import { rebuildRetrieval } from "../../src/retrieval/worker.js";
import { DatabaseSync } from "node:sqlite";
import { retrievalPaths as requirePaths } from "../../src/retrieval/paths.js";
