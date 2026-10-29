// Tests applyInvalidation(), applyPendingInvalidations() and listPendingInvalidations() in src/memory/invalidation.ts.
import { afterEach, describe, expect, it } from "vitest";

import {
  applyInvalidation,
  applyPendingInvalidations,
  INVALIDATED_REASON,
  listPendingInvalidations,
  POSSIBLY_OUTDATED_REASON
} from "../../src/memory/invalidation.js";
import { compensateMemoryReview, resolveMemoryReview } from "../../src/memory/review.js";
import { openMemoryStore, type MemoryStore } from "../../src/storage/store.js";
import type { EvidenceRef, MemoryCandidate } from "../../src/types.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const roots: string[] = [], stores: MemoryStore[] = [];

function store(): MemoryStore {
  const root = makeTempDir(); roots.push(root);
  const s = openMemoryStore(root); s.init(); stores.push(s); return s;
}

afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  roots.splice(0).forEach(cleanupTempDir);
});

function commit(s: MemoryStore, hash: string, authoredAt: string): EvidenceRef {
  s.addCommit({ hash, authorName: "T", authorEmail: "t@example.com", authoredAt, message: hash, changedFiles: [], diffSummary: hash });
  return { sourceType: "commit", sourceId: hash };
}

function candidate(s: MemoryStore, key: string, authoredAt: string, type: MemoryCandidate["type"] = "bug_fix"): MemoryCandidate {
  return s.upsertMemoryCandidate({
    type, title: `Fact ${key}`, summary: `Saved recovery codes behave as described in ${key}.`, reason: "From the session.",
    confidence: 0.9, evidence: [commit(s, `${key}-commit`, authoredAt)], relatedFiles: [], dedupeKey: key
  }, { qualityStatus: "active", qualityReasons: [] });
}

const OLD = "2026-10-01T00:00:00.000Z", NEW = "2026-10-05T00:00:00.000Z";
const request = (target: { category: "candidate" | "promoted"; id: string }, replacement: { category: "candidate" | "promoted"; id: string }, confidence: number) =>
  ({ target, replacement, confidence, why: "The fix landed.", source: "extraction" as const });

describe("applyInvalidation", () => {
  it("ignores low confidence and only flags middling confidence or older evidence", () => {
    const s = store();
    const old = candidate(s, "old", OLD), fresh = candidate(s, "fresh", NEW), stale = candidate(s, "stale", "2026-09-01T00:00:00.000Z");
    expect(applyInvalidation(s, request({ category: "candidate", id: old.id }, { category: "candidate", id: fresh.id }, 0.5)).outcome).toBe("ignored");
    expect(applyInvalidation(s, request({ category: "candidate", id: old.id }, { category: "candidate", id: fresh.id }, 0.8)).outcome).toBe("flagged");
    expect(s.readMemoryCandidate(old.id)!.qualityReasons).toContain(POSSIBLY_OUTDATED_REASON);
    expect(s.readMemoryCandidate(old.id)!.qualityStatus).toBe("needs_review");

    expect(applyInvalidation(s, request({ category: "candidate", id: fresh.id }, { category: "candidate", id: stale.id }, 0.95)).outcome).toBe("flagged");
    expect(s.readMemoryCandidate(fresh.id)!.promotionState).toBe("candidate");
  });

  it("discards an outdated candidate through a reversible system review", () => {
    const s = store();
    const old = candidate(s, "old", OLD), fresh = candidate(s, "fresh", NEW);
    const result = applyInvalidation(s, request({ category: "candidate", id: old.id }, { category: "candidate", id: fresh.id }, 0.95));
    expect(result.outcome).toBe("discarded");
    expect(s.readMemoryCandidate(old.id)!.qualityStatus).toBe("quarantined");

    compensateMemoryReview(s, { resolutionId: result.resolutionId!, reason: "Undo" });
    expect(s.readMemoryCandidate(old.id)!.qualityStatus).not.toBe("quarantined");
  });

  it("supersedes a durable memory when the replacement is durable too", () => {
    const s = store();
    const oldDurable = s.promoteMemoryCandidate(candidate(s, "old", OLD).id);
    const newDurable = s.promoteMemoryCandidate(candidate(s, "fresh", NEW, "decision").id);
    const result = applyInvalidation(s, request({ category: "promoted", id: oldDurable.id }, { category: "promoted", id: newDurable.id }, 0.95));
    expect(result.outcome).toBe("superseded");
    expect(s.readMemory(oldDurable.id)!.lifecycleStatus).toBe("superseded");
  });

  it("waits for a candidate replacement to be promoted before superseding", () => {
    const s = store();
    const oldDurable = s.promoteMemoryCandidate(candidate(s, "old", OLD).id);
    const fresh = candidate(s, "fresh", NEW, "decision");
    expect(applyInvalidation(s, request({ category: "promoted", id: oldDurable.id }, { category: "candidate", id: fresh.id }, 0.95)).outcome).toBe("pending");
    expect(s.readMemory(oldDurable.id)!.lifecycleStatus).toBe("current");
    expect(s.readMemory(oldDurable.id)!.qualityReasons).toContain(INVALIDATED_REASON);
    expect(applyPendingInvalidations(s)).toMatchObject({ superseded: 0, pending: 1 });

    s.promoteMemoryCandidate(fresh.id);
    expect(applyPendingInvalidations(s)).toMatchObject({ superseded: 1, pending: 0 });
    expect(s.readMemory(oldDurable.id)!.lifecycleStatus).toBe("superseded");
    expect(listPendingInvalidations(s)).toHaveLength(0);
    expect(listPendingInvalidations(s, { includeResolved: true })[0]!.outcome).toBe("superseded");
  });

  it("drops a pending request and its flag when the replacement is discarded", () => {
    const s = store();
    const oldDurable = s.promoteMemoryCandidate(candidate(s, "old", OLD).id);
    const fresh = candidate(s, "fresh", NEW, "decision");
    applyInvalidation(s, request({ category: "promoted", id: oldDurable.id }, { category: "candidate", id: fresh.id }, 0.95));
    resolveMemoryReview(s, { memoryId: fresh.id, category: "candidate", action: "discard", reason: "Wrong." }, "desktop");

    expect(applyPendingInvalidations(s)).toMatchObject({ dropped: 1, pending: 0 });
    expect(s.readMemory(oldDurable.id)!.qualityReasons).not.toContain(INVALIDATED_REASON);
    expect(s.readMemory(oldDurable.id)!.lifecycleStatus).toBe("current");
  });
});
