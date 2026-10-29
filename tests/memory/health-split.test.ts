// Tests the candidate share of needs-review and quarantined counts in store.getProjectSummary() (src/storage/store.ts) and the published summary from publishRetrieval() (src/retrieval/index.ts).
import { afterEach, expect, it } from "vitest";
import { closeRetrievalReaders, publishRetrieval, readPublishedSummary } from "../../src/retrieval/index.js";
import { openMemoryStore, type MemoryStore } from "../../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const opened: Array<{ root: string; store: MemoryStore }> = [];
afterEach(() => {
  closeRetrievalReaders();
  for (const { root, store } of opened.splice(0)) { store.close(); cleanupTempDir(root); }
});

it("reports how many flagged memories are still candidates, on both read paths", () => {
  const root = makeTempDir();
  const store = openMemoryStore(root); store.init(); opened.push({ root, store });
  store.addSourceWithChunks({ source: { id: "conv", type: "conversation", title: "Notes", origin: "test", rawContent: "body" }, chunks: [{ text: "Notes." }] });
  const candidate = (title: string, dedupeKey: string, quality?: { qualityStatus: "needs_review" | "quarantined"; qualityReasons: string[] }) => store.upsertMemoryCandidate({
    type: "constraint", title, summary: `${title}.`, reason: "Recorded for the test", confidence: 0.9,
    evidence: [{ sourceType: "conversation", sourceId: "conv", locator: "conv:chunk:0" }], relatedFiles: [], dedupeKey
  }, quality);
  candidate("Quarantined candidate", "quarantined", { qualityStatus: "quarantined", qualityReasons: ["missing_evidence"] });
  candidate("Flagged candidate", "flagged", { qualityStatus: "needs_review", qualityReasons: ["possibly_outdated"] });
  const durable = store.promoteMemoryCandidate(candidate("Flagged durable memory", "durable").id, "manual");
  store.updateMemoryQuality("promoted", durable.id, { qualityStatus: "needs_review", qualityReasons: ["possibly_outdated"], lastVerifiedAt: new Date().toISOString() });

  const expected = { needsReview: 2, quarantined: 1, candidates: { needsReview: 1, quarantined: 1 } };
  expect(store.getProjectSummary().memoryHealth).toMatchObject(expected);
  publishRetrieval(store, root, "fixture");
  expect(readPublishedSummary(root).summary.memoryHealth).toMatchObject(expected);
});
