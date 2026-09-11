import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";

import { parseLayer } from "../memory/layer.js";

/** Local copy of the snapshot envelope limit; importing it would cycle. */
const MAX_EXPANDED = 1024 * 1024 * 1024;

/**
 * A device's own non-core rows, packaged so peers can read them without being able to
 * write them. Partitions are single-writer by construction: the writer's installation
 * id is part of the layer name, so two devices can never contend for the same
 * partition and no merge is ever required.
 *
 * Only layers that name a device are shareable. A bare `branch:<name>` layer is not
 * attributable to one writer, so it stays local rather than risking two devices
 * publishing the same partition.
 */
export const PARTITION_SEGMENT_PREFIX = "partition:";
const partitionSchema = z.object({
  layer: z.string().min(1).max(300),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown())))
});
export type PartitionPayload = z.infer<typeof partitionSchema>;

/** Durable memory only by default; session state is the riskiest content to share. */
export type ShareLocalLayers = "durable" | "all" | "none";
const TEMPORARY_TABLES = new Set(["temporary_memories", "temporary_memories_fts", "temporary_memory_links"]);
/** Embeddings are provider- and device-specific, so they are never worth shipping. */
const UNSHARED_TABLES = new Set(["embedding_jobs", "embedding_vectors"]);

/**
 * A partition is identified by the checkout that wrote it as well as the layer it
 * carries. Two checkouts of one project on the same machine share an installation id,
 * so keying on the layer alone would make them overwrite each other's partition on
 * every sync. They still never import each other — that filter is by installation —
 * but they must not contend for one segment.
 */
export function partitionSegmentId(checkoutId: string, layer: string): string {
  return `${PARTITION_SEGMENT_PREFIX}${checkoutId}:${layer}`;
}
export function partitionLayer(segmentId: string): string {
  const rest = segmentId.slice(PARTITION_SEGMENT_PREFIX.length);
  const separator = rest.indexOf(":");
  return separator === -1 ? rest : rest.slice(separator + 1);
}
export function partitionCheckout(segmentId: string): string {
  const rest = segmentId.slice(PARTITION_SEGMENT_PREFIX.length);
  const separator = rest.indexOf(":");
  return separator === -1 ? "" : rest.slice(0, separator);
}
/** The installation allowed to write this partition, from the layer itself. */
export function partitionWriter(layer: string): string | undefined {
  try { return parseLayer(layer).deviceId; } catch { return undefined; }
}
export function isShareableLayer(layer: string): boolean {
  return partitionWriter(layer) !== undefined;
}
export function isOwnLayer(layer: string | null | undefined, deviceId: string): boolean {
  const writer = layer === null || layer === undefined ? undefined : partitionWriter(layer);
  return writer !== undefined && writer === deviceId.trim().toLowerCase();
}

export function encodePartition(payload: PartitionPayload): Buffer {
  // Table and row order are fixed so an unchanged partition hashes to the same blocks.
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  for (const name of Object.keys(payload.tables).sort()) tables[name] = payload.tables[name]!;
  const encoded = Buffer.from(JSON.stringify({ layer: payload.layer, tables }));
  if (encoded.length > MAX_EXPANDED) throw new Error("Snapshot exceeds expanded limit");
  return gzipSync(encoded);
}
export function decodePartition(bytes: Buffer): PartitionPayload {
  return partitionSchema.parse(JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED }).toString()));
}

/** Layers owned by this device that are eligible to be published. */
export function shareableLayers(db: DatabaseSync, deviceId: string, share: ShareLocalLayers): string[] {
  if (share === "none") return [];
  const tables = share === "all"
    ? ["memories", "memory_candidates", "temporary_memories"]
    : ["memories", "memory_candidates"];
  const layers = new Set<string>();
  for (const table of tables) {
    for (const row of db.prepare(`select distinct layer from ${table} where layer <> 'core'`).all() as Array<{ layer: string }>) {
      if (isOwnLayer(row.layer, deviceId)) layers.add(row.layer);
    }
  }
  return [...layers].sort();
}

export function exportPartition(
  db: DatabaseSync,
  layer: string,
  spec: ReadonlyArray<readonly [string, string]>,
  share: ShareLocalLayers
): PartitionPayload {
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  for (const [table, where] of spec) {
    if (UNSHARED_TABLES.has(table)) continue;
    if (share !== "all" && TEMPORARY_TABLES.has(table)) continue;
    const rows = db.prepare(`select * from ${quote(table)} where ${where} order by rowid`).all() as Array<Record<string, unknown>>;
    if (rows.length > 0) tables[table] = rows.map(normalizeRow);
  }
  return { layer, tables };
}

/**
 * Replaces a peer partition wholesale. Peer rows are never edited locally, so the
 * incoming copy is authoritative and a diff would only add ways to disagree.
 */
export function importPartition(
  db: DatabaseSync,
  payload: PartitionPayload,
  spec: ReadonlyArray<readonly [string, string]>
): number {
  for (const [table, where] of spec) {
    if (UNSHARED_TABLES.has(table)) continue;
    db.exec(`delete from ${quote(table)} where ${where}`);
  }
  let inserted = 0;
  for (const [table] of [...spec].reverse()) {
    for (const row of payload.tables[table] ?? []) {
      const keys = Object.keys(row);
      if (keys.length === 0) continue;
      db.prepare(`insert or ignore into ${quote(table)} (${keys.map(quote).join(", ")}) values (${keys.map(() => "?").join(", ")})`)
        .run(...keys.map(key => sqlValue(row[key])));
      inserted += 1;
    }
  }
  return inserted;
}

/** Peer rows may point at core rows this device does not have; repair, never fail. */
export function repairPartitionReferences(db: DatabaseSync): void {
  db.exec("update memory_candidates set promoted_memory_id = null where promoted_memory_id is not null and promoted_memory_id not in (select id from memories)");
  db.exec("delete from memory_relations where from_memory_id not in (select id from memories) or to_memory_id not in (select id from memories)");
  db.exec("delete from temporary_memory_links where memory_id not in (select id from temporary_memories)");
  db.exec("delete from chunks where source_id not in (select id from sources)");
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    const value = row[key];
    result[key] = typeof value === "bigint"
      ? value.toString()
      : value instanceof Uint8Array
        ? { $blob: Buffer.from(value).toString("base64") }
        : value;
  }
  return result;
}

function sqlValue(value: unknown): string | number | bigint | null | Uint8Array {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && "$blob" in (value as Record<string, unknown>)) {
    return new Uint8Array(Buffer.from(String((value as { $blob: string }).$blob), "base64"));
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") return value;
  return JSON.stringify(value);
}

function quote(name: string): string { return `"${name.replaceAll('"', '""')}"`; }
