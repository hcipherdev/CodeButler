import type { InvestigatorConfig } from "../types.js";
import {
  anthropicAwsRequestConfig,
  readAnthropicAwsText,
  runAnthropicAwsMessage,
  type AnthropicAwsHttpClient
} from "../providers/anthropic-aws.js";

export interface ReconciliationModelRequest {
  signal?: AbortSignal;
  system: string;
  payload: Record<string, unknown>;
  maxTokens: number;
}

export interface ReconciliationModelResponse {
  content: string;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/** Injectable so reconciliation tests never need a real network provider. */
export interface MemoryReconciliationProvider {
  provider: string;
  model: string;
  request(input: ReconciliationModelRequest): Promise<ReconciliationModelResponse>;
}

export function assertReconciliationProviderConfigured(config: InvestigatorConfig): void {
  if (!config.enabled) throw new Error("AI memory reconciliation requires an enabled investigator provider");
  if (!config.model.trim()) throw new Error("AI memory reconciliation requires an investigator model");
  requiredEnvironment(config.apiKeyEnv, "investigator API key");
  if (config.provider === "anthropic-aws") {
    requiredEnvironment(config.workspaceIdEnv ?? "ANTHROPIC_AWS_WORKSPACE_ID", "Anthropic AWS workspace ID");
    requiredEnvironment(config.regionEnv ?? "AWS_REGION", "AWS region");
  }
}

export function createMemoryReconciliationProvider(
  config: InvestigatorConfig,
  options: { fetchImpl?: typeof fetch | undefined; anthropicHttpClient?: AnthropicAwsHttpClient | undefined } = {}
): MemoryReconciliationProvider {
  assertReconciliationProviderConfigured(config);
  if (config.provider === "anthropic-aws") {
    return {
      provider: config.provider,
      model: config.model,
      async request(input) {
        const base = anthropicAwsRequestConfig({ ...config, maxTokens: input.maxTokens });
        const response = await runAnthropicAwsMessage({
          ...base,
          maxTokens: input.maxTokens,
          signal: input.signal,
          system: input.system,
          messages: [{ role: "user", content: JSON.stringify(input.payload) }]
        }, options.anthropicHttpClient);
        const content = readAnthropicAwsText(response);
        return { content };
      }
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    provider: config.provider,
    model: config.model,
    async request(input) {
      const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        ...(input.signal ? { signal: input.signal } : {}),
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env[config.apiKeyEnv] ?? ""}`
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          max_tokens: input.maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: JSON.stringify(input.payload) }
          ]
        })
      });
      if (!response.ok) throw new Error(`Memory reconciliation request failed with status ${response.status}`);
      const body = asRecord(await response.json());
      const choices = Array.isArray(body?.choices) ? body.choices : [];
      const message = asRecord(asRecord(choices[0])?.message);
      const content = typeof message?.content === "string" ? message.content : undefined;
      if (!content) throw new Error("Invalid memory reconciliation response");
      const usage = asRecord(body?.usage);
      return {
        content,
        ...(typeof usage?.prompt_tokens === "number" ? { inputTokens: usage.prompt_tokens } : {}),
        ...(typeof usage?.completion_tokens === "number" ? { outputTokens: usage.completion_tokens } : {})
      };
    }
  };
}

function requiredEnvironment(name: string, label: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`AI memory reconciliation ${label} is missing; set ${name}`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
