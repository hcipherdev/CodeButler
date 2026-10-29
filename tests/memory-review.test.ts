import { afterEach, describe, expect, it } from "vitest";

import { auditMemoryQuality } from "../src/memory/quality.js";
import { resolveMemoryReview, StaleMemoryReviewError } from "../src/memory/review.js";
import { createMemoryReviewContext } from "../src/memory/review-state.js";
import { openMemoryStore } from "../src/storage/store.js";
import type { ExtractedMemory, MemoryCandidate } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("memory review resolution", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  function createStore() {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addCommit({
      hash: "review-base",
      authorName: "Reviewer",
      authorEmail: "review@example.com",
      authoredAt: "2026-08-01T10:00:00Z",
      message: "Establish review behavior",
      changedFiles: ["src/review.ts"],
      diffSummary: "+ review behavior"
    });
    return { rootDir, store };
  }

  function candidate(store: ReturnType<typeof openMemoryStore>, overrides: Partial<ExtractedMemory> = {}): MemoryCandidate {
    return store.upsertMemoryCandidate({
      scope: { kind: "conditional", platforms: ["win32"] },
      layer: "branch:review",
      type: "constraint",
      title: "Review project memory",
      summary: "Review project memory before relying on uncertain extraction.",
      reason: "Human judgment resolves soft extraction warnings.",
      confidence: 0.55,
      evidence: [{ sourceType: "commit", sourceId: "review-base", locator: "src/review.ts" }],
      relatedFiles: ["src/review.ts"],
      dedupeKey: "review-candidate",
      ...overrides
    }, {
      qualityStatus: "needs_review",
      qualityReasons: ["low_confidence"],
      lastVerifiedAt: "2026-08-01T10:00:00.000Z"
    });
  }

  function result(store: ReturnType<typeof openMemoryStore>, id: string) {
    const found = store.readMemorySearchResultsByIds([id], {
      includeCandidates: true,
      lifecycleStatus: "all"
    })[0];
    if (!found) throw new Error(`Missing test memory ${id}`);
    return found;
  }

  it("preserves existing verification fingerprints without accepting them as new submission tokens", () => {
    const { store } = createStore();
    try {
      const original = candidate(store);
      const context = createMemoryReviewContext(store, "candidate", original);
      resolveMemoryReview(store, { memoryId: original.id, category: "candidate", action: "verify", reason: "Confirmed by reviewer", reviewToken: context.reviewToken }, "desktop");
      store.db.prepare("update memory_review_resolutions set context_fingerprint=? where memory_id=?").run(context.acceptedTokens.at(-1)!, original.id);
      expect(result(store, original.id).trust?.displayStatus).toBe("human_verified");
      expect(() => resolveMemoryReview(store, { memoryId: original.id, category: "candidate", action: "discard", reason: "Old client submission", reviewToken: context.acceptedTokens.at(-1)! }, "desktop")).toThrow(StaleMemoryReviewError);
    } finally { store.close(); }
  });

  it("persists verification without changing confidence or promotion and reopens on relevant evidence", () => {
    const { rootDir, store } = createStore();
    const original = candidate(store);
    const before = result(store, original.id);

    const resolved = resolveMemoryReview(store, {
      memoryId: original.id,
      category: "candidate",
      action: "verify",
      reviewToken: before.reviewToken,
      now: "2026-08-02T10:00:00.000Z"
    }, "desktop");

    expect(resolved.memory).toMatchObject({
      id: original.id,
      confidence: 0.55,
      promotionState: "candidate",
      qualityStatus: "active",
      qualityReasons: []
    });
    expect(auditMemoryQuality(store, { fix: true, now: "2026-08-02T10:01:00.000Z" })).toMatchObject({ updated: 0 });
    expect(result(store, original.id)).toMatchObject({
      reviewToken: before.reviewToken,
      review: { action: "verify", actor: "desktop", current: true },
      confidenceBasis: "unknown",
      trust: { displayStatus: "human_verified" }
    });
    store.close();

    const reopened = openMemoryStore(rootDir);
    reopened.init();
    expect(result(reopened, original.id).trust?.displayStatus).toBe("human_verified");
    reopened.addCommit({
      hash: "review-new-evidence",
      authorName: "Reviewer",
      authorEmail: "review@example.com",
      authoredAt: "2026-08-03T10:00:00Z",
      message: "Change review behavior",
      changedFiles: ["src/review.ts"],
      diffSummary: "+ changed review behavior"
    });
    expect(result(reopened, original.id)).toMatchObject({
      qualityStatus: "needs_review",
      review: { action: "verify", current: false },
      trust: { displayStatus: "needs_review" }
    });
    expect(auditMemoryQuality(reopened, { fix: true, now: "2026-08-03T11:00:00.000Z" })).toMatchObject({ updated: 0 });
    expect(result(reopened, original.id)).toMatchObject({
      qualityStatus: "needs_review",
      qualityReasons: expect.arrayContaining(["low_confidence", "review_context_changed", "stale_related_file_evidence"]),
      review: { action: "verify", current: false },
      trust: { displayStatus: "needs_review" }
    });
    expect(result(reopened, original.id).reviewToken).not.toBe(before.reviewToken);
    reopened.close();
  });

  it("rejects stale tokens and hard failures without partial writes", () => {
    const { store } = createStore();
    const soft = candidate(store);
    const staleToken = result(store, soft.id).reviewToken!;
    store.addCommit({
      hash: "review-stale",
      authorName: "Reviewer",
      authorEmail: "review@example.com",
      authoredAt: "2026-08-02T10:00:00Z",
      message: "Invalidate review token",
      changedFiles: ["src/review.ts"],
      diffSummary: "+ token invalidation"
    });
    expect(() => resolveMemoryReview(store, {
      memoryId: soft.id,
      category: "candidate",
      action: "verify",
      reviewToken: staleToken,
      now: "2026-08-02T11:00:00.000Z"
    })).toThrow(StaleMemoryReviewError);

    const hard = candidate(store, {
      title: "Missing evidence",
      summary: "This claim has no evidence and cannot be verified.",
      evidence: [],
      relatedFiles: [],
      dedupeKey: "review-hard-failure"
    });
    store.updateMemoryQuality("candidate", hard.id, {
      qualityStatus: "quarantined",
      qualityReasons: ["missing_evidence"]
    });
    expect(() => resolveMemoryReview(store, {
      memoryId: hard.id,
      category: "candidate",
      action: "verify",
      reviewToken: result(store, hard.id).reviewToken,
      now: "2026-08-02T11:00:00.000Z"
    })).toThrow("must be corrected or discarded");
    expect(store.db.prepare("select count(*) as count from memory_review_resolutions").get()).toEqual({ count: 0 });
    expect(store.listOperations({ operationType: "memory_review" })).toEqual([]);
    store.close();
  });

  it("rolls back a correction when any lifecycle write fails", () => {
    const { store } = createStore();
    const original = candidate(store, { dedupeKey: "review-rollback-candidate" });
    const beforeCount = store.listMemoryCandidates({ qualityStatus: "all", limit: null }).length;
    store.db.exec(
      `create trigger fail_review_resolution
       before insert on memory_review_resolutions
       begin
         select raise(abort, 'forced review rollback');
       end`
    );

    expect(() => resolveMemoryReview(store, {
      memoryId: original.id,
      category: "candidate",
      action: "correct",
      reason: "The extracted wording needs correction.",
      reviewToken: result(store, original.id).reviewToken,
      correction: {
        title: "Corrected review guidance",
        text: "Use corrected human-authored guidance for this project memory.",
        reason: "The original extraction was ambiguous."
      },
      now: "2026-08-02T11:30:00.000Z"
    })).toThrow("forced review rollback");

    expect(store.listMemoryCandidates({ qualityStatus: "all", limit: null })).toHaveLength(beforeCount);
    expect(store.db.prepare("select count(*) as count from memory_review_resolutions").get()).toEqual({ count: 0 });
    expect(store.listOperations({ operationType: "memory_review" })).toEqual([]);
    expect(result(store, original.id)).toMatchObject({ qualityStatus: "needs_review" });
    store.close();
  });

  it("corrects candidates idempotently while preserving scope and layer", () => {
    const { store } = createStore();
    const original = candidate(store);
    const reviewToken = result(store, original.id).reviewToken!;
    const input = {
      memoryId: original.id,
      category: "candidate" as const,
      action: "correct" as const,
      reason: "The automated wording was ambiguous.",
      reviewToken,
      correction: {
        title: "Review uncertain extraction",
        text: "Review uncertain extraction before using it as project guidance.",
        reason: "Human-authored wording makes the constraint explicit."
      },
      now: "2026-08-02T12:00:00.000Z"
    };
    const first = resolveMemoryReview(store, input, "desktop");
    const replay = resolveMemoryReview(store, { ...input, now: "2026-08-02T13:00:00.000Z" }, "desktop");

    expect(first.replacement).toMatchObject({
      promotionState: "candidate",
      qualityStatus: "active",
      layer: original.layer,
      scope: original.scope,
      origin: { method: "manual", channel: "desktop" }
    });
    expect(replay.replacement?.id).toBe(first.replacement?.id);
    expect(store.listMemoryCandidates({ qualityStatus: "all", limit: null }).find(item => item.id === original.id)).toMatchObject({
      qualityStatus: "quarantined",
      qualityReasons: expect.arrayContaining(["manual_review_corrected"])
    });
    expect(auditMemoryQuality(store, { fix: true, now: "2026-08-02T13:01:00.000Z" })).toMatchObject({ updated: 0 });
    expect(store.db.prepare("select count(*) as count from memory_review_resolutions").get()).toEqual({ count: 1 });
    expect(store.listOperations({ operationType: "memory_review" })).toHaveLength(1);
    store.close();
  });

  it("corrects and discards promoted memories without deleting history", () => {
    const { store } = createStore();
    const promotedCandidate = candidate(store, { layer: "core", dedupeKey: "review-promoted" });
    const promoted = store.promoteMemoryCandidate(promotedCandidate.id);
    const correctionInput = {
      memoryId: promoted.id,
      category: "promoted" as const,
      action: "correct" as const,
      reason: "The project constraint changed.",
      reviewToken: result(store, promoted.id).reviewToken,
      correction: {
        text: "Use the revised review workflow for every uncertain memory.",
        title: "Use the revised review workflow",
        reason: "The human correction supersedes the extracted wording."
      },
      now: "2026-08-02T14:00:00.000Z"
    };
    const corrected = resolveMemoryReview(store, correctionInput, "cli");
    const correctionReplay = resolveMemoryReview(store, { ...correctionInput, now: "2026-08-02T14:01:00.000Z" }, "cli");
    expect(correctionReplay.replacement?.id).toBe(corrected.replacement?.id);
    expect(store.readMemory(promoted.id)).toMatchObject({ lifecycleStatus: "superseded" });
    expect(corrected.replacement).toMatchObject({ lifecycleStatus: "current", source: "manual", layer: "core" });
    expect(store.listMemoryRelations({ relationType: "supersedes" })).toEqual([
      expect.objectContaining({ fromMemoryId: corrected.replacement?.id, toMemoryId: promoted.id })
    ]);

    const replacement = corrected.replacement!;
    const discarded = resolveMemoryReview(store, {
      memoryId: replacement.id,
      category: "promoted",
      action: "discard",
      reason: "The replacement is no longer applicable.",
      reviewToken: result(store, replacement.id).reviewToken,
      now: "2026-08-02T15:00:00.000Z"
    }, "mcp");
    expect(discarded.memory).toMatchObject({ lifecycleStatus: "retracted" });
    expect(store.readMemory(promoted.id)).toBeDefined();
    expect(store.readMemory(replacement.id)).toBeDefined();
    expect(store.db.prepare("select count(*) as count from memory_review_resolutions").get()).toEqual({ count: 2 });
    store.close();
  });

  it("quarantines discarded candidates and does not let Verify undo the discard", () => {
    const { store } = createStore();
    const original = candidate(store, { dedupeKey: "review-discard-candidate" });
    const reviewToken = result(store, original.id).reviewToken!;
    resolveMemoryReview(store, {
      memoryId: original.id,
      category: "candidate",
      action: "discard",
      reason: "This extraction is not a durable project fact.",
      reviewToken,
      now: "2026-08-02T15:30:00.000Z"
    });
    expect(result(store, original.id)).toMatchObject({
      qualityStatus: "quarantined",
      qualityReasons: expect.arrayContaining(["manual_review_discarded"]),
      review: { action: "discard", current: true },
      trust: { displayStatus: "quarantined" }
    });
    expect(auditMemoryQuality(store, { fix: true, now: "2026-08-02T15:30:30.000Z" })).toMatchObject({ updated: 0 });
    expect(() => resolveMemoryReview(store, {
      memoryId: original.id,
      category: "candidate",
      action: "verify",
      reviewToken,
      now: "2026-08-02T15:31:00.000Z"
    })).toThrow("Only legacy low-signal quarantine can be verified");
    expect(store.db.prepare("select count(*) as count from memory_review_resolutions").get()).toEqual({ count: 1 });
    const edited = store.upsertMemoryCandidate({
      scope: original.scope!,
      layer: original.layer!,
      type: original.type,
      title: `${original.title} edited`,
      summary: `${original.summary} The source was edited later.`,
      reason: original.reason,
      confidence: original.confidence,
      evidence: original.evidence,
      relatedFiles: original.relatedFiles,
      dedupeKey: original.dedupeKey
    });
    expect(edited.id).toBe(original.id);
    expect(store.searchMemoryLayer({ status: "candidate", qualityStatus: "all", limit: 100 }))
      .not.toContainEqual(expect.objectContaining({ id: original.id }));
    expect(store.getProjectSummary().memoryHealth).toMatchObject({
      active: 0,
      needsReview: 0,
      quarantined: 0,
      retired: 1,
      replaced: 0
    });
    store.close();
  });

  it("allows legacy low-signal memories to be manually verified", () => {
    const { store } = createStore();
    const legacy = candidate(store, {
      title: "Config defines timeout",
      summary: "package.json defines timeout.",
      reason: "Legacy deterministic config extraction.",
      confidence: 0.65,
      relatedFiles: ["package.json"],
      dedupeKey: "deterministic:config:package.json:timeout"
    });
    store.updateMemoryQuality("candidate", legacy.id, {
      qualityStatus: "quarantined",
      qualityReasons: ["legacy_low_signal_heuristic"]
    });
    resolveMemoryReview(store, {
      memoryId: legacy.id,
      category: "candidate",
      action: "verify",
      reviewToken: result(store, legacy.id).reviewToken,
      now: "2026-08-02T16:00:00.000Z"
    });
    expect(auditMemoryQuality(store, { fix: true, now: "2026-08-02T16:01:00.000Z" })).toMatchObject({ updated: 0 });
    expect(result(store, legacy.id)).toMatchObject({
      qualityStatus: "active",
      confidenceBasis: "legacy_config_key",
      trust: { displayStatus: "human_verified" }
    });
    store.close();
  });
});
