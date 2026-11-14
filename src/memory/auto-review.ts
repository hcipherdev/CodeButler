import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { runsOnlyWhenStarted } from "../ai/connection-policy.js";
import { jobModel } from "../ai/models.js";
import { aiBudgetExhausted, planPaused } from "../ai/usage.js";

import { atomicJson, readJson, stateDirectory } from "../cloud/state.js";
import { automaticReviewPolicy } from "../config.js";
import { openConfiguredMemoryStore } from "../storage/open-configured-store.js";
import type { MemoryStore } from "../storage/store.js";
import type { MemoryCandidate, ProjectConfig } from "../types.js";
import { awaitsCorroboration } from "./automatic-promotion.js";
import { isExactLegacyV1Memory } from "./legacy.js";
import { readMemoryPopulation } from "./quality.js";
import { applyMemoryReconciliation, planMemoryReconciliation } from "./reconciliation.js";
import {
  assertJobConfigured,
  reviewProviderFor,
  type MemoryReconciliationProvider
} from "./reconciliation-provider.js";
import { resolveMemoryReview } from "./review.js";
import { createMemoryReviewContext, currentMemoryReview, type MemoryReviewCategory } from "./review-state.js";

/**
 * Once a day, re-check flagged memories with the AI review (src/memory/reconciliation.ts),
 * ask it to confirm core candidates still waiting for corroboration, and apply the verdicts
 * the project allows. It runs in its own process, because a watcher pass is short-lived and
 * bounded in time.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
/** A run that holds the lock longer than this is presumed dead. */
const LOCK_STALE_MS = 3 * 60 * 60 * 1000;
/** A memory judged uncertain, or left waiting for a person, is not asked again for this long. */
const RECHECK_AFTER_MS = 14 * DAY_MS;
/** A durable memory judged uncertain this many times, unchanged, is kept and stops being flagged. */
const UNCERTAIN_KEEP_AFTER = 3;
/** Soft quality reasons an evidence check can settle; legacy heuristics have their own deterministic path. */
const REVIEWABLE_REASONS = new Set([
  "stale_related_file_evidence",
  "possibly_outdated",
  "invalidated_by_newer_evidence",
  "review_context_changed",
  "potential_conflict",
  "automatic_promotion_conflict",
  "cloud_merge_conflict",
  "low_confidence",
  "missing_claim"
]);

export interface AutomaticReviewState {
  version: 1;
  lastRunAt?: string | undefined;
  runId?: string | undefined;
  outcome?: "reviewed" | "nothing_to_review" | "failed" | undefined;
  error?: string | undefined;
  counts?: AutomaticReviewCounts | undefined;
}

export interface AutomaticReviewCounts {
  checked: number;
  verified: number;
  retired: number;
  leftForReview: number;
  uncertain: number;
  /** Durable memories kept after repeated uncertain verdicts. */
  kept: number;
  failed: number;
}

export type AutomaticReviewSkip = "disabled" | "investigator_unavailable" | "user_started_only" | "not_due" | "running" | "budget_exhausted";

export interface AutomaticReviewResult {
  skipped?: AutomaticReviewSkip | undefined;
  state?: AutomaticReviewState | undefined;
}

function statePath(root: string): string { return join(stateDirectory(root), "auto-review.json"); }
function lockPath(root: string): string { return join(stateDirectory(root), "auto-review.lock"); }

export function readAutomaticReviewState(root: string): AutomaticReviewState | undefined {
  return readJson<AutomaticReviewState>(statePath(root));
}

/** Why a run would not start now, or undefined when one is due. Cheap; safe on every watcher pass. */
export function automaticReviewSkipReason(root: string, config: ProjectConfig, now = new Date()): AutomaticReviewSkip | undefined {
  if (!automaticReviewPolicy(config).enabled) return "disabled";
  try { assertJobConfigured(config, "review"); } catch { return "investigator_unavailable"; }
  // Claude Code reviews only when a person starts one; the daily run would only be refused.
  if (runsOnlyWhenStarted(jobModel(config, "review"))) return "user_started_only";
  if (lockHeld(root, now)) return "running";
  // Checked before the daily gate is written, so a spent budget delays today's review rather than skipping it.
  if (aiBudgetExhausted() || planPaused(jobModel(config, "review").connectionId, now)) return "budget_exhausted";
  const lastRunAt = Date.parse(readAutomaticReviewState(root)?.lastRunAt ?? "");
  if (Number.isFinite(lastRunAt) && now.getTime() - lastRunAt < DAY_MS) return "not_due";
  return undefined;
}

/**
 * Starts a detached `memory review-auto --if-due` when a run is due. Returns whether one
 * was started; never throws, so a watcher pass is unaffected by it.
 */
export function launchAutomaticReviewIfDue(
  root: string,
  config: ProjectConfig,
  options: { now?: Date | undefined; spawnImpl?: typeof spawn | undefined } = {}
): boolean {
  try {
    if (automaticReviewSkipReason(root, config, options.now) !== undefined) return false;
    const entry = process.argv[1];
    if (!entry) return false;
    const child = (options.spawnImpl ?? spawn)(process.execPath, [...process.execArgv, entry, "memory", "review-auto", "--if-due"], {
      cwd: root, detached: true, stdio: "ignore", windowsHide: true
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * One review run: select flagged memories, ask the investigator about each, apply the
 * allowed verdicts. `ifDue` honours the daily gate; without it the run starts now.
 */
export async function runAutomaticReview(
  root: string,
  config: ProjectConfig,
  options: { ifDue?: boolean | undefined; now?: (() => Date) | undefined; provider?: MemoryReconciliationProvider | undefined } = {}
): Promise<AutomaticReviewResult> {
  const now = options.now ?? (() => new Date());
  const policy = automaticReviewPolicy(config);
  if (options.ifDue) {
    const skipped = automaticReviewSkipReason(root, config, now());
    if (skipped) return { skipped };
  } else if (!options.provider) {
    try { assertJobConfigured(config, "review"); } catch { return { skipped: "investigator_unavailable" }; }
    if (runsOnlyWhenStarted(jobModel(config, "review"))) return { skipped: "user_started_only" };
  }
  if (!acquireLock(root, now())) return { skipped: "running" };
  // Written first, so a run that fails is not retried on every watcher pass.
  const state: AutomaticReviewState = { version: 1, lastRunAt: now().toISOString() };
  atomicJson(statePath(root), state);
  try {
    const store = openConfiguredMemoryStore(root);
    let refs: Array<{ category: MemoryReviewCategory; id: string }>;
    try { store.init(); refs = selectAutoReviewTargets(store, policy.dailyItems, now(), candidateReviewOptions(config)); }
    finally { store.close(); }
    if (refs.length === 0) {
      state.outcome = "nothing_to_review";
      state.counts = emptyCounts();
      return { state };
    }
    const provider = options.provider ?? reviewProviderFor(config, "review");
    const planned = await planMemoryReconciliation(root, {
      memoryRefs: refs,
      limit: null,
      maxRequests: policy.dailyItems,
      tokenBudget: policy.tokenBudget,
      concurrency: 2
    }, { provider, now });
    state.runId = planned.id;
    const allowed = new Set<string>(policy.applyVerdicts);
    // A candidate is not durable yet, so a low-value call on one is cheap to apply and undo.
    const itemIds = planned.items
      .filter((item) => item.state === "planned" && item.verdict !== undefined &&
        (allowed.has(item.verdict) || (item.verdict === "low_value" && item.category === "candidate")))
      .map((item) => item.itemId);
    const run = itemIds.length
      ? await applyMemoryReconciliation(root, { runId: planned.id, itemIds, applyCorrections: false, skipBackup: true }, { now })
      : planned;
    const applied = run.items.filter((item) => item.state === "applied");
    const kept = keepRepeatedlyUncertain(root, run.items, now().toISOString());
    state.outcome = "reviewed";
    state.counts = {
      checked: run.items.length,
      verified: applied.filter((item) => item.verdict === "current").length,
      retired: applied.filter((item) => item.verdict !== "current").length,
      leftForReview: run.items.filter((item) => item.state === "planned" || item.state === "awaiting_correction_approval").length,
      uncertain: run.items.filter((item) => item.verdict === "uncertain").length,
      kept,
      failed: run.items.filter((item) => item.state === "failed").length
    };
    return { state };
  } catch (error) {
    state.outcome = "failed";
    state.error = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    return { state };
  } finally {
    try { atomicJson(statePath(root), state); } finally { releaseLock(root); }
  }
}

export interface AutoReviewTargetOptions {
  /** Also ask about core candidates awaiting corroboration at or above this confidence; omitted, none are asked about. */
  candidateMinConfidence?: number | undefined;
}

/**
 * Candidates are asked about only when automatic promotion would act on the verdict: below
 * the single-source bar an AI "current" cannot promote one, so it is left to expire instead.
 */
function candidateReviewOptions(config: ProjectConfig): AutoReviewTargetOptions {
  const promotion = config.promotion.automatic;
  return promotion.enabled && promotion.coreCandidates !== false
    ? { candidateMinConfidence: promotion.singleSourceMinConfidence ?? 0.9 }
    : {};
}

/**
 * Live flagged memories a review can settle, then (with candidateMinConfidence) core
 * candidates still waiting for corroboration, minus those already settled: currently
 * verified by an AI review, or judged uncertain or left waiting for a person within the
 * recheck window. Flagged durable memories come first; waiting candidates last, oldest first.
 */
export function selectAutoReviewTargets(
  store: MemoryStore,
  limit: number,
  now = new Date(),
  options: AutoReviewTargetOptions = {}
): Array<{ category: MemoryReviewCategory; id: string }> {
  const since = new Date(now.getTime() - RECHECK_AFTER_MS).toISOString();
  const settled = new Set((store.localDb.prepare(
    `select category, memory_id from memory_reconciliation_items
      where created_at >= ? and (verdict = 'uncertain' or state in ('planned', 'awaiting_correction_approval'))`
  ).all(since) as Array<{ category: string; memory_id: string }>).map((row) => `${row.category}\0${row.memory_id}`));
  const live = readMemoryPopulation(store, "self").live
    .filter(({ category, memory }) => !isExactLegacyV1Memory(memory) && !settled.has(`${category}\0${memory.id}`));
  const flagged = live
    .filter(({ category, memory }) => {
      if (memory.qualityStatus !== "needs_review") return false;
      if (!memory.qualityReasons.some((reason) => REVIEWABLE_REASONS.has(reason))) return false;
      const review = currentMemoryReview(store, category, memory);
      return !(review?.action === "verify" && review.current && review.actor === "ai");
    })
    .sort((left, right) =>
      Number(right.category === "promoted") - Number(left.category === "promoted") ||
      right.memory.confidence - left.memory.confidence ||
      right.memory.createdAt.localeCompare(left.memory.createdAt) ||
      left.memory.id.localeCompare(right.memory.id));
  const minConfidence = options.candidateMinConfidence;
  const waiting = minConfidence === undefined ? [] : live
    .flatMap((entry) => entry.category === "candidate" && entry.memory.qualityStatus === "active" &&
      entry.memory.confidence >= minConfidence && awaitsCorroboration(store, entry.memory as MemoryCandidate) ? [entry] : [])
    .sort((left, right) => left.memory.createdAt.localeCompare(right.memory.createdAt) || left.memory.id.localeCompare(right.memory.id));
  return [...flagged, ...waiting]
    .slice(0, limit)
    .map(({ category, memory }) => ({ category, id: memory.id }));
}

/**
 * Keeps durable memories the AI review has now judged uncertain UNCERTAIN_KEEP_AFTER times
 * without them changing: they are already in use, and asking again would not settle them.
 * The keep is a system verify, so new evidence or a related change flags them again.
 */
function keepRepeatedlyUncertain(root: string, items: Array<{ category: MemoryReviewCategory; memoryId: string; memoryVersion: string; verdict?: string | undefined }>, now: string): number {
  const durable = items.filter((item) => item.category === "promoted" && item.verdict === "uncertain");
  if (durable.length === 0) return 0;
  const store = openConfiguredMemoryStore(root);
  try {
    store.init();
    const count = store.localDb.prepare(
      `select count(*) as count from memory_reconciliation_items
        where category = 'promoted' and memory_id = ? and memory_version = ? and verdict = 'uncertain'`
    );
    let kept = 0;
    for (const item of durable) {
      if ((count.get(item.memoryId, item.memoryVersion) as { count: number }).count < UNCERTAIN_KEEP_AFTER) continue;
      const memory = store.readMemory(item.memoryId);
      if (memory?.lifecycleStatus !== "current" || memory.lifecycleGeneration !== item.memoryVersion) continue;
      try {
        resolveMemoryReview(store, {
          memoryId: memory.id,
          category: "promoted",
          action: "verify",
          reason: `Kept after ${UNCERTAIN_KEEP_AFTER} inconclusive AI reviews; flagged again if its evidence changes.`,
          reviewToken: createMemoryReviewContext(store, "promoted", memory).reviewToken,
          now
        }, "system");
        kept += 1;
      } catch { /* Changed since the run; the next one sees it fresh. */ }
    }
    return kept;
  } finally { store.close(); }
}

function emptyCounts(): AutomaticReviewCounts {
  return { checked: 0, verified: 0, retired: 0, leftForReview: 0, uncertain: 0, kept: 0, failed: 0 };
}

function lockHeld(root: string, now: Date): boolean {
  try { return now.getTime() - statSync(lockPath(root)).mtimeMs < LOCK_STALE_MS; } catch { return false; }
}

function acquireLock(root: string, now: Date): boolean {
  mkdirSync(stateDirectory(root), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath(root), "wx");
      try { writeSync(fd, JSON.stringify({ pid: process.pid, at: now.toISOString() })); } finally { closeSync(fd); }
      return true;
    } catch {
      if (lockHeld(root, now)) return false;
      try { unlinkSync(lockPath(root)); } catch { return false; }
    }
  }
  return false;
}

function releaseLock(root: string): void {
  try {
    const held = JSON.parse(readFileSync(lockPath(root), "utf8")) as { pid?: number };
    if (held.pid === process.pid) unlinkSync(lockPath(root));
  } catch { /* Already gone. */ }
}
