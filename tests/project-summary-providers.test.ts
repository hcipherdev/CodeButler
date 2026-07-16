import { describe, expect, it, vi } from "vitest";

import {
  createAnthropicAwsProjectSummaryGenerator,
  createConfiguredProjectSummaryGenerator,
  createOpenAICompatibleProjectSummaryGenerator
} from "../src/project-summary/providers.js";
import type { ProjectSummaryGeneratorInput } from "../src/project-summary/service.js";
import type { ExtractorConfig, ProjectConfig } from "../src/types.js";

function makeInput(): ProjectSummaryGeneratorInput {
  return {
    projectRoot: "/tmp/project",
    fingerprint: "abc123",
    agentHints: [{ fileName: "AGENTS.md", content: "old instructions" }],
    codeContext: {
      manifests: [{ path: "package.json", content: "{\"scripts\":{\"test\":\"vitest\"}}" }],
      docs: [{ path: "README.md", content: "# Project\n" }],
      codeFiles: [],
      inventory: ["src", "tests"],
      commits: [],
      projectState: {
        sources: 0,
        chunks: 0,
        commits: 0,
        decisions: 0,
        candidateMemories: 0,
        promotedMemories: 0,
        syncSources: {}
      },
      memories: []
    }
  };
}

function openAiConfig(overrides: Partial<ExtractorConfig> = {}): ExtractorConfig {
  return {
    provider: "openai-compatible",
    baseUrl: "https://example.test/v1",
    model: "gpt-test",
    apiKeyEnv: "TEST_PROJECT_SUMMARY_OPENAI_KEY",
    ...overrides
  };
}

describe("project summary providers", () => {
  it("maps OpenAI-compatible responses to summary markdown", async () => {
    process.env.TEST_PROJECT_SUMMARY_OPENAI_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ summaryMarkdown: "# OpenAI Brief\n" }) } }]
      })
    });
    const generator = createOpenAICompatibleProjectSummaryGenerator(openAiConfig(), fetchMock);

    await expect(generator.generate(makeInput())).resolves.toBe("# OpenAI Brief\n");
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://example.test/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer test-key");
    expect(JSON.parse(init.body)).toMatchObject({
      model: "gpt-test",
      temperature: 0
    });
    expect(JSON.parse(init.body).messages[0].content).toContain("project narrative summary");
  });

  it("accepts fenced JSON project summary responses", async () => {
    process.env.TEST_PROJECT_SUMMARY_OPENAI_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: [
                "```json",
                JSON.stringify({ summaryMarkdown: "# Fenced Brief\n" }, null, 2),
                "```"
              ].join("\n")
            }
          }
        ]
      })
    });
    const generator = createOpenAICompatibleProjectSummaryGenerator(openAiConfig(), fetchMock);

    await expect(generator.generate(makeInput())).resolves.toBe("# Fenced Brief\n");
  });

  it("accepts fenced JSON project summary responses with surrounding prose", async () => {
    process.env.TEST_PROJECT_SUMMARY_OPENAI_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: [
                "Here is the JSON:",
                "```json",
                JSON.stringify({ summaryMarkdown: "# Prose Wrapped Brief\n" }, null, 2),
                "```",
                "Generated from the supplied evidence."
              ].join("\n")
            }
          }
        ]
      })
    });
    const generator = createOpenAICompatibleProjectSummaryGenerator(openAiConfig(), fetchMock);

    await expect(generator.generate(makeInput())).resolves.toBe("# Prose Wrapped Brief\n");
  });

  it("maps Anthropic AWS responses to summary markdown", async () => {
    process.env.TEST_PROJECT_SUMMARY_AWS_KEY = "test-key";
    process.env.TEST_PROJECT_SUMMARY_WORKSPACE_ID = "wrkspc_test";
    process.env.TEST_PROJECT_SUMMARY_REGION = "us-east-1";
    const httpMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: "text", text: JSON.stringify({ summaryMarkdown: "# AWS Brief\n" }) }]
      }),
      text: async () => ""
    });
    const generator = createAnthropicAwsProjectSummaryGenerator(
      {
        provider: "anthropic-aws",
        model: "claude-test",
        apiKeyEnv: "TEST_PROJECT_SUMMARY_AWS_KEY",
        workspaceIdEnv: "TEST_PROJECT_SUMMARY_WORKSPACE_ID",
        regionEnv: "TEST_PROJECT_SUMMARY_REGION"
      },
      httpMock
    );

    await expect(generator.generate(makeInput())).resolves.toBe("# AWS Brief\n");
    const [, init] = httpMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.max_tokens).toBe(8192);
    expect(body.system).toContain("project narrative summary");
    expect(body.messages[0].content).toContain("AGENTS.md");
  });

  it("fails clearly when configured provider credentials are missing", async () => {
    delete process.env.TEST_PROJECT_SUMMARY_OPENAI_KEY;
    const config = {
      extractor: openAiConfig(),
      investigator: {
        enabled: true,
        mode: "native-rlm",
        provider: "openai-compatible",
        baseUrl: "https://example.test/v1",
        model: "gpt-test",
        apiKeyEnv: "TEST_PROJECT_SUMMARY_OPENAI_KEY",
        maxDepth: 1,
        maxSteps: 1,
        maxBranching: 1,
        topKPerSearch: 1,
        evidenceThreshold: 0.75,
        returnTrace: true
      }
    } as ProjectConfig;

    const generator = createConfiguredProjectSummaryGenerator(config);

    await expect(generator.generate(makeInput())).rejects.toThrow(
      "Project summary provider credentials are missing; set TEST_PROJECT_SUMMARY_OPENAI_KEY"
    );
  });
});
