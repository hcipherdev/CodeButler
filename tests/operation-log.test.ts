import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { openMemoryStore } from "../src/storage/store.js";
import type { BeginOperationInput, OperationType } from "../src/operations/types.js";
import { withTransaction } from "../src/storage/transactions.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("privacy-safe operation log", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  function createStore() {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    return store;
  }

  it("begins, completes, fails, and filters typed operations", () => {
    const store = createStore();
    const started = store.beginOperation({
      operationType: "export",
      actor: "cli",
      metadata: { identifier: "export-7", count: 2, category: "memories" },
      startedAt: "2026-07-15T10:00:00.000Z"
    });
    expect(started).toMatchObject({
      operationType: "export",
      status: "started",
      actor: "cli",
      completedAt: undefined,
      metadata: { identifier: "export-7", count: 2, category: "memories" }
    });

    expect(store.completeOperation(started.id, {
      completedAt: "2026-07-15T10:01:00.000Z"
    })).toMatchObject({ status: "completed", completedAt: "2026-07-15T10:01:00.000Z" });
    const failed = store.beginOperation({ operationType: "recovery", actor: "system" });
    expect(store.failOperation(failed.id)).toMatchObject({ status: "failed" });
    expect(store.listOperations({ status: "completed", operationType: "export" })).toEqual([
      expect.objectContaining({ id: started.id })
    ]);
    store.close();
  });

  it("rejects unallowlisted, content-bearing, secret, query, path, and error metadata", () => {
    const store = createStore();
    const unsafe = [
      { operationType: "export", metadata: { title: "Release plan" } },
      { operationType: "export", metadata: { summary: "raw source text" } },
      { operationType: "export", metadata: { reason: "because the user asked" } },
      { operationType: "export", metadata: { query: "password reset" } },
      { operationType: "export", metadata: { path: "../../.env" } },
      { operationType: "recovery", metadata: { error: "token=secret-value" } },
      { operationType: "export", metadata: { identifier: "../../secrets.txt" } },
      { operationType: "export", metadata: { category: "api_key=sk-secret" } },
      { operationType: "export", metadata: { category: "password-reset-query" } },
      { operationType: "export", metadata: { identifier: "Release-plan" } },
      { operationType: "export", metadata: { identifier: "Bearer-top-secret" } },
      { operationType: "migration", metadata: { identifier: "not-allowed-for-migration" } }
    ] as const;

    for (const input of unsafe) {
      expect(() => store.beginOperation({
        operationType: input.operationType,
        actor: "cli",
        metadata: input.metadata as never
      })).toThrow(/metadata/i);
    }
    expect(store.listOperations()).toHaveLength(2); // Schema migrations 9 and 10 only.
    store.close();
  });

  it("serializes a canonical copy instead of re-reading metadata accessors", () => {
    const store = createStore();
    let reads = 0;
    const metadata = Object.defineProperty({}, "identifier", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "export-7" : "raw source title password=hunter2";
      }
    });

    const operation = store.beginOperation({
      operationType: "export",
      actor: "cli",
      metadata
    });

    expect(operation.metadata).toEqual({ identifier: "export-7" });
    expect(reads).toBe(1);
    expect(JSON.stringify(store.db.prepare("select * from operation_log where id = ?").get(operation.id)))
      .not.toContain("hunter2");
    store.close();
  });

  it("enforces operation, status, and actor enums at the database boundary", () => {
    const store = createStore();
    const insert = store.db.prepare(
      `insert into operation_log
         (id, operation_type, status, started_at, completed_at, actor, metadata_json)
       values (?, ?, ?, ?, ?, ?, '{}')`
    );
    expect(() => insert.run("bad-type", "sync", "started", "2026-07-15T00:00:00Z", null, "system"))
      .toThrow();
    expect(() => insert.run("bad-status", "export", "pending", "2026-07-15T00:00:00Z", null, "system"))
      .toThrow();
    expect(() => insert.run("bad-actor", "export", "started", "2026-07-15T00:00:00Z", null, "user"))
      .toThrow();
    store.close();
  });

  it("stores deletion tombstones as SHA-256 hashes and never persists the original source id", () => {
    const store = createStore();
    const sourceId = "conversation:/Users/alice/private/session.jsonl";
    const expectedHash = createHash("sha256").update(sourceId).digest("hex");
    const tombstone = store.createSourceTombstone({
      sourceType: "conversation",
      sourceId,
      actor: "mcp",
      deletedAt: "2026-07-15T11:00:00.000Z"
    });

    expect(tombstone).toEqual({
      sourceType: "conversation",
      sourceIdHash: expectedHash,
      deletedAt: "2026-07-15T11:00:00.000Z",
      operationId: expect.stringMatching(/^operation-/)
    });
    expect(store.findSourceTombstone("conversation", sourceId)).toEqual(tombstone);
    expect(store.db.prepare("select * from source_tombstones").all()).toEqual([
      {
        source_type: "conversation",
        source_id_hash: expectedHash,
        deleted_at: "2026-07-15T11:00:00.000Z",
        operation_id: tombstone.operationId
      }
    ]);
    expect(JSON.stringify(store.db.prepare("select * from source_tombstones").all())).not.toContain(sourceId);
    expect(store.listOperations({ operationType: "deletion" })).toEqual([
      expect.objectContaining({
        id: tombstone.operationId,
        status: "completed",
        actor: "mcp",
        metadata: { sourceType: "conversation", sourceIdHash: expectedHash }
      })
    ]);
    store.close();
  });

  it("rolls back a tombstone and its generated operation together", () => {
    const store = createStore();
    expect(() => withTransaction(store.db, () => {
      store.createSourceTombstone({ sourceType: "commit", sourceId: "abc123", actor: "system" });
      throw new Error("rollback probe");
    })).toThrow("rollback probe");
    expect(store.findSourceTombstone("commit", "abc123")).toBeUndefined();
    expect(store.listOperations({ operationType: "deletion" })).toEqual([]);
    store.close();
  });

  it("keeps every operation-log column free of representative secrets", () => {
    const store = createStore();
    const secrets = ["sk-live-secret", "Bearer top-secret", "password=hunter2"];
    const operationTypes: OperationType[] = [
      "migration", "lifecycle_change", "redaction", "deletion", "export", "import",
      "retention_prune", "recovery"
    ];
    for (const [index, operationType] of operationTypes.entries()) {
      const input = {
        operationType,
        actor: "system",
        metadata: operationType === "migration" ? { migrationVersion: 10 + index } : undefined
      } as BeginOperationInput;
      const operation = store.beginOperation(input);
      store.completeOperation(operation.id);
    }
    const rows = store.db.prepare("select * from operation_log").all();
    for (const row of rows) {
      const serialized = JSON.stringify(row);
      for (const secret of secrets) expect(serialized).not.toContain(secret);
    }
    store.close();
  });
});
