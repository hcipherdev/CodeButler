// Tests openAIResponsesChat() in src/providers/openai-responses.ts through chatCompletion(): plan streaming, token refresh on refusal, plan error codes and the background plan pause in src/ai/usage.ts.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatCompletion } from "../../src/ai/chat.js";
import { AiConnectionError } from "../../src/ai/errors.js";
import { AI_PLAN_LIMIT_REASON, AiPausedError, AiPlanLimitError, backgroundPauseReason, planPaused, readAiUsage, usageDay, withAiTrigger } from "../../src/ai/usage.js";
import type { ExtractorConfig } from "../../src/types.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

let directory: string;
beforeEach(() => {
  directory = makeTempDir();
  vi.stubEnv("CODE_BUTLER_HOME", join(directory, "home"));
  vi.stubEnv("CODE_BUTLER_AI_USAGE_DIR", join(directory, "usage"));
  vi.stubEnv("CODE_BUTLER_WATCH_TOKEN", "");
});
afterEach(() => { vi.unstubAllEnvs(); cleanupTempDir(directory); });

const chatgpt: ExtractorConfig = { provider: "openai-responses", baseUrl: "https://api.openai.com/v1", model: "gpt-6-luna", apiKeyEnv: "",
  connectionId: "chatgpt", connectionKind: "chatgpt", connectionLabel: "ChatGPT plan" };
const request = { job: "extraction" as const, system: "Extract memories.", user: "{\"chunks\":[]}", maxTokens: 900, sendMaxTokens: true, jsonMode: true, errorLabel: "Extractor", invalidResponseMessage: "Invalid" };

const sse = (events: unknown[]) => {
  const text = events.map(event => `event: x\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("");
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Split mid-event so the reader has to join chunks.
      const middle = Math.floor(encoded.length / 2);
      controller.enqueue(encoded.slice(0, middle));
      controller.enqueue(encoded.slice(middle));
      controller.close();
    }
  });
};
const completed = (usage = { input_tokens: 120, output_tokens: 30 }) => [
  { type: "response.created" },
  { type: "response.output_text.delta", delta: "{\"memories\":" },
  { type: "response.output_text.delta", delta: "[]}" },
  { type: "response.completed", response: { usage } }
];

function server(...replies: Array<{ status: number; body?: unknown; events?: unknown[] }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if (reply.events) return new Response(sse(reply.events), { status: reply.status, headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function tokens() {
  const forced: boolean[] = [];
  return { forced, accessToken: async (force: boolean) => { forced.push(force); return force ? "fresh-token" : "token"; } };
}

describe("ChatGPT plan requests", () => {
  it("streams a Responses call with only the fields the plan accepts and records usage without a cost", async () => {
    const { fetchImpl, calls } = server({ status: 200, events: completed() });
    const token = tokens();
    const result = await chatCompletion(chatgpt, request, { fetchImpl, chatgptAccessToken: token.accessToken });
    expect(result).toEqual({ content: "{\"memories\":[]}", inputTokens: 120, outputTokens: 30 });
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer token");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: "gpt-6-luna", instructions: "Extract memories.", input: [{ role: "user", content: "{\"chunks\":[]}" }], store: false, stream: true
    });
    const [line] = readAiUsage(usageDay());
    expect(line).toMatchObject({ job: "extraction", connectionId: "chatgpt", inputTokens: 120, outputTokens: 30 });
    expect(line).not.toHaveProperty("costUsd");
  });

  it("counts only a completed response as success", async () => {
    const token = tokens();
    const cut = server({ status: 200, events: completed().slice(0, 3) });
    await expect(chatCompletion(chatgpt, request, { fetchImpl: cut.fetchImpl, chatgptAccessToken: token.accessToken })).rejects.toThrow(/ended before the response completed/);
    const incomplete = server({ status: 200, events: [{ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }] });
    await expect(chatCompletion(chatgpt, request, { fetchImpl: incomplete.fetchImpl, chatgptAccessToken: token.accessToken })).rejects.toThrow(/incomplete \(max_output_tokens\)/);
  });

  it("refreshes a refused token once, then gives up with a sign-in message", async () => {
    const token = tokens();
    const recovered = server({ status: 401, body: { error: { code: "subscription_sharing_invalid_user" } } }, { status: 200, events: completed() });
    await expect(chatCompletion(chatgpt, request, { fetchImpl: recovered.fetchImpl, chatgptAccessToken: token.accessToken })).resolves.toMatchObject({ content: "{\"memories\":[]}" });
    expect(token.forced).toEqual([false, true]);
    expect((recovered.calls[1]!.init.headers as Record<string, string>).authorization).toBe("Bearer fresh-token");
    const refused = server({ status: 401, body: { error: { code: "subscription_sharing_invalid_user" } } });
    await expect(chatCompletion(chatgpt, request, { fetchImpl: refused.fetchImpl, chatgptAccessToken: tokens().accessToken })).rejects.toBeInstanceOf(AiConnectionError);
    expect(refused.calls).toHaveLength(2);
  });

  it("explains an ineligible plan and retries a temporarily unavailable one", async () => {
    const ineligible = server({ status: 403, body: { error: { code: "subscription_sharing_user_not_eligible" } } });
    await expect(chatCompletion(chatgpt, request, { fetchImpl: ineligible.fetchImpl, chatgptAccessToken: tokens().accessToken })).rejects.toThrow(/needs Plus or Pro/);
    const flaky = server({ status: 503, body: { error: { code: "subscription_sharing_usage_unavailable" } } }, { status: 200, events: completed() });
    // One real two-second backoff before the retry.
    await expect(chatCompletion(chatgpt, request, { fetchImpl: flaky.fetchImpl, chatgptAccessToken: tokens().accessToken })).resolves.toMatchObject({ content: "{\"memories\":[]}" });
    expect(flaky.calls).toHaveLength(2);
  });

  it("pauses background work after the plan limit instead of failing, while a person's request still tries", async () => {
    const limited = server({ status: 200, events: [{ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } }] });
    const error = await withAiTrigger("background", () => chatCompletion(chatgpt, request, { fetchImpl: limited.fetchImpl, chatgptAccessToken: tokens().accessToken })).catch(caught => caught);
    expect(error).toBeInstanceOf(AiPlanLimitError);
    expect(error).toBeInstanceOf(AiPausedError);
    expect(error.message).toBe(AI_PLAN_LIMIT_REASON);
    expect(planPaused("chatgpt")).toBe(true);
    expect(withAiTrigger("background", () => backgroundPauseReason(chatgpt))).toBe(AI_PLAN_LIMIT_REASON);
    // A further background call stops before reaching OpenAI.
    const after = server({ status: 200, events: completed() });
    await expect(withAiTrigger("background", () => chatCompletion(chatgpt, request, { fetchImpl: after.fetchImpl, chatgptAccessToken: tokens().accessToken }))).rejects.toBeInstanceOf(AiPlanLimitError);
    expect(after.calls).toHaveLength(0);
    await expect(withAiTrigger("user", () => chatCompletion(chatgpt, { ...request, job: "review" }, { fetchImpl: after.fetchImpl, chatgptAccessToken: tokens().accessToken }))).resolves.toBeDefined();
    expect(after.calls).toHaveLength(1);
  });
});
