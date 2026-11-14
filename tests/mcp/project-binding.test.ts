// Tests prepareMcpProject() in src/mcp/project-binding.ts: an MCP start never waits on, or fails because of, a busy project lock.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withProjectGate } from "../../src/cloud/gate.js";
import { ensureProjectConfig } from "../../src/config.js";
import { prepareMcpProject } from "../../src/mcp/project-binding.js";
import { openConfiguredMemoryStore } from "../../src/storage/open-configured-store.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) cleanupTempDir(root); });

/** Holds the project lock until the returned release is called, like another server's startup sync. */
async function holdLock(root: string): Promise<() => Promise<void>> {
  let release!: () => void;
  let held!: () => void;
  const holding = new Promise<void>(resolve => { held = resolve; });
  const holder = withProjectGate(root, () => new Promise<void>(resolve => { held(); release = resolve; }));
  await holding;
  return async () => { release(); await holder; };
}

describe("preparing an MCP project", () => {
  it("returns at once for an existing project while another operation holds the lock", async () => {
    const root = makeTempDir(); roots.push(root);
    ensureProjectConfig(root);
    const store = openConfiguredMemoryStore(root); store.init(); store.close();
    const release = await holdLock(root);
    try {
      const started = Date.now();
      expect(await prepareMcpProject(root, true)).toEqual({ configCreated: false, databaseCreated: false });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally { await release(); }
  });

  it("starts anyway when a new project's lock stays busy, and sets it up once free", async () => {
    const root = makeTempDir(); roots.push(root);
    mkdirSync(join(root, ".code-butler"), { recursive: true });
    const release = await holdLock(root);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await prepareMcpProject(root, true)).toEqual({ configCreated: true, databaseCreated: true });
      expect(errors).toHaveBeenCalledWith("Code Butler is busy with another operation on this project; starting anyway");
    } finally { await release(); }
    await prepareMcpProject(root, true);
    expect(existsSync(join(root, ".code-butler", "config.json"))).toBe(true);
    expect(existsSync(join(root, ".code-butler", "memory.sqlite"))).toBe(true);
  }, 30_000);
});
