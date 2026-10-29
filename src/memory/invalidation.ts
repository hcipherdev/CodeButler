import { randomUUID } from "node:crypto";

import type { MemoryStore } from "../storage/store.js";
import type { DurableMemory, MemoryCandidate } from "../types.js";
import { latestEvidenceTime } from "./evidence-time.js";
import { updateMemoryStatus } from "./lifecycle-service.js";
import { compensateMemoryReview, resolveMemoryReview } from "./review.js";
import { effectiveTerminalMemoryReview, type MemoryReviewCategory } from "./review-state.js";

/**
 * When newer evidence says an existing memory no longer holds. The extractor and the
 * consolidation pass propose these; this module decides what is safe to do about them.
 */
export const INVALIDATION_POLICY_VERSION = "invalidation-v1";
/** At or above: act, when the replacement's evidence is newer than the target's. */
export const INVALIDATION_ACT_CONFIDENCE = 0.9;
/** At or above (and below the act bar): only flag the target for review. */
export const INVALIDATION_FLAG_CONFIDENCE = 0.7;
/** A durable memory waiting for its replacement to become durable before it is superseded. */
export const INVALIDATED_REASON = "invalidated_by_newer_evidence";
/** A memory a model doubted without enough confidence or newer evidence to act on. */
export const POSSIBLY_OUTDATED_REASON = "possibly_outdated";

export interface MemoryRef {
  category: MemoryReviewCategory;
  id: string;
}

export interface InvalidationRequest {
  /** The memory that no longer holds. */
  target: MemoryRef;
  /** The newer memory that states what holds now. */
  replacement: MemoryRef;
  confidence: number;
  why: string;
  source: "extraction" | "consolidation";
  runId?: string | undefined;
  now?: string | undefined;
}

export type InvalidationOutcome =
  | "ignored"
  | "unavailable"
  | "flagged"
  | "discarded"
  | "superseded"
  | "pending";

export interface InvalidationResult {
  outcome: InvalidationOutcome;
  /** The review that discarded a candidate target; undo compensates it. */
  resolutionId?: string | undefined;
  /** The durable memory this call superseded. */
  supersededMemoryId?: string | undefined;
  pendingId?: string | undefined;
}

type Resolved =
  | { category: "candidate"; memory: MemoryCandidate }
  | { category: "promoted"; memory: DurableMemory };

export function applyInvalidation(store: MemoryStore, request: InvalidationRequest): InvalidationResult {
  const now = request.now ?? new Date().toISOString();
  if (!(request.confidence >= INVALIDATION_FLAG_CONFIDENCE)) return { outcome: "ignored" };
  const target = resolveLive(store, request.target);
  const replacement = resolveLive(store, request.replacement);
  if (!target || !replacement) return { outcome: "unavailable" };
  if (target.memory.id === replacement.memory.id) return { outcome: "ignored" };

  const why = request.why.trim() || "Newer evidence shows this no longer holds.";
  const targetTime = latestEvidenceTime(store, target.memory.evidence) ?? Date.parse(target.memory.createdAt);
  const replacementTime = latestEvidenceTime(store, replacement.memory.evidence);
  const newer = replacementTime !== undefined && Number.isFinite(targetTime) && replacementTime > targetTime;
  if (request.confidence < INVALIDATION_ACT_CONFIDENCE || !newer) {
    flag(store, target, POSSIBLY_OUTDATED_REASON, now);
    return { outcome: "flagged" };
  }

  const reason = `Invalidated by newer memory ${replacement.memory.id}: ${why}`;
  try {
    if (target.category === "candidate") {
      const result = resolveMemoryReview(store, {
        memoryId: target.memory.id,
        category: "candidate",
        action: "discard",
        reason,
        now,
        provenance: {
          verdict: "obsolete",
          policyVersion: INVALIDATION_POLICY_VERSION,
          confidence: request.confidence,
          citationIds: [],
          reconciliationRunId: request.runId ?? `invalidation-${request.source}`,
          reconciliationItemId: randomUUID()
        }
      }, "system");
      return { outcome: "discarded", resolutionId: result.review.id };
    }
    if (replacement.category === "promoted") {
      updateMemoryStatus(store, {
        memoryId: target.memory.id,
        status: "superseded",
        reason,
        replacementMemoryId: replacement.memory.id,
        now,
        actor: "system"
      });
      return { outcome: "superseded", supersededMemoryId: target.memory.id };
    }
  } catch {
    // A read-only layer or a conflicting lifecycle leaves the decision to a person.
    flag(store, target, POSSIBLY_OUTDATED_REASON, now);
    return { outcome: "flagged" };
  }

  const pendingId = `invalidation-${randomUUID()}`;
  store.localDb.prepare(
    `insert into pending_invalidations
       (id, target_category, target_id, replacement_category, replacement_id, confidence, reason, source, run_id, created_at)
     values (?, 'promoted', ?, 'candidate', ?, ?, ?, ?, ?, ?)`
  ).run(pendingId, target.memory.id, replacement.memory.id, request.confidence, reason, request.source, request.runId ?? null, now);
  flag(store, target, INVALIDATED_REASON, now);
  return { outcome: "pending", pendingId };
}

export interface PendingInvalidationSummary {
  superseded: number;
  dropped: number;
  pending: number;
  warnings: string[];
}

/**
 * Supersedes durable memories whose replacement has since been promoted, and drops
 * requests whose replacement was withdrawn or whose target already changed.
 */
export function applyPendingInvalidations(store: MemoryStore, now = new Date().toISOString()): PendingInvalidationSummary {
  const summary: PendingInvalidationSummary = { superseded: 0, dropped: 0, pending: 0, warnings: [] };
  const rows = store.localDb.prepare(
    "select id, target_id, replacement_id, reason from pending_invalidations where resolved_at is null order by created_at, id"
  ).all() as Array<{ id: string; target_id: string; replacement_id: string; reason: string }>;
  const resolve = (id: string, outcome: string) =>
    store.localDb.prepare("update pending_invalidations set resolved_at = ?, outcome = ? where id = ?").run(now, outcome, id);
  for (const row of rows) {
    const target = store.readMemory(row.target_id);
    if (!target || target.lifecycleStatus !== "current") {
      resolve(row.id, "target_changed");
      summary.dropped += 1;
      continue;
    }
    const replacement = resolveLive(store, { category: "candidate", id: row.replacement_id });
    if (!replacement) {
      unflag(store, { category: "promoted", memory: target }, INVALIDATED_REASON, now);
      resolve(row.id, "dropped");
      summary.dropped += 1;
      continue;
    }
    if (replacement.category === "candidate") {
      summary.pending += 1;
      continue;
    }
    try {
      updateMemoryStatus(store, {
        memoryId: target.id,
        status: "superseded",
        reason: row.reason,
        replacementMemoryId: replacement.memory.id,
        now,
        actor: "system"
      });
      unflag(store, { category: "promoted", memory: target }, INVALIDATED_REASON, now);
      resolve(row.id, "superseded");
      summary.superseded += 1;
    } catch {
      summary.warnings.push("A pending invalidation could not be applied");
    }
  }
  return summary;
}

/**
 * Reverses what applyInvalidation did: restores a discarded candidate, makes a superseded
 * memory current again, or withdraws a pending request. False when nothing was reverted.
 */
export function undoInvalidation(store: MemoryStore, result: InvalidationResult, reason: string, now = new Date().toISOString()): boolean {
  if (result.outcome === "discarded" && result.resolutionId) {
    return !compensateMemoryReview(store, { resolutionId: result.resolutionId, reason, now }).replayed;
  }
  if (result.outcome === "superseded" && result.supersededMemoryId) {
    const memory = store.readMemory(result.supersededMemoryId);
    if (memory?.lifecycleStatus !== "superseded") return false;
    updateMemoryStatus(store, { memoryId: memory.id, status: "current", reason, now, actor: "system" });
    return true;
  }
  if (result.outcome === "pending" && result.pendingId) {
    const row = store.localDb.prepare("select target_id from pending_invalidations where id = ? and resolved_at is null")
      .get(result.pendingId) as { target_id: string } | undefined;
    if (!row) return false;
    store.localDb.prepare("update pending_invalidations set resolved_at = ?, outcome = 'undone' where id = ?").run(now, result.pendingId);
    const target = store.readMemory(row.target_id);
    if (target) unflag(store, { category: "promoted", memory: target }, INVALIDATED_REASON, now);
    return true;
  }
  return false;
}

export interface InvalidationRecord {
  id: string;
  targetCategory: MemoryReviewCategory;
  targetId: string;
  replacementCategory: MemoryReviewCategory;
  replacementId: string;
  confidence: number;
  reason: string;
  source: string;
  runId?: string | undefined;
  createdAt: string;
  resolvedAt?: string | undefined;
  outcome?: string | undefined;
}

export function listPendingInvalidations(store: MemoryStore, input: { includeResolved?: boolean; limit?: number } = {}): InvalidationRecord[] {
  const rows = store.localDb.prepare(
    `select * from pending_invalidations ${input.includeResolved ? "" : "where resolved_at is null"}
      order by created_at desc, id desc limit ?`
  ).all(Math.max(1, Math.floor(input.limit ?? 100))) as Array<Record<string, string | number | null>>;
  return rows.map((row) => ({
    id: String(row.id),
    targetCategory: row.target_category as MemoryReviewCategory,
    targetId: String(row.target_id),
    replacementCategory: row.replacement_category as MemoryReviewCategory,
    replacementId: String(row.replacement_id),
    confidence: Number(row.confidence),
    reason: String(row.reason),
    source: String(row.source),
    ...(row.run_id ? { runId: String(row.run_id) } : {}),
    createdAt: String(row.created_at),
    ...(row.resolved_at ? { resolvedAt: String(row.resolved_at) } : {}),
    ...(row.outcome ? { outcome: String(row.outcome) } : {})
  }));
}

/**
 * The live form of a reference: a promoted candidate resolves to its durable copy, and
 * withdrawn memories (discarded or corrected candidates, non-current durables) resolve
 * to nothing.
 */
export function resolveLive(store: MemoryStore, ref: MemoryRef): Resolved | undefined {
  if (ref.category === "promoted") {
    const memory = store.readMemory(ref.id);
    return memory && memory.lifecycleStatus === "current" ? { category: "promoted", memory } : undefined;
  }
  const candidate = store.readMemoryCandidate(ref.id);
  if (!candidate || effectiveTerminalMemoryReview(store, "candidate", candidate)) return undefined;
  if (candidate.promotionState === "promoted") {
    return candidate.promotedMemoryId ? resolveLive(store, { category: "promoted", id: candidate.promotedMemoryId }) : undefined;
  }
  return { category: "candidate", memory: candidate };
}

function flag(store: MemoryStore, target: Resolved, reason: string, now: string): void {
  const memory = target.memory;
  if (memory.qualityReasons.includes(reason)) return;
  store.updateMemoryQuality(target.category, memory.id, {
    qualityStatus: memory.qualityStatus === "quarantined" ? "quarantined" : "needs_review",
    qualityReasons: [...new Set([...memory.qualityReasons, reason])].sort(),
    lastVerifiedAt: now
  });
}

function unflag(store: MemoryStore, target: Resolved, reason: string, now: string): void {
  const memory = target.memory;
  if (!memory.qualityReasons.includes(reason)) return;
  const reasons = memory.qualityReasons.filter((item) => item !== reason);
  store.updateMemoryQuality(target.category, memory.id, {
    qualityStatus: memory.qualityStatus === "quarantined" ? "quarantined" : reasons.length ? "needs_review" : "active",
    qualityReasons: reasons,
    lastVerifiedAt: now
  });
}
