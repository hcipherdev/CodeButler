import type { ExtractorContext, ExtractorConversationInput } from "../types.js";

// Leave generous room below the 200k-token provider limit even for token-dense
// text, plus the system prompt and generated response. No tokenizer is required.
export const MAX_EXTRACTION_INPUT_BYTES = 128 * 1024;

export const DEFAULT_EXTRACTION_OUTPUT_TOKENS = 8192;

/** Names the first required field a model's memory record lacks, so a rejection says what to fix. */
export function memoryRecordProblem(record: Record<string, unknown> | undefined, validTypes: readonly string[]): string {
  if (!record) return "not_an_object";
  if (typeof record.type !== "string" || !validTypes.includes(record.type)) return `invalid_type:${String(record.type).slice(0, 40)}`;
  for (const field of ["title", "summary", "reason", "dedupeKey"])
    if (typeof record[field] !== "string" || !String(record[field]).trim()) return `missing_${field}`;
  if (typeof record.confidence !== "number" || !(record.confidence >= 0 && record.confidence <= 1)) return "invalid_confidence";
  if (!Array.isArray(record.evidence) || record.evidence.length === 0) return "missing_evidence";
  for (const item of record.evidence as unknown[]) {
    const ref = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
    if (!ref) return "invalid_evidence_reference:not_an_object";
    if (!["conversation", "commit", "decision"].includes(String(ref.sourceType))) return `invalid_evidence_reference:sourceType=${String(ref.sourceType).slice(0, 30)}`;
    if (typeof ref.sourceId !== "string") return `invalid_evidence_reference:sourceId=${typeof ref.sourceId}`;
    if (ref.locator !== undefined && typeof ref.locator !== "string") return `invalid_evidence_reference:locator=${ref.locator === null ? "null" : typeof ref.locator}`;
  }
  return "invalid_evidence_reference";
}

export function extractionOutputGuidance(maxTokens: number): string {
  const maxMemories = Math.max(1, Math.min(8, Math.floor(maxTokens / 768)));
  return ` Return at most ${maxMemories} strongest durable memories. ` +
    "Each memory requires type (decision, bug_fix, constraint, or rejected_approach), title, summary, reason, " +
    "confidence (0 to 1), dedupeKey, relatedFiles, and evidence. " +
    "Keep fields concise, evidence to at most 3 references, and relatedFiles to at most 5 paths. " +
    "Preserve applicability qualifiers. Finish the complete JSON object within the output budget.";
}

export function extractionBatches(context: ExtractorContext): ExtractorContext[] {
  return splitContext({
    conversations: context.conversations.map(sanitizeConversation),
    commits: context.commits
  });
}

function splitContext(context: ExtractorContext): ExtractorContext[] {
  if (Buffer.byteLength(JSON.stringify(context), "utf8") <= MAX_EXTRACTION_INPUT_BYTES) return [context];

  if (context.conversations.length + context.commits.length > 1) {
    const units: ExtractorContext[] = [
      ...context.conversations.map(conversation => ({ conversations: [conversation], commits: [] })),
      ...context.commits.map(commit => ({ conversations: [], commits: [commit] }))
    ];
    const midpoint = Math.ceil(units.length / 2);
    const combine = (items: ExtractorContext[]): ExtractorContext => ({
      conversations: items.flatMap(item => item.conversations),
      commits: items.flatMap(item => item.commits)
    });
    return [...splitContext(combine(units.slice(0, midpoint))), ...splitContext(combine(units.slice(midpoint)))];
  }

  const conversation = context.conversations[0];
  if (conversation) {
    const chunks = conversation.chunks ?? [];
    if (chunks.length > 1) {
      const midpoint = Math.ceil(chunks.length / 2);
      return [chunks.slice(0, midpoint), chunks.slice(midpoint)].flatMap(part =>
        splitContext({ conversations: [{ ...conversation, chunks: part }], commits: [] }));
    }
    if (chunks[0]) {
      return splitText(chunks[0].text).flatMap(text => splitContext({
        conversations: [{ ...conversation, chunks: [{ ...chunks[0]!, text }] }], commits: []
      }));
    }
    return splitText(conversation.rawContent).flatMap(rawContent =>
      splitContext({ conversations: [{ ...conversation, rawContent }], commits: [] }));
  }

  const commit = context.commits[0];
  if (commit) {
    const field = commit.diffSummary.length >= commit.message.length ? "diffSummary" : "message";
    return splitText(commit[field]).flatMap(text =>
      splitContext({ conversations: [], commits: [{ ...commit, [field]: text }] }));
  }
  throw new Error("Extraction metadata exceeds the request size limit");
}

function splitText(text: string): [string, string] {
  let midpoint = Math.floor(text.length / 2);
  // Keep surrogate pairs together so split evidence preserves its original text.
  if (midpoint > 0 && /[\uD800-\uDBFF]/.test(text[midpoint - 1]!)) midpoint -= 1;
  if (midpoint === 0) throw new Error("Extraction metadata exceeds the request size limit");
  return [text.slice(0, midpoint), text.slice(midpoint)];
}

function sanitizeConversation(conversation: ExtractorConversationInput): ExtractorConversationInput {
  const chunks = conversation.chunks
    ?.map((chunk, index) => ({
      ...chunk,
      id: chunk.id ?? `${conversation.sourceId}:chunk:${chunk.chunkIndex ?? index}`,
      sourceId: conversation.sourceId
    }))
    .filter(chunk => !isLowSignalText(chunk.text));
  return {
    ...conversation,
    // Indexed chunks already contain the transcript. Send its text only once.
    rawContent: conversation.chunks?.length || isLowSignalText(conversation.rawContent) ? "" : conversation.rawContent,
    ...(chunks === undefined ? {} : { chunks })
  };
}

function isLowSignalText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const tagMatches = trimmed.match(/<\/?[a-z][^>]*>/gi) ?? [];
  if (tagMatches.length >= 4) return true;
  if (/^```/.test(trimmed)) return true;
  if (/^\{[\s\S]*"[^"]+"\s*:/.test(trimmed)) return true;
  const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.filter(line => /^[+-]\s*\S/.test(line)).length >= 4;
}
