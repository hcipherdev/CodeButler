import {
  anthropicAwsRequestConfig,
  readAnthropicAwsText,
  runAnthropicAwsMessage,
  type AnthropicAwsHttpClient
} from "../providers/anthropic-aws.js";
import { parseJsonFromModelText } from "../json.js";
import type { ExtractorConfig, InvestigatorConfig, ProjectConfig } from "../types.js";
import type { ProjectSummaryGenerator, ProjectSummaryGeneratorInput } from "./service.js";

type SummaryProviderConfig = ExtractorConfig | InvestigatorConfig;

const PROJECT_SUMMARY_SYSTEM_PROMPT = [
  "You generate a project narrative summary for Code Butler.",
  "Treat AGENTS.md and CLAUDE.md as stale historical hints, not truth.",
  "Verify facts against the supplied manifests, docs, inventory, memories, commits, and sync state.",
  "Include project purpose, architecture, key subsystems, current constraints, important decisions, known risks/issues, verification commands, and how agents should retrieve detailed context from Butler.",
  "Do not invent facts that are not supported by the supplied evidence.",
  "Respond with strict JSON shaped as {\"summaryMarkdown\":\"...\"}."
].join(" ");
const DEFAULT_PROJECT_SUMMARY_MAX_TOKENS = 8192;

export function createConfiguredProjectSummaryGenerator(config: ProjectConfig): ProjectSummaryGenerator {
  const providerConfig =
    config.investigator.enabled
      ? config.investigator
      : config.extractor;
  if (providerConfig.provider === "anthropic-aws") {
    return createAnthropicAwsProjectSummaryGenerator(providerConfig);
  }
  return createOpenAICompatibleProjectSummaryGenerator(providerConfig);
}

export function createOpenAICompatibleProjectSummaryGenerator(
  config: SummaryProviderConfig,
  fetchImpl: typeof fetch = fetch
): ProjectSummaryGenerator {
  return {
    name: `${config.provider}:${config.model}`,
    async generate(input): Promise<string> {
      const apiKey = readRequiredProjectSummaryEnv(config.apiKeyEnv);
      const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          max_tokens: config.maxTokens ?? DEFAULT_PROJECT_SUMMARY_MAX_TOKENS,
          messages: [
            {
              role: "system",
              content: PROJECT_SUMMARY_SYSTEM_PROMPT
            },
            {
              role: "user",
              content: JSON.stringify(projectSummaryPayload(input))
            }
          ]
        })
      });
      if (!response.ok) {
        throw new Error(`Project summary request failed with status ${response.status}`);
      }
      return readSummaryMarkdown(readCompletionContent(await response.json()));
    }
  };
}

export function createAnthropicAwsProjectSummaryGenerator(
  config: SummaryProviderConfig,
  httpClient?: AnthropicAwsHttpClient
): ProjectSummaryGenerator {
  return {
    name: `${config.provider}:${config.model}`,
    async generate(input): Promise<string> {
      readRequiredProjectSummaryEnv(config.apiKeyEnv);
      const requestConfig = anthropicAwsRequestConfig(config);
      const payload = await runAnthropicAwsMessage(
        {
          ...requestConfig,
          maxTokens: config.maxTokens ?? DEFAULT_PROJECT_SUMMARY_MAX_TOKENS,
          system: PROJECT_SUMMARY_SYSTEM_PROMPT,
          messages: [{ role: "user", content: JSON.stringify(projectSummaryPayload(input)) }]
        },
        httpClient
      );
      return readSummaryMarkdown(readAnthropicAwsText(payload));
    }
  };
}

function projectSummaryPayload(input: ProjectSummaryGeneratorInput): Record<string, unknown> {
  return {
    task: "generate_project_narrative_summary",
    projectRoot: input.projectRoot,
    fingerprint: input.fingerprint,
    agentHints: input.agentHints,
    codeContext: input.codeContext
  };
}

function readRequiredProjectSummaryEnv(envName: string): string {
  const value = process.env[envName]?.trim();
  if (!value) {
    throw new Error(`Project summary provider credentials are missing; set ${envName}`);
  }
  return value;
}

function readSummaryMarkdown(content: string): string {
  const parsed = parseJsonFromModelText(content);
  const record = asRecord(parsed);
  const summaryMarkdown = record?.summaryMarkdown;
  if (typeof summaryMarkdown !== "string" || summaryMarkdown.trim().length === 0) {
    throw new Error("Invalid project summary response");
  }
  return summaryMarkdown;
}

function readCompletionContent(payload: unknown): string {
  const record = asRecord(payload);
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first?.message);
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    const joined = message.content
      .map((item) => {
        const part = asRecord(item);
        return typeof part?.text === "string" ? part.text : "";
      })
      .join("\n")
      .trim();
    if (joined) return joined;
  }
  throw new Error("Invalid project summary response");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
