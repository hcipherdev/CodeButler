import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureProjectConfig } from "../src/config.js";
import { createProjectMemoryServer } from "../src/server.js";
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
});
