// Tests memoryAnchors(), fileDiffSection() and isRelevantChange() in src/memory/related-change.ts, and their use in stale-file quality, review-token matching and batched AI review (src/memory/reconciliation.ts).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assessMemoryQuality } from "../../src/memory/quality.js";
import { planMemoryReconciliation } from "../../src/memory/reconciliation.js";
import type { MemoryReconciliationProvider, ReconciliationModelRequest } from "../../src/memory/reconciliation-provider.js";
import { fileDiffSection, isRelevantChange, memoryAnchors } from "../../src/memory/related-change.js";
import { resolveMemoryReview } from "../../src/memory/review.js";
import { createMemoryReviewContext, currentMemoryReview, matchingMemoryVerification } from "../../src/memory/review-state.js";
import { openConfiguredMemoryStore } from "../../src/storage/open-configured-store.js";
import type { MemoryStore } from "../../src/storage/store.js";
import type { CommitRecord, MemoryCandidate } from "../../src/types.js";
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

function project(): string {
  const root = makeTempDir(); roots.push(root);
  mkdirSync(join(root, ".code-butler"), { recursive: true });
  mkdirSync(join(root, "pages"), { recursive: true });
  writeFileSync(join(root, ".code-butler", "config.json"), JSON.stringify({
    sources: { git: { enabled: false }, codex: { enabled: false }, claude: { enabled: false } }
  }));
  writeFileSync(join(root, FILE), [
    "export default function Home() {",
    "  return (<main>",
    "    <a href=\"/download\">Download Beta</a>",
    "    <p>Copyright 2026</p>",
    "  </main>);",
    "}"
  ].join("\n"));
  return root;
}

function withStore<T>(root: string, work: (store: MemoryStore) => T): T {
  const store = openConfiguredMemoryStore(root); store.init();
  try { return work(store); } finally { store.close(); }
}

function diff(file: string, removed: string, added: string): string {
  return [
    `diff --git a/${file} b/${file}`, "index 1111111..2222222 100644", `--- a/${file}`, `+++ b/${file}`,
    "@@ -1,4 +1,4 @@", " export default function Home() {", `-${removed}`, `+${added}`, " }"
  ].join("\n");
}

function commit(hash: string, authoredAt: string, diffSummary: string, file = FILE): CommitRecord {
  return { hash, authorName: "T", authorEmail: "t@example.com", authoredAt, message: `Commit ${hash}`, changedFiles: [file], diffSummary };
}

const RELEVANT = diff(FILE, "    <a href=\"/start\">Get Started</a>", "    <a href=\"/download\">Download Beta</a>");
const IRRELEVANT = diff(FILE, "    <p>Copyright 2025</p>", "    <p>Copyright 2026</p>");

function heroMemory(store: MemoryStore, key: string, title = "Hero CTA reads 'Download Beta'"): MemoryCandidate {
  return store.upsertMemoryCandidate({
    type: "decision", title, summary: "The hero button label is 'Download Beta' and links to /download.",
    reason: "Recorded during the homepage work.", confidence: 0.95,
    evidence: [{ sourceType: "commit", sourceId: "c-evidence" }], relatedFiles: [FILE], dedupeKey: key
  });
}

describe("memoryAnchors", () => {
  it("collects quoted text, identifiers, routes and versions, but not the memory's own file", () => {
    const anchors = memoryAnchors({
      title: "Rename 'Seamless Collaboration' in v0.1.6",
      summary: "The _honey field and shareLocalLayers flag live in index; the CTA links to /download.",
      relatedFiles: ["pages/index.tsx"]
    });
    expect(anchors).toEqual(expect.arrayContaining([
      { value: "seamless collaboration", caseless: true },
      { value: "v0.1.6", caseless: false },
      { value: "_honey", caseless: false },
      { value: "shareLocalLayers", caseless: false },
      { value: "/download", caseless: false }
    ]));
    expect(anchors.map((anchor) => anchor.value)).not.toContain("index");
  });

  it("returns nothing for a memory that names nothing concrete", () => {
    expect(memoryAnchors({ title: "Setup is split into two sections", summary: "Installation and first run are separate.", relatedFiles: [] })).toEqual([]);
  });
});

describe("fileDiffSection", () => {
  it("reads one file's section, its changed lines and new-side ranges", () => {
    const summary = `${diff("a.ts", "old a", "new a")}\n${diff(FILE, "old", "new")}`;
    const section = fileDiffSection(summary, FILE)!;
    expect(section.status).toBe("modified");
    expect(section.changedText).toBe("old\nnew");
    expect(section.newRanges).toEqual([[1, 4]]);
    expect(section.truncated).toBe(false);
    expect(fileDiffSection(summary, "missing.ts")).toBeUndefined();
  });

  it("marks deletions and a section cut off by the stored diff limit", () => {
    const deleted = `diff --git a/${FILE} b/${FILE}\ndeleted file mode 100644\n--- a/${FILE}\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone`;
    expect(fileDiffSection(deleted, FILE)!.status).toBe("deleted");
    expect(fileDiffSection(`${diff(FILE, "a", "b")}\n[diff truncated at 12000 chars]`, FILE)!.truncated).toBe(true);
  });
});

describe("isRelevantChange", () => {
  it("is relevant only when changed lines touch an anchor, and conservative otherwise", () => {
    const root = project();
    withStore(root, (store) => {
      const anchors = memoryAnchors({ title: "CTA 'Download Beta'", summary: "Links to /download.", relatedFiles: [FILE] });
      expect(isRelevantChange(store, commit("r", "2026-10-01T00:00:00Z", RELEVANT), FILE, anchors)).toBe(true);
      expect(isRelevantChange(store, commit("i", "2026-10-01T00:00:00Z", IRRELEVANT), FILE, anchors)).toBe(false);
      expect(isRelevantChange(store, commit("n", "2026-10-01T00:00:00Z", IRRELEVANT), FILE, [])).toBe(true);
      expect(isRelevantChange(store, commit("m", "2026-10-01T00:00:00Z", "+ not a git diff"), FILE, anchors)).toBe(true);
    });
  });
});

describe("repository fallback", () => {
  it("reads a change from the local repository when the stored diff was cut off before the file", () => {
    const root = project();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q");
    git("-c", "user.name=T", "-c", "user.email=t@example.com", "add", FILE);
    git("-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "Add homepage");
    writeFileSync(join(root, FILE), "export default function Home() {\n  return <p>Copyright 2027</p>;\n}\n");
    git("-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qam", "Footer year");
    const hash = git("rev-parse", "HEAD");
    withStore(root, (store) => {
      const anchors = memoryAnchors({ title: "CTA 'Download Beta'", summary: "Links to /download.", relatedFiles: [FILE] });
      const cutOff = commit(hash, "2026-10-01T00:00:00Z", `${diff("other.ts", "a", "b")}\n[diff truncated at 12000 chars]`);
      // The footer commit removed the CTA line, so the repository shows it touched the memory.
      expect(isRelevantChange(store, cutOff, FILE, anchors)).toBe(true);
      const footerOnly = memoryAnchors({ title: "Footer shows 'Copyright 2027'", summary: "The footer year.", relatedFiles: [FILE] });
      expect(isRelevantChange(store, cutOff, FILE, footerOnly)).toBe(true);
      const unrelated = memoryAnchors({ title: "Pricing uses `monthlyPlan`", summary: "Plans are monthly.", relatedFiles: [FILE] });
      expect(isRelevantChange(store, cutOff, FILE, unrelated)).toBe(false);
    });
  });
});

describe("relevance-aware staleness", () => {
  it("flags a memory only for later commits that touch what it names", () => {
    const root = project();
    withStore(root, (store) => {
      store.addCommit(commit("c-evidence", "2026-10-01T00:00:00.000Z", RELEVANT));
      const memory = heroMemory(store, "stale-check");
      store.addCommit(commit("c-footer", "2026-10-05T00:00:00.000Z", IRRELEVANT));
      expect(assessMemoryQuality(store, memory).reasons).not.toContain("stale_related_file_evidence");
      store.addCommit(commit("c-cta", "2026-10-06T00:00:00.000Z", diff(FILE, "    <a href=\"/download\">Download Beta</a>", "    <a href=\"/start\">Start</a>")));
      expect(assessMemoryQuality(store, memory).reasons).toContain("stale_related_file_evidence");
    });
  });

  it("keeps a verification current across unrelated commits and accepts tokens saved under the old rule", () => {
    const root = project();
    withStore(root, (store) => {
      store.addCommit(commit("c-evidence", "2026-10-01T00:00:00.000Z", RELEVANT));
      const created = heroMemory(store, "verify-check");
      resolveMemoryReview(store, {
        memoryId: created.id, category: "candidate", action: "verify", reason: "Checked the homepage.",
        reviewToken: createMemoryReviewContext(store, "candidate", created).reviewToken
      }, "desktop");
      const memory = store.readMemoryCandidate(created.id)!;
      store.addCommit(commit("c-footer", "2026-10-05T00:00:00.000Z", IRRELEVANT));
      expect(currentMemoryReview(store, "candidate", memory)?.current).toBe(true);

      // A review saved when any commit to the file counted still matches after the switch.
      const context = createMemoryReviewContext(store, "candidate", memory);
      expect(context.acceptedTokens.length).toBeGreaterThan(1);
      store.db.prepare("update memory_review_resolutions set context_fingerprint = ? where memory_id = ?").run(context.acceptedTokens[1]!, memory.id);
      expect(matchingMemoryVerification(store, "candidate", memory)).toBeDefined();

      store.addCommit(commit("c-cta", "2026-10-06T00:00:00.000Z", diff(FILE, "    <a href=\"/download\">Download Beta</a>", "    <a href=\"/start\">Start</a>")));
      expect(currentMemoryReview(store, "candidate", memory)?.current).toBe(false);
    });
  });
});

describe("batched AI review", () => {
  /** Answers single and batched requests; `drop` omits that memory from batched answers. */
  function reviewer(drop?: string): MemoryReconciliationProvider & { requests: ReconciliationModelRequest[] } {
    const requests: ReconciliationModelRequest[] = [];
    const judge = (citationIds: string[]) => ({ verdict: "current", confidence: 0.95, rationale: "The CTA still reads Download Beta.", citationIds: citationIds.slice(0, 1) });
    return {
      provider: "test", model: "fake", requests,
      async request(input) {
        requests.push(input);
        const observations = input.payload.observations as Array<{ citationId: string; kind: string }>;
        const positive = (allowed: string[]) => observations.filter((item) => allowed.includes(item.citationId) && item.kind === "current-file").map((item) => item.citationId);
        const memories = input.payload.memories as Array<{ memory: { id: string; title: string }; allowedCitationIds: string[] }> | undefined;
        if (!memories) return { content: JSON.stringify(judge(positive(observations.map((item) => item.citationId)))), inputTokens: 100, outputTokens: 20 };
        return {
          content: JSON.stringify({ judgments: memories.filter((entry) => entry.memory.title !== drop)
            .map((entry) => ({ memoryId: entry.memory.id, ...judge(positive(entry.allowedCitationIds)) })) }),
          inputTokens: 300, outputTokens: 60
        };
      }
    };
  }

  function seed(root: string): Array<{ category: "candidate"; id: string }> {
    return withStore(root, (store) => {
      store.addCommit(commit("c-evidence", "2026-10-01T00:00:00.000Z", RELEVANT));
      const refs = ["First", "Second", "Third"].map((name) => ({ category: "candidate" as const, id: heroMemory(store, `batch-${name}`, `${name} hero CTA reads 'Download Beta'`).id }));
      store.addCommit(commit("c-cta", "2026-10-06T00:00:00.000Z", diff(FILE, "    <a href=\"/start\">Start</a>", "    <a href=\"/download\">Download Beta</a>")));
      return refs;
    });
  }

  it("judges memories that cite the same file in one request, sending only that file's changes", async () => {
    const root = project();
    const refs = seed(root);
    const fake = reviewer();
    const run = await planMemoryReconciliation(root, { memoryRefs: refs, limit: null, maxRequests: 10, tokenBudget: 100_000 }, { provider: fake });
    expect(fake.requests).toHaveLength(1);
    expect(run.items.map((item) => item.verdict)).toEqual(["current", "current", "current"]);
    const kinds = (fake.requests[0]!.payload.observations as Array<{ kind: string }>).map((item) => item.kind);
    expect(kinds).toContain("related-changes");
    expect(kinds).not.toContain("latest-related-commit");
  });

  it("sends a large file as an excerpt and states over the whole file which named things are missing", async () => {
    const root = project();
    const filler = Array.from({ length: 400 }, (_, index) => `  // filler line ${index} keeps this file large`);
    writeFileSync(join(root, FILE), ["export default function Home() {", ...filler, "  return <a href=\"/download\">Download Beta</a>;", ...filler, "}"].join("\n"));
    const refs = withStore(root, (store) => {
      store.addCommit(commit("c-evidence", "2026-10-01T00:00:00.000Z", RELEVANT));
      return [{ category: "candidate" as const, id: store.upsertMemoryCandidate({
        type: "decision", title: "CTA uses 'Download Beta' and the `trackCta` hook", summary: "The hero CTA calls trackCta and links to /download.",
        reason: "Recorded during the homepage work.", confidence: 0.95,
        evidence: [{ sourceType: "commit", sourceId: "c-evidence" }], relatedFiles: [FILE], dedupeKey: "excerpt"
      }).id }];
    });
    const fake = reviewer();
    await planMemoryReconciliation(root, { memoryRefs: refs, limit: null, maxRequests: 4, tokenBudget: 100_000 }, { provider: fake });
    const file = (fake.requests[0]!.payload.observations as Array<{ kind: string; content: string; metadata: Record<string, unknown> }>)
      .find((item) => item.kind === "current-file")!;
    expect(file.metadata).toMatchObject({ excerpt: true, anchorsMissing: ["trackCta"] });
    expect(file.metadata.anchorsFound).toEqual(expect.arrayContaining(["download beta", "/download"]));
    expect(file.content.length).toBeLessThanOrEqual(8_200);
    expect(file.content).toContain("Download Beta");
  });

  it("falls back to a single review for a memory the batch left out, then reuses identical judgments", async () => {
    const root = project();
    const refs = seed(root);
    const fake = reviewer("Third hero CTA reads 'Download Beta'");
    const run = await planMemoryReconciliation(root, { memoryRefs: refs, limit: null, maxRequests: 10, tokenBudget: 100_000 }, { provider: fake });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.payload.memories).toBeUndefined();
    expect(run.items.every((item) => item.verdict === "current")).toBe(true);

    const again = reviewer();
    const second = await planMemoryReconciliation(root, { memoryRefs: refs, limit: null, maxRequests: 10, tokenBudget: 100_000 }, { provider: again });
    expect(again.requests).toHaveLength(0);
    expect(second.items.every((item) => item.verdict === "current" && item.requestTokens === 0)).toBe(true);
  });
});
