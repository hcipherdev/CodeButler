// Tests chatCompletion() in src/ai/chat.ts: OpenRouter extras, direct Anthropic headers, usage ledger lines and the background budget in src/ai/usage.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatCompletion } from "../../src/ai/chat.js";
import { AI_BUDGET_REASON, aiUsageSummary, readAiUsage, recordAiUsage, usageDay, withAiTrigger } from "../../src/ai/usage.js";
import type { AnthropicAwsHttpClient } from "../../src/providers/anthropic-aws.js";
import type { ExtractorConfig } from "../../src/types.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

let directory: string;
let usageDir: string;
beforeEach(() => {
  directory = makeTempDir();
  usageDir = join(directory, "usage");
  vi.stubEnv("CODE_BUTLER_HOME", join(directory, "home"));
  vi.stubEnv("CODE_BUTLER_AI_USAGE_DIR", usageDir);
  vi.stubEnv("CODE_BUTLER_WATCH_TOKEN", "");
});
afterEach(() => { vi.unstubAllEnvs(); cleanupTempDir(directory); });

const request = { job: "review" as const, system: "Be brief.", user: "{}", errorLabel: "Test", invalidResponseMessage: "Invalid test response" };
const openRouter: ExtractorConfig = { provider: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4.5",
  apiKeyEnv: "TEST_OR_KEY", connectionId: "openrouter", connectionKind: "openrouter", connectionLabel: "OpenRouter", dataCollection: "deny" };

function capturingFetch(response: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: status < 300, status, json: async () => response, text: async () => JSON.stringify(response) };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("shared model client", () => {
  it("adds OpenRouter routing, attribution and cost reporting, and records usage without prompts", async () => {
    vi.stubEnv("TEST_OR_KEY", "or-key");
    const { fetchImpl, calls } = capturingFetch({ choices: [{ message: { content: "{\"ok\":true}" } }], usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.0042 } });
    const result = await chatCompletion(openRouter, { ...request, maxTokens: 500, sendMaxTokens: true, jsonMode: true }, { fetchImpl });
    expect(result).toEqual({ content: "{\"ok\":true}", inputTokens: 120, outputTokens: 30, costUsd: 0.0042 });
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]!.init.headers).toMatchObject({ authorization: "Bearer or-key", "X-Title": "Code Butler" });
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ max_tokens: 500, response_format: { type: "json_object" }, provider: { data_collection: "deny", require_parameters: true }, usage: { include: true } });
    const [entry] = readAiUsage(usageDay(), usageDir);
    expect(entry).toMatchObject({ job: "review", trigger: "user", connectionId: "openrouter", inputTokens: 120, outputTokens: 30, costUsd: 0.0042 });
    expect(JSON.stringify(entry)).not.toContain("Be brief");
  });

  it("sends no OpenRouter extras to other OpenAI-compatible providers", async () => {
    vi.stubEnv("TEST_OPENAI_KEY", "k");
    const { fetchImpl, calls } = capturingFetch({ choices: [{ message: { content: "hi" } }] });
    await chatCompletion({ provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-5", apiKeyEnv: "TEST_OPENAI_KEY", connectionId: "openai", connectionKind: "openai" }, request, { fetchImpl });
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.provider).toBeUndefined(); expect(body.usage).toBeUndefined(); expect(body.max_tokens).toBeUndefined();
    expect(calls[0]!.init.headers).not.toHaveProperty("X-Title");
    expect(readAiUsage(usageDay(), usageDir)[0]).toMatchObject({ inputTokens: Math.ceil(Buffer.byteLength("Be brief.{}") / 4), outputTokens: 1 });
  });

  it("calls api.anthropic.com directly with the key and no AWS workspace header", async () => {
    vi.stubEnv("TEST_ANTHROPIC_KEY", "anthropic-key");
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const http: AnthropicAwsHttpClient = async (url, init) => {
      seen.push({ url, headers: init.headers });
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "done" }], usage: { input_tokens: 9, output_tokens: 2 } }), text: async () => "" };
    };
    const result = await chatCompletion({ provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5", apiKeyEnv: "TEST_ANTHROPIC_KEY", connectionId: "anthropic", connectionKind: "anthropic" },
      { ...request, maxTokens: 100 }, { anthropicHttpClient: http });
    expect(result).toEqual({ content: "done", inputTokens: 9, outputTokens: 2 });
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0]!.headers).toMatchObject({ "X-Api-Key": "anthropic-key", "anthropic-version": "2023-06-01", "user-agent": "CodeButler" });
    expect(seen[0]!.headers).not.toHaveProperty("anthropic-workspace-id");
  });

  it("refuses background calls once today's cap is spent, while calls a person started still run", async () => {
    mkdirSync(join(directory, "home"), { recursive: true });
    writeFileSync(join(directory, "home", "config.json"), JSON.stringify({ ai: { budgets: { backgroundDailyTokens: 1000 } } }));
    recordAiUsage({ at: new Date().toISOString(), job: "extraction", trigger: "background", model: "m", inputTokens: 900, outputTokens: 200 }, usageDir);
    vi.stubEnv("TEST_OR_KEY", "or-key");
    const { fetchImpl, calls } = capturingFetch({ choices: [{ message: { content: "ok" } }] });
    await expect(withAiTrigger("background", () => chatCompletion(openRouter, request, { fetchImpl }))).rejects.toThrow(AI_BUDGET_REASON);
    expect(calls).toHaveLength(0);
    await expect(withAiTrigger("user", () => chatCompletion(openRouter, request, { fetchImpl }))).resolves.toMatchObject({ content: "ok" });
    const summary = aiUsageSummary(new Date(), usageDir, 1000);
    expect(summary.background.totalTokens).toBe(1100);
    expect(summary.user.calls).toBe(1);
    expect(summary.byJob.extraction?.totalTokens).toBe(1100);
  });

  it("maps a provider's refusal to a plain reason without echoing the request", async () => {
    vi.stubEnv("TEST_OR_KEY", "or-key");
    const { fetchImpl } = capturingFetch({ error: { message: "Insufficient credits" } }, 402);
    await expect(chatCompletion(openRouter, request, { fetchImpl })).rejects.toThrow("Test request failed with status 402: the provider account is out of credit");
  });
});
