// Tests desktop project setup, review actions, and operation coordination.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureProjectConfig } from "../src/config.js";
import { runCli } from "../src/cli.js";
import { handleDesktopRequest } from "../src/desktop/service.js";
import { rememberProjectMemory } from "../src/memory/remember.js";
import { planMemoryReconciliation, previewDesktopMemoryReconciliation } from "../src/memory/reconciliation.js";
import { initializeSchema, SCHEMA_MIGRATIONS } from "../src/storage/migrations.js";
import { openConfiguredMemoryStore } from "../src/storage/open-configured-store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";
import { saveBinding, binding, stateDirectory } from "../src/cloud/state.js";
import { syncProgressWriter } from "../src/cloud/sync-progress.js";
import { readProjectOperationStatus, withProjectGate } from "../src/cloud/gate.js";
import { activeForegroundIntent, renewForegroundIntent } from "../src/cloud/foreground.js";
import { ReviewStartCancelledError, runDesktopMemoryReview } from "../src/desktop/service.js";
import { AutomaticSyncOwner } from "../src/cloud/sync-owner.js";
import { globalWatchDirectory, runGlobalWatch } from "../src/global-watch.js";
import { NativeSecurity } from "../src/cloud/native-security.js";

describe("desktop engine contract", () => {
  let directory: string;
  let root: string;
  const watcherServiceStatus = () => ({
    installed: true,
    running: false,
    platform: "win32",
    label: "com.codebutler.watch.global",
    logsDir: "logs"
  });
  const addOptions = {
    ensureGlobalWatcher: () => {},
    initializationOptions: { generator: { async generate() { return "## What this is\n\nInitialized from desktop.\n"; } } }
  };

  beforeEach(() => {
    directory = makeTempDir();
    root = join(directory, "project");
    mkdirSync(root, { recursive: true });
    vi.stubEnv("CODE_BUTLER_HOME", join(directory, "home"));
    ensureProjectConfig(root);
    const store = openConfiguredMemoryStore(root);
    store.init();
    rememberProjectMemory(store, {
      type: "decision",
      title: "Desktop framework",
      text: "Use Tauri for the Windows-first desktop application.",
      reason: "Keep the distribution footprint small."
    });
    store.close();
    writeFileSync(join(root, ".code-butler", "project-summary.md"), "# Project brief\n\nDesktop work is active.\n");
    writeFileSync(join(root, "AGENTS.md"), "Desktop project instructions\n");
    writeFileSync(join(root, "CLAUDE.md"), "Desktop project instructions\n");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    cleanupTempDir(directory);
  });


  it("serves tier pages and working actions through the default desktop engine", async () => {
    vi.stubEnv("CODE_BUTLER_RETRIEVAL_ENGINE", "legacy");
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    const store = openConfiguredMemoryStore(root);
    store.init();
    let working: ReturnType<typeof store.upsertTemporaryMemory>;
    try {
      const now = new Date().toISOString();
      working = store.upsertTemporaryMemory({
        kind: "open_question", title: "Choose storage",
        summary: "Consider local project storage.", createdAt: now, updatedAt: now,
        scope: { kind: "conditional", platforms: ["win32"] }, layer: "branch:storage"
      });
    } finally { store.close(); }
    await expect(handleDesktopRequest({ version: 2, action: "memory.tiers", root }))
      .resolves.toMatchObject({ counts: { working: 1, durable: 1 } });
    await expect(handleDesktopRequest({ version: 2, action: "memory.page", root, tier: "working", limit: 1 }))
      .resolves.toMatchObject({ total: 1, items: [{ id: working.id, kind: "open_question" }] });
    await expect(handleDesktopRequest({ version: 1, action: "memory.working.detail", root, id: working.id }))
      .resolves.toMatchObject({ id: working.id, sharing: "storage · branch memory" });
    const kept = await handleDesktopRequest({ version: 1, action: "memory.working.keep", root, id: working.id });
    expect(kept).toMatchObject({ id: working.id, createdAt: working.createdAt });
    await expect(handleDesktopRequest({
      version: 1, action: "memory.working.candidate", root, id: working.id,
      type: "constraint", text: "Keep storage local on Windows.", destination: "project",
      fields: { requirement: "Keep storage local on Windows." }
    })).resolves.toMatchObject({ candidate: { promotionState: "candidate", layer: "core",
      scope: { kind: "conditional", platforms: ["win32"] },
      statement: { origin: "human", fields: { requirement: "Keep storage local on Windows." } } } });
    await expect(handleDesktopRequest({ version: 2, action: "memory.page", root, tier: "candidates" }))
      .resolves.toMatchObject({ total: 1 });
    await expect(handleDesktopRequest({ version: 1, action: "project.overview", root }))
      .resolves.toMatchObject({ tiers: { working: 1, candidates: 1, durable: 1 }, working: [{ id: working.id }] });
  });

  it("requires explicit deletion consent, preserves source files, and prevents stale operations recreating memory", async () => {
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    writeFileSync(join(root, "source.ts"), "export const keep = true;");
    await expect(handleDesktopRequest({ version: 1, action: "projects.remove", root, mode: "local" }))
      .rejects.toMatchObject({ code: "confirmation-required" });
    expect(existsSync(join(root, ".code-butler", "memory.sqlite"))).toBe(true);
    await handleDesktopRequest({ version: 1, action: "projects.remove", root, mode: "local", confirmed: true });
    expect(existsSync(join(root, ".code-butler"))).toBe(false);
    expect(readFileSync(join(root, "source.ts"), "utf8")).toContain("keep");
    expect(await handleDesktopRequest({ version: 1, action: "projects.list" }, { watcherServiceStatus })).toMatchObject({ projects: [] });
    await expect(withProjectGate(root, () => {})).rejects.toThrow("removed");
    expect(() => openConfiguredMemoryStore(root)).toThrow("removed");
    expect(existsSync(join(root, ".code-butler"))).toBe(false);
    await handleDesktopRequest({ version: 1, action: "projects.add", root, initialize: true }, addOptions);
    expect(existsSync(join(root, ".code-butler", "memory.sqlite"))).toBe(true);
  });

  it("refuses local deletion while another database session is open", async () => {
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    const store = openConfiguredMemoryStore(root); store.init();
    try {
      await expect(handleDesktopRequest({ version: 1, action: "projects.remove", root, mode: "local", confirmed: true }))
        .rejects.toThrow("database sessions");
      expect(existsSync(join(root, ".code-butler", "memory.sqlite"))).toBe(true);
    } finally { store.close(); }
  });

  it("waits for an active cloud operation before applying and reading AI review results", async () => {
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    const store = openConfiguredMemoryStore(root); store.init();
    store.upsertMemoryCandidate({
      type: "constraint", title: "Legacy config", summary: "package.json defines retries.",
      reason: "Legacy deterministic config extraction.", confidence: 0.65, evidence: [],
      relatedFiles: ["package.json"], dedupeKey: "deterministic:config:package.json:retries"
    }, { qualityStatus: "quarantined", qualityReasons: ["legacy_low_signal_heuristic"] });
    store.close();
    const run = await planMemoryReconciliation(root, {
      queue: "all", desktopSelection: { kind: "quarantined", limit: 1 }, maxRequests: 1, tokenBudget: 1
    });
    expect(run.items[0]).toMatchObject({ state: "planned", verdict: "low_value" });

    let release!: () => void;
    let entered!: () => void;
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    const holding = withProjectGate(root, async () => {
      await new Promise<void>(resolve => { release = resolve; entered(); });
    });
    await acquired;
    const applying = handleDesktopRequest({
      version: 1, action: "memory.ai.apply", root, runId: run.id, itemIds: [run.items[0]!.itemId]
    });
    const readingStatus = handleDesktopRequest({ version: 1, action: "memory.ai.status", root, runId: run.id });
    const readingResults = handleDesktopRequest({ version: 1, action: "memory.ai.results", root, runId: run.id });
    await new Promise(resolve => setTimeout(resolve, 80));
    release();
    await holding;
    const [applied, status, results] = await Promise.all([applying, readingStatus, readingResults]);
    expect(applied).toMatchObject({ counts: { applied: 1 } });
    expect(status).toMatchObject({ run: { id: run.id } });
    expect(results).toMatchObject({ run: { id: run.id } });
  });

  it("returns saved AI review results while another operation holds the project lock", async () => {
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    const store = openConfiguredMemoryStore(root); store.init();
    store.upsertMemoryCandidate({
      type: "constraint", title: "Legacy config", summary: "package.json defines retries.",
      reason: "Legacy deterministic config extraction.", confidence: 0.65, evidence: [],
      relatedFiles: ["package.json"], dedupeKey: "deterministic:config:package.json:retries"
    }, { qualityStatus: "quarantined", qualityReasons: ["legacy_low_signal_heuristic"] });
    store.close();
    const run = await planMemoryReconciliation(root, {
      queue: "all", desktopSelection: { kind: "quarantined", limit: 1 }, maxRequests: 1, tokenBudget: 1
    });

    let release!: () => void;
    let entered!: () => void;
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    const holding = withProjectGate(root, async () => {
      await new Promise<void>(resolve => { release = resolve; entered(); });
    });
    await acquired;
    const started = Date.now();
    const busy = await handleDesktopRequest({ version: 1, action: "memory.ai.results", root, runId: run.id });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(busy).toMatchObject({ run: { id: run.id }, memories: {}, memoriesPending: true });
    release();
    await holding;

    const free = await handleDesktopRequest({ version: 1, action: "memory.ai.results", root, runId: run.id });
    expect(free).not.toHaveProperty("memoriesPending");
    expect(free).toMatchObject({ run: { id: run.id }, memories: { [run.items[0]!.memoryId]: { title: "Legacy config" } } });
  });

  it("identifies a lock owner and queues review startup until the lock clears", async () => {
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    const store = openConfiguredMemoryStore(root); store.init();
    store.upsertMemoryCandidate({
      type: "constraint", title: "Legacy config", summary: "package.json defines retries.",
      reason: "Legacy deterministic config extraction.", confidence: 0.65, evidence: [],
      relatedFiles: ["package.json"], dedupeKey: "deterministic:config:package.json:retries"
    }, { qualityStatus: "quarantined", qualityReasons: ["legacy_low_signal_heuristic"] });
    store.close();
    let release!: () => void;
    let entered!: () => void;
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    const holding = withProjectGate(root, async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
    }, { name: "Cloud restore" });
    await acquired;
    expect(await handleDesktopRequest({ version: 1, action: "project.operation.status", root }))
      .toMatchObject({ operation: { name: "Cloud restore", pid: process.pid, startedAt: expect.any(String) } });
    const waiting: string[] = [];
    const review = runDesktopMemoryReview({ version: 1, action: "memory.ai.run", root,
      selection: { kind: "quarantined", limit: 1 }, tokenCap: 1 }, () => {}, () => false,
    { onWaiting: status => waiting.push(status.operation?.name ?? "unknown") });
    await vi.waitFor(() => expect(waiting).toContain("Cloud restore"));
    release(); await holding;
    expect(await review).toMatchObject({ status: "planned", items: [{ verdict: "low_value" }] });
    expect(readProjectOperationStatus(root)).toBeUndefined();
  });

  it("keeps one preview priority intent across busy retries and releases it after preview", async () => {
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    const store = openConfiguredMemoryStore(root); store.init();
    store.upsertMemoryCandidate({
      type: "constraint", title: "Legacy config", summary: "package.json defines retries.",
      reason: "Legacy deterministic config extraction.", confidence: 0.65, evidence: [],
      relatedFiles: ["package.json"], dedupeKey: "deterministic:config:package.json:retries"
    }, { qualityStatus: "quarantined", qualityReasons: ["legacy_low_signal_heuristic"] });
    store.close();
    let release!: () => void;
    let entered!: () => void;
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    const holding = withProjectGate(root, async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
    }, { name: "Watcher import" });
    await acquired;
    const intentId = randomUUID();
    const payload = { version: 1, action: "memory.ai.preview", root, selection: { kind: "quarantined", limit: 1 }, intentId };
    try {
      await expect(handleDesktopRequest(payload)).rejects.toMatchObject({ code: "busy" });
      expect(activeForegroundIntent(root)?.id).toBe(intentId);
    } finally { release(); await holding; }
    expect(await handleDesktopRequest(payload)).toMatchObject({ selected: 1 });
    expect(activeForegroundIntent(root)).toBeUndefined();
    const canceledId = randomUUID();
    renewForegroundIntent(root, canceledId);
    expect(await handleDesktopRequest({ version: 1, action: "project.operation.release-intent", root, intentId: canceledId })).toEqual({ released: true });
    expect(activeForegroundIntent(root)).toBeUndefined();
  });

  it("cancels a queued review without creating a saved run", async () => {
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    let release!: () => void;
    let entered!: () => void;
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    const holding = withProjectGate(root, async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
    });
    await acquired;
    let stop = false;
    const review = runDesktopMemoryReview({ version: 1, action: "memory.ai.run", root,
      selection: { kind: "all", limit: 1 }, tokenCap: 1 }, () => {}, () => stop,
    { onWaiting: () => { stop = true; } });
    await expect(review).rejects.toBeInstanceOf(ReviewStartCancelledError);
    release(); await holding;
    expect(await handleDesktopRequest({ version: 1, action: "memory.ai.status", root })).toEqual({});
  });

  it("reports a cloud sync holding only the checkout gate, with its upload progress", async () => {
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    mkdirSync(stateDirectory(root), { recursive: true });
    let release!: () => void, entered!: () => void;
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    const holding = withProjectGate(stateDirectory(root), async () => {
      const progress = syncProgressWriter(root); progress.upload(6_000_000, 13_000_000);
      entered(); await new Promise<void>(resolve => { release = resolve; }); progress.clear();
    }, { name: "Applying memory choice" });
    await acquired;
    expect(await handleDesktopRequest({ version: 1, action: "project.operation.status", root })).toMatchObject({
      operation: { name: "Applying memory choice", pid: process.pid, progress: { phase: "uploading", sentBytes: 6_000_000, totalBytes: 13_000_000 } }
    });
    release(); await holding;
    expect(await handleDesktopRequest({ version: 1, action: "project.operation.status", root })).toEqual({});
  });

  it("reports legacy lock owners and ignores dead owners", async () => {
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    const lock = join(root, ".code-butler", ".cloud-operation.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "legacy" }));
    expect(await handleDesktopRequest({ version: 1, action: "project.operation.status", root }))
      .toEqual({ operation: { name: "Other local operation", pid: process.pid } });
    writeFileSync(lock, JSON.stringify({ pid: 99999999, token: "dead" }));
    expect(await handleDesktopRequest({ version: 1, action: "project.operation.status", root })).toEqual({});
    await expect(withProjectGate(root, () => "entered" as const)).resolves.toBe("entered");
  });

  it("reclaims a gate lock when its PID now belongs to another process", async () => {
    const lock = join(root, ".code-butler", ".cloud-operation.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, processStart: "1", token: "former-owner", startedAt: new Date().toISOString() }));
    expect(readProjectOperationStatus(root)).toBeUndefined();
    await expect(withProjectGate(root, () => "entered" as const)).resolves.toBe("entered");
    expect(existsSync(lock)).toBe(false);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it("rechecks the reviewed selection after waiting and stops if it changed", async () => {
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    const store = openConfiguredMemoryStore(root); store.init();
    const memory = store.upsertMemoryCandidate({
      type: "constraint", title: "Legacy config", summary: "package.json defines retries.",
      reason: "Legacy deterministic config extraction.", confidence: 0.65, evidence: [],
      relatedFiles: ["package.json"], dedupeKey: "deterministic:config:package.json:retries"
    }, { qualityStatus: "quarantined", qualityReasons: ["legacy_low_signal_heuristic"] });
    store.close();
    const preview = previewDesktopMemoryReconciliation(root, { kind: "quarantined", limit: 1 });
    let release!: () => void;
    let entered!: () => void;
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    const holding = withProjectGate(root, async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
      const changed = openConfiguredMemoryStore(root); changed.init();
      changed.db.prepare("update memory_candidates set summary = ? where id = ?").run("Changed while review waited.", memory.id);
      changed.close();
    }, { name: "Memory sync" });
    await acquired;
    let waiting = false;
    const review = runDesktopMemoryReview({ version: 1, action: "memory.ai.run", root,
      selection: { kind: "quarantined", limit: 1 }, expectedSelectionFingerprint: preview.selectionFingerprint,
      tokenCap: 1 }, () => {}, () => false, { onWaiting: () => { waiting = true; } });
    await vi.waitFor(() => expect(waiting).toBe(true));
    release(); await holding;
    await expect(review).rejects.toThrow("selected memories changed after preview");
  });

  it("applies multiple approved corrections in one desktop request", async () => {
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    const store = openConfiguredMemoryStore(root); store.init();
    store.addCommit({
      hash: "desktop-correction", authorName: "Test", authorEmail: "test@example.com",
      authoredAt: "2026-09-21T10:00:00Z", message: "Update cache settings",
      changedFiles: ["src/cache.ts"], diffSummary: "+ sqlite cache"
    });
    for (const index of [1, 2]) {
      store.upsertMemoryCandidate({
        type: "decision", title: `Cache setting ${index}`, summary: `Cache setting ${index} uses Redis.`,
        reason: "Earlier implementation choice.", confidence: 0.7,
        evidence: [{ sourceType: "commit", sourceId: "desktop-correction" }],
        relatedFiles: ["src/cache.ts"], dedupeKey: `desktop-correction-${index}`
      }, { qualityStatus: "needs_review", qualityReasons: ["stale_related_file_evidence"] });
    }
    store.close();
    const run = await planMemoryReconciliation(root, {
      queue: "all", desktopSelection: { kind: "needs_review", limit: 2 },
      maxRequests: 4, tokenBudget: 100_000
    }, { provider: {
      provider: "mock", model: "correction-test",
      async request(input) {
        const observations = input.payload.observations as Array<{ citationId: string; kind: string }>;
        return { content: JSON.stringify({
          verdict: "changed", confidence: 0.96, rationale: "The current commit uses SQLite.",
          citationIds: [observations.find(item => item.kind === "commit")!.citationId],
          correction: { summary: "The cache uses SQLite.", reason: "Matches the current implementation.", relatedFiles: ["src/cache.ts"] }
        }) };
      }
    } });
    expect(run.items).toHaveLength(2);
    expect(run.items.every(item => item.state === "awaiting_correction_approval")).toBe(true);
    const itemIds = run.items.map(item => item.itemId);
    const applied = await handleDesktopRequest({ version: 1, action: "memory.ai.apply", root,
      runId: run.id, itemIds, applyCorrections: true });
    expect(applied).toMatchObject({ counts: { applied: 2, awaiting_correction_approval: 0 }, syncRequest: "disabled" });
    const replay = await handleDesktopRequest({ version: 1, action: "memory.ai.apply", root,
      runId: run.id, itemIds, applyCorrections: true });
    expect(replay).toMatchObject({ counts: { applied: 2, awaiting_correction_approval: 0 } });
  });

  it("shows a saved local Apply as pending until background sync acknowledges it", async () => {
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    const store = openConfiguredMemoryStore(root); store.init();
    store.upsertMemoryCandidate({
      type: "constraint", title: "Legacy config", summary: "package.json defines retries.",
      reason: "Legacy deterministic config extraction.", confidence: 0.65, evidence: [],
      relatedFiles: ["package.json"], dedupeKey: "deterministic:config:package.json:retries"
    }, { qualityStatus: "quarantined", qualityReasons: ["legacy_low_signal_heuristic"] });
    store.close();
    const run = await planMemoryReconciliation(root, {
      queue: "all", desktopSelection: { kind: "quarantined", limit: 1 }, maxRequests: 1, tokenBudget: 1
    });
    saveBinding(root, {
      projectId: "test-cloud-project", server: "https://cloud.example.test", vaultId: "test-vault",
      enabled: true, revision: 1, fingerprint: "0".repeat(64), status: "conflict", syncCondition: "conflict"
    });
    const applied = await handleDesktopRequest({ version: 1, action: "memory.ai.apply", root,
      runId: run.id, itemIds: [run.items[0]!.itemId] });
    expect(applied).toMatchObject({ counts: { applied: 1 }, syncRequest: "queued" });
    expect(await handleDesktopRequest({ version: 1, action: "project.overview", root })).toMatchObject({
      cloud: { status: "conflict", pendingSync: true }
    });
    expect(await handleDesktopRequest({ version: 1, action: "cloud.sync.status", root })).toMatchObject({
      pendingSync: true, queuedSince: expect.any(String)
    });
    await runGlobalWatch({ cliPath: "unused", once: true, runProject: async () => ({ outcome: "deferred", stage: "cloud", reason: "Another operation is active" }) });
    expect(await handleDesktopRequest({ version: 1, action: "cloud.sync.status", root })).toMatchObject({
      pendingSync: true, deferredReason: "Another operation is active"
    });
    const owner = new AutomaticSyncOwner(root);
    expect(owner.acquire()).toBe(true);
    const token = owner.beginRun();
    expect(await handleDesktopRequest({ version: 1, action: "cloud.sync.status", root })).toMatchObject({
      pendingSync: true, runningSince: expect.any(String)
    });
    owner.completeRun(token, "test-stamp"); owner.endRun(); owner.release();
    expect(await handleDesktopRequest({ version: 1, action: "project.overview", root })).toMatchObject({
      cloud: { status: "conflict" }
    });
    const overview = await handleDesktopRequest({ version: 1, action: "project.overview", root }) as { cloud: { pendingSync?: boolean; lastCompletedAt?: string } };
    expect(overview.cloud.pendingSync).toBeUndefined();
    expect(overview.cloud.lastCompletedAt).toEqual(expect.any(String));
  });

  it("reports a cloud sync as failing only after repeated failed runs", async () => {
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    saveBinding(root, {
      projectId: "test-cloud-project", server: "https://cloud.example.test", vaultId: "test-vault",
      enabled: true, revision: 1, fingerprint: "0".repeat(64), status: "deferred", syncCondition: "deferred"
    });
    const reason = "Cloud merge failed and was rolled back: FOREIGN KEY constraint failed";
    await runGlobalWatch({ cliPath: "unused", once: true, runProject: async () => ({ outcome: "failed", stage: "cloud", reason }) });
    expect(await handleDesktopRequest({ version: 1, action: "cloud.sync.status", root })).not.toHaveProperty("failedReason");
    // Later passes wait out the retry backoff, so the third consecutive failure is written as the watcher records it.
    const statusDirectory = join(globalWatchDirectory(), "status");
    const [statusFile] = readdirSync(statusDirectory).map(name => join(statusDirectory, name));
    writeFileSync(statusFile!, JSON.stringify({ ...JSON.parse(readFileSync(statusFile!, "utf8")), retryCount: 3 }));
    expect(await handleDesktopRequest({ version: 1, action: "cloud.sync.status", root })).toMatchObject({ failedReason: reason });
  });

  it("does not follow a project-memory junction outside the project", async () => {
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    const elsewhere = join(directory, "elsewhere");
    renameSync(join(root, ".code-butler"), elsewhere);
    symlinkSync(elsewhere, join(root, ".code-butler"), process.platform === "win32" ? "junction" : "dir");
    await expect(handleDesktopRequest({ version: 1, action: "projects.remove", root, mode: "local", confirmed: true }))
      .rejects.toThrow("not a normal project directory");
    expect(existsSync(join(elsewhere, "memory.sqlite"))).toBe(true);
  });

  it("keeps local memory and registration when online deletion fails, then permits retry", async () => {
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    saveBinding(root, { encryptionVersion: 2, enabled: true, projectId: "test-project", server: "https://example.com", vaultId: "test-vault", revision: 0, fingerprint: "", status: "ready" });
    const removeCloudProject = vi.fn(async () => { throw new Error("offline"); });
    const request = { version: 1, action: "projects.remove", root, mode: "everywhere", confirmed: true };
    await expect(handleDesktopRequest(request, { removeCloudProject })).rejects.toThrow("Online deletion was not confirmed");
    expect(existsSync(join(root, ".code-butler", "memory.sqlite"))).toBe(true);
    expect(await handleDesktopRequest({ version: 1, action: "projects.list" }, { watcherServiceStatus })).toMatchObject({ projects: [{ root }] });
    await handleDesktopRequest(request, { removeCloudProject: async cloud => {
      expect(cloud.projectId).toBe("test-project");
      expect(existsSync(join(root, ".code-butler", "memory.sqlite"))).toBe(true);
    } });
    expect(existsSync(join(root, ".code-butler"))).toBe(false);
    expect(binding(root)).toMatchObject({ enabled: false, status: "deleted" });
  });

  it("local-only deletion disables sync without deleting the online copy and reconnects when re-added", async () => {
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    saveBinding(root, { encryptionVersion: 2, enabled: true, projectId: "test-project", projectIdentity: "test-identity", server: "https://example.com", vaultId: "test-vault", revision: 0, fingerprint: "", status: "ready" });
    const removeCloudProject = vi.fn();
    await handleDesktopRequest({ version: 1, action: "projects.remove", root, mode: "local", confirmed: true }, { removeCloudProject });
    expect(removeCloudProject).not.toHaveBeenCalled();
    expect(binding(root)).toMatchObject({ enabled: false, status: "removed" });
    // Signed out here, so the re-added folder waits for enrollment instead of staying paused.
    const readded = await handleDesktopRequest({ version: 1, action: "projects.add", root, initialize: true }, addOptions);
    expect(readded).toMatchObject({ initialized: true, cloudSetup: { state: "pending" } });
  });

  it("adds, lists, opens, searches, reads, and removes a project without direct database access", async () => {
    const add = await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    expect(add).toMatchObject({ project: { name: "project", available: true }, initialized: false });

    const list = await handleDesktopRequest({ version: 1, action: "projects.list" }, { watcherServiceStatus });
    expect(list).toMatchObject({ watcher: { installed: true }, projects: [{ root }] });

    const overview = await handleDesktopRequest({ version: 1, action: "project.overview", root });
    expect(overview).toMatchObject({
      project: { root },
      narrative: { exists: true, summary: expect.stringContaining("Desktop work") },
      memory: { promotedMemories: 1 },
      cloud: { enabled: false, status: "not-configured" }
    });

    const search = await handleDesktopRequest({ version: 1, action: "memory.search", root, query: "Tauri" });
    expect(search).toEqual([expect.objectContaining({ title: "Desktop framework", kind: "promoted" })]);
    const id = (search as Array<{ id: string }>)[0]!.id;
    const detail = await handleDesktopRequest({ version: 1, action: "memory.detail", root, id });
    expect(detail).toMatchObject({ id, reason: "Keep the distribution footprint small." });

    await handleDesktopRequest({ version: 1, action: "projects.remove", root });
    const empty = await handleDesktopRequest({ version: 1, action: "projects.list" }, { watcherServiceStatus });
    expect(empty).toMatchObject({ projects: [] });
  });

  it("refreshes a stale project summary once and skips generation after it becomes current", async () => {
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    const generate = vi.fn(async () => "## Where things stand\n\nCurrent desktop state.\n");
    await expect(handleDesktopRequest(
      { version: 1, action: "project.summary.refresh", root, force: true },
      { projectSummaryOptions: { generator: { generate } } }
    )).resolves.toMatchObject({ generated: true, backupPath: expect.any(String) });
    expect(readFileSync(join(root, ".code-butler", "project-summary.md"), "utf8")).toContain("Current desktop state.");
    await expect(handleDesktopRequest(
      { version: 1, action: "project.summary.refresh", root },
      { projectSummaryOptions: { generator: { generate } } }
    )).resolves.toMatchObject({ checked: false, generated: false, skippedReason: "not_stale" });
    expect(generate).toHaveBeenCalledTimes(1);
    await expect(handleDesktopRequest({ version: 1, action: "project.overview", root }))
      .resolves.toMatchObject({ narrative: { status: { stale: false } } });
  });

  it("filters memory health and reads quality reasons for candidate memories", async () => {
    const store = openConfiguredMemoryStore(root);
    store.init();
    const candidate = store.upsertMemoryCandidate({
      type: "constraint",
      title: "Unverified deployment fragment",
      summary: "A copied deployment fragment needs review.",
      reason: "It has no resolvable source evidence.",
      confidence: 0.4,
      evidence: [],
      relatedFiles: [],
      dedupeKey: "desktop-quality-candidate"
    }, { qualityStatus: "quarantined", qualityReasons: ["missing_evidence", "low_confidence"] });
    const secondCandidate = store.upsertMemoryCandidate({
      type: "bug_fix",
      title: "Unresolved source fragment",
      summary: "Another fragment cannot resolve its evidence.",
      reason: "The source is not available on this device.",
      confidence: 0.8,
      evidence: [],
      relatedFiles: [],
      dedupeKey: "desktop-quality-candidate-two"
    }, { qualityStatus: "quarantined", qualityReasons: ["unresolved_evidence"] });
    store.close();
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);

    const results = await handleDesktopRequest({
      version: 1,
      action: "memory.search",
      root,
      query: "",
      qualityStatus: "quarantined",
      limit: 50
    }) as Array<{ id: string; kind: string; qualityReasons: string[]; reviewActions: string[] }>;
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: candidate.id,
        kind: "candidate",
        qualityReasons: expect.arrayContaining(["missing_evidence", "low_confidence"]),
        reviewActions: ["correct", "discard"]
      }),
      expect.objectContaining({ id: secondCandidate.id, kind: "candidate", qualityReasons: ["unresolved_evidence"] })
    ]));
    const firstPage = await handleDesktopRequest({ version: 1, action: "memory.search", root, query: "", qualityStatus: "quarantined", offset: 0, limit: 1 }) as Array<{ id: string }>;
    const secondPage = await handleDesktopRequest({ version: 1, action: "memory.search", root, query: "", qualityStatus: "quarantined", offset: 1, limit: 1 }) as Array<{ id: string }>;
    expect(new Set([firstPage[0]?.id, secondPage[0]?.id])).toEqual(new Set([candidate.id, secondCandidate.id]));
    await expect(handleDesktopRequest({ version: 1, action: "memory.detail", root, id: candidate.id }))
      .resolves.toMatchObject({ id: candidate.id, kind: "candidate", qualityStatus: "quarantined" });
  });

  it("persists desktop review actions, refreshes trust, and rejects stale review tokens", async () => {
    const store = openConfiguredMemoryStore(root);
    store.init();
    store.addCommit({
      hash: "desktop-review-base",
      authorName: "Desktop Reviewer",
      authorEmail: "review@example.com",
      authoredAt: "2026-08-01T10:00:00Z",
      message: "Add desktop review memory",
      changedFiles: ["src/desktop-review.ts"],
      diffSummary: "+ desktop review"
    });
    const candidate = store.upsertMemoryCandidate({
      type: "constraint",
      title: "Review desktop memory",
      summary: "Review this memory before relying on it in the desktop.",
      reason: "The extraction confidence is low.",
      confidence: 0.55,
      evidence: [{ sourceType: "commit", sourceId: "desktop-review-base", locator: "src/desktop-review.ts" }],
      relatedFiles: ["src/desktop-review.ts"],
      dedupeKey: "desktop-review-candidate"
    }, { qualityStatus: "needs_review", qualityReasons: ["low_confidence"] });
    store.close();
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);

    const search = await handleDesktopRequest({
      version: 1,
      action: "memory.search",
      root,
      query: "desktop memory",
      qualityStatus: "needs_review"
    }) as Array<{ id: string; reviewToken?: string; reviewActions: string[]; displayStatus: string; citations?: unknown[] }>;
    const found = search.find(memory => memory.id === candidate.id)!;
    expect(found).toMatchObject({
      reviewActions: ["verify", "correct", "discard"],
      displayStatus: "needs_review"
    });
    expect(found).not.toHaveProperty("citations");
    expect(found).not.toHaveProperty("reviewToken");
    const freshDetail = await handleDesktopRequest({ version: 1, action: "memory.detail", root, id: candidate.id }) as { reviewToken: string };

    await expect(handleDesktopRequest({
      version: 1,
      action: "memory.review.resolve",
      root,
      memoryId: candidate.id,
      category: "candidate",
      reviewAction: "verify",
      reviewToken: freshDetail.reviewToken
    })).resolves.toMatchObject({
      action: "verify",
      review: { actor: "desktop" },
      memory: { qualityStatus: "active", confidence: 0.55, promotionState: "candidate" }
    });
    await expect(handleDesktopRequest({ version: 1, action: "memory.detail", root, id: candidate.id }))
      .resolves.toMatchObject({
        reviewActions: ["correct", "discard"],
        review: { action: "verify", current: true },
        trust: { displayStatus: "human_verified" }
      });

    const changed = openConfiguredMemoryStore(root); changed.init();
    changed.addCommit({
      hash: "desktop-review-changed",
      authorName: "Desktop Reviewer",
      authorEmail: "review@example.com",
      authoredAt: "2026-08-02T10:00:00Z",
      message: "Change desktop review evidence",
      changedFiles: ["src/desktop-review.ts"],
      diffSummary: "+ changed desktop review"
    });
    changed.close();
    await expect(handleDesktopRequest({
      version: 1,
      action: "memory.review.resolve",
      root,
      memoryId: candidate.id,
      category: "candidate",
      reviewAction: "verify",
      reviewToken: freshDetail.reviewToken
    })).rejects.toMatchObject({ code: "stale-review" });
  });

  it("keeps peer-owned and historical memories read-only in desktop results", async () => {
    const store = openConfiguredMemoryStore(root); store.init();
    const layer = "device:11111111-1111-4111-8111-111111111111";
    const candidate = store.upsertMemoryCandidate({
      layer,
      type: "constraint",
      title: "Peer memory",
      summary: "This memory belongs to a peer partition.",
      reason: "Only its owning device may change it.",
      confidence: 0.8,
      evidence: [],
      relatedFiles: [],
      dedupeKey: "desktop-peer-memory"
    }, { qualityStatus: "needs_review", qualityReasons: ["curator_note"] });
    store.db.prepare(
      "insert into peer_partitions (segment_id, layer, writer_installation_id, fingerprint, imported_at) values (?, ?, ?, ?, ?)"
    ).run("partition:peer", layer, "11111111-1111-4111-8111-111111111111", "fingerprint", "2026-08-01T10:00:00.000Z");
    store.close();
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);

    await expect(handleDesktopRequest({ version: 1, action: "memory.detail", root, id: candidate.id }))
      .resolves.toMatchObject({ reviewActions: [] });
    await expect(handleDesktopRequest({
      version: 1,
      action: "memory.review.resolve",
      root,
      memoryId: candidate.id,
      category: "candidate",
      reviewAction: "discard",
      reason: "Attempted peer edit"
    })).rejects.toMatchObject({ code: "invalid-request", message: expect.stringContaining("read-only") });
  });

  it("disables an encrypted binding and requires the matching account before resuming it", async () => {
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    saveBinding(root, {
      encryptionVersion: 2,
      enabled: true,
      projectId: "test-project",
      server: "https://example.com",
      vaultId: "test-vault",
      revision: 4,
      fingerprint: "fingerprint",
      status: "synced"
    });
    await expect(handleDesktopRequest({ version: 1, action: "cloud.sync.set-enabled", root, enabled: false }))
      .rejects.toMatchObject({ code: "confirmation-required" });
    expect(binding(root)).toMatchObject({ enabled: true, status: "synced" });
    await expect(handleDesktopRequest({ version: 1, action: "cloud.sync.set-enabled", root, enabled: false, confirmed: true }))
      .resolves.toMatchObject({ enabled: false, status: "disabled", revision: 4 });
    expect(binding(root)).toMatchObject({ enabled: false, projectId: "test-project" });
    await expect(handleDesktopRequest({ version: 1, action: "cloud.sync.set-enabled", root, enabled: true, confirmed: true }))
      .rejects.toMatchObject({ code: "invalid-request", message: expect.stringContaining("cloud login") });
    expect(binding(root)).toMatchObject({ enabled: false, projectId: "test-project" });
    const cloudHome = join(directory, "home", "cloud"); mkdirSync(cloudHome, { recursive: true });
    writeFileSync(join(cloudHome, "account.json"), JSON.stringify({ server: "https://example.com" }));
    let tokenAccount = "other-account", localVault = "test-vault";
    const native = vi.spyOn(NativeSecurity, "forServer").mockReturnValue({
      invoke: async () => ({ accountId: tokenAccount }),
      status: async () => ({ descriptor: { accountId: "test-account", vaultId: localVault } })
    } as unknown as NativeSecurity);
    try {
      await expect(handleDesktopRequest({ version: 1, action: "cloud.sync.set-enabled", root, enabled: true, confirmed: true }))
        .rejects.toMatchObject({ code: "invalid-request" });
      tokenAccount = "test-account"; localVault = "other-vault";
      await expect(handleDesktopRequest({ version: 1, action: "cloud.sync.set-enabled", root, enabled: true, confirmed: true }))
        .rejects.toMatchObject({ code: "invalid-request" });
      localVault = "test-vault";
      await expect(handleDesktopRequest({ version: 1, action: "cloud.sync.set-enabled", root, enabled: true, confirmed: true }))
        .resolves.toMatchObject({ enabled: true, status: "ready", revision: 4 });
    } finally { native.mockRestore(); }
  });

  it("keeps first-time sync disabled when no authenticated cloud account is configured", async () => {
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    await expect(handleDesktopRequest({ version: 1, action: "cloud.sync.set-enabled", root, enabled: true, confirmed: true }))
      .rejects.toMatchObject({ code: "invalid-request", message: expect.stringContaining("cloud login") });
    expect(binding(root)).toBeUndefined();
  });

  it("rejects unregistered roots and unbounded search requests", async () => {
    await expect(handleDesktopRequest({ version: 1, action: "project.overview", root })).rejects.toMatchObject({ code: "not-registered" });
    await expect(handleDesktopRequest({ version: 1, action: "memory.search", root, query: "x", limit: 500 })).rejects.toMatchObject({ code: "invalid-request" });
  });

  it("inspects a ready project without changing its setup files", async () => {
    const dataDir = join(root, ".code-butler");
    const before = readdirSync(dataDir).sort();
    await expect(handleDesktopRequest({ version: 1, action: "projects.inspect", root }))
      .resolves.toMatchObject({ status: "ready", missing: [] });
    expect(readdirSync(dataDir).sort()).toEqual(before);
  });

  it("does not mistake uncheckpointed WAL data for an uninitialized database", async () => {
    const store = openConfiguredMemoryStore(root);
    try {
      store.init();
      rememberProjectMemory(store, { type: "decision", title: "Uncheckpointed change", text: "Keep this memory." });
      expect(statSync(join(root, ".code-butler", "memory.sqlite-wal")).size).toBeGreaterThan(0);
      await expect(handleDesktopRequest({ version: 1, action: "projects.inspect", root }))
        .resolves.toMatchObject({ status: "busy", issue: expect.stringContaining("uncheckpointed") });
    } finally { store.close(); }
  });

  it("can remove a registered project whose folder is unavailable", async () => {
    await handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions);
    renameSync(root, `${root}-offline`);
    await expect(handleDesktopRequest({ version: 1, action: "projects.remove", root })).resolves.toMatchObject({ root });
    const list = await handleDesktopRequest({ version: 1, action: "projects.list" }, { watcherServiceStatus });
    expect(list).toMatchObject({ projects: [] });
  });

  it("inspects without writing and requires confirmation before initializing a fresh folder", async () => {
    const freshRoot = join(directory, "fresh-project");
    mkdirSync(freshRoot);

    await expect(handleDesktopRequest({ version: 1, action: "projects.inspect", root: freshRoot }))
      .resolves.toMatchObject({ status: "needs-init", missing: ["config", "database", "summary", "AGENTS.md", "CLAUDE.md"] });
    expect(existsSync(join(freshRoot, ".code-butler"))).toBe(false);
    await expect(handleDesktopRequest({ version: 1, action: "projects.add", root: freshRoot }, addOptions))
      .rejects.toMatchObject({ code: "confirmation-required" });
    expect(existsSync(join(freshRoot, ".code-butler"))).toBe(false);

    const result = await handleDesktopRequest({ version: 1, action: "projects.add", root: freshRoot, initialize: true }, addOptions);
    expect(result).toMatchObject({ project: { root: freshRoot, name: "fresh-project", available: true }, initialized: true });
    expect(existsSync(join(freshRoot, ".code-butler", "config.json"))).toBe(true);
    expect(existsSync(join(freshRoot, ".code-butler", "memory.sqlite"))).toBe(true);
    expect(existsSync(join(freshRoot, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(freshRoot, "CLAUDE.md"))).toBe(true);
    expect(readFileSync(join(freshRoot, ".code-butler", "project-summary.md"), "utf8")).toContain("Initialized from desktop");
    await expect(handleDesktopRequest({ version: 1, action: "project.overview", root: freshRoot }))
      .resolves.toMatchObject({ narrative: { exists: true }, memory: { promotedMemories: 0 } });
  });

  it("produces the same core project artifacts as CLI init", async () => {
    const cliRoot = join(directory, "cli-project");
    const desktopRoot = join(directory, "desktop-project");
    mkdirSync(cliRoot);
    mkdirSync(desktopRoot);
    await expect(runCli(["init"], {
      cwd: cliRoot,
      projectSummaryGenerator: addOptions.initializationOptions.generator,
      watchServicePlatform: "win32",
      watchServiceHomeDir: directory,
      watchServiceCommandRunner: () => {},
      stdout: () => {}
    })).resolves.toBe(0);
    await handleDesktopRequest({ version: 1, action: "projects.add", root: desktopRoot, initialize: true }, addOptions);
    for (const file of [".code-butler/config.json", ".code-butler/memory.sqlite", ".code-butler/project-summary.md", "AGENTS.md", "CLAUDE.md"]) {
      expect(existsSync(join(cliRoot, file))).toBe(true);
      expect(existsSync(join(desktopRoot, file))).toBe(true);
    }
    expect(readFileSync(join(desktopRoot, "AGENTS.md"), "utf8"))
      .toBe(readFileSync(join(cliRoot, "AGENTS.md"), "utf8"));
  });

  it("completes missing summary setup without deleting existing memories", async () => {
    unlinkSync(join(root, ".code-butler", "project-summary.md"));
    await expect(handleDesktopRequest({ version: 1, action: "projects.inspect", root }))
      .resolves.toMatchObject({ status: "needs-init", missing: ["summary"] });
    await expect(handleDesktopRequest({ version: 1, action: "projects.add", root, initialize: true }, addOptions))
      .resolves.toMatchObject({ initialized: true });
    const overview = await handleDesktopRequest({ version: 1, action: "project.overview", root });
    expect(overview).toMatchObject({ memory: { promotedMemories: 1 }, narrative: { exists: true } });
  });

  it("recreates missing config while preserving an existing memory database", async () => {
    unlinkSync(join(root, ".code-butler", "config.json"));
    await expect(handleDesktopRequest({ version: 1, action: "projects.inspect", root }))
      .resolves.toMatchObject({ status: "needs-init", missing: ["config"] });
    await expect(handleDesktopRequest({ version: 1, action: "projects.add", root, initialize: true }, addOptions))
      .resolves.toMatchObject({ initialized: true });
    const overview = await handleDesktopRequest({ version: 1, action: "project.overview", root });
    expect(overview).toMatchObject({ memory: { promotedMemories: 1 } });
  });

  it("backs up existing agent files and reports a summary fallback", async () => {
    const freshRoot = join(directory, "backup-project");
    mkdirSync(freshRoot);
    writeFileSync(join(freshRoot, "AGENTS.md"), "Existing instructions\n");
    const result = await handleDesktopRequest({ version: 1, action: "projects.add", root: freshRoot, initialize: true }, {
      ensureGlobalWatcher: () => {},
      initializationOptions: { generator: { async generate() { throw new Error("provider unavailable"); } } }
    });
    expect(result).toMatchObject({ initialized: true, summaryFallback: true });
    const add = result as { backupFiles: string[]; warnings: string[] };
    expect(add.backupFiles.length).toBeGreaterThan(0);
    expect(readFileSync(add.backupFiles[0]!, "utf8")).toContain("Existing instructions");
    expect(add.warnings.join(" ")).toContain("fallback summary");
  });

  it("detects a stale inspection and does not silently initialize", async () => {
    await expect(handleDesktopRequest({ version: 1, action: "projects.inspect", root })).resolves.toMatchObject({ status: "ready" });
    unlinkSync(join(root, ".code-butler", "project-summary.md"));
    await expect(handleDesktopRequest({ version: 1, action: "projects.add", root }, addOptions))
      .rejects.toMatchObject({ code: "confirmation-required" });
    expect(existsSync(join(root, ".code-butler", "project-summary.md"))).toBe(false);
  });

  it("detects outdated storage, then upgrades only with confirmation", async () => {
    const oldRoot = join(directory, "old-project");
    const dataDir = join(oldRoot, ".code-butler");
    mkdirSync(dataDir, { recursive: true });
    ensureProjectConfig(oldRoot);
    const databasePath = join(dataDir, "memory.sqlite");
    const db = new DatabaseSync(databasePath);
    try { initializeSchema(db, databasePath, { migrations: SCHEMA_MIGRATIONS.slice(0, -1) }); }
    finally { db.close(); }
    const inspected = await handleDesktopRequest({ version: 1, action: "projects.inspect", root: oldRoot });
    expect(inspected).toMatchObject({ status: "needs-upgrade" });
    await expect(handleDesktopRequest({ version: 1, action: "projects.add", root: oldRoot }, addOptions))
      .rejects.toMatchObject({ code: "confirmation-required" });
    await expect(handleDesktopRequest({ version: 1, action: "projects.add", root: oldRoot, initialize: true }, addOptions))
      .resolves.toMatchObject({ initialized: true });
    await expect(handleDesktopRequest({ version: 1, action: "projects.inspect", root: oldRoot }))
      .resolves.toMatchObject({ status: "ready" });
  });

  it("rejects corrupt existing config and database without overwriting them", async () => {
    const badConfigRoot = join(directory, "bad-config");
    mkdirSync(join(badConfigRoot, ".code-butler"), { recursive: true });
    writeFileSync(join(badConfigRoot, ".code-butler", "config.json"), "{broken");
    await expect(handleDesktopRequest({ version: 1, action: "projects.inspect", root: badConfigRoot }))
      .resolves.toMatchObject({ status: "invalid", issue: expect.stringContaining("config") });
    await expect(handleDesktopRequest({ version: 1, action: "projects.add", root: badConfigRoot, initialize: true }, addOptions))
      .rejects.toMatchObject({ code: "invalid-request" });
    expect(readFileSync(join(badConfigRoot, ".code-butler", "config.json"), "utf8")).toBe("{broken");

    const badDbRoot = join(directory, "bad-database");
    mkdirSync(join(badDbRoot, ".code-butler"), { recursive: true });
    ensureProjectConfig(badDbRoot);
    writeFileSync(join(badDbRoot, ".code-butler", "memory.sqlite"), "not sqlite");
    await expect(handleDesktopRequest({ version: 1, action: "projects.inspect", root: badDbRoot }))
      .resolves.toMatchObject({ status: "invalid", issue: expect.stringContaining("database") });
    await expect(handleDesktopRequest({ version: 1, action: "projects.add", root: badDbRoot, initialize: true }, addOptions))
      .rejects.toMatchObject({ code: "invalid-request" });
    expect(readFileSync(join(badDbRoot, ".code-butler", "memory.sqlite"), "utf8")).toBe("not sqlite");

    const badLocalRoot = join(directory, "bad-local-config");
    mkdirSync(join(badLocalRoot, ".code-butler"), { recursive: true });
    writeFileSync(join(badLocalRoot, ".code-butler", "config.local.json"), "{broken");
    await expect(handleDesktopRequest({ version: 1, action: "projects.inspect", root: badLocalRoot }))
      .resolves.toMatchObject({ status: "invalid", issue: expect.stringContaining("Local project config") });
    expect(existsSync(join(badLocalRoot, ".code-butler", "config.json"))).toBe(false);
  });

  it("keeps a successfully added project when shared watcher installation fails", async () => {
    const result = await handleDesktopRequest({ version: 1, action: "projects.add", root }, {
      ensureGlobalWatcher() { throw new Error("Task Scheduler unavailable"); }
    });
    expect(result).toMatchObject({ initialized: false, warnings: [expect.stringContaining("Task Scheduler unavailable")] });
    const list = await handleDesktopRequest({ version: 1, action: "projects.list" }, { watcherServiceStatus });
    expect(list).toMatchObject({ projects: [{ root }] });
  });

  it("installs the shared watcher on request and reports why it could not", async () => {
    const ensureGlobalWatcher = vi.fn();
    await expect(handleDesktopRequest({ version: 1, action: "watcher.install" }, { ensureGlobalWatcher, watcherServiceStatus }))
      .resolves.toMatchObject({ installed: true, label: "com.codebutler.watch.global" });
    expect(ensureGlobalWatcher).toHaveBeenCalledOnce();
    await expect(handleDesktopRequest({ version: 1, action: "watcher.install" }, {
      ensureGlobalWatcher() { throw new Error("Task Scheduler unavailable"); }, watcherServiceStatus
    })).rejects.toMatchObject({ code: "invalid-request", message: expect.stringContaining("Task Scheduler unavailable") });
  });

  it("reports a missing folder clearly and does not register it", async () => {
    await expect(handleDesktopRequest({ version: 1, action: "projects.add", root: join(directory, "missing") }, addOptions))
      .rejects.toMatchObject({ code: "not-found", message: expect.stringContaining("unavailable") });
    const list = await handleDesktopRequest({ version: 1, action: "projects.list" }, { watcherServiceStatus });
    expect(list).toMatchObject({ projects: [] });
  });
});
