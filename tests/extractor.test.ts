import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenAICompatibleExtractor } from "../src/extract/openai.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("OpenAI-compatible extractor", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  it("parses valid extractor output", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                memories: [
                  {
                    type: "bug_fix",
                    title: "Fix stale cache reads",
                    summary: "Write invalidation was added after stale reads were reproduced.",
                    reason: "TTL-only invalidation left a stale read window.",
                    confidence: 0.92,
                    dedupeKey: "cache-stale-reads",
                    relatedFiles: ["src/cache.ts"],
                    evidence: [
                      { sourceType: "conversation", sourceId: "codex:session-1" },
                      { sourceType: "commit", sourceId: "abc123" }
                    ]
                  }
                ]
              })
            }
          }
        ]
      })
    });

    const extractor = createOpenAICompatibleExtractor(
      {
        provider: "openai-compatible",
        baseUrl: "https://example.test/v1",
        model: "gpt-test",
        apiKeyEnv: "TEST_API_KEY"
      },
      fetchMock as typeof fetch
    );

    const result = await extractor.extract({
      conversations: [{ sourceId: "codex:session-1", title: "session", rawContent: "cache stale read" }],
      commits: [
        {
          hash: "abc123",
          authorName: "Test User",
          authorEmail: "test@example.com",
          authoredAt: "2026-06-01T10:00:00Z",
          message: "Fix cache invalidation",
          changedFiles: ["src/cache.ts"],
          diffSummary: "+ invalidate after writes"
        }
      ]
    });

    expect(result.rejected).toEqual([]);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]).toMatchObject({
      type: "bug_fix",
      title: "Fix stale cache reads",
      confidence: 0.92,
      relatedFiles: ["src/cache.ts"]
    });
  });

  it("skips invalid individual memories and reports rejection reasons", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "{\"memories\":[{\"title\":\"missing fields\"}]}" } }]
      })
    });

    const extractor = createOpenAICompatibleExtractor(
      {
        provider: "openai-compatible",
        baseUrl: "https://example.test/v1",
        model: "gpt-test",
        apiKeyEnv: "TEST_API_KEY"
      },
      fetchMock as typeof fetch
    );

    await expect(extractor.extract({ conversations: [], commits: [] })).resolves.toEqual({
      memories: [],
      rejected: [{ index: 0, reason: "invalid_memory_record" }]
    });
  });

  it("still rejects invalid top-level extractor output", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "{\"items\":[]}" } }]
      })
    });

    const extractor = createOpenAICompatibleExtractor(
      {
        provider: "openai-compatible",
        baseUrl: "https://example.test/v1",
        model: "gpt-test",
        apiKeyEnv: "TEST_API_KEY"
      },
      fetchMock as typeof fetch
    );

    await expect(extractor.extract({ conversations: [], commits: [] })).rejects.toThrow("Invalid extractor response");
  });
});
