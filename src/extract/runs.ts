import { randomUUID } from "node:crypto";
import { openLocalMemoryDatabase } from "../storage/local-memory.js";

/**
 * One extraction batch and what became of it. Kept device-locally because a rejected
 * model output is diagnostic evidence about this device's extractor, not project memory.
 */
export interface ExtractionRun {
  id: string;
  startedAt: string;
  finishedAt: string;
  channel: "sync" | "watch" | "dry-run";
  provider?: string | undefined;
  model?: string | undefined;
  sourceIds: string[];
  /** Memories the model returned, before any validation. */
  returned: number;
  candidates: number;
  promoted: number;
  /** Rejection reason → count; extractor-format reasons are bare, quality reasons are `quality:` prefixed. */
  rejections: Record<string, number>;
  error?: string | undefined;
}

/** `reason:detail` when the extractor said which field failed. */
export function rejectionKey(item: { reason: string; detail?: string | undefined }): string {
  return item.detail ? `${item.reason}:${item.detail}` : item.reason;
}

export function countReasons(reasons: Iterable<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const reason of reasons) counts[reason] = (counts[reason] ?? 0) + 1;
  return counts;
}

/** Diagnostics never fail a sync: a run log that cannot be written is skipped. */
export function recordExtractionRun(localDatabasePath: string, run: Omit<ExtractionRun, "id">): void {
  try {
    const db = openLocalMemoryDatabase(localDatabasePath);
    try {
      db.prepare(`insert into extraction_runs(id,started_at,finished_at,channel,provider,model,source_ids_json,returned,candidates,promoted,rejections_json,error)
        values(?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), run.startedAt, run.finishedAt, run.channel, run.provider ?? null, run.model ?? null,
        JSON.stringify(run.sourceIds), run.returned, run.candidates, run.promoted, JSON.stringify(run.rejections), run.error ?? null);
    } finally { db.close(); }
  } catch { /* Diagnostic only. */ }
}

export function listExtractionRuns(localDatabasePath: string, since?: string): ExtractionRun[] {
  const db = openLocalMemoryDatabase(localDatabasePath);
  try {
    const rows = db.prepare("select * from extraction_runs where started_at >= ? order by started_at").all(since ?? "") as Array<Record<string, string | number | null>>;
    return rows.map(row => ({
      id: String(row.id), startedAt: String(row.started_at), finishedAt: String(row.finished_at),
      channel: row.channel as ExtractionRun["channel"],
      ...(row.provider ? { provider: String(row.provider) } : {}), ...(row.model ? { model: String(row.model) } : {}),
      sourceIds: JSON.parse(String(row.source_ids_json)) as string[],
      returned: Number(row.returned), candidates: Number(row.candidates), promoted: Number(row.promoted),
      rejections: JSON.parse(String(row.rejections_json)) as Record<string, number>,
      ...(row.error ? { error: String(row.error) } : {})
    }));
  } finally { db.close(); }
}
