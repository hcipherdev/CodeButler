// Tests platformKey(), compareVersions(), verifyMinisign(), checkForUpdate() and downloadUpdate() in src/desktop/updater.ts.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkForUpdate, compareVersions, downloadUpdate, platformKey, verifyMinisign } from "../../src/desktop/updater.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

// Produced by `tauri signer generate` and `tauri signer sign` for the bytes below, so the verifier
// is checked against the real tool's output rather than only against itself.
const TAURI_PUBLIC_KEY = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDUxMzVGODIzNkI2MEM5REMKUldUY3lXQnJJL2cxVVU0djIwK3U4V0JQWEdUMXNCT2EzN250bjVYeC9vT1dLRGxsODYwNlVENWsK";
const TAURI_SIGNATURE = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUY3lXQnJJL2cxVWNZd0tJNHNsV2t2NENiZ0FUY0t2ei9adkw1MmszRWRaYTUxNW9mODBRUUZRbDg3cXZSUUYxVnQ0SjZPYWFrUFVXTmF3SlR1UEh1STk1WFo0clRNUndnPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNTI0MzU5CWZpbGU6cGF5bG9hZC5iaW4KYmhGS1UwSkFNeUxzYkF0eTJScUpaMlBSeXBzSnlaeUhNVFBST0xjL1k0enNBRHM5QXVBWms5djF2NHJEQkhlQWVDSGR4b0lrUytiTFMxZmQrMGVvQnc9PQo=";
const TAURI_PAYLOAD = Buffer.from("hello installer bytes\n");

/** A minisign key pair in the same base64 layout `tauri signer` uses. */
function testSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const keyId = Buffer.from("0123456789abcdef", "hex");
  const pub = Buffer.from(`untrusted comment: minisign public key\n${Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64")}\n`).toString("base64");
  const signFile = (data: Buffer) => {
    const signature = sign(null, createHash("blake2b512").update(data).digest(), privateKey);
    const trusted = "timestamp:1\tfile:installer";
    const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), privateKey);
    return Buffer.from(`untrusted comment: test\n${Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64")}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`).toString("base64");
  };
  return { pub, signFile };
}

const installerName = platformKey().startsWith("windows") ? "Code-Butler_2.1.0_x64-setup.exe" : "Code-Butler-macOS-2.1.0-signed.pkg";
const installerUrl = `https://github.com/hcipherdev/CodeButler/releases/download/v2.1.0/${installerName}`;
function server(manifest: unknown, installer: Buffer, options: { manifestStatus?: number; finalUrl?: string } = {}) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("latest.json")) return new Response(JSON.stringify(manifest), { status: options.manifestStatus ?? 200 });
    const response = new Response(new Uint8Array(installer), { status: 200 });
    Object.defineProperty(response, "url", { value: options.finalUrl ?? "https://objects.githubusercontent.com/github-production-release-asset/123" });
    return response;
  }) as unknown as typeof fetch;
}

let home: string;
beforeEach(() => { home = makeTempDir(); vi.stubEnv("CODE_BUTLER_HOME", home); });
afterEach(() => { vi.unstubAllEnvs(); cleanupTempDir(home); });

describe("update helpers", () => {
  it("names this computer the way release manifests do", () => {
    expect(platformKey("darwin", "arm64")).toBe("darwin-aarch64");
    expect(platformKey("darwin", "x64")).toBe("darwin-x86_64");
    expect(platformKey("win32", "x64")).toBe("windows-x86_64");
  });

  it("orders versions numerically, with pre-releases before their release", () => {
    expect(compareVersions("2.0.10", "2.0.9")).toBe(1);
    expect(compareVersions("v2.1.0", "2.1.0")).toBe(0);
    expect(compareVersions("2.1.0-beta.1", "2.1.0")).toBe(-1);
    expect(compareVersions("2.0.0", "2.1.0-beta.1")).toBe(-1);
  });

  it("accepts a real tauri signature and rejects tampered data, other keys and garbage", () => {
    expect(verifyMinisign(TAURI_PUBLIC_KEY, TAURI_SIGNATURE, TAURI_PAYLOAD)).toBe(true);
    expect(verifyMinisign(TAURI_PUBLIC_KEY, TAURI_SIGNATURE, Buffer.from("hello installer bytes!\n"))).toBe(false);
    expect(verifyMinisign(testSigner().pub, TAURI_SIGNATURE, TAURI_PAYLOAD)).toBe(false);
    expect(verifyMinisign(TAURI_PUBLIC_KEY, "not a signature", TAURI_PAYLOAD)).toBe(false);
  });
});

describe("checking and downloading updates", () => {
  it("reports a newer release only when it has an installer for this computer", async () => {
    const manifest = { version: "2.1.0", notes: "Faster startup.", pub_date: "2026-11-01T00:00:00Z", platforms: { [platformKey()]: { url: installerUrl, signature: "x" } } };
    await expect(checkForUpdate(server(manifest, Buffer.alloc(0)), "2.0.0")).resolves.toEqual({ current: "2.0.0", available: true, version: "2.1.0", notes: "Faster startup.", publishedAt: "2026-11-01T00:00:00Z" });
    await expect(checkForUpdate(server(manifest, Buffer.alloc(0)), "2.1.0")).resolves.toMatchObject({ available: false });
    await expect(checkForUpdate(server({ ...manifest, platforms: { "plan9-mips": { url: installerUrl, signature: "x" } } }, Buffer.alloc(0)), "2.0.0"))
      .resolves.toMatchObject({ available: false, unsupported: true });
    await expect(checkForUpdate(server(manifest, Buffer.alloc(0), { manifestStatus: 404 }), "2.0.0")).rejects.toThrow("No release has been published yet.");
  });

  it("saves a verified installer and records it for the desktop shell", async () => {
    const signer = testSigner();
    const installer = Buffer.from("installer bytes");
    const manifest = { version: "2.1.0", platforms: { [platformKey()]: { url: installerUrl, signature: signer.signFile(installer) } } };
    mkdirSync(join(home, "updates"), { recursive: true });
    const result = await downloadUpdate("2.1.0", server(manifest, installer), "2.0.0", signer.pub);
    expect(result.file).toBe(join(home, "updates", installerName));
    expect(readFileSync(result.file)).toEqual(installer);
    expect(JSON.parse(readFileSync(join(home, "updates", "pending.json"), "utf8"))).toEqual({ version: "2.1.0", file: result.file, sha256: createHash("sha256").update(installer).digest("hex") });
  });

  it("refuses a bad signature, an unexpected host or redirect, and a stale version, saving nothing", async () => {
    const signer = testSigner();
    const installer = Buffer.from("installer bytes");
    const good = { version: "2.1.0", platforms: { [platformKey()]: { url: installerUrl, signature: signer.signFile(installer) } } };
    await expect(downloadUpdate("2.1.0", server(good, Buffer.from("tampered bytes")), "2.0.0", signer.pub)).rejects.toThrow("signature did not match");
    await expect(downloadUpdate("2.1.0", server({ ...good, platforms: { [platformKey()]: { url: `https://example.com/${installerName}`, signature: "x" } } }, installer), "2.0.0", signer.pub))
      .rejects.toThrow("expected release site");
    await expect(downloadUpdate("2.1.0", server(good, installer, { finalUrl: "https://example.com/evil" }), "2.0.0", signer.pub)).rejects.toThrow("unexpected site");
    await expect(downloadUpdate("2.0.5", server(good, installer), "2.0.0", signer.pub)).rejects.toThrow("newer release appeared");
    await expect(downloadUpdate("2.1.0", server(good, installer), "2.1.0", signer.pub)).rejects.toThrow("already installed");
    expect(existsSync(join(home, "updates")) ? readdirSync(join(home, "updates")) : []).toEqual([]);
  });
});
