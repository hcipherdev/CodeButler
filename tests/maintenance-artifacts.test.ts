import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inspectArtifactMaintenance, runArtifactMaintenance } from "../src/maintenance/artifacts.js";
import type { ArtifactRetentionConfig } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

const config: ArtifactRetentionConfig = {
  logs: { maxBytes: 1024, maxFiles: 3 },
  projectSummaryBackups: { maxFiles: 5 },
  recoveryBackups: { maxFiles: 5, minAgeDays: 7 },
  cloudHandles: { reapStale: true }
};

describe("artifact maintenance", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  function createProject(): { rootDir: string; dataDir: string } {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, ".code-butler");
    mkdirSync(dataDir, { recursive: true });
    return { rootDir, dataDir };
  }

  function touch(path: string, contents: string, at: string): void {
    writeFileSync(path, contents);
    utimesSync(path, new Date(at), new Date(at));
  }

  it("rotates an oversized watcher log and keeps only the configured rotated copies", () => {
    const { rootDir, dataDir } = createProject();
    const logsDir = join(dataDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const active = join(logsDir, "watch.out.log");
    touch(active, "x".repeat(2048), "2026-06-20T00:00:00.000Z");
    for (let index = 1; index <= 4; index += 1) {
      touch(`${active}.${index}`, `rotated ${index}`, `2026-06-1${index}T00:00:00.000Z`);
    }

    const result = runArtifactMaintenance(rootDir, config, { apply: true });

    expect(result.rotated).toBe(1);
    expect(existsSync(active)).toBe(false);
    const rotated = readdirSync(logsDir).filter((name) => name.startsWith("watch.out.log."));
    expect(rotated).toHaveLength(3);
    expect(rotated).toContain("watch.out.log.5");
    expect(readFileSync(join(logsDir, "watch.out.log.5"), "utf8")).toHaveLength(2048);
    expect(rotated).not.toContain("watch.out.log.1");
    expect(result.warnings).toEqual([]);
  });

  it("leaves an in-limit watcher log and its rotated copies untouched", () => {
    const { rootDir, dataDir } = createProject();
    const logsDir = join(dataDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const active = join(logsDir, "watch.err.log");
    touch(active, "small", "2026-06-20T00:00:00.000Z");
    touch(`${active}.1`, "rotated", "2026-06-19T00:00:00.000Z");

    const result = runArtifactMaintenance(rootDir, config, { apply: true });

    expect(result.items).toEqual([]);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(`${active}.1`)).toBe(true);
  });

  it("never prunes recovery backups newer than the minimum age", () => {
    const { rootDir, dataDir } = createProject();
    const now = new Date("2026-06-20T00:00:00.000Z");
    for (let index = 0; index < 8; index += 1) {
      touch(
        join(dataDir, `memory.sqlite.recovery-2026-06-1${index}T00-00-00-000Z-test.sqlite`),
        `recovery ${index}`,
        `2026-06-1${index}T00:00:00.000Z`
      );
    }

    const result = runArtifactMaintenance(rootDir, config, { apply: true, now });

    // 2026-06-10 through 2026-06-13 are older than 7 days; the rest are protected.
    expect(result.removed).toBe(0);
    expect(result.items).toEqual([]);
    expect(readdirSync(dataDir).filter((name) => name.startsWith("memory.sqlite.recovery-"))).toHaveLength(8);
  });

  it("prunes only eligible aged recovery backups beyond the retained count", () => {
    const { rootDir, dataDir } = createProject();
    const now = new Date("2026-06-20T00:00:00.000Z");
    for (let index = 1; index <= 7; index += 1) {
      touch(
        join(dataDir, `memory.sqlite.recovery-2026-06-0${index}T00-00-00-000Z-test.sqlite`),
        `aged ${index}`,
        `2026-06-0${index}T00:00:00.000Z`
      );
    }
    touch(
      join(dataDir, "memory.sqlite.recovery-2026-06-19T00-00-00-000Z-test.sqlite"),
      "fresh",
      "2026-06-19T00:00:00.000Z"
    );

    const result = runArtifactMaintenance(rootDir, config, { apply: true, now });

    expect(result.removed).toBe(2);
    const remaining = readdirSync(dataDir).filter((name) => name.startsWith("memory.sqlite.recovery-"));
    expect(remaining).toHaveLength(6);
    expect(remaining).toContain("memory.sqlite.recovery-2026-06-19T00-00-00-000Z-test.sqlite");
    expect(remaining).not.toContain("memory.sqlite.recovery-2026-06-01T00-00-00-000Z-test.sqlite");
    expect(remaining).not.toContain("memory.sqlite.recovery-2026-06-02T00-00-00-000Z-test.sqlite");
  });

  it("reaps cloud handles only when the recorded PID is not alive", () => {
    const { rootDir, dataDir } = createProject();
    const handleDir = join(dataDir, ".cloud-handles");
    mkdirSync(handleDir, { recursive: true });
    const live = join(handleDir, `${process.pid}-live.json`);
    const dead = join(handleDir, "1-dead.json");
    writeFileSync(live, JSON.stringify({ pid: process.pid }));
    writeFileSync(dead, JSON.stringify({ pid: 99999999 }));
    writeFileSync(join(dataDir, ".cloud-owner-live"), JSON.stringify({ pid: process.pid, token: "live" }));
    writeFileSync(join(dataDir, ".cloud-owner-dead"), JSON.stringify({ pid: 99999999, token: "dead" }));

    const result = runArtifactMaintenance(rootDir, config, { apply: true });

    expect(result.removed).toBe(2);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(join(dataDir, ".cloud-owner-live"))).toBe(true);
    expect(existsSync(join(dataDir, ".cloud-owner-dead"))).toBe(false);
  });

  it("keeps cloud handles when reaping is disabled", () => {
    const { rootDir, dataDir } = createProject();
    const handleDir = join(dataDir, ".cloud-handles");
    mkdirSync(handleDir, { recursive: true });
    const dead = join(handleDir, "1-dead.json");
    writeFileSync(dead, JSON.stringify({ pid: 99999999 }));

    const result = runArtifactMaintenance(
      rootDir,
      { ...config, cloudHandles: { reapStale: false } },
      { apply: true }
    );

    expect(result.items).toEqual([]);
    expect(existsSync(dead)).toBe(true);
  });

  it("reports planned deletions without mutating files during inspection", () => {
    const { rootDir, dataDir } = createProject();
    const backupDir = join(dataDir, "backups", "project-summary");
    mkdirSync(backupDir, { recursive: true });
    for (let index = 0; index < 7; index += 1) {
      touch(
        join(backupDir, `project-summary-2026-06-1${index}T00-00-00-000Z.md`),
        `backup ${index}`,
        `2026-06-1${index}T00:00:00.000Z`
      );
    }

    const planned = inspectArtifactMaintenance(rootDir, config);

    expect(planned.dryRun).toBe(true);
    expect(planned.removed).toBe(0);
    expect(planned.items).toHaveLength(2);
    expect(planned.items.every((item) => item.category === "projectSummaryBackups")).toBe(true);
    expect(readdirSync(backupDir)).toHaveLength(7);

    const applied = runArtifactMaintenance(rootDir, config, { apply: true });

    expect(applied.removed).toBe(2);
    expect(readdirSync(backupDir)).toHaveLength(5);
    expect(readdirSync(backupDir)).not.toContain("project-summary-2026-06-10T00-00-00-000Z.md");
  });

  it("skips missing artifact directories without warnings", () => {
    const { rootDir } = createProject();

    const result = inspectArtifactMaintenance(rootDir, config);

    expect(result).toMatchObject({ scanned: 0, removed: 0, rotated: 0, items: [], warnings: [] });
  });
});
