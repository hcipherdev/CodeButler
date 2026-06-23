import { execFileSync } from "node:child_process";

import type { MemoryStore } from "../storage/store.js";
import type { CommitRecord } from "../types.js";

export interface GitIngestResult {
  importedCommits: number;
}

export function ingestGitRepository(
  store: MemoryStore,
  repoPath: string,
  options: { maxCommits?: number; maxDiffChars?: number } = {}
): GitIngestResult {
  const maxCommits = options.maxCommits ?? 100;
  const maxDiffChars = options.maxDiffChars ?? 12000;
  const hashes = git(repoPath, ["log", `--max-count=${maxCommits}`, "--format=%H"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let importedCommits = 0;
  for (const hash of hashes) {
    const commit = readCommit(repoPath, hash, maxDiffChars);
    store.addCommit(commit);
    importedCommits += 1;
  }
  return { importedCommits };
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
