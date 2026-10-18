// Tests automatic account readiness for rules and deferred portable folders without mutating status reads.
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automaticSyncStatus, bootstrapAccount } from "../../src/desktop/bootstrap.js";
import type { DesktopAccountStatus } from "../../src/desktop/account.js";
import { globalRulesRoot, globalRulesProjectId } from "../../src/rules/identity.js";
import { atomicJson, saveBinding } from "../../src/cloud/state.js";
import { ensureProjectConfig, globalConfigDir } from "../../src/config.js";
import { registerWatchedProject } from "../../src/global-watch.js";
import { saveSecretBinding } from "../../src/secrets/state.js";
import type { SecretSyncStatus } from "../../src/secrets/sync.js";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";
import type { AccountClient } from "../../src/cloud/account-client.js";
import { AutomaticAccountChangedError } from "../../src/cloud/automatic-account.js";
import { secretsResourceId } from "../../src/cloud/resource-identity.js";
import { setGlobalRulesSyncEnabled } from "../../src/rules/sync.js";

const accountFence = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("../../src/cloud/automatic-account.js", async original => ({ ...await original<Record<string, unknown>>(), captureAutomaticAccount: accountFence.capture }));

let home: string;
// Canonical paths: macOS temp folders sit behind /var -> /private/var, which project roots and rules paths resolve.
beforeEach(() => { home = realpathSync(makeTempDir()); vi.stubEnv("CODE_BUTLER_HOME", home); accountFence.capture.mockReset(); accountFence.capture.mockResolvedValue({ client: { server: "https://example.test" } as AccountClient, vaultId: randomUUID(), assertCurrent: async () => {} }); });
afterEach(() => { vi.unstubAllEnvs(); cleanupTempDir(home); });
const ready: DesktopAccountStatus = { server: "https://example.test", accountId: "00000000-0000-4000-8000-000000000001", signedIn: true, verified: true, device: "enrolled", connection: "online" };

describe("automatic account bootstrap", () => {
  it("enables global rules once enrolled, starts the shared watcher, and leaves account login usable", async () => {
    const enable = vi.fn(async () => undefined), watcher = vi.fn();
    const result = await bootstrapAccount(ready, { setRulesSyncEnabled: enable, ensureGlobalWatcher: watcher });
    expect(result.rules).toEqual({ state: "enabled" }); expect(enable).toHaveBeenCalledWith(true, expect.objectContaining({ server: ready.server }), null); expect(watcher).toHaveBeenCalledOnce();
    expect(automaticSyncStatus(ready.server!, ready.accountId!)).toEqual(result);
    expect(automaticSyncStatus(ready.server!, randomUUID())).toBeUndefined();
  });
  it("waits for enrollment rather than trying to set up unavailable encryption keys", async () => {
    const enable = vi.fn(async () => undefined);
    expect(await bootstrapAccount({ ...ready, device: "not-enrolled" }, { setRulesSyncEnabled: enable })).toMatchObject({ rules: { state: "pending" } });
    expect(enable).not.toHaveBeenCalled();
  });
  it("respects manually paused rules through later sign-ins", async () => {
    mkdirSync(globalRulesRoot(), { recursive: true }); const vaultId = randomUUID();
    saveBinding(globalRulesRoot(), { kind: "global-rules", vaultId, projectId: globalRulesProjectId(vaultId), server: ready.server!, enabled: false, revision: 0, fingerprint: "", status: "disabled" });
    const enable = vi.fn(async () => undefined);
    expect(await bootstrapAccount(ready, { setRulesSyncEnabled: enable })).toMatchObject({ rules: { state: "paused" } }); expect(enable).not.toHaveBeenCalled();
  });
  it("preserves a rules pause made while automatic account verification is awaiting", async () => {
    mkdirSync(globalRulesRoot(), { recursive: true }); const vaultId = randomUUID();
    const initial = { kind: "global-rules" as const, vaultId, projectId: globalRulesProjectId(vaultId), server: ready.server!, enabled: true, revision: 0, fingerprint: "", status: "ready" };
    saveBinding(globalRulesRoot(), initial);
    accountFence.capture.mockImplementation(async () => {
      saveBinding(globalRulesRoot(), { ...initial, enabled: false, status: "disabled" });
      return { client: { server: ready.server } as AccountClient, vaultId, assertCurrent: async () => {} };
    });
    const result = await bootstrapAccount(ready, { setRulesSyncEnabled: setGlobalRulesSyncEnabled });
    expect(result.rules).toEqual({ state: "paused" });
    expect(automaticSyncStatus(ready.server!, ready.accountId!)?.rules.state).toBe("paused");
  });
  it("requires review for another rules vault even after an earlier successful readiness intent", async () => {
    mkdirSync(globalRulesRoot(), { recursive: true }); const vaultId = randomUUID(), otherVaultId = randomUUID();
    saveBinding(globalRulesRoot(), { kind: "global-rules", vaultId: otherVaultId, projectId: globalRulesProjectId(otherVaultId), server: ready.server!, enabled: true, revision: 0, fingerprint: "", status: "synced" });
    atomicJson(join(globalConfigDir(), "cloud", "automatic-rules-setup.json"), { server: ready.server, accountId: ready.accountId });
    accountFence.capture.mockResolvedValue({ client: { server: ready.server } as AccountClient, vaultId, assertCurrent: async () => {} });
    const enable = vi.fn(async () => undefined);
    expect(await bootstrapAccount(ready, { setRulesSyncEnabled: enable })).toMatchObject({ rules: { state: "review-required", reason: expect.stringContaining("another account") } });
    expect(enable).not.toHaveBeenCalled();
  });
  it("retains quota and account-isolation problems as nonfatal readiness outcomes", async () => {
    const enable = vi.fn(async () => { throw new Error("Vault is full: global rules require one project slot"); });
    expect(await bootstrapAccount(ready, { setRulesSyncEnabled: enable })).toMatchObject({ rules: { state: "pending", reason: expect.stringContaining("Vault is full") } });
    enable.mockImplementation(async () => { throw new Error("Global rules belong to another account; automatic rebinding is disabled"); });
    expect(await bootstrapAccount(ready, { setRulesSyncEnabled: enable, force: true })).toMatchObject({ rules: { state: "review-required" } });
  });
  it("requires review before rules setup when the captured account changes", async () => {
    accountFence.capture.mockResolvedValue({ client: { server: ready.server } as AccountClient, vaultId: randomUUID(), assertCurrent: async () => { throw new AutomaticAccountChangedError(); } });
    const enable = vi.fn(async () => undefined);
    expect(await bootstrapAccount(ready, { setRulesSyncEnabled: enable })).toMatchObject({ rules: { state: "review-required" } });
    expect(enable).not.toHaveBeenCalled();
  });
  it("keeps an existing secret-file conflict visible on background readiness passes", async () => {
    const root = join(home, "project"); mkdirSync(root); ensureProjectConfig(root); registerWatchedProject(root);
    const parentProjectId = randomUUID(), vaultId = randomUUID();
    accountFence.capture.mockResolvedValue({ client: { server: ready.server } as AccountClient, vaultId, assertCurrent: async () => {} });
    saveSecretBinding(root, { version: 2, server: ready.server!, vaultId, parentProjectId, resourceId: secretsResourceId(parentProjectId), checkoutId: randomUUID(), enabled: true, status: "conflict", revision: 1 });
    const resumeAccountSecrets = vi.fn(async () => undefined);
    const result = await bootstrapAccount(ready, { setRulesSyncEnabled: async () => undefined, resumeAccountSecrets });
    expect(result.secrets).toEqual([{ root, state: "review-required", reason: expect.stringContaining("Sync view") }]);
    expect(resumeAccountSecrets).not.toHaveBeenCalled();
    expect(automaticSyncStatus(ready.server!, ready.accountId!)?.secrets).toEqual(result.secrets);
  });
  it.each(["server", "vault"] as const)("shows review instead of success for an existing secret binding on another %s", async mismatch => {
    const root = join(home, "project"); mkdirSync(root); ensureProjectConfig(root); registerWatchedProject(root);
    const parentProjectId = randomUUID(), vaultId = randomUUID();
    accountFence.capture.mockResolvedValue({ client: { server: ready.server } as AccountClient, vaultId, assertCurrent: async () => {} });
    saveSecretBinding(root, { version: 2, server: mismatch === "server" ? "https://other.example.test" : ready.server!, vaultId: mismatch === "vault" ? randomUUID() : vaultId, parentProjectId, resourceId: secretsResourceId(parentProjectId), checkoutId: randomUUID(), enabled: true, status: "synced", revision: 1 });
    const resumeAccountSecrets = vi.fn(async () => undefined);
    const result = await bootstrapAccount(ready, { setRulesSyncEnabled: async () => undefined, resumeAccountSecrets });
    expect(result.secrets).toEqual([{ root, state: "review-required", reason: expect.stringContaining("another account") }]);
    expect(resumeAccountSecrets).not.toHaveBeenCalled();
  });
  it.each([
    [{ enabled: true, status: "conflict", migration: "conflict", revision: 1, conflicts: ["fixture.env"] }, "review-required"],
    [{ enabled: true, status: "migration-required", migration: "review-required", revision: 1, error: "Open Account Center to recover access." }, "review-required"],
    [{ enabled: true, status: "error", revision: 1, error: "Temporarily offline." }, "pending"],
    [{ enabled: true, status: "syncing", migration: "pending", revision: 1 }, "pending"],
    [{ enabled: true, status: "synced", revision: 1 }, "enabled"]
  ] as Array<[SecretSyncStatus, "enabled" | "pending" | "review-required"]>)("surfaces secrets %s as %s without blocking other readiness", async (outcome, state) => {
    const root = join(home, "project"); mkdirSync(root); ensureProjectConfig(root); registerWatchedProject(root);
    saveSecretBinding(root, { version: 1, server: ready.server!, vaultId: randomUUID(), checkoutId: randomUUID(), enabled: true, status: "ready", revision: 1 });
    const result = await bootstrapAccount(ready, { setRulesSyncEnabled: async () => undefined, resumeAccountSecrets: async () => outcome });
    expect(result).toMatchObject({ rules: { state: "enabled" }, secrets: [{ root, state }] });
    if (outcome.status === "conflict") expect(result.secrets?.[0]?.reason).toContain("Sync view");
  });
});
