import { createStatement, parseStatement } from "../memory/statement.js";
import { normalizeScope } from "../memory/scope.js";
import type {
  EvidenceRef,
  ExtractedMemory,
  ExtractorConfig,
  ExtractorContext,
  ExtractorProvider,
  ExtractorResult,
  MemoryType
} from "../types.js";
import { parseJsonFromModelText } from "../json.js";
import { DEFAULT_EXTRACTION_OUTPUT_TOKENS, extractionBatches, extractionOutputGuidance, memoryRecordProblem } from "./context.js";
import { EXTRACTOR_SYSTEM_PROMPT, withInferredEvidenceTypes } from "./prompt.js";

const VALID_MEMORY_TYPES: MemoryType[] = ["decision", "bug_fix", "constraint", "rejected_approach"];
export function createOpenAICompatibleExtractor(
  config: ExtractorConfig,
  fetchImpl: typeof fetch = fetch
): ExtractorProvider {
  return {
    async extract(context: ExtractorContext): Promise<ExtractorResult> {
      const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
      const result: ExtractorResult = { memories: [], rejected: [] };
      for (const batch of extractionBatches(context)) {
        const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${process.env[config.apiKeyEnv] ?? ""}`
          },
          body: JSON.stringify({
            model: config.model,
            temperature: 0,
            messages: [
              { role: "system", content: EXTRACTOR_SYSTEM_PROMPT + extractionOutputGuidance(config.maxTokens ?? DEFAULT_EXTRACTION_OUTPUT_TOKENS) },
              { role: "user", content: JSON.stringify(batch) }
            ]
          })
        });
        if (!response.ok) {
          throw new Error(`Extractor request failed with status ${response.status}`);
        }
        const payload = (await response.json()) as unknown;
        const content = readCompletionContent(payload);
        const parsed = parseJsonFromModelText(content);
        const extracted = readMemories(parsed, batch);
        const offset = result.memories.length + result.rejected.length;
        result.memories.push(...extracted.memories);
        result.rejected.push(...extracted.rejected.map(item => ({ ...item, index: item.index + offset })));
      }
      return result;
    }
  };
}

function readCompletionContent(payload: unknown): string {
  const record = asRecord(payload);
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first?.message);
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    const joined = message.content
      .map((item) => {
        const part = asRecord(item);
        return typeof part?.text === "string" ? part.text : "";
      })
      .join("\n")
      .trim();
    if (joined) return joined;
  }
  throw new Error("Invalid extractor response");
}

function readMemories(payload: unknown, context: ExtractorContext): ExtractorResult {
  const record = asRecord(payload);
  const memories = record?.memories;
  if (!Array.isArray(memories)) {
    throw new Error("Invalid extractor response");
  }
  const extracted: ExtractedMemory[] = [];
  const rejected: ExtractorResult["rejected"] = [];
  for (const [index, raw] of memories.entries()) {
    const value = withInferredEvidenceTypes(raw, context);
    const evidenceReason = invalidConversationEvidenceReason(value, context);
    if (evidenceReason) {
      rejected.push({ index, reason: evidenceReason });
      continue;
    }
    let memory: ExtractedMemory | undefined;
    try { memory = parseMemory(value); } catch { memory = undefined; }
    if (!memory) {
      rejected.push({ index, reason: "invalid_memory_record", detail: memoryRecordProblem(asRecord(value), VALID_MEMORY_TYPES) });
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

  const statement = parseStatement(record?.statement, type, "extracted") ?? createStatement(summary, type, "extracted");
  return {
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
