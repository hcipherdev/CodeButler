import { CORE_LAYER, matchesLayerFilter, parseLayer, layerLabel } from "./layer.js";
import type {
  DurableMemory,
  MemoryCandidate,
  MemoryLayerFilter,
  MemoryScope,
  MemoryType
} from "../types.js";
import type { MemoryStore } from "../storage/store.js";

export interface SuggestMemoryLayerPromotionsInput {
  layer?: MemoryLayerFilter | undefined;
  includeCandidates?: boolean | undefined;
  minConfidence?: number | undefined;
  minScore?: number | undefined;
  limit?: number | undefined;
}

export interface MemoryLayerPromotionSuggestion {
  memoryId: string;
  category: "candidate" | "promoted";
  type: MemoryType;
  title: string;
  summary: string;
  currentLayer: string;
  currentLayerLabel: string;
  targetLayer: typeof CORE_LAYER;
  score: number;
  reasons: string[];
  warnings: string[];
  suggestedReason: string;
  action:
    | {
        tool: "update_memory_layer";
        arguments: {
          memoryId: string;
          category: "candidate" | "promoted";
          layer: typeof CORE_LAYER;
          reason: string;
        };
      }
    | {
        tool: "resolve_branch_memory_triage";
        arguments: {
          memoryId: string;
          category: "candidate";
          action: "promote_to_core";
          reason: string;
        };
      };
}

export interface SuggestMemoryLayerPromotionsResult {
  scanned: number;
  eligible: number;
  suggestions: MemoryLayerPromotionSuggestion[];
  complete: true;
}

type SuggestibleMemory = {
  category: "candidate" | "promoted";
  memory: MemoryCandidate | DurableMemory;
};

export function suggestMemoryLayerPromotions(
  store: MemoryStore,
  input: SuggestMemoryLayerPromotionsInput = {}
): SuggestMemoryLayerPromotionsResult {
  const layer = input.layer ?? "all";
  const minConfidence = normalizeThreshold(input.minConfidence, 0.8, "minConfidence");
  const minScore = normalizeThreshold(input.minScore, 0.7, "minScore");
  const limit = normalizeLimit(input.limit);
  const promoted = store
    .listMemories({ lifecycleStatus: "all", qualityStatus: "all", limit: null })
    .map((memory): SuggestibleMemory => ({ category: "promoted", memory }));
  const candidates = input.includeCandidates === false
    ? []
    : store
      .listMemoryCandidates({ promotionState: "candidate", qualityStatus: "all", limit: null })
      .map((memory): SuggestibleMemory => ({ category: "candidate", memory }));

  const scanned = [...promoted, ...candidates]
    .filter((item) => currentLayer(item.memory) !== CORE_LAYER)
    .filter((item) => matchesLayerFilter(currentLayer(item.memory), layer));
  const eligible = scanned.filter((item) => isEligible(item, minConfidence));
  const suggestions = eligible
    .map(scoreSuggestion)
    .filter((suggestion) => suggestion.score >= minScore)
    .sort((left, right) =>
      right.score - left.score ||
      left.category.localeCompare(right.category) ||
      left.title.localeCompare(right.title) ||
      left.memoryId.localeCompare(right.memoryId)
    )
    .slice(0, limit);

  return { scanned: scanned.length, eligible: eligible.length, suggestions, complete: true };
}

function isEligible(item: SuggestibleMemory, minConfidence: number): boolean {
  if (item.memory.qualityStatus !== "active") return false;
  if (item.memory.confidence < minConfidence) return false;
  if (item.category === "promoted" && (item.memory as DurableMemory).lifecycleStatus !== "current") return false;
  return true;
}

function scoreSuggestion(item: SuggestibleMemory): MemoryLayerPromotionSuggestion {
  const memory = item.memory;
  const layer = currentLayer(memory);
  const reasons = new Set<string>();
  const warnings = new Set<string>();
  let score = 0;

  reasons.add("active_quality");
  score += 0.2;
  reasons.add("high_confidence");
  score += 0.25;

  const scopeScore = scoreScope(memory.scope, reasons, warnings);
  score += scopeScore;

  if (distinctEvidenceSources(memory.evidence) >= 2) {
    reasons.add("multiple_evidence_sources");
    score += 0.2;
  }
  if (memory.origin?.method === "manual") {
    reasons.add("manual_capture");
    score += 0.05;
  }
  if (item.category === "promoted") {
    reasons.add("current_promoted_memory");
    score += 0.05;
  } else {
    reasons.add("candidate_memory");
  }
  const parsedLayer = parseLayer(layer);
  if (parsedLayer.kind === "branch") {
    reasons.add("branch_layer");
    if (item.category === "candidate") {
      warnings.add("branch_candidate_requires_triage_resolution");
    } else {
      warnings.add("branch_memory_should_wait_for_branch_review");
    }
    score += 0.05;
  } else if (item.category === "candidate") {
    warnings.add("candidate_layer_move_does_not_promote_memory_status");
  }

  const suggestedReason = `Promote to core after layer promotion review: ${[...reasons].sort().join(", ")}.`;
  const action = item.category === "candidate" && parsedLayer.kind === "branch"
    ? {
        tool: "resolve_branch_memory_triage" as const,
        arguments: {
          memoryId: memory.id,
          category: "candidate" as const,
          action: "promote_to_core" as const,
          reason: suggestedReason
        }
      }
    : {
        tool: "update_memory_layer" as const,
        arguments: {
          memoryId: memory.id,
          category: item.category,
          layer: CORE_LAYER,
          reason: suggestedReason
        }
      };
  return {
    memoryId: memory.id,
    category: item.category,
    type: memory.type,
    title: memory.title,
    summary: memory.summary,
    currentLayer: layer,
    currentLayerLabel: layerLabel(layer),
    targetLayer: CORE_LAYER,
    score: Math.min(1, Number(score.toFixed(2))),
    reasons: [...reasons].sort(),
    warnings: [...warnings].sort(),
    suggestedReason,
    action
  };
}

function currentLayer(memory: MemoryCandidate | DurableMemory): string {
  return memory.layer ?? CORE_LAYER;
}

function scoreScope(scope: MemoryScope | undefined, reasons: Set<string>, warnings: Set<string>): number {
  if (scope?.kind === "project") {
    reasons.add("project_scope");
    return 0.25;
  }
  if (scope?.kind === "conditional") {
    reasons.add("conditional_scope");
    warnings.add("verify_conditional_scope_before_promotion");
    return 0.1;
  }
  reasons.add("unspecified_scope");
  warnings.add("verify_unspecified_scope_before_promotion");
  return 0.05;
}

function distinctEvidenceSources(evidence: Array<{ sourceId: string }>): number {
  return new Set(evidence.map((ref) => ref.sourceId)).size;
}

function normalizeThreshold(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`);
  return value;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 20;
  if (!Number.isInteger(value) || value <= 0) throw new Error("limit must be a positive integer");
  return Math.min(value, 100);
}
