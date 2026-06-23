import { afterEach, describe, expect, it } from "vitest";

import { addDecision } from "../src/decisions/store.js";
import { openMemoryStore } from "../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("investigation storage helpers", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  it("reads conversation windows and expands file/entity links", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();

    store.addSourceWithChunks({
      source: {
        id: "conv-1",
        type: "conversation",
        title: "cache-session.md",
        origin: "manual-import",
        rawContent: [
          "We saw stale reads in src/cache.ts.",
          "We should invalidate after writes.",
          "That should stop stale cache state."
        ].join("\n\n")
      },
      chunks: [
        { text: "We saw stale reads in src/cache.ts.", metadata: { turn_id: "t1" } },
        { text: "We should invalidate after writes.", metadata: { turn_id: "t2" } },
        { text: "That should stop stale cache state.", metadata: { turn_id: "t3" } }
      ]
    });

    store.addCommit({
      hash: "abc123",
      authorName: "Test User",
      authorEmail: "test@example.com",
      authoredAt: "2026-06-01T10:00:00Z",
      message: "Invalidate cache after writes",
      changedFiles: ["src/cache.ts"],
      diffSummary: "+ invalidate cache after write"
    });

    addDecision(store, {
      topic: "caching layer",
      decision: "Invalidate cache after writes",
      reason: "Avoid stale reads after mutation",
      status: "accepted",
      evidence: [
        { sourceType: "conversation", sourceId: "conv-1", locator: "conv-1:chunk:1" },
        { sourceType: "commit", sourceId: "abc123" }
      ]
    });

    const window = store.readConversationWindow("conv-1", "conv-1:chunk:1", 1, 1);
    const commit = store.readCommit("abc123");
    const links = store.getEntityLinks({ entityType: "commit", entityId: "abc123" });
    const mentioned = store.findSourcesMentioningFile("src/cache.ts", 5);
    const memories = store.findMemoriesByEvidence("commit", "abc123", 5);

    expect(window.map((chunk) => chunk.id)).toEqual(["conv-1:chunk:0", "conv-1:chunk:1", "conv-1:chunk:2"]);
    expect(commit?.message).toBe("Invalidate cache after writes");
    expect(links.some((link) => link.targetType === "file" && link.targetId === "src/cache.ts")).toBe(true);
    expect(mentioned.some((source) => source.id === "conv-1")).toBe(true);
    expect(memories.some((memory) => memory.type === "decision")).toBe(true);

    store.close();
  });
});
