import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";
import { CURRENT_SCHEMA_VERSION } from "../storage/migrations.js";
import { verifyDatabaseFile } from "../privacy/backup.js";
import { installationDeviceId } from "../memory/origin.js";
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
import { assertNoDatabaseHandles } from "./gate.js";
import { atomicJson, atomicWrite, binding, saveBinding, syncDirectory, readJson, sha256, stateDirectory, UUID, type Binding } from "./state.js";

export const MAX_COMPRESSED = 256 * 1024 * 1024;
export const MAX_EXPANDED = 1024 * 1024 * 1024;
const LOCAL_TABLES = ["sync_sources", "sync_cursors", "branch_triage_reviews", "promotion_decisions", "layer_retention_decisions", "peer_partitions"];
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
 */
export const BLOCK_SIZE = 64 * 1024;
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
  format: z.literal("code-butler-cloud"), version: z.literal(3), appVersion: z.literal("1.0.0"),
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
export function splitBlocks(bytes: Buffer): Array<{ checksum: string; data: Buffer }> {
  if (bytes.length === 0) return [{ checksum: sha256(bytes), data: bytes }];
  const blocks: Array<{ checksum: string; data: Buffer }> = [];
  for (let offset = 0; offset < bytes.length; offset += BLOCK_SIZE) {
    const data = bytes.subarray(offset, Math.min(offset + BLOCK_SIZE, bytes.length));
    blocks.push({ checksum: sha256(data), data: Buffer.from(data) });
  }
  return blocks;
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
  const parts = path.split("/");
  return parts.some(p => p === "logs" || p === "backups" || p === "staging" || p.startsWith(".cloud") || p === "cloud" || p === "device.json" || (p.startsWith(".env") && p !== ".env.example") || p.endsWith(".lock") || p.endsWith(".tmp") || p === ".DS_Store") || /^memory\.sqlite(?:-|\.)/.test(path);
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
  const result: Config = {};
  for (const key of ["promotion", "deterministic", "privacy", "retention", "sync"]) if (config[key] !== undefined) result[key] = config[key];
  if (config.retrieval) result.retrieval = config.retrieval;
  if (config.sources) {
    result.sources = {};
    for (const key of ["git", "codex", "claude"]) {
      if (!config.sources[key]) continue;
      result.sources[key] = { ...config.sources[key] };
      for (const local of ["repoPath", "roots", "hookInstall", "includeDefaultRoots"]) delete result.sources[key][local];
    }
  }
  return result;
}
function mergedConfig(remote: Config, local: Config): Config {
  const value = { ...local, ...portableConfig(remote) };
  value.sources = {};
  for (const key of ["git", "codex", "claude"]) value.sources[key] = { ...local.sources?.[key], ...remote.sources?.[key] };
  return value;
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
    const names = (db.prepare("pragma table_list").all() as Array<{ name: string; type: string; schema: string }>).filter(t => t.schema === "main" && t.type === "table" && !t.name.startsWith("sqlite_") && ![...LOCAL_TABLES, "operation_log", "schema_migrations"].includes(t.name)).map(t => t.name).sort();
    const tables = names.map(name => {
      const rows = db.prepare(`select * from ${quote(name)}`).all().map(row => {
        if (name === "temporary_memories") row.project_id = "@project";
        return JSON.stringify(row, (_k, v) => typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v);
      }).sort();
      return [name, rows];
    });
    return sha256(JSON.stringify(tables));
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
export async function captureSnapshot(
  root: string,
  projectId: string,
  parentRevision: number,
  checkoutId?: string,
  share: ShareLocalLayers = "durable"
): Promise<CaptureResult> {
  const dir = join(root, ".code-butler");
  const temporary = join(stateDirectory(root), `capture-${randomUUID()}.sqlite`);
  mkdirSync(stateDirectory(root), { recursive: true, mode: 0o700 });
  const source = new DatabaseSync(join(dir, "memory.sqlite"), { readOnly: true });
  try { await backup(source, temporary); } finally { source.close(); }
  try {
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
      deleteNonCoreRows(db);
    } finally { db.close(); }
    // Re-verify: the deletes above are the only mutation, so a dangling reference
    // introduced here must surface now rather than on the receiving device.
    verifyDatabaseFile(temporary);
    const logicalHash = databaseFingerprint(temporary);
    const segments: SnapshotSegment[] = [];
    const blocks = new Map<string, Buffer>();
    const hashes: Array<[string, string]> = [];
    let total = 0;
    for (const path of filesIn(dir)) {
      let bytes = path === "memory.sqlite" ? readFileSync(temporary) : readFileSync(join(dir, path));
      if (path === "config.json") bytes = Buffer.from(JSON.stringify(portableConfig(JSON.parse(bytes.toString()))));
      total += bytes.length;
      if (total > MAX_EXPANDED) throw new Error("Snapshot exceeds expanded limit");
      const core = path === "memory.sqlite";
      const parts = splitBlocks(bytes);
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
    const snapshot: Snapshot = { format: "code-butler-cloud", version: 3, appVersion: "1.0.0", schemaVersion: CURRENT_SCHEMA_VERSION, projectId, parentRevision, installationId: deviceId, ...(checkoutId ? { checkoutId: UUID.parse(checkoutId) } : {}), fingerprint: sha256(JSON.stringify(hashes)), segments };
    const encoded = Buffer.from(JSON.stringify(snapshot));
    if (encoded.length > MAX_EXPANDED) throw new Error("Encoded snapshot exceeds expanded limit");
    const bytes = gzipSync(encoded);
    if (bytes.length > MAX_COMPRESSED) throw new Error("Snapshot exceeds compressed limit");
    return { snapshot, bytes, blocks, peers };
  } finally { removeSqliteTempFiles(temporary); }
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
  const snapshot = manifestSchema.parse(JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED }).toString()));
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
    data: joinBlocks(segment, resolve)
  }));
  const config = files.find(file => file.path === "config.json");
  if (config && JSON.stringify(portableConfig(JSON.parse(config.data.toString()))) !== config.data.toString()) {
    throw new Error("Snapshot contains nonportable configuration");
  }
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
    verifySnapshotDatabase(snapshot, staged);
    const target = new DatabaseSync(staged);
    const original = new DatabaseSync(join(dir, "memory.sqlite"));
    try {
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
      target.prepare("update temporary_memories_fts set project_id = ?").run(root);
    } finally { original.close(); target.close(); }
    const existing = filesIn(dir);
    const previousBinding = binding(root);
    const journal: Journal = { ...(previousBinding ? { previousBinding } : {}), files: existing.map(path => ({ path, data: readFileSync(join(dir, path)).toString("base64") })), incoming: materialized.files.map(f => f.path) };
    atomicJson(join(state, "recovery.json"), journal);
    atomicJson(join(state, "apply-journal.json"), journal);
    const local = readJson<Config>(join(dir, "config.json")) ?? {};
    try {
      for (const path of existing) rmSync(join(dir, path), { force: true });
      for (const file of materialized.files) {
        mkdirSync(join(dir, file.path, ".."), { recursive: true });
        const data = file.path === "memory.sqlite" ? readFileSync(staged) : file.path === "config.json" ? Buffer.from(JSON.stringify(mergedConfig(JSON.parse(file.data.toString()), local))) : file.data;
        atomicWrite(join(dir, file.path), data);
      }
      // A snapshot without config still preserves local configuration.
      if (!materialized.files.some(f => f.path === "config.json")) atomicJson(join(dir, "config.json"), local);
      for (const suffix of ["-wal", "-shm"]) rmSync(join(dir, `memory.sqlite${suffix}`), { force: true });
      verifyDatabaseFile(join(dir, "memory.sqlite")); rmSync(join(state, "apply-journal.json")); syncDirectory(state);
    } catch (error) { recoverApply(root); throw error; }
  } finally { rmSync(staged, { force: true }); }
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
