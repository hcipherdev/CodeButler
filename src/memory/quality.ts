import type { MemoryStore } from "../storage/store.js";
import type {
  DurableMemory,
  EvidenceRef,
  ExtractedMemory,
  MemoryCandidate,
  MemoryLayerOwner,
  MemoryQualityStatus
} from "../types.js";
import {
  currentMemoryReview,
  effectiveTerminalMemoryReview,
  matchingMemoryVerification,
  type MemoryReviewCategory
} from "./review-state.js";
import { hasExactLegacyV1Signature } from "./legacy.js";
import { assessClaim, claimText } from "./statement.js";

export interface MemoryQualityAssessment {
  status: MemoryQualityStatus;
  reasons: string[];
  rejected: boolean;
  resolvedEvidenceCount: number;
  unresolvedEvidenceCount: number;
  lastVerifiedAt: string;
}

export interface MemoryAuditChange {
  kind: "candidate" | "promoted";
  id: string;
  title: string;
  previousStatus: MemoryQualityStatus;
  nextStatus: MemoryQualityStatus;
  reasons: string[];
}

export interface MemoryAuditResult {
  scanned: number;
  total: number;
  historicalTotal: number;
  complete: boolean;
  active: number;
  needsReview: number;
  quarantined: number;
  rejected: number;
  retired: number;
  replaced: number;
  updated: number;
  changes: MemoryAuditChange[];
  topReasons: Array<{ reason: string; count: number }>;
}

type AuditableMemory = ExtractedMemory | MemoryCandidate | DurableMemory;

export interface LiveMemoryPopulationEntry {
  category: MemoryReviewCategory;
  memory: MemoryCandidate | DurableMemory;
}

export interface MemoryPopulationSnapshot {
  candidates: MemoryCandidate[];
  promoted: DurableMemory[];
  live: LiveMemoryPopulationEntry[];
  historicalTotal: number;
  retired: number;
  replaced: number;
}

const MANUAL_REVIEW_QUARANTINE_REASONS = new Set([
  "manual_review_corrected",
  "manual_review_discarded"
]);
const PRESERVED_QUALITY_REASONS = new Set([
  "branch_triage_discarded",
  "layer_retention_archived",
  "automatic_promotion_conflict",
  "cloud_merge_conflict",
  // v19 recorded this assessment before v20 moved quality device-local. Keep
  // near-matches reviewable, while legacy-v1 retirement still requires the
  // complete exact structural signature.
  "legacy_low_signal_heuristic"
]);

export function assessMemoryQuality(
  store: MemoryStore,
  memory: AuditableMemory,
  options: {
    now?: string | undefined;
    source?: DurableMemory["source"] | undefined;
    currentStatus?: MemoryQualityStatus | undefined;
    potentialConflict?: boolean | undefined;
    ignoreReviewResolution?: boolean | undefined;
  } = {}
): MemoryQualityAssessment {
  const reasons = new Set<string>();
  const parts = [memory.title, claimText(memory), memory.reason, ...Object.values(memory.statement?.fields ?? {})];
  const text = parts.join("\n");

  if (!Number.isFinite(memory.confidence) || memory.confidence < 0 || memory.confidence > 1) {
    reasons.add("invalid_confidence");
  } else if (memory.confidence < 0.6) {
    reasons.add("low_confidence");
  }

  if (memory.evidence.length === 0) {
    reasons.add("missing_evidence");
  }

  const resolvedEvidenceCount = memory.evidence.filter((evidence) => evidenceExists(store, evidence)).length;
  const unresolvedEvidenceCount = memory.evidence.length - resolvedEvidenceCount;
  if (memory.evidence.length > 0 && unresolvedEvidenceCount > 0) {
    reasons.add("unresolved_evidence");
  }

  if (isHtmlOrMarkup(text)) reasons.add("html_or_markup_content");
  if (assessClaim(memory) === "missing_claim") reasons.add("missing_claim");
  if (isCodeOrDiff(text)) reasons.add("code_or_diff_content");
  if (parts.some(isJsonFragment)) reasons.add("json_fragment_content");
  if (parts.some(isTableFragment)) reasons.add("table_fragment_content");
  if (hasVeryLowProseRatio(text)) reasons.add("low_prose_ratio");
  if (isLegacyLowSignalMemory(memory)) reasons.add("legacy_low_signal_heuristic");
  if (hasNewerRelatedCommits(store, memory, options.source)) reasons.add("stale_related_file_evidence");
  if (options.potentialConflict ?? hasPotentialConflict(store, memory)) reasons.add("potential_conflict");

  // Device-local decisions remain cached until their fingerprint changes. Shared
  // review outcomes below are authoritative and do not depend on cached labels.
  if ("qualityReasons" in memory) {
    for (const reason of memory.qualityReasons) {
      if (PRESERVED_QUALITY_REASONS.has(reason)) reasons.add(reason);
    }
  }

  if (!options.ignoreReviewResolution && "id" in memory) {
    const category: MemoryReviewCategory | undefined = "promotionState" in memory
      ? "candidate"
      : "lifecycleStatus" in memory
        ? "promoted"
        : undefined;
    const latestReview = category === undefined ? undefined : currentMemoryReview(store, category, memory);
    const terminal = category === undefined ? undefined : effectiveTerminalMemoryReview(store, category, memory);
    if (terminal?.action === "correct") reasons.add("manual_review_corrected");
    if (terminal?.action === "discard") reasons.add("manual_review_discarded");
    const verification = category !== undefined && latestReview?.action === "verify" && latestReview.current
      ? matchingMemoryVerification(store, category, memory)
      : undefined;
    if ((latestReview?.action === "verify" && !latestReview.current) || latestReview?.action === "accept_wording") reasons.add("review_context_changed");
    for (const reason of verification?.resolvedReasons ?? []) reasons.delete(reason);
  }

  const hardReasons = [
    "invalid_confidence",
    "missing_evidence",
    "unresolved_evidence",
    "html_or_markup_content",
    "code_or_diff_content",
    "json_fragment_content",
    "table_fragment_content",
    "low_prose_ratio",
    "legacy_low_signal_heuristic",
    "branch_triage_discarded",
    "layer_retention_archived",
    ...MANUAL_REVIEW_QUARANTINE_REASONS
  ];
  const rejected = hardReasons.some((reason) => reasons.has(reason));
  const status: MemoryQualityStatus = rejected
    ? "quarantined"
    : reasons.size > 0
      ? "needs_review"
      : "active";

  return {
    status,
    reasons: [...reasons].sort(),
    rejected,
    resolvedEvidenceCount,
    unresolvedEvidenceCount,
    lastVerifiedAt: options.now ?? new Date().toISOString()
  };
}

function isLegacyLowSignalMemory(memory: AuditableMemory): boolean {
  return hasExactLegacyV1Signature(memory);
}

export function summarizeMemoryHealth(store: MemoryStore): Omit<MemoryAuditResult, "updated" | "changes"> {
  const population = readMemoryPopulation(store);
  const live = population.live.map((item) => item.memory);
  const reasons = live.flatMap((memory) => memory.qualityReasons);
  return {
    scanned: population.historicalTotal,
    total: live.length,
    historicalTotal: population.historicalTotal,
    complete: true,
    active: live.filter((memory) => memory.qualityStatus === "active").length,
    needsReview: live.filter((memory) => memory.qualityStatus === "needs_review").length,
    quarantined: live.filter((memory) => memory.qualityStatus === "quarantined").length,
    rejected: live.filter((memory) => memory.qualityStatus === "quarantined").length,
    retired: population.retired,
    replaced: population.replaced,
    topReasons: topReasons(reasons)
  };
}

/** The single live-population definition used by health and reconciliation. */
export function readMemoryPopulation(store: MemoryStore, owner: MemoryLayerOwner = "self"): MemoryPopulationSnapshot {
  const candidates = store.listMemoryCandidates({ promotionState: "candidate", qualityStatus: "all", owner, limit: null });
  const promoted = store.listMemories({ lifecycleStatus: "all", qualityStatus: "all", owner, limit: null });
  const candidateStates = candidates.map((memory) => ({
    memory,
    terminal: effectiveTerminalMemoryReview(store, "candidate", memory)
  }));
  return {
    candidates,
    promoted,
    live: [
      ...candidateStates
        .filter((item) => item.terminal === undefined)
        .map((item) => ({ category: "candidate" as const, memory: item.memory })),
      ...promoted
        .filter((memory) => memory.lifecycleStatus === "current")
        .map((memory) => ({ category: "promoted" as const, memory }))
    ],
    historicalTotal: candidates.length + promoted.length,
    retired: candidateStates.filter((item) => item.terminal?.action === "discard").length +
      promoted.filter((memory) => memory.lifecycleStatus === "retracted").length,
    replaced: candidateStates.filter((item) => item.terminal?.action === "correct").length +
      promoted.filter((memory) => memory.lifecycleStatus === "superseded").length
  };
}

export function auditMemoryQuality(
  store: MemoryStore,
  options: { fix?: boolean | undefined; now?: string | undefined } = {}
): MemoryAuditResult {
  if (options.fix) store.maintainLocalQualityCache();
  const now = options.now ?? new Date().toISOString();
  const population = readMemoryPopulation(store);
  const candidates = population.candidates;
  const promoted = population.promoted;
  const changes: MemoryAuditChange[] = [];
  const all = [
    ...candidates.map((memory) => ({ kind: "candidate" as const, memory })),
    ...promoted.map((memory) => ({ kind: "promoted" as const, memory }))
  ];

  for (const item of all) {
    const assessment = assessMemoryQuality(store, item.memory, {
      now,
      source: "source" in item.memory ? item.memory.source : undefined,
      currentStatus: item.memory.qualityStatus
    });
    if (
      assessment.status === item.memory.qualityStatus &&
      sameReasons(assessment.reasons, item.memory.qualityReasons)
    ) {
      continue;
    }
    changes.push({
      kind: item.kind,
      id: item.memory.id,
      title: item.memory.title,
      previousStatus: item.memory.qualityStatus,
      nextStatus: assessment.status,
      reasons: assessment.reasons
    });
    if (options.fix) {
      store.updateMemoryQuality(item.kind, item.memory.id, {
        qualityStatus: assessment.status,
        qualityReasons: assessment.reasons,
        lastVerifiedAt: assessment.lastVerifiedAt
      });
    }
  }

  const health = options.fix ? summarizeMemoryHealth(store) : summarizeProjectedHealth(store, all, changes);
  return {
    ...health,
    updated: options.fix ? changes.length : 0,
    changes,
    topReasons: health.topReasons
  };
}

function summarizeProjectedHealth(
  store: MemoryStore,
  all: Array<{ kind: "candidate" | "promoted"; memory: MemoryCandidate | DurableMemory }>,
  changes: MemoryAuditChange[]
): Omit<MemoryAuditResult, "updated" | "changes"> {
  const changed = new Map(changes.map((change) => [`${change.kind}:${change.id}`, change]));
  const live = all.filter((item) => item.kind === "candidate"
    ? effectiveTerminalMemoryReview(store, "candidate", item.memory) === undefined
    : (item.memory as DurableMemory).lifecycleStatus === "current");
  const statuses = live.map((item) => {
    const change = changed.get(`${item.kind}:${item.memory.id}`);
    return change?.nextStatus ?? item.memory.qualityStatus;
  });
  const reasons = live.flatMap((item) => {
    const change = changed.get(`${item.kind}:${item.memory.id}`);
    return change?.reasons ?? item.memory.qualityReasons;
  });
  return {
    scanned: all.length,
    total: live.length,
    historicalTotal: all.length,
    complete: true,
    active: statuses.filter((status) => status === "active").length,
    needsReview: statuses.filter((status) => status === "needs_review").length,
    quarantined: statuses.filter((status) => status === "quarantined").length,
    rejected: statuses.filter((status) => status === "quarantined").length,
    retired: all.filter((item) => item.kind === "candidate"
      ? effectiveTerminalMemoryReview(store, "candidate", item.memory)?.action === "discard"
      : (item.memory as DurableMemory).lifecycleStatus === "retracted").length,
    replaced: all.filter((item) => item.kind === "candidate"
      ? effectiveTerminalMemoryReview(store, "candidate", item.memory)?.action === "correct"
      : (item.memory as DurableMemory).lifecycleStatus === "superseded").length,
    topReasons: topReasons(reasons)
  };
}

function evidenceExists(store: MemoryStore, evidence: EvidenceRef): boolean {
  if (evidence.sourceType === "commit") return store.readCommit(evidence.sourceId) !== undefined;
  if (evidence.sourceType === "conversation") {
    if (evidence.locator === undefined) return false;
    if (store.readSource(evidence.sourceId)?.type !== "conversation") return false;
    return store.readConversationWindow(evidence.sourceId, evidence.locator, 0, 0).length === 1;
  }
  return store.readSource(evidence.sourceId) !== undefined;
}

function isHtmlOrMarkup(text: string): boolean {
  const tagMatches = text.match(/<\/?[a-z][^>]*>/gi) ?? [];
  return tagMatches.length >= 2 || /<\/(?:code|td|tr|table|pre|div)>/i.test(text);
}

function isCodeOrDiff(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const diffLines = lines.filter((line) => /^[+-]\s*\S/.test(line)).length;
  if (diffLines >= 2) return true;
  return /\b(?:const|let|var|function|class|import|export|return|async|await)\b.+[;{}]/.test(text);
}

function isJsonFragment(text: string): boolean {
  const trimmed = text.trim();
  return /^\{[\s\S]*"[^"]+"\s*:/.test(trimmed) || /^\[[\s\S]*\{[\s\S]*"[^"]+"\s*:/.test(trimmed);
}

function isTableFragment(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  return lines.filter((line) => line.startsWith("|") && line.endsWith("|")).length >= 2;
}

function hasVeryLowProseRatio(text: string): boolean {
  const cleaned = text.replace(/\s+/g, "");
  if (cleaned.length < 24) return false;
  const letters = cleaned.match(/[A-Za-z]/g)?.length ?? 0;
  const proseWords = text.match(/[A-Za-z]{3,}/g)?.length ?? 0;
  return letters / cleaned.length < 0.35 || proseWords < 3;
}

function hasNewerRelatedCommits(
  store: MemoryStore,
  memory: AuditableMemory,
  source: DurableMemory["source"] | undefined
): boolean {
  if (source === "manual") return false;
  if (memory.confidence >= 1 && memory.dedupeKey.startsWith("deterministic:conversation:")) return false;
  if (memory.relatedFiles.length === 0) return false;

  const evidenceCommitTimes = memory.evidence
    .filter((evidence) => evidence.sourceType === "commit")
    .map((evidence) => store.readCommit(evidence.sourceId)?.authoredAt)
    .filter((value): value is string => typeof value === "string")
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  if (evidenceCommitTimes.length === 0) return false;
  const latestEvidenceCommit = Math.max(...evidenceCommitTimes);

  return memory.relatedFiles.some((filePath) =>
    store.findCommits({ filePath, limit: 100 }).some((commit) => {
      const authoredAt = Date.parse(commit.authoredAt);
      return Number.isFinite(authoredAt) && authoredAt > latestEvidenceCommit;
    })
  );
}

function hasPotentialConflict(store: MemoryStore, memory: AuditableMemory): boolean {
  if (!("lifecycleStatus" in memory)) return false;
  return store.listMemoryRelations({
    fromMemoryId: memory.id,
    relationType: "potentially_contradicts"
  }).length > 0 || store.listMemoryRelations({
    toMemoryId: memory.id,
    relationType: "potentially_contradicts"
  }).length > 0;
}

function topReasons(reasons: string[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function sameReasons(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}
