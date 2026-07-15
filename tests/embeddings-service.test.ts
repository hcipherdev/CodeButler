import { afterEach, describe, expect, it } from "vitest";

import { buildEmbeddings, getEmbeddingStatus } from "../src/embeddings/service.js";
import {
  createEmbeddingEndpointHash,
  createProviderFingerprint,
  createProviderKey
} from "../src/embeddings/fingerprint.js";
import { openMemoryStore } from "../src/storage/store.js";
import type { EmbeddingProvider, ProjectConfig } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("embedding build service", () => {
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

  it("does not construct a provider or mutate embedding/FTS state when disabled", async () => {
    const store = createStore();
    addChunks(store, ["search needle"]);
    let factoryCalls = 0;

    const result = await buildEmbeddings(store, embeddingConfig(false), {
      providerFactory() {
        factoryCalls += 1;
        throw new Error("must not construct");
      }
    });

    expect(result).toMatchObject({ enabled: false, eligible: 1, activeCoverage: 0, usable: false, pending: 0, complete: 0, failed: 0, built: 0 });
    expect(result.warnings).toContain("Embeddings are disabled");
    expect(factoryCalls).toBe(0);
    expect(store.listEmbeddingJobs()).toEqual([]);
    expect(store.search({ query: "needle" })).toHaveLength(1);
    store.close();
  });

  it("reports active current-owner coverage instead of stale complete job counts", async () => {
    const store = createStore();
    addChunks(store, ["old content"]);
    const provider = fakeProvider("model", async (inputs) => vectorsFor(inputs, provider, "model", 2));
    const config = embeddingConfig(true);
    await buildEmbeddings(store, config, { provider });
    addChunks(store, ["new content"]);

    expect(getEmbeddingStatus(store, config, { provider })).toMatchObject({ eligible: 1, complete: 1, activeCoverage: 0 });
    store.close();
  });

  it("builds deterministic batches and keeps provider/model job state separate", async () => {
    const store = createStore();
    addChunks(store, ["one", "two", "three"]);
    const calls: string[][] = [];
    const provider = fakeProvider("model-a", async (inputs) => {
      calls.push(inputs);
      return vectorsFor(inputs, provider, "model-a", 2);
    });
    const config = embeddingConfig(true, { model: "model-a", batchSize: 2 });

    const result = await buildEmbeddings(store, config, { provider });

    expect(calls).toEqual([["one", "two"], ["three"]]);
    expect(result).toMatchObject({
      enabled: true,
      eligible: 3,
      pending: 0,
      complete: 3,
      failed: 0,
      built: 3,
      retried: 0,
      attempts: 3,
      providerKey: provider.providerKey,
      model: "model-a",
      dimension: 2,
      providerFingerprint: createProviderFingerprint(provider.endpointHash, "model-a", 2)
    });
    expect(getEmbeddingStatus(store, config, { provider })).toMatchObject({
      dimension: 2,
      providerFingerprint: createProviderFingerprint(provider.endpointHash, "model-a", 2)
    });

    const other = fakeProvider("model-b", async (inputs) => vectorsFor(inputs, other, "model-b", 2));
    await buildEmbeddings(store, embeddingConfig(true, { model: "model-b" }), { provider: other });
    expect(store.listEmbeddingJobs({ providerKey: provider.providerKey })).toHaveLength(3);
    expect(store.listEmbeddingJobs({ providerKey: other.providerKey })).toHaveLength(3);
    store.close();
  });

  it("marks a failed batch once per owner, sanitizes warnings, and retries failed jobs", async () => {
    const store = createStore();
    addChunks(store, ["one", "two"]);
    let fail = true;
    const provider = fakeProvider("model", async (inputs) => {
      if (fail) throw new Error("provider leaked api_key=sk-proj-abcdefghijklmnop");
      return vectorsFor(inputs, provider, "model", 3);
    });

    const failed = await buildEmbeddings(store, embeddingConfig(true), { provider });
    expect(failed).toMatchObject({ pending: 0, complete: 0, failed: 2, built: 0, retried: 0, attempts: 2, activeCoverage: 0, usable: true });
    expect(failed.warnings.join(" ")).toContain("[REDACTED:API_KEY]");
    expect(failed.warnings.join(" ")).not.toContain("sk-proj-abcdefghijklmnop");
    expect(store.listEmbeddingJobs({ state: "failed" }).map((job) => job.attempts)).toEqual([1, 1]);

    fail = false;
    const retried = await buildEmbeddings(store, embeddingConfig(true), { provider });
    expect(retried).toMatchObject({ pending: 0, complete: 2, failed: 0, built: 2, retried: 2, attempts: 4 });
    expect(store.listEmbeddingJobs({ state: "complete" }).map((job) => job.attempts)).toEqual([2, 2]);
    store.close();
  });

  it("rebuilds an already mixed active index into the provider's current fingerprint", async () => {
    const store = createStore();
    addChunks(store, ["one", "two"]);
    const provider = fakeProvider("model", async (inputs) => vectorsFor(inputs, provider, "model", 2));
    const owners = store.listEmbeddingOwners();
    for (const [index, owner] of owners.entries()) {
      const dimension = index + 2;
      store.upsertEmbeddingVector({ ...owner, providerKey: provider.providerKey, endpointHash: provider.endpointHash, model: "model", providerFingerprint: createProviderFingerprint(provider.endpointHash, "model", dimension), dimension, vectorBlob: new Uint8Array(dimension * 4) });
    }

    const result = await buildEmbeddings(store, embeddingConfig(true), { provider });

    expect(result).toMatchObject({
      usable: true,
      eligible: 2,
      activeCoverage: 2,
      pending: 0,
      complete: 2,
      failed: 0,
      built: 2,
      dimension: 2,
      providerFingerprint: createProviderFingerprint(provider.endpointHash, "model", 2)
    });
    expect(store.listEmbeddingVectors().map((vector) => vector.dimension)).toEqual([2, 2]);
    expect(new Set(store.listEmbeddingVectors().map((vector) => vector.providerFingerprint))).toEqual(
      new Set([createProviderFingerprint(provider.endpointHash, "model", 2)])
    );
    store.close();
  });

  it("redacts exact owner inputs from provider errors before warning and failure persistence", async () => {
    const store = createStore();
    const rawInput = "Private release note: rotate the orchard token before launch.";
    addChunks(store, [rawInput]);
    const provider = fakeProvider("model", async () => {
      throw new Error(`provider echoed input: ${rawInput}`);
    });

    const result = await buildEmbeddings(store, embeddingConfig(true), { provider });

    expect(result.warnings.join(" ")).toContain("[REDACTED:EMBEDDING_INPUT]");
    expect(result.warnings.join(" ")).not.toContain(rawInput);
    expect(store.listEmbeddingJobs({ state: "failed" })[0]!.lastError).toContain(
      "[REDACTED:EMBEDDING_INPUT]"
    );
    expect(store.listEmbeddingJobs({ state: "failed" })[0]!.lastError).not.toContain(rawInput);
    store.close();
  });

  it("never mixes dimensions/fingerprints and warns when provider construction is unavailable", async () => {
    const store = createStore();
    addChunks(store, ["one", "two"]);
    let call = 0;
    const provider = fakeProvider("model", async (inputs) => {
      call += 1;
      if (call === 1) return vectorsFor(inputs, provider, "model", 2);
      return {
        vectors: inputs.map(() => [1, 2, 3]),
        dimension: 3,
        providerFingerprint: "not-the-full-fingerprint"
      };
    });

    const mixed = await buildEmbeddings(store, embeddingConfig(true, { batchSize: 1 }), { provider });
    expect(mixed).toMatchObject({ complete: 1, failed: 1, built: 1, attempts: 2, dimension: 2 });
    expect(mixed.warnings.join(" ")).toMatch(/dimension|fingerprint/i);
    expect(store.listEmbeddingVectors()).toHaveLength(1);

    const unavailableStore = createStore();
    addChunks(unavailableStore, ["still searchable"]);
    const unavailable = await buildEmbeddings(unavailableStore, embeddingConfig(true), {
      providerFactory() {
        throw new Error("missing api_key=sk-proj-abcdefghijklmnop");
      }
    });
    expect(unavailable).toMatchObject({ eligible: 1, pending: 0, complete: 0, failed: 0, built: 0 });
    expect(unavailable.warnings.join(" ")).toContain("[REDACTED:API_KEY]");
    expect(unavailableStore.listEmbeddingJobs()).toEqual([]);
    expect(getEmbeddingStatus(unavailableStore, embeddingConfig(true), {
      providerFactory: () => { throw new Error("unavailable"); }
    })).toMatchObject({ enabled: true, eligible: 1, pending: 0, complete: 0, failed: 0 });
    expect(unavailableStore.search({ query: "searchable" })).toHaveLength(1);
    store.close();
    unavailableStore.close();
  });

  it("reports persisted provider state when provider construction is unavailable", async () => {
    const store = createStore();
    addChunks(store, ["complete", "failed", "pending"]);
    const config = embeddingConfig(true);
    const provider = fakeProvider("model", async (inputs) => vectorsFor(inputs, provider, "model", 2));
    store.reconcileEmbeddingJobs({
      providerKey: provider.providerKey,
      endpointHash: provider.endpointHash,
      model: config.embeddings.model
    });
    const [complete, failed] = store.listEmbeddingJobs({ providerKey: provider.providerKey });
    const providerFingerprint = createProviderFingerprint(provider.endpointHash, "model", 2);
    store.recordEmbeddingJobAttempts([complete!, failed!]);
    store.completeEmbeddingJob({
      ownerKind: complete!.ownerKind,
      ownerId: complete!.ownerId,
      contentHash: complete!.contentHash,
      ownerVersion: complete!.ownerVersion,
      providerKey: provider.providerKey,
      endpointHash: provider.endpointHash,
      model: "model",
      providerFingerprint,
      dimension: 2,
      vectorBlob: new Uint8Array(new Float32Array([1, 0]).buffer)
    });
    store.markEmbeddingJobFailed({
      ownerKind: failed!.ownerKind,
      ownerId: failed!.ownerId,
      contentHash: failed!.contentHash,
      ownerVersion: failed!.ownerVersion,
      providerKey: provider.providerKey,
      error: "provider failed"
    });
    const unavailableFactory = () => {
      throw new Error("missing api_key=sk-proj-abcdefghijklmnop");
    };

    const built = await buildEmbeddings(store, config, { providerFactory: unavailableFactory });
    expect(built).toMatchObject({
      enabled: true,
      eligible: 3,
      pending: 1,
      complete: 1,
      failed: 1,
      attempts: 2,
      built: 0,
      providerKey: provider.providerKey,
      model: "model",
      dimension: 2,
      providerFingerprint
    });
    expect(built.warnings.join(" ")).toContain("[REDACTED:API_KEY]");
    expect(getEmbeddingStatus(store, config, { providerFactory: unavailableFactory })).toMatchObject({
      pending: 1,
      complete: 1,
      failed: 1,
      attempts: 2,
      providerKey: provider.providerKey,
      model: "model",
      dimension: 2,
      providerFingerprint
    });
    store.close();
  });

  it("rebuilds every eligible owner when a changed owner reveals provider dimension drift", async () => {
    const store = createStore();
    addChunks(store, ["stable"]);
    const firstProvider = fakeProvider("model", async (inputs) => vectorsFor(inputs, firstProvider, "model", 2));
    await buildEmbeddings(store, embeddingConfig(true), { provider: firstProvider });

    addChunks(store, ["stable", "new"]);
    const changedProvider = fakeProvider("model", async (inputs) => vectorsFor(inputs, changedProvider, "model", 3));
    const result = await buildEmbeddings(store, embeddingConfig(true), { provider: changedProvider });

    expect(result).toMatchObject({
      usable: true,
      eligible: 2,
      activeCoverage: 2,
      pending: 0,
      complete: 2,
      failed: 0,
      built: 2,
      retried: 1,
      dimension: 3,
      providerFingerprint: createProviderFingerprint(changedProvider.endpointHash, "model", 3)
    });
    expect(store.listEmbeddingJobs().map((job) => job.state)).toEqual(["complete", "complete"]);
    expect(store.listEmbeddingVectors().map((vector) => vector.dimension)).toEqual([3, 3]);
    expect(new Set(store.listActiveEmbeddingVectors().map((vector) => vector.providerFingerprint))).toEqual(
      new Set([createProviderFingerprint(changedProvider.endpointHash, "model", 3)])
    );
    store.close();
  });

  it("keeps a fresh index single-fingerprint when two builders race their first dimensions", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const setupStore = openMemoryStore(rootDir);
    setupStore.init();
    addChunks(setupStore, ["one", "two", "three"]);
    setupStore.close();

    const dimTwoStore = openMemoryStore(rootDir);
    dimTwoStore.init();
    const dimThreeStore = openMemoryStore(rootDir);
    dimThreeStore.init();
    let releaseDimTwoFirst!: () => void;
    let releaseDimTwoRest!: () => void;
    let signalDimTwoStarted!: () => void;
    let signalDimTwoSecondStarted!: () => void;
    const dimTwoStarted = new Promise<void>((resolve) => { signalDimTwoStarted = resolve; });
    const dimTwoSecondStarted = new Promise<void>((resolve) => { signalDimTwoSecondStarted = resolve; });
    const dimTwoFirstRelease = new Promise<void>((resolve) => { releaseDimTwoFirst = resolve; });
    const dimTwoRestRelease = new Promise<void>((resolve) => { releaseDimTwoRest = resolve; });
    let dimTwoCalls = 0;
    const dimTwoProvider = fakeProvider("model", async (inputs) => {
      dimTwoCalls += 1;
      signalDimTwoStarted();
      if (dimTwoCalls === 1) {
        await dimTwoFirstRelease;
      } else {
        signalDimTwoSecondStarted();
        await dimTwoRestRelease;
      }
      return vectorsFor(inputs, dimTwoProvider, "model", 2);
    });
    let releaseDimThree!: () => void;
    let signalDimThreeStarted!: () => void;
    const dimThreeStarted = new Promise<void>((resolve) => { signalDimThreeStarted = resolve; });
    const dimThreeRelease = new Promise<void>((resolve) => { releaseDimThree = resolve; });
    const dimThreeProvider = fakeProvider("model", async (inputs) => {
      signalDimThreeStarted();
      await dimThreeRelease;
      return vectorsFor(inputs, dimThreeProvider, "model", 3);
    });

    const dimTwoBuild = buildEmbeddings(
      dimTwoStore,
      embeddingConfig(true, { batchSize: 1 }),
      { provider: dimTwoProvider }
    );
    await dimTwoStarted;
    const dimThreeBuild = buildEmbeddings(
      dimThreeStore,
      embeddingConfig(true, { batchSize: 1 }),
      { provider: dimThreeProvider }
    );
    await dimThreeStarted;

    releaseDimTwoFirst();
    await dimTwoSecondStarted;
    releaseDimThree();
    await dimThreeBuild;
    releaseDimTwoRest();
    const winner = await dimTwoBuild;

    expect(winner).toMatchObject({ usable: true, eligible: 3, activeCoverage: 3, complete: 3, failed: 0 });
    expect(new Set(dimThreeStore.listActiveEmbeddingVectors().map((vector) => vector.dimension)).size).toBe(1);
    expect(new Set(dimThreeStore.listActiveEmbeddingVectors().map((vector) => vector.providerFingerprint)).size).toBe(1);
    dimTwoStore.close();
    dimThreeStore.close();
  });

  it("does not retry or mix indexes when the provider changes dimension again during a rebuild", async () => {
    const store = createStore();
    addChunks(store, ["stable"]);
    const firstProvider = fakeProvider("model", async (inputs) => vectorsFor(inputs, firstProvider, "model", 2));
    await buildEmbeddings(store, embeddingConfig(true, { batchSize: 1 }), { provider: firstProvider });

    addChunks(store, ["stable", "new-one", "new-two"]);
    let calls = 0;
    const unstableProvider = fakeProvider("model", async (inputs) => {
      calls += 1;
      return vectorsFor(inputs, unstableProvider, "model", calls === 1 ? 3 : 4);
    });
    const result = await buildEmbeddings(
      store,
      embeddingConfig(true, { batchSize: 1 }),
      { provider: unstableProvider }
    );

    expect(calls).toBe(3);
    expect(result).toMatchObject({
      eligible: 3,
      activeCoverage: 1,
      pending: 0,
      complete: 1,
      failed: 2,
      attempts: 4,
      built: 1,
      dimension: 3
    });
    expect(result.warnings.join(" ")).toMatch(/dimension changed during build/i);
    expect(store.listEmbeddingVectors().map((vector) => vector.dimension)).toEqual([3]);
    expect(store.listEmbeddingJobs({ state: "failed" }).map((job) => job.attempts)).toEqual([2, 1]);
    store.close();
  });

  it("recovers a failed prior rebuild when the provider stabilizes on its newer dimension", async () => {
    const store = createStore();
    addChunks(store, ["stable"]);
    const firstProvider = fakeProvider("model", async (inputs) => vectorsFor(inputs, firstProvider, "model", 2));
    await buildEmbeddings(store, embeddingConfig(true, { batchSize: 1 }), { provider: firstProvider });

    addChunks(store, ["stable", "new-one", "new-two"]);
    let unstableCalls = 0;
    const unstableProvider = fakeProvider("model", async (inputs) => {
      unstableCalls += 1;
      return vectorsFor(inputs, unstableProvider, "model", unstableCalls === 1 ? 3 : 4);
    });
    const unstable = await buildEmbeddings(
      store,
      embeddingConfig(true, { batchSize: 1 }),
      { provider: unstableProvider }
    );
    expect(unstable).toMatchObject({ activeCoverage: 1, complete: 1, failed: 2, dimension: 3 });

    let stableCalls = 0;
    const stableProvider = fakeProvider("model", async (inputs) => {
      stableCalls += 1;
      return vectorsFor(inputs, stableProvider, "model", 4);
    });
    const recovered = await buildEmbeddings(
      store,
      embeddingConfig(true, { batchSize: 1 }),
      { provider: stableProvider }
    );

    expect(stableCalls).toBe(3);
    expect(recovered).toMatchObject({
      usable: true,
      eligible: 3,
      activeCoverage: 3,
      pending: 0,
      complete: 3,
      failed: 0,
      built: 3,
      dimension: 4,
      providerFingerprint: createProviderFingerprint(stableProvider.endpointHash, "model", 4)
    });
    expect(new Set(store.listEmbeddingVectors().map((vector) => vector.dimension))).toEqual(new Set([4]));
    store.close();
  });

  it("rotates an inherited targeted generation when every prior job failed before creating a vector", async () => {
    const store = createStore();
    addChunks(store, ["one", "two"]);
    const provider = fakeProvider("model", async (inputs) => vectorsFor(inputs, provider, "model", 4));
    store.reconcileEmbeddingJobs({
      providerKey: provider.providerKey,
      endpointHash: provider.endpointHash,
      model: "model"
    });
    const rebuilt = store.beginEmbeddingIndexRebuild({
      providerKey: provider.providerKey,
      endpointHash: provider.endpointHash,
      model: "model"
    });
    const oldTarget = createProviderFingerprint(provider.endpointHash, "model", 3);
    store.activateEmbeddingIndexRebuild({
      providerKey: provider.providerKey,
      rebuildToken: rebuilt.rebuildToken,
      providerFingerprint: oldTarget
    });
    const targetedJobs = store.listEmbeddingJobs({ providerKey: provider.providerKey });
    store.recordEmbeddingJobAttempts(targetedJobs);
    for (const job of targetedJobs) {
      store.markEmbeddingJobFailed({
        ownerKind: job.ownerKind,
        ownerId: job.ownerId,
        contentHash: job.contentHash,
        ownerVersion: job.ownerVersion,
        providerKey: job.providerKey,
        indexGeneration: job.indexGeneration,
        targetFingerprint: oldTarget,
        error: "prior provider failed"
      });
    }
    expect(store.listEmbeddingVectors()).toEqual([]);

    let calls = 0;
    const stableProvider = fakeProvider("model", async (inputs) => {
      calls += 1;
      return vectorsFor(inputs, stableProvider, "model", 4);
    });
    const result = await buildEmbeddings(store, embeddingConfig(true), { provider: stableProvider });

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      usable: true,
      eligible: 2,
      activeCoverage: 2,
      complete: 2,
      failed: 0,
      built: 2,
      retried: 2,
      dimension: 4,
      providerFingerprint: createProviderFingerprint(provider.endpointHash, "model", 4)
    });
    expect(new Set(store.listEmbeddingVectors().map((vector) => vector.dimension))).toEqual(new Set([4]));
    store.close();
  });

  it.each(["provider", "providerFactory"] as const)(
    "privacy-gates and redacts an injected remote %s",
    async (injection) => {
      const store = createStore();
      const secret = "api_key=sk-proj-abcdefghijklmnop";
      addChunks(store, [`searchable ${secret}`]);
      const persistedOwners = store.listEmbeddingOwners.bind(store);
      store.listEmbeddingOwners = () => persistedOwners().map((owner) => ({
        ...owner,
        text: `searchable ${secret}`
      }));
      const outbound: string[][] = [];
      const remote = fakeRemoteProvider("model", async (inputs) => {
        outbound.push(inputs);
        return vectorsFor(inputs, remote, "model", 2);
      });
      const blockedConfig = embeddingConfig(true, { baseUrl: "https://embeddings.example/v1" });
      const blockedOptions = injection === "provider"
        ? { provider: remote }
        : { providerFactory: () => remote };

      const blocked = await buildEmbeddings(store, blockedConfig, blockedOptions);

      expect(blocked).toMatchObject({ usable: false, eligible: 1, built: 0, activeCoverage: 0 });
      expect(blocked.warnings).toContain("Remote embeddings require privacy.allowRemoteEmbeddings=true");
      expect(outbound).toEqual([]);
      expect(store.listEmbeddingJobs()).toEqual([]);
      expect(store.search({ query: "searchable" })).toHaveLength(1);

      const allowedConfig = {
        ...blockedConfig,
        privacy: { allowRemoteEmbeddings: true }
      };
      const allowed = await buildEmbeddings(store, allowedConfig, blockedOptions);

      expect(allowed).toMatchObject({ usable: true, built: 1, activeCoverage: 1, failed: 0 });
      expect(outbound).toHaveLength(1);
      expect(outbound[0]![0]).toContain("[REDACTED:API_KEY]");
      expect(outbound[0]![0]).not.toContain("sk-proj-abcdefghijklmnop");
      store.close();
    }
  );

  it.each(["provider", "providerFactory"] as const)(
    "rejects an injected HTTPS %s that falsely claims to be local",
    async (injection) => {
      const store = createStore();
      const secret = "api_key=sk-proj-abcdefghijklmnop";
      addChunks(store, ["searchable"]);
      const persistedOwners = store.listEmbeddingOwners.bind(store);
      store.listEmbeddingOwners = () => persistedOwners().map((owner) => ({
        ...owner,
        text: `searchable ${secret}`
      }));
      const outbound: string[][] = [];
      const endpointHash = createEmbeddingEndpointHash("https://embeddings.example/v1");
      const dishonestProvider: EmbeddingProvider = {
        endpointHash,
        providerKey: createProviderKey(endpointHash, "model"),
        isRemote: false,
        async embed(inputs) {
          outbound.push(inputs);
          return vectorsFor(inputs, dishonestProvider, "model", 2);
        }
      };
      const config = {
        ...embeddingConfig(true, { baseUrl: "https://embeddings.example/v1" }),
        privacy: { allowRemoteEmbeddings: true }
      };
      const options = injection === "provider"
        ? { provider: dishonestProvider }
        : { providerFactory: () => dishonestProvider };

      const result = await buildEmbeddings(store, config, options);

      expect(result).toMatchObject({ usable: false, built: 0, activeCoverage: 0 });
      expect(result.warnings.join(" ")).toMatch(/locality.*configured endpoint/i);
      expect(outbound).toEqual([]);
      expect(store.listEmbeddingJobs()).toEqual([]);
      expect(store.search({ query: "searchable" })).toHaveLength(1);
      store.close();
    }
  );

  it("re-embeds an earlier successful batch when a later batch reveals dimension drift", async () => {
    const store = createStore();
    addChunks(store, ["existing"]);
    const firstProvider = fakeProvider("model", async (inputs) => vectorsFor(inputs, firstProvider, "model", 2));
    await buildEmbeddings(store, embeddingConfig(true, { batchSize: 1 }), { provider: firstProvider });

    addChunks(store, ["existing", "batch-a", "batch-b"]);
    let calls = 0;
    const changedProvider = fakeProvider("model", async (inputs) => {
      calls += 1;
      return vectorsFor(inputs, changedProvider, "model", calls === 1 ? 2 : 3);
    });
    const result = await buildEmbeddings(
      store,
      embeddingConfig(true, { batchSize: 1 }),
      { provider: changedProvider }
    );

    expect(calls).toBe(4);
    expect(result).toMatchObject({
      usable: true,
      eligible: 3,
      activeCoverage: 3,
      pending: 0,
      complete: 3,
      failed: 0,
      built: 3,
      dimension: 3
    });
    expect(store.listEmbeddingVectors().map((vector) => vector.dimension)).toEqual([3, 3, 3]);
    store.close();
  });

  it("rejects an old in-flight response after another builder activates a replacement index", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const setupStore = openMemoryStore(rootDir);
    setupStore.init();
    addChunks(setupStore, ["existing"]);
    const firstProvider = fakeProvider("model", async (inputs) => vectorsFor(inputs, firstProvider, "model", 2));
    await buildEmbeddings(setupStore, embeddingConfig(true, { batchSize: 1 }), { provider: firstProvider });
    addChunks(setupStore, ["existing", "new-one", "new-two"]);
    setupStore.close();

    const oldStore = openMemoryStore(rootDir);
    oldStore.init();
    const replacementStore = openMemoryStore(rootDir);
    replacementStore.init();
    let releaseOld!: () => void;
    let signalOldStarted!: () => void;
    const oldStarted = new Promise<void>((resolve) => { signalOldStarted = resolve; });
    const oldRelease = new Promise<void>((resolve) => { releaseOld = resolve; });
    const oldProvider = fakeProvider("model", async (inputs) => {
      signalOldStarted();
      await oldRelease;
      return vectorsFor(inputs, oldProvider, "model", 2);
    });
    const oldBuild = buildEmbeddings(
      oldStore,
      embeddingConfig(true, { batchSize: 1 }),
      { provider: oldProvider }
    );
    await oldStarted;

    let replacementCalls = 0;
    let releaseReplacement!: () => void;
    let signalReplacementPaused!: () => void;
    const replacementPaused = new Promise<void>((resolve) => { signalReplacementPaused = resolve; });
    const replacementRelease = new Promise<void>((resolve) => { releaseReplacement = resolve; });
    const replacementProvider = fakeProvider("model", async (inputs) => {
      replacementCalls += 1;
      if (replacementCalls === 2) {
        signalReplacementPaused();
        await replacementRelease;
      }
      return vectorsFor(inputs, replacementProvider, "model", 3);
    });
    const replacementBuild = buildEmbeddings(
      replacementStore,
      embeddingConfig(true, { batchSize: 1 }),
      { provider: replacementProvider }
    );
    await replacementPaused;

    releaseOld();
    await oldBuild;
    expect(replacementStore.listActiveEmbeddingVectors().map((vector) => vector.dimension)).toEqual([3]);
    expect(replacementStore.listEmbeddingJobs({ state: "pending" })).toHaveLength(2);

    releaseReplacement();
    const result = await replacementBuild;
    expect(result).toMatchObject({ usable: true, eligible: 3, activeCoverage: 3, complete: 3, failed: 0 });
    expect(new Set(replacementStore.listActiveEmbeddingVectors().map((vector) => vector.dimension))).toEqual(new Set([3]));
    oldStore.close();
    replacementStore.close();
  });
});

function addChunks(store: ReturnType<typeof openMemoryStore>, texts: string[]): void {
  store.addSourceWithChunks({
    source: { id: "source-1", type: "conversation", title: "Source", origin: "fixture", rawContent: texts.join(" ") },
    chunks: texts.map((text) => ({ text }))
  });
}

function embeddingConfig(
  enabled: boolean,
  overrides: Partial<ProjectConfig["embeddings"]> = {}
): Pick<ProjectConfig, "embeddings" | "privacy"> {
  return {
    embeddings: {
      enabled,
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "model",
      batchSize: 16,
      ...overrides
    },
    privacy: { allowRemoteEmbeddings: false }
  };
}

function fakeProvider(model: string, embed: EmbeddingProvider["embed"]): EmbeddingProvider {
  const endpointHash = createEmbeddingEndpointHash("http://127.0.0.1:11434/v1");
  return { endpointHash, providerKey: createProviderKey(endpointHash, model), isRemote: false, embed };
}

function fakeRemoteProvider(model: string, embed: EmbeddingProvider["embed"]): EmbeddingProvider {
  const endpointHash = createEmbeddingEndpointHash("https://embeddings.example/v1");
  return { endpointHash, providerKey: createProviderKey(endpointHash, model), isRemote: true, embed };
}

function vectorsFor(inputs: string[], provider: EmbeddingProvider, model: string, dimension: number) {
  return {
    vectors: inputs.map((_, index) => Array.from({ length: dimension }, (__, offset) => index + offset + 1)),
    dimension,
    providerFingerprint: createProviderFingerprint(provider.endpointHash, model, dimension)
  };
}
