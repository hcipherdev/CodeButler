import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import { join, basename } from "node:path";
import type { MemorySearchResult, SearchResult } from "../types.js";
import type { MemoryStore } from "../storage/store.js";
import type { MemorySearchInput } from "../search/service.js";
import { withApplicability } from "../memory/scope.js";
import { matchesLayerFilter } from "../memory/layer.js";
import { effectiveTerminalMemoryReview } from "../memory/review-state.js";
import { withReadCache, clearReadCache } from "./read-cache.js";
import { activateRetrieval, retrievalEpoch, retrievalPaths, retrievalPolicy, retrievalPrivacyPolicy } from "./paths.js";
import { measured } from "./metrics.js";
import { resolveEvidenceCitations, resolveFileCitation, buildTrustSummary } from "../evidence/citations.js";
import { getProjectSummaryStatus, type ProjectSummaryStatus } from "../project-summary/service.js";
import { loadProjectConfig } from "../config.js";
import { memoryContentText } from "../memory/statement.js";
import { presentMemory, sharingLabel } from "../memory/presentation.js";
import { readMemoryKnowledge } from "../memory/knowledge.js";
import { countMatchedTerms, queryTermsFor } from "../search/query-terms.js";
import { isSearchExcludedPath } from "../sources/sensitive-path.js";
export interface RetrievalFreshness {
    revision: string;
    indexedAt: string;
    refreshing: boolean;
    evaluatedAt?: string;
    nextExpiryAt?: string;
    error?: string;
}
export interface RetrievalPage {
    items: MemorySearchResult[];
    nextCursor?: string;
    freshness: RetrievalFreshness;
    restart?: boolean;
}
export type RetrievalInput = MemorySearchInput & {
    offset?: number;
    cursor?: string;
    summaryOnly?: boolean;
};
export interface Publication {
    format?: number;
    identity: string;
    sequence: number;
    epoch: string;
    policy: string;
    privacyPolicy?: string;
    indexedAt: string;
    revision: string;
    health: unknown;
    summary: unknown;
    summaryStatus?: ProjectSummaryStatus;
    summaryCommits?: ReturnType<MemoryStore["findCommits"]>;
}
function isGeneratedOnlyCommit(store: MemoryStore, hash: string): boolean {
    const row = store.db.prepare("select changed_files_json from commits where hash=?").get(hash) as {
        changed_files_json: string;
    } | undefined;
    const files = row ? JSON.parse(row.changed_files_json) as string[] : [];
    return files.length > 0 && files.every(isSearchExcludedPath);
}
export function publicationPrivacyMatches(root: string, p: Publication): boolean {
    return p.privacyPolicy ? p.privacyPolicy === retrievalPrivacyPolicy(root) : p.policy === retrievalPolicy(root, 2, 1) || p.policy === retrievalPolicy(root, undefined, 1);
}
function publishedSummaryStatus(root: string, db: DatabaseSync, summary: ReturnType<MemoryStore["getProjectSummary"]>, commits: ReturnType<MemoryStore["findCommits"]>): ProjectSummaryStatus {
    const projected = { paths: { rootDir: root }, findCommits: () => commits,
        listMemories: (input: { layer?: string; qualityStatus?: string } = {}) =>
            (db.prepare("select payload from records where category='promoted' and lifecycle='current' and peer=0").all() as Array<{payload:string}>)
                .map(r => JSON.parse(r.payload) as MemorySearchResult)
                .filter(m => (input.layer !== "core" || m.layer === "core") && (input.qualityStatus !== "active" || m.qualityStatus === "active"))
        ,readMemorySearchResultsByIds: (ids: string[]) => ids.flatMap(id => { const row = db.prepare("select payload from records where category='promoted' and id=?").get(id) as {payload:string}|undefined; return row ? [JSON.parse(row.payload)] : []; })
    } as unknown as MemoryStore;
    try {
        return getProjectSummaryStatus(root, { store: projected, config: loadProjectConfig(root), projectState: summary });
    }
    catch {
        return getProjectSummaryStatus(root);
    }
}
interface StoredRow {
    category: string;
    id: string;
    text: string;
    payload: string;
    brief: string;
    time1: string;
    time2: string;
    tie: number;
}
export class RetrievalUnavailableError extends Error {
    readonly code = "index-preparing";
    constructor(message = "Memory index is preparing. Retry shortly.") { super(message); }
}
export function initializeRetrieval(db: DatabaseSync): void {
    if (Number((db.prepare("pragma user_version").get() as {
        user_version: number;
    }).user_version) > 3)
        throw new Error("Retrieval index uses a newer schema");
    db.exec(`pragma journal_mode=WAL; pragma busy_timeout=5000; pragma user_version=3;
    create table if not exists memory_knowledge(id integer primary key check(id=1),payload text not null);
    create table if not exists publication(id integer primary key check(id=1), value text not null);
    create table if not exists records(
      key integer primary key, category text not null, id text not null, text text not null,
      type text not null, quality text not null, lifecycle text not null, layer text not null,
      peer integer not null, terminal integer not null, time1 text not null, time2 text not null, tie integer not null,
      payload text not null, brief text not null, expires text not null default '', verified integer not null default 0, unique(category,id));
    create index if not exists records_page on records(category,time1 desc,time2 desc,tie);
    create index if not exists records_filter on records(quality,category,time1 desc,time2 desc,tie);
    create index if not exists records_layer on records(layer,quality,category,time1 desc,time2 desc,tie);
    create index if not exists records_order on records((case category when 'promoted' then 0 else 1 end),time1 desc,time2 desc,tie);
    create index if not exists records_quality_order on records(quality,peer,(case category when 'promoted' then 0 else 1 end),time1 desc,time2 desc,tie);
    create virtual table if not exists record_fts using fts5(text, tokenize='trigram case_sensitive 1');
    create trigger if not exists record_insert after insert on records begin insert into record_fts(rowid,text) values(new.key,new.text); end;
    create trigger if not exists record_delete after delete on records begin delete from record_fts where rowid=old.key; end;
    create trigger if not exists record_update after update on records begin delete from record_fts where rowid=old.key; insert into record_fts(rowid,text) values(new.key,new.text); end;
    create table if not exists dependencies(entity text not null, entity_id text not null, category text not null, memory_id text not null, primary key(entity,entity_id,category,memory_id));
    create index if not exists dependencies_memory on dependencies(category,memory_id);
    create table if not exists file_observations(path text primary key,citation_json text not null,observed_at integer not null,version integer not null);
    create table if not exists source_metadata(id text primary key,type text not null,title text not null,metadata_json text not null,citation_json text not null);
    create table if not exists semantic_vectors(provider_key text not null,provider_fingerprint text not null,owner_kind text not null,owner_id text not null,payload text not null,vector_blob blob not null);
    create index if not exists semantic_provider on semantic_vectors(provider_key,provider_fingerprint);
    create table if not exists peer_partitions(layer text primary key);
    create table if not exists quote_chunks(id text primary key,source_id text not null,chunk_index integer not null,text text not null,metadata_json text not null);
    create index if not exists quote_window on quote_chunks(source_id,chunk_index);
    create virtual table if not exists raw_fts using fts5(chunk_id unindexed,source_id unindexed,source_type unindexed,title,text);
  `);
    const columns = (db.prepare("pragma table_info(records)").all() as Array<{name:string}>).map(r => r.name);
    if (!columns.includes("expires")) db.exec("alter table records add column expires text not null default ''");
    if (!columns.includes("verified")) db.exec("alter table records add column verified integer not null default 0");
    db.exec("create index if not exists records_tiers on records(category,peer,lifecycle,quality,verified,expires)");
}
export function readPublication(db: DatabaseSync): Publication | undefined {
    const row = db.prepare("select value from publication where id=1").get() as {
        value: string;
    } | undefined;
    return row ? JSON.parse(row.value) as Publication : undefined;
}
/** Called on a captured canonical store, never on the interactive reader connection. */
export function publishRetrieval(store: MemoryStore, root: string, identity: string, epoch = retrievalEpoch(root)): {
    changed: number;
    revision: string;
} {
    const paths = retrievalPaths(root);
    mkdirSync(paths.directory, { recursive: true });
    const policy = retrievalPolicy(root);
    const sequence = Number((store.db.prepare("select coalesce(max(sequence),0) as n from retrieval_changes").get() as {
        n: number;
    }).n);
    let previous: Publication | undefined;
    if (existsSync(paths.database)) {
        const prior = new DatabaseSync(paths.database, { readOnly: true });
        try {
            previous = readPublication(prior);
        }
        catch (error) {
            if (!/malformed|not a database|no such table/i.test(String(error)))
                throw error;
        }
        finally {
            prior.close();
        }
    }
    const full = !previous || previous.format !== 3 || previous.identity !== identity || previous.epoch !== epoch || previous.policy !== policy || previous.sequence > sequence;
    const databasePath = full ? join(paths.directory, `index-${randomUUID()}.sqlite`) : paths.database;
    const db = new DatabaseSync(databasePath);
    initializeRetrieval(db);
    const changes = full ? [] : store.db.prepare("select entity,entity_id,operation,before_json,after_json from retrieval_changes where sequence>? order by sequence").all(previous!.sequence) as Array<{
        entity: string;
        entity_id: string;
        operation: string;
        before_json: string | null;
        after_json: string | null;
    }>;
    const dirty = new Set<string>();
    const dirtySources = new Set<string>();
    const dependents = db.prepare("select category,memory_id from dependencies where entity=? and entity_id=?");
    let refreshAll = full;
    for (const change of changes) {
        for (const json of [change.before_json, change.after_json])
            if (json) {
                const context = JSON.parse(json) as {
                    memory_id?: string;
                    category?: string;
                    from_memory_id?: string;
                    to_memory_id?: string;
                    source_id?: string;
                    changed_files_json?: string;
                    layer?: string;
                };
                if (context.memory_id && context.category)
                    dirty.add(`${context.category}\0${context.memory_id}`);
                for (const id of [context.from_memory_id, context.to_memory_id])
                    if (id) {
                        dirty.add(`promoted\0${id}`);
                        dirty.add(`candidate\0${id}`);
                    }
                if (context.source_id)
                    dirtySources.add(context.source_id);
                for (const file of JSON.parse(context.changed_files_json ?? "[]") as string[])
                    for (const d of dependents.all("file", file) as Array<{
                        category: string;
                        memory_id: string;
                    }>)
                        dirty.add(`${d.category}\0${d.memory_id}`);
                if (change.entity === "peer_partitions" && context.layer)
                    for (const d of db.prepare("select category,id from records where layer=?").all(context.layer) as Array<{
                        category: string;
                        id: string;
                    }>)
                        dirty.add(`${d.category}\0${d.id}`);
            }
        if (change.entity === "temporary_memories") dirty.add(`temporary\0${change.entity_id}`);
        if (change.entity === "memories" || change.entity === "memory_candidates")
            dirty.add(`${change.entity === "memories" ? "promoted" : "candidate"}\0${change.entity_id}`);
        for (const dependency of dependents.all(change.entity, change.entity_id) as Array<{
            category: string;
            memory_id: string;
        }>)
            dirty.add(`${dependency.category}\0${dependency.memory_id}`);
        if (change.entity === "sources")
            dirtySources.add(change.entity_id);
        if (change.entity === "chunks") {
            const chunk = store.db.prepare("select source_id from chunks where id=?").get(change.entity_id) as {
                source_id: string;
            } | undefined;
            const old = db.prepare("select source_id from quote_chunks where id=?").get(change.entity_id) as {
                source_id: string;
            } | undefined;
            if (chunk)
                dirtySources.add(chunk.source_id);
            if (old)
                dirtySources.add(old.source_id);
        }
        if (["memory_review_resolutions", "memory_review_resolution_compensations", "branch_triage_reviews", "promotion_decisions", "layer_retention_decisions"].includes(change.entity)) {
            const row = store.db.prepare(`select memory_id,category from ${change.entity} where id=?`).get(change.entity_id) as {
                memory_id: string;
                category: string;
            } | undefined;
            if (row)
                dirty.add(`${row.category}\0${row.memory_id}`);
        }
        if (change.entity === "commits") {
            const commit = store.readCommit(change.entity_id);
            for (const path of commit?.changedFiles ?? [])
                for (const d of dependents.all("file", path) as Array<{
                    category: string;
                    memory_id: string;
                }>)
                    dirty.add(`${d.category}\0${d.memory_id}`);
        }
    }
    if (refreshAll)
        for (const [table, category] of [["memories", "promoted"], ["memory_candidates", "candidate"], ["temporary_memories", "temporary"]] as const) {
            for (const row of store.db.prepare(`select id from ${table}`).iterate() as Iterable<{
                id: string;
            }>)
                dirty.add(`${category}\0${row.id}`);
        }
    const peers = new Set((store.db.prepare("select layer from peer_partitions").all() as Array<{
        layer: string;
    }>).map(r => r.layer));
    const revision = `${identity}:${sequence}:${randomUUID()}`;
    db.exec("begin immediate");
    try {
        if (full)
            db.exec("delete from records; delete from dependencies; delete from source_metadata; delete from quote_chunks; delete from raw_fts; delete from file_observations;");
        db.exec("delete from peer_partitions");
        const insertPeer = db.prepare("insert into peer_partitions values(?)");
        for (const layer of peers)
            insertPeer.run(layer);
        const remove = db.prepare("delete from records where category=? and id=?");
        const removeDeps = db.prepare("delete from dependencies where category=? and memory_id=?");
        const dependency = db.prepare("insert or ignore into dependencies values(?,?,?,?)");
        const insert = db.prepare(`insert into records(category,id,text,type,quality,lifecycle,layer,peer,terminal,time1,time2,tie,payload,brief,expires,verified)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(category,id) do update set text=excluded.text,type=excluded.type,quality=excluded.quality,lifecycle=excluded.lifecycle,layer=excluded.layer,peer=excluded.peer,terminal=excluded.terminal,time1=excluded.time1,time2=excluded.time2,tie=excluded.tie,payload=excluded.payload,brief=excluded.brief,expires=excluded.expires,verified=excluded.verified`);
        const ownsLocalTransaction = !store.localDb.isTransaction;
        if (ownsLocalTransaction)
            store.localDb.exec("begin");
        try {
            withReadCache(() => {
                let batchPosition = 0;
                for (const key of dirty) {
                    if (batchPosition++ % 250 === 0)
                        clearReadCache(store);
                    const [category, id] = key.split("\0") as [
                        "promoted" | "candidate" | "temporary",
                        string
                    ];
                    if (category === "temporary") {
                        const memory = store.readTemporaryMemory(id);
                        removeDeps.run(category, id);
                        if (!memory) { remove.run(category, id); continue; }
                        const text = [memory.title, memory.summary, memory.details, ...memory.relatedFiles].join(" ").toLowerCase();
                        const payload = { ...memory, sharing: sharingLabel(memory.layer, peers.has(memory.layer ?? "core")), peer: peers.has(memory.layer ?? "core") };
                        // Temporary entries retain their own kind and expiry; they never acquire durable trust.
                        insert.run(category, id, text, memory.kind, "active", "current", memory.layer ?? "core", payload.peer ? 1 : 0, 0, memory.updatedAt, memory.createdAt, 0, JSON.stringify(payload), JSON.stringify(payload), memory.expiresAt, 0);
                        for (const ref of memory.evidence) {
                            dependency.run(ref.sourceType === "commit" ? "commits" : "sources", ref.sourceId, category, id);
                            if (ref.locator) dependency.run("chunks", ref.locator, category, id);
                        }
                        continue;
                    }
                    const table = category === "promoted" ? "memories" : "memory_candidates";
                    const row = store.db.prepare(`select *,rowid as position from ${table} where id=?`).get(id) as Record<string, unknown> | undefined;
                    removeDeps.run(category, id);
                    if (!row || (category === "candidate" && row.promotion_state !== "candidate")) {
                        remove.run(category, id);
                        continue;
                    }
                    const memory = store.readMemorySearchResultsByIds([id], { includeCandidates: category === "candidate", lifecycleStatus: "all" }).find(m => m.kind === category);
                    if (!memory) {
                        remove.run(category, id);
                        continue;
                    }
                    const terminal = effectiveTerminalMemoryReview(store, category, { id });
                    memory.presentation = presentMemory(memory, peers.has(memory.layer ?? "core"));
                    const text = [memoryContentText(memory), memory.relatedFiles.join(" ")].join(" ").toLowerCase();
                    const brief = { scope: memory.scope, origin: memory.origin, applicability: memory.applicability, statement: memory.statement, presentation: memory.presentation, kind: memory.kind, id: memory.id, type: memory.type, title: memory.title, summary: memory.summary, reason: memory.reason, confidence: memory.confidence,
                        evidence: memory.evidence, relatedFiles: memory.relatedFiles, dedupeKey: memory.dedupeKey, layer: memory.layer, qualityStatus: memory.qualityStatus, qualityReasons: memory.qualityReasons,
                        displayStatus: memory.trust?.displayStatus, ...(memory.lifecycleStatus ? { lifecycleStatus: memory.lifecycleStatus } : {}) };
                    insert.run(category, id, text, memory.type, memory.qualityStatus ?? "needs_review", memory.lifecycleStatus ?? "current", memory.layer ?? "core", peers.has(memory.layer ?? "core") ? 1 : 0, terminal?.action === "discard" ? 2 : terminal ? 1 : 0, String(category === "promoted" ? row.promoted_at : row.updated_at), String(row.created_at), Number(row.position) * (category === "candidate" ? -1 : 1), JSON.stringify(memory), JSON.stringify(brief), "", memory.presentation.verified ? 1 : 0);
                    for (const ref of memory.evidence) {
                        dependency.run(ref.sourceType === "commit" ? "commits" : "sources", ref.sourceId, category, id);
                        if (ref.locator)
                            dependency.run("chunks", ref.locator, category, id);
                    }
                    for (const file of memory.relatedFiles) {
                        dependency.run("file", file, category, id);
                        db.prepare("insert into file_observations values(?,?,?,1) on conflict(path) do update set citation_json=excluded.citation_json,observed_at=excluded.observed_at,version=file_observations.version+(file_observations.citation_json<>excluded.citation_json)").run(file, JSON.stringify(resolveFileCitation(root, file)), Date.now());
                    }
                }
            });
        }
        finally {
            if (ownsLocalTransaction)
                store.localDb.exec("commit");
        }
        if (full)
            for (const row of store.db.prepare("select id from sources").iterate() as Iterable<{
                id: string;
            }>)
                dirtySources.add(row.id);
        const addSource = db.prepare("insert or replace into source_metadata values(?,?,?,?,?)");
        const addChunk = db.prepare("insert or replace into quote_chunks values(?,?,?,?,?)");
        const addFts = db.prepare("insert into raw_fts(rowid,chunk_id,source_id,source_type,title,text) values(?,?,?,?,?,?)");
        for (const id of dirtySources) {
            if (!full) {
                db.prepare("delete from raw_fts where rowid in (select rowid from quote_chunks where source_id=?)").run(id);
                db.prepare("delete from source_metadata where id=?").run(id);
                db.prepare("delete from quote_chunks where source_id=?").run(id);
            }
            const source = store.readSourceMetadata(id);
            if (!source)
                continue;
            // Generated-only commits stay quotable as evidence but are kept out of raw search.
            const searchable = source.type !== "commit" || !isGeneratedOnlyCommit(store, id);
            addSource.run(id, source.type, source.title, JSON.stringify(source.metadata ?? {}), JSON.stringify(source.type === "conversation" ? null : resolveEvidenceCitations(store, { evidence: [{ sourceType: source.type, sourceId: id }] })));
            for (const chunk of store.db.prepare("select * from chunks where source_id=? order by chunk_index").iterate(id) as Iterable<{
                id: string;
                chunk_index: number;
                text: string;
                metadata_json: string;
            }>) {
                const inserted = addChunk.run(chunk.id, id, chunk.chunk_index, chunk.text, chunk.metadata_json);
                if (searchable)
                    addFts.run(inserted.lastInsertRowid, chunk.id, id, source.type, source.title, chunk.text);
            }
        }
        const counts = db.prepare("select category,quality,count(*) as n from records where peer=0 and ((category='promoted' and lifecycle='current') or (category='candidate' and terminal=0)) group by category,quality").all() as Array<{
            category: string;
            quality: string;
            n: number;
        }>;
        if (full || dirty.size || dirtySources.size || changes.some(c => c.entity === "embedding_vectors")) {
            db.exec("delete from semantic_vectors");
            const vectorInsert = db.prepare("insert into semantic_vectors values(?,?,?,?,?,?)");
            for (const vector of store.listActiveEmbeddingVectors()) {
                const { vectorBlob, ...payload } = vector;
                vectorInsert.run(vector.providerKey, vector.providerFingerprint, vector.ownerKind, vector.ownerId, JSON.stringify(payload), vectorBlob);
            }
        }
        const health = { active: 0, needsReview: 0, quarantined: 0, retired: 0, replaced: 0, candidates: { needsReview: 0, quarantined: 0 } };
        for (const row of counts) {
            const candidate = row.category === "candidate";
            if (row.quality === "active")
                health.active += row.n;
            else if (row.quality === "needs_review") {
                health.needsReview += row.n;
                if (candidate)
                    health.candidates.needsReview += row.n;
            }
            else {
                health.quarantined += row.n;
                if (candidate)
                    health.candidates.quarantined += row.n;
            }
        }
        health.retired = Number((db.prepare("select count(*) n from records where peer=0 and (lifecycle='retracted' or (category='candidate' and terminal=2))").get() as {
            n: number;
        }).n);
        health.replaced = Number((db.prepare("select count(*) n from records where peer=0 and (lifecycle='superseded' or (category='candidate' and terminal=1))").get() as {
            n: number;
        }).n);
        const historicalTotal = Number((db.prepare("select count(*) n from records where peer=0 and category in ('candidate','promoted')").get() as {
            n: number;
        }).n);
        const topReasons = db.prepare("select j.value as reason,count(*) as count from records r,json_each(r.payload,'$.qualityReasons') j where peer=0 and ((category='promoted' and lifecycle='current') or (category='candidate' and terminal=0)) group by j.value order by count desc,reason asc").all();
        // The candidate split is for the desktop overview; the audit shape matches summarizeMemoryHealth exactly.
        const { candidates: _candidates, ...auditCounts } = health;
        const auditHealth = { ...auditCounts, scanned: historicalTotal, total: health.active + health.needsReview + health.quarantined, historicalTotal, complete: true, rejected: health.quarantined, topReasons };
        const summary: ReturnType<MemoryStore["getProjectSummary"]> = { sources: 0, chunks: 0, commits: 0, decisions: 0, candidateMemories: 0, promotedMemories: 0, temporaryMemories: 0, memoryHealth: health, syncSources: {} };
        for (const [table, field] of [["sources", "sources"], ["chunks", "chunks"], ["commits", "commits"], ["decisions", "decisions"], ["memory_candidates", "candidateMemories"], ["memories", "promotedMemories"], ["temporary_memories", "temporaryMemories"]] as const)
            summary[field] = Number((store.db.prepare(`select count(*) n from ${table}`).get() as {
                n: number;
            }).n);
        summary.syncSources = Object.fromEntries(store.listSyncStatuses().map(s => [s.source, s]));
        summary.extraction = store.getExtractionStatus();
        const lastSyncAt = Object.values(summary.syncSources).flatMap(s => s?.lastSyncAt ? [s.lastSyncAt] : []).sort().at(-1);
        if (lastSyncAt)
            summary.lastSyncAt = lastSyncAt;
        if (retrievalEpoch(root) !== epoch || retrievalPolicy(root) !== policy)
            throw new RetrievalUnavailableError("Memory index was invalidated during publication.");
        // The same window the live summary filters from, so both compute the same fingerprint.
        const summaryCommits = store.findCommits({ limit: 100 });
        const knowledgeMemories=(db.prepare("select payload from records where category in ('candidate','promoted') order by id").all() as Array<{payload:string}>).map(row=>JSON.parse(row.payload) as MemorySearchResult);
        db.prepare("insert or replace into memory_knowledge values(1,?)").run(JSON.stringify(readMemoryKnowledge(store,knowledgeMemories)));
        const publication: Publication = { format: 3, identity, sequence, epoch, policy, privacyPolicy: retrievalPrivacyPolicy(root), indexedAt: new Date().toISOString(), revision, health: auditHealth, summary, summaryCommits, summaryStatus: publishedSummaryStatus(root, db, summary, summaryCommits) };
        db.prepare("insert or replace into publication values(1,?)").run(JSON.stringify(publication));
        db.exec("commit");
        if (full) {
            const check = db.prepare("pragma quick_check").get() as {
                quick_check: string;
            };
            if (check.quick_check !== "ok")
                throw new Error("Retrieval index validation failed");
            db.exec("pragma wal_checkpoint(TRUNCATE)");
            if (retrievalEpoch(root) !== epoch)
                throw new RetrievalUnavailableError("Memory index invalidated before activation");
            activateRetrieval(root, basename(databasePath));
        }
        return { changed: dirty.size, revision };
    }
    catch (error) {
        if (db.isTransaction)
            db.exec("rollback");
        throw error;
    }
    finally {
        db.close();
    }
}
const readers = new Map<string, {
    db: DatabaseSync;
    statements: Map<string, StatementSync>;
    epoch: string;
    path: string;
    publication?: Publication;
}>();
const fileObservations = new Map<string, {
    at: number;
    citation: ReturnType<typeof resolveFileCitation>;
}>();
const candidates = new Map<string, {
    revision: string;
    queries: Map<string, Array<{
        rowid: number;
    }>>;
}>();
const fileWatchers = new Map<string, FSWatcher>();
function refreshFileCitations(root: string, memory: MemorySearchResult): MemorySearchResult {
    if (!memory.citations?.some(c => c.kind === "file"))
        return memory;
    memory.citations = memory.citations.map(c => {
        if (c.kind !== "file")
            return c;
        const key = JSON.stringify([root, c.sourceId]);
        const previous = fileObservations.get(key);
        if (previous && Date.now() - previous.at < 5000)
            return previous.citation;
        const citation = resolveFileCitation(root, c.sourceId);
        if (fileObservations.size > 10000)
            fileObservations.clear();
        fileObservations.set(key, { at: Date.now(), citation });
        return citation;
    });
    return memory;
}
export function closeRetrievalReaders(root?: string): void {
    fileObservations.clear();
    if (root)
        candidates.delete(root);
    else
        candidates.clear();
    for (const [key, watcher] of fileWatchers)
        if (!root || root === key) {
            watcher.close();
            fileWatchers.delete(key);
        }
    for (const [key, reader] of readers)
        if (!root || key === root) {
            reader.db.close();
            readers.delete(key);
        }
}
export function withPublishedIndex<T>(root: string, work: (db: DatabaseSync, publication: Publication, prepare: (sql: string) => StatementSync) => T): T {
    const inFlight = readers.get(root);
    if (inFlight?.db.isTransaction && inFlight.publication)
        return work(inFlight.db, inFlight.publication, sql => {
            let statement = inFlight.statements.get(sql);
            if (!statement) {
                statement = inFlight.db.prepare(sql);
                inFlight.statements.set(sql, statement);
            }
            return statement;
        });
    const epoch = retrievalEpoch(root);
    const path = retrievalPaths(root).database;
    if (!existsSync(path))
        throw new RetrievalUnavailableError();
    let reader = readers.get(root);
    if (reader && (reader.epoch !== epoch || reader.path !== path)) {
        closeRetrievalReaders(root);
        reader = undefined;
    }
    if (!reader) {
        if (readers.size >= 8) {
            const oldest = readers.keys().next().value;
            if (oldest)
                closeRetrievalReaders(oldest);
        }
        reader = { db: new DatabaseSync(path, { readOnly: true }), statements: new Map(), epoch, path };
        reader.db.exec("pragma busy_timeout=100; pragma cache_size=-32768; pragma mmap_size=268435456");
        readers.set(root, reader);
        try {
            const watcher = watch(root, { persistent: false, recursive: true }, (_event, name) => {
                if (name && !/^(?:\.git|\.code-butler)(?:[\\/]|$)/.test(String(name)))
                    fileObservations.clear();
            });
            watcher.on("error", () => watcher.close());
            fileWatchers.set(root, watcher);
        }
        catch { /* Five-second reconciliation remains available where notifications fail. */ }
    }
    const { db, statements } = reader;
    const prepare = (sql: string) => { let statement = statements.get(sql); if (!statement) {
        if (statements.size >= 128)
            statements.clear();
        statement = db.prepare(sql);
        statements.set(sql, statement);
    } return statement; };
    const nested = db.isTransaction;
    if (!nested)
        db.exec("begin");
    try {
        const publication = readPublication(db);
        if (!publication || publication.epoch !== epoch || !publicationPrivacyMatches(root, publication))
            throw new RetrievalUnavailableError();
        reader.publication = publication;
        const result = work(db, publication, prepare);
        if (retrievalEpoch(root) !== epoch || !publicationPrivacyMatches(root, publication))
            throw new RetrievalUnavailableError("Memory index was invalidated.");
        return result;
    }
    finally {
        if (!nested) {
            delete reader.publication;
            db.exec("rollback");
        }
    }
}
export function freshness(root: string, p: Publication): RetrievalFreshness {
    let status: {
        running?: boolean;
        error?: string;
        pid?: number;
    } = {};
    try {
        status = JSON.parse(readFileSync(retrievalPaths(root).status, "utf8"));
    }
    catch { /* No worker yet. */ }
    if (status.running && status.pid)
        try {
            process.kill(status.pid, 0);
        }
        catch {
            status = { running: false, error: "Memory index worker stopped before completing publication." };
        }
    return { revision: p.revision, indexedAt: p.indexedAt, refreshing: status.running === true || p.policy !== retrievalPolicy(root), ...(status.error ? { error: status.error } : {}) };
}
export function readPublishedMemories(root: string, input: RetrievalInput = {}): RetrievalPage {
    return measured("query", () => withPublishedIndex(root, (db, p, prepare) => {
        const limit = Math.max(1, Math.min(100, Math.floor(input.limit || 10)));
        const query = input.query?.trim().toLowerCase() ?? "";
        const digest = createHash("sha256").update(JSON.stringify({ ...input, cursor: undefined, offset: undefined })).digest("hex");
        let offset = Math.max(0, Math.min(10000, Math.floor(input.offset || 0)));
        if (input.cursor) {
            let cursor: {
                revision: string;
                digest: string;
                offset: number;
            };
            try {
                cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
            }
            catch {
                throw new Error("Invalid memory cursor");
            }
            if (cursor.digest !== digest || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0)
                throw new Error("Invalid memory cursor");
            if (cursor.revision !== p.revision)
                return { items: [], freshness: freshness(root, p), restart: true };
            offset = cursor.offset;
        }
        const clauses: string[] = ["(r.category='promoted' or (r.category='candidate' and r.terminal=0))"];
        const params: SQLInputValue[] = [];
        if (input.status) {
            clauses.push("r.category=?");
            params.push(input.status);
        }
        if (input.type) {
            clauses.push("r.type=?");
            params.push(input.type);
        }
        if (input.qualityStatus !== "all") {
            clauses.push("r.quality=?");
            params.push(input.qualityStatus ?? "active");
        }
        if (input.lifecycleStatus !== "all") {
            clauses.push("(r.category='candidate' or r.lifecycle=?)");
            params.push(input.lifecycleStatus ?? "current");
        }
        if (input.owner !== "any") {
            clauses.push("r.peer=?");
            params.push(input.owner === "peer" ? 1 : 0);
        }
        if (input.layer && input.layer !== "all") {
            clauses.push(input.layer === "core" ? "r.layer='core'" : "r.layer like ?");
            if (input.layer !== "core")
                params.push(`${input.layer}:%`);
        }
        let prefix = "";
        let from = "records r";
        let order = "case r.category when 'promoted' then 0 else 1 end,r.time1 desc,r.time2 desc,r.tie";
        const orderParams: SQLInputValue[] = [];
        const terms = queryTermsFor(query, input.match);
        if (terms) {
            // Any term may match; promoted still leads, then the most terms matched, then recency.
            const hits = `(${terms.map(() => "(instr(r.text,?)>0)").join("+")})`;
            const trigram = terms.every(term => [...term].length >= 3 && !term.includes("\0"));
            if (trigram) {
                const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
                const key = `\0${match}`;
                let cache = candidates.get(root);
                if (!cache || cache.revision !== p.revision) {
                    cache = { revision: p.revision, queries: new Map() };
                    candidates.set(root, cache);
                }
                let preview = cache.queries.get(key);
                if (!preview) {
                    preview = prepare("select rowid from record_fts where record_fts match ? limit 129").all(match) as Array<{
                        rowid: number;
                    }>;
                    if (cache.queries.size >= 128)
                        cache.queries.delete(cache.queries.keys().next().value!);
                    cache.queries.set(key, preview);
                }
                if (preview.length <= 128) {
                    prefix = "with hits as materialized (select value as rowid from json_each(?)) ";
                    params.unshift(JSON.stringify(preview.map(hit => hit.rowid)));
                    from = "hits cross join records r on r.key=hits.rowid";
                }
                else {
                    clauses.push("r.key in (select rowid from record_fts where record_fts match ?)");
                    params.push(match);
                }
            }
            clauses.push(`${hits}>0`);
            params.push(...terms);
            order = `case r.category when 'promoted' then 0 else 1 end,${hits} desc,r.time1 desc,r.time2 desc,r.tie`;
            orderParams.push(...terms);
        }
        else if (query) {
            const trigram = [...query].length >= 3 && !query.includes("\0");
            const match = `"${query.replaceAll('"', '""')}"`;
            let cache = candidates.get(root);
            if (!cache || cache.revision !== p.revision) {
                cache = { revision: p.revision, queries: new Map() };
                candidates.set(root, cache);
            }
            let preview = trigram ? cache.queries.get(query) : undefined;
            if (trigram && !preview) {
                preview = prepare("select rowid from record_fts where record_fts match ? limit 129").all(match) as Array<{
                    rowid: number;
                }>;
                if (cache.queries.size >= 128)
                    cache.queries.delete(cache.queries.keys().next().value!);
                cache.queries.set(query, preview);
            }
            if (preview && preview.length <= 128) {
                // Selective queries must visit candidates first, not walk the ordering index.
                prefix = "with hits as materialized (select value as rowid from json_each(?)) ";
                params.unshift(JSON.stringify(preview.map(hit => hit.rowid)));
                from = "hits cross join records r on r.key=hits.rowid";
            }
            else {
                // Broad and short queries scan compact text, then stop the ordered walk at a page.
                from = "records r indexed by records_order";
                clauses.push(`r.key in (select rowid from record_fts where ${trigram ? "record_fts match ?" : "instr(text,?)>0"})`);
                params.push(trigram ? match : query);
            }
            clauses.push("instr(r.text,?)>0");
            params.push(query);
        }
        const sql = `${prefix}select ${input.summaryOnly ? "r.brief" : "r.payload"}${terms ? ",r.text" : ""} from ${from} where ${clauses.join(" and ")} order by ${order} limit ? offset ?`;
        const rows = prepare(sql).all(...params, ...orderParams, limit + 1, offset) as unknown as Array<StoredRow & { text?: string }>;
        const items = rows.slice(0, limit).map(row => {
            const memory = refreshFileCitations(root, JSON.parse(input.summaryOnly ? row.brief : row.payload) as MemorySearchResult);
            return terms ? { ...memory, match: { terms: terms.length, matched: countMatchedTerms(row.text ?? "", terms) } } : memory;
        }).filter(memory => matchesLayerFilter(memory.layer, input.layer));
        return { items: withApplicability(items, input.targetEnvironment), freshness: freshness(root, p), ...(rows.length > limit ? { nextCursor: Buffer.from(JSON.stringify({ revision: p.revision, digest, offset: offset + limit })).toString("base64url") } : {}) };
    }));
}
export function readPublishedDetail(root: string, id: string): MemorySearchResult | undefined {
    return withPublishedIndex(root, (_db, _p, prepare) => { const row = prepare("select payload from records where id=? and category in ('candidate','promoted') order by category desc limit 1").get(id) as {
        payload: string;
    } | undefined; return row ? refreshFileCitations(root, JSON.parse(row.payload) as MemorySearchResult) : undefined; });
}
export function readPublishedSummary(root: string) { return withPublishedIndex(root, (_db, p) => ({ summary: p.summary as ReturnType<MemoryStore["getProjectSummary"]>, status: p.summaryStatus, freshness: freshness(root, p) })); }
export function readPublishedHealth(root: string) { return withPublishedIndex(root, (_db, p) => p.health); }
/** Filesystem-only maintenance never needs a canonical snapshot or quality pass. */
export function refreshPublishedFiles(root: string): void {
    const paths = retrievalPaths(root);
    if (!existsSync(paths.database))
        return;
    const db = new DatabaseSync(paths.database);
    try {
        const p = readPublication(db);
        if (!p || p.epoch !== retrievalEpoch(root) || p.policy !== retrievalPolicy(root))
            return;
        let changed = false;
        db.exec("begin immediate");
        const now = Date.now();
        for (const row of db.prepare("select path,citation_json from file_observations where observed_at<=?").all(now - 4000) as Array<{
            path: string;
            citation_json: string;
        }>) {
            const citation = resolveFileCitation(root, row.path);
            const json = JSON.stringify(citation);
            db.prepare("update file_observations set citation_json=?,observed_at=?,version=version+? where path=?").run(json, now, json === row.citation_json ? 0 : 1, row.path);
            if (json === row.citation_json)
                continue;
            changed = true;
            for (const item of db.prepare("select r.key,r.payload from records r join dependencies d on d.category=r.category and d.memory_id=r.id where d.entity='file' and d.entity_id=?").all(row.path) as Array<{
                key: number;
                payload: string;
            }>) {
                const memory = JSON.parse(item.payload) as MemorySearchResult;
                memory.citations = memory.citations?.map(c => c.kind === "file" && c.sourceId === JSON.parse(row.citation_json).sourceId ? citation : c);
                db.prepare("update records set payload=? where key=?").run(JSON.stringify(memory), item.key);
            }
        }
        p.summaryStatus = publishedSummaryStatus(root, db, p.summary as ReturnType<MemoryStore["getProjectSummary"]>, p.summaryCommits ?? []);
        if (changed) {
            p.revision = `${p.identity}:${p.sequence}:${randomUUID()}`;
            p.indexedAt = new Date().toISOString();
        }
        db.prepare("update publication set value=? where id=1").run(JSON.stringify(p));
        if (p.epoch !== retrievalEpoch(root))
            throw new RetrievalUnavailableError();
        db.exec("commit");
    }
    finally {
        if (db.isTransaction)
            db.exec("rollback");
        db.close();
    }
}
interface RawRow {
    chunk_id: string;
    source_id: string;
    source_type: SearchResult["sourceType"];
    title: string;
    text: string;
    metadata_json: string;
    source_metadata: string;
    citation_json: string;
    chunk_index: number;
    score: number;
}
function rawResult(r: RawRow): SearchResult {
    const evidence = { sourceType: r.source_type, sourceId: r.source_id, locator: r.chunk_id };
    const clean = r.text.replace(/\s+/g, " ").trim();
    const citations = r.source_type === "conversation" ? [{ kind: "conversation" as const, sourceId: r.source_id, locator: r.chunk_id, label: `${r.title} chunk ${r.chunk_index}`, summary: clean.length > 180 ? `${clean.slice(0, 177)}...` : clean, resolved: true, metadata: JSON.parse(r.source_metadata) }] : (JSON.parse(r.citation_json) as NonNullable<SearchResult["citations"]>).map(c => ({ ...c, locator: r.chunk_id }));
    return { chunkId: r.chunk_id, sourceId: r.source_id, sourceType: r.source_type, title: r.title, text: r.text, score: r.score, metadata: JSON.parse(r.metadata_json), evidence, citations, trust: buildTrustSummary({ status: "active", evidence: [evidence], citations, reasons: [] }) };
}
export function readPublishedChunks(root: string, ids: string[]): SearchResult[] {
    return withPublishedIndex(root, (_db, _p, prepare) => {
        const found = new Map<string, SearchResult>();
        for (let start = 0; start < ids.length; start += 250) {
            const batch = ids.slice(start, start + 250);
            const rows = prepare(`select q.id as chunk_id,q.source_id,q.chunk_index,q.text,q.metadata_json,s.type as source_type,s.title,s.metadata_json as source_metadata,s.citation_json,0 as score from quote_chunks q join source_metadata s on s.id=q.source_id where q.id in (${batch.map(() => "?").join(",")})`).all(...batch) as unknown as RawRow[];
            for (const row of rows)
                found.set(row.chunk_id, rawResult(row));
        }
        return ids.flatMap(id => found.has(id) ? [found.get(id)!] : []);
    });
}
export function readPublishedRaw(root: string, input: {
    query: string;
    sourceTypes?: string[];
    limit?: number;
}): SearchResult[] {
    return withPublishedIndex(root, (_db, _p, prepare) => {
        const tokens = (input.query.match(/[A-Za-z0-9_./-]+/g) ?? []).map(t => `"${t.replaceAll('"', '""')}"`).join(" OR ");
        if (!tokens)
            return [];
        const types = input.sourceTypes ?? [];
        const rows = prepare(`select f.*,q.metadata_json,q.chunk_index,s.metadata_json as source_metadata,s.citation_json,bm25(raw_fts) as score from raw_fts f join quote_chunks q on q.id=f.chunk_id join source_metadata s on s.id=f.source_id where raw_fts match ? ${types.length ? `and f.source_type in (${types.map(() => "?").join(",")})` : ""} order by score asc limit ?`)
            .all(tokens, ...types, Math.max(1, Math.min(100, input.limit || 10))) as unknown as Array<{
            chunk_id: string;
            source_id: string;
            source_type: SearchResult["sourceType"];
            title: string;
            text: string;
            metadata_json: string;
            source_metadata: string;
            citation_json: string;
            chunk_index: number;
            score: number;
        }>;
        return rows.map(rawResult);
    });
}
