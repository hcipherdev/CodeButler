// Tests the inputDigest and commit basis saved by refreshProjectSummary() and the changesSince / refreshRecommended fields of getProjectSummaryStatus() in src/project-summary/service.ts.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { ensureProjectConfig, loadProjectConfig } from "../../src/config.js";
import { rememberProjectMemory } from "../../src/memory/remember.js";
import { getProjectSummaryStatus, refreshProjectSummary, type ProjectSummaryGenerator } from "../../src/project-summary/service.js";
import { openMemoryStore, type MemoryStore } from "../../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const opened: Array<{ root: string; store: MemoryStore }> = [];
afterEach(() => { for (const { root, store } of opened.splice(0)) { store.close(); cleanupTempDir(root); } });

const WRITTEN = "2026-10-25T19:45:50.000Z";
const at = (hours: number) => () => new Date(Date.parse(WRITTEN) + hours * 3_600_000);
const generator: ProjectSummaryGenerator = { async generate() { return "## What this is\n\nA repository summary.\n\n## How it's built\n\nFrom recorded facts."; } };

async function writtenProject() {
  const root = makeTempDir();
  writeFileSync(join(root, "README.md"), "# Example\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "--all"], { cwd: root });
  ensureProjectConfig(root);
  const store = openMemoryStore(root); store.init(); opened.push({ root, store });
  const config = loadProjectConfig(root);
  await refreshProjectSummary(store, config, { generator, now: at(0) });
  const status = (hours: number) => getProjectSummaryStatus(root, { store, config, now: at(hours) });
  return { root, store, config, status };
}
const commit = (store: MemoryStore, hash: string, hoursAfter: number) => store.addCommit({ hash, authorName: "Dev", authorEmail: "dev@example.test",
  authoredAt: new Date(Date.parse(WRITTEN) + hoursAfter * 3_600_000).toISOString(), message: `Change ${hash}`, changedFiles: ["src/lib.rs"], diffSummary: "1 file" });

it("records what the narrative was built from and reports nothing changed right after writing it", async () => {
  const { root, status } = await writtenProject();
  const meta = JSON.parse(readFileSync(join(root, ".code-butler", "project-summary.meta.json"), "utf8"));
  expect(meta.inputDigest).toMatchObject({ commits: [], memories: {}, files: expect.any(String) });
  expect(status(1)).toMatchObject({ stale: false, writtenAt: WRITTEN, refreshRecommended: false, changesSince: { commits: 0, memories: 0, files: false } });
});

it("counts commits, memory changes and file changes, and recommends a refresh only after a day", async () => {
  const { root, store, status } = await writtenProject();
  commit(store, "a".repeat(40), 1); commit(store, "b".repeat(40), 2);
  rememberProjectMemory(store, { type: "decision", text: "The watcher owns cloud publishing for every registered project." });
  writeFileSync(join(root, "README.md"), "# Example\nChanged.\n");
  expect(status(23)).toMatchObject({ stale: true, refreshRecommended: false, changesSince: { commits: 2, commitsCapped: false, memories: 1, files: true } });
  expect(status(24).refreshRecommended).toBe(true);
});

it("dates commits against the written time when the narrative has no digest", async () => {
  const { root, store, status } = await writtenProject();
  const metaPath = join(root, ".code-butler", "project-summary.meta.json");
  const { inputDigest: _digest, ...older } = JSON.parse(readFileSync(metaPath, "utf8"));
  writeFileSync(metaPath, JSON.stringify(older));
  commit(store, "c".repeat(40), -1); commit(store, "d".repeat(40), 3);
  const changes = status(4).changesSince!;
  expect(changes).toMatchObject({ commits: 1, commitsCapped: false });
  expect(changes.memories).toBeUndefined();
  expect(changes.files).toBeUndefined();
});

it("records the newest input commit as the basis, and backfills it on an unchanged check", async () => {
  const { root, store, config } = await writtenProject();
  const metaPath = join(root, ".code-butler", "project-summary.meta.json");
  const readMeta = () => JSON.parse(readFileSync(metaPath, "utf8"));
  expect(readMeta().basis).toBeUndefined();
  commit(store, "a".repeat(40), 1); commit(store, "b".repeat(40), 2);
  await refreshProjectSummary(store, config, { generator, now: at(3) });
  expect(readMeta().basis).toEqual({ commit: "b".repeat(40), committedAt: new Date(Date.parse(WRITTEN) + 2 * 3_600_000).toISOString() });
  const { basis: _basis, ...older } = readMeta();
  writeFileSync(metaPath, JSON.stringify(older));
  const checked = await refreshProjectSummary(store, config, { generator, now: at(30) });
  expect(checked.generated).toBe(false);
  expect(readMeta().basis).toMatchObject({ commit: "b".repeat(40) });
});
