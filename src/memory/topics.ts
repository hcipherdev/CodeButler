import { randomUUID } from "node:crypto";
import { assertOrdinaryProject } from "../rules/identity.js";
import { isAbsolute } from "node:path";
import type { MemoryStore } from "../storage/store.js";
import { withTransaction } from "../storage/transactions.js";
import type { MemorySearchResult } from "../types.js";
import { isPeerLayer } from "./peer-layer.js";
import { sanitizeLayerInput } from "./layer.js";
import { assessClaim } from "./statement.js";
import { visibleLayer, type KnowledgeFilter, type KnowledgeSnapshot } from "./events.js";
export interface TopicRevision {
    id: string;
    topic_id: string;
    layer: string;
    name: string;
    introduction: string;
    prefixes_json: string;
    parents_json: string;
    deleted: number;
    created_at: string;
}
export interface TopicOverride {
    id: string;
    topic_id: string;
    memory_id: string;
    category: string;
    layer: string;
    mode: "include" | "exclude" | "default";
    created_at: string;
}
export interface Topic {
    id: string;
    layer: string;
    name: string;
    introduction: string;
    prefixes: string[];
    heads: string[];
    conflicted: boolean;
    deleted: boolean;
    proposals: TopicRevision[];
}
export interface SaveTopicInput {
    id?: string;
    layer?: string;
    name: string;
    introduction?: string;
    prefixes: string[];
    expectedRevisions?: string[];
    deleted?: boolean;
}
export function normalizeTopicPrefix(raw: string): string {
    const path = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!path || isAbsolute(path) || /^[a-z]:/i.test(path) || path.split("/").some(p => !p || p === "." || p === "..") || /[\0\r\n]/.test(path))
        throw new Error("Topic prefixes must be repository-relative paths");
    return path;
}
/** Revisions are immutable. Multiple heads retain concurrent edits and their common ancestor. */
export function resolveTopics(revisions: TopicRevision[]): Topic[] {
    const groups = new Map<string, TopicRevision[]>();
    for (const row of revisions) {
        const list = groups.get(row.topic_id) ?? [];
        list.push(row);
        groups.set(row.topic_id, list);
    }
    return [...groups].map(([id, rows]) => {
        const parents = new Set(rows.flatMap(r => JSON.parse(r.parents_json) as string[]));
        const heads = rows.filter(r => !parents.has(r.id)).sort((a, b) => a.id.localeCompare(b.id));
        const byId = new Map(rows.map(r => [r.id, r]));
        const ancestors = (revision: TopicRevision) => {
            const result = new Set<string>();
            const queue = [revision.id];
            while (queue.length) {
                const next = queue.pop()!;
                if (result.has(next))
                    continue;
                result.add(next);
                const row = byId.get(next);
                if (row)
                    queue.push(...JSON.parse(row.parents_json));
            }
            return result;
        };
        const sets = heads.map(ancestors);
        const commonRows = rows.filter(r => sets.every(s => s.has(r.id)));
        // Ancestry determines the last agreed rules even when device clocks differ.
        const common = commonRows.filter(r => !commonRows.some(other => other.id !== r.id && ancestors(other).has(r.id))).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
        const row = heads.length === 1 ? heads[0]! : common[0] ?? rows.slice().sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0]!;
        return { id, layer: row.layer, name: row.name, introduction: row.introduction, prefixes: JSON.parse(row.prefixes_json) as string[], heads: heads.map(r => r.id), conflicted: heads.length > 1, deleted: row.deleted === 1, proposals: heads };
    }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
export function saveMemoryTopic(store: MemoryStore, input: SaveTopicInput, now = new Date().toISOString()): Topic {
    assertOrdinaryProject(store.paths.rootDir);
    return withTransaction(store.db, () => {
        const all = resolveTopics(store.db.prepare("select * from memory_topics").all() as unknown as TopicRevision[]);
        const prior = input.id ? all.find(t => t.id === input.id) : undefined;
        if (input.id && !prior)
            throw new Error("Unknown topic");
        const layer = prior?.layer ?? sanitizeLayerInput(store.contentPolicy, input.layer ?? "core");
        if (input.layer && prior && input.layer !== prior.layer)
            throw new Error("Topic sharing cannot change in an edit");
        if (isPeerLayer(store, layer))
            throw new Error("Topic belongs to another device and is read-only here");
        if (prior && JSON.stringify([...prior.heads].sort()) !== JSON.stringify([...(input.expectedRevisions ?? [])].sort()))
            throw new Error("Topic changed; reload its proposals before saving");
        const name = store.contentPolicy.text(input.name.trim());
        if (!name)
            throw new Error("Topic name is required");
        const prefixes = [...new Set(input.prefixes.map(normalizeTopicPrefix).map(p => store.contentPolicy.path(p)))].sort();
        if (prefixes.length > 100)
            throw new Error("A topic supports at most 100 path rules");
        const topicId = prior?.id ?? "topic-" + randomUUID();
        const revision: TopicRevision = { id: "topic-revision-" + randomUUID(), topic_id: topicId, layer, name, introduction: store.contentPolicy.text(input.introduction ?? ""), prefixes_json: JSON.stringify(prefixes), parents_json: JSON.stringify(prior?.heads ?? []), deleted: input.deleted ? 1 : 0, created_at: now };
        store.db.prepare("insert into memory_topics values(?,?,?,?,?,?,?,?,?)").run(revision.id, topicId, layer, name, revision.introduction, revision.prefixes_json, revision.parents_json, revision.deleted, now);
        return resolveTopics([...(store.db.prepare("select * from memory_topics where topic_id=?").all(topicId) as unknown as TopicRevision[])])[0]!;
    });
}
export function setTopicMembership(store: MemoryStore, input: {
    topicId: string;
    memoryId: string;
    mode: "include" | "exclude" | "default";
}, now = new Date().toISOString()) {
    assertOrdinaryProject(store.paths.rootDir);
    return withTransaction(store.db, () => {
        const topic = resolveTopics(store.db.prepare("select * from memory_topics where topic_id=?").all(input.topicId) as unknown as TopicRevision[])[0];
        const memory = store.readMemory(input.memoryId);
        if (!topic || topic.deleted || !memory)
            throw new Error("Unknown topic or durable memory");
        if (isPeerLayer(store, topic.layer) || isPeerLayer(store, memory.layer))
            throw new Error("Another device's content is read-only here");
        const layer = memory.layer ?? "core";
        if (topic.layer !== "core" && topic.layer !== layer)
            throw new Error("A private topic cannot group another layer's memory");
        if (topic.conflicted)
            throw new Error("Resolve the topic proposals before changing membership");
        const latest = store.db.prepare("select max(created_at) at from memory_topic_links where topic_id=? and memory_id=? and layer=?").get(topic.id, memory.id, layer) as {
            at: string | null;
        };
        if (latest.at && latest.at >= now)
            now = new Date(Date.parse(latest.at) + 1).toISOString();
        const id = "topic-link-" + randomUUID();
        store.db.prepare("insert into memory_topic_links values(?,?,?,?,?,?,?)").run(id, topic.id, memory.id, "promoted", layer, input.mode, now);
        return { id };
    });
}
export function eligibleHandbookMemory(m: MemorySearchResult): boolean { return m.kind === "promoted" && m.lifecycleStatus === "current" && m.qualityStatus === "active" && assessClaim(m) === "meaningful"; }
/** Keep whole-project membership overrides with their memory when its sharing changes. */
export function moveTopicMemberships(store: MemoryStore, memoryId: string, fromLayer: string, toLayer: string): void {
    if (fromLayer === toLayer || !store.db.prepare("select 1 from sqlite_master where name='memory_topic_links'").get())
        return;
    const coreTopics = new Set(resolveTopics(store.db.prepare("select * from memory_topics").all() as unknown as TopicRevision[]).filter(t => t.layer === "core" && !t.deleted).map(t => t.id));
    const rows = store.db.prepare("select * from memory_topic_links where memory_id=? and layer=? order by created_at desc,id desc").all(memoryId, fromLayer) as unknown as TopicOverride[];
    const seen = new Set<string>();
    for (const row of rows) {
        if (seen.has(row.topic_id) || !coreTopics.has(row.topic_id))
            continue;
        seen.add(row.topic_id);
        const latest = store.db.prepare("select max(created_at) at from memory_topic_links where topic_id=? and memory_id=?").get(row.topic_id, memoryId) as {
            at: string | null;
        };
        const at = new Date(Math.max(Date.now(), Date.parse(latest.at ?? row.created_at) + 1)).toISOString();
        const insert = store.db.prepare("insert into memory_topic_links values(?,?,?,?,?,?,?)");
        insert.run("topic-link-" + randomUUID(), row.topic_id, memoryId, "promoted", toLayer, row.mode, at);
        insert.run("topic-link-" + randomUUID(), row.topic_id, memoryId, "promoted", fromLayer, "default", at);
    }
}
export function handbookMemories(data: KnowledgeSnapshot, filter: KnowledgeFilter = { reach: "project" }): MemorySearchResult[] {
    return data.memories.filter(m => eligibleHandbookMemory(m) && visibleLayer(m.layer ?? "core", data, filter)).sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}
export function topicMatches(topic: Topic, memory: MemorySearchResult, overrides: TopicOverride[]): boolean {
    if (topic.deleted || (topic.layer !== "core" && topic.layer !== memory.layer))
        return false;
    const override = overrides.filter(o => o.topic_id === topic.id && o.memory_id === memory.id && o.category === "promoted" && o.layer === (memory.layer ?? "core"))
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0];
    if (override?.mode === "include")
        return true;
    if (override?.mode === "exclude")
        return false;
    return memory.relatedFiles.some(file => { const path = file.replaceAll("\\", "/").replace(/^\.\//, ""); return topic.prefixes.some(p => path === p || path.startsWith(p + "/")); });
}
export function readHandbook(data: KnowledgeSnapshot, filter: KnowledgeFilter = { reach: "project" }) {
    const memories = handbookMemories(data, filter);
    const topics = resolveTopics(data.topics).filter(t => !t.deleted && (t.layer === "core" || visibleLayer(t.layer, data, filter)));
    const assigned = new Set<string>();
    const cards = topics.map(topic => { const items = memories.filter(m => topicMatches(topic, m, data.overrides)); items.forEach(m => assigned.add(m.id)); return { ...topic, peer: data.peerLayers.includes(topic.layer), counts: typeCounts(items), total: items.length }; });
    const unassigned = memories.filter(m => !assigned.has(m.id));
    return { topics: cards, unassigned: { id: "unassigned", name: "Unassigned", counts: typeCounts(unassigned), total: unassigned.length }, total: memories.length, layers: [...new Set(data.memories.filter(m => visibleLayer(m.layer ?? "core", data, { owner: "self" })).map(m => m.layer ?? "core"))].sort() };
}
export function readHandbookTopic(data: KnowledgeSnapshot, id: string, filter: KnowledgeFilter = { reach: "project" }, offset = 0, limit = 50) {
    const handbook = readHandbook(data, filter);
    const topic = id === "unassigned" ? handbook.unassigned : handbook.topics.find(t => t.id === id);
    if (!topic)
        throw new Error("Unknown handbook topic");
    const memories = handbookMemories(data, filter);
    const assigned = new Set(handbook.topics.flatMap(t => memories.filter(m => topicMatches(t, m, data.overrides)).map(m => m.id)));
    const items = id === "unassigned" ? memories.filter(m => !assigned.has(m.id)) : memories.filter(m => topicMatches(topic as unknown as Topic, m, data.overrides));
    const size = Math.max(1, Math.min(100, limit)), start = Math.max(0, offset);
    return { topic, items: items.slice(start, start + size).map(m => ({ ...m, peer: data.peerLayers.includes(m.layer ?? "core") })), total: items.length, ...(start + size < items.length ? { nextOffset: start + size } : {}) };
}
export function suggestHandbookTopics(data: KnowledgeSnapshot, filter: KnowledgeFilter = { reach: "project" }) {
    const memories = handbookMemories(data, filter), existing = resolveTopics(data.topics).filter(t => !t.deleted);
    const prefixes = new Map<string, Set<string>>();
    for (const m of memories)
        for (const file of m.relatedFiles) {
            let path: string;
            try {
                path = normalizeTopicPrefix(file);
            }
            catch {
                continue;
            }
            const parts = path.split("/");
            if (parts.length < 2)
                continue;
            const prefix = parts[0] === "src" && parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0]!;
            if (existing.some(t => t.prefixes.includes(prefix)))
                continue;
            const ids = prefixes.get(prefix) ?? new Set<string>();
            ids.add(m.id);
            prefixes.set(prefix, ids);
        }
    return [...prefixes].sort(([a], [b]) => a.localeCompare(b)).map(([prefix, ids]) => ({ name: prefix.split("/").at(-1)!.replace(/[-_]/g, " "), prefixes: [prefix], memoryIds: [...ids].sort(), total: ids.size }));
}
function typeCounts(memories: MemorySearchResult[]) { return { decisions: memories.filter(m => m.type === "decision").length, constraints: memories.filter(m => m.type === "constraint").length, bugFixes: memories.filter(m => m.type === "bug_fix").length, rejected: memories.filter(m => m.type === "rejected_approach").length }; }
export function previewHandbookTopic(data: KnowledgeSnapshot, prefixes: string[], filter: KnowledgeFilter & {
    layer?: string | undefined;
} = { reach: "project" }) {
    const normalized = prefixes.map(normalizeTopicPrefix);
    const items = handbookMemories(data, filter).filter(m => (!filter.layer || m.layer === filter.layer) && m.relatedFiles.some(file => normalized.some(p => file.replaceAll("\\", "/") === p || file.replaceAll("\\", "/").startsWith(p + "/"))));
    return { total: items.length, items: items.map(m => ({ id: m.id, title: m.title, text: m.statement?.text ?? m.summary, layer: m.layer })), prefixes: normalized };
}
