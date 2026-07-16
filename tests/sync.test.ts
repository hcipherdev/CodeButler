import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureProjectConfig, loadProjectConfig } from "../src/config.js";
import {
  createEmbeddingEndpointHash,
  createProviderFingerprint,
  createProviderKey
} from "../src/embeddings/fingerprint.js";
import type { EmbeddingBuildResult } from "../src/embeddings/service.js";
import type { EmbeddingProvider, ExtractorProvider } from "../src/types.js";
import { syncProjectMemory } from "../src/sync/service.js";
import { openMemoryStore } from "../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("automatic sync", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  function git(repo: string, args: string[]): string {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  }

  function createFixtureWorkspace(): {
    rootDir: string;
    repoDir: string;
    codexDir: string;
    claudeDir: string;
  } {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const repoDir = join(rootDir, "repo");
    const codexDir = join(rootDir, "codex", "archived_sessions");
    const claudeDir = join(rootDir, "claude", "projects", "project-a");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });

    git(repoDir, ["init"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test User"]);
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "cache.ts"), "export const cache = true;\n");
    git(repoDir, ["add", "src/cache.ts"]);
    git(repoDir, ["commit", "-m", "Add cache module"]);

    writeFileSync(
      join(codexDir, "rollout-test.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-06-01T10:00:00Z",
          type: "session_meta",
          payload: { id: "codex-session-1", cwd: repoDir }
        }),
        JSON.stringify({
          timestamp: "2026-06-01T10:00:01Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Why did src/cache.ts change?" }]
          }
        }),
        JSON.stringify({
          timestamp: "2026-06-01T10:00:02Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "It changed to fix stale cache reads." }]
          }
        })
      ].join("\n")
    );

    writeFileSync(
      join(claudeDir, "claude-session-1.jsonl"),
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-06-01T10:05:00Z",
          sessionId: "claude-session-1",
          cwd: repoDir,
          message: { role: "user", content: "The stale cache bug is reproducible." }
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-06-01T10:05:05Z",
          sessionId: "claude-session-1",
          cwd: repoDir,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Invalidate after writes to close the stale-read window." }]
          }
        })
      ].join("\n")
    );

    ensureProjectConfig(rootDir);
    writeFileSync(
      join(rootDir, ".code-butler", "config.json"),
      JSON.stringify(
        {
          sources: {
            git: { enabled: true, repoPath: "./repo", hookInstall: false, maxCommits: 50, maxDiffChars: 12000 },
            codex: { enabled: true, roots: ["./codex/archived_sessions"], includeDefaultRoots: false },
            claude: { enabled: true, roots: ["./claude/projects"] }
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
          }
        },
        null,
        2
      )
    );

    return { rootDir, repoDir, codexDir, claudeDir };
  }

  it("incrementally syncs git and conversation logs without duplicates", async () => {
    const { rootDir, repoDir, codexDir, claudeDir } = createFixtureWorkspace();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    const provider: ExtractorProvider = {
      async extract(context) {
        return {
          memories: [
            {
              type: "bug_fix",
              title: "Fix stale cache reads",
              summary: "Write invalidation was added after stale cache reads were discussed.",
              reason: "TTL-only behavior left stale reads after mutation.",
              confidence: 0.91,
              dedupeKey: "cache-stale-reads",
              relatedFiles: ["src/cache.ts"],
              evidence: [
                { sourceType: "commit", sourceId: context.commits[0]!.hash },
                {
                  sourceType: "conversation",
                  sourceId: context.conversations[0]!.sourceId,
                  locator: `${context.conversations[0]!.sourceId}:chunk:0`
                }
              ]
            }
          ],
          rejected: []
        };
      }
    };

    const first = await syncProjectMemory(store, config, { extractorProvider: provider });
    expect(first.sources.git.imported).toBe(1);
    expect(first.sources.codex.imported).toBe(1);
    expect(first.sources.claude.imported).toBe(1);
    expect(first.memories.promoted).toBe(1);
    expect(store.listMemories({ status: "promoted" })).toHaveLength(1);

    const second = await syncProjectMemory(store, config, { extractorProvider: provider });
    expect(second.sources.git.imported).toBe(0);
    expect(second.sources.codex.imported).toBe(0);
    expect(second.sources.claude.imported).toBe(0);
    expect(store.listMemories({ status: "promoted" })).toHaveLength(1);

    writeFileSync(join(repoDir, "src", "cache.ts"), "export function invalidateAfterWrite() { return true; }\n");
    git(repoDir, ["add", "src/cache.ts"]);
    git(repoDir, ["commit", "-m", "Invalidate cache after writes"]);
    writeFileSync(
      join(codexDir, "rollout-test.jsonl"),
      readFileSync(join(codexDir, "rollout-test.jsonl"), "utf8") +
        "\n" +
        JSON.stringify({
          timestamp: "2026-06-01T10:10:00Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "The root cause was stale cache invalidation after writes." }]
          }
        })
    );
    writeFileSync(
      join(claudeDir, "claude-session-1.jsonl"),
      readFileSync(join(claudeDir, "claude-session-1.jsonl"), "utf8") +
        "\n" +
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-06-01T10:10:05Z",
          sessionId: "claude-session-1",
          cwd: repoDir,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "This should be stored as a durable bug-fix memory." }]
          }
        })
    );

    const third = await syncProjectMemory(store, config, { extractorProvider: provider });
    expect(third.sources.git.imported).toBe(1);
    expect(third.sources.codex.imported).toBe(1);
    expect(third.sources.claude.imported).toBe(1);
    expect(store.listMemoryCandidates()).toHaveLength(1);
    expect(store.getSyncStatus("git")?.lastSyncAt).toBeTruthy();

    store.close();
  });

  it("persists sanitized parser failures and resolves them after a successful repair", async () => {
    const { rootDir, repoDir, codexDir } = createFixtureWorkspace();
    const failedPath = join(codexDir, "broken-secret.jsonl");
    const secret = "sk-proj-abcdefghijklmnop";
    writeFileSync(failedPath, `{"api_key":"${secret}`);
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    const extractorProvider: ExtractorProvider = {
      async extract() { return { memories: [], rejected: [] }; }
    };

    await syncProjectMemory(store, config, { source: "codex", extractorProvider });
    await syncProjectMemory(store, config, { source: "codex", extractorProvider });

    expect(store.getSyncCursor("codex", failedPath)).toBeUndefined();
    expect(store.listSourceFailures()).toEqual([
      expect.objectContaining({
        adapter: "codex",
        path: failedPath,
        errorCode: "invalid_jsonl",
        attempts: 2,
        message: "The conversation log contains invalid JSONL."
      })
    ]);
    expect(JSON.stringify(store.listSourceFailures())).not.toContain(secret);

    writeFileSync(
      failedPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "repaired", cwd: repoDir } }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Repaired log." }] }
        })
      ].join("\n")
    );
    await syncProjectMemory(store, config, { source: "codex", extractorProvider });

    expect(store.readSource("codex:repaired")).toBeDefined();
    expect(store.listSourceFailures()).toEqual([]);
    expect(store.listSourceFailures({ resolved: true })).toEqual([
      expect.objectContaining({ path: failedPath, resolvedAt: expect.any(String) })
    ]);
    store.close();
  });

  it("resolves a persisted failure when a repaired file matches its last known-good cursor", async () => {
    const { rootDir, codexDir } = createFixtureWorkspace();
    const filePath = join(codexDir, "rollout-test.jsonl");
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    const extractorProvider: ExtractorProvider = { async extract() { return { memories: [], rejected: [] }; } };
    await syncProjectMemory(store, config, { source: "codex", extractorProvider });
    expect(store.getSyncCursor("codex", filePath)).toBeDefined();
    store.recordSourceFailure({
      adapter: "codex",
      path: filePath,
      errorCode: "read_failed",
      message: "The conversation log could not be read."
    });

    await syncProjectMemory(store, config, { source: "codex", extractorProvider });

    expect(store.listSourceFailures()).toEqual([]);
    expect(store.listSourceFailures({ resolved: true })).toEqual([
      expect.objectContaining({ path: filePath, errorCode: "read_failed", resolvedAt: expect.any(String) })
    ]);
    store.close();
  });

  it("records valid non-object JSONL rows as structured unsupported-message failures", async () => {
    const { rootDir, codexDir, claudeDir } = createFixtureWorkspace();
    const codexPath = join(codexDir, "null.jsonl");
    const claudePath = join(claudeDir, "null.jsonl");
    writeFileSync(codexPath, "null\n");
    writeFileSync(claudePath, "null\n");
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    const extractorProvider: ExtractorProvider = { async extract() { return { memories: [], rejected: [] }; } };

    await expect(syncProjectMemory(store, config, { source: "all", extractorProvider })).resolves.toBeDefined();

    expect(store.listSourceFailures({ limit: null })).toEqual(expect.arrayContaining([
      expect.objectContaining({ adapter: "codex", path: codexPath, errorCode: "no_supported_messages" }),
      expect.objectContaining({ adapter: "claude", path: claudePath, errorCode: "no_supported_messages" })
    ]));
    store.close();
  });

  it("filters conversation logs to the current project by default", async () => {
    const { rootDir, repoDir, claudeDir } = createFixtureWorkspace();
    const encodedProjectDir = join(rootDir, "claude", "projects", repoDir.replace(/^\/+/, "").replaceAll("/", "-"));
    const unrelatedDir = join(rootDir, "claude", "projects", "-Users-spiel-Documents-other");
    mkdirSync(encodedProjectDir, { recursive: true });
    mkdirSync(unrelatedDir, { recursive: true });
    writeFileSync(
      join(encodedProjectDir, "encoded-match.jsonl"),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-01T12:00:00Z",
        sessionId: "encoded-match",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "This belongs to the encoded project path." }]
        }
      })
    );
    writeFileSync(
      join(unrelatedDir, "unrelated.jsonl"),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-01T12:01:00Z",
        sessionId: "unrelated",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "This belongs to a different project." }]
        }
      })
    );

    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);

    const result = await syncProjectMemory(store, config, { source: "claude" });

    expect(result.sources.claude.imported).toBe(2);
    expect(store.readSource("claude:claude-session-1")?.origin).toContain("claude-session-1.jsonl");
    expect(store.readSource("claude:encoded-match")?.origin).toContain("encoded-match.jsonl");
    expect(store.readSource("claude:unrelated")).toBeUndefined();
    expect(repoDir).toBeTruthy();
    store.close();
  });

  it("imports all configured conversation logs when project-only filtering is disabled", async () => {
    const { rootDir } = createFixtureWorkspace();
    const unrelatedDir = join(rootDir, "claude", "projects", "-Users-spiel-Documents-other");
    mkdirSync(unrelatedDir, { recursive: true });
    writeFileSync(
      join(unrelatedDir, "unrelated.jsonl"),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-01T12:01:00Z",
        sessionId: "unrelated",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "This global memory should import when project filtering is disabled." }]
        }
      })
    );
    const configPath = join(rootDir, ".code-butler", "config.json");
    const rawConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const sources = rawConfig.sources as Record<string, Record<string, unknown>>;
    sources.claude = { ...sources.claude, projectOnly: false };
    writeFileSync(configPath, JSON.stringify(rawConfig, null, 2));

    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);

    const result = await syncProjectMemory(store, config, { source: "claude" });

    expect(result.sources.claude.imported).toBe(2);
    expect(store.readSource("claude:unrelated")?.origin).toContain("unrelated.jsonl");
    store.close();
  });

  it("keeps low-confidence memories as candidates", async () => {
    const { rootDir } = createFixtureWorkspace();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    const provider: ExtractorProvider = {
      async extract(context) {
        return {
          memories: [
            {
              type: "constraint",
              title: "Cache invalidation follow-up",
              summary: "A follow-up constraint was noted.",
              reason: "Need to avoid stale reads.",
              confidence: 0.4,
              dedupeKey: "cache-follow-up",
              relatedFiles: ["src/cache.ts"],
              evidence: [
                { sourceType: "commit", sourceId: context.commits[0]!.hash },
                {
                  sourceType: "conversation",
                  sourceId: context.conversations[0]!.sourceId,
                  locator: `${context.conversations[0]!.sourceId}:chunk:0`
                }
              ]
            }
          ],
          rejected: []
        };
      }
    };

    const result = await syncProjectMemory(store, config, { extractorProvider: provider });
    expect(result.memories.promoted).toBe(0);
    expect(store.listMemoryCandidates({ qualityStatus: "all" })).toHaveLength(1);
    expect(store.listMemoryCandidates({ qualityStatus: "all" })[0]).toMatchObject({
      qualityStatus: "needs_review",
      qualityReasons: expect.arrayContaining(["low_confidence"])
    });
    expect(store.listMemories({ status: "promoted" })).toHaveLength(0);
    store.close();
  });

  it("persists valid extracted memories and reports rejected noisy memories", async () => {
    const { rootDir } = createFixtureWorkspace();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    const provider: ExtractorProvider = {
      async extract(context) {
        return {
          memories: [
            {
              type: "bug_fix",
              title: "Fix stale cache reads",
              summary: "Write invalidation was added after stale cache reads were discussed.",
              reason: "TTL-only behavior left stale reads after mutation.",
              confidence: 0.91,
              dedupeKey: "valid-cache-fix",
              relatedFiles: ["src/cache.ts"],
              evidence: [
                { sourceType: "commit", sourceId: context.commits[0]!.hash },
                {
                  sourceType: "conversation",
                  sourceId: context.conversations[0]!.sourceId,
                  locator: `${context.conversations[0]!.sourceId}:chunk:0`
                }
              ]
            },
            {
              type: "constraint",
              title: "Bad HTML",
              summary: "</code></td><td>architecture.html</td>",
              reason: "Noisy extractor output.",
              confidence: 0.9,
              dedupeKey: "bad-html",
              relatedFiles: [],
              evidence: [
                {
                  sourceType: "conversation",
                  sourceId: context.conversations[0]!.sourceId,
                  locator: `${context.conversations[0]!.sourceId}:chunk:0`
                }
              ]
            }
          ],
          rejected: [{ index: 2, reason: "invalid_memory_record" }]
        };
      }
    };

    const result = await syncProjectMemory(store, config, { extractorProvider: provider });

    expect(result.memories).toMatchObject({
      candidates: 1,
      promoted: 1,
      rejected: 2,
      skipped: false
    });
    expect(store.listMemories({ status: "promoted" })).toEqual([
      expect.objectContaining({
        title: "Fix stale cache reads",
        qualityStatus: "active"
      })
    ]);
    expect(store.listMemoryCandidates({ qualityStatus: "all" })).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ dedupeKey: "bad-html" })])
    );
    store.close();
  });

  it("promotes typed Codex remember directives without an extractor provider", async () => {
    const { rootDir, repoDir, codexDir } = createFixtureWorkspace();
    writeFileSync(
      join(codexDir, "directive.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-06-01T11:00:00Z",
          type: "session_meta",
          payload: { id: "codex-directive", cwd: repoDir }
        }),
        JSON.stringify({
          timestamp: "2026-06-01T11:00:01Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "remember this decision: Use SQLite for project memory." }]
          }
        })
      ].join("\n")
    );

    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);

    const result = await syncProjectMemory(store, config, { source: "codex" });

    expect(result.memories.promoted).toBe(1);
    expect(store.listMemories({ status: "promoted" })[0]).toMatchObject({
      type: "decision",
      summary: "Use SQLite for project memory.",
      confidence: 1,
      evidence: [
        { sourceType: "conversation", sourceId: "codex:codex-directive", locator: "codex:codex-directive:chunk:0" }
      ]
    });
    store.close();
  });

  it("keeps generic Claude remember directives as idempotent candidates", async () => {
    const { rootDir, repoDir, claudeDir } = createFixtureWorkspace();
    writeFileSync(
      join(claudeDir, "directive.jsonl"),
      JSON.stringify({
        type: "user",
        timestamp: "2026-06-01T11:00:00Z",
        sessionId: "claude-directive",
        cwd: repoDir,
        message: {
          role: "user",
          content: "remember this: Low-confidence memories should stay candidates."
        }
      })
    );

    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);

    await syncProjectMemory(store, config, { source: "claude" });
    await syncProjectMemory(store, config, { source: "claude" });

    expect(store.listMemoryCandidates()).toHaveLength(1);
    expect(store.listMemoryCandidates()[0]).toMatchObject({
      type: "constraint",
      summary: "Low-confidence memories should stay candidates.",
      confidence: 0.75,
      promotionState: "candidate"
    });
    expect(store.listMemories({ status: "promoted" })).toHaveLength(0);
    store.close();
  });

  it("creates temporary working context from recent Codex task logs", async () => {
    const { rootDir, repoDir, codexDir } = createFixtureWorkspace();
    const recentTimestamp = new Date().toISOString();
    writeFileSync(
      join(codexDir, "temporary-task.jsonl"),
      [
        JSON.stringify({
          timestamp: recentTimestamp,
          type: "session_meta",
          payload: { id: "codex-temp-task", cwd: repoDir }
        }),
        JSON.stringify({
          timestamp: recentTimestamp,
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "For this task: continue wiring temporary memory before durable memory in src/mcp/tools.ts."
              }
            ]
          }
        })
      ].join("\n")
    );

    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);

    const result = await syncProjectMemory(store, config, { source: "codex" });
    const temporary = store.searchTemporaryMemory({
      query: "temporary memory durable memory",
      sessionId: "codex-temp-task",
      now: new Date().toISOString()
    });

    expect(result.temporary.upserted).toBeGreaterThan(0);
    expect(temporary[0]).toMatchObject({
      kind: "user_instruction",
      sessionId: "codex-temp-task",
      relatedFiles: ["src/mcp/tools.ts"],
      evidence: [{ sourceType: "conversation", sourceId: "codex:codex-temp-task" }]
    });
    expect(store.listMemories()).not.toContainEqual(expect.objectContaining({ summary: expect.stringContaining("temporary memory") }));
    store.close();
  });

  it("does not create unexpired temporary context from old conversation logs", async () => {
    const { rootDir, repoDir, codexDir } = createFixtureWorkspace();
    const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(codexDir, "temporary-old.jsonl"),
      [
        JSON.stringify({
          timestamp: oldTimestamp,
          type: "session_meta",
          payload: { id: "codex-old-task", cwd: repoDir }
        }),
        JSON.stringify({
          timestamp: oldTimestamp,
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "For this task: continue old temporary memory work." }]
          }
        })
      ].join("\n")
    );

    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);

    const result = await syncProjectMemory(store, config, { source: "codex" });

    expect(result.temporary.upserted).toBe(0);
    expect(
      store.searchTemporaryMemory({
        query: "old temporary memory",
        sessionId: "codex-old-task",
        now: new Date().toISOString()
      })
    ).toEqual([]);
    store.close();
  });

  it("creates structural candidates from changed test files during git sync", async () => {
    const { rootDir, repoDir } = createFixtureWorkspace();
    mkdirSync(join(repoDir, "tests"), { recursive: true });
    writeFileSync(
      join(repoDir, "tests", "memory.test.ts"),
      'it("keeps low-confidence memories as candidates", async () => {});\n'
    );
    git(repoDir, ["add", "tests/memory.test.ts"]);
    git(repoDir, ["commit", "-m", "update tests"]);

    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);

    const result = await syncProjectMemory(store, config, { source: "git" });

    expect(result.memories.candidates).toBe(1);
    expect(result.memories.promoted).toBe(0);
    expect(store.listMemoryCandidates()[0]).toMatchObject({
      type: "constraint",
      title: "Keeps low-confidence memories as candidates",
      relatedFiles: ["tests/memory.test.ts"],
      promotionState: "candidate"
    });
    store.close();
  });

  it("routes extractor-unavailable and no-new-evidence outcomes through one post-commit embedding hook", async () => {
    const { rootDir } = createFixtureWorkspace();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    const calls: number[] = [];
    const embeddingBuilder = async (): Promise<EmbeddingBuildResult> => {
      calls.push(store.listEmbeddingOwners().length);
      return disabledEmbeddingResult();
    };

    const unavailable = await syncProjectMemory(store, config, { source: "git", embeddingBuilder });
    expect(calls).toHaveLength(1);
    expect(unavailable.embeddings).toMatchObject({ enabled: false, built: 0 });

    const noEvidence = await syncProjectMemory(store, config, {
      source: "git",
      extractorProvider: { async extract() { return { memories: [], rejected: [] }; } },
      embeddingBuilder
    });
    expect(noEvidence.memories).toMatchObject({ skipped: true, reason: "No new evidence" });
    expect(calls).toHaveLength(2);
    expect(noEvidence.embeddings).toMatchObject({ enabled: false, built: 0 });
    store.close();
  });

  it("runs the post-commit embedding hook exactly once after successful extraction", async () => {
    const { rootDir } = createFixtureWorkspace();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    let calls = 0;

    const result = await syncProjectMemory(store, config, {
      source: "git",
      extractorProvider: { async extract() { return { memories: [], rejected: [] }; } },
      embeddingBuilder: async () => {
        calls += 1;
        return disabledEmbeddingResult();
      }
    });

    expect(result.sources.git.imported).toBe(1);
    expect(result.memories).toMatchObject({ skipped: false });
    expect(calls).toBe(1);
    store.close();
  });

  it("runs the post-commit embedding hook exactly once after extractor failure", async () => {
    const { rootDir } = createFixtureWorkspace();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    let calls = 0;

    const result = await syncProjectMemory(store, config, {
      source: "git",
      extractorProvider: { async extract() { throw new Error("injected extractor failure"); } },
      embeddingBuilder: async () => {
        calls += 1;
        return disabledEmbeddingResult();
      }
    });

    expect(result.sources.git.imported).toBe(1);
    expect(result.memories.error).toBe("injected extractor failure");
    expect(calls).toBe(1);
    store.close();
  });

  it("keeps committed FTS evidence and returns a safe warning when the embedding hook rejects", async () => {
    const { rootDir } = createFixtureWorkspace();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    const sourceLikeText = "export const cache = true;";
    let calls = 0;

    const result = await syncProjectMemory(store, config, {
      source: "git",
      embeddingBuilder: async () => {
        calls += 1;
        throw new Error(`embedding hook echoed source: ${sourceLikeText}`);
      }
    });

    expect(calls).toBe(1);
    expect(result.sources.git.imported).toBe(1);
    expect(store.search({ query: "cache" }).length).toBeGreaterThan(0);
    expect(result.embeddings!.warnings).toEqual(["Embedding build failed"]);
    expect(result.embeddings!.warnings.join(" ")).not.toContain(sourceLikeText);
    store.close();
  });

  it("keeps disabled embeddings provider-free during sync", async () => {
    const { rootDir } = createFixtureWorkspace();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    let providerCalls = 0;
    const provider = syncEmbeddingProvider(config, async () => {
      providerCalls += 1;
      throw new Error("disabled provider must not run");
    });

    const result = await syncProjectMemory(store, config, { source: "git", embeddingProvider: provider });

    expect(result.embeddings).toMatchObject({ enabled: false, built: 0 });
    expect(providerCalls).toBe(0);
    expect(store.listEmbeddingJobs()).toEqual([]);
    store.close();
  });

  it("isolates embedding failures from committed sync data and retries failed jobs on the next sync", async () => {
    const { rootDir } = createFixtureWorkspace();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    config.embeddings.enabled = true;
    config.embeddings.model = "sync-model";
    let fail = true;
    const provider = syncEmbeddingProvider(config, async (inputs) => {
      if (fail) throw new Error("embedding api_key=sk-proj-abcdefghijklmnop failed");
      const dimension = 2;
      return {
        vectors: inputs.map(() => [1, 0]),
        dimension,
        providerFingerprint: createProviderFingerprint(provider.endpointHash, config.embeddings.model, dimension)
      };
    });

    const first = await syncProjectMemory(store, config, { source: "git", embeddingProvider: provider });
    expect(first.sources.git.imported).toBe(1);
    expect(first.embeddings).toMatchObject({ failed: expect.any(Number), built: 0 });
    expect(first.embeddings!.failed).toBeGreaterThan(0);
    expect(first.embeddings!.warnings.join(" ")).toContain("[REDACTED:API_KEY]");
    expect(store.search({ query: "cache" }).length).toBeGreaterThan(0);
    expect(store.listEmbeddingJobs({ state: "failed" }).every((job) => job.attempts === 1)).toBe(true);

    fail = false;
    const second = await syncProjectMemory(store, config, { source: "git", embeddingProvider: provider });
    expect(second.memories).toMatchObject({ skipped: true, reason: "Extractor not configured" });
    expect(second.embeddings).toMatchObject({ failed: 0, pending: 0 });
    expect(second.embeddings!.built).toBeGreaterThan(0);
    expect(store.listEmbeddingJobs({ state: "complete" }).every((job) => job.attempts === 2)).toBe(true);
    store.close();
  });
});

function disabledEmbeddingResult(): EmbeddingBuildResult {
  return {
    enabled: false,
    eligible: 0,
    activeCoverage: 0,
    usable: false,
    pending: 0,
    complete: 0,
    failed: 0,
    attempts: 0,
    warnings: ["Embeddings are disabled"],
    built: 0,
    retried: 0,
    enqueued: 0,
    removedJobs: 0,
    removedVectors: 0
  };
}

function syncEmbeddingProvider(
  config: ReturnType<typeof loadProjectConfig>,
  embed: EmbeddingProvider["embed"]
): EmbeddingProvider {
  const endpointHash = createEmbeddingEndpointHash(config.embeddings.baseUrl);
  return {
    endpointHash,
    providerKey: createProviderKey(endpointHash, config.embeddings.model),
    isRemote: false,
    embed
  };
}
