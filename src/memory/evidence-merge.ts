import type { EvidenceRef } from "../types.js";

/**
 * Evidence one candidate keeps when the same fact is found again. Corroboration is
 * counted in distinct sources, so a distinct source always wins a slot over another
 * locator of a source that is already cited.
 */
export const MAX_MERGED_EVIDENCE = 8;
export const MAX_MERGED_RELATED_FILES = 10;

/** What storing an extracted memory did to the candidate table. */
export type CandidateMergeOutcome = "inserted" | "merged" | "unchanged" | "skipped_withdrawn";

function evidenceKey(reference: EvidenceRef): string {
  return JSON.stringify([reference.sourceType, reference.sourceId, reference.locator ?? null]);
}

function sourceKey(reference: EvidenceRef): string {
  return JSON.stringify([reference.sourceType, reference.sourceId]);
}

/** Unions evidence, existing references first, and caps it while preferring distinct sources. */
export function mergeEvidence(
  existing: readonly EvidenceRef[],
  incoming: readonly EvidenceRef[],
  cap = MAX_MERGED_EVIDENCE
): EvidenceRef[] {
  const seen = new Set<string>();
  const all: EvidenceRef[] = [];
  for (const reference of [...existing, ...incoming]) {
    const key = evidenceKey(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(reference);
  }
  // Never fewer slots than the row already fills, so a merge cannot shrink a candidate.
  const limit = Math.max(cap, existing.length);
  if (all.length <= limit) return all;
  const sources = new Set<string>();
  const firstPerSource: EvidenceRef[] = [];
  const repeats: EvidenceRef[] = [];
  for (const reference of all) {
    const key = sourceKey(reference);
    if (sources.has(key)) repeats.push(reference);
    else {
      sources.add(key);
      firstPerSource.push(reference);
    }
  }
  const kept = new Set([...firstPerSource, ...repeats].slice(0, limit));
  return all.filter((reference) => kept.has(reference));
}

export function mergeRelatedFiles(
  existing: readonly string[],
  incoming: readonly string[],
  cap = MAX_MERGED_RELATED_FILES
): string[] {
  return [...new Set([...existing, ...incoming])].slice(0, Math.max(cap, existing.length));
}

export function distinctEvidenceSources(evidence: readonly EvidenceRef[]): number {
  return new Set(evidence.map((reference) => reference.sourceId)).size;
}
