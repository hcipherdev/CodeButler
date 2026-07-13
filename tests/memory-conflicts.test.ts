import { afterEach, describe, expect, it } from "vitest";

import { auditMemoryConflicts } from "../src/memory/conflicts.js";
import { auditMemoryQuality } from "../src/memory/quality.js";
import { openMemoryStore } from "../src/storage/store.js";
import type { EvidenceRef } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("durable memory conflict audit", () => {
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
    return store;
  }

  function promote(
    store: ReturnType<typeof createStore>,
    input: {
      suffix: string;
      title?: string;
      summary: string;
      evidence?: EvidenceRef[];
      confidence?: number;
    }
  ) {
    const sourceId = `conflict-source-${input.suffix}`;
    if (input.evidence === undefined) {
      store.addSourceWithChunks({
        source: {
          id: sourceId,
          type: "conversation",
          title: `${input.suffix}.md`,
          origin: "test",
          rawContent: input.summary
        },
        chunks: [{ text: input.summary }]
      });
    }
    const candidate = store.upsertMemoryCandidate({
      type: "constraint",
      title: input.title ?? "Canonical deployment policy",
      summary: input.summary,
      reason: "Conflict audit test",
      confidence: input.confidence ?? 0.95,
      evidence: input.evidence ?? [
        { sourceType: "conversation", sourceId, locator: `${sourceId}:chunk:0` }
      ],
      relatedFiles: [],
      dedupeKey: `conflict-${input.suffix}`
    }, { qualityStatus: "active", qualityReasons: [] });
    return { candidate, memory: store.promoteMemoryCandidate(candidate.id) };
  }

  it("reports canonical conflict pairs in dry-run without mutating relations or quality", () => {
    const store = createStore();
    const first = promote(store, { suffix: "dry-first", summary: "Deploy through the blue queue." }).memory;
    const second = promote(store, { suffix: "dry-second", summary: "Deploy through the green queue." }).memory;

    const result = auditMemoryConflicts(store, { now: "2026-07-12T21:00:00.000Z" });

    expect(result).toMatchObject({ scannedGroups: 1, scannedMemories: 2, complete: true });
    expect(result.conflictPairs).toEqual([{
      fromMemoryId: [first.id, second.id].sort()[0],
      toMemoryId: [first.id, second.id].sort()[1]
    }]);
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "add_relation" }),
      expect.objectContaining({ kind: "update_quality", memoryId: first.id, nextStatus: "needs_review" }),
      expect.objectContaining({ kind: "update_quality", memoryId: second.id, nextStatus: "needs_review" })
    ]));
    expect(store.listMemoryRelations({ relationType: "potentially_contradicts" })).toEqual([]);
    expect(store.readMemory(first.id)).toMatchObject({ qualityStatus: "active", qualityReasons: [] });
    expect(store.readMemory(second.id)).toMatchObject({ qualityStatus: "active", qualityReasons: [] });
    store.close();
  });

  it("fixes conflicts without lifecycle changes and is idempotent", () => {
    const store = createStore();
    const first = promote(store, { suffix: "fix-first", summary: "Deploy through the blue queue." }).memory;
    const second = promote(store, { suffix: "fix-second", summary: "Deploy through the green queue." }).memory;

    const fixed = auditMemoryConflicts(store, { fix: true, now: "2026-07-12T21:01:00.000Z" });
    const repeated = auditMemoryConflicts(store, { fix: true, now: "2026-07-12T21:02:00.000Z" });

    expect(fixed.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "add_relation" }),
      expect.objectContaining({ kind: "update_quality", memoryId: first.id }),
      expect.objectContaining({ kind: "update_quality", memoryId: second.id })
    ]));
    expect(store.listMemoryRelations({ relationType: "potentially_contradicts" })).toHaveLength(1);
    for (const id of [first.id, second.id]) {
      expect(store.readMemory(id)).toMatchObject({
        lifecycleStatus: "current",
        qualityStatus: "needs_review",
        qualityReasons: ["potential_conflict"]
      });
    }
    expect(repeated.changes).toEqual([]);
    store.close();
  });

  it("preserves unrelated curator reasons when adding and removing potential conflict", () => {
    const store = createStore();
    const first = promote(store, { suffix: "curator-first", summary: "Deploy through the blue queue." }).memory;
    const second = promote(store, { suffix: "curator-second", summary: "Deploy through the green queue." });
    store.updateMemoryQuality("promoted", first.id, {
      qualityStatus: "needs_review",
      qualityReasons: ["curator_note"]
    });
    store.updateMemoryQuality("promoted", second.memory.id, {
      qualityStatus: "needs_review",
      qualityReasons: ["curator_note"]
    });

    auditMemoryConflicts(store, { fix: true, now: "2026-07-12T21:02:10.000Z" });
    expect(store.readMemory(first.id)).toMatchObject({
      qualityStatus: "needs_review",
      qualityReasons: ["curator_note", "potential_conflict"]
    });

    store.upsertMemoryCandidate({ ...second.candidate, summary: "deploy through the blue queue." });
    store.promoteMemoryCandidate(second.candidate.id);
    store.updateMemoryQuality("promoted", second.memory.id, {
      qualityStatus: "needs_review",
      qualityReasons: ["curator_note", "potential_conflict"]
    });
    auditMemoryConflicts(store, { fix: true, now: "2026-07-12T21:02:11.000Z" });
    expect(store.readMemory(first.id)).toMatchObject({
      qualityStatus: "needs_review",
      qualityReasons: ["curator_note"]
    });
    expect(store.readMemory(second.memory.id)).toMatchObject({
      qualityStatus: "needs_review",
      qualityReasons: ["curator_note"]
    });
    store.close();
  });

  it("canonicalizes an existing reverse relation and still reassesses both memories", () => {
    const store = createStore();
    const first = promote(store, { suffix: "reverse-first", summary: "Deploy through the blue queue." }).memory;
    const second = promote(store, { suffix: "reverse-second", summary: "Deploy through the green queue." }).memory;
    const [canonicalFrom, canonicalTo] = [first.id, second.id].sort();
    store.addMemoryRelation({
      fromMemoryId: canonicalTo as string,
      toMemoryId: canonicalFrom as string,
      relationType: "potentially_contradicts"
    });

    const fixed = auditMemoryConflicts(store, { fix: true, now: "2026-07-12T21:02:30.000Z" });

    expect(store.listMemoryRelations({ relationType: "potentially_contradicts" })).toEqual([
      expect.objectContaining({ fromMemoryId: canonicalFrom, toMemoryId: canonicalTo })
    ]);
    expect(fixed.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "remove_relation" }),
      expect.objectContaining({ kind: "add_relation" }),
      expect.objectContaining({ kind: "update_quality", memoryId: first.id }),
      expect.objectContaining({ kind: "update_quality", memoryId: second.id })
    ]));
    store.close();
  });

  it("excludes different subjects, normalized-identical summaries, and identical evidence signatures", () => {
    const store = createStore();
    promote(store, { suffix: "subject-a", title: "Deployment queue", summary: "Use the blue queue." });
    promote(store, { suffix: "subject-b", title: "Database queue", summary: "Use the green queue." });
    promote(store, { suffix: "summary-a", title: "Summary policy", summary: "Use   SQLite for memory." });
    promote(store, { suffix: "summary-b", title: "Summary policy", summary: "  use sqlite for memory.  " });
    store.addSourceWithChunks({
      source: {
        id: "shared-evidence",
        type: "conversation",
        title: "shared.md",
        origin: "test",
        rawContent: "Shared evidence"
      },
      chunks: [{ text: "Shared evidence" }]
    });
    const sharedEvidence = [{
      sourceType: "conversation" as const,
      sourceId: "shared-evidence",
      locator: "shared-evidence:chunk:0"
    }];
    promote(store, { suffix: "evidence-a", title: "Evidence policy", summary: "Use the blue queue.", evidence: sharedEvidence });
    promote(store, { suffix: "evidence-b", title: "Evidence policy", summary: "Use the green queue.", evidence: sharedEvidence });

    const result = auditMemoryConflicts(store);

    expect(result.scannedGroups).toBe(4);
    expect(result.scannedMemories).toBe(6);
    expect(result.conflictPairs).toEqual([]);
    expect(result.changes).toEqual([]);
    store.close();
  });

  it("treats duplicate evidence as a set and avoids a false conflict", () => {
    const store = createStore();
    const evidence = [{ sourceType: "conversation" as const, sourceId: "same", locator: "same:chunk:0" }];
    promote(store, { suffix: "duplicate-a", title: "Duplicate evidence", summary: "Use blue.", evidence });
    promote(store, {
      suffix: "duplicate-b",
      title: "Duplicate evidence",
      summary: "Use green.",
      evidence: [...evidence, ...evidence]
    });

    expect(auditMemoryConflicts(store).conflictPairs).toEqual([]);
    store.close();
  });

  it("does not collide evidence tuples containing legacy delimiters", () => {
    const store = createStore();
    promote(store, {
      suffix: "delimiter-a",
      title: "Delimiter evidence",
      summary: "Use blue.",
      evidence: [{ sourceType: "conversation", sourceId: "a", locator: "b|conversation:c:d" }]
    });
    promote(store, {
      suffix: "delimiter-b",
      title: "Delimiter evidence",
      summary: "Use green.",
      evidence: [
        { sourceType: "conversation", sourceId: "a", locator: "b" },
        { sourceType: "conversation", sourceId: "c", locator: "d" }
      ]
    });

    expect(auditMemoryConflicts(store).conflictPairs).toHaveLength(1);
    store.close();
  });

  it("removes obsolete conflict relations and clears only the potential-conflict quality reason", () => {
    const store = createStore();
    const first = promote(store, {
      suffix: "obsolete-first",
      summary: "Deploy through the blue queue.",
      confidence: 0.55
    });
    const second = promote(store, { suffix: "obsolete-second", summary: "Deploy through the green queue." });
    store.updateMemoryQuality("promoted", first.memory.id, {
      qualityStatus: "needs_review",
      qualityReasons: ["low_confidence"]
    });
    auditMemoryConflicts(store, { fix: true, now: "2026-07-12T21:03:00.000Z" });

    store.upsertMemoryCandidate({
      ...second.candidate,
      summary: "  deploy through the blue queue.  "
    });
    store.promoteMemoryCandidate(second.candidate.id);
    const resolved = auditMemoryConflicts(store, { fix: true, now: "2026-07-12T21:04:00.000Z" });

    expect(resolved.conflictPairs).toEqual([]);
    expect(resolved.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "remove_relation" })
    ]));
    expect(store.listMemoryRelations({ relationType: "potentially_contradicts" })).toEqual([]);
    expect(store.readMemory(first.memory.id)).toMatchObject({
      qualityStatus: "needs_review",
      qualityReasons: ["low_confidence"]
    });
    expect(store.readMemory(second.memory.id)).toMatchObject({
      qualityStatus: "active",
      qualityReasons: []
    });
    store.close();
  });

  it("general quality audit preserves and later clears potential-conflict status based on active relations", () => {
    const store = createStore();
    const first = promote(store, { suffix: "quality-first", summary: "Deploy through the blue queue." }).memory;
    const second = promote(store, { suffix: "quality-second", summary: "Deploy through the green queue." }).memory;
    const [fromMemoryId, toMemoryId] = [first.id, second.id].sort();
    const relation = store.addMemoryRelation({
      fromMemoryId: fromMemoryId as string,
      toMemoryId: toMemoryId as string,
      relationType: "potentially_contradicts"
    });

    auditMemoryQuality(store, { fix: true, now: "2026-07-12T21:05:00.000Z" });
    expect(store.readMemory(first.id)).toMatchObject({
      qualityStatus: "needs_review",
      qualityReasons: ["potential_conflict"]
    });
    expect(store.readMemory(second.id)).toMatchObject({
      qualityStatus: "needs_review",
      qualityReasons: ["potential_conflict"]
    });

    store.deleteMemoryRelation(relation.id);
    auditMemoryQuality(store, { fix: true, now: "2026-07-12T21:06:00.000Z" });
    expect(store.readMemory(first.id)).toMatchObject({ qualityStatus: "active", qualityReasons: [] });
    expect(store.readMemory(second.id)).toMatchObject({ qualityStatus: "active", qualityReasons: [] });
    store.close();
  });
});
