import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { MemoryStore } from "../storage/store.js";
import { memoryContentText } from "../memory/statement.js";
import { sharingLabel } from "../memory/presentation.js";
import { memoryMovement, type KnowledgeSnapshot } from "../memory/events.js";
import { readMemoryKnowledge } from "../memory/knowledge.js";
import { isPeerLayer } from "../memory/peer-layer.js";
import { canonicalRevisionParts } from "./canonical-revision.js";
import { withReadCache } from "./read-cache.js";
import type { MemorySearchResult, TemporaryMemory, MemoryQualityStatus } from "../types.js";
import { withPublishedIndex, freshness, RetrievalUnavailableError, type RetrievalFreshness, type Publication } from "./index.js";
export type MemoryTier = "working" | "candidates" | "durable" | "verified";
export type MemoryReach = "all" | "project" | "device" | "branch" | "branch_device";
export interface TierInput {
    tier?: MemoryTier;
    query?: string;
    qualityStatus?: MemoryQualityStatus | "all";
    history?: boolean;
    reach?: MemoryReach;
    owner?: "self" | "peer" | "any";
    type?: string;
    verifiedOnly?: boolean;
    limit?: number;
    cursor?: string;
}
export interface WorkingMemory extends TemporaryMemory {
    sharing: string;
    peer: boolean;
}
export interface MemoryTierCounts {
    working: number;
    candidates: number;
    durable: number;
    verified: number;
    replaced: number;
    expiringToday: number;
}
export interface TierPage {
    items: Array<MemorySearchResult | WorkingMemory>;
    total: number;
    counts: MemoryTierCounts;
    freshness: RetrievalFreshness;
    nextCursor?: string;
    restart?: boolean;
    movement7d?: ReturnType<typeof memoryMovement>;
}
/** One predicate defines both page membership and its total. */
function predicate(input: TierInput, now: string): {
    sql: string;
    params: SQLInputValue[];
} {
    const tier = input.tier ?? "durable";
    const clauses = [tier === "working" ? "r.category='temporary' and r.expires>?" :
            tier === "candidates" ? "r.category='candidate' and r.terminal=0" : "r.category='promoted'"];
    const params: SQLInputValue[] = tier === "working" ? [now] : [];
    if (tier !== "working" && tier !== "candidates" && (tier === "verified" || input.verifiedOnly || !input.history))
        clauses.push("r.lifecycle='current'");
    if (tier === "verified" || input.verifiedOnly)
        clauses.push("r.verified=1 and r.quality='active'");
    if (input.qualityStatus && input.qualityStatus !== "all") {
        clauses.push("r.quality=?");
        params.push(input.qualityStatus);
    }
    if (input.type) {
        clauses.push("r.type=?");
        params.push(input.type);
    }
    if (input.owner !== "any") {
        clauses.push("r.peer=?");
        params.push(input.owner === "peer" ? 1 : 0);
    }
    switch (input.reach) {
        case "project":
            clauses.push("r.layer='core'");
            break;
        case "device":
            clauses.push("r.layer like 'device:%'");
            break;
        case "branch":
            clauses.push("r.layer like 'branch:%' and instr(r.layer,':device:')=0");
            break;
        case "branch_device":
            clauses.push("r.layer like 'branch:%:device:%'");
            break;
    }
    const query = input.query?.trim().toLowerCase();
    if (query) {
        clauses.push("instr(r.text,?)>0");
        params.push(query);
    }
    return { sql: clauses.join(" and "), params };
}
function requireFormat(p: Publication): void {
    if (p.format !== 3)
        throw new RetrievalUnavailableError("Memory index is upgrading. Retry shortly.");
}
function count(db: DatabaseSync, input: TierInput, now: string): number {
    const where = predicate(input, now);
    return Number((db.prepare("select count(*) n from records r where " + where.sql).get(...where.params) as {
        n: number;
    }).n);
}
function snapshot(db: DatabaseSync, root: string, p: Publication, now: string, input:TierInput={}) {
    requireFormat(p);
    const row = db.prepare("select min(expires) expiry from records where category='temporary' and expires>?").get(now) as {
        expiry: string | null;
    };
    const counts: MemoryTierCounts = {
        working: count(db, { tier: "working" }, now), candidates: count(db, { tier: "candidates" }, now),
        durable: count(db, { tier: "durable" }, now), verified: count(db, { tier: "verified" }, now),
        replaced: Number((db.prepare("select count(*) n from records where category='promoted' and peer=0 and lifecycle='superseded'").get() as {
            n: number;
        }).n),
        expiringToday: Number((db.prepare("select count(*) n from records where category='temporary' and peer=0 and expires>? and expires<=?").get(now, new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString()) as {
            n: number;
        }).n)
    };
    const knowledge=db.prepare("select payload from memory_knowledge where id=1").get() as {payload:string}|undefined;
    const movement7d=knowledge ? memoryMovement(JSON.parse(knowledge.payload) as KnowledgeSnapshot,input,now) : undefined;
    const nextExpiryAt=[row.expiry,movement7d?.nextChangeAt].filter((at):at is string=>!!at).sort()[0];
    return { counts, ...(movement7d ? {movement7d} : {}), freshness: { ...freshness(root, p), evaluatedAt: now, ...(nextExpiryAt ? { nextExpiryAt } : {}) } };
}
export function readPublishedTiers(root: string, now = new Date().toISOString()) {
    return withPublishedIndex(root, (db, p) => snapshot(db, root, p, now));
}
export function readPublishedTierPage(root: string, input: TierInput = {}, now = new Date().toISOString()): TierPage {
    return withPublishedIndex(root, (db, p) => tierPage(db, root, p, input, now));
}
function tierPage(db: DatabaseSync, root: string, p: Publication, input: TierInput, now: string): TierPage {
    const state = snapshot(db, root, p, now, input);
    const where = predicate(input, now);
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)));
    const digest = createHash("sha256").update(JSON.stringify({ ...input, cursor: undefined })).digest("hex");
    let offset = 0;
    if (input.cursor) {
        let cursor: {
            revision: string;
            digest: string;
            offset: number;
            evaluatedAt: string;
            nextExpiryAt?: string;
        };
        try {
            cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
        }
        catch {
            throw new Error("Invalid memory cursor");
        }
        if (cursor.digest !== digest || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0)
            throw new Error("Invalid memory cursor");
        if (cursor.revision !== p.revision || (cursor.nextExpiryAt && cursor.nextExpiryAt <= now) || cursor.evaluatedAt > now)
            return { ...state, items: [], total: count(db, input, now), restart: true };
        offset = cursor.offset;
    }
    const rows = db.prepare("select payload from records r where " + where.sql + " order by r.time1 desc,r.time2 desc,r.id limit ? offset ?").all(...where.params, limit + 1, offset) as Array<{
        payload: string;
    }>;
    const nextCursor = rows.length > limit ? Buffer.from(JSON.stringify({ revision: p.revision, digest, offset: offset + limit, evaluatedAt: now, nextExpiryAt: state.freshness.nextExpiryAt })).toString("base64url") : undefined;
    return { ...state, items: rows.slice(0, limit).map(r => JSON.parse(r.payload)), total: count(db, input, now), ...(nextCursor ? { nextCursor } : {}) };
}
export function readPublishedWorkingDetail(root: string, id: string, now = new Date().toISOString()): WorkingMemory | undefined {
    return withPublishedIndex(root, (db, p) => {
        requireFormat(p);
        const row = db.prepare("select payload from records where category='temporary' and id=? and expires>?").get(id, now) as {
            payload: string;
        } | undefined;
        return row ? JSON.parse(row.payload) : undefined;
    });
}
/** Legacy desktop reads use the same predicates without enabling published retrieval. */
export function readCanonicalTierPage(store: MemoryStore, input: TierInput = {}, now = new Date().toISOString()): TierPage {
    const ownsSnapshot = !store.db.isTransaction;
    if (ownsSnapshot)
        store.db.exec("begin");
    try {
        const publication = canonicalPublication(store, now);
        const finish = (db: DatabaseSync): TierPage => {
            const page = tierPage(db, store.paths.rootDir, publication, input, now);
            return { ...page, freshness: { ...page.freshness, refreshing: false } };
        };
        // Inside a caller's transaction a rollback can reuse a change sequence for different rows,
        // so only a snapshot this read owns may be served from or stored in the cache.
        if (!ownsSnapshot) {
            const db = withReadCache(() => buildCanonicalIndex(store, now));
            try { return finish(db); }
            finally { db.close(); }
        }
        return finish(cachedCanonicalIndex(store, publication.revision, now));
    }
    finally {
        if (ownsSnapshot)
            store.db.exec("rollback");
    }
}
interface CanonicalIndex {
    root: string;
    revision: string;
    db: DatabaseSync;
}
const CANONICAL_INDEX_LIMIT = 3;
/** Most recently used last. Long-lived readers reuse an index until any journaled canonical change. */
const canonicalIndexes: CanonicalIndex[] = [];
/**
 * Triggers journal every table the tier records and their quality depend on into retrieval_changes,
 * and the revision also carries the quality and privacy policy, so an unchanged revision means an
 * unchanged index. Expiry and movement windows are applied at query time against `now`.
 */
function cachedCanonicalIndex(store: MemoryStore, revision: string, now: string): DatabaseSync {
    const root = store.paths.rootDir;
    const at = canonicalIndexes.findIndex(entry => entry.root === root);
    if (at >= 0) {
        const [entry] = canonicalIndexes.splice(at, 1);
        if (entry!.revision === revision) {
            canonicalIndexes.push(entry!);
            return entry!.db;
        }
        entry!.db.close();
    }
    const db = withReadCache(() => buildCanonicalIndex(store, now));
    canonicalIndexes.push({ root, revision, db });
    while (canonicalIndexes.length > CANONICAL_INDEX_LIMIT)
        canonicalIndexes.shift()!.db.close();
    return db;
}
/** Test hook: drop cached canonical indexes. */
export function clearCanonicalIndexCache(): void {
    while (canonicalIndexes.length)
        canonicalIndexes.pop()!.db.close();
}
function buildCanonicalIndex(store: MemoryStore, now: string): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    try {
        const promoted = store.listMemories({ qualityStatus: "all", lifecycleStatus: "all", layer: "all", owner: "any", limit: null });
        const candidates = store.listMemoryCandidates({ qualityStatus: "all", promotionState: "candidate", excludeTerminalReviews: true, layer: "all", owner: "any", limit: null });
        const metadata = new Map([...promoted, ...candidates].map(m => [m.id, m]));
        const memories = store.readMemorySearchResultsByIds([...metadata.keys()], { includeCandidates: true, lifecycleStatus: "all", summaryOnly: true });
        db.exec("create table records(category text,id text,text text,type text,quality text,lifecycle text,layer text,peer integer,terminal integer,time1 text,time2 text,payload text,expires text,verified integer); create table memory_knowledge(id integer primary key,payload text)");
        db.prepare("insert into memory_knowledge values(1,?)").run(JSON.stringify(readMemoryKnowledge(store)));
        const insert = db.prepare("insert into records values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
        for (const memory of memories) {
            const row = metadata.get(memory.id)!;
            const time1 = "promotedAt" in row ? row.promotedAt : row.updatedAt;
            insert.run(memory.kind, memory.id, [memoryContentText(memory), ...memory.relatedFiles].join(" ").toLowerCase(), memory.type, memory.qualityStatus ?? "needs_review", memory.lifecycleStatus ?? "current", memory.layer ?? "core", isPeerLayer(store, memory.layer) ? 1 : 0, 0, time1, row.createdAt, JSON.stringify(memory), "", memory.presentation?.verified ? 1 : 0);
        }
        const ids = store.db.prepare("select id from temporary_memories where project_id=? and expires_at>?").all(store.paths.rootDir, now) as Array<{
            id: string;
        }>;
        for (const { id } of ids) {
            const memory = store.readTemporaryMemory(id)!;
            const peer = isPeerLayer(store, memory.layer);
            const payload = { ...memory, peer, sharing: sharingLabel(memory.layer, peer) };
            insert.run("temporary", id, [memory.title, memory.summary, memory.details, ...memory.relatedFiles].join(" ").toLowerCase(), memory.kind, "active", "current", memory.layer ?? "core", peer ? 1 : 0, 0, memory.updatedAt, memory.createdAt, JSON.stringify(payload), memory.expiresAt, 0);
        }
        return db;
    }
    catch (error) {
        db.close();
        throw error;
    }
}
function canonicalPublication(store: MemoryStore, now: string): Publication {
    const { identity, sequence, policy } = canonicalRevisionParts(store);
    return { format: 3, identity, sequence, policy, epoch: "canonical", indexedAt: now, revision: identity + ":" + sequence + ":" + policy, health: {}, summary: {} };
}
export function readCanonicalFreshness(store: MemoryStore, now = new Date().toISOString()): RetrievalFreshness {
    const p = canonicalPublication(store, now);
    const row = store.db.prepare("select min(expires_at) expiry from temporary_memories where project_id=? and expires_at>?").get(store.paths.rootDir, now) as {
        expiry: string | null;
    };
    return { revision: p.revision, indexedAt: now, evaluatedAt: now, refreshing: false, ...(row.expiry ? { nextExpiryAt: row.expiry } : {}) };
}
