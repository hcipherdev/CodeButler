// Tests the review.automatic and extraction sections of validateProjectConfigFile(), automaticReviewPolicy() and extractionPolicy() in src/config.ts.
import { describe, expect, it } from "vitest";

import {
  automaticReviewPolicy,
  DEFAULT_AUTOMATIC_REVIEW_CONFIG,
  DEFAULT_EXTRACTION_CONFIG,
  extractionPolicy,
  validateProjectConfigFile
} from "../../src/config.js";

describe("review and extraction config", () => {
  it("defaults the daily review to on, 100 memories, current and obsolete verdicts", () => {
    expect(automaticReviewPolicy({})).toEqual({ enabled: true, dailyItems: 100, tokenBudget: 1_500_000, applyVerdicts: ["current", "obsolete"] });
    expect(automaticReviewPolicy({ review: { automatic: { ...DEFAULT_AUTOMATIC_REVIEW_CONFIG, dailyItems: 40 } } }).dailyItems).toBe(40);
    expect(extractionPolicy({})).toEqual(DEFAULT_EXTRACTION_CONFIG);
  });

  it("rejects unknown keys and invalid values", () => {
    expect(() => validateProjectConfigFile({ review: { automatic: { enabled: false, dailyItems: 10, applyVerdicts: ["current"] } } })).not.toThrow();
    expect(() => validateProjectConfigFile({ review: { automatic: { dailyItems: 0 } } })).toThrow("review.automatic.dailyItems");
    expect(() => validateProjectConfigFile({ review: { automatic: { applyVerdicts: ["changed"] } } })).toThrow("applyVerdicts");
    expect(() => validateProjectConfigFile({ review: { manual: {} } })).toThrow();
    expect(() => validateProjectConfigFile({ extraction: { overlapChunks: -1 } })).toThrow("extraction.overlapChunks");
  });
});
