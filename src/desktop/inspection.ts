import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { validateProjectConfigFile } from "../config.js";
import { readProjectBrief } from "../project-summary/service.js";
import { inspectProjectSetupArtifacts } from "../project-setup.js";
import { getMigrationStatus } from "../storage/migrations.js";
import type { DesktopProjectInspection } from "./contracts.js";

/** Inspect an existing folder without creating config, SQLite, or summary files. */
export function inspectDesktopProject(root: string): DesktopProjectInspection {
  const configPath = join(root, ".code-butler", "config.json");
  const localPath = join(root, ".code-butler", "config.local.json");
  const databasePath = join(root, ".code-butler", "memory.sqlite");
  const missing: DesktopProjectInspection["missing"] = [];

  for (const path of [
    join(root, ".code-butler"), configPath, localPath, databasePath,
    `${databasePath}-wal`, `${databasePath}-shm`,
    join(root, ".code-butler", "project-summary.md"),
    join(root, ".code-butler", "project-summary.meta.json"),
    join(root, ".code-butler", "setup.meta.json"), join(root, "AGENTS.md"), join(root, "CLAUDE.md")
  ]) {
    try {
      if (lstatSync(path).isSymbolicLink()) {
        return { root, status: "invalid", missing, issue: "Project setup uses a symbolic link; Code Butler will not initialize outside the selected folder." };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { root, status: "invalid", missing, issue: "Project setup files cannot be inspected." };
      }
    }
  }

  if (!existsSync(configPath)) missing.push("config");
  else {
    try { readAndValidateConfig(configPath); }
    catch (error) {
      return { root, status: "invalid", missing, issue: `Project config is invalid: ${error instanceof Error ? error.message : "cannot read it"}` };
    }
  }
  if (existsSync(localPath)) {
    try { readAndValidateConfig(localPath); }
    catch (error) {
      return { root, status: "invalid", missing, issue: `Local project config is invalid: ${error instanceof Error ? error.message : "cannot read it"}` };
    }
  }

  let needsUpgrade = false;
  let emptyDatabase = false;
  if (!existsSync(databasePath)) missing.push("database");
  else {
    // Immutable SQLite reads cannot see uncheckpointed WAL pages. Reporting
    // missing schema here would incorrectly suggest initializing an active DB.
    try {
      const walPath = `${databasePath}-wal`;
      if (existsSync(walPath) && statSync(walPath).size > 0) {
        return { root, status: "busy", missing, issue: "Project memory has active or uncheckpointed changes. Try again after the current Code Butler operation finishes." };
      }
    } catch {
      return { root, status: "busy", missing, issue: "Project memory is in use or cannot be inspected right now." };
    }
    let db: DatabaseSync | undefined;
    try {
      const immutableUrl = pathToFileURL(databasePath);
      immutableUrl.searchParams.set("immutable", "1");
      db = new DatabaseSync(immutableUrl, { readOnly: true });
      const check = db.prepare("PRAGMA quick_check").get() as { quick_check: string } | undefined;
      if (check?.quick_check !== "ok") throw new Error("SQLite integrity check failed");
      const migration = getMigrationStatus(db, databasePath);
      emptyDatabase = migration.currentVersion === 0;
      needsUpgrade = migration.currentVersion > 0 && migration.pendingVersions.length > 0;
    } catch (error) {
      return { root, status: "invalid", missing, issue: `Memory database is invalid: ${error instanceof Error ? error.message : "cannot read it"}` };
    } finally {
      db?.close();
    }
  }

  try {
    const brief = readProjectBrief(root);
    if (!brief.exists) missing.push("summary");
    else if (!brief.summary.trim()) missing.push("summary");
    for (const artifact of inspectProjectSetupArtifacts(root)) {
      if (!missing.includes(artifact)) missing.push(artifact);
    }
  } catch (error) {
    return { root, status: "invalid", missing, issue: `Project summary is invalid: ${error instanceof Error ? error.message : "cannot read it"}` };
  }

  return {
    root,
    status: needsUpgrade ? "needs-upgrade" : missing.length || emptyDatabase ? "needs-init" : "ready",
    missing,
    ...(emptyDatabase ? { issue: "The memory database has no Code Butler schema yet." } : {})
  };
}

function readAndValidateConfig(path: string): void {
  const raw = readFileSync(path, "utf8").trim();
  validateProjectConfigFile(JSON.parse(raw || "{}"));
}
