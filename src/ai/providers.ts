import type { AiConnectionKind, LlmProviderName } from "../types.js";

export interface AiProviderPreset {
  kind: AiConnectionKind;
  label: string;
  /** How requests are sent; every kind except the Anthropic ones speaks the OpenAI chat API. */
  provider: LlmProviderName;
  baseUrl?: string;
  /** The environment variable people conventionally set for this provider. */
  apiKeyEnv?: string;
  needsKey: boolean;
  /** Suggestions only: the live model list is authoritative and any model id may be entered. */
  suggested: { fast: string[]; smart: string[] };
  modelList: "openrouter" | "openai" | "anthropic" | "none";
  /** The provider's page listing exact model ids, for models the app does not suggest. */
  modelsUrl?: string;
  hint: string;
}

// Base URLs and model ids drift; check them against each provider's documentation when updating.
// Suggestions last checked 2026-10-20 against each provider's model page and OpenRouter's model list.
export const AI_PROVIDER_PRESETS: Record<AiConnectionKind, AiProviderPreset> = {
  openrouter: {
    kind: "openrouter", label: "OpenRouter", provider: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY", needsKey: true, modelList: "openrouter",
    suggested: {
      fast: ["anthropic/claude-haiku-5.5", "google/gemini-3.8-flash", "openai/gpt-6-luna", "deepseek/deepseek-v4.1-flash", "qwen/qwen3.8-flash"],
      smart: ["anthropic/claude-sonnet-5.5", "openai/gpt-6.1-sol", "google/gemini-4-argon", "anthropic/claude-opus-5.5", "deepseek/deepseek-v4-pro", "moonshotai/kimi-k3", "z-ai/glm-5.3", "x-ai/grok-4.7"]
    },
    modelsUrl: "https://openrouter.ai/models",
    hint: "One key for models from most providers."
  },
  anthropic: {
    kind: "anthropic", label: "Anthropic", provider: "anthropic", baseUrl: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY", needsKey: true, modelList: "anthropic",
    suggested: { fast: ["claude-haiku-5-5"], smart: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"] },
    modelsUrl: "https://platform.claude.com/docs/en/about-claude/models/overview",
    hint: "A key from console.anthropic.com."
  },
  "anthropic-aws": {
    kind: "anthropic-aws", label: "Claude on AWS", provider: "anthropic-aws",
    apiKeyEnv: "ANTHROPIC_AWS_API_KEY", needsKey: true, modelList: "none",
    // Claude Platform on AWS takes the same model ids as the Claude API.
    suggested: { fast: ["claude-haiku-5-5"], smart: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"] },
    modelsUrl: "https://platform.claude.com/docs/en/about-claude/models/overview",
    hint: "Claude Platform on AWS; also needs a workspace ID and region."
  },
  openai: {
    kind: "openai", label: "OpenAI", provider: "openai-compatible", baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY", needsKey: true, modelList: "openai",
    suggested: { fast: ["gpt-6-luna", "gpt-5.6-luna"], smart: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"] },
    modelsUrl: "https://developers.openai.com/api/docs/models",
    hint: "A key from platform.openai.com."
  },
  gemini: {
    kind: "gemini", label: "Google Gemini", provider: "openai-compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GEMINI_API_KEY", needsKey: true, modelList: "openai",
    suggested: { fast: ["gemini-3.8-flash", "gemini-3.5-flash-lite"], smart: ["gemini-4-argon", "gemini-3.1-pro-preview"] },
    modelsUrl: "https://ai.google.dev/gemini-api/docs/models",
    hint: "A key from Google AI Studio."
  },
  qwen: {
    kind: "qwen", label: "Qwen (DashScope)", provider: "openai-compatible", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY", needsKey: true, modelList: "openai",
    suggested: { fast: ["qwen3.8-flash"], smart: ["qwen3.8-max", "qwen3.7-plus"] },
    modelsUrl: "https://www.alibabacloud.com/help/en/model-studio/models",
    hint: "International endpoint by default; set the China endpoint as the base URL if your key is for mainland China."
  },
  ollama: {
    kind: "ollama", label: "Ollama (local)", provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1",
    needsKey: false, modelList: "openai",
    suggested: { fast: ["qwen2.5:7b", "llama3.1:8b"], smart: ["qwen2.5:32b"] },
    modelsUrl: "https://ollama.com/library",
    hint: "Runs on this computer; nothing leaves it."
  },
  lmstudio: {
    kind: "lmstudio", label: "LM Studio (local)", provider: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1",
    needsKey: false, modelList: "openai",
    suggested: { fast: [], smart: [] },
    modelsUrl: "https://lmstudio.ai/models",
    hint: "Runs on this computer; start LM Studio's local server first."
  },
  "openai-compatible": {
    kind: "openai-compatible", label: "Custom (OpenAI-compatible)", provider: "openai-compatible",
    needsKey: false, modelList: "openai",
    suggested: { fast: [], smart: [] },
    hint: "Any OpenAI-compatible endpoint, such as LiteLLM or Together."
  }
};

export const AI_CONNECTION_KINDS = Object.keys(AI_PROVIDER_PRESETS) as AiConnectionKind[];

export function isAiConnectionKind(value: unknown): value is AiConnectionKind {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(AI_PROVIDER_PRESETS, value);
}

export function isLocalKind(kind: AiConnectionKind | undefined): boolean {
  return kind === "ollama" || kind === "lmstudio";
}
