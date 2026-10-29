// Tests encrypted native account profile key/journal retention and cache cleanup after switching accounts.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NativeSecurity } from "../../src/cloud/native-security.js";
import { pruneEncryptedCaches } from "../../src/cloud/encrypted-coordinator.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const executable = process.env.CODE_BUTLER_TEST_NATIVE_EXECUTABLE ?? resolve("native/butler-crypto/target/debug", process.platform === "win32" ? "butler-crypto.exe" : "butler-crypto");
const roots: string[] = [], temp = () => { const root = makeTempDir(); roots.push(root); return root; };
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) cleanupTempDir(root); });
it.skipIf(!existsSync(executable) || !["win32", "darwin"].includes(process.platform))("keeps inactive account caches until their encrypted journals release them", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const directory = temp(), cache = temp(), security = new NativeSecurity(directory, executable), account = randomUUID(), other = randomUUID(), deviceId = randomUUID(), hash = "a".repeat(64), orphan = "b".repeat(64), checkoutId = randomUUID();
  await security.invoke("device-create", { accountId: account, deviceId, installationId: randomUUID(), label: "Account profile test" });
  const tokens = (accountId: string) => ({ accountId, accessToken: "ephemeral-test-token", refreshToken: "ephemeral-test-refresh", accessExpiresAt: Date.now() + 60_000 });
  await security.invoke("tokens-save", { tokens: tokens(account) });
  const journal = { fingerprint: "", applied: { hash } };
  await security.invoke("sync-save", { checkoutId, projectId: randomUUID(), pin: { revision: 0, commitment: "" }, value: journal });
  await security.invoke("tokens-save", { tokens: tokens(other) });
  expect((await security.status()).device).toBeNull(); expect(await security.invoke("sync-read", { checkoutId })).toBeNull();
  for (const name of [hash, orphan]) { const path = join(cache, `${name}.encrypted.gz`); writeFileSync(path, name); const old = new Date(Date.now() - 2 * 60 * 60_000); utimesSync(path, old, old); }
  expect(await pruneEncryptedCaches(cache, security)).toBe(1); expect(readdirSync(cache)).toEqual([`${hash}.encrypted.gz`]);
  await security.invoke("tokens-save", { tokens: tokens(account) });
  expect((await security.status()).device!.id).toBe(deviceId); expect(await security.invoke("sync-read", { checkoutId })).toEqual(journal);
  expect(await security.invoke("tokens-read")).toMatchObject({ accountId: account });
});
it.skipIf(!existsSync(executable) || !["win32", "darwin"].includes(process.platform))("restores the stored account profile when logout separates two account sign-ins", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const security = new NativeSecurity(temp(), executable), account = randomUUID(), other = randomUUID(), deviceId = randomUUID();
  const tokens = (accountId: string) => ({ accountId, accessToken: "ephemeral-test-token", refreshToken: "ephemeral-test-refresh", accessExpiresAt: Date.now() + 60_000 });
  await security.invoke("device-create", { accountId: account, deviceId, installationId: randomUUID(), label: "Logout profile test" });
  await security.invoke("tokens-save", { tokens: tokens(account) });
  await security.invoke("tokens-save", { tokens: tokens(other) });
  await security.invoke("logout");
  await security.invoke("tokens-save", { tokens: tokens(account) });
  expect((await security.status()).device!.id).toBe(deviceId);
  await security.invoke("logout");
  await security.invoke("tokens-save", { tokens: tokens(other) });
  expect((await security.status()).device).toBeNull();
  await security.invoke("logout");
  await security.invoke("tokens-save", { tokens: tokens(account) });
  expect((await security.status()).device!.id).toBe(deviceId);
});
