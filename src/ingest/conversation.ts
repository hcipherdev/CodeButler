import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

import type { MemoryChunk, MemorySource } from "../types.js";

export interface ParsedConversation {
  source: MemorySource;
  chunks: MemoryChunk[];
}

const MAX_CHUNK_CHARS = 2400;

export function parseConversationFile(filePath: string): ParsedConversation {
  const rawContent = readFileSync(filePath, "utf8");
  const extension = extname(filePath).toLowerCase();
  const source: MemorySource = {
    type: "conversation",
    title: basename(filePath),
    origin: filePath,
    rawContent,
    metadata: { filePath }
  };

  const chunks = extension === ".jsonl" ? parseJsonlChunks(rawContent) : parsePlainTextChunks(rawContent);
  return { source, chunks };
}

function parseJsonlChunks(rawContent: string): MemoryChunk[] {
  const chunks: MemoryChunk[] = [];
  const lines = rawContent.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const [index, line] of lines.entries()) {
    const parsed = JSON.parse(line) as unknown;
    if (!isJsonlTurn(parsed)) {
      throw new Error(`Invalid conversation JSONL at line ${index + 1}`);
    }
    chunks.push({
      chunkIndex: index,
      text: parsed.content,
      metadata: {
        turn_id: parsed.turn_id,
        role: parsed.role,
        timestamp: parsed.timestamp
      }
    });
  }
  return chunks;
}

function parsePlainTextChunks(rawContent: string): MemoryChunk[] {
  const paragraphs = rawContent
    .split(/\n\s*\n/g)
    .map((part) => part.trim())
    .filter(Boolean);
  const chunks: MemoryChunk[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (current.length === 0) {
      current = paragraph;
      continue;
    }
    if (current.length + paragraph.length + 2 <= MAX_CHUNK_CHARS) {
      current = `${current}\n\n${paragraph}`;
      continue;
    }
    chunks.push({ chunkIndex: chunks.length, text: current, metadata: {} });
    current = paragraph;
  }

  if (current.length > 0) {
    chunks.push({ chunkIndex: chunks.length, text: current, metadata: {} });
  }

  return chunks;
}

function isJsonlTurn(value: unknown): value is {
  turn_id: string;
  role: string;
  content: string;
  timestamp: string;
} {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.turn_id === "string" &&
    typeof record.role === "string" &&
    typeof record.content === "string" &&
    typeof record.timestamp === "string"
  );
}
