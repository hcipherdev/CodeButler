import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { withProjectGate } from "../src/cloud/gate.js";
import { assertNoDatabaseHandles } from "../src/cloud/gate.js";
import { createEmbeddingEndpointHash, createProviderFingerprint, createProviderKey } from "../src/embeddings/fingerprint.js";
import { ensureProjectConfig, loadProjectConfig } from "../src/config.js";
import { openConfiguredMemoryStore } from "../src/storage/open-configured-store.js";
import { syncWatchedProjectMemory } from "../src/sync/service.js";
import type { ExtractorProvider } from "../src/types.js";
import type { EmbeddingProvider } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanupTempDir(root); });

it("releases the gate during a model call and discards a result when its evidence changes", async () => {
  const directory = makeTempDir(); roots.push(directory);
  const root = join(directory, "project"); mkdirSync(root);
  ensureProjectConfig(root);
  const config = loadProjectConfig(root);
  config.sources.git.enabled = false;
  config.sources.codex.enabled = false;
  config.sources.claude.enabled = false;
  const commit = {
    hash: "watcher-staged-commit", authorName: "Test", authorEmail: "test@example.com",
    authoredAt: "2026-09-28T10:00:00Z", message: "Original evidence",
    changedFiles: ["src/work.ts"], diffSummary: "+ original"
  };
  const seed = openConfiguredMemoryStore(root); seed.init();
  seed.addCommit(commit);
  seed.enqueueExtractionEvidence("git", "commit", commit.hash);
  seed.close();

  let allowModel!: () => void;
  let modelStarted!: () => void;
  const entered = new Promise<void>(resolve => { modelStarted = resolve; });
  const paused = new Promise<void>(resolve => { allowModel = resolve; });
  const extractor: ExtractorProvider = { async extract() {
    modelStarted();
    await paused;
    return { memories: [{ type: "decision", title: "Old decision", summary: "Old evidence.",
      reason: "Old evidence.", confidence: 0.9, dedupeKey: "old-evidence", relatedFiles: [],
      evidence: [{ sourceType: "commit", sourceId: commit.hash }] }], rejected: [] };
  } };
  const running = syncWatchedProjectMemory(root, config, { source: "git", extractorProvider: extractor });
  await entered;
  expect(await withProjectGate(root, () => {
    const changed = openConfiguredMemoryStore(root); changed.init();
    try { changed.addCommit({ ...commit, message: "New evidence", diffSummary: "+ updated" }); }
    finally { changed.close(); }
    return "review acquired";
  }, { name: "Apply AI review", waitMs: 1_000 })).toBe("review acquired");
  allowModel();
  const result = await running;
  expect(result.memories.candidates).toBe(0);
  expect(result.memories.pending).toBe(1);
});

it("closes its database handle during a slow embedding call and rejects an outdated owner", async () => {
  const directory = makeTempDir(); roots.push(directory);
  const root = join(directory, "project"); mkdirSync(root);
  ensureProjectConfig(root);
  const config = loadProjectConfig(root);
  config.sources.git.enabled = false;
  config.sources.codex.enabled = false;
  config.sources.claude.enabled = false;
  config.embeddings = { enabled: true, provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", model: "model", batchSize: 16 };
  const seed = openConfiguredMemoryStore(root); seed.init();
  seed.addSourceWithChunks({ source: { id: "source-1", type: "conversation", title: "Source", origin: "fixture", rawContent: "Old content" }, chunks: [{ text: "Old content" }] });
  seed.close();
  const endpointHash = createEmbeddingEndpointHash(config.embeddings.baseUrl);
  let allowModel!: () => void;
  let modelStarted!: () => void;
  const entered = new Promise<void>(resolve => { modelStarted = resolve; });
  const paused = new Promise<void>(resolve => { allowModel = resolve; });
  const provider: EmbeddingProvider = {
    endpointHash, providerKey: createProviderKey(endpointHash, "model"), isRemote: false,
    async embed(inputs) {
      modelStarted(); await paused;
      return { vectors: inputs.map(() => [1, 2]), dimension: 2,
        providerFingerprint: createProviderFingerprint(endpointHash, "model", 2) };
    }
  };
  const running = syncWatchedProjectMemory(root, config, { source: "git", embeddingProvider: provider });
  await entered;
  await withProjectGate(root, () => {
    assertNoDatabaseHandles(root);
    const changed = openConfiguredMemoryStore(root); changed.init();
    try { changed.addSourceWithChunks({ source: { id: "source-1", type: "conversation", title: "Source", origin: "fixture", rawContent: "New content" }, chunks: [{ text: "New content" }] }); }
    finally { changed.close(); }
  }, { name: "Apply AI review", waitMs: 1_000 });
  allowModel();
  const result = await running;
  expect(result.embeddings?.activeCoverage).toBe(0);
});
