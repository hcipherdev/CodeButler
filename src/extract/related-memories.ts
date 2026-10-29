import { latestEvidenceTime } from "../memory/evidence-time.js";
import { parseScope } from "../memory/scope.js";
import type { MemoryStore } from "../storage/store.js";
import type { EvidenceRef, ExistingMemoryInput, ExtractorContext, MemoryScope, MemoryType } from "../types.js";

/** What an `E<n>` ref in an extraction batch points at, resolved server-side. */
export interface ExistingMemoryTarget {
  category: "candidate" | "promoted";
  id: string;
  type: MemoryType;
}

export interface RelatedMemorySelection {
  existingMemories: ExistingMemoryInput[];
  targets: Map<string, ExistingMemoryTarget>;
}

/** The candidate row a new extraction of a known fact should merge into. */
export interface CandidateIdentity {
  dedupeKey: string;
  scope: MemoryScope;
  layer: string;
}

const SUMMARY_LIMIT = 300;
const BATCH_TERMS = 60;
const FILE_WEIGHT = 3;
const STOPWORDS = new Set([
  "about", "after", "again", "also", "because", "before", "being", "between", "could", "does", "doing", "each",
  "from", "have", "here", "into", "just", "like", "make", "more", "most", "must", "need", "only", "other",
  "over", "same", "should", "show", "since", "some", "still", "such", "than", "that", "their", "them", "then",
  "there", "these", "they", "this", "those", "through", "under", "until", "very", "want", "were", "what",
  "when", "where", "which", "while", "will", "with", "without", "would", "your", "user", "assistant"
]);

/** A current durable memory or a live candidate, as related-memory selection and consolidation read it. */
export interface LiveMemoryItem {
  target: ExistingMemoryTarget;
  title: string;
  summary: string;
  reason: string;
  confidence: number;
  /** updated_at for a candidate, lifecycle_generation for a durable memory. */
  version: string;
  recordedAt: string;
  evidenceJson: string;
  files: string[];
  terms: Set<string>;
  durable: boolean;
}

/**
 * Picks the existing memories most related to a batch: shared files first, then
 * IDF-weighted term overlap. Reads rows and the cached quality directly, because a full
 * quality resolution of every candidate per batch would cost far more than the model call.
 */
export function selectRelatedMemories(store: MemoryStore, context: ExtractorContext, limit: number): RelatedMemorySelection {
  const empty: RelatedMemorySelection = { existingMemories: [], targets: new Map() };
  if (limit <= 0) return empty;
  const corpus = readLiveMemoryCorpus(store);
  if (corpus.length === 0) return empty;

  const batchFiles = new Set([
    ...context.commits.flatMap((commit) => commit.changedFiles),
    ...filesMentionedByChunks(store, context.conversations.flatMap((conversation) =>
      (conversation.chunks ?? []).filter((chunk) => !chunk.contextOnly && chunk.id).map((chunk) => chunk.id!)))
  ]);
  const batchText = [
    ...context.commits.map((commit) => `${commit.message}\n${commit.changedFiles.join(" ")}`),
    ...context.conversations.flatMap((conversation) => (conversation.chunks ?? []).filter((chunk) => !chunk.contextOnly).map((chunk) => chunk.text))
  ].join("\n");
  const batchTerms = topTerms(batchText, BATCH_TERMS);

  const documentFrequency = new Map<string, number>();
  for (const item of corpus) for (const term of item.terms) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  const idf = (term: string) => Math.log(1 + corpus.length / (documentFrequency.get(term) ?? 1));

  const scored = corpus.map((item) => {
    const fileHits = item.files.filter((file) => batchFiles.has(file)).length;
    const termMatches = [...item.terms].filter((term) => batchTerms.has(term));
    return { item, fileHits, termMatches: termMatches.length, score: FILE_WEIGHT * fileHits + termMatches.reduce((sum, term) => sum + idf(term), 0) };
  }).filter((entry) => entry.fileHits > 0 || entry.termMatches >= 2);
  scored.sort((left, right) =>
    right.score - left.score ||
    Number(right.item.durable) - Number(left.item.durable) ||
    right.item.recordedAt.localeCompare(left.item.recordedAt) ||
    left.item.target.id.localeCompare(right.item.target.id));

  const selection: RelatedMemorySelection = { existingMemories: [], targets: new Map() };
  for (const [index, { item }] of scored.slice(0, limit).entries()) {
    const ref = `E${index + 1}`;
    selection.targets.set(ref, item.target);
    selection.existingMemories.push({
      ref,
      type: item.target.type,
      title: item.title,
      summary: item.summary.length > SUMMARY_LIMIT ? `${item.summary.slice(0, SUMMARY_LIMIT - 1)}…` : item.summary,
      status: item.durable ? "durable" : "candidate",
      // When the fact was observed, not when its row was written: a backfilled memory is
      // older than its promotion date, and the model compares this against new evidence.
      recordedAt: observedAt(store, item)
    });
  }
  return selection;
}

/** The dedupe identity to merge into: the candidate itself, or the one a durable memory came from. */
export function candidateIdentityFor(store: MemoryStore, target: ExistingMemoryTarget): CandidateIdentity | undefined {
  const row = (target.category === "candidate"
    ? store.db.prepare("select dedupe_key, scope_json, layer from memory_candidates where id = ?").get(target.id)
    : store.db.prepare(
        "select dedupe_key, scope_json, layer from memory_candidates where promoted_memory_id = ? order by updated_at desc limit 1"
      ).get(target.id)) as { dedupe_key: string; scope_json: string; layer: string } | undefined;
  return row ? { dedupeKey: row.dedupe_key, scope: parseScope(row.scope_json), layer: row.layer } : undefined;
}

/**
 * Current durable memories and the candidates nobody withdrew, outside other devices'
 * read-only layers and without quarantined ones (by the cached device-local quality).
 */
export function readLiveMemoryCorpus(store: MemoryStore): LiveMemoryItem[] {
  const quarantined = new Set((store.localDb.prepare(
    "select category, memory_id from memory_quality_cache where quality_status = 'quarantined'"
  ).all() as Array<{ category: string; memory_id: string }>).map((row) => `${row.category}\0${row.memory_id}`));
  const peerLayers = "select layer from peer_partitions";
  const durable = store.db.prepare(
    `select id, type, title, summary, reason, confidence, lifecycle_generation as version, related_files_json, evidence_json, promoted_at as recorded_at
       from memories where lifecycle_status = 'current' and layer not in (${peerLayers})`
  ).all() as unknown as CorpusRow[];
  const candidates = store.db.prepare(
    `select c.id, c.type, c.title, c.summary, c.reason, c.confidence, c.updated_at as version, c.related_files_json, c.evidence_json, c.updated_at as recorded_at
       from memory_candidates c
      where c.promotion_state = 'candidate' and c.layer not in (${peerLayers})
        and not exists (
          select 1 from memory_review_resolutions r
           where r.memory_id = c.id and r.category = 'candidate' and r.action in ('correct', 'discard')
             and not exists (select 1 from memory_review_resolution_compensations x where x.resolution_id = r.id)
        )`
  ).all() as unknown as CorpusRow[];
  const items: LiveMemoryItem[] = [];
  for (const [category, rows] of [["promoted", durable], ["candidate", candidates]] as const) {
    for (const row of rows) {
      if (quarantined.has(`${category}\0${row.id}`)) continue;
      items.push({
        target: { category, id: row.id, type: row.type },
        title: row.title,
        summary: row.summary,
        reason: row.reason,
        confidence: row.confidence,
        version: row.version,
        recordedAt: row.recorded_at,
        evidenceJson: row.evidence_json,
        files: parseFiles(row.related_files_json),
        terms: new Set(tokens(`${row.title} ${row.summary}`)),
        durable: category === "promoted"
      });
    }
  }
  return items;
}

interface CorpusRow {
  id: string;
  type: MemoryType;
  title: string;
  summary: string;
  reason: string;
  confidence: number;
  version: string;
  related_files_json: string;
  evidence_json: string;
  recorded_at: string;
}

/** When the newest evidence behind a memory was observed, or when its row was written. */
export function observedAt(store: MemoryStore, item: Pick<LiveMemoryItem, "evidenceJson" | "recordedAt">): string {
  let evidence: EvidenceRef[] = [];
  try { evidence = JSON.parse(item.evidenceJson) as EvidenceRef[]; } catch { evidence = []; }
  const at = Array.isArray(evidence) ? latestEvidenceTime(store, evidence) : undefined;
  return at === undefined ? item.recordedAt : new Date(at).toISOString();
}

function filesMentionedByChunks(store: MemoryStore, chunkIds: string[]): string[] {
  const files: string[] = [];
  for (let offset = 0; offset < chunkIds.length; offset += 400) {
    const slice = chunkIds.slice(offset, offset + 400);
    const rows = store.db.prepare(
      `select distinct to_id from relations
        where from_type = 'chunk' and relation = 'mentions' and to_type = 'file' and from_id in (${slice.map(() => "?").join(", ")})`
    ).all(...slice) as Array<{ to_id: string }>;
    files.push(...rows.map((row) => row.to_id));
  }
  return files;
}

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? []).filter((token) => !STOPWORDS.has(token));
}

function topTerms(text: string, count: number): Set<string> {
  const frequency = new Map<string, number>();
  for (const token of tokens(text)) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  return new Set([...frequency.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, count).map(([term]) => term));
}

function parseFiles(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
