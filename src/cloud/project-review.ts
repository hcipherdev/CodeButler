import { loadProjectConfig } from "../config.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withProjectGate } from "./gate.js";
import { binding, stateDirectory } from "./state.js";
import { AccountClient } from "./account-client.js";
import { EncryptionError } from "./crypto-helper.js";
import { catalogAccount } from "./project-catalog.js";
import { projectTrust } from "./vault-client.js";
import { EncryptedTransport } from "./encrypted-client.js";
import { captureSnapshot, materializeSnapshot, bundleResolver, type SnapshotBundle } from "./snapshot.js";
import { encryptedCloudSync, type SyncReview, type MemoryReviewSummary } from "./encrypted-coordinator.js";
import { assertBindingIdentity } from "./project-identity.js";
import { recordCloudRunSuccess } from "../global-watch.js";

export function snapshotContentCounts(bundle: SnapshotBundle): MemoryReviewSummary {
  const dir = mkdtempSync(join(tmpdir(), "butler-memory-review-")), path = join(dir, "memory.sqlite");
  try {
    const bytes = materializeSnapshot(bundle.manifest, bundleResolver(bundle.blocks)).files.find(f => f.path === "memory.sqlite")!.data;
    writeFileSync(path, bytes, { mode: 0o600 });
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const count = (table: string) => Number(db.prepare(`select count(*) n from ${table}`).get()!.n);
      return { memories: count("memories"), candidates: count("memory_candidates"), sources: count("sources") };
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function reviewProjectConflict(root: string, suppliedClient?: AccountClient): Promise<SyncReview> {
  return withProjectGate(stateDirectory(root), async () => {
    const state = binding(root);
    if (!state?.enabled || !state.checkoutId) throw new Error("Enable the existing cloud connection before reviewing its conflict");
    assertBindingIdentity(root, state);
    const client = suppliedClient ?? new AccountClient(state.server), status = await catalogAccount(client);
    if (client.server !== state.server || status.descriptor!.vaultId !== state.vaultId) throw new EncryptionError("authentication-required");
    const remote = await new EncryptedTransport(client, projectTrust(status, state.projectId)).pull();
    if (!remote) throw new Error("This cloud project has no memory revision to review");
    const local = await captureSnapshot(root, state.projectId, remote.pin.revision, state.checkoutId, loadProjectConfig(root).sync.shareLocalLayers);
    const journal = await client.security.invoke<{ applied?: unknown } | null>("sync-read", { checkoutId: state.checkoutId });
    return { projectId: state.projectId, localFingerprint: local.snapshot.fingerprint, remote: remote.pin, canMerge: true, firstConnection: !journal?.applied, localSummary: snapshotContentCounts({ manifest: local.snapshot, blocks: local.blocks }), cloudSummary: snapshotContentCounts(remote.bundle) };
  });
}

export async function resolveProjectConflict(root: string, choice: "local" | "cloud" | "merge", review: SyncReview, client?: AccountClient) {
  const state = await encryptedCloudSync(root, choice, client, review);
  // Clear the watcher's stale conflict failure and backoff as soon as the choice lands.
  if (state?.status === "synced") recordCloudRunSuccess(root);
  return state;
}
