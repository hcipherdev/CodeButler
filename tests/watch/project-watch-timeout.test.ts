// Tests projectWatchExpired() and SleepTracker in src/global-watch.ts, which decide when the global watcher stops a project pass, without counting time the machine slept.
import { describe, expect, it } from "vitest";

import { projectWatchExpired, SleepTracker } from "../../src/global-watch.js";

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

  it("does not stop a pass that was only frozen by sleep", () => {
    // Started in a Power Nap wake, slept 15 minutes, and the first check runs on the next wake.
    const tracker = new SleepTracker(start);
    tracker.observe(start + 20_000);
    const woke = start + 20_000 + 15 * minute;
    tracker.observe(woke);
    expect(tracker).toMatchObject({ sleptMs: 15 * minute, resumedAt: woke });
    expect(projectWatchExpired(start, undefined, woke, tracker)).toBe(false);
    // Awake time still counts: ten idle minutes after waking is a stuck pass.
    expect(projectWatchExpired(start, undefined, woke + 9 * minute, tracker)).toBe(false);
    expect(projectWatchExpired(start, undefined, woke + 10 * minute, tracker)).toBe(true);
  });

  it("counts only awake time toward the one-hour limit, and ignores ordinary heartbeat gaps", () => {
    const tracker = new SleepTracker(start);
    for (let at = start + 1_000; at <= start + 25_000; at += 1_000) tracker.observe(at);
    expect(tracker.sleptMs).toBe(0);
    tracker.observe(start + 25_000 + 30 * minute);
    const late = start + 70 * minute;
    expect(projectWatchExpired(start, late - minute, late, tracker)).toBe(false);
    expect(projectWatchExpired(start, late + 19 * minute, late + 21 * minute, tracker)).toBe(true);
  });
});
