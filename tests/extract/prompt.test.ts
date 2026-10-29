// Tests EXTRACTOR_SYSTEM_PROMPT and withInferredEvidenceTypes() in src/extract/prompt.ts and memoryRecordProblem() in src/extract/context.ts, through the OpenAI-compatible extractor.
import { describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleExtractor } from "../../src/extract/openai.js";
import { memoryRecordProblem } from "../../src/extract/context.js";
import { EXTRACTOR_SYSTEM_PROMPT, withInferredEvidenceTypes } from "../../src/extract/prompt.js";
import type { ExtractorContext } from "../../src/types.js";

const TYPES = ["decision", "bug_fix", "constraint", "rejected_approach"];
const context: ExtractorContext = {
  conversations: [{ sourceId: "claude:session-1", title: "session", rawContent: "", chunks: [{ chunkIndex: 0, text: "We chose batched quota checks because per-object sums were quadratic." }] }],
  commits: [{ hash: "abc123", authorName: "Test", authorEmail: "t@example.com", authoredAt: "2026-10-08T10:00:00Z", message: "Batch quota checks", changedFiles: ["src/cloud/opaque-store.ts"], diffSummary: "+ putObjects" }]
};
const memory = (evidence: unknown[]) => ({ type: "decision", title: "Batch quota", summary: "Quota is checked once per upload batch.",
  reason: "Per-object usage sums made uploads quadratic.", confidence: 0.9, dedupeKey: "batch-quota", relatedFiles: [], evidence });

describe("extraction prompt and evidence repair", () => {
  it("defines every memory type and the exact evidence shape", () => {
    for (const text of ["decision =", "constraint =", "bug_fix =", "rejected_approach =", "\"sourceType\":\"commit\"", "\"sourceType\":\"conversation\"", "exact supplied chunk ID"])
      expect(EXTRACTOR_SYSTEM_PROMPT).toContain(text);
  });

  it("excludes plans, status reports and unfixed bugs, and asks for a bug_fix's fix", () => {
    for (const text of ["plans, proposals, or next steps", "status reports", "UI layout", "not yet fixed is not a bug_fix", "statement.fields.fix", "below 0.7"])
      expect(EXTRACTOR_SYSTEM_PROMPT).toContain(text);
  });

  it("infers a missing sourceType only when the id names exactly one supplied source", () => {
    expect(withInferredEvidenceTypes(memory([{ sourceId: "abc123" }]), context)).toMatchObject({ evidence: [{ sourceType: "commit", sourceId: "abc123" }] });
    expect(withInferredEvidenceTypes(memory([{ sourceId: "claude:session-1", locator: "claude:session-1:chunk:0" }]), context))
      .toMatchObject({ evidence: [{ sourceType: "conversation" }] });
    expect(withInferredEvidenceTypes(memory([{ sourceId: "unknown" }]), context)).toMatchObject({ evidence: [{ sourceId: "unknown" }] });
    expect((withInferredEvidenceTypes(memory([{ sourceId: "unknown" }]), context) as { evidence: Array<Record<string, unknown>> }).evidence[0]!.sourceType).toBeUndefined();
  });

  it("names the first failing field of a rejected record", () => {
    expect(memoryRecordProblem(undefined, TYPES)).toBe("not_an_object");
    expect(memoryRecordProblem({ ...memory([{ sourceType: "commit", sourceId: "abc123" }]), type: "fact" }, TYPES)).toBe("invalid_type:fact");
    expect(memoryRecordProblem({ ...memory([{ sourceType: "commit", sourceId: "abc123" }]), reason: "" }, TYPES)).toBe("missing_reason");
    expect(memoryRecordProblem(memory([{ sourceId: "abc123" }]), TYPES)).toBe("invalid_evidence_reference:sourceType=undefined");
    expect(memoryRecordProblem(memory([{ sourceType: "commit", sourceId: "abc123", locator: 3 }]), TYPES)).toBe("invalid_evidence_reference:locator=number");
  });

  it("keeps a memory whose commit evidence omitted sourceType, and sends the shared prompt", async () => {
    vi.stubEnv("TEST_API_KEY", "test");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ memories: [memory([{ sourceId: "abc123" }])] }) } }] })));
    const extractor = createOpenAICompatibleExtractor({ provider: "openai-compatible", baseUrl: "https://example.test/v1", model: "gpt-test", apiKeyEnv: "TEST_API_KEY" }, fetchMock as unknown as typeof fetch);
    const result = await extractor.extract(context);
    vi.unstubAllEnvs();
    expect(result.rejected).toEqual([]);
    expect(result.memories[0]).toMatchObject({ type: "decision", evidence: [{ sourceType: "commit", sourceId: "abc123" }] });
    const request = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(request.messages[0].content.startsWith(EXTRACTOR_SYSTEM_PROMPT)).toBe(true);
  });
});
