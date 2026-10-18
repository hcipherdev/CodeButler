import { execFileSync } from "node:child_process";
import { gitExecutable } from "../git-executable.js";
import { openConfiguredMemoryStore } from "../storage/open-configured-store.js";

/** Metadata-only exposure audit: never reads old Git diffs or memory text. */
export function auditSecretsExposure(root: string): string[] {
  const warnings: string[] = [];
  try {
    const history = execFileSync(gitExecutable(), ["log", "--all", "--max-count=1", "--format=%H", "--", "secrets"],
      { cwd: root, encoding: "utf8", maxBuffer: 1024, stdio: ["ignore", "pipe", "ignore"] });
    if (history.trim()) warnings.push("Git history contains files from secrets/. Rotate any credentials exposed through Git and review remote clones.");
  } catch (error) {
    if ((error as { status?: number }).status !== 128) warnings.push("Could not audit Git history for earlier secrets/ exposure.");
  }
  try {
    const store = openConfiguredMemoryStore(root);
    try {
      store.init();
      if (store.hasSensitiveGitEvidence()) warnings.push("Project memory contains an older Git source involving secrets/. Review and purge that evidence and rotate exposed credentials.");
    } finally { store.close(); }
  } catch { warnings.push("Could not audit project memory for earlier secrets/ exposure."); }
  return warnings;
}
