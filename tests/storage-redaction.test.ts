import { afterEach, describe, expect, it } from "vitest";

import { addDecision } from "../src/decisions/store.js";
import {
  createEmbeddingEndpointHash,
  createProviderFingerprint,
  createProviderKey,
  encodeFloat32Vector
} from "../src/embeddings/fingerprint.js";
import { createRedactionPolicy } from "../src/privacy/policy.js";
import { openMemoryStore } from "../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("storage-boundary redaction", () => {
  const secret = "project-secret-12345";
  let roots: string[] = [];

  afterEach(() => {
    for (const root of roots) cleanupTempDir(root);
    roots = [];
  });

  it("redacts built-in and configured secrets before every store-controlled write", () => {
    const root = makeTempDir();
    roots.push(root);
    const policy = createRedactionPolicy({
      allowRemoteEmbeddings: false,
      redactionPatterns: [{ name: "project secret", kind: "literal", pattern: secret }]
    });
    const store = openMemoryStore(root, { privacyPolicy: policy, backupRetention: 2 });
    store.init();

    const rawSourceId = `conversation-${secret}`;
    const sourceId = store.addSourceWithChunks({
      source: {
        id: rawSourceId,
        type: "conversation",
        title: `ordinary searchable ${secret}`,
        origin: `codex-${secret}`,
        rawContent: `ordinary searchable api_key=sk-proj-abcdefghijklmnop ${secret}`,
        metadata: { nested: { path: `src/${secret}/file.ts` } }
      },
      chunks: [{
        text: `ordinary searchable ${secret}`,
        metadata: { locator: `${rawSourceId}:chunk:0`, values: [secret] }
      }]
    });
    expect(sourceId).not.toContain(secret);
    expect(store.search({ query: "ordinary searchable" })).toHaveLength(1);

    const commitId = store.addCommit({
      hash: `hash-${secret}`,
      authorName: `Author ${secret}`,
      authorEmail: `person+${secret}@example.com`,
      authoredAt: "2026-07-16T00:00:00.000Z",
      message: `commit ordinary ${secret}`,
      changedFiles: [`src/${secret}/commit.ts`],
      diffSummary: `diff ${secret}`
    });
    expect(commitId).not.toContain(secret);

    const candidate = store.upsertMemoryCandidate({
      type: "constraint",
      title: `Candidate ${secret}`,
      summary: `candidate ordinary ${secret}`,
      reason: `reason ${secret}`,
      confidence: 0.8,
      evidence: [{ sourceType: "conversation", sourceId: rawSourceId, locator: `${rawSourceId}:chunk:0` }],
      relatedFiles: [`src/${secret}/candidate.ts`],
      dedupeKey: `candidate-${secret}`
    });
    expect(candidate.evidence[0]?.sourceId).toBe(sourceId);
    const memory = store.promoteMemoryCandidate(candidate.id);
    store.updateMemoryLifecycle(memory.id, {
      lifecycleStatus: "current",
      statusReason: `status ${secret}`
    });
    store.addMemoryRelation({
      fromMemoryId: memory.id,
      toMemoryId: store.upsertManualDecisionMemory({
        id: `manual-${secret}`,
        topic: `Manual ${secret}`,
        decision: `decision ${secret}`,
        reason: `manual reason ${secret}`,
        status: `accepted-${secret}`,
        evidence: [{ sourceType: "conversation", sourceId: rawSourceId }],
        createdAt: "2026-07-16T00:00:00.000Z"
      }).id,
      relationType: "potentially_contradicts",
      reason: `relation ${secret}`
    });

    store.upsertTemporaryMemory({
      id: `temporary-${secret}`,
      projectId: `/project/${secret}`,
      threadId: `thread-${secret}`,
      sessionId: `session-${secret}`,
      sourceAdapter: `codex-${secret}`,
      kind: "task_state",
      title: `Temporary ${secret}`,
      summary: `temporary ordinary ${secret}`,
      details: `details ${secret}`,
      relatedFiles: [`src/${secret}/temporary.ts`],
      evidence: [{ sourceType: "conversation", sourceId: rawSourceId }]
    });
    store.setSyncCursor("codex", `cursor-${secret}`, `value-${secret}`);
    store.recordSyncStatus({
      source: "codex",
      enabled: true,
      lastError: `Bearer abcdefghijklmnopqrstuvwxyz ${secret}`,
      metadata: { path: `logs/${secret}.jsonl` }
    });
    store.recordSourceFailure({
      adapter: "codex",
      path: `logs/${secret}.jsonl`,
      errorCode: `parse-${secret}`,
      message: `failed ${secret}`
    });
    addDecision(store, {
      topic: `Decision ${secret}`,
      decision: `choose ordinary ${secret}`,
      reason: `because ${secret}`,
      status: `accepted-${secret}`,
      evidence: [{ sourceType: "conversation", sourceId: rawSourceId, locator: `${rawSourceId}:chunk:0` }]
    });

    const text = JSON.stringify(allStoredValues(store));
    expect(text).not.toContain(secret);
    expect(text).not.toContain("sk-proj-abcdefghijklmnop");
    expect(store.listEmbeddingOwners().map((owner) => owner.text).join(" ")).not.toContain(secret);
    expect(text).toContain("temporary ordinary");
    store.close();
  });

  it("uses built-in redaction when no policy is supplied and does not mutate callers", () => {
    const root = makeTempDir();
    roots.push(root);
    const input = {
      source: {
        id: "source-1",
        type: "conversation" as const,
        title: "safe title",
        origin: "test",
        rawContent: "api_key=sk-proj-abcdefghijklmnop",
        metadata: { token: "Bearer abcdefghijklmnopqrstuvwxyz" }
      },
      chunks: [{ text: "api_key=sk-proj-abcdefghijklmnop" }]
    };
    const original = structuredClone(input);
    const store = openMemoryStore(root);
    store.init();
    store.addSourceWithChunks(input);

    expect(input).toEqual(original);
    expect(JSON.stringify(allStoredValues(store))).not.toContain("sk-proj-abcdefghijklmnop");
    expect(JSON.stringify(allStoredValues(store))).not.toContain("abcdefghijklmnopqrstuvwxyz");
    store.close();
  });

  it("keeps secret-bearing paths distinct and resolves lookups from their original values", () => {
    const root = makeTempDir();
    roots.push(root);
    const policy = createRedactionPolicy({
      allowRemoteEmbeddings: false,
      redactionPatterns: [{ name: "project secret", kind: "literal", pattern: secret }]
    });
    const store = openMemoryStore(root, { privacyPolicy: policy });
    store.init();
    const firstPath = `src/${secret}-one/file.ts`;
    const secondPath = `src/${secret}-two/file.ts`;
    store.addCommit({
      hash: "commit-one",
      authorName: "Author",
      authorEmail: "author@example.com",
      authoredAt: "2026-07-16T00:00:00.000Z",
      message: "First path",
      changedFiles: [firstPath],
      diffSummary: ""
    });
    store.addCommit({
      hash: "commit-two",
      authorName: "Author",
      authorEmail: "author@example.com",
      authoredAt: "2026-07-16T00:01:00.000Z",
      message: "Second path",
      changedFiles: [secondPath],
      diffSummary: ""
    });

    const storedPaths = store.db.prepare(
      "select distinct to_id from relations where to_type = 'file' order by to_id"
    ).all() as Array<{ to_id: string }>;
    expect(storedPaths).toHaveLength(2);
    expect(storedPaths[0]?.to_id).not.toBe(storedPaths[1]?.to_id);
    expect(JSON.stringify(storedPaths)).not.toContain(secret);
    expect(store.findCommits({ filePath: firstPath })).toEqual([
      expect.objectContaining({ hash: "commit-one" })
    ]);
    expect(store.findSourcesMentioningFile(secondPath)).toEqual([
      expect.objectContaining({ id: "commit-two" })
    ]);
    expect(store.getEntityLinks({ entityType: "file", entityId: firstPath })).not.toHaveLength(0);
    store.close();
  });

  it("redacts embedding metadata and maps owner lookups consistently", () => {
    const root = makeTempDir();
    roots.push(root);
    const policy = createRedactionPolicy({
      allowRemoteEmbeddings: false,
      redactionPatterns: [{ name: "project secret", kind: "literal", pattern: secret }]
    });
    const store = openMemoryStore(root, { privacyPolicy: policy });
    store.init();
    const rawSourceId = `embedding-${secret}`;
    store.addSourceWithChunks({
      source: {
        id: rawSourceId,
        type: "conversation",
        title: "Embedding source",
        origin: "test",
        rawContent: "embedding content"
      },
      chunks: [{ text: "embedding content" }]
    });
    const endpointHash = createEmbeddingEndpointHash("http://127.0.0.1:11434/v1");
    const model = `model-${secret}`;
    const providerKey = createProviderKey(endpointHash, model);
    store.reconcileEmbeddingJobs({ providerKey, endpointHash, model });
    const rawOwnerId = `${rawSourceId}:chunk:0`;
    const job = store.listEmbeddingJobs({ providerKey, ownerId: rawOwnerId })[0]!;
    expect(job.model).not.toContain(secret);
    store.recordEmbeddingJobAttempts([{ ...job, ownerId: rawOwnerId }]);
    store.completeEmbeddingJob({
      ...job,
      ownerId: rawOwnerId,
      endpointHash,
      model,
      providerFingerprint: createProviderFingerprint(endpointHash, model, 1),
      dimension: 1,
      vectorBlob: encodeFloat32Vector([1])
    });

    const vectors = store.listEmbeddingVectors({ providerKey, ownerId: rawOwnerId });
    expect(vectors).toHaveLength(1);
    expect(vectors[0]?.model).not.toContain(secret);
    expect(JSON.stringify(allStoredValues(store))).not.toContain(secret);
    store.close();
  });

  it("preserves sensitive identity lookups when configured rules are removed", () => {
    const root = makeTempDir();
    roots.push(root);
    const rawId = `source-${secret}`;
    const privatePolicy = createRedactionPolicy({
      allowRemoteEmbeddings: false,
      redactionPatterns: [{ name: "project secret", kind: "literal", pattern: secret }]
    });
    let store = openMemoryStore(root, { privacyPolicy: privatePolicy });
    store.init();
    const storedId = store.addSourceWithChunks({
      source: { id: rawId, type: "conversation", title: "Stable", origin: "test", rawContent: "stable text" },
      chunks: [{ text: "stable text" }]
    });
    store.close();

    store = openMemoryStore(root);
    store.init();
    expect(store.readSource(rawId)?.id).toBe(storedId);
    expect(store.addSourceWithChunks({
      source: { id: rawId, type: "conversation", title: "Updated", origin: "test", rawContent: "updated text" },
      chunks: [{ text: "updated text" }]
    })).toBe(storedId);
    expect(store.getProjectSummary().sources).toBe(1);
    expect(JSON.stringify(allStoredValues(store))).not.toContain(secret);
    store.close();
  });

  it("preserves distinct values for colliding sensitive JSON keys", () => {
    const root = makeTempDir();
    roots.push(root);
    const policy = createRedactionPolicy({
      allowRemoteEmbeddings: false,
      redactionPatterns: [{ name: "project secret", kind: "literal", pattern: secret }]
    });
    const store = openMemoryStore(root, { privacyPolicy: policy });
    store.init();
    store.addSourceWithChunks({
      source: {
        id: "json-keys",
        type: "conversation",
        title: "JSON keys",
        origin: "test",
        rawContent: "ordinary",
        metadata: {
          [`key-${secret}-one`]: "first",
          [`key-${secret}-two`]: "second"
        }
      },
      chunks: [{ text: "ordinary" }]
    });
    const metadata = store.readSource("json-keys")?.metadata ?? {};
    expect(Object.keys(metadata)).toHaveLength(2);
    expect(new Set(Object.values(metadata))).toEqual(new Set(["first", "second"]));
    expect(JSON.stringify(metadata)).not.toContain(secret);
    store.close();
  });
});

function allStoredValues(store: ReturnType<typeof openMemoryStore>): unknown[] {
  const tables = store.db.prepare(
    "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'"
  ).all() as Array<{ name: string }>;
  return tables.flatMap(({ name }) => store.db.prepare(`select * from "${name.replaceAll('"', '""')}"`).all());
}
