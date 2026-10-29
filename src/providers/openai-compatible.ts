import type { ExtractorConfig, InvestigatorConfig } from "../types.js";

export interface OpenAICompatibleChatRequest {
  system: string;
  user: string;
  /** Sent as max_tokens only when set; the extractor and investigator historically leave it out. */
  maxTokens?: number | undefined;
  jsonMode?: boolean | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  /** Prefixes "request failed with status N", e.g. "Extractor". */
  errorLabel: string;
  invalidResponseMessage: string;
  timeoutMessage?: string | undefined;
}
export interface ChatResult { content: string; inputTokens?: number | undefined; outputTokens?: number | undefined; costUsd?: number | undefined }

type ChatConfig = Pick<ExtractorConfig | InvestigatorConfig, "baseUrl" | "model" | "connectionKind" | "dataCollection">;

/** One OpenAI chat-completions call, shared by every OpenAI-compatible provider. */
export async function openAICompatibleChat(
  config: ChatConfig,
  request: OpenAICompatibleChatRequest,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<ChatResult> {
  const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
  const openRouter = config.connectionKind === "openrouter";
  const signals = [
    ...(request.timeoutMs ? [AbortSignal.timeout(request.timeoutMs)] : []),
    ...(request.signal ? [request.signal] : [])
  ];
  const body: Record<string, unknown> = {
    model: config.model,
    temperature: 0,
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    ...(request.jsonMode ? { response_format: { type: "json_object" } } : {}),
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user }
    ]
  };
  if (openRouter) {
    // Prompts carry commit diffs and chat logs, so by default only providers that keep nothing are used.
    const routing: Record<string, unknown> = {};
    if (config.dataCollection !== "allow") routing.data_collection = "deny";
    if (request.jsonMode) routing.require_parameters = true;
    if (Object.keys(routing).length) body.provider = routing;
    body.usage = { include: true };
  }
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      ...(signals.length ? { signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals) } : {}),
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(openRouter ? { "X-Title": "Code Butler" } : {})
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    if (request.timeoutMessage && error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) throw new Error(request.timeoutMessage);
    throw error;
  }
  if (!response.ok) throw new Error(`${request.errorLabel} request failed with status ${response.status}${await providerHint(response, openRouter)}`);
  const payload = asRecord(await response.json());
  const usage = asRecord(payload?.usage);
  return {
    content: readCompletionContent(payload, request.invalidResponseMessage),
    ...(typeof usage?.prompt_tokens === "number" ? { inputTokens: usage.prompt_tokens } : {}),
    ...(typeof usage?.completion_tokens === "number" ? { outputTokens: usage.completion_tokens } : {}),
    ...(typeof usage?.cost === "number" ? { costUsd: usage.cost } : {})
  };
}

/** OpenRouter states why a request was refused; other providers' bodies are not echoed. */
async function providerHint(response: Awaited<ReturnType<typeof fetch>>, openRouter: boolean): Promise<string> {
  if (response.status === 402) return ": the provider account is out of credit";
  if (response.status === 401) return ": the API key was rejected";
  if (response.status === 429) return ": the provider is rate limiting requests";
  if (!openRouter) return "";
  try {
    const message = asRecord(asRecord(await response.json())?.error)?.message;
    return typeof message === "string" && message.trim() ? `: ${message.trim().slice(0, 200)}` : "";
  } catch { return ""; }
}

export function readCompletionContent(payload: unknown, invalidResponseMessage: string): string {
  const record = asRecord(payload);
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  const message = asRecord(asRecord(choices[0])?.message);
  if (typeof message?.content === "string" && message.content) return message.content;
  if (Array.isArray(message?.content)) {
    const joined = message.content
      .map((item) => { const part = asRecord(item); return typeof part?.text === "string" ? part.text : ""; })
      .join("\n")
      .trim();
    if (joined) return joined;
  }
  throw new Error(invalidResponseMessage);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
