// Tests secretsSyncInterruption() and how encryptedSecretsSync() in src/secrets/sync.ts records busy, offline and real failures.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EncryptionError } from "../../src/cloud/crypto-helper.js";
import { OperationDeferredError } from "../../src/cloud/outcome.js";
import { SecretFolderError } from "../../src/secrets/folder-error.js";
import { saveSecretBinding, secretBinding, type SecretBinding } from "../../src/secrets/state.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

// The gate stands in for the whole sync run, so each test decides how that run ends.
const gate = vi.hoisted(() => ({ run: async (_root: string): Promise<never> => { throw new Error("unset"); } }));
vi.mock("../../src/cloud/gate.js", async original => ({
  ...await original<typeof import("../../src/cloud/gate.js")>(),
  withProjectGate: (root: string) => gate.run(root)
}));
const { encryptedSecretsSync, secretsSyncInterruption } = await import("../../src/secrets/sync.js");

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanupTempDir(root); });

function project(overrides: Partial<SecretBinding> = {}): string {
  const root = makeTempDir("butler-secrets-interruption-"); roots.push(root);
  saveSecretBinding(root, { version: 1, server: "https://synthetic.invalid", vaultId: randomUUID(), checkoutId: randomUUID(), enabled: true,
    status: "synced", revision: 4, lastSync: "2026-10-26T08:18:58.468Z", ...overrides });
  return root;
}
/** A run that got as far as marking the binding busy, then stopped with `error`. */
const failMidRun = (error: unknown) => async (root: string): Promise<never> => {
  const state = secretBinding(root)!; state.status = "syncing"; state.phase = "Checking encrypted vault"; delete state.error; saveSecretBinding(root, state);
  throw error;
};

describe("secrets sync interruptions", () => {
  it("separates retryable interruptions from failures", () => {
    expect(secretsSyncInterruption(new OperationDeferredError("Cloud operation deferred: another local Butler operation is active"))).toBe("busy");
    expect(secretsSyncInterruption(new EncryptionError("lease-expired"))).toBe("busy");
    expect(secretsSyncInterruption(new TypeError("fetch failed"))).toBe("offline");
    expect(secretsSyncInterruption(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }))).toBe("offline");
    expect(secretsSyncInterruption(new EncryptionError("locked"))).toBeUndefined();
    expect(secretsSyncInterruption(new SecretFolderError("secrets/x is a link."))).toBeUndefined();
    expect(secretsSyncInterruption(Object.assign(new Error("Unauthorized"), { status: 401 }))).toBeUndefined();
  });

  it("leaves the binding as it was when another operation holds the project", async () => {
    const root = project();
    gate.run = async () => { throw new OperationDeferredError("Cloud operation deferred: another local Butler operation is active"); };
    await expect(encryptedSecretsSync(root)).rejects.toBeInstanceOf(OperationDeferredError);
    expect(secretBinding(root)).toMatchObject({ status: "synced", lastSync: "2026-10-26T08:18:58.468Z" });
    expect(secretBinding(root)).not.toHaveProperty("error");
  });

  it("puts the earlier state back when the cloud cannot be reached mid-run", async () => {
    const root = project({ status: "error", error: "authentication" });
    gate.run = failMidRun(new TypeError("fetch failed"));
    await expect(encryptedSecretsSync(root)).rejects.toThrow("fetch failed");
    expect(secretBinding(root)).toMatchObject({ status: "error", error: "authentication" });
    expect(secretBinding(root)).not.toHaveProperty("phase");
  });

  it("records a named condition for real failures and keeps the generic code for unknown ones", async () => {
    const rejected = project();
    gate.run = failMidRun(Object.assign(new Error("Unauthorized"), { status: 401 }));
    await expect(encryptedSecretsSync(rejected)).rejects.toThrow("Unauthorized");
    expect(secretBinding(rejected)).toMatchObject({ status: "error", error: "authentication" });

    const unknown = project();
    gate.run = failMidRun(new Error("EACCES: permission denied, open '/somewhere/secrets/key.pem'"));
    await expect(encryptedSecretsSync(unknown)).rejects.toThrow("EACCES");
    // An unclassified message may carry a secret path, so only the generic code is kept.
    expect(secretBinding(unknown)).toMatchObject({ status: "error", error: "sync-failed" });
  });
});
