import { afterEach, describe, expect, it } from "vitest";

import { addDecision } from "../src/decisions/store.js";
import { openMemoryStore } from "../src/storage/store.js";
import { withTransaction } from "../src/storage/transactions.js";
import type { ExtractedMemory, TemporaryMemoryUpsertInput } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("atomic storage writes", () => {
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

  it("keeps transaction orchestration internal instead of exporting a required store method", () => {
    const store = createStore();
    expect("transaction" in store).toBe(false);
    store.close();
  });

  it("uses a savepoint for nested work so an inner failure does not abort the outer transaction", () => {
    const store = createStore();
    store.db.exec("create table transaction_test (value text)");

    withTransaction(store.db, () => {
      store.db.prepare("insert into transaction_test values ('outer-before')").run();
      expect(() =>
        withTransaction(store.db, () => {
          store.db.prepare("insert into transaction_test values ('inner')").run();
          throw new Error("inner failure");
        })
      ).toThrow("inner failure");
      store.db.prepare("insert into transaction_test values ('outer-after')").run();
    });

    expect(store.db.prepare("select value from transaction_test order by rowid").all()).toEqual([
      { value: "outer-before" },
      { value: "outer-after" }
    ]);
    store.close();
  });

  it("rolls back source, chunk, FTS, and relation replacement together", () => {
    const store = createStore();
    store.addSourceWithChunks({
      source: {
        id: "conv-atomic",
        type: "conversation",
        title: "Before",
        origin: "test",
        rawContent: "Before src/before.ts"
      },
      chunks: [{ text: "Before src/before.ts" }]
    });
    store.db.exec(`
      create trigger fail_chunk_insert before insert on chunks
      when new.source_id = 'conv-atomic'
      begin select raise(abort, 'injected chunk failure'); end;
    `);

    expect(() =>
      store.addSourceWithChunks({
        source: {
          id: "conv-atomic",
          type: "conversation",
          title: "After",
          origin: "test",
          rawContent: "After src/after.ts"
        },
        chunks: [{ text: "After src/after.ts" }]
      })
    ).toThrow("injected chunk failure");

    expect(store.readSource("conv-atomic")?.title).toBe("Before");
    expect(store.readChunkWindow("conv-atomic", 0, 0, 0)[0]?.text).toBe("Before src/before.ts");
    expect(store.search({ query: "Before" })).toHaveLength(1);
    expect(store.findSourcesMentioningFile("src/before.ts", 5)).toHaveLength(1);
    store.close();
  });

  it("rolls back a commit row when its source ingestion fails", () => {
    const store = createStore();
    store.db.exec(`
      create trigger fail_commit_source before insert on sources
      when new.id = 'commit-atomic'
      begin select raise(abort, 'injected source failure'); end;
    `);

    expect(() =>
      store.addCommit({
        hash: "commit-atomic",
        authorName: "Test",
        authorEmail: "test@example.com",
        authoredAt: "2026-01-01T00:00:00Z",
        message: "Atomic commit",
        changedFiles: ["src/atomic.ts"],
        diffSummary: "+ atomic"
      })
    ).toThrow("injected source failure");

    expect(store.readCommit("commit-atomic")).toBeUndefined();
    store.close();
  });

  it("rolls back the durable row when candidate promotion state cannot update", () => {
    const store = createStore();
    const memory: ExtractedMemory = {
      type: "constraint",
      title: "Atomic promotion",
      summary: "Promotions update both tables atomically.",
      reason: "Avoid split lifecycle state.",
      confidence: 0.9,
      evidence: [],
      relatedFiles: [],
      dedupeKey: "atomic-promotion"
    };
    const candidate = store.upsertMemoryCandidate(memory);
    store.db.exec(`
      create trigger fail_candidate_promotion before update on memory_candidates
      when new.promotion_state = 'promoted'
      begin select raise(abort, 'injected promotion failure'); end;
    `);

    expect(() => store.promoteMemoryCandidate(candidate.id)).toThrow("injected promotion failure");
    expect(store.listMemories({ qualityStatus: "all" })).toHaveLength(0);
    expect(store.listMemoryCandidates({ qualityStatus: "all" })[0]?.promotionState).toBe("candidate");
    store.close();
  });

  it("rolls back lifecycle metadata when a lifecycle relation write fails", () => {
    const store = createStore();
    const makeMemory = (suffix: string) => store.promoteMemoryCandidate(store.upsertMemoryCandidate({
      type: "constraint",
      title: `Lifecycle ${suffix}`,
      summary: `Lifecycle ${suffix}`,
      reason: "Atomic lifecycle write",
      confidence: 0.9,
      evidence: [],
      relatedFiles: [],
      dedupeKey: `atomic-lifecycle-${suffix}`
    }).id);
    const from = makeMemory("from");
    const to = makeMemory("to");
    store.db.exec(`
      create trigger fail_lifecycle_relation before insert on memory_relations
      begin select raise(abort, 'injected lifecycle relation failure'); end;
    `);

    expect(() => withTransaction(store.db, () => {
      store.updateMemoryLifecycle(to.id, {
        lifecycleStatus: "superseded",
        statusReason: "Should roll back",
        statusChangedAt: "2026-07-12T13:00:00.000Z"
      });
      store.addMemoryRelation({
        fromMemoryId: from.id,
        toMemoryId: to.id,
        relationType: "supersedes",
        reason: "Atomic pair"
      });
    })).toThrow("injected lifecycle relation failure");

    expect(store.readMemory(to.id)).toMatchObject({ lifecycleStatus: "current" });
    expect(store.listMemoryRelations()).toEqual([]);
    store.close();
  });

  it("rolls back a candidate row when rebuilding its memory links fails", () => {
    const store = createStore();
    store.db.exec(`
      create trigger fail_candidate_link before insert on memory_links
      when new.owner_kind = 'candidate'
      begin select raise(abort, 'injected candidate link failure'); end;
    `);

    expect(() =>
      store.upsertMemoryCandidate({
        type: "constraint",
        title: "Atomic candidate",
        summary: "Candidate rows and links change together.",
        reason: "Avoid partially indexed memory candidates.",
        confidence: 0.9,
        evidence: [],
        relatedFiles: ["src/atomic.ts"],
        dedupeKey: "atomic-candidate"
      })
    ).toThrow("injected candidate link failure");

    expect(store.listMemoryCandidates({ qualityStatus: "all" })).toHaveLength(0);
    expect(store.db.prepare("select count(*) as count from memory_links").get()).toEqual({ count: 0 });
    store.close();
  });

  it("rolls back a temporary row and links when FTS rebuilding fails", () => {
    const store = createStore();
    store.db.exec("drop table temporary_memories_fts");

    expect(() =>
      store.upsertTemporaryMemory({
        id: "temp-upsert-atomic",
        kind: "task_state",
        title: "Atomic temporary upsert",
        summary: "Temporary rows, links, and FTS change together.",
        relatedFiles: ["src/atomic.ts"],
        evidence: []
      })
    ).toThrow("temporary_memories_fts");

    expect(store.db.prepare("select count(*) as count from temporary_memories").get()).toEqual({ count: 0 });
    expect(store.db.prepare("select count(*) as count from temporary_memory_links").get()).toEqual({ count: 0 });
    store.close();
  });

  it("rolls back an entire manual decision when final relation insertion fails", () => {
    const store = createStore();
    store.db.exec(`
      create trigger fail_decision_relation before insert on relations
      when new.from_type = 'decision' and new.relation = 'supported_by'
      begin select raise(abort, 'injected decision relation failure'); end;
    `);

    expect(() =>
      addDecision(store, {
        topic: "Atomic decisions",
        decision: "Write all decision records together",
        reason: "Avoid partial manual decisions",
        status: "accepted",
        evidence: [{ sourceType: "conversation", sourceId: "conv-evidence", locator: "conv-evidence:chunk:0" }]
      })
    ).toThrow("injected decision relation failure");

    expect(store.db.prepare("select count(*) as count from decisions").get()).toEqual({ count: 0 });
    expect(store.readSource("DEC-0001")).toBeUndefined();
    expect(store.readChunkWindow("DEC-0001", 0, 0, 0)).toEqual([]);
    expect(store.listMemories({ qualityStatus: "all" })).toHaveLength(0);
    expect(
      store.db.prepare("select count(*) as count from relations where from_type = 'decision'").get()
    ).toEqual({ count: 0 });
    store.close();
  });

  it("rolls back direct manual decision memory rows when link insertion fails", () => {
    const store = createStore();
    store.db.exec(`
      create trigger fail_manual_memory_link before insert on memory_links
      when new.owner_kind = 'memory'
      begin select raise(abort, 'injected manual memory link failure'); end;
    `);

    expect(() => store.upsertManualDecisionMemory({
      id: "DEC-DIRECT",
      topic: "Direct atomic memory",
      decision: "Wrap direct durable writes",
      reason: "Links must not be partial",
      status: "accepted",
      evidence: [{ sourceType: "commit", sourceId: "abc123" }],
      createdAt: "2026-07-11T00:00:00Z"
    })).toThrow("injected manual memory link failure");
    expect(store.listMemories({ qualityStatus: "all" })).toHaveLength(0);
    expect(store.db.prepare("select count(*) as count from memory_links").get()).toEqual({ count: 0 });
    store.close();
  });

  it("rolls back FTS and link cleanup when deleting temporary rows fails", () => {
    const store = createStore();
    const temporary: TemporaryMemoryUpsertInput = {
      id: "temp-atomic",
      kind: "task_state",
      title: "Atomic cleanup",
      summary: "Clean temporary memory atomically.",
      relatedFiles: ["src/atomic.ts"],
      evidence: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-01-02T00:00:00Z"
    };
    store.upsertTemporaryMemory(temporary);
    store.db.exec(`
      create trigger fail_temporary_delete before delete on temporary_memories
      when old.id = 'temp-atomic'
      begin select raise(abort, 'injected cleanup failure'); end;
    `);

    expect(() =>
      store.deleteExpiredTemporaryMemories({ now: "2026-01-03T00:00:00Z" })
    ).toThrow("injected cleanup failure");
    expect(store.db.prepare("select count(*) as count from temporary_memories").get()).toEqual({ count: 1 });
    expect(store.db.prepare("select count(*) as count from temporary_memories_fts").get()).toEqual({ count: 1 });
    expect(store.db.prepare("select count(*) as count from temporary_memory_links").get()).toEqual({ count: 1 });
    store.close();
  });
});
