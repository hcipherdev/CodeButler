import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface BackupPurgeResult {
  removed: string[];
  failed: Array<{ path: string; error: string }>;
}

export function createRecoveryBackup(databasePath: string, now: Date = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const backupPath = `${databasePath}.recovery-${timestamp}-${randomUUID()}.sqlite`;
  const script = `
    const { backup, DatabaseSync } = require('node:sqlite');
    const source = new DatabaseSync(process.argv[1], { readOnly: true });
    backup(source, process.argv[2])
      .then(() => source.close())
      .catch((error) => { try { source.close(); } catch {} console.error(error); process.exitCode = 1; });
  `;
  execFileSync(process.execPath, ["-e", script, databasePath, backupPath], { stdio: "ignore" });
  verifyDatabaseFile(backupPath);
  return backupPath;
}

export function verifyDatabaseFile(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const quick = db.prepare("pragma quick_check").get() as { quick_check: string };
    if (quick.quick_check !== "ok") throw new Error(`Database backup failed quick_check: ${quick.quick_check}`);
    const foreignKeys = db.prepare("pragma foreign_key_check").all();
    if (foreignKeys.length > 0) throw new Error("Database backup failed foreign_key_check");
  } finally {
    db.close();
  }
}

export function removeRecoveryBackup(path: string): void {
  unlinkDatabaseFile(path);
}

export function restoreRecoveryBackup(databasePath: string, backupPath: string): void {
  copyFileSync(backupPath, databasePath);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${databasePath}${suffix}`;
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
  verifyDatabaseFile(databasePath);
}

export function listDatabaseBackups(databasePath: string): string[] {
  const directory = dirname(databasePath);
  const databaseName = basename(databasePath);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) =>
      name.endsWith(".sqlite") &&
      (name.startsWith(`${databaseName}.backup-`) || name.startsWith(`${databaseName}.recovery-`))
    )
    .map((name) => join(directory, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs || right.localeCompare(left));
}

export function purgeDatabaseBackups(databasePath: string, exclude: readonly string[] = []): BackupPurgeResult {
  const excluded = new Set(exclude);
  const result: BackupPurgeResult = { removed: [], failed: [] };
  for (const path of listDatabaseBackups(databasePath)) {
    if (excluded.has(path)) continue;
    try {
      unlinkDatabaseFile(path);
      result.removed.push(path);
    } catch (error) {
      result.failed.push({
        path,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return result;
}

function unlinkDatabaseFile(path: string): void {
  if (existsSync(path)) unlinkSync(path);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${path}${suffix}`;
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
}
