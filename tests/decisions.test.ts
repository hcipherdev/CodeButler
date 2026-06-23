import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { addDecision, findDecisions, importDecisionMarkdown } from "../src/decisions/store.js";
import { openMemoryStore } from "../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("decision records", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  it("stores manual decisions with evidence refs", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();

    const decision = addDecision(store, {
      topic: "caching layer",
      decision: "Invalidate cache after writes",
      reason: "Avoid stale reads after mutation",
      status: "accepted",
      evidence: [{ sourceType: "conversation", sourceId: "conv-1", locator: "turn_42" }]
    });

    const results = findDecisions(store, { topic: "cache" });

    expect(decision.id).toMatch(/^DEC-/);
    expect(results[0]).toMatchObject({
      id: decision.id,
      topic: "caching layer",
      decision: "Invalidate cache after writes",
      evidence: [{ sourceType: "conversation", sourceId: "conv-1", locator: "turn_42" }]
    });

    store.close();
  });

  it("imports markdown decision files", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    mkdirSync(join(rootDir, "docs"), { recursive: true });
    const decisionFile = join(rootDir, "docs", "decision.md");
    writeFileSync(
      decisionFile,
      [
        "# Decision: caching layer",
        "",
        "Status: accepted",
        "",
        "Decision: Invalidate cache after writes",
        "",
        "Reason: Avoid stale reads after mutation",
        "",
        "Evidence:",
        "- conversation:conv-1#turn_42",
        "- commit:a1b2c3d"
      ].join("\n")
    );

    const store = openMemoryStore(rootDir);
    store.init();
    const decision = importDecisionMarkdown(store, decisionFile);

    expect(decision.topic).toBe("caching layer");
    expect(decision.evidence).toEqual([
      { sourceType: "conversation", sourceId: "conv-1", locator: "turn_42" },
      { sourceType: "commit", sourceId: "a1b2c3d" }
    ]);

    store.close();
  });
});
