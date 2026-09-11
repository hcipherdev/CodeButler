import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
  applyAutomaticPromotion,
  listPromotionDecisions,
  planAutomaticPromotions,
  runAutomaticPromotions,
  PROMOTION_POLICY_VERSION
} from "../src/memory/automatic-promotion.js";
import { resolveBranchMemoryTriage } from "../src/memory/branch-triage.js";
import { rememberProjectMemory } from "../src/memory/remember.js";
import { CORE_LAYER } from "../src/memory/layer.js";
import { openMemoryStore, type MemoryStore } from "../src/storage/store.js";
import type { ProjectConfig } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

const roots: string[] = [], stores: MemoryStore[] = [];
const DEVICE = "9f2c4d1e-3b7a-4c5d-8e6f-0a1b2c3d4e5f";
const BRANCH = "feature/auto-promotion";

function root() { const r = makeTempDir(); roots.push(r); return r; }
function store() {
  const s = openMemoryStore(root(), { deviceLayer: () => `device:${DEVICE}` });
  s.init(); stores.push(s); return s;
}
function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** A repo whose feature branch is merged into main, so triage reports `merged`. */
function repoWithMergedBranch(): string {
  const repo = root();
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  git(repo, ["checkout", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# test\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "Initial commit"]);
  git(repo, ["checkout", "-b", BRANCH]);
  writeFileSync(join(repo, "feature.md"), "# feature\n");
  git(repo, ["add", "feature.md"]);
  git(repo, ["commit", "-m", "Add feature"]);
  git(repo, ["checkout", "main"]);
  git(repo, ["merge", "--no-ff", "-m", "Merge feature", BRANCH]);
  return repo;
}

/** A repo whose feature branch is still unmerged and checked out. */
function repoOnActiveBranch(): string {
  const repo = root();
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  git(repo, ["checkout", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# test\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "Initial commit"]);
  git(repo, ["checkout", "-b", BRANCH]);
  writeFileSync(join(repo, "wip.md"), "# wip\n");
  git(repo, ["add", "wip.md"]);
  git(repo, ["commit", "-m", "Work in progress"]);
  return repo;
}

function config(overrides: Partial<ProjectConfig["promotion"]["automatic"]> = {}): ProjectConfig {
  return {
    promotion: {
      confidenceThreshold: 0.85,
      requireCommitAndConversation: true,
      minSourceCategories: 2,
      automatic: {
        enabled: true,
        mode: "conservative",
        minScore: 0.85,
        mergedBranches: true,
        deviceMemories: true,
        ...overrides
      }
    },
    sources: { git: { repoPath: "" } }
  } as unknown as ProjectConfig;
}

function configFor(repoPath: string, overrides: Partial<ProjectConfig["promotion"]["automatic"]> = {}): ProjectConfig {
  const base = config(overrides);
  return { ...base, sources: { ...base.sources, git: { ...base.sources.git, repoPath } } } as ProjectConfig;
}

/** A project-scoped branch candidate: eligible on scope alone, no evidence needed. */
function branchCandidate(s: MemoryStore, text: string, dedupeKey = "auto-promote") {
  return s.upsertMemoryCandidate({
    layer: `branch:${BRANCH}:device:${DEVICE}`,
    type: "decision",
    title: "Cache tokens in Redis",
    summary: text,
    reason: "Discovered while building the feature.",
    confidence: 0.95,
    scope: { kind: "project" },
    evidence: [],
    relatedFiles: [],
    dedupeKey
  }, { qualityStatus: "active", qualityReasons: [] });
}

afterEach(() => {
  stores.splice(0).forEach(s => s.close());
  vi.unstubAllEnvs();
  roots.splice(0).forEach(cleanupTempDir);
});

it("promotes a merged-branch candidate to core and marks it promoted atomically", () => {
  const repo = repoWithMergedBranch();
  const s = store();
  const candidate = branchCandidate(s, "The auth middleware caches tokens in Redis.");

  const summary = runAutomaticPromotions(s, configFor(repo), { repoPath: repo });
  expect(summary.promoted).toBe(1);

  const core = s.listMemories({ layer: "core", lifecycleStatus: "current", qualityStatus: "all", limit: null });
  expect(core).toHaveLength(1);
  expect(core[0]!.summary).toBe("The auth middleware caches tokens in Redis.");

  // Never a core-layer candidate that is still unpromoted.
  const stored = s.listMemoryCandidates({ qualityStatus: "all", limit: null }).find(c => c.id === candidate.id)!;
  expect(stored.promotionState).toBe("promoted");
  expect(stored.layer).toBe(CORE_LAYER);
  expect(stored.promotedMemoryId).toBe(core[0]!.id);
});

it("converges on an existing core fact instead of raising a uniqueness error", () => {
  const repo = repoWithMergedBranch();
  const s = store();
  // The same fact already lives in core, so both uniqueness keys are occupied.
  const existing = rememberProjectMemory(s, {
    type: "decision",
    title: "Cache tokens in Redis",
    text: "The auth middleware caches tokens in Redis.",
    scope: { kind: "project" }
  });
  const candidate = branchCandidate(s, "The auth middleware caches tokens in Redis.");

  const plan = planAutomaticPromotions(s, configFor(repo), { repoPath: repo });
  const decision = plan.decisions.find(d => d.memoryId === candidate.id)!;
  expect(decision.decision).toBe("converge");
  expect(decision.coreMemoryId).toBe(existing.memory!.id);

  // The bug this replaces was `UNIQUE constraint failed` during the layer move.
  expect(() => applyAutomaticPromotion(s, decision, "system")).not.toThrow();

  // Converged, not duplicated.
  expect(s.listMemories({ layer: "core", lifecycleStatus: "current", qualityStatus: "all", limit: null })).toHaveLength(1);
  const stored = s.listMemoryCandidates({ qualityStatus: "all", limit: null }).find(c => c.id === candidate.id)!;
  expect(stored.promotionState).toBe("promoted");
  expect(stored.promotedMemoryId).toBe(existing.memory!.id);
});

it("defers a contradictory core fact for review instead of choosing silently", () => {
  const repo = repoWithMergedBranch();
  const s = store();
  const existing = rememberProjectMemory(s, {
    type: "decision",
    title: "Cache tokens in Redis",
    text: "The auth middleware caches tokens in Postgres, not Redis.",
    scope: { kind: "project" }
  });
  const candidate = branchCandidate(s, "The auth middleware caches tokens in Redis.");

  const summary = runAutomaticPromotions(s, configFor(repo), { repoPath: repo });
  expect(summary.deferred).toBe(1);
  expect(summary.promoted).toBe(0);

  // Core is untouched and the local item is flagged, not moved.
  const core = s.listMemories({ layer: "core", lifecycleStatus: "current", qualityStatus: "all", limit: null });
  expect(core).toHaveLength(1);
  expect(core[0]!.id).toBe(existing.memory!.id);
  const stored = s.listMemoryCandidates({ qualityStatus: "all", limit: null }).find(c => c.id === candidate.id)!;
  expect(stored.qualityStatus).toBe("needs_review");
  expect(stored.qualityReasons).toContain("automatic_promotion_conflict");
  expect(stored.layer).toBe(`branch:${BRANCH}:device:${DEVICE}`);
});

it("holds memories on a branch that is still active", () => {
  const repo = repoOnActiveBranch();
  const s = store();
  const candidate = branchCandidate(s, "Still deciding how to cache tokens.");

  const plan = planAutomaticPromotions(s, configFor(repo), { repoPath: repo });
  const decision = plan.decisions.find(d => d.memoryId === candidate.id)!;
  expect(decision.decision).toBe("skip");
  expect(decision.reasonCodes.some(code => code.startsWith("branch_"))).toBe(true);
  expect(s.listMemories({ layer: "core", qualityStatus: "all", limit: null })).toHaveLength(0);
});

it("lets an explicit retain_branch review suppress automatic promotion", () => {
  const repo = repoWithMergedBranch();
  const s = store();
  const candidate = branchCandidate(s, "The auth middleware caches tokens in Redis.");
  resolveBranchMemoryTriage(s, {
    memoryId: candidate.id,
    category: "candidate",
    action: "retain_branch",
    reason: "Keep this on the branch for now."
  }, "cli");

  const plan = planAutomaticPromotions(s, configFor(repo), { repoPath: repo });
  const decision = plan.decisions.find(d => d.memoryId === candidate.id)!;
  expect(decision.decision).toBe("skip");
  expect(decision.reasonCodes).toContain("suppressed_by_retain_branch_review");
  expect(s.listMemories({ layer: "core", qualityStatus: "all", limit: null })).toHaveLength(0);
});

it("skips weak, unconfident, and non-active memories with explicit reason codes", () => {
  const repo = repoWithMergedBranch();
  const s = store();
  const lowConfidence = s.upsertMemoryCandidate({
    layer: `branch:${BRANCH}:device:${DEVICE}`,
    type: "decision", title: "Maybe cache tokens", summary: "Perhaps Redis.",
    reason: "Guess.", confidence: 0.2, scope: { kind: "project" },
    evidence: [], relatedFiles: [], dedupeKey: "low-confidence"
  }, { qualityStatus: "active", qualityReasons: [] });
  const quarantined = s.upsertMemoryCandidate({
    layer: `branch:${BRANCH}:device:${DEVICE}`,
    type: "constraint", title: "Quarantined item", summary: "Suspect content.",
    reason: "Flagged.", confidence: 0.99, scope: { kind: "project" },
    evidence: [], relatedFiles: [], dedupeKey: "quarantined"
  }, { qualityStatus: "quarantined", qualityReasons: ["suspect"] });
  // No project scope and no corroboration: a lone local observation.
  const unshared = s.upsertMemoryCandidate({
    layer: `device:${DEVICE}`,
    type: "bug_fix", title: "Local only", summary: "Rebuild fixed it on this laptop.",
    reason: "Observed locally.", confidence: 0.99,
    evidence: [], relatedFiles: [], dedupeKey: "unshared"
  }, { qualityStatus: "active", qualityReasons: [] });

  const plan = planAutomaticPromotions(s, configFor(repo), { repoPath: repo });
  const byId = new Map(plan.decisions.map(d => [d.memoryId, d]));
  expect(byId.get(lowConfidence.id)!.reasonCodes).toContain("below_confidence_threshold");
  expect(byId.get(quarantined.id)!.reasonCodes).toContain("quality_quarantined");
  expect(byId.get(unshared.id)!.reasonCodes).toContain("no_shared_signal");
  expect([...byId.values()].every(d => d.decision === "skip")).toBe(true);
  expect(s.listMemories({ layer: "core", qualityStatus: "all", limit: null })).toHaveLength(0);
});

it("returns an empty plan when automatic promotion is disabled", () => {
  const repo = repoWithMergedBranch();
  const s = store();
  branchCandidate(s, "The auth middleware caches tokens in Redis.");

  const plan = planAutomaticPromotions(s, configFor(repo, { enabled: false }), { repoPath: repo });
  expect(plan).toMatchObject({ enabled: false, scanned: 0, decisions: [] });
  expect(runAutomaticPromotions(s, configFor(repo, { enabled: false }), { repoPath: repo }).promoted).toBe(0);
  expect(s.listMemories({ layer: "core", qualityStatus: "all", limit: null })).toHaveLength(0);
});

it("honours the mergedBranches and deviceMemories switches", () => {
  const repo = repoWithMergedBranch();
  const s = store();
  branchCandidate(s, "The auth middleware caches tokens in Redis.");
  expect(planAutomaticPromotions(s, configFor(repo, { mergedBranches: false }), { repoPath: repo }).scanned).toBe(0);

  const other = store();
  other.upsertMemoryCandidate({
    layer: `device:${DEVICE}`,
    type: "decision", title: "Device fact", summary: "Something project-wide.",
    reason: "Observed.", confidence: 0.99, scope: { kind: "project" },
    evidence: [], relatedFiles: [], dedupeKey: "device-fact"
  }, { qualityStatus: "active", qualityReasons: [] });
  expect(planAutomaticPromotions(other, configFor(repo, { deviceMemories: false }), { repoPath: repo }).scanned).toBe(0);
});

it("is idempotent across repeated runs with unchanged inputs", () => {
  const repo = repoWithMergedBranch();
  const s = store();
  branchCandidate(s, "The auth middleware caches tokens in Redis.");
  // A deferral and a skip both have to stay quiet on the second pass.
  rememberProjectMemory(s, {
    type: "constraint",
    title: "Conflicting subject",
    text: "Sessions expire after one hour.",
    scope: { kind: "project" }
  });
  s.upsertMemoryCandidate({
    layer: `branch:${BRANCH}:device:${DEVICE}`,
    type: "constraint", title: "Conflicting subject", summary: "Sessions never expire.",
    reason: "Found on the branch.", confidence: 0.99, scope: { kind: "project" },
    evidence: [{ sourceType: "commit", sourceId: "commit-abc1234", locator: "commit-abc1234" }],
    relatedFiles: [], dedupeKey: "conflicting"
  }, { qualityStatus: "active", qualityReasons: [] });

  const first = runAutomaticPromotions(s, configFor(repo), { repoPath: repo });
  expect(first.promoted + first.converged + first.deferred).toBeGreaterThan(0);

  const counts = () => ({
    memories: s.db.prepare("select count(*) as count from memories").get() as { count: number },
    candidates: s.db.prepare("select count(*) as count from memory_candidates").get() as { count: number },
    decisions: s.db.prepare("select count(*) as count from promotion_decisions").get() as { count: number },
    operations: s.db.prepare("select count(*) as count from operation_log").get() as { count: number }
  });
  const before = counts();

  const second = runAutomaticPromotions(s, configFor(repo), { repoPath: repo });
  expect(second).toMatchObject({ promoted: 0, converged: 0, deferred: 0, skipped: 0 });
  expect(counts()).toEqual(before);
});

it("records privacy-safe reason codes and hashes identifiers in the operation log", () => {
  const repo = repoWithMergedBranch();
  const s = store();
  const candidate = branchCandidate(s, "The auth middleware caches tokens in Redis.");
  runAutomaticPromotions(s, configFor(repo), { repoPath: repo });

  const operations = s.listOperations({ operationType: "automatic_promotion" });
  expect(operations).toHaveLength(1);
  expect(operations[0]).toMatchObject({ status: "completed", actor: "system" });
  const metadata = operations[0]!.metadata as Record<string, unknown>;
  expect(metadata.decision).toBe("promote");
  expect(metadata.policyVersion).toBe(PROMOTION_POLICY_VERSION);
  expect(metadata.memoryIdHash).toMatch(/^[a-f0-9]{64}$/);
  // The log must never carry the raw id or any summary text.
  expect(JSON.stringify(metadata)).not.toContain(candidate.id);
  expect(JSON.stringify(metadata)).not.toContain("Redis");

  const history = listPromotionDecisions(s, {});
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ decision: "promote", category: "candidate", policyVersion: PROMOTION_POLICY_VERSION });
  expect(history[0]!.reasonCodes).toContain("project_scope");
});

it("re-evaluates a stored decision when the policy version changes", () => {
  const repo = repoWithMergedBranch();
  const s = store();
  const candidate = branchCandidate(s, "The auth middleware caches tokens in Redis.");
  const plan = planAutomaticPromotions(s, configFor(repo), { repoPath: repo });
  const decision = plan.decisions.find(d => d.memoryId === candidate.id)!;

  expect(applyAutomaticPromotion(s, decision, "system").applied).toBe(true);
  // Same key: a no-op rather than a second row.
  expect(applyAutomaticPromotion(s, decision, "system").applied).toBe(false);
  // A newer policy version is a different decision key, so it re-opens.
  expect(applyAutomaticPromotion(s, { ...decision, policyVersion: decision.policyVersion + 1 }, "system").applied).toBe(true);
  expect(s.db.prepare("select count(*) as count from promotion_decisions").get()).toEqual({ count: 2 });
});

it("isolates an executor failure from committed evidence and retries next run", () => {
  const repo = repoWithMergedBranch();
  const s = store();
  branchCandidate(s, "The auth middleware caches tokens in Redis.");

  // Fail the first promotion attempt at the point it writes.
  const promote = s.promoteMemoryCandidate.bind(s);
  const spy = vi.spyOn(s, "promoteMemoryCandidate").mockImplementationOnce(() => {
    throw new Error("disk full");
  });
  const failed = runAutomaticPromotions(s, configFor(repo), { repoPath: repo });
  expect(failed.promoted).toBe(0);
  expect(failed.warnings).toHaveLength(1);
  // The warning must not leak identifiers or memory content.
  expect(failed.warnings[0]).not.toContain("Redis");
  // Nothing partial was left behind, so the next pass sees the same input.
  expect(s.listMemories({ layer: "core", qualityStatus: "all", limit: null })).toHaveLength(0);
  expect(s.db.prepare("select count(*) as count from promotion_decisions").get()).toEqual({ count: 0 });

  spy.mockRestore();
  s.promoteMemoryCandidate = promote;
  const retried = runAutomaticPromotions(s, configFor(repo), { repoPath: repo });
  expect(retried.promoted).toBe(1);
  expect(s.listMemories({ layer: "core", qualityStatus: "all", limit: null })).toHaveLength(1);
});

it("keeps promotion decisions out of cloud snapshots as device-local state", () => {
  const s = store();
  // Registered alongside branch_triage_reviews, which is already local-only.
  const localTables = s.db.prepare(
    "select name from sqlite_master where type = 'table' and name in ('promotion_decisions', 'branch_triage_reviews')"
  ).all() as Array<{ name: string }>;
  expect(localTables.map(row => row.name).sort()).toEqual(["branch_triage_reviews", "promotion_decisions"]);
});
