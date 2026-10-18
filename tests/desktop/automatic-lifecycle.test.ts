// Tests automatic sync lifecycle hooks, read-only account status, and project setup before watcher ingestion.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDesktopRequest } from "../../src/desktop/service.js";
import { ensureProjectIdentity } from "../../src/cloud/project-identity.js";
import { initializeProjectMemory } from "../../src/project-initialization.js";
import { activeForegroundIntent } from "../../src/cloud/foreground.js";
import { saveBinding } from "../../src/cloud/state.js";
import { makeTempDir, cleanupTempDir } from "../helpers/temp.js";
import type { DesktopAccountStatus } from "../../src/desktop/account.js";
import type { AccountClient } from "../../src/cloud/account-client.js";

const auth = vi.hoisted(() => ({ status: vi.fn(), login: vi.fn(), verify: vi.fn(), register: vi.fn(), exchange: vi.fn(), poll: vi.fn(), complete: vi.fn(), confirm: vi.fn(), restore: vi.fn(), approve: vi.fn(), devices: vi.fn(), revoke: vi.fn() }));
vi.mock("../../src/desktop/account.js", async original => ({ ...await original<Record<string, unknown>>(), localAccountStatus: auth.status, accountSummary: auth.status, accountPasswordLogin: auth.login, accountVerify: auth.verify, accountRegister: auth.register, accountPasskeyExchange: auth.exchange, enrollmentPoll: auth.poll, deviceComplete: auth.complete, vaultConfirm: auth.confirm, recoveryRestore: auth.restore, deviceApprove: auth.approve, accountDevices: auth.devices, accountDeviceRevoke: auth.revoke }));
let root: string, home: string;
const ready: DesktopAccountStatus = { server: "https://example.test", accountId: "00000000-0000-4000-8000-000000000001", signedIn: true, verified: true, device: "enrolled", connection: "online" };
beforeEach(() => {
  root = makeTempDir(); home = makeTempDir(); vi.stubEnv("CODE_BUTLER_HOME", home); vi.resetAllMocks();
  for (const fn of [auth.status, auth.login, auth.verify, auth.register, auth.exchange]) fn.mockResolvedValue(ready);
});
afterEach(() => { vi.unstubAllEnvs(); cleanupTempDir(root); cleanupTempDir(home); });
const automatic = () => vi.fn(async (_status: DesktopAccountStatus, _options?: import("../../src/desktop/bootstrap.js").AccountBootstrapOptions) => ({ rules: { state: "enabled" as const }, projects: [] }));

describe("automatic desktop lifecycle", () => {
  it("runs bootstrap after each login method while account status and summary remain read-only", async () => {
    const bootstrapAccount = automatic(), options = { bootstrapAccount, ensureGlobalWatcher: () => {} };
    await handleDesktopRequest({ version: 1, action: "account.status" }, options);
    await handleDesktopRequest({ version: 1, action: "account.summary" }, options);
    expect(bootstrapAccount).not.toHaveBeenCalled();
    const server = ready.server, email = "test@example.test", challengeId = randomUUID();
    await handleDesktopRequest({ version: 1, action: "account.password.login", server, email, password: "example" }, options);
    await handleDesktopRequest({ version: 1, action: "account.verify", server, email, challengeId, code: "12345678" }, options);
    await handleDesktopRequest({ version: 1, action: "account.register", server, email, challengeId, code: "12345678", password: "example" }, options);
    await handleDesktopRequest({ version: 1, action: "account.passkey.exchange", server, kind: "login", code: "a".repeat(43), verifier: "b".repeat(43), state: "c".repeat(43) }, options);
    expect(bootstrapAccount).toHaveBeenCalledTimes(4);
    expect(bootstrapAccount.mock.calls[0]?.[0]).toEqual(ready);
  });
  it("bootstraps startup and completed enrollment but leaves pending enrollment waiting", async () => {
    const bootstrapAccount = automatic(), options = { bootstrapAccount, ensureGlobalWatcher: () => {} };
    await expect(handleDesktopRequest({ version: 1, action: "account.bootstrap" }, options)).resolves.toMatchObject({ rules: { state: "enabled" } });
    auth.poll.mockResolvedValue({ status: "pending", expiresAt: Date.now() + 600_000 });
    await handleDesktopRequest({ version: 1, action: "account.enrollment.poll" }, options);
    expect(bootstrapAccount).toHaveBeenCalledTimes(1);
    auth.poll.mockResolvedValue({ status: "enrolled" });
    await handleDesktopRequest({ version: 1, action: "account.enrollment.poll" }, options);
    expect(bootstrapAccount).toHaveBeenCalledTimes(2);
  });
  it("accepts session-bound passkey state while rejecting malformed revision suffixes", async () => {
    const options = { bootstrapAccount: automatic(), ensureGlobalWatcher: () => {} };
    const request = { version: 1, action: "account.passkey.exchange", server: ready.server, kind: "login", code: "a".repeat(43), verifier: "b".repeat(43), state: "c".repeat(43) + "_12" };
    await handleDesktopRequest(request, options);
    expect(auth.exchange).toHaveBeenCalledWith(ready.server, "login", request.code, request.verifier, request.state);
    auth.exchange.mockClear();
    await expect(handleDesktopRequest({ ...request, state: "c".repeat(43) + "_revision" }, options)).rejects.toMatchObject({ code: "invalid-request" });
    expect(auth.exchange).not.toHaveBeenCalled();
  });
  it("approves with a fingerprint alone and requires confirmation before device removal", async () => {
    auth.approve.mockResolvedValue({ approved: true });
    const fingerprint = "a".repeat(64);
    await expect(handleDesktopRequest({ version: 1, action: "account.device.approve", fingerprint })).resolves.toEqual({ approved: true });
    expect(auth.approve).toHaveBeenCalledWith(fingerprint);
    const deviceId = randomUUID();
    await expect(handleDesktopRequest({ version: 1, action: "account.device.revoke", deviceId })).rejects.toMatchObject({ code: "confirmation-required" });
    expect(auth.revoke).not.toHaveBeenCalled();
    auth.revoke.mockResolvedValue({ revoked: true });
    await expect(handleDesktopRequest({ version: 1, action: "account.device.revoke", deviceId, confirmed: true })).resolves.toEqual({ revoked: true });
  });
  it("enables recognized portable memory after initialization completes and before the watcher starts", async () => {
    ensureProjectIdentity(root); const order: string[] = []; let initializationComplete = false; const vaultId = randomUUID();
    const result = await handleDesktopRequest({ version: 1, action: "projects.add", root, initialize: true }, {
      initializationOptions: { generator: { generate: async () => "# Project\n\nInitialized test project." } },
      initializeProject: async (target, options) => { const result = await initializeProjectMemory(target, options); initializationComplete = true; return result; },
      automaticConnection: {
        captureAccount: async () => ({ client: { server: ready.server } as AccountClient, vaultId, assertCurrent: async () => {} }),
        inspect: async () => ({ marker: "committed", recognition: "existing", populated: false, provenance: "portable-marker", projects: [], suggestions: [] }),
        enable: async target => {
          expect(initializationComplete).toBe(true); expect(activeForegroundIntent(target)).toBeDefined(); order.push("enable");
          const state = { encryptionVersion: 2 as const, enabled: true, server: ready.server!, vaultId, projectId: randomUUID(), fingerprint: "", revision: 0, status: "ready" };
          saveBinding(target, state); return state;
        }
      },
      ensureGlobalWatcher: () => { order.push("watcher"); }
    });
    expect(result).toMatchObject({ initialized: true, cloudSetup: { state: "enabled" } }); expect(order).toEqual(["enable", "watcher"]);
    expect(activeForegroundIntent(root)).toBeUndefined();
  });
});
