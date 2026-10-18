// Tests automatic portable-folder connection, deferred readiness, and manual review boundaries.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureProjectIdentity } from "../../src/cloud/project-identity.js";
import { binding, saveBinding, stateDirectory, type Binding } from "../../src/cloud/state.js";
import { pendingAutomaticConnection, pauseAutomaticConnection, queueAutomaticConnection, retryAutomaticConnection } from "../../src/cloud/auto-connect.js";
import type { ProjectConnectionInspection } from "../../src/cloud/project-connections.js";
import type { AccountClient } from "../../src/cloud/account-client.js";
import { AutomaticAccountChangedError } from "../../src/cloud/automatic-account.js";
import { makeTempDir, cleanupTempDir } from "../helpers/temp.js";

let root: string, home: string, saved: Binding;
beforeEach(() => {
  root = makeTempDir(); home = makeTempDir(); vi.stubEnv("CODE_BUTLER_HOME", home);
  saved = { projectId: randomUUID(), vaultId: randomUUID(), server: "https://example.test", enabled: true, revision: 0, fingerprint: "", status: "ready", encryptionVersion: 2 };
});
afterEach(() => { vi.unstubAllEnvs(); cleanupTempDir(root); cleanupTempDir(home); });
const recognized = (recognition: ProjectConnectionInspection["recognition"], populated = false): ProjectConnectionInspection => ({ marker: "committed", recognition, provenance: "portable-marker", populated, projects: [], suggestions: [], projectId: saved.projectId });

describe("automatic portable-folder setup", () => {
  it("enables a verified recognized clone without a separate opt-in and preserves manual conflicts", async () => {
    ensureProjectIdentity(root); queueAutomaticConnection(root);
    const enable = vi.fn(async () => { saveBinding(root, { ...saved, status: "conflict" }); return binding(root); });
    await expect(retryAutomaticConnection(root, { inspect: async () => recognized("existing", true), enable })).resolves.toEqual({ root, state: "enabled" });
    expect(enable).toHaveBeenCalledWith(root, true); expect(binding(root)?.status).toBe("conflict");
    expect(pendingAutomaticConnection(root)).toBe(false);
  });
  it("keeps a deferred intent until enrollment and a fresh catalog are available", async () => {
    ensureProjectIdentity(root); queueAutomaticConnection(root);
    const inspect = vi.fn(async () => recognized("existing")), enable = vi.fn(async () => saved);
    expect(await retryAutomaticConnection(root, { ready: false, inspect, enable })).toMatchObject({ state: "pending" });
    expect(inspect).not.toHaveBeenCalled();
    expect(await retryAutomaticConnection(root, { ready: true, force: true, inspect: async () => recognized("unavailable"), enable })).toMatchObject({ state: "pending" });
    expect(enable).not.toHaveBeenCalled();
    expect(await retryAutomaticConnection(root, { ready: true, force: true, inspect, enable })).toMatchObject({ state: "enabled" });
  });
  it.each(["remote-changed", "repair-required", "account-changed", "deleted", "conflict", "legacy"] as const)("requires manual review for %s without creating memory", async recognition => {
    ensureProjectIdentity(root); queueAutomaticConnection(root);
    const enable = vi.fn(async () => saved);
    expect(await retryAutomaticConnection(root, { inspect: async () => recognized(recognition), enable })).toMatchObject({ state: "review-required" });
    expect(enable).not.toHaveBeenCalled(); expect(pendingAutomaticConnection(root)).toBe(false);
  });
  it("does not set up unmarked folders or resume a deliberately paused connection", async () => {
    expect(queueAutomaticConnection(root)).toEqual({ root, state: "local-only" });
    expect(existsSync(join(stateDirectory(root), "automatic-connection.json"))).toBe(false);
    ensureProjectIdentity(root); saveBinding(root, { ...saved, enabled: false, status: "disabled" });
    expect(queueAutomaticConnection(root)).toEqual({ root, state: "paused" });
    const enable = vi.fn(async () => saved);
    expect(await retryAutomaticConnection(root, { enable })).toEqual({ root, state: "paused" }); expect(enable).not.toHaveBeenCalled();
  });
  it("reconnects a folder re-added after local memory removal, with or without its marker", async () => {
    const identity = ensureProjectIdentity(root).projectIdentity;
    saveBinding(root, { ...saved, projectIdentity: identity, enabled: false, status: "removed" });
    expect(queueAutomaticConnection(root)).toEqual({ root, state: "pending" });
    const enable = vi.fn(async () => { saveBinding(root, { ...saved, projectIdentity: identity }); return binding(root); });
    await expect(retryAutomaticConnection(root, { inspect: async () => recognized("existing", true), enable })).resolves.toEqual({ root, state: "enabled" });
    expect(enable).toHaveBeenCalledWith(root, true); expect(pendingAutomaticConnection(root)).toBe(false);

    const unmarked = makeTempDir();
    try {
      saveBinding(unmarked, { ...saved, projectIdentity: "recorded-identity", enabled: false, status: "removed" });
      expect(queueAutomaticConnection(unmarked)).toEqual({ root: unmarked, state: "pending" });
      const resume = vi.fn(async () => { saveBinding(unmarked, { ...saved, projectIdentity: "recorded-identity" }); return binding(unmarked); });
      await expect(retryAutomaticConnection(unmarked, { inspect: async () => ({ ...recognized("existing"), provenance: "local-binding" }), enable: resume })).resolves.toEqual({ root: unmarked, state: "enabled" });
    } finally { cleanupTempDir(unmarked); }
  });
  it("keeps a removed legacy binding without a recorded identity manually resumable", async () => {
    saveBinding(root, { ...saved, enabled: false, status: "removed" });
    expect(queueAutomaticConnection(root)).toEqual({ root, state: "paused" });
    expect(existsSync(join(stateDirectory(root), "automatic-connection.json"))).toBe(false);
  });
  it("lets a pause made after re-adding win over automatic resumption", async () => {
    const identity = ensureProjectIdentity(root).projectIdentity;
    saveBinding(root, { ...saved, projectIdentity: identity, enabled: false, status: "removed" });
    queueAutomaticConnection(root);
    saveBinding(root, { ...saved, projectIdentity: identity, enabled: false, status: "disabled" });
    const enable = vi.fn(async () => saved);
    expect(await retryAutomaticConnection(root, { inspect: async () => recognized("existing"), enable })).toEqual({ root, state: "paused" });
    expect(enable).not.toHaveBeenCalled(); expect(pendingAutomaticConnection(root)).toBe(false);
  });
  it("stops when the marker or requested account changes during deferred setup", async () => {
    const account = { server: saved.server, accountId: randomUUID() };
    ensureProjectIdentity(root); queueAutomaticConnection(root, account);
    const enable = vi.fn(async () => saved);
    expect(await retryAutomaticConnection(root, { account: { ...account, accountId: randomUUID() }, enable })).toMatchObject({ state: "review-required" });
    expect(enable).not.toHaveBeenCalled();
  });
  it("honors an explicit pause while first connection setup is still pending", async () => {
    ensureProjectIdentity(root); queueAutomaticConnection(root); pauseAutomaticConnection(root);
    const enable = vi.fn(async () => saved);
    expect(await retryAutomaticConnection(root, { ready: true, force: true, enable })).toMatchObject({ state: "paused" });
    expect(queueAutomaticConnection(root)).toMatchObject({ state: "paused" }); expect(enable).not.toHaveBeenCalled();
  });
  it("does not override a pause made while verifying the remote connection", async () => {
    ensureProjectIdentity(root); queueAutomaticConnection(root);
    const enable = vi.fn(async () => saved);
    expect(await retryAutomaticConnection(root, { inspect: async () => { pauseAutomaticConnection(root); return recognized("existing"); }, enable })).toMatchObject({ state: "paused" });
    expect(enable).not.toHaveBeenCalled();
  });
  it.each(["unavailable", "unlinked", "error"] as const)("keeps a pending pause authoritative when catalog verification returns %s", async outcome => {
    ensureProjectIdentity(root); queueAutomaticConnection(root);
    const enable = vi.fn(async () => saved), inspect = vi.fn(async () => {
      pauseAutomaticConnection(root);
      if (outcome === "error") throw new Error("Temporarily offline.");
      return recognized(outcome);
    });
    expect(await retryAutomaticConnection(root, { inspect, enable })).toMatchObject({ state: "paused" });
    expect(await retryAutomaticConnection(root, { ready: true, force: true, inspect, enable })).toMatchObject({ state: "paused" });
    expect(inspect).toHaveBeenCalledOnce(); expect(enable).not.toHaveBeenCalled(); expect(pendingAutomaticConnection(root)).toBe(false);
  });
  it("uses one captured account client through verification and connection mutation", async () => {
    const account = { server: saved.server, accountId: randomUUID() }, client = { server: saved.server } as AccountClient;
    ensureProjectIdentity(root); queueAutomaticConnection(root, account);
    const assertCurrent = vi.fn(async () => {}), inspect = vi.fn(async () => recognized("existing")), enable = vi.fn(async () => saved);
    expect(await retryAutomaticConnection(root, { account, captureAccount: async () => ({ client, vaultId: saved.vaultId, assertCurrent }), inspect, enable })).toMatchObject({ state: "enabled" });
    expect(inspect).toHaveBeenCalledWith(root, true, client); expect(enable).toHaveBeenCalledWith(root, true, { client }); expect(assertCurrent).toHaveBeenCalledTimes(2);
  });
  it("requires review when account selection changes during catalog verification", async () => {
    const account = { server: saved.server, accountId: randomUUID() }, client = { server: saved.server } as AccountClient;
    ensureProjectIdentity(root); queueAutomaticConnection(root, account);
    let changed = false; const assertCurrent = async () => { if (changed) throw new AutomaticAccountChangedError(); }, enable = vi.fn(async () => saved);
    expect(await retryAutomaticConnection(root, { account, captureAccount: async () => ({ client, vaultId: saved.vaultId, assertCurrent }), inspect: async () => { changed = true; return recognized("existing"); }, enable })).toMatchObject({ state: "review-required" });
    expect(enable).not.toHaveBeenCalled(); expect(binding(root)).toBeUndefined();
  });
  it("rejects a connection outcome from a different captured account vault", async () => {
    const account = { server: saved.server, accountId: randomUUID() }, client = { server: saved.server } as AccountClient;
    ensureProjectIdentity(root); queueAutomaticConnection(root, account);
    expect(await retryAutomaticConnection(root, { account, captureAccount: async () => ({ client, vaultId: randomUUID(), assertCurrent: async () => {} }), inspect: async () => recognized("existing"), enable: async () => saved })).toMatchObject({ state: "review-required" });
  });
  it("preserves a pending pause made during the final awaited account check", async () => {
    const account = { server: saved.server, accountId: randomUUID() }, client = { server: saved.server } as AccountClient;
    ensureProjectIdentity(root); queueAutomaticConnection(root, account);
    let checks = 0; const assertCurrent = async () => { if (++checks === 2) pauseAutomaticConnection(root); }, enable = vi.fn(async () => saved);
    expect(await retryAutomaticConnection(root, { account, captureAccount: async () => ({ client, vaultId: saved.vaultId, assertCurrent }), inspect: async () => recognized("existing"), enable })).toMatchObject({ state: "paused" });
    expect(enable).not.toHaveBeenCalled(); expect(binding(root)).toBeUndefined();
  });
  it("applies a pending pause made during remote enablement before releasing the sync gate", async () => {
    ensureProjectIdentity(root); queueAutomaticConnection(root);
    const result = await retryAutomaticConnection(root, { inspect: async () => recognized("existing"), enable: async () => {
      saveBinding(root, saved); pauseAutomaticConnection(root); return saved;
    } });
    expect(result).toMatchObject({ state: "paused" }); expect(binding(root)?.enabled).toBe(false);
    expect(await retryAutomaticConnection(root, { ready: true, force: true })).toMatchObject({ state: "paused" });
  });
});
