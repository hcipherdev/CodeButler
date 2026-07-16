import { execFileSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadProjectConfig } from "../config.js";
import { findDecisions } from "../decisions/store.js";
import { runDoctor } from "../doctor/service.js";
import { buildTrustSummary, resolveEvidenceCitations } from "../evidence/citations.js";
import { explainCodeChange, investigateProjectHistory } from "../investigate/history.js";
import { updateMemoryStatus } from "../memory/lifecycle-service.js";
import { summarizeMemoryHealth } from "../memory/quality.js";
import { rememberProjectMemory } from "../memory/remember.js";
import { findProjectMemories, searchProjectMemory, type SearchServiceOptions } from "../search/service.js";
import {
  readProjectBrief,
  refreshProjectSummary,
  type ProjectBrief,
  type ProjectSummaryGenerator,
  type ProjectSummaryOperationOptions,
  type ProjectSummaryRefreshResult
} from "../project-summary/service.js";
import type { MemoryStore, ProjectSummary } from "../storage/store.js";
import { syncProjectMemory } from "../sync/service.js";
import type {
  EvidenceRef,
  MemoryLifecycleStatus,
  MemoryQualityStatus,
  MemoryType,
  MemorySearchResult,
  SearchResult,
  SourceType,
  SyncSourceName,
  TemporaryMemory,
  TemporaryMemoryKind
} from "../types.js";
import type { DoctorReport } from "../types.js";
import { registerInvestigationToolGroup } from "./tool-groups/investigation.js";
import { registerMemoryToolGroup } from "./tool-groups/memory.js";
import { registerSourceToolGroup } from "./tool-groups/sources.js";

export interface RecentActivitySummary {
  window: {
    since: string;
    until: string;
  };
  summary: string[];
  highlights: Array<{
    kind: "commit" | "working_tree" | "conversation";
    text: string;
    evidence?: EvidenceRef | undefined;
    relatedFiles?: string[] | undefined;
    sourceId?: string | undefined;
  }>;
  conversations: Array<{
    sourceId: string;
    title: string;
    origin: string;
    createdAt: string;
    timestamp?: string;
    chunks: Array<{
      chunkId: string;
      text: string;
      metadata: Record<string, unknown>;
    }>;
  }>;
  commits: Array<{
    hash: string;
    authoredAt: string;
    message: string;
    changedFiles: string[];
    diffSummary: string;
  }>;
  workingTree: {
    requested: boolean;
    available: boolean;
    status: string[];
    diffStat: string[];
    error?: string;
  };
  why: string[];
  freshness: {
    hasIndexedSourcesInWindow: boolean;
    latestIndexedSourceAt?: string;
    lastSyncAt?: string;
    warning?: string;
  };
}

export interface ActiveContextSummary {
  generatedAt: string;
  scope: {
    threadId?: string;
    sessionId?: string;
    projectOnly: boolean;
  };
  groups: {
    taskState: TemporaryMemory[];
    openQuestions: TemporaryMemory[];
    workingHypotheses: TemporaryMemory[];
    recentTests: TemporaryMemory[];
    fileContext: TemporaryMemory[];
    userInstructions: TemporaryMemory[];
  };
  relatedFiles: string[];
  freshness: {
    activeTemporaryMemories: number;
    nearestExpiryAt?: string;
    warning?: string;
  };
}

export interface ProjectStartupMetadata {
  configCreated: boolean;
  databaseCreated: boolean;
}

export interface CurrentProjectInfo {
  rootDir: string;
  dataDir: string;
  configPath: string;
  databasePath: string;
  configCreated: boolean;
  databaseCreated: boolean;
}

export interface ProjectMemoryToolHandlers {
  current_project(): CurrentProjectInfo;
  search_project_memory(input: {
    query: string;
    sourceTypes?: SourceType[];
    limit?: number;
  }): Promise<{
    memories: ReturnType<MemoryStore["searchMemoryLayer"]>;
    results: ReturnType<MemoryStore["search"]>;
  }>;
  read_memory_source(input: { sourceId: string }): ReturnType<MemoryStore["readSource"]>;
  find_memories(input: {
    query?: string;
    type?: MemoryType;
    status?: "promoted" | "candidate";
    qualityStatus?: MemoryQualityStatus | "all";
    lifecycleStatus?: MemoryLifecycleStatus | "all";
    limit?: number;
  }): Promise<{
    results: ReturnType<MemoryStore["searchMemoryLayer"]>;
  }>;
  remember_project_memory(input: {
    type: MemoryType;
    text: string;
    title?: string;
    reason?: string;
    relatedFiles?: string[];
    promote?: boolean;
    supersedesMemoryId?: string;
  }): {
    sourceId: string;
    memory: MemorySearchResult;
  };
  update_memory_status(input: {
    memoryId: string;
    status: MemoryLifecycleStatus;
    reason: string;
    replacementMemoryId?: string;
  }): {
    memory: ReturnType<typeof updateMemoryStatus>;
    relations: ReturnType<MemoryStore["listMemoryRelations"]>;
  };
  find_decisions(input: { topic?: string; limit?: number }): ReturnType<typeof findDecisions>;
  find_related_commits(input: {
    query?: string;
    filePath?: string;
    limit?: number;
  }): ReturnType<MemoryStore["findCommits"]>;
  explain_code_change(input: {
    filePath: string;
    lineNumber?: number;
    question?: string;
  }): Promise<Awaited<ReturnType<typeof explainCodeChange>>>;
  investigate_project_history(input: {
    question: string;
    limit?: number;
  }): Promise<Awaited<ReturnType<typeof investigateProjectHistory>>>;
  summarize_recent_activity(input: {
    since?: string;
    until?: string;
    includeWorkingTree?: boolean;
  }): RecentActivitySummary;
  search_temporary_memory(input: {
    query: string;
    threadId?: string;
    sessionId?: string;
    limit?: number;
  }): {
    results: ReturnType<MemoryStore["searchTemporaryMemory"]>;
  };
  summarize_active_context(input: {
    threadId?: string;
    sessionId?: string;
    projectOnly?: boolean;
    limit?: number;
  }): ActiveContextSummary;
  cleanup_temporary_memory(input: {
    expiredOnly?: boolean;
  }): {
    deleted: number;
    expiredOnly: boolean;
  };
  sync_project_memory(input: {
    source?: SyncSourceName | "all";
  }): Promise<Awaited<ReturnType<typeof syncProjectMemory>>>;
  list_source_failures(input: {
    adapter?: SyncSourceName;
    resolved?: boolean;
    limit?: number;
  }): ReturnType<MemoryStore["listSourceFailures"]>;
  summarize_project_state(): ProjectSummary;
  summarize_memory_health(): ReturnType<typeof summarizeMemoryHealth>;
  run_doctor(): DoctorReport;
  summarize_project_brief(): ProjectBrief;
  refresh_project_summary(input: { force?: boolean }): Promise<ProjectSummaryRefreshResult>;
}

const sourceTypeSchema = z.enum(["conversation", "commit", "decision"]);
const memoryTypeSchema = z.enum(["decision", "bug_fix", "constraint", "rejected_approach"]);
const memoryQualityStatusSchema = z.enum(["active", "needs_review", "quarantined", "all"]);
const memoryLifecycleStatusSchema = z.enum(["current", "superseded", "retracted", "all"]);
const updateMemoryLifecycleStatusSchema = z.enum(["current", "superseded", "retracted"]);
const syncSourceSchema = z.enum(["git", "codex", "claude", "all"]);
const sourceFailureAdapterSchema = z.enum(["git", "codex", "claude"]);
export function createProjectMemoryToolHandlers(
  store: MemoryStore,
  options: {
    rootDir?: string;
    projectSummaryGenerator?: ProjectSummaryGenerator;
    now?: () => Date;
    warn?: (line: string) => void;
    startupMetadata?: ProjectStartupMetadata | undefined;
    searchService?: SearchServiceOptions | undefined;
  } = {}
): ProjectMemoryToolHandlers {
  const rootDir = options.rootDir ?? store.paths.rootDir;
  const config = loadProjectConfig(rootDir);
  const startupMetadata = options.startupMetadata ?? { configCreated: false, databaseCreated: false };
  return {
    current_project() {
      return {
        rootDir,
        dataDir: store.paths.dataDir,
        configPath: config.configPath,
        databasePath: store.paths.databasePath,
        configCreated: startupMetadata.configCreated,
        databaseCreated: startupMetadata.databaseCreated
      };
    },
    async search_project_memory(input) {
      const result = await searchProjectMemory(store, config, normalizeSearchInput(input), options.searchService);
      return {
        memories: result.memories,
        results: result.results.map((item) => decorateSearchResult(store, item))
      };
    },
    read_memory_source(input) {
      return store.readSource(input.sourceId);
    },
    async find_memories(input) {
      return {
        results: await findProjectMemories(store, config, normalizeMemorySearchInput(input), options.searchService)
      };
    },
    remember_project_memory(input) {
      const remembered = rememberProjectMemory(
        store,
        normalizeRememberMemoryInput(input),
        { ...(options.now === undefined ? {} : { now: options.now }), actor: "mcp" }
      );
      const memoryId = remembered.memory?.id ?? remembered.candidate.id;
      const status = remembered.memory ? "promoted" : "candidate";
      const memory = store
        .searchMemoryLayer({
          query: remembered.memory?.summary ?? remembered.candidate.summary,
          type: remembered.memory?.type ?? remembered.candidate.type,
          status,
          qualityStatus: "all",
          lifecycleStatus: "all",
          limit: 100
        })
        .find((result) => result.id === memoryId);
      if (!memory) {
        throw new Error(`Remembered memory could not be read back: ${memoryId}`);
      }
      return {
        sourceId: remembered.sourceId,
        memory
      };
    },
    update_memory_status(input) {
      const normalized = normalizeUpdateMemoryStatusInput(input);
      const memory = updateMemoryStatus(store, {
        ...normalized,
        now: nowIso(options.now),
        actor: "mcp"
      });
      const relations = store
        .listMemoryRelations()
        .filter((relation) => relation.fromMemoryId === memory.id || relation.toMemoryId === memory.id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
      return { memory, relations };
    },
    find_decisions(input) {
      return findDecisions(store, normalizeDecisionInput(input));
    },
    find_related_commits(input) {
      return store.findCommits(normalizeCommitInput(input));
    },
    async explain_code_change(input) {
      return explainCodeChange(store, normalizeExplainInput(input), { config });
    },
    async investigate_project_history(input) {
      return investigateProjectHistory(store, normalizeInvestigationInput(input), { config });
    },
    summarize_recent_activity(input) {
      return summarizeRecentActivity(store, rootDir, normalizeRecentActivityInput(input), options.now);
    },
    search_temporary_memory(input) {
      return {
        results: store.searchTemporaryMemory({
          ...normalizeTemporarySearchInput(input),
          now: nowIso(options.now)
        })
      };
    },
    summarize_active_context(input) {
      return summarizeActiveContext(store, normalizeActiveContextInput(input), options.now);
    },
    cleanup_temporary_memory(input) {
      const normalized = normalizeTemporaryCleanupInput(input);
      return {
        deleted: store.deleteExpiredTemporaryMemories({
          expiredOnly: normalized.expiredOnly,
          now: nowIso(options.now)
        }),
        expiredOnly: normalized.expiredOnly
      };
    },
    async sync_project_memory(input) {
      return syncProjectMemory(store, config, { source: input.source ?? "all" });
    },
    list_source_failures(input) {
      return store.listSourceFailures(input);
    },
    summarize_project_state() {
      return store.getProjectSummary();
    },
    summarize_memory_health() {
      return summarizeMemoryHealth(store);
    },
    run_doctor() {
      return runDoctor(rootDir, options.now === undefined ? {} : { now: options.now });
    },
    summarize_project_brief() {
      return readProjectBrief(rootDir);
    },
    refresh_project_summary(input) {
      const refreshOptions: ProjectSummaryOperationOptions = {};
      if (options.projectSummaryGenerator !== undefined) refreshOptions.generator = options.projectSummaryGenerator;
      if (options.now !== undefined) refreshOptions.now = options.now;
      if (input.force !== undefined) refreshOptions.force = input.force;
      return refreshProjectSummary(store, config, refreshOptions);
    }
  };
}

export function registerProjectMemoryTools(
  server: McpServer,
  store: MemoryStore,
  options: {
    rootDir?: string;
    projectSummaryGenerator?: ProjectSummaryGenerator;
    now?: () => Date;
    startupMetadata?: ProjectStartupMetadata | undefined;
  } = {}
): void {
  const handlers = createProjectMemoryToolHandlers(store, options);
  registerSourceToolGroup(server, handlers);
  registerMemoryToolGroup(server, handlers);
  registerInvestigationToolGroup(server, handlers);
  return;
}

function normalizeSourceFailureInput(input: {
  adapter?: SyncSourceName | undefined;
  resolved?: boolean | undefined;
  limit?: number | undefined;
}): { adapter?: SyncSourceName; resolved?: boolean; limit?: number } {
  const normalized: { adapter?: SyncSourceName; resolved?: boolean; limit?: number } = {};
  if (input.adapter !== undefined) normalized.adapter = input.adapter;
  if (input.resolved !== undefined) normalized.resolved = input.resolved;
  if (input.limit !== undefined) normalized.limit = input.limit;
  return normalized;
}

function normalizeSearchInput(input: {
  query: string;
  sourceTypes?: SourceType[] | undefined;
  limit?: number | undefined;
}): { query: string; sourceTypes?: SourceType[]; limit?: number } {
  const normalized: { query: string; sourceTypes?: SourceType[]; limit?: number } = {
    query: input.query
  };
  if (input.sourceTypes !== undefined) normalized.sourceTypes = input.sourceTypes;
  if (input.limit !== undefined) normalized.limit = input.limit;
  return normalized;
}

function normalizeDecisionInput(input: {
  topic?: string | undefined;
  limit?: number | undefined;
}): { topic?: string; limit?: number } {
  const normalized: { topic?: string; limit?: number } = {};
  if (input.topic !== undefined) normalized.topic = input.topic;
  if (input.limit !== undefined) normalized.limit = input.limit;
  return normalized;
}

function normalizeMemorySearchInput(input: {
  query?: string | undefined;
  type?: MemoryType | undefined;
  status?: "promoted" | "candidate" | undefined;
  qualityStatus?: MemoryQualityStatus | "all" | undefined;
  lifecycleStatus?: MemoryLifecycleStatus | "all" | undefined;
  limit?: number | undefined;
}): {
  query?: string;
  type?: MemoryType;
  status?: "promoted" | "candidate";
  qualityStatus?: MemoryQualityStatus | "all";
  lifecycleStatus?: MemoryLifecycleStatus | "all";
  limit?: number;
} {
  const normalized: {
    query?: string;
    type?: MemoryType;
    status?: "promoted" | "candidate";
    qualityStatus?: MemoryQualityStatus | "all";
    lifecycleStatus?: MemoryLifecycleStatus | "all";
    limit?: number;
  } = {};
  if (input.query !== undefined) normalized.query = input.query;
  if (input.type !== undefined) normalized.type = input.type;
  if (input.status !== undefined) normalized.status = input.status;
  if (input.qualityStatus !== undefined) normalized.qualityStatus = input.qualityStatus;
  if (input.lifecycleStatus !== undefined) normalized.lifecycleStatus = input.lifecycleStatus;
  if (input.limit !== undefined) normalized.limit = input.limit;
  return normalized;
}

function normalizeRememberMemoryInput(input: {
  type: MemoryType;
  text: string;
  title?: string | undefined;
  reason?: string | undefined;
  relatedFiles?: string[] | undefined;
  promote?: boolean | undefined;
  supersedesMemoryId?: string | undefined;
}): {
  type: MemoryType;
  text: string;
  title?: string;
  reason?: string;
  relatedFiles?: string[];
  promote?: boolean;
  supersedesMemoryId?: string;
} {
  const normalized: {
    type: MemoryType;
    text: string;
    title?: string;
    reason?: string;
    relatedFiles?: string[];
    promote?: boolean;
    supersedesMemoryId?: string;
  } = {
    type: input.type,
    text: input.text
  };
  if (input.title !== undefined) normalized.title = input.title;
  if (input.reason !== undefined) normalized.reason = input.reason;
  if (input.relatedFiles !== undefined) normalized.relatedFiles = input.relatedFiles;
  if (input.promote !== undefined) normalized.promote = input.promote;
  if (input.supersedesMemoryId !== undefined) normalized.supersedesMemoryId = input.supersedesMemoryId;
  return normalized;
}

function normalizeUpdateMemoryStatusInput(input: {
  memoryId: string;
  status: MemoryLifecycleStatus;
  reason: string;
  replacementMemoryId?: string | undefined;
}): {
  memoryId: string;
  status: MemoryLifecycleStatus;
  reason: string;
  replacementMemoryId?: string;
} {
  const reason = input.reason.trim();
  if (!reason) throw new Error("Memory lifecycle status reason is required");
  const normalized: {
    memoryId: string;
    status: MemoryLifecycleStatus;
    reason: string;
    replacementMemoryId?: string;
  } = {
    memoryId: input.memoryId,
    status: input.status,
    reason
  };
  if (input.replacementMemoryId !== undefined) normalized.replacementMemoryId = input.replacementMemoryId;
  return normalized;
}

function normalizeCommitInput(input: {
  query?: string | undefined;
  filePath?: string | undefined;
  limit?: number | undefined;
}): { query?: string; filePath?: string; limit?: number } {
  const normalized: { query?: string; filePath?: string; limit?: number } = {};
  if (input.query !== undefined) normalized.query = input.query;
  if (input.filePath !== undefined) normalized.filePath = input.filePath;
  if (input.limit !== undefined) normalized.limit = input.limit;
  return normalized;
}

function normalizeExplainInput(input: {
  filePath: string;
  lineNumber?: number | undefined;
  question?: string | undefined;
}): { filePath: string; lineNumber?: number; question?: string } {
  const normalized: { filePath: string; lineNumber?: number; question?: string } = {
    filePath: input.filePath
  };
  if (input.lineNumber !== undefined) normalized.lineNumber = input.lineNumber;
  if (input.question !== undefined) normalized.question = input.question;
  return normalized;
}

function normalizeInvestigationInput(input: {
  question: string;
  limit?: number | undefined;
}): { question: string; limit?: number } {
  const normalized: { question: string; limit?: number } = { question: input.question };
  if (input.limit !== undefined) normalized.limit = input.limit;
  return normalized;
}

function normalizeRecentActivityInput(input: {
  since?: string | undefined;
  until?: string | undefined;
  includeWorkingTree?: boolean | undefined;
}): { since?: string; until?: string; includeWorkingTree?: boolean } {
  const normalized: { since?: string; until?: string; includeWorkingTree?: boolean } = {};
  if (input.since !== undefined) normalized.since = input.since;
  if (input.until !== undefined) normalized.until = input.until;
  if (input.includeWorkingTree !== undefined) normalized.includeWorkingTree = input.includeWorkingTree;
  return normalized;
}

function normalizeTemporarySearchInput(input: {
  query: string;
  threadId?: string | undefined;
  sessionId?: string | undefined;
  limit?: number | undefined;
}): { query: string; threadId?: string; sessionId?: string; limit?: number } {
  const normalized: { query: string; threadId?: string; sessionId?: string; limit?: number } = {
    query: input.query
  };
  if (input.threadId !== undefined) normalized.threadId = input.threadId;
  if (input.sessionId !== undefined) normalized.sessionId = input.sessionId;
  if (input.limit !== undefined) normalized.limit = input.limit;
  return normalized;
}

function normalizeActiveContextInput(input: {
  threadId?: string | undefined;
  sessionId?: string | undefined;
  projectOnly?: boolean | undefined;
  limit?: number | undefined;
}): { threadId?: string; sessionId?: string; projectOnly?: boolean; limit?: number } {
  const normalized: { threadId?: string; sessionId?: string; projectOnly?: boolean; limit?: number } = {};
  if (input.threadId !== undefined) normalized.threadId = input.threadId;
  if (input.sessionId !== undefined) normalized.sessionId = input.sessionId;
  if (input.projectOnly !== undefined) normalized.projectOnly = input.projectOnly;
  if (input.limit !== undefined) normalized.limit = input.limit;
  return normalized;
}

function normalizeTemporaryCleanupInput(input: {
  expiredOnly?: boolean | undefined;
}): { expiredOnly: boolean } {
  return {
    expiredOnly: input.expiredOnly ?? true
  };
}

function normalizeSyncInput(input: {
  source?: SyncSourceName | "all" | undefined;
}): { source?: SyncSourceName | "all" } {
  const normalized: { source?: SyncSourceName | "all" } = {};
  if (input.source !== undefined) normalized.source = input.source;
  return normalized;
}

function summarizeActiveContext(
  store: MemoryStore,
  input: { threadId?: string; sessionId?: string; projectOnly?: boolean; limit?: number },
  nowFn?: () => Date
): ActiveContextSummary {
  const now = nowIso(nowFn);
  const memories = store.listActiveTemporaryMemory({
    ...input,
    now
  });
  const groups = groupTemporaryMemories(memories);
  const relatedFiles = [...new Set(memories.flatMap((memory) => memory.relatedFiles))].sort();
  const nearestExpiryAt = memories.map((memory) => memory.expiresAt).sort()[0];
  const scope: ActiveContextSummary["scope"] = {
    projectOnly: input.projectOnly ?? true
  };
  if (input.threadId !== undefined) scope.threadId = input.threadId;
  if (input.sessionId !== undefined) scope.sessionId = input.sessionId;
  const freshness: ActiveContextSummary["freshness"] = {
    activeTemporaryMemories: memories.length
  };
  if (nearestExpiryAt !== undefined) freshness.nearestExpiryAt = nearestExpiryAt;
  if (memories.length === 0) {
    freshness.warning = "No unexpired temporary working context was found for this project scope.";
  }
  return {
    generatedAt: now,
    scope,
    groups,
    relatedFiles,
    freshness
  };
}

function groupTemporaryMemories(memories: TemporaryMemory[]): ActiveContextSummary["groups"] {
  const groups: ActiveContextSummary["groups"] = {
    taskState: [],
    openQuestions: [],
    workingHypotheses: [],
    recentTests: [],
    fileContext: [],
    userInstructions: []
  };
  for (const memory of memories) {
    const key = temporaryGroupKey(memory.kind);
    groups[key].push(memory);
  }
  return groups;
}

function temporaryGroupKey(kind: TemporaryMemoryKind): keyof ActiveContextSummary["groups"] {
  switch (kind) {
    case "task_state":
      return "taskState";
    case "open_question":
      return "openQuestions";
    case "working_hypothesis":
      return "workingHypotheses";
    case "recent_test":
      return "recentTests";
    case "file_context":
      return "fileContext";
    case "user_instruction":
      return "userInstructions";
  }
}

interface RecentSourceRow {
  id: string;
  type: SourceType;
  title: string;
  origin: string;
  metadata_json: string;
  created_at: string;
}

interface RecentChunkRow {
  id: string;
  source_id: string;
  chunk_index: number;
  text: string;
  metadata_json: string;
}

interface RecentCommitRow {
  hash: string;
  authored_at: string;
  message: string;
  changed_files_json: string;
  diff_summary: string;
}

function summarizeRecentActivity(
  store: MemoryStore,
  rootDir: string,
  input: { since?: string; until?: string; includeWorkingTree?: boolean },
  nowFn?: () => Date
): RecentActivitySummary {
  const now = nowFn?.() ?? new Date();
  const since = input.since ? parseDateInput(input.since, "start") : threeDaysBefore(now);
  const until = input.until ? parseDateInput(input.until, "end") : now;
  const includeWorkingTree = input.includeWorkingTree ?? true;
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();

  const sourceRows = store.db
    .prepare(
      `select id, type, title, origin, metadata_json, created_at
       from sources
       order by created_at desc, id asc`
    )
    .all() as unknown as RecentSourceRow[];
  const sourcesInWindow = sourceRows.filter((source) =>
    dateInWindow(sourceActivityTimestamp(source), sinceIso, untilIso)
  );
  const conversationSources = sourcesInWindow.filter((source) => source.type === "conversation").slice(0, 20);
  const conversations = conversationSources.map((source) => {
    const metadata = parseJsonObjectLocal(source.metadata_json);
    const chunks = store.db
      .prepare(
        `select id, source_id, chunk_index, text, metadata_json
         from chunks
         where source_id = ?
         order by chunk_index asc
         limit 5`
      )
      .all(source.id) as unknown as RecentChunkRow[];
    const timestamp = stringValue(metadata.timestamp) ?? stringValue(metadata.createdAt);
    return {
      sourceId: source.id,
      title: source.title,
      origin: source.origin,
      createdAt: source.created_at,
      ...(timestamp ? { timestamp } : {}),
      chunks: chunks.map((chunk) => ({
        chunkId: chunk.id,
        text: chunk.text,
        metadata: parseJsonObjectLocal(chunk.metadata_json)
      }))
    };
  });

  const commitRows = store.db
    .prepare(
      `select hash, authored_at, message, changed_files_json, diff_summary
       from commits
       order by authored_at desc, hash asc`
    )
    .all() as unknown as RecentCommitRow[];
  const commits = commitRows
    .filter((commit) => dateInWindow(commit.authored_at, sinceIso, untilIso))
    .slice(0, 20)
    .map((commit) => ({
      hash: commit.hash,
      authoredAt: commit.authored_at,
      message: commit.message,
      changedFiles: parseJsonArrayLocal(commit.changed_files_json),
      diffSummary: commit.diff_summary
    }));

  const latestIndexedSourceAt = sourceRows
    .map(sourceActivityTimestamp)
    .filter((value): value is string => value !== undefined)
    .sort()
    .at(-1);
  const projectSummary = store.getProjectSummary();
  const freshness: RecentActivitySummary["freshness"] = {
    hasIndexedSourcesInWindow: sourcesInWindow.length > 0,
    ...(latestIndexedSourceAt ? { latestIndexedSourceAt } : {}),
    ...(projectSummary.lastSyncAt ? { lastSyncAt: projectSummary.lastSyncAt } : {})
  };
  if (sourcesInWindow.length === 0) {
    freshness.warning = `No Code Butler sources indexed for ${formatHumanDate(since)}; run \`code-butler watch\` or \`sync_project_memory\` after logs flush.`;
  } else {
    const projectBrief = readProjectBrief(rootDir);
    const summaryCheckedAt = projectBrief.meta?.lastCheckedAt ?? projectBrief.meta?.lastGeneratedAt;
    if (projectSummary.lastSyncAt && summaryCheckedAt && dateIsBefore(summaryCheckedAt, projectSummary.lastSyncAt)) {
      freshness.warning = "Project summary is older than the latest successful sync; run `code-butler project-summary refresh` or confirm the background watcher is running.";
    }
  }
  const workingTree = includeWorkingTree ? readWorkingTree(rootDir) : emptyWorkingTree(false);
  const highlights = summarizeRecentHighlights(conversations, commits, workingTree);
  const summary = highlights.map((highlight) => highlight.text).slice(0, 8);

  return {
    window: {
      since: sinceIso,
      until: untilIso
    },
    summary,
    highlights,
    conversations,
    commits,
    workingTree,
    why: summary,
    freshness
  };
}

function parseDateInput(input: string, boundary: "start" | "end"): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [year, month, day] = input.split("-").map(Number);
    if (year !== undefined && month !== undefined && day !== undefined) {
      return boundary === "start"
        ? new Date(year, month - 1, day, 0, 0, 0, 0)
        : new Date(year, month - 1, day, 23, 59, 59, 999);
    }
  }
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date input: ${input}`);
  return parsed;
}

function threeDaysBefore(date: Date): Date {
  return new Date(date.getTime() - 3 * 24 * 60 * 60 * 1000);
}

function sourceActivityTimestamp(source: RecentSourceRow): string | undefined {
  const metadata = parseJsonObjectLocal(source.metadata_json);
  return stringValue(metadata.timestamp) ?? stringValue(metadata.authoredAt) ?? stringValue(metadata.createdAt) ?? source.created_at;
}

function dateInWindow(value: string | undefined, sinceIso: string, untilIso: string): boolean {
  if (value === undefined) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const iso = date.toISOString();
  return iso >= sinceIso && iso <= untilIso;
}

function dateIsBefore(left: string, right: string): boolean {
  const leftDate = new Date(left);
  const rightDate = new Date(right);
  if (Number.isNaN(leftDate.getTime()) || Number.isNaN(rightDate.getTime())) return false;
  return leftDate.getTime() < rightDate.getTime();
}

function readWorkingTree(rootDir: string): RecentActivitySummary["workingTree"] {
  try {
    const status = execGit(rootDir, ["status", "--short", "--untracked-files=all"]);
    const diffStat = execGit(rootDir, ["diff", "--stat"]);
    return {
      requested: true,
      available: true,
      status: status.split("\n").filter(Boolean),
      diffStat: diffStat.split("\n").filter(Boolean)
    };
  } catch (error) {
    return {
      ...emptyWorkingTree(true),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function execGit(rootDir: string, args: string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function emptyWorkingTree(requested: boolean): RecentActivitySummary["workingTree"] {
  return {
    requested,
    available: false,
    status: [],
    diffStat: []
  };
}

function summarizeRecentHighlights(
  conversations: RecentActivitySummary["conversations"],
  commits: RecentActivitySummary["commits"],
  workingTree: RecentActivitySummary["workingTree"]
): RecentActivitySummary["highlights"] {
  const highlights: RecentActivitySummary["highlights"] = [];

  for (const commit of commits.slice(0, 8)) {
    highlights.push({
      kind: "commit",
      text: commitHighlightText(commit),
      evidence: { sourceType: "commit", sourceId: commit.hash },
      relatedFiles: commit.changedFiles
    });
  }

  if (workingTree.available && (workingTree.status.length > 0 || workingTree.diffStat.length > 0)) {
    const statusCount = workingTree.status.length;
    const firstStat = workingTree.diffStat[0];
    highlights.push({
      kind: "working_tree",
      text: firstStat
        ? `Working tree: ${statusCount} changed or untracked path(s); ${firstStat}.`
        : `Working tree: ${statusCount} changed or untracked path(s).`
    });
  }

  const seenConversationText = new Set<string>();
  for (const conversation of conversations) {
    for (const chunk of conversation.chunks) {
      const text = cleanRecentActivityText(chunk.text);
      if (!text || seenConversationText.has(text)) continue;
      seenConversationText.add(text);
      highlights.push({
        kind: "conversation",
        text: `Conversation context: ${text}`,
        evidence: { sourceType: "conversation", sourceId: conversation.sourceId, locator: chunk.chunkId },
        sourceId: conversation.sourceId
      });
      if (highlights.filter((highlight) => highlight.kind === "conversation").length >= 5) return highlights;
    }
  }

  return highlights;
}

function commitHighlightText(commit: RecentActivitySummary["commits"][number]): string {
  const hash = commit.hash.slice(0, 12);
  const files = commit.changedFiles.slice(0, 3).join(", ");
  const suffix = files ? ` (${files}${commit.changedFiles.length > 3 ? ", ..." : ""}).` : ".";
  return `Commit ${hash}: ${commit.message}${suffix}`;
}

function cleanRecentActivityText(value: string): string | undefined {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed || isNoisyRecentActivityText(collapsed)) return undefined;
  return truncateText(collapsed, 220);
}

function isNoisyRecentActivityText(value: string): boolean {
  const lower = value.toLowerCase();
  return [
    "<permissions instructions",
    "filesystem sandboxing defines",
    "# agents.md instructions",
    "# claude.md instructions",
    "the following is the codex agent history",
    "approval request start",
    "planned action json",
    "<environment_context>",
    "<skills_instructions>",
    "<plugins_instructions>",
    "tool exec_command call",
    "tool exec_command result",
    "original token count",
    "wall time:"
  ].some((pattern) => lower.includes(pattern));
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}...`;
}

function parseJsonObjectLocal(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseJsonArrayLocal(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nowIso(nowFn?: () => Date): string {
  return (nowFn?.() ?? new Date()).toISOString();
}

function formatHumanDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function normalizeProjectSummaryRefreshInput(input: { force?: boolean | undefined }): { force?: boolean } {
  const normalized: { force?: boolean } = {};
  if (input.force !== undefined) normalized.force = input.force;
  return normalized;
}

function decorateSearchResult(store: MemoryStore, result: SearchResult): SearchResult {
  const citations = resolveEvidenceCitations(store, {
    evidence: [result.evidence]
  });
  return {
    ...result,
    citations,
    trust: buildTrustSummary({
      status: "active",
      evidence: [result.evidence],
      citations,
      reasons: []
    })
  };
}

function asJsonContent(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}
