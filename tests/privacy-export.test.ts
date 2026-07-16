import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { auditPrivacy, exportPrivacy, importPrivacy } from "../src/privacy/service.js";
import { openConfiguredMemoryStore } from "../src/storage/open-configured-store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("privacy audit and export", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
  });

  function legacySecretStore() {
    const root = makeTempDir();
    tempDirs.push(root);
    const store = openConfiguredMemoryStore(root);
    store.init();
    store.db.prepare(
      `insert into sources (id, type, title, origin, raw_content, metadata_json, created_at)
       values ('legacy-secret', 'conversation', 'Legacy', 'fixture', ?, '{}', ?)`
    ).run("OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456", new Date().toISOString());
    return { root, store };
  }

  it("audits legacy plaintext without returning the matched value", () => {
    const { store } = legacySecretStore();
    const result = auditPrivacy(store);

    expect(result.matches).toBeGreaterThan(0);
    expect(result.findings).toContainEqual(expect.objectContaining({
      table: "sources",
      field: "raw_content",
      type: "api_key"
    }));
    expect(JSON.stringify(result)).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz123456");
    store.close();
  });

  it("exports redacted versioned JSON atomically and logs the operation", () => {
    const { root, store } = legacySecretStore();
    const outputPath = join(root, "exports", "privacy.json");

    const result = exportPrivacy(store, { outputPath, now: () => new Date("2026-07-16T10:00:00.000Z") });
    const content = readFileSync(outputPath, "utf8");
    const document = JSON.parse(content);

    expect(result.redacted).toBe(true);
    expect(document).toMatchObject({
      format: "code-butler-privacy-export",
      version: 1,
      redacted: true
    });
    expect(content).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz123456");
    expect(content).toContain("[REDACTED:API_KEY]");
    expect(existsSync(outputPath)).toBe(true);
    expect(store.listOperations({ operationType: "export" })).toEqual([
      expect.objectContaining({ status: "completed", actor: "cli" })
    ]);
    store.close();
  });

  it("requires explicit confirmation for raw export through service and CLI", async () => {
    const { root, store } = legacySecretStore();
    const outputPath = join(root, "raw.json");
    expect(() => exportPrivacy(store, { outputPath, raw: true })).toThrow(
      "Raw export requires --confirm-raw-export"
    );
    store.close();

    const errors: string[] = [];
    await expect(runCli(["privacy", "export", "--output", outputPath, "--raw"], {
      cwd: root,
      stderr: (line) => errors.push(line)
    })).resolves.toBe(1);
    expect(errors.join("\n")).toContain("Raw export requires --confirm-raw-export");
  });

  it("round-trips retained data and rebuilds FTS while rejecting nonempty targets", () => {
    const sourceRoot = makeTempDir();
    const targetRoot = makeTempDir();
    tempDirs.push(sourceRoot, targetRoot);
    const source = openConfiguredMemoryStore(sourceRoot);
    source.init();
    source.addSourceWithChunks({
      source: {
        id: "roundtrip-source",
        type: "conversation",
        title: "Roundtrip",
        origin: "fixture",
        rawContent: "Portable privacy export evidence."
      },
      chunks: [{ text: "Portable privacy export evidence." }]
    });
    const outputPath = join(sourceRoot, "privacy.json");
    exportPrivacy(source, { outputPath });
    source.close();

    const target = openConfiguredMemoryStore(targetRoot);
    target.init();
    importPrivacy(target, { inputPath: outputPath });
    expect(target.readSource("roundtrip-source")?.title).toBe("Roundtrip");
    expect(target.search({ query: "Portable privacy" })).toHaveLength(1);
    expect(target.db.prepare("pragma quick_check").get()).toEqual({ quick_check: "ok" });

    target.addSourceWithChunks({
      source: {
        id: "target-existing",
        type: "conversation",
        title: "Existing",
        origin: "fixture",
        rawContent: "Existing target content."
      },
      chunks: [{ text: "Existing target content." }]
    });
    expect(() => importPrivacy(target, { inputPath: outputPath })).toThrow(
      "Import into non-empty storage requires --confirm-nonempty"
    );
    target.close();
  });

  it("rolls back malformed imports without changing existing data", () => {
    const root = makeTempDir();
    tempDirs.push(root);
    const store = openConfiguredMemoryStore(root);
    store.init();
    store.addSourceWithChunks({
      source: {
        id: "existing",
        type: "conversation",
        title: "Existing",
        origin: "fixture",
        rawContent: "Keep this row."
      },
      chunks: [{ text: "Keep this row." }]
    });
    const inputPath = join(root, "bad.json");
    const document: {
      format: string;
      version: number;
      redacted: boolean;
      exportedAt: string;
      tables: Record<string, Array<Record<string, unknown>>>;
    } = {
      format: "code-butler-privacy-export",
      version: 1,
      redacted: true,
      exportedAt: new Date().toISOString(),
      tables: Object.fromEntries(
        [
          "sources", "chunks", "commits", "decisions", "relations", "sync_sources", "sync_cursors",
          "memory_candidates", "memories", "memory_links", "temporary_memories",
          "temporary_memory_links", "memory_relations", "source_failures", "source_tombstones",
          "private_identity_mappings", "operation_log"
        ].map((table) => [table, []])
      )
    };
    document.tables.sources = [{ unknown_column: "bad" }];
    writeFileSync(inputPath, JSON.stringify(document));

    expect(() => importPrivacy(store, { inputPath, confirmNonempty: true })).toThrow("Unknown column");
    expect(store.readSource("existing")?.title).toBe("Existing");
    store.close();
  });

  it("rejects content-bearing imported operation metadata", () => {
    const sourceRoot = makeTempDir();
    const targetRoot = makeTempDir();
    tempDirs.push(sourceRoot, targetRoot);
    const source = openConfiguredMemoryStore(sourceRoot);
    source.init();
    const inputPath = join(sourceRoot, "operation-content.json");
    exportPrivacy(source, { outputPath: inputPath });
    source.close();
    const document = JSON.parse(readFileSync(inputPath, "utf8")) as {
      tables: Record<string, Array<Record<string, unknown>>>;
    };
    document.tables.operation_log!.push({
      id: "op-crafted",
      operation_type: "export",
      status: "completed",
      started_at: "2026-07-16T10:00:00.000Z",
      completed_at: "2026-07-16T10:00:00.000Z",
      actor: "cli",
      metadata_json: JSON.stringify({ query: "private search text" })
    });
    writeFileSync(inputPath, JSON.stringify(document));
    const target = openConfiguredMemoryStore(targetRoot);
    target.init();

    expect(() => importPrivacy(target, { inputPath })).toThrow(
      "query is not allowed in export operation metadata"
    );
    target.close();
  });

  it("rejects dangling logical relations that SQLite foreign keys do not cover", () => {
    const sourceRoot = makeTempDir();
    const targetRoot = makeTempDir();
    tempDirs.push(sourceRoot, targetRoot);
    const source = openConfiguredMemoryStore(sourceRoot);
    source.init();
    const inputPath = join(sourceRoot, "dangling.json");
    exportPrivacy(source, { outputPath: inputPath });
    source.close();
    const document = JSON.parse(readFileSync(inputPath, "utf8")) as {
      tables: Record<string, Array<Record<string, unknown>>>;
    };
    document.tables.relations!.push({
      id: "dangling",
      from_type: "source",
      from_id: "missing",
      relation: "mentions",
      to_type: "file",
      to_id: "src/missing.ts",
      locator: null
    });
    writeFileSync(inputPath, JSON.stringify(document));
    const target = openConfiguredMemoryStore(targetRoot);
    target.init();

    expect(() => importPrivacy(target, { inputPath })).toThrow("dangling logical references");
    target.close();
  });

  it("rejects dangling evidence and promoted-memory references", () => {
    const sourceRoot = makeTempDir();
    const targetRoot = makeTempDir();
    tempDirs.push(sourceRoot, targetRoot);
    const source = openConfiguredMemoryStore(sourceRoot);
    source.init();
    source.addSourceWithChunks({
      source: {
        id: "evidence-source",
        type: "conversation",
        title: "Evidence",
        origin: "fixture",
        rawContent: "Evidence body"
      },
      chunks: [{ text: "Evidence body" }]
    });
    const candidate = source.upsertMemoryCandidate({
      type: "constraint",
      title: "Evidence-backed memory",
      summary: "Keep the reference valid.",
      reason: "Import validation.",
      confidence: 0.9,
      evidence: [{
        sourceType: "conversation",
        sourceId: "evidence-source",
        locator: "evidence-source:chunk:0"
      }],
      relatedFiles: [],
      dedupeKey: "evidence-backed-memory"
    });
    const inputPath = join(sourceRoot, "dangling-evidence.json");
    exportPrivacy(source, { outputPath: inputPath });
    source.close();
    const document = JSON.parse(readFileSync(inputPath, "utf8")) as {
      tables: Record<string, Array<Record<string, unknown>>>;
    };
    const exportedCandidate = document.tables.memory_candidates!
      .find((row) => row.id === candidate.id)!;
    exportedCandidate.evidence_json = JSON.stringify([{
      sourceType: "conversation",
      sourceId: "missing-source",
      locator: "missing-source:chunk:0"
    }]);
    exportedCandidate.promotion_state = "promoted";
    exportedCandidate.promoted_memory_id = "missing-memory";
    writeFileSync(inputPath, JSON.stringify(document));
    const target = openConfiguredMemoryStore(targetRoot);
    target.init();

    expect(() => importPrivacy(target, { inputPath })).toThrow("dangling logical references");
    target.close();
  });
});
