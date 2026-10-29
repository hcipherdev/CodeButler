// Tests credentialStatus() (including the remote-model opt-in), resolveApiKey() and resolveAwsSettings() in src/ai/credentials.ts with a fake keychain store.
import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialStatus, REMOTE_MODEL_CONSENT, resolveApiKey, resolveAwsSettings, setKeychainStoreForTests, type KeychainStore } from "../../src/ai/credentials.js";
import type { ExtractorConfig } from "../../src/types.js";

function fakeStore(secrets: Record<string, string>) {
  const reads: string[] = [];
  const store: KeychainStore = {
    async get(id) { reads.push(id); return secrets[id]; },
    async set(id, secret) { secrets[id] = secret; },
    async delete(id) { delete secrets[id]; }
  };
  return { store, reads };
}
const openrouter = (extra: Partial<ExtractorConfig> = {}): ExtractorConfig => ({
  provider: "openai-compatible", model: "m", apiKeyEnv: "TEST_OPENROUTER_KEY", connectionId: "openrouter", connectionKind: "openrouter", connectionLabel: "OpenRouter", ...extra
});

afterEach(() => { vi.unstubAllEnvs(); setKeychainStoreForTests(undefined); });

describe("AI credentials", () => {
  it("prefers the environment over a saved key and reports where the key comes from", async () => {
    const { store, reads } = fakeStore({ openrouter: "from-keychain" });
    setKeychainStoreForTests(store);
    vi.stubEnv("TEST_OPENROUTER_KEY", "from-env");
    const saved = openrouter({ keyUpdatedAt: "2026-10-20T00:00:00.000Z" });
    expect(credentialStatus(saved)).toEqual({ ok: true, keySource: "env", envName: "TEST_OPENROUTER_KEY", missing: [] });
    expect(await resolveApiKey(saved)).toBe("from-env");
    expect(reads).toEqual([]);
    vi.stubEnv("TEST_OPENROUTER_KEY", "");
    expect(credentialStatus(saved)).toMatchObject({ ok: true, keySource: "keychain" });
    expect(await resolveApiKey(saved)).toBe("from-keychain");
    expect(await resolveApiKey(saved)).toBe("from-keychain");
    expect(reads).toEqual(["openrouter"]);
  });

  it("re-reads the keychain once a replaced key bumps keyUpdatedAt", async () => {
    const secrets = { openrouter: "first" };
    const { store, reads } = fakeStore(secrets);
    setKeychainStoreForTests(store);
    expect(await resolveApiKey(openrouter({ keyUpdatedAt: "1" }))).toBe("first");
    secrets.openrouter = "second";
    expect(await resolveApiKey(openrouter({ keyUpdatedAt: "1" }))).toBe("first");
    expect(await resolveApiKey(openrouter({ keyUpdatedAt: "2" }))).toBe("second");
    expect(reads).toEqual(["openrouter", "openrouter"]);
  });

  it("reports missing keys without values, needs none for local servers, and explains a failed keychain read", async () => {
    vi.stubEnv("TEST_OPENROUTER_KEY", "");
    expect(credentialStatus(openrouter())).toEqual({ ok: false, keySource: "missing", missing: ["TEST_OPENROUTER_KEY"] });
    await expect(resolveApiKey(openrouter())).rejects.toThrow("OpenRouter API key is missing; set TEST_OPENROUTER_KEY");
    const local: ExtractorConfig = { provider: "openai-compatible", model: "llama", apiKeyEnv: "", connectionId: "ollama", connectionKind: "ollama" };
    expect(credentialStatus(local)).toEqual({ ok: true, keySource: "not-needed", missing: [] });
    expect(await resolveApiKey(local)).toBeUndefined();
    setKeychainStoreForTests({ get: async () => { throw new Error("locked"); }, set: async () => {}, delete: async () => {} });
    await expect(resolveApiKey(openrouter({ keyUpdatedAt: "x" }))).rejects.toThrow("could not be read from the system keychain");
  });

  it("takes Claude on AWS workspace and region from the environment first, then saved values", () => {
    const aws: ExtractorConfig = { provider: "anthropic-aws", model: "m", apiKeyEnv: "TEST_AWS_KEY", workspaceIdEnv: "TEST_AWS_WS", regionEnv: "TEST_AWS_REGION", workspaceId: "wrkspc_saved", region: "eu-west-1" };
    vi.stubEnv("TEST_AWS_KEY", "k"); vi.stubEnv("TEST_AWS_WS", ""); vi.stubEnv("TEST_AWS_REGION", "us-east-1");
    expect(resolveAwsSettings(aws)).toEqual({ workspaceId: "wrkspc_saved", region: "us-east-1" });
    expect(credentialStatus({ ...aws, workspaceId: undefined })).toMatchObject({ ok: false, missing: ["TEST_AWS_WS"] });
  });

  it("reports a model waiting for the remote-model opt-in as not ready, even with its key present", () => {
    vi.stubEnv("TEST_OPENROUTER_KEY", "from-env");
    expect(credentialStatus(openrouter({ requiresConsent: true }))).toEqual({
      ok: false, keySource: "env", envName: "TEST_OPENROUTER_KEY", missing: [REMOTE_MODEL_CONSENT]
    });
  });
});
