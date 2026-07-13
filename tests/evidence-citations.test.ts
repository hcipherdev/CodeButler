import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
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
    mkdirSync(join(rootDir, "src"), { recursive: true });
    writeFileSync(join(rootDir, "src", "cache.ts"), "export const cache = true;\n");
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
      resolved: true,
      metadata: { path: realpathSync(join(rootDir, "src", "cache.ts")) }
    });
    expect(citations[5]).toMatchObject({
      kind: "project_summary",
      sourceId: "project-summary",
      resolved: true
    });

    store.close();
  });

  it("requires an exact source-owned conversation chunk locator", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    for (const id of ["conv-a", "conv-b"]) {
      store.addSourceWithChunks({
        source: { id, type: "conversation", title: `${id}.md`, origin: "test", rawContent: id },
        chunks: [{ text: `${id} first chunk` }]
      });
    }
    store.addCommit({
      hash: "commit-source",
      authorName: "Test",
      authorEmail: "test@example.com",
      authoredAt: "2026-07-11T00:00:00Z",
      message: "Commit source",
      changedFiles: [],
      diffSummary: ""
    });

    const citations = resolveEvidenceCitations(store, {
      evidence: [
        { sourceType: "conversation", sourceId: "conv-a", locator: "conv-a:chunk:0" },
        { sourceType: "conversation", sourceId: "conv-a" },
        { sourceType: "conversation", sourceId: "conv-a", locator: "conv-a:chunk:99" },
        { sourceType: "conversation", sourceId: "conv-a", locator: "conv-b:chunk:0" },
        { sourceType: "conversation", sourceId: "commit-source", locator: "commit-source:chunk:0" }
      ]
    });

    expect(citations).toEqual([
      expect.objectContaining({ kind: "conversation", locator: "conv-a:chunk:0", resolved: true }),
      expect.objectContaining({ kind: "conversation", sourceId: "conv-a", resolved: false }),
      expect.objectContaining({ kind: "conversation", locator: "conv-a:chunk:99", resolved: false }),
      expect.objectContaining({ kind: "conversation", locator: "conv-b:chunk:0", resolved: false }),
      expect.objectContaining({ kind: "conversation", sourceId: "commit-source", resolved: false })
    ]);
    store.close();
  });

  it("resolves only normalized real files contained by the repository", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    mkdirSync(join(rootDir, "src"), { recursive: true });
    writeFileSync(join(rootDir, "src", "real.ts"), "export {};\n");

    const citations = resolveEvidenceCitations(store, {
      evidence: [],
      relatedFiles: ["./src/../src/real.ts", "src/missing.ts", "../outside.ts"]
    });

    expect(citations).toEqual([
      expect.objectContaining({ kind: "file", sourceId: "src/real.ts", resolved: true }),
      expect.objectContaining({ kind: "file", sourceId: "src/missing.ts", resolved: false }),
      expect.objectContaining({ kind: "file", sourceId: "../outside.ts", resolved: false })
    ]);
    store.close();
  });
});
