// Tests the "project.sources" desktop action in src/desktop/service.ts and countSourcesByType() in src/storage/store.ts.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ensureProjectConfig } from "../../src/config.js";
import { registerWatchedProject } from "../../src/global-watch.js";
import { handleDesktopRequest } from "../../src/desktop/service.js";
import { openMemoryStore } from "../../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

let directory: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (directory) cleanupTempDir(directory);
  directory = undefined;
});

it("reports source counts, adapter checks, and unresolved failures without adapter metadata", async () => {
  directory = makeTempDir();
  const root = join(directory, "project");
  vi.stubEnv("CODE_BUTLER_HOME", join(directory, "home"));
  vi.stubEnv("CODE_BUTLER_RETRIEVAL_ENGINE", "legacy");
  mkdirSync(root);
  ensureProjectConfig(root);
  registerWatchedProject(root);
  const store = openMemoryStore(root);
  store.init();
  try {
    store.addSourceWithChunks({ source: { id: "commit-1", type: "commit", title: "Add sync", origin: "git", rawContent: "Add sync" }, chunks: [{ text: "Add sync" }] });
    store.addSourceWithChunks({ source: { id: "chat-1", type: "conversation", title: "Plan", origin: "codex", rawContent: "Plan" }, chunks: [{ text: "Plan" }] });
    store.addSourceWithChunks({ source: { id: "chat-2", type: "conversation", title: "Review", origin: "claude", rawContent: "Review" }, chunks: [{ text: "Review" }] });
    store.recordSyncStatus({ source: "git", enabled: true, lastSyncAt: "2026-10-20T10:00:00.000Z", lastSuccessAt: "2026-10-20T10:00:00.000Z", metadata: { cursor: "abc" } });
    store.recordSyncStatus({ source: "codex", enabled: true, lastSyncAt: "2026-10-20T10:05:00.000Z", lastError: "Log folder is unreadable." });
    store.recordSourceFailure({ adapter: "codex", path: "/logs/broken.jsonl", errorCode: "invalid_jsonl", message: "The conversation log contains invalid JSONL.", occurredAt: "2026-10-20T10:05:00.000Z" });
    store.recordSourceFailure({ adapter: "claude", path: "/logs/fixed.jsonl", errorCode: "read_failed", message: "The conversation log could not be read.", occurredAt: "2026-10-20T09:00:00.000Z" });
    store.resolveSourceFailures("claude", "/logs/fixed.jsonl", "2026-10-20T09:30:00.000Z");
  } finally { store.close(); }

  const result = await handleDesktopRequest({ version: 1, action: "project.sources", root }) as {
    byType: Record<string, number>; adapters: Array<Record<string, unknown>>; failures: Array<{ path: string }>;
  };

  expect(result.byType).toEqual({ conversation: 2, commit: 1, decision: 0 });
  expect(result.adapters).toEqual([
    expect.objectContaining({ source: "codex", enabled: true, lastError: "Log folder is unreadable." }),
    expect.objectContaining({ source: "git", enabled: true, lastSuccessAt: "2026-10-20T10:00:00.000Z" })
  ]);
  expect(result.adapters.every(adapter => !("metadata" in adapter))).toBe(true);
  expect(result.failures.map(failure => failure.path)).toEqual(["/logs/broken.jsonl"]);
});
