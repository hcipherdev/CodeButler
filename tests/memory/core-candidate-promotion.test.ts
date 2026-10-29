// Tests planAutomaticPromotions(), runAutomaticPromotions() and undoAutomaticPromotions() in src/memory/automatic-promotion.ts for core-layer candidates, including AI-corrected replacements, plus active-candidate verification in src/memory/review.ts.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { mergeCore } from "../../src/cloud/merge.js";
import {
  collapseCoreCandidateSkips,
  planAutomaticPromotions,
  runAutomaticPromotions,
  undoAutomaticPromotions
} from "../../src/memory/automatic-promotion.js";
import { rememberProjectMemory } from "../../src/memory/remember.js";
import { compensateMemoryReview, resolveMemoryReview } from "../../src/memory/review.js";
import { exportPrivacy, importPrivacy } from "../../src/privacy/service.js";
import { openMemoryStore, type MemoryStore } from "../../src/storage/store.js";
import { withTransaction } from "../../src/storage/transactions.js";
import type { MemoryCandidate, ProjectConfig } from "../../src/types.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const DEVICE = "4b8e2f1a-6c3d-4e5f-9a0b-1c2d3e4f5a6b";
const roots: string[] = [], stores: MemoryStore[] = [];

function store(): MemoryStore {
  const root = makeTempDir(); roots.push(root);
  const s = openMemoryStore(root, { deviceLayer: () => `device:${DEVICE}` });
  s.init(); stores.push(s); return s;
}

function clone(source: MemoryStore): MemoryStore {
  const target = store(), outputPath = join(source.paths.rootDir, `copy-${randomUUID()}.json`);
  exportPrivacy(source, { outputPath });
  importPrivacy(target, { inputPath: outputPath });
  return target;
}

function config(overrides: Partial<ProjectConfig["promotion"]["automatic"]> = {}): ProjectConfig {
  return {
    promotion: {
      confidenceThreshold: 0.85,
      requireCommitAndConversation: true,
      minSourceCategories: 2,
      automatic: {
        enabled: true, mode: "conservative", minScore: 0.85, mergedBranches: true, deviceMemories: true,
        coreCandidates: true, singleSourceMinConfidence: 0.9, ...overrides
      }
    },
    sources: { git: { repoPath: "" } }
  } as unknown as ProjectConfig;
}

interface CandidateOptions {
  confidence?: number;
  sources?: number;
  quality?: "active" | "needs_review" | "quarantined";
  title?: string;
  summary?: string;
  layer?: string;
  scope?: { kind: "project" };
}

/** A core candidate whose evidence commits exist, so a human verify is not blocked. */
function candidate(s: MemoryStore, key: string, options: CandidateOptions = {}): MemoryCandidate {
  const evidence = Array.from({ length: options.sources ?? 1 }, (_, index) => {
    const hash = `${key}-evidence-${index}`;
    s.addCommit({
      hash, authorName: "Test User", authorEmail: "test@example.com", authoredAt: "2026-10-01T00:00:00.000Z",
      message: `Record ${key}`, changedFiles: [], diffSummary: `Record the ${key} decision.`
    });
    return { sourceType: "commit" as const, sourceId: hash };
  });
  const quality = options.quality ?? "active";
  return s.upsertMemoryCandidate({
    layer: options.layer ?? "core",
    type: "decision",
    title: options.title ?? `Decision ${key}`,
    summary: options.summary ?? `The sync pipeline uses the ${key} approach for uploads.`,
    reason: "Recorded while building the sync pipeline.",
    confidence: options.confidence ?? 0.95,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    evidence,
    relatedFiles: [],
    dedupeKey: key
  }, {
    qualityStatus: quality,
    qualityReasons: quality === "active" ? [] : quality === "needs_review" ? ["stale_related_file_evidence"] : ["suspect"]
  });
}

function aiVerify(s: MemoryStore, memoryId: string): void {
  resolveMemoryReview(s, {
    memoryId, category: "candidate", action: "verify", reason: "AI review judged it current.",
    provenance: { verdict: "current", policyVersion: "test", confidence: 0.95, citationIds: [], reconciliationRunId: "run", reconciliationItemId: "item" }
  }, "ai");
}

function decisionFor(s: MemoryStore, memoryId: string, overrides: Partial<ProjectConfig["promotion"]["automatic"]> = {}) {
  return planAutomaticPromotions(s, config(overrides)).decisions.find(d => d.memoryId === memoryId);
}

function candidateRow(s: MemoryStore, id: string): MemoryCandidate {
  return s.listMemoryCandidates({ qualityStatus: "all", limit: null }).find(c => c.id === id)!;
}

afterEach(() => {
  stores.splice(0).forEach(s => s.close());
  roots.splice(0).forEach(cleanupTempDir);
});

describe("core candidate promotion", () => {
  it("promotes a candidate a person verified, even at low model confidence", () => {
    const s = store();
    const c = candidate(s, "human-verified", { confidence: 0.7 });
    resolveMemoryReview(s, { memoryId: c.id, category: "candidate", action: "verify" }, "desktop");

    const decision = decisionFor(s, c.id)!;
    expect(decision.decision).toBe("promote");
    expect(decision.reasonCodes).toEqual(expect.arrayContaining(["core_candidate", "human_verified"]));

    expect(runAutomaticPromotions(s, config()).promoted).toBe(1);
    const stored = candidateRow(s, c.id);
    expect(stored.promotionState).toBe("promoted");
    expect(s.readMemory(stored.promotedMemoryId!)).toMatchObject({ layer: "core", lifecycleStatus: "current" });
  });

  it("applies the single-source bar to AI verification", () => {
    const s = store();
    const below = candidate(s, "ai-below", { confidence: 0.88 });
    const at = candidate(s, "ai-at", { confidence: 0.9 });
    aiVerify(s, below.id); aiVerify(s, at.id);

    expect(decisionFor(s, below.id)).toMatchObject({ decision: "skip" });
    expect(decisionFor(s, below.id)!.reasonCodes).toContain("below_single_source_confidence");
    expect(decisionFor(s, at.id)).toMatchObject({ decision: "promote" });
    expect(decisionFor(s, at.id)!.reasonCodes).toContain("ai_verified_current");
    expect(decisionFor(s, below.id, { singleSourceMinConfidence: 0.85 })).toMatchObject({ decision: "promote" });
  });

  it("promotes the replacement an AI correction wrote, on that correction's verdict", () => {
    const s = store();
    const correct = (key: string, confidence: number) => resolveMemoryReview(s, {
      memoryId: candidate(s, key, { summary: "Documentation includes Setup." }).id, category: "candidate", action: "correct", reason: "Rewrite the placeholder.",
      correction: { text: `The ${key} guide documents the two-tier configuration model.` },
      provenance: { verdict: "changed", policyVersion: "test", confidence, citationIds: [], reconciliationRunId: "run", reconciliationItemId: key }
    }, "ai");
    const at = correct("rewritten", 0.95).replacement!;
    const below = correct("rewritten-low", 0.85).replacement!;
    expect(at.dedupeKey.startsWith("ai-reconciliation:")).toBe(true);

    expect(decisionFor(s, at.id)).toMatchObject({ decision: "promote" });
    expect(decisionFor(s, at.id)!.reasonCodes).toEqual(expect.arrayContaining(["ai_corrected_replacement", "meets_single_source_confidence"]));
    expect(decisionFor(s, below.id)!.reasonCodes).toEqual(expect.arrayContaining(["ai_corrected_replacement", "below_single_source_confidence"]));
  });

  it("does not promote an AI rewrite of a legacy docs-heading record", () => {
    const s = store();
    const legacy = candidate(s, "deterministic:docs:README.md:setup", { summary: "Documentation includes Setup." });
    const replacement = resolveMemoryReview(s, {
      memoryId: legacy.id, category: "candidate", action: "correct", reason: "Rewrite the placeholder.",
      correction: { text: "The README has a Setup section describing installation." },
      provenance: { verdict: "changed", policyVersion: "test", confidence: 0.95, citationIds: [], reconciliationRunId: "run", reconciliationItemId: "legacy" }
    }, "ai").replacement!;
    expect(decisionFor(s, replacement.id)?.reasonCodes ?? []).not.toContain("ai_corrected_replacement");
  });

  it("does not count an AI review's verification of a replacement whose correction was reverted", () => {
    const s = store();
    const original = candidate(s, "rewritten", { summary: "Documentation includes Setup." });
    const correction = resolveMemoryReview(s, {
      memoryId: original.id, category: "candidate", action: "correct", reason: "Rewrite the placeholder.",
      correction: { text: "The setup guide documents the two-tier configuration model." },
      provenance: { verdict: "changed", policyVersion: "test", confidence: 0.95, citationIds: [], reconciliationRunId: "run", reconciliationItemId: "item" }
    }, "ai");
    const replacement = correction.replacement!;
    compensateMemoryReview(s, { resolutionId: correction.review.id, reason: "Correction was wrong." });
    aiVerify(s, replacement.id);

    expect(decisionFor(s, replacement.id)?.reasonCodes ?? []).not.toContain("ai_corrected_replacement");
  });

  it("applies the standard bar to independent sources", () => {
    const s = store();
    const below = candidate(s, "two-below", { sources: 2, confidence: 0.84 });
    const at = candidate(s, "two-at", { sources: 2, confidence: 0.85 });

    expect(decisionFor(s, below.id)!.reasonCodes).toEqual(expect.arrayContaining(["independent_sources", "below_confidence_threshold"]));
    expect(decisionFor(s, at.id)).toMatchObject({ decision: "promote" });
    expect(decisionFor(s, at.id)!.reasonCodes).toContain("independent_sources");
  });

  it("skips uncorroborated, stale, flagged and discarded candidates", () => {
    const s = store();
    const lone = candidate(s, "lone");
    const stale = candidate(s, "stale");
    resolveMemoryReview(s, { memoryId: stale.id, category: "candidate", action: "verify" }, "desktop");
    s.db.prepare("update memory_candidates set updated_at = ? where id = ?").run("2026-10-09T12:00:00.000Z", stale.id);
    const flagged = candidate(s, "flagged", { sources: 2, quality: "needs_review" });
    const quarantined = candidate(s, "quarantined", { sources: 2, quality: "quarantined" });
    const discarded = candidate(s, "discarded", { sources: 2 });
    resolveMemoryReview(s, { memoryId: discarded.id, category: "candidate", action: "discard", reason: "Not true." }, "desktop");

    expect(decisionFor(s, lone.id)!.reasonCodes).toContain("no_corroboration");
    // A verification whose context changed flags the memory for review instead of corroborating it.
    expect(decisionFor(s, stale.id)!.reasonCodes).toContain("quality_needs_review");
    expect(candidateRow(s, stale.id).qualityReasons).toContain("review_context_changed");
    expect(decisionFor(s, flagged.id)!.reasonCodes).toContain("quality_needs_review");
    expect(decisionFor(s, quarantined.id)!.reasonCodes).toContain("quality_quarantined");
    expect(decisionFor(s, discarded.id)!.decision).toBe("skip");
    expect(runAutomaticPromotions(s, config()).promoted).toBe(0);
  });

  it("keeps verification by agents out of corroboration and out of active memories", () => {
    const s = store();
    const c = candidate(s, "agent");
    expect(() => resolveMemoryReview(s, { memoryId: c.id, category: "candidate", action: "verify" }, "mcp"))
      .toThrow("Only memories that need review can be verified");
    const durable = rememberProjectMemory(s, { type: "decision", text: "Durable memories keep the old verify rule." }).memory!;
    expect(() => resolveMemoryReview(s, { memoryId: durable.id, category: "promoted", action: "verify" }, "desktop"))
      .toThrow("Only memories that need review can be verified");
    expect(decisionFor(s, c.id)!.reasonCodes).toContain("no_corroboration");
  });

  it("converges on an equivalent core fact and defers a contradicting one", () => {
    const s = store();
    const existing = rememberProjectMemory(s, {
      type: "decision", title: "Cache tokens in Redis", text: "The auth middleware caches tokens in Redis.", scope: { kind: "project" }
    }).memory!;
    rememberProjectMemory(s, {
      type: "decision", title: "Session storage", text: "Sessions are stored in Postgres, not Redis.", scope: { kind: "project" }
    });
    const same = candidate(s, "same-fact", { sources: 2, title: "Cache tokens in Redis", summary: "The auth middleware caches tokens in Redis.", scope: { kind: "project" } });
    const contradicting = candidate(s, "contradicting", { sources: 2, title: "Session storage", summary: "Sessions are stored in Redis.", scope: { kind: "project" } });

    expect(decisionFor(s, same.id)).toMatchObject({ decision: "converge", coreMemoryId: existing.id });
    expect(decisionFor(s, contradicting.id)).toMatchObject({ decision: "defer" });
  });

  it("evaluates every item rather than a capped top list", () => {
    const s = store();
    // Device memories go through the layer score; it used to be read from a top-100 list.
    const ids = Array.from({ length: 120 }, (_, index) =>
      candidate(s, `device-${index}`, { sources: 2, layer: `device:${DEVICE}`, scope: { kind: "project" } }).id);
    const plan = planAutomaticPromotions(s, config({ coreCandidates: false }));
    const promoted = plan.decisions.filter(d => d.decision === "promote").map(d => d.memoryId);
    expect(promoted.sort()).toEqual([...ids].sort());
  });

  it("collapses core-candidate skips into counts for reports", () => {
    const s = store();
    candidate(s, "quiet-1"); candidate(s, "quiet-2");
    const promotable = candidate(s, "loud", { sources: 2 });
    const report = collapseCoreCandidateSkips(planAutomaticPromotions(s, config()));
    expect(report.decisions.map(d => d.memoryId)).toEqual([promotable.id]);
    expect(report.coreCandidateSkips).toEqual({ total: 2, byReason: { no_corroboration: 2 } });
  });

  it("is switched off by coreCandidates: false", () => {
    const s = store();
    const c = candidate(s, "switched-off", { sources: 2 });
    expect(decisionFor(s, c.id, { coreCandidates: false })).toBeUndefined();
  });

  it("does not record skips, and a second run writes nothing", () => {
    const s = store();
    candidate(s, "unverified");
    candidate(s, "corroborated", { sources: 2 });
    const counts = () => ({
      decisions: s.db.prepare("select count(*) as count from promotion_decisions").get(),
      operations: s.db.prepare("select count(*) as count from operation_log").get(),
      memories: s.db.prepare("select count(*) as count from memories").get()
    });
    expect(runAutomaticPromotions(s, config()).promoted).toBe(1);
    expect(s.db.prepare("select decision from promotion_decisions").all()).toEqual([{ decision: "promote" }]);
    const before = counts();
    expect(runAutomaticPromotions(s, config())).toMatchObject({ promoted: 0, converged: 0, deferred: 0, skipped: 0 });
    expect(counts()).toEqual(before);
  });

  it("undoes a promotion, keeps it undone, and restores the same row after a new verify", () => {
    const s = store();
    const c = candidate(s, "undo-me", { sources: 2 });
    const start = new Date(Date.now() - 60_000).toISOString();
    runAutomaticPromotions(s, config());
    const durableId = candidateRow(s, c.id).promotedMemoryId!;

    const undo = undoAutomaticPromotions(s, { since: start });
    expect(undo).toMatchObject({ undone: 1, skipped: 0 });
    expect(candidateRow(s, c.id).promotionState).toBe("candidate");
    expect(s.readMemory(durableId)).toMatchObject({ lifecycleStatus: "retracted" });
    expect(undoAutomaticPromotions(s, { since: start }).items[0]!.outcome).toBe("already_undone");

    // Two sources still corroborate it, but an undone promotion waits for a person.
    expect(decisionFor(s, c.id)!.reasonCodes).toContain("previously_withdrawn");
    expect(runAutomaticPromotions(s, config()).promoted).toBe(0);

    resolveMemoryReview(s, {
      memoryId: c.id, category: "candidate", action: "verify", now: new Date(Date.now() + 60_000).toISOString()
    }, "desktop");
    expect(runAutomaticPromotions(s, config()).promoted).toBe(1);
    expect(candidateRow(s, c.id).promotedMemoryId).toBe(durableId);
    expect(s.readMemory(durableId)).toMatchObject({ lifecycleStatus: "current" });
  });

  it("converges two devices' promotions of one candidate and carries an undo across a merge", () => {
    const local = store();
    const c = candidate(local, "shared-fact", { sources: 2 });
    const ancestor = clone(local), remote = clone(local);
    for (const s of [local, remote]) {
      s.updateMemoryQuality("candidate", c.id, { qualityStatus: "active", qualityReasons: [], lastVerifiedAt: new Date().toISOString() });
      expect(runAutomaticPromotions(s, config()).promoted).toBe(1);
    }

    withTransaction(local.db, () => mergeCore(local.db, remote.db, ancestor.db));
    const current = local.listMemories({ layer: "core", lifecycleStatus: "current", qualityStatus: "all", limit: null })
      .filter(m => m.dedupeKey === "shared-fact");
    expect(current).toHaveLength(1);
    expect(candidateRow(local, c.id).promotedMemoryId).toBe(current[0]!.id);

    const base = clone(local), peer = clone(local);
    expect(undoAutomaticPromotions(local, { memoryId: c.id }).undone).toBe(1);
    withTransaction(peer.db, () => mergeCore(peer.db, local.db, base.db));
    peer.updateMemoryQuality("candidate", c.id, { qualityStatus: "active", qualityReasons: [], lastVerifiedAt: new Date().toISOString() });
    expect(candidateRow(peer, c.id).promotionState).toBe("candidate");
    expect(peer.readMemory(current[0]!.id)).toMatchObject({ lifecycleStatus: "retracted" });
    expect(decisionFor(peer, c.id)!.reasonCodes).toContain("previously_withdrawn");
  });
});
