// Tests the ai.settings.*, ai.connection.*, ai.chatgpt.* and ai.models.list desktop actions in src/desktop/service.ts and src/desktop/ai-settings.ts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setKeychainStoreForTests } from "../../src/ai/credentials.js";
import { handleDesktopRequest } from "../../src/desktop/service.js";
import { listConnectionModels, testConnection, type AiSettingsView } from "../../src/desktop/ai-settings.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";
import { loadGlobalJobSettings } from "../../src/config.js";
import { resolveApiKey, resolveAwsSettings } from "../../src/ai/credentials.js";

let directory: string;
let home: string;
let secrets: Record<string, string>;
const awsProfiles = {
  defaults: { extractorProfile: "anthropic-haiku", investigatorProfile: "anthropic-sonnet" },
  profiles: {
    "anthropic-haiku": { provider: "anthropic-aws", model: "claude-haiku-4-5-20251001", apiKeyEnv: "ANTHROPIC_AWS_API_KEY", workspaceIdEnv: "ANTHROPIC_AWS_WORKSPACE_ID", regionEnv: "AWS_REGION" },
    "anthropic-sonnet": { provider: "anthropic-aws", model: "claude-sonnet-4-6", apiKeyEnv: "ANTHROPIC_AWS_API_KEY", workspaceIdEnv: "ANTHROPIC_AWS_WORKSPACE_ID", regionEnv: "AWS_REGION" }
  }
};
const call = <T = Record<string, unknown>>(action: string, input: Record<string, unknown> = {}) => handleDesktopRequest({ version: 1, action, ...input } as never) as Promise<T>;
type View = { imported: boolean; connections: Array<{ id: string; kind: string; keySaved: boolean; keySource: string; usedBy: string[] }>; tiers: Record<string, { connection: string; model: string }>; effective: Array<{ job: string; connectionLabel: string; model: string; ok: boolean }> };

beforeEach(() => {
  directory = makeTempDir();
  home = join(directory, "home");
  mkdirSync(home, { recursive: true });
  vi.stubEnv("CODE_BUTLER_HOME", home);
  vi.stubEnv("CODE_BUTLER_AI_USAGE_DIR", join(directory, "usage"));
  vi.stubEnv("ANTHROPIC_AWS_API_KEY", "aws-secret-value");
  vi.stubEnv("ANTHROPIC_AWS_WORKSPACE_ID", "wrkspc_test");
  vi.stubEnv("AWS_REGION", "us-east-1");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  secrets = {};
  setKeychainStoreForTests({ get: async id => secrets[id], set: async (id, value) => { secrets[id] = value; }, delete: async id => { delete secrets[id]; } });
});
afterEach(() => { vi.unstubAllEnvs(); setKeychainStoreForTests(undefined); cleanupTempDir(directory); });

describe("desktop AI settings", () => {
  it("shows effective AWS values and makes explicit edits override the environment for this provider", async () => {
    const tiers = { fast: { connection: "existing", model: "example" } };
    await call("ai.settings.save", { settings: { connections: { existing: { kind: "anthropic-aws", workspaceId: "old-saved-workspace", region: "old-saved-region" } }, tiers } });
    const before = await call<AiSettingsView>("ai.settings.read");
    expect(before.connections[0]!.awsSettings).toEqual({ workspaceId: "wrkspc_test", region: "us-east-1", workspaceIdSource: "environment", regionSource: "environment" });
    const after = await call<AiSettingsView>("ai.settings.save", { settings: { connections: { existing: { kind: "anthropic-aws", workspaceId: "edited-workspace", region: "eu-west-1", preferSavedAwsSettings: true } }, tiers } });
    expect(after.connections[0]!.awsSettings).toEqual({ workspaceId: "edited-workspace", region: "eu-west-1", workspaceIdSource: "saved", regionSource: "saved" });
    expect(resolveAwsSettings(loadGlobalJobSettings().models!.extraction)).toEqual({ workspaceId: "edited-workspace", region: "eu-west-1" });
    expect(process.env.AWS_REGION).toBe("us-east-1"); expect(process.env.ANTHROPIC_AWS_WORKSPACE_ID).toBe("wrkspc_test");
  });

  it("uses an explicitly replaced key even when an older key is inherited from the environment", async () => {
    const tiers = { fast: { connection: "existing", model: "example" } };
    await call("ai.settings.save", { settings: { connections: { existing: { kind: "anthropic-aws" } }, tiers } });
    const after = await call<AiSettingsView>("ai.connection.setKey", { connectionId: "existing", key: "new-app-key", preferSaved: true });
    expect(after.connections[0]).toMatchObject({ keySource: "keychain", preferSavedKey: true });
    expect(await resolveApiKey(loadGlobalJobSettings().models!.extraction)).toBe("new-app-key");
    expect(process.env.ANTHROPIC_AWS_API_KEY).toBe("aws-secret-value"); expect(JSON.stringify(after)).not.toContain("new-app-key");
    await call("ai.settings.save", { settings: { connections: { existing: { kind: "anthropic-aws", label: "Renamed" } }, tiers } });
    expect(await resolveApiKey(loadGlobalJobSettings().models!.extraction)).toBe("new-app-key");
  });

  it("uses the app's .env copy after replacement when the keychain is unavailable and the shell still has an old key", async () => {
    vi.stubEnv("TEST_PROVIDER_KEY", "old-shell-key");
    setKeychainStoreForTests({ get: async () => undefined, set: async () => { throw new Error("unavailable"); }, delete: async () => {} });
    const tiers = { fast: { connection: "existing", model: "example" } };
    await call("ai.settings.save", { settings: { connections: { existing: { kind: "openai", apiKeyEnv: "TEST_PROVIDER_KEY" } }, tiers } });
    const after = await call<AiSettingsView>("ai.connection.setKey", { connectionId: "existing", key: "new-file-key", saveToEnv: true, preferSaved: true });
    vi.stubEnv("TEST_PROVIDER_KEY", "old-shell-key");
    expect(await resolveApiKey(loadGlobalJobSettings().models!.extraction)).toBe("new-file-key");
    expect(after.connections[0]).toMatchObject({ keyInEnv: true, keyInKeychain: false, preferSavedKey: true });
    expect(JSON.stringify(after)).not.toContain("new-file-key");
  });
  it("repairs missing workspace and region on an existing provider without replacing its key or job choices", async () => {
    for (const name of ["ANTHROPIC_AWS_API_KEY", "ANTHROPIC_AWS_WORKSPACE_ID", "AWS_REGION"]) vi.stubEnv(name, "");
    const tiers = { fast: { connection: "existing", model: "fast", maxTokens: 1000 }, smart: { connection: "existing", model: "smart" } };
    const jobs = { review: { connection: "existing", model: "custom", maxTokens: 2000 } };
    await call("ai.settings.save", { settings: { connections: { existing: { kind: "anthropic-aws" } }, tiers, jobs } });
    const before = await call<AiSettingsView>("ai.connection.setKey", { connectionId: "existing", key: "fixture-key" });
    expect(before.connections[0]!.missing).toEqual(["ANTHROPIC_AWS_WORKSPACE_ID", "AWS_REGION"]);
    const after = await call<AiSettingsView>("ai.settings.save", { settings: { connections: { existing: { kind: "anthropic-aws", label: "Fixed AWS", workspaceId: "workspace-fixed", region: "eu-west-1" } }, tiers, jobs } });
    expect(after.connections).toHaveLength(1); expect(after.connections[0]).toMatchObject({ id: "existing", label: "Fixed AWS", keySaved: true, keySource: "keychain", missing: [] });
    expect(after.tiers).toEqual(tiers); expect(after.jobs).toEqual(jobs); expect(secrets.existing).toBe("fixture-key");
    expect(JSON.stringify(after)).not.toContain("fixture-key");
  });

  it("keeps an environment-only saved key usable when its variable name is edited", async () => {
    vi.stubEnv("OLD_PROVIDER_KEY", ""); vi.stubEnv("NEW_PROVIDER_KEY", "");
    const tiers = { fast: { connection: "existing", model: "example" } };
    await call("ai.settings.save", { settings: { connections: { existing: { kind: "openai", apiKeyEnv: "OLD_PROVIDER_KEY" } }, tiers } });
    await call("ai.connection.setKey", { connectionId: "existing", key: "fixture-secret", saveToEnv: true });
    // Simulate a machine where .env was the only credential store that accepted the key.
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")); delete config.ai.connections.existing.keyUpdatedAt; secrets = {};
    writeFileSync(join(home, "config.json"), JSON.stringify(config));
    const after = await call<AiSettingsView>("ai.settings.save", { settings: { connections: { existing: { kind: "openai", apiKeyEnv: "NEW_PROVIDER_KEY" } }, tiers } });
    expect(after.connections[0]).toMatchObject({ id: "existing", keySaved: true, keyInEnv: true, keyInKeychain: false, keySource: "env", keyEnvName: "NEW_PROVIDER_KEY", missing: [] });
    expect(readFileSync(join(home, ".env"), "utf8")).toContain("NEW_PROVIDER_KEY=fixture-secret");
    expect(readFileSync(join(home, ".env"), "utf8")).not.toContain("OLD_PROVIDER_KEY=");
    expect(process.env.NEW_PROVIDER_KEY).toBe("fixture-secret"); expect(process.env.OLD_PROVIDER_KEY).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain("fixture-secret"); expect(after.tiers).toEqual(tiers);
  });

  it("keeps a shared original variable for another provider when editing a saved-key variable", async () => {
    vi.stubEnv("SHARED_PROVIDER_KEY", ""); vi.stubEnv("NEW_PROVIDER_KEY", "");
    await call("ai.settings.save", { settings: { connections: { first: { kind: "openai", apiKeyEnv: "SHARED_PROVIDER_KEY" }, second: { kind: "openai", apiKeyEnv: "SHARED_PROVIDER_KEY" } }, tiers: { fast: { connection: "first", model: "example" } } } });
    await call("ai.connection.setKey", { connectionId: "first", key: "fixture-shared", saveToEnv: true });
    await call("ai.settings.save", { settings: { connections: { first: { kind: "openai", apiKeyEnv: "NEW_PROVIDER_KEY" }, second: { kind: "openai", apiKeyEnv: "SHARED_PROVIDER_KEY" } } } });
    const text = readFileSync(join(home, ".env"), "utf8"); expect(text).toContain("SHARED_PROVIDER_KEY=fixture-shared"); expect(text).toContain("NEW_PROVIDER_KEY=fixture-shared");
  });

  it("refuses a conflicting destination variable before changing settings or credentials", async () => {
    vi.stubEnv("OLD_PROVIDER_KEY", ""); vi.stubEnv("NEW_PROVIDER_KEY", "");
    await call("ai.settings.save", { settings: { connections: { existing: { kind: "openai", apiKeyEnv: "OLD_PROVIDER_KEY" } }, tiers: { fast: { connection: "existing", model: "example" } } } });
    await call("ai.connection.setKey", { connectionId: "existing", key: "fixture-first", saveToEnv: true });
    writeFileSync(join(home, ".env"), readFileSync(join(home, ".env"), "utf8") + "NEW_PROVIDER_KEY=fixture-other\n");
    const config = readFileSync(join(home, "config.json"), "utf8"), env = readFileSync(join(home, ".env"), "utf8");
    await expect(call("ai.settings.save", { settings: { connections: { existing: { kind: "openai", apiKeyEnv: "NEW_PROVIDER_KEY" } } } })).rejects.toThrow("already has a different key");
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(config); expect(readFileSync(join(home, ".env"), "utf8")).toBe(env);
  });

  it.each([false, true])("rolls back the copied key if edited settings fail validation (empty destination: %s)", async emptyDestination => {
    vi.stubEnv("OLD_PROVIDER_KEY", ""); vi.stubEnv("NEW_PROVIDER_KEY", "");
    await call("ai.settings.save", { settings: { connections: { existing: { kind: "openai", apiKeyEnv: "OLD_PROVIDER_KEY" } }, tiers: { fast: { connection: "existing", model: "example" } } } });
    await call("ai.connection.setKey", { connectionId: "existing", key: "fixture-first", saveToEnv: true });
    if (emptyDestination) writeFileSync(join(home, ".env"), readFileSync(join(home, ".env"), "utf8") + "NEW_PROVIDER_KEY=\n");
    const config = readFileSync(join(home, "config.json"), "utf8"), env = readFileSync(join(home, ".env"), "utf8");
    await expect(call("ai.settings.save", { settings: { connections: { existing: { kind: "openai", apiKeyEnv: "NEW_PROVIDER_KEY", baseUrl: "not-a-url" } } } })).rejects.toThrow();
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(config);
    expect(readFileSync(join(home, ".env"), "utf8")).toBe(env.replace("NEW_PROVIDER_KEY=\n", ""));
    expect(process.env.NEW_PROVIDER_KEY).toBe(""); expect(process.env.OLD_PROVIDER_KEY).toBe("fixture-first");
  });
  it("keeps a custom endpoint's saved key reachable when resetting its variable to the default", async () => {
    vi.stubEnv("OLD_PROVIDER_KEY", ""); vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "");
    const connection = { kind: "openai-compatible", baseUrl: "https://custom.test/v1", apiKeyEnv: "OLD_PROVIDER_KEY" };
    const tiers = { fast: { connection: "existing", model: "example" } };
    await call("ai.settings.save", { settings: { connections: { existing: connection }, tiers } });
    await call("ai.connection.setKey", { connectionId: "existing", key: "fixture-custom", saveToEnv: true });
    const { apiKeyEnv: _old, ...rest } = connection;
    const after = await call<AiSettingsView>("ai.settings.save", { settings: { connections: { existing: rest }, tiers } });
    expect(after.connections[0]).toMatchObject({ apiKeyEnv: "OPENAI_COMPATIBLE_API_KEY", keyInEnv: true, keySource: "env" });
    expect(after.effective.find(job => job.job === "extraction")).toMatchObject({ keySource: "env", ok: true });
  });

  it("shows legacy profiles as an imported setup and adopts them on the first save, keeping the old keys in the file", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify(awsProfiles));
    const view = await call<View>("ai.settings.read");
    expect(view.imported).toBe(true);
    expect(view.connections).toEqual([expect.objectContaining({ id: "anthropic-aws", kind: "anthropic-aws", keySource: "env", usedBy: expect.arrayContaining(["extraction", "review"]) })]);
    expect(view.tiers).toEqual({ fast: { connection: "anthropic-aws", model: "claude-haiku-4-5-20251001" }, smart: { connection: "anthropic-aws", model: "claude-sonnet-4-6" } });
    expect(view.effective.find(row => row.job === "extraction")).toMatchObject({ connectionLabel: "Claude on AWS", model: "claude-haiku-4-5-20251001", ok: true });
    expect(JSON.stringify(view)).not.toContain("aws-secret-value");

    const saved = await call<View>("ai.settings.save", { settings: { connections: { "anthropic-aws": { kind: "anthropic-aws" } }, tiers: view.tiers } });
    expect(saved.imported).toBe(false);
    const file = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<string, unknown>;
    expect(file.profiles).toEqual(awsProfiles.profiles);
    expect(file.ai).toMatchObject({ tiers: view.tiers, budgets: { backgroundDailyTokens: 2_000_000 } });
  });

  it("saves keys to the keychain only, never returns them, and refuses to remove a connection still in use", async () => {
    await call("ai.settings.save", { settings: { connections: { openrouter: { kind: "openrouter" } }, tiers: { fast: { connection: "openrouter", model: "google/gemini-2.5-flash" } } } });
    const before = await call<View>("ai.settings.read");
    expect(before.connections[0]).toMatchObject({ keySaved: false, keySource: "missing" });
    expect(before.effective.find(row => row.job === "review")).toMatchObject({ ok: false });

    const after = await call<View>("ai.connection.setKey", { connectionId: "openrouter", key: "sk-or-v1-test-secret" });
    expect(secrets.openrouter).toBe("sk-or-v1-test-secret");
    expect(after.connections[0]).toMatchObject({ keySaved: true, keySource: "keychain" });
    expect(JSON.stringify(after)).not.toContain("sk-or-v1-test-secret");
    expect(readFileSync(join(home, "config.json"), "utf8")).not.toContain("sk-or-v1-test-secret");
    // The page cannot forge a saved-key marker; it is kept from what the keychain call recorded.
    await call("ai.settings.save", { settings: { connections: { openrouter: { kind: "openrouter", keyUpdatedAt: "forged" } }, tiers: { fast: { connection: "openrouter", model: "x" } } } });
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).ai.connections.openrouter.keyUpdatedAt).not.toBe("forged");

    await expect(call("ai.settings.save", { settings: { connections: {}, tiers: { fast: { connection: "openrouter", model: "x" } } } }))
      .rejects.toMatchObject({ message: expect.stringContaining("Choose another provider first for: Fast model") });
    await call("ai.settings.save", { settings: { connections: { local: { kind: "ollama" } }, tiers: { fast: { connection: "local", model: "llama3.1:8b" } } } });
    expect(secrets.openrouter).toBeUndefined();
  });

  it("saves keys to the keychain and to .env under the default variable name, keeping the rest of .env", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY_2", "");
    writeFileSync(join(home, ".env"), "# mine\nOTHER_KEY=keep-me\n");
    await call("ai.settings.save", { settings: { connections: { openai: { kind: "openai" }, "openai-2": { kind: "openai" } }, tiers: { fast: { connection: "openai", model: "gpt-5-mini" } } } });

    const saved = await call<View & { connections: Array<{ keyInEnv: boolean; keyInKeychain: boolean; keyEnvName: string }> }>("ai.connection.setKey", { connectionId: "openai-2", key: "sk-second", saveToEnv: true });
    expect(secrets["openai-2"]).toBe("sk-second");
    expect(readFileSync(join(home, ".env"), "utf8")).toBe("# mine\nOTHER_KEY=keep-me\nOPENAI_API_KEY_2=sk-second\n");
    expect(saved.connections.find(c => c.id === "openai-2")).toMatchObject({ keySaved: true, keyInKeychain: true, keyInEnv: true, keyEnvName: "OPENAI_API_KEY_2", keySource: "env" });
    expect(saved.connections.find(c => c.id === "openai")).toMatchObject({ keyEnvName: "OPENAI_API_KEY", keySaved: false });
    expect(JSON.stringify(saved)).not.toContain("sk-second");

    // Replacing the key in the keychain only drops the older .env copy, which would otherwise win.
    await call("ai.connection.setKey", { connectionId: "openai-2", key: "sk-newer" });
    expect(readFileSync(join(home, ".env"), "utf8")).toBe("# mine\nOTHER_KEY=keep-me\n");
    expect(secrets["openai-2"]).toBe("sk-newer");
    expect(process.env.OPENAI_API_KEY_2).toBeUndefined();

    await call("ai.connection.setKey", { connectionId: "openai-2", key: "sk-again", saveToEnv: true });
    await call("ai.connection.removeKey", { connectionId: "openai-2" });
    expect(readFileSync(join(home, ".env"), "utf8")).toBe("# mine\nOTHER_KEY=keep-me\n");
    expect(secrets["openai-2"]).toBeUndefined();
  });

  it("keeps the key in .env when the keychain refuses it, and fails only when neither store took it", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    setKeychainStoreForTests({ get: async () => undefined, set: async () => { throw new Error("locked"); }, delete: async () => undefined });
    await call("ai.settings.save", { settings: { connections: { openrouter: { kind: "openrouter" } }, tiers: { fast: { connection: "openrouter", model: "x" } } } });

    await expect(call("ai.connection.setKey", { connectionId: "openrouter", key: "sk-or-v1-x" }))
      .rejects.toMatchObject({ message: expect.stringContaining("Also save to .env") });
    const view = await call<View & { notice?: string }>("ai.connection.setKey", { connectionId: "openrouter", key: "sk-or-v1-x", saveToEnv: true });
    expect(view.notice).toContain("saved to .env as OPENROUTER_API_KEY only");
    expect(view.connections[0]).toMatchObject({ keySaved: true, keySource: "env" });
    expect(readFileSync(join(home, ".env"), "utf8")).toBe("OPENROUTER_API_KEY=sk-or-v1-x\n");
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).ai.connections.openrouter).toEqual({ kind: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", keySavedToEnv: true });

    // Removing the connection removes the key the app wrote to .env.
    await call("ai.settings.save", { settings: { connections: { local: { kind: "ollama" } }, tiers: { fast: { connection: "local", model: "llama3.1:8b" } } } });
    expect(readFileSync(join(home, ".env"), "utf8")).toBe("");
  });

  it("suggests current Claude models for Claude on AWS, which has no live model list", async () => {
    await call("ai.settings.save", { settings: { connections: { "anthropic-aws": { kind: "anthropic-aws" } }, tiers: { fast: { connection: "anthropic-aws", model: "claude-haiku-5-5" } } } });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const list = await listConnectionModels("anthropic-aws", fetchImpl);
    expect(list).toEqual({ live: false, models: [
      { id: "claude-haiku-5-5", suggested: "fast" }, { id: "claude-sonnet-5-5", suggested: "smart" },
      { id: "claude-opus-5-5", suggested: "smart" }, { id: "claude-fable-5-1", suggested: "smart" }
    ] });
    expect(fetchImpl).not.toHaveBeenCalled();
    const view = await call<{ presets: Array<{ kind: string; modelsUrl?: string }> }>("ai.settings.read");
    expect(view.presets.find(preset => preset.kind === "anthropic-aws")?.modelsUrl).toBe("https://platform.claude.com/docs/en/about-claude/models/overview");
    expect(view.presets.filter(preset => !preset.modelsUrl).map(preset => preset.kind)).toEqual(["openai-compatible"]);
  });

  it("tests an OpenRouter key without spending tokens and lists models with prices", async () => {
    await call("ai.settings.save", { settings: { connections: { openrouter: { kind: "openrouter" } }, tiers: { smart: { connection: "openrouter", model: "anthropic/claude-sonnet-5.5" } } } });
    await call("ai.connection.setKey", { connectionId: "openrouter", key: "sk-or-v1-test" });
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      const body = url.endsWith("/key")
        ? { data: { limit: 10, usage: 2.5 } }
        : { data: [{ id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" } }, { id: "zzz/other" }] };
      return { ok: true, status: 200, json: async () => body };
    }) as unknown as typeof fetch;
    await expect(testConnection("openrouter", fetchImpl)).resolves.toEqual({ ok: true, detail: "OpenRouter accepted the key; $7.50 of credit left on it.", creditUsd: 7.5 });
    const list = await listConnectionModels("openrouter", fetchImpl);
    expect(list.live).toBe(true);
    expect(list.models.find(model => model.id === "anthropic/claude-sonnet-5.5")).toMatchObject({ label: "Claude Sonnet 5.5", contextLength: 200000, promptUsdPerMillion: 3, completionUsdPerMillion: 15, suggested: "smart" });
    expect(list.models.at(-1)).toMatchObject({ id: "zzz/other" });
    expect(urls).toEqual(["https://openrouter.ai/api/v1/key", "https://openrouter.ai/api/v1/models"]);

    const rejecting = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(testConnection("openrouter", rejecting)).resolves.toEqual({ ok: false, detail: "The provider rejected the key." });
  });

  it("shows a ChatGPT plan connection as waiting for sign-in, keeps sign-in markers server-side and deletes its sign-in with it", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ ai: { connections: { chatgpt: { kind: "chatgpt", keyUpdatedAt: "2026-11-01T00:00:00.000Z", accountLabel: "person@example.com" } } } }));
    const view = await call<View & { presets: Array<{ kind: string; auth: string }>; connections: Array<{ id: string; accountLabel?: string }> }>("ai.settings.read");
    expect(view.presets.find(preset => preset.kind === "chatgpt")).toMatchObject({ auth: "chatgpt" });
    expect(view.presets.find(preset => preset.kind === "claude-code")).toMatchObject({ auth: "claude-cli" });
    expect(view.connections.find(connection => connection.id === "chatgpt")).toMatchObject({ keySource: "keychain", accountLabel: "person@example.com" });
    // The page cannot forge or drop the sign-in when it saves other changes.
    await call("ai.settings.save", { settings: { connections: { chatgpt: { kind: "chatgpt", label: "Work plan" } }, tiers: {} } });
    const stored = JSON.parse(readFileSync(join(home, "config.json"), "utf8")).ai.connections.chatgpt;
    expect(stored).toMatchObject({ label: "Work plan", keyUpdatedAt: "2026-11-01T00:00:00.000Z", accountLabel: "person@example.com" });
    await expect(call("ai.settings.save", { settings: { connections: { chatgpt: { kind: "chatgpt", accountLabel: "forged@example.com" } } } })).rejects.toThrow();
    mkdirSync(join(home, "ai-auth"), { recursive: true });
    writeFileSync(join(home, "ai-auth", "chatgpt.json"), JSON.stringify({ version: 1, clientId: "oaiapp_x" }));
    await call("ai.settings.save", { settings: { connections: {}, tiers: {} } });
    expect(existsSync(join(home, "ai-auth", "chatgpt.json"))).toBe(false);
    await expect(call("ai.chatgpt.start", { connectionId: "chatgpt", redirectUri: "http://127.0.0.1:1455/auth/callback" })).rejects.toThrow(/no longer exists/);
  });
});
