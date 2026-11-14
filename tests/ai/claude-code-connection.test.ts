// Tests the Claude Code connection: claudeCliChat() in src/providers/claude-cli.ts and the gate in assertConnectionAllowed() (src/ai/connection-policy.ts) through chatCompletion().
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatCompletion } from "../../src/ai/chat.js";
import { CLAUDE_CODE_USER_ONLY } from "../../src/ai/connection-policy.js";
import { readAiUsage, usageDay, withAiTrigger } from "../../src/ai/usage.js";
import { CLAUDE_CLI_NOT_FOUND, CLAUDE_CLI_SIGNED_OUT, type ClaudeCliDeps } from "../../src/providers/claude-cli.js";
import { handleDesktopRequest } from "../../src/desktop/service.js";
import type { ExtractorConfig } from "../../src/types.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

let directory: string;
let home: string;
beforeEach(() => {
  directory = makeTempDir();
  home = join(directory, "home");
  mkdirSync(home, { recursive: true });
  vi.stubEnv("CODE_BUTLER_HOME", join(directory, "config"));
  vi.stubEnv("CODE_BUTLER_AI_USAGE_DIR", join(directory, "usage"));
  vi.stubEnv("CODE_BUTLER_WATCH_TOKEN", "");
});
afterEach(() => { vi.unstubAllEnvs(); cleanupTempDir(directory); });

const claude: ExtractorConfig = { provider: "claude-cli", model: "sonnet", apiKeyEnv: "", connectionId: "claude-code", connectionKind: "claude-code", connectionLabel: "Claude Code" };
const request = { system: "Reply with JSON.", user: "{\"memory\":1}", errorLabel: "Test", invalidResponseMessage: "Invalid" };

interface Call { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string; systemPrompt: string }
function fakeClaude(output: Record<string, unknown> | string, installed = true) {
  const calls: Call[] = [];
  const cli = join(home, ".local", "bin", "claude");
  const deps: ClaudeCliDeps = {
    machine: { home, platform: "darwin", env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-should-not-pass", ANTHROPIC_AUTH_TOKEN: "token", CODE_BUTLER_WATCH_TOKEN: "w", HOME: home } },
    exists: path => installed && path === cli,
    run: async (command, args, options) => {
      const promptFile = args[args.indexOf("--system-prompt-file") + 1]!;
      calls.push({ command, args, cwd: options.cwd, env: options.env, stdin: options.stdin, systemPrompt: readFileSync(promptFile, "utf8") });
      return { code: 0, stdout: typeof output === "string" ? output : JSON.stringify(output), stderr: "" };
    }
  };
  return { deps, calls, cli };
}
const success = { type: "result", subtype: "success", is_error: false, result: "```json\n{\"ok\":true}\n```", usage: { input_tokens: 40, cache_read_input_tokens: 2, output_tokens: 9 } };

describe("Claude Code connection", () => {
  it("runs the installed CLI as a plain, tool-less call on the person's own sign-in when they start a review", async () => {
    const { deps, calls, cli } = fakeClaude(success);
    const result = await withAiTrigger("user", () => chatCompletion(claude, { ...request, job: "review" }, { claudeCli: deps }));
    expect(result).toEqual({ content: "```json\n{\"ok\":true}\n```", inputTokens: 42, outputTokens: 9 });
    const [call] = calls;
    expect(call!.command).toBe(cli);
    expect(call!.args.slice(0, 5)).toEqual(["-p", "--output-format", "json", "--model", "sonnet"]);
    expect(call!.args).toEqual(expect.arrayContaining(["--tools", "", "--strict-mcp-config", "--setting-sources", "--no-session-persistence"]));
    expect(call!.args).not.toContain("--bare");
    expect(call!.stdin).toBe(request.user);
    expect(call!.systemPrompt).toBe(request.system);
    expect(call!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call!.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(call!.env.CODE_BUTLER_WATCH_TOKEN).toBeUndefined();
    // The empty working directory, with the prompt file in it, is gone afterwards.
    expect(existsSync(call!.cwd)).toBe(false);
    expect(readAiUsage(usageDay())).toEqual([expect.objectContaining({ job: "review", trigger: "user", connectionId: "claude-code", inputTokens: 42, outputTokens: 9 })]);
    expect(readAiUsage(usageDay())[0]).not.toHaveProperty("costUsd");
  });

  it("refuses unattended work, background work and jobs other than review, wording, summary and rules", async () => {
    const { deps, calls } = fakeClaude(success);
    // Without an explicit mark, as for MCP tools, git hooks and timers.
    await expect(chatCompletion(claude, { ...request, job: "review" }, { claudeCli: deps })).rejects.toThrow(CLAUDE_CODE_USER_ONLY);
    await expect(withAiTrigger("background", () => chatCompletion(claude, { ...request, job: "summary" }, { claudeCli: deps }))).rejects.toThrow(CLAUDE_CODE_USER_ONLY);
    for (const job of ["extraction", "investigator", "consolidation"] as const) {
      await expect(withAiTrigger("user", () => chatCompletion(claude, { ...request, job }, { claudeCli: deps }))).rejects.toThrow(CLAUDE_CODE_USER_ONLY);
    }
    for (const job of ["wording", "summary", "rules"] as const) {
      await expect(withAiTrigger("user", () => chatCompletion(claude, { ...request, job }, { claudeCli: deps }))).resolves.toMatchObject({ content: expect.any(String) });
    }
    expect(calls).toHaveLength(3);
  });

  it("explains a missing install and a signed-out CLI", async () => {
    await expect(withAiTrigger("user", () => chatCompletion(claude, { ...request, job: "review" }, { claudeCli: fakeClaude(success, false).deps })))
      .rejects.toThrow(CLAUDE_CLI_NOT_FOUND);
    const signedOut = fakeClaude({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
    await expect(withAiTrigger("user", () => chatCompletion(claude, { ...request, job: "review" }, { claudeCli: signedOut.deps })))
      .rejects.toThrow(CLAUDE_CLI_SIGNED_OUT);
    const broken = fakeClaude("not json");
    await expect(withAiTrigger("user", () => chatCompletion(claude, { ...request, job: "review" }, { claudeCli: broken.deps })))
      .rejects.toThrow(/Claude Code failed/);
  });

  it("runs calls one at a time", async () => {
    let running = 0, peak = 0;
    const { deps } = fakeClaude(success);
    const run = deps.run!;
    deps.run = async (...args) => { running += 1; peak = Math.max(peak, running); await new Promise(resolve => setTimeout(resolve, 10)); try { return await run(...args); } finally { running -= 1; } };
    await withAiTrigger("user", () => Promise.all([1, 2, 3].map(() => chatCompletion(claude, { ...request, job: "review" }, { claudeCli: deps }))));
    expect(peak).toBe(1);
  });

  it("can't be saved as a tier or for background jobs, only per job for review, wording, summary and rules", async () => {
    const save = (settings: Record<string, unknown>) => handleDesktopRequest({ version: 1, action: "ai.settings.save", settings } as never);
    const connections = { "claude-code": { kind: "claude-code" } };
    await expect(save({ connections, tiers: { smart: { connection: "claude-code", model: "sonnet" } } })).rejects.toThrow(/Claude Code can only be chosen/);
    await expect(save({ connections, tiers: {}, jobs: { extraction: { connection: "claude-code", model: "sonnet" } } })).rejects.toThrow(/Claude Code can only be chosen/);
    await expect(save({ connections, tiers: {}, jobs: { review: { connection: "claude-code", model: "sonnet" }, rules: { connection: "claude-code", model: "opus" } } })).resolves.toBeDefined();
  });
});
