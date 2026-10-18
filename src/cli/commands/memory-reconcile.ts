import {
  applyMemoryReconciliation,
  planMemoryReconciliation,
  readMemoryReconciliationRun,
  replanMemoryReconciliation,
  revertMemoryReconciliation,
  type MemoryReconciliationQueue,
  type MemoryReconciliationQualityFilter,
  type MemoryReconciliationRun
} from "../../memory/reconciliation.js";

export async function runMemoryReconcileCommand(
  args: string[],
  cwd: string,
  stdout: (line: string) => void,
  options: { now?: (() => Date) | undefined } = {}
): Promise<number> {
  const [command, ...rest] = args;
  if (command === "plan") {
    validateFlags(rest, {
      values: ["--queue", "--quality", "--limit", "--max-requests", "--token-budget", "--concurrency"],
      booleans: ["--json"]
    });
    const queue = parseQueue(value(rest, "--queue") ?? "actionable");
    const qualityFilter = parseQualityFilter(value(rest, "--quality"));
    const limitRaw = value(rest, "--limit");
    const limit = limitRaw === undefined ? 20 : limitRaw === "all" ? null : positiveInteger(limitRaw, "--limit");
    const run = await planMemoryReconciliation(cwd, {
      queue,
      qualityFilter,
      limit,
      maxRequests: optionalPositiveInteger(rest, "--max-requests"),
      tokenBudget: optionalPositiveInteger(rest, "--token-budget"),
      concurrency: optionalPositiveInteger(rest, "--concurrency")
    }, { now: options.now });
    outputRun(run, rest.includes("--json"), stdout);
    return 0;
  }
  if (command === "status") {
    validateFlags(rest, { values: ["--run"], booleans: ["--json"] });
    const runId = requiredValue(rest, "--run");
    outputRun(readMemoryReconciliationRun(cwd, runId), rest.includes("--json"), stdout);
    return 0;
  }
  if (command === "replan") {
    validateFlags(rest, {
      values: ["--run"],
      booleans: ["--stale-only", "--retry-failed", "--retry-uncertain", "--json"]
    });
    const run = await replanMemoryReconciliation(cwd, {
      runId: requiredValue(rest, "--run"),
      staleOnly: rest.includes("--stale-only"),
      retryFailed: rest.includes("--retry-failed"),
      retryUncertain: rest.includes("--retry-uncertain")
    }, { now: options.now });
    outputRun(run, rest.includes("--json"), stdout);
    return 0;
  }
  if (command === "apply") {
    validateFlags(rest, {
      values: ["--run"],
      booleans: ["--apply-corrections", "--force-offline", "--json"]
    });
    const run = await applyMemoryReconciliation(cwd, {
      runId: requiredValue(rest, "--run"),
      applyCorrections: rest.includes("--apply-corrections"),
      forceOffline: rest.includes("--force-offline")
    }, { now: options.now });
    outputRun(run, rest.includes("--json"), stdout);
    return 0;
  }
  if (command === "revert") {
    validateFlags(rest, { values: ["--run"], booleans: ["--force-offline", "--json"] });
    const run = await revertMemoryReconciliation(cwd, {
      runId: requiredValue(rest, "--run"),
      forceOffline: rest.includes("--force-offline")
    }, { now: options.now });
    outputRun(run, rest.includes("--json"), stdout);
    return 0;
  }
  throw new Error(
    "Usage: code-butler memory reconcile <plan|status|replan|apply|revert> [options]"
  );
}

function outputRun(run: MemoryReconciliationRun, json: boolean, stdout: (line: string) => void): void {
  if (json) {
    stdout(JSON.stringify(run, null, 2));
    return;
  }
  stdout(`Memory reconciliation ${run.id}: ${run.status}`);
  stdout(`queue=${run.queue} items=${run.items.length} requests=${run.requestCount}/${run.maxRequests} tokens=${run.tokenCount}/${run.tokenBudget}`);
  stdout(Object.entries(run.counts).filter(([, count]) => count > 0).map(([state, count]) => `${state}=${count}`).join(" ") || "items=0");
  if (run.warning) stdout(`warning: ${run.warning}`);
  for (const item of run.items) {
    stdout(`${item.state} ${item.category} ${item.memoryId}${item.verdict ? `: ${item.verdict} (${(item.confidence ?? 0).toFixed(2)})` : ""}`);
    if (item.error) stdout(`  error: ${item.error}`);
  }
}

function validateFlags(args: string[], allowed: { values: string[]; booleans: string[] }): void {
  const valueFlags = new Set(allowed.values);
  const booleanFlags = new Set(allowed.booleans);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) throw new Error(`Unexpected memory reconcile argument: ${token}`);
    if (!valueFlags.has(token) && !booleanFlags.has(token)) throw new Error(`Unknown memory reconcile option: ${token}`);
    if (seen.has(token)) throw new Error(`Duplicate memory reconcile option: ${token}`);
    seen.add(token);
    if (valueFlags.has(token)) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`Missing value for ${token}`);
      index += 1;
    }
  }
}

function value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function requiredValue(args: string[], flag: string): string {
  const found = value(args, flag)?.trim();
  if (!found) throw new Error(`Required option: ${flag}`);
  return found;
}

function optionalPositiveInteger(args: string[], flag: string): number | undefined {
  const raw = value(args, flag);
  return raw === undefined ? undefined : positiveInteger(raw, flag);
}

function positiveInteger(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return Number(raw);
}

function parseQueue(raw: string): MemoryReconciliationQueue {
  if (raw === "actionable" || raw === "legacy" || raw === "all") return raw;
  throw new Error("--queue must be actionable, legacy, or all");
}

function parseQualityFilter(raw: string | undefined): MemoryReconciliationQualityFilter | undefined {
  if (raw === undefined) return undefined;
  if (raw === "needs_review" || raw === "quarantined") return raw;
  throw new Error("--quality must be needs_review or quarantined");
}
