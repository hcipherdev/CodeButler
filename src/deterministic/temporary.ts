import type {
  EvidenceRef,
  ExtractorConversationInput,
  MemoryChunk,
  TemporaryMemoryKind,
  TemporaryMemoryUpsertInput
} from "../types.js";

export interface TemporaryMemoryExtraction {
  memories: TemporaryMemoryUpsertInput[];
}

export interface TemporaryMemoryExtractionOptions {
  projectId: string;
  now?: Date;
}

const TEMPORARY_MEMORY_RECENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const TEMPORARY_MEMORY_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TEMPORARY_MEMORIES_PER_CONVERSATION = 8;

export function extractTemporaryMemories(
  conversations: ExtractorConversationInput[],
  options: TemporaryMemoryExtractionOptions
): TemporaryMemoryExtraction {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const memories: TemporaryMemoryUpsertInput[] = [];

  for (const conversation of conversations) {
    let extractedForConversation = 0;
    const chunks = conversation.chunks ?? [];
    for (const [fallbackIndex, chunk] of chunks.entries()) {
      if (extractedForConversation >= MAX_TEMPORARY_MEMORIES_PER_CONVERSATION) break;
      const timestamp = chunkTimestamp(chunk);
      if (!timestamp || !isRecent(timestamp, now)) continue;
      const kind = classifyTemporaryMemory(chunk.text);
      if (!kind) continue;

      const chunkIndex = typeof chunk.chunkIndex === "number" ? chunk.chunkIndex : fallbackIndex;
      const metadata = {
        ...conversation.metadata,
        ...chunk.metadata
      };
      const sessionId = stringValue(metadata.sessionId);
      const threadId = stringValue(metadata.threadId) ?? sessionId;
      const sourceAdapter = stringValue(metadata.adapter);
      const relatedFiles = detectFileMentions(chunk.text);
      const evidence: EvidenceRef[] = [
        {
          sourceType: "conversation",
          sourceId: conversation.sourceId,
          locator: `${conversation.sourceId}:chunk:${chunkIndex}`
        }
      ];
      const summary = cleanSentence(chunk.text);
      const title = titleFromText(summary);
      const memory: TemporaryMemoryUpsertInput = {
        id: stableTemporaryMemoryId(conversation.sourceId, kind, summary),
        projectId: options.projectId,
        kind,
        title,
        summary,
        details: chunk.text.trim(),
        relatedFiles,
        evidence,
        confidence: confidenceForKind(kind),
        createdAt: timestamp.toISOString(),
        updatedAt: nowIso,
        expiresAt: new Date(now.getTime() + TEMPORARY_MEMORY_DEFAULT_TTL_MS).toISOString()
      };
      if (threadId !== undefined) memory.threadId = threadId;
      if (sessionId !== undefined) memory.sessionId = sessionId;
      if (sourceAdapter !== undefined) memory.sourceAdapter = sourceAdapter;
      memories.push(memory);
      extractedForConversation += 1;
    }
  }

  return { memories: dedupeTemporaryMemories(memories) };
}

function chunkTimestamp(chunk: MemoryChunk): Date | undefined {
  const value = stringValue(chunk.metadata?.timestamp) ?? stringValue(chunk.metadata?.createdAt);
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function isRecent(timestamp: Date, now: Date): boolean {
  const ageMs = now.getTime() - timestamp.getTime();
  return ageMs >= 0 && ageMs <= TEMPORARY_MEMORY_RECENT_WINDOW_MS;
}

function classifyTemporaryMemory(text: string): TemporaryMemoryKind | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  if (/\b(?:remember|keep|note)\s+(?:this\s+)?(?:for\s+)?(?:this\s+)?(?:task|session)\s*:/i.test(normalized)) {
    return "user_instruction";
  }
  if (/\bfor\s+this\s+(?:task|session)\s*:/i.test(normalized)) {
    return "user_instruction";
  }
  if (/\b(?:test|typecheck|build|vitest|failed|failing|passed|regression)\b/i.test(normalized)) {
    return "recent_test";
  }
  if (/\?\s*$/.test(normalized) || /^(?:what|why|how|should|can|could|where)\b/i.test(normalized)) {
    return "open_question";
  }
  if (/\b(?:hypothesis|root cause|likely|probably|suspect)\b/i.test(normalized)) {
    return "working_hypothesis";
  }
  if (/\b(?:continue|current task|where we left off|implement|wire|fix|add|update|refactor)\b/i.test(normalized)) {
    return "task_state";
  }
  if (detectFileMentions(normalized).length > 0) {
    return "file_context";
  }
  return undefined;
}

function confidenceForKind(kind: TemporaryMemoryKind): number {
  if (kind === "user_instruction") return 0.95;
  if (kind === "task_state") return 0.85;
  if (kind === "recent_test") return 0.8;
  if (kind === "open_question") return 0.75;
  return 0.7;
}

function stableTemporaryMemoryId(sourceId: string, kind: TemporaryMemoryKind, summary: string): string {
  return `temporary:${sourceId}:${kind}:${slug(summary).slice(0, 72)}`;
}

function titleFromText(text: string): string {
  const firstSentence = text.split(/[.!?]\s/)[0]?.trim() ?? text.trim();
  const title = firstSentence.length > 72 ? `${firstSentence.slice(0, 69)}...` : firstSentence;
  return title || "Temporary working context";
}

function cleanSentence(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function detectFileMentions(text: string): string[] {
  const matches = text.match(/(?:[\w.-]+\/)+[\w.@-]+(?:\.[\w-]+)?/g) ?? [];
  return [...new Set(matches.map((match) => match.replace(/[),.;:]+$/, "")))];
}

function dedupeTemporaryMemories(memories: TemporaryMemoryUpsertInput[]): TemporaryMemoryUpsertInput[] {
  const seen = new Set<string>();
  return memories.filter((memory) => {
    const key = memory.id ?? `${memory.kind}:${memory.summary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function slug(value: string): string {
  const slugged = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slugged || "context";
}
