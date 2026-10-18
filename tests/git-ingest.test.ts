import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ingestGitRepository } from "../src/ingest/git.js";
import { scanGitSource } from "../src/sources/git.js";
import { openMemoryStore } from "../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("git ingestion", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  function git(repo: string, args: string[]): string {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  }

  it("imports commit metadata, changed files, and bounded diff snippets", () => {
    const repo = makeTempDir("code-butler-git-repo-");
    const rootDir = makeTempDir();
    tempDirs.push(repo, rootDir);

    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test User"]);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "cache.ts"), "export const ttl = 1000;\n");
    git(repo, ["add", "src/cache.ts"]);
    git(repo, ["commit", "-m", "Add cache module"]);
    writeFileSync(
      join(repo, "src", "cache.ts"),
      "export function invalidateAfterWrite() {\n  return true;\n}\n"
    );
    git(repo, ["add", "src/cache.ts"]);
    git(repo, ["commit", "-m", "Invalidate cache after writes"]);

    const store = openMemoryStore(rootDir);
    store.init();
    const imported = ingestGitRepository(store, repo, { maxCommits: 10 });
    const commits = store.findCommits({ filePath: "src/cache.ts", limit: 10 });

    expect(imported.importedCommits).toBe(2);
    expect(commits[0]).toMatchObject({
      message: "Invalidate cache after writes",
      changedFiles: ["src/cache.ts"]
    });
    expect(commits[0]?.diffSummary).toContain("invalidateAfterWrite");
    expect(store.findCommits({ filePath: "src/cache.ts", query: "INVALIDATE", limit: 1 }).map(commit => commit.hash))
      .toEqual([commits[0]!.hash]);
    expect(store.findCommits({ filePath: "src/missing.ts", limit: 1 })).toEqual([]);
    expect(store.findCommits({ limit: 1 }).map(commit => commit.hash)).toEqual([commits[0]!.hash]);
    expect(store.search({ query: "invalidateAfterWrite", limit: 5 })[0]?.sourceType).toBe("commit");

    store.close();
  });

  it("bounds commits whose diff exceeds the old 10 MB git output buffer instead of failing with ENOBUFS", () => {
    const repo = makeTempDir("code-butler-git-repo-");
    const rootDir = makeTempDir();
    tempDirs.push(repo, rootDir);

    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test User"]);
    writeFileSync(join(repo, "huge.txt"), "generated line of fixture data\n".repeat(360_000));
    git(repo, ["add", "huge.txt"]);
    git(repo, ["commit", "-m", "Add oversized fixture"]);

    const store = openMemoryStore(rootDir);
    store.init();
    expect(ingestGitRepository(store, repo, { maxCommits: 10, maxDiffChars: 500 }).importedCommits).toBe(1);
    const [commit] = store.findCommits({ filePath: "huge.txt", limit: 1 });
    expect(commit?.message).toBe("Add oversized fixture");
    expect(commit?.diffSummary).toContain("[diff truncated at 500 chars]");
    expect(commit?.diffSummary.length).toBeLessThan(600);
    store.close();

    const scan = scanGitSource({ enabled: true, repoPath: repo, hookInstall: false, maxCommits: 10, maxDiffChars: 500 });
    expect(scan.commits).toHaveLength(1);
    expect(scan.commits[0]?.diffSummary).toContain("[diff truncated at 500 chars]");
  });
});
