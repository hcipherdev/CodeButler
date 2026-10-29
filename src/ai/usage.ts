import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
const RETAIN_DAYS = 90;

/** Background work never prompts anyone, so it is the work a daily cap protects. */
export class AiBudgetExceededError extends Error {
  constructor() { super(AI_BUDGET_REASON); this.name = "AiBudgetExceededError"; }
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

/** Background work checks this before each model batch, so queued work waits for tomorrow instead of failing. */
export function backgroundBudgetPaused(): boolean {
  return currentAiTrigger() === "background" && aiBudgetExhausted();
}

/** Throws before a background call once today's allowance is used; user-started calls always run. */
export function assertAiBudget(trigger = currentAiTrigger()): void {
  if (trigger === "background" && aiBudgetExhausted()) throw new AiBudgetExceededError();
}
