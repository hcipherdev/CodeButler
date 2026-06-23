import { afterEach, describe, expect, it } from "vitest";

import { openMemoryStore } from "../src/storage/store.js";
import type { TemporaryMemoryUpsertInput } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("temporary memory storage", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  function createStore() {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    return { rootDir, store };
  }

  function temporaryMemory(input: Partial<TemporaryMemoryUpsertInput> = {}): TemporaryMemoryUpsertInput {
    return {
      id: "temp-task",
      kind: "task_state",
      title: "Continue cache work",
      summary: "Continue wiring the temporary memory cache before durable memory.",
      details: "The current task is to keep compaction context available for src/cache.ts.",
      relatedFiles: ["src/cache.ts"],
      evidence: [{ sourceType: "conversation", sourceId: "codex:session-a", locator: "codex:session-a:chunk:0" }],
      confidence: 0.9,
      threadId: "thread-a",
      sessionId: "session-a",
      sourceAdapter: "codex",
      createdAt: "2026-06-18T08:00:00.000Z",
      updatedAt: "2026-06-18T08:00:00.000Z",
      expiresAt: "2026-06-19T08:00:00.000Z",
      ...input
    };
  }

  it("creates and searches temporary memories", () => {
    const { store } = createStore();

    const created = store.upsertTemporaryMemory(temporaryMemory());
    const results = store.searchTemporaryMemory({
      query: "temporary memory cache",
      threadId: "thread-a",
      sessionId: "session-a",
      now: "2026-06-18T09:00:00.000Z"
    });

    expect(created.id).toBe("temp-task");
    expect(results[0]).toMatchObject({
      id: "temp-task",
      kind: "task_state",
      relatedFiles: ["src/cache.ts"],
      evidence: [{ sourceType: "conversation", sourceId: "codex:session-a", locator: "codex:session-a:chunk:0" }]
    });
    store.close();
  });

  it("excludes expired items and deletes expired records only", () => {
    const { store } = createStore();
    store.upsertTemporaryMemory(temporaryMemory({ id: "expired", expiresAt: "2026-06-18T07:59:00.000Z" }));
    store.upsertTemporaryMemory(temporaryMemory({ id: "active", expiresAt: "2026-06-19T08:00:00.000Z" }));

    expect(
      store.searchTemporaryMemory({
        query: "temporary memory cache",
        now: "2026-06-18T09:00:00.000Z"
      }).map((memory) => memory.id)
    ).toEqual(["active"]);
    expect(store.deleteExpiredTemporaryMemories({ now: "2026-06-18T09:00:00.000Z" })).toBe(1);
    expect(store.listActiveTemporaryMemory({ now: "2026-06-18T09:00:00.000Z" }).map((memory) => memory.id)).toEqual([
      "active"
    ]);
    store.close();
  });

  it("ranks current thread and session before project-wide temporary memory", () => {
    const { store } = createStore();
    store.upsertTemporaryMemory(
      temporaryMemory({
        id: "other-session",
        threadId: "thread-b",
        sessionId: "session-b",
        updatedAt: "2026-06-18T09:30:00.000Z",
        summary: "Continue temporary memory cache work from another session."
      })
    );
    store.upsertTemporaryMemory(
      temporaryMemory({
        id: "current-session",
        threadId: "thread-a",
        sessionId: "session-a",
        updatedAt: "2026-06-18T08:30:00.000Z",
        summary: "Continue temporary memory cache work from the active session."
      })
    );

    const results = store.searchTemporaryMemory({
      query: "temporary memory cache",
      threadId: "thread-a",
      sessionId: "session-a",
      now: "2026-06-18T10:00:00.000Z"
    });

    expect(results.map((memory) => memory.id)).toEqual(["current-session", "other-session"]);
    store.close();
  });
});
