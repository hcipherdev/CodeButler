import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir } from "../config.js";
import { atomicJson, canonicalRoot, sha256 } from "./state.js";

function marker(root: string): string {
  const canonical = canonicalRoot(root);
  return join(globalConfigDir(), "removed-projects", `${sha256(process.platform === "win32" ? canonical.toLowerCase() : canonical)}.json`);
}
export function assertProjectNotRemoved(root: string): void {
  if (existsSync(marker(root))) throw new Error("Project memory was removed. Explicitly initialize or add this folder again before using Butler.");
}
export function markProjectRemoved(root: string): void { atomicJson(marker(root), { removed: true }); }
export function clearProjectRemoved(root: string): void { rmSync(marker(root), { force: true }); }
