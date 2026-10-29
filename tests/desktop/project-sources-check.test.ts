// Tests the "project.sources.check" desktop action in src/desktop/service.ts and recordManualWatchRun() in src/global-watch.ts.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ensureProjectConfig } from "../../src/config.js";
import { listWatchedProjectStatuses, registerWatchedProject } from "../../src/global-watch.js";
import { handleDesktopRequest } from "../../src/desktop/service.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

let directory: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (directory) cleanupTempDir(directory);
  directory = undefined;
});

it("imports new commits on request and records the pass where the overview reads it", async () => {
  directory = makeTempDir();
  const root = join(directory, "project");
  // Point every source at the temp folder so the pass never reads the developer's own Codex or Claude logs.
  vi.stubEnv("HOME", join(directory, "user"));
  vi.stubEnv("CODE_BUTLER_HOME", join(directory, "home"));
  vi.stubEnv("CODE_BUTLER_RETRIEVAL_ENGINE", "legacy");
  mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  git("init", "-q"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
  writeFileSync(join(root, "README.md"), "# Project\n");
  git("add", "."); git("commit", "-qm", "Add the project readme");
  ensureProjectConfig(root);
  registerWatchedProject(root);

  const first = await handleDesktopRequest({ version: 1, action: "project.sources.check", root }) as { outcome: string; imported: { git: number } };
  expect(first.outcome).toBe("success");
  expect(first.imported.git).toBeGreaterThanOrEqual(1);
  const lastRun = listWatchedProjectStatuses().find(project => project.root === root)?.lastRun;
  expect(lastRun).toMatchObject({ ok: true, outcome: "success", stage: "ingestion", stages: { ingestion: { outcome: "success" } } });
  expect(lastRun?.lastSuccessAt).toBe(lastRun?.checkedAt);

  const second = await handleDesktopRequest({ version: 1, action: "project.sources.check", root }) as { outcome: string; imported: { git: number } };
  expect(second).toMatchObject({ outcome: "success", imported: { git: 0 } });

  writeFileSync(join(root, "notes.md"), "Decided to keep storage local.\n");
  git("add", "."); git("commit", "-qm", "Keep storage local");
  const third = await handleDesktopRequest({ version: 1, action: "project.sources.check", root }) as { imported: { git: number } };
  expect(third.imported.git).toBe(1);
});
