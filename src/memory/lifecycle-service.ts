import type { MemoryStore } from "../storage/store.js";
import { afterCommit, withTransaction } from "../storage/transactions.js";
import type { DurableMemory, MemoryLifecycleStatus } from "../types.js";

export interface UpdateMemoryStatusInput {
  memoryId: string;
  status: MemoryLifecycleStatus;
  reason: string;
  replacementMemoryId?: string | undefined;
  now: string;
}

export function updateMemoryStatus(
  store: MemoryStore,
  input: UpdateMemoryStatusInput
): DurableMemory {
  if (!isMemoryLifecycleStatus(input.status)) {
    throw new Error(`Invalid memory lifecycle status: ${String(input.status)}`);
  }
  if (input.status !== "superseded" && input.replacementMemoryId !== undefined) {
    throw new Error(`replacementMemoryId is not allowed for ${input.status} status`);
  }

  return withTransaction(store.db, () => {
    const memory = store.readMemory(input.memoryId);
    if (!memory) throw new Error(`Unknown durable memory: ${input.memoryId}`);

    if (input.status === "superseded") {
      const replacementId = input.replacementMemoryId;
      if (!replacementId) throw new Error("Superseded memory requires a replacementMemoryId");
      if (replacementId === input.memoryId) throw new Error("A memory cannot supersede itself");
      const replacement = store.readMemory(replacementId);
      if (!replacement) throw new Error(`Unknown durable memory: ${replacementId}`);
      const supersedes = store.listMemoryRelations({ relationType: "supersedes" });
      const exactReplay = supersedes.some((relation) =>
        relation.fromMemoryId === replacementId && relation.toMemoryId === input.memoryId
      );
      const compatibleReplay = exactReplay && !supersedes.some((relation) =>
        relation.toMemoryId === input.memoryId && relation.fromMemoryId !== replacementId
      );
      if (memory.lifecycleStatus === "superseded" && !compatibleReplay) {
        throw new Error("Superseded memory already has a different replacement");
      }
      if (memory.lifecycleStatus === "superseded") return memory;
      if (memory.lifecycleStatus !== "current") {
        throw new Error("Only current memories can be superseded");
      }
      if (replacement.lifecycleStatus !== "current") {
        throw new Error("Replacement memory must be current");
      }
      if (wouldCreateSupersessionCycle(supersedes, replacementId, input.memoryId)) {
        throw new Error("Memory supersession cycle detected");
      }

      const updated = store.updateMemoryLifecycle(input.memoryId, {
        lifecycleStatus: "superseded",
        validUntil: input.now,
        statusReason: input.reason,
        statusChangedAt: input.now
      });
      store.addMemoryRelation({
        fromMemoryId: replacementId,
        toMemoryId: input.memoryId,
        relationType: "supersedes",
        createdAt: input.now,
        reason: input.reason
      });
      scheduleEmbeddingCleanup(store, input.memoryId);
      return updated;
    }

    if (input.status === "current") {
      for (const relation of store.listMemoryRelations({
        toMemoryId: input.memoryId,
        relationType: "supersedes"
      })) {
        store.deleteMemoryRelation(relation.id);
      }
    }

    const updated = store.updateMemoryLifecycle(input.memoryId, {
      lifecycleStatus: input.status,
      validUntil: input.status === "current" ? null : input.now,
      statusReason: input.reason,
      statusChangedAt: input.now
    });
    scheduleEmbeddingCleanup(store, input.memoryId);
    return updated;
  });
}

function scheduleEmbeddingCleanup(store: MemoryStore, memoryId: string): void {
  afterCommit(store.db, () => {
    try {
      store.deleteStaleEmbeddingJobsForMemory(memoryId);
    } catch {
      // Job and vector cleanup are independent best-effort maintenance.
    }
    try {
      store.deleteStaleEmbeddingVectorsForMemory(memoryId);
    } catch {
      // Job and vector cleanup are independent best-effort maintenance.
    }
  });
}

function wouldCreateSupersessionCycle(
  relations: ReturnType<MemoryStore["listMemoryRelations"]>,
  replacementMemoryId: string,
  originalMemoryId: string
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const relation of relations) {
    const outgoing = adjacency.get(relation.fromMemoryId) ?? [];
    outgoing.push(relation.toMemoryId);
    adjacency.set(relation.fromMemoryId, outgoing);
  }
  const visited = new Set<string>();
  const pending = [originalMemoryId];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    if (current === replacementMemoryId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

function isMemoryLifecycleStatus(status: string): status is MemoryLifecycleStatus {
  return status === "current" || status === "superseded" || status === "retracted";
}
