import { randomUUID } from "node:crypto";

import { observedAt, readLiveMemoryCorpus, type LiveMemoryItem } from "../extract/related-memories.js";
import { parseJsonFromModelText } from "../json.js";
import type { MemoryStore } from "../storage/store.js";
import { withTransaction } from "../storage/transactions.js";
import type { EvidenceRef, MemoryCandidate, ProjectConfig } from "../types.js";
import { runAutomaticPromotions } from "./automatic-promotion.js";
import { distinctEvidenceSources, mergeEvidence, mergeRelatedFiles } from "./evidence-merge.js";
import {
  applyInvalidation,
  applyPendingInvalidations,
  resolveLive,
  undoInvalidation,
  type InvalidationResult,
  type MemoryRef
} from "./invalidation.js";
import type { MemoryReconciliationProvider } from "./reconciliation-provider.js";
import { compensateMemoryReview, resolveMemoryReview } from "./review.js";

/**
 * One-off backlog consolidation: cluster the live memories cheaply, ask the investigator
 * model which items in each cluster state the same fact (or make another untrue), then
 * merge each group's evidence into one canonical memory and retire the rest. Nothing is
 * deleted; every change is a review or lifecycle row that undo reverses.
 */
export const CONSOLIDATION_POLICY_VERSION = "consolidation-v1";
export const MAX_COMPONENT_SIZE = 24;
const GROUP_MIN_CONFIDENCE = 0.8;
const SHARED_FILE_THRESHOLD = 0.25;
const TEXT_THRESHOLD = 0.45;
/** Terms and files this common do not seed comparisons; they still count toward similarity. */
const MAX_BLOCKING_FREQUENCY = 60;
const REASON_LIMIT = 300;
const SYSTEM_PROMPT =
  "You consolidate a software project's memory records. Each item has a ref, type, status (durable or candidate), title, summary, reason, " +
  "confidence and observedAt (when its evidence was recorded). Group items that state the same fact: the same claim, not merely the same topic. " +
  "Only items of the same type may share a group. Choose the clearest item as canonical; a durable item must be the canonical of its group. " +
  "Separately, report invalidations: an older item whose claim is no longer true because a newer item (by observedAt) shows the behavior changed, " +
  "the decision was reversed, or the bug it describes as present was fixed. Leave out items with no duplicate. " +
  "Respond with strict JSON and nothing else: " +
  "{\"groups\":[{\"canonical\":\"I1\",\"members\":[\"I2\"],\"confidence\":0.9}],\"invalidations\":[{\"older\":\"I3\",\"newer\":\"I4\",\"confidence\":0.9,\"why\":\"one sentence\"}]}. " +
  "Return {\"groups\":[],\"invalidations\":[]} when nothing qualifies.";

interface VersionedRef extends MemoryRef { version: string }

interface GroupPayload { canonical: VersionedRef; members: VersionedRef[]; confidence: number }
interface InvalidationPayload { older: VersionedRef; newer: VersionedRef; confidence: number; why: string }

interface GroupResult {
  /** The candidate row that absorbed the members' evidence, and its state before and after. */
  mergedCandidateId?: string | undefined;
  before?: { evidence: EvidenceRef[]; relatedFiles: string[]; confidence: number } | undefined;
  afterVersion?: string | undefined;
  retired: Array<{ id: string; resolutionId: string }>;
  skippedMembers: number;
}

export interface ConsolidationSummary {
  population: number;
  components: number;
  requests: number;
  failedRequests: number;
  truncated: boolean;
  groups: number;
  membersToRetire: number;
  canonicalsGainingSources: number;
  estimatedPromotions: number;
  invalidations: number;
  skipped: Record<string, number>;
  applied?: {
    groups: number;
    retired: number;
    skipped: Record<string, number>;
    invalidations: Record<string, number>;
    promoted: number;
    superseded: number;
  } | undefined;
  undone?: { groups: number; restored: number; invalidations: number; changedSince: number } | undefined;
}

export interface ConsolidationRun {
  id: string;
  status: "planned" | "applied" | "partial" | "undone";
  provider?: string | undefined;
  model?: string | undefined;
  createdAt: string;
  appliedAt?: string | undefined;
  summary: ConsolidationSummary;
}

export interface PlanConsolidationOptions {
  provider: MemoryReconciliationProvider;
  /** Model requests at most; one per cluster. */
  maxRequests?: number | undefined;
  /** Clusters considered at most, largest first. */
  limit?: number | null | undefined;
  concurrency?: number | undefined;
  /** Confidence an estimated promotion needs; defaults to promotion.confidenceThreshold. */
  confidenceThreshold?: number | undefined;
  now?: (() => Date) | undefined;
  onProgress?: ((done: number, total: number) => void) | undefined;
}

export async function planConsolidation(store: MemoryStore, options: PlanConsolidationOptions): Promise<ConsolidationRun> {
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const corpus = readLiveMemoryCorpus(store);
  const components = buildConsolidationComponents(corpus);
  const limit = options.limit === null ? components.length : Math.min(components.length, options.limit ?? components.length);
  const maxRequests = options.maxRequests ?? 300;
  const selected = components.slice(0, Math.min(limit, maxRequests));
  const summary: ConsolidationSummary = {
    population: corpus.length, components: components.length, requests: 0, failedRequests: 0,
    truncated: selected.length < components.length, groups: 0, membersToRetire: 0,
    canonicalsGainingSources: 0, estimatedPromotions: 0, invalidations: 0, skipped: {}
  };
  const skip = (reason: string) => { summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1; };
  const runId = `consolidation-${randomUUID()}`;
  const createdAt = now();
  store.localDb.prepare(
    "insert into consolidation_runs (id, status, provider, model, created_at, updated_at) values (?, 'planning', ?, ?, ?, ?)"
  ).run(runId, options.provider.provider, options.provider.model, createdAt, createdAt);
  const insertItem = store.localDb.prepare(
    "insert into consolidation_items (run_id, item_id, kind, payload_json, state) values (?, ?, ?, ?, 'planned')"
  );
  const quality = cachedQuality(store);
  const threshold = options.confidenceThreshold ?? 0.85;

  let done = 0;
  const responses = await mapConcurrent(selected, Math.max(1, Math.min(4, options.concurrency ?? 2)), async (component) => {
    const refs = new Map(component.map((item, index) => [`I${index + 1}`, item]));
    try {
      const response = await options.provider.request({
        system: SYSTEM_PROMPT,
        maxTokens: 2048,
        payload: {
          items: [...refs.entries()].map(([ref, item]) => ({
            ref, type: item.target.type, status: item.durable ? "durable" : "candidate", title: item.title,
            summary: item.summary, reason: item.reason.slice(0, REASON_LIMIT), confidence: item.confidence,
            observedAt: observedAt(store, item)
          }))
        }
      });
      return { refs, parsed: parseJsonFromModelText(response.content) as unknown };
    } catch {
      return { refs, parsed: undefined };
    } finally {
      options.onProgress?.(++done, selected.length);
    }
  });

  let itemNumber = 0;
  for (const { refs, parsed } of responses) {
    summary.requests += 1;
    const record = asRecord(parsed);
    if (!record) { summary.failedRequests += 1; continue; }
    const used = new Set<string>();
    for (const rawGroup of Array.isArray(record.groups) ? record.groups : []) {
      const group = validateGroup(asRecord(rawGroup), refs, used);
      if (typeof group === "string") { skip(group); continue; }
      for (const item of [group.canonical, ...group.members]) used.add(item.target.id);
      const payload: GroupPayload = {
        canonical: versioned(group.canonical),
        members: group.members.map(versioned),
        confidence: group.confidence
      };
      insertItem.run(runId, `item-${++itemNumber}`, "group", JSON.stringify(payload));
      summary.groups += 1;
      summary.membersToRetire += group.members.length;
      const evidence = [group.canonical, ...group.members].map((item) => parseEvidence(item.evidenceJson));
      const before = distinctEvidenceSources(evidence[0]!);
      const after = distinctEvidenceSources(evidence.reduce((merged, next) => mergeEvidence(merged, next), [] as EvidenceRef[]));
      if (after > before) summary.canonicalsGainingSources += 1;
      const confidence = Math.max(...[group.canonical, ...group.members].map((item) => item.confidence));
      const status = quality.get(`${group.canonical.target.category}\0${group.canonical.target.id}`);
      if (!group.canonical.durable && after >= 2 && confidence >= threshold && (status === undefined || status === "active")) {
        summary.estimatedPromotions += 1;
      }
    }
    for (const rawInvalidation of Array.isArray(record.invalidations) ? record.invalidations : []) {
      const value = asRecord(rawInvalidation);
      const older = typeof value?.older === "string" ? refs.get(value.older) : undefined;
      const newer = typeof value?.newer === "string" ? refs.get(value.newer) : undefined;
      const confidence = typeof value?.confidence === "number" ? value.confidence : Number.NaN;
      if (!older || !newer || older === newer || !(confidence >= 0 && confidence <= 1)) { skip("invalid_invalidation"); continue; }
      const payload: InvalidationPayload = {
        older: versioned(older), newer: versioned(newer), confidence,
        why: typeof value?.why === "string" ? value.why.trim().slice(0, 500) : ""
      };
      insertItem.run(runId, `item-${++itemNumber}`, "invalidation", JSON.stringify(payload));
      summary.invalidations += 1;
    }
  }
  const finished = now();
  store.localDb.prepare("update consolidation_runs set status = 'planned', summary_json = ?, updated_at = ? where id = ?")
    .run(JSON.stringify(summary), finished, runId);
  return readConsolidationRun(store, runId);
}

/**
 * Applies a planned run. Each group is its own transaction and re-checked against the
 * plan: a member that changed or was withdrawn since is left alone.
 */
export function applyConsolidation(
  store: MemoryStore,
  config: ProjectConfig,
  input: { runId?: string | undefined; now?: (() => Date) | undefined } = {}
): ConsolidationRun {
  const now = () => (input.now?.() ?? new Date()).toISOString();
  const run = input.runId ? readConsolidationRun(store, input.runId) : latestPlannedRun(store);
  if (!run) throw new Error("No planned consolidation run; run code-butler memory consolidate --plan first");
  if (run.status !== "planned" && run.status !== "partial") throw new Error(`Consolidation run ${run.id} is ${run.status}`);
  const applied: NonNullable<ConsolidationSummary["applied"]> = run.summary.applied ?? {
    groups: 0, retired: 0, skipped: {}, invalidations: {}, promoted: 0, superseded: 0
  };
  const skip = (reason: string) => { applied.skipped[reason] = (applied.skipped[reason] ?? 0) + 1; };
  const items = store.localDb.prepare(
    "select item_id, kind, payload_json from consolidation_items where run_id = ? and state = 'planned' order by kind, rowid"
  ).all(run.id) as Array<{ item_id: string; kind: "group" | "invalidation"; payload_json: string }>;
  const markItem = store.localDb.prepare("update consolidation_items set state = ?, result_json = ? where run_id = ? and item_id = ?");
  /** Retired member → the canonical that now holds its fact, for invalidations that name it. */
  const canonicalOf = new Map<string, MemoryRef>();

  for (const item of items.filter((entry) => entry.kind === "group")) {
    const payload = JSON.parse(item.payload_json) as GroupPayload;
    let result: GroupResult | string;
    try {
      result = withTransaction(store.db, () => applyGroup(store, payload, run.id, now()));
    } catch {
      result = "apply_failed";
    }
    if (typeof result === "string") { skip(result); markItem.run("skipped", JSON.stringify({ reason: result }), run.id, item.item_id); continue; }
    applied.groups += 1;
    applied.retired += result.retired.length;
    for (const retired of result.retired) canonicalOf.set(retired.id, payload.canonical);
    markItem.run("applied", JSON.stringify(result), run.id, item.item_id);
  }

  for (const item of items.filter((entry) => entry.kind === "invalidation")) {
    const payload = JSON.parse(item.payload_json) as InvalidationPayload;
    const target = canonicalOf.get(payload.older.id) ?? payload.older;
    const replacement = canonicalOf.get(payload.newer.id) ?? payload.newer;
    let result: InvalidationResult;
    try {
      result = target.id === replacement.id
        ? { outcome: "ignored" }
        : applyInvalidation(store, { target, replacement, confidence: payload.confidence, why: payload.why, source: "consolidation", runId: run.id, now: now() });
    } catch {
      result = { outcome: "unavailable" };
    }
    applied.invalidations[result.outcome] = (applied.invalidations[result.outcome] ?? 0) + 1;
    markItem.run(result.outcome === "ignored" || result.outcome === "unavailable" ? "skipped" : "applied", JSON.stringify(result), run.id, item.item_id);
  }

  // Merged groups are the ones most likely to have just become corroborated.
  try { applied.promoted += runAutomaticPromotions(store, config).promoted; } catch { skip("promotion_pass_failed"); }
  try { applied.superseded += applyPendingInvalidations(store).superseded; } catch { skip("pending_invalidation_pass_failed"); }

  const remaining = (store.localDb.prepare("select count(*) as count from consolidation_items where run_id = ? and state = 'planned'")
    .get(run.id) as { count: number }).count;
  const appliedAt = now();
  store.localDb.prepare("update consolidation_runs set status = ?, applied_at = coalesce(applied_at, ?), summary_json = ?, updated_at = ? where id = ?")
    .run(remaining ? "partial" : "applied", appliedAt, JSON.stringify({ ...run.summary, applied }), appliedAt, run.id);
  return readConsolidationRun(store, run.id);
}

export function undoConsolidation(store: MemoryStore, input: { runId: string; now?: (() => Date) | undefined }): ConsolidationRun {
  const now = () => (input.now?.() ?? new Date()).toISOString();
  const run = readConsolidationRun(store, input.runId);
  if (run.status !== "applied" && run.status !== "partial") throw new Error(`Consolidation run ${run.id} is ${run.status}`);
  const undone = { groups: 0, restored: 0, invalidations: 0, changedSince: 0 };
  const reason = `Consolidation run ${run.id} undone.`;
  const items = store.localDb.prepare(
    "select item_id, kind, result_json from consolidation_items where run_id = ? and state = 'applied' order by rowid desc"
  ).all(run.id) as Array<{ item_id: string; kind: "group" | "invalidation"; result_json: string }>;
  const markItem = store.localDb.prepare("update consolidation_items set state = 'undone' where run_id = ? and item_id = ?");
  // Invalidations were applied after the groups, so they are reverted first.
  for (const item of [...items.filter((entry) => entry.kind === "invalidation"), ...items.filter((entry) => entry.kind === "group")]) {
    const result = JSON.parse(item.result_json) as GroupResult & InvalidationResult;
    withTransaction(store.db, () => {
      if (item.kind === "invalidation") {
        if (undoInvalidation(store, result, reason, now())) undone.invalidations += 1;
        return;
      }
      for (const retired of result.retired) {
        if (!compensateMemoryReview(store, { resolutionId: retired.resolutionId, reason, now: now() }).replayed) undone.restored += 1;
      }
      if (result.mergedCandidateId && result.before) {
        const current = store.readMemoryCandidate(result.mergedCandidateId);
        if (current && current.updatedAt === result.afterVersion) {
          store.upsertMemoryCandidate({ ...plainCandidate(current), ...result.before });
        } else undone.changedSince += 1;
      }
      undone.groups += 1;
    });
    markItem.run(run.id, item.item_id);
  }
  const at = now();
  store.localDb.prepare("update consolidation_runs set status = 'undone', summary_json = ?, updated_at = ? where id = ?")
    .run(JSON.stringify({ ...run.summary, undone }), at, run.id);
  return readConsolidationRun(store, run.id);
}

export function listConsolidationRuns(store: MemoryStore, limit = 20): ConsolidationRun[] {
  const rows = store.localDb.prepare("select id from consolidation_runs order by created_at desc, id desc limit ?").all(limit) as Array<{ id: string }>;
  return rows.map((row) => readConsolidationRun(store, row.id));
}

export function readConsolidationRun(store: MemoryStore, runId: string): ConsolidationRun {
  const row = store.localDb.prepare(
    "select id, status, provider, model, created_at, applied_at, summary_json from consolidation_runs where id = ?"
  ).get(runId) as { id: string; status: ConsolidationRun["status"]; provider: string | null; model: string | null; created_at: string; applied_at: string | null; summary_json: string } | undefined;
  if (!row) throw new Error(`Unknown consolidation run: ${runId}`);
  return {
    id: row.id,
    status: row.status,
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {}),
    createdAt: row.created_at,
    ...(row.applied_at ? { appliedAt: row.applied_at } : {}),
    summary: JSON.parse(row.summary_json) as ConsolidationSummary
  };
}

/**
 * Clusters items that may state the same fact: shared related files plus similar
 * wording, or very similar wording alone, by IDF-weighted Jaccard over title and
 * summary terms. Oversized clusters are re-split at stricter thresholds, then chunked.
 */
export function buildConsolidationComponents(items: LiveMemoryItem[], maxSize = MAX_COMPONENT_SIZE): LiveMemoryItem[][] {
  const termFrequency = new Map<string, number>();
  for (const item of items) for (const term of item.terms) termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
  const idf = (term: string) => Math.log(1 + items.length / (termFrequency.get(term) ?? 1));
  const components = link(items, idf, 0).filter((component) => component.length > 1);
  const sized = components.flatMap((component) => split(component, idf, maxSize, 1));
  return sized
    .filter((component) => component.length > 1)
    .sort((left, right) => right.length - left.length || left[0]!.target.id.localeCompare(right[0]!.target.id));
}

function split(component: LiveMemoryItem[], idf: (term: string) => number, maxSize: number, step: number): LiveMemoryItem[][] {
  if (component.length <= maxSize) return [component];
  if (step <= 4) return link(component, idf, step * 0.1).flatMap((part) => split(part, idf, maxSize, step + 1));
  const ordered = [...component].sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.target.id.localeCompare(right.target.id));
  const chunks: LiveMemoryItem[][] = [];
  for (let offset = 0; offset < ordered.length; offset += maxSize) chunks.push(ordered.slice(offset, offset + maxSize));
  return chunks;
}

function link(items: LiveMemoryItem[], idf: (term: string) => number, raise: number): LiveMemoryItem[][] {
  const parent = items.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) { parent[index] = parent[parent[index]!]!; index = parent[index]!; }
    return index;
  };
  const byKey = new Map<string, number[]>();
  for (const [index, item] of items.entries()) {
    for (const key of [...[...item.terms].map((term) => `t:${term}`), ...item.files.map((file) => `f:${file}`)]) {
      const bucket = byKey.get(key) ?? [];
      bucket.push(index);
      byKey.set(key, bucket);
    }
  }
  const compared = new Set<string>();
  for (const bucket of byKey.values()) {
    if (bucket.length < 2 || bucket.length > MAX_BLOCKING_FREQUENCY) continue;
    for (let left = 0; left < bucket.length; left += 1) {
      for (let right = left + 1; right < bucket.length; right += 1) {
        const a = bucket[left]!, b = bucket[right]!;
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        if (compared.has(key)) continue;
        compared.add(key);
        const first = items[a]!, second = items[b]!;
        const similarity = weightedJaccard(first.terms, second.terms, idf);
        const sharesFile = first.files.some((file) => second.files.includes(file));
        if ((sharesFile && similarity >= SHARED_FILE_THRESHOLD + raise) || similarity >= TEXT_THRESHOLD + raise) parent[find(a)] = find(b);
      }
    }
  }
  const groups = new Map<number, LiveMemoryItem[]>();
  for (const [index, item] of items.entries()) {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(item);
    groups.set(root, group);
  }
  return [...groups.values()];
}

function weightedJaccard(left: Set<string>, right: Set<string>, idf: (term: string) => number): number {
  let shared = 0, union = 0;
  for (const term of new Set([...left, ...right])) {
    const weight = idf(term);
    union += weight;
    if (left.has(term) && right.has(term)) shared += weight;
  }
  return union === 0 ? 0 : shared / union;
}

function validateGroup(
  record: Record<string, unknown> | undefined,
  refs: Map<string, LiveMemoryItem>,
  used: Set<string>
): { canonical: LiveMemoryItem; members: LiveMemoryItem[]; confidence: number } | string {
  let canonical = typeof record?.canonical === "string" ? refs.get(record.canonical) : undefined;
  const confidence = typeof record?.confidence === "number" ? record.confidence : Number.NaN;
  if (!canonical) return "invalid_group";
  if (!(confidence >= GROUP_MIN_CONFIDENCE && confidence <= 1)) return "low_confidence_group";
  const named = (Array.isArray(record?.members) ? record.members : [])
    .map((ref) => typeof ref === "string" ? refs.get(ref) : undefined)
    .filter((item): item is LiveMemoryItem => item !== undefined);
  const all = [...new Set([canonical, ...named])].filter((item) => item.target.type === canonical!.target.type && !used.has(item.target.id));
  const durables = all.filter((item) => item.durable);
  if (durables.length > 1) return "two_durables";
  // A durable fact is the one to keep; a candidate never absorbs it.
  if (durables[0]) canonical = durables[0];
  if (!all.includes(canonical)) return "invalid_group";
  const members = all.filter((item) => item !== canonical);
  return members.length ? { canonical, members, confidence } : "no_members";
}

function applyGroup(store: MemoryStore, payload: GroupPayload, runId: string, now: string): GroupResult | string {
  const canonical = resolveLive(store, payload.canonical);
  if (!canonical) return "canonical_withdrawn";
  const members = payload.members.map((member) => ({ member, live: store.readMemoryCandidate(member.id) }));
  const usable = members.filter(({ member, live }) =>
    live !== undefined && live.promotionState === "candidate" && live.updatedAt === member.version && resolveLive(store, member) !== undefined
  ).map(({ live }) => live!);
  if (usable.length === 0) return "members_changed";

  // The candidate row that holds the canonical fact; a durable canonical merges into its source candidate.
  const holderId = canonical.category === "candidate"
    ? canonical.memory.id
    : identityHolder(store, canonical.memory.id);
  const result: GroupResult = { retired: [], skippedMembers: members.length - usable.length };
  if (holderId) {
    const holder = store.readMemoryCandidate(holderId);
    if (holder) {
      result.before = { evidence: holder.evidence, relatedFiles: holder.relatedFiles, confidence: holder.confidence };
      const merged = store.mergeExtractedMemoryCandidate({
        ...plainCandidate(holder),
        evidence: usable.reduce((evidence, member) => mergeEvidence(evidence, member.evidence, Infinity), [] as EvidenceRef[]),
        relatedFiles: usable.reduce((files, member) => mergeRelatedFiles(files, member.relatedFiles, Infinity), [] as string[]),
        confidence: Math.max(...usable.map((member) => member.confidence))
      });
      if (merged.outcome === "merged") {
        result.mergedCandidateId = holder.id;
        result.afterVersion = merged.candidate.updatedAt;
      } else result.before = undefined;
    }
  }
  for (const member of usable) {
    const review = resolveMemoryReview(store, {
      memoryId: member.id,
      category: "candidate",
      action: "discard",
      reason: `Duplicate of ${canonical.memory.id} (consolidation run ${runId}).`,
      now
    }, "system");
    result.retired.push({ id: member.id, resolutionId: review.review.id });
  }
  return result;
}

/** The candidate a durable memory was promoted from, which carries its evidence forward. */
function identityHolder(store: MemoryStore, durableId: string): string | undefined {
  const row = store.db.prepare("select id from memory_candidates where promoted_memory_id = ? order by updated_at desc limit 1")
    .get(durableId) as { id: string } | undefined;
  return row?.id;
}

/** The stored fields of a candidate, as the store's write paths accept them. */
function plainCandidate(candidate: MemoryCandidate) {
  return {
    type: candidate.type,
    title: candidate.title,
    summary: candidate.summary,
    ...(candidate.statement ? { statement: candidate.statement } : {}),
    reason: candidate.reason,
    confidence: candidate.confidence,
    evidence: candidate.evidence,
    relatedFiles: candidate.relatedFiles,
    dedupeKey: candidate.dedupeKey,
    ...(candidate.scope ? { scope: candidate.scope } : {}),
    ...(candidate.layer ? { layer: candidate.layer } : {}),
    ...(candidate.origin ? { origin: candidate.origin } : {})
  };
}

function versioned(item: LiveMemoryItem): VersionedRef {
  return { category: item.target.category, id: item.target.id, version: item.version };
}

function latestPlannedRun(store: MemoryStore): ConsolidationRun | undefined {
  const row = store.localDb.prepare(
    "select id from consolidation_runs where status in ('planned', 'partial') order by created_at desc, id desc limit 1"
  ).get() as { id: string } | undefined;
  return row ? readConsolidationRun(store, row.id) : undefined;
}

function cachedQuality(store: MemoryStore): Map<string, string> {
  const rows = store.localDb.prepare("select category, memory_id, quality_status from memory_quality_cache").all() as Array<{ category: string; memory_id: string; quality_status: string }>;
  return new Map(rows.map((row) => [`${row.category}\0${row.memory_id}`, row.quality_status]));
}

function parseEvidence(value: string): EvidenceRef[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as EvidenceRef[] : [];
  } catch {
    return [];
  }
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  }));
  return results;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
