import { slugMemoryText } from "./directives.js";
import type { DurableMemory, ExtractedMemory, MemoryCandidate } from "../types.js";

type LegacyMemory = ExtractedMemory | MemoryCandidate | DurableMemory;

// The retired v1 extractor wrote the "Captured from" reasons; the "Legacy" forms are kept for existing fixtures.
const CONFIG_REASONS = new Set(["Captured from deterministic package or config file change.", "Legacy deterministic config extraction."]);
const DOCS_REASONS = new Set(["Captured from deterministic documentation change.", "Legacy deterministic documentation extraction."]);

/** Exact v1 extractor signatures only. Deliberately rejects near matches. */
export function isExactLegacyV1Memory(memory: LegacyMemory): boolean {
  if (!("qualityReasons" in memory) || !memory.qualityReasons.includes("legacy_low_signal_heuristic")) {
    return false;
  }
  return hasExactLegacyV1Signature(memory);
}

/** The structural signature used by the quality assessor to produce the historical reason. */
export function hasExactLegacyV1Signature(memory: LegacyMemory): boolean {
  const config = memory.dedupeKey.match(/^deterministic:config:(.+):([^:]+)$/);
  if (config?.[1] && config[2] && CONFIG_REASONS.has(memory.reason)) {
    const match = memory.summary.match(/^(.+) defines (.+)\.$/);
    return match?.[1] === config[1] && slugMemoryText(match[2] ?? "") === config[2] &&
      memory.relatedFiles.includes(config[1]);
  }

  const docs = memory.dedupeKey.match(/^deterministic:docs:(.+):([^:]+)$/);
  if (docs?.[1] && docs[2] && DOCS_REASONS.has(memory.reason)) {
    const match = memory.summary.match(/^Documentation includes (.+)\.$/);
    return slugMemoryText(match?.[1] ?? "") === docs[2] && memory.relatedFiles.includes(docs[1]);
  }
  return false;
}
