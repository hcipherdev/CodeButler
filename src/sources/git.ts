import { gitExecutable } from "../git-executable.js";
import { execFileSync } from "node:child_process";

import type { GitSourceConfig } from "../types.js";
import type { MemoryStore } from "../storage/store.js";
import type { CommitRecord } from "../types.js";
import { isSensitiveGitPath, isGeneratedMemoryPath } from "./sensitive-path.js";
import { readBoundedGitOutput } from "./bounded-git.js";

export interface GitSyncResult {
  imported: number;
  commits: CommitRecord[];
}
export interface GitSourceScan { cursor?: string | undefined; hashes: string[]; commits: CommitRecord[] }

export function scanGitSource(config: GitSourceConfig, cursor?: string): GitSourceScan {
  const hashes = listCommitHashes(config.repoPath, config.maxCommits, cursor);
  return { cursor, hashes, commits: hashes.map(hash => readCommit(config.repoPath, hash, config.maxDiffChars)).filter((commit): commit is CommitRecord => Boolean(commit)) };
}

export function syncGitSource(store: MemoryStore, config: GitSourceConfig, queueForExtraction = false, scan?: GitSourceScan): GitSyncResult {
  const cursor = store.getSyncCursor("git", "last_commit")?.cursorValue;
  if (scan && cursor !== scan.cursor) throw new Error("Git source changed during scan; retry on the next pass");
  const { hashes, commits: scanned } = scan ?? scanGitSource(config, cursor);
  const commits = scanned.filter(commit => !store.findSourceTombstone("commit", commit.hash));
  for (const commit of commits) {
    store.addCommit(commit);
    if (queueForExtraction) store.enqueueExtractionEvidence("git", "commit", commit.hash);
  }
  if (hashes.length > 0) {
    store.setSyncCursor("git", "last_commit", hashes.at(-1)!);
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

function readCommit(repoPath: string, hash: string, maxDiffChars: number): CommitRecord | undefined {
  const paths = execFileSync(gitExecutable(), ["show", "--format=", "--name-only", "--no-renames", "-z", hash],
    { cwd: repoPath, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, windowsHide: true }).split("\0").filter(Boolean);
  // A commit touching secrets/ may also carry values in its message or another file's diff.
  if (!paths.length || paths.some(path => path.toLowerCase().startsWith("secrets/"))) return undefined;
  const changedFiles = paths.filter(path => !isSensitiveGitPath(path) && !isGeneratedMemoryPath(path));
  if (!changedFiles.length) return undefined;
  const metadata = git(repoPath, ["show", "-s", "--format=%H%x00%an%x00%ae%x00%aI%x00%s", hash]).split(
    "\u0000"
  );
  if (metadata.length < 5) {
    throw new Error(`Could not parse git metadata for ${hash}`);
  }
  // Positive pathspecs prevent secret file content from entering this process.
  const diff = readBoundedGitOutput(repoPath, ["show", "--format=", "--no-ext-diff", "--unified=40", "--no-color", hash, "--", ...changedFiles.map(path => `:(literal)${path}`)], maxDiffChars);

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
    diffSummary: boundText(diff.output.trim(), maxDiffChars, diff.truncated)
  };
}

function git(repoPath: string, args: string[]): string {
  return execFileSync(gitExecutable(), args, {
    cwd: repoPath,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  }).trim();
}

function boundText(value: string, maxChars: number, truncated = false): string {
  if (value.length <= maxChars && !truncated) return value;
  return `${value.slice(0, maxChars)}\n[diff truncated at ${maxChars} chars]`;
}
