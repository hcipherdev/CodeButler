import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ingestGitRepository } from "../src/ingest/git.js";
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
    expect(store.search({ query: "invalidateAfterWrite", limit: 5 })[0]?.sourceType).toBe("commit");

    store.close();
  });
});
