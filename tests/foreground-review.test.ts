import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { activeForegroundIntent, beginForegroundIntent, renewForegroundIntent } from "../src/cloud/foreground.js";
import { withProjectGate } from "../src/cloud/gate.js";
import { OperationDeferredError } from "../src/cloud/outcome.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanupTempDir(root); });

function project(): string {
  const directory = makeTempDir(); roots.push(directory);
  const root = join(directory, "project"); mkdirSync(root);
  return root;
}

it("lets a foreground intent defer new watcher gate entries and releases on completion", async () => {
  const root = project();
  const intent = beginForegroundIntent(root);
  expect(activeForegroundIntent(root)?.id).toBe(intent.id);
  await expect(withProjectGate(root, () => "background", { background: true, waitMs: 100 }))
    .rejects.toBeInstanceOf(OperationDeferredError);
  expect(await withProjectGate(root, () => "foreground", { name: "Prepare AI review" })).toBe("foreground");
  intent.release();
  expect(activeForegroundIntent(root)).toBeUndefined();
  expect(await withProjectGate(root, () => "background", { background: true, waitMs: 100 })).toBe("background");
});

it("expires an abandoned intent and allows watcher work to recover", async () => {
  const root = project();
  const id = randomUUID();
  renewForegroundIntent(root, id);
  const path = join(root, ".code-butler", ".foreground-intents", `${id}.json`);
  const prior = JSON.parse(readFileSync(path, "utf8")) as { id: string; requestedAt: number };
  writeFileSync(path, JSON.stringify({ ...prior, expiresAt: Date.now() - 1 }));
  expect(activeForegroundIntent(root)).toBeUndefined();
  expect(existsSync(path)).toBe(false);
  expect(await withProjectGate(root, () => "recovered", { background: true, waitMs: 100 })).toBe("recovered");
});
