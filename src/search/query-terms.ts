// Common words that would substring-match nearly every memory and blur term counts.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with", "is", "are", "was",
  "what", "how", "why", "when", "did", "we", "do", "does", "about"
]);

export type MemoryQueryMatch = "phrase" | "terms";

/**
 * Splits an agent query into lowercase substring terms. Whitespace is the only
 * separator, so paths, quoted words and non-Latin text stay single terms.
 */
export function parseQueryTerms(query: string | undefined): string[] {
  const words = [...new Set((query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean))];
  const meaningful = words.filter((word) => !STOPWORDS.has(word));
  return meaningful.length > 0 ? meaningful : words;
}

/** Terms mode only differs from phrase mode once a query has two or more terms. */
export function queryTermsFor(query: string | undefined, match: MemoryQueryMatch | undefined): string[] | undefined {
  if (match !== "terms") return undefined;
  const terms = parseQueryTerms(query);
  return terms.length >= 2 ? terms : undefined;
}

export function countMatchedTerms(haystackLower: string, terms: string[]): number {
  let matched = 0;
  for (const term of terms) if (haystackLower.includes(term)) matched += 1;
  return matched;
}
