import {
  anthropicAwsRequestConfig,
  readAnthropicAwsText,
  runAnthropicAwsMessage,
  type AnthropicAwsHttpClient
} from "../providers/anthropic-aws.js";
import { parseJsonFromModelText } from "../json.js";
import type {
  EvidenceRef,
  ExtractedMemory,
  ExtractorConfig,
  ExtractorContext,
  ExtractorProvider,
  ExtractorResult,
  MemoryType
} from "../types.js";

const VALID_MEMORY_TYPES: MemoryType[] = ["decision", "bug_fix", "constraint", "rejected_approach"];

const EXTRACTOR_SYSTEM_PROMPT =
  "Extract durable project memories. Respond with strict JSON shaped as {\"memories\": [...]}. " +
  "Conversation evidence must include the exact supplied source ID and exact supplied chunk ID as locator.";

export function createAnthropicAwsExtractor(
  config: ExtractorConfig,
  httpClient?: AnthropicAwsHttpClient
): ExtractorProvider {
  return {
    async extract(context: ExtractorContext): Promise<ExtractorResult> {
      const requestConfig = anthropicAwsRequestConfig(config);
      const payload = await runAnthropicAwsMessage(
        {
          ...requestConfig,
          maxTokens: requestConfig.maxTokens,
          system: EXTRACTOR_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: JSON.stringify({
                conversations: sanitizeConversations(context.conversations),
                commits: context.commits
              })
            }
          ]
        },
        httpClient
      );
      const parsed = parseJsonFromModelText(readAnthropicAwsText(payload));
      return readMemories(parsed, context);
    }
  };
}

function readMemories(payload: unknown, context: ExtractorContext): ExtractorResult {
  const record = asRecord(payload);
  const memories = record?.memories;
  if (!Array.isArray(memories)) {
    throw new Error("Invalid extractor response");
  }
  const extracted: ExtractedMemory[] = [];
  const rejected: ExtractorResult["rejected"] = [];
  for (const [index, value] of memories.entries()) {
    const evidenceReason = invalidConversationEvidenceReason(value, context);
    if (evidenceReason) {
      rejected.push({ index, reason: evidenceReason });
      continue;
    }
    const memory = parseMemory(value);
    if (!memory) {
      rejected.push({ index, reason: "invalid_memory_record" });
      continue;
    }
    extracted.push(memory);
  }
  return { memories: extracted, rejected };
}

function parseMemory(value: unknown): ExtractedMemory | undefined {
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

  return {
    type,
    title,
    summary,
    reason,
    confidence,
    evidence,
    relatedFiles,
    dedupeKey
  };
}

function isEvidenceRef(value: unknown): value is EvidenceRef {
  const record = asRecord(value);
  return (
    (record?.sourceType === "conversation" || record?.sourceType === "commit" || record?.sourceType === "decision") &&
    typeof record.sourceId === "string" &&
    (record.locator === undefined || typeof record.locator === "string")
  );
}

function invalidConversationEvidenceReason(value: unknown, context: ExtractorContext): string | undefined {
  const evidence = asRecord(value)?.evidence;
  if (!Array.isArray(evidence)) return undefined;
  const allowed = new Set(context.conversations.flatMap((conversation) =>
    (conversation.chunks ?? []).map((chunk, index) =>
      chunk.id ?? `${conversation.sourceId}:chunk:${chunk.chunkIndex ?? index}`
    )
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sanitizeConversations(context: ExtractorContext["conversations"]): ExtractorContext["conversations"] {
  return context.map((conversation) => {
    const chunks = conversation.chunks
      ?.filter((chunk) => !isLowSignalText(chunk.text))
      .map((chunk, index) => ({
        ...chunk,
        id: chunk.id ?? `${conversation.sourceId}:chunk:${chunk.chunkIndex ?? index}`,
        sourceId: conversation.sourceId
      }));
    const sanitized: ExtractorContext["conversations"][number] = {
      ...conversation,
      rawContent: isLowSignalText(conversation.rawContent) ? "" : conversation.rawContent
    };
    if (chunks !== undefined) sanitized.chunks = chunks;
    return sanitized;
  });
}

function isLowSignalText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const tagMatches = trimmed.match(/<\/?[a-z][^>]*>/gi) ?? [];
  if (tagMatches.length >= 4) return true;
  if (/^```/.test(trimmed)) return true;
  if (/^\{[\s\S]*"[^"]+"\s*:/.test(trimmed)) return true;
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.filter((line) => /^[+-]\s*\S/.test(line)).length >= 4;
}
