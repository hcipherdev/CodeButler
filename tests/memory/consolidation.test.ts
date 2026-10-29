// Tests buildConsolidationComponents(), planConsolidation(), applyConsolidation() and undoConsolidation() in src/memory/consolidation.ts with an injected model provider, and the `memory consolidate` / `memory invalidations` commands in src/cli/commands/.
import { afterEach, describe, expect, it } from "vitest";

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runMemoryCommand } from "../../src/cli/commands/memory.js";
import { readLiveMemoryCorpus } from "../../src/extract/related-memories.js";
import {
  applyConsolidation,
  buildConsolidationComponents,
  listConsolidationRuns,
  planConsolidation,
  undoConsolidation
} from "../../src/memory/consolidation.js";
import type { MemoryReconciliationProvider } from "../../src/memory/reconciliation-provider.js";
import { openMemoryStore, type MemoryStore } from "../../src/storage/store.js";
import type { EvidenceRef, MemoryCandidate, ProjectConfig } from "../../src/types.js";
import { runMemoryConsolidateCommand } from "../../src/cli/commands/memory-consolidate.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const roots: string[] = [], stores: MemoryStore[] = [];

function store(): MemoryStore {
  const root = makeTempDir(); roots.push(root);
  const s = openMemoryStore(root); s.init(); stores.push(s); return s;
}

afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  roots.splice(0).forEach(cleanupTempDir);
});

const config = {
  promotion: {
    confidenceThreshold: 0.85, requireCommitAndConversation: true, minSourceCategories: 2,
    automatic: { enabled: true, mode: "conservative", minScore: 0.85, mergedBranches: true, deviceMemories: true, coreCandidates: true, singleSourceMinConfidence: 0.9 }
  },
  sources: { git: { repoPath: "" } }
} as unknown as ProjectConfig;

function commit(s: MemoryStore, hash: string, authoredAt = "2026-10-01T00:00:00.000Z"): EvidenceRef {
  s.addCommit({ hash, authorName: "T", authorEmail: "t@example.com", authoredAt, message: hash, changedFiles: [], diffSummary: hash });
  return { sourceType: "commit", sourceId: hash };
}

function candidate(s: MemoryStore, key: string, title: string, summary: string, options: { type?: MemoryCandidate["type"]; at?: string } = {}): MemoryCandidate {
  return s.upsertMemoryCandidate({
    type: options.type ?? "constraint", title, summary, reason: "Seen in a session.", confidence: 0.9,
    evidence: [commit(s, `${key}-commit`, options.at)], relatedFiles: ["src/join-card.ts"], dedupeKey: key
  }, { qualityStatus: "active", qualityReasons: [] });
}

/** Answers each cluster from a script keyed by item title. */
function provider(answer: (titleToRef: Map<string, string>) => unknown): MemoryReconciliationProvider & { requests: number } {
  const fake = {
    provider: "test", model: "fake", requests: 0,
    async request(input: { payload: Record<string, unknown> }) {
      fake.requests += 1;
      const items = input.payload.items as Array<{ ref: string; title: string }>;
      return { content: JSON.stringify(answer(new Map(items.map((item) => [item.title, item.ref])))) };
    }
  };
  return fake;
}

function joinCardFacts(s: MemoryStore) {
  return {
    a: candidate(s, "join-card-30day-expiry", "Join card expiry fixed at 30 days", "Device join cards expire 30 days after creation and are never renewed."),
    b: candidate(s, "join-card-30-day-expiry-fixed", "Join card 30 day expiry", "Join cards expire 30 days after device creation and nothing renews them."),
    c: candidate(s, "join-card-expires-never-renews", "Join card expires and never renews", "Every device join card expires 30 days after creation and never renews."),
    other: candidate(s, "dashboard-cards", "Dashboard cards are clickable", "Team dashboard cards open their detail views.", { type: "decision" })
  };
}

const sameFact = (refs: Map<string, string>) => ({
  groups: [{ canonical: refs.get("Join card expiry fixed at 30 days"), members: [refs.get("Join card 30 day expiry"), refs.get("Join card expires and never renews")], confidence: 0.95 }],
  invalidations: []
});

describe("buildConsolidationComponents", () => {
  it("clusters paraphrases of one fact and leaves unrelated memories out", () => {
    const s = store();
    joinCardFacts(s);
    const components = buildConsolidationComponents(readLiveMemoryCorpus(s));
    expect(components).toHaveLength(1);
    expect(components[0]!.map((item) => item.title).sort()).toEqual(["Join card 30 day expiry", "Join card expires and never renews", "Join card expiry fixed at 30 days"]);
  });

  it("splits clusters larger than the maximum size", () => {
    const s = store();
    for (let index = 0; index < 30; index += 1) candidate(s, `variant-${index}`, `Join card expiry variant ${index}`, "Join cards expire 30 days after creation and never renew.");
    const components = buildConsolidationComponents(readLiveMemoryCorpus(s), 24);
    expect(components.length).toBeGreaterThan(1);
    for (const component of components) expect(component.length).toBeLessThanOrEqual(24);
  });
});

describe("consolidation plan, apply and undo", () => {
  it("merges a group into one corroborated memory, retires the rest, and promotes it", async () => {
    const s = store();
    const { a, b, c, other } = joinCardFacts(s);
    const rowsBefore = (s.db.prepare("select count(*) as n from memory_candidates").get() as { n: number }).n;

    const plan = await planConsolidation(s, { provider: provider(sameFact) });
    expect(plan.status).toBe("planned");
    expect(plan.summary).toMatchObject({ groups: 1, membersToRetire: 2, canonicalsGainingSources: 1, estimatedPromotions: 1 });
    expect(s.readMemoryCandidate(b.id)!.qualityStatus).toBe("active");

    const applied = applyConsolidation(s, config, { runId: plan.id });
    expect(applied.status).toBe("applied");
    expect(applied.summary.applied).toMatchObject({ groups: 1, retired: 2, promoted: 1 });
    const canonical = s.readMemoryCandidate(a.id)!;
    expect(new Set(canonical.evidence.map((item) => item.sourceId))).toEqual(new Set([`join-card-30day-expiry-commit`, `join-card-30-day-expiry-fixed-commit`, `join-card-expires-never-renews-commit`]));
    expect(canonical.promotionState).toBe("promoted");
    expect(s.readMemoryCandidate(b.id)!.qualityStatus).toBe("quarantined");
    expect(s.readMemoryCandidate(c.id)!.qualityStatus).toBe("quarantined");
    expect(s.readMemoryCandidate(other.id)!.qualityStatus).toBe("active");
    expect((s.db.prepare("select count(*) as n from memory_candidates").get() as { n: number }).n).toBe(rowsBefore);

    const undone = undoConsolidation(s, { runId: plan.id });
    expect(undone.status).toBe("undone");
    expect(s.readMemoryCandidate(b.id)!.qualityStatus).toBe("active");
    expect(s.readMemoryCandidate(c.id)!.qualityStatus).toBe("active");
    expect(listConsolidationRuns(s)[0]!.summary.undone?.groups).toBe(1);
  });

  it("drops members of another type and skips groups that would merge two durable memories", async () => {
    const s = store();
    const { a, b, c, other } = joinCardFacts(s);
    s.promoteMemoryCandidate(b.id);
    s.promoteMemoryCandidate(c.id);
    const plan = await planConsolidation(s, { provider: provider((refs) => ({
      groups: [{ canonical: refs.get("Join card expiry fixed at 30 days"), members: [refs.get("Join card 30 day expiry"), refs.get("Join card expires and never renews"), refs.get("Dashboard cards are clickable")], confidence: 0.95 }],
      invalidations: []
    })) });
    expect(plan.summary.groups).toBe(0);
    expect(plan.summary.skipped).toMatchObject({ two_durables: 1 });
    expect(s.readMemoryCandidate(a.id)!.qualityStatus).toBe("active");
    expect(s.readMemoryCandidate(other.id)!.qualityStatus).toBe("active");
  });

  it("applies a consolidation invalidation to the older memory and undoes it", async () => {
    const s = store();
    const older = candidate(s, "join-card-never-renews", "Join card never renews", "Join cards expire after 30 days and are never renewed.", { type: "bug_fix", at: "2026-10-01T00:00:00.000Z" });
    const newer = candidate(s, "join-card-renews", "Join card renews before expiry", "Join cards are now renewed seven days before their 30 day expiry.", { type: "decision", at: "2026-10-06T00:00:00.000Z" });
    const durable = s.promoteMemoryCandidate(older.id);
    s.promoteMemoryCandidate(newer.id);

    const plan = await planConsolidation(s, { provider: provider((refs) => ({
      groups: [],
      invalidations: [{ older: refs.get("Join card never renews"), newer: refs.get("Join card renews before expiry"), confidence: 0.95, why: "Renewal was added." }]
    })) });
    expect(plan.summary.invalidations).toBe(1);
    const applied = applyConsolidation(s, config, { runId: plan.id });
    expect(applied.summary.applied?.invalidations).toEqual({ superseded: 1 });
    expect(s.readMemory(durable.id)!.lifecycleStatus).toBe("superseded");

    undoConsolidation(s, { runId: plan.id });
    expect(s.readMemory(durable.id)!.lifecycleStatus).toBe("current");
  });

  it("records a model failure as a failed request and changes nothing", async () => {
    const s = store();
    joinCardFacts(s);
    const failing: MemoryReconciliationProvider = { provider: "test", model: "fake", async request() { throw new Error("overloaded"); } };
    const plan = await planConsolidation(s, { provider: failing });
    expect(plan.summary).toMatchObject({ requests: 1, failedRequests: 1, groups: 0 });
  });
});

describe("memory consolidate command", () => {
  it("plans, applies and lists a run, and lists invalidations", async () => {
    const s = store();
    const root = s.paths.rootDir;
    mkdirSync(join(root, ".code-butler"), { recursive: true });
    writeFileSync(join(root, ".code-butler", "config.json"), JSON.stringify({ sources: { git: { enabled: false }, codex: { enabled: false }, claude: { enabled: false } } }));
    const { b } = joinCardFacts(s);
    s.close(); stores.splice(stores.indexOf(s), 1);

    const lines: string[] = [];
    const out = (line: string) => lines.push(line);
    const fake = provider(sameFact);
    await runMemoryConsolidateCommand(["--plan", "--json"], root, out, { provider: fake });
    const plan = JSON.parse(lines.pop()!) as { id: string; summary: { groups: number } };
    expect(plan.summary.groups).toBe(1);

    await runMemoryConsolidateCommand(["--apply", "--run", plan.id], root, out);
    expect(lines.join("\n")).toContain("applied groups=1 retired=2");
    lines.length = 0;
    await runMemoryConsolidateCommand(["--history"], root, out);
    expect(lines[0]).toContain(`Consolidation ${plan.id} applied`);

    lines.length = 0;
    await runMemoryCommand(["invalidations"], root, out);
    expect(lines).toEqual(["Memory Invalidations", "none pending"]);
    await expect(runMemoryConsolidateCommand(["--plan", "--apply"], root, out)).rejects.toThrow("Usage");

    const reopened = openMemoryStore(root); reopened.init(); stores.push(reopened);
    expect(reopened.readMemoryCandidate(b.id)!.qualityStatus).toBe("quarantined");
  });
});
