import type { EvidenceRef } from "../types.js";

export function createEvidenceSignature(evidence: EvidenceRef[]): string {
  const tuples = evidence.map((item) => JSON.stringify([
    item.sourceType,
    item.sourceId,
    item.locator ?? null
  ]));
  return JSON.stringify([...new Set(tuples)].sort());
}
