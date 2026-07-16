import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { prunePrivacySources } from "../src/privacy/service.js";
import { openMemoryStore } from "../src/storage/store.js";
import type { RetentionConfig } from "../src/types.js";

describe("privacy retention", () => {
  it("selects expired sources by adapter and exact overrides without mutating in dry-run mode", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "code-butler-retention-"));
    const store = openMemoryStore(rootDir);
    store.init();
    addSource(store, "old-codex", "codex", "2026-01-01T00:00:00.000Z");
    addSource(store, "old-manual", "manual", "2026-01-01T00:00:00.000Z");
    addSource(store, "override-keep", "codex", "2026-01-01T00:00:00.000Z");
    addSource(store, "override-delete", "manual", "2026-07-01T00:00:00.000Z");
    const retention: RetentionConfig = {
      migrationBackups: 5,
      sources: {
        git: { maxAgeDays: null },
        codex: { maxAgeDays: 30 },
        claude: { maxAgeDays: null },
        manual: { maxAgeDays: null }
      },
      overrides: [
        { sourceId: "override-keep", maxAgeDays: null },
        { sourceId: "override-delete", maxAgeDays: 7 }
      ]
    };

    const result = prunePrivacySources(store, retention, {
      apply: false,
      now: () => new Date("2026-07-16T00:00:00.000Z")
    });

    expect(result.sourceIdHashes).toHaveLength(2);
    expect(result.selected).toBe(2);
    expect(result.deleted).toBe(0);
    expect(store.readSource("old-codex")).toBeTruthy();
    expect(store.readSource("override-delete")).toBeTruthy();
    store.close();
  });

  it("applies selected retention deletion and leaves indefinite sources intact", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "code-butler-retention-apply-"));
    const store = openMemoryStore(rootDir);
    store.init();
    addSource(store, "old-codex", "codex", "2026-01-01T00:00:00.000Z");
    addSource(store, "old-manual", "manual", "2026-01-01T00:00:00.000Z");
    const retention: RetentionConfig = {
      migrationBackups: 5,
      sources: {
        git: { maxAgeDays: null },
        codex: { maxAgeDays: 30 },
        claude: { maxAgeDays: null },
        manual: { maxAgeDays: null }
      },
      overrides: []
    };

    const result = prunePrivacySources(store, retention, {
      apply: true,
      now: () => new Date("2026-07-16T00:00:00.000Z")
    });

    expect(result).toMatchObject({ selected: 1, deleted: 1 });
    expect(store.readSource("old-codex")).toBeUndefined();
    expect(store.readSource("old-manual")).toBeTruthy();
    store.close();
  });
});

function addSource(
  store: ReturnType<typeof openMemoryStore>,
  id: string,
  adapter: string,
  createdAt: string
): void {
  store.addSourceWithChunks({
    source: {
      id,
      type: "conversation",
      title: id,
      origin: adapter,
      rawContent: id,
      metadata: { adapter }
    },
    chunks: [{ text: id }]
  });
  store.db.prepare("update sources set created_at = ? where id = ?").run(createdAt, id);
}
