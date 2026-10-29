import { loadProjectConfig } from "../../config.js";
import { countReasons, listExtractionRuns, rejectionKey } from "../../extract/runs.js";
import { resetExtractionCursors } from "../../extract/cursor.js";
import { assessMemoryQuality } from "../../memory/quality.js";
import { openConfiguredMemoryStore } from "../../storage/open-configured-store.js";
import type { ExtractionJob } from "../../storage/store.js";
import { buildConfiguredExtractor, extractionContext, shouldPromote } from "../../sync/service.js";

const USAGE = "Usage: code-butler extraction <report|dry-run|requeue> [--since <ISO date>] [--limit <n>] [--json]";

/**
 * `report` summarises the device-local extraction run log. `dry-run` sends recent
 * sources to the configured extractor and shows what would be kept, without writing.
 * `requeue` queues already-processed sources again, e.g. after an extractor fix; the
 * next sync or watcher pass extracts them (and spends provider calls on them).
 */
export async function runExtractionCommand(args: string[], cwd: string, stdout: (line: string) => void): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "report" && subcommand !== "dry-run" && subcommand !== "requeue") throw new Error(USAGE);
  const options = parseOptions(rest);
  const store = openConfiguredMemoryStore(cwd);
  store.init();
  try {
    if (subcommand === "report") {
      const runs = listExtractionRuns(store.paths.localDatabasePath, options.since);
      const totals = runs.reduce((sum, run) => ({ returned: sum.returned + run.returned, candidates: sum.candidates + run.candidates, merged: sum.merged + (run.merged ?? 0), promoted: sum.promoted + run.promoted, failed: sum.failed + (run.error ? 1 : 0) }), { returned: 0, candidates: 0, merged: 0, promoted: 0, failed: 0 });
      const rejections = countReasons(runs.flatMap(run => Object.entries(run.rejections).flatMap(([reason, count]) => Array<string>(count).fill(reason))));
      if (options.json) { stdout(JSON.stringify({ runs, totals, rejections }, null, 2)); return 0; }
      stdout("Extraction Runs");
      stdout(`runs=${runs.length} failed=${totals.failed} returned=${totals.returned} candidates=${totals.candidates} merged=${totals.merged} promoted=${totals.promoted}`);
      for (const [reason, count] of Object.entries(rejections).sort((a, b) => b[1] - a[1])) stdout(`rejected ${reason}=${count}`);
      for (const run of runs.slice(-options.limit)) {
        stdout(`${run.startedAt} ${run.channel} sources=${run.sourceIds.length} returned=${run.returned} candidates=${run.candidates} merged=${run.merged ?? 0} promoted=${run.promoted}${run.error ? ` error=${run.error}` : ""}`);
      }
      return 0;
    }

    if (subcommand === "requeue") {
      if (!options.since) throw new Error("extraction requeue requires --since <ISO date>");
      const sources = store.db.prepare("select id, type from sources where type in ('commit','conversation') and created_at >= ? order by created_at")
        .all(options.since) as Array<{ id: string; type: "commit" | "conversation" }>;
      let queued = 0;
      for (const source of sources) {
        // Conversation ids carry their adapter as a prefix; other prefixes (manual memories) are not extraction sources.
        const adapter = source.type === "commit" ? "git" : source.id.startsWith("codex:") ? "codex" : source.id.startsWith("claude:") ? "claude" : undefined;
        if (!adapter) continue;
        store.enqueueExtractionEvidence(adapter, source.type, source.id); queued++;
      }
      // Requeueing asks for a full re-read, e.g. after an extractor fix, not just the newest messages.
      resetExtractionCursors(store, sources.filter(source => source.type === "conversation").map(source => source.id));
      if (options.json) { stdout(JSON.stringify({ queued }, null, 2)); return 0; }
      stdout(`Queued ${queued} source(s) since ${options.since} for extraction on the next sync.`);
      return 0;
    }

    const config = loadProjectConfig(cwd);
    const extractor = buildConfiguredExtractor(config);
    if (!extractor) throw new Error("No extractor configured, or its provider credentials are missing from the environment");
    const sources = store.db.prepare("select id, type from sources where type in ('commit','conversation') and created_at >= ? order by created_at desc limit ?")
      .all(options.since ?? "", options.limit) as Array<{ id: string; type: "commit" | "conversation" }>;
    const jobs: ExtractionJob[] = sources.map(source => ({ adapter: source.type === "commit" ? "git" : "claude", sourceType: source.type, sourceId: source.id, enqueuedAt: "", attempts: 0 }));
    const { context } = extractionContext(store, jobs);
    const extracted = await extractor.extract(context);
    const memories = extracted.memories.map(memory => {
      const quality = assessMemoryQuality(store, memory);
      return {
        type: memory.type, confidence: memory.confidence, summary: memory.summary,
        evidence: [...new Set(memory.evidence.map(item => item.sourceType))],
        quality: quality.rejected ? "rejected" : quality.status, reasons: quality.reasons,
        wouldPromote: !quality.rejected && quality.status === "active" && shouldPromote(memory, config)
      };
    });
    if (options.json) { stdout(JSON.stringify({ sources: sources.length, memories, extractorRejected: extracted.rejected }, null, 2)); return 0; }
    stdout(`Extraction dry run: ${sources.length} sources (${context.commits.length} commits, ${context.conversations.length} conversations), nothing written`);
    stdout(`returned=${memories.length + extracted.rejected.length} parsed=${memories.length} extractorRejected=${extracted.rejected.length}`);
    for (const [reason, count] of Object.entries(countReasons(extracted.rejected.map(rejectionKey)))) stdout(`extractor rejected ${reason}=${count}`);
    for (const memory of memories) {
      stdout(`- [${memory.type} ${memory.confidence.toFixed(2)} ${memory.quality}${memory.wouldPromote ? " promote" : ""}] ${memory.summary}`);
      stdout(`    evidence=${memory.evidence.join("+") || "none"}${memory.reasons.length ? ` reasons=${memory.reasons.join(",")}` : ""}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

function parseOptions(args: string[]): { since?: string | undefined; limit: number; json: boolean } {
  let since: string | undefined, limit = 10, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") json = true;
    else if (arg === "--since" && args[i + 1]) {
      since = args[++i]!;
      if (Number.isNaN(Date.parse(since))) throw new Error(`Invalid --since date: ${since}`);
    } else if (arg === "--limit" && args[i + 1]) {
      limit = Number(args[++i]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("--limit must be an integer from 1 to 50");
    } else throw new Error(`Unknown extraction option: ${arg}\n${USAGE}`);
  }
  return { since, limit, json };
}
