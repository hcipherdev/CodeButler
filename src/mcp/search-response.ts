import { parseQueryTerms } from "../search/query-terms.js";
import type { MemorySearchResult, SearchResult } from "../types.js";

// Agent clients reject or spill tool output past roughly 25k tokens; stay well under it.
export const DEFAULT_SEARCH_MAX_CHARS = 40_000;
const EXCERPT_CHARS = 600;
const EXCERPT_LEAD = 200;
const OMISSION_RESERVE = 400;

const MAX_OCCURRENCES_PER_TERM = 100;

/**
 * The window of the chunk holding the most distinct query terms, then the most
 * occurrences, preferring the earliest such window; the chunk's start when no term occurs.
 */
export function excerptText(text: string, terms: string[]): { text: string; excerpted: boolean } {
  if (text.length <= EXCERPT_CHARS) return { text, excerpted: false };
  const start = bestExcerptStart(text.toLowerCase(), terms, text.length);
  const end = Math.min(text.length, start + EXCERPT_CHARS);
  return { text: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`, excerpted: true };
}

function bestExcerptStart(lower: string, terms: string[], length: number): number {
  const occurrences: Array<{ position: number; end: number; term: number }> = [];
  terms.forEach((term, index) => {
    if (!term) return;
    for (let position = lower.indexOf(term), found = 0; position >= 0 && found < MAX_OCCURRENCES_PER_TERM; position = lower.indexOf(term, position + 1), found++)
      occurrences.push({ position, end: position + term.length, term: index });
  });
  if (occurrences.length === 0) return 0;
  occurrences.sort((left, right) => left.position - right.position);
  let best = { start: 0, distinct: -1, count: -1 };
  for (const anchor of occurrences) {
    // Leading context before the anchor, but never a window that runs past the end.
    const start = Math.max(0, Math.min(anchor.position - EXCERPT_LEAD, length - EXCERPT_CHARS));
    const inside = occurrences.filter((item) => item.position >= start && item.end <= start + EXCERPT_CHARS);
    const distinct = new Set(inside.map((item) => item.term)).size;
    if (distinct > best.distinct || (distinct === best.distinct && inside.length > best.count))
      best = { start, distinct, count: inside.length };
  }
  return best.start;
}

/** Drops presentation copies that repeat the summary or title verbatim. */
export function compactMemory(memory: MemorySearchResult): MemorySearchResult {
  const compact = { ...memory };
  if (compact.statement && compact.statement.text === compact.summary) {
    const { text: _text, ...statement } = compact.statement;
    compact.statement = statement as typeof compact.statement;
  }
  if (compact.presentation) {
    const { text, headline, ...presentation } = compact.presentation;
    compact.presentation = {
      ...presentation,
      ...(text === compact.summary ? {} : { text }),
      ...(headline === compact.title ? {} : { headline })
    } as typeof compact.presentation;
  }
  return compact;
}

export function compactRawResult(result: SearchResult, terms: string[]): Omit<SearchResult, "trust"> & { textLength?: number; excerpted?: true } {
  const { trust: _trust, ...rest } = result;
  const excerpt = excerptText(result.text, terms);
  return excerpt.excerpted ? { ...rest, text: excerpt.text, textLength: result.text.length, excerpted: true } : rest;
}

const BUDGET_NOTE = "Some hits were left out to stay within maxChars. Use a smaller limit, raise maxChars, or read one hit in full with read_memory_source { sourceId, chunkId }.";
const PARTIAL_NOTE = "Memories matching fewer than half of the query terms were left out; find_memories lists them ranked.";

/**
 * Removes trailing items, taking turns across the listed keys so no list is emptied
 * just because it comes first, until the serialized response fits. Callers serialize
 * compactly, so these lengths are the final sizes.
 */
export function fitToBudget<T extends Record<string, unknown>>(
  value: T,
  dropOrder: Array<keyof T & string>,
  maxChars: number,
  omitted: Record<string, number> = {}
): T {
  const notes = omitted.partialMemories ? [PARTIAL_NOTE] : [];
  let size = JSON.stringify(value).length;
  if (size > maxChars) {
    const lists = new Map(dropOrder.map((key) => [key, [...(value[key] as unknown[])]]));
    let dropped = true;
    while (dropped && size > maxChars - OMISSION_RESERVE) {
      dropped = false;
      for (const [key, items] of lists) {
        if (items.length === 0 || size <= maxChars - OMISSION_RESERVE) continue;
        size -= JSON.stringify(items.pop()).length + 1;
        omitted[key] = (omitted[key] ?? 0) + 1;
        dropped = true;
      }
    }
    value = { ...value, ...Object.fromEntries(lists) };
    notes.push(BUDGET_NOTE);
  }
  return notes.length === 0 ? value : { ...value, omitted, note: notes.join(" ") };
}

/** In a mixed response, a memory sharing one word of a long query is noise next to raw hits. */
function coversEnoughTerms(memory: MemorySearchResult): boolean {
  return !memory.match || memory.match.matched >= Math.ceil(memory.match.terms / 2);
}

export function shapeSearchProjectMemory<T extends { memories: MemorySearchResult[]; results: SearchResult[] }>(
  value: T,
  input: { query: string; maxChars?: number | undefined }
): T {
  const terms = parseQueryTerms(input.query);
  const memories = value.memories.filter(coversEnoughTerms);
  const partialMemories = value.memories.length - memories.length;
  const shaped = { ...value, memories: memories.map(compactMemory), results: value.results.map((result) => compactRawResult(result, terms)) };
  return fitToBudget(shaped, ["results", "memories"], input.maxChars ?? DEFAULT_SEARCH_MAX_CHARS, partialMemories ? { partialMemories } : {}) as unknown as T;
}

export function shapeFindMemories<T extends { results: MemorySearchResult[] }>(value: T, maxChars: number | undefined): T {
  return fitToBudget({ ...value, results: value.results.map(compactMemory) }, ["results"], maxChars ?? DEFAULT_SEARCH_MAX_CHARS);
}
