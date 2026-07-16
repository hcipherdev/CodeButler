import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { auditPrivacy, exportPrivacy, importPrivacy, scrubPrivacy } from "../src/privacy/service.js";
import { openMemoryStore } from "../src/storage/store.js";

describe("Release 5 privacy acceptance", () => {
  it("keeps fresh secrets out and removes migrated legacy plaintext through scrub and portable re-import", () => {
    const freshRoot = mkdtempSync(join(tmpdir(), "code-butler-privacy-acceptance-fresh-"));
    const legacyRoot = mkdtempSync(join(tmpdir(), "code-butler-privacy-acceptance-legacy-"));
    const importRoot = mkdtempSync(join(tmpdir(), "code-butler-privacy-acceptance-import-"));
    const freshSecret = "ghp_freshabcdefghijklmnopqrstuvwxyz123456";
    const legacySecret = "ghp_legacyabcdefghijklmnopqrstuvwxyz12345";

    const fresh = openMemoryStore(freshRoot);
    fresh.init();
    fresh.addSourceWithChunks({
      source: {
        id: "fresh",
        type: "conversation",
        title: freshSecret,
        origin: "codex",
        rawContent: freshSecret,
        metadata: { nested: freshSecret }
      },
      chunks: [{ text: freshSecret, metadata: { nested: freshSecret } }]
    });
    expect(scanDatabase(fresh)).not.toContain(freshSecret);
    fresh.close();

    const legacy = openMemoryStore(legacyRoot);
    legacy.init();
    legacy.addSourceWithChunks({
      source: { id: "legacy", type: "conversation", title: "legacy", origin: "codex", rawContent: "safe" },
      chunks: [{ text: "safe" }]
    });
    legacy.db.prepare("update sources set raw_content = ? where id = ?").run(legacySecret, "legacy");
    legacy.db.prepare("update chunks set text = ? where source_id = ?").run(legacySecret, "legacy");
    legacy.db.prepare("update chunks_fts set text = ? where source_id = ?").run(legacySecret, "legacy");
    expect(auditPrivacy(legacy).matches).toBeGreaterThan(0);
    const beforePath = join(legacyRoot, "before.json");
    exportPrivacy(legacy, { outputPath: beforePath });
    expect(readFileSync(beforePath, "utf8")).not.toContain(legacySecret);

    scrubPrivacy(legacy);
    expect(scanDatabase(legacy)).not.toContain(legacySecret);
    expect(legacy.db.prepare("pragma quick_check").get()).toEqual({ quick_check: "ok" });
    expect(legacy.db.prepare("pragma foreign_key_check").all()).toEqual([]);
    const exportPath = join(legacyRoot, "after.json");
    exportPrivacy(legacy, { outputPath: exportPath });
    legacy.close();

    const imported = openMemoryStore(importRoot);
    imported.init();
    importPrivacy(imported, { inputPath: exportPath });
    expect(scanDatabase(imported)).not.toContain(legacySecret);
    expect(imported.readSource("legacy")).toBeTruthy();
    expect(imported.db.prepare("pragma quick_check").get()).toEqual({ quick_check: "ok" });
    imported.close();
  });
});

function scanDatabase(store: ReturnType<typeof openMemoryStore>): string {
  const tables = store.db.prepare(
    `select name from sqlite_schema
     where type = 'table' and name not like 'sqlite_%'`
  ).all() as Array<{ name: string }>;
  return JSON.stringify(tables.map(({ name }) => ({
    name,
    rows: store.db.prepare(`select * from "${name.replaceAll("\"", "\"\"")}"`).all()
  })));
}
