import type { MemoryStore } from "../storage/store.js";
import { retrievalPolicy } from "./paths.js";

/**
 * Triggers journal every canonical table that memory reads depend on into retrieval_changes, and the
 * policy carries the quality and privacy versions, so an unchanged revision means unchanged derived reads.
 */
export function canonicalRevisionParts(store: MemoryStore): { identity: string; sequence: number; policy: string } {
    const identity = (store.db.prepare("select id from retrieval_identity").get() as {
        id: string;
    }).id;
    // Every watcher pass stamps sync_sources (last sync times) even when nothing was imported. No memory,
    // quality or tier read uses those rows, so counting them would invalidate every cache each pass.
    const row = store.db.prepare("select sequence from retrieval_changes where entity <> 'sync_sources' order by sequence desc limit 1").get() as {
        sequence: number;
    } | undefined;
    return { identity, sequence: Number(row?.sequence ?? 0), policy: retrievalPolicy(store.paths.rootDir) };
}

export function canonicalRevision(store: MemoryStore): string {
    const { identity, sequence, policy } = canonicalRevisionParts(store);
    return identity + ":" + sequence + ":" + policy;
}

const REVISION_CACHE_LIMIT = 8;
/** Most recently used last; long-lived readers reuse a value until any journaled canonical change. */
const revisionValues: Array<{ key: string; revision: string; value: unknown }> = [];

/**
 * Serves a value derived only from canonical rows from the previous read of the same revision.
 * Inside a caller's transaction a rollback can reuse a change sequence for different rows, so
 * only a snapshot this read owns may be served from or stored in the cache.
 */
export function revisionCached<T>(store: MemoryStore, name: string, work: () => T): T {
    if (store.db.isTransaction)
        return work();
    store.db.exec("begin");
    try {
        const key = store.paths.rootDir + "\0" + name;
        let revision: string;
        try { revision = canonicalRevision(store); }
        catch { return work(); } // A store without the change journal cannot prove freshness.
        const at = revisionValues.findIndex(entry => entry.key === key);
        if (at >= 0) {
            const [entry] = revisionValues.splice(at, 1);
            if (entry!.revision === revision) {
                revisionValues.push(entry!);
                return entry!.value as T;
            }
        }
        const value = work();
        revisionValues.push({ key, revision, value });
        while (revisionValues.length > REVISION_CACHE_LIMIT)
            revisionValues.shift();
        return value;
    }
    finally {
        store.db.exec("rollback");
    }
}

/** Test hook: forget revision-cached values. */
export function clearRevisionCache(): void { revisionValues.length = 0; }
