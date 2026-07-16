import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createRecoveryBackup, purgeDatabaseBackups } from "../src/privacy/backup.js";
import { deletePrivacySource, exportPrivacy, importPrivacy, scrubPrivacy } from "../src/privacy/service.js";
import { openMemoryStore } from "../src/storage/store.js";

describe("privacy recovery backups", () => {
  it("creates a verified node:sqlite backup and purges migration and recovery copies explicitly", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "code-butler-recovery-"));
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: { id: "source", type: "conversation", title: "title", origin: "test", rawContent: "body" },
      chunks: [{ text: "body" }]
    });

    const backupPath = createRecoveryBackup(store.paths.databasePath);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    expect(backup.prepare("pragma quick_check").get()).toEqual({ quick_check: "ok" });
    expect(backup.prepare("select count(*) as count from sources").get()).toEqual({ count: 1 });
    backup.close();

    const result = purgeDatabaseBackups(store.paths.databasePath);
    expect(result.removed).toContain(backupPath);
    expect(result.failed).toEqual([]);
    expect(existsSync(backupPath)).toBe(false);
    store.close();
  });

  it("restores the verified backup after a post-commit verification failure", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "code-butler-post-commit-recovery-"));
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: { id: "legacy", type: "conversation", title: "legacy", origin: "test", rawContent: "safe" },
      chunks: [{ text: "safe" }]
    });
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    store.db.prepare("update sources set raw_content = ? where id = ?").run(secret, "legacy");

    let thrown: unknown;
    try {
      scrubPrivacy(store, {
        afterCommitVerification: () => { throw new Error("injected post-commit failure"); }
      });
    } catch (error) {
      thrown = error;
    }

    const backupPath = (thrown as Error & { backupPath: string }).backupPath;
    expect(existsSync(backupPath)).toBe(true);
    expect(store.readSource("legacy")?.rawContent).toBe(secret);
    expect(store.db.prepare("pragma quick_check").get()).toEqual({ quick_check: "ok" });
    expect(store.listOperations({ operationType: "redaction" }).at(0)?.status).toBe("failed");
    store.close();
  });

  it("restores a deleted source after a post-commit deletion failure", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "code-butler-delete-recovery-"));
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: { id: "delete-me", type: "conversation", title: "delete", origin: "codex", rawContent: "body" },
      chunks: [{ text: "body" }]
    });

    expect(() => deletePrivacySource(store, {
      sourceId: "delete-me",
      confirmSourceId: "delete-me",
      afterCommitVerification: () => { throw new Error("post-commit delete failure"); }
    })).toThrow("Recovery backup retained at");

    expect(store.readSource("delete-me")).toBeTruthy();
    expect(store.listOperations({ operationType: "deletion" }).at(0)?.status).toBe("failed");
    store.close();
  });

  it("restores a nonempty target after a post-commit import failure", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "code-butler-import-source-"));
    const targetRoot = mkdtempSync(join(tmpdir(), "code-butler-import-target-"));
    const source = openMemoryStore(sourceRoot);
    source.init();
    source.addSourceWithChunks({
      source: { id: "imported", type: "conversation", title: "imported", origin: "test", rawContent: "body" },
      chunks: [{ text: "body" }]
    });
    const path = join(sourceRoot, "export.json");
    exportPrivacy(source, { outputPath: path });
    source.close();
    const target = openMemoryStore(targetRoot);
    target.init();
    target.addSourceWithChunks({
      source: { id: "existing", type: "conversation", title: "existing", origin: "test", rawContent: "body" },
      chunks: [{ text: "body" }]
    });

    expect(() => importPrivacy(target, {
      inputPath: path,
      confirmNonempty: true,
      afterCommitVerification: () => { throw new Error("post-commit import failure"); }
    })).toThrow("Recovery backup retained at");

    expect(target.readSource("existing")).toBeTruthy();
    expect(target.readSource("imported")).toBeUndefined();
    expect(target.listOperations({ operationType: "import" }).at(0)?.status).toBe("failed");
    target.close();
  });

  it("retains and restores from the recovery backup when completion logging fails", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "code-butler-completion-recovery-"));
    const store = openMemoryStore(rootDir);
    store.init();
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    store.addSourceWithChunks({
      source: { id: "legacy", type: "conversation", title: "legacy", origin: "test", rawContent: "safe" },
      chunks: [{ text: "safe" }]
    });
    store.db.prepare("update sources set raw_content = ? where id = ?").run(secret, "legacy");
    store.completeOperation = () => {
      throw new Error("injected completion failure");
    };

    let thrown: unknown;
    try {
      scrubPrivacy(store);
    } catch (error) {
      thrown = error;
    }

    const backupPath = (thrown as Error & { backupPath: string }).backupPath;
    expect(existsSync(backupPath)).toBe(true);
    expect(store.readSource("legacy")?.rawContent).toBe(secret);
    expect(store.listOperations({ operationType: "redaction" }).at(0)?.status).toBe("failed");
    store.close();
  });
});
