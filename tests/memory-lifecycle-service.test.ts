import { afterEach, describe, expect, it } from "vitest";

import {
  createEmbeddingEndpointHash,
  createProviderFingerprint,
  createProviderKey,
  encodeFloat32Vector
} from "../src/embeddings/fingerprint.js";
import { buildEmbeddings } from "../src/embeddings/service.js";
import { updateMemoryStatus } from "../src/memory/lifecycle-service.js";
import { rememberProjectMemory } from "../src/memory/remember.js";
import { openMemoryStore } from "../src/storage/store.js";
import { withTransaction } from "../src/storage/transactions.js";
import type { EmbeddingProvider, ExtractedMemory, MemoryLifecycleStatus } from "../src/types.js";
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

  it("runs remember supersession cleanup after the outer commit and isolates independent cleanup failures", () => {
    const store = createStore();
    const old = rememberProjectMemory(store, {
      type: "constraint",
      text: "Deployments use the pre-commit cleanup queue.",
      title: "Cleanup commit boundary"
    }, { now: () => new Date("2026-07-12T20:07:00.000Z") });
    const observations: Array<{ kind: string; inTransaction: boolean }> = [];
    store.deleteStaleEmbeddingJobsForMemory = () => {
      observations.push({ kind: "jobs", inTransaction: store.db.isTransaction });
      throw new Error("injected job cleanup failure");
    };
    store.deleteStaleEmbeddingVectorsForMemory = () => {
      observations.push({ kind: "vectors", inTransaction: store.db.isTransaction });
      throw new Error("injected vector cleanup failure");
    };

    const replacement = rememberProjectMemory(store, {
      type: "constraint",
      text: "Deployments use the post-commit cleanup queue.",
      title: "Cleanup commit boundary",
      supersedesMemoryId: old.memory?.id
    }, { now: () => new Date("2026-07-12T20:08:00.000Z") });

    expect(observations).toEqual([
      { kind: "jobs", inTransaction: false },
      { kind: "vectors", inTransaction: false }
    ]);
    expect(store.readSource(replacement.sourceId)).toBeTruthy();
    expect(store.listMemoryCandidates({ qualityStatus: "all" })).toHaveLength(2);
    expect(replacement.memory).toMatchObject({ lifecycleStatus: "current" });
    expect(store.readMemory(old.memory?.id ?? "")).toMatchObject({ lifecycleStatus: "superseded" });
    expect(store.listMemoryRelations({ relationType: "supersedes" })).toEqual([
      expect.objectContaining({ fromMemoryId: replacement.memory?.id, toMemoryId: old.memory?.id })
    ]);
    store.close();
  });

  it("discards remember supersession cleanup when an enclosing transaction rolls back", () => {
    const store = createStore();
    const old = rememberProjectMemory(store, {
      type: "constraint",
      text: "Use the original outer rollback queue.",
      title: "Outer rollback cleanup"
    });
    let cleanupCalls = 0;
    store.deleteStaleEmbeddingJobsForMemory = () => {
      cleanupCalls += 1;
      return 0;
    };
    store.deleteStaleEmbeddingVectorsForMemory = () => {
      cleanupCalls += 1;
      return 0;
    };

    expect(() => withTransaction(store.db, () => {
      rememberProjectMemory(store, {
        type: "constraint",
        text: "Use the replacement outer rollback queue.",
        title: "Outer rollback cleanup",
        supersedesMemoryId: old.memory?.id
      });
      throw new Error("injected outer rollback");
    })).toThrow("injected outer rollback");

    expect(cleanupCalls).toBe(0);
    expect(store.readMemory(old.memory?.id ?? "")).toMatchObject({ lifecycleStatus: "current" });
    expect(store.listMemoryRelations()).toEqual([]);
    expect(store.listMemoryCandidates({ qualityStatus: "all" })).toHaveLength(1);
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

  it("atomically invalidates inactive embedding state and queues fresh work only after reactivation reconciliation", () => {
    const store = createStore();
    const memory = promote(store, "embedding-lifecycle");
    const endpointHash = createEmbeddingEndpointHash("http://127.0.0.1:11434/v1");
    const provider = {
      endpointHash,
      model: "model",
      providerKey: createProviderKey(endpointHash, "model")
    };
    store.reconcileEmbeddingJobs(provider);
    const owner = store.listEmbeddingOwners().find((item) => item.ownerId === memory.id)!;
    store.recordEmbeddingJobAttempts([
      store.listEmbeddingJobs({ ownerKind: "memory", ownerId: memory.id })[0]!
    ]);
    store.completeEmbeddingJob({
      ...owner,
      ...provider,
      providerFingerprint: createProviderFingerprint(endpointHash, "model", 1),
      dimension: 1,
      vectorBlob: encodeFloat32Vector([1])
    });

    updateMemoryStatus(store, {
      memoryId: memory.id,
      status: "retracted",
      reason: "No longer trusted",
      now: "2026-07-12T20:09:00.000Z"
    });
    expect(store.listEmbeddingVectors({ ownerKind: "memory", ownerId: memory.id })).toEqual([]);
    expect(store.listEmbeddingJobs({ ownerKind: "memory", ownerId: memory.id })).toEqual([]);

    updateMemoryStatus(store, {
      memoryId: memory.id,
      status: "current",
      reason: "Verified again",
      now: "2026-07-12T20:10:00.000Z"
    });
    expect(store.listEmbeddingVectors({ ownerKind: "memory", ownerId: memory.id })).toEqual([]);
    expect(store.listEmbeddingJobs({ ownerKind: "memory", ownerId: memory.id })).toEqual([]);
    store.reconcileEmbeddingJobs(provider);
    expect(store.listEmbeddingJobs({ ownerKind: "memory", ownerId: memory.id })).toEqual([
      expect.objectContaining({ state: "pending", attempts: 0 })
    ]);
    store.close();
  });

  it("commits lifecycle changes when embedding cleanup fails and never reactivates stale vectors", () => {
    const store = createStore();
    const memory = promote(store, "embedding-cleanup-failure");
    const endpointHash = createEmbeddingEndpointHash("http://127.0.0.1:11434/v1");
    const provider = {
      endpointHash,
      model: "model",
      providerKey: createProviderKey(endpointHash, "model")
    };
    store.reconcileEmbeddingJobs(provider);
    const owner = store.listEmbeddingOwners().find((item) => item.ownerId === memory.id)!;
    store.recordEmbeddingJobAttempts([
      store.listEmbeddingJobs({ ownerKind: "memory", ownerId: memory.id })[0]!
    ]);
    store.completeEmbeddingJob({
      ...owner,
      ...provider,
      providerFingerprint: createProviderFingerprint(endpointHash, "model", 1),
      dimension: 1,
      vectorBlob: encodeFloat32Vector([1])
    });
    store.db.prepare(
      "update embedding_jobs set updated_at = ?, completed_at = ? where owner_kind = 'memory' and owner_id = ?"
    ).run("2026-07-12T19:00:00.000Z", "2026-07-12T19:00:00.000Z", memory.id);
    store.db.prepare(
      "update embedding_vectors set created_at = ?, updated_at = ? where owner_kind = 'memory' and owner_id = ?"
    ).run("2026-07-12T19:00:00.000Z", "2026-07-12T19:00:00.000Z", memory.id);
    store.db.exec(`
      create trigger fail_embedding_job_cleanup
      before delete on embedding_jobs when old.owner_kind = 'memory' and old.owner_id = '${memory.id}'
      begin select raise(abort, 'injected embedding cleanup failure'); end;
      create trigger fail_embedding_vector_cleanup
      before delete on embedding_vectors when old.owner_kind = 'memory' and old.owner_id = '${memory.id}'
      begin select raise(abort, 'injected embedding cleanup failure'); end;
    `);

    expect(updateMemoryStatus(store, {
      memoryId: memory.id,
      status: "retracted",
      reason: "No longer trusted",
      now: "2026-07-12T20:09:00.000Z"
    })).toMatchObject({ lifecycleStatus: "retracted" });
    expect(store.readMemory(memory.id)).toMatchObject({ lifecycleStatus: "retracted" });
    expect(store.listEmbeddingVectors({ ownerKind: "memory", ownerId: memory.id })).toHaveLength(1);
    expect(store.listActiveEmbeddingVectors({ ownerKind: "memory", ownerId: memory.id })).toEqual([]);

    expect(updateMemoryStatus(store, {
      memoryId: memory.id,
      status: "current",
      reason: "Verified again",
      now: "2026-07-12T20:10:00.000Z"
    })).toMatchObject({ lifecycleStatus: "current" });
    expect(store.listEmbeddingVectors({ ownerKind: "memory", ownerId: memory.id })).toHaveLength(1);
    expect(store.listActiveEmbeddingVectors({ ownerKind: "memory", ownerId: memory.id })).toEqual([]);

    store.db.exec("drop trigger fail_embedding_job_cleanup; drop trigger fail_embedding_vector_cleanup");
    expect(store.reconcileEmbeddingJobs(provider)).toMatchObject({
      enqueued: 1,
      removedJobs: 1,
      removedVectors: 1
    });
    expect(store.listEmbeddingVectors({ ownerKind: "memory", ownerId: memory.id })).toEqual([]);
    expect(store.listEmbeddingJobs({ ownerKind: "memory", ownerId: memory.id })).toEqual([
      expect.objectContaining({ state: "pending", attempts: 0 })
    ]);
    store.close();
  });

  it("preserves a fresh generation created by another connection before stale cleanup runs", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const staleStore = openMemoryStore(rootDir);
    staleStore.init();
    const freshStore = openMemoryStore(rootDir);
    freshStore.init();
    const memory = promote(staleStore, "cleanup-interleaving");
    const endpointHash = createEmbeddingEndpointHash("http://127.0.0.1:11434/v1");
    const provider = {
      endpointHash,
      model: "model",
      providerKey: createProviderKey(endpointHash, "model")
    };
    staleStore.reconcileEmbeddingJobs(provider);
    const staleOwner = staleStore.listEmbeddingOwners().find((owner) => owner.ownerId === memory.id)!;
    staleStore.recordEmbeddingJobAttempts([
      staleStore.listEmbeddingJobs({ ownerKind: "memory", ownerId: memory.id })[0]!
    ]);
    staleStore.completeEmbeddingJob({
      ...staleOwner,
      ...provider,
      providerFingerprint: createProviderFingerprint(endpointHash, "model", 1),
      dimension: 1,
      vectorBlob: encodeFloat32Vector([1])
    });

    const deleteJobs = staleStore.deleteStaleEmbeddingJobsForMemory.bind(staleStore);
    let freshGeneration = "";
    staleStore.deleteStaleEmbeddingJobsForMemory = (memoryId) => {
      const reactivated = freshStore.updateMemoryLifecycle(memory.id, {
        lifecycleStatus: "current",
        validUntil: null,
        statusReason: "Reactivated concurrently",
        statusChangedAt: "2026-07-12T20:10:00.000Z"
      });
      freshGeneration = reactivated.lifecycleGeneration;
      freshStore.reconcileEmbeddingJobs(provider);
      const freshOwner = freshStore.listEmbeddingOwners().find((owner) => owner.ownerId === memory.id)!;
      freshStore.recordEmbeddingJobAttempts([
        freshStore.listEmbeddingJobs({ ownerKind: "memory", ownerId: memory.id })[0]!
      ]);
      freshStore.completeEmbeddingJob({
        ...freshOwner,
        ...provider,
        providerFingerprint: createProviderFingerprint(endpointHash, "model", 1),
        dimension: 1,
        vectorBlob: encodeFloat32Vector([2])
      });
      return deleteJobs(memoryId);
    };

    updateMemoryStatus(staleStore, {
      memoryId: memory.id,
      status: "retracted",
      reason: "Trigger stale post-commit cleanup",
      now: "2026-07-12T20:09:00.000Z"
    });

    expect(freshStore.listEmbeddingJobs({ ownerKind: "memory", ownerId: memory.id })).toEqual([
      expect.objectContaining({ ownerVersion: freshGeneration, state: "complete", attempts: 1 })
    ]);
    expect(freshStore.listActiveEmbeddingVectors({ ownerKind: "memory", ownerId: memory.id })).toEqual([
      expect.objectContaining({ ownerVersion: freshGeneration })
    ]);
    freshStore.close();
    staleStore.close();
  });

  it("rejects an in-flight completion from an old lifecycle generation", async () => {
    const store = createStore();
    const memory = promote(store, "deferred-embedding-generation");
    const collidingTimestamp = memory.statusChangedAt;
    store.updateMemoryLifecycle(memory.id, {
      lifecycleStatus: "current",
      statusChangedAt: collidingTimestamp
    });
    const endpointHash = createEmbeddingEndpointHash("http://127.0.0.1:11434/v1");
    let calls = 0;
    let releaseRequest!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const provider: EmbeddingProvider = {
      endpointHash,
      providerKey: createProviderKey(endpointHash, "model"),
      isRemote: false,
      embed(inputs) {
        calls += 1;
        const result = {
          vectors: inputs.map(() => [1]),
          dimension: 1,
          providerFingerprint: createProviderFingerprint(endpointHash, "model", 1)
        };
        if (calls > 1) return Promise.resolve(result);
        markStarted();
        return new Promise((resolve) => {
          releaseRequest = () => resolve(result);
        });
      }
    };
    const config = {
      embeddings: {
        enabled: true,
        provider: "openai-compatible" as const,
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "model",
        batchSize: 16
      },
      privacy: { allowRemoteEmbeddings: false }
    };

    const staleBuild = buildEmbeddings(store, config, { provider });
    await started;
    const staleJob = store.listEmbeddingJobs({ ownerKind: "memory", ownerId: memory.id })[0]!;
    store.db.exec(`
      create trigger fail_deferred_job_cleanup
      before delete on embedding_jobs when old.owner_kind = 'memory' and old.owner_id = '${memory.id}'
      begin select raise(abort, 'injected deferred cleanup failure'); end;
      create trigger fail_deferred_vector_cleanup
      before delete on embedding_vectors when old.owner_kind = 'memory' and old.owner_id = '${memory.id}'
      begin select raise(abort, 'injected deferred cleanup failure'); end;
    `);
    updateMemoryStatus(store, {
      memoryId: memory.id,
      status: "retracted",
      reason: "Temporarily invalid",
      now: collidingTimestamp
    });
    updateMemoryStatus(store, {
      memoryId: memory.id,
      status: "current",
      reason: "Verified in a new generation",
      now: collidingTimestamp
    });

    releaseRequest();
    await staleBuild;

    expect(store.listActiveEmbeddingVectors({ ownerKind: "memory", ownerId: memory.id })).toEqual([]);
    expect(store.listEmbeddingJobs({ ownerKind: "memory", ownerId: memory.id })).toEqual([
      expect.objectContaining({ ownerVersion: staleJob.ownerVersion, state: "pending", attempts: 1 })
    ]);

    store.db.exec("drop trigger fail_deferred_job_cleanup; drop trigger fail_deferred_vector_cleanup");
    const currentOwner = store.listEmbeddingOwners().find((owner) => owner.ownerId === memory.id)!;
    expect(currentOwner.ownerVersion).not.toBe(staleJob.ownerVersion);
    expect(store.reconcileEmbeddingJobs({
      providerKey: provider.providerKey,
      endpointHash: provider.endpointHash,
      model: "model"
    })).toMatchObject({ enqueued: 1, removedJobs: 1 });
    expect(() => store.completeEmbeddingJob({
      ownerKind: staleJob.ownerKind,
      ownerId: staleJob.ownerId,
      contentHash: staleJob.contentHash,
      ownerVersion: staleJob.ownerVersion,
      providerKey: provider.providerKey,
      endpointHash: provider.endpointHash,
      model: "model",
      providerFingerprint: createProviderFingerprint(endpointHash, "model", 1),
      dimension: 1,
      vectorBlob: encodeFloat32Vector([1])
    })).toThrow("owner generation");
    expect(() => store.markEmbeddingJobFailed({
      ownerKind: staleJob.ownerKind,
      ownerId: staleJob.ownerId,
      contentHash: staleJob.contentHash,
      ownerVersion: staleJob.ownerVersion,
      providerKey: provider.providerKey,
      error: "late old-generation failure"
    })).toThrow("owner generation");
    expect(store.listEmbeddingJobs({ ownerKind: "memory", ownerId: memory.id })).toEqual([
      expect.objectContaining({ ownerVersion: currentOwner.ownerVersion, state: "pending", attempts: 0 })
    ]);

    const freshBuild = await buildEmbeddings(store, config, { provider });
    expect(freshBuild).toMatchObject({ built: 1, pending: 0, failed: 0 });
    expect(calls).toBe(2);
    expect(store.listEmbeddingJobs({ ownerKind: "memory", ownerId: memory.id })).toEqual([
      expect.objectContaining({ ownerVersion: currentOwner.ownerVersion, state: "complete", attempts: 1 })
    ]);
    expect(store.listActiveEmbeddingVectors({ ownerKind: "memory", ownerId: memory.id })).toEqual([
      expect.objectContaining({ ownerVersion: currentOwner.ownerVersion })
    ]);
    store.close();
  });
});
