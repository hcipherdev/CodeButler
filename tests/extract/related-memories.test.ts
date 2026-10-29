// Tests selectRelatedMemories() in src/extract/related-memories.ts, existingMemories in extractionBatches() (src/extract/context.ts), and sameAs/invalidates handling during syncProjectMemory() in src/sync/service.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadProjectConfig } from "../../src/config.js";
import { extractionBatches, MAX_EXTRACTION_INPUT_BYTES } from "../../src/extract/context.js";
import { selectRelatedMemories } from "../../src/extract/related-memories.js";
import { resolveMemoryReview } from "../../src/memory/review.js";
import { openMemoryStore, type MemoryStore } from "../../src/storage/store.js";
import { syncProjectMemory } from "../../src/sync/service.js";
import type { EvidenceRef, ExtractorContext, ExtractorMemory, ExtractorProvider, MemoryCandidate } from "../../src/types.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const roots: string[] = [], stores: MemoryStore[] = [];
const OLD = "2026-10-01T00:00:00.000Z", NEW = "2026-10-05T00:00:00.000Z";

/** A project whose configured sources are all off, so sync only processes queued jobs. */
function store(): MemoryStore {
  const root = makeTempDir(); roots.push(root);
  mkdirSync(join(root, ".code-butler"), { recursive: true });
  writeFileSync(join(root, ".code-butler", "config.json"), JSON.stringify({
    sources: { git: { enabled: false }, codex: { enabled: false }, claude: { enabled: false } },
    extractor: { provider: "openai-compatible", baseUrl: "https://example.test/v1", model: "test", apiKeyEnv: "TEST_API_KEY" }
  }));
  const s = openMemoryStore(root); s.init(); stores.push(s); return s;
}

afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  roots.splice(0).forEach(cleanupTempDir);
});

function commit(s: MemoryStore, hash: string, authoredAt: string, changedFiles: string[] = []): EvidenceRef {
  s.addCommit({ hash, authorName: "T", authorEmail: "t@example.com", authoredAt, message: `Commit ${hash}`, changedFiles, diffSummary: hash });
  return { sourceType: "commit", sourceId: hash };
}

function candidate(s: MemoryStore, key: string, fields: Partial<MemoryCandidate> & { evidence: EvidenceRef[] }): MemoryCandidate {
  return s.upsertMemoryCandidate({
    type: "bug_fix", title: `Fact ${key}`, summary: `Summary ${key}.`, reason: "From a session.", confidence: 0.9,
    relatedFiles: [], dedupeKey: key, ...fields
  }, { qualityStatus: "active", qualityReasons: [] });
}

/** A queued conversation with one message, as a later session would leave it. */
function queuedConversation(s: MemoryStore, text: string, timestamp = NEW): EvidenceRef {
  const sourceId = "claude:later";
  s.addSourceWithChunks({
    source: { id: sourceId, type: "conversation", title: "later.jsonl", origin: "/tmp/later.jsonl", rawContent: text },
    chunks: [{ text, metadata: { role: "user", timestamp } }]
  });
  s.enqueueExtractionEvidence("claude", "conversation", sourceId);
  return { sourceType: "conversation", sourceId, locator: `${sourceId}:chunk:0` };
}

function extractorReturning(build: (context: ExtractorContext) => ExtractorMemory[]): ExtractorProvider & { contexts: ExtractorContext[] } {
  const contexts: ExtractorContext[] = [];
  return { contexts, async extract(context) { contexts.push(context); return { memories: build(context), rejected: [] }; } };
}

const refFor = (context: ExtractorContext, title: string) => context.existingMemories?.find((item) => item.title === title)?.ref;

describe("selectRelatedMemories", () => {
  it("offers memories that share files or terms with the batch, dated by their evidence", () => {
    const s = store();
    candidate(s, "recovery", { title: "Saved recovery code trust", summary: "Saved recovery codes do not grant device trust.", relatedFiles: ["src/recovery.rs"], evidence: [commit(s, "c-old", OLD)] });
    candidate(s, "unrelated", { title: "Dashboard cards", summary: "Cards open detail views.", relatedFiles: ["src/ui.ts"], evidence: [commit(s, "c-ui", OLD)] });
    const discarded = candidate(s, "discarded", { title: "Recovery trust note", summary: "Recovery trust recovery codes.", relatedFiles: ["src/recovery.rs"], evidence: [commit(s, "c-x", OLD)] });
    resolveMemoryReview(s, { memoryId: discarded.id, category: "candidate", action: "discard", reason: "Noise." }, "desktop");

    const context: ExtractorContext = {
      conversations: [],
      commits: [{ hash: "c-new", authorName: "T", authorEmail: "t@example.com", authoredAt: NEW, message: "Grant device trust after recovery code entry", changedFiles: ["src/recovery.rs"], diffSummary: "" }]
    };
    const selection = selectRelatedMemories(s, context, 20);
    expect(selection.existingMemories.map((item) => item.title)).toEqual(["Saved recovery code trust"]);
    expect(selection.existingMemories[0]).toMatchObject({ ref: "E1", type: "bug_fix", status: "candidate", recordedAt: OLD });
    expect(selection.targets.get("E1")?.category).toBe("candidate");
  });

  it("repeats existing memories in every batch a large context is split into", () => {
    const big = "x".repeat(MAX_EXTRACTION_INPUT_BYTES / 2 + 10);
    const context: ExtractorContext = {
      conversations: ["a", "b"].map((id) => ({ sourceId: `claude:${id}`, title: id, rawContent: "", chunks: [{ id: `claude:${id}:chunk:0`, chunkIndex: 0, text: `Plain prose ${big}` }] })),
      commits: [],
      existingMemories: [{ ref: "E1", type: "decision", title: "t", summary: "s", status: "candidate", recordedAt: OLD }]
    };
    const batches = extractionBatches(context);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) expect(batch.existingMemories?.[0]?.ref).toBe("E1");
  });
});

describe("sync with existing memories", () => {
  it("merges a restated fact into the existing candidate it names", async () => {
    const s = store();
    const existing = candidate(s, "recovery-no-trust", { title: "Saved recovery code trust", summary: "Saved recovery codes do not grant device trust.", relatedFiles: ["src/recovery.rs"], evidence: [commit(s, "c-old", OLD)] });
    const chunk = queuedConversation(s, "Saved recovery code trust: recovery codes do not grant device trust yet, see src/recovery.rs.");
    const extractor = extractorReturning((context) => [{
      type: "bug_fix", title: "Recovery codes skip trust", summary: "Recovery codes leave the device untrusted.", reason: "Seen again.", confidence: 0.9,
      relatedFiles: ["src/recovery.rs"], dedupeKey: "a-fresh-key", evidence: [chunk], sameAs: refFor(context, "Saved recovery code trust")
    }]);

    const result = await syncProjectMemory(s, loadProjectConfig(s.paths.rootDir), { extractorProvider: extractor });
    expect(extractor.contexts[0]?.existingMemories?.length).toBeGreaterThan(0);
    expect(result.memories.candidates).toBe(1);
    const merged = s.readMemoryCandidate(existing.id)!;
    expect(merged.evidence.map((item) => item.sourceId)).toEqual(["c-old", "claude:later"]);
    expect(merged.title).toBe("Saved recovery code trust");
    expect(s.listMemoryCandidates({ qualityStatus: "all", limit: null })).toHaveLength(1);
  });

  it("retires an existing candidate that newer evidence invalidates", async () => {
    const s = store();
    const existing = candidate(s, "recovery-no-trust", { title: "Saved recovery code trust", summary: "Saved recovery codes do not grant device trust.", relatedFiles: ["src/recovery.rs"], evidence: [commit(s, "c-old", OLD)] });
    const chunk = queuedConversation(s, "Saved recovery code trust is fixed: entering the recovery code now grants full device trust in src/recovery.rs.");
    const extractor = extractorReturning((context) => [{
      type: "decision", title: "Recovery code grants trust", summary: "Password plus the saved recovery code grants full device trust.", reason: "The fix landed.",
      confidence: 0.95, relatedFiles: ["src/recovery.rs"], dedupeKey: "recovery-grants-trust", evidence: [chunk],
      invalidates: { ref: refFor(context, "Saved recovery code trust")!, confidence: 0.95, why: "The fix grants trust now." }
    }]);

    await syncProjectMemory(s, loadProjectConfig(s.paths.rootDir), { extractorProvider: extractor });
    expect(s.readMemoryCandidate(existing.id)!.qualityStatus).toBe("quarantined");
    const replacement = s.listMemoryCandidates({ qualityStatus: "all", limit: null }).find((item) => item.dedupeKey === "recovery-grants-trust");
    expect(replacement?.qualityStatus).not.toBe("quarantined");
  });
});
