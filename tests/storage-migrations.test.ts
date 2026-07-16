import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
  createV3MemorySubjectKey,
  getMigrationStatus,
  initializeSchema
} from "../src/storage/migrations.js";
import { openMemoryStore } from "../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("ordered storage migrations", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  it("keeps the version-3 subject-key fixture stable", () => {
    expect(createV3MemorySubjectKey("decision", "  R\u00e9sum\u00e9 / API v2  ")).toBe("decision:resume-api-v2");
  });

  it("adds the version-9 content-free operation and source tombstone schema", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();

    expect(CURRENT_SCHEMA_VERSION).toBe(10);
    expect(store.db.prepare("pragma table_info(source_failures)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "adapter" }),
        expect.objectContaining({ name: "path" }),
        expect.objectContaining({ name: "error_code" }),
        expect.objectContaining({ name: "attempts" }),
        expect.objectContaining({ name: "resolved_at" })
      ])
    );
    expect(store.db.prepare("pragma table_info(operation_log)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "id", pk: 1 }),
        expect.objectContaining({ name: "operation_type" }),
        expect.objectContaining({ name: "status" }),
        expect.objectContaining({ name: "started_at" }),
        expect.objectContaining({ name: "completed_at" }),
        expect.objectContaining({ name: "actor" }),
        expect.objectContaining({ name: "metadata_json", dflt_value: "'{}'" })
      ])
    );
    expect(store.db.prepare("pragma table_info(source_tombstones)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "source_type", pk: 1 }),
        expect.objectContaining({ name: "source_id_hash", pk: 2 }),
        expect.objectContaining({ name: "deleted_at" }),
        expect.objectContaining({ name: "operation_id" })
      ])
    );
    const migrationOperations = store.listOperations({ operationType: "migration" });
    expect(migrationOperations).toHaveLength(2);
    expect(migrationOperations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operationType: "migration",
        status: "completed",
        actor: "system",
        metadata: { migrationVersion: 10 }
      }),
      expect.objectContaining({
        operationType: "migration",
        status: "completed",
        actor: "system",
        metadata: { migrationVersion: 9 }
      })
    ]));
    store.close();
  });

  it("upgrades a legacy database in place, records ordered versions, and creates a backup", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, ".code-butler");
    const databasePath = join(dataDir, "memory.sqlite");
    mkdirSync(dataDir, { recursive: true });
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      create table memory_candidates (
        id text primary key, type text not null, title text not null, summary text not null,
        reason text not null, confidence real not null, evidence_json text not null,
        related_files_json text not null, dedupe_key text not null unique,
        promotion_state text not null, evidence_signature text not null,
        created_at text not null, updated_at text not null
      );
      insert into memory_candidates values
        ('legacy-id', 'constraint', 'Legacy', 'Preserve this row.', 'Upgrade safely.', 0.9,
         '[]', '[]', 'legacy-key', 'candidate', '', '2026-01-01', '2026-01-01');
    `);
    legacy.close();

    const store = openMemoryStore(rootDir);
    store.init();

    expect(store.listMemoryCandidates({ qualityStatus: "all" })).toEqual([
      expect.objectContaining({ id: "legacy-id", qualityStatus: "active" })
    ]);
    expect(getMigrationStatus(store.db, store.paths.databasePath)).toMatchObject({
      currentVersion: CURRENT_SCHEMA_VERSION,
      latestVersion: CURRENT_SCHEMA_VERSION,
      pendingVersions: []
    });
    expect(
      store.db.prepare("select version from schema_migrations order by version").all()
    ).toEqual(SCHEMA_MIGRATIONS.map(({ version }) => ({ version })));
    expect(readdirSync(dataDir).filter((name) => name.startsWith("memory.sqlite.backup-"))).toHaveLength(1);
    expect(store.db.prepare("pragma busy_timeout").get()).toEqual({ timeout: 5000 });
    store.close();
  });

  it("upgrades a populated pre-ledger database before creating lifecycle indexes", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, ".code-butler");
    const databasePath = join(dataDir, "memory.sqlite");
    mkdirSync(dataDir, { recursive: true });
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      create table memories (
        id text primary key, type text not null, title text not null, summary text not null,
        reason text not null, confidence real not null, evidence_json text not null,
        related_files_json text not null, dedupe_key text not null, evidence_signature text not null,
        source text not null, created_at text not null, promoted_at text not null,
        quality_status text not null default 'active', quality_reasons_json text not null default '[]',
        last_verified_at text
      );
      create table memory_candidates (
        id text primary key, type text not null, title text not null, summary text not null,
        reason text not null, confidence real not null, evidence_json text not null,
        related_files_json text not null, dedupe_key text not null unique,
        promotion_state text not null, evidence_signature text not null,
        quality_status text not null default 'active', quality_reasons_json text not null default '[]',
        last_verified_at text, created_at text not null, updated_at text not null
      );
      insert into memories values
        ('legacy-memory', 'decision', 'Legacy memory', 'Keep this row.', 'Migration coverage.', 1,
         '[]', '[]', 'legacy-memory', 'legacy-signature', 'manual',
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'active', '[]', null);
    `);
    legacy.close();

    const store = openMemoryStore(rootDir);
    store.init();

    expect(store.readMemory("legacy-memory")).toMatchObject({
      lifecycleStatus: "current",
      subjectKey: "decision:legacy-memory"
    });
    expect(
      store.db.prepare("select name from sqlite_master where type = 'index' and name = 'idx_memories_lifecycle_status'").get()
    ).toEqual({ name: "idx_memories_lifecycle_status" });
    expect(readdirSync(dataDir).filter((name) => name.startsWith("memory.sqlite.backup-") )).toHaveLength(1);
    store.close();
  });

  it("upgrades v2 lifecycle data additively and backfills unambiguous promotion pointers", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, ".code-butler");
    const databasePath = join(dataDir, "memory.sqlite");
    mkdirSync(dataDir, { recursive: true });
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      create table schema_migrations (
        version integer primary key, name text not null, applied_at text not null
      );
      insert into schema_migrations values
        (1, 'create base memory schema', '2026-01-01T00:00:00.000Z'),
        (2, 'add memory quality metadata', '2026-01-02T00:00:00.000Z');
      create table memory_candidates (
        id text primary key, type text not null, title text not null, summary text not null,
        reason text not null, confidence real not null, evidence_json text not null,
        related_files_json text not null, dedupe_key text not null unique,
        promotion_state text not null, evidence_signature text not null,
        quality_status text not null default 'active', quality_reasons_json text not null default '[]',
        last_verified_at text, created_at text not null, updated_at text not null
      );
      create table memories (
        id text primary key, type text not null, title text not null, summary text not null,
        reason text not null, confidence real not null, evidence_json text not null,
        related_files_json text not null, dedupe_key text not null, evidence_signature text not null,
        source text not null, quality_status text not null default 'active',
        quality_reasons_json text not null default '[]', last_verified_at text,
        created_at text not null, promoted_at text not null,
        unique (dedupe_key, evidence_signature, source)
      );
      insert into memories values
        ('memory-match', 'constraint', '  Stable  TITLE \u00c9  ', 'Legacy summary', 'Legacy reason', 0.9,
         '[]', '[]', 'matched-key', 'signature-1', 'auto', 'active', '[]', null,
         '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z'),
        ('memory-other', 'decision', 'Other title', 'Other summary', 'Other reason', 0.9,
         '[]', '[]', 'other-key', 'signature-2', 'manual', 'active', '[]', null,
         '2026-01-02T00:00:00.000Z', '2026-01-04T00:00:00.000Z'),
        ('memory-ambiguous-auto', 'decision', 'Ambiguous auto', 'Ambiguous', 'Ambiguous', 0.9,
         '[]', '[]', 'ambiguous-key', 'ambiguous-signature', 'auto', 'active', '[]', null,
         '2026-01-02T00:00:00.000Z', '2026-01-04T00:00:00.000Z'),
        ('memory-ambiguous-manual', 'decision', 'Ambiguous manual', 'Ambiguous', 'Ambiguous', 0.9,
         '[]', '[]', 'ambiguous-key', 'ambiguous-signature', 'manual', 'active', '[]', null,
         '2026-01-02T00:00:00.000Z', '2026-01-04T00:00:00.000Z');
      insert into memory_candidates values
        ('candidate-match', 'constraint', 'Stable title', 'Candidate', 'Candidate', 0.9,
         '[]', '[]', 'matched-key', 'promoted', 'signature-1', 'active', '[]', null,
         '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z'),
        ('candidate-open', 'decision', 'Open candidate', 'Candidate', 'Candidate', 0.9,
         '[]', '[]', 'open-key', 'candidate', 'signature-open', 'active', '[]', null,
         '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z'),
        ('candidate-ambiguous', 'decision', 'Ambiguous candidate', 'Candidate', 'Candidate', 0.9,
         '[]', '[]', 'ambiguous-key', 'promoted', 'ambiguous-signature', 'active', '[]', null,
         '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z');
    `);
    legacy.close();

    const store = openMemoryStore(rootDir);
    store.init();

    expect(store.db.prepare("select count(*) as count from memories").get()).toEqual({ count: 4 });
    expect(store.db.prepare("select count(*) as count from memory_candidates").get()).toEqual({ count: 3 });
    expect(store.db.prepare("select count(*) as count from memory_relations").get()).toEqual({ count: 0 });
    expect(store.readMemory("memory-match")).toMatchObject({
      subjectKey: "constraint:stable-title-e",
      lifecycleStatus: "current",
      validFrom: "2026-01-01T00:00:00.000Z",
      statusChangedAt: "2026-01-03T00:00:00.000Z"
    });
    expect(store.listMemoryCandidates({ qualityStatus: "all" })).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "candidate-match", promotedMemoryId: "memory-match" }),
      expect.objectContaining({ id: "candidate-open", promotedMemoryId: undefined }),
      expect.objectContaining({ id: "candidate-ambiguous", promotedMemoryId: undefined })
    ]));
    expect(
      store.db.prepare("pragma table_info(memories)").all()
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "subject_key", notnull: 1 }),
      expect.objectContaining({ name: "lifecycle_status", notnull: 1 }),
      expect.objectContaining({ name: "status_changed_at", notnull: 1 })
    ]));
    expect(readdirSync(dataDir).filter((name) => name.startsWith("memory.sqlite.backup-"))).toHaveLength(1);

    store.updateMemoryLifecycle("memory-match", { lifecycleStatus: "retracted" });
    store.db.prepare("update memories set subject_key = ? where id = ?").run(
      "constraint:post-v3-custom-key",
      "memory-match"
    );
    SCHEMA_MIGRATIONS[2]?.up(store.db);
    expect(store.readMemory("memory-match")).toMatchObject({
      lifecycleStatus: "retracted",
      subjectKey: "constraint:post-v3-custom-key"
    });
    expect(store.listMemoryCandidates({ qualityStatus: "all" })).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "candidate-match", promotedMemoryId: "memory-match" }),
      expect.objectContaining({ id: "candidate-ambiguous", promotedMemoryId: undefined })
    ]));
    expect(store.db.prepare("select count(*) as count from memories").get()).toEqual({ count: 4 });
    expect(store.db.prepare("select count(*) as count from memory_relations").get()).toEqual({ count: 0 });
    store.close();
  });

  it("adds constrained embedding tables and upgrades v3 data without changing logical counts", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const legacyStore = openMemoryStore(rootDir);
    initializeSchema(legacyStore.db, legacyStore.paths.databasePath, {
      migrations: SCHEMA_MIGRATIONS.slice(0, 3)
    });
    legacyStore.addSourceWithChunks({
      source: {
        id: "legacy-source",
        type: "conversation",
        title: "Legacy source",
        origin: "fixture",
        rawContent: "Legacy content"
      },
      chunks: [{ text: "Legacy content" }]
    });
    legacyStore.upsertMemoryCandidate({
      type: "decision",
      title: "Legacy memory",
      summary: "Keep this memory.",
      reason: "Migration coverage.",
      confidence: 1,
      evidence: [{ sourceType: "conversation", sourceId: "legacy-source" }],
      relatedFiles: [],
      dedupeKey: "legacy-memory"
    });
    legacyStore.db.prepare(
      `insert into memories
         (id, type, title, summary, reason, confidence, evidence_json, related_files_json,
          dedupe_key, evidence_signature, source, quality_status, quality_reasons_json,
          last_verified_at, subject_key, lifecycle_status, valid_from, valid_until,
          status_reason, status_changed_at, created_at, promoted_at)
       values (?, 'decision', 'Legacy memory', 'Keep this memory.', 'Migration coverage.', 1,
               '[]', '[]', 'legacy-memory', 'legacy-signature', 'manual', 'active', '[]', null,
               'decision:legacy-memory', 'current', ?, null, null, ?, ?, ?)`
    ).run(
      "legacy-memory",
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z"
    );
    const before = {
      sources: legacyStore.db.prepare("select count(*) as count from sources").get(),
      chunks: legacyStore.db.prepare("select count(*) as count from chunks").get(),
      memories: legacyStore.db.prepare("select count(*) as count from memories").get()
    };
    legacyStore.close();

    const store = openMemoryStore(rootDir);
    store.init();

    expect(CURRENT_SCHEMA_VERSION).toBe(10);
    expect(store.db.prepare("select count(*) as count from sources").get()).toEqual(before.sources);
    expect(store.db.prepare("select count(*) as count from chunks").get()).toEqual(before.chunks);
    expect(store.db.prepare("select count(*) as count from memories").get()).toEqual(before.memories);
    const lifecycleGeneration = store.listMemories({
      lifecycleStatus: "all",
      qualityStatus: "all"
    })[0]!.lifecycleGeneration;
    expect(lifecycleGeneration).toMatch(/^[a-f0-9-]{36}$/);
    expect(
      store.db.prepare(
        "select name from sqlite_master where type = 'table' and name in ('embedding_jobs', 'embedding_vectors') order by name"
      ).all()
    ).toEqual([{ name: "embedding_jobs" }, { name: "embedding_vectors" }]);
    expect(store.db.prepare("pragma table_info(embedding_jobs)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "index_generation", notnull: 1, dflt_value: "''" }),
      expect.objectContaining({ name: "target_fingerprint", notnull: 0 })
    ]));
    expect(
      store.db.prepare("select name from sqlite_master where type = 'index' and name like 'idx_embedding_%' order by name").all()
    ).toEqual(expect.arrayContaining([
      { name: "idx_embedding_jobs_owner" },
      { name: "idx_embedding_jobs_provider_state" },
      { name: "idx_embedding_vectors_owner" },
      { name: "idx_embedding_vectors_provider" }
    ]));
    expect(() =>
      store.db.prepare(
        `insert into embedding_jobs
           (owner_kind, owner_id, content_hash, provider_key, endpoint_hash, model, state,
            attempts, created_at, updated_at)
         values ('candidate', 'bad', 'hash', 'key', 'endpoint', 'model', 'pending', 0, 'now', 'now')`
      ).run()
    ).toThrow();
    expect(() =>
      store.db.prepare(
        `insert into embedding_jobs
           (owner_kind, owner_id, content_hash, provider_key, endpoint_hash, model, state,
            attempts, created_at, updated_at)
         values ('chunk', 'bad', 'hash', 'key', 'endpoint', 'model', 'running', 0, 'now', 'now')`
      ).run()
    ).toThrow();
    store.close();

    const reopened = openMemoryStore(rootDir);
    reopened.init();
    expect(reopened.readMemory("legacy-memory")?.lifecycleGeneration).toBe(lifecycleGeneration);
    reopened.close();
  });

  it("upgrades existing v4 embedding rows with a stable empty owner generation", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    initializeSchema(store.db, store.paths.databasePath, {
      migrations: SCHEMA_MIGRATIONS.slice(0, 4)
    });
    store.db.exec(`
      insert into embedding_jobs
        (owner_kind, owner_id, content_hash, provider_key, endpoint_hash, model, state,
         attempts, created_at, updated_at)
      values ('chunk', 'legacy-chunk', 'content', 'provider', 'endpoint', 'model',
              'pending', 0, '2026-07-01', '2026-07-01');
      insert into embedding_vectors
        (owner_kind, owner_id, content_hash, provider_key, endpoint_hash, model,
         provider_fingerprint, dimension, vector_blob, created_at, updated_at)
      values ('chunk', 'legacy-chunk', 'content', 'provider', 'endpoint', 'model',
              'fingerprint', 1, x'0000803f', '2026-07-01', '2026-07-01');
    `);
    store.close();

    const upgraded = openMemoryStore(rootDir);
    upgraded.init();

    expect(upgraded.db.prepare(
      "select owner_version as ownerVersion from embedding_jobs where owner_id = 'legacy-chunk'"
    ).get()).toEqual({ ownerVersion: "" });
    expect(upgraded.db.prepare(
      "select owner_version as ownerVersion from embedding_vectors where owner_id = 'legacy-chunk'"
    ).get()).toEqual({ ownerVersion: "" });
    upgraded.close();
  });

  it("rolls back a failed migration while retaining its pre-migration backup", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.close();

    const databasePath = join(rootDir, ".code-butler", "memory.sqlite");
    for (let index = 0; index < 6; index += 1) {
      const oldBackup = new DatabaseSync(
        `${databasePath}.backup-2025-01-0${index + 1}T00-00-00-000Z.sqlite`
      );
      oldBackup.close();
    }
    const db = new DatabaseSync(databasePath);
    expect(() =>
      initializeSchema(db, databasePath, {
        migrations: [
          ...SCHEMA_MIGRATIONS,
          {
            version: CURRENT_SCHEMA_VERSION + 1,
            name: "failure injection",
            up(database) {
              database.exec("create table should_rollback (id text)");
              throw new Error("injected migration failure");
            }
          }
        ]
      })
    ).toThrow("injected migration failure");

    expect(
      db.prepare("select name from sqlite_master where type = 'table' and name = 'should_rollback'").get()
    ).toBeUndefined();
    expect(
      db.prepare("select max(version) as version from schema_migrations").get()
    ).toEqual({ version: CURRENT_SCHEMA_VERSION });
    expect(db.prepare(
      `select count(*) as count from operation_log
       where operation_type = 'migration'
         and json_extract(metadata_json, '$.migrationVersion') = ?`
    ).get(CURRENT_SCHEMA_VERSION + 1)).toEqual({ count: 0 });
    const retained = readdirSync(join(rootDir, ".code-butler")).filter((name) =>
      name.startsWith("memory.sqlite.backup-")
    );
    expect(retained).toHaveLength(7);
    expect(retained.some((name) => name.includes("2026-") || name.includes("2027-"))).toBe(true);
    db.close();
  });

  it("retains only the newest two migration backups by default", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, ".code-butler");
    const databasePath = join(dataDir, "memory.sqlite");
    mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec("create table legacy_data (value text); insert into legacy_data values ('kept')");
    db.close();
    for (let index = 0; index < 6; index += 1) {
      const backup = `${databasePath}.backup-2026-01-0${index + 1}T00-00-00-000Z.sqlite`;
      const placeholder = new DatabaseSync(backup);
      placeholder.close();
      expect(existsSync(backup)).toBe(true);
    }

    const store = openMemoryStore(rootDir);
    store.init();
    store.close();

    expect(readdirSync(dataDir).filter((name) => name.startsWith("memory.sqlite.backup-"))).toHaveLength(2);
  });

  it("uses an explicit migration backup retention override", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, ".code-butler");
    const databasePath = join(dataDir, "memory.sqlite");
    mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec("create table legacy_data (value text); insert into legacy_data values ('kept')");
    db.close();
    for (let index = 0; index < 4; index += 1) {
      const backup = `${databasePath}.backup-2026-02-0${index + 1}T00-00-00-000Z.sqlite`;
      const placeholder = new DatabaseSync(backup);
      placeholder.close();
    }

    const store = openMemoryStore(rootDir, { backupRetention: 3 });
    store.init();
    store.close();

    expect(readdirSync(dataDir).filter((name) => name.startsWith("memory.sqlite.backup-"))).toHaveLength(3);
  });

  it("does not double-apply a migration body across concurrent initializers", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.close();
    const databasePath = join(rootDir, ".code-butler", "memory.sqlite");
    const barrierDir = join(rootDir, "barrier");
    mkdirSync(barrierDir);
    const script = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { DatabaseSync } from 'node:sqlite';
      import { initializeSchema, SCHEMA_MIGRATIONS, CURRENT_SCHEMA_VERSION } from './src/storage/migrations.ts';
      const role = process.argv[2];
      const barrier = process.argv[3];
      writeFileSync(join(barrier, 'started-' + role), '');
      const db = new DatabaseSync(process.argv[1]);
      initializeSchema(db, process.argv[1], {
        migrations: [...SCHEMA_MIGRATIONS, {
          version: CURRENT_SCHEMA_VERSION + 1,
          name: 'concurrency probe',
          up(database) {
            if (role === 'first') {
              writeFileSync(join(barrier, 'holding-lock'), '');
              while (!existsSync(join(barrier, 'release'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            }
            database.exec('create table if not exists migration_body_runs (id integer primary key)');
            database.exec('insert into migration_body_runs default values');
          }
        }]
      });
      db.close();
    `;

    const first = runInitializer(script, databasePath, "first", barrierDir);
    await waitForFile(join(barrierDir, "holding-lock"));
    const second = runInitializer(script, databasePath, "second", barrierDir);
    await waitForFile(join(barrierDir, "started-second"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(join(barrierDir, "release"), "");
    await Promise.all([first, second]);

    const verified = new DatabaseSync(databasePath);
    expect(
      verified.prepare("select count(*) as count from migration_body_runs").get()
    ).toEqual({ count: 1 });
    expect(
      verified.prepare("select count(*) as count from schema_migrations where name = 'concurrency probe'").get()
    ).toEqual({ count: 1 });
    expect(verified.prepare(
      `select count(*) as count from operation_log
       where operation_type = 'migration' and status = 'completed'
         and json_extract(metadata_json, '$.migrationVersion') = ?`
    ).get(CURRENT_SCHEMA_VERSION + 1)).toEqual({ count: 1 });
    verified.close();
  });

  it("rejects a non-contiguous applied migration ledger", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.db.prepare("delete from schema_migrations where version = 1").run();

    expect(() => store.init()).toThrow("contiguous prefix");
    expect(store.db.prepare("select version from schema_migrations order by version").all()).toEqual(
      SCHEMA_MIGRATIONS.slice(1).map(({ version }) => ({ version }))
    );
    store.close();
  });

  it("rejects a database created by a newer schema version", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.db.prepare("insert into schema_migrations values (?, ?, ?)").run(
      CURRENT_SCHEMA_VERSION + 1,
      "future migration",
      "2026-07-11T00:00:00Z"
    );

    expect(() => store.init()).toThrow("newer schema version");
    store.close();
  });
});

function runInitializer(script: string, databasePath: string, role: string, barrierDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, databasePath, role, barrierDir], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Initializer exited ${code}: ${stderr}`));
    });
  });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}
import { spawn } from "node:child_process";
