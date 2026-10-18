// Tests encodeRowStream() and buildDatabaseFromRowStream() in src/cloud/row-stream.ts, and v4 snapshots (captureSnapshot rowStream, captureFingerprint, materializeSnapshot, decodeSnapshot, objectSizeEstimates) in src/cloud/snapshot.ts and src/cloud/encrypted-snapshot.ts.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EncryptionError } from "../../src/cloud/crypto-helper.js";
import { objectSizeEstimates } from "../../src/cloud/encrypted-snapshot.js";
import { buildDatabaseFromRowStream, encodeRowStream } from "../../src/cloud/row-stream.js";
import { bundleResolver, captureFingerprint, captureSnapshot, databaseFingerprint, decodeSnapshot, materializeSnapshot, verifySnapshotDatabase } from "../../src/cloud/snapshot.js";
import { stateDirectory } from "../../src/cloud/state.js";
import { rememberProjectMemory } from "../../src/memory/remember.js";
import { openConfiguredMemoryStore } from "../../src/storage/open-configured-store.js";
import type { MemoryStore } from "../../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const roots: string[] = [];
const temp = () => { const path = makeTempDir(); roots.push(path); return path; };
afterEach(() => { vi.unstubAllEnvs(); for (const path of roots.splice(0)) cleanupTempDir(path); });

function withStore<T>(root: string, work: (store: MemoryStore) => T): T {
  const store = openConfiguredMemoryStore(root);
  try { store.init(); return work(store); } finally { store.close(); }
}
function project(): string {
  vi.stubEnv("CODE_BUTLER_HOME", temp());
  const root = temp(); withStore(root, () => undefined); mkdirSync(stateDirectory(root), { recursive: true }); return root;
}
const databasePath = (root: string) => join(root, ".code-butler", "memory.sqlite");
const remember = (root: string, text: string) => withStore(root, store => rememberProjectMemory(store, { type: "decision", text }).memory!);
const addSource = (root: string, id: string, createdAt: string, text: string) => withStore(root, store => {
  store.addSourceWithChunks({ source: { id, type: "conversation", title: id, origin: `test:${id}`, rawContent: text }, chunks: [{ text }] });
  store.db.prepare("update sources set created_at = ? where id = ?").run(createdAt, id);
});
/** Builds into a scratch file and returns the open database; the caller closes it. */
function built(stream: Buffer): { db: DatabaseSync; path: string } {
  const path = join(temp(), "built.sqlite"); buildDatabaseFromRowStream(stream, path);
  return { db: new DatabaseSync(path, { readOnly: true }), path };
}

describe("row stream", () => {
  it("rebuilds a database with the same fingerprint, schema and storage classes, without the search index", () => {
    const root = project();
    remember(root, "Snapshots carry rows instead of pages.");
    addSource(root, "conversation-a", "2026-10-14T08:00:00.000Z", "First conversation about block reuse.");
    withStore(root, store => store.db.exec("create table probe(i integer, r real, t text, b blob, n); insert into probe values (9007199254740993, 1.0, 'rows', x'00ff', null), (-2, 2.5, '{\"schema\":1}', x'', 3)"));
    const stream = encodeRowStream(databasePath(root));
    const { db, path } = built(stream);
    try {
      expect(databaseFingerprint(path)).toBe(databaseFingerprint(databasePath(root)));
      expect(db.prepare("select typeof(i) i, typeof(r) r, typeof(t) t, typeof(b) b, typeof(n) n from probe order by i").all().map(row => ({ ...row })))
        .toEqual([{ i: "integer", r: "real", t: "text", b: "blob", n: "integer" }, { i: "integer", r: "real", t: "text", b: "blob", n: "null" }]);
      expect((db.prepare("select cast(i as text) i from probe order by i desc limit 1").get() as { i: string }).i).toBe("9007199254740993");
      const source = new DatabaseSync(databasePath(root), { readOnly: true });
      const triggers = (d: DatabaseSync) => (d.prepare("select name from sqlite_master where type = 'trigger' order by name").all() as Array<{ name: string }>).map(row => row.name);
      try { expect(triggers(db)).toEqual(triggers(source)); } finally { source.close(); }
      // Rows went in before the triggers existed, so the journal holds only the rows it was sent; the search index is left for the receiver.
      const journal = (d: DatabaseSync) => Number((d.prepare("select count(*) n from retrieval_changes").get() as { n: number }).n);
      const original = new DatabaseSync(databasePath(root), { readOnly: true });
      try { expect(journal(db)).toBe(journal(original)); } finally { original.close(); }
      expect(Number((db.prepare("select count(*) n from chunks_fts").get() as { n: number }).n)).toBe(0);
      expect(db.prepare("pragma quick_check").get()).toMatchObject({ quick_check: "ok" });
    } finally { db.close(); }
  });

  it("writes the same bytes for the same rows whatever order they were inserted in", async () => {
    const root = project();
    for (const [id, at] of [["older", "2026-10-01T00:00:00.000Z"], ["newer", "2026-10-02T00:00:00.000Z"], ["middle", "2026-10-01T12:00:00.000Z"]] as const) addSource(root, id, at, `${id} conversation`);
    const copy = join(temp(), "reordered.sqlite");
    const { backup } = await import("node:sqlite");
    const source = new DatabaseSync(databasePath(root), { readOnly: true });
    try { await backup(source, copy); } finally { source.close(); }
    // Same rows, physically reinserted in another order, so rowids differ from the original.
    const db = new DatabaseSync(copy);
    try {
      db.exec(`pragma foreign_keys = off;
        create temp table s as select * from sources; create temp table c as select * from chunks;
        delete from chunks; delete from sources;
        insert into sources select * from s order by id; insert into chunks select * from c order by id;
        delete from retrieval_changes;`);
    } finally { db.close(); }
    withStore(root, store => store.db.exec("delete from retrieval_changes"));
    const order = (path: string) => { const d = new DatabaseSync(path, { readOnly: true }); try { return (d.prepare("select id from sources order by rowid").all() as Array<{ id: string }>).map(r => r.id); } finally { d.close(); } };
    expect(order(copy)).not.toEqual(order(databasePath(root)));
    expect(encodeRowStream(copy).equals(encodeRowStream(databasePath(root)))).toBe(true);
  });

  it("keeps a source's file mentions together, so re-ingesting it rewrites one stretch of the stream", () => {
    const root = project();
    for (const [id, at] of [["older", "2026-10-01T00:00:00.000Z"], ["active", "2026-10-02T00:00:00.000Z"], ["newer", "2026-10-03T00:00:00.000Z"]] as const) addSource(root, id, at, `${id} conversation`);
    const mention = (store: MemoryStore, source: string) => {
      const insert = store.db.prepare("insert into relations (id, from_type, from_id, relation, to_type, to_id, locator) values (?, ?, ?, 'mentions', 'file', ?, ?)");
      for (let i = 0; i < 20; i++) insert.run(randomUUID(), "source", source, `src/${source}-${i}.ts`, null);
      const chunk = (store.db.prepare("select id from chunks where source_id = ?").get(source) as { id: string }).id;
      for (let i = 0; i < 20; i++) insert.run(randomUUID(), "chunk", chunk, `src/${source}-${i}.ts`, chunk);
    };
    withStore(root, store => { for (const source of ["older", "active", "newer"]) mention(store, source); store.db.exec("delete from retrieval_changes"); });
    const lines = () => encodeRowStream(databasePath(root)).toString("utf8").split("\n");
    const before = lines();
    // What re-ingesting a growing conversation does: every mention of that source comes back under a new id.
    withStore(root, store => {
      store.db.prepare("delete from relations where from_id = ? or from_id in (select id from chunks where source_id = ?)").run("active", "active");
      mention(store, "active"); store.db.exec("delete from retrieval_changes");
    });
    const after = lines();
    expect(after.length).toBe(before.length);
    const changed = after.flatMap((line, index) => line === before[index] ? [] : [index]);
    expect(changed.length).toBe(40);
    expect(changed.at(-1)! - changed[0]!).toBe(39);
  });

  it("masks the checkout path of temporary memories", () => {
    const root = project();
    withStore(root, store => store.db.prepare(`insert into temporary_memories (id, project_id, kind, title, summary, details, related_files_json, evidence_json, confidence, created_at, updated_at, expires_at)
      values (?, ?, 'task_state', 't', 's', 'd', '[]', '[]', 0.5, ?, ?, ?)`).run("temporary-1", root, "2026-10-14T00:00:00.000Z", "2026-10-14T00:00:00.000Z", "2099-01-01T00:00:00.000Z"));
    const stream = encodeRowStream(databasePath(root));
    expect(stream.toString()).not.toContain(root);
    expect(stream.toString()).toContain("@project");
  });

  it("runs only the one CREATE statement a schema line names, and rejects anything else", () => {
    const header = JSON.stringify({ format: "code-butler-rows", version: 1 });
    const stream = (...lines: unknown[]) => Buffer.from([header, ...lines.map(line => JSON.stringify(line)), JSON.stringify({ end: 0 })].join("\n") + "\n");
    const smuggled = built(stream({ schema: ["table", "a", "create table a(x); create table b(y)"] }));
    try { expect((smuggled.db.prepare("select name from sqlite_master").all() as Array<{ name: string }>).map(row => row.name)).toEqual(["a"]); } finally { smuggled.db.close(); }
    expect(() => built(stream({ schema: ["table", "a", "drop table b"] }))).toThrow("Invalid snapshot schema");
    expect(() => built(stream({ schema: ["table", "other", "create table a(x)"] }))).toThrow("Invalid snapshot schema");
    expect(() => built(stream({ schema: ["table", "a", "create table a(x)"] }, { rows: ["missing", ["x"]] }))).toThrow("Invalid snapshot row stream");
    expect(() => built(Buffer.from(`${JSON.stringify({ format: "code-butler-rows", version: 2 })}\n`))).toThrow(EncryptionError);
    expect(() => built(stream({ schema: ["table", "a", "create table a(x)"] }).subarray(0, -2))).toThrow("Invalid snapshot row stream");
  });
});

describe("snapshot format v4", () => {
  it("publishes the core as content-defined row stream blocks that materialize into a verified database", async () => {
    const root = project();
    for (let i = 0; i < 30; i++) remember(root, `Decision ${i}: rows are cut on content so inserts only touch nearby blocks.`);
    const captured = await captureSnapshot(root, randomUUID(), 0, undefined, "durable", { rowStream: true });
    expect(captured.snapshot.version).toBe(4);
    const materialized = materializeSnapshot(captured.snapshot, bundleResolver(captured.blocks));
    const path = join(temp(), "memory.sqlite");
    const { writeFileSync } = await import("node:fs"); writeFileSync(path, materialized.files.find(file => file.path === "memory.sqlite")!.data);
    expect(() => verifySnapshotDatabase(captured.snapshot, path)).not.toThrow();
    const core = captured.snapshot.segments.find(segment => segment.kind === "core")!;
    const sizes = objectSizeEstimates(captured.snapshot, Object.fromEntries(core.blocks.map(hash => [hash, hash])));
    expect(sizes.get(core.blocks[0]!)! - 128).toBe(Math.ceil(core.bytes / core.blocks.length));
    rmSync(path, { force: true });
  }, 60000);

  it("reports the same fingerprint from a fingerprint-only capture as from a full one", async () => {
    const root = project();
    remember(root, "Checks that only compare fingerprints skip encoding the core.");
    addSource(root, "conversation-a", "2026-10-14T08:00:00.000Z", "A conversation the fingerprint covers.");
    withStore(root, store => store.db.prepare(`insert into temporary_memories (id, project_id, kind, title, summary, details, related_files_json, evidence_json, confidence, created_at, updated_at, expires_at)
      values (?, ?, 'task_state', 't', 's', 'd', '[]', '[]', 0.5, ?, ?, ?)`).run("temporary-1", root, "2026-10-14T00:00:00.000Z", "2026-10-14T00:00:00.000Z", "2099-01-01T00:00:00.000Z"));
    const full = await captureSnapshot(root, randomUUID(), 0, undefined, "durable", { rowStream: true });
    expect(await captureFingerprint(root)).toBe(full.snapshot.fingerprint);
    remember(root, "A later change moves it.");
    expect(await captureFingerprint(root)).not.toBe(full.snapshot.fingerprint);
  }, 60000);

  it("keeps project memory on v3 unless asked, and reports a newer manifest as needing an upgrade", async () => {
    const root = project();
    const captured = await captureSnapshot(root, randomUUID(), 0);
    expect(captured.snapshot.version).toBe(3);
    const newer = gzipSync(Buffer.from(JSON.stringify({ ...captured.snapshot, version: 5 })));
    expect(() => decodeSnapshot(newer)).toThrow(expect.objectContaining({ state: "incompatible-format" }));
  }, 60000);
});
