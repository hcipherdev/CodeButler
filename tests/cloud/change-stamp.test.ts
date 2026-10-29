// Tests localCloudChangeStamp() in src/cloud/client.ts when a WAL file disappears between listing and stat.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const vanished = new Set<string>();
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readdirSync = ((path: string, ...rest: unknown[]) => {
    const names = (actual.readdirSync as (...args: unknown[]) => string[])(path, ...rest);
    return [...names, ...[...vanished].filter((name) => !names.includes(name))];
  }) as typeof actual.readdirSync;
  return { ...actual, default: { ...actual, readdirSync }, readdirSync };
});

const { localCloudChangeStamp } = await import("../../src/cloud/client.js");
const roots: string[] = [];

afterEach(() => { vanished.clear(); roots.splice(0).forEach(cleanupTempDir); });

describe("localCloudChangeStamp", () => {
  it("treats a WAL that vanished after the directory listing as absent", () => {
    const root = makeTempDir(); roots.push(root);
    mkdirSync(join(root, ".code-butler"));
    writeFileSync(join(root, ".code-butler", "config.json"), "{}");
    const before = localCloudChangeStamp(root);
    vanished.add("memory.sqlite-wal");
    expect(localCloudChangeStamp(root)).toBe(before);
  });
});
