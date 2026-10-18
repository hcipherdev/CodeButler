import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertNoDatabaseHandles, withProjectGate } from "../src/cloud/gate.js";
import { captureSnapshot } from "../src/cloud/snapshot.js";
import { ensureProjectConfig } from "../src/config.js";
import { openConfiguredMemoryStore } from "../src/storage/open-configured-store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanupTempDir(root); });

it("releases the project gate and database handle before slow snapshot export", async () => {
  const directory = makeTempDir(); roots.push(directory);
  const root = join(directory, "project"); mkdirSync(root);
  ensureProjectConfig(root);
  const store = openConfiguredMemoryStore(root); store.init(); store.close();
  let allowExport!: () => void;
  let copyFinished!: () => void;
  const entered = new Promise<void>(resolve => { copyFinished = resolve; });
  const paused = new Promise<void>(resolve => { allowExport = resolve; });
  const snapshot = captureSnapshot(root, randomUUID(), 0, undefined, "durable", {
    afterCopy: async () => { copyFinished(); await paused; }
  });
  await entered;
  expect(await withProjectGate(root, () => { assertNoDatabaseHandles(root); return "review acquired"; },
    { name: "Prepare AI review", waitMs: 1_000 })).toBe("review acquired");
  allowExport();
  expect((await snapshot).snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
});
