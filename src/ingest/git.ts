import { gitExecutable } from "../git-executable.js";
import { assertOrdinaryProject } from "../rules/identity.js";
import { execFileSync } from "node:child_process";

import type { MemoryStore } from "../storage/store.js";
import type { CommitRecord } from "../types.js";
import { isSensitiveGitPath, isGeneratedMemoryPath } from "../sources/sensitive-path.js";
import { readBoundedGitOutput } from "../sources/bounded-git.js";

export interface GitIngestResult {
  importedCommits: number;
}

export function ingestGitRepository(
  store: MemoryStore,
  repoPath: string,
  options: { maxCommits?: number; maxDiffChars?: number } = {}
): GitIngestResult {
  assertOrdinaryProject(store.paths.rootDir);
  const maxCommits = options.maxCommits ?? 100;
  const maxDiffChars = options.maxDiffChars ?? 12000;
  const hashes = git(repoPath, ["log", `--max-count=${maxCommits}`, "--format=%H"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let importedCommits = 0;
  for (const hash of hashes) {
    const commit = readCommit(repoPath, hash, maxDiffChars);
    if (!commit) continue;
    store.addCommit(commit);
    importedCommits += 1;
  }
  return { importedCommits };
}

function readCommit(repoPath: string, hash: string, maxDiffChars: number): CommitRecord | undefined {
  const paths = execFileSync(gitExecutable(), ["show", "--format=", "--name-only", "--no-renames", "-z", hash],
    { cwd: repoPath, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, windowsHide: true }).split("\0").filter(Boolean);
  if (!paths.length || paths.some(path => path.toLowerCase().startsWith("secrets/"))) return undefined;
  const changedFiles = paths.filter(path => !isSensitiveGitPath(path) && !isGeneratedMemoryPath(path));
  if (!changedFiles.length) return undefined;
  const metadata = git(repoPath, ["show", "-s", "--format=%H%x00%an%x00%ae%x00%aI%x00%s", hash]).split(
    "\u0000"
  );
  if (metadata.length < 5) {
    throw new Error(`Could not parse git metadata for ${hash}`);
  }
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
