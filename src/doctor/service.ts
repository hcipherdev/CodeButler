import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadExistingProjectConfig } from "../config.js";
import { getProjectSummaryStatus } from "../project-summary/service.js";
import { getClaudeSourceStatus, getCodexSourceStatus, type ConversationSourceStatus } from "../sources/codex.js";
import type { MemoryStore } from "../storage/store.js";
import type {
  DoctorCheck,
  DoctorNextAction,
  DoctorReport,
  DoctorStatus,
  ExtractorConfig,
  InvestigatorConfig,
  ProjectConfig,
  SyncCursor,
  SyncSourceName,
  SyncStatus
} from "../types.js";

const STALE_SYNC_MS = 24 * 60 * 60 * 1000;
const KEY_TABLES = [
  "sources",
  "chunks",
  "commits",
  "decisions",
  "sync_cursors",
  "sync_sources",
  "memory_candidates",
  "memories",
  "temporary_memories"
] as const;
const REQUIRED_QUALITY_COLUMNS = ["quality_status", "quality_reasons_json", "last_verified_at"] as const;
const SYNC_SOURCES: SyncSourceName[] = ["git", "codex", "claude"];

export interface DoctorRunOptions {
  now?: () => Date;
}

interface DoctorStorageState {
  databasePath: string;
  db?: DatabaseSync;
  readable: boolean;
  readableTables: Set<string>;
  qualityColumnsAvailable: boolean;
}

interface SyncStatusRow {
  source: SyncSourceName;
  enabled: number;
  last_sync_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  metadata_json: string;
}

interface SyncCursorRow {
  source: SyncSourceName;
  cursor_key: string;
  cursor_value: string;
  updated_at: string;
}

interface MemoryQualityRow {
  quality_status: "active" | "needs_review" | "quarantined";
  quality_reasons_json: string;
}

interface MemoryHealthSummary {
  scanned: number;
  active: number;
  needsReview: number;
  quarantined: number;
  rejected: number;
  topReasons: Array<{ reason: string; count: number }>;
}

export function runDoctor(rootDir: string, options: DoctorRunOptions = {}): DoctorReport {
  const projectRoot = resolve(rootDir);
  const now = (options.now ?? (() => new Date()))();
  const checks: DoctorCheck[] = [];
  const nextActions: DoctorNextAction[] = [];

  const addCheck = (check: DoctorCheck): void => {
    checks.push(check);
  };
  const addAction = (action: DoctorNextAction): void => {
    if (nextActions.some((existing) => existing.command === action.command)) return;
    nextActions.push(action);
  };

  const configPath = join(projectRoot, ".code-butler", "config.json");
  let config: ProjectConfig | undefined;

  if (!existsSync(configPath)) {
    addCheck({
      id: "config:exists",
      category: "project",
      status: "error",
      title: "Project config is missing",
      detail: `No config found at ${configPath}.`
    });
    addAction({
      priority: "high",
      command: "code-butler init",
      reason: "Create the project-local config and SQLite store before using Code Butler."
    });
  } else {
    addCheck({
      id: "config:exists",
      category: "project",
      status: "ok",
      title: "Project config exists",
      detail: configPath
    });
    try {
      config = loadExistingProjectConfig(projectRoot);
      addCheck({
        id: "config:load",
        category: "project",
        status: "ok",
        title: "Project config parses",
        detail: "Configuration loaded without writing defaults."
      });
    } catch (error) {
      addCheck({
        id: "config:load",
        category: "project",
        status: "error",
        title: "Project config does not parse",
        detail: messageFromError(error)
      });
      addAction({
        priority: "high",
        command: "edit .code-butler/config.json",
        reason: "Fix the config JSON before running sync or MCP tools."
      });
    }
  }

  const storage = inspectStorage(projectRoot);
  addCheck(storage.check);
  if (storage.check.status !== "ok") {
    addAction({
      priority: storage.check.status === "error" ? "high" : "medium",
      command: "code-butler init",
      reason: "Initialize or migrate the local SQLite store."
    });
  }

  try {
    if (config !== undefined) {
      addProjectChecks(config, addCheck, addAction);
      addSourceChecks(config, storage, addCheck, addAction);
      addSyncChecks(config, storage, now, addCheck, addAction);
      addExtractorChecks(config, addCheck, addAction);
    }
    addSummaryCheck(projectRoot, now, addCheck, addAction);
    addMemoryCheck(storage, addCheck, addAction);
  } finally {
    storage.db?.close();
  }

  return {
    status: aggregateStatus(checks),
    generatedAt: now.toISOString(),
    projectRoot,
    checks,
    nextActions: sortActions(nextActions)
  };
}

function addProjectChecks(
  config: ProjectConfig,
  addCheck: (check: DoctorCheck) => void,
  addAction: (action: DoctorNextAction) => void
): void {
  const repoPath = config.sources.git.repoPath;
  const repoExists = pathExists(repoPath);
  if (!repoExists) {
    addCheck({
      id: "project:repo_path",
      category: "project",
      status: config.sources.git.enabled ? "error" : "warning",
      title: "Configured repository path is missing",
      detail: repoPath,
      metadata: { gitEnabled: config.sources.git.enabled }
    });
    addAction({
      priority: config.sources.git.enabled ? "high" : "medium",
      command: "edit .code-butler/config.json",
      reason: "Point sources.git.repoPath at the project repository."
    });
    return;
  }

  addCheck({
    id: "project:repo_path",
    category: "project",
    status: "ok",
    title: "Configured repository path exists",
    detail: repoPath
  });

  if (!config.sources.git.enabled) {
    addCheck({
      id: "project:git_config",
      category: "project",
      status: "ok",
      title: "Git source is disabled",
      detail: "Git sync checks will not run until sources.git.enabled is true."
    });
    return;
  }

  const gitDir = join(repoPath, ".git");
  const gitConfigured = pathExists(gitDir);
  addCheck({
    id: "project:git_config",
    category: "project",
    status: gitConfigured ? "ok" : "warning",
    title: gitConfigured ? "Git source is coherent" : "Git source points at a non-Git directory",
    detail: gitConfigured ? gitDir : `Expected a Git directory at ${gitDir}.`
  });
}

function inspectStorage(rootDir: string): DoctorStorageState & { check: DoctorCheck } {
  const databasePath = join(rootDir, ".code-butler", "memory.sqlite");
  if (!existsSync(databasePath)) {
    return {
      databasePath,
      readable: false,
      readableTables: new Set(),
      qualityColumnsAvailable: false,
      check: {
        id: "storage:sqlite",
        category: "storage",
        status: "warning",
        title: "SQLite store is missing",
        detail: `No database found at ${databasePath}.`
      }
    };
  }

  try {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    const readableTables = new Set<string>();
    const missingTables: string[] = [];
    const counts: Record<string, number> = {};
    for (const table of KEY_TABLES) {
      if (!tableExists(db, table)) {
        missingTables.push(table);
        continue;
      }
      readableTables.add(table);
      counts[table] = countRows(db, table);
    }

    const missingQualityColumns = ["memory_candidates", "memories"].flatMap((table) => {
      if (!readableTables.has(table)) return [];
      const columns = tableColumns(db, table);
      return REQUIRED_QUALITY_COLUMNS.filter((column) => !columns.has(column)).map((column) => `${table}.${column}`);
    });

    if (missingTables.length > 0 || missingQualityColumns.length > 0) {
      return {
        databasePath,
        db,
        readable: false,
        readableTables,
        qualityColumnsAvailable: false,
        check: {
          id: "storage:sqlite",
          category: "storage",
          status: "error",
          title: "SQLite store needs migration",
          detail: [...missingTables.map((table) => `missing table ${table}`), ...missingQualityColumns].join(", "),
          metadata: { databasePath, counts }
        }
      };
    }

    return {
      databasePath,
      db,
      readable: true,
      readableTables,
      qualityColumnsAvailable: true,
      check: {
        id: "storage:sqlite",
        category: "storage",
        status: "ok",
        title: "SQLite store is readable",
        detail: databasePath,
        metadata: { counts }
      }
    };
  } catch (error) {
    return {
      databasePath,
      readable: false,
      readableTables: new Set(),
      qualityColumnsAvailable: false,
      check: {
        id: "storage:sqlite",
        category: "storage",
        status: "error",
        title: "SQLite store cannot be opened",
        detail: messageFromError(error),
        metadata: { databasePath }
      }
    };
  }
}

function addSourceChecks(
  config: ProjectConfig,
  storage: DoctorStorageState,
  addCheck: (check: DoctorCheck) => void,
  addAction: (action: DoctorNextAction) => void
): void {
  addCheck({
    id: "sources:git",
    category: "sources",
    status: !config.sources.git.enabled || pathExists(config.sources.git.repoPath) ? "ok" : "error",
    title: config.sources.git.enabled ? "Git source is configured" : "Git source is disabled",
    detail: `repoPath=${config.sources.git.repoPath}`
  });

  const cursorStore = createCursorStore(storage);
  for (const source of ["codex", "claude"] as const) {
    try {
      const status =
        source === "codex"
          ? getCodexSourceStatus(cursorStore, config.sources.codex, config.sources.git.repoPath)
          : getClaudeSourceStatus(cursorStore, config.sources.claude, config.sources.git.repoPath);
      addConversationSourceCheck(status, addCheck, addAction);
    } catch (error) {
      addCheck({
        id: `sources:${source}`,
        category: "sources",
        status: "error",
        title: `${source} source status failed`,
        detail: messageFromError(error)
      });
      addAction({
        priority: "medium",
        command: "code-butler sources status",
        reason: "Inspect configured conversation source roots."
      });
    }
  }
}

function addConversationSourceCheck(
  status: ConversationSourceStatus,
  addCheck: (check: DoctorCheck) => void,
  addAction: (action: DoctorNextAction) => void
): void {
  const missingRoots = status.roots.filter((root) => !root.exists);
  const hasParseFailures = status.totals.parseFailures > 0;
  const checkStatus: DoctorStatus = !status.enabled
    ? "ok"
    : missingRoots.length > 0 || hasParseFailures
      ? "warning"
      : "ok";
  const detail = [
    `enabled=${status.enabled}`,
    `projectOnly=${status.projectOnly}`,
    `found=${status.totals.found}`,
    `indexed=${status.totals.indexed}`,
    `pending=${status.totals.pending}`,
    `ignored=${status.totals.ignored}`,
    `parseFailures=${status.totals.parseFailures}`
  ].join(" ");

  addCheck({
    id: `sources:${status.source}`,
    category: "sources",
    status: checkStatus,
    title:
      checkStatus === "warning"
        ? `${status.source} source needs attention`
        : status.enabled
          ? `${status.source} source is configured`
          : `${status.source} source is disabled`,
    detail,
    metadata: {
      roots: status.roots,
      missingRoots: missingRoots.map((root) => root.root),
      totals: status.totals
    }
  });

  if (checkStatus === "warning") {
    addAction({
      priority: "medium",
      command: "code-butler sources status",
      reason: "Review missing roots or parse failures in configured conversation sources."
    });
  }
}

function addSyncChecks(
  config: ProjectConfig,
  storage: DoctorStorageState,
  now: Date,
  addCheck: (check: DoctorCheck) => void,
  addAction: (action: DoctorNextAction) => void
): void {
  const statuses = readSyncStatuses(storage);
  for (const source of SYNC_SOURCES) {
    const status = statuses[source];
    const enabled = isSourceEnabled(config, source) || status?.enabled === true;
    if (!enabled) {
      addCheck({
        id: `sync:${source}`,
        category: "sync",
        status: "ok",
        title: `${source} sync is disabled`,
        detail: "No freshness requirement applies while this source is disabled."
      });
      continue;
    }

    if (status?.lastError) {
      addCheck({
        id: `sync:${source}`,
        category: "sync",
        status: "error",
        title: `${source} sync has a recorded error`,
        detail: status.lastError,
        metadata: recordFrom(status)
      });
      addAction({
        priority: "high",
        command: "code-butler sync",
        reason: `Clear the recorded ${source} sync error.`
      });
      continue;
    }

    if (!status?.lastSuccessAt) {
      addCheck({
        id: `sync:${source}`,
        category: "sync",
        status: "warning",
        title: `${source} has never synced successfully`,
        detail: "No successful sync timestamp is recorded.",
        metadata: status ? recordFrom(status) : undefined
      });
      addAction({
        priority: "medium",
        command: "code-butler sync",
        reason: "Bring enabled sources up to date."
      });
      continue;
    }

    const syncedAt = Date.parse(status.lastSuccessAt);
    const stale = Number.isFinite(syncedAt) && now.getTime() - syncedAt > STALE_SYNC_MS;
    addCheck({
      id: `sync:${source}`,
      category: "sync",
      status: stale ? "warning" : "ok",
      title: stale ? `${source} sync is stale` : `${source} sync is fresh`,
      detail: `lastSuccessAt=${status.lastSuccessAt}`,
      metadata: recordFrom(status)
    });
    if (stale) {
      addAction({
        priority: "medium",
        command: "code-butler sync",
        reason: "Refresh sources older than 24 hours."
      });
    }
  }
}

function addSummaryCheck(
  rootDir: string,
  now: Date,
  addCheck: (check: DoctorCheck) => void,
  addAction: (action: DoctorNextAction) => void
): void {
  const status = getProjectSummaryStatus(rootDir, { now: () => now });
  const needsRefresh = !status.exists || status.stale || status.due;
  addCheck({
    id: "summary:freshness",
    category: "summary",
    status: needsRefresh ? "warning" : "ok",
    title: needsRefresh ? "Project summary needs refresh" : "Project summary is fresh",
    detail: `exists=${status.exists} due=${status.due} stale=${status.stale}`,
    metadata: recordFrom(status)
  });
  if (needsRefresh) {
    addAction({
      priority: "medium",
      command: "code-butler project-summary refresh",
      reason: "Refresh the narrative project summary used by agents."
    });
  }
}

function addExtractorChecks(
  config: ProjectConfig,
  addCheck: (check: DoctorCheck) => void,
  addAction: (action: DoctorNextAction) => void
): void {
  const missing = [
    ...missingProviderEnvVars("extractor", config.extractor),
    ...(config.investigator.enabled ? missingProviderEnvVars("investigator", config.investigator) : [])
  ];
  if (missing.length === 0) {
    addCheck({
      id: "extractor:credentials",
      category: "extractor",
      status: "ok",
      title: "Extractor and investigator credentials are present",
      detail: "Configured provider environment variables are available."
    });
    return;
  }

  const uniqueMissing = [...new Set(missing)];
  addCheck({
    id: "extractor:credentials",
    category: "extractor",
    status: "warning",
    title: "LLM provider credentials are missing",
    detail: uniqueMissing.join(", "),
    metadata: { missing: uniqueMissing }
  });
  addAction({
    priority: "low",
    command: "edit .code-butler/.env",
    reason: "Set provider credentials for LLM extraction and investigation. Deterministic mode still works without them."
  });
}

function addMemoryCheck(
  storage: DoctorStorageState,
  addCheck: (check: DoctorCheck) => void,
  addAction: (action: DoctorNextAction) => void
): void {
  if (!storage.db || !storage.readable || !storage.qualityColumnsAvailable) {
    addCheck({
      id: "memory:quality",
      category: "memory",
      status: "warning",
      title: "Memory quality health is unavailable",
      detail: "SQLite storage must be initialized and migrated before memory health can be read."
    });
    return;
  }

  try {
    const health = readMemoryHealth(storage.db);
    const needsAttention = health.needsReview > 0 || health.quarantined > 0;
    addCheck({
      id: "memory:quality",
      category: "memory",
      status: needsAttention ? "warning" : "ok",
      title: needsAttention ? "Memory quality needs review" : "Memory quality is clean",
      detail: `active=${health.active} needs_review=${health.needsReview} quarantined=${health.quarantined}`,
      metadata: recordFrom(health)
    });
    if (needsAttention) {
      addAction({
        priority: "medium",
        command: "code-butler memory audit --fix",
        reason: "Mark noisy or stale memories before they affect search results."
      });
    }
  } catch (error) {
    addCheck({
      id: "memory:quality",
      category: "memory",
      status: "error",
      title: "Memory quality health failed",
      detail: messageFromError(error)
    });
  }
}

function createCursorStore(storage: DoctorStorageState): MemoryStore {
  return {
    getSyncCursor(source: SyncSourceName, cursorKey: string): SyncCursor | undefined {
      if (!storage.db || !storage.readableTables.has("sync_cursors")) return undefined;
      const row = storage.db
        .prepare(
          `select source, cursor_key, cursor_value, updated_at
           from sync_cursors
           where source = ? and cursor_key = ?`
        )
        .get(source, cursorKey) as SyncCursorRow | undefined;
      if (!row) return undefined;
      return {
        source: row.source,
        cursorKey: row.cursor_key,
        cursorValue: row.cursor_value,
        updatedAt: row.updated_at
      };
    }
  } as MemoryStore;
}

function readSyncStatuses(storage: DoctorStorageState): Partial<Record<SyncSourceName, SyncStatus>> {
  if (!storage.db || !storage.readableTables.has("sync_sources")) return {};
  const rows = storage.db
    .prepare(
      `select source, enabled, last_sync_at, last_success_at, last_error, metadata_json
       from sync_sources`
    )
    .all() as unknown as SyncStatusRow[];
  const statuses: Partial<Record<SyncSourceName, SyncStatus>> = {};
  for (const row of rows) {
    const status: SyncStatus = {
      source: row.source,
      enabled: row.enabled === 1
    };
    if (row.last_sync_at !== null) status.lastSyncAt = row.last_sync_at;
    if (row.last_success_at !== null) status.lastSuccessAt = row.last_success_at;
    if (row.last_error !== null) status.lastError = row.last_error;
    status.metadata = parseJsonObject(row.metadata_json);
    statuses[row.source] = status;
  }
  return statuses;
}

function readMemoryHealth(db: DatabaseSync): MemoryHealthSummary {
  const rows = [
    ...(db
      .prepare(
        `select quality_status, quality_reasons_json
         from memory_candidates
         where promotion_state = 'candidate'`
      )
      .all() as unknown as MemoryQualityRow[]),
    ...(db
      .prepare(
        `select quality_status, quality_reasons_json
         from memories`
      )
      .all() as unknown as MemoryQualityRow[])
  ];
  const reasons = rows.flatMap((row) => parseStringArray(row.quality_reasons_json));
  return {
    scanned: rows.length,
    active: rows.filter((row) => row.quality_status === "active").length,
    needsReview: rows.filter((row) => row.quality_status === "needs_review").length,
    quarantined: rows.filter((row) => row.quality_status === "quarantined").length,
    rejected: rows.filter((row) => row.quality_status === "quarantined").length,
    topReasons: topReasons(reasons)
  };
}

function missingProviderEnvVars(label: "extractor" | "investigator", config: ExtractorConfig | InvestigatorConfig): string[] {
  const vars = [config.apiKeyEnv];
  if (config.provider === "anthropic-aws") {
    vars.push(config.workspaceIdEnv ?? "ANTHROPIC_AWS_WORKSPACE_ID");
    vars.push(config.regionEnv ?? "AWS_REGION");
  }
  return vars
    .filter((envVar): envVar is string => typeof envVar === "string" && envVar.length > 0)
    .filter((envVar) => process.env[envVar] === undefined || process.env[envVar] === "")
    .map((envVar) => `${label}:${envVar}`);
}

function isSourceEnabled(config: ProjectConfig, source: SyncSourceName): boolean {
  if (source === "git") return config.sources.git.enabled;
  if (source === "codex") return config.sources.codex.enabled;
  return config.sources.claude.enabled;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("select name from sqlite_master where type = 'table' and name = ?")
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`pragma table_info(${table})`).all() as unknown as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`select count(*) as count from ${table}`).get() as { count: number };
  return row.count;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function topReasons(reasons: string[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function recordFrom(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}

function aggregateStatus(checks: DoctorCheck[]): DoctorStatus {
  if (checks.some((check) => check.status === "error")) return "error";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ok";
}

function sortActions(actions: DoctorNextAction[]): DoctorNextAction[] {
  const priorityOrder = new Map<DoctorNextAction["priority"], number>([
    ["high", 0],
    ["medium", 1],
    ["low", 2]
  ]);
  return [...actions].sort(
    (left, right) =>
      (priorityOrder.get(left.priority) ?? 99) - (priorityOrder.get(right.priority) ?? 99) ||
      left.command.localeCompare(right.command)
  );
}

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
