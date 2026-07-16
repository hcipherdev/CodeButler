import { afterEach, describe, expect, it } from "vitest";

import { openMemoryStore } from "../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("source failure storage", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs.length = 0;
  });

  it("deduplicates repeated failures, sanitizes messages, and resolves repaired paths", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    const path = "/logs/session.jsonl";

    store.recordSourceFailure({
      adapter: "codex",
      path,
      errorCode: "invalid_jsonl",
      message: "Malformed line with api_key=sk-proj-abcdefghijklmnop",
      occurredAt: "2026-07-15T10:00:00.000Z"
    });
    store.recordSourceFailure({
      adapter: "codex",
      path,
      errorCode: "invalid_jsonl",
      message: "Malformed again\nwith control\u0000 text api_key=sk-proj-qrstuvwxyzabcdef",
      occurredAt: "2026-07-15T11:00:00.000Z"
    });

    expect(store.listSourceFailures()).toEqual([
      expect.objectContaining({
        adapter: "codex",
        path,
        errorCode: "invalid_jsonl",
        attempts: 2,
        firstOccurredAt: "2026-07-15T10:00:00.000Z",
        lastOccurredAt: "2026-07-15T11:00:00.000Z"
      })
    ]);
    expect(store.listSourceFailures()[0]?.message).not.toContain("sk-proj-");
    expect(store.listSourceFailures()[0]?.message).not.toContain("\u0000");

    expect(store.resolveSourceFailures("codex", path, "2026-07-15T12:00:00.000Z")).toBe(1);
    expect(store.listSourceFailures()).toEqual([]);
    expect(store.listSourceFailures({ resolved: true })).toEqual([
      expect.objectContaining({ resolvedAt: "2026-07-15T12:00:00.000Z", attempts: 2 })
    ]);
    store.close();
  });

  it("filters by adapter and returns stable newest-first bounded rows", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.recordSourceFailure({ adapter: "claude", path: "/b", errorCode: "read_failed", message: "b", occurredAt: "2026-07-15T11:00:00.000Z" });
    store.recordSourceFailure({ adapter: "codex", path: "/a", errorCode: "invalid_jsonl", message: "a", occurredAt: "2026-07-15T10:00:00.000Z" });

    expect(store.listSourceFailures({ adapter: "claude", limit: 1 }).map((failure) => failure.path)).toEqual(["/b"]);
    expect(store.listSourceFailures({ limit: 1 }).map((failure) => failure.path)).toEqual(["/b"]);
    store.close();
  });
});
