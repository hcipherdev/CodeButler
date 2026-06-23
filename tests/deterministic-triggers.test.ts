import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { extractDeterministicMemories } from "../src/deterministic/triggers.js";
import type { ProjectConfig } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

const baseConfig: ProjectConfig["deterministic"] = {
  enabled: true,
  promoteStrongSignals: true,
  triggers: {
    conversationDirectives: true,
    gitChangedFiles: true,
    decisionFiles: true,
    testExpectations: true,
    packageAndConfigFacts: true,
    docsFacts: true
  }
};

describe("deterministic memory triggers", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  it("extracts typed remember directives from conversation text as promoted memories", () => {
    const result = extractDeterministicMemories(
      {
        conversations: [
          {
            sourceId: "codex:session-1",
            title: "session.jsonl",
            rawContent: "user: remember this decision: Use SQLite for local project memory.",
            chunks: [
              {
                chunkIndex: 0,
                text: "remember this decision: Use SQLite for local project memory.",
                metadata: { role: "user" }
              }
            ]
          }
        ],
        commits: []
      },
      { deterministic: baseConfig }
    );

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]).toMatchObject({
      type: "decision",
      title: "Use SQLite for local project memory",
      summary: "Use SQLite for local project memory.",
      reason: "Captured from explicit conversation directive.",
      confidence: 1,
      dedupeKey: "deterministic:conversation:codex:session-1:0"
    });
    expect(result.memories[0]?.evidence).toEqual([
      { sourceType: "conversation", sourceId: "codex:session-1", locator: "codex:session-1:chunk:0" }
    ]);
    expect(result.promoteDedupeKeys).toEqual(["deterministic:conversation:codex:session-1:0"]);
  });

  it("keeps generic remember directives as constraint candidates", () => {
    const result = extractDeterministicMemories(
      {
        conversations: [
          {
            sourceId: "claude:session-1",
            title: "session.jsonl",
            rawContent: "user: remember this: Low-confidence memories should stay candidates.",
            chunks: [
              {
                chunkIndex: 0,
                text: "remember this: Low-confidence memories should stay candidates.",
                metadata: { role: "user" }
              }
            ]
          }
        ],
        commits: []
      },
      { deterministic: baseConfig }
    );

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]).toMatchObject({
      type: "constraint",
      confidence: 0.75,
      dedupeKey: "deterministic:conversation:claude:session-1:0"
    });
    expect(result.promoteDedupeKeys).toEqual([]);
  });

  it("extracts test expectation candidates from changed test files", () => {
    const result = extractDeterministicMemories(
      {
        conversations: [],
        commits: [
          {
            hash: "abc123",
            authorName: "Test User",
            authorEmail: "test@example.com",
            authoredAt: "2026-06-01T10:00:00Z",
            message: "update tests",
            changedFiles: ["tests/sync.test.ts"],
            diffSummary: '+  it("keeps low-confidence memories as candidates", async () => {})'
          }
        ]
      },
      { deterministic: baseConfig }
    );

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]).toMatchObject({
      type: "constraint",
      title: "Keeps low-confidence memories as candidates",
      relatedFiles: ["tests/sync.test.ts"],
      confidence: 0.7,
      dedupeKey: "deterministic:test:tests/sync.test.ts:keeps-low-confidence-memories-as-candidates"
    });
    expect(result.promoteDedupeKeys).toEqual([]);
  });

  it("promotes explicit decision files changed by git commits", () => {
    const repoPath = makeTempDir();
    tempDirs.push(repoPath);
    mkdirSync(join(repoPath, "docs", "adr"), { recursive: true });
    writeFileSync(
      join(repoPath, "docs", "adr", "001-memory.md"),
      [
        "# Decision: deterministic memory triggers",
        "",
        "Status: accepted",
        "",
        "Decision: Parse explicit remember directives before LLM extraction",
        "",
        "Reason: Users need reliable memory capture without depending on model inference"
      ].join("\n")
    );

    const result = extractDeterministicMemories(
      {
        conversations: [],
        commits: [
          {
            hash: "abc123",
            authorName: "Test User",
            authorEmail: "test@example.com",
            authoredAt: "2026-06-01T10:00:00Z",
            message: "add adr",
            changedFiles: ["docs/adr/001-memory.md"],
            diffSummary: ""
          }
        ]
      },
      { deterministic: baseConfig, repoPath }
    );

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]).toMatchObject({
      type: "decision",
      title: "deterministic memory triggers",
      summary: "Parse explicit remember directives before LLM extraction",
      reason: "Users need reliable memory capture without depending on model inference",
      confidence: 1,
      dedupeKey: "deterministic:decision-file:docs/adr/001-memory.md:deterministic-memory-triggers"
    });
    expect(result.promoteDedupeKeys).toEqual([
      "deterministic:decision-file:docs/adr/001-memory.md:deterministic-memory-triggers"
    ]);
  });
});
