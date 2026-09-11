import { createHash, randomUUID } from "node:crypto";

import { hashOperationIdentifier, recordCompletedOperation } from "../operations/log.js";
import type {
  AutomaticPromotionConfig,
  AutomaticPromotionDecisionKind,
  DurableMemory,
  MemoryCandidate,
  MemoryType,
  OperationActor,
  ProjectConfig
} from "../types.js";
import type { MemoryStore } from "../storage/store.js";
import { withTransaction } from "../storage/transactions.js";
import { CORE_LAYER, layerLabel, parseLayer } from "./layer.js";
import {
  memoryFactsConflict,
  memorySubjectGroupKey,
  normalizeMemorySummary,
  type ComparableMemoryFact
} from "./conflicts.js";
import { createEvidenceSignature } from "./evidence-signature.js";
import { scopeKey } from "./scope.js";
import { updateMemoryLayer } from "./layer-service.js";
import { suggestBranchMemoryTriage, type BranchTriageState } from "./branch-triage.js";
import { suggestMemoryLayerPromotions } from "./layer-promotion.js";
import { peerLayers } from "./peer-layer.js";

/**
 * Bumping this re-opens every stored decision, including deferrals a previous
 * policy declined. Decisions are keyed by it so a policy change is a re-evaluation
 * rather than a silent no-op.
 */
export const PROMOTION_POLICY_VERSION = 1;

export type AutomaticPromotionCategory = "candidate" | "promoted";

export interface AutomaticPromotionDecision {
  memoryId: string;
  category: AutomaticPromotionCategory;
  type: MemoryType;
  title: string;
  currentLayer: string;
  currentLayerLabel: string;
  memoryVersion: string;
  policyVersion: number;
  decision: AutomaticPromotionDecisionKind;
  reasonCodes: string[];
  score: number;
  branchState?: BranchTriageState | undefined;
  /** Set for `converge`: the existing core memory this fact resolves to. */
  coreMemoryId?: string | undefined;
}

export interface AutomaticPromotionPlan {
  scanned: number;
  decisions: AutomaticPromotionDecision[];
  policyVersion: number;
  enabled: boolean;
  complete: true;
}

export interface AutomaticPromotionSummary {
  scanned: number;
  promoted: number;
  converged: number;
  deferred: number;
  skipped: number;
  warnings: string[];
}

export interface PlanAutomaticPromotionsInput {
  repoPath?: string | undefined;
  now?: string | undefined;
  /** Overrides the configured policy; the CLI preview uses this. */
  automatic?: Partial<AutomaticPromotionConfig> | undefined;
}

export interface ApplyAutomaticPromotionResult {
  memoryId: string;
  category: AutomaticPromotionCategory;
  decision: AutomaticPromotionDecisionKind;
  applied: boolean;
  reasonCodes: string[];
  promotedMemoryId?: string | undefined;
  coreMemoryId?: string | undefined;
}

interface PromotionDecisionRow {
  id: string;
  memory_id: string;
  category: AutomaticPromotionCategory;
  memory_version: string;
  policy_version: number;
  decision: AutomaticPromotionDecisionKind;
  reason_codes_json: string;
  target_layer: string | null;
  core_memory_id: string | null;
  decided_at: string;
  actor: OperationActor;
}

interface PlanItem {
  category: AutomaticPromotionCategory;
  memory: MemoryCandidate | DurableMemory;
  layer: string;
  memoryVersion: string;
  score: number;
  branchState?: BranchTriageState | undefined;
}

const SUPPRESSING_TRIAGE_ACTIONS = new Set(["retain_branch", "discard"]);

export function planAutomaticPromotions(
  store: MemoryStore,
  config: ProjectConfig,
  input: PlanAutomaticPromotionsInput = {}
): AutomaticPromotionPlan {
  const policy: AutomaticPromotionConfig = { ...config.promotion.automatic, ...(input.automatic ?? {}) };
  if (!policy.enabled) {
    return { scanned: 0, decisions: [], policyVersion: PROMOTION_POLICY_VERSION, enabled: false, complete: true };
  }

  const items = collectPlanItems(store, policy, input);
  const coreMemories = store.listMemories({
    lifecycleStatus: "current",
    qualityStatus: "all",
    layer: "core",
    limit: null
  });
  const coreBySubject = groupCoreBySubject(coreMemories);
  const decisions = items
    .map((item) => decide(store, config, policy, item, coreBySubject))
    .sort((left, right) =>
      decisionPriority(left.decision) - decisionPriority(right.decision) ||
      right.score - left.score ||
      left.category.localeCompare(right.category) ||
      left.title.localeCompare(right.title) ||
      left.memoryId.localeCompare(right.memoryId)
    );

  return {
    scanned: items.length,
    decisions,
    policyVersion: PROMOTION_POLICY_VERSION,
    enabled: true,
    complete: true
  };
}

/**
 * Applies one decision in a single transaction. Convergence and preflight checks
 * run before any write, so no automatic path can surface a raw uniqueness error.
 */
export function applyAutomaticPromotion(
  store: MemoryStore,
  decision: AutomaticPromotionDecision,
  actor: OperationActor = "system",
  now?: string
): ApplyAutomaticPromotionResult {
  const decidedAt = (now === undefined ? new Date() : new Date(now)).toISOString();
  if (Number.isNaN(Date.parse(decidedAt))) throw new Error("now must be a valid timestamp");

  return withTransaction(store.db, () => {
    const existing = findDecision(store, decision);
    // An unchanged deferral or skip must not write another row or log entry.
    if (existing && existing.decision === decision.decision) {
      return {
        memoryId: decision.memoryId,
        category: decision.category,
        decision: decision.decision,
        applied: false,
        reasonCodes: decision.reasonCodes,
        ...(decision.coreMemoryId === undefined ? {} : { coreMemoryId: decision.coreMemoryId })
      };
    }

    let promotedMemoryId: string | undefined;
    if (decision.decision === "promote") {
      promotedMemoryId = promoteToCore(store, decision, actor);
    } else if (decision.decision === "converge") {
      convergeOnCore(store, decision);
    } else if (decision.decision === "defer") {
      markNeedsReview(store, decision, decidedAt);
    }

    upsertDecision(store, {
      id: `promotion-decision-${randomUUID()}`,
      memoryId: decision.memoryId,
      category: decision.category,
      memoryVersion: decision.memoryVersion,
      policyVersion: decision.policyVersion,
      decision: decision.decision,
      reasonCodes: decision.reasonCodes,
      targetLayer: decision.decision === "promote" ? CORE_LAYER : decision.currentLayer,
      coreMemoryId: decision.coreMemoryId ?? promotedMemoryId,
      decidedAt,
      actor
    });

    const metadata: {
      memoryIdHash: string;
      category: string;
      decision: AutomaticPromotionDecisionKind;
      reasonCodesHash: string;
      policyVersion: number;
      coreMemoryIdHash?: string;
    } = {
      memoryIdHash: hashOperationIdentifier(decision.memoryId),
      category: decision.category === "candidate" ? "candidates" : "memories",
      decision: decision.decision,
      reasonCodesHash: hashReasonCodes(decision.reasonCodes),
      policyVersion: decision.policyVersion
    };
    const coreId = decision.coreMemoryId ?? promotedMemoryId;
    if (coreId !== undefined) metadata.coreMemoryIdHash = hashOperationIdentifier(coreId);
    recordCompletedOperation(store.db, {
      operationType: "automatic_promotion",
      actor,
      metadata,
      startedAt: decidedAt
    }, decidedAt);

    return {
      memoryId: decision.memoryId,
      category: decision.category,
      decision: decision.decision,
      applied: true,
      reasonCodes: decision.reasonCodes,
      ...(promotedMemoryId === undefined ? {} : { promotedMemoryId }),
      ...(decision.coreMemoryId === undefined ? {} : { coreMemoryId: decision.coreMemoryId })
    };
  });
}

/**
 * Runs the plan and applies it. Callers treat a throw as non-fatal: sync has
 * already committed its evidence by this point and retries on the next pass.
 */
export function runAutomaticPromotions(
  store: MemoryStore,
  config: ProjectConfig,
  input: PlanAutomaticPromotionsInput = {},
  actor: OperationActor = "system"
): AutomaticPromotionSummary {
  const plan = planAutomaticPromotions(store, config, input);
  const summary: AutomaticPromotionSummary = {
    scanned: plan.scanned,
    promoted: 0,
    converged: 0,
    deferred: 0,
    skipped: 0,
    warnings: []
  };
  for (const decision of plan.decisions) {
    try {
      const result = applyAutomaticPromotion(store, decision, actor, input.now);
      if (decision.decision === "promote" && result.applied) summary.promoted += 1;
      else if (decision.decision === "converge" && result.applied) summary.converged += 1;
      else if (decision.decision === "defer" && result.applied) summary.deferred += 1;
      else if (decision.decision === "skip" && result.applied) summary.skipped += 1;
    } catch {
      // Identifiers and content never reach a warning string.
      summary.warnings.push(`Automatic promotion could not be applied for one ${decision.category} memory`);
    }
  }
  return summary;
}

export function listPromotionDecisions(
  store: MemoryStore,
  input: { memoryId?: string | undefined; limit?: number | undefined } = {}
): AutomaticPromotionDecisionRecord[] {
  const limit = input.limit === undefined ? 20 : Math.min(Math.max(1, Math.floor(input.limit)), 100);
  const rows = input.memoryId === undefined
    ? store.db.prepare(
        `select id, memory_id, category, memory_version, policy_version, decision, reason_codes_json,
                target_layer, core_memory_id, decided_at, actor
           from promotion_decisions
          order by decided_at desc, id desc
          limit ?`
      ).all(limit) as unknown as PromotionDecisionRow[]
    : store.db.prepare(
        `select id, memory_id, category, memory_version, policy_version, decision, reason_codes_json,
                target_layer, core_memory_id, decided_at, actor
           from promotion_decisions
          where memory_id = ?
          order by decided_at desc, id desc
          limit ?`
      ).all(store.contentPolicy.identifier(input.memoryId), limit) as unknown as PromotionDecisionRow[];
  return rows.map((row) => ({
    memoryId: row.memory_id,
    category: row.category,
    memoryVersion: row.memory_version,
    policyVersion: row.policy_version,
    decision: row.decision,
    reasonCodes: parseReasonCodes(row.reason_codes_json),
    decidedAt: row.decided_at,
    actor: row.actor,
    ...(row.target_layer === null ? {} : { targetLayer: row.target_layer }),
    ...(row.core_memory_id === null ? {} : { coreMemoryId: row.core_memory_id })
  }));
}

export interface AutomaticPromotionDecisionRecord {
  memoryId: string;
  category: AutomaticPromotionCategory;
  memoryVersion: string;
  policyVersion: number;
  decision: AutomaticPromotionDecisionKind;
  reasonCodes: string[];
  decidedAt: string;
  actor: OperationActor;
  targetLayer?: string | undefined;
  coreMemoryId?: string | undefined;
}

function collectPlanItems(
  store: MemoryStore,
  policy: AutomaticPromotionConfig,
  input: PlanAutomaticPromotionsInput
): PlanItem[] {
  // The existing read-only scorer supplies the score and its reason codes; a
  // minScore of 0 here keeps weak items visible so they get a recorded skip.
  const suggestions = suggestMemoryLayerPromotions(store, {
    layer: "all",
    includeCandidates: true,
    minConfidence: 0,
    minScore: 0,
    limit: 100
  });
  const scoreByKey = new Map(suggestions.suggestions.map((item) => [itemKey(item.category, item.memoryId), item.score]));

  const triage = suggestBranchMemoryTriage(store, {
    ...(input.repoPath === undefined ? {} : { repoPath: input.repoPath }),
    includeActive: true,
    includeReviewed: true,
    limit: 100,
    ...(input.now === undefined ? {} : { now: input.now })
  });
  const branchStateByKey = new Map(
    triage.suggestions.map((item) => [itemKey(item.category, item.memoryId), item.branchState])
  );
  // The layer scorer never exceeds 0.75 without multi-source evidence, so on its
  // own it would gate out every merged-branch memory. Taking the stronger of the
  // two keeps merged branches the primary automatic path, while a device memory
  // still has to earn its score through corroboration.
  const triageScoreByKey = new Map(
    triage.suggestions.map((item) => [itemKey(item.category, item.memoryId), item.score])
  );

  const scoreFor = (category: AutomaticPromotionCategory, memoryId: string): number => Math.max(
    scoreByKey.get(itemKey(category, memoryId)) ?? 0,
    triageScoreByKey.get(itemKey(category, memoryId)) ?? 0
  );
  const candidates = store
    .listMemoryCandidates({ promotionState: "candidate", qualityStatus: "all", limit: null })
    .map((memory): PlanItem => ({
      category: "candidate",
      memory,
      layer: memory.layer ?? CORE_LAYER,
      memoryVersion: memory.updatedAt,
      score: scoreFor("candidate", memory.id),
      branchState: branchStateByKey.get(itemKey("candidate", memory.id))
    }));
  const promoted = store
    .listMemories({ lifecycleStatus: "all", qualityStatus: "all", limit: null })
    .map((memory): PlanItem => ({
      category: "promoted",
      memory,
      layer: memory.layer ?? CORE_LAYER,
      memoryVersion: memory.lifecycleGeneration,
      score: scoreFor("promoted", memory.id),
      branchState: branchStateByKey.get(itemKey("promoted", memory.id))
    }));

  const peers = new Set(peerLayers(store));
  return [...candidates, ...promoted].filter((item) => {
    const parsed = parseLayer(item.layer);
    if (parsed.kind === "core") return false;
    // Another device's local finding is theirs to promote; this device cannot even
    // write the row, and promoting it here would duplicate it on the next sync.
    if (peers.has(item.layer)) return false;
    if (parsed.kind === "branch" && !policy.mergedBranches) return false;
    if (parsed.kind === "device" && !policy.deviceMemories) return false;
    return true;
  });
}

function decide(
  store: MemoryStore,
  config: ProjectConfig,
  policy: AutomaticPromotionConfig,
  item: PlanItem,
  coreBySubject: Map<string, DurableMemory[]>
): AutomaticPromotionDecision {
  const memory = item.memory;
  const reasonCodes: string[] = [];
  const base = {
    memoryId: memory.id,
    category: item.category,
    type: memory.type,
    title: memory.title,
    currentLayer: item.layer,
    currentLayerLabel: layerLabel(item.layer),
    memoryVersion: item.memoryVersion,
    policyVersion: PROMOTION_POLICY_VERSION,
    score: item.score,
    ...(item.branchState === undefined ? {} : { branchState: item.branchState })
  };
  const skip = (...codes: string[]): AutomaticPromotionDecision =>
    ({ ...base, decision: "skip", reasonCodes: [...reasonCodes, ...codes].sort() });

  // Identity, memory version and policy version key a decision. If one is on
  // record for this exact key the inputs have not changed, so neither has the
  // answer. Re-deriving it would flip a recorded `defer` to `skip`, because
  // deferral itself sets needs_review, and log a second decision every sync.
  const recorded = findDecision(store, {
    memoryId: memory.id,
    category: item.category,
    memoryVersion: item.memoryVersion,
    policyVersion: PROMOTION_POLICY_VERSION
  });
  if (recorded) {
    return {
      ...base,
      decision: recorded.decision,
      reasonCodes: parseReasonCodes(recorded.reason_codes_json),
      ...(recorded.core_memory_id === null ? {} : { coreMemoryId: recorded.core_memory_id })
    };
  }

  // 1. Quality and lifecycle.
  if (memory.qualityStatus !== "active") return skip(`quality_${memory.qualityStatus}`);
  reasonCodes.push("active_quality");
  if (item.category === "promoted" && (memory as DurableMemory).lifecycleStatus !== "current") {
    return skip(`lifecycle_${(memory as DurableMemory).lifecycleStatus}`);
  }

  // 2. Confidence.
  if (memory.confidence < config.promotion.confidenceThreshold) return skip("below_confidence_threshold");
  reasonCodes.push("meets_confidence_threshold");

  // 3. A shared signal, so one uncorroborated local observation stays local.
  const sharedSignals: string[] = [];
  if (memory.scope?.kind === "project") sharedSignals.push("project_scope");
  const categories = new Set(memory.evidence.map((reference) => reference.sourceType));
  if (categories.size >= config.promotion.minSourceCategories) sharedSignals.push("corroborated_source_categories");
  if (item.branchState === "merged") sharedSignals.push("branch_merged_to_default");
  if (sharedSignals.length === 0) return skip("no_shared_signal");
  reasonCodes.push(...sharedSignals);

  // 4. An explicit branch review outranks the automatic policy.
  const review = findSuppressingReview(store, memory.id, item.category, item.memoryVersion);
  if (review) return skip(`suppressed_by_${review}_review`);

  // 5. Unmerged work in progress stays on its branch.
  if (item.branchState === "current" || item.branchState === "active") {
    return skip(`branch_${item.branchState}`);
  }

  // 6. Score gate, after the cheap disqualifiers have had their say.
  if (item.score < policy.minScore) return skip("below_minimum_score");
  reasonCodes.push("meets_minimum_score");

  // 7. Reconcile against core before proposing any write.
  const equivalent = findCoreEquivalent(memory, coreBySubject);
  if (equivalent.kind === "equivalent") {
    return {
      ...base,
      decision: "converge",
      reasonCodes: [...reasonCodes, "converged_existing_core_fact"].sort(),
      coreMemoryId: equivalent.memory.id
    };
  }
  if (equivalent.kind === "conflicting") {
    return {
      ...base,
      decision: "defer",
      reasonCodes: [...reasonCodes, "core_fact_conflict"].sort(),
      coreMemoryId: equivalent.memory.id
    };
  }
  return { ...base, decision: "promote", reasonCodes: reasonCodes.sort() };
}

type CoreMatch =
  | { kind: "none" }
  | { kind: "equivalent"; memory: DurableMemory }
  | { kind: "conflicting"; memory: DurableMemory };

/**
 * Classifies a non-core fact against current core memory. Both uniqueness keys
 * (`memories` on dedupe/evidence/source/scope/layer and `memory_candidates` on
 * dedupe/scope/layer) trip when an equivalent core row already exists, so this
 * has to run before a layer move rather than after it fails.
 */
export function findCoreEquivalent(
  memory: ComparableMemoryFact & { dedupeKey: string; layer?: string | undefined },
  coreBySubject: Map<string, DurableMemory[]>
): CoreMatch {
  const group = coreBySubject.get(memorySubjectGroupKey(memory)) ?? [];
  const dedupeMatch = group.find((core) =>
    core.dedupeKey === memory.dedupeKey && scopeKey(core.scope) === scopeKey(memory.scope)
  );
  if (dedupeMatch) return { kind: "equivalent", memory: dedupeMatch };
  const summaryMatch = group.find((core) =>
    normalizeMemorySummary(core.summary) === normalizeMemorySummary(memory.summary)
  );
  if (summaryMatch) return { kind: "equivalent", memory: summaryMatch };
  const conflict = group.find((core) => memoryFactsConflict(core, memory));
  if (conflict) return { kind: "conflicting", memory: conflict };
  return { kind: "none" };
}

export function groupCoreBySubject(memories: DurableMemory[]): Map<string, DurableMemory[]> {
  const groups = new Map<string, DurableMemory[]>();
  for (const memory of memories) {
    const key = memorySubjectGroupKey(memory);
    const group = groups.get(key) ?? [];
    group.push(memory);
    groups.set(key, group);
  }
  return groups;
}

function promoteToCore(
  store: MemoryStore,
  decision: AutomaticPromotionDecision,
  actor: OperationActor
): string {
  if (decision.category === "candidate") {
    // Already atomic: writes the durable core row and updates the candidate's
    // promotion state and layer together, so no core candidate is left unpromoted.
    return store.promoteMemoryCandidate(decision.memoryId, "auto", { layer: CORE_LAYER }).id;
  }
  const moved = updateMemoryLayer(store, {
    memoryId: decision.memoryId,
    category: "promoted",
    layer: CORE_LAYER,
    reason: promotionReason(decision)
  }, actor);
  return moved.memoryId;
}

/**
 * Resolves the local fact onto the existing core identity. The candidate keeps its
 * own layer: moving it to core would collide on `unique(dedupe_key, scope_key, layer)`
 * against the row that is already there, which is the failure this path exists to avoid.
 */
function convergeOnCore(store: MemoryStore, decision: AutomaticPromotionDecision): void {
  if (decision.coreMemoryId === undefined) throw new Error("Convergence requires a core memory id");
  if (decision.category !== "candidate") return;
  store.db.prepare(
    `update memory_candidates
        set promotion_state = 'promoted', promoted_memory_id = ?, updated_at = ?
      where id = ?`
  ).run(
    store.contentPolicy.identifier(decision.coreMemoryId),
    new Date().toISOString(),
    store.contentPolicy.identifier(decision.memoryId)
  );
}

function markNeedsReview(store: MemoryStore, decision: AutomaticPromotionDecision, now: string): void {
  const kind = decision.category === "candidate" ? "candidate" : "promoted";
  const current = decision.category === "candidate"
    ? store.listMemoryCandidates({ qualityStatus: "all", limit: null }).find((item) => item.id === decision.memoryId)
    : store.readMemory(decision.memoryId);
  if (!current) return;
  store.updateMemoryQuality(kind, decision.memoryId, {
    qualityStatus: "needs_review",
    qualityReasons: [...new Set([...current.qualityReasons, "automatic_promotion_conflict"])].sort(),
    lastVerifiedAt: now
  });
}

function promotionReason(decision: AutomaticPromotionDecision): string {
  return `Automatic promotion to core (policy v${decision.policyVersion}): ${decision.reasonCodes.join(", ")}.`;
}

function findSuppressingReview(
  store: MemoryStore,
  memoryId: string,
  category: AutomaticPromotionCategory,
  memoryVersion: string
): string | undefined {
  const row = store.db.prepare(
    `select action from branch_triage_reviews
      where memory_id = ? and category = ? and memory_version = ?
      order by reviewed_at desc, id desc
      limit 1`
  ).get(memoryId, category, memoryVersion) as { action: string } | undefined;
  if (!row || !SUPPRESSING_TRIAGE_ACTIONS.has(row.action)) return undefined;
  return row.action;
}

function findDecision(
  store: MemoryStore,
  decision: Pick<AutomaticPromotionDecision, "memoryId" | "category" | "memoryVersion" | "policyVersion">
): PromotionDecisionRow | undefined {
  return store.db.prepare(
    `select id, memory_id, category, memory_version, policy_version, decision, reason_codes_json,
            target_layer, core_memory_id, decided_at, actor
       from promotion_decisions
      where memory_id = ? and category = ? and memory_version = ? and policy_version = ?`
  ).get(
    decision.memoryId,
    decision.category,
    decision.memoryVersion,
    decision.policyVersion
  ) as PromotionDecisionRow | undefined;
}

function upsertDecision(
  store: MemoryStore,
  input: {
    id: string;
    memoryId: string;
    category: AutomaticPromotionCategory;
    memoryVersion: string;
    policyVersion: number;
    decision: AutomaticPromotionDecisionKind;
    reasonCodes: string[];
    targetLayer: string;
    coreMemoryId?: string | undefined;
    decidedAt: string;
    actor: OperationActor;
  }
): void {
  store.db.prepare(
    `insert into promotion_decisions
       (id, memory_id, category, memory_version, policy_version, decision, reason_codes_json,
        target_layer, core_memory_id, decided_at, actor)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(memory_id, category, memory_version, policy_version) do update set
       id = excluded.id,
       decision = excluded.decision,
       reason_codes_json = excluded.reason_codes_json,
       target_layer = excluded.target_layer,
       core_memory_id = excluded.core_memory_id,
       decided_at = excluded.decided_at,
       actor = excluded.actor`
  ).run(
    input.id,
    input.memoryId,
    input.category,
    input.memoryVersion,
    input.policyVersion,
    input.decision,
    JSON.stringify(input.reasonCodes),
    input.targetLayer,
    input.coreMemoryId ?? null,
    input.decidedAt,
    input.actor
  );
}

function hashReasonCodes(codes: string[]): string {
  return createHash("sha256").update([...codes].sort().join(",")).digest("hex");
}

function parseReasonCodes(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((code): code is string => typeof code === "string") : [];
  } catch {
    return [];
  }
}

function itemKey(category: string, memoryId: string): string {
  return `${category}\0${memoryId}`;
}

function decisionPriority(decision: AutomaticPromotionDecisionKind): number {
  switch (decision) {
    case "promote": return 0;
    case "converge": return 1;
    case "defer": return 2;
    case "skip": return 3;
  }
}

/** Re-exported so callers do not need a second import for the evidence signature. */
export { createEvidenceSignature };
