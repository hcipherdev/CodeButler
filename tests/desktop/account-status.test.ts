// Tests desktop enrollment status and recovery guidance for passkey management errors.
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { accountSummary } from "../../src/desktop/account.js";
import { handleDesktopRequest } from "../../src/desktop/service.js";
import { AccountClient } from "../../src/cloud/account-client.js";
import { EncryptionError } from "../../src/cloud/crypto-helper.js";
import { NativeSecurity } from "../../src/cloud/native-security.js";
import { atomicJson } from "../../src/cloud/state.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

let home: string;
beforeEach(() => {
  home = makeTempDir(); vi.stubEnv("CODE_BUTLER_HOME", home);
  atomicJson(join(home, "cloud", "account.json"), { server: "https://example.test" });
  vi.spyOn(NativeSecurity, "forServer").mockReturnValue({
    invoke: async () => ({ accountId: "account" }),
    status: async () => ({ device: null, descriptor: null, records: [], projects: {}, recoveryReady: false })
  } as unknown as NativeSecurity);
  vi.spyOn(AccountClient.prototype, "profile").mockResolvedValue({ id: "account", email: "owner@example.test", createdAt: 1, passwordSet: true, passkeyCount: 0 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); cleanupTempDir(home); });

it("keeps a fresh computer unverified when the vault request fails", async () => {
  vi.spyOn(AccountClient.prototype, "request").mockRejectedValue(new Error("network unavailable"));
  expect(await accountSummary()).toMatchObject({ signedIn: true, verified: false, device: "none" });
});

it("offers first-computer setup only when the server confirms no vault exists", async () => {
  vi.spyOn(AccountClient.prototype, "request").mockRejectedValue(new EncryptionError("enrollment-required"));
  expect(await accountSummary()).toMatchObject({ signedIn: true, verified: true, device: "none" });
});

it("identifies an existing vault as requiring enrollment on a fresh computer", async () => {
  vi.spyOn(AccountClient.prototype, "request").mockResolvedValue({ descriptor: { vaultId: "existing-vault" } });
  expect(await accountSummary()).toMatchObject({ signedIn: true, verified: true, device: "not-enrolled" });
});

it.each([
  { failure: "authentication required", status: 401, body: '{"state":"authentication-required"}',
    code: "invalid-request", guidance: /log back in with your password, then try Add passkey again/ },
  { failure: "authentication required for removal", status: 401, body: '{"state":"authentication-required"}', remove: true,
    code: "invalid-request", guidance: /log back in with your password, then try removing the passkey again/ },
  { failure: "server rate limit", status: 429, body: '{"state":"authentication-required"}',
    code: "busy", guidance: /Wait a few minutes, then try Add passkey again/ },
  { failure: "proxy rate limit", status: 429, body: "Too Many Requests",
    code: "busy", guidance: /Wait a few minutes, then try Add passkey again/ }
])("shows recovery guidance for a passkey request failure: $failure", async ({ status, body, code, guidance, remove }) => {
  const tokens = { accessToken: "test-access-token", refreshToken: "test-refresh-token", accessExpiresAt: Date.now() + 60_000, accountId: "account" };
  const nativeResponses = { capabilities: { sessionWrites: 1 }, "session-read": { tokens }, "tokens-read": tokens };
  vi.mocked(NativeSecurity.forServer).mockReturnValue({
    invoke: async (action: keyof typeof nativeResponses) => nativeResponses[action]
  } as unknown as NativeSecurity);
  const fetch = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal("fetch", fetch);

  const id = "test-passkey-credential";
  const request = remove
    ? { version: 1, action: "account.passkey.remove", id }
    : { version: 1, action: "account.passkey.start", kind: "add", server: "https://example.test",
      redirectUri: "http://127.0.0.1:12345/auth/callback", label: "This device" };
  await expect(handleDesktopRequest(request)).rejects.toMatchObject({ code, message: expect.stringMatching(guidance) });
  const path = remove ? `/v2/auth/passkeys/${id}` : "/v2/auth/passkey/start";
  expect(fetch).toHaveBeenCalledWith(`https://example.test${path}`, expect.objectContaining({ method: remove ? "DELETE" : "POST" }));
});
