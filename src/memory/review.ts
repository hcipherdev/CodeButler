import { createStatement } from "./statement.js";
import { recordMemoryEvent } from "./events.js";
import { createHash, randomUUID } from "node:crypto";

import { hashOperationIdentifier, recordCompletedOperation } from "../operations/log.js";
import type { MemoryStore } from "../storage/store.js";
import { withTransaction } from "../storage/transactions.js";
import type {
  DurableMemory,
  EvidenceRef,
  MemoryCandidate,
  MemoryOrigin,
  MemoryReviewAction,
  MemoryReviewProvenance,
  MemoryReviewSummary,
  MemoryScope,
  MemoryType,
  OperationActor
} from "../types.js";
import { updateMemoryStatus } from "./lifecycle-service.js";
import { createMemoryOrigin } from "./origin.js";
import { assertWritableLayer } from "./peer-layer.js";
import { assessMemoryQuality } from "./quality.js";
import { rememberProjectMemory } from "./remember.js";
import {
  createMemoryReviewContext,
  currentMemoryReview,
  findMemoryReviewByToken,
  type MemoryReviewCategory,
  type ReviewableMemory
} from "./review-state.js";

const VERIFY_REASON = "Confirmed against current project state.";
const VERIFY_BLOCKING_REASONS = new Set([
  "invalid_confidence",
  "missing_claim",
  "missing_evidence",
  "unresolved_evidence",
  "html_or_markup_content",
  "code_or_diff_content",
  "json_fragment_content",
  "table_fragment_content",
  "low_prose_ratio"
]);

export interface MemoryCorrectionInput {
  type?: MemoryType | undefined;
  title?: string | undefined;
  text?: string | undefined;
  summary?: string | undefined;
  reason?: string | undefined;
  relatedFiles?: string[] | undefined;
  scope?: MemoryScope | undefined;
  statement?: import("../types.js").MemoryStatement | undefined;
  /** Internal reconciliation fields. They are intentionally not accepted by the public review CLI. */
  evidence?: EvidenceRef[] | undefined;
  confidence?: number | undefined;
  origin?: MemoryOrigin | undefined;
  dedupeKey?: string | undefined;
}

export interface ResolveMemoryReviewInput {
  memoryId: string;
  category: MemoryReviewCategory;
  action: MemoryReviewAction;
  reason?: string | undefined;
  reviewToken?: string | undefined;
  correction?: MemoryCorrectionInput | undefined;
  now?: string | undefined;
  provenance?: MemoryReviewProvenance | undefined;
}

export interface ResolveMemoryReviewResult {
  memoryId: string;
  category: MemoryReviewCategory;
  action: MemoryReviewAction;
  reviewToken: string;
  reviewedAt: string;
  review: MemoryReviewSummary;
  memory: ReviewableMemory;
  replacement?: ReviewableMemory | undefined;
  complete: true;
}

export interface CompensateMemoryReviewInput {
  resolutionId: string;
  reason: string;
  reconciliationRunId?: string | undefined;
  reconciliationItemId?: string | undefined;
  now?: string | undefined;
}

export interface CompensateMemoryReviewResult {
  compensationId: string;
  resolutionId: string;
  memoryId: string;
  category: MemoryReviewCategory;
  replacementMemoryId?: string | undefined;
  revertedAt: string;
  replayed: boolean;
}

export class StaleMemoryReviewError extends Error {
  constructor() {
    super("This memory changed after it was opened. Refresh it before reviewing.");
  }
}

export function resolveMemoryReview(
  store: MemoryStore,
  input: ResolveMemoryReviewInput,
  actor: OperationActor = "mcp"
): ResolveMemoryReviewResult {
  assertCategory(input.category);
  assertAction(input.action);
  const reviewedAt = normalizeTimestamp(input.now);
  const reason = normalizeReviewReason(store, input.action, input.reason);

  return withTransaction(store.db, () => {
    if (input.reviewToken !== undefined && !/^[a-f0-9]{64}$/.test(input.reviewToken)) {
      throw new Error("reviewToken must be a SHA-256 token");
    }
    const memory = readReviewableMemory(store, input.memoryId, input.category, true);
    assertWritableLayer(store, input.category, memory.id);
    const context = createMemoryReviewContext(store, input.category, memory);
    const replay = input.reviewToken === undefined ? undefined : findMemoryReviewByToken(store, {
      memoryId: memory.id,
      category: input.category,
      reviewToken: input.reviewToken,
      action: input.action
    });
    if (replay) {
      const completedPromotedLifecycleAction = input.category === "promoted" &&
        input.action !== "verify" &&
        (memory as DurableMemory).lifecycleStatus !== "current";
      if (input.reviewToken !== context.reviewToken && !completedPromotedLifecycleAction) {
        throw new StaleMemoryReviewError();
      }
      const latest = currentMemoryReview(store, input.category, memory);
      const replaySummary = latest?.id === replay.id ? latest : { ...replay, current: false };
      const replacement = replay.replacementMemoryId && replay.replacementCategory
        ? tryReadReviewableMemory(store, replay.replacementMemoryId, replay.replacementCategory)
        : undefined;
      return {
        memoryId: memory.id,
        category: input.category,
        action: input.action,
        reviewToken: input.reviewToken!,
        reviewedAt: replaySummary.reviewedAt,
        review: replaySummary,
        memory,
        ...(replacement === undefined ? {} : { replacement }),
        complete: true
      };
    }
    if (input.category === "promoted" && (memory as DurableMemory).lifecycleStatus !== "current") {
      throw new Error("Only current promoted memories can be reviewed");
    }
    if (input.reviewToken !== undefined && input.reviewToken !== context.reviewToken) {
      throw new StaleMemoryReviewError();
    }
    if (input.action !== "correct" && input.correction !== undefined) {
      throw new Error("correction is only allowed with the correct action");
    }

    const rawAssessment = assessMemoryQuality(store, memory, {
      now: reviewedAt,
      source: "source" in memory ? memory.source : undefined,
      ignoreReviewResolution: true
    });
    const resolvedReasons = [...new Set([...memory.qualityReasons, ...rawAssessment.reasons])].sort();
    let replacement: ReviewableMemory | undefined;

    if (input.action === "verify") {
      // A person may confirm an active candidate; automatic promotion treats that
      // verification as corroboration. Agents (MCP) still verify only flagged memories.
      const confirmsCandidate = input.category === "candidate" && (actor === "desktop" || actor === "cli");
      if (memory.qualityStatus === "active" && actor !== "ai" && !confirmsCandidate) {
        const existing = currentMemoryReview(store, input.category, memory);
        if (existing?.action !== "verify") throw new Error("Only memories that need review can be verified");
      }
      const blocking = resolvedReasons.filter((item) =>
        VERIFY_BLOCKING_REASONS.has(item) && !(actor === "ai" && (item === "missing_evidence" || item === "unresolved_evidence"))
      );
      if (blocking.length > 0) {
        throw new Error(`Memory must be corrected or discarded: ${blocking.join(", ")}`);
      }
      if (
        actor !== "ai" &&
        memory.qualityStatus === "quarantined" &&
        (resolvedReasons.length === 0 || resolvedReasons.some((item) => item !== "legacy_low_signal_heuristic"))
      ) {
        throw new Error("Only legacy low-signal quarantine can be verified; correct or discard this memory instead");
      }
    } else if (input.action === "correct") {
      const correction = input.correction;
      if (!correction) throw new Error("Correction details are required");
      if (correction.text !== undefined && correction.summary !== undefined && correction.text !== correction.summary) {
        throw new Error("Correction text and summary must match when both are provided");
      }
      if (correction.statement && correction.statement.text !== (correction.text ?? correction.summary ?? memory.summary)) throw new Error("Statement text and correction text must match");
      if (actor === "ai") {
        const summary = correction.text ?? correction.summary ?? memory.summary;
        const evidence = correction.evidence ?? memory.evidence;
        const origin = correction.origin ?? createMemoryOrigin({
          method: "llm",
          channel: "cli",
          generator: {
            ...(input.provenance?.provider === undefined ? {} : { provider: input.provenance.provider }),
            ...(input.provenance?.model === undefined ? {} : { model: input.provenance.model })
          }
        }, { now: () => new Date(reviewedAt) });
        const dedupeKey = correction.dedupeKey ?? `ai-reconciliation:${memory.id}:${createHash("sha256")
          .update(summary)
          .digest("hex")
          .slice(0, 24)}`;
        const candidate = store.upsertMemoryCandidate({
          scope: correction.scope ?? memory.scope ?? { kind: "unspecified" },
          layer: memory.layer ?? "core",
          origin,
          type: correction.type ?? memory.type,
          title: correction.title ?? memory.title,
          summary,
          statement: createStatement(summary, correction.type ?? memory.type, "extracted", correction.statement?.fields),
          reason: correction.reason ?? memory.reason,
          confidence: correction.confidence ?? input.provenance?.confidence ?? memory.confidence,
          evidence,
          relatedFiles: correction.relatedFiles ?? memory.relatedFiles,
          dedupeKey
        });
        replacement = input.category === "promoted"
          ? store.promoteMemoryCandidate(candidate.id, "auto", { layer: memory.layer ?? "core", actor })
          : candidate;
        if (input.category === "promoted") {
          updateMemoryStatus(store, {
            memoryId: memory.id,
            status: "superseded",
            reason,
            replacementMemoryId: replacement.id,
            now: reviewedAt,
            actor
          });
        }
      } else {
        const remembered = rememberProjectMemory(store, {
          scope: correction.scope ?? memory.scope ?? { kind: "unspecified" },
          layer: memory.layer ?? "core",
          type: correction.type ?? memory.type,
          text: correction.text ?? correction.summary ?? memory.summary,
          statement: { fields: correction.statement?.fields },
          title: correction.title ?? memory.title,
          reason: correction.reason ?? memory.reason,
          relatedFiles: correction.relatedFiles ?? memory.relatedFiles,
          promote: input.category === "promoted",
          ...(input.category === "promoted" ? { supersedesMemoryId: memory.id } : {})
        }, {
          now: () => new Date(reviewedAt),
          actor,
          identitySalt: memory.id,
          sourceEvidence: memory.evidence
        });
        replacement = input.category === "promoted" ? remembered.memory : remembered.candidate;
      }
      if (!replacement || replacement.id === memory.id) throw new Error("Correction must create a distinct replacement memory");
    } else if (input.category !== "candidate") {
      updateMemoryStatus(store, {
        memoryId: memory.id,
        status: "retracted",
        reason,
        now: reviewedAt,
        actor
      });
    }

    const replacementCategory = replacement === undefined
      ? undefined
      : input.category === "promoted" ? "promoted" as const : "candidate" as const;
    store.db.prepare(
      `insert into memory_review_resolutions
         (id, memory_id, category, layer, memory_version, context_fingerprint, action,
          resolved_reasons_json, reason, reviewed_at, actor, replacement_memory_id, replacement_category,
          verdict, policy_version, provider, model, confidence, citation_ids_json,
          reconciliation_run_id, reconciliation_item_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      `memory-review-${randomUUID()}`,
      memory.id,
      input.category,
      memory.layer ?? "core",
      context.memoryVersion,
      context.reviewToken,
      input.action,
      JSON.stringify(resolvedReasons),
      reason,
      reviewedAt,
      actor,
      replacement?.id ?? null,
      replacementCategory ?? null,
      input.provenance?.verdict ?? null,
      input.provenance?.policyVersion ?? null,
      input.provenance?.provider ?? null,
      input.provenance?.model ?? null,
      input.provenance?.confidence ?? null,
      JSON.stringify(input.provenance?.citationIds ?? []),
      input.provenance?.reconciliationRunId ?? null,
      input.provenance?.reconciliationItemId ?? null
    );
    if (input.category === "candidate" && input.action !== "verify") recordMemoryEvent(store.db,store.contentPolicy,{
      kind:input.action === "correct" ? "corrected" : "withdrawn",memoryId:memory.id,category:"candidate",layer:memory.layer ?? "core",
      relatedMemoryId:replacement?.id,relatedCategory:replacementCategory,relatedLayer:replacement?.layer,reason,actor,at:reviewedAt,
      key:`candidate-review:${memory.id}:${context.reviewToken}:${input.action}`});

    recordCompletedOperation(store.db, {
      operationType: "memory_review",
      actor,
      metadata: {
        memoryIdHash: hashOperationIdentifier(memory.id),
        ...(replacement === undefined
          ? {}
          : { replacementMemoryIdHash: hashOperationIdentifier(replacement.id) }),
        reasonHash: hashOperationIdentifier(reason),
        category: input.category === "candidate" ? "candidates" : "memories",
        action: input.action
      },
      startedAt: reviewedAt
    }, reviewedAt);

    const updated = readReviewableMemory(store, memory.id, input.category, true);
    const review = currentMemoryReview(store, input.category, updated);
    if (!review) throw new Error("Memory review could not be read back");
    return {
      memoryId: memory.id,
      category: input.category,
      action: input.action,
      reviewToken: context.reviewToken,
      reviewedAt,
      review,
      memory: updated,
      ...(replacement === undefined ? {} : { replacement }),
      complete: true
    };
  });
}

/**
 * Append-only inverse of a review. Callers must perform their stale-state
 * comparison before invoking this function; the transaction keeps compensation and
 * lifecycle restoration indivisible.
 */
export function compensateMemoryReview(
  store: MemoryStore,
  input: CompensateMemoryReviewInput,
  actor: OperationActor = "system"
): CompensateMemoryReviewResult {
  const revertedAt = normalizeTimestamp(input.now);
  const reason = store.contentPolicy.text(input.reason.trim());
  if (!reason) throw new Error("Revert reason is required");
  return withTransaction(store.db, () => {
    const resolutionId = store.contentPolicy.identifier(input.resolutionId);
    const resolution = store.db.prepare(
      `select id, memory_id, category, layer, action, replacement_memory_id, replacement_category
         from memory_review_resolutions where id = ?`
    ).get(resolutionId) as {
      id: string;
      memory_id: string;
      category: MemoryReviewCategory;
      layer: string;
      action: MemoryReviewAction;
      replacement_memory_id: string | null;
      replacement_category: MemoryReviewCategory | null;
    } | undefined;
    if (!resolution) throw new Error(`Unknown memory review resolution: ${input.resolutionId}`);
    const existing = store.db.prepare(
      "select id, reverted_at from memory_review_resolution_compensations where resolution_id = ?"
    ).get(resolution.id) as { id: string; reverted_at: string } | undefined;
    if (existing) {
      return {
        compensationId: existing.id,
        resolutionId: resolution.id,
        memoryId: resolution.memory_id,
        category: resolution.category,
        ...(resolution.replacement_memory_id === null ? {} : { replacementMemoryId: resolution.replacement_memory_id }),
        revertedAt: existing.reverted_at,
        replayed: true
      };
    }

    assertWritableLayer(store, resolution.category, resolution.memory_id);
    if (resolution.action === "verify") {
      // Verification has no lifecycle side effect; compensation alone removes it
      // from the effective-review view.
    } else if (resolution.category === "promoted") {
      const original = store.readMemory(resolution.memory_id);
      if (!original) throw new Error(`Unknown promoted memory: ${resolution.memory_id}`);
      if (resolution.action === "correct") {
        if (resolution.replacement_category !== "promoted" || !resolution.replacement_memory_id) {
          throw new Error("Correction review is missing its promoted replacement");
        }
        const replacement = store.readMemory(resolution.replacement_memory_id);
        if (!replacement) throw new Error(`Unknown replacement memory: ${resolution.replacement_memory_id}`);
        assertWritableLayer(store, "promoted", replacement.id);
        updateMemoryStatus(store, {
          memoryId: original.id,
          status: "current",
          reason,
          now: revertedAt,
          actor
        });
        updateMemoryStatus(store, {
          memoryId: replacement.id,
          status: "retracted",
          reason: `Replacement withdrawn because review ${resolution.id} was reverted.`,
          now: revertedAt,
          actor
        });
      } else {
        updateMemoryStatus(store, {
          memoryId: original.id,
          status: "current",
          reason,
          now: revertedAt,
          actor
        });
      }
    } else if (resolution.action === "correct" && resolution.replacement_category === "candidate" && resolution.replacement_memory_id) {
      const replacement = tryReadReviewableMemory(store, resolution.replacement_memory_id, "candidate");
      if (replacement) {
        resolveMemoryReview(store, {
          memoryId: replacement.id,
          category: "candidate",
          action: "discard",
          reason: `Replacement withdrawn because review ${resolution.id} was reverted.`,
          now: revertedAt
        }, actor);
      }
    }

    const compensationId = `memory-review-revert-${randomUUID()}`;
    store.db.prepare(
      `insert into memory_review_resolution_compensations
         (id, resolution_id, memory_id, category, layer, reason, reverted_at, actor,
          reconciliation_run_id, reconciliation_item_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      compensationId,
      resolution.id,
      resolution.memory_id,
      resolution.category,
      resolution.layer,
      reason,
      revertedAt,
      actor,
      input.reconciliationRunId ?? null,
      input.reconciliationItemId ?? null
    );
    if(resolution.category === "candidate" && resolution.action !== "verify")recordMemoryEvent(store.db,store.contentPolicy,{
      kind:"restored",memoryId:resolution.memory_id,category:"candidate",layer:resolution.layer,
      reason,actor,at:revertedAt,key:"review-restored:"+compensationId});
    return {
      compensationId,
      resolutionId: resolution.id,
      memoryId: resolution.memory_id,
      category: resolution.category,
      ...(resolution.replacement_memory_id === null ? {} : { replacementMemoryId: resolution.replacement_memory_id }),
      revertedAt,
      replayed: false
    };
  });
}

function tryReadReviewableMemory(
  store: MemoryStore,
  id: string,
  category: MemoryReviewCategory
): ReviewableMemory | undefined {
  try {
    return readReviewableMemory(store, id, category, true);
  } catch {
    return undefined;
  }
}

function readReviewableMemory(
  store: MemoryStore,
  rawId: string,
  category: MemoryReviewCategory,
  includePromotedCandidate = false
): ReviewableMemory {
  const id = store.contentPolicy.identifier(rawId);
  if (category === "promoted") {
    const memory = store.readMemory(id);
    if (!memory) throw new Error(`Unknown promoted memory: ${rawId}`);
    return memory;
  }
  const memory = store.listMemoryCandidates({ qualityStatus: "all", owner: "any", limit: null })
    .find((candidate) => candidate.id === id && (includePromotedCandidate || candidate.promotionState === "candidate"));
  if (!memory) throw new Error(`Unknown candidate memory: ${rawId}`);
  return memory;
}

function normalizeReviewReason(store: MemoryStore, action: MemoryReviewAction, raw: string | undefined): string {
  const reason = (raw ?? (action === "verify" ? VERIFY_REASON : "")).trim();
  if (!reason) throw new Error(`${action === "correct" ? "Correction" : "Discard"} reason is required`);
  return store.contentPolicy.text(reason);
}

function normalizeTimestamp(value: string | undefined): string {
  const timestamp = value ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    throw new Error("now must be an ISO-8601 UTC timestamp");
  }
  return timestamp;
}

function assertCategory(value: string): asserts value is MemoryReviewCategory {
  if (value !== "candidate" && value !== "promoted") throw new Error("Invalid memory review category");
}

function assertAction(value: string): asserts value is MemoryReviewAction {
  if (value !== "verify" && value !== "correct" && value !== "discard") {
    throw new Error("Invalid memory review action");
  }
}
