// Tests structured statements across privacy export/scrub, embeddings, and cloud conflicts.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openMemoryStore } from "../../src/storage/store.js";
import { rememberProjectMemory } from "../../src/memory/remember.js";
import { createStatement } from "../../src/memory/statement.js";
import { exportPrivacy, importPrivacy, scrubPrivacy } from "../../src/privacy/service.js";
import { mergeCore } from "../../src/cloud/merge.js";
import { createProviderFingerprint, createProviderKey, createEmbeddingEndpointHash, encodeFloat32Vector } from "../../src/embeddings/fingerprint.js";
import { makeTempDir, cleanupTempDir } from "../helpers/temp.js";
const stores: ReturnType<typeof openMemoryStore>[] = [], roots: string[] = [];
afterEach(() => { for (const s of stores.splice(0))
    s.close(); for (const r of roots.splice(0))
    cleanupTempDir(r); });
function fixture() { const root = makeTempDir(); roots.push(root); const store = openMemoryStore(root); store.init(); stores.push(store); return { root, store }; }
function save(store: ReturnType<typeof openMemoryStore>, rationale: string) {
    return rememberProjectMemory(store, { type: "decision", text: "Use local memory storage.", scope: { kind: "project" }, statement: { fields: { choice: "SQLite", rationale } } }).memory!;
}
describe("statement integration", () => {
    it("round-trips statements through redacted privacy export and import", () => {
        const { root, store } = fixture();
        const memory = save(store, "Support offline use.");
        const outputPath = join(root, "export.json");
        exportPrivacy(store, { outputPath });
        const restored = fixture();
        importPrivacy(restored.store, { inputPath: outputPath });
        expect(restored.store.readMemory(memory.id)?.statement).toEqual(memory.statement);
        expect(JSON.parse(readFileSync(outputPath, "utf8")).tables.memories[0].statement_json).toContain("Support offline use.");
    });
    it("scrubs a secret found only in a stored structured slot", () => {
        const { store } = fixture();
        const memory = save(store, "Support offline use.");
        const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
        const statement = createStatement(memory.summary, "decision", "submitted", { rationale: "OPENAI_API_KEY=" + secret });
        store.db.prepare("update memories set statement_json=? where id=?").run(JSON.stringify(statement), memory.id);
        scrubPrivacy(store);
        const after = store.readMemory(memory.id)!;
        expect(JSON.stringify(after.statement)).not.toContain(secret);
        expect(after.statement?.fields.rationale).toContain("REDACTED");
        expect(after.statement?.origin).toBe("submitted");
    });
    it("completes statement-aware embedding jobs and rejects vectors after a slot changes", () => {
        const { store } = fixture();
        const memory = save(store, "Support offline use.");
        const endpointHash = createEmbeddingEndpointHash("https://example.test/v1"), model = "test";
        const provider = { endpointHash, model, providerKey: createProviderKey(endpointHash, model) };
        store.reconcileEmbeddingJobs(provider);
        const job = store.listEmbeddingJobs({ state: "pending" }).find(j => j.ownerId === memory.id)!;
        expect(store.listEmbeddingOwners().find(owner => owner.ownerId === memory.id)?.text).toContain("Support offline use.");
        store.completeEmbeddingJob({ ...job, ...provider, providerFingerprint: createProviderFingerprint(endpointHash, model, 1), dimension: 1, vectorBlob: encodeFloat32Vector([1]) });
        expect(store.listActiveEmbeddingVectors({ providerKey: provider.providerKey }).find(v => v.ownerId === memory.id)).toBeDefined();
        store.db.prepare("update memories set statement_json=? where id=?").run(JSON.stringify(createStatement(memory.summary, "decision", "submitted", { rationale: "Support a different deployment." })), memory.id);
        expect(store.listActiveEmbeddingVectors({ providerKey: provider.providerKey }).find(v => v.ownerId === memory.id)).toBeUndefined();
    });
    it("flags differing fields under both same and different natural-key identities instead of silently converging", () => {
        for (const sameId of [true, false]) {
            const local = fixture().store, remote = fixture().store, base = fixture().store;
            const left = save(local, "Support offline use."), right = save(remote, "Support another reason.");
            if (sameId) {
                remote.db.exec("begin; pragma defer_foreign_keys=on");
                remote.db.prepare("update memories set id=? where id=?").run(left.id, right.id);
                remote.db.prepare("update memory_candidates set promoted_memory_id=? where promoted_memory_id=?").run(left.id, right.id);
                remote.db.prepare("update memory_links set owner_id=? where owner_kind='memory' and owner_id=?").run(left.id, right.id);
                remote.db.exec("commit");
            }
            const result = mergeCore(local.db, remote.db, base.db);
            expect(result.flagged).toBeGreaterThan(0);
            expect(result.reviewMemoryIds).toContain(left.id);
            expect(local.readMemory(left.id)?.statement?.fields.rationale).toBe("Support offline use.");
        }
    });
});
