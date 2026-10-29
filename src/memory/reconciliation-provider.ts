import type { AiJob, ExtractorConfig, InvestigatorConfig, ProjectConfig } from "../types.js";
import { jobModel } from "../ai/models.js";
import { chatCompletion } from "../ai/chat.js";
import { credentialStatus } from "../ai/credentials.js";
import type { AnthropicAwsHttpClient } from "../providers/anthropic-aws.js";

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
  /** The AI settings connection name, for "Runs on" labels; absent for legacy settings. */
  connectionLabel?: string | undefined;
  connectionId?: string | undefined;
  request(input: ReconciliationModelRequest): Promise<ReconciliationModelResponse>;
}

type ReviewerConfig = (ExtractorConfig | InvestigatorConfig) & { enabled?: boolean | undefined };

export function assertReconciliationProviderConfigured(config: ReviewerConfig): void {
  if (config.enabled === false) throw new Error("AI memory reconciliation requires an enabled investigator provider");
  if (!config.model.trim()) throw new Error("AI memory reconciliation requires an investigator model");
  const status = credentialStatus(config);
  if (!status.ok) throw new Error(`AI memory reconciliation credentials are missing; set ${status.missing.join(", ")} or add the key in Code Butler's AI models settings`);
}

/** The model a review-style job runs on, ready to use. */
export function reviewProviderFor(config: Pick<ProjectConfig, "models" | "extractor" | "investigator">, job: AiJob): MemoryReconciliationProvider {
  return createMemoryReconciliationProvider(jobModel(config, job), { job });
}

export function assertJobConfigured(config: Pick<ProjectConfig, "models" | "extractor" | "investigator">, job: AiJob): void {
  assertReconciliationProviderConfigured(jobModel(config, job));
}

/** Review, wording, consolidation and rule drafting share this JSON request shape; `job` labels the usage. */
export function createMemoryReconciliationProvider(
  config: ReviewerConfig,
  options: { fetchImpl?: typeof fetch | undefined; anthropicHttpClient?: AnthropicAwsHttpClient | undefined; job?: AiJob | undefined } = {}
): MemoryReconciliationProvider {
  assertReconciliationProviderConfigured(config);
  return {
    provider: config.provider,
    model: config.model,
    ...(config.connectionLabel ? { connectionLabel: config.connectionLabel } : {}),
    ...(config.connectionId ? { connectionId: config.connectionId } : {}),
    async request(input) {
      const result = await chatCompletion(config, {
        job: options.job ?? "review",
        system: input.system,
        user: JSON.stringify(input.payload),
        maxTokens: input.maxTokens,
        sendMaxTokens: true,
        // Anthropic has no JSON mode; its prompts already ask for strict JSON.
        jsonMode: config.provider === "openai-compatible",
        signal: input.signal,
        errorLabel: "Memory reconciliation",
        invalidResponseMessage: "Invalid memory reconciliation response"
      }, { fetchImpl: options.fetchImpl, anthropicHttpClient: options.anthropicHttpClient });
      return {
        content: result.content,
        ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {})
      };
    }
  };
}
