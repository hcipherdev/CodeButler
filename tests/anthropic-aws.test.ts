import { describe, expect, it, vi } from "vitest";

import { createAnthropicAwsExtractor } from "../src/extract/anthropic-aws.js";
import { createAnthropicAwsInvestigator } from "../src/investigate/anthropic-aws.js";
import { runAnthropicAwsMessage } from "../src/providers/anthropic-aws.js";
import type { ExtractorConfig, InvestigationPlannerState, InvestigatorConfig } from "../src/types.js";

function extractorConfig(overrides: Partial<ExtractorConfig> = {}): ExtractorConfig {
  return {
    provider: "anthropic-aws",
    model: "claude-haiku-4-5-20251001",
    apiKeyEnv: "ANTHROPIC_AWS_API_KEY",
    workspaceIdEnv: "ANTHROPIC_AWS_WORKSPACE_ID",
    regionEnv: "AWS_REGION",
    ...overrides
  };
}

function investigatorConfig(overrides: Partial<InvestigatorConfig> = {}): InvestigatorConfig {
  return {
    enabled: true,
    mode: "native-rlm",
    provider: "anthropic-aws",
    model: "claude-sonnet-4-6",
    apiKeyEnv: "ANTHROPIC_AWS_API_KEY",
    workspaceIdEnv: "ANTHROPIC_AWS_WORKSPACE_ID",
    regionEnv: "AWS_REGION",
    maxDepth: 3,
    maxSteps: 18,
    maxBranching: 2,
    topKPerSearch: 5,
    evidenceThreshold: 0.75,
    returnTrace: true,
    ...overrides
  };
}

describe("AnthropicAWS provider", () => {
  it("calls the regional Claude Platform on AWS Messages endpoint without Python", async () => {
    process.env.TEST_ANTHROPIC_AWS_API_KEY = "test-api-key";
    process.env.TEST_ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_test";
    process.env.TEST_AWS_REGION = "us-east-1";
    const httpMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: "text", text: "ok" }]
      }),
      text: async () => ""
    });

    const response = await runAnthropicAwsMessage(
      {
        model: "claude-haiku-4-5-20251001",
        maxTokens: 64,
        system: "Reply briefly.",
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
        apiKeyEnv: "TEST_ANTHROPIC_AWS_API_KEY",
        workspaceIdEnv: "TEST_ANTHROPIC_AWS_WORKSPACE_ID",
        regionEnv: "TEST_AWS_REGION"
      },
      httpMock
    );

    expect(response).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(httpMock).toHaveBeenCalledTimes(1);
    const [url, init] = httpMock.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe("https://aws-external-anthropic.us-east-1.api.aws/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      accept: "application/json",
      "content-type": "application/json",
      "content-length": "143",
      "anthropic-version": "2023-06-01",
      "X-Api-Key": "test-api-key",
      "anthropic-workspace-id": "wrkspc_test"
    });
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 64,
      system: "Reply briefly.",
      messages: [{ role: "user", content: "Reply with exactly: ok" }]
    });
  });

  it("includes response body details when the Messages request fails", async () => {
    process.env.TEST_ANTHROPIC_AWS_API_KEY = "test-api-key";
    process.env.TEST_ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_test";
    process.env.TEST_AWS_REGION = "us-east-1";
    const httpMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => "model access denied"
    });

    await expect(
      runAnthropicAwsMessage(
        {
          model: "claude-sonnet-4-6",
          maxTokens: 64,
          system: "Reply briefly.",
          messages: [{ role: "user", content: "Hello" }],
          apiKeyEnv: "TEST_ANTHROPIC_AWS_API_KEY",
          workspaceIdEnv: "TEST_ANTHROPIC_AWS_WORKSPACE_ID",
          regionEnv: "TEST_AWS_REGION"
        },
        httpMock
      )
    ).rejects.toThrow("AnthropicAWS request failed with status 403: model access denied");
  });

  it("maps extractor requests to Anthropic Messages and parses text output", async () => {
    process.env.TEST_ANTHROPIC_AWS_API_KEY = "test-api-key";
    process.env.TEST_ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_test";
    process.env.TEST_AWS_REGION = "us-east-1";
    const httpMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              memories: [
                {
                  type: "decision",
                  title: "Use Claude Platform on AWS",
                  summary: "Code Butler can call AnthropicAWS directly for extraction.",
                  reason: "The project uses Anthropic AWS API keys instead of Bedrock SigV4.",
                  confidence: 0.91,
                  dedupeKey: "anthropic-aws-provider",
                  relatedFiles: ["src/extract/anthropic-aws.ts"],
                  evidence: [{ sourceType: "commit", sourceId: "abc123" }]
                }
              ]
            })
          }
        ]
      }),
      text: async () => ""
    });

    const extractor = createAnthropicAwsExtractor(
      extractorConfig({
        apiKeyEnv: "TEST_ANTHROPIC_AWS_API_KEY",
        workspaceIdEnv: "TEST_ANTHROPIC_AWS_WORKSPACE_ID",
        regionEnv: "TEST_AWS_REGION"
      }),
      httpMock
    );
    const result = await extractor.extract({
      conversations: [],
      commits: [
        {
          hash: "abc123",
          authorName: "Test",
          authorEmail: "test@example.com",
          authoredAt: "2026-06-14T10:00:00Z",
          message: "Add AnthropicAWS provider",
          changedFiles: ["src/extract/anthropic-aws.ts"],
          diffSummary: "+ provider"
        }
      ]
    });

    expect(result.rejected).toEqual([]);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]?.title).toBe("Use Claude Platform on AWS");
    const [, init] = httpMock.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }];
    const body = JSON.parse(init.body as string);
    expect(body.system).toContain("Extract durable project memories");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.role).toBe("user");
  });

  it("parses fenced JSON extractor responses", async () => {
    process.env.TEST_ANTHROPIC_AWS_API_KEY = "test-api-key";
    process.env.TEST_ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_test";
    process.env.TEST_AWS_REGION = "us-east-1";
    const httpMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          {
            type: "text",
            text: [
              "```json",
              JSON.stringify({
                memories: [
                  {
                    type: "constraint",
                    title: "Use fenced JSON parser",
                    summary: "Extractor responses may be wrapped in JSON code fences.",
                    reason: "Claude can emit Markdown fences despite strict JSON instructions.",
                    confidence: 0.9,
                    dedupeKey: "extractor-fenced-json",
                    relatedFiles: ["src/extract/anthropic-aws.ts"],
                    evidence: [{ sourceType: "commit", sourceId: "abc123" }]
                  }
                ]
              }),
              "```"
            ].join("\n")
          }
        ]
      }),
      text: async () => ""
    });

    const extractor = createAnthropicAwsExtractor(
      extractorConfig({
        apiKeyEnv: "TEST_ANTHROPIC_AWS_API_KEY",
        workspaceIdEnv: "TEST_ANTHROPIC_AWS_WORKSPACE_ID",
        regionEnv: "TEST_AWS_REGION"
      }),
      httpMock
    );

    await expect(extractor.extract({ conversations: [], commits: [] })).resolves.toMatchObject({
      memories: [expect.objectContaining({ title: "Use fenced JSON parser" })],
      rejected: []
    });
  });

  it("maps investigator requests to Anthropic Messages and parses planner JSON", async () => {
    process.env.TEST_ANTHROPIC_AWS_API_KEY = "test-api-key";
    process.env.TEST_ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_test";
    process.env.TEST_AWS_REGION = "us-east-1";
    const httpMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              action: { type: "finalize_answer" },
              rationale: "Enough evidence is already present."
            })
          }
        ]
      }),
      text: async () => ""
    });

    const investigator = createAnthropicAwsInvestigator(
      investigatorConfig({
        apiKeyEnv: "TEST_ANTHROPIC_AWS_API_KEY",
        workspaceIdEnv: "TEST_ANTHROPIC_AWS_WORKSPACE_ID",
        regionEnv: "TEST_AWS_REGION"
      }),
      httpMock
    );
    const decision = await investigator.planNextAction(makePlannerState());

    expect(decision).toEqual({
      action: { type: "finalize_answer" },
      rationale: "Enough evidence is already present."
    });
    const [, init] = httpMock.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.max_tokens).toBe(2048);
    expect(body.system).toContain("project-history investigation planner");
  });
});

function makePlannerState(): InvestigationPlannerState {
  return {
    mode: "native-rlm",
    rootQuestion: "Why use AnthropicAWS?",
    question: "Why use AnthropicAWS?",
    depth: 0,
    node: {
      id: "node-1",
      question: "Why use AnthropicAWS?",
      depth: 0
    },
    budget: {
      maxDepth: 3,
      maxSteps: 18,
      maxBranching: 2,
      topKPerSearch: 5,
      evidenceThreshold: 0.75
    },
    trace: { steps: [] },
    evidence: [],
    visitedEntities: [],
    relatedCommits: [],
    relatedDecisions: [],
    relatedMemories: [],
    candidateMemories: [],
    searchResults: []
  };
}
