// Tests snapshotFile() and applySnapshot() in src/cloud/snapshot.ts and how applyCoreMerge() in src/cloud/client.ts keep the current project narrative via preferIncomingNarrative() in src/project-summary/service.ts.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { applyCoreMerge } from "../../src/cloud/client.js";
import { applySnapshot, bundleResolver, captureSnapshot, materializeSnapshot, snapshotFile } from "../../src/cloud/snapshot.js";
import { stateDirectory } from "../../src/cloud/state.js";
import { rememberProjectMemory } from "../../src/memory/remember.js";
import { preferIncomingNarrative } from "../../src/project-summary/service.js";
import { openConfiguredMemoryStore } from "../../src/storage/open-configured-store.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const roots: string[] = [];
const temp = () => { const path = makeTempDir(); roots.push(path); return path; };
afterEach(() => { vi.unstubAllEnvs(); for (const path of roots.splice(0)) cleanupTempDir(path); });

const withStore = <T>(root: string, work: (store: ReturnType<typeof openConfiguredMemoryStore>) => T): T => {
  const store = openConfiguredMemoryStore(root);
  try { store.init(); return work(store); } finally { store.close(); }
};
const capture = async (root: string) => { const result = await captureSnapshot(root, randomUUID(), 0); return { manifest: result.snapshot, blocks: result.blocks }; };
const summaryPath = (root: string) => join(root, ".code-butler", "project-summary.md");
const metaPath = (root: string) => join(root, ".code-butler", "project-summary.meta.json");

/** A generated narrative: its text and the metadata recording when it was written. */
function writeNarrative(root: string, text: string, generatedAt: string, meta: Record<string, unknown> = {}): void {
  const content = `# Project summary\n\n${text}\n`;
  writeFileSync(summaryPath(root), content);
  writeFileSync(metaPath(root), JSON.stringify({ version: 1, format: 2, summaryPath: summaryPath(root), fingerprint: "f", lastGeneratedAt: generatedAt,
    lastCheckedAt: generatedAt, outputContentHash: createHash("sha256").update(content).digest("hex"), ...meta }));
}

/** Two checkouts that agreed on one memory; each then writes its own narrative and the cloud side adds a memory. */
async function diverged(local: (root: string) => void, cloud: (root: string) => void) {
  vi.stubEnv("CODE_BUTLER_HOME", temp());
  const here = temp(), there = temp();
  withStore(here, store => rememberProjectMemory(store, { type: "decision", text: "Subsystem 0 owns its own retry policy." }));
  mkdirSync(stateDirectory(here), { recursive: true });
  const ancestor = await capture(here);
  withStore(there, () => undefined);
  applySnapshot(there, materializeSnapshot(ancestor.manifest, bundleResolver(ancestor.blocks)));
  withStore(there, store => rememberProjectMemory(store, { type: "decision", text: "Subsystem 1 owns its own retry policy." }));
  local(here); cloud(there);
  return { here, ancestor, remote: await capture(there) };
}

it("reads one project file from a snapshot exactly as a full materialization does", async () => {
  const { remote } = await diverged(() => undefined, root => writeNarrative(root, "Cloud text.", "2026-10-26T07:00:00.000Z"));
  const full = materializeSnapshot(remote.manifest, bundleResolver(remote.blocks)).files.find(file => file.path === "project-summary.md")!.data;
  expect(snapshotFile(remote.manifest, bundleResolver(remote.blocks), "project-summary.md")).toEqual(full);
  expect(snapshotFile(remote.manifest, bundleResolver(remote.blocks), "missing.md")).toBeUndefined();
});

it("takes the other device's narrative and metadata when they were written later", async () => {
  const { here, ancestor, remote } = await diverged(
    root => writeNarrative(root, "Older local text.", "2026-10-20T07:00:00.000Z"),
    root => writeNarrative(root, "Newer cloud text.", "2026-10-25T19:45:50.000Z"));
  applyCoreMerge(here, remote, ancestor);
  expect(readFileSync(summaryPath(here), "utf8")).toContain("Newer cloud text.");
  expect(JSON.parse(readFileSync(metaPath(here), "utf8"))).toMatchObject({ lastGeneratedAt: "2026-10-25T19:45:50.000Z", summaryPath: summaryPath(here) });
}, 60000);

it("keeps this device's narrative when it is newer, edited by hand, or the other pair is unusable", async () => {
  const keeps = async (local: (root: string) => void, cloud: (root: string) => void, expected: string) => {
    const { here, ancestor, remote } = await diverged(local, cloud);
    applyCoreMerge(here, remote, ancestor);
    expect(readFileSync(summaryPath(here), "utf8")).toContain(expected);
  };
  await keeps(root => writeNarrative(root, "Newer local text.", "2026-10-25T19:45:50.000Z"),
    root => writeNarrative(root, "Older cloud text.", "2026-10-20T07:00:00.000Z"), "Newer local text.");
  await keeps(root => { writeNarrative(root, "Local text.", "2026-10-20T07:00:00.000Z"); writeFileSync(summaryPath(root), "# Project summary\n\nHand-edited local text.\n"); },
    root => writeNarrative(root, "Newer cloud text.", "2026-10-25T19:45:50.000Z"), "Hand-edited local text.");
  await keeps(root => writeNarrative(root, "Local text.", "2026-10-20T07:00:00.000Z"),
    root => { writeNarrative(root, "Newer cloud text.", "2026-10-25T19:45:50.000Z"); writeFileSync(metaPath(root), "{not json"); }, "Local text.");
}, 120000);

const basis = (commit: string, committedAt: string) => ({ basis: { commit, committedAt } });
const fastForward = (root: string, remote: Awaited<ReturnType<typeof capture>>) => applySnapshot(root, materializeSnapshot(remote.manifest, bundleResolver(remote.blocks)));
const meta = (root: string) => JSON.parse(readFileSync(metaPath(root), "utf8"));

it("keeps a narrative built from later commits over one written later from earlier commits", async () => {
  const local = (root: string) => writeNarrative(root, "Local text from newer commits.", "2026-10-24T19:41:00.000Z",
    { ...basis("b".repeat(40), "2026-10-22T19:11:52.000Z"), lastCheckedAt: "2026-10-25T19:41:00.000Z" });
  const cloud = (root: string) => writeNarrative(root, "Cloud text from older commits.", "2026-10-26T13:07:00.000Z", basis("a".repeat(40), "2026-10-20T08:00:00.000Z"));
  const merged = await diverged(local, cloud);
  applyCoreMerge(merged.here, merged.remote, merged.ancestor);
  expect(readFileSync(summaryPath(merged.here), "utf8")).toContain("Local text from newer commits.");
  // The fast-forward keeps the local pair whole, so the other device's check time does not reset this one's.
  const forwarded = await diverged(local, cloud);
  fastForward(forwarded.here, forwarded.remote);
  expect(readFileSync(summaryPath(forwarded.here), "utf8")).toContain("Local text from newer commits.");
  expect(meta(forwarded.here)).toMatchObject({ lastCheckedAt: "2026-10-25T19:41:00.000Z", basis: { commit: "b".repeat(40) } });
}, 120000);

it("takes a narrative built from later commits on fast-forward, with this checkout's summary path", async () => {
  const { here, remote } = await diverged(
    root => writeNarrative(root, "Local text.", "2026-10-26T13:07:00.000Z", basis("a".repeat(40), "2026-10-20T08:00:00.000Z")),
    root => writeNarrative(root, "Cloud text.", "2026-10-24T19:41:00.000Z", { ...basis("b".repeat(40), "2026-10-22T19:11:52.000Z"), summaryPath: "C:\\Users\\dev\\project\\.code-butler\\project-summary.md" }));
  fastForward(here, remote);
  expect(readFileSync(summaryPath(here), "utf8")).toContain("Cloud text.");
  expect(meta(here)).toMatchObject({ summaryPath: summaryPath(here), basis: { commit: "b".repeat(40) } });
}, 60000);

it("orders commits by git ancestry before commit time, and settles the same commit by write time", () => {
  const here = temp(), cloud = temp();
  for (const root of [here, cloud]) mkdirSync(join(root, ".code-butler"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", here, "-c", "user.name=Dev", "-c", "user.email=dev@example.test", ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("commit", "-q", "--allow-empty", "-m", "one"); const parent = git("rev-parse", "HEAD");
  git("commit", "-q", "--allow-empty", "-m", "two"); const child = git("rev-parse", "HEAD");
  // The descendant carries the earlier time, so only ancestry can pick it.
  writeNarrative(here, "Local text from the child.", "2026-10-20T07:00:00.000Z", basis(child, "2026-10-01T00:00:00.000Z"));
  const incoming = () => ({ summary: readFileSync(summaryPath(cloud)), meta: readFileSync(metaPath(cloud)) });
  writeNarrative(cloud, "Cloud text from the parent.", "2026-10-25T07:00:00.000Z", basis(parent, "2026-10-09T00:00:00.000Z"));
  expect(preferIncomingNarrative(here, incoming()).take).toBe(false);
  writeNarrative(cloud, "Cloud text, same commit, written later.", "2026-10-25T07:00:00.000Z", basis(child, "2026-10-01T00:00:00.000Z"));
  expect(preferIncomingNarrative(here, incoming()).take).toBe(true);
});
