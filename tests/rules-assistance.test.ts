import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";
import { loadGlobalReviewerConfig } from "../src/config.js";
import { draftGlobalRule, ruleAssistanceStatus } from "../src/rules/assistance.js";
import { createMemoryReconciliationProvider, type ReconciliationModelRequest } from "../src/memory/reconciliation-provider.js";
import { handleDesktopRequest } from "../src/desktop/service.js";
import { rulesDesktopList } from "../src/rules/desktop.js";

const roots: string[] = [];
function temp() { const root = makeTempDir(); roots.push(root); return root; }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) cleanupTempDir(root); });
function output() {
  return { draft: { title: "Clear names", body: "Use clear, descriptive names.", severity: "must", enabled: true, core: true,
    applies: { platforms: [] as string[], shells: [] as string[], markers: [] as string[] }, triggers: { actions: [] as string[], paths: [] as string[], keywords: [] as string[] } },
    assumptions: ["General guidance applies to every task."], scopeEvidence: {} as Record<string, string> };
}
function provider(value: unknown = output()) {
  return { provider: "test", model: "test-model", request: vi.fn(async (_input: ReconciliationModelRequest) => ({ content: typeof value === "string" ? value : JSON.stringify(value) })) };
}

describe("explicit unsaved rule drafting", () => {
  it.each(["json", "JSON", ""])("accepts a complete %s code fence without saving or retrying", async language => {
    const home = temp(); vi.stubEnv("CODE_BUTLER_HOME", home);
    const value = output(); value.draft.body = "Document examples using Markdown:\n```ts\nconst name = 'example';\n```";
    const model = provider(` \r\n\`\`\`${language}\r\n${JSON.stringify(value)}\r\n\`\`\`\r\n `);
    const result = await draftGlobalRule("Document code examples.", { ruleDraftProvider: () => model });
    expect(result).toMatchObject(value); expect(model.request).toHaveBeenCalledOnce(); expect(readdirSync(home)).toEqual([]);
  });
  it("rejects prose, incomplete fences, and multiple JSON blocks with a safe parsing diagnostic", async () => {
    const json = JSON.stringify(output());
    for (const text of [`Here is your draft:\n\`\`\`json\n${json}\n\`\`\``, `\`\`\`json\n${json}`, `\`\`\`json\n${json}\n\`\`\`\n\`\`\`json\n${json}\n\`\`\``, "private model text"]) {
      const failure = await draftGlobalRule("Use clear names.", { ruleDraftProvider: () => provider(text) }).catch(error => error as Error);
      expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toContain("The response is not valid JSON.");
      expect((failure as Error).message).not.toContain("private model text");
    }
  });
  it("keeps schema, trigger, scope, and secret checks after unwrapping", async () => {
    const cases = [
      { value: { ...output(), draft: { ...output().draft, severity: "should" } }, reason: "required rule fields" },
      { value: { ...output(), draft: { ...output().draft, core: false } }, reason: "at least one trigger" },
      { value: { ...output(), draft: { ...output().draft, applies: { platforms: ["darwin"] } } }, reason: "exact supporting excerpt" }
    ];
    for (const { value, reason } of cases) await expect(draftGlobalRule("Use clear names.", { ruleDraftProvider: () => provider(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``) })).rejects.toThrow(reason);
    const secret = JSON.stringify({ ...output(), assumptions: ["sk-" + "a".repeat(32)] }).replace("sk-", "\\u0073k-");
    await expect(draftGlobalRule("Use clear names.", { ruleDraftProvider: () => provider(`\`\`\`json\n${secret}\n\`\`\``) })).rejects.toThrow("recognized secret");
  });
  it("uses one bounded reviewer request containing only the description and produces no files", async () => {
    const home = temp(); vi.stubEnv("CODE_BUTLER_HOME", home);
    const model = provider(), ensureGlobalWatcher = vi.fn(), syncRules = vi.fn();
    const result = await handleDesktopRequest({ version: 1, action: "rules.draft", description: "Use clear names." }, { ruleDraftProvider: () => model, ensureGlobalWatcher, syncRules });
    expect(result).toMatchObject(output()); expect(model.request).toHaveBeenCalledOnce();
    const sent = model.request.mock.calls[0]![0];
    expect(sent.payload).toEqual({ description: "Use clear names." }); expect(sent.maxTokens).toBe(4096); expect(sent.signal?.aborted).toBe(false);
    expect(sent.system).toContain("Preserve the description's language");
    expect(readdirSync(home)).toEqual([]); expect(ensureGlobalWatcher).not.toHaveBeenCalled(); expect(syncRules).not.toHaveBeenCalled();
    const before = rulesDesktopList();
    await handleDesktopRequest({ version: 1, action: "rules.create", expectedRevision: before.revision, input: (result as ReturnType<typeof output>).draft });
    expect(rulesDesktopList().rules).toHaveLength(1);
    expect(rulesDesktopList().rules[0]).toMatchObject({ severity: "must", core: true });
    await expect(handleDesktopRequest({ version: 1, action: "rules.create", expectedRevision: before.revision, input: output().draft })).rejects.toMatchObject({ code: "stale-rule" });
  });
  it("normalizes inactive triggers and preserves the model's user-language text", async () => {
    const value = output(); value.draft.title = "清晰的命名"; value.draft.body = "使用清晰的名称。"; value.draft.triggers.keywords = ["names"];
    const result = await draftGlobalRule("使用清晰的名称。", { ruleDraftProvider: () => provider(value) });
    expect(result.draft.body).toBe(value.draft.body); expect(result.draft.triggers.keywords).toEqual([]);
  });
  it("accepts conditional triggers and explicit project/platform/shell restrictions", async () => {
    const value = output(); value.draft.core = false; value.draft.triggers.actions = ["create_doc"]; value.draft.triggers.keywords = ["debug"];
    value.draft.applies = { platforms: ["darwin"], shells: ["zsh"], markers: ["package.json"] };
    value.scopeEvidence = { platforms: "macOS only", shells: "Zsh only", markers: "projects containing package.json" };
    const result = await draftGlobalRule("When writing debug docs: macOS only, Zsh only, projects containing package.json.", { ruleDraftProvider: () => provider(value) });
    expect(result.draft).toEqual(value.draft);
  });
  it.each(["platforms", "shells", "markers"] as const)("rejects unsolicited %s restrictions", async category => {
    const value = output(); value.draft.applies[category] = [category === "platforms" ? "darwin" : category === "shells" ? "bash" : "package.json"];
    await expect(draftGlobalRule("Use clear names.", { ruleDraftProvider: () => provider(value) })).rejects.toThrow("invalid rule draft");
    value.scopeEvidence[category] = "Invented scope";
    await expect(draftGlobalRule("Use clear names.", { ruleDraftProvider: () => provider(value) })).rejects.toThrow("invalid rule draft");
  });
  it.each(["lower-priority", "no-trigger", "body-bytes", "file-bytes", "unknown-field", "bad-path", "bad-platform", "bad-shell"])("rejects %s output", async kind => {
    const value = output();
    if (kind === "lower-priority") value.draft.severity = "should";
    if (kind === "no-trigger") value.draft.core = false;
    if (kind === "body-bytes") value.draft.body = "界".repeat(1366);
    if (kind === "file-bytes") { value.draft.core = false; value.draft.triggers.paths = Array(32).fill("p".repeat(240)); value.draft.triggers.keywords = Array(32).fill("k".repeat(240)); value.draft.body = "b".repeat(4096); }
    if (kind === "unknown-field") Object.assign(value.draft, { schemaVersion: 2 });
    if (kind === "bad-path") { value.draft.applies.markers = ["../secret"]; value.scopeEvidence.markers = "names"; }
    if (kind === "bad-platform") value.draft.applies.platforms = ["macOS"];
    if (kind === "bad-shell") value.draft.applies.shells = ["../bash"];
    await expect(draftGlobalRule("Use clear names.", { ruleDraftProvider: () => provider(value) })).rejects.toThrow("invalid rule draft");
  });
  it("rejects malformed JSON and recognized secrets in every returned field", async () => {
    const escaped = JSON.stringify({ ...output(), assumptions: ["Use sk-" + "a".repeat(32)] }).replace("sk-", "\\u0073k-");
    for (const value of ["not json", escaped, { ...output(), assumptions: ["Use sk-" + "a".repeat(32)] }, { ...output(), draft: { ...output().draft, body: "sk-" + "a".repeat(32) } }]) {
      await expect(draftGlobalRule("Use clear names.", { ruleDraftProvider: () => provider(value) })).rejects.toThrow();
    }
  });
  it("checks input secrets and UTF-8 limits before obtaining a provider", async () => {
    const factory = vi.fn(() => provider());
    for (const description of [" ", "界".repeat(2731), "Use sk-" + "a".repeat(32)]) await expect(draftGlobalRule(description, { ruleDraftProvider: factory })).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
    await expect(draftGlobalRule("界".repeat(2730), { ruleDraftProvider: factory })).resolves.toHaveProperty("draft");
  });
  it("aborts at 60 seconds, performs no retry, and ignores a late provider result", async () => {
    vi.useFakeTimers(); const home = temp(); vi.stubEnv("CODE_BUTLER_HOME", home);
    let finish!: (response: { content: string }) => void;
    const model = { ...provider(), request: vi.fn((_input: ReconciliationModelRequest) => new Promise<{ content: string }>(resolve => { finish = resolve; })) };
    const pending = expect(draftGlobalRule("Use clear names.", { ruleDraftProvider: () => model })).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(60_000); await pending;
    expect(model.request).toHaveBeenCalledOnce(); expect(model.request.mock.calls[0]![0].signal?.aborted).toBe(true);
    finish({ content: JSON.stringify(output()) }); await Promise.resolve(); expect(readdirSync(home)).toEqual([]);
  });
  it("sanitizes provider failures without retrying", async () => {
    const model = provider(); model.request.mockRejectedValue(new Error("private provider response"));
    await expect(draftGlobalRule("Use clear names.", { ruleDraftProvider: () => model })).rejects.toThrow("Check the global reviewer settings");
    expect(model.request).toHaveBeenCalledOnce();
  });
});

describe("global reviewer configuration and adapter", () => {
  function config() {
    const home = temp(); vi.stubEnv("CODE_BUTLER_HOME", home); vi.stubEnv("RULES_TEST_KEY", undefined);
    writeFileSync(join(home, "config.json"), JSON.stringify({ defaults: { investigatorProfile: "reviewer" }, profiles: { reviewer: { provider: "openai-compatible", model: "global-reviewer", apiKeyEnv: "RULES_TEST_KEY", baseUrl: "https://example.invalid/v1" } } }));
    return home;
  }
  it("loads global profile and .env credentials without project overrides or scaffold initialization", async () => {
    const home = config(); writeFileSync(join(home, ".env"), "RULES_TEST_KEY=global-test-value\n");
    mkdirSync(join(home, "project", ".code-butler"), { recursive: true });
    writeFileSync(join(home, "project", ".code-butler", "config.local.json"), JSON.stringify({ investigator: { model: "project-only", apiKeyEnv: "PROJECT_ONLY_KEY" } }));
    expect(loadGlobalReviewerConfig()).toMatchObject({ model: "global-reviewer", apiKeyEnv: "RULES_TEST_KEY" }); expect(process.env.RULES_TEST_KEY).toBe("global-test-value");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output()) } }] }), { status: 200 }));
    expect(await handleDesktopRequest({ version: 1, action: "rules.assistance.status" })).toMatchObject({ available: true, model: "global-reviewer" });
    expect(fetchMock).not.toHaveBeenCalled();
    await handleDesktopRequest({ version: 1, action: "rules.draft", description: "Use clear names." });
    const [url, init] = fetchMock.mock.calls[0]!; expect(url).toBe("https://example.invalid/v1/chat/completions");
    expect(JSON.parse(String(init!.body))).toMatchObject({ model: "global-reviewer", max_tokens: 4096 });
    expect(init!.headers).toMatchObject({ authorization: "Bearer global-test-value" }); expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(existsSync(join(home, "global"))).toBe(false);
    await expect(handleDesktopRequest({ version: 1, action: "rules.draft", description: "Use clear names.", root: join(home, "project") })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("reports missing credentials and handles an uninitialized home without writes", () => {
    const home = config(); expect(ruleAssistanceStatus()).toMatchObject({ available: false, model: "global-reviewer" });
    expect(existsSync(join(home, "global"))).toBe(false);
    const empty = temp(); vi.stubEnv("CODE_BUTLER_HOME", empty); vi.stubEnv("OPENAI_API_KEY", undefined);
    expect(ruleAssistanceStatus().available).toBe(false); expect(readdirSync(empty)).toEqual([]);
  });
  it("forwards the abort signal and fixed token budget to the Anthropic reviewer adapter", async () => {
    config(); vi.stubEnv("RULES_TEST_KEY", "test"); vi.stubEnv("RULES_WORKSPACE", "test"); vi.stubEnv("RULES_REGION", "test");
    const http = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify(output()) }] }), text: async () => "" }));
    const model = createMemoryReconciliationProvider({ ...loadGlobalReviewerConfig(), provider: "anthropic-aws", workspaceIdEnv: "RULES_WORKSPACE", regionEnv: "RULES_REGION" }, { anthropicHttpClient: http });
    const controller = new AbortController(); await model.request({ signal: controller.signal, system: "Draft", payload: { description: "Names" }, maxTokens: 4096 });
    expect(http).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal, body: expect.stringContaining('"max_tokens":4096') }));
  });
});
