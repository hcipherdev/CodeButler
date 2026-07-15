export interface RankedVector {
  id: string;
  vector: number[];
}

export interface RankingMetadata {
  lexicalRank?: number;
  semanticRank?: number;
  fusedScore: number;
}

export function decodeFloat32Vector(blob: Uint8Array, dimension: number): number[] {
  if (!Number.isInteger(dimension) || dimension <= 0 || blob.byteLength !== dimension * 4) {
    throw new Error("Embedding vector dimension does not match its Float32 blob");
  }
  const copy = blob.slice();
  return Array.from(new Float32Array(copy.buffer, copy.byteOffset, dimension));
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) throw new Error("Vector dimensions do not match");
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index]!;
    const r = right[index]!;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export function rankByCosine(query: number[], items: RankedVector[]): Array<{ id: string; score: number; rank: number }> {
  return items
    .map((item) => ({ id: item.id, score: cosineSimilarity(query, item.vector) }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

export function reciprocalRankFuse(
  lexical: Array<{ id: string }>,
  semantic: Array<{ id: string }>,
  options: { k: number; limit: number }
): Array<{ id: string } & RankingMetadata> {
  const byId = new Map<string, { id: string } & RankingMetadata>();
  lexical.forEach((item, index) => {
    byId.set(item.id, { id: item.id, lexicalRank: index + 1, fusedScore: 1 / (options.k + index + 1) });
  });
  semantic.forEach((item, index) => {
    const existing = byId.get(item.id);
    if (existing) {
      existing.semanticRank = index + 1;
      existing.fusedScore += 1 / (options.k + index + 1);
    } else {
      byId.set(item.id, { id: item.id, semanticRank: index + 1, fusedScore: 1 / (options.k + index + 1) });
    }
  });
  return [...byId.values()]
    .sort((left, right) => right.fusedScore - left.fusedScore || left.id.localeCompare(right.id))
    .slice(0, options.limit);
}
