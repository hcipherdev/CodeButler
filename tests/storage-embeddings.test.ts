import { afterEach, describe, expect, it } from "vitest";

import {
  createEmbeddingEndpointHash,
  createProviderFingerprint,
  createProviderKey,
  encodeFloat32Vector
} from "../src/embeddings/fingerprint.js";
import { openMemoryStore } from "../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("embedding storage", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  it("enumerates chunks and current promoted memories only", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: {
        id: "source-1",
        type: "conversation",
        title: "Embedding source",
        origin: "fixture",
        rawContent: "First chunk\n\nSecond chunk"
      },
      chunks: [{ text: "First chunk" }, { text: "Second chunk" }]
    });

    const current = promote(store, "current", "Current memory");
    const superseded = promote(store, "superseded", "Superseded memory");
    const retracted = promote(store, "retracted", "Retracted memory");
    store.updateMemoryLifecycle(superseded.id, { lifecycleStatus: "superseded" });
    store.updateMemoryLifecycle(retracted.id, { lifecycleStatus: "retracted" });
    store.upsertMemoryCandidate(memoryInput("candidate", "Candidate only"));
    store.upsertTemporaryMemory({
      kind: "task_state",
      title: "Temporary",
      summary: "Temporary memory",
      confidence: 1
    });

    expect(store.listEmbeddingOwners()).toEqual([
      expect.objectContaining({
        ownerKind: "chunk",
        ownerId: "source-1:chunk:0",
        text: "First chunk",
        ownerVersion: ""
      }),
      expect.objectContaining({
        ownerKind: "chunk",
        ownerId: "source-1:chunk:1",
        text: "Second chunk",
        ownerVersion: ""
      }),
      expect.objectContaining({
        ownerKind: "memory",
        ownerId: current.id,
        text: "Current memory\n\nSummary for Current memory\n\nReason for Current memory",
        ownerVersion: current.lifecycleGeneration
      })
    ]);
    expect(store.listEmbeddingOwners().every((owner) => /^[a-f0-9]{64}$/.test(owner.contentHash))).toBe(true);
    store.close();
  });

  it("reads active vectors with vector-scoped eligibility and rejects stale content without enumerating owners", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: { id: "scoped", type: "conversation", title: "Scoped", origin: "fixture", rawContent: "Current" },
      chunks: [{ text: "Current" }]
    });
    const owner = store.listEmbeddingOwners()[0]!;
    const provider = providerMetadata();
    store.upsertEmbeddingVector({
      ...owner, ...provider,
      providerFingerprint: createProviderFingerprint(provider.endpointHash, provider.model, 1),
      dimension: 1, vectorBlob: encodeFloat32Vector([1])
    });
    store.listEmbeddingOwners = () => { throw new Error("active reads must not enumerate owners"); };
    expect(store.listActiveEmbeddingVectors({ providerKey: provider.providerKey })).toHaveLength(1);
    store.db.prepare("update chunks set text = ? where id = ?").run("Changed behind vector", owner.ownerId);
    expect(store.listActiveEmbeddingVectors({ providerKey: provider.providerKey })).toEqual([]);
    store.close();
  });

  it("reads more than 1000 active vectors without owner enumeration or variable-limit queries", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: { id: "many-vectors", type: "conversation", title: "Many", origin: "fixture", rawContent: "many" },
      chunks: Array.from({ length: 1105 }, (_, index) => ({ text: `vector ${index}` }))
    });
    const provider = providerMetadata();
    for (const owner of store.listEmbeddingOwners()) {
      store.upsertEmbeddingVector({
        ...owner, ...provider,
        providerFingerprint: createProviderFingerprint(provider.endpointHash, provider.model, 1),
        dimension: 1, vectorBlob: encodeFloat32Vector([1])
      });
    }
    store.listEmbeddingOwners = () => { throw new Error("active reads must remain vector-scoped"); };
    expect(store.listActiveEmbeddingVectors({ providerKey: provider.providerKey })).toHaveLength(1105);
    store.close();
  });

  it("reconciles unique jobs and records complete and failed attempts", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: { id: "source-1", type: "conversation", title: "Source", origin: "fixture", rawContent: "One" },
      chunks: [{ text: "One" }]
    });
    const provider = providerMetadata();

    expect(store.reconcileEmbeddingJobs(provider)).toMatchObject({ enqueued: 1, removedJobs: 0, removedVectors: 0 });
    expect(store.reconcileEmbeddingJobs(provider)).toMatchObject({ enqueued: 0, removedJobs: 0, removedVectors: 0 });
    const [job] = store.listEmbeddingJobs();
    expect(job).toMatchObject({
      ownerKind: "chunk",
      ownerId: "source-1:chunk:0",
      providerKey: provider.providerKey,
      endpointHash: provider.endpointHash,
      model: "model",
      state: "pending",
      attempts: 0
    });

    store.recordEmbeddingJobAttempts([job!]);
    store.markEmbeddingJobFailed({
      ownerKind: job!.ownerKind,
      ownerId: job!.ownerId,
      contentHash: job!.contentHash,
      ownerVersion: job!.ownerVersion,
      providerKey: job!.providerKey,
      error: `safe failure api_key=sk-proj-abcdefghijklmnop\n${"x".repeat(2_000)}`
    });
    expect(store.listEmbeddingJobs({ state: "failed" })[0]).toMatchObject({
      state: "failed",
      attempts: 1,
      lastError: expect.stringMatching(/^safe failure /)
    });
    expect(store.listEmbeddingJobs({ state: "failed" })[0]!.lastError!.length).toBeLessThanOrEqual(1_000);
    expect(store.listEmbeddingJobs({ state: "failed" })[0]!.lastError).toContain("[REDACTED:API_KEY]");
    expect(store.listEmbeddingJobs({ state: "failed" })[0]!.lastError).not.toContain("sk-proj-abcdefghijklmnop");

    const providerFingerprint = createProviderFingerprint(provider.endpointHash, provider.model, 3);
    store.recordEmbeddingJobAttempts([job!]);
    store.completeEmbeddingJob({
      ownerKind: job!.ownerKind,
      ownerId: job!.ownerId,
      contentHash: job!.contentHash,
      ownerVersion: job!.ownerVersion,
      ...provider,
      providerFingerprint,
      dimension: 3,
      vectorBlob: encodeFloat32Vector([1, 2, 3])
    });
    expect(store.listEmbeddingJobs({ state: "complete" })[0]).toMatchObject({
      state: "complete",
      attempts: 2,
      lastError: undefined,
      providerFingerprint
    });
    expect(store.listEmbeddingVectors()).toEqual([
      expect.objectContaining({ providerFingerprint, dimension: 3 })
    ]);
    store.close();
  });

  it("stores validated Float32 blobs and deletes owner state", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: { id: "source-1", type: "conversation", title: "Source", origin: "fixture", rawContent: "One" },
      chunks: [{ text: "One" }]
    });
    const owner = store.listEmbeddingOwners()[0]!;
    const provider = providerMetadata();
    store.reconcileEmbeddingJobs(provider);
    const vector = encodeFloat32Vector([1, 2, 3]);
    const providerFingerprint = createProviderFingerprint(provider.endpointHash, provider.model, 3);

    expect(() => store.upsertEmbeddingVector({
      ...owner,
      ...provider,
      providerFingerprint: createProviderFingerprint(provider.endpointHash, provider.model, 2),
      dimension: 2,
      vectorBlob: vector
    })).toThrow("Float32 vector byte length");
    store.upsertEmbeddingVector({
      ...owner,
      ...provider,
      providerFingerprint,
      dimension: 3,
      vectorBlob: vector
    });
    store.upsertEmbeddingVector({
      ...owner,
      ...provider,
      providerFingerprint,
      dimension: 3,
      vectorBlob: vector
    });

    expect(store.listEmbeddingVectors()).toEqual([
      expect.objectContaining({
        ownerKind: "chunk",
        ownerId: owner.ownerId,
        contentHash: owner.contentHash,
        providerFingerprint,
        dimension: 3,
        vectorBlob: expect.any(Uint8Array)
      })
    ]);
    expect(store.deleteEmbeddingVectorsForOwner("chunk", owner.ownerId)).toBe(1);
    expect(store.deleteEmbeddingJobsForOwner("chunk", owner.ownerId)).toBe(1);
    expect(store.listEmbeddingVectors()).toEqual([]);
    expect(store.listEmbeddingJobs()).toEqual([]);
    store.close();
  });

  it("reconciliation removes stale content and ineligible owners for only the active provider key", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: { id: "source-1", type: "conversation", title: "Source", origin: "fixture", rawContent: "Old" },
      chunks: [{ text: "Old" }]
    });
    const provider = providerMetadata();
    const other = providerMetadata("http://127.0.0.1:11435/v1", "other-model");
    store.reconcileEmbeddingJobs(provider);
    store.reconcileEmbeddingJobs(other);
    const oldOwner = store.listEmbeddingOwners()[0]!;
    store.upsertEmbeddingVector({
      ...oldOwner,
      ...provider,
      providerFingerprint: createProviderFingerprint(provider.endpointHash, provider.model, 1),
      dimension: 1,
      vectorBlob: encodeFloat32Vector([1])
    });
    store.addSourceWithChunks({
      source: { id: "source-1", type: "conversation", title: "Source", origin: "fixture", rawContent: "New" },
      chunks: [{ text: "New" }]
    });

    expect(store.reconcileEmbeddingJobs(provider)).toMatchObject({ enqueued: 1, removedJobs: 1, removedVectors: 1 });
    expect(store.listEmbeddingJobs({ providerKey: provider.providerKey })[0]!.state).toBe("pending");
    expect(store.listEmbeddingJobs({ providerKey: other.providerKey })).toHaveLength(1);
    store.close();
  });

  it("rejects provider keys and full fingerprints that do not match their metadata", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: { id: "source-1", type: "conversation", title: "Source", origin: "fixture", rawContent: "One" },
      chunks: [{ text: "One" }]
    });
    const owner = store.listEmbeddingOwners()[0]!;
    const provider = providerMetadata();

    expect(() => store.reconcileEmbeddingJobs({ ...provider, providerKey: "mismatched-key" })).toThrow(
      "providerKey does not match endpointHash and model"
    );
    store.reconcileEmbeddingJobs(provider);
    expect(() => store.upsertEmbeddingVector({
      ...owner,
      ...provider,
      providerKey: "mismatched-key",
      providerFingerprint: createProviderFingerprint(provider.endpointHash, provider.model, 1),
      dimension: 1,
      vectorBlob: encodeFloat32Vector([1])
    })).toThrow("providerKey does not match endpointHash and model");
    expect(() => store.upsertEmbeddingVector({
      ...owner,
      ...provider,
      providerFingerprint: "mismatched-fingerprint",
      dimension: 1,
      vectorBlob: encodeFloat32Vector([1])
    })).toThrow("providerFingerprint does not match endpointHash, model, and dimension");
    store.close();
  });

  it("rolls back vector insertion when atomic job completion fails", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: { id: "source-1", type: "conversation", title: "Source", origin: "fixture", rawContent: "One" },
      chunks: [{ text: "One" }]
    });
    const provider = providerMetadata();
    store.reconcileEmbeddingJobs(provider);
    const job = store.listEmbeddingJobs()[0]!;
    const completion = {
      ownerKind: job.ownerKind,
      ownerId: job.ownerId,
      contentHash: job.contentHash,
      ownerVersion: job.ownerVersion,
      ...provider,
      providerFingerprint: createProviderFingerprint(provider.endpointHash, provider.model, 2),
      dimension: 2,
      vectorBlob: encodeFloat32Vector([1, 0])
    };
    store.db.exec(`
      create trigger fail_embedding_completion
      before update of state on embedding_jobs when new.state = 'complete'
      begin select raise(abort, 'injected completion failure'); end;
    `);

    store.recordEmbeddingJobAttempts([job]);
    expect(() => store.completeEmbeddingJob(completion)).toThrow("injected completion failure");
    expect(store.listEmbeddingVectors()).toEqual([]);
    expect(store.listEmbeddingJobs()[0]).toMatchObject({ state: "pending", attempts: 1 });

    store.db.exec("drop trigger fail_embedding_completion");
    store.completeEmbeddingJob(completion);
    expect(store.listEmbeddingVectors()).toHaveLength(1);
    expect(store.listEmbeddingJobs()[0]).toMatchObject({ state: "complete", attempts: 1 });
    store.close();
  });

  it("prevents completed and stale workers from changing terminal job state", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: { id: "source-1", type: "conversation", title: "Source", origin: "fixture", rawContent: "Old" },
      chunks: [{ text: "Old" }]
    });
    const provider = providerMetadata();
    store.reconcileEmbeddingJobs(provider);
    const oldJob = store.listEmbeddingJobs()[0]!;
    const completion = {
      ownerKind: oldJob.ownerKind,
      ownerId: oldJob.ownerId,
      contentHash: oldJob.contentHash,
      ownerVersion: oldJob.ownerVersion,
      ...provider,
      providerFingerprint: createProviderFingerprint(provider.endpointHash, provider.model, 1),
      dimension: 1,
      vectorBlob: encodeFloat32Vector([1])
    };
    store.recordEmbeddingJobAttempts([oldJob]);
    store.completeEmbeddingJob(completion);

    expect(() => store.completeEmbeddingJob(completion)).toThrow("Embedding job must be pending or failed");
    expect(() => store.markEmbeddingJobFailed({
      ownerKind: oldJob.ownerKind,
      ownerId: oldJob.ownerId,
      contentHash: oldJob.contentHash,
      ownerVersion: oldJob.ownerVersion,
      providerKey: oldJob.providerKey,
      error: "late failure"
    })).toThrow("Embedding job must be pending or failed");
    expect(store.listEmbeddingJobs()[0]).toMatchObject({ state: "complete", attempts: 1 });

    store.addSourceWithChunks({
      source: { id: "source-1", type: "conversation", title: "Source", origin: "fixture", rawContent: "New" },
      chunks: [{ text: "New" }]
    });
    store.reconcileEmbeddingJobs(provider);
    expect(() => store.completeEmbeddingJob(completion)).toThrow("Embedding job not found");
    expect(store.listEmbeddingVectors()).toEqual([]);
    expect(store.listEmbeddingJobs()).toEqual([
      expect.objectContaining({ state: "pending", attempts: 0 })
    ]);
    store.close();
  });

  it("validates one embedding owner without enumerating all owners", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: {
        id: "targeted-owner-source",
        type: "conversation",
        title: "Targeted owner",
        origin: "fixture",
        rawContent: "Targeted owner content"
      },
      chunks: [{ text: "Targeted owner content" }]
    });
    const provider = providerMetadata();
    store.reconcileEmbeddingJobs(provider);
    const job = store.listEmbeddingJobs()[0]!;
    store.listEmbeddingOwners = () => {
      throw new Error("owner validation must not enumerate all owners");
    };

    store.recordEmbeddingJobAttempts([job]);
    store.markEmbeddingJobFailed({
      ownerKind: job.ownerKind,
      ownerId: job.ownerId,
      contentHash: job.contentHash,
      ownerVersion: job.ownerVersion,
      providerKey: job.providerKey,
      error: "targeted failure"
    });
    store.recordEmbeddingJobAttempts([job]);
    store.completeEmbeddingJob({
      ownerKind: job.ownerKind,
      ownerId: job.ownerId,
      contentHash: job.contentHash,
      ownerVersion: job.ownerVersion,
      ...provider,
      providerFingerprint: createProviderFingerprint(provider.endpointHash, provider.model, 1),
      dimension: 1,
      vectorBlob: encodeFloat32Vector([1])
    });

    expect(store.listEmbeddingJobs()[0]).toMatchObject({ state: "complete", attempts: 2 });
    store.close();
  });

  it("keeps unchanged chunk vectors while invalidating only changed chunk content", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: { id: "source-1", type: "conversation", title: "Source", origin: "fixture", rawContent: "stable old" },
      chunks: [{ text: "stable" }, { text: "old" }]
    });
    const provider = providerMetadata();
    store.reconcileEmbeddingJobs(provider);
    store.recordEmbeddingJobAttempts(store.listEmbeddingJobs({ providerKey: provider.providerKey }));
    for (const owner of store.listEmbeddingOwners()) {
      store.completeEmbeddingJob({
        ...owner,
        ...provider,
        providerFingerprint: createProviderFingerprint(provider.endpointHash, provider.model, 1),
        dimension: 1,
        vectorBlob: encodeFloat32Vector([1])
      });
    }

    store.addSourceWithChunks({
      source: { id: "source-1", type: "conversation", title: "Source", origin: "fixture", rawContent: "stable new" },
      chunks: [{ text: "stable" }, { text: "new" }]
    });
    expect(store.reconcileEmbeddingJobs(provider)).toMatchObject({ enqueued: 1, removedJobs: 1, removedVectors: 1 });

    expect(store.listEmbeddingVectors({ providerKey: provider.providerKey })).toEqual([
      expect.objectContaining({ ownerId: "source-1:chunk:0" })
    ]);
    expect(store.listEmbeddingJobs({ providerKey: provider.providerKey })).toEqual([
      expect.objectContaining({ ownerId: "source-1:chunk:0", state: "complete" }),
      expect.objectContaining({ ownerId: "source-1:chunk:1", state: "pending", attempts: 0 })
    ]);
    store.close();
  });

  it("atomically retires one provider index and requeues every current owner without resetting attempts", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: { id: "source-1", type: "conversation", title: "Source", origin: "fixture", rawContent: "one two" },
      chunks: [{ text: "one" }, { text: "two" }]
    });
    const provider = providerMetadata();
    const other = providerMetadata("http://127.0.0.1:11435/v1", "other-model");
    store.reconcileEmbeddingJobs(provider);
    store.reconcileEmbeddingJobs(other);
    const jobs = store.listEmbeddingJobs({ providerKey: provider.providerKey });
    store.recordEmbeddingJobAttempts(jobs);
    for (const owner of store.listEmbeddingOwners()) {
      store.completeEmbeddingJob({
        ...owner,
        ...provider,
        providerFingerprint: createProviderFingerprint(provider.endpointHash, provider.model, 2),
        dimension: 2,
        vectorBlob: encodeFloat32Vector([1, 0])
      });
    }

    const rebuilt = store.beginEmbeddingIndexRebuild(provider);
    expect(rebuilt).toMatchObject({ removedVectors: 2, requeued: 2, rebuildToken: expect.any(String) });
    expect(store.listEmbeddingVectors({ providerKey: provider.providerKey })).toEqual([]);
    expect(store.listEmbeddingJobs({ providerKey: provider.providerKey })).toEqual([
      expect.objectContaining({ state: "pending", attempts: 1, providerFingerprint: undefined, indexGeneration: rebuilt.rebuildToken, targetFingerprint: undefined }),
      expect.objectContaining({ state: "pending", attempts: 1, providerFingerprint: undefined, indexGeneration: rebuilt.rebuildToken, targetFingerprint: undefined })
    ]);
    expect(store.listEmbeddingJobs({ providerKey: other.providerKey })).toHaveLength(2);
    store.close();
  });

  it("guards a replacement index from stale completions and failures with a persisted generation target", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: { id: "source-1", type: "conversation", title: "Source", origin: "fixture", rawContent: "one" },
      chunks: [{ text: "one" }]
    });
    const provider = providerMetadata();
    store.reconcileEmbeddingJobs(provider);
    const staleJob = store.listEmbeddingJobs()[0]!;
    store.recordEmbeddingJobAttempts([staleJob]);
    const rebuilt = store.beginEmbeddingIndexRebuild(provider);
    const targetFingerprint = createProviderFingerprint(provider.endpointHash, provider.model, 3);
    expect(store.activateEmbeddingIndexRebuild({
      providerKey: provider.providerKey,
      rebuildToken: rebuilt.rebuildToken,
      providerFingerprint: targetFingerprint
    })).toBe(1);
    expect(() => store.activateEmbeddingIndexRebuild({
      providerKey: provider.providerKey,
      rebuildToken: rebuilt.rebuildToken,
      providerFingerprint: createProviderFingerprint(provider.endpointHash, provider.model, 4)
    })).toThrow(/different target/i);

    const staleCompletion = {
      ...store.listEmbeddingOwners()[0]!,
      ...provider,
      indexGeneration: staleJob.indexGeneration,
      providerFingerprint: createProviderFingerprint(provider.endpointHash, provider.model, 2),
      dimension: 2,
      vectorBlob: encodeFloat32Vector([1, 0])
    };
    expect(() => store.completeEmbeddingJob(staleCompletion)).toThrow(/generation|target/i);
    expect(() => store.markEmbeddingJobFailed({
      ...staleJob,
      error: "stale failure"
    })).toThrow(/generation/i);

    const currentJob = store.listEmbeddingJobs()[0]!;
    expect(() => store.completeEmbeddingJob({
      ...staleCompletion,
      indexGeneration: currentJob.indexGeneration
    })).toThrow(/target/i);
    store.markEmbeddingJobFailed({ ...currentJob, error: "retryable target failure" });
    expect(store.listEmbeddingJobs()[0]).toMatchObject({
      state: "failed",
      targetFingerprint,
      lastError: "retryable target failure"
    });
    store.recordEmbeddingJobAttempts(store.listEmbeddingJobs());
    store.completeEmbeddingJob({
      ...store.listEmbeddingOwners()[0]!,
      ...provider,
      indexGeneration: currentJob.indexGeneration,
      providerFingerprint: targetFingerprint,
      dimension: 3,
      vectorBlob: encodeFloat32Vector([1, 0, 0])
    });
    expect(store.listActiveEmbeddingVectors()).toEqual([
      expect.objectContaining({ providerFingerprint: targetFingerprint, dimension: 3 })
    ]);
    store.close();
  });

  it("excludes stale content and inactive memories from active vector reads before reconciliation", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: { id: "source-1", type: "conversation", title: "Source", origin: "fixture", rawContent: "old" },
      chunks: [{ text: "old" }]
    });
    const memory = promote(store, "active-vector", "Active vector memory");
    const provider = providerMetadata();
    store.reconcileEmbeddingJobs(provider);
    store.recordEmbeddingJobAttempts(store.listEmbeddingJobs({ providerKey: provider.providerKey }));
    for (const owner of store.listEmbeddingOwners()) {
      store.completeEmbeddingJob({
        ...owner,
        ...provider,
        providerFingerprint: createProviderFingerprint(provider.endpointHash, provider.model, 1),
        dimension: 1,
        vectorBlob: encodeFloat32Vector([1])
      });
    }

    store.addSourceWithChunks({
      source: { id: "source-1", type: "conversation", title: "Source", origin: "fixture", rawContent: "new" },
      chunks: [{ text: "new" }]
    });
    store.updateMemoryLifecycle(memory.id, { lifecycleStatus: "retracted" });

    expect(store.listEmbeddingVectors({ providerKey: provider.providerKey })).toHaveLength(2);
    expect(store.listActiveEmbeddingVectors({ providerKey: provider.providerKey })).toEqual([]);
    store.close();
  });

  it("reconciles same-content memory embedding state from a different lifecycle generation", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    const memory = promote(store, "lifecycle-epoch", "Lifecycle epoch memory");
    const provider = providerMetadata();
    store.reconcileEmbeddingJobs(provider);
    const owner = store.listEmbeddingOwners()[0]!;
    store.recordEmbeddingJobAttempts(store.listEmbeddingJobs({ providerKey: provider.providerKey }));
    store.completeEmbeddingJob({
      ...owner,
      ...provider,
      providerFingerprint: createProviderFingerprint(provider.endpointHash, provider.model, 1),
      dimension: 1,
      vectorBlob: encodeFloat32Vector([1])
    });
    store.db.prepare(
      "update embedding_jobs set updated_at = ?, completed_at = ? where owner_kind = 'memory' and owner_id = ?"
    ).run("2026-07-12T20:00:00.000Z", "2026-07-12T20:00:00.000Z", memory.id);
    store.db.prepare(
      "update embedding_vectors set created_at = ?, updated_at = ? where owner_kind = 'memory' and owner_id = ?"
    ).run("2026-07-12T20:00:00.000Z", "2026-07-12T20:00:00.000Z", memory.id);
    store.updateMemoryLifecycle(memory.id, {
      lifecycleStatus: "current",
      statusChangedAt: "2026-07-12T20:00:00.000Z"
    });

    expect(store.listActiveEmbeddingVectors({ providerKey: provider.providerKey })).toEqual([]);
    expect(store.reconcileEmbeddingJobs(provider)).toMatchObject({
      enqueued: 1,
      removedJobs: 1,
      removedVectors: 1
    });
    expect(store.listEmbeddingVectors({ providerKey: provider.providerKey })).toEqual([]);
    expect(store.listEmbeddingJobs({ providerKey: provider.providerKey })).toEqual([
      expect.objectContaining({ ownerId: memory.id, state: "pending", attempts: 0 })
    ]);
    store.close();
  });
});

function memoryInput(key: string, title: string) {
  return {
    type: "decision" as const,
    title,
    summary: `Summary for ${title}`,
    reason: `Reason for ${title}`,
    confidence: 1,
    evidence: [],
    relatedFiles: [],
    dedupeKey: key
  };
}

function promote(store: ReturnType<typeof openMemoryStore>, key: string, title: string) {
  const candidate = store.upsertMemoryCandidate(memoryInput(key, title));
  return store.promoteMemoryCandidate(candidate.id);
}

function providerMetadata(baseUrl = "http://127.0.0.1:11434/v1", model = "model") {
  const endpointHash = createEmbeddingEndpointHash(baseUrl);
  return {
    endpointHash,
    model,
    providerKey: createProviderKey(endpointHash, model)
  };
}
