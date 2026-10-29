// Tests multi-term memory matching (parseQueryTerms, store.searchMemoryLayer, readPublishedMemories), search response shaping in src/mcp/search-response.ts, read_memory_chunk, and generated-commit exclusion from raw search.
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryStore, type MemoryStore } from "../../src/storage/store.js";
import { closeRetrievalReaders, publishRetrieval, readPublishedChunks, readPublishedMemories, readPublishedRaw } from "../../src/retrieval/index.js";
import { createProjectMemoryToolHandlers } from "../../src/mcp/tools.js";
import { parseQueryTerms } from "../../src/search/query-terms.js";
import { compactMemory, excerptText, shapeFindMemories, shapeSearchProjectMemory } from "../../src/mcp/search-response.js";
import { isGeneratedMemoryPath, isSearchExcludedPath, searchExcludedPathSql } from "../../src/sources/sensitive-path.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const opened: Array<{ root: string; store: MemoryStore }> = [];
afterEach(() => {
  closeRetrievalReaders();
  for (const { root, store } of opened.splice(0)) {
    store.close();
    cleanupTempDir(root);
  }
});

function fixture() {
  const root = makeTempDir();
  const store = openMemoryStore(root);
  store.init();
  opened.push({ root, store });
  store.addSourceWithChunks({ source: { id: "conv", type: "conversation", title: "Policy talk", origin: "test", rawContent: "body" }, chunks: [{ text: "We checked provider terms." }] });
  const remember = (title: string, summary: string, dedupeKey: string, promote = true) => {
    const candidate = store.upsertMemoryCandidate({ type: "constraint", title, summary, reason: "Recorded for the test", confidence: 0.99, evidence: [{ sourceType: "conversation", sourceId: "conv", locator: "conv:chunk:0" }], relatedFiles: [], dedupeKey });
    if (promote) store.promoteMemoryCandidate(candidate.id, "manual");
  };
  remember("Subscription-backed AI connections", "Policy: Sign in with ChatGPT covers Codex in open-source apps; keep Claude on API keys.", "policy");
  remember("Claude Code install notes", "Install the CLI globally.", "install");
  remember("Watcher layout", "Popover placement for the watcher panel.", "unrelated");
  remember("Candidate about ChatGPT plans", "ChatGPT plan usage for a subscription.", "candidate", false);
  // The partial match is the newest promoted memory, so recency alone would rank it first.
  store.db.prepare("update memories set promoted_at=? where title=?").run("2099-01-01T00:00:00.000Z", "Claude Code install notes");
  return { root, store };
}

describe("parseQueryTerms", () => {
  it("splits on whitespace, keeps paths and quotes, and drops stopwords only when other terms remain", () => {
    expect(parseQueryTerms("How did we decide the Claude plan")).toEqual(["decide", "claude", "plan"]);
    expect(parseQueryTerms("src/a_b.ts \"Literal\" src/a_b.ts")).toEqual(["src/a_b.ts", "\"literal\""]);
    expect(parseQueryTerms("what is the")).toEqual(["what", "is", "the"]);
    expect(parseQueryTerms("   ")).toEqual([]);
  });
});

describe("terms match mode", () => {
  it("finds a memory regardless of word order on both engines, while phrase mode stays exact", () => {
    const { root, store } = fixture();
    publishRetrieval(store, root, "fixture");
    for (const query of ["ChatGPT Sign in", "subscription policy Codex Claude plan"]) {
      const input = { query, match: "terms" as const, qualityStatus: "all" as const, limit: 10 };
      const canonical = store.searchMemoryLayer(input);
      expect(canonical[0]?.title).toBe("Subscription-backed AI connections");
      expect(readPublishedMemories(root, input).items).toEqual(canonical);
    }
    expect(store.searchMemoryLayer({ query: "ChatGPT Sign in", qualityStatus: "all" })).toEqual([]);
    expect(readPublishedMemories(root, { query: "ChatGPT Sign in", qualityStatus: "all" }).items).toEqual([]);
  });

  it("ranks by matched terms within promoted memories, keeps promoted first, and reports match counts", () => {
    const { root, store } = fixture();
    publishRetrieval(store, root, "fixture");
    const byTerms = { query: "claude api keys", match: "terms" as const, qualityStatus: "all" as const };
    const ranked = store.searchMemoryLayer(byTerms);
    expect(ranked.map((memory) => [memory.title, memory.match])).toEqual([
      ["Subscription-backed AI connections", { terms: 3, matched: 3 }],
      ["Claude Code install notes", { terms: 3, matched: 1 }]
    ]);
    expect(readPublishedMemories(root, byTerms).items).toEqual(ranked);

    // The candidate matches more terms but still follows the promoted memory.
    const mixed = { query: "chatgpt plan subscription", match: "terms" as const, qualityStatus: "all" as const };
    expect(store.searchMemoryLayer(mixed).map((memory) => [memory.kind, memory.match?.matched])).toEqual([["promoted", 2], ["candidate", 3]]);
    expect(readPublishedMemories(root, mixed).items).toEqual(store.searchMemoryLayer(mixed));
  });

  it("matches phrase mode exactly for single-term queries", () => {
    const { root, store } = fixture();
    publishRetrieval(store, root, "fixture");
    for (const query of ["", "claude", "ChatGPT", "a", "src/a_b.ts", "中文", "\"literal\"", "  watcher  "]) {
      for (const status of [undefined, "candidate", "promoted"] as const) {
        const phrase = { query, qualityStatus: "all" as const, limit: 5, ...(status ? { status } : {}) };
        const terms = { ...phrase, match: "terms" as const };
        expect(store.searchMemoryLayer(terms)).toEqual(store.searchMemoryLayer(phrase));
        expect(readPublishedMemories(root, terms).items).toEqual(readPublishedMemories(root, phrase).items);
      }
    }
  });

  it("is what the MCP find_memories and search_project_memory handlers use", async () => {
    const { root, store } = fixture();
    const handlers = createProjectMemoryToolHandlers(store, { rootDir: root });
    expect((await handlers.find_memories({ query: "ChatGPT Sign in", qualityStatus: "all" })).results[0]?.title).toBe("Subscription-backed AI connections");
    expect((await handlers.search_project_memory({ query: "ChatGPT Sign in" })).memories[0]?.title).toBe("Subscription-backed AI connections");
  });
});

describe("search response shaping", () => {
  it("excerpts long text around the earliest query term", () => {
    const text = `${"x".repeat(5000)}needle${"y".repeat(7000)}`;
    const excerpt = excerptText(text, ["needle"]);
    expect(excerpt.excerpted).toBe(true);
    expect(excerpt.text).toContain("needle");
    expect(excerpt.text.length).toBeLessThanOrEqual(602);
    expect(excerptText("short needle", ["needle"])).toEqual({ text: "short needle", excerpted: false });
    expect(excerptText(text, ["absent"]).text.startsWith("xxx")).toBe(true);
  });

  it("centers the excerpt on the passage with the most query terms, not the first hit", () => {
    const text = `Claude on AWS. ${"filler ".repeat(300)}Use your Codex quota: Claude subscription terms need checking. ${"tail ".repeat(300)}`;
    const excerpt = excerptText(text, ["claude", "codex", "subscription"]);
    expect(excerpt.text).toContain("Codex quota: Claude subscription");
    expect(excerpt.text).not.toContain("Claude on AWS");
    // A cluster near the end still yields a full-length window.
    const late = excerptText(`${"x".repeat(5000)} codex claude`, ["codex", "claude"]);
    expect(late.text.endsWith("codex claude")).toBe(true);
    expect(late.text.length).toBe(601);
  });

  it("returns excerpts, drops trust, fits the budget, and reads the full chunk on request", async () => {
    const { root, store } = fixture();
    const long = `${"filler ".repeat(1000)}needle decision ${"tail ".repeat(1000)}`;
    store.addSourceWithChunks({ source: { id: "big", type: "conversation", title: "Long", origin: "test", rawContent: long }, chunks: Array.from({ length: 8 }, () => ({ text: long })) });
    const handlers = createProjectMemoryToolHandlers(store, { rootDir: root });
    const raw = await handlers.search_project_memory({ query: "needle", limit: 8 });

    const shaped = shapeSearchProjectMemory(raw, { query: "needle" });
    const hit = shaped.results[0] as (typeof shaped.results)[number] & { textLength?: number; excerpted?: boolean };
    expect(hit.text.length).toBeLessThanOrEqual(602);
    expect(hit.text).toContain("needle");
    expect(hit).toMatchObject({ textLength: long.length, excerpted: true });
    expect(hit.trust).toBeUndefined();

    const tight = shapeSearchProjectMemory(raw, { query: "needle", maxChars: 2000 }) as typeof shaped & { omitted?: { results?: number } };
    expect(JSON.stringify(tight).length).toBeLessThanOrEqual(2000);
    expect(tight.omitted?.results).toBeGreaterThan(0);

    const chunk = handlers.read_memory_chunk({ sourceId: "big", chunkId: hit.chunkId });
    expect(chunk?.text).toBe(long);
    expect(handlers.read_memory_chunk({ sourceId: "conv", chunkId: hit.chunkId })).toBeUndefined();
  });

  it("leaves out memories matching under half the terms and trims both lists in turn", async () => {
    const { root, store } = fixture();
    const handlers = createProjectMemoryToolHandlers(store, { rootDir: root });
    const memories = (await handlers.find_memories({ query: "claude api keys", qualityStatus: "all" })).results;
    expect(memories.map((memory) => memory.match?.matched)).toEqual([3, 1]);
    const filtered = shapeSearchProjectMemory({ memories, results: [] }, { query: "claude api keys" }) as { memories: unknown[]; omitted?: Record<string, number>; note?: string };
    expect(filtered.memories).toHaveLength(1);
    expect(filtered.omitted).toEqual({ partialMemories: 1 });
    expect(filtered.note).toContain("find_memories");

    const hit = (await handlers.search_project_memory({ query: "provider" })).results[0]!;
    const many = { memories: Array.from({ length: 6 }, () => memories[0]!), results: Array.from({ length: 6 }, () => ({ ...hit, text: "provider ".repeat(60) })) };
    const trimmed = shapeSearchProjectMemory(many, { query: "provider", maxChars: 8000 }) as typeof many & { omitted?: Record<string, number> };
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(8000);
    expect(trimmed.omitted?.results).toBeGreaterThan(0);
    expect(trimmed.omitted?.memories).toBeGreaterThan(0);
    expect(trimmed.results.length).toBeGreaterThan(0);
  });

  it("removes memory text that repeats the summary or title", async () => {
    const { root, store } = fixture();
    const handlers = createProjectMemoryToolHandlers(store, { rootDir: root });
    const memory = (await handlers.find_memories({ query: "watcher", qualityStatus: "all" })).results[0]!;
    expect(memory.presentation?.text).toBe(memory.summary);
    expect(memory.presentation?.headline).toBe(memory.title);
    const compact = compactMemory(memory);
    expect(compact.presentation?.text).toBeUndefined();
    expect(compact.presentation?.headline).toBeUndefined();
    if (memory.statement?.text === memory.summary) expect(compact.statement?.text).toBeUndefined();
    expect(compact.summary).toBe(memory.summary);
    expect(shapeFindMemories({ results: [memory] }, undefined).results[0]).toEqual(compact);
  });
});

describe("generated commits", () => {
  it("recognizes search-excluded paths in JavaScript and SQL alike, without widening evidence exclusion", () => {
    const { store } = fixture();
    const cases: Array<[string, boolean]> = [
      [".code-butler/project-summary.md", true],
      ["./.code-butler/Project-Summary.md", true],
      [".code-butler/project-summary.meta.json", true],
      [".code-butler\\handbook\\topic.md", true],
      ["docs/project-summary.md", false],
      [".code-butler/config.json", false]
    ];
    for (const [path, expected] of cases) {
      expect(isSearchExcludedPath(path)).toBe(expected);
      const row = store.db.prepare(`with p(v) as (select ?) select ${searchExcludedPathSql("v")} as excluded from p`).get(path) as { excluded: number };
      expect(Boolean(row.excluded)).toBe(expected);
    }
    // Summary edits remain ingestible evidence; only handbook output is generated evidence.
    expect(isGeneratedMemoryPath(".code-butler/project-summary.md")).toBe(false);
  });

  it("keeps generated-only commits out of raw search on both engines but leaves them readable", () => {
    const { root, store } = fixture();
    const commit = (hash: string, changedFiles: string[], diffSummary: string) => store.addCommit({ hash, authorName: "Dev", authorEmail: "dev@example.com", authoredAt: "2026-10-20T00:00:00Z", message: "update", changedFiles, diffSummary });
    const summaryHash = "a".repeat(40);
    commit(summaryHash, [".code-butler/project-summary.md"], "needle in the generated summary");
    commit("b".repeat(40), ["src/search/service.ts"], "needle in a real change");
    commit("c".repeat(40), [".code-butler/project-summary.md", "src/x.ts"], "needle in a mixed change");
    publishRetrieval(store, root, "fixture");

    const expected = ["b".repeat(40), "c".repeat(40)];
    expect(store.search({ query: "needle", sourceTypes: ["commit"] }).map((hit) => hit.sourceId).sort()).toEqual(expected);
    expect(readPublishedRaw(root, { query: "needle", sourceTypes: ["commit"] }).map((hit) => hit.sourceId).sort()).toEqual(expected);

    const chunkId = (store.db.prepare("select id from chunks where source_id=?").get(summaryHash) as { id: string }).id;
    expect(store.readSearchResultsByChunkIds([chunkId])).toHaveLength(1);
    expect(readPublishedChunks(root, [chunkId])).toHaveLength(1);
  });
});
