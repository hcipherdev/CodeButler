import type { SearchResult } from "../types.js";
import type { MemoryStore } from "../storage/store.js";

export interface SearchIndex {
  search(input: { query: string; sourceTypes?: string[]; limit?: number }): SearchResult[];
}

export function createFtsSearchIndex(store: MemoryStore): SearchIndex {
  return {
    search(input) {
      return store.search(input);
    }
  };
}
