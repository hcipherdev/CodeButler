import { spawnSync } from "node:child_process";

import { readMemoryBranchContext } from "./branch.js";

/**
 * Git branch facts shared by branch triage and layer retention. Both need to know
 * whether a branch is current, merged, gone, or simply unknown, and neither may
 * guess: an unavailable repository must classify as `unknown` so no automatic
 * action fires on missing evidence.
 */
export type BranchState = "current" | "merged" | "stale" | "active" | "unknown";

export interface GitBranchFacts {
  available: boolean;
  repoPath?: string | undefined;
  currentBranch?: string | undefined;
  defaultBranch?: string | undefined;
}

export function readGitBranchFacts(repoPath: string | undefined): GitBranchFacts {
  if (!repoPath?.trim() || gitStatus(repoPath, ["rev-parse", "--git-dir"]) !== 0) return { available: false };
  const context = readMemoryBranchContext(repoPath);
  const defaultBranch = findDefaultBranch(repoPath, context.defaultBranch);
  return {
    available: true,
    repoPath,
    currentBranch: context.branch,
    ...(defaultBranch === undefined ? {} : { defaultBranch })
  };
}

export function classifyBranch(
  branch: string,
  latestMemoryAt: string,
  git: GitBranchFacts,
  staleDays: number,
  now: Date
): BranchState {
  if (!git.available) return "unknown";
  if (git.currentBranch === branch) return "current";
  if (!localBranchExists(git, branch)) return "stale";
  const isStale = now.getTime() - Date.parse(latestMemoryAt) > staleDays * 24 * 60 * 60 * 1000;
  if (git.defaultBranch === undefined) return isStale ? "stale" : "unknown";
  const merged = branchMergedIntoDefault(git, branch, git.defaultBranch);
  if (merged === undefined) return isStale ? "stale" : "unknown";
  if (merged) return "merged";
  return isStale ? "stale" : "active";
}

export function localBranchExists(git: GitBranchFacts, branch: string): boolean {
  return gitStatusForFacts(git, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]) === 0;
}

function findDefaultBranch(repoPath: string, detected: string | undefined): string | undefined {
  for (const candidate of [detected, "main", "master"]) {
    if (candidate && gitStatus(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]) === 0) {
      return candidate;
    }
  }
  return undefined;
}

function branchMergedIntoDefault(git: GitBranchFacts, branch: string, defaultBranch: string): boolean | undefined {
  const status = gitStatusForFacts(git, ["merge-base", "--is-ancestor", branch, defaultBranch]);
  if (status === 0) return true;
  if (status === 1) return false;
  return undefined;
}

function gitStatusForFacts(git: GitBranchFacts, args: string[]): number | undefined {
  return git.repoPath === undefined ? undefined : gitStatus(git.repoPath, args);
}

function gitStatus(repoPath: string, args: string[]): number | undefined {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.error) return undefined;
  return result.status ?? undefined;
}
