// Tests bounded memory extraction, lossless evidence splitting, and provider batch failures.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicAwsExtractor } from "../../src/extract/anthropic-aws.js";
import { extractionBatches, extractionOutputGuidance, MAX_EXTRACTION_INPUT_BYTES } from "../../src/extract/context.js";
import { createOpenAICompatibleExtractor } from "../../src/extract/openai.js";
import type { ExtractorContext } from "../../src/types.js";

afterEach(() => vi.unstubAllEnvs());

function largeConversation(): ExtractorContext {
  const text = 'Decision: preserve Unicode 😀 and escaped "text".\n'.repeat(10_000);
  return {
    conversations: [{ sourceId: "codex:large", title: "large session", rawContent: text,
      chunks: [{ chunkIndex: 7, text, metadata: { role: "user" } }] }],
    commits: []
  };
}

function expectBounded(batches: ExtractorContext[]): void {
  for (const batch of batches) expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(MAX_EXTRACTION_INPUT_BYTES);
}

describe("extraction request sizing", () => {
  it("limits generated memories to fit the configured output budget", () => {
    expect(extractionOutputGuidance(2048)).toContain("at most 2");
    expect(extractionOutputGuidance(8192)).toContain("at most 8");
  });
  it("removes the duplicate transcript and preserves original chunk indices after filtering", () => {
    const [batch] = extractionBatches({ conversations: [{ sourceId: "conv", title: "session", rawContent: "A decision.",
      chunks: [{ text: "```code```" }, { text: "A decision." }] }], commits: [] });
    expect(batch!.conversations[0]).toMatchObject({ rawContent: "", chunks: [{ id: "conv:chunk:1", text: "A decision." }] });
  });

  it("splits a single huge message without losing text, metadata, or its evidence locator", () => {
    const context = largeConversation();
    const batches = extractionBatches(context);
    expect(batches.length).toBeGreaterThan(1);
    expectBounded(batches);
    const chunks = batches.flatMap(batch => batch.conversations.flatMap(conversation => conversation.chunks ?? []));
    expect(chunks.map(chunk => chunk.text).join("")).toBe(context.conversations[0]!.chunks![0]!.text);
    for (const chunk of chunks) expect(chunk).toMatchObject({ id: "codex:large:chunk:7", sourceId: "codex:large", metadata: { role: "user" } });
    expect(context.conversations[0]!.rawContent).not.toBe("");
  });

  it("bounds a batch of many conversations and retains all their message text", () => {
    const context: ExtractorContext = { conversations: Array.from({ length: 10 }, (_, index) => ({
      sourceId: `conv:${index}`, title: "session", rawContent: "duplicate transcript",
      chunks: Array.from({ length: 5 }, (_, chunkIndex) => ({ chunkIndex, text: `Decision ${index}: ` + "history ".repeat(3000) }))
    })), commits: [] };
    const batches = extractionBatches(context);
    expectBounded(batches);
    expect(batches.flatMap(batch => batch.conversations.flatMap(conversation => conversation.chunks?.map(chunk => chunk.text) ?? [])))
      .toEqual(context.conversations.flatMap(conversation => conversation.chunks!.map(chunk => chunk.text)));
  });

  it("bounds oversized commits and raw-only conversations without discarding their text", () => {
    const rawContent = "A project decision. ".repeat(20_000);
    const diffSummary = "+ changed line\n".repeat(20_000);
    const context: ExtractorContext = { conversations: [{ sourceId: "raw", title: "session", rawContent }], commits: [{
      hash: "commit", authorName: "Test", authorEmail: "test@example.test", authoredAt: "2026-10-02T00:00:00Z",
      message: "Fix extraction", changedFiles: ["src/extract/context.ts"], diffSummary
    }] };
    const batches = extractionBatches(context);
    expectBounded(batches);
    expect(batches.flatMap(batch => batch.conversations.map(conversation => conversation.rawContent)).join("")).toBe(rawContent);
    expect(batches.flatMap(batch => batch.commits.map(commit => commit.diffSummary)).join("")).toBe(diffSummary);
  });

  it("fails locally for oversized metadata rather than sending an unbounded request", () => {
    expect(() => extractionBatches({ conversations: [{ sourceId: "conv", title: "session", rawContent: "", metadata: {
      oversized: "x".repeat(MAX_EXTRACTION_INPUT_BYTES)
    } }], commits: [] })).toThrow("Extraction metadata exceeds");
  });
});

describe.each(["anthropic-aws", "openai-compatible"] as const)("%s extraction batching", provider => {
  function setup(failSecond = false) {
    vi.stubEnv("TEST_EXTRACTION_KEY", "test-key");
    vi.stubEnv("TEST_EXTRACTION_WORKSPACE", "test-workspace");
    vi.stubEnv("TEST_EXTRACTION_REGION", "us-east-1");
    const sent: ExtractorContext[] = [];
    const client = vi.fn(async (_url: string, init: { body?: unknown }) => {
      const body = JSON.parse(String(init.body));
      if (provider === "anthropic-aws") expect(body.max_tokens).toBe(8192);
      const batch = JSON.parse(body.messages[provider === "anthropic-aws" ? 0 : 1].content) as ExtractorContext;
      sent.push(batch);
      if (failSecond && sent.length === 2) throw new Error("second batch failed");
      const chunk = batch.conversations[0]!.chunks![0]!;
      const output = JSON.stringify({ memories: [{ type: "constraint", title: `Decision ${sent.length}`, summary: "Keep evidence IDs.",
        reason: "Split large extraction inputs safely.", confidence: 0.9, dedupeKey: `decision-${sent.length}`, relatedFiles: [],
        evidence: [{ sourceType: "conversation", sourceId: chunk.sourceId, locator: chunk.id }] }] });
      return { ok: true, status: 200, text: async () => "", json: async () => provider === "anthropic-aws"
        ? { content: [{ type: "text", text: output }] } : { choices: [{ message: { content: output } }] } };
    });
    const config = { provider, model: "test-model", apiKeyEnv: "TEST_EXTRACTION_KEY", workspaceIdEnv: "TEST_EXTRACTION_WORKSPACE", regionEnv: "TEST_EXTRACTION_REGION" };
    const extractor = provider === "anthropic-aws" ? createAnthropicAwsExtractor(config, client)
      : createOpenAICompatibleExtractor(config, client as unknown as typeof fetch);
    return { extractor, sent };
  }

  it("sends bounded requests and combines their extracted memories", async () => {
    const { extractor, sent } = setup();
    const result = await extractor.extract(largeConversation());
    expect(sent.length).toBeGreaterThan(1);
    expectBounded(sent);
    expect(result.memories).toHaveLength(sent.length);
    expect(result.rejected).toEqual([]);
  });

  it("rejects the full extraction if a later request fails, so queued evidence remains retryable", async () => {
    const { extractor, sent } = setup(true);
    await expect(extractor.extract(largeConversation())).rejects.toThrow("second batch failed");
    expect(sent).toHaveLength(2);
  });
});
