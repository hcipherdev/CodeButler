// Tests inheritedCandidateVerification() in src/memory/review-state.ts through assessMemoryQuality() and resolveMemoryQuality(): a durable memory keeps its candidate's verification until something it was checked against changes.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveMemoryQuality } from "../../src/memory/quality-cache.js";
import { assessMemoryQuality } from "../../src/memory/quality.js";
import { resolveMemoryReview } from "../../src/memory/review.js";
import { createMemoryReviewContext } from "../../src/memory/review-state.js";
import { openConfiguredMemoryStore } from "../../src/storage/open-configured-store.js";
import type { MemoryStore } from "../../src/storage/store.js";
import type { CommitRecord } from "../../src/types.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const FILE = "pages/index.tsx";
const roots: string[] = [];
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.CODE_BUTLER_HOME;
  const home = makeTempDir(); roots.push(home);
  process.env.CODE_BUTLER_HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.CODE_BUTLER_HOME;
  else process.env.CODE_BUTLER_HOME = originalHome;
  roots.splice(0).forEach(cleanupTempDir);
});

function withProject<T>(work: (store: MemoryStore) => T): T {
  const root = makeTempDir(); roots.push(root);
  mkdirSync(join(root, ".code-butler"), { recursive: true });
  writeFileSync(join(root, ".code-butler", "config.json"), JSON.stringify({
    sources: { git: { enabled: false }, codex: { enabled: false }, claude: { enabled: false } }
  }));
  const store = openConfiguredMemoryStore(root); store.init();
  try { return work(store); } finally { store.close(); }
}

function commit(hash: string, authoredAt: string, removed: string, added: string): CommitRecord {
  return {
    hash, authorName: "T", authorEmail: "t@example.com", authoredAt, message: `Commit ${hash}`, changedFiles: [FILE],
    diffSummary: [`diff --git a/${FILE} b/${FILE}`, `--- a/${FILE}`, `+++ b/${FILE}`, "@@ -1,3 +1,3 @@", " <main>", `-${removed}`, `+${added}`, " </main>"].join("\n")
  };
}

/** A candidate whose related file changed after its evidence, verified, then made durable. */
function verifiedThenPromoted(store: MemoryStore) {
  store.addCommit(commit("c-evidence", "2026-10-01T00:00:00.000Z", "<a>Get Started</a>", "<a>Download Beta</a>"));
  const created = store.upsertMemoryCandidate({
    type: "decision", title: "Hero CTA reads 'Download Beta'", summary: "The hero button label is 'Download Beta'.",
    reason: "Recorded during the homepage work.", confidence: 0.95,
    evidence: [{ sourceType: "commit", sourceId: "c-evidence" }], relatedFiles: [FILE], dedupeKey: "hero-cta"
  });
  store.addCommit(commit("c-label", "2026-10-05T00:00:00.000Z", "<a>Download beta</a>", "<a>Download Beta</a>"));
  const candidate = store.readMemoryCandidate(created.id)!;
  expect(assessMemoryQuality(store, candidate, { ignoreReviewResolution: true }).reasons).toContain("stale_related_file_evidence");
  resolveMemoryReview(store, {
    memoryId: candidate.id, category: "candidate", action: "verify", reason: "Label still reads Download Beta.",
    reviewToken: createMemoryReviewContext(store, "candidate", candidate).reviewToken
  }, "desktop");
  return store.promoteMemoryCandidate(candidate.id, "auto", { layer: "core" });
}

describe("verification carried from candidate to durable memory", () => {
  it("does not flag a durable memory again for what its candidate's verification already covered", () => {
    withProject((store) => {
      const durable = verifiedThenPromoted(store);
      expect(assessMemoryQuality(store, durable).reasons).not.toContain("stale_related_file_evidence");
      expect(resolveMemoryQuality(store, "promoted", durable).qualityStatus).toBe("active");
    });
  });

  it("flags it again once a later commit touches what the memory names", () => {
    withProject((store) => {
      const durable = verifiedThenPromoted(store);
      store.addCommit(commit("c-rename", "2026-10-07T00:00:00.000Z", "<a>Download Beta</a>", "<a>Get the app</a>"));
      expect(assessMemoryQuality(store, durable).reasons).toContain("stale_related_file_evidence");
      expect(resolveMemoryQuality(store, "promoted", durable).qualityReasons).toContain("stale_related_file_evidence");
    });
  });

  it("does not carry a verification over to a durable memory that states a different claim", () => {
    withProject((store) => {
      const durable = verifiedThenPromoted(store);
      store.db.prepare("update memories set summary = ? where id = ?").run("The hero button says Get the app.", durable.id);
      const changed = store.readMemory(durable.id)!;
      expect(assessMemoryQuality(store, changed).reasons).toContain("stale_related_file_evidence");
    });
  });
});
