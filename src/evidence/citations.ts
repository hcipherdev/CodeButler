import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { MemoryStore } from "../storage/store.js";
import type {
  EvidenceCitation,
  EvidenceRef,
  MemoryQualityStatus,
  TrustSummary
} from "../types.js";

export interface ResolveEvidenceInput {
  evidence: EvidenceRef[];
  relatedFiles?: string[] | undefined;
  includeProjectSummary?: boolean | undefined;
}

export function resolveEvidenceCitations(
  store: MemoryStore,
  input: ResolveEvidenceInput
): EvidenceCitation[] {
  const citations = input.evidence.map((evidence) => resolveEvidenceCitation(store, evidence));
  for (const filePath of input.relatedFiles ?? []) {
    citations.push(resolveFileCitation(store, filePath));
  }
  if (input.includeProjectSummary) {
    const summaryPath = join(store.paths.dataDir, "project-summary.md");
    citations.push({
      kind: "project_summary",
      sourceId: "project-summary",
      label: "project summary",
      summary: existsSync(summaryPath) ? "Project narrative summary" : "Project summary not generated",
      resolved: existsSync(summaryPath),
      metadata: { path: summaryPath }
    });
  }
  return dedupeCitations(citations);
}

export function buildTrustSummary(input: {
  status?: MemoryQualityStatus | undefined;
  confidence?: number | undefined;
  evidence: EvidenceRef[];
  citations?: EvidenceCitation[] | undefined;
  reasons?: string[] | undefined;
  lastVerifiedAt?: string | undefined;
}): TrustSummary {
  const evidenceCitations = input.citations?.filter((citation) =>
    citation.kind === "conversation" || citation.kind === "commit" || citation.kind === "decision" || citation.kind === "missing"
  ) ?? [];
  const resolvedEvidenceCount = evidenceCitations.filter((citation) => citation.resolved).length;
  const unresolvedEvidenceCount = Math.max(input.evidence.length - resolvedEvidenceCount, 0);
  const sourceTypes = [...new Set(input.evidence.map((evidence) => evidence.sourceType))].sort();
  const trust: TrustSummary = {
    status: input.status ?? (unresolvedEvidenceCount > 0 ? "needs_review" : "active"),
    evidenceCount: input.evidence.length,
    resolvedEvidenceCount,
    unresolvedEvidenceCount,
    sourceTypes,
    reasons: input.reasons ?? []
  };
  if (typeof input.confidence === "number" && Number.isFinite(input.confidence)) {
    trust.confidence = input.confidence;
  }
  if (input.lastVerifiedAt !== undefined) {
    trust.lastVerifiedAt = input.lastVerifiedAt;
  }
  return trust;
}

export function resolveTrustSummary(
  store: MemoryStore,
  input: {
    evidence: EvidenceRef[];
    relatedFiles?: string[] | undefined;
    status?: MemoryQualityStatus | undefined;
    confidence?: number | undefined;
    reasons?: string[] | undefined;
    lastVerifiedAt?: string | undefined;
  }
): TrustSummary {
  const citations = resolveEvidenceCitations(store, {
    evidence: input.evidence,
    relatedFiles: input.relatedFiles
  });
  return buildTrustSummary({
    status: input.status,
    confidence: input.confidence,
    evidence: input.evidence,
    citations,
    reasons: input.reasons,
    lastVerifiedAt: input.lastVerifiedAt
  });
}

function resolveEvidenceCitation(store: MemoryStore, evidence: EvidenceRef): EvidenceCitation {
  if (evidence.sourceType === "commit") {
    const commit = store.readCommit(evidence.sourceId);
    if (!commit) return missingCitation(evidence);
    return {
      kind: "commit",
      sourceId: evidence.sourceId,
      locator: evidence.locator,
      label: `commit ${shortHash(commit.hash)}`,
      summary: commit.message,
      resolved: true,
      metadata: {
        authoredAt: commit.authoredAt,
        changedFiles: commit.changedFiles
      }
    };
  }

  const source = store.readSource(evidence.sourceId);
  if (!source) return missingCitation(evidence);
  if (evidence.sourceType === "conversation") {
    const chunk = readLocatedChunk(store, evidence);
    if (source.type !== "conversation" || chunk === undefined) {
      return {
        kind: "conversation",
        sourceId: evidence.sourceId,
        locator: evidence.locator,
        label: source.title,
        summary: "Conversation chunk locator could not be resolved in the local store.",
        resolved: false,
        metadata: source.metadata
      };
    }
    const label = chunk?.chunkIndex !== undefined
      ? `${source.title} chunk ${chunk.chunkIndex}`
      : source.title;
    return {
      kind: "conversation",
      sourceId: evidence.sourceId,
      locator: evidence.locator,
      label,
      summary: summarizeText(chunk?.text ?? source.rawContent),
      resolved: true,
      metadata: source.metadata
    };
  }

  return {
    kind: "decision",
    sourceId: evidence.sourceId,
    locator: evidence.locator,
    label: `decision: ${source.title}`,
    summary: summarizeText(source.rawContent),
    resolved: true,
    metadata: source.metadata
  };
}

function resolveFileCitation(store: MemoryStore, filePath: string): EvidenceCitation {
  const rootPath = realpathSync(store.paths.rootDir);
  const candidatePath = resolve(rootPath, filePath);
  const lexicalRelative = normalizePath(relative(rootPath, candidatePath));
  const displayPath = isContainedRelativePath(lexicalRelative)
    ? lexicalRelative
    : normalizePath(filePath);
  if (!isContainedRelativePath(lexicalRelative) || !existsSync(candidatePath)) {
    return unresolvedFileCitation(displayPath);
  }
  try {
    const realPath = realpathSync(candidatePath);
    const repositoryPath = normalizePath(relative(rootPath, realPath));
    if (!isContainedRelativePath(repositoryPath) || !statSync(realPath).isFile()) {
      return unresolvedFileCitation(displayPath);
    }
    return {
      kind: "file",
      sourceId: repositoryPath,
      label: `file ${repositoryPath}`,
      summary: repositoryPath,
      resolved: true,
      metadata: { path: realPath }
    };
  } catch {
    return unresolvedFileCitation(displayPath);
  }
}

function unresolvedFileCitation(filePath: string): EvidenceCitation {
  return {
    kind: "file",
    sourceId: filePath,
    label: `file ${filePath}`,
    summary: filePath,
    resolved: false
  };
}

function isContainedRelativePath(filePath: string): boolean {
  return filePath.length > 0 && filePath !== ".." && !filePath.startsWith("../") && !isAbsolute(filePath);
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function readLocatedChunk(store: MemoryStore, evidence: EvidenceRef) {
  if (!evidence.locator?.includes(":chunk:")) return undefined;
  const chunks = store.readConversationWindow(evidence.sourceId, evidence.locator, 0, 0);
  return chunks[0];
}

function missingCitation(evidence: EvidenceRef): EvidenceCitation {
  return {
    kind: "missing",
    sourceId: evidence.sourceId,
    locator: evidence.locator,
    label: `missing ${evidence.sourceType} ${evidence.sourceId}`,
    summary: "Evidence reference could not be resolved in the local store.",
    resolved: false,
    metadata: { sourceType: evidence.sourceType }
  };
}

function dedupeCitations(citations: EvidenceCitation[]): EvidenceCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = `${citation.kind}:${citation.sourceId}:${citation.locator ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

function summarizeText(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > 180 ? `${cleaned.slice(0, 177)}...` : cleaned;
}
