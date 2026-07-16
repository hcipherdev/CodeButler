import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openMemoryStore } from "../src/storage/store.js";
import type { ExtractedMemory } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("memory quality storage", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  function memory(overrides: Partial<ExtractedMemory> = {}): ExtractedMemory {
    return {
      type: "constraint",
      title: "Use SQLite",
      summary: "Use SQLite for local project memory.",
      reason: "Local-first memory needs an embedded database.",
      confidence: 0.92,
      evidence: [{ sourceType: "conversation", sourceId: "conv-1" }],
      relatedFiles: ["src/storage/store.ts"],
      dedupeKey: "sqlite-memory",
      ...overrides
    };
  }

  it("stores quality metadata and hides quarantined memories by default", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();

    store.upsertMemoryCandidate(memory({ dedupeKey: "active" }), {
      qualityStatus: "active",
      qualityReasons: [],
      lastVerifiedAt: "2026-06-01T10:00:00Z"
    });
    store.upsertMemoryCandidate(memory({ dedupeKey: "quarantined", title: "Bad HTML" }), {
      qualityStatus: "quarantined",
      qualityReasons: ["html_or_markup_content"],
      lastVerifiedAt: "2026-06-01T10:00:00Z"
    });

    expect(store.listMemoryCandidates().map((candidate) => candidate.dedupeKey)).toEqual(["active"]);
    expect(store.listMemoryCandidates({ qualityStatus: "all" }).map((candidate) => candidate.dedupeKey)).toEqual([
      "quarantined",
      "active"
    ]);
    expect(store.searchMemoryLayer({ qualityStatus: "all" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dedupeKey: "quarantined",
          qualityStatus: "quarantined",
          qualityReasons: ["html_or_markup_content"],
          trust: expect.objectContaining({ status: "quarantined" })
        })
      ])
    );

    store.close();
  });

  it("migrates old memory rows to active quality status", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, ".code-butler");
    mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(join(dataDir, "memory.sqlite"));
    db.exec(`
      create table memory_candidates (
        id text primary key,
        type text not null,
        title text not null,
        summary text not null,
        reason text not null,
        confidence real not null,
        evidence_json text not null,
        related_files_json text not null,
        dedupe_key text not null unique,
        promotion_state text not null,
        evidence_signature text not null,
        created_at text not null,
        updated_at text not null
      );
      insert into memory_candidates
        (id, type, title, summary, reason, confidence, evidence_json, related_files_json,
         dedupe_key, promotion_state, evidence_signature, created_at, updated_at)
      values
        ('candidate-old', 'constraint', 'Old', 'Old memory.', 'Existing DB row.', 0.8, '[]', '[]',
         'old-memory', 'candidate', '', '2026-06-01T10:00:00Z', '2026-06-01T10:00:00Z');
    `);
    db.close();

    const store = openMemoryStore(rootDir);
    store.init();

    expect(store.listMemoryCandidates()).toEqual([
      expect.objectContaining({
        id: "candidate-old",
        qualityStatus: "active",
        qualityReasons: [],
        lastVerifiedAt: undefined
      })
    ]);

    store.close();
  });

  it("checkpoints WAL changes into the primary database before closing", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.db.exec("pragma wal_autocheckpoint = 0");
    store.db.exec("pragma busy_timeout = 0");
    store.db.exec("create table checkpoint_fixture (value text); insert into checkpoint_fixture values ('shared');");
    const reader = new DatabaseSync(store.paths.databasePath, { readOnly: true });
    reader.exec("begin");
    expect(reader.prepare("select value from checkpoint_fixture").all()).toEqual([{ value: "shared" }]);

    expect(existsSync(`${store.paths.databasePath}-wal`)).toBe(true);
    expect(() => store.close()).toThrow("Cannot safely close Code Butler memory database");

    reader.exec("commit");
    store.close();
    const walPath = `${store.paths.databasePath}-wal`;
    expect(existsSync(walPath) ? statSync(walPath).size : 0).toBe(0);
    expect(reader.prepare("select value from checkpoint_fixture").all()).toEqual([{ value: "shared" }]);
    reader.close();
  });
});
