import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  DurableMemory,
  MemoryLifecycleStatus,
  MemoryRelation,
  MemoryRelationType
} from "../types.js";
import type { StorageContentPolicy } from "./content-policy.js";
import { withTransaction } from "./transactions.js";

interface MemoryRelationRow {
  id: string;
  from_memory_id: string;
  to_memory_id: string;
  relation_type: MemoryRelationType;
  created_at: string;
  reason: string | null;
}

export function retractedLifecycleValues(timestamp: string): {
  validUntil: string;
  statusReason: string;
  statusChangedAt: string;
  lifecycleGeneration: string;
} {
  return {
    validUntil: timestamp,
    statusReason: "Evidence deleted by privacy operation",
    statusChangedAt: timestamp,
    lifecycleGeneration: randomUUID()
  };
}

export function updateMemoryLifecycle(
  db: DatabaseSync,
  contentPolicy: StorageContentPolicy,
  readMemory: (id: string) => DurableMemory | undefined,
  id: string,
  lifecycle: {
    lifecycleStatus: MemoryLifecycleStatus;
    validFrom?: string;
    validUntil?: string | null;
    statusReason?: string | null;
    statusChangedAt?: string;
  }
): DurableMemory {
  return withTransaction(db, () => {
    const canonicalId = contentPolicy.identifier(id);
    const existing = readMemory(canonicalId);
    if (!existing) throw new Error(`Unknown durable memory: ${canonicalId}`);
    db.prepare(
      `update memories
       set lifecycle_status = ?, valid_from = ?, valid_until = ?, status_reason = ?,
           status_changed_at = ?, lifecycle_generation = ?
       where id = ?`
    ).run(
      lifecycle.lifecycleStatus,
      lifecycle.validFrom ?? existing.validFrom,
      lifecycle.validUntil === undefined ? existing.validUntil ?? null : lifecycle.validUntil,
      lifecycle.statusReason === undefined ? existing.statusReason ?? null :
        lifecycle.statusReason === null ? null : contentPolicy.text(lifecycle.statusReason),
      lifecycle.statusChangedAt ?? new Date().toISOString(),
      randomUUID(),
      canonicalId
    );
    return readMemory(canonicalId) as DurableMemory;
  });
}

export function addMemoryRelation(
  db: DatabaseSync,
  contentPolicy: StorageContentPolicy,
  readMemory: (id: string) => DurableMemory | undefined,
  input: {
    fromMemoryId: string;
    toMemoryId: string;
    relationType: MemoryRelationType;
    createdAt?: string;
    reason?: string;
  }
): MemoryRelation {
  return withTransaction(db, () => {
    const normalized = {
      ...input,
      fromMemoryId: contentPolicy.identifier(input.fromMemoryId),
      toMemoryId: contentPolicy.identifier(input.toMemoryId),
      ...(input.reason === undefined ? {} : { reason: contentPolicy.text(input.reason) })
    };
    if (normalized.fromMemoryId === normalized.toMemoryId) {
      throw new Error("Memory relations cannot relate a memory to itself");
    }
    if (!readMemory(normalized.fromMemoryId)) {
      throw new Error(`Unknown durable memory: ${normalized.fromMemoryId}`);
    }
    if (!readMemory(normalized.toMemoryId)) {
      throw new Error(`Unknown durable memory: ${normalized.toMemoryId}`);
    }
    const id = `memory-relation-${randomUUID()}`;
    db.prepare(
      `insert into memory_relations (id, from_memory_id, to_memory_id, relation_type, created_at, reason)
       values (?, ?, ?, ?, ?, ?)
       on conflict(from_memory_id, to_memory_id, relation_type) do nothing`
    ).run(
      id,
      normalized.fromMemoryId,
      normalized.toMemoryId,
      normalized.relationType,
      normalized.createdAt ?? new Date().toISOString(),
      normalized.reason ?? null
    );
    const row = db.prepare(
      `select id, from_memory_id, to_memory_id, relation_type, created_at, reason
       from memory_relations
       where from_memory_id = ? and to_memory_id = ? and relation_type = ?`
    ).get(
      normalized.fromMemoryId,
      normalized.toMemoryId,
      normalized.relationType
    ) as unknown as MemoryRelationRow;
    return memoryRelationFromRow(row);
  });
}

export function listMemoryRelations(
  db: DatabaseSync,
  contentPolicy: StorageContentPolicy,
  input: {
    fromMemoryId?: string;
    toMemoryId?: string;
    relationType?: MemoryRelationType;
  } = {}
): MemoryRelation[] {
  const predicates: string[] = [];
  const parameters: string[] = [];
  if (input.fromMemoryId !== undefined) {
    predicates.push("from_memory_id = ?");
    parameters.push(contentPolicy.identifier(input.fromMemoryId));
  }
  if (input.toMemoryId !== undefined) {
    predicates.push("to_memory_id = ?");
    parameters.push(contentPolicy.identifier(input.toMemoryId));
  }
  if (input.relationType !== undefined) {
    predicates.push("relation_type = ?");
    parameters.push(input.relationType);
  }
  const where = predicates.length > 0 ? `where ${predicates.join(" and ")}` : "";
  const rows = db.prepare(
    `select id, from_memory_id, to_memory_id, relation_type, created_at, reason
     from memory_relations ${where}
     order by created_at asc, id asc`
  ).all(...parameters) as unknown as MemoryRelationRow[];
  return rows.map(memoryRelationFromRow);
}

export function deleteMemoryRelation(
  db: DatabaseSync,
  contentPolicy: StorageContentPolicy,
  id: string
): boolean {
  return withTransaction(
    db,
    () => db.prepare("delete from memory_relations where id = ?")
      .run(contentPolicy.identifier(id)).changes > 0
  );
}

function memoryRelationFromRow(row: MemoryRelationRow): MemoryRelation {
  return {
    id: row.id,
    fromMemoryId: row.from_memory_id,
    toMemoryId: row.to_memory_id,
    relationType: row.relation_type,
    createdAt: row.created_at,
    reason: row.reason ?? undefined
  };
}
