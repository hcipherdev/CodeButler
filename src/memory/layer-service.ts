import { createHash } from "node:crypto";
import type { MemoryStore } from "../storage/store.js";
import type { OperationActor } from "../types.js";
import { withTransaction } from "../storage/transactions.js";
import { sanitizeLayerInput } from "./layer.js";
import { assertWritableLayer } from "./peer-layer.js";

export interface UpdateMemoryLayerInput {
  memoryId: string;
  category: "candidate" | "promoted" | "temporary";
  layer: string;
  reason: string;
}

export function updateMemoryLayer(store: MemoryStore, input: UpdateMemoryLayerInput, actor: OperationActor = "mcp") {
  if (!input.reason.trim()) throw new Error("Layer correction reason is required");
  const table = { candidate: "memory_candidates", promoted: "memories", temporary: "temporary_memories" }[input.category];
  if (!table) throw new Error("Invalid memory category");
  const layer = sanitizeLayerInput(store.contentPolicy, input.layer);
  const id = store.contentPolicy.identifier(input.memoryId);
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  return withTransaction(store.db, () => {
    const row = store.db.prepare(`select * from ${table} where id = ?`).get(id);
    if (!row) throw new Error("Unknown memory ID");
    assertWritableLayer(store, input.category, id);
    const updates = [{ table, id }];
    if (input.category === "candidate" && typeof row.promoted_memory_id === "string") updates.push({ table: "memories", id: row.promoted_memory_id });
    const durableId = input.category === "promoted" ? id : row.promoted_memory_id;
    if (typeof durableId === "string") {
      for (const c of store.db.prepare("select id from memory_candidates where promoted_memory_id = ?").all(durableId)) {
        if (!updates.some(x => x.table === "memory_candidates" && x.id === c.id)) updates.push({ table: "memory_candidates", id: String(c.id) });
      }
    }
    try {
      for (const update of updates) store.db.prepare(`update ${update.table} set layer = ? where id = ?`).run(layer, update.id);
    } catch (error) {
      if (String(error).includes("UNIQUE constraint")) throw new Error("Layer correction collides with an existing memory; no records changed");
      throw error;
    }
    const op = store.beginOperation({ operationType: "layer_change", actor, metadata: { memoryIdHash: hash(id), reasonHash: hash(input.reason.trim()), category: input.category === "candidate" ? "candidates" : input.category === "temporary" ? "temporary_memories" : "memories" } });
    store.completeOperation(op.id);
    return { memoryId: id, category: input.category, layer, updatedMemoryIds: updates.map(x => x.id) };
  });
}
