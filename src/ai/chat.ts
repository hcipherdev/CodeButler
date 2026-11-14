import { readEnv } from "../project-env.js";
import { readAnthropicAwsText, runAnthropicAwsMessage, type AnthropicAwsHttpClient } from "../providers/anthropic-aws.js";
import { claudeCliChat, type ClaudeCliDeps } from "../providers/claude-cli.js";
import { openAIResponsesChat } from "../providers/openai-responses.js";
import { openAICompatibleChat, type ChatResult } from "../providers/openai-compatible.js";
import type { AiJob, ExtractorConfig, InvestigatorConfig } from "../types.js";
import { chatgptAccessToken } from "./chatgpt-auth.js";
import { assertConnectionAllowed } from "./connection-policy.js";
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
  claudeCli?: ClaudeCliDeps | undefined;
  /** Tests supply the ChatGPT token instead of a signed-in connection. */
  chatgptAccessToken?: ((force: boolean) => Promise<string>) | undefined;
}
export type { ChatResult };

type ChatModel = ExtractorConfig | InvestigatorConfig;

/**
 * Every model call goes through here: which connections may serve the call, the provider's protocol,
 * the key from the environment or keychain, the daily background budget, and one usage line afterwards.
 */
export async function chatCompletion(model: ChatModel, request: ChatRequest, transports: ChatTransports = {}): Promise<ChatResult> {
  assertConnectionAllowed(model, request.job);
  const trigger = currentAiTrigger();
  assertAiBudget(trigger, model);
  const result = await providerChat(model, request, transports);
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

async function providerChat(model: ChatModel, request: ChatRequest, transports: ChatTransports): Promise<ChatResult> {
  if (model.provider === "anthropic" || model.provider === "anthropic-aws") return anthropicChat(model, request, transports.anthropicHttpClient);
  if (model.provider === "openai-responses") {
    const connectionId = model.connectionId;
    return openAIResponsesChat({ model: model.model, system: request.system, user: request.user, signal: request.signal, timeoutMs: request.timeoutMs, errorLabel: request.errorLabel }, {
      fetchImpl: transports.fetchImpl, baseUrl: model.baseUrl, connectionId,
      accessToken: transports.chatgptAccessToken ?? (force => connectionId ? chatgptAccessToken(connectionId, { force }) : Promise.reject(new Error("ChatGPT needs a signed-in connection")))
    });
  }
  if (model.provider === "claude-cli") {
    return claudeCliChat({ model: model.model, system: request.system, user: request.user, cliPath: model.cliPath, signal: request.signal, timeoutMs: request.timeoutMs }, transports.claudeCli);
  }
  return openAICompatibleChat(model, { ...request, maxTokens: request.sendMaxTokens ? request.maxTokens : undefined },
    // Legacy settings never failed locally on a missing key; the provider rejects the request instead.
    model.connectionId ? await resolveApiKey(model) : readEnv(model.apiKeyEnv, model.envRoot), transports.fetchImpl);
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
    envRoot: model.envRoot,
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
