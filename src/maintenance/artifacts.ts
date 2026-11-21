import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { handleOwnerPid } from "../cloud/gate.js";
import type { ArtifactRetentionConfig } from "../types.js";

export type ArtifactMaintenanceAction = "remove" | "rotate";
export type ArtifactMaintenanceCategory = "logs" | "projectSummaryBackups" | "handbookBackups" | "recoveryBackups" | "reconnectBackups" | "cloudHandles";

export interface ArtifactMaintenanceItem {
  category: ArtifactMaintenanceCategory;
  action: ArtifactMaintenanceAction;
  path: string;
  reason: string;
  bytes?: number | undefined;
}

export interface ArtifactMaintenanceResult {
  dryRun: boolean;
  scanned: number;
  removed: number;
  rotated: number;
  items: ArtifactMaintenanceItem[];
  warnings: string[];
}

export function inspectArtifactMaintenance(
  rootDir: string,
  config: ArtifactRetentionConfig,
  options: { now?: Date } = {}
): ArtifactMaintenanceResult {
  return runArtifactMaintenance(rootDir, config, { apply: false, ...options });
}

export function runArtifactMaintenance(
  rootDir: string,
  config: ArtifactRetentionConfig,
  options: { apply: boolean; now?: Date }
): ArtifactMaintenanceResult {
  const result: ArtifactMaintenanceResult = {
    dryRun: !options.apply,
    scanned: 0,
    removed: 0,
    rotated: 0,
    items: [],
    warnings: []
  };
  const dataDir = join(rootDir, ".code-butler");
  inspectLogs(dataDir, config, result);
  inspectProjectSummaryBackups(dataDir, config, result);
  inspectHandbookBackups(dataDir, config, result);
  inspectRecoveryBackups(dataDir, config, options.now ?? new Date(), result);
  inspectReconnectBackups(dataDir, result);
  inspectCloudHandles(dataDir, config, result);
  if (options.apply) applyMaintenance(result, config);
  return result;
}

/** What the global watcher and its runtime installer write under `<CODE_BUTLER_HOME>/watch/logs`. */
export const GLOBAL_WATCH_LOG_NAMES = ["watch.out.log", "watch.err.log", "store-watch.out.log", "store-watch.err.log", "runtime-install.log"] as const;

/** Rotates and prunes the named logs in one folder, such as the global watcher's, outside any project. */
export function runLogDirectoryMaintenance(
  logsDir: string,
  names: readonly string[],
  logs: ArtifactRetentionConfig["logs"],
  options: { apply: boolean }
): ArtifactMaintenanceResult {
  const result: ArtifactMaintenanceResult = { dryRun: !options.apply, scanned: 0, removed: 0, rotated: 0, items: [], warnings: [] };
  inspectLogDirectory(logsDir, names, logs, result);
  if (options.apply) applyMaintenance(result, { logs });
  return result;
}

function inspectLogs(dataDir: string, config: ArtifactRetentionConfig, result: ArtifactMaintenanceResult): void {
  inspectLogDirectory(join(dataDir, "logs"), ["watch.out.log", "watch.err.log"], config.logs, result);
}

function inspectLogDirectory(logsDir: string, names: readonly string[], logs: ArtifactRetentionConfig["logs"], result: ArtifactMaintenanceResult): void {
  const config = { logs };
  for (const name of names) {
    const path = join(logsDir, name);
    if (existsSync(path)) {
      result.scanned += 1;
      const size = statSync(path).size;
      if (size > config.logs.maxBytes) {
        result.items.push({
          category: "logs",
          action: "rotate",
          path,
          reason: `size ${size} exceeds ${config.logs.maxBytes}`,
          bytes: size
        });
      }
    }
    for (const rotated of listRotatedLogs(logsDir, name).slice(config.logs.maxFiles)) {
      result.scanned += 1;
      result.items.push({
        category: "logs",
        action: "remove",
        path: rotated,
        reason: `retains newest ${config.logs.maxFiles} rotated log file(s)`,
        bytes: statSync(rotated).size
      });
    }
    const existingRotated = listRotatedLogs(logsDir, name);
    if (existsSync(path) && statSync(path).size > config.logs.maxBytes && config.logs.maxFiles > 0) {
      for (const displaced of existingRotated.slice(Math.max(0, config.logs.maxFiles - 1), config.logs.maxFiles)) {
        if (result.items.some((item) => item.path === displaced)) continue;
        result.items.push({
          category: "logs",
          action: "remove",
          path: displaced,
          reason: `retains newest ${config.logs.maxFiles} rotated log file(s) after rotation`,
          bytes: statSync(displaced).size
        });
      }
    }
  }
}

function inspectProjectSummaryBackups(
  dataDir: string,
  config: ArtifactRetentionConfig,
  result: ArtifactMaintenanceResult
): void {
  const dir = join(dataDir, "backups", "project-summary");
  const backups = listFiles(dir, (name) => name.startsWith("project-summary-") && name.endsWith(".md"));
  result.scanned += backups.length;
  for (const backup of backups.slice(config.projectSummaryBackups.maxFiles)) {
    result.items.push({
      category: "projectSummaryBackups",
      action: "remove",
      path: backup,
      reason: `retains newest ${config.projectSummaryBackups.maxFiles} project summary backup(s)`,
      bytes: statSync(backup).size
    });
  }
}

function inspectHandbookBackups(dataDir: string, config: ArtifactRetentionConfig, result: ArtifactMaintenanceResult): void {
  const backupsDir = join(dataDir, "backups"), directory = join(backupsDir, "handbook");
  if ([dataDir, backupsDir, directory].some(path => existsSync(path) && lstatSync(path).isSymbolicLink())) return;
  const backups = listFiles(directory, name => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.md$/i.test(name));
  result.scanned += backups.length;
  for (const path of backups.slice(config.projectSummaryBackups.maxFiles)) {
    result.items.push({ category: "handbookBackups", action: "remove", path,
      reason: `retains newest ${config.projectSummaryBackups.maxFiles} handbook backup(s)`, bytes: statSync(path).size });
  }
}

function inspectRecoveryBackups(
  dataDir: string,
  config: ArtifactRetentionConfig,
  now: Date,
  result: ArtifactMaintenanceResult
): void {
  const cutoff = now.getTime() - config.recoveryBackups.minAgeDays * 24 * 60 * 60 * 1000;
  const eligible = listFiles(dataDir, (name) => name.startsWith("memory.sqlite.recovery-") && name.endsWith(".sqlite"))
    .filter((path) => statSync(path).mtimeMs <= cutoff);
  result.scanned += eligible.length;
  for (const backup of eligible.slice(config.recoveryBackups.maxFiles)) {
    result.items.push({
      category: "recoveryBackups",
      action: "remove",
      path: backup,
      reason: `retains newest ${config.recoveryBackups.maxFiles} recovery backup(s) older than ${config.recoveryBackups.minAgeDays} day(s)`,
      bytes: statSync(backup).size
    });
  }
}

/** Local and cloud snapshot pairs written when a reviewed memory choice is applied. */
const RECONNECT_BACKUP_SETS = 5;
function inspectReconnectBackups(dataDir: string, result: ArtifactMaintenanceResult): void {
  const backupsDir = join(dataDir, "backups"), directory = join(backupsDir, "reconnect");
  if ([dataDir, backupsDir, directory].some(path => existsSync(path) && lstatSync(path).isSymbolicLink())) return;
  const backups = listFiles(directory, name => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-(?:local|cloud)\.snapshot\.gz$/i.test(name));
  result.scanned += backups.length;
  const kept = new Set<string>();
  for (const path of backups) {
    const set = basename(path).slice(0, 36);
    if (kept.has(set) || kept.size < RECONNECT_BACKUP_SETS) { kept.add(set); continue; }
    result.items.push({ category: "reconnectBackups", action: "remove", path,
      reason: `retains newest ${RECONNECT_BACKUP_SETS} reviewed memory choice backup set(s)`, bytes: statSync(path).size });
  }
}

function inspectCloudHandles(dataDir: string, config: ArtifactRetentionConfig, result: ArtifactMaintenanceResult): void {
  if (!config.cloudHandles.reapStale) return;
  const handleDir = join(dataDir, ".cloud-handles");
  for (const handle of listFiles(handleDir, () => true)) {
    result.scanned += 1;
    // The name records the owner even when a crash left the content empty or zero-filled.
    const pid = handleOwnerPid(basename(handle));
    if (pid !== undefined ? !alive(pid) : !pidFileAlive(handle, result)) {
      result.items.push({ category: "cloudHandles", action: "remove", path: handle, reason: "recorded PID is not alive" });
    }
  }
  for (const owner of listFiles(dataDir, (name) => name.startsWith(".cloud-owner-"))) {
    result.scanned += 1;
    if (!pidFileAlive(owner, result)) {
      result.items.push({ category: "cloudHandles", action: "remove", path: owner, reason: "recorded PID is not alive" });
    }
  }
}

function applyMaintenance(result: ArtifactMaintenanceResult, config: Pick<ArtifactRetentionConfig, "logs">): void {
  const rotated = result.items.filter((item) => item.action === "rotate");
  for (const item of result.items.filter((candidate) => candidate.action === "remove")) {
    try {
      rmSync(item.path, { force: true });
      result.removed += 1;
    } catch (error) {
      result.warnings.push(`Could not remove ${item.path}: ${messageFromError(error)}`);
    }
  }
  for (const item of rotated) {
    try {
      result.removed += rotateLog(item.path, config.logs.maxFiles);
      result.rotated += 1;
    } catch (error) {
      result.warnings.push(`Could not rotate ${item.path}: ${messageFromError(error)}`);
    }
  }
}

/**
 * Copies the log aside and empties it in place. The watcher's service manager (launchd,
 * systemd, the Windows launcher) keeps the file open for appending, so a rename would leave
 * it writing into the rotated copy; truncating keeps the open file current. Lines written
 * between the copy and the truncate are lost, which is accepted for watcher logs.
 */
function rotateLog(path: string, maxFiles: number): number {
  if (maxFiles === 0) {
    truncateSync(path, 0);
    return 1;
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const name = basename(path);
  const existing = listRotatedLogs(dir, name);
  const next = existing
    .map((candidate) => Number(candidate.slice(path.length + 1)))
    .filter((value) => Number.isInteger(value) && value > 0)
    .reduce((max, value) => Math.max(max, value), 0) + 1;
  const copy = `${path}.${next}`;
  copyFileSync(path, copy);
  try { truncateSync(path, 0); }
  catch (error) {
    // Without the truncate the next pass would copy the same lines again.
    rmSync(copy, { force: true });
    throw error;
  }
  let removed = 0;
  for (const extra of listRotatedLogs(dir, name).slice(maxFiles)) {
    rmSync(extra, { force: true });
    removed += 1;
  }
  return removed;
}

function listRotatedLogs(dir: string, name: string): string[] {
  return listFiles(dir, (candidate) => candidate.startsWith(`${name}.`) && /^\d+$/.test(candidate.slice(name.length + 1)));
}

function listFiles(dir: string, accept: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => accept(name))
    .map((name) => join(dir, name))
    .filter((path) => {
      try {
        return lstatSync(path).isFile();
      } catch {
        return false;
      }
    })
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs || right.localeCompare(left));
}

function pidFileAlive(path: string, result: ArtifactMaintenanceResult): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    if (!Number.isInteger(parsed.pid)) return true;
    return alive(parsed.pid as number);
  } catch (error) {
    result.warnings.push(`Could not inspect ${path}: ${messageFromError(error)}`);
    return true;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
