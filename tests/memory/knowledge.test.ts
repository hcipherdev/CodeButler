// Tests schema-24 migration, atomic memory events, lifecycle privacy, topic rules, and published parity.
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "../../src/storage/store.js";
import { initializeSchema, SCHEMA_MIGRATIONS } from "../../src/storage/migrations.js";
import { withTransaction } from "../../src/storage/transactions.js";
import { rememberProjectMemory } from "../../src/memory/remember.js";
import { compensateMemoryReview, resolveMemoryReview } from "../../src/memory/review.js";
import { resolveBranchMemoryTriage } from "../../src/memory/branch-triage.js";
import { applyLayerRetention } from "../../src/memory/layer-retention.js";
import { matchingMemoryVerification } from "../../src/memory/review-state.js";
import { updateMemoryStatus } from "../../src/memory/lifecycle-service.js";
import { updateMemoryLayer } from "../../src/memory/layer-service.js";
import { memoryHistory, memoryMovement, recordMemoryEvent } from "../../src/memory/events.js";
import { readMemoryKnowledge } from "../../src/memory/knowledge.js";
import { previewHandbookTopic, readHandbook, readHandbookTopic, resolveTopics, saveMemoryTopic, setTopicMembership, suggestHandbookTopics } from "../../src/memory/topics.js";
import { publishRetrieval, closeRetrievalReaders, withPublishedIndex } from "../../src/retrieval/index.js";
import { readCanonicalTierPage, readPublishedTierPage } from "../../src/retrieval/tiers.js";
import { makeTempDir, cleanupTempDir } from "../helpers/temp.js";
const stores: ReturnType<typeof openMemoryStore>[] = [], roots: string[] = [];
afterEach(() => {
    closeRetrievalReaders();
    for (const s of stores.splice(0))
        s.close();
    for (const r of roots.splice(0))
        cleanupTempDir(r);
});
function fixture(legacy = false) {
    const root = makeTempDir();
    roots.push(root);
    const store = openMemoryStore(root);
    stores.push(store);
    if (legacy)
        initializeSchema(store.db, store.paths.databasePath, { migrations: SCHEMA_MIGRATIONS.slice(0, 23) });
    else
        store.init();
    return { root, store };
}
function save(store: ReturnType<typeof openMemoryStore>, text: string, files: string[] = [], layer = "core", promote = true) { return rememberProjectMemory(store, { type: "decision", text, relatedFiles: files, scope: { kind: "project" }, layer, promote }, { actor: "desktop" }); }
const time = (days = 0) => new Date(Date.now() + days * 86400000 + 1000).toISOString();
describe("memory events and migration", () => {
    it("upgrades schema 23 without changing statements or existing verification", () => {
        const { store } = fixture(true);
        const m = save(store, "Use SQLite for offline storage.").memory!;
        store.db.prepare("update memories set confidence=0.5 where id=?").run(m.id);
        resolveMemoryReview(store, { memoryId: m.id, category: "promoted", action: "verify" }, "desktop");
        const before = store.db.prepare("select * from memories where id=?").get(m.id);
        expect(matchingMemoryVerification(store, "promoted", store.readMemory(m.id)!)).toBeDefined();
        initializeSchema(store.db, store.paths.databasePath);
        expect(store.db.prepare("select * from memories where id=?").get(m.id)).toEqual(before);
        expect(matchingMemoryVerification(store, "promoted", store.readMemory(m.id)!)).toBeDefined();
        expect(store.db.prepare("select kind,recorded from memory_events where memory_id=?").all(m.id)).toEqual([{ kind: "made_durable", recorded: 1 }]);
        expect(store.db.prepare("select max(version) version from schema_migrations").get()).toEqual({ version: 24 });
    });
    it("recovers dated corrections, withdrawals, restorations and branch sharing from schema 23", () => {
        const { store } = fixture(true);
        const m = save(store, "Use the earlier backup transport.").memory!;
        const correctedAt = time(-3), restoredAt = time(-2), discardedAt = time(-1), restoredAgainAt = time(-0.5);
        const correction = resolveMemoryReview(store, { memoryId: m.id, category: "promoted", action: "correct",
            correction: { summary: "Use the encrypted backup transport." }, reason: "Encrypt backups", now: correctedAt }, "desktop");
        compensateMemoryReview(store, { resolutionId: correction.review.id, reason: "Restore pending validation", now: restoredAt }, "desktop");
        const discard = resolveMemoryReview(store, { memoryId: m.id, category: "promoted", action: "discard",
            reason: "Withdraw pending validation", now: discardedAt }, "desktop");
        compensateMemoryReview(store, { resolutionId: discard.review.id, reason: "Validation completed", now: restoredAgainAt }, "desktop");
        const branch = save(store, "Share the tested key format.", [], "branch:keys", false).candidate;
        resolveBranchMemoryTriage(store, { memoryId: branch.id, category: "candidate", action: "promote_to_core",
            reason: "Key format is project knowledge", now: discardedAt }, "cli");
        const before = store.db.prepare("select * from memories where id=?").get(m.id);
        initializeSchema(store.db, store.paths.databasePath);
        expect(store.db.prepare("select * from memories where id=?").get(m.id)).toEqual(before);
        const history = memoryHistory(readMemoryKnowledge(store), m.id, "promoted", { limit: 100 }).items;
        expect(history.filter(e => e.kind === "replaced")).toHaveLength(1);
        expect(history.find(e => e.kind === "replaced")).toMatchObject({ at: correctedAt, reason: "Encrypt backups",
            to: { id: correction.replacement!.id, category: "promoted", available: true } });
        expect(history.filter(e => e.kind === "restored").map(e => e.at).sort()).toEqual([restoredAt, restoredAgainAt].sort());
        expect(history.filter(e => e.kind === "withdrawn")).toHaveLength(2);
        expect(memoryMovement(readMemoryKnowledge(store), {}, time())).toMatchObject({ replaced: 1, withdrawn: 2,
            sharedProjectWide: 1, partialSharingHistory: true });
    });
    it("records manual, automatic and sharing transitions once and rolls back together", () => {
        const { store } = fixture();
        const local = save(store, "Use branch-owned keys.", [], "branch:keys", false).candidate;
        const durable = store.promoteMemoryCandidate(local.id, "auto", { layer: "core" });
        store.promoteMemoryCandidate(local.id, "auto", { layer: "core" });
        updateMemoryLayer(store, { memoryId: durable.id, category: "promoted", layer: "core", reason: "Already shared" });
        const events = readMemoryKnowledge(store).events.filter(e => e.memory_id === durable.id);
        expect(events.map(e => e.kind).sort()).toEqual(["made_durable", "sharing_changed"]);
        expect(memoryMovement(readMemoryKnowledge(store), {}, time())).toMatchObject({ madeDurable: 1, sharedProjectWide: 1, partialSharingHistory: true });
        expect(() => withTransaction(store.db, () => { save(store, "Use a rollback-only transport."); throw new Error("rollback"); })).toThrow("rollback");
        expect(readMemoryKnowledge(store).events.filter(e => e.kind === "made_durable")).toHaveLength(1);
        recordMemoryEvent(store.db, store.contentPolicy, { kind: "withdrawn", memoryId: durable.id, category: "promoted", layer: "core", at: time(), key: "replay" });
        recordMemoryEvent(store.db, store.contentPolicy, { kind: "withdrawn", memoryId: durable.id, category: "promoted", layer: "core", at: time(), key: "replay" });
        expect(readMemoryKnowledge(store).events.filter(e => e.kind === "withdrawn")).toHaveLength(1);
        const at = time();
        recordMemoryEvent(store.db, store.contentPolicy, { kind: "replaced", memoryId: durable.id, category: "promoted", layer: "core", at, key: "device-a-fact" });
        recordMemoryEvent(store.db, store.contentPolicy, { kind: "replaced", memoryId: durable.id, category: "promoted", layer: "core", at, key: "device-b-same-fact" });
        expect(memoryMovement(readMemoryKnowledge(store), {}, time())).toMatchObject({ replaced: 1 });
    });
    it("ages activity without publication and applies reach and ownership filters", () => {
        const { root, store } = fixture();
        const m = save(store, "Keep branch decisions scoped.", [], "branch:topic").memory!;
        const old = time(-8), recent = time(-2), now = time();
        store.db.prepare("update memory_events set occurred_at=? where kind='coverage'").run(old);
        store.db.prepare("update memory_events set occurred_at=? where kind='made_durable'").run(recent);
        publishRetrieval(store, root, "test");
        const page = readPublishedTierPage(root, { reach: "branch" }, now);
        expect(page.movement7d).toMatchObject({ madeDurable: 1, partialSharingHistory: false });
        expect(page.freshness.nextExpiryAt).toBeDefined();
        expect(readPublishedTierPage(root, { reach: "project" }, now).movement7d?.madeDurable).toBe(0);
        expect(readPublishedTierPage(root, { reach: "branch" }, time(6)).movement7d?.madeDurable).toBe(0);
        expect(readPublishedTierPage(root, { reach: "branch" }, time(6)).freshness.revision).toBe(page.freshness.revision);
        const snapshot = readMemoryKnowledge(store);
        snapshot.peerLayers.push(m.layer!);
        expect(memoryMovement(snapshot, { owner: "self" }, now).madeDurable).toBe(0);
        expect(memoryMovement(snapshot, { owner: "peer", reach: "branch" }, now).madeDurable).toBe(1);
    });
    it("moves an existing durable candidate atomically without recording another promotion", () => {
        const { store } = fixture();
        const saved = save(store, "Keep promotion retries idempotent.", [], "branch:retries");
        const moved = store.promoteMemoryCandidate(saved.candidate.id, "manual", { layer: "core", actor: "cli" });
        expect(moved.layer).toBe("core");
        store.promoteMemoryCandidate(saved.candidate.id, "manual", { layer: "core", actor: "cli" });
        const events = readMemoryKnowledge(store).events.filter(e => e.memory_id === moved.id);
        expect(events.filter(e => e.kind === "made_durable")).toHaveLength(1);
        expect(events.filter(e => e.kind === "sharing_changed")).toHaveLength(1);
        expect(events.find(e => e.kind === "sharing_changed")).toMatchObject({ actor: "cli", from_value: "branch:retries", to_value: "core" });
    });
    it("counts separate withdrawals and keeps topic overrides across sharing changes", () => {
        const { store } = fixture(), m = save(store, "Keep handbook membership explicit.", ["src/storage/store.ts"], "branch:storage").memory!;
        const topic = saveMemoryTopic(store, { name: "Manual handbook", prefixes: [] });
        setTopicMembership(store, { topicId: topic.id, memoryId: m.id, mode: "include" });
        updateMemoryLayer(store, { memoryId: m.id, category: "promoted", layer: "core", reason: "Share approved project knowledge" });
        expect(readHandbookTopic(readMemoryKnowledge(store), topic.id).total).toBe(1);
        updateMemoryStatus(store, { memoryId: m.id, status: "retracted", reason: "Withdraw first version", now: time(-2) });
        updateMemoryStatus(store, { memoryId: m.id, status: "current", reason: "Restore first version", now: time(-1) });
        updateMemoryStatus(store, { memoryId: m.id, status: "retracted", reason: "Withdraw again", now: time() });
        expect(memoryMovement(readMemoryKnowledge(store), {}, time(1)).withdrawn).toBe(2);
    });
    it("records candidate retention together with its archive decision and deduplicates retries", () => {
        const { store } = fixture();
        const candidate = save(store, "Keep stale branch work in history.", [], "branch:closed", false).candidate;
        const decision = { memoryId: candidate.id, category: "candidate" as const, type: candidate.type, title: candidate.title,
            layer: candidate.layer!, layerLabel: "Closed branch", memoryVersion: candidate.updatedAt,
            policyVersion: 1, decision: "archive" as const, reasonCodes: ["branch_deleted"], idleDays: 31 };
        expect(() => withTransaction(store.db, () => { applyLayerRetention(store, decision, "system", time()); throw new Error("rollback"); })).toThrow("rollback");
        expect(readMemoryKnowledge(store).events.filter(e => e.kind === "withdrawn")).toHaveLength(0);
        expect(store.listMemoryCandidates({ qualityStatus: "all", limit: null }).find(m => m.id === candidate.id)?.qualityStatus).toBe("active");
        applyLayerRetention(store, decision, "system", time());
        applyLayerRetention(store, decision, "system", time());
        expect(memoryHistory(readMemoryKnowledge(store), candidate.id, "candidate").items.filter(e => e.kind === "withdrawn")).toHaveLength(1);
    });
    it("rolls back branch discard quality and history together", () => {
        const { store } = fixture();
        const candidate = save(store, "Keep discarded branch work recoverable.", [], "branch:discard", false).candidate;
        const input = { memoryId: candidate.id, category: "candidate" as const, action: "discard" as const, reason: "No longer needed" };
        expect(() => withTransaction(store.db, () => { resolveBranchMemoryTriage(store, input, "cli"); throw new Error("rollback"); })).toThrow("rollback");
        expect(readMemoryKnowledge(store).events.filter(e => e.kind === "withdrawn")).toHaveLength(0);
        expect(store.listMemoryCandidates({ qualityStatus: "all", limit: null }).find(m => m.id === candidate.id)?.qualityStatus).toBe("active");
        expect(resolveBranchMemoryTriage(store, input, "cli").candidate?.qualityStatus).toBe("quarantined");
    });
});
describe("lifecycle history", () => {
    it("keeps replacement links after restoration and paginates recorded withdrawal", () => {
        const { store } = fixture();
        const a = save(store, "Use plaintext test backups.").memory!, b = save(store, "Use encrypted test backups.").memory!;
        updateMemoryStatus(store, { memoryId: a.id, status: "superseded", replacementMemoryId: b.id, reason: "Encrypt stored backups", now: time(), actor: "desktop" });
        updateMemoryStatus(store, { memoryId: a.id, status: "superseded", replacementMemoryId: b.id, reason: "Retry", now: time() });
        updateMemoryStatus(store, { memoryId: a.id, status: "current", reason: "Restore for testing", now: time(1) });
        store.updateMemoryLifecycle(a.id, { lifecycleStatus: "retracted", statusReason: "Withdraw obsolete advice", statusChangedAt: time(2) });
        const data = readMemoryKnowledge(store), history = memoryHistory(data, a.id, "promoted", { limit: 2 });
        expect(history.total).toBe(5);
        expect(history.nextOffset).toBe(2);
        const all = memoryHistory(data, b.id, "promoted", { limit: 100 }).items;
        expect(all.filter(e => e.kind === "replaced")).toHaveLength(1);
        expect(all.find(e => e.kind === "replaced")).toMatchObject({ reason: "Encrypt stored backups", to: { id: b.id, category: "promoted", available: true } });
        expect(all.map(e => e.kind)).toEqual(expect.arrayContaining(["restored", "withdrawn"]));
    });
    it("labels candidate corrections and contains malformed cycles and unavailable nodes", () => {
        const { store } = fixture();
        const candidate = save(store, "Consider an old sync transport.", [], "core", false).candidate;
        resolveMemoryReview(store, { memoryId: candidate.id, category: "candidate", action: "correct", reason: "Use the agreed transport", correction: { summary: "Use encrypted sync transport." } }, "desktop");
        let data = readMemoryKnowledge(store);
        const correction = data.events.find(e => e.kind === "corrected")!;
        expect(memoryHistory(data, candidate.id, "candidate").items.find(e => e.kind === "corrected")).toMatchObject({ to: { category: "candidate", available: true } });
        recordMemoryEvent(store.db, store.contentPolicy, { kind: "corrected", memoryId: correction.related_memory_id!, category: "candidate", layer: "core", relatedMemoryId: candidate.id, relatedCategory: "candidate", relatedLayer: "core", key: "cycle" });
        recordMemoryEvent(store.db, store.contentPolicy, { kind: "replaced", memoryId: correction.related_memory_id!, category: "candidate", layer: "core", relatedMemoryId: "gone", relatedCategory: "promoted", relatedLayer: "core", key: "missing" });
        data = readMemoryKnowledge(store);
        expect(memoryHistory(data, candidate.id, "candidate", { limit: 100 }).items.find(e => e.kind === "replaced")).toMatchObject({ to: { available: false }, reason: "Reason not recorded" });
    });
    it("does not expose private predecessor statements or reasons from a core memory", () => {
        const { store } = fixture();
        const core = save(store, "Use public encryption guidance.").memory!, privateMemory = save(store, "Private predecessor content.", [], "device:11111111-1111-4111-8111-111111111111").memory!;
        recordMemoryEvent(store.db, store.contentPolicy, { kind: "replaced", memoryId: core.id, category: "promoted", layer: "core", relatedMemoryId: privateMemory.id, relatedCategory: "promoted", relatedLayer: privateMemory.layer, reason: "Private predecessor content.", key: "private" });
        const text = JSON.stringify(memoryHistory(readMemoryKnowledge(store), core.id, "promoted"));
        expect(text).not.toContain("Private predecessor content");
        expect(text).not.toContain(privateMemory.id);
        expect(text).toContain('"available":false');
    });
});
describe("confirmed handbook topics", () => {
    it("suggests without writing, applies future rules, and supports multiple memberships and overrides", () => {
        const { store } = fixture();
        const a = save(store, "Encrypt the sync payload.", ["src/cloud/client.ts"]).memory!, b = save(store, "Store local project state.", ["src/storage/store.ts"]).memory!;
        const data = readMemoryKnowledge(store), suggestions = suggestHandbookTopics(data);
        expect(suggestions.map(t => t.prefixes)).toContainEqual(["src/cloud"]);
        expect(store.db.prepare("select count(*) n from memory_topics").get()).toEqual({ n: 0 });
        const cloud = saveMemoryTopic(store, { name: "Encrypted sync", prefixes: ["src/cloud"], introduction: "How sync works." });
        const all = saveMemoryTopic(store, { name: "Engine", prefixes: ["src"] });
        const future = save(store, "Sign synced snapshots.", ["src/cloud/snapshot.ts"]).memory!;
        expect(readHandbookTopic(readMemoryKnowledge(store), cloud.id).items.map(m => m.id).sort()).toEqual([a.id, future.id].sort());
        expect(readHandbookTopic(readMemoryKnowledge(store), all.id).total).toBe(3);
        setTopicMembership(store, { topicId: cloud.id, memoryId: a.id, mode: "exclude" });
        setTopicMembership(store, { topicId: cloud.id, memoryId: b.id, mode: "include" });
        expect(readHandbookTopic(readMemoryKnowledge(store), cloud.id).items.map(m => m.id).sort()).toEqual([b.id, future.id].sort());
        setTopicMembership(store, { topicId: cloud.id, memoryId: a.id, mode: "default" }, time());
        expect(readHandbookTopic(readMemoryKnowledge(store), cloud.id).total).toBe(3);
        expect(previewHandbookTopic(readMemoryKnowledge(store), ["src/cloud"]).total).toBe(2);
        expect(() => saveMemoryTopic(store, { name: "Unsafe", prefixes: ["../private"] })).toThrow("repository-relative");
    });
    it("defaults to core, isolates private topics, and makes peer content read-only", () => {
        const { store } = fixture();
        save(store, "Use public project storage.", ["src/storage/a.ts"]);
        const local = save(store, "Use device storage for drafts.", ["src/storage/b.ts"], "device:11111111-1111-4111-8111-111111111111").memory!;
        const topic = saveMemoryTopic(store, { name: "Device notes", layer: local.layer!, prefixes: ["src/storage"] });
        expect(readHandbook(readMemoryKnowledge(store)).topics).toHaveLength(0);
        expect(readHandbook(readMemoryKnowledge(store), { reach: "device" }).total).toBe(1);
        expect(readHandbookTopic(readMemoryKnowledge(store), topic.id, { reach: "device" }).total).toBe(1);
        store.db.prepare("insert into peer_partitions values('peer',?,'writer','fingerprint',?)").run(local.layer!, time());
        expect(() => setTopicMembership(store, { topicId: topic.id, memoryId: local.id, mode: "exclude" })).toThrow("read-only");
        expect(readHandbook(readMemoryKnowledge(store), { reach: "device", owner: "peer" }).topics).toHaveLength(1);
    });
    it("retains concurrent proposals and the agreed rules until explicit resolution", () => {
        const { store } = fixture();
        const topic = saveMemoryTopic(store, { name: "Sync", prefixes: ["src/cloud"] });
        const root = readMemoryKnowledge(store).topics[0]!;
        for (const [id, name, prefix] of [["left", "Left", "desktop"], ["right", "Right", "src/storage"]] as const)
            store.db.prepare("insert into memory_topics values(?,?,?,?,?,?,?,?,?)").run(id, topic.id, "core", name, "", JSON.stringify([prefix]), JSON.stringify([root.id]), 0, time());
        const conflicted = resolveTopics(readMemoryKnowledge(store).topics)[0]!;
        expect(conflicted).toMatchObject({ name: "Sync", prefixes: ["src/cloud"], conflicted: true });
        expect(conflicted.proposals).toHaveLength(2);
        expect(() => saveMemoryTopic(store, { id: topic.id, name: "Stale", prefixes: [], expectedRevisions: topic.heads })).toThrow("Topic changed");
        const resolved = saveMemoryTopic(store, { id: topic.id, name: "Merged", prefixes: ["desktop", "src/cloud"], expectedRevisions: conflicted.heads });
        expect(resolved.conflicted).toBe(false);
        saveMemoryTopic(store, { id: resolved.id, name: resolved.name, prefixes: resolved.prefixes, expectedRevisions: resolved.heads, deleted: true });
        expect(readHandbook(readMemoryKnowledge(store)).topics).toHaveLength(0);
    });
    it("publishes the same memberships, movement and histories as canonical reads", () => {
        const { root, store } = fixture();
        const m = save(store, "Keep encryption metadata versioned.", ["src/cloud/vault.ts"]).memory!;
        saveMemoryTopic(store, { name: "Vault", prefixes: ["src/cloud"] });
        publishRetrieval(store, root, "test");
        const canonical = readMemoryKnowledge(store);
        withPublishedIndex(root, db => {
            const row = db.prepare("select payload from memory_knowledge where id=1").get() as {
                payload: string;
            };
            const data = JSON.parse(row.payload);
            expect(readHandbook(data)).toEqual(readHandbook(canonical));
            expect(memoryHistory(data, m.id, "promoted")).toEqual(memoryHistory(canonical, m.id, "promoted"));
        });
        const at = time();
        expect(readPublishedTierPage(root, {}, at).movement7d).toEqual(readCanonicalTierPage(store, {}, at).movement7d);
    });
});
