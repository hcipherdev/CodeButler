import type { MemoryStore } from "../storage/store.js";
import type { MemorySearchResult } from "../types.js";
import type { KnowledgeSnapshot, MemoryEvent } from "./events.js";
import type { TopicOverride, TopicRevision } from "./topics.js";
import { peerLayers } from "./peer-layer.js";
import { presentMemory } from "./presentation.js";
import { withReadCache } from "../retrieval/read-cache.js";
/** Capture every history record in one reader snapshot, without mutating canonical storage. */
export function readMemoryKnowledge(store: MemoryStore, publishedMemories?: MemorySearchResult[]): KnowledgeSnapshot {
    const owns = !store.db.isTransaction;
    if (owns)
        store.db.exec("begin");
    try {
        return withReadCache(() => {
            const ids = publishedMemories ? [] : (store.db.prepare("select id from memories union select id from memory_candidates").all() as Array<{
                id: string;
            }>).map(r => r.id);
            const peers = peerLayers(store);
            const memories = publishedMemories ?? store.readMemorySearchResultsByIds(ids, { includeCandidates: true, lifecycleStatus: "all" });
            for (const m of memories)
                m.presentation = presentMemory(m, peers.includes(m.layer ?? "core"));
            return { memories, events: store.db.prepare("select * from memory_events order by occurred_at,id").all() as unknown as MemoryEvent[],
                topics: store.db.prepare("select * from memory_topics order by id").all() as unknown as TopicRevision[],
                overrides: store.db.prepare("select * from memory_topic_links order by id").all() as unknown as TopicOverride[], peerLayers: peers };
        });
    }
    finally {
        if (owns)
            store.db.exec("rollback");
    }
}
