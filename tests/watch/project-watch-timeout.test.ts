// Tests projectWatchExpired() in src/global-watch.ts, which decides when the global watcher stops a project pass.
import { describe, expect, it } from "vitest";

import { projectWatchExpired } from "../../src/global-watch.js";

const minute = 60 * 1000, start = Date.parse("2026-10-14T11:08:00.000Z");

describe("project watch time limit", () => {
  it("stops a pass that reports no progress for ten minutes", () => {
    expect(projectWatchExpired(start, undefined, start + 9 * minute)).toBe(false);
    expect(projectWatchExpired(start, undefined, start + 10 * minute)).toBe(true);
  });

  it("keeps a pass that is still reporting progress, such as a long upload", () => {
    expect(projectWatchExpired(start, start + 9 * minute, start + 12 * minute)).toBe(false);
    expect(projectWatchExpired(start, start + 30 * minute, start + 38 * minute)).toBe(false);
    expect(projectWatchExpired(start, start + 30 * minute, start + 40 * minute)).toBe(true);
  });

  it("ignores progress left by an earlier worker and stops any pass after an hour", () => {
    expect(projectWatchExpired(start, start - 5 * minute, start + 10 * minute)).toBe(true);
    expect(projectWatchExpired(start, start + 59 * minute, start + 60 * minute)).toBe(true);
  });
});
