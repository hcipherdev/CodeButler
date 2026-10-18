import type { MemoryStore } from "../storage/store.js";
import { measured } from "../retrieval/metrics.js";
import {
  localContentHash,
  readLocalMemoryQuality,
  writeLocalMemoryQuality
} from "../storage/local-memory.js";
import type {
  DurableMemory,
  MemoryCandidate,
  MemoryQualityStatus
} from "../types.js";
import { assessMemoryQuality } from "./quality.js";
import { createMemoryReviewContext, type MemoryReviewCategory } from "./review-state.js";

export const MEMORY_QUALITY_POLICY_VERSION = 4;

export interface ResolvedMemoryQuality {
  qualityStatus: MemoryQualityStatus;
  qualityReasons: string[];
  lastVerifiedAt?: string | undefined;
}

type QualityMemory = MemoryCandidate | DurableMemory;

export function resolveMemoryQuality(
  store: MemoryStore,
  category: MemoryReviewCategory,
  memory: QualityMemory,
  now = new Date().toISOString()
): ResolvedMemoryQuality {
  const memoryVersion = memoryVersionFor(category, memory);
  try {
    const fingerprint = createQualityAssessmentFingerprint(store, category, memory);
    const cached = readLocalMemoryQuality(store.localDb, category, memory.id);
    if (
      cached?.memoryVersion === memoryVersion &&
      cached.assessmentFingerprint === fingerprint &&
      cached.policyVersion === MEMORY_QUALITY_POLICY_VERSION
    ) {
      return {
        qualityStatus: cached.qualityStatus,
        qualityReasons: cached.qualityReasons,
        lastVerifiedAt: cached.lastVerifiedAt
      };
    }

    const input = cached === undefined ? memory : {
      ...memory,
      qualityStatus: cached.qualityStatus,
      qualityReasons: cached.qualityReasons,
      lastVerifiedAt: cached.lastVerifiedAt
    };
    const assessment = assessMemoryQuality(store, input, {
      now,
      source: "source" in input ? input.source : undefined,
      currentStatus: cached?.qualityStatus
    });
    const resolved: ResolvedMemoryQuality = {
      qualityStatus: assessment.status,
      qualityReasons: assessment.reasons,
      lastVerifiedAt: assessment.lastVerifiedAt
    };
    writeLocalMemoryQuality(store.localDb, {
      category,
      memoryId: memory.id,
      memoryVersion,
      assessmentFingerprint: fingerprint,
      policyVersion: MEMORY_QUALITY_POLICY_VERSION,
      qualityStatus: resolved.qualityStatus,
      qualityReasons: resolved.qualityReasons,
      lastVerifiedAt: resolved.lastVerifiedAt,
      assessedAt: now
    });
    return resolved;
  } catch {
    return {
      qualityStatus: "needs_review",
      qualityReasons: ["quality_assessment_unavailable"]
    };
  }
}

export function writeExplicitMemoryQuality(
  store: MemoryStore,
  category: MemoryReviewCategory,
  memory: QualityMemory,
  quality: ResolvedMemoryQuality,
  now = new Date().toISOString()
): void {
  const fingerprint = createQualityAssessmentFingerprint(store, category, memory);
  writeLocalMemoryQuality(store.localDb, {
    category,
    memoryId: memory.id,
    memoryVersion: memoryVersionFor(category, memory),
    assessmentFingerprint: fingerprint,
    policyVersion: MEMORY_QUALITY_POLICY_VERSION,
    qualityStatus: quality.qualityStatus,
    qualityReasons: quality.qualityReasons,
    lastVerifiedAt: quality.lastVerifiedAt,
    assessedAt: now
  });
}

export function createQualityAssessmentFingerprint(
  store: MemoryStore,
  category: MemoryReviewCategory,
  memory: QualityMemory
): string {
  const context = createMemoryReviewContext(store, category, memory);
  return localContentHash({
    policyVersion: MEMORY_QUALITY_POLICY_VERSION,
    category,
    memoryVersion: context.memoryVersion,
    reviewToken: context.reviewToken,
    reviews: safeRows(store, `
      select r.id, r.memory_version, r.context_fingerprint, r.action, r.reviewed_at, r.actor,
             r.verdict, r.policy_version,
             case when c.id is null then 0 else 1 end as reverted
        from memory_review_resolutions r
        left join memory_review_resolution_compensations c on c.resolution_id = r.id
       where r.memory_id = ? and r.category = ?
       order by r.reviewed_at, r.id`, memory.id, category),
    branchTriage: safeRows(store, `
      select memory_version, action, reviewed_at from branch_triage_reviews
       where memory_id = ? and category = ? order by reviewed_at, id`, memory.id, category),
    promotion: safeRows(store, `
      select memory_version, policy_version, decision, reason_codes_json, decided_at
        from promotion_decisions where memory_id = ? and category = ? order by decided_at, id`, memory.id, category),
    retention: safeRows(store, `
      select memory_version, policy_version, decision, reason_codes_json, decided_at
        from layer_retention_decisions where memory_id = ? and category = ? order by decided_at, id`, memory.id, category)
  });
}

export function withResolvedQuality<T extends QualityMemory>(
  store: MemoryStore,
  category: MemoryReviewCategory,
  memory: T
): T {
  return measured("quality", () => ({ ...memory, ...resolveMemoryQuality(store, category, memory) }));
}

export function pendingQuality(): ResolvedMemoryQuality {
  return { qualityStatus: "needs_review", qualityReasons: ["quality_assessment_pending"] };
}

function memoryVersionFor(category: MemoryReviewCategory, memory: QualityMemory): string {
  return category === "candidate"
    ? (memory as MemoryCandidate).updatedAt
    : (memory as DurableMemory).lifecycleGeneration;
}

function safeRows(store: MemoryStore, sql: string, ...parameters: string[]): unknown[] {
  try {
    return store.db.prepare(sql).all(...parameters);
  } catch {
    return [];
  }
}
