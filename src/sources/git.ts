import { execFileSync } from "node:child_process";

import type { GitSourceConfig } from "../types.js";
import type { MemoryStore } from "../storage/store.js";
import type { CommitRecord } from "../types.js";

export interface GitSyncResult {
  imported: number;
  commits: CommitRecord[];
}

export function syncGitSource(store: MemoryStore, config: GitSourceConfig): GitSyncResult {
  const cursor = store.getSyncCursor("git", "last_commit")?.cursorValue;
  const hashes = listCommitHashes(config.repoPath, config.maxCommits, cursor);
  const commits = hashes.map((hash) => readCommit(config.repoPath, hash, config.maxDiffChars));
  for (const commit of commits) {
    store.addCommit(commit);
  }
  if (commits.length > 0) {
    store.setSyncCursor("git", "last_commit", commits.at(-1)!.hash);
  }
  return {
    imported: commits.length,
    commits
  };
}

function listCommitHashes(repoPath: string, maxCommits: number, cursor?: string): string[] {
  if (cursor) {
    try {
      return git(repoPath, ["rev-list", "--reverse", `${cursor}..HEAD`])
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return listCommitHashes(repoPath, maxCommits);
    }
  }

  return git(repoPath, ["log", `--max-count=${maxCommits}`, "--reverse", "--format=%H"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readCommit(repoPath: string, hash: string, maxDiffChars: number): CommitRecord {
  const metadata = git(repoPath, ["show", "-s", "--format=%H%x00%an%x00%ae%x00%aI%x00%s", hash]).split(
    "\u0000"
  );
  if (metadata.length < 5) {
    throw new Error(`Could not parse git metadata for ${hash}`);
  }
  const changedFiles = git(repoPath, ["show", "--format=", "--name-only", "--no-renames", hash])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const diff = git(repoPath, ["show", "--format=", "--no-ext-diff", "--unified=40", "--no-color", hash]);

  const [commitHash, authorName, authorEmail, authoredAt, message] = metadata;
  if (!commitHash || !authorName || !authorEmail || !authoredAt || !message) {
    throw new Error(`Incomplete git metadata for ${hash}`);
  }

  return {
    hash: commitHash,
    authorName,
    authorEmail,
    authoredAt,
    message,
    changedFiles,
    diffSummary: boundText(diff, maxDiffChars)
  };
}

function git(repoPath: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  }).trim();
}

function boundText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[diff truncated at ${maxChars} chars]`;
}
