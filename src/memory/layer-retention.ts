import { createHash, randomUUID } from "node:crypto";

import { hashOperationIdentifier, recordCompletedOperation } from "../operations/log.js";
import type {
  DurableMemory,
  LayerRetentionConfig,
  LayerRetentionDecisionKind,
  MemoryCandidate,
  MemoryType,
  OperationActor,
  ProjectConfig
} from "../types.js";
import type { MemoryStore } from "../storage/store.js";
import { withTransaction } from "../storage/transactions.js";
import { CORE_LAYER, layerLabel, parseLayer } from "./layer.js";
import {
  classifyBranch,
  localBranchExists,
  readGitBranchFacts,
  type BranchState,
  type GitBranchFacts
} from "./branch-state.js";
import { updateMemoryStatus } from "./lifecycle-service.js";
import { peerLayers } from "./peer-layer.js";

/**
 * Bumping this re-opens every stored decision, the same contract as
 * PROMOTION_POLICY_VERSION: a policy change is a re-evaluation, not a silent no-op.
 */
export const RETENTION_POLICY_VERSION = 1;

/** An explicit review outranks the policy in both directions. */
const SUPPRESSING_TRIAGE_ACTIONS = new Set(["retain_branch"]);
const ARCHIVE_QUALITY_REASON = "layer_retention_archived";

export type LayerRetentionCategory = "candidate" | "promoted";

export interface LayerRetentionDecision {
  memoryId: string;
  category: LayerRetentionCategory;
  type: MemoryType;
  title: string;
  layer: string;
  layerLabel: string;
  memoryVersion: string;
  policyVersion: number;
  decision: LayerRetentionDecisionKind;
  reasonCodes: string[];
  idleDays: number;
  branch?: string | undefined;
  branchState?: BranchState | undefined;
}

export interface LayerRetentionPlan {
  scanned: number;
  decisions: LayerRetentionDecision[];
  policyVersion: number;
  enabled: boolean;
  complete: true;
}

export interface LayerRetentionSummary {
  scanned: number;
  archived: number;
  skipped: number;
  warnings: string[];
}

export interface PlanLayerRetentionInput {
  repoPath?: string | undefined;
  now?: string | undefined;
  /** Overrides the configured policy; the CLI preview uses this. */
  layers?: Partial<LayerRetentionConfig> | undefined;
}

export interface ApplyLayerRetentionResult {
  memoryId: string;
  category: LayerRetentionCategory;
  decision: LayerRetentionDecisionKind;
  applied: boolean;
  reasonCodes: string[];
}

export interface LayerRetentionDecisionRecord {
  memoryId: string;
  category: LayerRetentionCategory;
  memoryVersion: string;
  policyVersion: number;
  decision: LayerRetentionDecisionKind;
  reasonCodes: string[];
  layer: string;
  decidedAt: string;
  actor: OperationActor;
}

interface RetentionDecisionRow {
  id: string;
  memory_id: string;
  category: LayerRetentionCategory;
  memory_version: string;
  policy_version: number;
  decision: LayerRetentionDecisionKind;
  reason_codes_json: string;
  layer: string;
  decided_at: string;
  actor: OperationActor;
}

interface RetentionItem {
  category: LayerRetentionCategory;
  memory: MemoryCandidate | DurableMemory;
  layer: string;
  kind: "device" | "branch";
  branch?: string | undefined;
  memoryVersion: string;
  lastTouchedAt: string;
}

export function planLayerRetention(
  store: MemoryStore,
  config: ProjectConfig,
  input: PlanLayerRetentionInput = {}
): LayerRetentionPlan {
  const policy = resolvePolicy(config, input.layers);
  if (!policy.enabled) {
    return { scanned: 0, decisions: [], policyVersion: RETENTION_POLICY_VERSION, enabled: false, complete: true };
  }

  const now = parseNow(input.now);
  const items = collectItems(store);
  const git = readGitBranchFacts(input.repoPath);
  const decisions = items
    .map((item) => decide(store, policy, item, git, now))
    .sort((left, right) =>
      decisionPriority(left.decision) - decisionPriority(right.decision) ||
      right.idleDays - left.idleDays ||
      left.category.localeCompare(right.category) ||
      left.title.localeCompare(right.title) ||
      left.memoryId.localeCompare(right.memoryId)
    );

  return {
    scanned: items.length,
    decisions,
    policyVersion: RETENTION_POLICY_VERSION,
    enabled: true,
    complete: true
  };
}

/**
 * Applies one decision in a single transaction. Archival is reversible: a promoted
 * memory is retracted (restorable with updateMemoryStatus) and a candidate is
 * quarantined, so no evidence is destroyed.
 */
export function applyLayerRetention(
  store: MemoryStore,
  decision: LayerRetentionDecision,
  actor: OperationActor = "system",
  now?: string
): ApplyLayerRetentionResult {
  const decidedAt = parseNow(now).toISOString();

  return withTransaction(store.db, () => {
    const unchanged = {
      memoryId: decision.memoryId,
      category: decision.category,
      decision: decision.decision,
      applied: false,
      reasonCodes: decision.reasonCodes
    };
    // Only archival is recorded. A skip is a re-derived observation, not a decision to
    // remember, and persisting one would both grow the table without bound and pin a
    // time-dependent answer to a memory version that never changes.
    if (decision.decision === "skip") return unchanged;
    if (findDecision(store, decision)) return unchanged;

    archive(store, decision, decidedAt, actor);

    upsertDecision(store, {
      id: `layer-retention-${randomUUID()}`,
      memoryId: decision.memoryId,
      category: decision.category,
      memoryVersion: decision.memoryVersion,
      policyVersion: decision.policyVersion,
      decision: decision.decision,
      reasonCodes: decision.reasonCodes,
      layer: decision.layer,
      decidedAt,
      actor
    });

    recordCompletedOperation(store.db, {
      operationType: "layer_retention",
      actor,
      metadata: {
        memoryIdHash: hashOperationIdentifier(decision.memoryId),
        category: decision.category === "candidate" ? "candidates" : "memories",
        decision: decision.decision,
        reasonCodesHash: hashReasonCodes(decision.reasonCodes),
        policyVersion: decision.policyVersion
      },
      startedAt: decidedAt
    }, decidedAt);

    return {
      memoryId: decision.memoryId,
      category: decision.category,
      decision: decision.decision,
      applied: true,
      reasonCodes: decision.reasonCodes
    };
  });
}

/**
 * Runs the plan and applies it. Callers treat a throw as non-fatal: sync has already
 * committed its evidence by this point and retries on the next pass.
 */
export function runLayerRetention(
  store: MemoryStore,
  config: ProjectConfig,
  input: PlanLayerRetentionInput = {},
  actor: OperationActor = "system"
): LayerRetentionSummary {
  const plan = planLayerRetention(store, config, input);
  const summary: LayerRetentionSummary = {
    scanned: plan.scanned,
    archived: 0,
    skipped: plan.decisions.filter((decision) => decision.decision === "skip").length,
    warnings: []
  };
  for (const decision of plan.decisions) {
    if (decision.decision === "skip") continue;
    try {
      const result = applyLayerRetention(store, decision, actor, input.now);
      if (result.applied) summary.archived += 1;
    } catch {
      // Identifiers and content never reach a warning string.
      summary.warnings.push(`Layer retention could not be applied for one ${decision.category} memory`);
    }
  }
  return summary;
}

export function listLayerRetentionDecisions(
  store: MemoryStore,
  input: { memoryId?: string | undefined; limit?: number | undefined } = {}
): LayerRetentionDecisionRecord[] {
  const limit = input.limit === undefined ? 20 : Math.min(Math.max(1, Math.floor(input.limit)), 100);
  const columns = `id, memory_id, category, memory_version, policy_version, decision, reason_codes_json,
                   layer, decided_at, actor`;
  const rows = input.memoryId === undefined
    ? store.db.prepare(
        `select ${columns} from layer_retention_decisions order by decided_at desc, id desc limit ?`
      ).all(limit) as unknown as RetentionDecisionRow[]
    : store.db.prepare(
        `select ${columns} from layer_retention_decisions where memory_id = ?
          order by decided_at desc, id desc limit ?`
      ).all(store.contentPolicy.identifier(input.memoryId), limit) as unknown as RetentionDecisionRow[];
  return rows.map((row) => ({
    memoryId: row.memory_id,
    category: row.category,
    memoryVersion: row.memory_version,
    policyVersion: row.policy_version,
    decision: row.decision,
    reasonCodes: parseReasonCodes(row.reason_codes_json),
    layer: row.layer,
    decidedAt: row.decided_at,
    actor: row.actor
  }));
}

function resolvePolicy(
  config: ProjectConfig,
  overrides: Partial<LayerRetentionConfig> | undefined
): LayerRetentionConfig {
  const configured = config.retention?.layers ?? {
    enabled: false,
    graceDays: 30,
    branch: { onDeleted: "keep", onMerged: "keep", maxIdleDays: null },
    device: { maxIdleDays: null }
  };
  return {
    ...configured,
    ...(overrides ?? {}),
    branch: { ...configured.branch, ...(overrides?.branch ?? {}) },
    device: { ...configured.device, ...(overrides?.device ?? {}) }
  };
}

function collectItems(store: MemoryStore): RetentionItem[] {
  // A peer's partition is expired by the device that owns it, not here.
  const peers = new Set(peerLayers(store));
  const candidates = store
    .listMemoryCandidates({ promotionState: "candidate", qualityStatus: "all", limit: null })
    .map((memory) => toItem("candidate", memory))
    .filter((item): item is RetentionItem => item !== undefined);
  const promoted = store
    .listMemories({ lifecycleStatus: "current", qualityStatus: "all", limit: null })
    .map((memory) => toItem("promoted", memory))
    .filter((item): item is RetentionItem => item !== undefined);
  return [...candidates, ...promoted].filter((item) => !peers.has(item.layer));
}

function toItem(
  category: LayerRetentionCategory,
  memory: MemoryCandidate | DurableMemory
): RetentionItem | undefined {
  const layer = memory.layer ?? CORE_LAYER;
  const parsed = parseLayer(layer);
  // Core is shared truth and never expires here; only this device's own layers do.
  if (parsed.kind === "core") return undefined;
  const lastTouchedAt = category === "candidate"
    ? (memory as MemoryCandidate).updatedAt
    : (memory as DurableMemory).statusChangedAt;
  return {
    category,
    memory,
    layer,
    kind: parsed.kind,
    ...(parsed.branch === undefined ? {} : { branch: parsed.branch }),
    memoryVersion: category === "candidate"
      ? (memory as MemoryCandidate).updatedAt
      : (memory as DurableMemory).lifecycleGeneration,
    lastTouchedAt
  };
}

function decide(
  store: MemoryStore,
  policy: LayerRetentionConfig,
  item: RetentionItem,
  git: GitBranchFacts,
  now: Date
): LayerRetentionDecision {
  const idleDays = Math.max(0, Math.floor((now.getTime() - Date.parse(item.lastTouchedAt)) / 86400000));
  const branchState = item.branch === undefined
    ? undefined
    : classifyBranch(item.branch, item.lastTouchedAt, git, policy.graceDays, now);
  const base = {
    memoryId: item.memory.id,
    category: item.category,
    type: item.memory.type,
    title: item.memory.title,
    layer: item.layer,
    layerLabel: layerLabel(item.layer),
    memoryVersion: item.memoryVersion,
    policyVersion: RETENTION_POLICY_VERSION,
    idleDays,
    ...(item.branch === undefined ? {} : { branch: item.branch }),
    ...(branchState === undefined ? {} : { branchState })
  };
  const skip = (...codes: string[]): LayerRetentionDecision =>
    ({ ...base, decision: "skip", reasonCodes: [...codes].sort() });

  // Deliberately no cached-skip short-circuit here. Unlike a promotion decision,
  // this policy takes the clock as an input, so a `within_grace_period` skip must be
  // re-derived every pass rather than pinned to a memory version that never changes.
  // Idempotency comes from the other direction: an archived memory is no longer
  // `current`, so the lifecycle and quality checks below skip it for free.

  // An explicit retain review outranks the policy.
  if (findSuppressingReview(store, item.memory.id, item.category, item.memoryVersion)) {
    return skip("suppressed_by_retain_branch_review");
  }
  // Already archived by some other path; nothing to do.
  if (item.category === "promoted" && (item.memory as DurableMemory).lifecycleStatus !== "current") {
    return skip(`lifecycle_${(item.memory as DurableMemory).lifecycleStatus}`);
  }
  if (item.category === "candidate" && item.memory.qualityStatus === "quarantined") {
    return skip("already_quarantined");
  }
  // The grace period applies to every rule, so recent work is never touched.
  if (idleDays < policy.graceDays) return skip("within_grace_period");

  if (item.kind === "branch") {
    if (branchState === undefined || branchState === "unknown") return skip("branch_state_unknown");
    if (branchState === "current" || branchState === "active") return skip(`branch_${branchState}`);
    if (branchState === "merged") {
      // Merged branches belong to promotion and triage, not retention.
      return policy.branch.onMerged === "archive"
        ? { ...base, decision: "archive", reasonCodes: ["branch_merged_to_default", "idle_past_grace_period"].sort() }
        : skip("branch_merged_left_to_promotion");
    }
    // `stale` covers two distinct causes — the branch is gone, or it still exists but
    // its work aged out — and each maps to its own policy key, so ask git directly
    // rather than inferring the cause from the state.
    if (policy.branch.onDeleted === "archive" && item.branch !== undefined && !localBranchExists(git, item.branch)) {
      return { ...base, decision: "archive", reasonCodes: ["branch_deleted", "idle_past_grace_period"].sort() };
    }
    if (policy.branch.maxIdleDays !== null && idleDays >= policy.branch.maxIdleDays) {
      return { ...base, decision: "archive", reasonCodes: ["branch_idle_past_max_age"].sort() };
    }
    return skip("branch_retained_by_policy");
  }

  if (policy.device.maxIdleDays !== null && idleDays >= policy.device.maxIdleDays) {
    return { ...base, decision: "archive", reasonCodes: ["device_idle_past_max_age"].sort() };
  }
  return skip("device_retention_disabled");
}

function archive(
  store: MemoryStore,
  decision: LayerRetentionDecision,
  now: string,
  actor: OperationActor
): void {
  if (decision.category === "promoted") {
    updateMemoryStatus(store, {
      memoryId: decision.memoryId,
      status: "retracted",
      reason: archiveReason(decision),
      now,
      actor
    });
    return;
  }
  const current = store
    .listMemoryCandidates({ qualityStatus: "all", limit: null })
    .find((item) => item.id === decision.memoryId);
  if (!current) return;
  store.updateMemoryQuality("candidate", decision.memoryId, {
    qualityStatus: "quarantined",
    qualityReasons: [...new Set([...current.qualityReasons, ARCHIVE_QUALITY_REASON])].sort(),
    lastVerifiedAt: now
  });
}

function archiveReason(decision: LayerRetentionDecision): string {
  return `Layer retention archive (policy v${decision.policyVersion}): ${decision.reasonCodes.join(", ")}.`;
}

function findSuppressingReview(
  store: MemoryStore,
  memoryId: string,
  category: LayerRetentionCategory,
  memoryVersion: string
): boolean {
  const row = store.db.prepare(
    `select action from branch_triage_reviews
      where memory_id = ? and category = ? and memory_version = ?
      order by reviewed_at desc, id desc
      limit 1`
  ).get(memoryId, category, memoryVersion) as { action: string } | undefined;
  return row !== undefined && SUPPRESSING_TRIAGE_ACTIONS.has(row.action);
}

function findDecision(
  store: MemoryStore,
  decision: Pick<LayerRetentionDecision, "memoryId" | "category" | "memoryVersion" | "policyVersion">
): RetentionDecisionRow | undefined {
  return store.db.prepare(
    `select id, memory_id, category, memory_version, policy_version, decision, reason_codes_json,
            layer, decided_at, actor
       from layer_retention_decisions
      where memory_id = ? and category = ? and memory_version = ? and policy_version = ?`
  ).get(
    decision.memoryId,
    decision.category,
    decision.memoryVersion,
    decision.policyVersion
  ) as RetentionDecisionRow | undefined;
}

function upsertDecision(
  store: MemoryStore,
  input: {
    id: string;
    memoryId: string;
    category: LayerRetentionCategory;
    memoryVersion: string;
    policyVersion: number;
    decision: LayerRetentionDecisionKind;
    reasonCodes: string[];
    layer: string;
    decidedAt: string;
    actor: OperationActor;
  }
): void {
  store.db.prepare(
    `insert into layer_retention_decisions
       (id, memory_id, category, memory_version, policy_version, decision, reason_codes_json,
        layer, decided_at, actor)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(memory_id, category, memory_version, policy_version) do update set
       id = excluded.id,
       decision = excluded.decision,
       reason_codes_json = excluded.reason_codes_json,
       layer = excluded.layer,
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
    input.layer,
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

function parseNow(value: string | undefined): Date {
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("now must be a valid timestamp");
  return date;
}

function decisionPriority(decision: LayerRetentionDecisionKind): number {
  return decision === "archive" ? 0 : 1;
}
