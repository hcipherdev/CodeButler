// Tests noteMemoryUsage() (including through the MCP find_memories handler), ingestMemoryUsage(), recordMemoryAttention() and lastAttentionDay() in src/memory/usage.ts, and how memory_usage rows sync (deleteNonCoreRows(), mergeCore(), privacy export/import).
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mergeCore } from "../../src/cloud/merge.js";
import { createProjectMemoryToolHandlers } from "../../src/mcp/tools.js";
import { deleteNonCoreRows } from "../../src/cloud/snapshot.js";
import { stateDirectory } from "../../src/cloud/state.js";
import { ingestMemoryUsage, lastAttentionDay, noteMemoryUsage, recordMemoryAttention, usageDay } from "../../src/memory/usage.js";
import { exportPrivacy, importPrivacy } from "../../src/privacy/service.js";
import { openMemoryStore, type MemoryStore } from "../../src/storage/store.js";
import { withTransaction } from "../../src/storage/transactions.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const DEVICE = "6d1f3a2b-4c5e-4f60-8a7b-9c0d1e2f3a4b";
const roots: string[] = [], stores: MemoryStore[] = [];

beforeEach(() => { const home = makeTempDir(); roots.push(home); vi.stubEnv("CODE_BUTLER_HOME", home); });
afterEach(() => {
  vi.unstubAllEnvs();
  stores.splice(0).forEach((s) => s.close());
  roots.splice(0).forEach(cleanupTempDir);
});

function store(): MemoryStore {
  const root = makeTempDir(); roots.push(root);
  const s = openMemoryStore(root, { deviceLayer: () => `device:${DEVICE}` });
  s.init(); stores.push(s); return s;
}

function clone(source: MemoryStore): MemoryStore {
  const target = store(), outputPath = join(source.paths.rootDir, `copy-${randomUUID()}.json`);
  exportPrivacy(source, { outputPath });
  importPrivacy(target, { inputPath: outputPath });
  return target;
}

const rows = (s: MemoryStore) => s.db.prepare("select memory_id, layer, kind, day from memory_usage order by memory_id, kind, day").all();
const usageLines = (root: string) => readFileSync(join(stateDirectory(root), "memory-usage.jsonl"), "utf8").trim().split("\n");

describe("memory usage", () => {
  it("notes a candidate once a day on the read path and ingests it into one row", () => {
    const s = store(), root = s.paths.rootDir, id = `candidate-${randomUUID()}`;
    const ref = { category: "candidate" as const, id, layer: "core" };
    noteMemoryUsage(root, [ref, ref]);
    noteMemoryUsage(root, [ref]);
    expect(usageLines(root)).toHaveLength(1);

    expect(ingestMemoryUsage(s, root)).toBe(1);
    expect(lastAttentionDay(s, "candidate", id)).toBe(usageDay());
    expect(ingestMemoryUsage(s, root)).toBe(0);

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    noteMemoryUsage(root, [ref], tomorrow);
    expect(ingestMemoryUsage(s, root)).toBe(1);
    expect(lastAttentionDay(s, "candidate", id)).toBe(usageDay(tomorrow));
  });

  it("skips torn lines and picks up a file an interrupted ingest left behind", () => {
    const s = store(), root = s.paths.rootDir;
    noteMemoryUsage(root, [{ category: "candidate", id: "fresh", layer: "core" }]);
    const line = (id: string) => JSON.stringify({ category: "candidate", id, layer: "core", day: "2026-10-01" });
    writeFileSync(join(stateDirectory(root), "memory-usage.123-1.ingesting"), `${line("left-behind")}\n{"category":"cand`);
    expect(ingestMemoryUsage(s, root)).toBe(2);
    expect(readdirSync(stateDirectory(root)).filter((name) => name.startsWith("memory-usage"))).toEqual([]);
  });

  it("syncs shared usage and keeps device usage on this device", () => {
    const s = store();
    recordMemoryAttention(s, { category: "candidate", id: "shared", layer: "core" }, "used", "2026-10-01");
    recordMemoryAttention(s, { category: "candidate", id: "mine", layer: `device:${DEVICE}` }, "correction_proposed", "2026-10-02");
    recordMemoryAttention(s, { category: "candidate", id: "shared", layer: "core" }, "used", "2026-10-01");
    expect(rows(s)).toHaveLength(2);

    const exported = clone(s);
    expect(rows(exported)).toEqual(rows(s));
    deleteNonCoreRows(exported.db);
    expect(rows(exported)).toEqual([{ memory_id: "shared", layer: "core", kind: "used", day: "2026-10-01" }]);
  });

  it("counts a candidate an agent is handed by find_memories as used", async () => {
    const s = store(), root = s.paths.rootDir;
    s.addSourceWithChunks({ source: { id: "conv", type: "conversation", title: "Notes", origin: "test", rawContent: "body" }, chunks: [{ text: "Notes." }] });
    const candidate = s.upsertMemoryCandidate({
      type: "decision", title: "Resumable uploads", summary: "Uploads resume from the last confirmed block.", reason: "Recorded for the test", confidence: 0.9,
      evidence: [{ sourceType: "conversation", sourceId: "conv", locator: "conv:chunk:0" }], relatedFiles: [], dedupeKey: "resumable"
    });
    const result = await createProjectMemoryToolHandlers(s).find_memories({ query: "resumable uploads" });
    expect(result.results.map((memory) => memory.id)).toContain(candidate.id);
    expect(usageLines(root).map((line) => JSON.parse(line).id)).toEqual([candidate.id]);
    ingestMemoryUsage(s, root);
    expect(lastAttentionDay(s, "candidate", candidate.id)).toBe(usageDay());
  });

  it("merges another device's usage of a shared candidate", () => {
    const ancestor = store();
    const local = clone(ancestor), remote = clone(ancestor);
    recordMemoryAttention(remote, { category: "candidate", id: "shared", layer: "core" }, "used", "2026-10-05");
    withTransaction(local.db, () => mergeCore(local.db, remote.db, ancestor.db));
    expect(lastAttentionDay(local, "candidate", "shared")).toBe("2026-10-05");
  });
});
