import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { addDecision } from "../src/decisions/store.js";
import { resolveEvidenceCitations } from "../src/evidence/citations.js";
import { openMemoryStore } from "../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("evidence citation resolution", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  it("resolves commits, conversation chunks, decisions, files, missing sources, and project summary citations", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    writeFileSync(join(rootDir, ".code-butler", "project-summary.md"), "# Project Summary\n\nUse SQLite.\n");
    expect(existsSync(join(rootDir, ".code-butler", "project-summary.md"))).toBe(true);

    store.addSourceWithChunks({
      source: {
        id: "conv-1",
        type: "conversation",
        title: "cache-session.md",
        origin: "manual-import",
        rawContent: "We chose write invalidation for src/cache.ts."
      },
      chunks: [
        {
          text: "We chose write invalidation for src/cache.ts.",
          metadata: { role: "user", turn_id: "turn-1" }
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
      diffSummary: "+ invalidate cache"
    });
    const decision = addDecision(store, {
      topic: "cache invalidation",
      decision: "Invalidate after writes",
      reason: "Avoid stale reads",
      status: "accepted",
      evidence: [{ sourceType: "conversation", sourceId: "conv-1", locator: "conv-1:chunk:0" }]
    });

    const citations = resolveEvidenceCitations(store, {
      evidence: [
        { sourceType: "commit", sourceId: "abc123" },
        { sourceType: "conversation", sourceId: "conv-1", locator: "conv-1:chunk:0" },
        { sourceType: "decision", sourceId: decision.id },
        { sourceType: "conversation", sourceId: "missing-conversation" }
      ],
      relatedFiles: ["src/cache.ts"],
      includeProjectSummary: true
    });

    expect(citations.map((citation) => citation.kind)).toEqual([
      "commit",
      "conversation",
      "decision",
      "missing",
      "file",
      "project_summary"
    ]);
    expect(citations[0]).toMatchObject({
      kind: "commit",
      sourceId: "abc123",
      label: "commit abc123",
      summary: "Invalidate cache after writes",
      resolved: true
    });
    expect(citations[1]).toMatchObject({
      kind: "conversation",
      sourceId: "conv-1",
      locator: "conv-1:chunk:0",
      label: "cache-session.md chunk 0",
      resolved: true
    });
    expect(citations[2]).toMatchObject({
      kind: "decision",
      sourceId: decision.id,
      label: "decision: cache invalidation",
      resolved: true
    });
    expect(citations[3]).toMatchObject({
      kind: "missing",
      sourceId: "missing-conversation",
      resolved: false
    });
    expect(citations[4]).toMatchObject({
      kind: "file",
      sourceId: "src/cache.ts",
      resolved: false
    });
    expect(citations[5]).toMatchObject({
      kind: "project_summary",
      sourceId: "project-summary",
      resolved: true
    });

    store.close();
  });
});
