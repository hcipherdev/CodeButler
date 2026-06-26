import { createAnthropicAwsExtractor } from "../extract/anthropic-aws.js";
import { createOpenAICompatibleExtractor } from "../extract/openai.js";
import { extractDeterministicMemories } from "../deterministic/triggers.js";
import { extractTemporaryMemories } from "../deterministic/temporary.js";
import { assessMemoryQuality } from "../memory/quality.js";
import type { MemoryStore } from "../storage/store.js";
import { syncClaudeSource, syncCodexSource } from "../sources/codex.js";
import { syncGitSource } from "../sources/git.js";
import type {
  CommitRecord,
  ExtractedMemory,
  ExtractorConversationInput,
  ExtractorProvider,
  ProjectConfig,
  SyncSourceName
} from "../types.js";

export interface SyncSourceResult {
  imported: number;
  enabled: boolean;
  error?: string;
}

export interface SyncMemoryResult {
  candidates: number;
  promoted: number;
  rejected: number;
  skipped: boolean;
  reason?: string;
  error?: string;
}

export interface SyncTemporaryMemoryResult {
  upserted: number;
  deletedExpired: number;
}

export interface SyncRunResult {
  startedAt: string;
  completedAt: string;
  sources: Record<SyncSourceName, SyncSourceResult>;
  memories: SyncMemoryResult;
  temporary: SyncTemporaryMemoryResult;
}

export async function syncProjectMemory(
  store: MemoryStore,
  config: ProjectConfig,
  options: {
    source?: SyncSourceName | "all";
    extractorProvider?: ExtractorProvider;
  } = {}
): Promise<SyncRunResult> {
  const startedAt = new Date().toISOString();
  const selectedSources = options.source && options.source !== "all" ? [options.source] : SOURCE_NAMES;
  const result: SyncRunResult = {
    startedAt,
    completedAt: startedAt,
    sources: {
      git: { imported: 0, enabled: config.sources.git.enabled },
      codex: { imported: 0, enabled: config.sources.codex.enabled },
      claude: { imported: 0, enabled: config.sources.claude.enabled }
    },
    memories: {
      candidates: 0,
      promoted: 0,
      rejected: 0,
      skipped: false
    },
    temporary: {
      upserted: 0,
      deletedExpired: store.deleteExpiredTemporaryMemories({ now: startedAt })
    }
  };

  const importedConversations: ExtractorConversationInput[] = [];
  const importedCommits: CommitRecord[] = [];

  for (const sourceName of SOURCE_NAMES) {
    if (!selectedSources.includes(sourceName)) continue;
    try {
      if (sourceName === "git") {
        if (!config.sources.git.enabled) {
          recordDisabledSync(store, sourceName, startedAt);
          continue;
        }
        const syncResult = syncGitSource(store, config.sources.git);
        importedCommits.push(...syncResult.commits);
        result.sources.git = { imported: syncResult.imported, enabled: true };
        store.recordSyncStatus({
          source: "git",
          enabled: true,
          lastSyncAt: startedAt,
          lastSuccessAt: startedAt,
          metadata: { imported: syncResult.imported, repoPath: config.sources.git.repoPath }
        });
        continue;
      }

      if (sourceName === "codex") {
        if (!config.sources.codex.enabled) {
          recordDisabledSync(store, sourceName, startedAt);
          continue;
        }
        const syncResult = syncCodexSource(store, config.sources.codex, config.sources.git.repoPath);
        importedConversations.push(...syncResult.conversations);
        result.sources.codex = { imported: syncResult.imported, enabled: true };
        store.recordSyncStatus({
          source: "codex",
          enabled: true,
          lastSyncAt: startedAt,
          lastSuccessAt: startedAt,
          metadata: { imported: syncResult.imported, roots: config.sources.codex.roots }
        });
        continue;
      }

      if (!config.sources.claude.enabled) {
        recordDisabledSync(store, sourceName, startedAt);
        continue;
      }
      const syncResult = syncClaudeSource(store, config.sources.claude, config.sources.git.repoPath);
      importedConversations.push(...syncResult.conversations);
      result.sources.claude = { imported: syncResult.imported, enabled: true };
      store.recordSyncStatus({
        source: "claude",
        enabled: true,
        lastSyncAt: startedAt,
        lastSuccessAt: startedAt,
        metadata: { imported: syncResult.imported, roots: config.sources.claude.roots }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.sources[sourceName] = {
        imported: 0,
        enabled: isEnabled(config, sourceName),
        error: message
      };
      store.recordSyncStatus({
        source: sourceName,
        enabled: isEnabled(config, sourceName),
        lastSyncAt: startedAt,
        lastError: message
      });
    }
  }

  result.temporary.upserted = processTemporaryMemories(
    store,
    extractTemporaryMemories(importedConversations, {
      projectId: store.paths.rootDir,
      now: new Date(startedAt)
    }).memories
  );

  const deterministicProcessed = processDeterministicMemories(
    store,
    extractDeterministicMemories(
      {
        conversations: importedConversations,
        commits: importedCommits
      },
      { deterministic: config.deterministic, repoPath: config.sources.git.repoPath }
    )
  );

  const extractor = options.extractorProvider ?? buildConfiguredExtractor(config);
  if (!extractor) {
    result.memories =
      deterministicProcessed.candidates > 0
        ? {
            candidates: deterministicProcessed.candidates,
            promoted: deterministicProcessed.promoted,
            rejected: deterministicProcessed.rejected,
            skipped: false
          }
        : {
            candidates: 0,
            promoted: 0,
            rejected: deterministicProcessed.rejected,
            skipped: true,
            reason: "Extractor not configured"
          };
    result.completedAt = new Date().toISOString();
    return result;
  }

  if (importedConversations.length === 0 && importedCommits.length === 0) {
    result.memories = {
      candidates: 0,
      promoted: 0,
      rejected: deterministicProcessed.rejected,
      skipped: true,
      reason: "No new evidence"
    };
    result.completedAt = new Date().toISOString();
    return result;
  }

  try {
    const extracted = await extractor.extract({
      conversations: importedConversations,
      commits: importedCommits
    });
    const processed = processExtractedMemories(store, config, extracted.memories);
    result.memories = {
      candidates: deterministicProcessed.candidates + processed.candidates,
      promoted: deterministicProcessed.promoted + processed.promoted,
      rejected: deterministicProcessed.rejected + processed.rejected + extracted.rejected.length,
      skipped: false
    };
  } catch (error) {
    result.memories =
      deterministicProcessed.candidates > 0
        ? {
            candidates: deterministicProcessed.candidates,
            promoted: deterministicProcessed.promoted,
            rejected: deterministicProcessed.rejected,
            skipped: false,
            error: error instanceof Error ? error.message : String(error)
          }
        : {
            candidates: 0,
            promoted: 0,
            rejected: deterministicProcessed.rejected,
            skipped: true,
            error: error instanceof Error ? error.message : String(error)
          };
  }

  result.completedAt = new Date().toISOString();
  return result;
}

const SOURCE_NAMES: SyncSourceName[] = ["git", "codex", "claude"];

function processDeterministicMemories(
  store: MemoryStore,
  extraction: { memories: ExtractedMemory[]; promoteDedupeKeys: string[] }
): { candidates: number; promoted: number; rejected: number } {
  const promoteDedupeKeys = new Set(extraction.promoteDedupeKeys);
  let promoted = 0;
  let candidates = 0;
  let rejected = 0;
  for (const memory of extraction.memories) {
    const assessment = assessMemoryQuality(store, memory);
    if (assessment.rejected) {
      rejected += 1;
      continue;
    }
    const candidate = store.upsertMemoryCandidate(memory, {
      qualityStatus: assessment.status,
      qualityReasons: assessment.reasons,
      lastVerifiedAt: assessment.lastVerifiedAt
    });
    candidates += 1;
    if (assessment.status === "active" && promoteDedupeKeys.has(memory.dedupeKey)) {
      store.promoteMemoryCandidate(candidate.id);
      promoted += 1;
    }
  }
  return {
    candidates,
    promoted,
    rejected
  };
}

function processTemporaryMemories(store: MemoryStore, memories: ReturnType<typeof extractTemporaryMemories>["memories"]): number {
  for (const memory of memories) {
    store.upsertTemporaryMemory(memory);
  }
  return memories.length;
}

function processExtractedMemories(
  store: MemoryStore,
  config: ProjectConfig,
  memories: ExtractedMemory[]
): { candidates: number; promoted: number; rejected: number } {
  let promoted = 0;
  let candidates = 0;
  let rejected = 0;
  for (const memory of memories) {
    const assessment = assessMemoryQuality(store, memory);
    if (assessment.rejected) {
      rejected += 1;
      continue;
    }
    const candidate = store.upsertMemoryCandidate(memory, {
      qualityStatus: assessment.status,
      qualityReasons: assessment.reasons,
      lastVerifiedAt: assessment.lastVerifiedAt
    });
    candidates += 1;
    if (assessment.status === "active" && shouldPromote(memory, config)) {
      store.promoteMemoryCandidate(candidate.id);
      promoted += 1;
    }
  }
  return {
    candidates,
    promoted,
    rejected
  };
}

function shouldPromote(memory: ExtractedMemory, config: ProjectConfig): boolean {
  if (memory.confidence < config.promotion.confidenceThreshold) return false;
  const categories = new Set(memory.evidence.map((item) => item.sourceType));
  const hasCommitConversation = categories.has("commit") && categories.has("conversation");
  const hasMinCategories = categories.size >= config.promotion.minSourceCategories;
  return config.promotion.requireCommitAndConversation
    ? hasCommitConversation || hasMinCategories
    : hasMinCategories;
}

function buildConfiguredExtractor(config: ProjectConfig): ExtractorProvider | undefined {
  if (!config.extractor.provider) return undefined;
  if (!hasProviderCredentials(config.extractor)) return undefined;
  if (config.extractor.provider === "anthropic-aws") {
    return createAnthropicAwsExtractor(config.extractor);
  }
  return createOpenAICompatibleExtractor(config.extractor);
}

function hasProviderCredentials(config: ProjectConfig["extractor"]): boolean {
  if (!process.env[config.apiKeyEnv]?.trim()) return false;
  if (config.provider !== "anthropic-aws") return true;
  const workspaceIdEnv = config.workspaceIdEnv ?? "ANTHROPIC_AWS_WORKSPACE_ID";
  const regionEnv = config.regionEnv ?? "AWS_REGION";
  return Boolean(process.env[workspaceIdEnv]?.trim() && process.env[regionEnv]?.trim());
}

function recordDisabledSync(store: MemoryStore, sourceName: SyncSourceName, timestamp: string): void {
  store.recordSyncStatus({
    source: sourceName,
    enabled: false,
    lastSyncAt: timestamp,
    lastSuccessAt: timestamp,
    metadata: { imported: 0, disabled: true }
  });
}

function isEnabled(config: ProjectConfig, sourceName: SyncSourceName): boolean {
  if (sourceName === "git") return config.sources.git.enabled;
  if (sourceName === "codex") return config.sources.codex.enabled;
  return config.sources.claude.enabled;
}
