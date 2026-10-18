import { afterEach, describe, expect, it } from "vitest";

import {
  applyMemoryReconciliation,
  continueDesktopMemoryReconciliation,
  planMemoryReconciliation,
  previewDesktopMemoryReconciliation,
  readLatestDesktopMemoryReconciliationRun,
  revertMemoryReconciliation
} from "../src/memory/reconciliation.js";
import type { MemoryReconciliationProvider } from "../src/memory/reconciliation-provider.js";
import { runDesktopMemoryReview } from "../src/desktop/service.js";
import { assertNoDatabaseHandles, withProjectGate } from "../src/cloud/gate.js";
import { readDesktopMemoryReconciliationStatus } from "../src/memory/reconciliation.js";
import { openMemoryStore } from "../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("desktop AI memory review", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) cleanupTempDir(root); });
  const root = () => { const path = makeTempDir(); roots.push(path); return path; };
  function fakeProvider() {
    let calls = 0;
    const provider: MemoryReconciliationProvider = {
      provider: "mock", model: "mock-reviewer",
      async request() {
        calls += 1;
        return { content: JSON.stringify({ verdict: "uncertain", confidence: 0.95, rationale: "Evidence is insufficient.", citationIds: [] }), inputTokens: 20, outputTokens: 10 };
      }
    };
    return { provider, get calls() { return calls; } };
  }
  function candidates(project: string, count: number, qualityStatus: "needs_review" | "active" | "quarantined" = "needs_review") {
    const store = openMemoryStore(project); store.init();
    const items = Array.from({ length: count }, (_, index) => store.upsertMemoryCandidate({
      type: "constraint", title: `Memory ${index}`, summary: `Project memory ${index}.`, reason: "Review this evidence.",
      confidence: 0.7, evidence: [], relatedFiles: [], dedupeKey: `desktop-ai-${qualityStatus}-${index}`
    }, { qualityStatus, qualityReasons: qualityStatus === "active" ? [] : ["missing_evidence"] }));
    store.close(); return items;
  }

  it("selects beyond the 50-item UI page and lets a single active memory call the model", async () => {
    const project = root();
    candidates(project, 55);
    const active = candidates(project, 1, "active")[0]!;
    const fake = fakeProvider();
    const preview = previewDesktopMemoryReconciliation(project, { kind: "needs_review", limit: 55 }, { provider: fake.provider });
    expect(preview).toMatchObject({ selected: 55, modelItems: 55, deterministicItems: 0, model: "mock-reviewer" });
    const single = await planMemoryReconciliation(project, {
      queue: "all", desktopSelection: { kind: "single", memoryId: active.id, category: "candidate" },
      maxRequests: 2, tokenBudget: 100_000
    }, { provider: fake.provider });
    expect(single.items).toEqual([expect.objectContaining({ memoryId: active.id, deterministic: false, state: "uncertain" })]);
    expect(fake.calls).toBe(1);
  });

  it("limits each tab to its own live memories, with All spanning every category", async () => {
    const project = root();
    candidates(project, 55, "needs_review");
    candidates(project, 3, "active");
    candidates(project, 4, "quarantined");
    const fake = fakeProvider();
    expect(previewDesktopMemoryReconciliation(project, { kind: "all", limit: 100 }, { provider: fake.provider }).selected).toBe(62);
    expect(previewDesktopMemoryReconciliation(project, { kind: "all", limit: 20 }, { provider: fake.provider }).selected).toBe(20);
    expect(previewDesktopMemoryReconciliation(project, { kind: "active", limit: 20 }, { provider: fake.provider }).selected).toBe(3);
    expect(previewDesktopMemoryReconciliation(project, { kind: "needs_review", limit: 55 }, { provider: fake.provider }).selected).toBe(55);
    expect(previewDesktopMemoryReconciliation(project, { kind: "quarantined", limit: 2 }, { provider: fake.provider }).selected).toBe(2);
    const activeRun = await planMemoryReconciliation(project, {
      queue: "all", desktopSelection: { kind: "active", limit: 2 }, maxRequests: 4, tokenBudget: 100_000
    }, { provider: fake.provider });
    expect(activeRun.items).toHaveLength(2);
    expect(activeRun.items.every(item => item.state === "uncertain")).toBe(true);
    expect(fake.calls).toBe(2);
  });

  it("labels exact legacy quarantine results and uses no model calls", async () => {
    const project = root();
    const store = openMemoryStore(project); store.init();
    const legacy = store.upsertMemoryCandidate({
      type: "constraint", title: "Config defines retries", summary: "package.json defines retries.",
      reason: "Legacy deterministic config extraction.", confidence: 0.65, evidence: [],
      relatedFiles: ["package.json"], dedupeKey: "deterministic:config:package.json:retries"
    }, { qualityStatus: "quarantined", qualityReasons: ["legacy_low_signal_heuristic"] });
    store.close();
    const fake = fakeProvider();
    const preview = previewDesktopMemoryReconciliation(project, { kind: "quarantined", limit: 20 }, { provider: fake.provider });
    expect(preview).toMatchObject({ selected: 1, modelItems: 0, deterministicItems: 1 });
    const run = await planMemoryReconciliation(project, { queue: "all", desktopSelection: { kind: "quarantined", limit: 20 }, maxRequests: 1, tokenBudget: 1 }, { provider: fake.provider });
    expect(run.items).toEqual([expect.objectContaining({ deterministic: true, verdict: "low_value", state: "planned" })]);
    expect(fake.calls).toBe(0);
    const single = await planMemoryReconciliation(project, {
      queue: "all", desktopSelection: { kind: "single", memoryId: legacy.id, category: "candidate" }, maxRequests: 2, tokenBudget: 100_000
    }, { provider: fake.provider });
    expect(single.items).toEqual([expect.objectContaining({ deterministic: false, state: "uncertain" })]);
    expect(fake.calls).toBe(1);
  });

  it("starts a 51-item model quarantine batch and leaves it pending when the cap is too small", async () => {
    const project = root(); candidates(project, 51, "quarantined");
    const fake = fakeProvider();
    const preview = previewDesktopMemoryReconciliation(project, { kind: "quarantined", limit: 51 }, { provider: fake.provider });
    expect(preview).toMatchObject({ selected: 51, modelItems: 51, deterministicItems: 0 });
    const events: number[] = [];
    const run = await planMemoryReconciliation(project, {
      queue: "all", desktopSelection: { kind: "quarantined", limit: 51 }, maxRequests: 102, tokenBudget: 1
    }, { provider: fake.provider, onProgress: progress => events.push(progress.reviewed) });
    expect(run.counts.pending).toBe(51);
    expect(events[0]).toBe(0);
    expect(fake.calls).toBe(0);
  });

  it("releases the canonical database while model analysis runs", async () => {
    const project = root(); candidates(project, 1);
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const provider: MemoryReconciliationProvider = {
      provider: "mock", model: "paused-reviewer",
      async request() {
        entered(); await blocked;
        return { content: JSON.stringify({ verdict: "uncertain", confidence: 0.95, rationale: "Evidence is insufficient.", citationIds: [] }) };
      }
    };
    const reviewing = planMemoryReconciliation(project, {
      queue: "all", desktopSelection: { kind: "needs_review", limit: 1 }, maxRequests: 2, tokenBudget: 100_000
    }, { provider });
    await started;
    await withProjectGate(project, () => {
      assertNoDatabaseHandles(project);
      expect(readDesktopMemoryReconciliationStatus(project)).toMatchObject({ status: "planning", requestCount: 1 });
      const syncing = openMemoryStore(project); syncing.init();
      syncing.upsertMemoryCandidate({
        type: "constraint", title: "New sync result", summary: "A new memory arrived during model analysis.",
        reason: "Concurrent ingestion test.", confidence: 0.7, evidence: [], relatedFiles: [], dedupeKey: "concurrent-sync"
      });
      syncing.close();
    }, { name: "Memory sync" });
    finish();
    expect(await reviewing).toMatchObject({ status: "planned", counts: { uncertain: 1 } });
  });

  it("stops after completed items and continues pending items in the same run", async () => {
    const project = root(); candidates(project, 3);
    const fake = fakeProvider();
    let stop = false;
    const events: number[] = [];
    const first = await planMemoryReconciliation(project, {
      queue: "all", desktopSelection: { kind: "needs_review", limit: 3 }, concurrency: 1,
      maxRequests: 6, tokenBudget: 100_000
    }, {
      provider: fake.provider, shouldStop: () => stop,
      onProgress: progress => { events.push(progress.reviewed); if (progress.reviewed === 1) stop = true; }
    });
    expect(first.counts).toMatchObject({ pending: 2, uncertain: 1 });
    expect(events).toContain(1);
    expect(fake.calls).toBe(1);
    const continued = await continueDesktopMemoryReconciliation(project, first.id, 100_000, { provider: fake.provider });
    expect(continued.counts).toMatchObject({ pending: 0, uncertain: 3 });
    expect(continued.id).toBe(first.id);
    expect(fake.calls).toBe(3);
    expect(readLatestDesktopMemoryReconciliationRun(project)?.id).toBe(first.id);
  });

  it("pauses at the estimated cap and applies only selected decisions with undo", async () => {
    const project = root(); candidates(project, 2);
    const fake = fakeProvider();
    const preview = previewDesktopMemoryReconciliation(project, { kind: "needs_review", limit: 2 }, { provider: fake.provider });
    const capped = await planMemoryReconciliation(project, {
      queue: "all", desktopSelection: { kind: "needs_review", limit: 2 }, concurrency: 1,
      maxRequests: 4, tokenBudget: Math.ceil(preview.estimatedTokens.minimum / 2)
    }, { provider: fake.provider });
    expect(capped.counts.pending).toBeGreaterThan(0);
    const continued = await continueDesktopMemoryReconciliation(project, capped.id, 100_000, { provider: fake.provider });
    expect(continued.counts.pending).toBe(0);
    expect(fake.calls).toBe(2);

    const store = openMemoryStore(project); store.init();
    const legacy = Array.from({ length: 2 }, (_, index) => store.upsertMemoryCandidate({
      type: "constraint", title: `Config defines legacy${index}`, summary: `package.json defines legacy${index}.`,
      reason: "Legacy deterministic config extraction.", confidence: 0.65, evidence: [],
      relatedFiles: ["package.json"], dedupeKey: `deterministic:config:package.json:legacy${index}`
    }, { qualityStatus: "quarantined", qualityReasons: ["legacy_low_signal_heuristic"] }));
    store.close();
    const run = await planMemoryReconciliation(project, { queue: "all", desktopSelection: { kind: "quarantined", limit: 20 }, maxRequests: 1, tokenBudget: 1 });
    const chosen = run.items.find(item => item.memoryId === legacy[0]!.id)!;
    const applied = await applyMemoryReconciliation(project, { runId: run.id, itemIds: [chosen.itemId] });
    expect(applied.counts).toMatchObject({ applied: 1, planned: 1 });
    const undone = await revertMemoryReconciliation(project, { runId: run.id });
    expect(undone.counts).toMatchObject({ reverted: 1, planned: 1 });
  });

  it("retries a failed model request without repeating completed verdicts", async () => {
    const project = root(); candidates(project, 2);
    let calls = 0;
    const provider: MemoryReconciliationProvider = {
      provider: "mock", model: "mock-reviewer",
      async request() {
        calls += 1;
        if (calls === 1) throw new Error("Temporary model outage");
        return { content: JSON.stringify({ verdict: "uncertain", confidence: 0.95, rationale: "Evidence is insufficient.", citationIds: [] }) };
      }
    };
    const first = await planMemoryReconciliation(project, {
      queue: "all", desktopSelection: { kind: "needs_review", limit: 2 }, concurrency: 1,
      maxRequests: 4, tokenBudget: 100_000
    }, { provider });
    expect(first.counts).toMatchObject({ failed: 1, uncertain: 1 });
    expect(calls).toBe(2);
    const retried = await continueDesktopMemoryReconciliation(project, first.id, 100_000, { provider });
    expect(retried.counts).toMatchObject({ failed: 0, uncertain: 2 });
    expect(calls).toBe(3);
  });

  it("reports an actionable Start validation error instead of a generic desktop failure", async () => {
    await expect(runDesktopMemoryReview({ version: 1, action: "memory.ai.run", root: "C:/project",
      selection: { kind: "quarantined", limit: 0 }, tokenCap: 1 }, () => {}, () => false))
      .rejects.toThrow(/Invalid AI review Start request: selection.limit/);
  });
});
