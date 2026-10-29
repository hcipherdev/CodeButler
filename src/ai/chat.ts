import { readAnthropicAwsText, runAnthropicAwsMessage, type AnthropicAwsHttpClient } from "../providers/anthropic-aws.js";
import { openAICompatibleChat, type ChatResult } from "../providers/openai-compatible.js";
import type { AiJob, ExtractorConfig, InvestigatorConfig } from "../types.js";
import { resolveApiKey, resolveAwsSettings } from "./credentials.js";
import { assertAiBudget, currentAiTrigger, recordAiUsage } from "./usage.js";

export interface ChatRequest {
  job: AiJob;
  system: string;
  user: string;
  maxTokens?: number | undefined;
  /** OpenAI-compatible calls send max_tokens only when asked; Anthropic always needs one. */
  sendMaxTokens?: boolean | undefined;
  jsonMode?: boolean | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  errorLabel: string;
  invalidResponseMessage: string;
  timeoutMessage?: string | undefined;
}
export interface ChatTransports {
  fetchImpl?: typeof fetch | undefined;
  anthropicHttpClient?: AnthropicAwsHttpClient | undefined;
}
export type { ChatResult };

type ChatModel = ExtractorConfig | InvestigatorConfig;

/**
 * Every model call goes through here: the provider's protocol, the key from the environment or
 * keychain, the daily background budget, and one usage line afterwards.
 */
export async function chatCompletion(model: ChatModel, request: ChatRequest, transports: ChatTransports = {}): Promise<ChatResult> {
  const trigger = currentAiTrigger();
  assertAiBudget(trigger);
  const result = model.provider === "anthropic" || model.provider === "anthropic-aws"
    ? await anthropicChat(model, request, transports.anthropicHttpClient)
    : await openAICompatibleChat(model, { ...request, maxTokens: request.sendMaxTokens ? request.maxTokens : undefined },
        // Legacy settings never failed locally on a missing key; the provider rejects the request instead.
        model.connectionId ? await resolveApiKey(model) : process.env[model.apiKeyEnv]?.trim(), transports.fetchImpl);
  recordAiUsage({
    at: new Date().toISOString(), job: request.job, trigger,
    ...(model.connectionId ? { connectionId: model.connectionId } : {}),
    model: model.model,
    // Providers that omit usage still count against the budget, estimated at about four bytes a token.
    inputTokens: result.inputTokens ?? Math.ceil(Buffer.byteLength(request.system + request.user) / 4),
    outputTokens: result.outputTokens ?? Math.ceil(Buffer.byteLength(result.content) / 4),
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {})
  });
  return result;
}

async function anthropicChat(model: ChatModel, request: ChatRequest, httpClient: AnthropicAwsHttpClient | undefined): Promise<ChatResult> {
  const direct = model.provider === "anthropic";
  const apiKey = await resolveApiKey(model, model.connectionLabel ?? (direct ? "Anthropic" : "Anthropic AWS"));
  const aws = direct ? undefined : resolveAwsSettings(model);
  const response = await runAnthropicAwsMessage({
    kind: direct ? "anthropic" : "anthropic-aws",
    model: model.model,
    maxTokens: request.maxTokens ?? model.maxTokens ?? 2048,
    system: request.system,
    messages: [{ role: "user", content: request.user }],
    apiKeyEnv: model.apiKeyEnv,
    workspaceIdEnv: model.workspaceIdEnv ?? "ANTHROPIC_AWS_WORKSPACE_ID",
    regionEnv: model.regionEnv ?? "AWS_REGION",
    baseUrl: model.baseUrl,
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    ...(apiKey ? { apiKey } : {}),
    ...(aws ?? {})
  }, httpClient);
  return {
    content: readAnthropicAwsText(response),
    ...(typeof response.usage?.input_tokens === "number" ? { inputTokens: response.usage.input_tokens } : {}),
    ...(typeof response.usage?.output_tokens === "number" ? { outputTokens: response.usage.output_tokens } : {})
  };
}
