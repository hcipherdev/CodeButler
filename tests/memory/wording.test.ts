// Tests selected AI wording drafts, strict fields, individual approval, stale versions, cancellation, and undo.
import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { openMemoryStore } from "../../src/storage/store.js";
import { rememberProjectMemory } from "../../src/memory/remember.js";
import { resolveMemoryReview } from "../../src/memory/review.js";
import { matchingMemoryVerification, currentMemoryReview } from "../../src/memory/review-state.js";
import { applyMemoryWording, previewMemoryWording, readMemoryWording, runMemoryWording, validateWordingProposal, type WordingSelection } from "../../src/memory/wording.js";
import type { MemoryReconciliationProvider } from "../../src/memory/reconciliation-provider.js";
import { createStatement } from "../../src/memory/statement.js";
import { makeTempDir, cleanupTempDir } from "../helpers/temp.js";
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const r of roots.splice(0))
    cleanupTempDir(r); });
function fixture() { const root = makeTempDir(); roots.push(root); vi.stubEnv("CODE_BUTLER_HOME", join(root, "home")); const store = openMemoryStore(root); store.init(); return { root, store }; }
function add(store: ReturnType<typeof openMemoryStore>, text: string, promote = true) { return rememberProjectMemory(store, { type: "decision", text, promote, scope: { kind: "conditional", platforms: ["win32"] }, statement: { fields: { rationale: "Support offline work." } } }, { actor: "desktop" }); }
function selection(...items: Array<{
    id: string;
    category?: "candidate" | "promoted";
}>): WordingSelection { return { kind: "selected", items: items.map(i => ({ memoryId: i.id, category: i.category ?? "promoted" })) }; }
function provider(work: (payload: Record<string, unknown>, call: number) => unknown = (payload) => ({ ...payload, text: String(payload.text).replace("Use ", "Choose ") })): MemoryReconciliationProvider & {
    calls: number;
    payloads: Record<string, unknown>[];
} {
    return { provider: "test", model: "test", calls: 0, payloads: [], async request(input) { this.payloads.push(input.payload); const value = work(input.payload, ++this.calls); return { content: JSON.stringify(value), inputTokens: 10, outputTokens: 10 }; } };
}
function read(root: string, id: string) { const store = openMemoryStore(root); store.init(); try {
    return store.readMemory(id)!;
}
finally {
    store.close();
} }
describe("wording-only AI mode", () => {
    it("rejects new, missing, empty and metadata fields", () => {
        const before = createStatement("Use SQLite.", "decision", "human", { choice: "Use SQLite.", rationale: "Support offline work." });
        expect(() => validateWordingProposal(before, { text: "Choose SQLite.", fields: { choice: "Choose SQLite." } }, "decision")).toThrow("exactly");
        expect(() => validateWordingProposal(before, { text: "Choose SQLite.", fields: { ...before.fields, alternatives: "Redis" } }, "decision")).toThrow("exactly");
        expect(() => validateWordingProposal(before, { text: "Choose SQLite.", fields: { ...before.fields, rationale: "" } }, "decision")).toThrow();
        expect(() => validateWordingProposal(before, { text: "Choose SQLite.", fields: before.fields, type: "constraint" }, "decision")).toThrow();
        expect(validateWordingProposal(before, { text: "Choose SQLite.", fields: before.fields }, "decision").origin).toBe("ai_wording_accepted");
    });
    it("sends only wording, keeps drafts local, applies selected approvals, and clears verification", async () => {
        const { root, store } = fixture();
        let a: string, b: string, before: ReturnType<typeof read>;
        try {
            a = add(store, "Use SQLite for project storage.").memory!.id;
            b = add(store, "Use local queues for jobs.").memory!.id;
            store.db.prepare("update memories set confidence=0.5 where id=?").run(a);
            resolveMemoryReview(store, { memoryId: a, category: "promoted", action: "verify" }, "desktop");
            before = store.readMemory(a)!;
            expect(matchingMemoryVerification(store, "promoted", before)).toBeDefined();
        }
        finally {
            store.close();
        }
        const fake = provider(), selected = selection({ id: a }, { id: b }), preview = previewMemoryWording(root, selected, { provider: fake });
        const run = await runMemoryWording(root, { selection: selected, tokenCap: 10000, expectedSelectionFingerprint: preview.selectionFingerprint }, { provider: fake });
        expect(run.mode).toBe("wording");
        expect(run.counts.planned).toBe(2);
        expect(read(root, a).statement).toEqual(before.statement);
        expect(fake.payloads.every(p => JSON.stringify(Object.keys(p).sort()) === JSON.stringify(["fields", "text"]))).toBe(true);
        expect(await applyMemoryWording(root, run.id, [])).toMatchObject({ counts: { planned: 2, applied: 0 } });
        const accepted = await applyMemoryWording(root, run.id, [run.items[0]!.itemId]);
        expect(accepted.counts.applied).toBe(1);
        expect(accepted.counts.planned).toBe(1);
        const after = read(root, a);
        expect(after.statement?.origin).toBe("ai_wording_accepted");
        expect(after.id).toBe(before.id);
        expect({ type: after.type, evidence: after.evidence, scope: after.scope, layer: after.layer, lifecycle: after.lifecycleStatus }).toEqual({ type: before.type, evidence: before.evidence, scope: before.scope, layer: before.layer, lifecycle: before.lifecycleStatus });
        expect(read(root, b).summary).toBe("Use local queues for jobs.");
        const verify = openMemoryStore(root);
        verify.init();
        try {
            expect(matchingMemoryVerification(verify, "promoted", verify.readMemory(a)!)).toBeUndefined();
            expect(currentMemoryReview(verify, "promoted", verify.readMemory(a)!)).toMatchObject({ action: "accept_wording" });
            expect(verify.db.prepare("select name from sqlite_master where name='memory_wording_runs'").get()).toBeUndefined();
            expect(verify.localDb.prepare("select count(*) n from memory_wording_runs").get()).toEqual({ n: 1 });
        }
        finally {
            verify.close();
        }
        const replay = await applyMemoryWording(root, run.id, [run.items[0]!.itemId]);
        expect(replay.counts.applied).toBe(1);
        const undone = await applyMemoryWording(root, run.id, [run.items[0]!.itemId], true);
        expect(undone.items[0]?.state).toBe("reverted");
        expect(read(root, a).statement).toEqual(before.statement);
        const undoVerify = openMemoryStore(root);
        undoVerify.init();
        try {
            expect(matchingMemoryVerification(undoVerify, "promoted", undoVerify.readMemory(a)!)).toBeUndefined();
        }
        finally {
            undoVerify.close();
        }
    });
    it("rejects stale approvals and protects undo after another change", async () => {
        const { root, store } = fixture();
        let a: string, b: string;
        try {
            a = add(store, "Use SQLite for durable storage.").memory!.id;
            b = add(store, "Use serial writes for snapshots.").memory!.id;
        }
        finally {
            store.close();
        }
        const fake = provider(), run = await runMemoryWording(root, { selection: selection({ id: a }, { id: b }), tokenCap: 10000 }, { provider: fake });
        const changed = openMemoryStore(root);
        changed.init();
        try {
            changed.db.prepare("update memories set reason='Changed factual context' where id=?").run(a);
        }
        finally {
            changed.close();
        }
        const applied = await applyMemoryWording(root, run.id, run.items.map(i => i.itemId));
        expect(applied.items.find(i => i.memoryId === a)?.state).toBe("stale");
        expect(applied.items.find(i => i.memoryId === b)?.state, JSON.stringify(applied.items)).toBe("applied");
        const edited = openMemoryStore(root);
        edited.init();
        try {
            edited.db.prepare("update memories set reason='Changed after wording acceptance' where id=?").run(b);
        }
        finally {
            edited.close();
        }
        const undo = await applyMemoryWording(root, run.id, applied.items.filter(i => i.state === "applied").map(i => i.itemId), true);
        expect(undo.items.find(i => i.memoryId === b)?.state).toBe("revert_blocked");
        expect(read(root, b).statement?.origin).toBe("ai_wording_accepted");
        await expect(applyMemoryWording(root, run.id, ["unapproved-id"])).rejects.toThrow("Unknown approved proposal");
    });
    it("resumes budget-limited and failed items without mutating unapproved memories", async () => {
        const { root, store } = fixture();
        let a: string, b: string;
        try {
            a = add(store, "Use a local retry queue.").memory!.id;
            b = add(store, "Use a local writer lock.").memory!.id;
        }
        finally {
            store.close();
        }
        const fake = provider((payload, call) => { if (call === 1)
            throw new Error("Provider failed"); return { ...payload, text: String(payload.text).replace("Use", "Choose") }; });
        const limited = await runMemoryWording(root, { selection: selection({ id: a }, { id: b }), tokenCap: 1 }, { provider: fake });
        expect(limited.status).toBe("partial");
        expect(fake.calls).toBe(0);
        const partial = await runMemoryWording(root, { continueRunId: limited.id, tokenCap: 10000 }, { provider: fake });
        expect(partial.counts).toMatchObject({ planned: 1, failed: 1 });
        expect(read(root, a).summary).toBe("Use a local retry queue.");
        const resumed = await runMemoryWording(root, { continueRunId: partial.id, tokenCap: 10000 }, { provider: fake });
        expect(resumed.counts.planned).toBe(2);
        expect(readMemoryWording(root, resumed.id)?.requestCount).toBe(3);
    });
    it("charges a cancelled request and leaves the memory unchanged", async () => {
        const { root, store } = fixture();
        let id: string;
        try {
            id = add(store, "Use project-owned keys.").memory!.id;
        }
        finally {
            store.close();
        }
        let stop = false;
        const fake = provider(payload => { stop = true; return payload; });
        const run = await runMemoryWording(root, { selection: selection({ id }), tokenCap: 10000 }, { provider: fake, shouldStop: () => stop });
        expect(run.status).toBe("partial");
        expect(run.counts.pending).toBe(1);
        expect(run.tokenCount).toBeGreaterThan(0);
        expect(run.requestCount).toBe(1);
        expect(read(root, id).summary).toBe("Use project-owned keys.");
    });
    it("supports candidates and directs missing claims to Correct", async () => {
        const { root, store } = fixture();
        let candidate: string, missing: string;
        try {
            candidate = add(store, "Use explicit project scope.", false).candidate.id;
            missing = store.upsertMemoryCandidate({ type: "constraint", title: "Documentation", summary: "Documentation includes Memory layers.", reason: "Extraction", confidence: 0.8, evidence: [], relatedFiles: [], dedupeKey: "missing" }).id;
        }
        finally {
            store.close();
        }
        expect(() => previewMemoryWording(root, selection({ id: missing, category: "candidate" }), { provider: provider() })).toThrow("Correct");
        const run = await runMemoryWording(root, { selection: selection({ id: candidate, category: "candidate" }), tokenCap: 10000 }, { provider: provider() });
        const result = await applyMemoryWording(root, run.id, [run.items[0]!.itemId]);
        expect(result.counts.applied, JSON.stringify(result.items)).toBe(1);
    });
});
