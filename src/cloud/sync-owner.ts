import { existsSync, linkSync, mkdirSync, statSync, unlinkSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { globalConfigDir } from "../config.js";
import { isGlobalRulesRoot } from "../rules/identity.js";
import { newRuntimeRecord, processIsLive, type RuntimeRecord } from "../runtime.js";
import { atomicJson, binding, canonicalRoot, readJson, sha256, stateDirectory, type CloudSyncTimings } from "./state.js";

export function checkoutKey(root: string): string {
  return sha256(canonicalRoot(root));
}
export const ownershipDirectory = (root: string): string => join(globalConfigDir(), "cloud", "schedulers", checkoutKey(root));
export function activeGlobalWatcher(root: string): RuntimeRecord | undefined {
  const directory = join(globalConfigDir(), "watch");
  if (!isGlobalRulesRoot(root) && !existsSync(join(directory, "projects", `${checkoutKey(root)}.json`))) {
    const registry = join(directory, "projects"), canonical = canonicalRoot(root);
    if (!existsSync(registry) || !readdirSync(registry).some(name => {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) return false;
      const project = readJson<{ root: string }>(join(registry,name));
      try { return !!project?.root && canonicalRoot(project.root) === canonical; } catch { return false; }
    })) return undefined;
  }
  const runner = readJson<RuntimeRecord>(join(directory, "runner.json"));
  return runner && processIsLive(runner) ? runner : undefined;
}
export function requestAutomaticSync(root: string, reason: "local" | "remote" = "local"): void {
  atomicJson(join(ownershipDirectory(root), "request.json"), { token: randomUUID(), reason });
}
export interface AutomaticSyncStatus {
  pending: boolean;
  queuedReason?: "local" | "remote";
  queuedSince?: string;
  runningSince?: string;
  lastCompletedAt?: string;
  lastLocalStamp?: string;
  lastQueueWaitMs?: number;
  timings?: CloudSyncTimings;
}
export interface AutomaticSyncQueue { pending: boolean; queuedSince?: string; queuedReason?: "local" | "remote" }
interface SyncCompletion { completedAt: string; localStamp: string; queueWaitMs?: number }
const fileTime = (path: string): string | undefined => {
  try { return statSync(path).mtime.toISOString(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
};
export function automaticSyncQueue(root: string): AutomaticSyncQueue {
  const directory = ownershipDirectory(root);
  const request = readJson<{ token: string; reason?: "local" | "remote" }>(join(directory, "request.json"));
  const completed = readJson<{ token: string }>(join(directory, "completed.json"));
  const pending = request !== undefined && request.token !== completed?.token;
  const queuedSince = pending ? fileTime(join(directory, "request.json")) : undefined;
  return { pending, ...(queuedSince ? { queuedSince, queuedReason: request?.reason ?? "local" } : {}) };
}
export function automaticSyncStatus(root: string): AutomaticSyncStatus {
  const directory = ownershipDirectory(root);
  const queue = automaticSyncQueue(root);
  const last = readJson<SyncCompletion>(join(directory, "last-success.json"));
  const timings = readJson<CloudSyncTimings>(join(stateDirectory(root), "timing.json"));
  const running = readJson<RuntimeRecord & { runStartedAt: string }>(join(directory, "running.json"));
  return {
    ...queue,
    ...(running && processIsLive(running) ? { runningSince: running.runStartedAt } : {}),
    ...(last ? { lastCompletedAt: last.completedAt, lastLocalStamp: last.localStamp, ...(last.queueWaitMs !== undefined ? { lastQueueWaitMs: last.queueWaitMs } : {}) } : {}),
    ...(timings ? { timings } : {})
  };
}
export function requestAutomaticSyncIfAbsent(root: string, reason: "local" | "remote" = "local"): void {
  const queue = automaticSyncQueue(root);
  if (!queue.pending || reason === "local" && queue.queuedReason === "remote") requestAutomaticSync(root, reason);
}
/**
 * Unattended publishes from one checkout are at least this far apart. A device that must merge first, being
 * slower or catching up, otherwise keeps losing the publish race to one that publishes every minute, and every
 * publish is another version the others download. Explicit requests (Sync now, connecting) are not delayed.
 */
export const AUTOMATIC_PUBLISH_INTERVAL_MS = 10 * 60 * 1000;
/** Queues a sync for local changes unless this checkout published within the interval; a later sweep queues it then. */
export function requestLocalChangeSync(root: string, now: number = Date.now()): boolean {
  const published = Date.parse(binding(root)?.lastPublishedAt ?? "");
  if (published <= now && now - published < AUTOMATIC_PUBLISH_INTERVAL_MS) return false;
  requestAutomaticSyncIfAbsent(root);
  return true;
}
export function automaticSyncPending(root: string): boolean {
  const directory = ownershipDirectory(root);
  const requested = readJson<{ token: string }>(join(directory, "request.json"))?.token;
  const completed = readJson<{ token: string }>(join(directory, "completed.json"))?.token;
  return requested !== undefined && requested !== completed;
}
export class AutomaticSyncOwner {
  readonly record: RuntimeRecord;
  private directory: string;
  private owned = false;
  private runToken: string | undefined;
  private runQueueWaitMs: number | undefined;
  constructor(readonly root: string, role: RuntimeRecord["role"] = "mcp") {
    this.directory = ownershipDirectory(root); this.record = newRuntimeRecord(role, canonicalRoot(root));
  }
  private get path(): string { return join(this.directory, "owner.json"); }
  acquire(): boolean {
    const watcher = activeGlobalWatcher(this.root);
    if (watcher && !(this.record.role === "watcher" && process.env.CODE_BUTLER_WATCH_RUNNER_TOKEN === watcher.token && !!process.env.CODE_BUTLER_WATCH_TOKEN)) {
      this.release(); return false;
    }
    if (this.owned) return true;
    mkdirSync(this.directory, { recursive: true });
    const candidate = join(this.directory, `${this.record.token}.candidate`);
    writeFileSync(candidate, JSON.stringify(this.record), { flag: "wx", mode: 0o600 });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { linkSync(candidate, this.path); this.owned = true; return true; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const owner = readJson<RuntimeRecord>(this.path);
          if (!owner) continue;
          if (processIsLive(owner)) return false;
          const reaper = join(this.directory, `reap-${owner.token}`);
          try {
            linkSync(this.path, reaper);
            try { if (readJson<RuntimeRecord>(this.path)?.token === owner.token) unlinkSync(this.path); }
            finally { unlinkSync(reaper); }
          } catch (error) { if (!["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        }
      }
      return false;
    } finally { unlinkSync(candidate); }
  }
  pending(): string | undefined { return readJson<{ token: string }>(join(this.directory, "request.json"))?.token; }
  beginRun(): string | undefined {
    if (!this.owned) throw new Error("Automatic sync owner is not held");
    const token = this.pending();
    const startedAt = new Date().toISOString();
    const queuedSince = token ? fileTime(join(this.directory, "request.json")) : undefined;
    this.runQueueWaitMs = queuedSince ? Math.max(0, Date.parse(startedAt) - Date.parse(queuedSince)) : undefined;
    this.runToken = randomUUID();
    atomicJson(join(this.directory, "running.json"), { ...this.record, token: this.runToken, runStartedAt: startedAt });
    return token;
  }
  completeRun(token: string | undefined, localStamp: string): void {
    const completedAt = new Date().toISOString();
    const queueWaitMs = this.runQueueWaitMs ?? readJson<SyncCompletion>(join(this.directory, "last-success.json"))?.queueWaitMs;
    atomicJson(join(this.directory, "last-success.json"), { completedAt, localStamp, ...(queueWaitMs !== undefined ? { queueWaitMs } : {}) });
    this.acknowledge(token);
  }
  endRun(): void {
    const path = join(this.directory, "running.json");
    try { if (readJson<{ token: string }>(path)?.token === this.runToken) unlinkSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.runToken = undefined;
    this.runQueueWaitMs = undefined;
  }
  acknowledge(token: string | undefined): void {
    // Keep the request file: acknowledgement is a separate atomic value, so a
    // concurrent request can never be lost between a read and unlink.
    if (token) atomicJson(join(this.directory, "completed.json"), { token });
  }
  requested(): boolean { return automaticSyncPending(this.root); }
  release(): void {
    if (!this.owned) return;
    try { if (readJson<RuntimeRecord>(this.path)?.token === this.record.token) unlinkSync(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.owned = false;
  }
}
