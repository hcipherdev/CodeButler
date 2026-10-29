import { cachedRead } from "../retrieval/read-cache.js";
import type { MemoryStore } from "../storage/store.js";
import type { EvidenceRef } from "../types.js";

export interface EvidenceTimes {
  /** Authored times of cited commits, in epoch milliseconds. */
  commits: number[];
  /** Timestamps of cited conversation chunks, in epoch milliseconds. */
  conversations: number[];
}

/** When each cited observation was made; references without a readable time are left out. */
export function evidenceTimes(store: MemoryStore, evidence: readonly EvidenceRef[]): EvidenceTimes {
  const times: EvidenceTimes = { commits: [], conversations: [] };
  for (const reference of evidence) {
    if (reference.sourceType === "commit") {
      const authoredAt = Date.parse(store.readCommit(reference.sourceId)?.authoredAt ?? "");
      if (Number.isFinite(authoredAt)) times.commits.push(authoredAt);
    } else if (reference.sourceType === "conversation" && reference.locator) {
      const at = Date.parse(conversationChunkTimestamp(store, reference.sourceId, reference.locator) ?? "");
      if (Number.isFinite(at)) times.conversations.push(at);
    }
  }
  return times;
}

/** The newest observation behind a memory, or undefined when no cited source carries a time. */
export function latestEvidenceTime(store: MemoryStore, evidence: readonly EvidenceRef[]): number | undefined {
  const { commits, conversations } = evidenceTimes(store, evidence);
  const all = [...commits, ...conversations];
  return all.length ? Math.max(...all) : undefined;
}

function conversationChunkTimestamp(store: MemoryStore, sourceId: string, locator: string): string | undefined {
  return cachedRead(store, `chunk-timestamp:${sourceId}\0${locator}`, () => {
    const timestamp = store.readConversationWindow(sourceId, locator, 0, 0)[0]?.metadata?.timestamp;
    return typeof timestamp === "string" ? timestamp : undefined;
  });
}
