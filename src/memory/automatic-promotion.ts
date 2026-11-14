import { createHash, randomUUID } from "node:crypto";
import { assertOrdinaryProject } from "../rules/identity.js";

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
import { DEFAULT_CANDIDATE_EXPIRY_DAYS } from "../config.js";
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
import { updateMemoryStatus } from "./lifecycle-service.js";
import { peerLayers } from "./peer-layer.js";
import { lastAttentionDay } from "./usage.js";
import { compensateMemoryReview, resolveMemoryReview } from "./review.js";
import { createMemoryReviewContext, currentMemoryReview, effectiveTerminalMemoryReview } from "./review-state.js";

/**
 * Bumping this re-opens every stored decision, including deferrals a previous
 * policy declined. Decisions are keyed by it so a policy change is a re-evaluation
 * rather than a silent no-op.
 */
export const PROMOTION_POLICY_VERSION = 2;

/** Marks every decision taken by the core-candidate rule; undo selects on it. */
const CORE_CANDIDATE_CODE = "core_candidate";
/** Verifications by a person. MCP (an agent) and system verifies never corroborate. */
const HUMAN_REVIEW_ACTORS = new Set<OperationActor>(["desktop", "cli"]);
const UNDO_REASON = "Automatic promotion undone.";
/** Dedupe-key prefix of replacements an AI review wrote (src/memory/review.ts, reconciliation.ts). */
const AI_REPLACEMENT_PREFIX = "ai-reconciliation:";

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
  /** Core candidates discarded for staying uncorroborated past candidateExpiryDays. */
  expired: number;
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
  assertOrdinaryProject(store.paths.rootDir);
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
 * Most core candidates are uncorroborated, so listing each skip would flood a report.
 * Keeps every other decision and replaces core-candidate skips with counts by reason.
 */
export function collapseCoreCandidateSkips(plan: AutomaticPromotionPlan): AutomaticPromotionPlan & {
  coreCandidateSkips: { total: number; byReason: Record<string, number> };
} {
  const isCoreSkip = (decision: AutomaticPromotionDecision) =>
    decision.decision === "skip" && decision.reasonCodes.includes(CORE_CANDIDATE_CODE);
  const byReason: Record<string, number> = {};
  let total = 0;
  for (const decision of plan.decisions.filter(isCoreSkip)) {
    total += 1;
    for (const code of decision.reasonCodes) {
      if (code !== CORE_CANDIDATE_CODE && code !== "active_quality") byReason[code] = (byReason[code] ?? 0) + 1;
    }
  }
  return { ...plan, decisions: plan.decisions.filter((decision) => !isCoreSkip(decision)), coreCandidateSkips: { total, byReason } };
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
  assertOrdinaryProject(store.paths.rootDir);
  const decidedAt = (now === undefined ? new Date() : new Date(now)).toISOString();
  if (Number.isNaN(Date.parse(decidedAt))) throw new Error("now must be a valid timestamp");

  // A core candidate's corroboration (a verify, its device-local quality) lives outside
  // its version key, so a recorded skip would outlast the verify that should lift it.
  if (decision.decision === "skip" && decision.reasonCodes.includes(CORE_CANDIDATE_CODE)) {
    return {
      memoryId: decision.memoryId,
      category: decision.category,
      decision: decision.decision,
      applied: false,
      reasonCodes: decision.reasonCodes
    };
  }

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
    expired: 0,
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
  // After promotion, so a candidate corroborated in this pass is promoted rather than expired.
  if (plan.enabled) {
    try { summary.expired = expireUnconfirmedCandidates(store, config, input.now).expired; }
    catch { summary.warnings.push("Unconfirmed candidates could not be expired"); }
  }
  return summary;
}

/**
 * Whether a core candidate still lacks the corroboration the core-candidate rule promotes on:
 * no current verification and fewer than two independent sources. The daily AI review asks
 * about these (src/memory/auto-review.ts); the rest expire.
 */
export function awaitsCorroboration(store: MemoryStore, memory: MemoryCandidate): boolean {
  if (parseLayer(memory.layer ?? CORE_LAYER).kind !== "core") return false;
  if (new Set(memory.evidence.map((reference) => reference.sourceId)).size >= 2) return false;
  const review = currentMemoryReview(store, "candidate", memory);
  return !(review?.action === "verify" && review.current);
}

/** Reason prefix of expiry discards; with actor, action and time it identifies one expiry pass. */
export const CANDIDATE_EXPIRY_REASON_PREFIX = "Unconfirmed after ";
/** Below this many durable memories the candidates are most of what a project remembers, so none expire. */
const EXPIRY_MIN_DURABLE = 10;

export interface CandidateExpiryResult {
  expired: number;
  /** The pass's review time, shared by every discard it wrote; absent when nothing expired. */
  at?: string | undefined;
}

/**
 * Discards candidates that automatic promotion has left unpromoted, and nobody has used,
 * for candidateExpiryDays active days, so the review queue drains without a person.
 *
 * The clock starts at the later of the candidate's last change and its last attention
 * (src/memory/usage.ts: an agent was handed it, or an AI review proposed a correction), on
 * any device. It counts active days, not calendar days, so time away does not count:
 * - a shared (`core`) candidate counts days on which any synced device imported evidence
 *   (`sources` syncs with its original import time);
 * - this device's own (`device:` layer) candidate counts only days this device imported
 *   evidence (local_activity_days), so an idle machine never expires its own.
 *
 * Nothing expires while the project has fewer than EXPIRY_MIN_DURABLE durable memories. A
 * candidate someone has reviewed, one with an undone review (an undone expiry must stay
 * undone), and a quarantined one (it is cleared by hand) are left alone. The discard is an
 * ordinary system review, shared like the candidate; restoreCandidateExpiry undoes a pass.
 */
export function expireUnconfirmedCandidates(store: MemoryStore, config: ProjectConfig, now?: string | undefined): CandidateExpiryResult {
  const policy = config.promotion.automatic;
  const days = policy.candidateExpiryDays ?? DEFAULT_CANDIDATE_EXPIRY_DAYS;
  if (!policy.enabled || policy.coreCandidates === false || days <= 0) return { expired: 0 };
  const durable = store.listMemories({ lifecycleStatus: "current", qualityStatus: "all", layer: "core", limit: null }).length;
  if (durable < EXPIRY_MIN_DURABLE) return { expired: 0 };
  const peers = new Set(peerLayers(store));
  const candidates = store.listMemoryCandidates({ promotionState: "candidate", qualityStatus: "all", limit: null })
    .flatMap((memory): Array<{ memory: MemoryCandidate; clock: "shared" | "local" }> => {
      if (memory.qualityStatus === "quarantined") return [];
      const layer = memory.layer ?? CORE_LAYER, kind = parseLayer(layer).kind;
      if (kind === "core") return [{ memory, clock: "shared" }];
      return kind === "device" && !peers.has(layer) ? [{ memory, clock: "local" }] : [];
    });
  if (candidates.length === 0) return { expired: 0 };
  const sharedDays = (store.db.prepare("select distinct substr(created_at, 1, 10) as day from sources order by day").all() as Array<{ day: string }>)
    .map((row) => row.day);
  const localDays = (store.localDb.prepare("select day from local_activity_days order by day").all() as Array<{ day: string }>)
    .map((row) => row.day);
  // Days strictly after the last touch; the touching day itself does not count.
  const activeDaysSince = (sorted: string[], day: string) => sorted.length - upperBound(sorted, day);
  const reviewedByPerson = store.db.prepare(
    `select 1 from memory_review_resolutions r
      where r.memory_id = ? and r.category = 'candidate'
        and (r.actor in ('desktop', 'cli', 'mcp')
          or exists (select 1 from memory_review_resolution_compensations c where c.resolution_id = r.id))
      limit 1`
  );
  const correctionPending = store.localDb.prepare(
    `select 1 from memory_reconciliation_items
      where memory_id = ? and category = 'candidate' and state = 'awaiting_correction_approval' limit 1`
  );
  const at = now ?? new Date().toISOString();
  let expired = 0;
  for (const { memory, clock } of candidates) {
    const attention = lastAttentionDay(store, "candidate", memory.id);
    const touched = attention !== undefined && attention > memory.updatedAt.slice(0, 10) ? attention : memory.updatedAt.slice(0, 10);
    if (activeDaysSince(clock === "shared" ? sharedDays : localDays, touched) < days) continue;
    if (reviewedByPerson.get(memory.id) || correctionPending.get(memory.id)) continue;
    if (effectiveTerminalMemoryReview(store, "candidate", memory) !== undefined) continue;
    resolveMemoryReview(store, {
      memoryId: memory.id,
      category: "candidate",
      action: "discard",
      reason: `${CANDIDATE_EXPIRY_REASON_PREFIX}${days} active days: not confirmed or used in that time.`,
      reviewToken: createMemoryReviewContext(store, "candidate", memory).reviewToken,
      now: at
    }, "system");
    expired += 1;
  }
  return expired ? { expired, at } : { expired };
}

/** Marks today active for this device's own candidates; sync calls it when it imported evidence. */
export function recordLocalActivityDay(store: MemoryStore, at: string): void {
  store.localDb.prepare("insert or ignore into local_activity_days (day) values (?)").run(at.slice(0, 10));
}

/** Index of the first entry greater than value in a sorted list. */
function upperBound(sorted: string[], value: string): number {
  let low = 0, high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid]! <= value) low = mid + 1; else high = mid;
  }
  return low;
}

export interface CandidateExpiryPass {
  at: string;
  /** Candidates the pass discarded. */
  count: number;
  /** Of those, the ones still discarded by an expiry. */
  restorable: number;
}

const EXPIRY_DISCARDS = `r.category = 'candidate' and r.action = 'discard' and r.actor = 'system' and r.reason like ? || '%'`;
const NOT_UNDONE = "not exists (select 1 from memory_review_resolution_compensations c where c.resolution_id = r.id)";

/**
 * The most recent expiry pass, from the shared review rows, so any device sees it. Counts
 * are per candidate: two devices that expired the same candidate before syncing wrote two
 * discards for it, and both must be undone to restore it.
 */
export function latestCandidateExpiry(store: Pick<MemoryStore, "db">): CandidateExpiryPass | undefined {
  const latest = store.db.prepare(`select max(r.reviewed_at) as at from memory_review_resolutions r where ${EXPIRY_DISCARDS}`)
    .get(CANDIDATE_EXPIRY_REASON_PREFIX) as { at: string | null } | undefined;
  if (!latest?.at) return undefined;
  const ids = passMemoryIds(store, latest.at);
  const restorable = ids.filter((id) => store.db.prepare(
    `select 1 from memory_review_resolutions r where ${EXPIRY_DISCARDS} and r.memory_id = ? and ${NOT_UNDONE} limit 1`
  ).get(CANDIDATE_EXPIRY_REASON_PREFIX, id)).length;
  return { at: latest.at, count: ids.length, restorable };
}

function passMemoryIds(store: Pick<MemoryStore, "db">, at: string): string[] {
  return (store.db.prepare(`select distinct r.memory_id as id from memory_review_resolutions r where ${EXPIRY_DISCARDS} and r.reviewed_at = ?`)
    .all(CANDIDATE_EXPIRY_REASON_PREFIX, at) as Array<{ id: string }>).map((row) => row.id);
}

export interface ExpiredCandidate { id: string; type: string; title: string; summary: string; restored: boolean }

/**
 * The candidates one expiry pass discarded (the latest by default), so a person can check
 * them before restoring. It only reads plain rows, so the desktop can run it on a read-only
 * connection without waiting for a sync to finish.
 */
export function listCandidateExpiry(store: Pick<MemoryStore, "db">, at?: string): { at?: string | undefined; candidates: ExpiredCandidate[] } {
  const pass = at ?? latestCandidateExpiry(store)?.at;
  if (pass === undefined) return { candidates: [] };
  const candidates = passMemoryIds(store, pass).flatMap((id) => {
    const candidate = store.db.prepare("select type, title, summary from memory_candidates where id = ?").get(id) as
      { type: string; title: string; summary: string } | undefined;
    if (!candidate) return [];
    const restored = !store.db.prepare(
      `select 1 from memory_review_resolutions r where ${EXPIRY_DISCARDS} and r.memory_id = ? and ${NOT_UNDONE} limit 1`
    ).get(CANDIDATE_EXPIRY_REASON_PREFIX, id);
    return [{ id, type: candidate.type, title: candidate.title, summary: candidate.summary, restored }];
  });
  return { at: pass, candidates };
}

/**
 * Restores the candidates one expiry pass discarded (the latest by default, or just `ids`), undoing every
 * expiry discard on them, including a duplicate another device wrote before syncing.
 * Restored candidates carry an undone review, so later passes leave them alone.
 */
export function restoreCandidateExpiry(
  store: MemoryStore,
  input: { at?: string | undefined; ids?: readonly string[] | undefined; now?: string | undefined } = {},
  actor: OperationActor = "cli"
): { at?: string | undefined; restored: number } {
  const at = input.at ?? latestCandidateExpiry(store)?.at;
  if (at === undefined) return { restored: 0 };
  const chosen = input.ids ? new Set(input.ids) : undefined;
  let restored = 0;
  withTransaction(store.db, () => {
    for (const memoryId of passMemoryIds(store, at).filter((id) => !chosen || chosen.has(id))) {
      const resolutions = (store.db.prepare(
        `select r.id from memory_review_resolutions r where ${EXPIRY_DISCARDS} and r.memory_id = ? and ${NOT_UNDONE}`
      ).all(CANDIDATE_EXPIRY_REASON_PREFIX, memoryId) as Array<{ id: string }>).map((row) => row.id);
      for (const resolutionId of resolutions) {
        compensateMemoryReview(store, { resolutionId, reason: "Restored an unconfirmed-candidate expiry.", now: input.now }, actor);
      }
      if (resolutions.length) restored += 1;
    }
  });
  return { at, restored };
}

export interface UndoAutomaticPromotionsInput {
  /** Undo this device's core-candidate promotions decided at or after this time. */
  since?: string | undefined;
  /** Undo the promotion of one candidate. */
  memoryId?: string | undefined;
  now?: string | undefined;
}

export interface UndoAutomaticPromotionItem {
  memoryId: string;
  durableMemoryId: string;
  outcome: "undone" | "already_undone" | "changed_since";
}

export interface UndoAutomaticPromotionsResult {
  undone: number;
  skipped: number;
  items: UndoAutomaticPromotionItem[];
}

/**
 * Reverses core-candidate promotions this device decided: the durable copy is withdrawn
 * and the candidate returns to candidate state. Both are synced rows, so other devices
 * see the withdrawal, and the core-candidate rule keeps the candidate unpromoted until
 * a person verifies it again. Nothing is deleted.
 */
export function undoAutomaticPromotions(
  store: MemoryStore,
  input: UndoAutomaticPromotionsInput,
  actor: OperationActor = "cli"
): UndoAutomaticPromotionsResult {
  assertOrdinaryProject(store.paths.rootDir);
  if ((input.since === undefined) === (input.memoryId === undefined)) {
    throw new Error("Undo needs exactly one of since or memoryId");
  }
  if (input.since !== undefined && Number.isNaN(Date.parse(input.since))) throw new Error("since must be a valid timestamp");
  const now = (input.now === undefined ? new Date() : new Date(input.now)).toISOString();
  if (Number.isNaN(Date.parse(now))) throw new Error("now must be a valid timestamp");

  const rows = (input.since !== undefined
    ? store.db.prepare(
        `select memory_id, core_memory_id, reason_codes_json from promotion_decisions
          where decision = 'promote' and category = 'candidate' and policy_version >= 2 and decided_at >= ?
          order by decided_at desc, id desc`
      ).all(new Date(input.since).toISOString())
    : store.db.prepare(
        `select memory_id, core_memory_id, reason_codes_json from promotion_decisions
          where decision = 'promote' and category = 'candidate' and policy_version >= 2 and memory_id = ?
          order by decided_at desc, id desc`
      ).all(store.contentPolicy.identifier(input.memoryId!))
  ) as Array<{ memory_id: string; core_memory_id: string | null; reason_codes_json: string }>;

  const latest = new Map<string, string>();
  for (const row of rows) {
    if (row.core_memory_id === null || latest.has(row.memory_id)) continue;
    if (!parseReasonCodes(row.reason_codes_json).includes(CORE_CANDIDATE_CODE)) continue;
    latest.set(row.memory_id, row.core_memory_id);
  }

  const items: UndoAutomaticPromotionItem[] = [];
  for (const [memoryId, durableMemoryId] of latest) {
    items.push(withTransaction(store.db, () => {
      const candidate = store.db.prepare(
        "select promotion_state, promoted_memory_id from memory_candidates where id = ?"
      ).get(memoryId) as { promotion_state: string; promoted_memory_id: string | null } | undefined;
      const durable = store.readMemory(durableMemoryId);
      const item = { memoryId, durableMemoryId };
      if (!candidate || !durable || candidate.promoted_memory_id !== durableMemoryId) return { ...item, outcome: "changed_since" as const };
      if (candidate.promotion_state === "candidate" && durable.lifecycleStatus === "retracted") {
        return { ...item, outcome: "already_undone" as const };
      }
      if (candidate.promotion_state !== "promoted" || durable.lifecycleStatus !== "current") {
        return { ...item, outcome: "changed_since" as const };
      }
      updateMemoryStatus(store, { memoryId: durableMemoryId, status: "retracted", reason: UNDO_REASON, now, actor });
      // A newer updated_at wins the cloud merge and makes earlier verifications stale.
      store.db.prepare(
        "update memory_candidates set promotion_state = 'candidate', updated_at = ? where id = ?"
      ).run(now, memoryId);
      return { ...item, outcome: "undone" as const };
    }));
  }
  const undone = items.filter((item) => item.outcome === "undone").length;
  return { undone, skipped: items.length - undone, items };
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
  // Uncapped: an item outside a top-N list would score 0 and be recorded as a skip.
  const suggestions = suggestMemoryLayerPromotions(store, {
    layer: "all",
    includeCandidates: true,
    minConfidence: 0,
    minScore: 0,
    limit: null
  });
  const scoreByKey = new Map(suggestions.suggestions.map((item) => [itemKey(item.category, item.memoryId), item.score]));

  const triage = suggestBranchMemoryTriage(store, {
    ...(input.repoPath === undefined ? {} : { repoPath: input.repoPath }),
    includeActive: true,
    includeReviewed: true,
    limit: null,
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
    // A core durable memory is already promoted; a core candidate is promoted in
    // place by the core-candidate rule when it has been corroborated.
    if (parsed.kind === "core") return item.category === "candidate" && policy.coreCandidates !== false;
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

  if (item.category === "candidate" && parseLayer(item.layer).kind === "core") {
    return decideCoreCandidate(store, config, policy, item.memory as MemoryCandidate, base, coreBySubject);
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

/**
 * A core candidate is already shared, so the question is only whether it has been
 * corroborated: a person verified it, its evidence spans independent sources, or an
 * AI review judged it current. Extracted candidates carry an unspecified scope and
 * one source, so the layer score (built for layer moves) is not used here.
 */
function decideCoreCandidate(
  store: MemoryStore,
  config: ProjectConfig,
  policy: AutomaticPromotionConfig,
  memory: MemoryCandidate,
  base: Omit<AutomaticPromotionDecision, "decision" | "reasonCodes">,
  coreBySubject: Map<string, DurableMemory[]>
): AutomaticPromotionDecision {
  const reasonCodes = [CORE_CANDIDATE_CODE];
  const decision = { ...base, score: memory.confidence };
  const skip = (...codes: string[]): AutomaticPromotionDecision =>
    ({ ...decision, decision: "skip", reasonCodes: [...reasonCodes, ...codes].sort() });

  // 1. Quality.
  if (memory.qualityStatus !== "active") return skip(`quality_${memory.qualityStatus}`);
  reasonCodes.push("active_quality");

  const review = currentMemoryReview(store, "candidate", memory);
  const verified = review?.action === "verify" && review.current ? review : undefined;
  const humanVerified = verified !== undefined && HUMAN_REVIEW_ACTORS.has(verified.actor) ? verified : undefined;

  // 2. A withdrawn durable copy (for example an undone promotion) stays withdrawn
  // until a person verifies the candidate again.
  const copy = memory.promotedMemoryId === undefined ? undefined : store.readMemory(memory.promotedMemoryId);
  if (copy?.lifecycleStatus === "superseded") return skip("durable_copy_superseded");
  if (copy?.lifecycleStatus === "retracted" && !(humanVerified && humanVerified.reviewedAt > copy.statusChangedAt)) {
    return skip("previously_withdrawn");
  }

  // 3. Corroboration, each path with its own confidence bar.
  const independentSources = new Set(memory.evidence.map((reference) => reference.sourceId)).size >= 2;
  // An AI review verifies the replacement it just wrote; that is self-confirmation, so
  // only an AI verdict on a memory it did not write corroborates.
  const aiWritten = memory.dedupeKey.startsWith(AI_REPLACEMENT_PREFIX);
  const aiVerified = verified?.actor === "ai" && !aiWritten;
  // The correction itself is that review's verdict on the original's evidence. Without
  // carrying it over, the original is quarantined and its replacement can never promote.
  const aiCorrected = aiWritten && hasCurrentAiCorrection(store, memory.id);
  if (humanVerified) {
    reasonCodes.push("human_verified");
  } else if (independentSources && memory.confidence >= config.promotion.confidenceThreshold) {
    reasonCodes.push("independent_sources", "meets_confidence_threshold");
  } else if (aiVerified && memory.confidence >= (policy.singleSourceMinConfidence ?? 0.9)) {
    reasonCodes.push("ai_verified_current", "meets_single_source_confidence");
  } else if (aiCorrected && memory.confidence >= (policy.singleSourceMinConfidence ?? 0.9)) {
    reasonCodes.push("ai_corrected_replacement", "meets_single_source_confidence");
  } else if (independentSources) {
    return skip("independent_sources", "below_confidence_threshold");
  } else if (aiVerified) {
    return skip("ai_verified_current", "below_single_source_confidence");
  } else if (aiCorrected) {
    return skip("ai_corrected_replacement", "below_single_source_confidence");
  } else if (verified?.actor === "ai" && aiWritten) {
    return skip("ai_self_verified");
  } else {
    return skip("no_corroboration");
  }

  // 4. Reconcile against core before proposing any write.
  const equivalent = findCoreEquivalent(memory, coreBySubject);
  if (equivalent.kind === "equivalent") {
    return {
      ...decision,
      decision: "converge",
      reasonCodes: [...reasonCodes, "converged_existing_core_fact"].sort(),
      coreMemoryId: equivalent.memory.id
    };
  }
  if (equivalent.kind === "conflicting") {
    return {
      ...decision,
      decision: "defer",
      reasonCodes: [...reasonCodes, "core_fact_conflict"].sort(),
      coreMemoryId: equivalent.memory.id
    };
  }
  return { ...decision, decision: "promote", reasonCodes: reasonCodes.sort() };
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
    const promoted = store.promoteMemoryCandidate(decision.memoryId, "auto", { layer: CORE_LAYER, actor });
    // A candidate verified again after an undo reuses its withdrawn durable row.
    if (promoted.lifecycleStatus === "retracted") {
      updateMemoryStatus(store, {
        memoryId: promoted.id,
        status: "current",
        reason: "Verified again after its automatic promotion was undone.",
        now: new Date().toISOString(),
        actor
      });
    }
    return promoted.id;
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

/**
 * An AI correction, not reverted, that wrote this candidate as the replacement of
 * another. A rewrite of a legacy docs-heading or config-key record is still that
 * record's low-signal content in other words, so it does not count.
 */
function hasCurrentAiCorrection(store: MemoryStore, candidateId: string): boolean {
  return store.db.prepare(
    `select 1 from memory_review_resolutions r
       join memory_candidates original on original.id = r.memory_id
      where r.replacement_memory_id = ? and r.replacement_category = 'candidate'
        and r.action = 'correct' and r.actor = 'ai' and r.category = 'candidate'
        and original.dedupe_key not like 'deterministic:docs:%'
        and original.dedupe_key not like 'deterministic:config:%'
        and not exists (select 1 from memory_review_resolution_compensations c where c.resolution_id = r.id)
      limit 1`
  ).get(candidateId) !== undefined;
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
