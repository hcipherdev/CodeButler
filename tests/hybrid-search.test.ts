import { describe, expect, it } from "vitest";

import { createEmbeddingEndpointHash, createProviderFingerprint, createProviderKey, encodeFloat32Vector } from "../src/embeddings/fingerprint.js";
import {
  cosineSimilarity,
  decodeFloat32Vector,
  rankByCosine,
  reciprocalRankFuse
} from "../src/search/hybrid.js";
import { findProjectMemories, searchProjectMemory } from "../src/search/service.js";
import { openMemoryStore } from "../src/storage/store.js";
import type { EmbeddingProvider, ProjectConfig } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("hybrid ranking", () => {
  it("decodes Float32 blobs and rejects invalid dimensions", () => {
    const bytes = new Uint8Array(new Float32Array([1, 2]).buffer);
    expect(decodeFloat32Vector(bytes, 2)).toEqual([1, 2]);
    expect(() => decodeFloat32Vector(bytes, 3)).toThrow(/dimension/i);
  });

  it("orders cosine scores, handles zero vectors, and breaks ties by id", () => {
    expect(cosineSimilarity([1, 0], [0, 0])).toBe(0);
    expect(rankByCosine([1, 0], [
      { id: "b", vector: [1, 0] },
      { id: "c", vector: [0, 1] },
      { id: "a", vector: [1, 0] }
    ])).toEqual([
      { id: "a", score: 1, rank: 1 },
      { id: "b", score: 1, rank: 2 },
      { id: "c", score: 0, rank: 3 }
    ]);
  });

  it("fuses lexical-only and semantic-only hits with exact reciprocal ranks", () => {
    const fused = reciprocalRankFuse(
      [{ id: "lex" }, { id: "both" }],
      [{ id: "sem" }, { id: "both" }],
      { k: 60, limit: 3 }
    );
    expect(fused).toEqual([
      { id: "both", lexicalRank: 2, semanticRank: 2, fusedScore: 2 / 62 },
      { id: "lex", lexicalRank: 1, fusedScore: 1 / 61 },
      { id: "sem", semanticRank: 1, fusedScore: 1 / 61 }
    ]);
  });
});

describe("hybrid search service", () => {
  it("returns the exact lexical result without calling a provider in FTS mode", async () => {
    const root = makeTempDir();
    const store = openMemoryStore(root);
    store.init();
    store.addSourceWithChunks({
      source: { type: "conversation", title: "one", origin: "test", rawContent: "lexical needle" },
      chunks: [{ text: "lexical needle" }]
    });
    const expected = { memories: store.searchMemoryLayer({ query: "needle", limit: 5 }), results: store.search({ query: "needle", limit: 5 }) };
    let calls = 0;
    const actual = await searchProjectMemory(store, config("fts", true), { query: "needle", limit: 5 }, {
      provider: provider([1, 0], () => { calls += 1; })
    });
    expect(actual).toEqual(expected);
    expect(calls).toBe(0);
    store.close();
    cleanupTempDir(root);
  });

  it("falls back deeply equal when vectors are missing or query dimensions mismatch", async () => {
    const root = makeTempDir();
    const store = openMemoryStore(root);
    store.init();
    store.addSourceWithChunks({
      source: { type: "conversation", title: "one", origin: "test", rawContent: "lexical needle" },
      chunks: [{ text: "lexical needle" }]
    });
    const expected = { memories: store.searchMemoryLayer({ query: "needle", limit: 5 }), results: store.search({ query: "needle", limit: 5 }) };
    expect(await searchProjectMemory(store, config("hybrid", true), { query: "needle", limit: 5 }, {
      provider: provider([1, 0])
    })).toEqual(expected);
    let disabledCalls = 0;
    expect(await searchProjectMemory(store, config("hybrid", false), { query: "needle", limit: 5 }, {
      provider: provider([1, 0], () => { disabledCalls += 1; })
    })).toEqual(expected);
    expect(disabledCalls).toBe(0);
    const owner = store.listEmbeddingOwners()[0]!;
    const malformed = provider([Number.NaN, 0]);
    store.upsertEmbeddingVector({
      ...owner, providerKey: malformed.providerKey, endpointHash: malformed.endpointHash, model: "model",
      providerFingerprint: createProviderFingerprint(malformed.endpointHash, "model", 2), dimension: 2,
      vectorBlob: encodeFloat32Vector([1, 0])
    });
    expect(await searchProjectMemory(store, config("hybrid", true), { query: "needle", limit: 5 }, { provider: malformed })).toEqual(expected);
    store.close();
    cleanupTempDir(root);
  });

  it("falls back on provider errors and remote privacy rejection", async () => {
    const root = makeTempDir();
    const store = openMemoryStore(root);
    store.init();
    store.addSourceWithChunks({
      source: { type: "conversation", title: "one", origin: "test", rawContent: "lexical needle" },
      chunks: [{ text: "lexical needle" }]
    });
    const expected = { memories: store.searchMemoryLayer({ query: "needle" }), results: store.search({ query: "needle" }) };
    const broken = provider([1, 0]);
    broken.embed = async () => { throw new Error("provider failed"); };
    expect(await searchProjectMemory(store, config("hybrid", true), { query: "needle" }, { provider: broken })).toEqual(expected);
    const remote = config("hybrid", true);
    remote.embeddings.baseUrl = "https://embeddings.example/v1";
    expect(await searchProjectMemory(store, remote, { query: "needle" })).toEqual(expected);
    store.close();
    cleanupTempDir(root);
  });

  it("privacy-gates injected remote providers and redacts opted-in queries", async () => {
    const root = makeTempDir();
    const store = openMemoryStore(root);
    store.init();
    store.addSourceWithChunks({
      source: { type: "conversation", title: "one", origin: "test", rawContent: "needle sk-proj-abcdefghijklmnop" },
      chunks: [{ text: "needle sk-proj-abcdefghijklmnop" }]
    });
    const remoteConfig = config("hybrid", true);
    remoteConfig.embeddings.baseUrl = "https://embeddings.example/v1";
    const blockedInputs: string[][] = [];
    const blocked = provider([1, 0], (inputs) => { blockedInputs.push(inputs); }, {
      baseUrl: remoteConfig.embeddings.baseUrl, isRemote: true
    });
    seedVectors(store, blocked);
    const input = { query: "needle sk-proj-abcdefghijklmnop" };
    const expected = { memories: store.searchMemoryLayer(input), results: store.search(input) };
    expect(await searchProjectMemory(store, remoteConfig, input, { provider: blocked })).toEqual(expected);
    expect(blockedInputs).toEqual([]);

    remoteConfig.privacy.allowRemoteEmbeddings = true;
    const allowedInputs: string[][] = [];
    const allowed = provider([1, 0], (inputs) => { allowedInputs.push(inputs); }, {
      baseUrl: remoteConfig.embeddings.baseUrl, isRemote: true
    });
    const hybrid = await searchProjectMemory(store, remoteConfig, input, { provider: allowed });
    expect(hybrid.results[0]?.ranking).toBeDefined();
    expect(allowedInputs).toEqual([["needle [REDACTED:API_KEY]"]]);
    expect(JSON.stringify(allowedInputs)).not.toContain("sk-proj-abcdefghijklmnop");
    store.close();
    cleanupTempDir(root);
  });

  it("uses only the exact returned provider fingerprint", async () => {
    const root = makeTempDir();
    const store = openMemoryStore(root);
    store.init();
    store.addSourceWithChunks({
      source: { type: "conversation", title: "one", origin: "test", rawContent: "lexical needle" },
      chunks: [{ text: "lexical needle" }]
    });
    const p = provider([1, 0, 0]);
    const owner = store.listEmbeddingOwners()[0]!;
    store.upsertEmbeddingVector({
      ...owner, providerKey: p.providerKey, endpointHash: p.endpointHash, model: "model",
      providerFingerprint: createProviderFingerprint(p.endpointHash, "model", 2), dimension: 2,
      vectorBlob: encodeFloat32Vector([1, 0])
    });
    const expected = { memories: store.searchMemoryLayer({ query: "needle" }), results: store.search({ query: "needle" }) };
    expect(await searchProjectMemory(store, config("hybrid", true), { query: "needle" }, { provider: p })).toEqual(expected);
    store.close();
    cleanupTempDir(root);
  });

  it("does not mix vectors after endpoint or model changes", async () => {
    const root = makeTempDir();
    const store = openMemoryStore(root);
    store.init();
    store.addSourceWithChunks({
      source: { type: "conversation", title: "one", origin: "test", rawContent: "lexical needle" },
      chunks: [{ text: "lexical needle" }]
    });
    const original = provider([1, 0]);
    seedVectors(store, original);
    const input = { query: "needle" };
    const expected = { memories: store.searchMemoryLayer(input), results: store.search(input) };

    const endpointConfig = config("hybrid", true);
    endpointConfig.embeddings.baseUrl = "http://localhost:9999/v1";
    const endpointProvider = provider([1, 0], () => {}, { baseUrl: endpointConfig.embeddings.baseUrl });
    expect(await searchProjectMemory(store, endpointConfig, input, { provider: endpointProvider })).toEqual(expected);

    const modelConfig = config("hybrid", true);
    modelConfig.embeddings.model = "other-model";
    const modelProvider = provider([1, 0], () => {}, { model: "other-model" });
    expect(await searchProjectMemory(store, modelConfig, input, { provider: modelProvider })).toEqual(expected);
    store.close();
    cleanupTempDir(root);
  });

  it("fuses raw chunks and current memories while leaving candidates lexical-only", async () => {
    const root = makeTempDir();
    const store = openMemoryStore(root);
    store.init();
    store.addSourceWithChunks({
      source: { type: "conversation", title: "sources", origin: "test", rawContent: "lexical needle\nsemantic concept" },
      chunks: [{ text: "lexical needle" }, { text: "semantic concept" }]
    });
    const candidate = store.upsertMemoryCandidate({
      type: "decision", title: "Lexical candidate", summary: "needle candidate", reason: "test", confidence: 0.9,
      evidence: [], relatedFiles: [], dedupeKey: "candidate"
    });
    const promotedCandidate = store.upsertMemoryCandidate({
      type: "decision", title: "Semantic memory", summary: "semantic promoted", reason: "test", confidence: 0.9,
      evidence: [], relatedFiles: [], dedupeKey: "promoted"
    });
    const promoted = store.promoteMemoryCandidate(promotedCandidate.id);
    const p = provider([1, 0]);
    const owners = store.listEmbeddingOwners();
    for (const owner of owners) {
      const vector = owner.ownerKind === "chunk" && owner.text.includes("semantic") || owner.ownerId === promoted.id
        ? [1, 0]
        : [0, 1];
      store.upsertEmbeddingVector({
        ...owner, providerKey: p.providerKey, endpointHash: p.endpointHash, model: "model",
        providerFingerprint: createProviderFingerprint(p.endpointHash, "model", 2), dimension: 2,
        vectorBlob: encodeFloat32Vector(vector)
      });
    }
    const result = await searchProjectMemory(store, config("hybrid", true), { query: "needle", limit: 5 }, { provider: p });
    const lexicalScore = store.search({ query: "needle", limit: 5 })[0]!.score;
    expect(result.results.find((item) => item.text === "lexical needle")?.score).toBe(lexicalScore);
    expect(result.results.find((item) => item.text === "semantic concept")?.ranking)
      .toMatchObject({ semanticRank: 1, fusedScore: expect.any(Number) });
    expect(result.results.every((item) => item.citations === undefined)).toBe(true);
    expect(result.memories.find((item) => item.id === promoted.id)?.ranking).toMatchObject({ semanticRank: 1 });
    expect(result.memories.find((item) => item.id === candidate.id)?.ranking).toBeUndefined();
    store.close();
    cleanupTempDir(root);
  });

  it("preserves raw and memory filters, lifecycle fallback, and limits", async () => {
    const root = makeTempDir();
    const store = openMemoryStore(root);
    store.init();
    store.addSourceWithChunks({
      source: { type: "conversation", title: "conversation", origin: "test", rawContent: "needle conversation" },
      chunks: [{ text: "needle conversation" }]
    });
    store.addSourceWithChunks({
      source: { type: "commit", title: "commit", origin: "test", rawContent: "semantic commit" },
      chunks: [{ text: "semantic commit" }]
    });
    const active = promote(store, "decision", "active", "semantic active", "active");
    promote(store, "constraint", "quarantined", "semantic quarantine", "quarantined");
    const superseded = promote(store, "decision", "superseded", "needle superseded", "active");
    store.updateMemoryLifecycle(superseded.id, { lifecycleStatus: "superseded" });
    store.upsertMemoryCandidate({ type: "decision", title: "candidate", summary: "needle candidate", reason: "test", confidence: 0.9, evidence: [], relatedFiles: [], dedupeKey: "candidate-filter" });
    let providerCalls = 0;
    const p = provider([1, 0], () => { providerCalls += 1; });
    seedVectors(store, p, (text) => text.includes("semantic") ? [1, 0] : [0, 1]);
    const cfg = config("hybrid", true);

    const raw = await searchProjectMemory(store, cfg, { query: "needle", sourceTypes: ["conversation"], limit: 1 }, { provider: p });
    expect(raw.results).toHaveLength(1);
    expect(raw.results[0]?.sourceType).toBe("conversation");

    const decisions = await findProjectMemories(store, cfg, { query: "needle", type: "decision", qualityStatus: "active", lifecycleStatus: "current", limit: 1 }, { provider: p });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ id: active.id, type: "decision", qualityStatus: "active", lifecycleStatus: "current" });
    const quarantined = await findProjectMemories(store, cfg, { query: "needle", type: "constraint", qualityStatus: "all", lifecycleStatus: "current", limit: 2 }, { provider: p });
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toMatchObject({ type: "constraint", qualityStatus: "quarantined", lifecycleStatus: "current" });
    const lifecycleFilters = ["all", "superseded", "retracted"] as const;
    const beforeLexicalLifecycleFilters = providerCalls;
    for (const lifecycleStatus of lifecycleFilters) {
      const filter = { query: "needle", status: "promoted" as const, lifecycleStatus, limit: 2 };
      expect(await findProjectMemories(store, cfg, filter, { provider: p })).toEqual(store.searchMemoryLayer(filter));
    }
    const candidateFilter = { query: "needle", status: "candidate" as const, limit: 2 };
    expect(await findProjectMemories(store, cfg, candidateFilter, { provider: p })).toEqual(store.searchMemoryLayer(candidateFilter));
    expect(providerCalls).toBe(beforeLexicalLifecycleFilters);
    store.close();
    cleanupTempDir(root);
  });

  it("retains lexical hits that do not yet have vectors", async () => {
    const root = makeTempDir();
    const store = openMemoryStore(root);
    store.init();
    store.addSourceWithChunks({
      source: { id: "partial", type: "conversation", title: "Partial", origin: "test", rawContent: "needle\nsemantic" },
      chunks: [{ text: "needle without vector" }, { text: "semantic with vector" }]
    });
    const p = provider([1, 0]);
    const semanticOwner = store.listEmbeddingOwners().find((owner) => owner.text.includes("semantic"))!;
    store.upsertEmbeddingVector({
      ...semanticOwner, providerKey: p.providerKey, endpointHash: p.endpointHash, model: "model",
      providerFingerprint: createProviderFingerprint(p.endpointHash, "model", 2), dimension: 2,
      vectorBlob: encodeFloat32Vector([1, 0])
    });
    const result = await searchProjectMemory(store, config("hybrid", true), { query: "needle", limit: 5 }, { provider: p });
    expect(result.results.map((item) => item.text)).toEqual(expect.arrayContaining([
      "needle without vector", "semantic with vector"
    ]));
    expect(result.results.find((item) => item.text === "needle without vector")?.ranking?.lexicalRank).toBe(1);
    store.close();
    cleanupTempDir(root);
  });
});

function config(mode: "fts" | "hybrid", enabled: boolean): ProjectConfig {
  return {
    configPath: "test", sources: {} as ProjectConfig["sources"], extractor: {} as ProjectConfig["extractor"],
    investigator: {} as ProjectConfig["investigator"], promotion: {} as ProjectConfig["promotion"],
    sync: { autoSyncOnServerStart: false }, retrieval: { mode, rrfK: 60 },
    embeddings: { enabled, provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", model: "model", batchSize: 16 },
    privacy: { allowRemoteEmbeddings: false }, deterministic: {} as ProjectConfig["deterministic"]
  };
}

function provider(
  queryVector: number[],
  onCall: (inputs: string[]) => void = () => {},
  options: { baseUrl?: string; model?: string; isRemote?: boolean } = {}
): EmbeddingProvider {
  const model = options.model ?? "model";
  const endpointHash = createEmbeddingEndpointHash(options.baseUrl ?? "http://127.0.0.1:11434/v1");
  return {
    endpointHash, providerKey: createProviderKey(endpointHash, model), isRemote: options.isRemote ?? false,
    async embed(inputs) {
      onCall(inputs);
      return { vectors: [queryVector], dimension: queryVector.length, providerFingerprint: createProviderFingerprint(endpointHash, model, queryVector.length) };
    }
  };
}

function seedVectors(store: ReturnType<typeof openMemoryStore>, p: EmbeddingProvider, vectorFor: (text: string) => number[] = () => [1, 0]): void {
  for (const owner of store.listEmbeddingOwners()) {
    const vector = vectorFor(owner.text);
    store.upsertEmbeddingVector({
      ...owner, providerKey: p.providerKey, endpointHash: p.endpointHash, model: "model",
      providerFingerprint: createProviderFingerprint(p.endpointHash, "model", vector.length),
      dimension: vector.length, vectorBlob: encodeFloat32Vector(vector)
    });
  }
}

function promote(store: ReturnType<typeof openMemoryStore>, type: "decision" | "constraint", key: string, summary: string, qualityStatus: "active" | "quarantined") {
  const candidate = store.upsertMemoryCandidate({ type, title: key, summary, reason: "test", confidence: 0.9, evidence: [], relatedFiles: [], dedupeKey: key }, { qualityStatus });
  return store.promoteMemoryCandidate(candidate.id);
}
