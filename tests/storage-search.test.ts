import { afterEach, describe, expect, it } from "vitest";

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
});
