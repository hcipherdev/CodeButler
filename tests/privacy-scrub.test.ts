import { existsSync, readdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { scrubPrivacy } from "../src/privacy/service.js";
import { openMemoryStore } from "../src/storage/store.js";

describe("privacy scrub", () => {
  it("redacts legacy content, rebuilds FTS, and removes its verified recovery backup", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "code-butler-privacy-scrub-"));
    const store = openMemoryStore(rootDir);
    store.init();
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    store.addSourceWithChunks({
      source: {
        id: "legacy-source",
        type: "conversation",
        title: "legacy",
        origin: "codex",
        rawContent: "safe"
      },
      chunks: [{ text: "safe" }]
    });
    store.db.prepare("update sources set raw_content = ?, metadata_json = ? where id = ?")
      .run(`raw ${secret}`, JSON.stringify({ nested: secret }), "legacy-source");
    store.db.prepare("update chunks set text = ?, metadata_json = ? where source_id = ?")
      .run(`chunk ${secret}`, JSON.stringify({ nested: secret }), "legacy-source");
    store.db.prepare("update chunks_fts set text = ? where source_id = ?").run(secret, "legacy-source");
    const secretSourceId = `legacy-${secret}`;
    const secretChunkId = `${secretSourceId}:chunk:0`;
    store.db.prepare(
      `insert into sources (id, type, title, origin, raw_content, metadata_json, created_at)
       values (?, 'conversation', 'secret id', 'codex', 'safe', '{}', ?)`
    ).run(secretSourceId, new Date().toISOString());
    store.db.prepare(
      `insert into chunks (id, source_id, chunk_index, text, metadata_json)
       values (?, ?, 0, 'identifier evidence', '{}')`
    ).run(secretChunkId, secretSourceId);
    store.db.prepare(
      `insert into chunks_fts (chunk_id, source_id, source_type, title, text)
       values (?, ?, 'conversation', 'secret id', 'identifier evidence')`
    ).run(secretChunkId, secretSourceId);

    const result = scrubPrivacy(store);

    expect(result.redactions).toBeGreaterThan(0);
    expect(existsSync(result.backupPath)).toBe(false);
    const serialized = JSON.stringify({
      sources: store.db.prepare("select * from sources").all(),
      chunks: store.db.prepare("select * from chunks").all(),
      fts: store.db.prepare("select * from chunks_fts").all()
    });
    expect(serialized).not.toContain(secret);
    expect(JSON.stringify(store.db.prepare("select * from sources").all())).not.toContain(secret);
    expect(store.search({ query: "chunk", limit: 5 })).toHaveLength(1);
    expect(store.db.prepare("pragma quick_check").get()).toEqual({ quick_check: "ok" });
    expect(store.db.prepare("pragma foreign_key_check").all()).toEqual([]);
    expect(readdirSync(store.paths.dataDir).filter((name) => name.includes(".recovery-"))).toEqual([]);
    store.close();
  });

  it("rolls back and retains the exact verified backup when mutation fails", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "code-butler-privacy-scrub-failure-"));
    const store = openMemoryStore(rootDir);
    store.init();
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    store.addSourceWithChunks({
      source: {
        id: "legacy-source",
        type: "conversation",
        title: "legacy",
        origin: "codex",
        rawContent: "safe"
      },
      chunks: [{ text: "safe" }]
    });
    store.db.prepare("update sources set raw_content = ? where id = ?").run(secret, "legacy-source");

    let thrown: unknown;
    try {
      scrubPrivacy(store, { afterMutation: () => { throw new Error("injected mutation failure"); } });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error & { backupPath?: string }).backupPath).toBeTruthy();
    const backupPath = (thrown as Error & { backupPath: string }).backupPath;
    expect(existsSync(backupPath)).toBe(true);
    expect(store.db.prepare("select raw_content from sources where id = ?").get("legacy-source"))
      .toEqual({ raw_content: secret });
    store.close();
  });
});
