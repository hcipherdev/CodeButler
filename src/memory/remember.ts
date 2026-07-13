import { createHash } from "node:crypto";

import { assessMemoryQuality } from "./quality.js";
import { cleanMemoryText, titleFromMemoryText } from "./directives.js";
import { updateMemoryStatus } from "./lifecycle-service.js";
import type { MemoryStore } from "../storage/store.js";
import { withTransaction } from "../storage/transactions.js";
import type { DurableMemory, MemoryCandidate, MemoryType } from "../types.js";

export interface RememberProjectMemoryInput {
  type: MemoryType;
  text: string;
  title?: string | undefined;
  reason?: string | undefined;
  relatedFiles?: string[] | undefined;
  promote?: boolean | undefined;
  supersedesMemoryId?: string | undefined;
}

export interface RememberProjectMemoryResult {
  sourceId: string;
  candidate: MemoryCandidate;
  memory?: DurableMemory | undefined;
}

export function rememberProjectMemory(
  store: MemoryStore,
  input: RememberProjectMemoryInput,
  options: { now?: () => Date } = {}
): RememberProjectMemoryResult {
  const shouldPromote = input.promote ?? true;
  if (input.supersedesMemoryId !== undefined && !shouldPromote) {
    throw new Error("Superseding a durable memory requires promotion");
  }

  return withTransaction(store.db, () => rememberProjectMemoryAtomically(store, input, options, shouldPromote));
}

function rememberProjectMemoryAtomically(
  store: MemoryStore,
  input: RememberProjectMemoryInput,
  options: { now?: () => Date },
  shouldPromote: boolean
): RememberProjectMemoryResult {
  const summary = cleanMemoryText(input.text);
  if (!summary) throw new Error("Memory text is required");
  const type = normalizeMemoryType(input.type);
  const title = cleanMemoryText(input.title ?? titleFromMemoryText(summary));
  if (!title) throw new Error("Memory title is required");
  const relatedFiles = normalizeRelatedFiles(input.relatedFiles);
  const reason = cleanMemoryText(input.reason ?? "Captured from explicit user memory request.");
  const now = (options.now ?? (() => new Date()))().toISOString();
  const stableId = stableMemoryId(type, summary);
  const sourceId = `manual-memory:${type}:${stableId}`;
  const locator = `${sourceId}:chunk:0`;

  store.addSourceWithChunks({
    source: {
      id: sourceId,
      type: "conversation",
      title: `Manual ${type} memory`,
      origin: "manual-memory",
      rawContent: formatManualMemorySource({ type, title, summary, reason, relatedFiles, now }),
      metadata: {
        adapter: "manual",
        memoryType: type,
        capturedAt: now
      }
    },
    chunks: [
      {
        text: summary,
        metadata: {
          role: "user",
          memoryType: type,
          capturedAt: now
        }
      }
    ]
  });

  const extracted = {
    type,
    title,
    summary,
    reason,
    confidence: 1,
    evidence: [{ sourceType: "conversation" as const, sourceId, locator }],
    relatedFiles,
    dedupeKey: `manual-memory:${type}:${stableId}`
  };
  const assessment = assessMemoryQuality(store, extracted);
  if (assessment.rejected) {
    throw new Error(`Memory rejected by quality gate: ${assessment.reasons.join(", ")}`);
  }
  const candidate = store.upsertMemoryCandidate(extracted, {
    qualityStatus: assessment.status,
    qualityReasons: assessment.reasons,
    lastVerifiedAt: assessment.lastVerifiedAt ?? now
  });
  const memory = shouldPromote ? store.promoteMemoryCandidate(candidate.id, "manual") : undefined;
  if (memory && input.supersedesMemoryId !== undefined) {
    updateMemoryStatus(store, {
      memoryId: input.supersedesMemoryId,
      status: "superseded",
      reason: `Superseded by ${memory.title}.`,
      replacementMemoryId: memory.id,
      now
    });
  }
  return { sourceId, candidate, memory };
}

function normalizeMemoryType(type: MemoryType): MemoryType {
  if (type === "decision" || type === "constraint" || type === "bug_fix" || type === "rejected_approach") return type;
  throw new Error("Memory type must be one of decision, constraint, bug_fix, rejected_approach");
}

function normalizeRelatedFiles(files: string[] | undefined): string[] {
  return [...new Set((files ?? []).map((file) => file.trim()).filter(Boolean).map((file) => file.replace(/\\/g, "/")))];
}

function stableMemoryId(type: MemoryType, text: string): string {
  return createHash("sha256")
    .update(`${type}\0${text.toLowerCase().replace(/\s+/g, " ").trim()}`)
    .digest("hex")
    .slice(0, 16);
}

function formatManualMemorySource(input: {
  type: MemoryType;
  title: string;
  summary: string;
  reason: string;
  relatedFiles: string[];
  now: string;
}): string {
  return [
    `Type: ${input.type}`,
    `Title: ${input.title}`,
    `Captured: ${input.now}`,
    "",
    input.summary,
    "",
    `Reason: ${input.reason}`,
    "",
    "Related files:",
    ...(input.relatedFiles.length > 0 ? input.relatedFiles.map((file) => `- ${file}`) : ["- none"])
  ].join("\n");
}
