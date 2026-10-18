import { spawnSync } from "node:child_process";

import { gitExecutable } from "../git-executable.js";

/**
 * Reads at most roughly `maxChars` of git output. Oversized output (for example a commit with a
 * multi-megabyte diff) is cut off instead of failing with ENOBUFS, so callers must bound it again.
 */
export function readBoundedGitOutput(repoPath: string, args: string[], maxChars: number): { output: string; truncated: boolean } {
  // UTF-8 needs at most 4 bytes per char; the slack keeps a final partial char from costing a whole char.
  const result = spawnSync(gitExecutable(), args, {
    cwd: repoPath,
    encoding: "utf8",
    maxBuffer: Math.max(0, maxChars) * 4 + 1024,
    windowsHide: true
  });
  const truncated = (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS";
  if (result.error && !truncated) throw result.error;
  if (!truncated && result.status !== 0) {
    throw new Error(`git ${args[0]} failed with exit code ${result.status}: ${result.stderr.trim()}`);
  }
  return { output: result.stdout, truncated };
}
