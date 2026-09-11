import { execFileSync } from "node:child_process";

import type { MemoryLayer } from "../types.js";
import { formatLayer, normalizeLayer } from "./layer.js";
import { installationDeviceId } from "./origin.js";

const DEFAULT_BRANCH_NAMES = ["main", "master"];

export interface MemoryBranchContext {
  branch?: string | undefined;
  defaultBranch?: string | undefined;
  isDefaultBranch: boolean;
  isDetached: boolean;
}

export interface DefaultBranchLayerOptions {
  defaultBranches?: readonly string[] | undefined;
  deviceId?: string | undefined;
}

export function readMemoryBranchContext(
  repoPath: string | undefined,
  options: Pick<DefaultBranchLayerOptions, "defaultBranches"> = {}
): MemoryBranchContext {
  const branch = currentGitBranch(repoPath);
  if (!branch) return { isDefaultBranch: true, isDetached: true };

  const defaultBranch = currentDefaultBranch(repoPath);
  const defaultBranches = new Set([
    ...DEFAULT_BRANCH_NAMES,
    ...(defaultBranch ? [defaultBranch] : []),
    ...(options.defaultBranches ?? [])
  ].map((name) => name.trim()).filter(Boolean));

  return {
    branch,
    ...(defaultBranch ? { defaultBranch } : {}),
    isDefaultBranch: defaultBranches.has(branch),
    isDetached: false
  };
}

export function defaultBranchMemoryLayer(
  repoPath: string | undefined,
  options: DefaultBranchLayerOptions = {}
): MemoryLayer | undefined {
  const context = readMemoryBranchContext(repoPath, options);
  if (!context.branch || context.isDefaultBranch) return undefined;
  try {
    return normalizeLayer(formatLayer({
      kind: "branch",
      branch: context.branch,
      deviceId: options.deviceId ?? installationDeviceId()
    }));
  } catch {
    return undefined;
  }
}

function currentGitBranch(repoPath: string | undefined): string | undefined {
  return runGit(repoPath, ["branch", "--show-current"]);
}

function currentDefaultBranch(repoPath: string | undefined): string | undefined {
  const originHead = runGit(repoPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) return originHead.replace(/^[^/]+\//, "");
  return runGit(repoPath, ["config", "--get", "init.defaultBranch"]);
}

function runGit(repoPath: string | undefined, args: string[]): string | undefined {
  if (!repoPath?.trim()) return undefined;
  try {
    const output = execFileSync("git", ["-C", repoPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}
