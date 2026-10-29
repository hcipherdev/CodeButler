// Tests checkMaintenancePass()/recordMaintenancePass()/maintenanceRevision() in src/sync/maintenance-pass.ts and the watcher skip of promotion and retention in syncWatchedProjectMemory() (src/sync/service.ts), including watcher-timing.json phase fields and quiet-window waiting counts.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateDirectory } from "../../src/cloud/state.js";
import { ensureProjectConfig, extractionPolicy, loadProjectConfig } from "../../src/config.js";
import { openConfiguredMemoryStore } from "../../src/storage/open-configured-store.js";
import { syncProjectMemory, syncWatchedProjectMemory } from "../../src/sync/service.js";
import { MAINTENANCE_RERUN_MS } from "../../src/sync/maintenance-pass.js";
import type { ProjectConfig } from "../../src/types.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const roots: string[] = [];
let originalHome: string | undefined;
beforeEach(() => {
  originalHome = process.env.CODE_BUTLER_HOME;
  const home = makeTempDir(); roots.push(home);
  process.env.CODE_BUTLER_HOME = home;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.CODE_BUTLER_HOME;
  else process.env.CODE_BUTLER_HOME = originalHome;
  for (const root of roots.splice(0)) cleanupTempDir(root);
});

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

function project(): { root: string; config: ProjectConfig } {
  const directory = makeTempDir(); roots.push(directory);
  const root = join(directory, "project"); mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "start");
  ensureProjectConfig(root);
  const config = loadProjectConfig(root);
  config.sources.git.enabled = false;
  config.sources.codex.enabled = false;
  config.sources.claude.enabled = false;
  config.embeddings.enabled = false;
  return { root, config };
}

const pass = (root: string, config: ProjectConfig) => syncWatchedProjectMemory(root, config, { source: "git" });
const recordPath = (root: string) => join(stateDirectory(root), "maintenance-pass.json");

describe("watcher maintenance skip", () => {
  it("runs the first pass, skips an unchanged second pass and records phase timing", async () => {
    const { root, config } = project();
    const first = await pass(root, config);
    expect(first.maintenanceSkipped).toBeUndefined();
    expect(first.promotions).toBeDefined();
    const record = readFileSync(recordPath(root), "utf8");

    const second = await pass(root, config);
    expect(second.maintenanceSkipped).toBe(true);
    expect(second.promotions).toBeUndefined();
    expect(second.retention).toBeUndefined();
    expect(readFileSync(recordPath(root), "utf8")).toBe(record);

    const timing = JSON.parse(readFileSync(join(root, ".code-butler", "watcher-timing.json"), "utf8"));
    expect(timing).toMatchObject({ maintenanceSkipped: true });
    for (const field of ["preparationMs", "extractionPrepMs", "maintenanceMs", "gateHoldMs", "importMs", "totalMs"])
      expect(typeof timing[field]).toBe("number");
    expect(timing.gateHoldMs).toBeLessThanOrEqual(timing.totalMs);
  });

  it("runs again after a canonical write", async () => {
    const { root, config } = project();
    await pass(root, config);
    const store = openConfiguredMemoryStore(root); store.init();
    try {
      store.addCommit({ hash: "maintenance-commit", authorName: "Test", authorEmail: "test@example.com",
        authoredAt: "2026-10-01T10:00:00Z", message: "New evidence", changedFiles: ["src/work.ts"], diffSummary: "+ work" });
    } finally { store.close(); }
    expect((await pass(root, config)).maintenanceSkipped).toBeUndefined();
    expect((await pass(root, config)).maintenanceSkipped).toBe(true);
  });

  it("stays skipped while only a growing session's messages are re-imported", async () => {
    const { root, config } = project();
    await pass(root, config);
    const store = openConfiguredMemoryStore(root); store.init();
    try {
      for (const count of [2, 3]) store.addSourceWithChunks({
        source: { id: "claude:active", type: "conversation", title: "active.jsonl", origin: "/tmp/active.jsonl", rawContent: "user: still working" },
        chunks: Array.from({ length: count }, (_, index) => ({ text: `Message ${index}`, metadata: { timestamp: "2026-10-19T10:00:00Z" } }))
      });
    } finally { store.close(); }
    expect((await pass(root, config)).maintenanceSkipped).toBe(true);
  });

  it("does not count a session waiting to go quiet as pending work", async () => {
    const { root, config } = project();
    const store = openConfiguredMemoryStore(root); store.init();
    try {
      store.addSourceWithChunks({
        source: { id: "claude:active", type: "conversation", title: "active.jsonl", origin: "/tmp/active.jsonl", rawContent: "user: still working" },
        chunks: [{ text: "Message 0", metadata: { timestamp: "2026-10-19T10:00:00Z" } }]
      });
      store.enqueueExtractionEvidence("claude", "conversation", "claude:active");
    } finally { store.close(); }
    const extractorProvider = { async extract() { return { memories: [], rejected: [] }; } };
    const result = await syncWatchedProjectMemory(root, { ...config, extraction: { ...extractionPolicy(config), conversationQuietMinutes: 10 } }, { extractorProvider });
    expect(result.memories).toMatchObject({ pending: 1, waiting: 1 });
  });

  it("runs again after a config change", async () => {
    const { root, config } = project();
    await pass(root, config);
    const changed = structuredClone(config);
    changed.embeddings.batchSize += 1;
    expect((await pass(root, changed)).maintenanceSkipped).toBeUndefined();
    expect((await pass(root, changed)).maintenanceSkipped).toBe(true);
  });

  it("runs again after a new branch or a HEAD switch", async () => {
    const { root, config } = project();
    await pass(root, config);
    git(root, "branch", "feature");
    expect((await pass(root, config)).maintenanceSkipped).toBeUndefined();
    expect((await pass(root, config)).maintenanceSkipped).toBe(true);
    git(root, "checkout", "-q", "feature");
    expect((await pass(root, config)).maintenanceSkipped).toBeUndefined();
  });

  it("runs again once the last pass is older than the rerun bound", async () => {
    const { root, config } = project();
    await pass(root, config);
    const record = JSON.parse(readFileSync(recordPath(root), "utf8"));
    record.ranAt = new Date(Date.now() - MAINTENANCE_RERUN_MS - 1000).toISOString();
    writeFileSync(recordPath(root), JSON.stringify(record));
    expect((await pass(root, config)).maintenanceSkipped).toBeUndefined();
  });

  it("does not skip for an explicit sync", async () => {
    const { root, config } = project();
    await pass(root, config);
    const store = openConfiguredMemoryStore(root); store.init();
    try {
      const result = await syncProjectMemory(store, config, { source: "git" });
      expect(result.maintenanceSkipped).toBeUndefined();
      expect(result.promotions).toBeDefined();
    } finally { store.close(); }
  });
});
