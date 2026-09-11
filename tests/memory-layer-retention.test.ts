import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { resolveBranchMemoryTriage } from "../src/memory/branch-triage.js";
import {
  listLayerRetentionDecisions,
  planLayerRetention,
  runLayerRetention
} from "../src/memory/layer-retention.js";
import { updateMemoryStatus } from "../src/memory/lifecycle-service.js";
import { CORE_LAYER } from "../src/memory/layer.js";
import { openMemoryStore, type MemoryStore } from "../src/storage/store.js";
import type { ExtractedMemory, LayerRetentionConfig, ProjectConfig } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

const roots: string[] = [];
const stores: MemoryStore[] = [];
const NOW = "2026-09-10T12:00:00.000Z";
const LONG_AGO = "2026-01-01T00:00:00.000Z";
const DEVICE = "device:9f2c4d1e-3b7a-4c5d-8e6f-0a1b2c3d4e5f";

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  roots.splice(0).forEach(cleanupTempDir);
  vi.unstubAllEnvs();
});

function root(): string {
  const dir = makeTempDir();
  roots.push(dir);
  return dir;
}

function store(rootDir = root()): MemoryStore {
  const opened = openMemoryStore(rootDir);
  opened.init();
  stores.push(opened);
  return opened;
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function commitFile(repo: string, name: string, content: string, message: string): void {
  writeFileSync(join(repo, name), content);
  git(repo, ["add", name]);
  git(repo, ["commit", "-m", message]);
}

/** `feature/gone` is created and deleted; `feature/live` and `feature/merged` remain. */
function initRepo(): string {
  const repo = root();
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  git(repo, ["checkout", "-b", "main"]);
  commitFile(repo, "README.md", "# retention\n", "Initial commit");
  git(repo, ["checkout", "-b", "feature/merged"]);
  commitFile(repo, "merged.txt", "merged\n", "Merged work");
  git(repo, ["checkout", "main"]);
  git(repo, ["merge", "--no-ff", "feature/merged", "-m", "Merge feature/merged"]);
  git(repo, ["checkout", "-b", "feature/live"]);
  commitFile(repo, "live.txt", "live\n", "Live work");
  git(repo, ["checkout", "main"]);
  return repo;
}

function config(repoPath: string, layers: Partial<LayerRetentionConfig> = {}): ProjectConfig {
  return {
    sources: { git: { repoPath } },
    retention: {
      migrationBackups: 2,
      sources: {
        git: { maxAgeDays: null },
        codex: { maxAgeDays: null },
        claude: { maxAgeDays: null },
        manual: { maxAgeDays: null }
      },
      overrides: [],
      layers: {
        enabled: true,
        graceDays: 30,
        branch: { onDeleted: "archive", onMerged: "keep", maxIdleDays: null },
        device: { maxIdleDays: null },
        ...layers
      }
    }
  } as unknown as ProjectConfig;
}

function memory(layer: string, title: string, dedupeKey: string): ExtractedMemory {
  return {
    layer,
    type: "decision",
    title,
    summary: `${title} summary.`,
    reason: `${title} reason.`,
    confidence: 1,
    dedupeKey,
    evidence: [],
    relatedFiles: []
  };
}

function age(store: MemoryStore, id: string, at = LONG_AGO): void {
  store.db.prepare("update memory_candidates set updated_at = ? where id = ?").run(at, id);
  store.db.prepare("update memories set status_changed_at = ? where id = ?").run(at, id);
}

function decisionFor(store: MemoryStore, config: ProjectConfig, id: string) {
  return planLayerRetention(store, config, {
    repoPath: config.sources.git.repoPath,
    now: NOW
  }).decisions.find((decision) => decision.memoryId === id);
}

it("archives a candidate whose branch no longer exists and leaves live, merged and core memories alone", () => {
  const repo = initRepo();
  const s = store(repo);
  const projectConfig = config(repo);
  const gone = s.upsertMemoryCandidate(memory("branch:feature/gone", "Gone", "gone"));
  const live = s.upsertMemoryCandidate(memory("branch:feature/live", "Live", "live"));
  const merged = s.upsertMemoryCandidate(memory("branch:feature/merged", "Merged", "merged"));
  const core = s.upsertMemoryCandidate(memory(CORE_LAYER, "Core", "core"));
  for (const item of [gone, live, merged, core]) age(s, item.id);

  const summary = runLayerRetention(s, projectConfig, { repoPath: repo, now: NOW });

  expect(summary).toMatchObject({ scanned: 3, archived: 1 });
  // Idempotency runs through the item's own state rather than a cached decision.
  expect(decisionFor(s, projectConfig, gone.id)).toMatchObject({
    decision: "skip",
    reasonCodes: ["already_quarantined"]
  });
  const archived = s.listMemoryCandidates({ qualityStatus: "all", limit: null }).find((item) => item.id === gone.id)!;
  expect(archived.qualityStatus).toBe("quarantined");
  expect(archived.qualityReasons).toContain("layer_retention_archived");
  for (const untouched of [live, merged]) {
    expect(s.listMemoryCandidates({ qualityStatus: "all", limit: null })
      .find((item) => item.id === untouched.id)!.qualityStatus).not.toBe("quarantined");
  }
  // Core is shared truth and is never even scanned.
  expect(planLayerRetention(s, projectConfig, { repoPath: repo, now: NOW }).decisions
    .some((decision) => decision.memoryId === core.id)).toBe(false);
});

it("retracts a promoted branch memory reversibly and records one explainable decision", () => {
  const repo = initRepo();
  const s = store(repo);
  const projectConfig = config(repo);
  const candidate = s.upsertMemoryCandidate(memory("branch:feature/gone", "Gone", "gone"));
  const promoted = s.promoteMemoryCandidate(candidate.id, "auto", { layer: "branch:feature/gone" });
  age(s, promoted.id);

  expect(runLayerRetention(s, projectConfig, { repoPath: repo, now: NOW })).toMatchObject({ archived: 1 });
  expect(s.readMemory(promoted.id)!.lifecycleStatus).toBe("retracted");

  const history = listLayerRetentionDecisions(s, {});
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    memoryId: promoted.id,
    category: "promoted",
    decision: "archive",
    policyVersion: 1,
    layer: "branch:feature/gone"
  });
  expect(history[0]!.reasonCodes).toEqual(["branch_deleted", "idle_past_grace_period"]);

  // Archival is reversible: nothing was destroyed.
  updateMemoryStatus(s, {
    memoryId: promoted.id,
    status: "current",
    reason: "Still needed.",
    now: NOW
  });
  expect(s.readMemory(promoted.id)!.lifecycleStatus).toBe("current");
});

it("holds a memory inside the grace period and re-derives the decision once it passes", () => {
  const repo = initRepo();
  const s = store(repo);
  const projectConfig = config(repo);
  const gone = s.upsertMemoryCandidate(memory("branch:feature/gone", "Gone", "gone"));
  age(s, gone.id, "2026-09-01T00:00:00.000Z");

  expect(decisionFor(s, projectConfig, gone.id)).toMatchObject({
    decision: "skip",
    reasonCodes: ["within_grace_period"]
  });
  expect(runLayerRetention(s, projectConfig, { repoPath: repo, now: NOW })).toMatchObject({ archived: 0 });
  expect(listLayerRetentionDecisions(s, {})).toHaveLength(0);

  // The clock is an input to this policy, so a skip must never be cached.
  const later = "2026-11-10T12:00:00.000Z";
  expect(runLayerRetention(s, projectConfig, { repoPath: repo, now: later })).toMatchObject({ archived: 1 });
});

it("lets an explicit retain_branch review outrank the policy", () => {
  const repo = initRepo();
  const s = store(repo);
  const projectConfig = config(repo);
  const gone = s.upsertMemoryCandidate(memory("branch:feature/gone", "Gone", "gone"));
  age(s, gone.id);
  resolveBranchMemoryTriage(s, {
    memoryId: gone.id,
    category: "candidate",
    action: "retain_branch",
    reason: "Keep this branch note.",
    now: NOW
  }, "cli");

  expect(decisionFor(s, projectConfig, gone.id)).toMatchObject({
    decision: "skip",
    reasonCodes: ["suppressed_by_retain_branch_review"]
  });
  expect(runLayerRetention(s, projectConfig, { repoPath: repo, now: NOW })).toMatchObject({ archived: 0 });
});

it("never acts without git evidence, and keeps device memories unless idle age-out is configured", () => {
  const repo = initRepo();
  const s = store(repo);
  const gone = s.upsertMemoryCandidate(memory("branch:feature/gone", "Gone", "gone"));
  const device = s.upsertMemoryCandidate(memory(DEVICE, "Device", "device"));
  for (const item of [gone, device]) age(s, item.id);

  const noGit = config(join(repo, "missing"));
  expect(decisionFor(s, noGit, gone.id)).toMatchObject({
    decision: "skip",
    reasonCodes: ["branch_state_unknown"]
  });
  expect(runLayerRetention(s, noGit, { repoPath: join(repo, "missing"), now: NOW })).toMatchObject({ archived: 0 });

  const projectConfig = config(repo);
  expect(decisionFor(s, projectConfig, device.id)).toMatchObject({
    decision: "skip",
    reasonCodes: ["device_retention_disabled"]
  });
  const withDeviceAgeOut = config(repo, { device: { maxIdleDays: 60 } });
  expect(decisionFor(s, withDeviceAgeOut, device.id)).toMatchObject({
    decision: "archive",
    reasonCodes: ["device_idle_past_max_age"]
  });
});

it("is idempotent across repeated passes and inert when disabled", () => {
  const repo = initRepo();
  const s = store(repo);
  const projectConfig = config(repo);
  const gone = s.upsertMemoryCandidate(memory("branch:feature/gone", "Gone", "gone"));
  age(s, gone.id);

  const countRows = (table: string): number =>
    Number((s.db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n);

  runLayerRetention(s, projectConfig, { repoPath: repo, now: NOW });
  const decisions = countRows("layer_retention_decisions");
  const operations = countRows("operation_log");

  expect(runLayerRetention(s, projectConfig, { repoPath: repo, now: NOW })).toMatchObject({ archived: 0 });
  expect(countRows("layer_retention_decisions")).toBe(decisions);
  expect(countRows("operation_log")).toBe(operations);

  const disabled = planLayerRetention(s, config(repo, { enabled: false }), { repoPath: repo, now: NOW });
  expect(disabled).toMatchObject({ enabled: false, scanned: 0, decisions: [] });
});
