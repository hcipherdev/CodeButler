import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { pruneEncryptedCaches } from "../src/cloud/encrypted-coordinator.js";
import type { AccountClient } from "../src/cloud/account-client.js";
import { NativeSecurity } from "../src/cloud/native-security.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanupTempDir(root); });

it("prunes old unreferenced encrypted caches and keeps journal references and in-flight writes", async () => {
  const root = makeTempDir(); roots.push(root); mkdirSync(root, { recursive: true });
  const retained = "a".repeat(64), orphan = "b".repeat(64), recent = "c".repeat(64);
  for (const hash of [retained, orphan, recent]) writeFileSync(join(root, `${hash}.encrypted.gz`), hash);
  const old = new Date(Date.now() - 2 * 60 * 60_000);
  for (const hash of [retained, orphan]) utimesSync(join(root, `${hash}.encrypted.gz`), old, old);
  writeFileSync(join(root, "unrelated.txt"), "keep");
  const security = { invoke: async () => [retained] } as unknown as AccountClient["security"];
  expect(await pruneEncryptedCaches(root, security)).toBe(1);
  expect(readdirSync(root).sort()).toEqual([`${recent}.encrypted.gz`, `${retained}.encrypted.gz`, "unrelated.txt"].sort());
});

it("leaves caches intact when journal enumeration is incomplete", async () => {
  const root = makeTempDir(); roots.push(root);
  const hash = "d".repeat(64), path = join(root, `${hash}.encrypted.gz`);
  writeFileSync(path, "old");
  const old = new Date(Date.now() - 2 * 60 * 60_000); utimesSync(path, old, old);
  const security = { invoke: async () => ["invalid"] } as unknown as AccountClient["security"];
  expect(await pruneEncryptedCaches(root, security)).toBe(0);
  expect(readdirSync(root)).toEqual([`${hash}.encrypted.gz`]);
});

const executable = resolve("native/butler-crypto/target/debug", process.platform === "win32" ? "butler-crypto.exe" : "butler-crypto");

it.skipIf(!existsSync(executable) || !["win32", "darwin"].includes(process.platform))("enumerates applied, remote, and pending references from the native journal", async () => {
  const root = makeTempDir(); roots.push(root);
  const security = new NativeSecurity(root, executable);
  await security.invoke("device-create", { deviceId: randomUUID(), installationId: randomUUID(), label: "cache-test" });
  const hashes = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
  await security.invoke("sync-save", { checkoutId: "checkout", projectId: "project", pin: { revision: 0, commitment: "" },
    value: { fingerprint: "", applied: { hash: hashes[0] }, remote: { hash: hashes[1] }, pending: { hash: hashes[2] } } });
  expect(await security.invoke<string[]>("sync-list-cache-refs")).toEqual(hashes);
});
