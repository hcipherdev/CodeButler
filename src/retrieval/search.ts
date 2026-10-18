import type { MemoryStore } from "../storage/store.js";
import type { MemorySearchResult, EmbeddingVector } from "../types.js";
import { findProjectMemories, searchProjectMemory, type MemorySearchInput, type SearchServiceOptions } from "../search/service.js";
import { loadProjectConfig } from "../config.js";
import { readPublishedMemories, readPublishedRaw, withPublishedIndex, readPublishedChunks } from "./index.js";
/** Only the search service's read interface is exposed; no canonical handle exists. */
function searchStore(root: string): MemoryStore {
    return {
        searchMemoryLayer: input => readPublishedMemories(root, input).items,
        search: input => readPublishedRaw(root, input),
        listActiveEmbeddingVectors: input => withPublishedIndex(root, (_db, _p, prepare) => {
            const rows = prepare("select payload,vector_blob from semantic_vectors where provider_key=? and provider_fingerprint=?").all(input?.providerKey ?? "", input?.providerFingerprint ?? "") as Array<{
                payload: string;
                vector_blob: Uint8Array;
            }>;
            return rows.map(r => ({ ...JSON.parse(r.payload), vectorBlob: r.vector_blob }) as EmbeddingVector);
        }),
        readMemorySearchResultsByIds: (ids, input = {}) => withPublishedIndex(root, (_db, _p, prepare) => {
            const result = new Map<string, MemorySearchResult>();
            for (let offset = 0; offset < ids.length; offset += 250) {
                const batch = ids.slice(offset, offset + 250);
                const rows = prepare(`select id,payload from records where category='promoted' ${input.lifecycleStatus === 'all' ? '' : "and lifecycle='current'"} and id in (${batch.map(() => "?").join(",")})`).all(...batch) as Array<{
                    id: string;
                    payload: string;
                }>;
                for (const row of rows)
                    result.set(row.id, JSON.parse(row.payload));
            }
            return ids.flatMap(id => result.has(id) ? [result.get(id)!] : []);
        }),
        readSearchResultsByChunkIds: ids => readPublishedChunks(root, ids),
        get db() { return withPublishedIndex(root, db => db); }
    } as MemoryStore;
}
export async function findPublishedMemories(root: string, input: MemorySearchInput, options: SearchServiceOptions = {}) {
    const page = readPublishedMemories(root, input);
    const config = loadProjectConfig(root);
    if (config.retrieval.mode !== "hybrid")
        return { results: page.items, freshness: page.freshness };
    const results = await findProjectMemories(searchStore(root), config, input, options);
    // Remote embedding calls may outlive publication or a privacy revocation.
    const current = readPublishedMemories(root, input);
    return { results: current.freshness.revision === page.freshness.revision ? results : current.items, freshness: current.freshness };
}
export async function searchPublishedMemory(root: string, input: Parameters<typeof searchProjectMemory>[2], options: SearchServiceOptions = {}) {
    const config = loadProjectConfig(root);
    const before = readPublishedMemories(root, input);
    const result = await searchProjectMemory(searchStore(root), config, input, options);
    return withPublishedIndex(root, () => {
        const current = readPublishedMemories(root, input);
        return { ...(current.freshness.revision === before.freshness.revision ? result : { memories: current.items, results: readPublishedRaw(root, input) }), freshness: current.freshness };
    });
}
