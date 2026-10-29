// Tests incremental conversation extraction in src/sync/service.ts (extractionContext(), syncProjectMemory(), syncWatchedProjectMemory()) with the cursors and quiet window in src/extract/cursor.ts and the contextOnly evidence rule in src/extract/parse.ts.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureProjectConfig, loadProjectConfig } from "../../src/config.js";
import { readExtractedMemories } from "../../src/extract/parse.js";
import { runExtractionCommand } from "../../src/cli/commands/extraction.js";
import { openMemoryStore, type MemoryStore } from "../../src/storage/store.js";
import { syncProjectMemory, syncWatchedProjectMemory } from "../../src/sync/service.js";
import type { ExtractorContext, ExtractorProvider, ExtractorResult, ProjectConfig } from "../../src/types.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const roots: string[] = [];
let originalHome: string | undefined;

// Watcher passes write device-local state under CODE_BUTLER_HOME; keep it out of the real one.
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

interface Fixture { root: string; repo: string; log: string }

function message(repo: string, index: number, minute = index): string {
  return JSON.stringify({
    type: index % 2 === 0 ? "user" : "assistant",
    timestamp: `2026-10-01T10:${String(minute).padStart(2, "0")}:00Z`,
    sessionId: "session-a",
    cwd: repo,
    message: { role: index % 2 === 0 ? "user" : "assistant", content: `Message ${index}: uploads resume from the last confirmed block.` }
  });
}

function fixture(extraction: Record<string, number> = {}, messages = 3): Fixture {
  const root = makeTempDir(); roots.push(root);
  const repo = join(root, "repo");
  const claudeDir = join(root, "claude", "projects", "project-a");
  mkdirSync(repo, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git(["init"]); git(["config", "user.email", "t@example.com"]); git(["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "fixture\n"); git(["add", "README.md"]); git(["commit", "-m", "init"]);
  const log = join(claudeDir, "session-a.jsonl");
  writeFileSync(log, Array.from({ length: messages }, (_, index) => message(repo, index)).join("\n"));
  ensureProjectConfig(root);
  writeFileSync(join(root, ".code-butler", "config.json"), JSON.stringify({
    sources: {
      git: { enabled: false, repoPath: "./repo" },
      codex: { enabled: false },
      claude: { enabled: true, roots: ["./claude/projects"] }
    },
    extractor: { provider: "openai-compatible", baseUrl: "https://example.test/v1", model: "test", apiKeyEnv: "TEST_API_KEY" },
    extraction
  }));
  return { root, repo, log };
}

function grow(f: Fixture, from: number, to: number): void {
  appendFileSync(f.log, "\n" + Array.from({ length: to - from }, (_, offset) => message(f.repo, from + offset)).join("\n"));
}

/** Records what each call was sent; returns one memory citing the first new message. */
function recordingExtractor(onCall?: (context: ExtractorContext) => void | Promise<void>): ExtractorProvider & { calls: Array<{ ids: string[]; contextOnly: string[] }> } {
  const calls: Array<{ ids: string[]; contextOnly: string[] }> = [];
  return {
    calls,
    async extract(context): Promise<ExtractorResult> {
      const chunks = context.conversations.flatMap((conversation) => conversation.chunks ?? []);
      calls.push({ ids: chunks.map((chunk) => chunk.id!), contextOnly: chunks.filter((chunk) => chunk.contextOnly).map((chunk) => chunk.id!) });
      await onCall?.(context);
      const fresh = chunks.find((chunk) => !chunk.contextOnly);
      return {
        memories: fresh ? [{
          type: "decision", title: `Resumable uploads ${calls.length}`, summary: "Uploads resume from the last confirmed block.",
          reason: "Large vaults time out.", confidence: 0.9, relatedFiles: [], dedupeKey: `resumable-${calls.length}`,
          evidence: [{ sourceType: "conversation", sourceId: fresh.sourceId!, locator: fresh.id! }]
        }] : [],
        rejected: []
      };
    }
  };
}

const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, offset) => `claude:session-a:chunk:${from + offset}`);

async function sync(f: Fixture, extractor: ExtractorProvider, options: { honorQuietWindow?: boolean } = {}) {
  const store = openMemoryStore(f.root); store.init();
  try { return await syncProjectMemory(store, loadProjectConfig(f.root), { source: "claude", extractorProvider: extractor, ...options }); }
  finally { store.close(); }
}

function withStore<T>(f: Fixture, work: (store: MemoryStore) => T): T {
  const store = openMemoryStore(f.root); store.init();
  try { return work(store); } finally { store.close(); }
}

describe("incremental conversation extraction", () => {
  it("sends only new messages, with already-extracted ones as context", async () => {
    const f = fixture({ overlapChunks: 2 });
    const extractor = recordingExtractor();
    await sync(f, extractor);
    expect(extractor.calls[0]).toEqual({ ids: ids(0, 3), contextOnly: [] });

    grow(f, 3, 5);
    const result = await sync(f, extractor);
    expect(extractor.calls[1]).toEqual({ ids: ids(1, 5), contextOnly: ids(1, 3) });
    expect(result.memories.pending).toBe(0);

    await sync(f, extractor);
    expect(extractor.calls).toHaveLength(2);
  });

  it("starts over when the log was rewritten rather than appended to", async () => {
    const f = fixture({ overlapChunks: 2 });
    const extractor = recordingExtractor();
    await sync(f, extractor);
    writeFileSync(f.log, [message(f.repo, 0, 30), message(f.repo, 1, 31), message(f.repo, 7, 32), message(f.repo, 8, 33)].join("\n"));
    await sync(f, extractor);
    expect(extractor.calls[1]).toEqual({ ids: ids(0, 4), contextOnly: [] });
  });

  it("re-reads a requeued conversation in full", async () => {
    const f = fixture({ overlapChunks: 2 });
    const extractor = recordingExtractor();
    await sync(f, extractor);
    await runExtractionCommand(["requeue", "--since", "2000-01-01T00:00:00Z"], f.root, () => {});
    await sync(f, extractor);
    expect(extractor.calls[1]).toEqual({ ids: ids(0, 3), contextOnly: [] });
  });

  it("seeds a cursor for a log extracted before cursors existed", async () => {
    const f = fixture({ overlapChunks: 1 });
    const extractor = recordingExtractor();
    await sync(f, extractor);
    withStore(f, (store) => store.localDb.exec("delete from conversation_extraction_cursors"));
    grow(f, 3, 4);
    await sync(f, extractor);
    expect(extractor.calls[1]).toEqual({ ids: ids(2, 4), contextOnly: ids(2, 3) });
  });

  it("lets an unattended pass wait for an active session, but not an explicit sync", async () => {
    const f = fixture({ conversationQuietMinutes: 10, maxDeltaChunks: 50 });
    const extractor = recordingExtractor();
    const waiting = await sync(f, extractor, { honorQuietWindow: true });
    expect(extractor.calls).toHaveLength(0);
    expect(waiting.memories.reason).toBe("Waiting for active sessions to go quiet");
    expect(waiting.memories.pending).toBe(1);

    await sync(f, extractor);
    expect(extractor.calls).toHaveLength(1);
  });

  it("does not wait once a session has a large backlog", async () => {
    const f = fixture({ conversationQuietMinutes: 10, maxDeltaChunks: 3 });
    const extractor = recordingExtractor();
    await sync(f, extractor, { honorQuietWindow: true });
    expect(extractor.calls).toHaveLength(1);
  });

  it("keeps a watcher result when the log grows during the model call, then extracts the rest", async () => {
    const f = fixture({ conversationQuietMinutes: 0, overlapChunks: 1 });
    let grown = false;
    const extractor = recordingExtractor(async () => {
      if (grown) return;
      grown = true;
      grow(f, 3, 5);
      // Another pass imports the growth while this model call is in flight.
      const store = openMemoryStore(f.root); store.init();
      try { await syncProjectMemory(store, loadProjectConfig(f.root), { source: "claude", stopAfterImport: true, extractorProvider: recordingExtractor() }); }
      finally { store.close(); }
    });
    const result = await syncWatchedProjectMemory(f.root, loadProjectConfig(f.root) as ProjectConfig, { source: "claude", extractorProvider: extractor });
    expect(extractor.calls.map((call) => call.ids)).toEqual([ids(0, 3), ids(2, 5)]);
    expect(result.memories.candidates).toBe(2);
    expect(result.memories.pending).toBe(0);
  });
});

describe("contextOnly evidence", () => {
  it("rejects a memory supported only by already-extracted messages", () => {
    const context: ExtractorContext = {
      conversations: [{ sourceId: "claude:s", title: "s", rawContent: "", chunks: [
        { id: "claude:s:chunk:0", chunkIndex: 0, text: "old", contextOnly: true },
        { id: "claude:s:chunk:1", chunkIndex: 1, text: "new" }
      ] }],
      commits: []
    };
    const record = (locator: string) => ({ type: "decision", title: "t", summary: "s.", reason: "r", confidence: 0.9, dedupeKey: "k", relatedFiles: [],
      evidence: [{ sourceType: "conversation", sourceId: "claude:s", locator }] });
    const result = readExtractedMemories({ memories: [record("claude:s:chunk:0"), record("claude:s:chunk:1")] }, context);
    expect(result.memories).toHaveLength(1);
    expect(result.rejected).toEqual([{ index: 0, reason: "context_only_evidence" }]);
  });
});
