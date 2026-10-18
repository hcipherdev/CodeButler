import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import { binding, saveBinding, type Binding } from "../src/cloud/state.js";
import { automaticSyncPending, AutomaticSyncOwner } from "../src/cloud/sync-owner.js";
import {
  applyMemoryReconciliation,
  planMemoryReconciliation,
  readMemoryReconciliationRun,
  replanMemoryReconciliation,
  revertMemoryReconciliation
} from "../src/memory/reconciliation.js";
import type { MemoryReconciliationProvider } from "../src/memory/reconciliation-provider.js";
import { resolveMemoryReview } from "../src/memory/review.js";
import { openMemoryStore } from "../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("safe AI memory reconciliation", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) cleanupTempDir(root);
  });

  function root(): string {
    const value = makeTempDir();
    roots.push(value);
    return value;
  }

  function provider(
    response: (payload: Record<string, unknown>, call: number) => Record<string, unknown> | string
  ): MemoryReconciliationProvider & { calls: number } {
    return {
      provider: "test-provider",
      model: "test-model",
      calls: 0,
      async request(input) {
        this.calls += 1;
        const value = response(input.payload, this.calls);
        return { content: typeof value === "string" ? value : JSON.stringify(value), inputTokens: 20, outputTokens: 10 };
      }
    };
  }

  function addLegacyCandidate(project: string, suffix = "retries") {
    const store = openMemoryStore(project);
    store.init();
    const memory = store.upsertMemoryCandidate({
      type: "constraint",
      title: `Config defines ${suffix}`,
      summary: `package.json defines ${suffix}.`,
      reason: "Legacy deterministic config extraction.",
      confidence: 0.65,
      evidence: [],
      relatedFiles: ["package.json"],
      dedupeKey: `deterministic:config:package.json:${suffix}`
    }, { qualityStatus: "quarantined", qualityReasons: ["legacy_low_signal_heuristic"] });
    store.close();
    return memory;
  }

  function cloudBinding(condition: Binding["syncCondition"]): Binding {
    return {
      projectId: randomUUID(),
      server: "https://cloud.example.test",
      vaultId: randomUUID(),
      enabled: true,
      revision: 1,
      fingerprint: "0".repeat(64),
      status: condition ?? "ready",
      ...(condition === undefined ? {} : { syncCondition: condition })
    };
  }

  it("retires exact legacy noise without a model and reverses the shared decision", async () => {
    const project = root();
    const legacy = addLegacyCandidate(project);

    const plan = await planMemoryReconciliation(project, { queue: "legacy", limit: null });
    expect(plan).toMatchObject({ status: "planned", requestCount: 0 });
    expect(plan.items).toEqual([
      expect.objectContaining({ memoryId: legacy.id, deterministic: true, verdict: "low_value", state: "planned" })
    ]);

    const applied = await applyMemoryReconciliation(project, { runId: plan.id });
    expect(applied).toMatchObject({ status: "applied", counts: expect.objectContaining({ applied: 1 }) });
    await expect(applyMemoryReconciliation(project, { runId: plan.id })).resolves.toMatchObject({ status: "applied" });
    const retired = openMemoryStore(project);
    retired.init();
    expect(retired.searchMemoryLayer({ qualityStatus: "all" })).toEqual([]);
    expect(retired.getProjectSummary().memoryHealth).toMatchObject({ retired: 1, quarantined: 0 });
    retired.close();

    const noLongerLive = await replanMemoryReconciliation(project, { runId: plan.id, staleOnly: true });
    expect(noLongerLive).toMatchObject({ status: "planned", parentRunId: plan.id, items: [] });

    const reverted = await revertMemoryReconciliation(project, { runId: plan.id });
    expect(reverted).toMatchObject({ status: "reverted", counts: expect.objectContaining({ reverted: 1 }) });
    await expect(revertMemoryReconciliation(project, { runId: plan.id })).resolves.toMatchObject({ status: "reverted" });
    const restored = openMemoryStore(project);
    restored.init();
    expect(restored.searchMemoryLayer({ qualityStatus: "all" }).map((memory) => memory.id)).toContain(legacy.id);
    expect(restored.db.prepare(
      "select count(*) as count from memory_review_resolutions where reconciliation_run_id = ?"
    ).get(plan.id)).toEqual({ count: 1 });
    expect(restored.db.prepare(
      "select count(*) as count from memory_review_resolution_compensations where reconciliation_run_id = ?"
    ).get(plan.id)).toEqual({ count: 1 });
    restored.close();
  });

  it("routes legacy near-matches to AI instead of deterministic retirement", async () => {
    const project = root();
    const store = openMemoryStore(project);
    store.init();
    store.addCommit({
      hash: "near-legacy-evidence",
      authorName: "Test",
      authorEmail: "test@example.com",
      authoredAt: "2026-09-21T10:00:00Z",
      message: "Document production retries",
      changedFiles: ["package.json"],
      diffSummary: "+ retries"
    });
    const near = store.upsertMemoryCandidate({
      type: "constraint",
      title: "Config defines retries",
      summary: "package.json defines retries for production.",
      reason: "Legacy deterministic config extraction.",
      confidence: 0.9,
      evidence: [{ sourceType: "commit", sourceId: "near-legacy-evidence" }],
      relatedFiles: ["package.json"],
      dedupeKey: "deterministic:config:package.json:retries"
    }, { qualityStatus: "quarantined", qualityReasons: ["legacy_low_signal_heuristic"] });
    store.close();

    const legacy = await planMemoryReconciliation(project, { queue: "legacy", limit: null });
    expect(legacy.items).toEqual([]);
    const fake = provider(() => ({
      verdict: "uncertain",
      confidence: 0.95,
      rationale: "The historical template does not exactly match, so human review is safer.",
      citationIds: []
    }));
    const actionable = await planMemoryReconciliation(project, { queue: "actionable", limit: null }, { provider: fake });
    expect(fake.calls).toBe(1);
    expect(actionable.items).toEqual([
      expect.objectContaining({ memoryId: near.id, deterministic: false, verdict: "uncertain", state: "uncertain" })
    ]);
  });

  it("plans quarantined and needs-review memories separately before applying the limit", async () => {
    const project = root();
    const store = openMemoryStore(project);
    store.init();
    const quarantined = store.upsertMemoryCandidate({
      type: "constraint",
      title: "Quarantined constraint",
      summary: "A quarantined project constraint.",
      reason: "Needs an AI judgment.",
      confidence: 0.5,
      evidence: [],
      relatedFiles: [],
      dedupeKey: "quality-filter-quarantined"
    }, { qualityStatus: "quarantined", qualityReasons: ["legacy_low_signal_heuristic"] });
    const needsReview = store.upsertMemoryCandidate({
      type: "constraint",
      title: "Needs-review constraint",
      summary: "A project constraint needing review.",
      reason: "Needs an AI judgment.",
      confidence: 0.5,
      evidence: [],
      relatedFiles: [],
      dedupeKey: "quality-filter-needs-review"
    }, { qualityStatus: "needs_review", qualityReasons: ["low_confidence"] });
    store.close();

    const fake = provider(() => ({ verdict: "uncertain", confidence: 0.95, rationale: "Evidence is insufficient.", citationIds: [] }));
    const quarantinePlan = await planMemoryReconciliation(project, {
      queue: "actionable", qualityFilter: "quarantined", limit: 1
    }, { provider: fake });
    expect(quarantinePlan.items).toEqual([expect.objectContaining({ memoryId: quarantined.id })]);

    const reviewPlan = await planMemoryReconciliation(project, {
      queue: "actionable", qualityFilter: "needs_review", limit: 1
    }, { provider: fake });
    expect(reviewPlan.items).toEqual([expect.objectContaining({ memoryId: needsReview.id })]);
    expect(fake.calls).toBe(2);

    const replanned = await replanMemoryReconciliation(project, { runId: quarantinePlan.id, retryUncertain: true }, { provider: fake });
    expect(replanned).toMatchObject({ parentRunId: quarantinePlan.id });
    expect(replanned.items).toEqual([expect.objectContaining({ memoryId: quarantined.id })]);
  });

  it("exposes deterministic plan, status, apply, and revert through the CLI", async () => {
    const project = root();
    const store = openMemoryStore(project);
    store.init();
    const legacy = store.upsertMemoryCandidate({
      type: "constraint",
      title: "Documentation includes Setup",
      summary: "Documentation includes Setup.",
      reason: "Legacy deterministic documentation extraction.",
      confidence: 0.65,
      evidence: [],
      relatedFiles: ["README.md"],
      dedupeKey: "deterministic:docs:README.md:setup"
    }, { qualityStatus: "quarantined", qualityReasons: ["legacy_low_signal_heuristic"] });
    store.close();

    const planOutput: string[] = [];
    expect(await runCli([
      "memory", "reconcile", "plan", "--queue", "legacy", "--quality", "quarantined", "--limit", "all", "--json"
    ], { cwd: project, stdout: (line) => planOutput.push(line) })).toBe(0);
    const plan = JSON.parse(planOutput.join("\n")) as { id: string; requestCount: number; items: Array<{ memoryId: string }> };
    expect(plan).toMatchObject({ requestCount: 0, items: [{ memoryId: legacy.id }] });

    for (const command of ["status", "apply", "revert"] as const) {
      const output: string[] = [];
      expect(await runCli([
        "memory", "reconcile", command, "--run", plan.id, "--json"
      ], { cwd: project, stdout: (line) => output.push(line) })).toBe(0);
      expect(JSON.parse(output.join("\n"))).toMatchObject({
        id: plan.id,
        status: command === "status" ? "planned" : command === "apply" ? "applied" : "reverted"
      });
    }
  });

  it("activates an independently cited current memory with AI trust and can remove that trust", async () => {
    const project = root();
    const store = openMemoryStore(project);
    store.init();
    store.addCommit({
      hash: "ai-current",
      authorName: "Test",
      authorEmail: "test@example.com",
      authoredAt: "2026-09-20T10:00:00Z",
      message: "Keep the cache bounded",
      changedFiles: ["src/cache.ts"],
      diffSummary: "+ bounded cache"
    });
    const memory = store.upsertMemoryCandidate({
      type: "constraint",
      title: "Bound the cache",
      summary: "The project cache must remain bounded.",
      reason: "Avoid unbounded memory growth.",
      confidence: 0.55,
      evidence: [{ sourceType: "commit", sourceId: "ai-current" }],
      relatedFiles: ["src/cache.ts"],
      dedupeKey: "ai-current-candidate"
    }, { qualityStatus: "needs_review", qualityReasons: ["low_confidence"] });
    store.close();

    const fake = provider((payload) => {
      const observations = payload.observations as Array<{ citationId: string; kind: string }>;
      return {
        verdict: "current",
        confidence: 0.97,
        rationale: "The indexed commit directly establishes the constraint.",
        citationIds: [observations.find((observation) => observation.kind === "commit")!.citationId]
      };
    });
    const plan = await planMemoryReconciliation(project, { queue: "actionable" }, { provider: fake });
    expect(fake.calls).toBe(1);
    const applied = await applyMemoryReconciliation(project, { runId: plan.id });
    expect(applied.status).toBe("applied");

    const active = openMemoryStore(project);
    active.init();
    const result = active.readMemorySearchResultsByIds([memory.id], { includeCandidates: true })[0]!;
    expect(result).toMatchObject({ qualityStatus: "active", trust: { displayStatus: "ai_validated" } });
    active.close();

    await revertMemoryReconciliation(project, { runId: plan.id });
    const untrusted = openMemoryStore(project);
    untrusted.init();
    expect(untrusted.readMemorySearchResultsByIds([memory.id], { includeCandidates: true })[0]).toMatchObject({
      qualityStatus: "needs_review",
      trust: { displayStatus: "needs_review" }
    });
    untrusted.close();
  });

  it("requires correction approval, preserves the original, and retracts the generated replacement on revert", async () => {
    const project = root();
    const store = openMemoryStore(project);
    store.init();
    store.addCommit({
      hash: "ai-change",
      authorName: "Test",
      authorEmail: "test@example.com",
      authoredAt: "2026-09-21T10:00:00Z",
      message: "Move cache to SQLite",
      changedFiles: ["src/cache.ts"],
      diffSummary: "+ sqlite cache"
    });
    const memory = store.upsertMemoryCandidate({
      type: "decision",
      title: "Cache backend",
      summary: "The cache uses Redis.",
      reason: "Earlier implementation choice.",
      confidence: 0.7,
      evidence: [{ sourceType: "commit", sourceId: "ai-change" }],
      relatedFiles: ["src/cache.ts"],
      dedupeKey: "ai-change-candidate"
    }, { qualityStatus: "needs_review", qualityReasons: ["stale_related_file_evidence"] });
    store.close();

    const fake = provider((payload) => {
      const observations = payload.observations as Array<{ citationId: string; kind: string }>;
      return {
        verdict: "changed",
        confidence: 0.96,
        rationale: "The current change records SQLite as the cache backend.",
        citationIds: [observations.find((observation) => observation.kind === "commit")!.citationId],
        correction: { summary: "The cache uses SQLite.", reason: "Matches the current implementation.", relatedFiles: ["src/cache.ts"] }
      };
    });
    const plan = await planMemoryReconciliation(project, { queue: "actionable" }, { provider: fake });
    const held = await applyMemoryReconciliation(project, { runId: plan.id });
    expect(held).toMatchObject({ status: "partial", counts: expect.objectContaining({ awaiting_correction_approval: 1 }) });

    const applied = await applyMemoryReconciliation(project, { runId: plan.id, applyCorrections: true });
    expect(applied.status).toBe("applied");
    const replacementId = applied.items[0]!.replacementMemoryId!;
    const changed = openMemoryStore(project);
    changed.init();
    expect(changed.searchMemoryLayer({ qualityStatus: "all" }).map((item) => item.id)).toContain(replacementId);
    expect(changed.searchMemoryLayer({ qualityStatus: "all" }).map((item) => item.id)).not.toContain(memory.id);
    changed.close();

    await revertMemoryReconciliation(project, { runId: plan.id });
    const restored = openMemoryStore(project);
    restored.init();
    const live = restored.searchMemoryLayer({ qualityStatus: "all" }).map((item) => item.id);
    expect(live).toContain(memory.id);
    expect(live).not.toContain(replacementId);
    expect(restored.listMemoryCandidates({ qualityStatus: "all", limit: null }).map((item) => item.id)).toContain(replacementId);
    restored.close();
  });

  it("applies an approved correction and ordinary decision in one local batch before requesting sync", async () => {
    vi.stubEnv("CODE_BUTLER_HOME", root());
    const project = root();
    addLegacyCandidate(project, "mixed-batch");
    const store = openMemoryStore(project); store.init();
    store.addCommit({
      hash: "mixed-change", authorName: "Test", authorEmail: "test@example.com",
      authoredAt: "2026-09-21T10:00:00Z", message: "Move cache to SQLite",
      changedFiles: ["src/cache.ts"], diffSummary: "+ sqlite cache"
    });
    store.upsertMemoryCandidate({
      type: "decision", title: "Cache backend", summary: "The cache uses Redis.",
      reason: "Earlier implementation choice.", confidence: 0.7,
      evidence: [{ sourceType: "commit", sourceId: "mixed-change" }],
      relatedFiles: ["src/cache.ts"], dedupeKey: "mixed-change-candidate"
    }, { qualityStatus: "needs_review", qualityReasons: ["stale_related_file_evidence"] });
    store.close();
    const fake = provider((payload) => ({
      verdict: "changed", confidence: 0.96, rationale: "The commit records SQLite.",
      citationIds: [(payload.observations as Array<{ citationId: string; kind: string }>)
        .find(observation => observation.kind === "commit")!.citationId],
      correction: { summary: "The cache uses SQLite.", reason: "Matches the commit.", relatedFiles: ["src/cache.ts"] }
    }));
    const plan = await planMemoryReconciliation(project, { queue: "all", limit: null }, { provider: fake });
    expect(plan).toMatchObject({ counts: { planned: 1, awaiting_correction_approval: 1 } });
    saveBinding(project, cloudBinding("conflict"));
    const requestSync = vi.fn(() => {
      expect(readMemoryReconciliationRun(project, plan.id).counts.applied).toBe(2);
    });
    const applied = await applyMemoryReconciliation(project, {
      runId: plan.id, itemIds: plan.items.map(item => item.itemId), applyCorrections: true
    }, { requestSync });
    expect(applied).toMatchObject({ counts: { applied: 2 }, syncRequest: "queued" });
    expect(requestSync).toHaveBeenCalledOnce();
    expect(fake.calls).toBe(1);
  });

  it("retries a saved Apply failure without rerunning the AI review", async () => {
    const project = root();
    addLegacyCandidate(project, "apply-retry");
    const plan = await planMemoryReconciliation(project, { queue: "legacy", limit: null });
    const store = openMemoryStore(project); store.init();
    store.localDb.prepare(
      "update memory_reconciliation_items set state = 'failed', error = 'interrupted Apply' where run_id = ?"
    ).run(plan.id);
    store.close();
    const applied = await applyMemoryReconciliation(project, { runId: plan.id, itemIds: [plan.items[0]!.itemId] });
    expect(applied).toMatchObject({ counts: { applied: 1, failed: 0 } });
  });

  it("retries one malformed response and turns sub-threshold confidence into uncertainty", async () => {
    const project = root();
    const store = openMemoryStore(project);
    store.init();
    const memory = store.upsertMemoryCandidate({
      type: "constraint",
      title: "Unknown constraint",
      summary: "The deployment may require a private runner.",
      reason: "The source is ambiguous.",
      confidence: 0.4,
      evidence: [],
      relatedFiles: [],
      dedupeKey: "ai-uncertain-candidate"
    }, { qualityStatus: "needs_review", qualityReasons: ["low_confidence"] });
    store.close();
    const fake = provider((payload, call) => call === 1 ? "not json" : {
      verdict: "current",
      confidence: 0.5,
      rationale: "There is not enough current project evidence.",
      citationIds: [(payload.observations as Array<{ citationId: string }>)[0]!.citationId]
    });
    const plan = await planMemoryReconciliation(project, { queue: "actionable" }, { provider: fake });
    expect(plan).toMatchObject({ requestCount: 2, counts: expect.objectContaining({ uncertain: 1 }) });
    expect(plan.items[0]).toMatchObject({ memoryId: memory.id, verdict: "uncertain", state: "uncertain" });
  });

  it("rejects positive verdicts supported only by missing evidence", async () => {
    const project = root();
    const store = openMemoryStore(project);
    store.init();
    store.upsertMemoryCandidate({
      type: "constraint",
      title: "Missing evidence",
      summary: "The deployment requires a private runner.",
      reason: "The referenced source is gone.",
      confidence: 0.7,
      evidence: [{ sourceType: "commit", sourceId: "missing-commit" }],
      relatedFiles: [],
      dedupeKey: "missing-positive-evidence"
    }, { qualityStatus: "quarantined", qualityReasons: ["unresolved_evidence"] });
    store.close();

    const fake = provider((payload, call) => ({
      verdict: call === 1 ? "current" : "uncertain",
      confidence: 0.98,
      rationale: call === 1 ? "The missing record proves it." : "The current project evidence is insufficient.",
      citationIds: [(payload.observations as Array<{ citationId: string }>)[0]!.citationId]
    }));
    const plan = await planMemoryReconciliation(project, { queue: "actionable" }, { provider: fake });
    expect(fake.calls).toBe(2);
    expect(plan.items[0]).toMatchObject({ verdict: "uncertain", state: "uncertain" });
  });

  it("reuses uncertain judgments unless retry-uncertain explicitly bypasses the cache", async () => {
    const project = root();
    const store = openMemoryStore(project);
    store.init();
    store.addCommit({
      hash: "uncertain-cache-evidence",
      authorName: "Test",
      authorEmail: "test@example.com",
      authoredAt: "2026-09-22T10:00:00.000Z",
      message: "Document the runner",
      changedFiles: ["deploy.yml"],
      diffSummary: "+ private runner"
    });
    store.upsertMemoryCandidate({
      type: "constraint",
      title: "Private runner",
      summary: "Deployments require a private runner.",
      reason: "The current evidence may be environment-specific.",
      confidence: 0.55,
      evidence: [{ sourceType: "commit", sourceId: "uncertain-cache-evidence" }],
      relatedFiles: [],
      dedupeKey: "uncertain-cache"
    }, { qualityStatus: "needs_review", qualityReasons: ["low_confidence"] });
    store.close();

    const uncertain = provider(() => ({
      verdict: "uncertain",
      confidence: 0.96,
      rationale: "The evidence does not establish that this applies to every deployment.",
      citationIds: []
    }));
    const original = await planMemoryReconciliation(project, { queue: "actionable" }, { provider: uncertain });
    expect(uncertain.calls).toBe(1);

    const cachedProvider = provider(() => {
      throw new Error("cached uncertainty should avoid a model request");
    });
    const cached = await replanMemoryReconciliation(project, { runId: original.id }, { provider: cachedProvider });
    expect(cachedProvider.calls).toBe(0);
    expect(cached).toMatchObject({ parentRunId: original.id, requestCount: 0 });
    expect(cached.items[0]).toMatchObject({ verdict: "uncertain", state: "uncertain" });

    const retry = provider((payload) => ({
      verdict: "current",
      confidence: 0.97,
      rationale: "The indexed deployment change directly records the constraint.",
      citationIds: [(payload.observations as Array<{ citationId: string; kind: string }>)
        .find((observation) => observation.kind === "commit")!.citationId]
    }));
    const replanned = await replanMemoryReconciliation(
      project,
      { runId: original.id, retryUncertain: true },
      { provider: retry }
    );
    expect(retry.calls).toBe(1);
    expect(replanned.items[0]).toMatchObject({ verdict: "current", state: "planned" });
  });

  it("skips a stale proposal and requires an explicit stale-only replan", async () => {
    const project = root();
    const store = openMemoryStore(project);
    store.init();
    store.addCommit({
      hash: "stale-plan-evidence",
      authorName: "Test",
      authorEmail: "test@example.com",
      authoredAt: "2026-09-22T10:00:00.000Z",
      message: "Set cache limit",
      changedFiles: ["src/cache.ts"],
      diffSummary: "+ maxEntries: 100"
    });
    store.upsertMemoryCandidate({
      type: "constraint",
      title: "Cache limit",
      summary: "The cache is limited to 100 entries.",
      reason: "Avoid unbounded memory growth.",
      confidence: 0.55,
      evidence: [{ sourceType: "commit", sourceId: "stale-plan-evidence" }],
      relatedFiles: [],
      dedupeKey: "stale-plan"
    }, { qualityStatus: "needs_review", qualityReasons: ["low_confidence"] });
    store.close();
    const judgment = () => provider((payload) => ({
      verdict: "current",
      confidence: 0.97,
      rationale: "The indexed commit records the bound.",
      citationIds: [(payload.observations as Array<{ citationId: string; kind: string }>)
        .find((observation) => observation.kind === "commit")!.citationId]
    }));
    const plan = await planMemoryReconciliation(project, { queue: "actionable" }, { provider: judgment() });

    const changed = openMemoryStore(project);
    changed.init();
    changed.addCommit({
      hash: "stale-plan-evidence",
      authorName: "Test",
      authorEmail: "test@example.com",
      authoredAt: "2026-09-22T11:00:00.000Z",
      message: "Raise cache limit",
      changedFiles: ["src/cache.ts"],
      diffSummary: "+ maxEntries: 200"
    });
    changed.close();

    const skipped = await applyMemoryReconciliation(project, { runId: plan.id });
    expect(skipped).toMatchObject({ status: "partial", counts: expect.objectContaining({ stale: 1, applied: 0 }) });
    const replanned = await replanMemoryReconciliation(
      project,
      { runId: plan.id, staleOnly: true },
      { provider: judgment() }
    );
    expect(replanned).toMatchObject({ parentRunId: plan.id, status: "planned" });
    expect(replanned.items[0]).toMatchObject({ verdict: "current", state: "planned" });
  });

  it("makes a proposal stale when the effective review decision changes", async () => {
    const project = root();
    const store = openMemoryStore(project);
    store.init();
    store.addCommit({
      hash: "review-change-evidence",
      authorName: "Test",
      authorEmail: "test@example.com",
      authoredAt: "2026-09-22T10:00:00.000Z",
      message: "Document bounded queues",
      changedFiles: ["src/queue.ts"],
      diffSummary: "+ bounded queue"
    });
    const memory = store.upsertMemoryCandidate({
      type: "constraint",
      title: "Bound queues",
      summary: "All background queues are bounded.",
      reason: "Protect long-running processes.",
      confidence: 0.55,
      evidence: [{ sourceType: "commit", sourceId: "review-change-evidence" }],
      relatedFiles: [],
      dedupeKey: "review-change"
    }, { qualityStatus: "needs_review", qualityReasons: ["low_confidence"] });
    store.close();
    const fake = provider((payload) => ({
      verdict: "current",
      confidence: 0.97,
      rationale: "The indexed change establishes the constraint.",
      citationIds: [(payload.observations as Array<{ citationId: string; kind: string }>)
        .find((observation) => observation.kind === "commit")!.citationId]
    }));
    const plan = await planMemoryReconciliation(project, { queue: "actionable" }, { provider: fake });

    const reviewed = openMemoryStore(project);
    reviewed.init();
    resolveMemoryReview(reviewed, {
      memoryId: memory.id,
      category: "candidate",
      action: "verify",
      reviewToken: plan.items[0]!.reviewToken,
      reason: "A human confirmed this before the AI plan was applied."
    }, "cli");
    reviewed.close();

    const result = await applyMemoryReconciliation(project, { runId: plan.id });
    expect(result).toMatchObject({ status: "partial", counts: expect.objectContaining({ stale: 1, applied: 0 }) });
  });

  it("continues reverting eligible items when a later edit blocks one item", async () => {
    const project = root();
    const first = addLegacyCandidate(project, "first");
    const second = addLegacyCandidate(project, "second");
    const plan = await planMemoryReconciliation(project, { queue: "legacy", limit: null });
    await applyMemoryReconciliation(project, { runId: plan.id });

    const changed = openMemoryStore(project);
    changed.init();
    changed.upsertMemoryCandidate({
      type: "constraint",
      title: "Config defines first (edited)",
      summary: "The first setting was edited after reconciliation.",
      reason: "Later human edit.",
      confidence: 0.9,
      evidence: [],
      relatedFiles: ["package.json"],
      dedupeKey: "deterministic:config:package.json:first"
    });
    changed.close();

    const reverted = await revertMemoryReconciliation(project, { runId: plan.id });
    expect(reverted).toMatchObject({
      status: "partial",
      counts: expect.objectContaining({ reverted: 1, revert_blocked: 1 })
    });
    expect(reverted.items.find((item) => item.memoryId === first.id)).toMatchObject({ state: "revert_blocked" });
    expect(reverted.items.find((item) => item.memoryId === second.id)).toMatchObject({ state: "reverted" });
  });

  it.each(["offline-network", "deferred", "conflict", "authentication", "upgrade-required", "integrity-failure"] as const)(
    "applies and undoes locally before requesting background sync when cloud is %s",
    async (condition) => {
      vi.stubEnv("CODE_BUTLER_HOME", root());
      const project = root();
      addLegacyCandidate(project, condition);
      const plan = await planMemoryReconciliation(project, { queue: "legacy", limit: null });
      saveBinding(project, cloudBinding(condition));

      const applied = await applyMemoryReconciliation(project, { runId: plan.id, forceOffline: true });
      expect(applied).toMatchObject({ status: "applied", offlineOverride: false, syncRequest: "queued" });
      expect(automaticSyncPending(project)).toBe(true);
      expect(binding(project)?.syncCondition).toBe(condition);
      const owner = new AutomaticSyncOwner(project);
      owner.acknowledge(owner.pending());
      expect(automaticSyncPending(project)).toBe(false);

      const reverted = await revertMemoryReconciliation(project, { runId: plan.id });
      expect(reverted).toMatchObject({ status: "reverted", syncRequest: "queued" });
      expect(automaticSyncPending(project)).toBe(true);
      expect(binding(project)?.syncCondition).toBe(condition);
    }
  );

  it("keeps a committed local decision successful when queuing cloud sync fails", async () => {
    vi.stubEnv("CODE_BUTLER_HOME", root());
    const project = root();
    addLegacyCandidate(project, "scheduling-failure");
    const plan = await planMemoryReconciliation(project, { queue: "legacy", limit: null });
    saveBinding(project, cloudBinding("offline-network"));
    const applied = await applyMemoryReconciliation(project, { runId: plan.id }, {
      requestSync: () => { throw new Error("scheduler unavailable"); }
    });
    expect(applied).toMatchObject({ counts: { applied: 1 }, syncRequest: "failed" });
    expect(automaticSyncPending(project)).toBe(false);
    expect((await applyMemoryReconciliation(project, { runId: plan.id })).syncRequest).toBe("queued");
  });
});
