import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureProjectConfig } from "../src/config.js";
import { closeProjectMemoryServer, createProjectMemoryServer, type ProjectMemoryServer } from "../src/server.js";
import { MemoryStoreCheckpointBusyError } from "../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("server startup sync", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  function git(repo: string, args: string[]): string {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  }

  it("syncs configured sources before serving tools", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const repoDir = join(rootDir, "repo");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    git(repoDir, ["init"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test User"]);
    writeFileSync(join(repoDir, "src", "cache.ts"), "export const cache = true;\n");
    git(repoDir, ["add", "src/cache.ts"]);
    git(repoDir, ["commit", "-m", "Add cache module"]);

    const codexDir = join(rootDir, "codex", "archived_sessions");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "rollout-test.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-06-01T10:00:00Z",
          type: "session_meta",
          payload: { id: "codex-session-1", cwd: repoDir }
        }),
        JSON.stringify({
          timestamp: "2026-06-01T10:00:01Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "The cache fix matters." }]
          }
        })
      ].join("\n")
    );

    ensureProjectConfig(rootDir);
    writeFileSync(
      join(rootDir, ".code-butler", "config.json"),
      JSON.stringify(
        {
          sources: {
            git: { enabled: true, repoPath: "./repo", hookInstall: false, maxCommits: 50, maxDiffChars: 12000 },
            codex: { enabled: true, roots: ["./codex/archived_sessions"], includeDefaultRoots: false },
            claude: { enabled: false, roots: [] }
          },
          extractor: {
            provider: "openai-compatible",
            baseUrl: "https://example.test/v1",
            model: "gpt-test",
            apiKeyEnv: "TEST_API_KEY"
          },
          promotion: {
            confidenceThreshold: 0.85,
            requireCommitAndConversation: true,
            minSourceCategories: 2
          },
          sync: {
            autoSyncOnServerStart: true
          }
        },
        null,
        2
      )
    );

    const projectServer = await createProjectMemoryServer(rootDir);
    const summary = projectServer.store.getProjectSummary();

    expect(summary.lastSyncAt).toBeTruthy();
    expect(summary.sources).toBeGreaterThan(0);
    expect(summary.syncSources.codex?.lastSyncAt).toBeTruthy();
    expect(existsSync(join(repoDir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(repoDir, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(repoDir, ".code-butler", "project-summary.md"))).toBe(false);

    projectServer.store.close();
  });

  it("applies project redaction rules before startup sync writes", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const secret = "server-project-secret";
    const codexDir = join(rootDir, "codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "secret.jsonl"), [
      JSON.stringify({ timestamp: "2026-07-16T00:00:00Z", type: "session_meta", payload: { id: "session-1", cwd: rootDir } }),
      JSON.stringify({
        timestamp: "2026-07-16T00:00:01Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `ordinary ${secret}` }] }
      })
    ].join("\n"));
    ensureProjectConfig(rootDir);
    writeFileSync(join(rootDir, ".code-butler", "config.json"), JSON.stringify({
      sources: {
        git: { enabled: false },
        codex: { enabled: true, roots: ["./codex"], includeDefaultRoots: false },
        claude: { enabled: false, roots: [] }
      },
      sync: { autoSyncOnServerStart: true },
      privacy: {
        allowRemoteEmbeddings: false,
        redactionPatterns: [{ name: "server secret", kind: "literal", pattern: secret }]
      }
    }, null, 2));

    const projectServer = await createProjectMemoryServer(rootDir);
    const rows = projectServer.store.db.prepare(
      "select raw_content from sources union all select text from chunks"
    ).all();
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(projectServer.store.search({ query: "ordinary" })).not.toHaveLength(0);
    projectServer.store.close();
  });

  it("keeps MCP serving when the memory database cannot checkpoint during shutdown", async () => {
    const serverClose = vi.fn(async () => {});
    const storeClose = vi.fn(() => {
      throw new MemoryStoreCheckpointBusyError("Cannot safely close Code Butler memory database");
    });
    const projectServer = {
      server: { close: serverClose },
      store: { close: storeClose }
    } as unknown as ProjectMemoryServer;

    await expect(closeProjectMemoryServer(projectServer)).rejects.toThrow(
      "Cannot safely close Code Butler memory database"
    );
    expect(storeClose).toHaveBeenCalledOnce();
    expect(serverClose).not.toHaveBeenCalled();
  });

  it("reports a fatal error when MCP transport shutdown fails after closing memory", async () => {
    const serverClose = vi.fn(async () => {
      throw new Error("transport close failed");
    });
    const storeClose = vi.fn();
    const projectServer = {
      server: { close: serverClose },
      store: { close: storeClose }
    } as unknown as ProjectMemoryServer;

    await expect(closeProjectMemoryServer(projectServer)).rejects.toThrow(
      "MCP server close failed after the memory database was safely closed"
    );
    expect(storeClose).toHaveBeenCalledOnce();
    expect(serverClose).toHaveBeenCalledOnce();
  });

  it("reports a fatal error for a non-retryable memory store close failure", async () => {
    const serverClose = vi.fn(async () => {});
    const storeClose = vi.fn(() => {
      throw new Error("database close failed");
    });
    const projectServer = {
      server: { close: serverClose },
      store: { close: storeClose }
    } as unknown as ProjectMemoryServer;

    await expect(closeProjectMemoryServer(projectServer)).rejects.toThrow(
      "Memory database close failed before MCP transport shutdown"
    );
    expect(storeClose).toHaveBeenCalledOnce();
    expect(serverClose).not.toHaveBeenCalled();
  });
});
