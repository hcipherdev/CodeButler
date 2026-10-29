import { SCOPE_GUIDANCE } from "../memory/scope.js";
import { chatCompletion } from "../ai/chat.js";
import { credentialStatus } from "../ai/credentials.js";
import { jobModel } from "../ai/models.js";
import type { AnthropicAwsHttpClient } from "../providers/anthropic-aws.js";
import { parseJsonFromModelText } from "../json.js";
import type { ExtractorConfig, InvestigatorConfig, ProjectConfig } from "../types.js";
import type { ProjectSummaryGenerator, ProjectSummaryGeneratorInput } from "./service.js";

type SummaryProviderConfig = ExtractorConfig | InvestigatorConfig;

const PROJECT_SUMMARY_SYSTEM_PROMPT = [
  SCOPE_GUIDANCE,
  "Write a concise project overview for a person reading it in Git or a desktop app.",
  "Use supplied manifests, docs, code, commits and scoped memories as evidence.",
  "Return surrounding prose only: what this is, how it is built, where things stand, open risks and questions, and how to verify changes.",
  "Decision and constraint sections are assembled separately from current durable project memories. Do not reproduce them.",
  "Preserve applicability qualifiers when mentioning a conditional fact. Omit inventory counts, absolute paths, runtime diagnostics, agent instructions and retrieval tool lists.",
  "Do not invent facts that are not supported by the supplied evidence.",
  "Respond with strict JSON shaped as {\"sections\":{\"what\":\"Markdown prose\",\"architecture\":\"Markdown prose\",\"status\":\"Markdown prose\",\"risks\":\"Markdown prose\",\"verification\":\"Markdown prose\"}}."
].join(" ");
const DEFAULT_PROJECT_SUMMARY_MAX_TOKENS = 8192;
const PROJECT_SUMMARY_REQUEST_TIMEOUT_MS = 300000;

export function createConfiguredProjectSummaryGenerator(config: ProjectConfig): ProjectSummaryGenerator {
  const providerConfig = jobModel(config, "summary");
  // Extraction/investigation profiles are deliberately small (1200/2500 tokens).
  // A full narrative needs its own budget or its JSON string can be cut off.
  const summaryConfig = { ...providerConfig, maxTokens: DEFAULT_PROJECT_SUMMARY_MAX_TOKENS };
  if (providerConfig.provider === "anthropic-aws" || providerConfig.provider === "anthropic") {
    return createAnthropicAwsProjectSummaryGenerator(summaryConfig);
  }
  return createOpenAICompatibleProjectSummaryGenerator(summaryConfig);
}

export function createOpenAICompatibleProjectSummaryGenerator(
  config: SummaryProviderConfig,
  fetchImpl: typeof fetch = fetch
): ProjectSummaryGenerator {
  return {
    name: `${config.provider}:${config.model}`,
    async generate(input, signal): Promise<string> {
      assertSummaryCredentials(config);
      const { content } = await chatCompletion(config, {
        job: "summary",
        system: PROJECT_SUMMARY_SYSTEM_PROMPT,
        user: JSON.stringify(projectSummaryPayload(input)),
        maxTokens: config.maxTokens ?? DEFAULT_PROJECT_SUMMARY_MAX_TOKENS,
        sendMaxTokens: true,
        signal,
        timeoutMs: PROJECT_SUMMARY_REQUEST_TIMEOUT_MS,
        errorLabel: "Project summary",
        invalidResponseMessage: "Invalid project summary response",
        timeoutMessage: "Project summary request timed out"
      }, { fetchImpl });
      return readSummaryMarkdown(content);
    }
  };
}

export function createAnthropicAwsProjectSummaryGenerator(
  config: SummaryProviderConfig,
  httpClient?: AnthropicAwsHttpClient
): ProjectSummaryGenerator {
  return {
    name: `${config.provider}:${config.model}`,
    async generate(input, signal): Promise<string> {
      assertSummaryCredentials(config);
      const { content } = await chatCompletion(config, {
        job: "summary",
        system: PROJECT_SUMMARY_SYSTEM_PROMPT,
        user: JSON.stringify(projectSummaryPayload(input)),
        maxTokens: config.maxTokens ?? DEFAULT_PROJECT_SUMMARY_MAX_TOKENS,
        signal,
        timeoutMs: PROJECT_SUMMARY_REQUEST_TIMEOUT_MS,
        errorLabel: "Project summary",
        invalidResponseMessage: "Invalid AnthropicAWS response"
      }, { anthropicHttpClient: httpClient });
      return readSummaryMarkdown(content);
    }
  };
}

function projectSummaryPayload(input: ProjectSummaryGeneratorInput): Record<string, unknown> {
  return {
    task: "generate_project_narrative_summary",
    fingerprint: input.fingerprint,
    notes: input.notes,
    codeContext: {
      manifests: input.codeContext.manifests, docs: input.codeContext.docs,
      codeFiles: input.codeContext.codeFiles, inventory: input.codeContext.inventory,
      memories: input.codeContext.memories.map(m => ({ type: m.type, title: m.title, statement: m.statement, summary: m.summary, scope: m.scope })),
      commits: input.codeContext.commits
    }
  };
}

function assertSummaryCredentials(config: SummaryProviderConfig): void {
  const status = credentialStatus(config);
  if (!status.ok) throw new Error(`Project summary provider credentials are missing; set ${status.missing.join(", ")}`);
}

function readSummaryMarkdown(content: string): string {
  const parsed = parseJsonFromModelText(content);
  const record = asRecord(parsed);
  const sections = asRecord(record?.sections);
  if (sections) {
    const names: Record<string, string> = { what: "What this is", architecture: "How it's built", status: "Where things stand", risks: "Open risks and questions", verification: "How to verify changes" };
    const prose = Object.entries(names).filter(([key]) => typeof sections[key] === "string" && (sections[key] as string).trim())
      .map(([key, heading]) => `## ${heading}\n\n${sections[key]}`).join("\n\n");
    if (!prose) throw new Error("Invalid project summary response");
    return prose;
  }
  const summaryMarkdown = record?.summaryMarkdown;
  if (typeof summaryMarkdown !== "string" || summaryMarkdown.trim().length === 0) {
    throw new Error("Invalid project summary response");
  }
  return summaryMarkdown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
