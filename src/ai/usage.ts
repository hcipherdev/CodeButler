import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { globalConfigDir, loadAiBudget } from "../config.js";
import type { AiJob } from "../types.js";

export type AiTrigger = "background" | "user";
export interface AiUsageEntry {
  at: string;
  job: AiJob;
  trigger: AiTrigger;
  connectionId?: string | undefined;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number | undefined;
}
export interface AiUsageTotals { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number; calls: number }
export interface AiUsageSummary {
  day: string;
  background: AiUsageTotals;
  user: AiUsageTotals;
  byJob: Partial<Record<AiJob, AiUsageTotals>>;
  last7Days: AiUsageTotals;
  backgroundDailyTokens: number | null;
}

export const AI_BUDGET_REASON = "Daily AI budget reached; background AI work resumes tomorrow";
export const AI_PLAN_LIMIT_REASON = "ChatGPT plan usage limit reached; background AI work resumes later";
const RETAIN_DAYS = 90;
/** OpenAI says not to guess when a plan limit resets, so background work simply checks again later. */
const PLAN_PAUSE_MS = 30 * 60_000;

/** Work that waits instead of failing: queued evidence stays queued and nothing is recorded as an error. */
export class AiPausedError extends Error {}

/** Background work never prompts anyone, so it is the work a daily cap protects. */
export class AiBudgetExceededError extends AiPausedError {
  constructor() { super(AI_BUDGET_REASON); this.name = "AiBudgetExceededError"; }
}

/** The person's ChatGPT plan, or this app's share of it, is used up for now. */
export class AiPlanLimitError extends AiPausedError {
  constructor(message = AI_PLAN_LIMIT_REASON) { super(message); this.name = "AiPlanLimitError"; }
}

export function isAiPauseReason(reason: string | undefined): boolean {
  return reason === AI_BUDGET_REASON || reason === AI_PLAN_LIMIT_REASON;
}

const triggerContext = new AsyncLocalStorage<AiTrigger>();

/** Marks model calls made inside `work` as background or user-started. */
export function withAiTrigger<T>(trigger: AiTrigger, work: () => T): T {
  return triggerContext.run(trigger, work);
}

/** Watcher passes, and the review they launch, carry the watcher token; everything else was asked for. */
export function currentAiTrigger(): AiTrigger {
  return triggerContext.getStore() ?? (process.env.CODE_BUTLER_WATCH_TOKEN ? "background" : "user");
}

/** Only a trigger set with withAiTrigger; the watch-token fallback above does not count. */
export function explicitAiTrigger(): AiTrigger | undefined {
  return triggerContext.getStore();
}

/** CODE_BUTLER_AI_USAGE_DIR lets the test suite keep its calls out of the real ledger. */
export function usageDirectory(): string { return process.env.CODE_BUTLER_AI_USAGE_DIR?.trim() || join(globalConfigDir(), "usage"); }

/** The local calendar day, so "today" matches the person's day rather than UTC. */
export function usageDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Appends one line; appends from concurrent processes do not interleave at this size. Never stores prompts. */
export function recordAiUsage(entry: AiUsageEntry, directory = usageDirectory()): void {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `${usageDay(new Date(entry.at))}.jsonl`);
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    pruneUsage(directory);
  } catch { /* Usage accounting must never fail the model call it describes. */ }
}

let lastPrunedDay = "";
function pruneUsage(directory: string, now = new Date()): void {
  const today = usageDay(now);
  if (lastPrunedDay === today) return;
  lastPrunedDay = today;
  const cutoff = usageDay(new Date(now.getTime() - RETAIN_DAYS * 86_400_000));
  for (const name of readdirSync(directory)) {
    const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (match && match[1]! < cutoff) rmSync(join(directory, name), { force: true });
  }
}

export function readAiUsage(day: string, directory = usageDirectory()): AiUsageEntry[] {
  let text: string;
  try { text = readFileSync(join(directory, `${day}.jsonl`), "utf8"); } catch { return []; }
  const entries: AiUsageEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as AiUsageEntry;
      if (typeof value.inputTokens === "number" && typeof value.outputTokens === "number") entries.push(value);
    } catch { /* Skip a line cut short by a crash. */ }
  }
  return entries;
}

function totals(entries: AiUsageEntry[]): AiUsageTotals {
  const result: AiUsageTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, calls: 0 };
  for (const entry of entries) {
    result.inputTokens += entry.inputTokens;
    result.outputTokens += entry.outputTokens;
    result.costUsd += entry.costUsd ?? 0;
    result.calls += 1;
  }
  result.totalTokens = result.inputTokens + result.outputTokens;
  return result;
}

export function backgroundTokensToday(now = new Date(), directory = usageDirectory()): number {
  return totals(readAiUsage(usageDay(now), directory).filter(entry => entry.trigger === "background")).totalTokens;
}

export function aiUsageSummary(now = new Date(), directory = usageDirectory(), limit = loadAiBudget()): AiUsageSummary {
  const today = readAiUsage(usageDay(now), directory);
  const byJob: AiUsageSummary["byJob"] = {};
  for (const job of new Set(today.map(entry => entry.job))) byJob[job] = totals(today.filter(entry => entry.job === job));
  const week: AiUsageEntry[] = [];
  for (let offset = 0; offset < 7; offset += 1) week.push(...readAiUsage(usageDay(new Date(now.getTime() - offset * 86_400_000)), directory));
  return {
    day: usageDay(now),
    background: totals(today.filter(entry => entry.trigger === "background")),
    user: totals(today.filter(entry => entry.trigger === "user")),
    byJob,
    last7Days: totals(week),
    backgroundDailyTokens: limit
  };
}

/** True when background work has used today's allowance; a null limit means no cap. */
export function aiBudgetExhausted(limit = loadAiBudget(), now = new Date(), directory = usageDirectory()): boolean {
  return limit !== null && backgroundTokensToday(now, directory) >= limit;
}

type PausedModel = { connectionId?: string | undefined } | undefined;

function planPauseFile(directory: string): string { return join(directory, "plan-pauses.json"); }

function readPlanPauses(directory: string): Record<string, string> {
  try {
    const value = JSON.parse(readFileSync(planPauseFile(directory), "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, string> : {};
  } catch { return {}; }
}

/** Background calls on this connection wait a while after the plan reported its limit. */
export function recordPlanPause(connectionId: string, now = new Date(), directory = usageDirectory()): void {
  try {
    const pauses = readPlanPauses(directory);
    for (const [id, until] of Object.entries(pauses)) if (!(Date.parse(until) > now.getTime())) delete pauses[id];
    pauses[connectionId] = new Date(now.getTime() + PLAN_PAUSE_MS).toISOString();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(planPauseFile(directory), `${JSON.stringify(pauses)}\n`, { mode: 0o600 });
  } catch { /* A missed pause only means one more refused call. */ }
}

export function planPaused(connectionId: string | undefined, now = new Date(), directory = usageDirectory()): boolean {
  if (!connectionId) return false;
  const until = readPlanPauses(directory)[connectionId];
  return until !== undefined && Date.parse(until) > now.getTime();
}

/** Why background work on this model should wait, or undefined when it may run. */
export function backgroundPauseReason(model?: PausedModel): string | undefined {
  if (currentAiTrigger() !== "background") return undefined;
  if (aiBudgetExhausted()) return AI_BUDGET_REASON;
  if (planPaused(model?.connectionId)) return AI_PLAN_LIMIT_REASON;
  return undefined;
}

/** Background work checks this before each model batch, so queued work waits instead of failing. */
export function backgroundBudgetPaused(model?: PausedModel): boolean {
  return backgroundPauseReason(model) !== undefined;
}

/** Throws before a background call once today's allowance or the plan is used up; user-started calls always run. */
export function assertAiBudget(trigger = currentAiTrigger(), model?: PausedModel): void {
  if (trigger !== "background") return;
  if (aiBudgetExhausted()) throw new AiBudgetExceededError();
  if (planPaused(model?.connectionId)) throw new AiPlanLimitError();
}
