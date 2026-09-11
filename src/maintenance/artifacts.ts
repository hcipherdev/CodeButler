import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync
} from "node:fs";
import { basename, dirname, join } from "node:path";

import type { ArtifactRetentionConfig } from "../types.js";

export type ArtifactMaintenanceAction = "remove" | "rotate";
export type ArtifactMaintenanceCategory = "logs" | "projectSummaryBackups" | "recoveryBackups" | "cloudHandles";

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
  inspectRecoveryBackups(dataDir, config, options.now ?? new Date(), result);
  inspectCloudHandles(dataDir, config, result);
  if (options.apply) applyMaintenance(result, config);
  return result;
}

function inspectLogs(dataDir: string, config: ArtifactRetentionConfig, result: ArtifactMaintenanceResult): void {
  const logsDir = join(dataDir, "logs");
  for (const name of ["watch.out.log", "watch.err.log"]) {
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

function inspectCloudHandles(dataDir: string, config: ArtifactRetentionConfig, result: ArtifactMaintenanceResult): void {
  if (!config.cloudHandles.reapStale) return;
  const handleDir = join(dataDir, ".cloud-handles");
  for (const handle of listFiles(handleDir, () => true)) {
    result.scanned += 1;
    if (!pidFileAlive(handle, result)) {
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

function applyMaintenance(result: ArtifactMaintenanceResult, config: ArtifactRetentionConfig): void {
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

function rotateLog(path: string, maxFiles: number): number {
  if (maxFiles === 0) {
    rmSync(path, { force: true });
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
  renameSync(path, `${path}.${next}`);
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
