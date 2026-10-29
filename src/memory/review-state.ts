import { createHash } from "node:crypto";
import { cachedRead } from "../retrieval/read-cache.js";
import { prepareCached } from "../storage/statements.js";
import { fileCommits, latestRelevantCommit } from "./related-change.js";

import type { MemoryStore } from "../storage/store.js";
import type {
  CommitRecord,
  DurableMemory,
  EvidenceRef,
  MemoryCandidate,
  MemoryConfidenceBasis,
  MemoryReviewAction,
  MemoryReviewSummary,
  MemoryTrustDisplayStatus,
  OperationActor
} from "../types.js";

function evidenceVersion(store:MemoryStore,evidence:EvidenceRef):string {
  return cachedRead(store,`evidence-version:${JSON.stringify(evidence)}`,()=>{
    const value=evidence.sourceType==="commit" ? store.readCommit(evidence.sourceId) : {
      source:store.readSourceMetadata(evidence.sourceId),
      chunk:evidence.locator ? store.readConversationWindow(evidence.sourceId,evidence.locator,0,0)[0] : undefined,
      decision:evidence.sourceType==="decision" ? store.readSource(evidence.sourceId)?.rawContent : undefined
    };
    return createHash("sha256").update(JSON.stringify(value) ?? "missing").digest("hex");
  });
}

export type MemoryReviewCategory = "candidate" | "promoted";
export type ReviewableMemory = MemoryCandidate | DurableMemory;

interface MemoryReviewRow {
  id: string;
  memory_id: string;
  category: MemoryReviewCategory;
  layer: string;
  memory_version: string;
  context_fingerprint: string;
  action: MemoryReviewAction;
  resolved_reasons_json: string;
  reason: string;
  reviewed_at: string;
  actor: OperationActor;
  replacement_memory_id: string | null;
  replacement_category: MemoryReviewCategory | null;
  verdict: import("../types.js").MemoryReconciliationVerdict | null;
  policy_version: string | null;
  provider: string | null;
  model: string | null;
  confidence: number | null;
  citation_ids_json: string;
  reconciliation_run_id: string | null;
  reconciliation_item_id: string | null;
}

const REVIEW_COLUMNS = `
  r.id, r.memory_id, r.category, r.layer, r.memory_version, r.context_fingerprint, r.action,
  r.resolved_reasons_json, r.reason, r.reviewed_at, r.actor,
  r.replacement_memory_id, r.replacement_category,
  r.verdict, r.policy_version, r.provider, r.model, r.confidence, r.citation_ids_json,
  r.reconciliation_run_id, r.reconciliation_item_id`;

export interface MemoryReviewContext {
  memoryVersion: string;
  reviewToken: string;
  /**
   * reviewToken plus the tokens earlier fingerprint rules gave this same context: before
   * evidence content was included, and before related files counted only relevant commits.
   */
  acceptedTokens: string[];
}

export function acceptsReviewToken(context: MemoryReviewContext, token: string): boolean {
  return context.acceptedTokens.includes(token);
}

export function createMemoryReviewContext(
  store: MemoryStore,
  category: MemoryReviewCategory,
  memory: ReviewableMemory
): MemoryReviewContext {
  const memoryVersion = category === "candidate"
    ? (memory as MemoryCandidate).updatedAt
    : (memory as DurableMemory).lifecycleGeneration;
  const evidenceState = memory.evidence
    .map((evidence) => ({ ...evidence, resolved: evidenceExists(store, evidence), version: evidenceVersion(store,evidence) }))
    .sort((left, right) => evidenceKey(left).localeCompare(evidenceKey(right)));
  const relatedFiles = [...new Set(memory.relatedFiles)].sort();
  const commitState = (commit: CommitRecord | undefined) => commit ? { hash: commit.hash, authoredAt: commit.authoredAt } : null;
  // A commit that changes nothing the memory names leaves its review current.
  const relatedFileState = relatedFiles.map((filePath) => ({ filePath, latestCommit: commitState(latestRelevantCommit(store, memory, filePath)) }));
  const anyCommitFileState = relatedFiles.map((filePath) => ({ filePath, latestCommit: commitState(fileCommits(store, filePath)[0]) }));
  const conflicts = [
    ...store.listMemoryRelations({ fromMemoryId: memory.id, relationType: "potentially_contradicts" }),
    ...store.listMemoryRelations({ toMemoryId: memory.id, relationType: "potentially_contradicts" })
  ]
    .map((relation) => ({
      id: relation.id,
      fromMemoryId: relation.fromMemoryId,
      toMemoryId: relation.toMemoryId,
      createdAt: relation.createdAt
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const payload = {
    category,
    memoryVersion,
    memory: {
      id: memory.id,
      type: memory.type,
      title: memory.title,
      summary: memory.summary,
      ...(memory.statement ? { statement: memory.statement } : {}),
      reason: memory.reason,
      scope: memory.scope ?? { kind: "unspecified" },
      layer: memory.layer ?? "core",
      confidence: memory.confidence,
      evidence: memory.evidence,
      relatedFiles: memory.relatedFiles,
      dedupeKey: memory.dedupeKey
    },
    evidenceState,
    relatedFileState,
    conflicts
  };
  const token = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const reviewToken = token(payload);
  const anyCommitPayload = { ...payload, relatedFileState: anyCommitFileState };
  return {
    memoryVersion,
    reviewToken,
    acceptedTokens: [...new Set([
      reviewToken,
      token(anyCommitPayload),
      token({ ...anyCommitPayload, evidenceState: evidenceState.map(({ version: _version, ...evidence }) => evidence) })
    ])]
  };
}

export function currentMemoryReview(
  store: MemoryStore,
  category: MemoryReviewCategory,
  memory: ReviewableMemory,
  providedContext?: MemoryReviewContext
): MemoryReviewSummary | undefined {
  const latest = readLatestReview(store, memory.id, category);
  if (!latest) return undefined;
  const context = providedContext ?? createMemoryReviewContext(store, category, memory);
  const current = latest.action === "verify"
    ? latest.memory_version === context.memoryVersion && acceptsReviewToken(context, latest.context_fingerprint)
    : true;
  return reviewSummary(latest, current);
}

export function effectiveTerminalMemoryReview(
  store: MemoryStore,
  category: MemoryReviewCategory,
  memory: Pick<ReviewableMemory, "id">
): MemoryReviewSummary | undefined {
  const row = prepareCached(store.db,
    `select ${REVIEW_COLUMNS}
       from memory_review_resolutions r
      where r.memory_id = ? and r.category = ?
        and r.action in ('correct', 'discard')
        and not exists (
          select 1 from memory_review_resolution_compensations c where c.resolution_id = r.id
        )
      order by r.reviewed_at desc, r.rowid desc
      limit 1`
  ).get(memory.id, category) as MemoryReviewRow | undefined;
  return row ? reviewSummary(row, true) : undefined;
}

export function matchingMemoryVerification(
  store: MemoryStore,
  category: MemoryReviewCategory,
  memory: ReviewableMemory,
  providedContext?: MemoryReviewContext
): MemoryReviewSummary | undefined {
  const context = providedContext ?? createMemoryReviewContext(store, category, memory);
  const row = prepareCached(store.db,
    `select ${REVIEW_COLUMNS}
       from memory_review_resolutions r
      where memory_id = ? and category = ? and memory_version = ? and context_fingerprint in (${placeholders(context.acceptedTokens)})
        and not exists (select 1 from memory_review_resolution_compensations c where c.resolution_id = r.id)
      order by reviewed_at desc, rowid desc
      limit 1`
  ).get(memory.id, category, context.memoryVersion, ...context.acceptedTokens) as MemoryReviewRow | undefined;
  if (!row || row.action !== "verify") return undefined;
  return reviewSummary(row, true);
}

/**
 * A durable memory made from a candidate starts without reviews of its own, so the
 * candidate's verification would otherwise be asked for again. It carries over when the
 * candidate's latest review is that verification, the durable memory states the same
 * claim, and the candidate's context, rebuilt at the version and layer it was verified
 * at, still gives the verified token: nothing it was checked against has changed since.
 */
export function inheritedCandidateVerification(store: MemoryStore, memory: DurableMemory): MemoryReviewSummary | undefined {
  const candidateIds = prepareCached(store.db, "select id from memory_candidates where promoted_memory_id = ? order by updated_at desc")
    .all(memory.id) as Array<{ id: string }>;
  for (const { id } of candidateIds) {
    const candidate = store.readMemoryCandidate(id);
    if (!candidate || !sameClaim(candidate, memory)) continue;
    const row = readLatestReview(store, id, "candidate");
    if (row?.action !== "verify") continue;
    const context = createMemoryReviewContext(store, "candidate", { ...candidate, updatedAt: row.memory_version, layer: row.layer });
    if (acceptsReviewToken(context, row.context_fingerprint)) return reviewSummary(row, true);
  }
  return undefined;
}

function sameClaim(candidate: MemoryCandidate, memory: DurableMemory): boolean {
  const claim = (value: ReviewableMemory) => JSON.stringify({
    type: value.type, title: value.title, summary: value.summary, reason: value.reason,
    statement: value.statement ?? null, relatedFiles: [...new Set(value.relatedFiles)].sort()
  });
  return claim(candidate) === claim(memory);
}

export function readExactMemoryReview(
  store: MemoryStore,
  input: {
    memoryId: string;
    category: MemoryReviewCategory;
    memoryVersion: string;
    reviewToken: string;
    action: MemoryReviewAction;
  }
): MemoryReviewSummary | undefined {
  const row = prepareCached(store.db,
    `select ${REVIEW_COLUMNS}
       from memory_review_resolutions r
      where memory_id = ? and category = ? and memory_version = ? and context_fingerprint = ? and action = ?
        and not exists (select 1 from memory_review_resolution_compensations c where c.resolution_id = r.id)
      order by reviewed_at desc, rowid desc
      limit 1`
  ).get(input.memoryId, input.category, input.memoryVersion, input.reviewToken, input.action) as MemoryReviewRow | undefined;
  return row ? reviewSummary(row, true) : undefined;
}

export function findMemoryReviewByToken(
  store: MemoryStore,
  input: {
    memoryId: string;
    category: MemoryReviewCategory;
    reviewToken: string;
    action: MemoryReviewAction;
  }
): MemoryReviewSummary | undefined {
  const row = prepareCached(store.db,
    `select ${REVIEW_COLUMNS}
       from memory_review_resolutions r
      where memory_id = ? and category = ? and context_fingerprint = ? and action = ?
        and not exists (select 1 from memory_review_resolution_compensations c where c.resolution_id = r.id)
      order by reviewed_at desc, rowid desc
      limit 1`
  ).get(input.memoryId, input.category, input.reviewToken, input.action) as MemoryReviewRow | undefined;
  return row ? reviewSummary(row, true) : undefined;
}

export function confidenceBasis(memory: Pick<ReviewableMemory, "dedupeKey" | "origin"> & Partial<Pick<DurableMemory, "source">>): MemoryConfidenceBasis {
  if (memory.source === "manual" || memory.origin?.method === "manual" || memory.dedupeKey.startsWith("manual-memory:")) return "manual";
  if (memory.dedupeKey.startsWith("deterministic:conversation:")) return "explicit_directive";
  if (memory.dedupeKey.startsWith("deterministic:decision-file:")) return "decision_file";
  if (memory.dedupeKey.startsWith("deterministic:test:")) return "test_expectation";
  if (memory.dedupeKey.startsWith("deterministic:config:")) return "legacy_config_key";
  if (memory.dedupeKey.startsWith("deterministic:docs:")) return "legacy_docs_heading";
  if (memory.origin?.method === "llm") return "model_extraction";
  return "unknown";
}

export function trustDisplayStatus(
  store: MemoryStore,
  category: MemoryReviewCategory,
  memory: ReviewableMemory
): MemoryTrustDisplayStatus {
  if (memory.qualityStatus === "quarantined") return "quarantined";
  if (memory.qualityStatus === "needs_review") return "needs_review";
  if (matchingMemoryVerificationByActor(store, category, memory, ["cli", "mcp", "desktop"])) {
    return "human_verified";
  }
  if (matchingMemoryVerificationByActor(store, category, memory, ["ai"])) return "ai_validated";
  const latest = currentMemoryReview(store, category, memory);
  if (latest?.action === "verify" && !latest.current) return "needs_review";
  return "evidence_backed";
}

function readLatestReview(
  store: MemoryStore,
  memoryId: string,
  category: MemoryReviewCategory
): MemoryReviewRow | undefined {
  return prepareCached(store.db,
    `select ${REVIEW_COLUMNS}
       from memory_review_resolutions r
      where memory_id = ? and category = ?
        and not exists (select 1 from memory_review_resolution_compensations c where c.resolution_id = r.id)
      order by reviewed_at desc, rowid desc
      limit 1`
  ).get(memoryId, category) as MemoryReviewRow | undefined;
}

function reviewSummary(row: MemoryReviewRow, current: boolean): MemoryReviewSummary {
  const summary: MemoryReviewSummary = {
    id: row.id,
    action: row.action,
    reason: row.reason,
    reviewedAt: row.reviewed_at,
    actor: row.actor,
    resolvedReasons: parseStringArray(row.resolved_reasons_json),
    current
  };
  if (row.replacement_memory_id !== null) summary.replacementMemoryId = row.replacement_memory_id;
  if (row.replacement_category !== null) summary.replacementCategory = row.replacement_category;
  if (row.verdict !== null) summary.verdict = row.verdict;
  if (row.policy_version !== null) summary.policyVersion = row.policy_version;
  if (row.provider !== null) summary.provider = row.provider;
  if (row.model !== null) summary.model = row.model;
  if (row.confidence !== null) summary.confidence = row.confidence;
  const citations = parseStringArray(row.citation_ids_json);
  if (citations.length > 0) summary.citationIds = citations;
  if (row.reconciliation_run_id !== null) summary.reconciliationRunId = row.reconciliation_run_id;
  if (row.reconciliation_item_id !== null) summary.reconciliationItemId = row.reconciliation_item_id;
  return summary;
}

function matchingMemoryVerificationByActor(
  store: MemoryStore,
  category: MemoryReviewCategory,
  memory: ReviewableMemory,
  actors: OperationActor[]
): MemoryReviewSummary | undefined {
  const context = createMemoryReviewContext(store, category, memory);
  const row = prepareCached(store.db,
    `select ${REVIEW_COLUMNS}
       from memory_review_resolutions r
      where r.memory_id = ? and r.category = ? and r.memory_version = ? and r.context_fingerprint in (${placeholders(context.acceptedTokens)})
        and r.action = 'verify' and r.actor in (${placeholders(actors)})
        and not exists (select 1 from memory_review_resolution_compensations c where c.resolution_id = r.id)
      order by r.reviewed_at desc, r.rowid desc limit 1`
  ).get(memory.id, category, context.memoryVersion, ...context.acceptedTokens, ...actors) as MemoryReviewRow | undefined;
  return row ? reviewSummary(row, true) : undefined;
}

function evidenceExists(store: MemoryStore, evidence: EvidenceRef): boolean {
  if (evidence.sourceType === "commit") return store.readCommit(evidence.sourceId) !== undefined;
  if (evidence.sourceType === "conversation") {
    if (evidence.locator === undefined) return false;
    if (store.readSourceMetadata(evidence.sourceId)?.type !== "conversation") return false;
    return store.readConversationWindow(evidence.sourceId, evidence.locator, 0, 0).length === 1;
  }
  return store.readSourceMetadata(evidence.sourceId) !== undefined;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function evidenceKey(evidence: EvidenceRef & { resolved: boolean }): string {
  return `${evidence.sourceType}\0${evidence.sourceId}\0${evidence.locator ?? ""}\0${evidence.resolved ? "1" : "0"}`;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
