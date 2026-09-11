import type { MemoryStore } from "../storage/store.js";

/**
 * A peer layer is one this device imported from another device's partition. Those rows
 * are readable so an agent can answer "what was device A working on?", but this device
 * is not their writer: the owning device republishes its partition on every sync and
 * would overwrite any local edit without warning. Rejecting the write is therefore the
 * honest behaviour, not a limitation to work around.
 */
export function isPeerLayer(store: MemoryStore, layer: string | null | undefined): boolean {
  if (layer === null || layer === undefined || layer === "core") return false;
  try {
    return store.db.prepare("select 1 from peer_partitions where layer = ?").get(layer) !== undefined;
  } catch {
    // A database that predates the peer-partition table holds no peer rows.
    return false;
  }
}

export function peerLayers(store: MemoryStore): string[] {
  try {
    return (store.db.prepare("select layer from peer_partitions order by layer").all() as Array<{ layer: string }>)
      .map((row) => row.layer);
  } catch {
    return [];
  }
}

/** Throws when a memory belongs to another device's read-only partition. */
export function assertWritableLayer(
  store: MemoryStore,
  category: "candidate" | "promoted" | "temporary",
  memoryId: string
): void {
  const table = { candidate: "memory_candidates", promoted: "memories", temporary: "temporary_memories" }[category];
  const row = store.db.prepare(`select layer from ${table} where id = ?`).get(store.contentPolicy.identifier(memoryId)) as
    { layer: string } | undefined;
  if (row && isPeerLayer(store, row.layer)) {
    throw new Error("Memory belongs to another device's layer and is read-only here");
  }
}
