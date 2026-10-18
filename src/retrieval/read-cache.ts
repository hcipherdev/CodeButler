import { AsyncLocalStorage } from "node:async_hooks";
import type { MemoryStore } from "../storage/store.js";
const cache = new AsyncLocalStorage<WeakMap<MemoryStore, Map<string, unknown>>>();
/** Scope caches to one coherent read, never across canonical mutations. */
export function withReadCache<T>(work: () => T): T {
    if (cache.getStore())
        return work();
    return cache.run(new WeakMap(), work);
}
export function clearReadCache(store: MemoryStore): void { cache.getStore()?.delete(store); }
export function hasCachedRead(store: MemoryStore, key: string): boolean { return cache.getStore()?.get(store)?.has(key) === true; }
export function cachedRead<T>(store: MemoryStore, key: string, work: () => T): T {
    const scope = cache.getStore();
    if (!scope)
        return work();
    let entries = scope.get(store);
    if (!entries) {
        entries = new Map();
        scope.set(store, entries);
    }
    if (entries.has(key))
        return entries.get(key) as T;
    const result = work();
    entries.set(key, result);
    return result;
}
