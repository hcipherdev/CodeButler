import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";

import type { CodexLogSourceConfig, ConversationLogSourceConfig, MemoryChunk, MemorySource, SyncSourceName } from "../types.js";
import type { ExtractorConversationInput } from "../types.js";
import type { MemoryStore } from "../storage/store.js";

export interface ConversationSyncResult {
  imported: number;
  conversations: ExtractorConversationInput[];
}

export interface ConversationSourceRootStatus {
  root: string;
  exists: boolean;
  found: number;
  indexed: number;
  pending: number;
  ignored: number;
  parseFailures: number;
  latestLogAt?: string | undefined;
}

export interface ConversationSourceStatus {
  source: "codex" | "claude";
  enabled: boolean;
  projectOnly: boolean;
  roots: ConversationSourceRootStatus[];
  totals: {
    found: number;
    indexed: number;
    pending: number;
    ignored: number;
    parseFailures: number;
  };
}

export function syncCodexSource(
  store: MemoryStore,
  config: CodexLogSourceConfig,
  projectRoot: string
): ConversationSyncResult {
  return syncConversationLogSource(store, "codex", config, projectRoot, parseCodexFile);
}

export function syncClaudeSource(
  store: MemoryStore,
  config: ConversationLogSourceConfig,
  projectRoot: string
): ConversationSyncResult {
  return syncConversationLogSource(store, "claude", config, projectRoot, parseClaudeFile);
}

export function getCodexSourceStatus(
  store: MemoryStore,
  config: CodexLogSourceConfig,
  projectRoot: string
): ConversationSourceStatus {
  return getConversationSourceStatus(store, "codex", config, projectRoot, parseCodexFile);
}

export function getClaudeSourceStatus(
  store: MemoryStore,
  config: ConversationLogSourceConfig,
  projectRoot: string
): ConversationSourceStatus {
  return getConversationSourceStatus(store, "claude", config, projectRoot, parseClaudeFile);
}

function syncConversationLogSource(
  store: MemoryStore,
  sourceName: "codex" | "claude",
  config: ConversationLogSourceConfig,
  projectRoot: string,
  parser: (filePath: string) => ParsedConversationLog | undefined
): ConversationSyncResult {
  const conversations: ExtractorConversationInput[] = [];
  let imported = 0;

  for (const root of config.roots) {
    for (const filePath of findJsonlFiles(root)) {
      const signature = fileSignature(filePath);
      const cursor = store.getSyncCursor(sourceName, filePath)?.cursorValue;
      if (cursor === signature) continue;
      const parsed = parser(filePath);
      if (!parsed) continue;
      if (!shouldIncludeConversation(parsed, filePath, projectRoot, config.projectOnly)) continue;
      store.setSyncCursor(sourceName, filePath, signature);
      store.addSourceWithChunks({ source: parsed.source, chunks: parsed.chunks });
      const conversation: ExtractorConversationInput = {
        sourceId: parsed.source.id!,
        title: parsed.source.title,
        rawContent: parsed.source.rawContent,
        chunks: parsed.chunks
      };
      if (parsed.source.metadata !== undefined) {
        conversation.metadata = parsed.source.metadata;
      }
      conversations.push(conversation);
      imported += 1;
    }
  }

  return { imported, conversations };
}

function getConversationSourceStatus(
  store: MemoryStore,
  sourceName: "codex" | "claude",
  config: ConversationLogSourceConfig,
  projectRoot: string,
  parser: (filePath: string) => ParsedConversationLog | undefined
): ConversationSourceStatus {
  const roots = config.roots.map<ConversationSourceRootStatus>((root) => {
    const files = findJsonlFiles(root);
    const status: ConversationSourceRootStatus = {
      root,
      exists: existsSync(root),
      found: files.length,
      indexed: 0,
      pending: 0,
      ignored: 0,
      parseFailures: 0
    };
    let latestMtime = 0;
    for (const filePath of files) {
      latestMtime = Math.max(latestMtime, statSync(filePath).mtimeMs);
      const parsed = parser(filePath);
      if (!parsed) {
        status.parseFailures += 1;
        continue;
      }
      if (!shouldIncludeConversation(parsed, filePath, projectRoot, config.projectOnly)) {
        status.ignored += 1;
        continue;
      }
      const signature = fileSignature(filePath);
      const cursor = store.getSyncCursor(sourceName, filePath)?.cursorValue;
      if (cursor === signature) {
        status.indexed += 1;
      } else {
        status.pending += 1;
      }
    }
    if (latestMtime > 0) status.latestLogAt = new Date(latestMtime).toISOString();
    return status;
  });

  return {
    source: sourceName,
    enabled: config.enabled,
    projectOnly: config.projectOnly,
    roots,
    totals: roots.reduce(
      (totals, root) => ({
        found: totals.found + root.found,
        indexed: totals.indexed + root.indexed,
        pending: totals.pending + root.pending,
        ignored: totals.ignored + root.ignored,
        parseFailures: totals.parseFailures + root.parseFailures
      }),
      { found: 0, indexed: 0, pending: 0, ignored: 0, parseFailures: 0 }
    )
  };
}

interface ParsedConversationLog {
  source: MemorySource;
  chunks: MemoryChunk[];
}

function parseCodexFile(filePath: string): ParsedConversationLog | undefined {
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let sessionId: string | undefined;
  let cwd: string | undefined;
  const chunks: MemoryChunk[] = [];
  const transcript: string[] = [];

  for (const line of lines) {
    const parsed = safeParseJson(line);
    if (!parsed) continue;
    const record = parsed as Record<string, unknown>;
    if (!sessionId && record.type === "session_meta") {
      const payload = asRecord(record.payload);
      if (typeof payload?.id === "string") sessionId = payload.id;
      if (typeof payload?.cwd === "string") cwd = payload.cwd;
      continue;
    }
    if (record.type !== "response_item") continue;
    const payload = asRecord(record.payload);
    if (payload?.type !== "message") continue;
    const role = typeof payload.role === "string" ? payload.role : undefined;
    const text = extractCodexContent(payload.content);
    if (!role || !text) continue;
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;
    transcript.push(`${role}: ${text}`);
    chunks.push({
      chunkIndex: chunks.length,
      text,
      metadata: {
        role,
        timestamp,
        adapter: "codex",
        sessionId,
        cwd,
        filePath
      }
    });
  }

  if (chunks.length === 0) return undefined;
  const resolvedSessionId = sessionId ?? basename(filePath, extname(filePath));
  return {
    source: {
      id: `codex:${resolvedSessionId}`,
      type: "conversation",
      title: basename(filePath),
      origin: filePath,
      rawContent: transcript.join("\n\n"),
      metadata: {
        adapter: "codex",
        sessionId: resolvedSessionId,
        cwd,
        filePath
      }
    },
    chunks
  };
}

function parseClaudeFile(filePath: string): ParsedConversationLog | undefined {
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let sessionId: string | undefined;
  let cwd: string | undefined;
  const chunks: MemoryChunk[] = [];
  const transcript: string[] = [];

  for (const line of lines) {
    const parsed = safeParseJson(line);
    if (!parsed) continue;
    const record = parsed as Record<string, unknown>;
    if (!sessionId && typeof record.sessionId === "string") {
      sessionId = record.sessionId;
    }
    if (!cwd && typeof record.cwd === "string") {
      cwd = record.cwd;
    }
    const message = asRecord(record.message);
    const role = typeof message?.role === "string" ? message.role : typeof record.type === "string" ? record.type : undefined;
    const text = extractClaudeContent(message?.content);
    if (!role || !text) continue;
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;
    transcript.push(`${role}: ${text}`);
    chunks.push({
      chunkIndex: chunks.length,
      text,
      metadata: {
        role,
        timestamp,
        adapter: "claude",
        sessionId,
        cwd,
        filePath
      }
    });
  }

  if (chunks.length === 0) return undefined;
  const resolvedSessionId = sessionId ?? basename(filePath, extname(filePath));
  return {
    source: {
      id: `claude:${resolvedSessionId}`,
      type: "conversation",
      title: basename(filePath),
      origin: filePath,
      rawContent: transcript.join("\n\n"),
      metadata: {
        adapter: "claude",
        sessionId: resolvedSessionId,
        cwd,
        filePath
      }
    },
    chunks
  };
}

function shouldIncludeConversation(
  parsed: ParsedConversationLog,
  filePath: string,
  projectRoot: string,
  projectOnly: boolean
): boolean {
  if (!projectOnly) return true;
  const normalizedProjectRoot = normalizePath(projectRoot);
  const encodedProjectRoot = encodeProjectPath(normalizedProjectRoot);
  const metadata = parsed.source.metadata ?? {};
  const cwd = typeof metadata.cwd === "string" ? normalizePath(metadata.cwd) : undefined;
  if (cwd && isSameOrInside(cwd, normalizedProjectRoot)) return true;
  const normalizedFilePath = normalizePath(filePath);
  if (isSameOrInside(normalizedFilePath, normalizedProjectRoot)) return true;
  return normalizedFilePath.includes(encodedProjectRoot);
}

function normalizePath(path: string): string {
  return resolve(path);
}

function isSameOrInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function encodeProjectPath(path: string): string {
  return path.replace(/^\/+/, "").replaceAll("/", "-");
}

function findJsonlFiles(root: string): string[] {
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return findJsonlFiles(path);
      return entry.isFile() && extname(entry.name).toLowerCase() === ".jsonl" ? [path] : [];
    });
  } catch {
    return [];
  }
}

function fileSignature(filePath: string): string {
  const stats = statSync(filePath);
  return `${stats.mtimeMs}:${stats.size}`;
}

function extractCodexContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      const record = asRecord(item);
      if (!record) return "";
      if (record.type === "input_text" || record.type === "output_text") {
        return typeof record.text === "string" ? record.text.trim() : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractClaudeContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      const record = asRecord(item);
      if (!record || record.type !== "text") return "";
      return typeof record.text === "string" ? record.text.trim() : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function safeParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
