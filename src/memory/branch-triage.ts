import { randomUUID } from "node:crypto";

import { hashOperationIdentifier, recordCompletedOperation } from "../operations/log.js";
import type { BranchTriageAction, DurableMemory, MemoryCandidate, MemoryType, OperationActor } from "../types.js";
import type { MemoryStore } from "../storage/store.js";
import { withTransaction } from "../storage/transactions.js";
import { CORE_LAYER, layerLabel, parseLayer, sanitizeLayer } from "./layer.js";
import { classifyBranch, readGitBranchFacts, type BranchState } from "./branch-state.js";
import { updateMemoryStatus } from "./lifecycle-service.js";
import { updateMemoryLayer } from "./layer-service.js";
import { assertWritableLayer } from "./peer-layer.js";

export type BranchTriageCategory = "candidate" | "promoted";
/** Shared with layer retention, which classifies the same branches. */
export type BranchTriageState = BranchState;

export interface SuggestBranchMemoryTriageInput {
  repoPath?: string | undefined;
  branch?: string | undefined;
  includeActive?: boolean | undefined;
  staleDays?: number | undefined;
  includeReviewed?: boolean | undefined;
  limit?: number | undefined;
  now?: string | undefined;
}

export interface ResolveBranchMemoryTriageInput {
  memoryId: string;
  category: BranchTriageCategory;
  action: BranchTriageAction;
  reason: string;
  supersedesMemoryId?: string | undefined;
  now?: string | undefined;
}

export interface BranchMemoryTriageSuggestion {
  memoryId: string;
  category: BranchTriageCategory;
  type: MemoryType;
  title: string;
  summary: string;
  branch: string;
  layer: string;
  layerLabel: string;
  branchState: BranchTriageState;
  latestMemoryAt: string;
  reviewed: boolean;
  lastReview?: {
    action: BranchTriageAction;
    reviewedAt: string;
  } | undefined;
  score: number;
  reasons: string[];
  warnings: string[];
  recommendedAction: BranchTriageAction;
  suggestedReason: string;
  action: {
    tool: "resolve_branch_memory_triage";
    arguments: {
      memoryId: string;
      category: BranchTriageCategory;
      action: BranchTriageAction;
      reason: string;
    };
  };
}

export interface BranchMemoryTriageGroup {
  branch: string;
  branchState: BranchTriageState;
  latestMemoryAt: string;
  suggestions: BranchMemoryTriageSuggestion[];
}

export interface SuggestBranchMemoryTriageResult {
  scanned: number;
  eligible: number;
  reviewedHidden: number;
  groups: BranchMemoryTriageGroup[];
  suggestions: BranchMemoryTriageSuggestion[];
  complete: true;
}

export interface ResolveBranchMemoryTriageResult {
  memoryId: string;
  category: BranchTriageCategory;
  action: BranchTriageAction;
  branch: string;
  layer: string;
  reviewedAt: string;
  reviewId: string;
  memoryVersion: string;
  promotedMemoryId?: string | undefined;
  supersedesMemoryId?: string | undefined;
  candidate?: MemoryCandidate | undefined;
  memory?: DurableMemory | undefined;
  complete: true;
}

interface TriageItem {
  category: BranchTriageCategory;
  memory: MemoryCandidate | DurableMemory;
  branch: string;
  layer: string;
  latestMemoryAt: string;
  memoryVersion: string;
}

interface BranchTriageReviewRow {
  id: string;
  memory_id: string;
  category: BranchTriageCategory;
  branch: string;
  layer: string;
  memory_version: string;
  action: BranchTriageAction;
  reason: string;
  reviewed_at: string;
  actor: OperationActor;
  promoted_memory_id: string | null;
  supersedes_memory_id: string | null;
}

const DEFAULT_STALE_DAYS = 30;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DISCARD_REASON = "branch_triage_discarded";

export function suggestBranchMemoryTriage(
  store: MemoryStore,
  input: SuggestBranchMemoryTriageInput = {}
): SuggestBranchMemoryTriageResult {
  const staleDays = normalizeStaleDays(input.staleDays);
  const limit = normalizeLimit(input.limit);
  const now = parseNow(input.now);
  const branchFilter = input.branch === undefined ? undefined : sanitizeBranchFilter(store, input.branch);
  const items = listBranchTriageItems(store)
    .filter((item) => branchFilter === undefined || item.branch === branchFilter);
  const scanned = items.length;
  const latestByBranch = latestMemoryAtByBranch(items);
  const gitFacts = readGitBranchFacts(input.repoPath);
  const stateByBranch = new Map<string, BranchTriageState>();
  for (const [branch, latestMemoryAt] of latestByBranch) {
    stateByBranch.set(branch, classifyBranch(branch, latestMemoryAt, gitFacts, staleDays, now));
  }

  let reviewedHidden = 0;
  const suggestions: BranchMemoryTriageSuggestion[] = [];
  for (const item of items) {
    const branchState = stateByBranch.get(item.branch) ?? "unknown";
    if (!input.includeActive && (branchState === "active" || branchState === "current")) continue;
    const review = findReview(store, item.memory.id, item.category, item.memoryVersion);
    if (review && !input.includeReviewed) {
      reviewedHidden += 1;
      continue;
    }
    suggestions.push(scoreSuggestion(item, branchState, review));
  }

  const sorted = suggestions
    .sort((left, right) =>
      statePriority(left.branchState) - statePriority(right.branchState) ||
      right.score - left.score ||
      left.branch.localeCompare(right.branch) ||
      left.category.localeCompare(right.category) ||
      left.title.localeCompare(right.title) ||
      left.memoryId.localeCompare(right.memoryId)
    );
  const limited = sorted.slice(0, limit);
  return {
    scanned,
    eligible: sorted.length,
    reviewedHidden,
    groups: groupSuggestions(limited),
    suggestions: limited,
    complete: true
  };
}

export function resolveBranchMemoryTriage(
  store: MemoryStore,
  input: ResolveBranchMemoryTriageInput,
  actor: OperationActor = "mcp"
): ResolveBranchMemoryTriageResult {
  assertCategory(input.category);
  assertAction(input.action);
  const reason = input.reason.trim();
  if (!reason) throw new Error("Branch triage reason is required");
  if (input.action !== "promote_to_core" && input.supersedesMemoryId !== undefined) {
    throw new Error("supersedesMemoryId is only allowed with promote_to_core");
  }
  const reviewedAt = parseNow(input.now).toISOString();

  return withTransaction(store.db, () => {
    const item = readTriageItem(store, input.memoryId, input.category);
    const reviewId = `branch-triage-${randomUUID()}`;
    let candidate: MemoryCandidate | undefined;
    let memory: DurableMemory | undefined;
    let promotedMemoryId: string | undefined;

    if (input.action === "promote_to_core") {
      if (input.category === "candidate") {
        memory = store.promoteMemoryCandidate(item.memory.id, "manual", { layer: CORE_LAYER });
        promotedMemoryId = memory.id;
      } else {
        const moved = updateMemoryLayer(store, {
          memoryId: item.memory.id,
          category: "promoted",
          layer: CORE_LAYER,
          reason
        }, actor);
        promotedMemoryId = moved.memoryId;
        memory = store.readMemory(moved.memoryId);
      }
      if (input.supersedesMemoryId !== undefined) {
        updateMemoryStatus(store, {
          memoryId: input.supersedesMemoryId,
          status: "superseded",
          reason,
          replacementMemoryId: promotedMemoryId,
          now: reviewedAt,
          actor
        });
      }
    } else if (input.action === "discard") {
      if (input.category === "candidate") {
        const existingReasons = "qualityReasons" in item.memory ? item.memory.qualityReasons : [];
        store.updateMemoryQuality("candidate", item.memory.id, {
          qualityStatus: "quarantined",
          qualityReasons: [...new Set([...existingReasons, DISCARD_REASON])].sort(),
          lastVerifiedAt: reviewedAt
        });
        candidate = readAnyCandidate(store, item.memory.id);
      } else {
        memory = updateMemoryStatus(store, {
          memoryId: item.memory.id,
          status: "retracted",
          reason,
          now: reviewedAt,
          actor
        });
      }
    } else {
      if (input.category === "candidate") candidate = item.memory as MemoryCandidate;
      else memory = item.memory as DurableMemory;
    }

    upsertReview(store, {
      id: reviewId,
      memoryId: item.memory.id,
      category: item.category,
      branch: item.branch,
      layer: item.layer,
      memoryVersion: item.memoryVersion,
      action: input.action,
      reason,
      reviewedAt,
      actor,
      promotedMemoryId,
      supersedesMemoryId: input.supersedesMemoryId
    });
    const metadata: {
      memoryIdHash: string;
      branchHash: string;
      reasonHash: string;
      category: string;
      action: BranchTriageAction;
      promotedMemoryIdHash?: string;
      supersedesMemoryIdHash?: string;
    } = {
      memoryIdHash: hashOperationIdentifier(item.memory.id),
      branchHash: hashOperationIdentifier(item.branch),
      reasonHash: hashOperationIdentifier(reason),
      category: item.category === "candidate" ? "candidates" : "memories",
      action: input.action
    };
    if (promotedMemoryId !== undefined) metadata.promotedMemoryIdHash = hashOperationIdentifier(promotedMemoryId);
    if (input.supersedesMemoryId !== undefined) metadata.supersedesMemoryIdHash = hashOperationIdentifier(input.supersedesMemoryId);
    recordCompletedOperation(store.db, {
      operationType: "branch_triage",
      actor,
      metadata,
      startedAt: reviewedAt
    }, reviewedAt);

    const result: ResolveBranchMemoryTriageResult = {
      memoryId: item.memory.id,
      category: item.category,
      action: input.action,
      branch: item.branch,
      layer: item.layer,
      reviewedAt,
      reviewId,
      memoryVersion: item.memoryVersion,
      complete: true
    };
    if (promotedMemoryId !== undefined) result.promotedMemoryId = promotedMemoryId;
    if (input.supersedesMemoryId !== undefined) result.supersedesMemoryId = input.supersedesMemoryId;
    if (candidate !== undefined) result.candidate = candidate;
    if (memory !== undefined) result.memory = memory;
    return result;
  });
}

function listBranchTriageItems(store: MemoryStore): TriageItem[] {
  const candidates = store
    .listMemoryCandidates({ promotionState: "candidate", qualityStatus: "all", limit: null })
    .map((memory) => toTriageItem("candidate", memory))
    .filter((item): item is TriageItem => item !== undefined);
  const promoted = store
    .listMemories({ lifecycleStatus: "current", qualityStatus: "all", limit: null })
    .map((memory) => toTriageItem("promoted", memory))
    .filter((item): item is TriageItem => item !== undefined);
  return [...candidates, ...promoted];
}

function toTriageItem(category: BranchTriageCategory, memory: MemoryCandidate | DurableMemory): TriageItem | undefined {
  const layer = memory.layer ?? CORE_LAYER;
  const parsed = parseLayer(layer);
  if (parsed.kind !== "branch" || !parsed.branch) return undefined;
  const latestMemoryAt = category === "candidate"
    ? (memory as MemoryCandidate).updatedAt
    : (memory as DurableMemory).promotedAt;
  const memoryVersion = category === "candidate"
    ? (memory as MemoryCandidate).updatedAt
    : (memory as DurableMemory).lifecycleGeneration;
  return {
    category,
    memory,
    branch: parsed.branch,
    layer,
    latestMemoryAt,
    memoryVersion
  };
}

function readTriageItem(store: MemoryStore, rawId: string, category: BranchTriageCategory): TriageItem {
  const id = store.contentPolicy.identifier(rawId);
  const memory = category === "candidate" ? readCandidate(store, id) : store.readMemory(id);
  if (!memory) throw new Error(`Unknown ${category} memory: ${rawId}`);
  if (category === "promoted" && (memory as DurableMemory).lifecycleStatus !== "current") {
    throw new Error("Only current promoted branch memories can be resolved");
  }
  const item = toTriageItem(category, memory);
  if (!item) throw new Error("Memory is not in a branch layer");
  assertWritableLayer(store, category === "candidate" ? "candidate" : "promoted", id);
  return item;
}

function readCandidate(store: MemoryStore, id: string): MemoryCandidate | undefined {
  return store
    .listMemoryCandidates({ promotionState: "candidate", qualityStatus: "all", limit: null })
    .find((candidate) => candidate.id === id);
}

function readAnyCandidate(store: MemoryStore, id: string): MemoryCandidate | undefined {
  return store
    .listMemoryCandidates({ qualityStatus: "all", limit: null })
    .find((candidate) => candidate.id === id);
}

function scoreSuggestion(
  item: TriageItem,
  branchState: BranchTriageState,
  review: BranchTriageReviewRow | undefined
): BranchMemoryTriageSuggestion {
  const reasons = new Set<string>([`${branchState}_branch`, `${item.category}_memory`]);
  const warnings = new Set<string>();
  let score = 0.4;

  if (branchState === "merged") {
    score += 0.35;
    reasons.add("branch_merged_to_default");
  } else if (branchState === "stale") {
    score += 0.25;
    reasons.add("branch_missing_or_old");
  } else if (branchState === "active") {
    score += 0.1;
    warnings.add("branch_still_active");
  } else if (branchState === "current") {
    score += 0.05;
    warnings.add("current_branch_memory");
  } else {
    warnings.add("git_state_unavailable");
  }

  if (item.memory.qualityStatus === "active") {
    score += 0.15;
    reasons.add("active_quality");
  } else if (item.memory.qualityStatus === "quarantined") {
    warnings.add("quarantined_quality");
  } else {
    warnings.add("needs_quality_review");
  }
  if (item.memory.confidence >= 0.8) {
    score += 0.1;
    reasons.add("high_confidence");
  }
  if (item.memory.scope?.kind === "project") {
    score += 0.1;
    reasons.add("project_scope");
  }

  const recommendedAction = recommendAction(item, branchState);
  const suggestedReason = suggestedResolutionReason(recommendedAction, item, branchState, reasons);
  const suggestion: BranchMemoryTriageSuggestion = {
    memoryId: item.memory.id,
    category: item.category,
    type: item.memory.type,
    title: item.memory.title,
    summary: item.memory.summary,
    branch: item.branch,
    layer: item.layer,
    layerLabel: layerLabel(item.layer),
    branchState,
    latestMemoryAt: item.latestMemoryAt,
    reviewed: review !== undefined,
    score: Math.min(1, Number(score.toFixed(2))),
    reasons: [...reasons].sort(),
    warnings: [...warnings].sort(),
    recommendedAction,
    suggestedReason,
    action: {
      tool: "resolve_branch_memory_triage",
      arguments: {
        memoryId: item.memory.id,
        category: item.category,
        action: recommendedAction,
        reason: suggestedReason
      }
    }
  };
  if (review !== undefined) {
    suggestion.lastReview = { action: review.action, reviewedAt: review.reviewed_at };
  }
  return suggestion;
}

function recommendAction(item: TriageItem, branchState: BranchTriageState): BranchTriageAction {
  if (item.memory.qualityStatus === "quarantined") return "discard";
  if (
    (branchState === "merged" || branchState === "stale") &&
    item.memory.qualityStatus === "active" &&
    item.memory.confidence >= 0.8
  ) {
    return "promote_to_core";
  }
  if (branchState === "stale" && item.memory.qualityStatus !== "active") return "discard";
  return "retain_branch";
}

function suggestedResolutionReason(
  action: BranchTriageAction,
  item: TriageItem,
  branchState: BranchTriageState,
  reasons: ReadonlySet<string>
): string {
  if (action === "promote_to_core") {
    return `Promote branch memory from ${item.branch} to core after triage: ${[...reasons].sort().join(", ")}.`;
  }
  if (action === "discard") {
    return `Discard branch memory from ${item.branch} after triage: ${branchState}_branch.`;
  }
  return `Retain branch memory on ${item.branch} after triage: ${branchState}_branch.`;
}

function latestMemoryAtByBranch(items: TriageItem[]): Map<string, string> {
  const latest = new Map<string, string>();
  for (const item of items) {
    const existing = latest.get(item.branch);
    if (existing === undefined || item.latestMemoryAt > existing) latest.set(item.branch, item.latestMemoryAt);
  }
  return latest;
}

function groupSuggestions(suggestions: BranchMemoryTriageSuggestion[]): BranchMemoryTriageGroup[] {
  const groups = new Map<string, BranchMemoryTriageGroup>();
  for (const suggestion of suggestions) {
    const existing = groups.get(suggestion.branch);
    if (existing) {
      existing.suggestions.push(suggestion);
      if (suggestion.latestMemoryAt > existing.latestMemoryAt) existing.latestMemoryAt = suggestion.latestMemoryAt;
      continue;
    }
    groups.set(suggestion.branch, {
      branch: suggestion.branch,
      branchState: suggestion.branchState,
      latestMemoryAt: suggestion.latestMemoryAt,
      suggestions: [suggestion]
    });
  }
  return [...groups.values()].sort((left, right) =>
    statePriority(left.branchState) - statePriority(right.branchState) ||
    left.branch.localeCompare(right.branch)
  );
}

function sanitizeBranchFilter(store: MemoryStore, branch: string): string {
  const sanitized = sanitizeLayer(store.contentPolicy, `branch:${branch}`);
  const parsed = parseLayer(sanitized);
  if (parsed.kind !== "branch" || !parsed.branch) throw new Error("branch must be a valid Git branch name");
  return parsed.branch;
}

function findReview(
  store: MemoryStore,
  memoryId: string,
  category: BranchTriageCategory,
  memoryVersion: string
): BranchTriageReviewRow | undefined {
  return store.db.prepare(
    `select id, memory_id, category, branch, layer, memory_version, action, reason, reviewed_at, actor,
            promoted_memory_id, supersedes_memory_id
       from branch_triage_reviews
      where memory_id = ? and category = ? and memory_version = ?
      order by reviewed_at desc, id desc
      limit 1`
  ).get(memoryId, category, memoryVersion) as BranchTriageReviewRow | undefined;
}

function upsertReview(
  store: MemoryStore,
  input: {
    id: string;
    memoryId: string;
    category: BranchTriageCategory;
    branch: string;
    layer: string;
    memoryVersion: string;
    action: BranchTriageAction;
    reason: string;
    reviewedAt: string;
    actor: OperationActor;
    promotedMemoryId?: string | undefined;
    supersedesMemoryId?: string | undefined;
  }
): void {
  store.db.prepare(
    `insert into branch_triage_reviews
       (id, memory_id, category, branch, layer, memory_version, action, reason, reviewed_at, actor,
        promoted_memory_id, supersedes_memory_id)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(memory_id, category, memory_version) do update set
       id = excluded.id,
       branch = excluded.branch,
       layer = excluded.layer,
       action = excluded.action,
       reason = excluded.reason,
       reviewed_at = excluded.reviewed_at,
       actor = excluded.actor,
       promoted_memory_id = excluded.promoted_memory_id,
       supersedes_memory_id = excluded.supersedes_memory_id`
  ).run(
    input.id,
    input.memoryId,
    input.category,
    input.branch,
    input.layer,
    input.memoryVersion,
    input.action,
    store.contentPolicy.text(input.reason),
    input.reviewedAt,
    input.actor,
    input.promotedMemoryId ?? null,
    input.supersedesMemoryId ?? null
  );
}

function assertCategory(category: string): asserts category is BranchTriageCategory {
  if (category !== "candidate" && category !== "promoted") throw new Error("category must be candidate or promoted");
}

function assertAction(action: string): asserts action is BranchTriageAction {
  if (action !== "promote_to_core" && action !== "discard" && action !== "retain_branch") {
    throw new Error("action must be promote_to_core, discard, or retain_branch");
  }
}

function normalizeStaleDays(value: number | undefined): number {
  if (value === undefined) return DEFAULT_STALE_DAYS;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("staleDays must be a positive integer");
  return value;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("limit must be a positive integer");
  return Math.min(value, MAX_LIMIT);
}

function parseNow(value: string | undefined): Date {
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("now must be a valid timestamp");
  return date;
}

function statePriority(state: BranchTriageState): number {
  switch (state) {
    case "merged": return 0;
    case "stale": return 1;
    case "unknown": return 2;
    case "active": return 3;
    case "current": return 4;
  }
}
