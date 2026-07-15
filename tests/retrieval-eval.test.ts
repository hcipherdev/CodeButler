import { describe, expect, it } from "vitest";

import { computeRetrievalMetrics, hybridRecallGate } from "../scripts/eval-retrieval.js";

describe("retrieval evaluation metrics", () => {
  it("computes mean recall at K and reciprocal rank", () => {
    const metrics = computeRetrievalMetrics([
      { expected: ["a", "b"], returned: ["x", "a", "b"] },
      { expected: ["c"], returned: ["c", "x"] }
    ], [1, 3]);
    expect(metrics.recallAt).toEqual({ "1": 0.5, "3": 1 });
    expect(metrics.mrr).toBe(0.75);
  });

  it("counts duplicate returned evidence at most once", () => {
    const metrics = computeRetrievalMetrics([{ expected: ["a"], returned: ["a", "a"] }], [2]);
    expect(metrics.recallAt).toEqual({ "2": 1 });
    expect(metrics.mrr).toBe(1);
  });

  it("fails hybrid recall below either live FTS or checked baseline", () => {
    expect(hybridRecallGate(0.9, 0.8, 0.7)).toBe(true);
    expect(hybridRecallGate(0.7, 0.8, 0.7)).toBe(false);
    expect(hybridRecallGate(0.75, 0.7, 0.8)).toBe(false);
  });
});
