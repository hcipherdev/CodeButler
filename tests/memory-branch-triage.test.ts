import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
  resolveBranchMemoryTriage,
  suggestBranchMemoryTriage
} from "../src/memory/branch-triage.js";
import { CORE_LAYER } from "../src/memory/layer.js";
import { rememberProjectMemory } from "../src/memory/remember.js";
import { createProjectMemoryToolHandlers } from "../src/mcp/tools.js";
import { runCli } from "../src/cli.js";
import { openMemoryStore, type MemoryStore } from "../src/storage/store.js";
import type { ExtractedMemory } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

const roots: string[] = [];
const stores: MemoryStore[] = [];
const NOW = "2026-09-10T12:00:00.000Z";

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

function initRepo(): string {
  const repo = root();
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  git(repo, ["checkout", "-b", "main"]);
  commitFile(repo, "README.md", "# branch triage\n", "Initial commit");
  return repo;
}

function initRepoWithBranchStates(): string {
  const repo = initRepo();
  git(repo, ["checkout", "-b", "feature/merged"]);
  commitFile(repo, "merged.txt", "merged\n", "Merged branch work");
  git(repo, ["checkout", "main"]);
  git(repo, ["merge", "--no-ff", "feature/merged", "-m", "Merge feature/merged"]);
  git(repo, ["checkout", "-b", "feature/active"]);
  commitFile(repo, "active.txt", "active\n", "Active branch work");
  git(repo, ["checkout", "main"]);
  git(repo, ["checkout", "-b", "feature/stale"]);
  commitFile(repo, "stale.txt", "stale\n", "Stale branch work");
  git(repo, ["checkout", "main"]);
  git(repo, ["checkout", "-b", "feature/current"]);
  return repo;
}

function memory(branch: string, title: string, dedupeKey: string, confidence = 1): ExtractedMemory {
  return {
    layer: `branch:${branch}`,
    type: "decision",
    title,
    summary: `${title} summary.`,
    reason: `${title} reason.`,
    confidence,
    dedupeKey,
    evidence: [],
    relatedFiles: []
  };
}

it("classifies branch-layer memories by current, merged, active, stale, missing ref, and Git availability", () => {
  const repo = initRepoWithBranchStates();
  const s = store(repo);
  const current = s.upsertMemoryCandidate(memory("feature/current", "Current", "current"));
  const merged = s.upsertMemoryCandidate(memory("feature/merged", "Merged", "merged"));
  const active = s.upsertMemoryCandidate(memory("feature/active", "Active", "active"));
  const stale = s.upsertMemoryCandidate(memory("feature/stale", "Stale", "stale"));
  const missing = s.upsertMemoryCandidate(memory("feature/missing", "Missing", "missing"));
  s.db.prepare("update memory_candidates set updated_at = ? where id = ?")
    .run("2026-07-01T00:00:00.000Z", stale.id);

  const result = suggestBranchMemoryTriage(s, {
    repoPath: repo,
    includeActive: true,
    staleDays: 30,
    now: NOW,
    limit: 20
  });
  const byId = new Map(result.suggestions.map((suggestion) => [suggestion.memoryId, suggestion.branchState]));

  expect(byId.get(current.id)).toBe("current");
  expect(byId.get(merged.id)).toBe("merged");
  expect(byId.get(active.id)).toBe("active");
  expect(byId.get(stale.id)).toBe("stale");
  expect(byId.get(missing.id)).toBe("stale");
  expect(suggestBranchMemoryTriage(s, {
    repoPath: join(repo, "missing"),
    includeActive: true,
    now: NOW
  }).suggestions.find((suggestion) => suggestion.memoryId === merged.id)!.branchState).toBe("unknown");
});

it("suggests branch memories only by default, orders merged and stale before active, and hides reviewed items", () => {
  const repo = initRepoWithBranchStates();
  const s = store(repo);
  const merged = s.upsertMemoryCandidate(memory("feature/merged", "Merged", "merged"));
  const stale = s.upsertMemoryCandidate(memory("feature/stale", "Stale", "stale"));
  const active = s.upsertMemoryCandidate(memory("feature/active", "Active", "active"));
  s.upsertMemoryCandidate({ ...memory("feature/device", "Device", "device"), layer: "device:9f2c4d1e-3b7a-4c5d-8e6f-0a1b2c3d4e5f" });
  s.db.prepare("update memory_candidates set updated_at = ? where id = ?")
    .run("2026-07-01T00:00:00.000Z", stale.id);

  const defaultResult = suggestBranchMemoryTriage(s, { repoPath: repo, now: NOW, limit: 20 });
  expect(defaultResult.scanned).toBe(3);
  expect(defaultResult.suggestions.map((suggestion) => suggestion.memoryId)).toEqual([merged.id, stale.id]);

  const activeResult = suggestBranchMemoryTriage(s, { repoPath: repo, includeActive: true, now: NOW, limit: 20 });
  expect(activeResult.suggestions.map((suggestion) => suggestion.branchState)).toEqual(["merged", "stale", "active"]);

  resolveBranchMemoryTriage(s, {
    memoryId: stale.id,
    category: "candidate",
    action: "retain_branch",
    reason: "Still useful for this branch.",
    now: NOW
  }, "cli");
  expect(suggestBranchMemoryTriage(s, { repoPath: repo, now: NOW, limit: 20 })).toMatchObject({
    reviewedHidden: 1,
    suggestions: [expect.objectContaining({ memoryId: merged.id })]
  });
  expect(suggestBranchMemoryTriage(s, { repoPath: repo, now: NOW, includeReviewed: true, limit: 20 }).suggestions)
    .toEqual(expect.arrayContaining([expect.objectContaining({ memoryId: stale.id, reviewed: true })]));
});

it("resolves branch triage actions for candidates and promoted memories", () => {
  const s = store();
  const promoteCandidate = s.upsertMemoryCandidate(memory("feature/promote-candidate", "Promote Candidate", "promote-candidate"));
  const promoted = resolveBranchMemoryTriage(s, {
    memoryId: promoteCandidate.id,
    category: "candidate",
    action: "promote_to_core",
    reason: "Merged and worth sharing.",
    now: NOW
  }, "cli");
  expect(promoted.promotedMemoryId).toBeDefined();
  expect(promoted.memory).toMatchObject({ id: promoted.promotedMemoryId, layer: CORE_LAYER });
  expect(s.listMemoryCandidates({ qualityStatus: "all", limit: null }).find((candidate) => candidate.id === promoteCandidate.id))
    .toMatchObject({ promotionState: "promoted", layer: CORE_LAYER });

  const branchPromoted = rememberProjectMemory(s, {
    type: "decision",
    text: "Move this branch memory to core.",
    layer: "branch:feature/promote-promoted"
  });
  const moved = resolveBranchMemoryTriage(s, {
    memoryId: branchPromoted.memory!.id,
    category: "promoted",
    action: "promote_to_core",
    reason: "Reviewed after merge.",
    now: NOW
  }, "cli");
  expect(moved.memory).toMatchObject({ id: branchPromoted.memory!.id, layer: CORE_LAYER });
  expect(s.listMemoryCandidates({ qualityStatus: "all", limit: null }).find((candidate) => candidate.id === branchPromoted.candidate.id))
    .toMatchObject({ layer: CORE_LAYER });

  const discardCandidate = s.upsertMemoryCandidate(memory("feature/discard-candidate", "Discard Candidate", "discard-candidate"));
  resolveBranchMemoryTriage(s, {
    memoryId: discardCandidate.id,
    category: "candidate",
    action: "discard",
    reason: "Rejected during merge review.",
    now: NOW
  }, "mcp");
  expect(s.listMemoryCandidates({ qualityStatus: "all", limit: null }).find((candidate) => candidate.id === discardCandidate.id))
    .toMatchObject({ qualityStatus: "quarantined", qualityReasons: ["branch_triage_discarded"] });

  const discardPromoted = rememberProjectMemory(s, {
    type: "decision",
    text: "Retract this branch memory.",
    layer: "branch:feature/discard-promoted"
  });
  resolveBranchMemoryTriage(s, {
    memoryId: discardPromoted.memory!.id,
    category: "promoted",
    action: "discard",
    reason: "No longer applies.",
    now: NOW
  }, "mcp");
  expect(s.readMemory(discardPromoted.memory!.id)).toMatchObject({ lifecycleStatus: "retracted" });

  const retained = s.upsertMemoryCandidate(memory("feature/retain", "Retain Candidate", "retain-candidate"));
  resolveBranchMemoryTriage(s, {
    memoryId: retained.id,
    category: "candidate",
    action: "retain_branch",
    reason: "Still branch-local.",
    now: NOW
  }, "cli");
  expect(s.listMemoryCandidates({ qualityStatus: "all", limit: null }).find((candidate) => candidate.id === retained.id))
    .toMatchObject({ promotionState: "candidate", qualityStatus: "active", layer: "branch:feature/retain" });
  expect(s.db.prepare("select count(*) as count from branch_triage_reviews").get()).toEqual({ count: 5 });
  expect(s.listOperations({ operationType: "branch_triage" })).toHaveLength(5);
  expect(JSON.stringify(s.listOperations({ operationType: "branch_triage" }))).not.toContain("Still branch-local");
});

it("exposes branch triage through MCP handlers", () => {
  const repo = initRepoWithBranchStates();
  const s = store(repo);
  const candidate = s.upsertMemoryCandidate(memory("feature/merged", "MCP Candidate", "mcp-candidate"));
  const handlers = createProjectMemoryToolHandlers(s, {
    rootDir: repo,
    now: () => new Date(NOW)
  });

  const suggestions = handlers.suggest_branch_memory_triage({ limit: 10 });
  expect(suggestions.suggestions).toEqual([
    expect.objectContaining({
      memoryId: candidate.id,
      branchState: "merged",
      action: {
        tool: "resolve_branch_memory_triage",
        arguments: expect.objectContaining({ action: "promote_to_core" })
      }
    })
  ]);
  expect(handlers.resolve_branch_memory_triage({
    memoryId: candidate.id,
    category: "candidate",
    action: "promote_to_core",
    reason: "Confirmed in MCP."
  })).toMatchObject({
    memoryId: candidate.id,
    action: "promote_to_core",
    memory: { layer: CORE_LAYER }
  });
});

it("exposes branch triage through CLI JSON and validates actions", async () => {
  const home = root();
  vi.stubEnv("CODE_BUTLER_HOME", home);
  const repo = initRepoWithBranchStates();
  const s = store(repo);
  const candidate = s.upsertMemoryCandidate(memory("feature/merged", "CLI Candidate", "cli-candidate"));
  const lines: string[] = [];
  const errors: string[] = [];

  expect(await runCli(["memory", "branch-triage", "--json"], {
    cwd: repo,
    stdout: (line) => lines.push(line)
  })).toBe(0);
  expect(JSON.parse(lines.join("\n")).suggestions).toEqual([
    expect.objectContaining({ memoryId: candidate.id, branchState: "merged" })
  ]);

  lines.length = 0;
  expect(await runCli([
    "memory", "branch-resolve",
    "--id", candidate.id,
    "--category", "candidate",
    "--action", "retain_branch",
    "--reason", "Keep it branch-local.",
    "--json"
  ], { cwd: repo, stdout: (line) => lines.push(line) })).toBe(0);
  expect(JSON.parse(lines.join("\n"))).toMatchObject({ memoryId: candidate.id, action: "retain_branch" });

  expect(await runCli([
    "memory", "branch-resolve",
    "--id", candidate.id,
    "--category", "candidate",
    "--action", "invented",
    "--reason", "Nope."
  ], { cwd: repo, stderr: (line) => errors.push(line) })).toBe(1);
  expect(errors.join("\n")).toContain("--action must be one of promote_to_core, discard, retain_branch");
});
