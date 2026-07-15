import { afterEach, describe, expect, it } from "vitest";

import { addDecision } from "../src/decisions/store.js";
import { explainCodeChange, investigateProjectHistory } from "../src/investigate/history.js";
import { openMemoryStore } from "../src/storage/store.js";
import type {
  InvestigationAction,
  InvestigationPlannerState,
  InvestigationResult,
  InvestigatorProvider,
  ProjectConfig
} from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("native RLM investigation", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  function createProjectConfig(rootDir: string): ProjectConfig {
    return {
      configPath: `${rootDir}/.code-butler/config.json`,
      sources: {
        git: {
          enabled: true,
          repoPath: rootDir,
          hookInstall: false,
          maxCommits: 50,
          maxDiffChars: 12_000
        },
        codex: { enabled: true, roots: [], includeDefaultRoots: false, projectOnly: true },
        claude: { enabled: true, roots: [], projectOnly: true }
      },
      extractor: {
        provider: "openai-compatible",
        baseUrl: "https://example.test/v1",
        model: "gpt-test",
        apiKeyEnv: "TEST_API_KEY"
      },
      promotion: {
        confidenceThreshold: 0.85,
        requireCommitAndConversation: true,
        minSourceCategories: 2
      },
      sync: {
        autoSyncOnServerStart: true
      },
      retrieval: { mode: "fts", rrfK: 60 },
      embeddings: {
        enabled: false,
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "nomic-embed-text",
        batchSize: 16
      },
      privacy: { allowRemoteEmbeddings: false },
      deterministic: {
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
      },
      investigator: {
        enabled: true,
        mode: "native-rlm",
        provider: "openai-compatible",
        baseUrl: "https://example.test/v1",
        model: "gpt-investigator",
        apiKeyEnv: "TEST_API_KEY",
        maxDepth: 3,
        maxSteps: 18,
        maxBranching: 2,
        topKPerSearch: 5,
        evidenceThreshold: 0.75,
        returnTrace: true
      }
    };
  }

  function seedStore(rootDir: string) {
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: {
        id: "conv-cache",
        type: "conversation",
        title: "cache-discussion.md",
        origin: "manual-import",
        rawContent: [
          "We discussed src/cache.ts and found stale reads after writes.",
          "The likely fix is invalidating cache entries on mutation."
        ].join("\n\n")
      },
      chunks: [
        {
          text: "We discussed src/cache.ts and found stale reads after writes.",
          metadata: { turn_id: "turn_1", filePath: "src/cache.ts" }
        },
        {
          text: "The likely fix is invalidating cache entries on mutation.",
          metadata: { turn_id: "turn_2", filePath: "src/cache.ts" }
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
      evidence: [
        { sourceType: "conversation", sourceId: "conv-cache", locator: "conv-cache:chunk:0" },
        { sourceType: "commit", sourceId: "abc123" }
      ]
    });
    return store;
  }

  function createRecursiveProvider(): InvestigatorProvider {
    return {
      async planNextAction(state: InvestigationPlannerState) {
        if (state.depth === 0 && !state.trace.steps.some((step) => step.action.type === "spawn_subinvestigation")) {
          return {
            action: {
              type: "spawn_subinvestigation",
              question: "Read the exact cache discussion for src/cache.ts",
              targetEntity: { entityType: "commit", entityId: "abc123" }
            },
            rationale: "Inspect the commit branch first."
          };
        }

        if (state.depth === 1 && !state.trace.steps.some((step) => step.action.type === "read_source")) {
          return {
            action: {
              type: "read_source",
              sourceId: "conv-cache"
            },
            rationale: "Read the discussion source to confirm the reason."
          };
        }

        return {
          action: {
            type: "finalize_answer"
          },
          rationale: "There is enough evidence to answer."
        };
      },
      async synthesizeAnswer(state: InvestigationPlannerState) {
        return {
          answer: `We modified src/cache.ts to avoid stale reads after writes. Evidence gathered: ${state.evidence.length}.`,
          evidenceScore: 0.92
        };
      }
    };
  }

  it("runs a recursive child investigation and returns a full trace", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = seedStore(rootDir);

    const result = await explainCodeChange(
      store,
      { filePath: "src/cache.ts", question: "Why did we modify src/cache.ts?" },
      {
        config: createProjectConfig(rootDir),
        investigatorProvider: createRecursiveProvider()
      }
    );

    expect(result.mode).toBe("native-rlm");
    expect(result.status).toBe("complete");
    expect(result.trace.steps.length).toBeGreaterThan(1);
    expect(result.trace.steps.some((step) => step.action.type === "spawn_subinvestigation")).toBe(true);
    expect(result.trace.steps.some((step) => step.depth === 1)).toBe(true);
    expect(result.answer).toContain("stale reads");
    expect(result.evidenceScore).toBeGreaterThan(0.75);
    expect(result.terminationReason).toBeTruthy();

    store.close();
  });

  it("falls back to heuristic investigation when the investigator is unavailable", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = seedStore(rootDir);

    const result = await investigateProjectHistory(store, {
      question: "Why did caching change?",
      limit: 5
    });

    expect(result.mode).toBe("heuristic-fallback");
    expect(result.trace.steps.length).toBeGreaterThan(0);
    expect(result.answer).toContain("stale reads");
    expect(result.evidence.length).toBeGreaterThan(0);

    store.close();
  });

  it("seeds native RLM with temporary memory before durable memory and raw sources", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = seedStore(rootDir);
    store.upsertTemporaryMemory({
      id: "temp-cache-task",
      kind: "task_state",
      title: "Continue cache investigation",
      summary: "Continue cache invalidation investigation from the active session.",
      details: "Temporary working context says src/cache.ts was the current task before compaction.",
      relatedFiles: ["src/cache.ts"],
      evidence: [{ sourceType: "conversation", sourceId: "conv-cache", locator: "conv-cache:chunk:0" }],
      confidence: 0.9,
      threadId: "thread-a",
      sessionId: "session-a",
      sourceAdapter: "codex",
      createdAt: "2099-06-18T08:00:00.000Z",
      updatedAt: "2099-06-18T08:30:00.000Z",
      expiresAt: "2099-06-19T08:00:00.000Z"
    });
    const provider: InvestigatorProvider = {
      async planNextAction() {
        return {
          action: { type: "finalize_answer" },
          rationale: "Seed evidence is enough."
        };
      },
      async synthesizeAnswer(state: InvestigationPlannerState) {
        return {
          answer: `Temporary working context: ${state.temporaryMemories?.[0]?.summary ?? "none"}`,
          evidenceScore: 0.85
        };
      }
    };

    const result = await explainCodeChange(
      store,
      { filePath: "src/cache.ts", question: "Continue from where we left off on src/cache.ts" },
      {
        config: createProjectConfig(rootDir),
        investigatorProvider: provider
      }
    );

    expect(result.trace.steps[0]?.action.type).toBe("search_temporary_memory");
    expect(result.trace.steps[1]?.action.type).toBe("search_memories");
    expect(result.trace.steps.some((step) => step.action.type === "search_raw_sources")).toBe(true);
    expect(result.temporaryMemories?.[0]?.id).toBe("temp-cache-task");
    expect(result.answer).toContain("Temporary working context");
    store.close();
  });

  it("retries invalid planner output and then finalizes from existing evidence", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = seedStore(rootDir);
    let calls = 0;
    const provider: InvestigatorProvider = {
      async planNextAction() {
        calls += 1;
        if (calls === 1) {
          return {
            action: { type: "not-a-real-action" } as unknown as InvestigationAction,
            rationale: "bad action"
          };
        }
        return {
          action: {
            type: "finalize_answer"
          },
          rationale: "Recover after invalid action."
        };
      },
      async synthesizeAnswer(state: InvestigationPlannerState) {
        return {
          answer: `Recovered using ${state.evidence.length} evidence items.`,
          evidenceScore: 0.8
        };
      }
    };

    const result = await investigateProjectHistory(
      store,
      { question: "Why did caching change?" },
      {
        config: createProjectConfig(rootDir),
        investigatorProvider: provider
      }
    );

    expect(result.mode).toBe("native-rlm");
    expect(result.trace.steps.some((step) => step.status === "failed")).toBe(true);
    expect(result.answer).toContain("Recovered");
    expect(result.trace.steps.at(-1)?.action.type).toBe("finalize_answer");

    store.close();
  });
});
