import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { installationDeviceId } from "../memory/origin.js";
import { loadProjectConfig } from "../config.js";
import { openConfiguredMemoryStore } from "../storage/open-configured-store.js";
import { partitionCheckout, type ShareLocalLayers } from "./partition.js";
import { flagMergeConflicts, mergeCore, type MergeCoreResult } from "./merge.js";
import { createRecoveryBackup, removeRecoveryBackup } from "../privacy/backup.js";
import { assertPrivacyDatabaseIntegrity, rebuildPrivacyDerivedIndexes } from "../storage/privacy-maintenance.js";
import { auditMemoryConflicts } from "../memory/conflicts.js";
import { auditMemoryQuality } from "../memory/quality.js";
import { recordCompletedOperation } from "../operations/log.js";
import { withTransaction } from "../storage/transactions.js";
import { withProjectGate } from "./gate.js";
import { DatabaseSync } from "node:sqlite";
import { rmSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import {
  applySnapshot,
  bundleResolver,
  captureSnapshot,
  decodeBundle,
  decodeSnapshot,
  encodeBundle,
  excluded,
  MAX_COMPRESSED,
  MAX_EXPANDED,
  materializeSnapshot,
  missingBlocks,
  partitionSegments,
  recoverApply,
  type CaptureResult,
  type Snapshot,
  type SnapshotBundle,
  type SnapshotSegment
} from "./snapshot.js";
import { atomicJson, atomicWrite, binding, connection, ensureCheckoutId, saveBinding, sha256, stateDirectory, type Binding, type Connection } from "./state.js";

const API_REQUEST_TIMEOUT_MS = 30000;
/** One download batch: 8 MiB of 64 KiB blocks. */
const BATCH_BLOCKS = 128;
const SNAPSHOT_REQUEST_TIMEOUT_MS = 300000;

export interface Head {
  revision: number; fingerprint: string; checksum: string;
  checkoutId?: string | null; installationId?: string | null;
  /** Absent from a pre-segment server; treated as "nothing is already there". */
  segments?: SnapshotSegment[];
}
export class RequestError extends Error {
  constructor(public status: number, detail = "") {
    const base = status === 401
      ? "Beta code invalid or revoked"
      : status === 403
        ? "Beta access expired"
        : status === 409
          ? "Cloud revision conflict"
          : `Cloud request failed (${status})`;
    super(detail ? `${base}: ${detail}` : base);
  }
}
function timeoutForRequest(path: string, payload?: Buffer | object): number {
  return Buffer.isBuffer(payload) || path.includes("/snapshots/") ? SNAPSHOT_REQUEST_TIMEOUT_MS : API_REQUEST_TIMEOUT_MS;
}
/**
 * A keep-alive socket that the server has just closed fails the next request on it with
 * ECONNRESET rather than being reissued. Node closes idle sockets after five seconds,
 * so any client that pauses between requests — a slow capture, a busy machine — can
 * lose one this way. Every cloud request is idempotent (reads are reads, blocks are
 * content-addressed, a publish is keyed by upload id), so one retry on a connection
 * error is safe and turns a lost socket into a non-event.
 */
function isRetriableConnectionError(error: unknown): boolean {
  const causes = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET"]);
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && causes.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function request(conn: Connection, path: string, method = "GET", payload?: Buffer | object): Promise<Response> {
  const send = async (): Promise<Response> => await fetch(`${conn.server}${path}`, {
    method, redirect: "error", signal: AbortSignal.timeout(timeoutForRequest(path, payload)),
    headers: { authorization: `Bearer ${conn.secret}`, ...(Buffer.isBuffer(payload) ? { "content-type": "application/octet-stream", "x-content-sha256": sha256(payload) } : payload ? { "content-type": "application/json" } : {}) },
    ...(payload ? { body: Buffer.isBuffer(payload) ? new Uint8Array(payload) : JSON.stringify(payload) } : {})
  });
  let response: Response;
  try {
    try {
      response = await send();
    } catch (error) {
      if (!isRetriableConnectionError(error)) throw error;
      response = await send();
    }
  } catch (error) {
    if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) throw new Error("Cloud request timed out; local memory remains available");
    throw new Error("Cloud unavailable; local memory remains available");
  }
  if (!response.ok) throw new RequestError(response.status, await readErrorBody(response));
  return response;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).trim().slice(0, 500);
  } catch {
    return "";
  }
}
export async function responseBytes(response: Response): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  if (!response.body) throw new Error("Missing snapshot response");
  for await (const chunk of response.body) { size += chunk.length; if (size > MAX_COMPRESSED) throw new Error("Cloud snapshot too large"); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
export async function projectOperation<T>(root: string, work: () => T | Promise<T>): Promise<T> {
  return withProjectGate(root, async () => { recoverApply(root); return work(); });
}
function ensureDatabase(root: string): void { const store = openConfiguredMemoryStore(root); try { store.init(); } finally { store.close(); } }
/** Reading config must never break sync: an unreadable file falls back to the default. */
function shareMode(root: string): ShareLocalLayers {
  try { return loadProjectConfig(root).sync.shareLocalLayers; } catch { return "durable"; }
}
function matchingConnection(state: Binding): Connection {
  const conn = connection();
  if (conn.server !== state.server || conn.vaultId !== state.vaultId) throw new Error("This checkout belongs to a different cloud connection");
  return conn;
}
function saveSyncState(root: string, state: Binding): void {
  const current = binding(root);
  // A concurrent disable/rebind must not be undone by an in-flight request.
  if (current?.enabled && current.projectId === state.projectId && current.vaultId === state.vaultId && current.server === state.server) saveBinding(root, state);
}
async function readHead(conn: Connection, projectId: string): Promise<Head> {
  return await (await request(conn, `/v1/projects/${projectId}/head`)).json() as Head;
}
/**
 * True when the cloud holds peer partitions this device has not imported, or still
 * lists ones it has since withdrawn. A peer's partition deliberately does not move the
 * core fingerprint, so this is the only signal that a pull is due.
 */
function peerPartitionsStale(imported: Map<string, string>, head: Head): boolean {
  const own = installationDeviceId();
  const remote = new Map(
    (head.segments ?? [])
      .filter(segment => segment.kind === "partition" && segment.writerInstallationId !== own)
      .map(segment => [segment.id, segment.fingerprint])
  );
  if (remote.size !== imported.size) return true;
  for (const [layer, fingerprint] of remote) if (imported.get(layer) !== fingerprint) return true;
  return false;
}

/**
 * True when this checkout's partitions differ from what the cloud already holds.
 * Scoped to the checkout, not the installation: a sibling checkout on the same machine
 * publishes its own partitions, and treating those as ours would have the two of them
 * overwriting each other in an endless exchange.
 */
function ownPartitionsDiffer(manifest: Snapshot, head: Head, checkoutId: string): boolean {
  const mine = (segments: SnapshotSegment[]): Map<string, string> => new Map(
    segments.filter(segment => segment.kind === "partition" && partitionCheckout(segment.id) === checkoutId)
      .map(segment => [segment.id, segment.fingerprint])
  );
  const local = mine(partitionSegments(manifest));
  const remote = mine(head.segments ?? []);
  if (local.size !== remote.size) return true;
  for (const [id, fingerprint] of local) if (remote.get(id) !== fingerprint) return true;
  return false;
}
function canAdoptRemoteBase(state: Binding & { checkoutId: string }, head: Head): boolean {
  return head.revision > state.revision && ((head.checkoutId != null && head.checkoutId === state.checkoutId) || state.pending?.fingerprint === head.fingerprint);
}
function adoptRemoteBase(root: string, state: Binding & { checkoutId: string }, head: Head): void {
  state.revision = head.revision; state.fingerprint = head.fingerprint; state.status = "synced"; delete state.pending; saveSyncState(root, state);
}
function finishSync(root: string, state: Binding): Binding {
  delete state.pending; state.lastSync = new Date().toISOString(); saveSyncState(root, state); return state;
}
/** Bounds one batch request; blocks are small, so the limit is a byte budget. */
const BATCH_BYTES = 8 * 1024 * 1024;

function batched(checksums: string[], blocks: Map<string, Buffer>): string[][] {
  const batches: string[][] = []; let current: string[] = []; let size = 0;
  for (const checksum of checksums) {
    const data = blocks.get(checksum);
    if (!data) throw new Error("Snapshot block missing");
    if (current.length > 0 && size + data.length > BATCH_BYTES) { batches.push(current); current = []; size = 0; }
    current.push(checksum); size += data.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Uploads only blocks the server is missing, in batches rather than one request each. */
async function uploadBlocks(conn: Connection, projectId: string, manifest: Snapshot, blocks: Map<string, Buffer>, head: Head): Promise<number> {
  const present = new Set((head.segments ?? []).flatMap(segment => segment.blocks));
  const wanted = missingBlocks(manifest, checksum => present.has(checksum));
  for (const batch of batched(wanted, blocks)) {
    const payload: Record<string, string> = {};
    for (const checksum of batch) payload[checksum] = blocks.get(checksum)!.toString("base64");
    await request(conn, `/v1/projects/${projectId}/segments`, "PUT", gzipSync(Buffer.from(JSON.stringify(payload))));
  }
  return wanted.length;
}

/**
 * Downloads a revision as a self-contained bundle, fetching only the blocks this
 * device does not already hold locally.
 */
async function downloadBundle(
  conn: Connection,
  projectId: string,
  head: Head,
  have: Map<string, Buffer> = new Map(),
  /** The ancestor is addressed by revision alone, so its checksum is not known here. */
  trustRevision = false
): Promise<SnapshotBundle> {
  const response = await request(conn, `/v1/projects/${projectId}/snapshots/${head.revision}`);
  const bytes = await responseBytes(response);
  if (!trustRevision && sha256(bytes) !== head.checksum) throw new Error("Cloud snapshot checksum mismatch");
  const manifest = decodeSnapshot(bytes);
  const blocks = new Map<string, Buffer>();
  const wanted: string[] = [];
  for (const checksum of new Set(manifest.segments.flatMap(segment => segment.blocks))) {
    const local = have.get(checksum);
    if (local) blocks.set(checksum, local); else wanted.push(checksum);
  }
  // Requested in batches, and only for blocks this device does not already hold.
  for (let offset = 0; offset < wanted.length; offset += BATCH_BLOCKS) {
    const batch = wanted.slice(offset, offset + BATCH_BLOCKS);
    const response = await responseBytes(await request(conn, `/v1/projects/${projectId}/segments`, "POST", batch));
    const payload = z.record(z.string(), z.string()).parse(JSON.parse(gunzipSync(response, { maxOutputLength: MAX_EXPANDED }).toString()));
    for (const checksum of batch) {
      const encoded = payload[checksum];
      if (encoded === undefined) throw new Error("Snapshot block missing");
      const data = Buffer.from(encoded, "base64");
      if (sha256(data) !== checksum) throw new Error("Snapshot block checksum mismatch");
      blocks.set(checksum, data);
    }
  }
  return { manifest, blocks };
}

async function preserveConflict(root: string, conn: Connection, state: Binding, head: Head, local: CaptureResult): Promise<void> {
  atomicJson(join(stateDirectory(root), "conflict.json"), { cloudRevision: head.revision, localFingerprint: local.snapshot.fingerprint });
  atomicWrite(join(stateDirectory(root), "conflict-local.gz"), encodeBundle({ manifest: local.snapshot, blocks: local.blocks }));
  if (head.revision > 0) {
    const remote = await downloadBundle(conn, state.projectId, head, local.blocks);
    atomicWrite(join(stateDirectory(root), "conflict-cloud.gz"), encodeBundle(remote));
  }
  state.status = "conflict";
}

/**
 * Merges the cloud's core content into this checkout instead of choosing a side.
 * Needs the common ancestor — the revision this device last agreed with — which the
 * server retains for five revisions; without it there is no way to tell an addition
 * from a deletion, so the caller falls back to an explicit choice.
 */
async function mergeWithCloud(
  root: string,
  conn: Connection,
  state: Binding & { checkoutId: string },
  head: Head,
  local: CaptureResult,
  share: ShareLocalLayers
): Promise<MergeCoreResult> {
  const remote = await downloadBundle(conn, state.projectId, head, local.blocks);
  const ancestorHead: Head = { revision: state.revision, fingerprint: state.fingerprint, checksum: "" };
  let ancestor: SnapshotBundle;
  try {
    ancestor = await downloadBundle(conn, state.projectId, ancestorHead, local.blocks, true);
  } catch {
    throw new Error("Cloud merge unavailable: the shared ancestor revision is no longer retained. Resolve with --keep local or --keep cloud.");
  }
  return await projectOperation(root, async () => {
    const current = await captureSnapshot(root, state.projectId, state.revision, state.checkoutId, share);
    if (current.snapshot.fingerprint !== local.snapshot.fingerprint) throw new RequestError(409);
    if (!binding(root)?.enabled) throw new Error("Cloud sync disabled");
    return applyCoreMerge(root, remote, ancestor);
  });
}

export async function cloudSync(root: string, keep?: "local" | "cloud" | "merge"): Promise<Binding | undefined> {
  const initial = binding(root); if (!initial?.enabled) return initial;
  if (initial.status === "conflict" && !keep) return initial;
  const conn = matchingConnection(initial);
  try {
    // Serialize sync coordinators separately from bounded local DB operations.
    return await withProjectGate(stateDirectoryRoot(root), async () => {
      const share = shareMode(root);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const state = ensureCheckoutId(root, binding(root)!);
        const head = await readHead(conn, state.projectId);
        const local = await projectOperation(root, async () => { ensureDatabase(root); return captureSnapshot(root, state.projectId, state.revision, state.checkoutId, share); });
        const localChanged = state.fingerprint !== local.snapshot.fingerprint;
        const remoteChanged = head.revision !== state.revision;
        // Shared content and this device's own partitions move independently: a
        // partition-only change publishes by rebase and can never be a conflict.
        const partitionsChanged = ownPartitionsDiffer(local.snapshot, head, state.checkoutId);
        const peersStale = peerPartitionsStale(local.peers, head);
        if (!keep && state.status === "conflict") return state;
        if (head.fingerprint === local.snapshot.fingerprint && !partitionsChanged && !peersStale) {
          state.revision = head.revision; state.fingerprint = local.snapshot.fingerprint; state.status = "synced";
        } else if (!keep && remoteChanged && localChanged && canAdoptRemoteBase(state, head)) {
          adoptRemoteBase(root, state, head); continue;
        } else if (keep === "merge") {
          // Merge, then fall through to a normal push of the merged result: the
          // publish parents on head, so the other device sees one converged revision.
          const merged = await mergeWithCloud(root, conn, state, head, local, share);
          atomicJson(join(stateDirectory(root), "merge.json"), {
            cloudRevision: head.revision,
            adopted: merged.adopted,
            converged: merged.converged,
            retained: merged.retained,
            deleted: merged.deleted,
            flagged: merged.flagged,
            reviewMemoryIds: merged.reviewMemoryIds
          });
          state.status = "merged";
          saveSyncState(root, state);
          keep = "local";
          continue;
        } else if (!keep && remoteChanged && localChanged) {
          await preserveConflict(root, conn, state, head, local);
        } else if (keep === "cloud" || ((remoteChanged || peersStale) && !localChanged)) {
          // Blocks this device already holds are never re-downloaded.
          const remote = await downloadBundle(conn, state.projectId, head, local.blocks);
          const snapshot = remote.manifest;
          if (snapshot.projectId !== state.projectId || snapshot.fingerprint !== head.fingerprint) throw new Error("Cloud snapshot identity mismatch");
          const materialized = materializeSnapshot(snapshot, bundleResolver(remote.blocks));
          // Check the remote revision again before acquiring the local application gate.
          const latest = await readHead(conn, state.projectId);
          if (latest.revision !== head.revision) throw new RequestError(409);
          await projectOperation(root, async () => {
            const current = await captureSnapshot(root, state.projectId, state.revision, state.checkoutId, share);
            if (current.snapshot.fingerprint !== local.snapshot.fingerprint) throw new RequestError(409);
            if (!binding(root)?.enabled) throw new Error("Cloud sync disabled");
            applySnapshot(root, materialized);
            ensureDatabase(root);
            const restored = await captureSnapshot(root, state.projectId, head.revision, state.checkoutId, share);
            state.revision = head.revision; state.fingerprint = restored.snapshot.fingerprint; state.status = "synced";
            saveSyncState(root, state);
          });
          // A pull that also left this device's own partition unpublished retries in the
          // same run, so one `cloud sync` is enough to both receive and share.
          if (partitionsChanged) continue;
        } else if (keep === "local" || localChanged || partitionsChanged || head.revision === 0) {
          if (keep) {
            atomicWrite(join(stateDirectory(root), "conflict-local.gz"), encodeBundle({ manifest: local.snapshot, blocks: local.blocks }));
            if (head.revision > 0) {
              const remote = await downloadBundle(conn, state.projectId, head, local.blocks);
              atomicWrite(join(stateDirectory(root), "conflict-cloud.gz"), encodeBundle(remote));
            }
          }
          const parentRevision = keep === "local" || (partitionsChanged && !localChanged) ? head.revision : state.revision;
          // Retain the exact manifest and its blocks for retries; physical SQLite bytes
          // vary on recapture, so a resumed upload must replay the original payload.
          let uploadId: string; let manifest: Snapshot; let blocks: Map<string, Buffer>; let bytes: Buffer;
          const pendingPath = join(stateDirectory(root), "pending.gz");
          if (state.pending?.fingerprint === local.snapshot.fingerprint && state.pending.parentRevision === parentRevision && existsSync(pendingPath)) {
            const resumed = decodeBundle(readFileSync(pendingPath));
            uploadId = state.pending.uploadId; manifest = resumed.manifest; blocks = resumed.blocks;
            bytes = gzipSync(Buffer.from(JSON.stringify(manifest)));
          } else {
            const fresh = await projectOperation(root, () => captureSnapshot(root, state.projectId, parentRevision, state.checkoutId, share));
            uploadId = randomUUID(); manifest = fresh.snapshot; blocks = fresh.blocks; bytes = fresh.bytes;
            state.pending = { uploadId, fingerprint: fresh.snapshot.fingerprint, parentRevision };
            atomicWrite(pendingPath, encodeBundle({ manifest, blocks })); saveSyncState(root, state);
          }
          if (!binding(root)?.enabled) return binding(root);
          let published: Head;
          try {
            // Blocks first: a manifest may only be published once every block it
            // references is stored, so a revision is never partially downloadable.
            await uploadBlocks(conn, state.projectId, manifest, blocks, head);
            published = await (await request(conn, `/v1/projects/${state.projectId}/snapshots/${uploadId}`, "PUT", bytes)).json() as Head;
          } catch (error) {
            if (error instanceof RequestError && error.status === 409 && !keep) {
              const latest = await readHead(conn, state.projectId);
              if (canAdoptRemoteBase(state, latest)) { adoptRemoteBase(root, state, latest); continue; }
              await preserveConflict(root, conn, state, latest, local);
              return finishSync(root, state);
            }
            throw error;
          }
          state.revision = published.revision; state.fingerprint = state.pending!.fingerprint; state.status = "synced";
        } else state.status = "synced";
        return finishSync(root, state);
      }
      throw new RequestError(409);
    });
  } catch (error) {
    const current = binding(root)!;
    current.status = error instanceof RequestError && error.status === 409 ? "conflict" : error instanceof RequestError && (error.status === 401 || error.status === 403) ? "access-unavailable" : "offline-or-deferred";
    saveSyncState(root, current); throw error;
  }
}
// Reuse the gate implementation in the private checkout-state directory.
/**
 * Applies a merged core onto the live database. Only shared rows move, so local layers
 * are untouched by construction; derived indexes are rebuilt and the audits that
 * privacy operations already run keep the result self-consistent.
 */
function applyCoreMerge(root: string, remote: SnapshotBundle, ancestor: SnapshotBundle): MergeCoreResult {
  const state = stateDirectory(root);
  const remotePath = join(state, `merge-remote-${randomUUID()}.sqlite`);
  const ancestorPath = join(state, `merge-ancestor-${randomUUID()}.sqlite`);
  writeFileSync(remotePath, materializeSnapshot(remote.manifest, bundleResolver(remote.blocks)).files.find(file => file.path === "memory.sqlite")!.data);
  writeFileSync(ancestorPath, materializeSnapshot(ancestor.manifest, bundleResolver(ancestor.blocks)).files.find(file => file.path === "memory.sqlite")!.data);
  const store = openConfiguredMemoryStore(root);
  const remoteDb = new DatabaseSync(remotePath, { readOnly: true });
  const ancestorDb = new DatabaseSync(ancestorPath, { readOnly: true });
  const backup = createRecoveryBackup(store.paths.databasePath, new Date());
  try {
    store.init();
    const now = new Date().toISOString();
    const result = withTransaction(store.db, () => {
      const merged = mergeCore(store.db, remoteDb, ancestorDb);
      rebuildPrivacyDerivedIndexes(store.db);
      auditMemoryConflicts(store, { fix: true, now });
      auditMemoryQuality(store, { fix: true, now });
      // Flagged last: the quality audit recomputes status from evidence, so marking a
      // merge conflict before it runs would have the audit quietly clear the mark.
      flagMergeConflicts(store.db, merged.reviewMemoryIds, now);
      assertPrivacyDatabaseIntegrity(store.db);
      recordCompletedOperation(store.db, {
        operationType: "cloud_merge",
        actor: "cli",
        metadata: { count: merged.adopted + merged.deleted, category: "memories", identifier: `merge-${merged.flagged}` },
        startedAt: now
      }, now);
      return merged;
    });
    removeRecoveryBackup(backup);
    return result;
  } catch (error) {
    // The backup is the only way back from a half-applied merge, so it is retained.
    throw new Error(`Cloud merge failed; recovery backup retained at ${backup}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    remoteDb.close(); ancestorDb.close(); store.close();
    for (const path of [remotePath, ancestorPath]) for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  }
}

function stateDirectoryRoot(root: string): string {
  const path = stateDirectory(root); atomicJson(join(path, "coordinator.json"), { version: 1 }); return path;
}
export async function syncQuietly(root: string, warn: (line: string) => void = console.error): Promise<void> {
  if (!binding(root)?.enabled) return;
  try { const state = await cloudSync(root); if (state?.status === "conflict") warn("Cloud sync paused: conflicting snapshots. Run code-butler cloud resolve --keep local|cloud."); }
  catch (error) { warn(error instanceof Error ? error.message : "Cloud sync deferred"); }
}
function fileStamp(root: string): string {
  const base = join(root, ".code-butler");
  function scan(dir: string, prefix = ""): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).sort().flatMap(name => {
      const path = prefix ? `${prefix}/${name}` : name;
      // Include WAL as a change signal, although it never travels in snapshots.
      if (excluded(path) && path !== "memory.sqlite-wal") return [];
      const stat = lstatSync(join(dir, name));
      if (stat.isSymbolicLink()) throw new Error("Cloud sync does not follow project symlinks");
      return stat.isDirectory() ? scan(join(dir, name), path) : [`${path}:${stat.size}:${stat.mtimeMs}`];
    });
  }
  return sha256(scan(base).join("\n"));
}
export function startCloudScheduler(root: string, warn: (line: string) => void = console.error, timing: { pollMs?: number; settleMs?: number; tickMs?: number } = {}): () => void {
  const pollMs = timing.pollMs ?? 60000, settleMs = timing.settleMs ?? 10000;
  let lastStamp = ""; let changedAt = 0; let nextPoll = Date.now() + pollMs; let failures = 0; let busy = false; let stopped = false;
  const timer = setInterval(() => {
    if (busy || stopped || !binding(root)?.enabled || binding(root)?.status === "conflict") return;
    void (async () => {
      busy = true;
      try {
        if (failures > 0 && Date.now() < nextPoll) return;
        const stamp = fileStamp(root);
        if (stamp !== lastStamp) { lastStamp = stamp; changedAt = Date.now(); }
        if (Date.now() < nextPoll && (!changedAt || Date.now() - changedAt < settleMs)) return;
        const result = await cloudSync(root);
        if (result?.status === "conflict") warn("Cloud sync paused: conflicting snapshots. Run code-butler cloud resolve --keep local|cloud.");
        failures = 0; changedAt = 0; nextPoll = Date.now() + pollMs;
      } catch (error) {
        failures++; changedAt = 0; nextPoll = Date.now() + Math.min(300000, 10000 * 2 ** Math.min(failures, 5));
        warn(error instanceof Error ? error.message : "Cloud sync deferred");
      } finally { busy = false; }
    })();
  }, timing.tickMs ?? 2000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
