import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { openConfiguredMemoryStore } from "../storage/open-configured-store.js";
import { withProjectGate } from "./gate.js";
import { applySnapshot, captureSnapshot, decodeSnapshot, excluded, MAX_COMPRESSED, recoverApply } from "./snapshot.js";
import { atomicJson, atomicWrite, binding, connection, ensureCheckoutId, saveBinding, sha256, stateDirectory, type Binding, type Connection } from "./state.js";

const API_REQUEST_TIMEOUT_MS = 30000;
const SNAPSHOT_REQUEST_TIMEOUT_MS = 300000;

export interface Head { revision: number; fingerprint: string; checksum: string; checkoutId?: string | null; installationId?: string | null }
export class RequestError extends Error { constructor(public status: number) { super(status === 401 ? "Beta code invalid or revoked" : status === 403 ? "Beta access expired" : status === 409 ? "Cloud revision conflict" : `Cloud request failed (${status})`); } }
function timeoutForRequest(path: string, payload?: Buffer | object): number {
  return Buffer.isBuffer(payload) || path.includes("/snapshots/") ? SNAPSHOT_REQUEST_TIMEOUT_MS : API_REQUEST_TIMEOUT_MS;
}
export async function request(conn: Connection, path: string, method = "GET", payload?: Buffer | object): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${conn.server}${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(timeoutForRequest(path, payload)),
      headers: { authorization: `Bearer ${conn.secret}`, ...(Buffer.isBuffer(payload) ? { "content-type": "application/octet-stream", "x-content-sha256": sha256(payload) } : payload ? { "content-type": "application/json" } : {}) },
      ...(payload ? { body: Buffer.isBuffer(payload) ? new Uint8Array(payload) : JSON.stringify(payload) } : {})
    });
  } catch (error) {
    if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) throw new Error("Cloud request timed out; local memory remains available");
    throw new Error("Cloud unavailable; local memory remains available");
  }
  if (!response.ok) { await response.body?.cancel(); throw new RequestError(response.status); }
  return response;
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
function canAdoptRemoteBase(state: Binding & { checkoutId: string }, head: Head): boolean {
  return head.revision > state.revision && ((head.checkoutId != null && head.checkoutId === state.checkoutId) || state.pending?.fingerprint === head.fingerprint);
}
function adoptRemoteBase(root: string, state: Binding & { checkoutId: string }, head: Head): void {
  state.revision = head.revision; state.fingerprint = head.fingerprint; state.status = "synced"; delete state.pending; saveSyncState(root, state);
}
function finishSync(root: string, state: Binding): Binding {
  delete state.pending; state.lastSync = new Date().toISOString(); saveSyncState(root, state); return state;
}
async function preserveConflict(root: string, conn: Connection, state: Binding, head: Head, local: { snapshot: { fingerprint: string }; bytes: Buffer }): Promise<void> {
  atomicJson(join(stateDirectory(root), "conflict.json"), { cloudRevision: head.revision, localFingerprint: local.snapshot.fingerprint });
  atomicWrite(join(stateDirectory(root), "conflict-local.gz"), local.bytes);
  if (head.revision > 0) {
    const remote = await responseBytes(await request(conn, `/v1/projects/${state.projectId}/snapshots/${head.revision}`));
    if (sha256(remote) !== head.checksum) throw new Error("Cloud snapshot checksum mismatch");
    decodeSnapshot(remote);
    atomicWrite(join(stateDirectory(root), "conflict-cloud.gz"), remote);
  }
  state.status = "conflict";
}

export async function cloudSync(root: string, keep?: "local" | "cloud"): Promise<Binding | undefined> {
  const initial = binding(root); if (!initial?.enabled) return initial;
  if (initial.status === "conflict" && !keep) return initial;
  const conn = matchingConnection(initial);
  try {
    // Serialize sync coordinators separately from bounded local DB operations.
    return await withProjectGate(stateDirectoryRoot(root), async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const state = ensureCheckoutId(root, binding(root)!);
        const head = await readHead(conn, state.projectId);
        const local = await projectOperation(root, async () => { ensureDatabase(root); return captureSnapshot(root, state.projectId, state.revision, state.checkoutId); });
        const localChanged = state.fingerprint !== local.snapshot.fingerprint;
        const remoteChanged = head.revision !== state.revision;
        if (!keep && state.status === "conflict") return state;
        if (head.fingerprint === local.snapshot.fingerprint) {
          state.revision = head.revision; state.fingerprint = local.snapshot.fingerprint; state.status = "synced";
        } else if (!keep && remoteChanged && localChanged && canAdoptRemoteBase(state, head)) {
          adoptRemoteBase(root, state, head); continue;
        } else if (!keep && remoteChanged && localChanged) {
          await preserveConflict(root, conn, state, head, local);
        } else if (keep === "cloud" || (remoteChanged && !localChanged)) {
          const response = await request(conn, `/v1/projects/${state.projectId}/snapshots/${head.revision}`);
          const bytes = await responseBytes(response);
          if (sha256(bytes) !== head.checksum) throw new Error("Cloud snapshot checksum mismatch");
          const snapshot = decodeSnapshot(bytes);
          if (snapshot.projectId !== state.projectId || snapshot.fingerprint !== head.fingerprint) throw new Error("Cloud snapshot identity mismatch");
          // Check the remote revision again before acquiring the local application gate.
          const latest = await readHead(conn, state.projectId);
          if (latest.revision !== head.revision) throw new RequestError(409);
          await projectOperation(root, async () => {
            const current = await captureSnapshot(root, state.projectId, state.revision, state.checkoutId);
            if (current.snapshot.fingerprint !== local.snapshot.fingerprint) throw new RequestError(409);
            if (!binding(root)?.enabled) throw new Error("Cloud sync disabled");
            applySnapshot(root, snapshot);
            ensureDatabase(root);
            const restored = await captureSnapshot(root, state.projectId, head.revision, state.checkoutId);
            state.revision = head.revision; state.fingerprint = restored.snapshot.fingerprint; state.status = "synced";
            saveSyncState(root, state);
          });
        } else if (keep === "local" || localChanged || head.revision === 0) {
          if (keep) {
            atomicWrite(join(stateDirectory(root), "conflict-local.gz"), local.bytes);
            if (head.revision > 0) {
              const remote = await responseBytes(await request(conn, `/v1/projects/${state.projectId}/snapshots/${head.revision}`));
              if (sha256(remote) !== head.checksum) throw new Error("Cloud snapshot checksum mismatch");
              decodeSnapshot(remote);
              atomicWrite(join(stateDirectory(root), "conflict-cloud.gz"), remote);
            }
          }
          const parentRevision = keep === "local" ? head.revision : state.revision;
          // Retain exact request bytes for retries; physical SQLite bytes may vary on recapture.
          let uploadId: string; let bytes: Buffer;
          if (state.pending?.fingerprint === local.snapshot.fingerprint && state.pending.parentRevision === parentRevision && existsSync(join(stateDirectory(root), "pending.gz"))) {
            uploadId = state.pending.uploadId; bytes = readFileSync(join(stateDirectory(root), "pending.gz"));
          } else {
            const fresh = await projectOperation(root, () => captureSnapshot(root, state.projectId, parentRevision, state.checkoutId));
            uploadId = randomUUID(); bytes = fresh.bytes;
            state.pending = { uploadId, fingerprint: fresh.snapshot.fingerprint, parentRevision };
            atomicWrite(join(stateDirectory(root), "pending.gz"), bytes); saveSyncState(root, state);
          }
          if (!binding(root)?.enabled) return binding(root);
          let published: Head;
          try {
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
