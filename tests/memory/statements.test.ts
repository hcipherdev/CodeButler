// Tests memory statements, claim quality, canonical persistence, and verification integrity.
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "../../src/storage/store.js";
import { rememberProjectMemory } from "../../src/memory/remember.js";
import { createStatement, assessClaim, parseStatement, memoryContentText } from "../../src/memory/statement.js";
import { presentMemory, presentMemoryMarkdown } from "../../src/memory/presentation.js";
import { createMemoryReviewContext } from "../../src/memory/review-state.js";
import { resolveMemoryReview } from "../../src/memory/review.js";
import { makeTempDir, cleanupTempDir } from "../helpers/temp.js";
const stores: ReturnType<typeof openMemoryStore>[] = [];
const roots: string[] = [];
afterEach(() => { for (const store of stores.splice(0))
    store.close(); for (const root of roots.splice(0))
    cleanupTempDir(root); });
function fixture() {
    const root = makeTempDir();
    roots.push(root);
    const store = openMemoryStore(root);
    store.init();
    stores.push(store);
    return store;
}
describe("human-readable memory foundation", () => {
    it("round-trips canonical statements and their fields through promotion and search", () => {
        const store = fixture();
        const saved = rememberProjectMemory(store, { type: "decision", text: "Use Tauri for the desktop.", scope: { kind: "project" },
            statement: { fields: { choice: "Use Tauri", rationale: "It has a smaller distribution.", alternatives: "Electron" } } }, { actor: "desktop" });
        const memory = store.readMemory(saved.memory!.id)!;
        expect(memory.statement).toEqual(createStatement("Use Tauri for the desktop.", "decision", "human", {
            choice: "Use Tauri", rationale: "It has a smaller distribution.", alternatives: "Electron"
        }));
        expect(memory.summary).toBe(memory.statement!.text);
        expect(store.searchMemoryLayer({ query: "smaller distribution", qualityStatus: "all" })[0]?.id).toBe(memory.id);
        const detail = store.readMemorySearchResultsByIds([memory.id])[0]!;
        expect(detail.presentation?.slots.find(slot => slot.label === "Because")?.value).toBe("It has a smaller distribution.");
        expect(presentMemoryMarkdown(presentMemory(detail), { link: "memory:" + memory.id })).toContain("memory:" + memory.id);
    });
    it("does not label MCP submissions as human-authored", () => {
        const store = fixture();
        expect(rememberProjectMemory(store, { type: "constraint", text: "Keep memory local first." }, { actor: "mcp" }).candidate.statement?.origin).toBe("submitted");
    });
    it("does not mistake capture provenance or missing rationale for a missing claim", () => {
        expect(assessClaim({ type: "constraint", summary: "Never commit memory.sqlite." })).toBe("meaningful");
        expect(assessClaim({ type: "constraint", summary: "Test expectation: keeps encryption keys on the device" })).toBe("meaningful");
        const store = fixture();
        const memory = rememberProjectMemory(store, { type: "constraint", text: "Never commit memory.sqlite.", reason: "Captured from explicit conversation directive." }).memory!;
        expect(memory.qualityReasons).not.toContain("missing_claim");
    });
    it("treats only the docs extractor shape as a placeholder, not claims that start with the same words", () => {
        expect(assessClaim({ type: "constraint", summary: "Documentation includes Release manifest." })).toBe("missing_claim");
        expect(assessClaim({ type: "constraint", summary: "Documentation includes 6. Cloud upload is stuck.", dedupeKey: "deterministic:docs:docs/issues.md:6-cloud-upload-is-stuck" })).toBe("missing_claim");
        expect(assessClaim({ type: "constraint", summary: "Documentation includes 6. Cloud upload is stuck.", dedupeKey: "remember:constraint:x" })).toBe("meaningful");
        expect(assessClaim({ type: "constraint", summary: "Documentation includes both macOS and Windows prerequisites. The Windows section lists Visual Studio Build Tools.", dedupeKey: "ai-reconciliation:candidate-1:abc" })).toBe("meaningful");
    });
    it("requires correction for an extraction placeholder instead of allowing verification", () => {
        const store = fixture();
        const memory = rememberProjectMemory(store, { type: "constraint", text: "Documentation includes Memory layers." }).memory!;
        expect(store.readMemory(memory.id)?.qualityReasons).toContain("missing_claim");
        expect(() => resolveMemoryReview(store, { memoryId: memory.id, category: "promoted", action: "verify" }, "desktop")).toThrow("corrected or discarded");
    });
    it("uses the stored claim for quality and preserves its author during sanitization", () => {
        const store = fixture();
        const saved = rememberProjectMemory(store, { type: "decision", text: "Use SQLite." });
        const candidate = store.upsertMemoryCandidate({ ...saved.candidate, summary: "Documentation includes SQLite.",
            statement: createStatement("Use SQLite for local storage.", "decision", "submitted", { choice: "SQLite" }) });
        expect(candidate.summary).toBe("Use SQLite for local storage.");
        expect(candidate.qualityReasons).not.toContain("missing_claim");
    });
    it("invalidates verification when structured rationale changes without changing the claim", () => {
        const store = fixture();
        const saved = rememberProjectMemory(store, { type: "decision", text: "Use SQLite.", promote: false });
        const original = store.upsertMemoryCandidate({ ...saved.candidate, confidence: 0.55 });
        const context = createMemoryReviewContext(store, "candidate", original);
        resolveMemoryReview(store, { memoryId: original.id, category: "candidate", action: "verify", reviewToken: context.reviewToken }, "desktop");
        const changed = store.upsertMemoryCandidate({ ...original,
            statement: createStatement("Use SQLite.", "decision", "submitted", { rationale: "Support offline queries." }) });
        expect(createMemoryReviewContext(store, "candidate", changed).reviewToken).not.toBe(context.reviewToken);
        expect(store.readMemorySearchResultsByIds([changed.id], { includeCandidates: true })[0]?.trust?.displayStatus).toBe("needs_review");
    });
    it("leaves legacy NULL statements unmodified and exposes only a derived presentation", () => {
        const store = fixture();
        store.addCommit({ hash: "legacy", authorName: "Test", authorEmail: "test@example.com", authoredAt: "2026-09-01T00:00:00Z",
            message: "Choose local storage", changedFiles: [], diffSummary: "" });
        const candidate = store.upsertMemoryCandidate({ type: "decision", title: "Use SQLite", summary: "Use SQLite for local storage.",
            reason: "Recorded choice.", confidence: 1, evidence: [{ sourceType: "commit", sourceId: "legacy" }], relatedFiles: [], dedupeKey: "legacy" });
        const memory = store.promoteMemoryCandidate(candidate.id);
        expect(memory.statement).toBeUndefined();
        expect(store.db.prepare("select statement_json from memories where id=?").get(memory.id)).toMatchObject({ statement_json: null });
        expect(store.readMemorySearchResultsByIds([memory.id])[0]?.presentation?.derived).toBe(true);
    });
    it("drops unrelated and empty extractor fields and forces extracted authorship", () => {
        const statement = parseStatement({ version: 1, text: "Use Tauri.", origin: "human",
            fields: { choice: "Tauri", rationale: "", invented: "unsafe", fix: "unrelated" } }, "decision", "extracted");
        expect(statement).toEqual({ version: 1, text: "Use Tauri.", origin: "extracted", fields: { choice: "Tauri" } });
    });
    it("keeps applicability separate from project sharing and escapes Markdown claims", () => {
        const store = fixture();
        const memory = rememberProjectMemory(store, { type: "constraint", text: "Keep *keys* local.", scope: { kind: "conditional", platforms: ["win32"] } }).memory!;
        const p = presentMemory(store.readMemorySearchResultsByIds([memory.id])[0]!);
        expect(p.sharing).toBe("Whole project");
        expect(p.applies).toBe("Windows");
        expect(presentMemoryMarkdown(p)).toContain("\\*keys\\*");
        expect(memoryContentText(memory)).toContain("Keep *keys* local.");
    });
});
