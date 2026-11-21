import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { isAbsolute } from "node:path/win32";
import { globalConfigDir } from "./config.js";
import { readJson } from "./cloud/state.js";
import { buildInfo, type BuildInfo } from "./runtime.js";

export interface StoreWatcherHandoff {
  state: "waiting" | "starting" | "blocked" | "rolled-back";
  detail?: string;
}

export function storeWatcherHandoffPath(): string {
  return join(globalConfigDir(), "watch", "store-handoff-status.json");
}

export function storeWatcherTransitionDirectory(): string {
  return join(globalConfigDir(), "watch", "store-handoff");
}

export function storeWatcherJournalPath(): string {
  return join(storeWatcherTransitionDirectory(), "transaction.json");
}

export function storeWatcherStatus(platform = process.platform): { expectedBuild?: BuildInfo; handoff?: StoreWatcherHandoff } {
  if (!storeLauncher(platform)) return {};
  let handoff: StoreWatcherHandoff | undefined;
  try { handoff = readJson<StoreWatcherHandoff>(storeWatcherHandoffPath()); }
  catch { /* Diagnostics must not prevent reading the watcher status. */ }
  return { expectedBuild: buildInfo, ...(handoff ? { handoff } : {}) };
}

/** Set by the MSIX native entry points after Windows confirms package identity. */
export function storeLauncher(platform = process.platform, env = process.env): string | undefined {
  const launcher = env.CODE_BUTLER_STORE_LAUNCHER;
  return platform === "win32" && launcher && isAbsolute(launcher) ? launcher : undefined;
}

export function storeStartup(operation: "status" | "enable" | "disable", launcher = storeLauncher()): { installed: boolean; state: number } {
  if (!launcher) throw new Error("The Microsoft Store launcher is unavailable.");
  const result = JSON.parse(execFileSync(launcher, ["--store-startup", operation], {
    encoding: "utf8", timeout: 15_000, windowsHide: true
  })) as { installed: boolean; state: number };
  if (typeof result.installed !== "boolean" || !Number.isInteger(result.state)) throw new Error("Windows returned an invalid startup task status.");
  return result;
}
