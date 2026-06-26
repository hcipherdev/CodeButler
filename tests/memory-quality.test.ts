import { afterEach, describe, expect, it } from "vitest";

import { assessMemoryQuality } from "../src/memory/quality.js";
import { openMemoryStore } from "../src/storage/store.js";
import type { ExtractedMemory } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("memory quality gate", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  function createStore() {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: {
        id: "conv-1",
        type: "conversation",
        title: "session.md",
        origin: "manual-import",
        rawContent: "Use SQLite for local project memory."
      },
      chunks: [{ text: "Use SQLite for local project memory." }]
    });
    store.addCommit({
      hash: "abc123",
      authorName: "Test User",
      authorEmail: "test@example.com",
      authoredAt: "2026-06-01T10:00:00Z",
      message: "Add SQLite store",
      changedFiles: ["src/storage/store.ts"],
      diffSummary: "+ sqlite store"
    });
    return store;
  }

  function memory(overrides: Partial<ExtractedMemory> = {}): ExtractedMemory {
    return {
      type: "decision",
      title: "Use SQLite",
      summary: "Use SQLite for local project memory.",
      reason: "Local-first memory needs an embedded database.",
      confidence: 0.92,
      evidence: [
        { sourceType: "conversation", sourceId: "conv-1", locator: "conv-1:chunk:0" },
        { sourceType: "commit", sourceId: "abc123" }
      ],
      relatedFiles: ["src/storage/store.ts"],
      dedupeKey: "sqlite-memory",
      ...overrides
    };
  }

  it("keeps clear prose with resolved evidence active", () => {
    const store = createStore();

    expect(assessMemoryQuality(store, memory())).toMatchObject({
      status: "active",
      rejected: false,
      resolvedEvidenceCount: 2,
      unresolvedEvidenceCount: 0,
      reasons: []
    });

    store.close();
  });

  it("quarantines HTML, code, JSON, and table-like memory content", () => {
    const store = createStore();

    const cases = [
      { summary: "</code></td><td>architecture.html</td>", reason: "html_or_markup_content" },
      { summary: "+ const cache = new Map();\n- old cache", reason: "code_or_diff_content" },
      { summary: "{\"decision\":\"Use SQLite\",\"reason\":\"local\"}", reason: "json_fragment_content" },
      { summary: "| file | owner |\n| src/a.ts | ai |", reason: "table_fragment_content" }
    ];

    for (const testCase of cases) {
      expect(assessMemoryQuality(store, memory({ summary: testCase.summary }))).toMatchObject({
        status: "quarantined",
        rejected: true,
        reasons: expect.arrayContaining([testCase.reason])
      });
    }

    store.close();
  });

  it("rejects empty, unresolved, and invalid confidence evidence", () => {
    const store = createStore();

    expect(assessMemoryQuality(store, memory({ evidence: [] }))).toMatchObject({
      status: "quarantined",
      rejected: true,
      reasons: expect.arrayContaining(["missing_evidence"])
    });
    expect(
      assessMemoryQuality(store, memory({ evidence: [{ sourceType: "conversation", sourceId: "missing" }] }))
    ).toMatchObject({
      status: "quarantined",
      rejected: true,
      reasons: expect.arrayContaining(["unresolved_evidence"])
    });
    expect(assessMemoryQuality(store, memory({ confidence: Number.NaN }))).toMatchObject({
      status: "quarantined",
      rejected: true,
      reasons: expect.arrayContaining(["invalid_confidence"])
    });

    store.close();
  });

  it("marks weak but usable memories for review instead of rejecting them", () => {
    const store = createStore();

    expect(assessMemoryQuality(store, memory({ confidence: 0.55 }))).toMatchObject({
      status: "needs_review",
      rejected: false,
      reasons: expect.arrayContaining(["low_confidence"])
    });

    store.close();
  });
});
