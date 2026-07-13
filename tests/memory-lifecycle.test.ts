import { afterEach, describe, expect, it } from "vitest";

import { createMemorySubjectKey } from "../src/memory/lifecycle.js";
import { openMemoryStore } from "../src/storage/store.js";
import type { ExtractedMemory, MemoryLifecycleStatus } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("durable memory lifecycle storage", () => {
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

  function promote(store: ReturnType<typeof createStore>, suffix: string) {
    const extracted: ExtractedMemory = {
      type: "constraint",
      title: `  Stable  TITLE ${suffix}  `,
      summary: `Summary ${suffix}`,
      reason: "Lifecycle test",
      confidence: 0.95,
      evidence: [{ sourceType: "conversation", sourceId: `source-${suffix}` }],
      relatedFiles: [],
      dedupeKey: `lifecycle-${suffix}`
    };
    const candidate = store.upsertMemoryCandidate(extracted);
    return { candidate, memory: store.promoteMemoryCandidate(candidate.id) };
  }

  it("creates a stable subject key from memory type and normalized title", () => {
    expect(createMemorySubjectKey("constraint", "  Stable  TITLE \u00c9  ")).toBe("constraint:stable-title-e");
    expect(createMemorySubjectKey("constraint", "stable title e")).toBe("constraint:stable-title-e");
  });

  it("stores lifecycle metadata and points a promoted candidate at its durable memory", () => {
    const store = createStore();
    const { candidate, memory } = promote(store, "pointer");

    expect(memory).toMatchObject({
      lifecycleStatus: "current",
      subjectKey: createMemorySubjectKey(memory.type, memory.title),
      validFrom: memory.createdAt,
      statusChangedAt: memory.promotedAt
    });
    expect(memory.validUntil).toBeUndefined();
    expect(memory.statusReason).toBeUndefined();
    expect(store.listMemoryCandidates({ qualityStatus: "all" })).toEqual([
      expect.objectContaining({ id: candidate.id, promotedMemoryId: memory.id })
    ]);
    expect(store.readMemory(memory.id)).toEqual(memory);
    store.close();
  });

  it("defaults promoted reads to current and supports all or specific lifecycle filters", () => {
    const store = createStore();
    const current = promote(store, "current").memory;
    const superseded = promote(store, "superseded").memory;
    const retracted = promote(store, "retracted").memory;
    store.updateMemoryLifecycle(superseded.id, {
      lifecycleStatus: "superseded",
      statusReason: "Replaced",
      validUntil: "2026-07-12T10:00:00.000Z",
      statusChangedAt: "2026-07-12T10:00:00.000Z"
    });
    store.updateMemoryLifecycle(retracted.id, {
      lifecycleStatus: "retracted",
      statusReason: "Incorrect",
      statusChangedAt: "2026-07-12T11:00:00.000Z"
    });

    expect(store.listMemories({ qualityStatus: "all" }).map(({ id }) => id)).toEqual([current.id]);
    expect(store.listMemories({ qualityStatus: "all", lifecycleStatus: "all" })).toHaveLength(3);
    expect(store.listMemories({ qualityStatus: "all", lifecycleStatus: "superseded" })).toEqual([
      expect.objectContaining({ id: superseded.id, statusReason: "Replaced" })
    ]);
    expect(store.searchMemoryLayer({ status: "promoted", qualityStatus: "all" })).toHaveLength(1);
    expect(store.searchMemoryLayer({ status: "promoted", qualityStatus: "all", lifecycleStatus: "all" })).toHaveLength(3);
    expect(store.searchMemoryLayer({ status: "promoted", qualityStatus: "all", lifecycleStatus: "retracted" })).toEqual([
      expect.objectContaining({ id: retracted.id, lifecycleStatus: "retracted" })
    ]);
    store.close();
  });

  it.each(["superseded", "retracted"] satisfies MemoryLifecycleStatus[])(
    "does not reactivate a %s durable memory during repeated promotion",
    (lifecycleStatus) => {
      const store = createStore();
      const first = promote(store, lifecycleStatus);
      store.updateMemoryLifecycle(first.memory.id, {
        lifecycleStatus,
        statusReason: `Marked ${lifecycleStatus}`,
        statusChangedAt: "2026-07-12T12:00:00.000Z"
      });
      store.upsertMemoryCandidate({
        ...first.candidate,
        summary: "Updated evidence and content",
        evidence: [{ sourceType: "conversation", sourceId: `updated-source-${lifecycleStatus}` }]
      });
      const repeated = store.promoteMemoryCandidate(first.candidate.id);

      expect(repeated).toMatchObject({
        id: first.memory.id,
        summary: "Updated evidence and content",
        lifecycleStatus,
        statusReason: `Marked ${lifecycleStatus}`,
        statusChangedAt: "2026-07-12T12:00:00.000Z"
      });
      expect(store.listMemories({ qualityStatus: "all" })).toEqual([]);
      store.close();
    }
  );

  it("stores unique memory relations and supports filtered listing and deletion", () => {
    const store = createStore();
    const from = promote(store, "relation-from").memory;
    const to = promote(store, "relation-to").memory;
    const relation = store.addMemoryRelation({
      fromMemoryId: from.id,
      toMemoryId: to.id,
      relationType: "supersedes",
      reason: "New canonical fact",
      createdAt: "2026-07-12T13:00:00.000Z"
    });

    expect(store.addMemoryRelation({
      fromMemoryId: from.id,
      toMemoryId: to.id,
      relationType: "supersedes",
      reason: "Duplicate tuple"
    })).toEqual(relation);
    expect(store.listMemoryRelations({ fromMemoryId: from.id })).toEqual([relation]);
    expect(store.listMemoryRelations({ toMemoryId: to.id, relationType: "supersedes" })).toEqual([relation]);
    expect(store.deleteMemoryRelation(relation.id)).toBe(true);
    expect(store.deleteMemoryRelation(relation.id)).toBe(false);
    expect(store.listMemoryRelations()).toEqual([]);
    store.close();
  });

  it("uses compound relation filters and provides a relation-type-leading index", () => {
    const store = createStore();
    const first = promote(store, "filter-first").memory;
    const second = promote(store, "filter-second").memory;
    const third = promote(store, "filter-third").memory;
    const supersedes = store.addMemoryRelation({
      fromMemoryId: first.id,
      toMemoryId: second.id,
      relationType: "supersedes"
    });
    store.addMemoryRelation({
      fromMemoryId: first.id,
      toMemoryId: third.id,
      relationType: "potentially_contradicts"
    });

    expect(store.listMemoryRelations({
      fromMemoryId: first.id,
      toMemoryId: second.id,
      relationType: "supersedes"
    })).toEqual([supersedes]);
    expect(store.listMemoryRelations({ relationType: "potentially_contradicts" })).toHaveLength(1);
    expect(store.db.prepare(
      "select sql from sqlite_master where type = 'index' and name = 'idx_memory_relations_type'"
    ).get()).toMatchObject({ sql: expect.stringMatching(/\(relation_type,/) });
    store.close();
  });

  it("rejects self-relations through both the store and fresh schema", () => {
    const store = createStore();
    const memory = promote(store, "self-relation").memory;

    expect(() => store.addMemoryRelation({
      fromMemoryId: memory.id,
      toMemoryId: memory.id,
      relationType: "supersedes"
    })).toThrow("cannot relate a memory to itself");
    expect(store.db.prepare(
      "select sql from sqlite_master where type = 'table' and name = 'memory_relations'"
    ).get()).toMatchObject({ sql: expect.stringMatching(/check\s*\(from_memory_id\s*<>\s*to_memory_id\)/i) });
    expect(store.listMemoryRelations()).toEqual([]);
    store.close();
  });
});
