import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseConversationFile } from "../src/ingest/conversation.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("conversation ingestion", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  function tempProject(): string {
    const dir = makeTempDir();
    tempDirs.push(dir);
    mkdirSync(join(dir, "conversations"), { recursive: true });
    return dir;
  }

  it("chunks markdown conversations deterministically", () => {
    const dir = tempProject();
    const file = join(dir, "conversations", "cache.md");
    writeFileSync(
      file,
      [
        "# Cache discussion",
        "",
        "We rejected time-based invalidation because stale reads remained possible.",
        "",
        "We chose invalidating cache entries after writes."
      ].join("\n")
    );

    const parsed = parseConversationFile(file);

    expect(parsed.source.type).toBe("conversation");
    expect(parsed.source.title).toBe("cache.md");
    expect(parsed.source.rawContent).toContain("stale reads");
    expect(parsed.chunks.map((chunk) => chunk.chunkIndex)).toEqual([0]);
    expect(parsed.chunks[0]?.text).toContain("invalidating cache entries");
  });

  it("preserves jsonl turn metadata", () => {
    const dir = tempProject();
    const file = join(dir, "conversations", "session.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({
          turn_id: "turn_1",
          role: "user",
          content: "Why did we change src/cache.ts?",
          timestamp: "2026-06-01T10:00:00Z"
        }),
        JSON.stringify({
          turn_id: "turn_2",
          role: "assistant",
          content: "The write path needed explicit invalidation.",
          timestamp: "2026-06-01T10:01:00Z"
        })
      ].join("\n")
    );

    const parsed = parseConversationFile(file);

    expect(parsed.chunks).toHaveLength(2);
    expect(parsed.chunks[0]?.metadata).toMatchObject({
      turn_id: "turn_1",
      role: "user",
      timestamp: "2026-06-01T10:00:00Z"
    });
    expect(parsed.chunks[1]?.text).toBe("The write path needed explicit invalidation.");
  });
});
