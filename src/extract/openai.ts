import type {
  EvidenceRef,
  ExtractedMemory,
  ExtractorConfig,
  ExtractorContext,
  ExtractorProvider,
  MemoryType
} from "../types.js";
import { parseJsonFromModelText } from "../json.js";

const VALID_MEMORY_TYPES: MemoryType[] = ["decision", "bug_fix", "constraint", "rejected_approach"];

export function createOpenAICompatibleExtractor(
  config: ExtractorConfig,
  fetchImpl: typeof fetch = fetch
): ExtractorProvider {
  return {
    async extract(context: ExtractorContext): Promise<ExtractedMemory[]> {
      const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
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
            {
              role: "system",
              content:
                "Extract durable project memories. Respond with strict JSON shaped as {\"memories\": [...]}."
            },
            {
              role: "user",
              content: JSON.stringify({
                conversations: context.conversations,
                commits: context.commits
              })
            }
          ]
        })
      });
      if (!response.ok) {
        throw new Error(`Extractor request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as unknown;
      const content = readCompletionContent(payload);
      const parsed = parseJsonFromModelText(content);
      const memories = readMemories(parsed);
      return memories;
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

function readMemories(payload: unknown): ExtractedMemory[] {
  const record = asRecord(payload);
  const memories = record?.memories;
  if (!Array.isArray(memories)) {
    throw new Error("Invalid extractor response");
  }
  const extracted = memories.map(parseMemory);
  if (extracted.some((memory) => !memory)) {
    throw new Error("Invalid extractor response");
  }
  return extracted as ExtractedMemory[];
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
