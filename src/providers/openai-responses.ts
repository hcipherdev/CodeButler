import { setTimeout as delay } from "node:timers/promises";

import { AiConnectionError } from "../ai/errors.js";
import { AiPlanLimitError, recordPlanPause } from "../ai/usage.js";
import type { ChatResult } from "./openai-compatible.js";

/*
 * One Responses API call paid by the person's ChatGPT plan. The plan flow requires store:false and
 * stream:true, takes the system prompt as `instructions`, and rejects max_output_tokens, temperature,
 * system message items and previous_response_id, so none of those are sent.
 */

export const CHATGPT_USAGE_URL = "https://chatgpt.com/#settings";

export interface ResponsesRequest {
  model: string;
  system: string;
  user: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  errorLabel: string;
}
export interface ResponsesDeps {
  fetchImpl?: typeof fetch | undefined;
  /** A current access token; `force` asks for a refreshed one after a refusal. */
  accessToken: (force: boolean) => Promise<string>;
  connectionId?: string | undefined;
  baseUrl?: string | undefined;
  /** Waits between retries of a temporarily unavailable plan; injectable so tests do not wait. */
  backoff?: (attempt: number) => Promise<void>;
}

const RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 300_000;

interface ResponsesError { code?: string | undefined; message?: string | undefined; param?: string | undefined }

export async function openAIResponsesChat(request: ResponsesRequest, deps: ResponsesDeps): Promise<ChatResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const backoff = deps.backoff ?? (attempt => delay(2_000 * 2 ** attempt));
  const signal = AbortSignal.any([AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS), ...(request.signal ? [request.signal] : [])]);
  const body = JSON.stringify({
    model: request.model, instructions: request.system, input: [{ role: "user", content: request.user }], store: false, stream: true
  });
  let refreshed = false;
  for (let attempt = 0; ; attempt += 1) {
    const token = await deps.accessToken(refreshed);
    const response = await fetchImpl(`${(deps.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/responses`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream" }, body, signal
    });
    if (response.ok) return await readStream(response, request, deps);
    const error = await readError(response);
    // A refused token is refreshed once; a second refusal is a real sign-in problem.
    if ((response.status === 401 || error.code === "subscription_sharing_invalid_user") && !refreshed) { refreshed = true; continue; }
    if (temporarilyUnavailable(response.status, error.code) && attempt < RETRIES) { await backoff(attempt); continue; }
    throw planError(response.status, error, request, deps);
  }
}

function temporarilyUnavailable(status: number, code: string | undefined): boolean {
  return code === "subscription_sharing_usage_unavailable" || code === "subscription_sharing_user_unavailable" || (status === 503 && !code);
}

async function readError(response: Response): Promise<ResponsesError> {
  try {
    const value = await response.json() as { error?: ResponsesError; detail?: string };
    return value.error ?? { message: value.detail };
  } catch { return {}; }
}

/** Maps OpenAI's plan error codes to what the person can do about each. */
function planError(status: number, error: ResponsesError, request: ResponsesRequest, deps: ResponsesDeps): Error {
  switch (error.code) {
    case "subscription_sharing_usage_limit_exceeded":
      if (deps.connectionId) recordPlanPause(deps.connectionId);
      return new AiPlanLimitError();
    case "subscription_sharing_user_not_eligible":
      return new AiConnectionError("Your ChatGPT plan can't be used here. Using a ChatGPT plan in other apps needs Plus or Pro, and your workspace may not allow it.");
    case "subscription_sharing_invalid_user":
      return new AiConnectionError("OpenAI did not accept the ChatGPT sign-in. Sign out and sign in with ChatGPT again.");
    case "subscription_sharing_unsupported_capability":
      return new AiConnectionError(`The ChatGPT plan does not support ${error.param ? `"${error.param}" for ` : ""}this request${error.param === "model" ? "; choose another model" : ""}.`);
    default:
      if (status === 403) return new AiConnectionError(`ChatGPT refused the request${error.message ? `: ${bounded(error.message)}` : ""}.`);
      return new Error(`${request.errorLabel} request failed with status ${status}${error.code ? ` (${error.code})` : ""}`);
  }
}

/** Success only on response.completed; a stream that fails, stops early or is cut off is an error. */
async function readStream(response: Response, request: ResponsesRequest, deps: ResponsesDeps): Promise<ChatResult> {
  if (!response.body) throw new Error(`${request.errorLabel} returned no stream`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", text = "";
  const handle = (event: Record<string, unknown>): ChatResult | undefined => {
    const type = event.type;
    if (type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
    else if (type === "response.completed") {
      const usage = (event.response as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined)?.usage;
      // No costUsd: the person's plan is not billed per token.
      return { content: text, ...(typeof usage?.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
        ...(typeof usage?.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}) };
    } else if (type === "response.failed" || type === "error") {
      const error = (type === "error" ? event : (event.response as { error?: ResponsesError } | undefined)?.error) as ResponsesError | undefined;
      throw planError(0, error ?? {}, request, deps);
    } else if (type === "response.incomplete") {
      const reason = (event.response as { incomplete_details?: { reason?: string } } | undefined)?.incomplete_details?.reason;
      throw new Error(`${request.errorLabel} response was incomplete${reason ? ` (${reason})` : ""}`);
    }
    return undefined;
  };
  for (;;) {
    const { value, done } = await reader.read();
    buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, "\n");
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
      const result = handle(event);
      if (result) { await reader.cancel().catch(() => undefined); return result; }
    }
    if (done) throw new Error(`${request.errorLabel} stream ended before the response completed`);
  }
}

function bounded(text: string): string { return text.length > 300 ? `${text.slice(0, 300)}…` : text; }
