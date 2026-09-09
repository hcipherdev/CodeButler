export interface EvaluationCase {
  expected: string[];
  returned: string[];
}

export interface RetrievalMetrics {
  recallAt: Record<string, number>;
  mrr: number;
}

export function computeRetrievalMetrics(cases: EvaluationCase[], kValues: number[]): RetrievalMetrics {
  if (cases.length === 0) return { recallAt: Object.fromEntries(kValues.map((k) => [String(k), 0])), mrr: 0 };
  const recallAt: Record<string, number> = {};
  for (const k of kValues) {
    recallAt[String(k)] = cases.reduce((sum, item) => {
      const expected = new Set(item.expected);
      const hits = new Set(item.returned.slice(0, k).filter((id) => expected.has(id))).size;
      return sum + (expected.size === 0 ? 1 : hits / expected.size);
    }, 0) / cases.length;
  }
  const mrr = cases.reduce((sum, item) => {
    const expected = new Set(item.expected);
    const index = item.returned.findIndex((id) => expected.has(id));
    return sum + (index < 0 ? 0 : 1 / (index + 1));
  }, 0) / cases.length;
  return { recallAt, mrr };
}

export function hybridRecallGate(hybridRecallAt10: number, ftsRecallAt10: number, checkedBaseline: number): boolean {
  return hybridRecallAt10 >= ftsRecallAt10 && hybridRecallAt10 >= checkedBaseline;
}
