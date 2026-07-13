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
                      {
                        sourceType: "conversation",
                        sourceId: "codex:session-1",
                        locator: "codex:session-1:chunk:0"
                      },
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
      conversations: [{
        sourceId: "codex:session-1",
        title: "session",
        rawContent: "cache stale read",
        chunks: [{ chunkIndex: 0, text: "cache stale read" }]
      }],
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
    const request = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(request.messages[0].content).toContain("exact supplied chunk ID");
    const providerContext = JSON.parse(request.messages[1].content);
    expect(providerContext.conversations[0].chunks[0]).toMatchObject({
      id: "codex:session-1:chunk:0",
      sourceId: "codex:session-1"
    });
  });

  it("skips invalid individual memories and reports rejection reasons", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ memories: [
          { title: "missing fields" },
          {
            type: "constraint", title: "Missing locator", summary: "A valid-looking memory.",
            reason: "Conversation evidence omitted its chunk.", confidence: 0.9,
            dedupeKey: "missing-locator", relatedFiles: [],
            evidence: [{ sourceType: "conversation", sourceId: "conv-1" }]
          }
        ] }) } }]
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
      rejected: [
        { index: 0, reason: "invalid_memory_record" },
        { index: 1, reason: "conversation_evidence_requires_exact_chunk_locator" }
      ]
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
