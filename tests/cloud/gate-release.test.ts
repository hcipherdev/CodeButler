// Tests releaseProjectGateDuring() and the longest-hold log written by withProjectGate() in src/cloud/gate.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readProjectOperationStatus, releaseProjectGateDuring, withProjectGate } from "../../src/cloud/gate.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

describe("releasing the project gate during model calls", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) cleanupTempDir(root); });
  const project = () => { const root = makeTempDir(); roots.push(root); return root; };
  const timing = (root: string) => JSON.parse(readFileSync(join(root, ".code-butler", "gate-timing.json"), "utf8")) as {
    operation: string; holdMs: number; longest: Array<{ operation: string; holdMs: number; recordedAt: string; waitMs: number }>;
  };

  it("lets another operation run while the holder waits, then takes the gate back", async () => {
    const root = project();
    const order: string[] = [];
    let otherFinished!: Promise<void>;
    await withProjectGate(root, async () => {
      order.push("holder before");
      await releaseProjectGateDuring(root, async () => {
        expect(readProjectOperationStatus(root)).toBeUndefined();
        otherFinished = withProjectGate(root, () => { order.push("other"); }, { name: "Other", waitMs: 2_000 });
        await otherFinished;
      });
      expect(readProjectOperationStatus(root)).toMatchObject({ name: "Holder", pid: process.pid });
      order.push("holder after");
    }, { name: "Holder" });
    expect(order).toEqual(["holder before", "other", "holder after"]);
  });

  it("waits for an operation that took the gate before handing it back", async () => {
    const root = project();
    let release!: () => void;
    let otherHolding!: Promise<void>;
    let otherEntered!: () => void;
    const otherAcquired = new Promise<void>(resolve => { otherEntered = resolve; });
    const order: string[] = [];
    const holder = withProjectGate(root, async () => {
      await releaseProjectGateDuring(root, async () => {
        otherHolding = withProjectGate(root, async () => {
          otherEntered();
          await new Promise<void>(resolve => { release = resolve; });
          order.push("other done");
        }, { waitMs: 2_000 });
        await otherAcquired;
      });
      order.push("holder resumed");
    }, { name: "Holder" });
    await otherAcquired;
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(order).toEqual([]);
    release();
    await Promise.all([holder, otherHolding]);
    expect(order).toEqual(["other done", "holder resumed"]);
  }, 10_000);

  it("runs the work directly when the caller does not hold the gate", async () => {
    const root = project();
    await expect(releaseProjectGateDuring(root, async () => "ran")).resolves.toBe("ran");
    expect(readProjectOperationStatus(root)).toBeUndefined();
  });

  it("excludes released time from the recorded hold and keeps the longest recent holds", async () => {
    const root = project();
    await withProjectGate(root, async () => {
      await releaseProjectGateDuring(root, () => new Promise(resolve => setTimeout(resolve, 300)));
    }, { name: "Released holder" });
    expect(timing(root)).toMatchObject({ operation: "Released holder" });
    expect(timing(root).holdMs).toBeLessThan(250);

    const path = join(root, ".code-butler", "gate-timing.json");
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    writeFileSync(path, JSON.stringify({ longest: [
      { operation: "Stale", holdMs: 99_000, waitMs: 0, recordedAt: old },
      ...Array.from({ length: 12 }, (_, index) => ({ operation: `Recent ${index}`, holdMs: 1_000 + index, waitMs: 0, recordedAt: recent }))
    ] }));
    await withProjectGate(root, () => undefined, { name: "Quick" });
    const longest = timing(root).longest;
    expect(longest).toHaveLength(10);
    expect(longest.map(item => item.operation)).not.toContain("Stale");
    expect(longest[0]).toMatchObject({ operation: "Recent 11", holdMs: 1_011 });
    expect(longest.map(item => item.holdMs)).toEqual([...longest.map(item => item.holdMs)].sort((left, right) => right - left));
  });
});
