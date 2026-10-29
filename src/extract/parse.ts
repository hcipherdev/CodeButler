import { createStatement, parseStatement } from "../memory/statement.js";
import { normalizeScope } from "../memory/scope.js";
import type { EvidenceRef, ExtractorContext, ExtractorMemory, ExtractorResult, MemoryType } from "../types.js";
import { memoryRecordProblem } from "./context.js";
import { withInferredEvidenceTypes } from "./prompt.js";

export const VALID_MEMORY_TYPES: MemoryType[] = ["decision", "bug_fix", "constraint", "rejected_approach"];

/** Validates one model response against the batch it answered; shared by every extractor provider. */
export function readExtractedMemories(payload: unknown, context: ExtractorContext): ExtractorResult {
  const record = asRecord(payload);
  const memories = record?.memories;
  if (!Array.isArray(memories)) {
    throw new Error("Invalid extractor response");
  }
  const contextOnly = contextOnlyChunkIds(context);
  const extracted: ExtractorMemory[] = [];
  const rejected: ExtractorResult["rejected"] = [];
  for (const [index, raw] of memories.entries()) {
    const value = withInferredEvidenceTypes(raw, context);
    const evidenceReason = invalidConversationEvidenceReason(value, context);
    if (evidenceReason) {
      rejected.push({ index, reason: evidenceReason });
      continue;
    }
    let memory: ExtractorMemory | undefined;
    try { memory = parseMemory(value); } catch { memory = undefined; }
    if (!memory) {
      rejected.push({ index, reason: "invalid_memory_record", detail: memoryRecordProblem(asRecord(value), VALID_MEMORY_TYPES) });
      continue;
    }
    // A bug_fix without its fix reads as a live bug long after it was fixed.
    if (memory.type === "bug_fix" && !memory.statement?.fields.fix) {
      rejected.push({ index, reason: "bug_fix_without_fix" });
      continue;
    }
    if (restsOnContextOnly(memory.evidence, contextOnly)) {
      rejected.push({ index, reason: "context_only_evidence" });
      continue;
    }
    extracted.push(memory);
  }
  return { memories: extracted, rejected };
}

const EXISTING_REF = /^E\d{1,4}$/;

function parseMemory(value: unknown): ExtractorMemory | undefined {
  const record = asRecord(value);
  const type = typeof record?.type === "string" ? (record.type as MemoryType) : undefined;
  const title = typeof record?.title === "string" ? record.title.trim() : "";
  const summary = typeof record?.summary === "string" ? record.summary.trim() : "";
  const reason = typeof record?.reason === "string" ? record.reason.trim() : "";
  const confidence = typeof record?.confidence === "number" ? record.confidence : Number.NaN;
  const dedupeKey = typeof record?.dedupeKey === "string" ? record.dedupeKey.trim() : "";
  const relatedFiles = Array.isArray(record?.relatedFiles)
    ? record.relatedFiles.filter((item): item is string => typeof item === "string")
    : [];
  const evidence = Array.isArray(record?.evidence) ? record.evidence.filter(isEvidenceRef) : [];

  if (
    !type ||
    !VALID_MEMORY_TYPES.includes(type) ||
    !title ||
    !summary ||
    !reason ||
    !dedupeKey ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    evidence.length === 0
  ) {
    return undefined;
  }

  const statement = parseStatement(record?.statement, type, "extracted") ?? createStatement(summary, type, "extracted");
  const sameAs = typeof record?.sameAs === "string" && EXISTING_REF.test(record.sameAs.trim()) ? record.sameAs.trim() : undefined;
  const invalidates = parseInvalidates(record?.invalidates);
  return {
    ...(sameAs === undefined ? {} : { sameAs }),
    ...(invalidates === undefined ? {} : { invalidates }),
    scope: normalizeScope(record?.scope),
    type,
    title,
    summary: statement.text,
    statement,
    reason,
    confidence,
    evidence,
    relatedFiles,
    dedupeKey
  };
}

/** A malformed reference is dropped rather than failing the memory it is attached to. */
function parseInvalidates(value: unknown): ExtractorMemory["invalidates"] {
  const record = asRecord(value);
  const ref = typeof record?.ref === "string" ? record.ref.trim() : "";
  const confidence = typeof record?.confidence === "number" ? record.confidence : Number.NaN;
  if (!EXISTING_REF.test(ref) || !(confidence >= 0 && confidence <= 1)) return undefined;
  return { ref, confidence, why: typeof record?.why === "string" ? record.why.trim().slice(0, 500) : "" };
}

function isEvidenceRef(value: unknown): value is EvidenceRef {
  const record = asRecord(value);
  return (
    (record?.sourceType === "conversation" || record?.sourceType === "commit" || record?.sourceType === "decision") &&
    typeof record.sourceId === "string" &&
    (record.locator === undefined || typeof record.locator === "string")
  );
}

function chunkId(conversation: ExtractorContext["conversations"][number], chunk: NonNullable<ExtractorContext["conversations"][number]["chunks"]>[number], index: number): string {
  return chunk.id ?? `${conversation.sourceId}:chunk:${chunk.chunkIndex ?? index}`;
}

function invalidConversationEvidenceReason(value: unknown, context: ExtractorContext): string | undefined {
  const evidence = asRecord(value)?.evidence;
  if (!Array.isArray(evidence)) return undefined;
  const allowed = new Set(context.conversations.flatMap((conversation) =>
    (conversation.chunks ?? []).map((chunk, index) => chunkId(conversation, chunk, index))
  ));
  for (const item of evidence) {
    const record = asRecord(item);
    if (record?.sourceType !== "conversation") continue;
    if (typeof record.locator !== "string" || !record.locator) {
      return "conversation_evidence_requires_exact_chunk_locator";
    }
    if (typeof record.sourceId !== "string" || !allowed.has(record.locator) || !record.locator.startsWith(`${record.sourceId}:chunk:`)) {
      return "invalid_conversation_evidence_locator";
    }
  }
  return undefined;
}

function contextOnlyChunkIds(context: ExtractorContext): Set<string> {
  return new Set(context.conversations.flatMap((conversation) =>
    (conversation.chunks ?? []).flatMap((chunk, index) => chunk.contextOnly ? [chunkId(conversation, chunk, index)] : [])
  ));
}

/** Context messages were extracted on an earlier pass; a memory needs something new behind it. */
function restsOnContextOnly(evidence: readonly EvidenceRef[], contextOnly: ReadonlySet<string>): boolean {
  if (contextOnly.size === 0 || evidence.some((reference) => reference.sourceType !== "conversation")) return false;
  return evidence.every((reference) => reference.locator !== undefined && contextOnly.has(reference.locator));
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
