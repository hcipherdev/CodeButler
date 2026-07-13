import { afterEach, describe, expect, it } from "vitest";

import { updateMemoryStatus } from "../src/memory/lifecycle-service.js";
import { rememberProjectMemory } from "../src/memory/remember.js";
import { openMemoryStore } from "../src/storage/store.js";
import type { ExtractedMemory, MemoryLifecycleStatus } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("memory lifecycle orchestration", () => {
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
    const memory: ExtractedMemory = {
      type: "constraint",
      title: `Lifecycle ${suffix}`,
      summary: `Lifecycle summary ${suffix}`,
      reason: "Lifecycle service test",
      confidence: 0.95,
      evidence: [],
      relatedFiles: [],
      dedupeKey: `lifecycle-service-${suffix}`
    };
    return store.promoteMemoryCandidate(store.upsertMemoryCandidate(memory).id);
  }

  it("atomically supersedes an original with a current replacement in replacement-to-original direction", () => {
    const store = createStore();
    const original = promote(store, "original");
    const replacement = promote(store, "replacement");

    const updated = updateMemoryStatus(store, {
      memoryId: original.id,
      status: "superseded",
      reason: "A newer constraint is canonical.",
      replacementMemoryId: replacement.id,
      now: "2026-07-12T20:00:00.000Z"
    });

    expect(updated).toMatchObject({
      lifecycleStatus: "superseded",
      statusReason: "A newer constraint is canonical.",
      statusChangedAt: "2026-07-12T20:00:00.000Z",
      validUntil: "2026-07-12T20:00:00.000Z"
    });
    expect(store.listMemoryRelations({ relationType: "supersedes" })).toEqual([
      expect.objectContaining({
        fromMemoryId: replacement.id,
        toMemoryId: original.id,
        createdAt: "2026-07-12T20:00:00.000Z"
      })
    ]);
    store.close();
  });

  it("allows only exact idempotent supersession replay and rejects incompatible target states", () => {
    const store = createStore();
    const original = promote(store, "replay-original");
    const firstReplacement = promote(store, "replay-first");
    const secondReplacement = promote(store, "replay-second");
    updateMemoryStatus(store, {
      memoryId: original.id,
      status: "superseded",
      reason: "First replacement",
      replacementMemoryId: firstReplacement.id,
      now: "2026-07-12T20:00:00.000Z"
    });

    const targetBeforeReplay = store.readMemory(original.id);
    const relationsBeforeReplay = store.listMemoryRelations({ relationType: "supersedes" });
    expect(updateMemoryStatus(store, {
      memoryId: original.id,
      status: "superseded",
      reason: "Replay",
      replacementMemoryId: firstReplacement.id,
      now: "2026-07-12T20:00:01.000Z"
    })).toEqual(targetBeforeReplay);
    expect(store.listMemoryRelations({ relationType: "supersedes" })).toEqual(relationsBeforeReplay);
    expect(() => updateMemoryStatus(store, {
      memoryId: original.id,
      status: "superseded",
      reason: "Incompatible replacement",
      replacementMemoryId: secondReplacement.id,
      now: "2026-07-12T20:00:02.000Z"
    })).toThrow("Superseded memory already has a different replacement");
    store.addMemoryRelation({
      fromMemoryId: secondReplacement.id,
      toMemoryId: original.id,
      relationType: "supersedes"
    });
    expect(() => updateMemoryStatus(store, {
      memoryId: original.id,
      status: "superseded",
      reason: "Ambiguous replay",
      replacementMemoryId: firstReplacement.id,
      now: "2026-07-12T20:00:02.500Z"
    })).toThrow("Superseded memory already has a different replacement");

    const retracted = promote(store, "replay-retracted");
    updateMemoryStatus(store, {
      memoryId: retracted.id,
      status: "retracted",
      reason: "Incorrect",
      now: "2026-07-12T20:00:03.000Z"
    });
    expect(() => updateMemoryStatus(store, {
      memoryId: retracted.id,
      status: "superseded",
      reason: "Cannot replace a retraction",
      replacementMemoryId: firstReplacement.id,
      now: "2026-07-12T20:00:04.000Z"
    })).toThrow("Only current memories can be superseded");
    store.addMemoryRelation({
      fromMemoryId: firstReplacement.id,
      toMemoryId: retracted.id,
      relationType: "supersedes"
    });
    expect(() => updateMemoryStatus(store, {
      memoryId: retracted.id,
      status: "superseded",
      reason: "A stale relation cannot reactivate a retraction",
      replacementMemoryId: firstReplacement.id,
      now: "2026-07-12T20:00:05.000Z"
    })).toThrow("Only current memories can be superseded");
    store.close();
  });

  it("replays unchanged when the exact historical replacement has since become non-current", () => {
    const store = createStore();
    const original = promote(store, "replay-chain-original");
    const historicalReplacement = promote(store, "replay-chain-historical");
    const latestReplacement = promote(store, "replay-chain-latest");
    updateMemoryStatus(store, {
      memoryId: original.id,
      status: "superseded",
      reason: "Historical replacement",
      replacementMemoryId: historicalReplacement.id,
      now: "2026-07-12T20:00:10.000Z"
    });
    updateMemoryStatus(store, {
      memoryId: historicalReplacement.id,
      status: "superseded",
      reason: "Latest replacement",
      replacementMemoryId: latestReplacement.id,
      now: "2026-07-12T20:00:11.000Z"
    });
    const targetBeforeReplay = store.readMemory(original.id);
    const relationsBeforeReplay = store.listMemoryRelations({ relationType: "supersedes" });

    expect(updateMemoryStatus(store, {
      memoryId: original.id,
      status: "superseded",
      reason: "Late delivery replay",
      replacementMemoryId: historicalReplacement.id,
      now: "2026-07-12T20:00:12.000Z"
    })).toEqual(targetBeforeReplay);
    expect(store.listMemoryRelations({ relationType: "supersedes" })).toEqual(relationsBeforeReplay);
    store.close();
  });

  it("rejects missing, self, and non-current replacements without changing lifecycle state", () => {
    const store = createStore();
    const original = promote(store, "validation-original");
    const replacement = promote(store, "validation-replacement");
    updateMemoryStatus(store, {
      memoryId: replacement.id,
      status: "retracted",
      reason: "Not trustworthy",
      now: "2026-07-12T20:01:00.000Z"
    });

    expect(() => updateMemoryStatus(store, {
      memoryId: "missing",
      status: "retracted",
      reason: "Missing",
      now: "2026-07-12T20:02:00.000Z"
    })).toThrow("Unknown durable memory: missing");
    expect(() => updateMemoryStatus(store, {
      memoryId: original.id,
      status: "superseded",
      reason: "No replacement provided",
      now: "2026-07-12T20:02:00.000Z"
    })).toThrow("requires a replacementMemoryId");
    expect(() => updateMemoryStatus(store, {
      memoryId: original.id,
      status: "superseded",
      reason: "Replacement does not exist",
      replacementMemoryId: "missing-replacement",
      now: "2026-07-12T20:02:00.000Z"
    })).toThrow("Unknown durable memory: missing-replacement");
    expect(() => updateMemoryStatus(store, {
      memoryId: original.id,
      status: "superseded",
      reason: "Self",
      replacementMemoryId: original.id,
      now: "2026-07-12T20:02:00.000Z"
    })).toThrow("cannot supersede itself");
    expect(() => updateMemoryStatus(store, {
      memoryId: original.id,
      status: "superseded",
      reason: "Bad replacement",
      replacementMemoryId: replacement.id,
      now: "2026-07-12T20:02:00.000Z"
    })).toThrow("Replacement memory must be current");

    expect(store.readMemory(original.id)).toMatchObject({ lifecycleStatus: "current" });
    expect(store.listMemoryRelations({ relationType: "supersedes" })).toEqual([]);
    store.close();
  });

  it("rejects a transitive supersession cycle", () => {
    const store = createStore();
    const first = promote(store, "cycle-first");
    const second = promote(store, "cycle-second");
    const third = promote(store, "cycle-third");
    store.addMemoryRelation({ fromMemoryId: second.id, toMemoryId: first.id, relationType: "supersedes" });
    store.addMemoryRelation({ fromMemoryId: third.id, toMemoryId: second.id, relationType: "supersedes" });

    expect(() => updateMemoryStatus(store, {
      memoryId: third.id,
      status: "superseded",
      reason: "Would close a cycle",
      replacementMemoryId: first.id,
      now: "2026-07-12T20:03:00.000Z"
    })).toThrow("supersession cycle");
    expect(store.readMemory(third.id)).toMatchObject({ lifecycleStatus: "current" });
    expect(store.listMemoryRelations({ relationType: "supersedes" })).toHaveLength(2);
    store.close();
  });

  it("retracts without a supersedes relation and only reactivates through explicit current status", () => {
    const store = createStore();
    const memory = promote(store, "reactivation");

    updateMemoryStatus(store, {
      memoryId: memory.id,
      status: "retracted",
      reason: "Incorrect",
      now: "2026-07-12T20:04:00.000Z"
    });
    const current = updateMemoryStatus(store, {
      memoryId: memory.id,
      status: "current",
      reason: "Validated again",
      now: "2026-07-12T20:05:00.000Z"
    });

    expect(current).toMatchObject({
      lifecycleStatus: "current",
      statusReason: "Validated again",
      statusChangedAt: "2026-07-12T20:05:00.000Z"
    });
    expect(current.validUntil).toBeUndefined();
    expect(store.listMemoryRelations({ relationType: "supersedes" })).toEqual([]);
    store.close();
  });

  it("reactivates atomically by removing incoming supersedes relations while keeping outgoing history", () => {
    const store = createStore();
    const older = promote(store, "reactivate-older");
    const memory = promote(store, "reactivate-middle");
    const replacement = promote(store, "reactivate-replacement");
    store.addMemoryRelation({ fromMemoryId: memory.id, toMemoryId: older.id, relationType: "supersedes" });
    updateMemoryStatus(store, {
      memoryId: memory.id,
      status: "superseded",
      reason: "Temporarily replaced",
      replacementMemoryId: replacement.id,
      now: "2026-07-12T20:05:30.000Z"
    });

    updateMemoryStatus(store, {
      memoryId: memory.id,
      status: "current",
      reason: "Canonical again",
      now: "2026-07-12T20:05:31.000Z"
    });

    expect(store.listMemoryRelations({ relationType: "supersedes" })).toEqual([
      expect.objectContaining({ fromMemoryId: memory.id, toMemoryId: older.id })
    ]);
    expect(store.readMemory(memory.id)).toMatchObject({ lifecycleStatus: "current" });
    store.close();
  });

  it("rejects invalid statuses and replacement ids on non-superseded transitions with stable service errors", () => {
    const store = createStore();
    const memory = promote(store, "invalid-status");
    const replacement = promote(store, "invalid-status-replacement");

    expect(() => updateMemoryStatus(store, {
      memoryId: memory.id,
      status: "obsolete" as MemoryLifecycleStatus,
      reason: "Invalid",
      now: "2026-07-12T20:05:40.000Z"
    })).toThrow("Invalid memory lifecycle status: obsolete");
    for (const status of ["current", "retracted"] as const) {
      expect(() => updateMemoryStatus(store, {
        memoryId: memory.id,
        status,
        reason: "Replacement is invalid here",
        replacementMemoryId: replacement.id,
        now: "2026-07-12T20:05:41.000Z"
      })).toThrow(`replacementMemoryId is not allowed for ${status} status`);
    }
    expect(store.readMemory(memory.id)).toMatchObject({ lifecycleStatus: "current" });
    store.close();
  });

  it("loads supersession adjacency once while checking a transitive cycle", () => {
    const store = createStore();
    const first = promote(store, "adjacency-first");
    const second = promote(store, "adjacency-second");
    const third = promote(store, "adjacency-third");
    store.addMemoryRelation({ fromMemoryId: second.id, toMemoryId: first.id, relationType: "supersedes" });
    store.addMemoryRelation({ fromMemoryId: third.id, toMemoryId: second.id, relationType: "supersedes" });
    const listRelations = store.listMemoryRelations.bind(store);
    let supersedesLoads = 0;
    store.listMemoryRelations = (input) => {
      if (input?.relationType === "supersedes") supersedesLoads += 1;
      return listRelations(input);
    };

    expect(() => updateMemoryStatus(store, {
      memoryId: third.id,
      status: "superseded",
      reason: "Cycle",
      replacementMemoryId: first.id,
      now: "2026-07-12T20:05:50.000Z"
    })).toThrow("supersession cycle");
    expect(supersedesLoads).toBe(1);
    store.close();
  });

  it("rolls back lifecycle metadata when relation insertion fails", () => {
    const store = createStore();
    const original = promote(store, "rollback-original");
    const replacement = promote(store, "rollback-replacement");
    store.db.exec(`
      create trigger fail_service_relation before insert on memory_relations
      begin select raise(abort, 'injected service relation failure'); end;
    `);

    expect(() => updateMemoryStatus(store, {
      memoryId: original.id,
      status: "superseded",
      reason: "Must roll back",
      replacementMemoryId: replacement.id,
      now: "2026-07-12T20:06:00.000Z"
    })).toThrow("injected service relation failure");
    expect(store.readMemory(original.id)).toMatchObject({ lifecycleStatus: "current" });
    expect(store.listMemoryRelations()).toEqual([]);
    store.close();
  });

  it("atomically remembers a promoted replacement and supersedes the old memory", () => {
    const store = createStore();
    const old = rememberProjectMemory(store, {
      type: "constraint",
      text: "Deployments use the legacy release queue.",
      title: "Deployment release queue"
    }, { now: () => new Date("2026-07-12T20:07:00.000Z") });

    const replacement = rememberProjectMemory(store, {
      type: "constraint",
      text: "Deployments use the verified release queue.",
      title: "Deployment release queue",
      supersedesMemoryId: old.memory?.id
    }, { now: () => new Date("2026-07-12T20:08:00.000Z") });

    expect(replacement.memory?.lifecycleStatus).toBe("current");
    expect(store.readMemory(old.memory?.id ?? "")).toMatchObject({
      lifecycleStatus: "superseded",
      validUntil: "2026-07-12T20:08:00.000Z"
    });
    expect(store.listMemoryRelations({ relationType: "supersedes" })).toEqual([
      expect.objectContaining({ fromMemoryId: replacement.memory?.id, toMemoryId: old.memory?.id })
    ]);
    store.close();
  });

  it("rejects candidate-only supersession before writing any remember artifacts", () => {
    const store = createStore();
    const old = promote(store, "candidate-only-old");

    expect(() => rememberProjectMemory(store, {
      type: "constraint",
      text: "This candidate cannot supersede a durable memory.",
      promote: false,
      supersedesMemoryId: old.id
    })).toThrow("requires promotion");
    expect(store.listMemoryCandidates({ qualityStatus: "all" })).toHaveLength(1);
    expect(store.listMemories({ lifecycleStatus: "all", qualityStatus: "all" })).toHaveLength(1);
    expect(store.db.prepare("select count(*) as count from sources").get()).toEqual({ count: 0 });
    store.close();
  });

  it("rolls back source, candidate, durable replacement, lifecycle, and relation on remember failure", () => {
    const store = createStore();
    const old = rememberProjectMemory(store, {
      type: "constraint",
      text: "Use the original release checklist.",
      title: "Release checklist"
    });
    const before = {
      sources: store.db.prepare("select count(*) as count from sources").get(),
      candidates: store.db.prepare("select count(*) as count from memory_candidates").get(),
      memories: store.db.prepare("select count(*) as count from memories").get()
    };
    store.db.exec(`
      create trigger fail_remember_relation before insert on memory_relations
      begin select raise(abort, 'injected remember relation failure'); end;
    `);

    expect(() => rememberProjectMemory(store, {
      type: "constraint",
      text: "Use the replacement release checklist.",
      title: "Release checklist",
      supersedesMemoryId: old.memory?.id
    })).toThrow("injected remember relation failure");

    expect(store.db.prepare("select count(*) as count from sources").get()).toEqual(before.sources);
    expect(store.db.prepare("select count(*) as count from memory_candidates").get()).toEqual(before.candidates);
    expect(store.db.prepare("select count(*) as count from memories").get()).toEqual(before.memories);
    expect(store.readMemory(old.memory?.id ?? "")).toMatchObject({ lifecycleStatus: "current" });
    expect(store.listMemoryRelations()).toEqual([]);
    store.close();
  });
});
