import { afterEach, describe, expect, it, vi } from "vitest";

import { createFtsSearchIndex } from "../src/search/fts.js";
import { openMemoryStore } from "../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("SQLite FTS storage", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  it("indexes sources and returns ranked evidence", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();

    const sourceId = store.addSourceWithChunks({
      source: {
        type: "conversation",
        title: "cache-session.md",
        origin: "manual-import",
        rawContent: "We chose cache invalidation after writes to avoid stale reads."
      },
      chunks: [
        {
          text: "We chose cache invalidation after writes to avoid stale reads.",
          metadata: { turn_id: "turn_42" }
        }
      ]
    });

    const index = createFtsSearchIndex(store);
    const results = index.search({ query: "stale reads", limit: 5 });
    const source = store.readSource(sourceId);

    expect(results[0]).toMatchObject({
      sourceId,
      sourceType: "conversation",
      title: "cache-session.md",
      evidence: { sourceType: "conversation", sourceId }
    });
    expect(results[0]?.text).toContain("stale reads");
    expect(source?.rawContent).toContain("cache invalidation");

    store.close();
  });

  it("bulk-resolves more than 1000 chunks in requested order without exceeding SQLite variables", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: { id: "large", type: "conversation", title: "Large", origin: "fixture", rawContent: "large" },
      chunks: Array.from({ length: 1105 }, (_, index) => ({ text: `chunk ${index}` }))
    });
    const ids = Array.from({ length: 1105 }, (_, index) => `large:chunk:${1104 - index}`);
    const prepare = vi.spyOn(store.db, "prepare");
    const results = store.readSearchResultsByChunkIds(ids);
    const chunkSelects = prepare.mock.calls.filter(([sql]) => String(sql).includes("from chunks c join sources s"));
    expect(results).toHaveLength(1105);
    expect(results.map((result) => result.chunkId)).toEqual(ids);
    expect(chunkSelects).toHaveLength(3);
    prepare.mockRestore();
    store.close();
  });

  it("bulk-resolves memories without one query per id and preserves semantic order", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    const ids = Array.from({ length: 12 }, (_, index) => {
      const candidate = store.upsertMemoryCandidate({
        type: "decision", title: `Memory ${index}`, summary: `Summary ${index}`, reason: "test", confidence: 0.9,
        evidence: [], relatedFiles: [], dedupeKey: `bulk-memory-${index}`
      });
      return store.promoteMemoryCandidate(candidate.id).id;
    }).reverse();
    const prepare = vi.spyOn(store.db, "prepare");
    const results = store.readMemorySearchResultsByIds(ids);
    const memorySelects = prepare.mock.calls.filter(([sql]) => String(sql).includes("from memories"));
    expect(results.map((result) => result.id)).toEqual(ids);
    expect(memorySelects).toHaveLength(1);
    prepare.mockRestore();
    store.close();
  });
});
