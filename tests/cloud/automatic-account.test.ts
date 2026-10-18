// Tests that automatic setup keeps its captured account authority across concurrent sign-in changes.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureAutomaticAccount, AutomaticAccountChangedError } from "../../src/cloud/automatic-account.js";
import { NativeSecurity, type SecurityStatus } from "../../src/cloud/native-security.js";
import { atomicJson } from "../../src/cloud/state.js";
import { globalConfigDir } from "../../src/config.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

let home: string;
beforeEach(() => { home = makeTempDir(); vi.stubEnv("CODE_BUTLER_HOME", home); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); cleanupTempDir(home); });
function fixture() {
  const expected = { server: "https://example.test", accountId: randomUUID() }, vaultId = randomUUID();
  let accountId: string = expected.accountId;
  atomicJson(join(globalConfigDir(), "cloud", "account.json"), { server: expected.server });
  const invoke = vi.fn(async () => ({ accountId, accessToken: "local-fixture", refreshToken: "local-fixture", accessExpiresAt: Date.now() + 60_000 }));
  const status = vi.fn(async () => ({ descriptor: { accountId: expected.accountId, vaultId } } as SecurityStatus));
  vi.spyOn(NativeSecurity, "forServer").mockReturnValue({ invoke, status } as unknown as NativeSecurity);
  return { expected, vaultId, invoke, changeAccount: () => { accountId = randomUUID(); } };
}
it("checks captured account identity before every authenticated request", async () => {
  const f = fixture(), context = await captureAutomaticAccount(f.expected);
  expect(context.vaultId).toBe(f.vaultId); expect((await context.client.tokens()).accountId).toBe(f.expected.accountId);
  f.changeAccount();
  await expect(context.assertCurrent()).rejects.toBeInstanceOf(AutomaticAccountChangedError);
  await expect(context.client.tokens()).rejects.toBeInstanceOf(AutomaticAccountChangedError);
});
it("rejects a server switch before reading authentication from the captured authority", async () => {
  const f = fixture(), context = await captureAutomaticAccount(f.expected); f.invoke.mockClear();
  atomicJson(join(globalConfigDir(), "cloud", "account.json"), { server: "https://other.example.test" });
  await expect(context.client.tokens()).rejects.toBeInstanceOf(AutomaticAccountChangedError);
  expect(f.invoke).not.toHaveBeenCalled();
});
