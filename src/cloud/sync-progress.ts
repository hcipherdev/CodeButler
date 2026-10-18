import { rmSync } from "node:fs";
import { join } from "node:path";
import { atomicJson, readJson, stateDirectory } from "./state.js";

/** What a running cloud sync is doing, for the desktop to show while it holds the gate. */
export interface SyncProgress {
  phase: "checking" | "merging" | "applying" | "encrypting" | "uploading";
  sentBytes?: number;
  totalBytes?: number;
  updatedAt: string;
}

const progressPath = (root: string) => join(stateDirectory(root), "sync-progress.json");

/** Returns a writer that records phases; upload byte counts are throttled to one write per interval. */
export function syncProgressWriter(root: string, intervalMs = 1000): { phase(phase: SyncProgress["phase"]): void; upload(sent: number, total: number): void; clear(): void } {
  let lastUpload = 0;
  const write = (value: Omit<SyncProgress, "updatedAt">) => {
    try { atomicJson(progressPath(root), { ...value, updatedAt: new Date().toISOString() }); } catch { /* Progress is diagnostic and never fails a sync. */ }
  };
  return {
    phase: phase => { lastUpload = 0; write({ phase }); },
    upload: (sent, total) => {
      const now = Date.now();
      if (sent < total && now - lastUpload < intervalMs) return;
      lastUpload = now; write({ phase: "uploading", sentBytes: sent, totalBytes: total });
    },
    clear: () => { try { rmSync(progressPath(root), { force: true }); } catch { /* A stale file is ignored once no operation holds the gate. */ } }
  };
}

export function readSyncProgress(root: string): SyncProgress | undefined {
  try { return readJson<SyncProgress>(progressPath(root)); } catch { return undefined; }
}
