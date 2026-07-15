import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runDoctor } from "../src/doctor/service.js";
import { openMemoryStore } from "../src/storage/store.js";
import { createEmbeddingEndpointHash, createProviderFingerprint, createProviderKey, encodeFloat32Vector } from "../src/embeddings/fingerprint.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("doctor service", () => {
  let tempDirs: string[] = [];
  const originalCodeButlerHome = process.env.CODE_BUTLER_HOME;

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
    delete process.env.TEST_CODE_BUTLER_API_KEY;
    if (originalCodeButlerHome === undefined) {
      delete process.env.CODE_BUTLER_HOME;
    } else {
      process.env.CODE_BUTLER_HOME = originalCodeButlerHome;
    }
  });

  function writeConfig(rootDir: string, overrides: Record<string, unknown> = {}): void {
    mkdirSync(join(rootDir, ".code-butler"), { recursive: true });
    writeFileSync(
      join(rootDir, ".code-butler", "config.json"),
      JSON.stringify(
        {
          sources: {
            git: { enabled: false, repoPath: ".", hookInstall: false, maxCommits: 50, maxDiffChars: 12000 },
            codex: { enabled: false, roots: [], includeDefaultRoots: false, projectOnly: true },
            claude: { enabled: false, roots: [], projectOnly: true }
          },
          extractor: {
            provider: "openai-compatible",
            baseUrl: "https://example.test/v1",
            model: "gpt-test",
            apiKeyEnv: "TEST_CODE_BUTLER_API_KEY"
          },
          investigator: {
            enabled: true,
            mode: "native-rlm",
            provider: "openai-compatible",
            baseUrl: "https://example.test/v1",
            model: "gpt-test",
            apiKeyEnv: "TEST_CODE_BUTLER_API_KEY"
          },
          ...overrides
        },
        null,
        2
      )
    );
  }

  function writeFreshSummary(rootDir: string): void {
    mkdirSync(join(rootDir, ".code-butler"), { recursive: true });
    writeFileSync(join(rootDir, ".code-butler", "project-summary.md"), "# Summary\n");
    writeFileSync(
      join(rootDir, ".code-butler", "project-summary.meta.json"),
      JSON.stringify(
        {
          version: 1,
          summaryPath: join(rootDir, ".code-butler", "project-summary.md"),
          fingerprint: "test",
          lastGeneratedAt: "2026-06-24T10:00:00.000Z",
          lastCheckedAt: "2026-06-24T10:00:00.000Z"
        },
        null,
        2
      )
    );
  }

  it("reports an initialized healthy project as ok", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    process.env.TEST_CODE_BUTLER_API_KEY = "test-key";
    writeConfig(rootDir);
    writeFreshSummary(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.close();

    const report = runDoctor(rootDir, { now: () => new Date("2026-06-24T12:00:00.000Z") });

    expect(report.status).toBe("ok");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "config:load", status: "ok" }),
        expect.objectContaining({ id: "storage:sqlite", status: "ok" }),
        expect.objectContaining({ id: "summary:freshness", status: "ok" }),
        expect.objectContaining({ id: "extractor:credentials", status: "ok" }),
        expect.objectContaining({ id: "storage:quick_check", status: "ok", metadata: { result: "ok" } }),
        expect.objectContaining({
          id: "storage:schema_migrations",
          status: "ok",
          metadata: expect.objectContaining({
            currentVersion: expect.any(Number),
            latestVersion: expect.any(Number),
            pendingMigrations: [],
            latestBackup: null
          })
        }),
        expect.objectContaining({
          id: "storage:transaction_recovery",
          status: "ok",
          metadata: expect.objectContaining({
            inTransaction: false,
            journalMode: "wal",
            busyTimeout: 5000,
            recoveryReady: true
          })
        }),
        expect.objectContaining({
          id: "memory:quality",
          metadata: expect.objectContaining({ total: 0, scanned: 0, complete: true })
        })
      ])
    );
    expect(report.nextActions).toEqual([]);
  });

  it("reports disabled embeddings in FTS mode as healthy without network access", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    process.env.TEST_CODE_BUTLER_API_KEY = "test-key";
    writeConfig(rootDir);
    writeFreshSummary(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.close();

    const report = runDoctor(rootDir, { now: () => new Date("2026-06-24T12:00:00.000Z") });
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "retrieval:mode", status: "ok", metadata: { mode: "fts" } }),
      expect.objectContaining({ id: "embeddings:config", status: "ok", metadata: expect.objectContaining({ enabled: false, local: true, remoteAllowed: false }) }),
      expect.objectContaining({ id: "embeddings:queue", status: "ok", metadata: expect.objectContaining({ pending: 0, complete: 0, failed: 0, attempts: 0 }) }),
      expect.objectContaining({ id: "embeddings:coverage", status: "ok", metadata: expect.objectContaining({ eligible: 0, vectors: 0 }) })
    ]));
  });

  it("warns when hybrid retrieval has no usable remote provider or vectors", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    process.env.TEST_CODE_BUTLER_API_KEY = "test-key";
    writeConfig(rootDir, {
      retrieval: { mode: "hybrid", rrfK: 60 },
      embeddings: { enabled: true, provider: "openai-compatible", baseUrl: "https://embedding.example/v1", model: "embed-test", batchSize: 16 },
      privacy: { allowRemoteEmbeddings: false }
    });
    writeFreshSummary(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.close();

    const report = runDoctor(rootDir, { now: () => new Date("2026-06-24T12:00:00.000Z") });
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "retrieval:mode", status: "warning" }),
      expect.objectContaining({ id: "embeddings:config", status: "warning", detail: expect.not.stringContaining("https://") }),
      expect.objectContaining({ id: "embeddings:coverage", status: "warning" })
    ]));
    expect(report.nextActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "code-butler embeddings build" })
    ]));
  });

  it("excludes stale content generations and scopes queue diagnostics to the configured provider", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    process.env.TEST_CODE_BUTLER_API_KEY = "test-key";
    writeConfig(rootDir, {
      retrieval: { mode: "hybrid", rrfK: 60 },
      embeddings: { enabled: true, provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", model: "embed-test", batchSize: 16 }
    });
    writeFreshSummary(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({ source: { id: "changing", type: "conversation", title: "change", origin: "test", rawContent: "old text" }, chunks: [{ text: "old text" }] });
    const owner = store.listEmbeddingOwners()[0]!;
    const endpointHash = createEmbeddingEndpointHash("http://127.0.0.1:11434/v1");
    const providerKey = createProviderKey(endpointHash, "embed-test");
    store.upsertEmbeddingVector({ ...owner, endpointHash, providerKey, model: "embed-test", providerFingerprint: createProviderFingerprint(endpointHash, "embed-test", 2), dimension: 2, vectorBlob: encodeFloat32Vector([1, 0]) });
    store.reconcileEmbeddingJobs({ providerKey, endpointHash, model: "embed-test" });
    const otherEndpoint = createEmbeddingEndpointHash("http://127.0.0.1:9999/v1");
    const otherKey = createProviderKey(otherEndpoint, "other-model");
    store.reconcileEmbeddingJobs({ providerKey: otherKey, endpointHash: otherEndpoint, model: "other-model" });
    store.db.prepare("update embedding_jobs set state = 'failed', attempts = 2, last_error = 'old provider failed' where provider_key = ?").run(otherKey);
    store.addSourceWithChunks({ source: { id: "changing", type: "conversation", title: "change", origin: "test", rawContent: "new text" }, chunks: [{ text: "new text" }] });
    store.close();

    const report = runDoctor(rootDir);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "embeddings:queue", metadata: expect.objectContaining({ pending: 0, failed: 0, attempts: 0, staleJobs: 2 }) }),
      expect.objectContaining({ id: "embeddings:coverage", status: "warning", metadata: expect.objectContaining({ eligible: 1, vectors: 0, staleVectors: 1, configuredIndexes: [] }) }),
      expect.objectContaining({ id: "retrieval:mode", status: "warning" })
    ]));
  });

  it("warns for partial vector coverage and pending configured work", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    process.env.TEST_CODE_BUTLER_API_KEY = "test-key";
    writeConfig(rootDir, { retrieval: { mode: "hybrid", rrfK: 60 }, embeddings: { enabled: true, provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", model: "embed-test", batchSize: 16 } });
    writeFreshSummary(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({ source: { id: "partial", type: "conversation", title: "partial", origin: "test", rawContent: "one two" }, chunks: [{ text: "one" }, { text: "two" }] });
    const endpointHash = createEmbeddingEndpointHash("http://127.0.0.1:11434/v1");
    const providerKey = createProviderKey(endpointHash, "embed-test");
    const owners = store.listEmbeddingOwners();
    store.upsertEmbeddingVector({ ...owners[0]!, endpointHash, providerKey, model: "embed-test", providerFingerprint: createProviderFingerprint(endpointHash, "embed-test", 2), dimension: 2, vectorBlob: encodeFloat32Vector([1, 0]) });
    store.reconcileEmbeddingJobs({ providerKey, endpointHash, model: "embed-test" });
    store.close();

    const report = runDoctor(rootDir);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "embeddings:queue", status: "warning", metadata: expect.objectContaining({ pending: 2, failed: 0 }) }),
      expect.objectContaining({ id: "embeddings:coverage", status: "warning", metadata: expect.objectContaining({ eligible: 2, vectors: 1 }) }),
      expect.objectContaining({ id: "retrieval:mode", status: "warning" })
    ]));
    expect(report.nextActions).toEqual(expect.arrayContaining([expect.objectContaining({ command: "code-butler embeddings build" })]));
  });

  it("reports complete configured vector coverage as healthy", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    process.env.TEST_CODE_BUTLER_API_KEY = "test-key";
    writeConfig(rootDir, { retrieval: { mode: "hybrid", rrfK: 60 }, embeddings: { enabled: true, provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", model: "embed-test", batchSize: 16 } });
    writeFreshSummary(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({ source: { id: "complete", type: "conversation", title: "complete", origin: "test", rawContent: "one two" }, chunks: [{ text: "one" }, { text: "two" }] });
    const endpointHash = createEmbeddingEndpointHash("http://127.0.0.1:11434/v1");
    const providerKey = createProviderKey(endpointHash, "embed-test");
    for (const owner of store.listEmbeddingOwners()) store.upsertEmbeddingVector({ ...owner, endpointHash, providerKey, model: "embed-test", providerFingerprint: createProviderFingerprint(endpointHash, "embed-test", 2), dimension: 2, vectorBlob: encodeFloat32Vector([1, 0]) });
    store.close();

    const report = runDoctor(rootDir);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "embeddings:coverage", status: "ok", metadata: expect.objectContaining({ eligible: 2, vectors: 2 }) }),
      expect.objectContaining({ id: "retrieval:mode", status: "ok" })
    ]));
  });

  it("rejects malformed configured vector metadata without exposing content", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    process.env.TEST_CODE_BUTLER_API_KEY = "test-key";
    writeConfig(rootDir, {
      retrieval: { mode: "hybrid", rrfK: 60 },
      embeddings: { enabled: true, provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", model: "embed-test", batchSize: 16 }
    });
    writeFreshSummary(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({ source: { id: "secret-owner", type: "conversation", title: "secret", origin: "test", rawContent: "never expose this content" }, chunks: [{ text: "never expose this content" }] });
    const owner = store.listEmbeddingOwners()[0]!;
    const endpointHash = createEmbeddingEndpointHash("http://127.0.0.1:11434/v1");
    const providerKey = createProviderKey(endpointHash, "embed-test");
    store.upsertEmbeddingVector({ ...owner, endpointHash, providerKey, model: "embed-test", providerFingerprint: createProviderFingerprint(endpointHash, "embed-test", 2), dimension: 2, vectorBlob: encodeFloat32Vector([1, 0]) });
    store.db.prepare("update embedding_vectors set endpoint_hash = 'wrong', model = 'wrong', provider_fingerprint = 'wrong', dimension = 3").run();
    store.close();

    const report = runDoctor(rootDir);
    const coverage = report.checks.find((check) => check.id === "embeddings:coverage")!;
    expect(coverage).toMatchObject({ status: "warning", metadata: { eligible: 1, vectors: 0, staleVectors: 1, configuredIndexes: [] } });
    expect(JSON.stringify(coverage)).not.toContain("never expose this content");
  });

  it("handles partial embedding schemas as a warning instead of throwing", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    process.env.TEST_CODE_BUTLER_API_KEY = "test-key";
    writeConfig(rootDir, { retrieval: { mode: "hybrid", rrfK: 60 }, embeddings: { enabled: true, provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", model: "embed-test", batchSize: 16 } });
    writeFreshSummary(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.db.exec("drop table embedding_vectors; create table embedding_vectors (owner_id text)");
    store.close();

    const report = runDoctor(rootDir);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "embeddings:schema", status: "warning" }),
      expect.objectContaining({ id: "retrieval:mode", status: "warning" })
    ]));
    expect(report.nextActions).toEqual(expect.arrayContaining([expect.objectContaining({ command: "code-butler init" })]));
  });

  it("reports missing and invalid config as errors without throwing", () => {
    const missingRoot = makeTempDir();
    const invalidRoot = makeTempDir();
    tempDirs.push(missingRoot, invalidRoot);
    mkdirSync(join(invalidRoot, ".code-butler"), { recursive: true });
    writeFileSync(join(invalidRoot, ".code-butler", "config.json"), "{not json");

    expect(runDoctor(missingRoot).checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "config:exists", status: "error" })
      ])
    );
    expect(runDoctor(missingRoot).status).toBe("error");
    expect(runDoctor(invalidRoot).checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "config:load", status: "error" })
      ])
    );
  });

  it("warns about missing source roots and missing extractor credentials", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    writeConfig(rootDir, {
      sources: {
        git: { enabled: false, repoPath: ".", hookInstall: false, maxCommits: 50, maxDiffChars: 12000 },
        codex: { enabled: true, roots: ["./missing-codex"], includeDefaultRoots: false, projectOnly: true },
        claude: { enabled: true, roots: ["./missing-claude"], projectOnly: true }
      }
    });
    writeFreshSummary(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.close();

    const report = runDoctor(rootDir, { now: () => new Date("2026-06-24T12:00:00.000Z") });

    expect(report.status).toBe("warning");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "sources:codex", status: "warning" }),
        expect.objectContaining({ id: "sources:claude", status: "warning" }),
        expect.objectContaining({ id: "extractor:credentials", status: "warning" })
      ])
    );
    expect(report.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "code-butler sources status" }),
        expect.objectContaining({ command: "edit ~/.config/code-butler/.env" })
      ])
    );
  });

  it("reports missing project profiles as config errors", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    writeConfig(rootDir, {
      extractor: { profile: "missing" }
    });

    const report = runDoctor(rootDir, { now: () => new Date("2026-06-24T12:00:00.000Z") });

    expect(report.status).toBe("error");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "config:load",
          status: "error",
          detail: expect.stringContaining('Unknown Code Butler provider profile "missing" for extractor')
        })
      ])
    );
  });

  it("reports a future migration ledger as incompatible", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    process.env.TEST_CODE_BUTLER_API_KEY = "test-key";
    writeConfig(rootDir);
    writeFreshSummary(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.db.prepare("insert into schema_migrations values (99, 'future', '2026-07-11T00:00:00Z')").run();
    store.close();

    const report = runDoctor(rootDir, { now: () => new Date("2026-06-24T12:00:00.000Z") });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "storage:schema_migrations",
          status: "error",
          detail: expect.stringContaining("newer schema version")
        })
      ])
    );
  });

  it("recommends initialization when a readable database has pending migrations", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    process.env.TEST_CODE_BUTLER_API_KEY = "test-key";
    writeConfig(rootDir);
    writeFreshSummary(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.db.prepare("delete from schema_migrations where version = (select max(version) from schema_migrations)").run();
    store.close();

    const report = runDoctor(rootDir);
    expect(report.nextActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "code-butler init" })
    ]));
  });

  it("closes the database when storage inspection throws after opening", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    writeConfig(rootDir);
    writeFileSync(join(rootDir, ".code-butler", "memory.sqlite"), "");
    const close = vi.fn();
    const fake = {
      exec() {},
      prepare() { throw new Error("injected inspection failure"); },
      close
    } as unknown as DatabaseSync;

    runDoctor(rootDir, { openDatabase: () => fake });
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports sync errors, stale sync, missing summary, and memory health actions", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    process.env.TEST_CODE_BUTLER_API_KEY = "test-key";
    writeConfig(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.recordSyncStatus({
      source: "git",
      enabled: true,
      lastSyncAt: "2026-06-20T10:00:00.000Z",
      lastSuccessAt: "2026-06-20T10:00:00.000Z"
    });
    store.recordSyncStatus({
      source: "codex",
      enabled: true,
      lastSyncAt: "2026-06-24T10:00:00.000Z",
      lastError: "failed to parse"
    });
    store.addSourceWithChunks({
      source: {
        id: "conv-1",
        type: "conversation",
        title: "session.md",
        origin: "manual",
        rawContent: "Use SQLite."
      },
      chunks: [{ text: "Use SQLite." }]
    });
    store.upsertMemoryCandidate(
      {
        type: "constraint",
        title: "Needs review",
        summary: "This memory needs review.",
        reason: "Test setup.",
        confidence: 0.8,
        evidence: [{ sourceType: "conversation", sourceId: "conv-1" }],
        relatedFiles: [],
        dedupeKey: "needs-review"
      },
      { qualityStatus: "needs_review", qualityReasons: ["low_confidence"] }
    );
    store.close();

    const report = runDoctor(rootDir, { now: () => new Date("2026-06-24T12:00:00.000Z") });

    expect(report.status).toBe("error");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "sync:git", status: "warning" }),
        expect.objectContaining({ id: "sync:codex", status: "error" }),
        expect.objectContaining({ id: "summary:freshness", status: "warning" }),
        expect.objectContaining({ id: "memory:quality", status: "warning" })
      ])
    );
    expect(report.nextActions.map((action) => action.command)).toEqual(
      expect.arrayContaining([
        "code-butler sync",
        "code-butler project-summary refresh",
        "code-butler memory audit --fix"
      ])
    );
  });
});
