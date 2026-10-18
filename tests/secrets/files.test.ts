// Verifies binary secrets folder safety, three-way merge behavior, and atomic local application.
import { randomUUID } from "node:crypto";
import { linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applySecretFiles, captureSecretFolder, materializeSecretFiles, mergeSecretFiles, validateSecretManifest, validateSecretPath } from "../../src/secrets/files.js";
import { encryptedSecretsSync, secretsSyncStatus, setSecretsSyncEnabled } from "../../src/secrets/sync.js";
import { saveSecretBinding, secretBinding } from "../../src/secrets/state.js";
import { SecretFolderError } from "../../src/secrets/folder-error.js";

const roots: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), "butler-secrets-test-")); roots.push(path); return path; };
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const id = randomUUID(), device = randomUUID();
const capture = (root: string) => captureSecretFolder(root, id, 0, device);
function put(root: string, path: string, bytes: Buffer): void {
  const parts = path.split("/"), file = parts.pop()!;
  const folder = join(root, "secrets", ...parts); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, file), bytes);
}

describe("encrypted secrets file model", () => {
  it("is disabled by default and does not create or upload a folder", async () => {
    const root = temp();
    expect(await secretsSyncStatus(root)).toMatchObject({ enabled: false, status: "disabled" });
    expect(await encryptedSecretsSync(root)).toMatchObject({ enabled: false, status: "disabled" });
  });
  it("pauses locally while keeping plaintext files and the cloud binding", async () => {
    const home = temp(), root = temp(); vi.stubEnv("CODE_BUTLER_HOME", home);
    put(root, ".env", Buffer.from("local value"));
    saveSecretBinding(root, { version: 1, server: "https://example.test", vaultId: id, checkoutId: randomUUID(), enabled: true, status: "ready", revision: 3 });
    expect(await setSecretsSyncEnabled(root, false)).toMatchObject({ enabled: false, status: "disabled", revision: 3 });
    expect(secretBinding(root)?.vaultId).toBe(id);
    expect(readFileSync(join(root, "secrets", ".env"), "utf8")).toBe("local value");
  });
  it("round trips recursive binary files and treats an absent new device folder as download", () => {
    const source = temp(), target = temp(), bytes = Buffer.from([0, 255, 1, 127, 0]);
    put(source, "private/nested/.env", bytes);
    const remote = capture(source), local = capture(target);
    const merged = mergeSecretFiles(undefined, local, remote);
    expect(merged.conflicts).toEqual([]);
    applySecretFiles(target, local, merged.files);
    expect(readFileSync(join(target, "secrets", "private", "nested", ".env"))).toEqual(bytes);
    expect(materializeSecretFiles(capture(target)).get("private/nested/.env")).toEqual(bytes);
  });

  it("propagates ordinary edits and deletions while holding simultaneous edits and edit versus delete", () => {
    const baseRoot = temp(), localRoot = temp(), remoteRoot = temp();
    put(baseRoot, "a.env", Buffer.from("base")); put(baseRoot, "delete.env", Buffer.from("old"));
    const base = capture(baseRoot);
    put(localRoot, "a.env", Buffer.from("local")); put(localRoot, "delete.env", Buffer.from("old"));
    put(remoteRoot, "a.env", Buffer.from("remote"));
    const merged = mergeSecretFiles(base, capture(localRoot), capture(remoteRoot));
    expect(merged.conflicts).toEqual(["a.env"]);
    expect(merged.files.has("delete.env")).toBe(false);
    expect(mergeSecretFiles(base, capture(localRoot), capture(remoteRoot), { "a.env": "local" }).files.get("a.env")?.toString()).toBe("local");
    put(localRoot, "delete.env", Buffer.from("changed"));
    const editDelete = mergeSecretFiles(base, capture(localRoot), capture(remoteRoot));
    expect(editDelete.conflicts).toContain("delete.env");
  });

  it("converges after an interrupted multi-file apply", () => {
    const baseRoot = temp(), remoteRoot = temp(), partialRoot = temp();
    for (const root of [baseRoot, partialRoot]) { put(root, "a.env", Buffer.from("old A")); put(root, "b.env", Buffer.from("old B")); }
    put(remoteRoot, "a.env", Buffer.from("new A")); put(remoteRoot, "b.env", Buffer.from("new B"));
    const base = capture(baseRoot), remote = capture(remoteRoot);
    writeFileSync(join(partialRoot, "secrets", "a.env"), "new A");
    const partial = capture(partialRoot), merged = mergeSecretFiles(base, partial, remote);
    expect(merged.conflicts).toEqual([]);
    applySecretFiles(partialRoot, partial, merged.files);
    expect(readFileSync(join(partialRoot, "secrets", "a.env"), "utf8")).toBe("new A");
    expect(readFileSync(join(partialRoot, "secrets", "b.env"), "utf8")).toBe("new B");
  });

  it("rejects unsafe names, case collisions, links, and changed preimages before writing", () => {
    for (const path of ["../outside", "C:/drive", "CON", "a/../b", "a\\b", "trailing. ", "a//b", "x".repeat(256)]) {
      expect(() => validateSecretPath(path)).toThrow();
    }
    const root = temp(); put(root, "Alpha.env", Buffer.from("one"));
    const caseManifest = capture(root).manifest;
    expect(() => validateSecretManifest({ ...caseManifest, files: [caseManifest.files[0], { ...caseManifest.files[0], path: "alpha.env" }] })).toThrow();
    expect(() => validateSecretManifest({ ...caseManifest, files: [
      { ...caseManifest.files[0], path: "Folder/a.env" }, { ...caseManifest.files[0], path: "folder/b.env" }
    ] })).toThrow();
    const safe = temp(), outside = temp();
    mkdirSync(join(safe, "secrets")); writeFileSync(join(outside, "value"), "outside");
    try { symlinkSync(join(outside, "value"), join(safe, "secrets", "link")); expect(() => capture(safe)).toThrow(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; }
    const hard = temp(); put(hard, "linked", Buffer.from("file"));
    linkSync(join(hard, "secrets", "linked"), join(outside, "hardlink"));
    expect(() => capture(hard)).toThrow();
    const beforeRoot = temp(); put(beforeRoot, "a.env", Buffer.from("before"));
    const before = capture(beforeRoot); writeFileSync(join(beforeRoot, "secrets", "a.env"), "changed");
    expect(() => applySecretFiles(beforeRoot, before, new Map([["a.env", Buffer.from("desired")]]))).toThrow();
    expect(readFileSync(join(beforeRoot, "secrets", "a.env"), "utf8")).toBe("changed");
  });

  it("rejects over-quota manifests before materialization", () => {
    const root = temp(); put(root, "one", Buffer.from("one"));
    const original = capture(root).manifest;
    expect(() => validateSecretManifest({ ...original, files: [{ ...original.files[0], size: 32 * 1024 * 1024 + 1 }] })).toThrow();
    const large = temp(); put(large, "too-large", Buffer.alloc(0));
    truncateSync(join(large, "secrets", "too-large"), 32 * 1024 * 1024 + 1);
    expect(() => capture(large)).toThrow();
  });

  it("explains a local folder problem in words instead of a verification failure", () => {
    const crowded = temp();
    for (let i = 0; i <= 1000; i++) put(crowded, `run/data/${String(i).padStart(4, "0")}.log`, Buffer.from("x"));
    expect(() => capture(crowded)).toThrow(SecretFolderError);
    expect(() => capture(crowded)).toThrow("secrets/ holds more than 1,000 files");
    const large = temp(); put(large, "tool.zip", Buffer.alloc(0));
    truncateSync(join(large, "secrets", "tool.zip"), 32 * 1024 * 1024 + 1);
    expect(() => capture(large)).toThrow("secrets/tool.zip is 32.0 MB; one file can be at most 32 MB");
    const hard = temp(), outside = temp(); put(hard, "linked", Buffer.from("file"));
    linkSync(join(hard, "secrets", "linked"), join(outside, "hardlink"));
    expect(() => capture(hard)).toThrow("secrets/linked is not a regular file");
  });
});
