// Tests mergeEvidence() in src/memory/evidence-merge.ts, MemoryStore.mergeExtractedMemoryCandidate() in src/storage/store.ts, and the evidence-recency and stale-verify rules of assessMemoryQuality() in src/memory/quality.ts.
import { afterEach, describe, expect, it } from "vitest";

import { planAutomaticPromotions } from "../../src/memory/automatic-promotion.js";
import { mergeEvidence, mergeRelatedFiles } from "../../src/memory/evidence-merge.js";
import { resolveMemoryReview } from "../../src/memory/review.js";
import { openMemoryStore, type MemoryStore } from "../../src/storage/store.js";
import type { EvidenceRef, ExtractedMemory, MemoryCandidate, ProjectConfig } from "../../src/types.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const roots: string[] = [], stores: MemoryStore[] = [];

function store(): MemoryStore {
  const root = makeTempDir(); roots.push(root);
  const s = openMemoryStore(root); s.init(); stores.push(s); return s;
}

function commit(s: MemoryStore, hash: string, authoredAt = "2026-10-01T00:00:00.000Z", changedFiles: string[] = []): EvidenceRef {
  s.addCommit({ hash, authorName: "Test", authorEmail: "test@example.com", authoredAt, message: `Commit ${hash}`, changedFiles, diffSummary: `Change for ${hash}.` });
  return { sourceType: "commit", sourceId: hash };
}

function conversation(s: MemoryStore, sessionId: string, timestamp: string): EvidenceRef {
  const sourceId = `claude:${sessionId}`;
  s.addSourceWithChunks({
    source: { id: sourceId, type: "conversation", title: `${sessionId}.jsonl`, origin: `/tmp/${sessionId}.jsonl`, rawContent: "user: keep uploads resumable" },
    chunks: [{ text: "We keep uploads resumable because large vaults time out.", metadata: { role: "user", timestamp } }]
  });
  return { sourceType: "conversation", sourceId, locator: `${sourceId}:chunk:0` };
}

function extracted(evidence: EvidenceRef[], overrides: Partial<ExtractedMemory> = {}): ExtractedMemory {
  return {
    type: "decision",
    title: "Uploads are resumable",
    summary: "Vault uploads resume from the last confirmed block instead of restarting.",
    reason: "Large vaults time out before a single request finishes.",
    confidence: 0.9,
    evidence,
    relatedFiles: [],
    dedupeKey: "resumable-uploads",
    ...overrides
  };
}

function config(): ProjectConfig {
  return {
    promotion: {
      confidenceThreshold: 0.85, requireCommitAndConversation: true, minSourceCategories: 2,
      automatic: { enabled: true, mode: "conservative", minScore: 0.85, mergedBranches: true, deviceMemories: true, coreCandidates: true, singleSourceMinConfidence: 0.9 }
    },
    sources: { git: { repoPath: "" } }
  } as unknown as ProjectConfig;
}

function reread(s: MemoryStore, id: string): MemoryCandidate {
  return s.listMemoryCandidates({ qualityStatus: "all", limit: null }).find((item) => item.id === id)!;
}

afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  roots.splice(0).forEach(cleanupTempDir);
});

describe("mergeEvidence", () => {
  const ref = (sourceId: string, locator?: string): EvidenceRef => ({ sourceType: "conversation", sourceId, ...(locator ? { locator } : {}) });

  it("unions references, keeping existing ones first", () => {
    expect(mergeEvidence([ref("a", "a:1")], [ref("a", "a:1"), ref("b", "b:1")])).toEqual([ref("a", "a:1"), ref("b", "b:1")]);
  });

  it("gives a new distinct source a slot over another locator of a cited source", () => {
    const existing = [1, 2, 3, 4].map((n) => ref("a", `a:${n}`));
    const merged = mergeEvidence(existing, [ref("b", "b:1")], 4);
    expect(merged.map((item) => item.sourceId)).toEqual(["a", "a", "a", "b"]);
  });

  it("never drops references a row already holds when it is over the cap", () => {
    const existing = [1, 2, 3].map((n) => ref(`s${n}`));
    expect(mergeEvidence(existing, [], 2)).toHaveLength(3);
    expect(mergeRelatedFiles(["a", "b", "c"], ["d"], 2)).toEqual(["a", "b", "c"]);
  });
});

describe("mergeExtractedMemoryCandidate", () => {
  it("adds a second session's evidence to the existing candidate and keeps its wording", () => {
    const s = store();
    const first = s.mergeExtractedMemoryCandidate(extracted([commit(s, "c1")]), { qualityStatus: "active", qualityReasons: [] });
    expect(first.outcome).toBe("inserted");

    const second = s.mergeExtractedMemoryCandidate(
      extracted([commit(s, "c2")], { title: "Resumable vault uploads", confidence: 0.95, relatedFiles: ["src/upload.ts"] }),
      { qualityStatus: "active", qualityReasons: [] }
    );
    expect(second.outcome).toBe("merged");
    expect(second.candidate.id).toBe(first.candidate.id);
    expect(second.candidate.title).toBe("Uploads are resumable");
    expect(second.candidate.confidence).toBe(0.95);
    expect(second.candidate.evidence.map((item) => item.sourceId)).toEqual(["c1", "c2"]);
    expect(second.candidate.relatedFiles).toEqual(["src/upload.ts"]);
    expect(second.candidate.updatedAt > first.candidate.updatedAt).toBe(true);
  });

  it("leaves the version alone when nothing new was found", () => {
    const s = store();
    const evidence = [commit(s, "c1")];
    const first = s.mergeExtractedMemoryCandidate(extracted(evidence));
    const again = s.mergeExtractedMemoryCandidate(extracted(evidence, { confidence: 0.6 }));
    expect(again.outcome).toBe("unchanged");
    expect(again.candidate.updatedAt).toBe(first.candidate.updatedAt);
    expect(again.candidate.confidence).toBe(0.9);
  });

  it("does not revive a fact a person discarded", () => {
    const s = store();
    const first = s.mergeExtractedMemoryCandidate(extracted([commit(s, "c1")]));
    resolveMemoryReview(s, { memoryId: first.candidate.id, category: "candidate", action: "discard", reason: "Wrong." }, "desktop");

    const again = s.mergeExtractedMemoryCandidate(extracted([commit(s, "c2")]), { qualityStatus: "active", qualityReasons: [] });
    expect(again.outcome).toBe("skipped_withdrawn");
    expect(reread(s, first.candidate.id).evidence.map((item) => item.sourceId)).toEqual(["c1"]);
    expect(reread(s, first.candidate.id).qualityStatus).toBe("quarantined");
  });

  it("keeps device-local preserved quality reasons instead of overwriting them on a merge", () => {
    const s = store();
    const first = s.mergeExtractedMemoryCandidate(extracted([commit(s, "c1")]), {
      qualityStatus: "needs_review", qualityReasons: ["automatic_promotion_conflict"]
    });
    s.mergeExtractedMemoryCandidate(extracted([commit(s, "c2")]), { qualityStatus: "active", qualityReasons: [] });
    expect(reread(s, first.candidate.id).qualityReasons).toContain("automatic_promotion_conflict");
  });

  it("lets a fact found in two sessions reach the independent-sources bar", () => {
    const s = store();
    const first = s.mergeExtractedMemoryCandidate(extracted([conversation(s, "one", "2026-10-02T00:00:00.000Z")]), { qualityStatus: "active", qualityReasons: [] });
    expect(planAutomaticPromotions(s, config()).decisions.find((item) => item.memoryId === first.candidate.id)?.reasonCodes)
      .toContain("no_corroboration");

    s.mergeExtractedMemoryCandidate(extracted([conversation(s, "two", "2026-10-03T00:00:00.000Z")]), { qualityStatus: "active", qualityReasons: [] });
    const decision = planAutomaticPromotions(s, config()).decisions.find((item) => item.memoryId === first.candidate.id)!;
    expect(decision.decision).toBe("promote");
    expect(decision.reasonCodes).toContain("independent_sources");
  });
});

describe("quality after evidence merges", () => {
  it("clears stale related-file evidence once a later conversation restates the fact", () => {
    const s = store();
    const old = commit(s, "c-old", "2026-10-01T00:00:00.000Z", ["src/upload.ts"]);
    commit(s, "c-later", "2026-10-05T00:00:00.000Z", ["src/upload.ts"]);
    const first = s.mergeExtractedMemoryCandidate(extracted([old], { relatedFiles: ["src/upload.ts"] }));
    expect(reread(s, first.candidate.id).qualityReasons).toContain("stale_related_file_evidence");

    s.mergeExtractedMemoryCandidate(extracted([conversation(s, "restated", "2026-10-06T00:00:00.000Z")], { relatedFiles: ["src/upload.ts"] }));
    expect(reread(s, first.candidate.id).qualityReasons).not.toContain("stale_related_file_evidence");
  });

  it("treats a stale AI verify on a candidate as unverified, but a person's as needing review", () => {
    const s = store();
    const ai = s.mergeExtractedMemoryCandidate(extracted([commit(s, "a1")], { dedupeKey: "ai-checked" }), { qualityStatus: "active", qualityReasons: [] });
    resolveMemoryReview(s, {
      memoryId: ai.candidate.id, category: "candidate", action: "verify", reason: "AI judged it current.",
      provenance: { verdict: "current", policyVersion: "test", confidence: 0.95, citationIds: [], reconciliationRunId: "run", reconciliationItemId: "item" }
    }, "ai");
    const human = s.mergeExtractedMemoryCandidate(extracted([commit(s, "h1")], { dedupeKey: "human-checked" }), { qualityStatus: "active", qualityReasons: [] });
    resolveMemoryReview(s, { memoryId: human.candidate.id, category: "candidate", action: "verify" }, "desktop");

    s.mergeExtractedMemoryCandidate(extracted([commit(s, "a2")], { dedupeKey: "ai-checked" }));
    s.mergeExtractedMemoryCandidate(extracted([commit(s, "h2")], { dedupeKey: "human-checked" }));

    expect(reread(s, ai.candidate.id).qualityReasons).not.toContain("review_context_changed");
    expect(reread(s, ai.candidate.id).qualityStatus).toBe("active");
    expect(reread(s, human.candidate.id).qualityReasons).toContain("review_context_changed");
  });
});
