import { gitExecutable } from "../git-executable.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

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

/**
 * Changes whenever a local branch is created, deleted or moved, or HEAD switches: everything
 * classifyBranch can observe. "unavailable" when git cannot answer, which is itself stable.
 */
export function readGitRefsFingerprint(repoPath: string | undefined): string {
  if (!repoPath?.trim()) return "unavailable";
  const refs = gitOutput(repoPath, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]);
  if (refs === undefined) return "unavailable";
  const head = gitOutput(repoPath, ["symbolic-ref", "-q", "HEAD"]) ?? gitOutput(repoPath, ["rev-parse", "HEAD"]) ?? "";
  return createHash("sha256").update(JSON.stringify([refs, head])).digest("hex");
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

function gitOutput(repoPath: string, args: string[]): string | undefined {
  const result = spawnSync(gitExecutable(), ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout;
}

function gitStatus(repoPath: string, args: string[]): number | undefined {
  const result = spawnSync(gitExecutable(), ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true
  });
  if (result.error) return undefined;
  return result.status ?? undefined;
}
