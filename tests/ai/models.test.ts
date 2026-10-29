// Tests AI model resolution (resolveAiJobModels, jobModel in src/ai/models.ts) and the `ai` config section in src/config.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureProjectConfig, loadAiBudget, loadGlobalReviewerConfig, loadProjectConfig, saveGlobalAiSettings } from "../../src/config.js";
import { jobModel } from "../../src/ai/models.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

let directory: string | undefined;
afterEach(() => { vi.unstubAllEnvs(); if (directory) cleanupTempDir(directory); directory = undefined; });

function setup(globalConfig: unknown, local?: unknown) {
  directory = makeTempDir();
  const home = join(directory, "home"), root = join(directory, "project");
  mkdirSync(home, { recursive: true }); mkdirSync(root);
  vi.stubEnv("CODE_BUTLER_HOME", home);
  writeFileSync(join(home, "config.json"), JSON.stringify(globalConfig));
  ensureProjectConfig(root);
  if (local) writeFileSync(join(root, ".code-butler", "config.local.json"), JSON.stringify(local));
  return { home, root };
}

const awsProfiles = {
  defaults: { extractorProfile: "anthropic-haiku", investigatorProfile: "anthropic-sonnet" },
  profiles: {
    "anthropic-haiku": { provider: "anthropic-aws", model: "claude-haiku-4-5-20251001", apiKeyEnv: "ANTHROPIC_AWS_API_KEY", workspaceIdEnv: "ANTHROPIC_AWS_WORKSPACE_ID", regionEnv: "AWS_REGION" },
    "anthropic-sonnet": { provider: "anthropic-aws", model: "claude-sonnet-4-6", apiKeyEnv: "ANTHROPIC_AWS_API_KEY", workspaceIdEnv: "ANTHROPIC_AWS_WORKSPACE_ID", regionEnv: "AWS_REGION" }
  }
};

describe("AI model resolution", () => {
  it("keeps legacy profiles exactly as they ran before when there is no ai section", () => {
    const { root } = setup(awsProfiles);
    const config = loadProjectConfig(root);
    expect(config.extractor).toMatchObject({ provider: "anthropic-aws", model: "claude-haiku-4-5-20251001", apiKeyEnv: "ANTHROPIC_AWS_API_KEY" });
    expect(config.investigator).toMatchObject({ provider: "anthropic-aws", model: "claude-sonnet-4-6", enabled: true, maxSteps: 18 });
    for (const job of ["review", "wording", "summary", "investigator", "rules", "consolidation"] as const) {
      expect(jobModel(config, job)).toMatchObject({ model: "claude-sonnet-4-6", source: "legacy" });
    }
    expect(jobModel(config, "extraction")).toMatchObject({ model: "claude-haiku-4-5-20251001", source: "legacy" });
    expect(config.aiBudget).toEqual({ backgroundDailyTokens: 2_000_000 });
  });

  it("runs extraction on Fast and everything else on Smart, with per-job and project overrides", () => {
    const { root } = setup({
      ...awsProfiles,
      ai: {
        connections: { openrouter: { kind: "openrouter" }, local: { kind: "ollama" } },
        tiers: { fast: { connection: "openrouter", model: "google/gemini-2.5-flash" }, smart: { connection: "openrouter", model: "anthropic/claude-sonnet-4.5" } },
        jobs: { wording: { connection: "local", model: "qwen2.5:32b" }, consolidation: { tier: "fast" } },
        budgets: { backgroundDailyTokens: null }
      }
    }, { ai: { jobs: { review: { connection: "local", model: "qwen2.5:7b" } } } });
    const config = loadProjectConfig(root);
    expect(config.extractor).toMatchObject({ provider: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-2.5-flash",
      apiKeyEnv: "OPENROUTER_API_KEY", connectionId: "openrouter", connectionLabel: "OpenRouter", dataCollection: "deny" });
    expect(config.investigator).toMatchObject({ model: "anthropic/claude-sonnet-4.5", connectionId: "openrouter", maxSteps: 18 });
    expect(jobModel(config, "summary")).toMatchObject({ model: "anthropic/claude-sonnet-4.5", source: "ai" });
    expect(jobModel(config, "wording")).toMatchObject({ connectionId: "local", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:32b" });
    expect(jobModel(config, "consolidation")).toMatchObject({ model: "google/gemini-2.5-flash" });
    expect(jobModel(config, "review")).toMatchObject({ model: "qwen2.5:7b", source: "project-override" });
    expect(config.aiBudget).toEqual({ backgroundDailyTokens: null });
  });

  it("falls back to the other tier only when a job's own tier is unset anywhere, and rules use global settings only", () => {
    const { root } = setup({ ai: { connections: { anthropic: { kind: "anthropic" } },
      tiers: { fast: { connection: "anthropic", model: "claude-haiku-5-5" }, smart: { connection: "anthropic", model: "claude-sonnet-5-5" } } } },
      { ai: { tiers: { smart: { connection: "anthropic", model: "project-only" } } } });
    const config = loadProjectConfig(root);
    expect(config.extractor).toMatchObject({ provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-haiku-5-5", apiKeyEnv: "ANTHROPIC_API_KEY" });
    expect(jobModel(config, "review")).toMatchObject({ model: "project-only", source: "project-override" });
    expect(loadGlobalReviewerConfig()).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
    saveGlobalAiSettings({ connections: { anthropic: { kind: "anthropic" } }, tiers: { smart: { connection: "anthropic", model: "claude-sonnet-5-5" } } });
    expect(jobModel(loadProjectConfig(root), "extraction")).toMatchObject({ model: "project-only" });
  });

  it("lets provider settings written in a project's own config win over global AI settings, but not global legacy blocks", () => {
    const ai = { connections: { openrouter: { kind: "openrouter" } }, tiers: { fast: { connection: "openrouter", model: "fast-model" }, smart: { connection: "openrouter", model: "smart-model" } } };
    const { root } = setup({ ...awsProfiles, investigator: { model: "global-legacy" }, ai },
      { extractor: { provider: "openai-compatible", baseUrl: "https://example.test/v1", model: "project-model", apiKeyEnv: "PROJECT_KEY" } });
    const config = loadProjectConfig(root);
    expect(config.extractor).toMatchObject({ model: "project-model", apiKeyEnv: "PROJECT_KEY" });
    expect(jobModel(config, "extraction")).toMatchObject({ source: "project-override" });
    expect(jobModel(config, "review")).toMatchObject({ model: "smart-model", source: "ai" });
  });

  it("rejects unknown kinds, unknown connections, bad ids and credentials in URLs", () => {
    const { root } = setup({});
    const attempt = (ai: unknown) => () => saveGlobalAiSettings(ai as never);
    expect(attempt({ connections: { x: { kind: "made-up" } } })).toThrow("not a supported provider");
    expect(attempt({ connections: { "Bad Id": { kind: "openai" } } })).toThrow("connection ids");
    expect(attempt({ connections: { a: { kind: "openai" } }, tiers: { fast: { connection: "b", model: "m" } } })).toThrow("must name a configured connection");
    expect(attempt({ connections: { a: { kind: "openai-compatible", baseUrl: "https://user:pass@example.com/v1" } } })).toThrow("without credentials");
    expect(attempt({ connections: { a: { kind: "openai-compatible" } } })).toThrow("baseUrl is required");
    saveGlobalAiSettings({ connections: { a: { kind: "openai" } }, tiers: { fast: { connection: "a", model: "gpt-5-mini" } }, budgets: { backgroundDailyTokens: 5000 } });
    expect(loadAiBudget()).toBe(5000);
    expect(loadProjectConfig(root).extractor).toMatchObject({ model: "gpt-5-mini", connectionId: "a" });
  });
});
