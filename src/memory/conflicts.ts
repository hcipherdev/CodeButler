import { createEvidenceSignature } from "./evidence-signature.js";
import type { MemoryStore } from "../storage/store.js";
import { withTransaction } from "../storage/transactions.js";
import type { DurableMemory, MemoryQualityStatus } from "../types.js";

export interface MemoryConflictPair {
  fromMemoryId: string;
  toMemoryId: string;
}

export type MemoryConflictAuditChange =
  | { kind: "add_relation"; fromMemoryId: string; toMemoryId: string }
  | { kind: "remove_relation"; relationId: string; fromMemoryId: string; toMemoryId: string }
  | {
      kind: "update_quality";
      memoryId: string;
      previousStatus: MemoryQualityStatus;
      nextStatus: MemoryQualityStatus;
      reasons: string[];
    };

export interface MemoryConflictAuditResult {
  scannedGroups: number;
  scannedMemories: number;
  conflictPairs: MemoryConflictPair[];
  changes: MemoryConflictAuditChange[];
  complete: boolean;
}

export function auditMemoryConflicts(
  store: MemoryStore,
  options: { fix?: boolean | undefined; now?: string | undefined } = {}
): MemoryConflictAuditResult {
  const now = options.now ?? new Date().toISOString();
  const memories = store.listMemories({ lifecycleStatus: "current", qualityStatus: "all", limit: null });
  const groups = groupBySubject(memories);
  const conflictPairs = [...groups.values()]
    .flatMap(findConflictPairs)
    .sort(comparePairs);
  const desired = new Set(conflictPairs.map(pairKey));
  const existing = store.listMemoryRelations({ relationType: "potentially_contradicts" });
  const existingKeys = new Set(existing.map((relation) =>
    pairKey({ fromMemoryId: relation.fromMemoryId, toMemoryId: relation.toMemoryId })
  ));
  const additions = conflictPairs.filter((pair) => !existingKeys.has(pairKey(pair)));
  const removals = existing.filter((relation) => {
    const canonical = canonicalPair(relation.fromMemoryId, relation.toMemoryId);
    return relation.fromMemoryId !== canonical.fromMemoryId || !desired.has(pairKey(canonical));
  });
  const relationChanges: MemoryConflictAuditChange[] = [
    ...additions.map((pair): MemoryConflictAuditChange => ({ kind: "add_relation", ...pair })),
    ...removals.map((relation): MemoryConflictAuditChange => ({
      kind: "remove_relation",
      relationId: relation.id,
      fromMemoryId: relation.fromMemoryId,
      toMemoryId: relation.toMemoryId
    }))
  ];
  const conflictMemoryIds = new Set(conflictPairs.flatMap((pair) => [pair.fromMemoryId, pair.toMemoryId]));
  const assessedMemoryIds = new Set([
    ...conflictMemoryIds,
    ...existing.flatMap((relation) => [relation.fromMemoryId, relation.toMemoryId])
  ]);
  const qualityChanges = [...assessedMemoryIds]
    .sort()
    .flatMap((memoryId): MemoryConflictAuditChange[] => {
      const memory = store.readMemory(memoryId);
      if (!memory) return [];
      const reasons = updatePotentialConflictReason(memory.qualityReasons, conflictMemoryIds.has(memoryId));
      const status = qualityStatusForConflictChange(memory.qualityStatus, reasons);
      if (status === memory.qualityStatus && sameReasons(reasons, memory.qualityReasons)) {
        return [];
      }
      return [{
        kind: "update_quality",
        memoryId,
        previousStatus: memory.qualityStatus,
        nextStatus: status,
        reasons
      }];
    });
  const changes = [...relationChanges, ...qualityChanges];

  if (options.fix) {
    withTransaction(store.db, () => {
      for (const relation of removals) {
        store.deleteMemoryRelation(relation.id);
      }
      for (const pair of additions) {
        store.addMemoryRelation({
          ...pair,
          relationType: "potentially_contradicts",
          createdAt: now,
          reason: "Potential conflict: summaries and evidence differ."
        });
      }
      for (const change of qualityChanges) {
        if (change.kind !== "update_quality") continue;
        store.updateMemoryQuality("promoted", change.memoryId, {
          qualityStatus: change.nextStatus,
          qualityReasons: change.reasons,
          lastVerifiedAt: now
        });
      }
    });
  }

  return {
    scannedGroups: groups.size,
    scannedMemories: memories.length,
    conflictPairs,
    changes,
    complete: true
  };
}

function groupBySubject(memories: DurableMemory[]): Map<string, DurableMemory[]> {
  const groups = new Map<string, DurableMemory[]>();
  for (const memory of memories) {
    const key = `${memory.type}\0${memory.subjectKey}`;
    const group = groups.get(key) ?? [];
    group.push(memory);
    groups.set(key, group);
  }
  return groups;
}

function findConflictPairs(memories: DurableMemory[]): MemoryConflictPair[] {
  const pairs: MemoryConflictPair[] = [];
  for (let leftIndex = 0; leftIndex < memories.length; leftIndex += 1) {
    const left = memories[leftIndex] as DurableMemory;
    for (let rightIndex = leftIndex + 1; rightIndex < memories.length; rightIndex += 1) {
      const right = memories[rightIndex] as DurableMemory;
      if (normalizeSummary(left.summary) === normalizeSummary(right.summary)) continue;
      if (createEvidenceSignature(left.evidence) === createEvidenceSignature(right.evidence)) continue;
      pairs.push(canonicalPair(left.id, right.id));
    }
  }
  return pairs;
}

function normalizeSummary(summary: string): string {
  return summary.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function canonicalPair(left: string, right: string): MemoryConflictPair {
  const [fromMemoryId, toMemoryId] = [left, right].sort();
  return { fromMemoryId: fromMemoryId as string, toMemoryId: toMemoryId as string };
}

function pairKey(pair: MemoryConflictPair): string {
  return `${pair.fromMemoryId}\0${pair.toMemoryId}`;
}

function comparePairs(left: MemoryConflictPair, right: MemoryConflictPair): number {
  return left.fromMemoryId.localeCompare(right.fromMemoryId) || left.toMemoryId.localeCompare(right.toMemoryId);
}

function sameReasons(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((reason, index) => reason === normalizedRight[index]);
}

function updatePotentialConflictReason(reasons: string[], present: boolean): string[] {
  const next = reasons.filter((reason) => reason !== "potential_conflict");
  if (present) next.push("potential_conflict");
  return [...new Set(next)];
}

function qualityStatusForConflictChange(
  currentStatus: MemoryQualityStatus,
  reasons: string[]
): MemoryQualityStatus {
  if (reasons.length === 0) return "active";
  if (currentStatus === "quarantined") return "quarantined";
  return "needs_review";
}
