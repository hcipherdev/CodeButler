import { afterEach, describe, expect, it } from "vitest";

import { addDecision } from "../src/decisions/store.js";
import { explainCodeChange, investigateProjectHistory } from "../src/investigate/history.js";
import { openMemoryStore } from "../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("project history investigation", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  it("connects a changed file to commits, conversations, and decisions", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();

    store.addSourceWithChunks({
      source: {
        type: "conversation",
        title: "cache-discussion.md",
        origin: "manual-import",
        rawContent: "We discussed src/cache.ts and chose invalidation after write to avoid stale reads."
      },
      chunks: [
        {
          text: "We discussed src/cache.ts and chose invalidation after write to avoid stale reads.",
          metadata: { turn_id: "turn_42" }
        }
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
      evidence: [{ sourceType: "conversation", sourceId: "cache-discussion.md", locator: "turn_42" }]
    });

    const explanation = await explainCodeChange(store, {
      filePath: "src/cache.ts",
      question: "Why did we modify src/cache.ts?"
    });

    expect(explanation.answer).toContain("src/cache.ts");
    expect(explanation.mode).toBe("heuristic-fallback");
    expect(explanation.trace.steps.length).toBeGreaterThan(0);
    expect(explanation.evidence.map((item) => item.sourceType)).toEqual(
      expect.arrayContaining(["commit", "conversation", "decision"])
    );
    expect(explanation.relatedCommits[0]?.hash).toBe("abc123");
  });

  it("investigates natural language questions with cited evidence", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: {
        type: "conversation",
        title: "cache-discussion.md",
        origin: "manual-import",
        rawContent: "The caching layer changed because write-through updates caused stale reads."
      },
      chunks: [
        {
          text: "The caching layer changed because write-through updates caused stale reads.",
          metadata: { turn_id: "turn_100" }
        }
      ]
    });

    const result = await investigateProjectHistory(store, {
      question: "Why did caching change?",
      limit: 5
    });

    expect(result.answer).toContain("stale reads");
    expect(result.mode).toBe("heuristic-fallback");
    expect(result.searchResults[0]?.title).toBe("cache-discussion.md");
    expect(result.evidence[0]).toMatchObject({ sourceType: "conversation" });

    store.close();
  });
});
