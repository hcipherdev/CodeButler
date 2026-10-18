import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { StorageContentPolicy } from "../storage/content-policy.js";
import type { MemorySearchResult, OperationActor } from "../types.js";
export type MemoryEventKind = "coverage" | "made_durable" | "sharing_changed" | "replaced" | "withdrawn" | "restored" | "corrected" | "wording_accepted" | "wording_undone";
export interface MemoryEvent {
    id: string;
    event_key: string;
    kind: MemoryEventKind;
    memory_id: string;
    category: string;
    layer: string;
    related_memory_id: string | null;
    related_category: string | null;
    related_layer: string | null;
    from_value: string | null;
    to_value: string | null;
    reason: string;
    actor: string;
    occurred_at: string;
    recorded: number;
}
export function recordMemoryEvent(db: DatabaseSync, policy: StorageContentPolicy, input: {
    kind: MemoryEventKind;
    memoryId: string;
    category: string;
    layer: string;
    relatedMemoryId?: string | undefined;
    relatedCategory?: string | undefined;
    relatedLayer?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    reason?: string | undefined;
    actor?: OperationActor | undefined;
    at?: string | undefined;
    key?: string | undefined;
}): void {
    // Older-schema fixtures and migration writers may run before this additive table exists.
    if (!db.prepare("select 1 from sqlite_master where type='table' and name='memory_events'").get())
        return;
    const at = input.at ?? new Date().toISOString();
    const key = input.key ?? [input.kind, input.category, input.memoryId, input.relatedMemoryId ?? "", input.from ?? "", input.to ?? "", at].join("\0");
    const id = "event-" + createHash("sha256").update(key).digest("hex");
    db.prepare(`insert or ignore into memory_events
    (id,event_key,kind,memory_id,category,layer,related_memory_id,related_category,related_layer,from_value,to_value,reason,actor,occurred_at)
    values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, id, input.kind, policy.identifier(input.memoryId), input.category, policy.identifier(input.layer), input.relatedMemoryId ? policy.identifier(input.relatedMemoryId) : null, input.relatedCategory ?? null, input.relatedLayer ? policy.identifier(input.relatedLayer) : null, input.from ? policy.text(input.from) : null, input.to ? policy.text(input.to) : null, policy.text(input.reason ?? ""), input.actor ?? "system", at);
}
export interface KnowledgeSnapshot {
    memories: MemorySearchResult[];
    events: MemoryEvent[];
    topics: import("./topics.js").TopicRevision[];
    overrides: import("./topics.js").TopicOverride[];
    peerLayers: string[];
}
export interface KnowledgeFilter {
    reach?: "all" | "project" | "device" | "branch" | "branch_device" | undefined;
    owner?: "self" | "peer" | "any" | undefined;
}
export function visibleLayer(layer: string, data: KnowledgeSnapshot, filter: KnowledgeFilter = {}): boolean {
    const peer = data.peerLayers.includes(layer);
    if ((filter.owner ?? "self") !== "any" && peer !== (filter.owner === "peer"))
        return false;
    switch (filter.reach) {
        case "project": return layer === "core";
        case "device": return layer.startsWith("device:");
        case "branch": return layer.startsWith("branch:") && !layer.includes(":device:");
        case "branch_device": return layer.startsWith("branch:") && layer.includes(":device:");
        default: return true;
    }
}
export function memoryMovement(data: KnowledgeSnapshot, filter: KnowledgeFilter = {}, now = new Date().toISOString()) {
    const start = new Date(Date.parse(now) - 7 * 86400000).toISOString();
    const seen = new Set<string>();
    const selected = data.events.filter(e => e.occurred_at >= start && e.occurred_at <= now && visibleLayer(e.layer, data, filter))
        .filter(e => { const key = eventIdentity(e); if (seen.has(key))
        return false; seen.add(key); return true; });
    const total = (kind: string) => selected.filter(e => e.kind === kind).length;
    const since = data.events.filter(e => e.kind === "coverage").map(e => e.occurred_at).sort()[0] ?? now;
    const nextChangeAt = [...selected.map(e => new Date(Date.parse(e.occurred_at) + 7 * 86400000 + 1).toISOString()),
        ...(since > start ? [new Date(Date.parse(since) + 7 * 86400000).toISOString()] : [])].filter(at => at > now).sort()[0];
    return { madeDurable: new Set(selected.filter(e => e.kind === "made_durable").map(e => e.category + ":" + e.memory_id)).size, sharedProjectWide: selected.filter(e => e.kind === "sharing_changed" && e.to_value === "core").length,
        replaced: total("replaced"), withdrawn: total("withdrawn"), since, partialSharingHistory: since > start, windowStart: start, evaluatedAt: now, ...(nextChangeAt ? { nextChangeAt } : {}) };
}
function eventIdentity(e: MemoryEvent): string {
    return e.kind === "made_durable" ? e.kind + ":" + e.category + ":" + e.memory_id :
        JSON.stringify([e.kind, e.category, e.memory_id, e.related_category, e.related_memory_id, e.from_value, e.to_value, e.occurred_at]);
}
export function memoryHistory(data: KnowledgeSnapshot, id: string, category: string, input: KnowledgeFilter & {
    offset?: number;
    limit?: number;
} = {}) {
    const lookup = new Map(data.memories.map(m => [m.kind + ":" + m.id, m]));
    const root = lookup.get(category + ":" + id);
    if (!root || !visibleLayer(root.layer ?? "core", data, { owner: "any" }))
        throw new Error("Unknown memory");
    // Core history may never expose the content or labels of a private predecessor.
    const allowed = (layer: string) => root.layer === "core" ? layer === "core" : layer === "core" || layer === root.layer;
    const reachable = new Set([category + ":" + id]);
    const events = data.events.filter(e => e.kind !== "coverage" && (allowed(e.layer) || (e.related_layer !== null && allowed(e.related_layer))));
    let changed = true;
    while (changed) {
        changed = false;
        for (const e of events) {
            const from = e.category + ":" + e.memory_id;
            const to = e.related_memory_id ? (e.related_category ?? "promoted") + ":" + e.related_memory_id : undefined;
            if (reachable.has(from) || (to && reachable.has(to))) {
                for (const key of [from, to])
                    if (key && !reachable.has(key)) {
                        reachable.add(key);
                        changed = true;
                    }
            }
        }
    }
    const node = (key: string) => {
        const m = lookup.get(key);
        return m && allowed(m.layer ?? "core") ? { id: m.id, category: m.kind, title: m.title, statement: m.statement?.text ?? m.summary, state: m.lifecycleStatus ?? "candidate", available: true } : { available: false };
    };
    const seen = new Set<string>();
    const rows = events.filter(e => reachable.has(e.category + ":" + e.memory_id)).sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id))
        .filter(e => { const key = eventIdentity(e); if (seen.has(key))
        return false; seen.add(key); return true; });
    const offset = Math.max(0, input.offset ?? 0), limit = Math.max(1, Math.min(100, input.limit ?? 30));
    return { items: rows.slice(offset, offset + limit).map(e => ({ id: e.id, kind: e.kind, at: e.occurred_at, reason: !allowed(e.layer) || (e.related_memory_id && !allowed(e.related_layer ?? "")) ? "Reason not recorded" : e.reason || "Reason not recorded", from: node(e.category + ":" + e.memory_id),
            ...(e.related_memory_id ? { to: allowed(e.related_layer ?? "") ? node((e.related_category ?? "promoted") + ":" + e.related_memory_id) : { available: false } } : {}) })), total: rows.length, ...(offset + limit < rows.length ? { nextOffset: offset + limit } : {}) };
}
