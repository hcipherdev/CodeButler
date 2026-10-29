import { createHash, randomUUID } from "node:crypto";
import { purgeRetrieval } from "../retrieval/privacy.js";
import { invalidateHandbookExport } from "../memory/export.js";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";
import { portableProjectConfig } from "../config.js";
import { CURRENT_SCHEMA_VERSION, initializeSchema } from "../storage/migrations.js";
import { verifyDatabaseFile } from "../privacy/backup.js";
import { rebuildSearchIndexes } from "../storage/privacy-maintenance.js";
import { buildDatabaseFromRowStream, encodeRowStream } from "./row-stream.js";
import { installationDeviceId } from "../memory/origin.js";
import { preferIncomingNarrative, serializeProjectSummaryMeta } from "../project-summary/service.js";
import { EncryptionError } from "./crypto-helper.js";
import {
  decodePartition,
  encodePartition,
  exportPartition,
  importPartition,
  PARTITION_SEGMENT_PREFIX,
  partitionLayer,
  partitionSegmentId,
  partitionWriter,
  repairPartitionReferences,
  shareableLayers,
  type PartitionPayload,
  type ShareLocalLayers
} from "./partition.js";
import { assertNoDatabaseHandles, registerDatabaseHandle, withProjectGate } from "./gate.js";
import { atomicJson, atomicWrite, binding, saveBinding, syncDirectory, readJson, sha256, stateDirectory, UUID, type Binding } from "./state.js";

export const MAX_COMPRESSED = 256 * 1024 * 1024;
export const MAX_EXPANDED = 1024 * 1024 * 1024;
const LOCAL_TABLES = ["sync_sources", "sync_cursors", "extraction_jobs", "extraction_status", "branch_triage_reviews", "promotion_decisions", "layer_retention_decisions", "peer_partitions"];
const SQLITE_SIDE_SUFFIXES = ["", "-wal", "-shm"];
/**
 * Payloads travel as content-addressed blocks rather than inside the manifest, so a
 * segment the server already holds is neither uploaded nor downloaded again. The core
 * database is split because it is both the largest payload and the one that changes on
 * almost every sync; a whole-file address would defeat the purpose.
 *
 * 64 KiB (16 SQLite pages) is measured, not guessed. One added memory scatters page
 * writes across the whole file, so block size decides how precisely a delta is
 * captured. On this project's 37.8 MiB database, adding one memory re-sent 43.9% of the
 * compressed payload at 1 MiB blocks, 22.4% at 256 KiB, and 4.5% at 64 KiB — 0.55 MiB
 * instead of 12.32 MiB. Going smaller still saves bytes (2.2% at 16 KiB) but multiplies
 * per-block bookkeeping, so requests are batched rather than blocks made tinier.
 *
 * That measurement is for format v3, which ships the SQLite file. Project memory now
 * ships v4 (see row-stream.ts): page files renumber pages whenever a table grows, so a
 * merge still re-sent ~80% of them, while a row stream cut on content re-sends under 1%.
 * BLOCK_SIZE remains the largest block either format produces.
 */
export const BLOCK_SIZE = 64 * 1024;
export const SMALL_CORE_BLOCK_SIZE = 16 * 1024;
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const CORE_SEGMENT = "core";
const FILE_SEGMENT_PREFIX = "file:";
const segmentSchema = z.object({
  id: z.string().min(1).max(400),
  kind: z.enum(["core", "file", "partition"]),
  /** Logical for `core` (databaseFingerprint), content hash otherwise. */
  fingerprint: SHA256,
  blocks: z.array(SHA256).min(1).max(65536),
  bytes: z.number().int().nonnegative(),
  /** Partitions only: the single installation permitted to write this segment. */
  writerInstallationId: UUID.optional()
});
export type SnapshotSegment = z.infer<typeof segmentSchema>;
const manifestSchema = z.object({
  /** 3: the core segment is a SQLite file. 4: it is a row stream (see row-stream.ts) without search indexes. */
  format: z.literal("code-butler-cloud"), version: z.union([z.literal(3), z.literal(4)]), appVersion: z.literal("1.0.0"),
  schemaVersion: z.number().int().min(1).max(CURRENT_SCHEMA_VERSION), projectId: UUID,
  parentRevision: z.number().int().nonnegative(), installationId: UUID, checkoutId: UUID.optional(),
  fingerprint: SHA256,
  segments: z.array(segmentSchema).min(1).max(20000)
});
export type Snapshot = z.infer<typeof manifestSchema>;
/** A manifest plus the block bytes it references, ready to write to disk. */
export interface MaterializedSnapshot {
  manifest: Snapshot;
  files: Array<{ path: string; data: Buffer }>;
  /** Peer partitions to import read-only; this device's own are never taken back. */
  partitions: PartitionPayload[];
}
export function splitBlocks(bytes: Buffer, blockSize = BLOCK_SIZE): Array<{ checksum: string; data: Buffer }> {
  if (bytes.length === 0) return [{ checksum: sha256(bytes), data: bytes }];
  const blocks: Array<{ checksum: string; data: Buffer }> = [];
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    const data = bytes.subarray(offset, Math.min(offset + blockSize, bytes.length));
    blocks.push({ checksum: sha256(data), data: Buffer.from(data) });
  }
  return blocks;
}
/** Derived from a fixed label so every device cuts identical bytes at identical offsets. */
const GEAR = Uint32Array.from({ length: 256 }, (_, i) => createHash("sha256").update(`code-butler/cdc-gear/${i}`).digest().readUInt32BE(0));
export interface ContentDefinedSizes { min: number; avg: number; max: number }
/**
 * FastCDC-style split: a boundary depends only on the ~32 bytes before it, so inserted
 * or removed pages re-align within a block or two instead of shifting every later
 * fixed-offset block. Readers need no change; they only join blocks by checksum.
 */
export function splitContentDefined(bytes: Buffer, { min, avg, max }: ContentDefinedSizes): Array<{ checksum: string; data: Buffer }> {
  if (!(0 < min && min < avg && avg < max && max <= BLOCK_SIZE)) throw new Error("Invalid content-defined block sizes");
  if (bytes.length === 0) return [{ checksum: sha256(bytes), data: bytes }];
  // The gear hash shifts left, so its top bits cover the most recent bytes. A stricter
  // mask before `avg` and a looser one after it keep block sizes close to `avg`.
  const bits = Math.round(Math.log2(avg)), top = (n: number) => (~0 << (32 - n)) >>> 0;
  const strict = top(bits + 1), loose = top(bits - 1);
  const blocks: Array<{ checksum: string; data: Buffer }> = [];
  for (let start = 0; start < bytes.length;) {
    const end = Math.min(bytes.length, start + max), normal = Math.min(end, start + avg);
    let cut = end, hash = 0;
    for (let i = Math.min(end, start + min); i < end; i++) {
      hash = ((hash << 1) + GEAR[bytes[i]!]!) >>> 0;
      if ((hash & (i < normal ? strict : loose)) === 0) { cut = i + 1; break; }
    }
    const data = Buffer.from(bytes.subarray(start, cut));
    blocks.push({ checksum: sha256(data), data });
    start = cut;
  }
  return blocks;
}
/** Distinct objects one revision may reference (the envelope's limit). */
const OBJECT_LIMIT = 32768;
/**
 * Cuts a v4 core row stream on content, so inserted or removed rows change only the blocks
 * around them. The smallest average that stays inside the object budget wins; measured on
 * real projects, 8 KiB averages re-sent under 1% of a merged snapshot. Past every average,
 * fixed full-size blocks are always within the budget the v3 path already guarantees.
 */
function splitRowStream(bytes: Buffer, budget: number): Array<{ checksum: string; data: Buffer }> {
  for (const avg of [8 * 1024, 16 * 1024, 32 * 1024]) {
    if (bytes.length / avg > budget * 0.75) continue;
    const parts = splitContentDefined(bytes, { min: avg / 4, avg, max: BLOCK_SIZE });
    if (new Set(parts.map(part => part.checksum)).size <= budget) return parts;
  }
  return splitBlocks(bytes, BLOCK_SIZE);
}
/** The SQLite file a v4 core row stream describes; verified afterwards like any received database. */
function databaseFromRowStream(stream: Buffer): Buffer {
  const directory = mkdtempSync(join(tmpdir(), "butler-rows-"));
  try {
    const path = join(directory, "memory.sqlite");
    buildDatabaseFromRowStream(stream, path);
    return readFileSync(path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
export function joinBlocks(segment: SnapshotSegment, resolve: (checksum: string) => Buffer): Buffer {
  const parts = segment.blocks.map(checksum => {
    const data = resolve(checksum);
    // The address is the hash of the plaintext block, so a wrong or corrupted block
    // cannot be silently assembled into a file that then passes file-level checks.
    if (sha256(data) !== checksum) throw new Error("Snapshot block checksum mismatch");
    return data;
  });
  const joined = Buffer.concat(parts);
  if (joined.length !== segment.bytes) throw new Error("Snapshot segment size mismatch");
  return joined;
}
export function segmentPath(segment: SnapshotSegment): string {
  return segment.kind === "core" ? "memory.sqlite" : segment.id.slice(FILE_SEGMENT_PREFIX.length);
}
export function partitionSegments(manifest: Snapshot): SnapshotSegment[] {
  return manifest.segments.filter(segment => segment.kind === "partition");
}
export function fileSegments(manifest: Snapshot): SnapshotSegment[] {
  return manifest.segments.filter(segment => segment.kind !== "partition");
}
/** One small project file from a snapshot, without rebuilding the memory database. */
export function snapshotFile(manifest: Snapshot, resolve: (checksum: string) => Buffer, path: string): Buffer | undefined {
  const segment = fileSegments(manifest).find(item => item.kind !== "core" && segmentPath(item) === path);
  return segment ? joinBlocks(segment, resolve) : undefined;
}
export function coreSegment(manifest: Snapshot): SnapshotSegment {
  const segment = manifest.segments.find(item => item.kind === "core");
  if (!segment) throw new Error("Snapshot database missing");
  return segment;
}
/** Blocks a peer must send us, given what we already hold. */
export function missingBlocks(manifest: Snapshot, holds: (checksum: string) => boolean): string[] {
  return [...new Set(manifest.segments.flatMap(segment => segment.blocks))].filter(checksum => !holds(checksum));
}

/**
 * A manifest and its blocks in one file. Requests ship blocks individually so the
 * server can dedupe them, but retained pending and conflict copies must stay
 * self-contained: a recovery file that only references blocks recovers nothing.
 */
export interface SnapshotBundle { manifest: Snapshot; blocks: Map<string, Buffer> }
const bundleSchema = z.object({
  manifest: z.unknown(),
  blocks: z.record(SHA256, z.string())
});
export function encodeBundle(bundle: SnapshotBundle): Buffer {
  const blocks: Record<string, string> = {};
  for (const [checksum, data] of bundle.blocks) blocks[checksum] = data.toString("base64");
  const encoded = Buffer.from(JSON.stringify({ manifest: bundle.manifest, blocks }));
  if (encoded.length > MAX_EXPANDED) throw new Error("Encoded snapshot exceeds expanded limit");
  const bytes = gzipSync(encoded);
  if (bytes.length > MAX_COMPRESSED) throw new Error("Snapshot exceeds compressed limit");
  return bytes;
}
export function decodeBundle(bytes: Buffer, platform: string = process.platform): SnapshotBundle {
  if (bytes.length > MAX_COMPRESSED) throw new Error("Snapshot exceeds compressed limit");
  const parsed = bundleSchema.parse(JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED }).toString()));
  const manifest = decodeSnapshot(gzipSync(Buffer.from(JSON.stringify(parsed.manifest))), platform);
  const blocks = new Map<string, Buffer>();
  for (const [checksum, encoded] of Object.entries(parsed.blocks)) {
    const data = Buffer.from(encoded, "base64");
    if (sha256(data) !== checksum) throw new Error("Snapshot block checksum mismatch");
    blocks.set(checksum, data);
  }
  return { manifest, blocks };
}
export function bundleResolver(blocks: Map<string, Buffer>): (checksum: string) => Buffer {
  return checksum => {
    const data = blocks.get(checksum);
    if (!data) throw new Error("Snapshot block missing");
    return data;
  };
}
export function excluded(path: string): boolean {
  if(path==="handbook-export.meta.json"||path==="handbook"||path.startsWith("handbook/"))return true;
  if (path === "setup.meta.json") return true;
  const parts = path.split("/");
  return parts.some(p => p === "config.local.json" || p === "logs" || p === "backups" || p === "staging" || p.startsWith(".cloud") || p === ".foreground-intents" || p === "gate-timing.json" || p === "watcher-timing.json" || p === "cloud" || p === "device.json" || (p.startsWith(".env") && p !== ".env.example") || p.endsWith(".lock") || p.endsWith(".tmp") || p === ".DS_Store") ||
    /^memory\.sqlite(?:-|\.)/.test(path) ||
    /^memory-local\.sqlite(?:$|-|\.)/.test(path) || parts.includes("retrieval");
}
export function validArchivePath(path: string, platform: string = process.platform): void {
  if (!path || path.includes("\\") || path.startsWith("/") || path.includes("\0") || path.split("/").some(p => !p || p === "." || p === "..") || /^[a-z]:/i.test(path)) throw new Error("Invalid snapshot path");
  if (platform === "win32" && path.split("/").some(p => /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error("Snapshot filename cannot be represented on Windows");
}
function filesIn(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const result: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (excluded(relative)) continue;
    validArchivePath(relative);
    const stat = lstatSync(join(dir, name));
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Unsupported project file: ${relative}`);
    if (stat.isDirectory()) result.push(...filesIn(join(dir, name), relative)); else result.push(relative);
  }
  return result;
}
type Config = Record<string, any>;
export function portableConfig(config: Config): Config {
  return portableProjectConfig(config);
}

function assertPortableConfigBytes(bytes: Buffer): void {
  const config = JSON.parse(bytes.toString()) as Config;
  if (!sameJson(config, portableConfig(config))) throw new Error("Snapshot contains nonportable configuration");
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) result[key] = canonicalJson(object[key]);
  return result;
}
function quote(name: string): string { return `"${name.replaceAll('"', '""')}"`; }

/**
 * One layer selector drives every half of the layer boundary: stripping non-core rows
 * from a snapshot, exporting one partition, importing a peer's partition, and keeping
 * this device's own rows across a restore. Passing the predicate in rather than
 * hardcoding `layer <> 'core'` is what keeps those four from drifting apart.
 */
export const NON_CORE = "layer <> 'core'";
export function layerIs(layer: string): string {
  return `layer = '${layer.replaceAll("'", "''")}'`;
}
function layerRowSpec(match: string): ReadonlyArray<readonly [string, string]> {
  const memories = `select id from memories where ${match}`;
  const candidates = `select id from memory_candidates where ${match}`;
  const temporary = `select id from temporary_memories where ${match}`;
  /** rememberProjectMemory gives a non-core memory a dedicated source row holding its full text. */
  const sources = "select id from local_layer_sources";
  const chunks = `select id from chunks where source_id in (${sources})`;
  const ownedByMemory = `(owner_kind = 'memory' and owner_id in (${memories})) or (owner_kind = 'chunk' and owner_id in (${chunks}))`;
  /**
   * Children first, so each predicate still resolves while the list is walked and
   * dependents are gone before their parents. Every dependent is listed explicitly
   * rather than relying on `on delete cascade`, so the result does not depend on
   * whether a given connection enforces foreign keys.
   *
   * The soft-reference tables (`memory_links`, `embedding_*`) carry no foreign key
   * but do feed `databaseFingerprint`, so leaving them behind would upload content
   * derived from device-local memories.
   */
  return [
    ["memory_events", match], ["memory_topic_links", match], ["memory_topics", match],
    ["memory_review_resolution_compensations", match],
    ["memory_review_resolutions", match],
    ["memory_relations", `from_memory_id in (${memories}) or to_memory_id in (${memories})`],
    ["memory_links", `(owner_kind = 'memory' and owner_id in (${memories})) or (owner_kind = 'candidate' and owner_id in (${candidates}))`],
    ["embedding_jobs", ownedByMemory],
    ["embedding_vectors", ownedByMemory],
    ["temporary_memory_links", `memory_id in (${temporary})`],
    ["temporary_memories_fts", `memory_id in (${temporary})`],
    ["temporary_memories", match],
    ["memory_candidates", match],
    ["memories", match],
    ["chunks_fts", `source_id in (${sources})`],
    ["relations", `from_id in (${sources}) or to_id in (${sources})`],
    ["chunks", `source_id in (${sources})`],
    ["sources", `id in (${sources})`]
  ];
}
const LOCAL_LAYER_ROWS = layerRowSpec(NON_CORE);

const coreManualSourceOwners = `
  (owner_kind = 'memory' and owner_id in (select id from memories where layer = 'core')) or
  (owner_kind = 'candidate' and owner_id in (select id from memory_candidates where layer = 'core'))
`;

function prepareLocalLayerSources(db: DatabaseSync, match: string = NON_CORE): void {
  const memoryOwners = `
    (owner_kind = 'memory' and owner_id in (select id from memories where ${match})) or
    (owner_kind = 'candidate' and owner_id in (select id from memory_candidates where ${match}))
  `;
  db.exec("drop table if exists temp.local_layer_sources");
  db.exec("create temp table local_layer_sources(id text primary key)");
  db.exec(`
    insert or ignore into local_layer_sources(id)
    select distinct target_id
    from memory_links
    where target_id like 'manual-memory:%'
      and (${memoryOwners})
      and not exists (
        select 1
        from memory_links core_owner
        where core_owner.target_id = memory_links.target_id
          and (${coreManualSourceOwners.replaceAll("owner_kind", "core_owner.owner_kind").replaceAll("owner_id", "core_owner.owner_id")})
      )
  `);
  // A layer-scoped export must not claim another layer's dedicated source rows, so the
  // id-pattern sweep only applies when stripping everything non-core.
  if (match !== NON_CORE) return;
  db.exec(`
    insert or ignore into local_layer_sources(id)
    select sources.id
    from sources
    where sources.id like 'manual-memory:%:layer:%'
      and not exists (
        select 1
        from memory_links core_owner
        where core_owner.target_id = sources.id
          and (${coreManualSourceOwners.replaceAll("owner_kind", "core_owner.owner_kind").replaceAll("owner_id", "core_owner.owner_id")})
      )
  `);
}

/** Drop everything device-local so only `core` memories cross devices. */
export function deleteNonCoreRows(db: DatabaseSync): void {
  prepareLocalLayerSources(db);
  db.exec(`update memory_candidates set promoted_memory_id = null where promoted_memory_id in (select id from memories where ${NON_CORE})`);
  for (const [table, where] of LOCAL_LAYER_ROWS) db.exec(`delete from ${quote(table)} where ${where}`);
}

/**
 * SQL for "non-core rows this device is responsible for": everything non-core except
 * layers previously imported from a peer. Membership is tracked rather than inferred
 * from the layer name, because a locally created layer may legitimately carry another
 * device's id (a user can set one explicitly) and must not be deleted on restore,
 * while a partition a peer stopped publishing must not linger forever.
 */
export function localLayerPredicate(peerLayers: readonly string[] = []): string {
  if (peerLayers.length === 0) return NON_CORE;
  const list = peerLayers.map(layer => `'${layer.replaceAll("'", "''")}'`).join(", ");
  return `layer <> 'core' and layer not in (${list})`;
}

function readPeerPartitionState(db: DatabaseSync): Array<{ segment_id: string; fingerprint: string }> {
  try {
    return db.prepare("select segment_id, fingerprint from peer_partitions").all() as Array<{ segment_id: string; fingerprint: string }>;
  } catch {
    return [];
  }
}

/** Non-core layers this device previously imported from another device. */
export function importedPeerLayers(db: DatabaseSync): string[] {
  try {
    return (db.prepare("select layer from peer_partitions order by layer").all() as Array<{ layer: string }>).map(row => row.layer);
  } catch {
    // A database that predates migration 17 has no peer state to exclude.
    return [];
  }
}

/** Carry this device's local layers across a restore, mirroring the LOCAL_TABLES copy. */
export function preserveLocalLayers(original: DatabaseSync, target: DatabaseSync, peerLayers: readonly string[] = []): void {
  const match = localLayerPredicate(peerLayers);
  const spec = layerRowSpec(match);
  prepareLocalLayerSources(original, match);
  prepareLocalLayerSources(target, match);
  // Rows arrive before the parents they point at, and a local candidate may reference a
  // core memory the sender retracted. Defer enforcement to the repair step below and the
  // foreign_key_check that verifyDatabaseFile runs on the finished file.
  target.exec("PRAGMA foreign_keys = OFF");
  for (const [table, where] of spec) target.exec(`delete from ${quote(table)} where ${where}`);
  for (const [table, where] of [...spec].reverse()) {
    for (const row of original.prepare(`select * from ${quote(table)} where ${where}`).all()) {
      const keys = Object.keys(row);
      target.prepare(`insert into ${quote(table)} (${keys.map(quote)}) values (${keys.map(() => "?")})`).run(...keys.map(k => row[k]!));
    }
  }
  // The other device may have retracted a core memory this device still points at.
  // foreign_key_check would reject the restore, so repair rather than fail.
  target.exec("update memory_candidates set promoted_memory_id = null where promoted_memory_id is not null and promoted_memory_id not in (select id from memories)");
  target.exec("delete from memory_relations where from_memory_id not in (select id from memories) or to_memory_id not in (select id from memories)");
  target.exec("delete from temporary_memory_links where memory_id not in (select id from temporary_memories)");
  // Sources and chunks need no repair: the incoming snapshot is already verified
  // FK-consistent, and the copy above takes both from the same complete database.
}
export function databaseFingerprint(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const names = (db.prepare("pragma table_list").all() as Array<{ name: string; type: string; schema: string }>).filter(t => t.schema === "main" && t.type === "table" && !t.name.startsWith("sqlite_") && ![...LOCAL_TABLES, "operation_log", "schema_migrations", "retrieval_identity", "retrieval_changes"].includes(t.name)).map(t => t.name).sort();
    // The hash of JSON.stringify([[name, columns, sortedRows], …]), fed as it is produced rather than built
    // as one string about twice the size of the database: the same value with far less memory and copying.
    const hash = createHash("sha256");
    let pending = "[";
    const feed = (text: string) => { pending += text; if (pending.length >= 1 << 20) { hash.update(pending); pending = ""; } };
    names.forEach((name, table) => {
      const columns = (db.prepare(`pragma table_info(${quote(name)})`).all() as Array<{ name: string }>).map(column => column.name);
      const expressions = columns.map((column, index) => {
        const value = name === "temporary_memories" && column === "project_id" ? "'@project'" : quote(column);
        return `typeof(${value}) || ':' || coalesce(hex(cast(${value} as blob)), '') as c${index}`;
      });
      const rows: string[] = [];
      for (const row of db.prepare(`select ${expressions.join(", ")} from ${quote(name)}`).iterate()) {
        rows.push(JSON.stringify(columns.map((_column, index) => (row as Record<string, string>)[`c${index}`])));
      }
      rows.sort();
      feed(`${table ? "," : ""}[${JSON.stringify(name)},${JSON.stringify(columns)},[`);
      rows.forEach((row, index) => feed(`${index ? "," : ""}${JSON.stringify(row)}`));
      feed("]]");
    });
    hash.update(`${pending}]`);
    return hash.digest("hex");
  } finally { db.close(); }
}
export interface CaptureResult {
  snapshot: Snapshot;
  /** Gzipped manifest: the publish request body, and the retained pending bytes. */
  bytes: Buffer;
  /** Plaintext block payloads, keyed by content address. */
  blocks: Map<string, Buffer>;
  /**
   * Peer partitions this device has already imported, by layer and fingerprint. A
   * peer's partition changing leaves the core fingerprint untouched by design, so
   * without this the sync decision has no way to notice that a pull is due.
   */
  peers: Map<string, string>;
}
export interface CaptureStageHooks {
  afterCopy?: (() => void | Promise<void>) | undefined;
  /** Write format v4: the core as a row stream in content-defined blocks. Project memory sync only. */
  rowStream?: boolean | undefined;
}
/** Copies the live database into `temporary` under the project gate, as one consistent read. */
async function copyLiveDatabase(root: string, temporary: string): Promise<void> {
  const dir = join(root, ".code-butler");
  await withProjectGate(root, async () => {
    const release = registerDatabaseHandle(dir);
    try {
      const source = new DatabaseSync(join(dir, "memory.sqlite"), { readOnly: true });
      try {
        source.exec("begin");source.prepare("select count(*) from sqlite_master").get();
        await backup(source, temporary);
      } finally {if(source.isTransaction) source.exec("rollback");source.close();}
    } finally { release(); }
  }, { name: "Cloud snapshot copy" });
}
/** Leaves only shared core content in a captured copy whose device-local tables are already empty. */
function stripToCore(db: DatabaseSync): void {
  deleteNonCoreRows(db);
  // Core history may retain an unavailable private link, never its private explanation.
  db.exec("update memory_events set reason='' where layer='core' and related_layer is not null and related_layer<>'core'");
}
/**
 * The fingerprint captureSnapshot reports, without exporting partitions or encoding and splitting the core:
 * for checks that only ask whether local memory changed since an earlier capture. Partitions never count
 * toward the fingerprint, so which layers are shared does not matter here.
 */
export async function captureFingerprint(root: string): Promise<string> {
  const dir = join(root, ".code-butler");
  const temporary = join(stateDirectory(root), `capture-${process.pid}-${randomUUID()}.sqlite`);
  mkdirSync(stateDirectory(root), { recursive: true, mode: 0o700 });
  cleanAbandonedCaptureFiles(stateDirectory(root));
  try {
    await copyLiveDatabase(root, temporary);
    verifyDatabaseFile(temporary);
    const db = new DatabaseSync(temporary);
    try {
      for (const name of LOCAL_TABLES) db.exec(`delete from ${quote(name)}`);
      stripToCore(db);
    } finally { db.close(); }
    verifyDatabaseFile(temporary);
    const hashes = filesIn(dir).map(path => [path, path === "memory.sqlite" ? databaseFingerprint(temporary) : sha256(readFileSync(join(dir, path)))]);
    return sha256(JSON.stringify(hashes));
  } finally { removeSqliteTempFiles(temporary); }
}
export async function captureSnapshot(
  root: string,
  projectId: string,
  parentRevision: number,
  checkoutId?: string,
  share: ShareLocalLayers = "durable",
  hooks: CaptureStageHooks = {}
): Promise<CaptureResult> {
  const dir = join(root, ".code-butler");
  const temporary = join(stateDirectory(root), `capture-${process.pid}-${randomUUID()}.sqlite`);
  mkdirSync(stateDirectory(root), { recursive: true, mode: 0o700 });
  cleanAbandonedCaptureFiles(stateDirectory(root));
  const copyStarted = performance.now();
  try { await copyLiveDatabase(root, temporary); }
  catch (error) { removeSqliteTempFiles(temporary); throw error; }
  const copyMs = performance.now() - copyStarted;
  try {
    await hooks.afterCopy?.();
    const exportStarted = performance.now();
    verifyDatabaseFile(temporary);
    // Partitions are read from the same consistent backup copy, before the non-core
    // rows are stripped from it: one capture, one point in time, two payloads.
    const deviceId = installationDeviceId();
    const partitions: Array<{ layer: string; payload: Buffer }> = [];
    const peers = new Map<string, string>();
    const db = new DatabaseSync(temporary);
    try {
      for (const row of readPeerPartitionState(db)) peers.set(row.segment_id, row.fingerprint);
      for (const name of LOCAL_TABLES) db.exec(`delete from ${quote(name)}`);
      for (const layer of shareableLayers(db, deviceId, share)) {
        prepareLocalLayerSources(db, layerIs(layer));
        partitions.push({
          layer,
          payload: encodePartition(exportPartition(db, layer, layerRowSpec(layerIs(layer)), share))
        });
      }
      stripToCore(db);
      if(db.prepare("select 1 from sqlite_master where name='retrieval_changes'").get()) {
        // A row stream carries no free pages, so only a shipped page file needs the VACUUM to drop deleted content.
        db.exec(`pragma secure_delete=ON; delete from retrieval_changes; update retrieval_identity set id='snapshot'${hooks.rowStream ? "" : "; vacuum"}`);
      }
    } finally { db.close(); }
    const exportMs = performance.now() - exportStarted;
    // Re-verify: the deletes above are the only mutation, so a dangling reference
    // introduced here must surface now rather than on the receiving device.
    verifyDatabaseFile(temporary);
    const hashStarted = performance.now();
    const logicalHash = databaseFingerprint(temporary);
    const segments: SnapshotSegment[] = [];
    const blocks = new Map<string, Buffer>();
    const hashes: Array<[string, string]> = [];
    let total = 0;
    const partitionBlocks = partitions.reduce((count, partition) => count + Math.ceil(partition.payload.length / BLOCK_SIZE), 0);
    for (const path of filesIn(dir)) {
      const bytes = path === "memory.sqlite" ? hooks.rowStream ? encodeRowStream(temporary) : readFileSync(temporary) : readFileSync(join(dir, path));
      if (path === "config.json") assertPortableConfigBytes(bytes);
      total += bytes.length;
      if (total > MAX_EXPANDED) throw new Error("Snapshot exceeds expanded limit");
      const core = path === "memory.sqlite";
      // Objects the rest of the snapshot may still need: later files up to the expanded limit, and partitions.
      const coreBudget = OBJECT_LIMIT - Math.ceil((MAX_EXPANDED - bytes.length) / BLOCK_SIZE) - partitionBlocks;
      const smallCoreFits = core && bytes.length <= 128 * 1024 * 1024 && Math.ceil(bytes.length / SMALL_CORE_BLOCK_SIZE) <= coreBudget;
      const parts = core && hooks.rowStream ? splitRowStream(bytes, coreBudget) : splitBlocks(bytes, smallCoreFits ? SMALL_CORE_BLOCK_SIZE : BLOCK_SIZE);
      for (const block of parts) blocks.set(block.checksum, block.data);
      const fingerprint = core ? logicalHash : sha256(bytes);
      segments.push({
        id: core ? CORE_SEGMENT : `${FILE_SEGMENT_PREFIX}${path}`,
        kind: core ? "core" : "file",
        fingerprint,
        blocks: parts.map(block => block.checksum),
        bytes: bytes.length
      });
      // Unchanged from v2 on purpose: the fingerprint keeps meaning "the portable
      // content of this project", so conflict detection is not silently redefined.
      hashes.push([path, fingerprint]);
    }
    // Partitions ride alongside the core payload but stay out of `hashes`: the
    // fingerprint must keep meaning "shared project content", so a device's own local
    // writes still cannot manufacture a conflict for anyone.
    for (const { layer, payload } of partitions) {
      const parts = splitBlocks(payload);
      for (const block of parts) blocks.set(block.checksum, block.data);
      segments.push({
        id: partitionSegmentId(checkoutId ?? deviceId, layer),
        kind: "partition",
        fingerprint: sha256(payload),
        blocks: parts.map(block => block.checksum),
        bytes: payload.length,
        writerInstallationId: deviceId
      });
    }
    const snapshot: Snapshot = { format: "code-butler-cloud", version: hooks.rowStream ? 4 : 3, appVersion: "1.0.0", schemaVersion: CURRENT_SCHEMA_VERSION, projectId, parentRevision, installationId: deviceId, ...(checkoutId ? { checkoutId: UUID.parse(checkoutId) } : {}), fingerprint: sha256(JSON.stringify(hashes)), segments };
    const encoded = Buffer.from(JSON.stringify(snapshot));
    if (encoded.length > MAX_EXPANDED) throw new Error("Encoded snapshot exceeds expanded limit");
    const bytes = gzipSync(encoded);
    if (bytes.length > MAX_COMPRESSED) throw new Error("Snapshot exceeds compressed limit");
    try { atomicJson(join(stateDirectory(root), "snapshot-timing.json"), {
      recordedAt: new Date().toISOString(), copyMs: Math.round(copyMs), exportMs: Math.round(exportMs),
      hashAndCompressionMs: Math.round(performance.now() - hashStarted)
    }); } catch { /* Diagnostics must not mask a successful capture. */ }
    return { snapshot, bytes, blocks, peers };
  } finally { removeSqliteTempFiles(temporary); }
}

function cleanAbandonedCaptureFiles(directory: string): void {
  const names = readdirSync(directory);
  for (const name of names) {
    const match = /^capture-(\d+)-[a-f0-9-]{36}\.sqlite(?:-wal|-shm)?$/i.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try { process.kill(pid, 0); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
    try { rmSync(join(directory, name), { force: true }); }
    catch { /* Cleanup is best effort and never blocks a fresh capture. */ }
  }
}

function removeSqliteTempFiles(path: string): void {
  for (const suffix of SQLITE_SIDE_SUFFIXES) rmSync(`${path}${suffix}`, { force: true });
}
/**
 * Validates the manifest alone. Payload checks that used to run here now run in
 * `materializeSnapshot`, because the bytes arrive separately; both halves must run
 * before anything is written, and `publish` runs both server-side too.
 */
export function decodeSnapshot(bytes: Buffer, platform: string = process.platform): Snapshot {
  if (bytes.length > MAX_COMPRESSED) throw new Error("Snapshot exceeds compressed limit");
  const raw: unknown = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED }).toString());
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const format = (raw as { format?: unknown; version?: unknown });
    if (format.format === "code-butler-cloud" && typeof format.version === "number" && format.version > 4) throw new EncryptionError("incompatible-format");
    const version = (raw as { schemaVersion?: unknown }).schemaVersion;
    if (typeof version === "number" && version > CURRENT_SCHEMA_VERSION) {
      throw new EncryptionError("upgrade-required", {
        remoteSchemaVersion: version,
        supportedSchemaVersion: CURRENT_SCHEMA_VERSION
      });
    }
  }
  const snapshot = manifestSchema.parse(raw);
  const seen = new Set<string>();
  const paths = new Set(fileSegments(snapshot).map(segmentPath));
  let total = 0;
  let cores = 0;
  const ids = new Set<string>();
  for (const segment of snapshot.segments) {
    if (ids.has(segment.id)) throw new Error("Snapshot contains colliding paths"); ids.add(segment.id);
    if (segment.kind === "partition") {
      // A partition is single-writer by construction: its layer names the only
      // installation allowed to write it, and the segment must agree with the layer.
      if (!segment.id.startsWith(PARTITION_SEGMENT_PREFIX)) throw new Error("Invalid snapshot segment id");
      const writer = partitionWriter(partitionLayer(segment.id));
      if (!writer || writer !== segment.writerInstallationId) throw new Error("Invalid snapshot partition writer");
      total += segment.bytes;
      if (total > MAX_EXPANDED) throw new Error("Invalid snapshot checksum or size");
      continue;
    }
    if (segment.kind === "core") {
      cores += 1;
      if (segment.id !== CORE_SEGMENT) throw new Error("Invalid snapshot segment id");
    } else if (!segment.id.startsWith(FILE_SEGMENT_PREFIX)) {
      throw new Error("Invalid snapshot segment id");
    }
    const path = segmentPath(segment);
    validArchivePath(path, platform);
    const components = path.split("/");
    if (components.slice(0, -1).some((_p, i) => paths.has(components.slice(0, i + 1).join("/")))) throw new Error("Snapshot file/directory collision");
    if (excluded(path) && path !== "memory.sqlite") throw new Error("Snapshot contains excluded files");
    const key = platform === "linux" ? path : path.normalize("NFC").toLowerCase();
    if (seen.has(key)) throw new Error("Snapshot contains colliding paths"); seen.add(key);
    total += segment.bytes;
    if (total > MAX_EXPANDED) throw new Error("Invalid snapshot checksum or size");
    // A file is one block, so its content address and its fingerprint are the same
    // hash; only the core database has a separate logical fingerprint.
    if (segment.kind === "file" && (segment.blocks.length !== 1 || segment.blocks[0] !== segment.fingerprint)) {
      throw new Error("Invalid snapshot checksum or size");
    }
  }
  if (cores !== 1 || !seen.has("memory.sqlite")) throw new Error("Snapshot database missing");
  return snapshot;
}
/**
 * Turns a validated manifest plus its blocks into the files to write. Runs the payload
 * checks the manifest cannot carry: block addresses, segment sizes, and configuration
 * portability.
 */
export function materializeSnapshot(
  manifest: Snapshot,
  resolve: (checksum: string) => Buffer,
  deviceId?: string
): MaterializedSnapshot {
  const files = fileSegments(manifest).map(segment => ({
    path: segmentPath(segment),
    data: segment.kind === "core" && manifest.version === 4 ? databaseFromRowStream(joinBlocks(segment, resolve)) : joinBlocks(segment, resolve)
  }));
  const config = files.find(file => file.path === "config.json");
  if (config) assertPortableConfigBytes(config.data);
  const own = deviceId ?? installationDeviceId();
  const partitions = partitionSegments(manifest)
    // This device's live rows are authoritative for its own layers, so a published
    // copy of them is ignored rather than restored over the top.
    .filter(segment => segment.writerInstallationId !== own)
    .map(segment => {
      const payload = decodePartition(joinBlocks(segment, resolve));
      if (payload.layer !== partitionLayer(segment.id)) throw new Error("Snapshot partition layer mismatch");
      return payload;
    });
  return { manifest, files, partitions };
}
interface Journal { previousBinding?: Binding; files: Array<{ path: string; data: string }>; incoming: string[] }
export function recoverApply(root: string): void {
  const path = join(stateDirectory(root), "apply-journal.json");
  const journal = readJson<Journal>(path); if (!journal) return;
  assertNoDatabaseHandles(root);
  const dir = join(root, ".code-butler");
  for (const name of journal.incoming) { validArchivePath(name); rmSync(join(dir, name), { force: true }); }
  for (const file of journal.files) { validArchivePath(file.path); mkdirSync(join(dir, file.path, ".."), { recursive: true }); atomicWrite(join(dir, file.path), Buffer.from(file.data, "base64")); }
  for (const suffix of ["-wal", "-shm"]) rmSync(join(dir, `memory.sqlite${suffix}`), { force: true });
  verifyDatabaseFile(join(dir, "memory.sqlite"));
  if (journal.previousBinding) saveBinding(root, journal.previousBinding);
  rmSync(path); syncDirectory(stateDirectory(root));
}
export function applySnapshot(root: string, materialized: MaterializedSnapshot): void {
  assertNoDatabaseHandles(root);
  const snapshot = materialized.manifest;
  const dir = join(root, ".code-butler"); const state = stateDirectory(root);
  mkdirSync(state, { recursive: true });
  const staged = join(state, `restore-${randomUUID()}.sqlite`);
  writeFileSync(staged, materialized.files.find(f => f.path === "memory.sqlite")!.data);
  try {
    verifyAndMigrateSnapshotDatabase(snapshot, staged);
    const target = new DatabaseSync(staged);
    const original = new DatabaseSync(join(dir, "memory.sqlite"));
    try {
      const existingTombstones=new Set((original.prepare("select source_type,source_id_hash from source_tombstones").all() as Array<{source_type:string;source_id_hash:string}>).map(r=>JSON.stringify(r)));
      if((target.prepare("select source_type,source_id_hash from source_tombstones").all() as Array<{source_type:string;source_id_hash:string}>).some(r=>!existingTombstones.has(JSON.stringify(r)))) {purgeRetrieval(root);invalidateHandbookExport(root);}
      // A restored canonical database has a new identity even if its journal sequence matches.
      target.prepare("update retrieval_identity set id=?").run(randomUUID());
      const checkpoint = original.prepare("pragma wal_checkpoint(TRUNCATE)").get() as { busy: number };
      if (checkpoint.busy) throw new Error("Cloud restore deferred: SQLite is busy");
      for (const name of LOCAL_TABLES) {
        target.exec(`delete from ${quote(name)}`);
        for (const row of original.prepare(`select * from ${quote(name)}`).all()) {
          const keys = Object.keys(row); target.prepare(`insert into ${quote(name)} (${keys.map(quote)}) values (${keys.map(() => "?")})`).run(...keys.map(k => row[k]!));
        }
      }
      // Layers imported from a peer before, plus the ones arriving now: neither set is
      // this device's own, so neither is carried across from the local database.
      const incoming = new Set(materialized.partitions.map(partition => partition.layer));
      const peerLayers = [...new Set([...importedPeerLayers(original), ...incoming])];
      preserveLocalLayers(original, target, peerLayers);
      // Peer partitions are read-only here: replaced wholesale from the manifest, then
      // repaired rather than rejected when they point at core rows we do not have.
      target.exec("delete from peer_partitions");
      const importedAt = new Date().toISOString();
      for (const partition of materialized.partitions) {
        importPartition(target, partition, layerRowSpec(layerIs(partition.layer)));
        const segment = partitionSegments(snapshot).find(item => partitionLayer(item.id) === partition.layer);
        target.prepare("insert or replace into peer_partitions(segment_id, layer, writer_installation_id, fingerprint, imported_at) values (?, ?, ?, ?, ?)")
          .run(segment?.id ?? partition.layer, partition.layer, segment?.writerInstallationId ?? "", segment?.fingerprint ?? "", importedAt);
      }
      if (materialized.partitions.length > 0) repairPartitionReferences(target);
      target.prepare("update temporary_memories set project_id = ?").run(root);
      // A v4 snapshot carries no search index, and a v3 one indexed another checkout's rows; rebuild from what was restored.
      rebuildSearchIndexes(target);
    } finally { original.close(); target.close(); }
    const narrative = incomingNarrative(root, materialized.files);
    const incoming = materialized.files.filter(file => !narrative.keepLocal || !NARRATIVE_FILES.has(file.path))
      .map(file => file.path === NARRATIVE_META && narrative.meta ? { ...file, data: narrative.meta } : file);
    const existing = filesIn(dir);
    const previousBinding = binding(root);
    const journal: Journal = { ...(previousBinding ? { previousBinding } : {}), files: existing.map(path => ({ path, data: readFileSync(join(dir, path)).toString("base64") })), incoming: incoming.map(f => f.path) };
    atomicJson(join(state, "recovery.json"), journal);
    atomicJson(join(state, "apply-journal.json"), journal);
    const local = readJson<Config>(join(dir, "config.json")) ?? {};
    try {
      for (const path of existing) if (!narrative.keepLocal || !NARRATIVE_FILES.has(path)) rmSync(join(dir, path), { force: true });
      for (const file of incoming) {
        mkdirSync(join(dir, file.path, ".."), { recursive: true });
        const data = file.path === "memory.sqlite" ? readFileSync(staged) : file.data;
        atomicWrite(join(dir, file.path), data);
      }
      // A snapshot without config still preserves local configuration.
      if (!materialized.files.some(f => f.path === "config.json")) atomicJson(join(dir, "config.json"), local);
      for (const suffix of ["-wal", "-shm"]) rmSync(join(dir, `memory.sqlite${suffix}`), { force: true });
      verifyDatabaseFile(join(dir, "memory.sqlite")); rmSync(join(state, "apply-journal.json")); syncDirectory(state);
    } catch (error) { recoverApply(root); throw error; }
  } finally { rmSync(staged, { force: true }); }
}

const NARRATIVE_SUMMARY = "project-summary.md", NARRATIVE_META = "project-summary.meta.json";
const NARRATIVE_FILES = new Set([NARRATIVE_SUMMARY, NARRATIVE_META]);

/**
 * The narrative is not replaced wholesale like the rest: this device's own is kept, check time included,
 * unless the incoming one was built from later commits. A taken pair gets this checkout's summary path.
 */
function incomingNarrative(root: string, files: MaterializedSnapshot["files"]): { keepLocal: boolean; meta?: Buffer } {
  const file = (path: string) => files.find(item => item.path === path)?.data;
  // With nothing local to keep, the incoming files land as they are unless they can be taken properly.
  const hasLocal = existsSync(join(root, ".code-butler", NARRATIVE_SUMMARY));
  try {
    const decision = preferIncomingNarrative(root, { summary: file(NARRATIVE_SUMMARY), meta: file(NARRATIVE_META) });
    return decision.take ? { keepLocal: false, meta: Buffer.from(serializeProjectSummaryMeta(decision.meta)) } : { keepLocal: hasLocal };
  } catch {
    // Failing to decide leaves the local narrative, which the next daily refresh rewrites if it is stale.
    return { keepLocal: hasLocal };
  }
}

/** Verify the authored bytes first, then upgrade only the private staged copy. */
export function verifyAndMigrateSnapshotDatabase(snapshot: Snapshot, databasePath: string): boolean {
  verifySnapshotDatabase(snapshot, databasePath);
  if (snapshot.schemaVersion === CURRENT_SCHEMA_VERSION) return false;
  const db = new DatabaseSync(databasePath);
  try {
    initializeSchema(db, databasePath, { backupRetention: 0, createBackup: false });
  } finally {
    db.close();
  }
  verifyDatabaseFile(databasePath);
  return true;
}

export function verifySnapshotDatabase(snapshot: Snapshot, databasePath: string): void {
  verifyDatabaseFile(databasePath);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db.prepare("select max(version) as version from schema_migrations").get() as { version: number };
    if (row.version !== snapshot.schemaVersion) throw new Error("Snapshot schema version mismatch");
  } finally { db.close(); }
  const core = coreSegment(snapshot);
  const logical = databaseFingerprint(databasePath);
  if (logical !== core.fingerprint) throw new Error("Snapshot logical fingerprint mismatch");
  const hashes = fileSegments(snapshot).map(segment => [segmentPath(segment), segment.fingerprint]);
  if (sha256(JSON.stringify(hashes)) !== snapshot.fingerprint) throw new Error("Snapshot logical fingerprint mismatch");
}
