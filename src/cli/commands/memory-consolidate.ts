import { projectOperation } from "../../cloud/client.js";
import { loadProjectConfig } from "../../config.js";
import {
  applyConsolidation,
  listConsolidationRuns,
  planConsolidation,
  undoConsolidation,
  type ConsolidationRun
} from "../../memory/consolidation.js";
import { reviewProviderFor, type MemoryReconciliationProvider } from "../../memory/reconciliation-provider.js";
import { openConfiguredMemoryStore } from "../../storage/open-configured-store.js";

const USAGE = [
  "Usage: code-butler memory consolidate --plan [--limit <clusters>|all] [--max-requests <n>] [--concurrency <n>] [--json]",
  "       code-butler memory consolidate --apply [--run <id>] [--json]",
  "       code-butler memory consolidate --undo --run <id> [--json]",
  "       code-butler memory consolidate --history [--json]"
].join("\n");

/**
 * `--plan` clusters the live memories and asks the investigator model which ones repeat
 * or outdate each other, writing only a device-local plan. `--apply` merges each group
 * into one memory and retires the rest; `--undo` reverses an applied run.
 */
export async function runMemoryConsolidateCommand(
  args: string[],
  cwd: string,
  stdout: (line: string) => void,
  options: { now?: (() => Date) | undefined; provider?: MemoryReconciliationProvider | undefined } = {}
): Promise<number> {
  const flags = parseFlags(args);
  const json = flags.has("--json");
  const modes = ["--plan", "--apply", "--undo", "--history"].filter((mode) => flags.has(mode));
  if (modes.length !== 1) throw new Error(USAGE);

  if (flags.has("--history")) {
    const store = openConfiguredMemoryStore(cwd);
    store.init();
    try {
      const runs = listConsolidationRuns(store);
      if (json) stdout(JSON.stringify({ runs }, null, 2));
      else if (runs.length === 0) stdout("No consolidation runs.");
      else for (const run of runs) printRun(run, stdout);
      return 0;
    } finally { store.close(); }
  }

  if (flags.has("--plan")) {
    const config = loadProjectConfig(cwd);
    const provider = options.provider ?? reviewProviderFor(config, "consolidation");
    const limitRaw = flags.get("--limit");
    const store = openConfiguredMemoryStore(cwd);
    store.init();
    try {
      const run = await planConsolidation(store, {
        provider,
        limit: limitRaw === undefined ? undefined : limitRaw === "all" ? null : positiveInteger(limitRaw, "--limit"),
        maxRequests: optionalPositiveInteger(flags, "--max-requests"),
        concurrency: optionalPositiveInteger(flags, "--concurrency"),
        confidenceThreshold: config.promotion.confidenceThreshold,
        now: options.now,
        ...(json ? {} : { onProgress: (done: number, total: number) => { if (done === total || done % 25 === 0) stdout(`clusters reviewed ${done}/${total}`); } })
      });
      if (json) stdout(JSON.stringify(run, null, 2));
      else { printRun(run, stdout); stdout(`Nothing changed yet. Apply with: code-butler memory consolidate --apply --run ${run.id}`); }
      return 0;
    } finally { store.close(); }
  }

  const runId = flags.get("--run");
  if (flags.has("--undo") && !runId) throw new Error(USAGE);
  const run = await projectOperation(cwd, () => {
    const store = openConfiguredMemoryStore(cwd);
    store.init();
    try {
      return flags.has("--apply")
        ? applyConsolidation(store, loadProjectConfig(cwd), { runId, now: options.now })
        : undoConsolidation(store, { runId: runId!, now: options.now });
    } finally { store.close(); }
  }, { name: flags.has("--apply") ? "Apply memory consolidation" : "Undo memory consolidation", waitMs: 0 });
  if (json) stdout(JSON.stringify(run, null, 2));
  else {
    printRun(run, stdout);
    if (flags.has("--undo") && run.appliedAt) {
      stdout(`Promotions that followed the run are kept; reverse them with: code-butler memory promotions --undo --since ${run.appliedAt}`);
    }
  }
  return 0;
}

function printRun(run: ConsolidationRun, stdout: (line: string) => void): void {
  const summary = run.summary;
  stdout(`Consolidation ${run.id} ${run.status} (${run.createdAt}${run.model ? `, ${run.model}` : ""})`);
  stdout(`  population=${summary.population} clusters=${summary.components} requests=${summary.requests} failed=${summary.failedRequests}${summary.truncated ? " truncated" : ""}`);
  stdout(`  groups=${summary.groups} retire=${summary.membersToRetire} gaining-sources=${summary.canonicalsGainingSources} est-promotions=${summary.estimatedPromotions} invalidations=${summary.invalidations}`);
  const skipped = Object.entries(summary.skipped);
  if (skipped.length) stdout(`  skipped ${skipped.map(([reason, count]) => `${reason}=${count}`).join(" ")}`);
  if (summary.applied) {
    const applied = summary.applied;
    stdout(`  applied groups=${applied.groups} retired=${applied.retired} promoted=${applied.promoted} superseded=${applied.superseded}`);
    const outcomes = Object.entries(applied.invalidations);
    if (outcomes.length) stdout(`  invalidations ${outcomes.map(([outcome, count]) => `${outcome}=${count}`).join(" ")}`);
    const notApplied = Object.entries(applied.skipped);
    if (notApplied.length) stdout(`  not applied ${notApplied.map(([reason, count]) => `${reason}=${count}`).join(" ")}`);
  }
  if (summary.undone) {
    stdout(`  undone groups=${summary.undone.groups} restored=${summary.undone.restored} invalidations=${summary.undone.invalidations} changed-since=${summary.undone.changedSince}`);
  }
}

const VALUE_FLAGS = new Set(["--limit", "--max-requests", "--concurrency", "--run"]);
const BOOLEAN_FLAGS = new Set(["--plan", "--apply", "--undo", "--history", "--json"]);

function parseFlags(args: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (flags.has(token)) throw new Error(`Duplicate memory consolidate option: ${token}`);
    if (BOOLEAN_FLAGS.has(token)) { flags.set(token, ""); continue; }
    if (!VALUE_FLAGS.has(token)) throw new Error(`Unknown memory consolidate option: ${token}\n${USAGE}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    flags.set(token, value);
    index += 1;
  }
  return flags;
}

function optionalPositiveInteger(flags: Map<string, string>, flag: string): number | undefined {
  const raw = flags.get(flag);
  return raw === undefined ? undefined : positiveInteger(raw, flag);
}

function positiveInteger(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
  return value;
}
