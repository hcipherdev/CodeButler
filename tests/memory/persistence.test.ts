// Tests cloud and privacy round trips for history, topic revisions, overrides, and derived handbook removal.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openMemoryStore, type MemoryStore } from "../../src/storage/store.js";
import { withTransaction } from "../../src/storage/transactions.js";
import { rememberProjectMemory } from "../../src/memory/remember.js";
import { installationDeviceId } from "../../src/memory/origin.js";
import { memoryHistory } from "../../src/memory/events.js";
import { readMemoryKnowledge } from "../../src/memory/knowledge.js";
import { readHandbook, readHandbookTopic, saveMemoryTopic, setTopicMembership } from "../../src/memory/topics.js";
import { exportMemoryHandbook } from "../../src/memory/export.js";
import { deletePrivacySource, exportPrivacy, importPrivacy, scrubPrivacy } from "../../src/privacy/service.js";
import { mergeCore } from "../../src/cloud/merge.js";
import { applySnapshot, captureSnapshot, materializeSnapshot } from "../../src/cloud/snapshot.js";
import { makeTempDir, cleanupTempDir } from "../helpers/temp.js";
const stores: MemoryStore[] = [], roots: string[] = [];
afterEach(() => { for (const s of stores.splice(0))
    s.close(); vi.unstubAllEnvs(); for (const r of roots.splice(0))
    cleanupTempDir(r); });
function fixture() { const root = makeTempDir(); roots.push(root); const store = openMemoryStore(root); store.init(); stores.push(store); return { root, store }; }
function close(store: MemoryStore) { store.close(); stores.splice(stores.indexOf(store), 1); }
function save(store: MemoryStore, text: string, layer = "core") { return rememberProjectMemory(store, { type: "decision", text, relatedFiles: ["src/cloud/client.ts"], scope: { kind: "project" }, layer }).memory!; }
function clone(source: MemoryStore) { const target = fixture(), outputPath = join(source.paths.rootDir, "copy-" + randomUUID() + ".json"); exportPrivacy(source, { outputPath }); importPrivacy(target.store, { inputPath: outputPath }); return target; }
describe("schema-24 persistence", () => {
    it("round-trips events and approved topics through privacy export without local AI drafts", () => {
        const { root, store } = fixture();
        const m = save(store, "Keep sync envelopes encrypted.");
        const topic = saveMemoryTopic(store, { name: "Encrypted sync", prefixes: ["src/cloud"], introduction: "Approved project knowledge." });
        setTopicMembership(store, { topicId: topic.id, memoryId: m.id, mode: "include" });
        store.localDb.prepare("insert into memory_wording_runs values('local-draft','{}','2026-10-01')").run();
        const copied = clone(store), before = readMemoryKnowledge(store), after = readMemoryKnowledge(copied.store);
        expect(after.events).toEqual(before.events);
        expect(after.topics).toEqual(before.topics);
        expect(after.overrides).toEqual(before.overrides);
        expect(readHandbook(after)).toEqual(readHandbook(before));
        expect(copied.store.localDb.prepare("select count(*) n from memory_wording_runs").get()).toEqual({ n: 0 });
        const generated = exportMemoryHandbook(store);
        const source = m.evidence[0]!.sourceId;
        deletePrivacySource(store, { sourceId: source, confirmSourceId: source });
        expect(generated.files.every(path => !existsSync(join(root, ".code-butler/handbook", path)))).toBe(true);
        expect(readMemoryKnowledge(store).events.some(e => e.memory_id === m.id)).toBe(false);
        expect(readMemoryKnowledge(store).overrides.some(o => o.memory_id === m.id)).toBe(false);
    });
    it("merges concurrent topic edits while keeping the last agreed rules and override removals", () => {
        const local = fixture(), m = save(local.store, "Use signed sync envelopes.");
        const topic = saveMemoryTopic(local.store, { name: "Sync", prefixes: ["src/cloud"] });
        setTopicMembership(local.store, { topicId: topic.id, memoryId: m.id, mode: "include" });
        const ancestor = clone(local.store), remote = clone(local.store);
        saveMemoryTopic(local.store, { id: topic.id, name: "Local topic", prefixes: ["desktop"], expectedRevisions: topic.heads });
        saveMemoryTopic(remote.store, { id: topic.id, name: "Remote topic", prefixes: ["src/storage"], expectedRevisions: topic.heads });
        setTopicMembership(remote.store, { topicId: topic.id, memoryId: m.id, mode: "default" }, "2026-10-10T00:00:00.000Z");
        withTransaction(local.store.db, () => mergeCore(local.store.db, remote.store.db, ancestor.store.db));
        const merged = readHandbook(readMemoryKnowledge(local.store)).topics[0]!;
        expect(merged).toMatchObject({ name: "Sync", prefixes: ["src/cloud"], conflicted: true });
        expect(merged.proposals).toHaveLength(2);
        const links = readMemoryKnowledge(local.store).overrides;
        expect(links.map(o => o.mode).sort()).toEqual(["default", "include"]);
        const count = readMemoryKnowledge(local.store).events.length;
        withTransaction(local.store.db, () => mergeCore(local.store.db, remote.store.db, ancestor.store.db));
        expect(readMemoryKnowledge(local.store).events).toHaveLength(count);
        saveMemoryTopic(local.store, { id: topic.id, name: "Resolved sync", prefixes: ["src/cloud"], expectedRevisions: merged.heads });
        expect(readHandbookTopic(readMemoryKnowledge(local.store), topic.id).total).toBe(1);
    });
    it("converges memory IDs and remaps later history and membership without duplicate promotion history", () => {
        const local = fixture(), remote = fixture(), ancestor = fixture();
        const a = save(local.store, "Use content-addressed snapshots."), b = save(remote.store, "Use content-addressed snapshots.");
        const topic = saveMemoryTopic(remote.store, { name: "Snapshots", prefixes: ["src/cloud"] });
        setTopicMembership(remote.store, { topicId: topic.id, memoryId: b.id, mode: "include" });
        withTransaction(local.store.db, () => mergeCore(local.store.db, remote.store.db, ancestor.store.db));
        let data = readMemoryKnowledge(local.store);
        expect(data.memories.filter(m => m.kind === "promoted")).toHaveLength(1);
        expect(data.overrides[0]?.memory_id).toBe(a.id);
        expect(memoryHistory(data, a.id, "promoted").items.filter(e => e.kind === "made_durable")).toHaveLength(1);
        remote.store.updateMemoryLifecycle(b.id, { lifecycleStatus: "retracted", statusReason: "Retired snapshot rule" });
        withTransaction(local.store.db, () => mergeCore(local.store.db, remote.store.db, ancestor.store.db));
        data = readMemoryKnowledge(local.store);
        expect(data.events.find(e => e.kind === "withdrawn")?.memory_id).toBe(a.id);
        expect(local.store.readMemory(a.id)?.lifecycleStatus).toBe("retracted");
        expect(local.store.db.prepare("select count(*) n from memory_links where owner_kind='memory' and owner_id not in (select id from memories)").get()).toEqual({ n: 0 });
    });
    it("captures core and device topics in separate cloud partitions and excludes generated documents", async () => {
        const directory = makeTempDir();
        roots.push(directory);
        vi.stubEnv("CODE_BUTLER_HOME", join(directory, "home-a"));
        const a = fixture(), device = installationDeviceId();
        const core = save(a.store, "Keep core sync metadata portable."), privateMemory = save(a.store, "Keep device drafts on their owner.", "device:" + device);
        const coreTopic = saveMemoryTopic(a.store, { name: "Core sync", prefixes: ["src/cloud"] });
        const privateTopic = saveMemoryTopic(a.store, { name: "Device drafts", layer: privateMemory.layer!, prefixes: ["src/cloud"] });
        setTopicMembership(a.store, { topicId: privateTopic.id, memoryId: privateMemory.id, mode: "include" });
        exportMemoryHandbook(a.store);
        close(a.store);
        const capture = await captureSnapshot(a.root, randomUUID(), 0, randomUUID());
        expect(capture.snapshot.schemaVersion).toBe(24);
        expect(capture.snapshot.segments.some(s => s.id.includes("handbook"))).toBe(false);
        vi.stubEnv("CODE_BUTLER_HOME", join(directory, "home-b"));
        const b = fixture();
        const deviceB = installationDeviceId();
        close(b.store);
        const materialized = materializeSnapshot(capture.snapshot, id => capture.blocks.get(id)!, deviceB);
        expect(materialized.partitions).toHaveLength(1);
        expect(materialized.partitions[0]!.tables.memory_topics?.some(t => t.topic_id === privateTopic.id)).toBe(true);
        const path = join(directory, "core.sqlite");
        writeFileSync(path, materialized.files.find(f => f.path === "memory.sqlite")!.data);
        const coreDb = new DatabaseSync(path);
        try {
            expect(coreDb.prepare("select distinct layer from memory_topics").all()).toEqual([{ layer: "core" }]);
            expect(coreDb.prepare("select count(*) n from memory_events where layer<>'core'").get()).toEqual({ n: 0 });
        }
        finally {
            coreDb.close();
        }
        applySnapshot(b.root, materialized);
        const restored = openMemoryStore(b.root);
        restored.init();
        stores.push(restored);
        const data = readMemoryKnowledge(restored);
        expect(readHandbook(data).topics[0]?.id).toBe(coreTopic.id);
        expect(readHandbook(data).total).toBe(1);
        expect(readHandbook(data, { reach: "device", owner: "peer" }).topics.some(t => t.id === privateTopic.id && t.peer)).toBe(true);
        expect(() => setTopicMembership(restored, { topicId: privateTopic.id, memoryId: privateMemory.id, mode: "exclude" })).toThrow("read-only");
        expect(memoryHistory(data, core.id, "promoted").items.length).toBeGreaterThan(0);
    });
    it("scrubs topic introductions and history reasons and invalidates handbook output", () => {
        const { root, store } = fixture();
        const m = save(store, "Keep API credentials private."), topic = saveMemoryTopic(store, { name: "Credentials", prefixes: ["src/cloud"] });
        const secret = "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456";
        store.db.prepare("update memory_topics set introduction=? where topic_id=?").run(secret, topic.id);
        store.db.prepare("update memory_events set reason=? where memory_id=?").run(secret, m.id);
        exportMemoryHandbook(store);
        scrubPrivacy(store);
        const json = JSON.stringify(readMemoryKnowledge(store));
        expect(json).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz123456");
        expect(existsSync(join(root, ".code-butler/handbook/index.md"))).toBe(false);
    });
});
