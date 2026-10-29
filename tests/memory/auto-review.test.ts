// Tests runAutomaticReview(), selectAutoReviewTargets(), automaticReviewSkipReason() and launchAutomaticReviewIfDue() in src/memory/auto-review.ts with an injected investigator.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadProjectConfig, setRemoteModelConsent } from "../../src/config.js";
import {
  automaticReviewSkipReason,
  launchAutomaticReviewIfDue,
  readAutomaticReviewState,
  runAutomaticReview,
  selectAutoReviewTargets
} from "../../src/memory/auto-review.js";
import { planAutomaticPromotions } from "../../src/memory/automatic-promotion.js";
import { revertMemoryReconciliation } from "../../src/memory/reconciliation.js";
import type { MemoryReconciliationProvider } from "../../src/memory/reconciliation-provider.js";
import { resolveMemoryReview } from "../../src/memory/review.js";
import { openConfiguredMemoryStore } from "../../src/storage/open-configured-store.js";
import type { MemoryStore } from "../../src/storage/store.js";
import type { MemoryCandidate, ProjectConfig } from "../../src/types.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const roots: string[] = [];
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.CODE_BUTLER_HOME;
  const home = makeTempDir(); roots.push(home);
  process.env.CODE_BUTLER_HOME = home;
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalHome === undefined) delete process.env.CODE_BUTLER_HOME;
  else process.env.CODE_BUTLER_HOME = originalHome;
  roots.splice(0).forEach(cleanupTempDir);
});

function project(review: Record<string, unknown> = {}): string {
  const root = makeTempDir(); roots.push(root);
  mkdirSync(join(root, ".code-butler"), { recursive: true });
  writeFileSync(join(root, ".code-butler", "config.json"), JSON.stringify({
    sources: { git: { enabled: false }, codex: { enabled: false }, claude: { enabled: false } },
    review: { automatic: review }
  }));
  return root;
}

function withStore<T>(root: string, work: (store: MemoryStore) => T): T {
  const store = openConfiguredMemoryStore(root); store.init();
  try { return work(store); } finally { store.close(); }
}

/** A candidate whose related file changed after its evidence, so it needs review as stale. */
function staleCandidate(store: MemoryStore, key: string, title: string): MemoryCandidate {
  store.addCommit({ hash: `${key}-old`, authorName: "T", authorEmail: "t@example.com", authoredAt: "2026-10-01T00:00:00.000Z", message: `Add ${key}`, changedFiles: [`src/${key}.ts`], diffSummary: `+ ${key}` });
  store.addCommit({ hash: `${key}-new`, authorName: "T", authorEmail: "t@example.com", authoredAt: "2026-10-05T00:00:00.000Z", message: `Change ${key}`, changedFiles: [`src/${key}.ts`], diffSummary: `~ ${key}` });
  return store.upsertMemoryCandidate({
    type: "decision", title, summary: `${title} for the upload pipeline.`, reason: "Recorded during the upload work.", confidence: 0.95,
    evidence: [{ sourceType: "commit", sourceId: `${key}-old` }], relatedFiles: [`src/${key}.ts`], dedupeKey: key
  });
}

/** Answers by title prefix: Keep → current, Old → obsolete, Fix → changed, Meh → low_value, else uncertain. */
function investigator(): MemoryReconciliationProvider & { requests: number } {
  const fake = {
    provider: "test", model: "fake", requests: 0,
    async request(input: { payload: Record<string, unknown> }) {
      fake.requests += 1;
      const memory = input.payload.memory as { title: string };
      const observations = input.payload.observations as Array<{ citationId: string; kind: string }>;
      const cite = observations.find((item) => item.kind === "latest-related-commit" || item.kind === "commit")!.citationId;
      const verdict = memory.title.startsWith("Keep") ? "current" : memory.title.startsWith("Old") ? "obsolete"
        : memory.title.startsWith("Fix") ? "changed" : memory.title.startsWith("Meh") ? "low_value" : "uncertain";
      return { content: JSON.stringify({
        verdict, confidence: 0.95, rationale: "Checked against the latest commit.", citationIds: [cite],
        ...(verdict === "changed" ? { correction: { summary: "Uploads resume from the last confirmed block, per the latest commit." } } : {})
      }) };
    }
  };
  return fake;
}

describe("automatic review", () => {
  it("applies current and obsolete verdicts and leaves corrections and low-value calls for a person", async () => {
    const root = project();
    const ids = withStore(root, (store) => ({
      keep: staleCandidate(store, "keep", "Keep resumable uploads").id,
      old: staleCandidate(store, "old", "Old upload retry limit").id,
      fix: staleCandidate(store, "fix", "Fix upload block size").id,
      meh: staleCandidate(store, "meh", "Meh upload naming").id
    }));
    withStore(root, (store) => expect(store.readMemoryCandidate(ids.keep)!.qualityReasons).toContain("stale_related_file_evidence"));

    const result = await runAutomaticReview(root, loadProjectConfig(root), { provider: investigator() });
    expect(result.state).toMatchObject({ outcome: "reviewed", counts: { checked: 4, verified: 1, retired: 1, leftForReview: 2 } });
    expect(readAutomaticReviewState(root)?.runId).toBe(result.state!.runId);

    withStore(root, (store) => {
      expect(store.readMemoryCandidate(ids.keep)!.qualityStatus).toBe("active");
      expect(store.readMemoryCandidate(ids.old)!.qualityStatus).toBe("quarantined");
      expect(store.readMemoryCandidate(ids.fix)!.qualityStatus).toBe("needs_review");
      expect(store.readMemoryCandidate(ids.meh)!.qualityStatus).toBe("needs_review");
      const decision = planAutomaticPromotions(store, loadProjectConfig(root) as ProjectConfig).decisions.find((item) => item.memoryId === ids.keep)!;
      expect(decision.decision).toBe("promote");
      expect(decision.reasonCodes).toContain("ai_verified_current");
      // Waiting for a person, or verified: neither is asked again tomorrow.
      expect(selectAutoReviewTargets(store, 100)).toEqual([]);
    });

    await revertMemoryReconciliation(root, { runId: result.state!.runId! });
    withStore(root, (store) => expect(store.readMemoryCandidate(ids.old)!.qualityStatus).not.toBe("quarantined"));
  });

  it("selects only flagged live memories, durable first, within the daily cap", () => {
    const root = project();
    withStore(root, (store) => {
      const durable = store.promoteMemoryCandidate(staleCandidate(store, "durable", "Keep durable fact").id);
      const flagged = staleCandidate(store, "flagged", "Keep flagged fact");
      const discarded = staleCandidate(store, "discarded", "Keep discarded fact");
      resolveMemoryReview(store, { memoryId: discarded.id, category: "candidate", action: "discard", reason: "Noise." }, "desktop");
      store.upsertMemoryCandidate({
        type: "decision", title: "Fresh fact", summary: "Fresh fact.", reason: "r", confidence: 0.9,
        evidence: [{ sourceType: "commit", sourceId: "flagged-new" }], relatedFiles: [], dedupeKey: "fresh"
      });

      expect(selectAutoReviewTargets(store, 100)).toEqual([{ category: "promoted", id: durable.id }, { category: "candidate", id: flagged.id }]);
      expect(selectAutoReviewTargets(store, 1)).toHaveLength(1);
    });
  });

  it("does not ask again about a memory judged uncertain within the recheck window", async () => {
    const root = project();
    withStore(root, (store) => staleCandidate(store, "unsure", "Unclear upload rule"));
    const fake = investigator();
    await runAutomaticReview(root, loadProjectConfig(root), { provider: fake });
    expect(fake.requests).toBe(1);
    withStore(root, (store) => expect(selectAutoReviewTargets(store, 100)).toEqual([]));
  });

  it("runs at most daily, and only when enabled with an investigator configured", async () => {
    const enabled = project();
    const disabled = project({ enabled: false });
    expect(automaticReviewSkipReason(disabled, loadProjectConfig(disabled))).toBe("disabled");
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(automaticReviewSkipReason(enabled, loadProjectConfig(enabled))).toBe("investigator_unavailable");

    vi.stubEnv("OPENAI_API_KEY", "test-key");
    // An exported key alone does not opt the built-in default model in.
    expect(automaticReviewSkipReason(enabled, loadProjectConfig(enabled))).toBe("investigator_unavailable");
    setRemoteModelConsent(enabled, true);
    const config = loadProjectConfig(enabled);
    expect(automaticReviewSkipReason(enabled, config)).toBeUndefined();
    const spawnImpl = vi.fn(() => ({ unref() {} }));
    expect(launchAutomaticReviewIfDue(enabled, config, { spawnImpl: spawnImpl as never })).toBe(true);
    expect((spawnImpl.mock.calls[0] as unknown as [string, string[]])[1]).toEqual(expect.arrayContaining(["memory", "review-auto", "--if-due"]));

    expect((await runAutomaticReview(enabled, config, { ifDue: true, provider: investigator() })).state?.outcome).toBe("nothing_to_review");
    expect(automaticReviewSkipReason(enabled, config)).toBe("not_due");
    expect(launchAutomaticReviewIfDue(enabled, config, { spawnImpl: spawnImpl as never })).toBe(false);
    expect((await runAutomaticReview(enabled, config, { ifDue: true, provider: investigator() })).skipped).toBe("not_due");
    const tomorrow = () => new Date(Date.now() + 25 * 60 * 60 * 1000);
    expect(automaticReviewSkipReason(enabled, config, tomorrow())).toBeUndefined();
  });
});
