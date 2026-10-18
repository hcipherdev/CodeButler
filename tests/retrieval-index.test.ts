import { afterEach, describe, expect, it, vi } from "vitest";
import { openMemoryStore } from "../src/storage/store.js";
import { closeRetrievalReaders, publishRetrieval, readPublishedMemories, RetrievalUnavailableError } from "../src/retrieval/index.js";
import { purgeRetrieval } from "../src/retrieval/privacy.js";
import { withProjectGate } from "../src/cloud/gate.js";
import { makeTempDir, cleanupTempDir } from "./helpers/temp.js";
import { resolveEvidenceCitations } from "../src/evidence/citations.js";
import { readPublishedHealth, readPublishedRaw, withPublishedIndex } from "../src/retrieval/index.js";
import { summarizeMemoryHealth } from "../src/memory/quality.js";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { retrievalPaths } from "../src/retrieval/paths.js";
import { createProjectMemoryToolHandlers } from "../src/mcp/tools.js";
import { captureRetrieval, publishCapture, callCanonicalTool, rebuildRetrieval } from "../src/retrieval/worker.js";
import { resolveMemoryReview, StaleMemoryReviewError } from "../src/memory/review.js";
const roots: string[] = [];
afterEach(() => { closeRetrievalReaders(); for (const root of roots)
    cleanupTempDir(root); roots.length = 0; });
function fixture() {
    const root = makeTempDir();
    roots.push(root);
    const store = openMemoryStore(root);
    store.init();
    store.addSourceWithChunks({ source: { id: "source", type: "conversation", title: "Decision", origin: "test", rawContent: "large unused body ".repeat(10000) }, chunks: [{ text: "We decided to preserve exact substring matching." }, { text: "Evidence for compatibility." }] });
    for (let i = 0; i < 12; i++) {
        const candidate = store.upsertMemoryCandidate({ type: "decision", title: `Choice ${i}`, summary: `Unicode café 中文 substring src/a_b.ts quote \"literal\" token${i}`, reason: "User explicitly chose this behavior", confidence: .99, evidence: [{ sourceType: "conversation", sourceId: "source", locator: "source:chunk:0" }], relatedFiles: [], dedupeKey: `choice-${i}` });
        if (i % 2 === 0)
            store.promoteMemoryCandidate(candidate.id, "manual");
    }
    return { root, store };
}
describe("published retrieval", () => {
    it("applies privacy before first publication and recovers a corrupt derived file", async () => {
        const { root, store } = fixture();
        store.db.prepare("update memories set title='secretvalue decision'").run();
        store.close();
        writeFileSync(join(root, ".code-butler", "config.json"), JSON.stringify({ privacy: { redactionPatterns: [{ name: "test", kind: "literal", pattern: "secretvalue" }] } }));
        await rebuildRetrieval(root);
        expect(JSON.stringify(readPublishedMemories(root, { qualityStatus: "all" }))).not.toContain("secretvalue");
        closeRetrievalReaders();
        writeFileSync(retrievalPaths(root).database, "corrupt index");
        await rebuildRetrieval(root);
        expect(readPublishedMemories(root, { qualityStatus: "all" }).items.length).toBeGreaterThan(0);
    });
    it("captures local quality decisions and serves raw sources through the separate worker", async () => {
        const { root, store } = fixture();
        try {
            const memory = store.searchMemoryLayer({ status: "candidate", qualityStatus: "all" })[0]!;
            store.updateMemoryQuality("candidate", memory.id, { qualityStatus: "quarantined", qualityReasons: ["low_confidence"] });
            const expected = store.searchMemoryLayer({ qualityStatus: "all" });
            const capture = await captureRetrieval(store);
            publishCapture(capture);
            expect(readPublishedMemories(root, { qualityStatus: "all" }).items).toEqual(expected);
            const source = await callCanonicalTool(root, "read_memory_source", { sourceId: "source" }) as {
                rawContent: string;
            };
            expect(source.rawContent).toBe(store.readSource("source")?.rawContent);
            expect(await callCanonicalTool(root, "__cloud_sync", {})).toBeUndefined();
        }
        finally {
            store.close();
        }
    });
    it("preserves ownership, scope, layer, lifecycle and summary filters before pagination", () => {
        const { root, store } = fixture();
        try {
            const layer = "device:11111111-1111-4111-8111-111111111111";
            store.db.prepare("update memories set layer=? where rowid%2=0").run(layer);
            store.db.prepare("insert into peer_partitions values('peer',?,'writer','fingerprint','2026-01-01')").run(layer);
            publishRetrieval(store, root, "fixture");
            for (const owner of ["self", "peer", "any"] as const)
                for (const layer of ["all", "core", "device", "branch"] as const)
                    for (const summaryOnly of [false, true]) {
                        const input = { owner, layer, summaryOnly, qualityStatus: "all" as const, lifecycleStatus: "all" as const, limit: 2, offset: 1 };
                        expect(readPublishedMemories(root, input).items).toEqual(store.searchMemoryLayer(input));
                    }
        }
        finally {
            store.close();
        }
    });
    it("rejects a review token when quoted content changes without changing the source or chunk ID", () => {
        const { root, store } = fixture();
        try {
            publishRetrieval(store, root, "fixture");
            const memory = readPublishedMemories(root, { qualityStatus: "all" }).items[0]!;
            store.db.prepare("update chunks set text='The decision was reversed.' where id='source:chunk:0'").run();
            expect(() => resolveMemoryReview(store, { category: memory.kind, memoryId: memory.id, action: "discard", reason: "Stale submission", reviewToken: memory.reviewToken! }, "desktop")).toThrow(StaleMemoryReviewError);
        }
        finally {
            store.close();
        }
    });
    it("keeps discarded candidate counts and publication invalidation consistent", () => {
        const { root, store } = fixture();
        try {
            publishRetrieval(store, root, "fixture");
            const memory = readPublishedMemories(root, { status: "candidate", qualityStatus: "all" }).items[0]!;
            resolveMemoryReview(store, { category: "candidate", memoryId: memory.id, action: "discard", reason: "No longer needed", reviewToken: memory.reviewToken! }, "desktop");
            expect(publishRetrieval(store, root, "fixture").changed).toBe(1);
            expect(readPublishedMemories(root, { qualityStatus: "all" }).items).toEqual(store.searchMemoryLayer({ qualityStatus: "all" }));
            expect(readPublishedHealth(root)).toEqual(summarizeMemoryHealth(store));
        }
        finally {
            store.close();
        }
    });
    it("reports preparing before the first complete publication", () => {
        const { root, store } = fixture();
        try {
            expect(() => readPublishedMemories(root)).toThrow(RetrievalUnavailableError);
        }
        finally {
            store.close();
        }
    });
    it("assesses only changed memories and journals rolled-back mutations atomically", () => {
        const { root, store } = fixture();
        try {
            publishRetrieval(store, root, "fixture");
            const before = readPublishedMemories(root, { qualityStatus: "all" });
            const id = before.items[0]!.id;
            const spy = vi.spyOn(store, "readMemorySearchResultsByIds");
            store.db.exec("begin");
            store.db.prepare("update memories set summary='rolled back' where id=?").run(id);
            store.db.exec("rollback");
            expect(publishRetrieval(store, root, "fixture").changed).toBe(0);
            expect(spy).not.toHaveBeenCalled();
            store.db.prepare("update memories set summary='Updated decision' where id=?").run(id);
            expect(publishRetrieval(store, root, "fixture").changed).toBe(1);
            expect(spy).toHaveBeenCalledTimes(1);
            expect(readPublishedMemories(root, { query: "Updated decision", qualityStatus: "all" }).items).toHaveLength(1);
        }
        finally {
            store.close();
        }
    });
    it("matches canonical health and decorated raw search", async () => {
        const { root, store } = fixture();
        try {
            publishRetrieval(store, root, "fixture");
            expect(readPublishedHealth(root)).toEqual(summarizeMemoryHealth(store));
            const expected = await createProjectMemoryToolHandlers(store, { rootDir: root }).search_project_memory({ query: "Evidence", limit: 5 });
            expect(readPublishedRaw(root, { query: "Evidence", limit: 5 })).toEqual(expected.results);
        }
        finally {
            store.close();
        }
    });
    it("keeps the previous completed file readable until replacement activation and repairs corruption", () => {
        const { root, store } = fixture();
        try {
            publishRetrieval(store, root, "fixture");
            const before = readPublishedMemories(root, { qualityStatus: "all" });
            const original = store.readMemorySearchResultsByIds.bind(store);
            const spy = vi.spyOn(store, "readMemorySearchResultsByIds").mockImplementation((...args) => {
                expect(readPublishedMemories(root, { qualityStatus: "all" }).freshness.revision).toBe(before.freshness.revision);
                return original(...args);
            });
            publishRetrieval(store, root, "replaced-canonical");
            spy.mockRestore();
            expect(readPublishedMemories(root, { qualityStatus: "all" }).items).toEqual(before.items);
            closeRetrievalReaders();
            writeFileSync(retrievalPaths(root).database, "corrupt test index");
            publishRetrieval(store, root, "replaced-canonical");
            expect(readPublishedMemories(root, { qualityStatus: "all" }).items).toEqual(before.items);
        }
        finally {
            store.close();
        }
    });
    it("rejects stale policy immediately and refreshes file containment observations within five seconds", () => {
        const { root, store } = fixture();
        try {
            const file = join(root, "note.txt");
            writeFileSync(file, "present");
            store.db.prepare("update memories set related_files_json=?").run(JSON.stringify(["note.txt"]));
            publishRetrieval(store, root, "fixture");
            const first = readPublishedMemories(root, { qualityStatus: "all" });
            expect(first.items[0]?.citations?.some(c => c.kind === "file" && c.resolved)).toBe(true);
            unlinkSync(file);
            const later = Date.now() + 5001;
            const clock = vi.spyOn(Date, "now").mockReturnValue(later);
            try {
                expect(readPublishedMemories(root, { qualityStatus: "all" }).items[0]?.citations?.some(c => c.kind === "file" && !c.resolved)).toBe(true);
            }
            finally {
                clock.mockRestore();
            }
            writeFileSync(join(root, ".code-butler", "config.json"), JSON.stringify({ privacy: { redactionPatterns: [{ name: "test", kind: "literal", pattern: "secretvalue" }] } }));
            expect(() => readPublishedMemories(root)).toThrow(RetrievalUnavailableError);
        }
        finally {
            store.close();
        }
    });
    it("uses the trigram candidate index without reconstructing quality", () => {
        const { root, store } = fixture();
        try {
            publishRetrieval(store, root, "fixture");
            const spy = vi.spyOn(store, "readMemorySearchResultsByIds");
            readPublishedMemories(root, { query: "token1", qualityStatus: "all" });
            expect(spy).not.toHaveBeenCalled();
            const plan = withPublishedIndex(root, db => db.prepare("explain query plan select * from record_fts where record_fts match ?").all('"token1"'));
            expect(JSON.stringify(plan)).toContain("VIRTUAL TABLE INDEX");
        }
        finally {
            store.close();
        }
    });
    it("preserves substring matches, filtering, ordering and citation payloads", () => {
        const { root, store } = fixture();
        try {
            publishRetrieval(store, root, "fixture");
            for (const query of ["", "token1", "absent", "a", "_b", "café", "中文", "\"literal\"", "src/a_b.ts"]) {
                for (const status of [undefined, "candidate", "promoted"] as const) {
                    const input = { query, qualityStatus: "all" as const, lifecycleStatus: "all" as const, limit: 5, ...(status ? { status } : {}) };
                    expect(readPublishedMemories(root, input).items).toEqual(store.searchMemoryLayer(input));
                }
            }
        }
        finally {
            store.close();
        }
    });
    it("reads a completed revision while the canonical gate is held", async () => {
        const { root, store } = fixture();
        try {
            publishRetrieval(store, root, "fixture");
            await withProjectGate(root, async () => { expect(readPublishedMemories(root, { qualityStatus: "all" }).items.length).toBeGreaterThan(0); });
        }
        finally {
            store.close();
        }
    });
    it("binds cursors to revision and filters and preserves the old publication after failure", () => {
        const { root, store } = fixture();
        try {
            publishRetrieval(store, root, "fixture");
            const input = { qualityStatus: "all" as const, limit: 2 };
            const first = readPublishedMemories(root, input);
            expect(first.nextCursor).toBeTruthy();
            expect(readPublishedMemories(root, { ...input, cursor: first.nextCursor! }).items[0]?.id).not.toBe(first.items[0]?.id);
            expect(() => readPublishedMemories(root, { ...input, query: "different", cursor: first.nextCursor! })).toThrow("cursor");
            store.db.prepare("update memories set summary='changed' where id=?").run(first.items[0]!.id);
            const spy = vi.spyOn(store, "readMemorySearchResultsByIds").mockImplementation(() => { throw new Error("interrupted"); });
            expect(() => publishRetrieval(store, root, "fixture")).toThrow("interrupted");
            expect(readPublishedMemories(root, input).freshness.revision).toBe(first.freshness.revision);
            spy.mockRestore();
            publishRetrieval(store, root, "fixture");
            expect(readPublishedMemories(root, { ...input, cursor: first.nextCursor! }).restart).toBe(true);
        }
        finally {
            store.close();
        }
    });
    it("invalidates a missing evidence dependency and purges readable derived content", () => {
        const { root, store } = fixture();
        try {
            publishRetrieval(store, root, "fixture");
            store.db.prepare("delete from chunks where id=?").run("source:chunk:0");
            publishRetrieval(store, root, "fixture");
            expect(readPublishedMemories(root, { qualityStatus: "all" }).items.every(m => m.citations?.some(c => !c.resolved))).toBe(true);
            purgeRetrieval(root);
            expect(() => readPublishedMemories(root)).toThrow(RetrievalUnavailableError);
        }
        finally {
            store.close();
        }
    });
    it("quotes a chunk without reading the conversation body and indexes windows", () => {
        const { store } = fixture();
        try {
            const body = vi.spyOn(store, "readSource").mockImplementation(() => { throw new Error("body read"); });
            const citations = resolveEvidenceCitations(store, { evidence: [{ sourceType: "conversation", sourceId: "source", locator: "source:chunk:0" }, { sourceType: "conversation", sourceId: "source", locator: "source:chunk:0" }] });
            expect(citations).toHaveLength(1);
            expect(body).not.toHaveBeenCalled();
            expect(store.readConversationWindow("wrong", "source:chunk:0", 0, 0)).toEqual([]);
            const plan = store.db.prepare("explain query plan select * from chunks where source_id=? and chunk_index between ? and ?").all("source", 0, 1);
            expect(JSON.stringify(plan)).toContain("idx_chunks_source_position");
        }
        finally {
            store.close();
        }
    });
});
