// Tests the extraction run log (recordExtractionRun/listExtractionRuns in src/extract/runs.ts) written by syncProjectMemory() in src/sync/service.ts, and the `extraction report` command in src/cli/commands/extraction.ts.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureProjectConfig, loadProjectConfig } from "../../src/config.js";
import { listExtractionRuns } from "../../src/extract/runs.js";
import { runExtractionCommand } from "../../src/cli/commands/extraction.js";
import { openConfiguredMemoryStore } from "../../src/storage/open-configured-store.js";
import { syncProjectMemory } from "../../src/sync/service.js";
import type { ExtractorProvider } from "../../src/types.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanupTempDir(root); });

function project() {
  const directory = makeTempDir(); roots.push(directory);
  const root = join(directory, "project"); mkdirSync(root);
  ensureProjectConfig(root);
  const config = loadProjectConfig(root);
  config.sources.git.enabled = false; config.sources.codex.enabled = false; config.sources.claude.enabled = false;
  const store = openConfiguredMemoryStore(root); store.init();
  const commit = { hash: "extraction-run-commit", authorName: "Test", authorEmail: "test@example.com", authoredAt: "2026-10-08T10:00:00Z",
    message: "Switch uploads to batched quota checks", changedFiles: ["src/cloud/opaque-store.ts"], diffSummary: "+ putObjects" };
  store.addCommit(commit);
  store.enqueueExtractionEvidence("git", "commit", commit.hash);
  return { root, config, store, commit };
}

describe("extraction run log", () => {
  it("records what the model returned and why each rejected memory was dropped", async () => {
    const p = project();
    const extractor: ExtractorProvider = { async extract() {
      return {
        memories: [
          { type: "decision", title: "Batch quota checks", summary: "Check storage quota once per upload batch because per-object sums made uploads quadratic.",
            reason: "Per-object usage() scans dominated upload time.", confidence: 0.9, dedupeKey: "batch-quota", relatedFiles: [],
            evidence: [{ sourceType: "commit", sourceId: p.commit.hash }] },
          { type: "decision", title: "Unsupported", summary: "A claim the model could not tie to any evidence at all.",
            reason: "None.", confidence: 0.9, dedupeKey: "unsupported", relatedFiles: [], evidence: [] }
        ],
        rejected: [{ index: 2, reason: "invalid_memory_record" }]
      };
    } };
    try {
      const result = await syncProjectMemory(p.store, p.config, { extractorProvider: extractor });
      expect(result.memories.candidates).toBe(1);
      const [run] = listExtractionRuns(p.store.paths.localDatabasePath);
      expect(run).toMatchObject({ channel: "sync", sourceIds: [p.commit.hash], returned: 3, candidates: 1 });
      expect(run!.rejections).toMatchObject({ invalid_memory_record: 1, "quality:missing_evidence": 1 });
      expect(run!.error).toBeUndefined();
    } finally { p.store.close(); }
  });

  it("records a failed batch with its error", async () => {
    const p = project();
    const extractor: ExtractorProvider = { async extract() { throw new Error("provider unavailable"); } };
    try {
      await syncProjectMemory(p.store, p.config, { extractorProvider: extractor });
      const [run] = listExtractionRuns(p.store.paths.localDatabasePath);
      expect(run).toMatchObject({ returned: 0, candidates: 0, error: "provider unavailable" });
    } finally { p.store.close(); }
  });

  it("summarises runs and rejection reasons in `extraction report`", async () => {
    const p = project();
    const extractor: ExtractorProvider = { async extract() { return { memories: [], rejected: [{ index: 0, reason: "invalid_memory_record" }] }; } };
    try { await syncProjectMemory(p.store, p.config, { extractorProvider: extractor }); } finally { p.store.close(); }
    const lines: string[] = [];
    expect(await runExtractionCommand(["report", "--json"], p.root, line => lines.push(line))).toBe(0);
    const report = JSON.parse(lines.join("\n")) as { totals: { returned: number }; rejections: Record<string, number> };
    expect(report.totals.returned).toBe(1);
    expect(report.rejections).toEqual({ invalid_memory_record: 1 });
  });

  it("requeues already-processed sources for another extraction pass", async () => {
    const p = project();
    const extractor: ExtractorProvider = { async extract() { return { memories: [], rejected: [] }; } };
    try {
      await syncProjectMemory(p.store, p.config, { extractorProvider: extractor });
      expect(p.store.getExtractionStatus().pending).toBe(0);
    } finally { p.store.close(); }
    const lines: string[] = [];
    expect(await runExtractionCommand(["requeue", "--since", "2000-01-01", "--json"], p.root, line => lines.push(line))).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toEqual({ queued: 1 });
    const store = openConfiguredMemoryStore(p.root); store.init();
    try { expect(store.getExtractionStatus().pending).toBe(1); } finally { store.close(); }
    await expect(runExtractionCommand(["requeue"], p.root, () => {})).rejects.toThrow("requires --since");
  });

  it("rejects malformed options", async () => {
    const p = project(); p.store.close();
    await expect(runExtractionCommand(["report", "--since", "not-a-date"], p.root, () => {})).rejects.toThrow("Invalid --since date");
    await expect(runExtractionCommand(["unknown"], p.root, () => {})).rejects.toThrow("Usage: code-butler extraction");
  });
});
