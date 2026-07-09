import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createProjectMemoryToolHandlers } from "../src/mcp/tools.js";
import type { ProjectSummaryGenerator } from "../src/project-summary/service.js";
import { openMemoryStore } from "../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("MCP tool handlers", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  it("exposes search, read, explain, and summary handlers", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    const sourceId = store.addSourceWithChunks({
      source: {
        type: "conversation",
        title: "cache.md",
        origin: "manual-import",
        rawContent: "The cache changed to prevent stale reads in src/cache.ts."
      },
      chunks: [{ text: "The cache changed to prevent stale reads in src/cache.ts." }]
    });
    store.addCommit({
      hash: "abc123",
      authorName: "Test User",
      authorEmail: "test@example.com",
      authoredAt: "2026-06-01T10:00:00Z",
      message: "Change cache behavior",
      changedFiles: ["src/cache.ts"],
      diffSummary: "+ prevent stale reads"
    });

    const handlers = createProjectMemoryToolHandlers(store);

    expect(handlers.search_project_memory({ query: "stale reads", limit: 5 }).results[0]?.sourceId).toBe(
      sourceId
    );
    expect(handlers.read_memory_source({ sourceId })?.title).toBe("cache.md");
    expect((await handlers.explain_code_change({ filePath: "src/cache.ts" })).relatedCommits[0]?.hash).toBe(
      "abc123"
    );
    expect(handlers.summarize_project_state()).toMatchObject({
      sources: 2,
      commits: 1,
      decisions: 0
    });

    store.close();
  });

  it("reports the current project diagnostic metadata", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();

    const handlers = createProjectMemoryToolHandlers(store, {
      rootDir,
      startupMetadata: {
        configCreated: true,
        databaseCreated: true
      }
    });

    expect(handlers.current_project()).toEqual({
      rootDir,
      dataDir: join(rootDir, ".code-butler"),
      configPath: join(rootDir, ".code-butler", "config.json"),
      databasePath: join(rootDir, ".code-butler", "memory.sqlite"),
      configCreated: true,
      databaseCreated: true
    });

    store.close();
  });

  it("returns citation and trust fields and exposes memory health", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: {
        id: "conv-1",
        type: "conversation",
        title: "cache.md",
        origin: "manual-import",
        rawContent: "Use SQLite for local project memory."
      },
      chunks: [{ text: "Use SQLite for local project memory." }]
    });
    const active = store.upsertMemoryCandidate(
      {
        type: "decision",
        title: "Use SQLite",
        summary: "Use SQLite for local project memory.",
        reason: "Local-first memory needs durable embedded storage.",
        confidence: 0.91,
        evidence: [{ sourceType: "conversation", sourceId: "conv-1", locator: "conv-1:chunk:0" }],
        relatedFiles: ["src/storage/store.ts"],
        dedupeKey: "sqlite-memory"
      },
      { qualityStatus: "active", qualityReasons: [], lastVerifiedAt: "2026-06-01T10:00:00Z" }
    );
    store.promoteMemoryCandidate(active.id);
    store.upsertMemoryCandidate(
      {
        type: "constraint",
        title: "Bad HTML",
        summary: "</code></td><td>architecture.html</td>",
        reason: "Noisy import.",
        confidence: 0.8,
        evidence: [{ sourceType: "conversation", sourceId: "conv-1" }],
        relatedFiles: [],
        dedupeKey: "bad-html"
      },
      { qualityStatus: "quarantined", qualityReasons: ["html_or_markup_content"] }
    );

    const handlers = createProjectMemoryToolHandlers(store, { rootDir });
    const found = handlers.find_memories({ query: "SQLite", status: "promoted", limit: 5 });
    const all = handlers.find_memories({ qualityStatus: "all", limit: 10 });
    const state = handlers.summarize_project_state();
    const health = handlers.summarize_memory_health();

    expect(found.results[0]).toMatchObject({
      title: "Use SQLite",
      qualityStatus: "active",
      citations: expect.arrayContaining([
        expect.objectContaining({ kind: "conversation", sourceId: "conv-1", resolved: true })
      ]),
      trust: expect.objectContaining({
        status: "active",
        confidence: 0.91,
        resolvedEvidenceCount: 1,
        unresolvedEvidenceCount: 0
      })
    });
    expect(all.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Bad HTML",
          qualityStatus: "quarantined",
          trust: expect.objectContaining({ status: "quarantined" })
        })
      ])
    );
    expect(state.memoryHealth).toMatchObject({
      active: 1,
      quarantined: 1,
      needsReview: 0
    });
    expect(health.topReasons).toEqual([{ reason: "html_or_markup_content", count: 1 }]);

    store.close();
  });

  it("remembers project memory with resolvable evidence through the MCP handler", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    const handlers = createProjectMemoryToolHandlers(store, {
      rootDir,
      now: () => new Date("2026-07-09T20:00:00.000Z")
    });

    const remembered = handlers.remember_project_memory({
      type: "constraint",
      text: "Article templates must update datePublished to the current date before publishing.",
      title: "Article templates update datePublished",
      relatedFiles: ["main_web/article_update.sh"]
    });

    expect(remembered.memory).toMatchObject({
      kind: "promoted",
      type: "constraint",
      title: "Article templates update datePublished",
      summary: "Article templates must update datePublished to the current date before publishing.",
      confidence: 1,
      qualityStatus: "active",
      citations: [
        expect.objectContaining({
          kind: "conversation",
          resolved: true
        }),
        expect.objectContaining({
          kind: "file",
          sourceId: "main_web/article_update.sh"
        })
      ],
      trust: expect.objectContaining({
        status: "active",
        resolvedEvidenceCount: 1,
        unresolvedEvidenceCount: 0
      })
    });
    expect(remembered.sourceId).toMatch(/^manual-memory:/);
    expect(store.readSource(remembered.sourceId)?.rawContent).toContain("Article templates must update datePublished");
    expect(handlers.find_memories({ query: "datePublished", status: "promoted", limit: 5 }).results[0]).toMatchObject({
      id: remembered.memory.id,
      kind: "promoted"
    });

    store.close();
  });

  it("keeps repeated remember_project_memory calls idempotent", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    const handlers = createProjectMemoryToolHandlers(store, {
      rootDir,
      now: () => new Date("2026-07-09T20:00:00.000Z")
    });
    const input = {
      type: "constraint" as const,
      text: "Run article_update.sh after editing articlelist.json."
    };

    const first = handlers.remember_project_memory(input);
    const second = handlers.remember_project_memory(input);

    expect(second.memory.id).toBe(first.memory.id);
    expect(store.listMemories({ status: "promoted", query: "article_update", limit: 10 })).toHaveLength(1);
    expect(
      store.db.prepare("select count(*) as count from sources where id = ?").get(first.sourceId)
    ).toEqual({ count: 1 });

    store.close();
  });

  it("exposes project brief handlers without installing agent bootstrap files", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    writeFileSync(join(rootDir, "README.md"), "# MCP Project\n");
    writeFileSync(join(rootDir, "AGENTS.md"), "original agents");
    const store = openMemoryStore(rootDir);
    store.init();
    const generator: ProjectSummaryGenerator = {
      async generate() {
        return "# MCP Generated Brief\n";
      }
    };

    const handlers = createProjectMemoryToolHandlers(store, {
      rootDir,
      projectSummaryGenerator: generator,
      now: () => new Date("2026-06-16T10:00:00Z")
    });
    const refreshed = await handlers.refresh_project_summary({ force: true });
    const brief = await handlers.summarize_project_brief();

    expect(refreshed.generated).toBe(true);
    expect(brief.exists).toBe(true);
    expect(brief.summary).toContain("MCP Generated Brief");
    expect(brief.meta?.lastGeneratedAt).toBe("2026-06-16T10:00:00.000Z");
    expect(readFileSync(join(rootDir, "AGENTS.md"), "utf8")).toBe("original agents");
    expect(existsSync(join(rootDir, "AGENTS.md.code-butler-backup-2026-06-16T10-00-00-000Z"))).toBe(false);
    expect(existsSync(join(rootDir, "CLAUDE.md"))).toBe(false);

    store.close();
  });

  it("returns missing project brief without mutating files when no summary exists", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    writeFileSync(join(rootDir, "README.md"), "# Auto MCP Project\n");
    writeFileSync(join(rootDir, "AGENTS.md"), "old agents");
    const warnings: string[] = [];
    const store = openMemoryStore(rootDir);
    store.init();

    const handlers = createProjectMemoryToolHandlers(store, {
      rootDir,
      now: () => new Date("2026-06-16T10:00:00Z"),
      warn: (line) => warnings.push(line)
    });
    const brief = await handlers.summarize_project_brief();

    expect(brief.exists).toBe(false);
    expect(brief.summary).toBe("");
    expect(brief.meta).toBeUndefined();
    expect(readFileSync(join(rootDir, "AGENTS.md"), "utf8")).toBe("old agents");
    expect(existsSync(join(rootDir, "AGENTS.md.code-butler-backup-2026-06-16T10-00-00-000Z"))).toBe(false);
    expect(existsSync(join(rootDir, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(rootDir, ".code-butler", "project-summary.md"))).toBe(false);
    expect(warnings).toEqual([]);

    store.close();
  });

  it("sync_project_memory does not bootstrap an uninitialized project", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    mkdirSync(join(rootDir, ".code-butler"), { recursive: true });
    writeFileSync(
      join(rootDir, ".code-butler", "config.json"),
      JSON.stringify(
        {
          sources: {
            git: { enabled: false, repoPath: ".", hookInstall: false, maxCommits: 50, maxDiffChars: 12000 },
            codex: { enabled: false, roots: [], includeDefaultRoots: false },
            claude: { enabled: false, roots: [] }
          }
        },
        null,
        2
      )
    );
    const store = openMemoryStore(rootDir);
    store.init();

    const handlers = createProjectMemoryToolHandlers(store, { rootDir });
    const result = await handlers.sync_project_memory({});

    expect(result.memories.promoted).toBe(0);
    expect(existsSync(join(rootDir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(rootDir, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(rootDir, ".code-butler", "project-summary.md"))).toBe(false);

    store.close();
  });

  it("summarizes recent activity from timestamped conversations and commits", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    const todaySourceId = store.addSourceWithChunks({
      source: {
        id: "conversation-today",
        type: "conversation",
        title: "today-session.jsonl",
        origin: "codex",
        rawContent: "We fixed the cache invalidation path because stale reads were leaking through.",
        metadata: { timestamp: "2026-06-18T08:30:00.000Z" }
      },
      chunks: [{ text: "Fixed cache invalidation because stale reads were leaking through." }]
    });
    store.db
      .prepare("update sources set created_at = ? where id = ?")
      .run("2026-06-18T08:30:00.000Z", todaySourceId);
    store.addCommit({
      hash: "def456",
      authorName: "Test User",
      authorEmail: "test@example.com",
      authoredAt: "2026-06-18T09:00:00.000Z",
      message: "Fix cache invalidation",
      changedFiles: ["src/cache.ts"],
      diffSummary: "+ invalidate stale entries"
    });

    const handlers = createProjectMemoryToolHandlers(store, {
      rootDir,
      now: () => new Date("2026-06-18T12:00:00.000Z")
    });
    const recent = handlers.summarize_recent_activity({
      since: "2026-06-18T00:00:00.000Z",
      until: "2026-06-18T23:59:59.000Z",
      includeWorkingTree: false
    });

    expect(recent.conversations).toHaveLength(1);
    expect(recent.conversations[0]?.sourceId).toBe("conversation-today");
    expect(recent.commits.map((commit) => commit.hash)).toEqual(["def456"]);
    expect(recent.summary[0]).toBe("Commit def456: Fix cache invalidation (src/cache.ts).");
    expect(recent.highlights[0]).toMatchObject({
      kind: "commit",
      text: "Commit def456: Fix cache invalidation (src/cache.ts)."
    });
    expect(recent.why).toEqual([
      "Commit def456: Fix cache invalidation (src/cache.ts).",
      "Conversation context: Fixed cache invalidation because stale reads were leaking through."
    ]);
    expect(recent.freshness.hasIndexedSourcesInWindow).toBe(true);
    store.close();
  });

  it("filters noisy recent conversation chunks out of summary and why", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    const sourceId = store.addSourceWithChunks({
      source: {
        id: "conversation-noisy",
        type: "conversation",
        title: "noisy-session.jsonl",
        origin: "codex",
        rawContent: "Mixed noisy and useful content.",
        metadata: { timestamp: "2026-06-18T08:30:00.000Z" }
      },
      chunks: [
        { text: "<permissions instructions>\nFilesystem sandboxing defines which files can be read or written." },
        { text: "# AGENTS.md instructions for /Users/spiel/Documents/code-butler" },
        { text: "The npm publish path should use prepack before packing." }
      ]
    });
    store.db
      .prepare("update sources set created_at = ? where id = ?")
      .run("2026-06-18T08:30:00.000Z", sourceId);

    const handlers = createProjectMemoryToolHandlers(store, {
      rootDir,
      now: () => new Date("2026-06-18T12:00:00.000Z")
    });
    const recent = handlers.summarize_recent_activity({
      since: "2026-06-18T00:00:00.000Z",
      until: "2026-06-18T23:59:59.000Z",
      includeWorkingTree: false
    });

    expect(recent.conversations[0]?.chunks).toHaveLength(3);
    expect(recent.summary).toEqual(["Conversation context: The npm publish path should use prepack before packing."]);
    expect(recent.why).toEqual(["Conversation context: The npm publish path should use prepack before packing."]);
    expect(recent.why.join("\n")).not.toContain("permissions instructions");
    expect(recent.why.join("\n")).not.toContain("AGENTS.md instructions");
    store.close();
  });

  it("warns when the narrative project summary is older than the latest sync", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    mkdirSync(join(rootDir, ".code-butler"), { recursive: true });
    writeFileSync(join(rootDir, ".code-butler", "project-summary.md"), "# Old summary\n");
    writeFileSync(
      join(rootDir, ".code-butler", "project-summary.meta.json"),
      JSON.stringify({
        version: 1,
        summaryPath: join(rootDir, ".code-butler", "project-summary.md"),
        fingerprint: "old",
        lastGeneratedAt: "2026-06-15T08:00:00.000Z",
        lastCheckedAt: "2026-06-15T08:00:00.000Z"
      })
    );
    store.recordSyncStatus({
      source: "git",
      enabled: true,
      lastSyncAt: "2026-06-18T09:00:00.000Z",
      lastSuccessAt: "2026-06-18T09:00:00.000Z"
    });
    store.addCommit({
      hash: "fresh123",
      authorName: "Test User",
      authorEmail: "test@example.com",
      authoredAt: "2026-06-18T09:00:00.000Z",
      message: "Update launch docs",
      changedFiles: ["README.md"],
      diffSummary: "+ launch docs"
    });

    const handlers = createProjectMemoryToolHandlers(store, {
      rootDir,
      now: () => new Date("2026-06-18T12:00:00.000Z")
    });
    const recent = handlers.summarize_recent_activity({
      since: "2026-06-18T00:00:00.000Z",
      until: "2026-06-18T23:59:59.000Z",
      includeWorkingTree: false
    });

    expect(recent.freshness.warning).toContain("Project summary is older than the latest successful sync");
    store.close();
  });

  it("does not match old sources containing today when the requested window has no indexed sources", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    const oldSourceId = store.addSourceWithChunks({
      source: {
        id: "conversation-old",
        type: "conversation",
        title: "old-session.jsonl",
        origin: "codex",
        rawContent: "What changes did I make today and why?",
        metadata: { timestamp: "2026-06-17T08:30:00.000Z" }
      },
      chunks: [{ text: "What changes did I make today and why?" }]
    });
    store.db
      .prepare("update sources set created_at = ? where id = ?")
      .run("2026-06-17T08:30:00.000Z", oldSourceId);

    const handlers = createProjectMemoryToolHandlers(store, {
      rootDir,
      now: () => new Date("2026-06-18T12:00:00.000Z")
    });
    const recent = handlers.summarize_recent_activity({
      since: "2026-06-18T00:00:00.000Z",
      until: "2026-06-18T23:59:59.000Z",
      includeWorkingTree: false
    });

    expect(recent.conversations).toEqual([]);
    expect(recent.commits).toEqual([]);
    expect(recent.freshness.hasIndexedSourcesInWindow).toBe(false);
    expect(recent.freshness.warning).toContain("No Code Butler sources indexed for June 18, 2026");
    store.close();
  });

  it("filters commit windows by parsed timestamps rather than lexical timestamp strings", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addCommit({
      hash: "offset-old",
      authorName: "Test User",
      authorEmail: "test@example.com",
      authoredAt: "2026-06-17T23:27:07+02:00",
      message: "Late previous-day local commit",
      changedFiles: ["src/cache.ts"],
      diffSummary: "+ previous day"
    });

    const handlers = createProjectMemoryToolHandlers(store, {
      rootDir,
      now: () => new Date("2026-06-18T12:00:00.000+02:00")
    });
    const recent = handlers.summarize_recent_activity({
      since: "2026-06-18T00:00:00.000+02:00",
      until: "2026-06-18T23:59:59.999+02:00",
      includeWorkingTree: false
    });

    expect(recent.commits).toEqual([]);
    store.close();
  });

  it("defaults recent activity to the last 3 days", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();

    const handlers = createProjectMemoryToolHandlers(store, {
      rootDir,
      now: () => new Date("2026-06-18T12:00:00.000Z")
    });
    const recent = handlers.summarize_recent_activity({});

    expect(recent.window.since).toBe("2026-06-15T12:00:00.000Z");
    expect(recent.window.until).toBe("2026-06-18T12:00:00.000Z");
    store.close();
  });

  it("searches and summarizes active temporary context", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.upsertTemporaryMemory({
      id: "temp-active-task",
      kind: "task_state",
      title: "Continue MCP temporary context",
      summary: "Continue wiring temporary context MCP tools before durable memory search.",
      details: "The active task touches src/mcp/tools.ts and should survive compaction.",
      relatedFiles: ["src/mcp/tools.ts"],
      evidence: [{ sourceType: "conversation", sourceId: "codex:temp-session", locator: "codex:temp-session:chunk:0" }],
      confidence: 0.9,
      threadId: "thread-a",
      sessionId: "session-a",
      sourceAdapter: "codex",
      createdAt: "2026-06-18T08:00:00.000Z",
      updatedAt: "2026-06-18T08:30:00.000Z",
      expiresAt: "2026-06-19T08:00:00.000Z"
    });
    store.upsertTemporaryMemory({
      id: "temp-open-question",
      kind: "open_question",
      title: "Should cleanup run on startup?",
      summary: "Should expired temporary memories be cleaned on sync startup?",
      details: "Open question from the same session.",
      relatedFiles: [],
      evidence: [{ sourceType: "conversation", sourceId: "codex:temp-session", locator: "codex:temp-session:chunk:1" }],
      confidence: 0.8,
      threadId: "thread-a",
      sessionId: "session-a",
      sourceAdapter: "codex",
      createdAt: "2026-06-18T08:05:00.000Z",
      updatedAt: "2026-06-18T08:10:00.000Z",
      expiresAt: "2026-06-19T08:05:00.000Z"
    });

    const handlers = createProjectMemoryToolHandlers(store, {
      rootDir,
      now: () => new Date("2026-06-18T09:00:00.000Z")
    });
    const search = handlers.search_temporary_memory({
      query: "temporary context",
      threadId: "thread-a",
      sessionId: "session-a"
    });
    const active = handlers.summarize_active_context({
      threadId: "thread-a",
      sessionId: "session-a"
    });

    expect(search.results[0]?.id).toBe("temp-active-task");
    expect(active.groups.taskState.map((memory) => memory.id)).toEqual(["temp-active-task"]);
    expect(active.groups.openQuestions.map((memory) => memory.id)).toEqual(["temp-open-question"]);
    expect(active.relatedFiles).toEqual(["src/mcp/tools.ts"]);
    store.close();
  });

  it("cleans up expired temporary memory through the MCP handler", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.upsertTemporaryMemory({
      id: "temp-expired",
      kind: "task_state",
      title: "Expired task",
      summary: "Expired temporary context",
      details: "",
      relatedFiles: [],
      evidence: [],
      confidence: 0.5,
      createdAt: "2026-06-17T08:00:00.000Z",
      updatedAt: "2026-06-17T08:00:00.000Z",
      expiresAt: "2026-06-18T07:00:00.000Z"
    });
    store.upsertTemporaryMemory({
      id: "temp-active",
      kind: "task_state",
      title: "Active task",
      summary: "Active temporary context",
      details: "",
      relatedFiles: [],
      evidence: [],
      confidence: 0.5,
      createdAt: "2026-06-18T08:00:00.000Z",
      updatedAt: "2026-06-18T08:00:00.000Z",
      expiresAt: "2026-06-19T08:00:00.000Z"
    });

    const handlers = createProjectMemoryToolHandlers(store, {
      rootDir,
      now: () => new Date("2026-06-18T09:00:00.000Z")
    });
    const cleanup = handlers.cleanup_temporary_memory({ expiredOnly: true });

    expect(cleanup.deleted).toBe(1);
    expect(store.listActiveTemporaryMemory({ now: "2026-06-18T09:00:00.000Z" }).map((memory) => memory.id)).toEqual([
      "temp-active"
    ]);
    store.close();
  });

  it("includes working tree status as corroboration when requested", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    execFileSync("git", ["init"], { cwd: rootDir, stdio: "ignore" });
    mkdirSync(join(rootDir, "src"), { recursive: true });
    writeFileSync(join(rootDir, "src", "cache.ts"), "export const cache = new Map();\n");
    const store = openMemoryStore(rootDir);
    store.init();

    const handlers = createProjectMemoryToolHandlers(store, {
      rootDir,
      now: () => new Date("2026-06-18T12:00:00.000Z")
    });
    const recent = handlers.summarize_recent_activity({
      since: "2026-06-18T00:00:00.000Z",
      until: "2026-06-18T23:59:59.000Z",
      includeWorkingTree: true
    });

    expect(recent.workingTree.available).toBe(true);
    expect(recent.workingTree.status.some((line) => line.includes("src/cache.ts"))).toBe(true);
    expect(recent.summary.some((line) => line.includes("Working tree:"))).toBe(true);
    expect(recent.highlights.some((highlight) => highlight.kind === "working_tree")).toBe(true);
    expect(recent.conversations).toEqual([]);
    store.close();
  });
});
