import { AsyncLocalStorage } from "node:async_hooks";
import { recordRetrievalDuration } from "../retrieval/metrics.js";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson, canonicalRoot } from "./state.js";
import { assertProjectNotRemoved } from "./removal-state.js";
import { OperationDeferredError } from "./outcome.js";
import { activeForegroundIntent } from "./foreground.js";
import { processStartIdentity } from "../runtime.js";

const held = new AsyncLocalStorage<Set<string>>();
export interface ProjectOperationStatus {
  name: string;
  pid: number;
  startedAt?: string;
  elapsedMs?: number;
}

export function readProjectOperationStatus(root: string): ProjectOperationStatus | undefined {
  try {
    const owner = JSON.parse(readFileSync(join(canonicalRoot(root), ".code-butler", ".cloud-operation.lock"), "utf8")) as {
      pid?: unknown; name?: unknown; startedAt?: unknown;
    };
    if (!Number.isInteger(owner.pid) || !lockOwnerAlive(owner as GateOwner)) return undefined;
    const startedAt = typeof owner.startedAt === "string" && Number.isFinite(Date.parse(owner.startedAt))
      ? owner.startedAt : undefined;
    return {
      name: typeof owner.name === "string" && owner.name.length > 0 ? owner.name : "Other local operation",
      pid: owner.pid as number,
      ...(startedAt ? { startedAt, elapsedMs: Math.max(0, Date.now() - Date.parse(startedAt)) } : {})
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}
export function watcherOwnsProjectGate(root: string, pid: number, watcherToken: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(join(canonicalRoot(root), ".code-butler", ".cloud-operation.lock"), "utf8")) as GateOwner & { watcherToken?: unknown };
    return owner.pid === pid && owner.watcherToken === watcherToken && lockOwnerAlive(owner);
  } catch { return false; }
}
interface GateOwner { pid?: unknown; processStart?: unknown; startedAt?: unknown; token?: unknown }
function lockOwnerAlive(owner: GateOwner): boolean {
  if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return false;
  const pid = owner.pid as number;
  const currentStart = processStartIdentity(pid);
  if (currentStart && typeof owner.processStart === "string") return currentStart === owner.processStart;
  // Older lock files lack processStart. A process created well after the lock
  // was written is proof that Windows reused the PID, not the lock owner.
  if (process.platform === "win32" && currentStart && /^\d+$/.test(currentStart) && typeof owner.startedAt === "string") {
    const lockTime = Date.parse(owner.startedAt);
    if (Number.isFinite(lockTime)) {
      const processTime = Number((BigInt(currentStart) - 621355968000000000n) / 10000n);
      if (processTime > lockTime + 60_000) return false;
    }
  }
  return alive(pid);
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export async function withProjectGate<T>(root: string, work: () => Promise<T> | T, options: { allowRemoved?: boolean; waitMs?: number; name?: string; background?: boolean } = {}): Promise<T> {
  root = canonicalRoot(root);
  if (!options.allowRemoved) assertProjectNotRemoved(root);
  if (held.getStore()?.has(root)) return work();
  const dir = join(root, ".code-butler"); mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".cloud-operation.lock");
  const token = randomUUID(); const owner = join(dir, `.cloud-owner-${token}`);
  const processStart = processStartIdentity(process.pid);
  writeFileSync(owner, JSON.stringify({ pid: process.pid, ...(processStart ? { processStart } : {}), token, name: options.name ?? "Other local operation", startedAt: new Date().toISOString(),
    ...(process.env.CODE_BUTLER_WATCH_TOKEN ? { watcherToken: process.env.CODE_BUTLER_WATCH_TOKEN } : {}) }), { flag: "wx", mode: 0o600 });
  const deadline = Date.now() + (options.waitMs ?? 15000);
  const background = options.background ?? Boolean(process.env.CODE_BUTLER_WATCH_TOKEN);
  const waitStarted=performance.now();
  try {
    while (true) {
      if (background && activeForegroundIntent(root)) {
        if (Date.now() > deadline) throw new OperationDeferredError("Background operation deferred for foreground review");
        await delay(50);
        continue;
      }
      try { linkSync(owner, lock); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const value = JSON.parse(readFileSync(lock, "utf8")) as GateOwner;
          if (Number.isSafeInteger(value.pid) && typeof value.token === "string" && !lockOwnerAlive(value)) {
            // Only one contender may reap this exact dead owner's lock.
            const reaping = `${lock}.reap-${value.token}`;
            try {
              linkSync(lock, reaping);
              try { if (JSON.parse(readFileSync(lock, "utf8")).token === value.token) unlinkSync(lock); }
              finally { unlinkSync(reaping); }
              continue;
            } catch (error) { if (!["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; }
        if (Date.now() > deadline) throw new OperationDeferredError("Cloud operation deferred: another local Butler operation is active");
        await delay(50);
      }
    }
    if (background && activeForegroundIntent(root)) {
      try { if (JSON.parse(readFileSync(lock, "utf8")).token === token) unlinkSync(lock); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      throw new OperationDeferredError("Background operation deferred for foreground review");
    }
    const holdStarted = performance.now();
    try {
      recordRetrievalDuration("gateWait",performance.now()-waitStarted);
      if (!options.allowRemoved) assertProjectNotRemoved(root);
      return await held.run(new Set([...(held.getStore() ?? []), root]), work);
    }
    finally {
      try { if (JSON.parse(readFileSync(lock, "utf8")).token === token) unlinkSync(lock); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      try { if (existsSync(dir)) atomicJson(join(dir, "gate-timing.json"), {
        recordedAt: new Date().toISOString(), operation: options.name ?? "Other local operation",
        waitMs: Math.round(holdStarted - waitStarted), holdMs: Math.round(performance.now() - holdStarted)
      }); } catch { /* Diagnostic writes must not mask an operation. */ }
    }
  } finally {
    try { unlinkSync(owner); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/** Short synchronous database steps used by a watcher between asynchronous model calls. */
export function withProjectGateSync<T>(root: string, work: () => T, name: string): T {
  root = canonicalRoot(root);
  assertProjectNotRemoved(root);
  if (held.getStore()?.has(root)) return work();
  if (activeForegroundIntent(root)) throw new OperationDeferredError("Watcher database step deferred for foreground review");
  const dir = join(root, ".code-butler"); mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".cloud-operation.lock");
  const token = randomUUID();
  const owner = join(dir, `.cloud-owner-${token}`);
  const processStart = processStartIdentity(process.pid);
  writeFileSync(owner, JSON.stringify({ pid: process.pid, ...(processStart ? { processStart } : {}), token, name, startedAt: new Date().toISOString(),
    ...(process.env.CODE_BUTLER_WATCH_TOKEN ? { watcherToken: process.env.CODE_BUTLER_WATCH_TOKEN } : {}) }), { flag: "wx", mode: 0o600 });
  const started = performance.now();
  let acquired = false;
  try {
    while (!acquired) {
      try { linkSync(owner, lock); acquired = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let reaped = false;
        try {
          const value = JSON.parse(readFileSync(lock, "utf8")) as GateOwner;
          if (Number.isSafeInteger(value.pid) && typeof value.token === "string" && /^[a-f0-9-]{36}$/i.test(value.token) && !lockOwnerAlive(value)) {
            // Migration uses synchronous gates, so an interrupted owner must be reaped here too.
            const reaping = `${lock}.reap-${value.token}`;
            linkSync(lock, reaping);
            try {
              if (JSON.parse(readFileSync(lock, "utf8")).token === value.token) { unlinkSync(lock); reaped = true; }
            } finally { unlinkSync(reaping); }
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") reaped = true; }
        if (!reaped) throw new OperationDeferredError("Watcher database step deferred for another local operation");
      }
    }
    if (activeForegroundIntent(root)) throw new OperationDeferredError("Watcher database step deferred for foreground review");
    return held.run(new Set([...(held.getStore() ?? []), root]), work);
  } finally {
    if (acquired) {
      try { if (JSON.parse(readFileSync(lock, "utf8")).token === token) unlinkSync(lock); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    try { unlinkSync(owner); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (acquired) try { if (existsSync(dir)) atomicJson(join(dir, "gate-timing.json"), {
      recordedAt: new Date().toISOString(), operation: name, waitMs: 0, holdMs: Math.round(performance.now() - started)
    }); } catch { /* Diagnostic writes must not mask an operation. */ }
  }
}
// Track even local-only MCP processes so enabling sync cannot replace their open DB.
export function registerDatabaseHandle(dataDir: string): () => void {
  assertProjectNotRemoved(join(dataDir, ".."));
  const dir = join(dataDir, ".cloud-handles"); mkdirSync(dir, { recursive: true });
  const checkGate = () => {
    assertProjectNotRemoved(join(dataDir, ".."));
    try {
      const owner = JSON.parse(readFileSync(join(dataDir, ".cloud-operation.lock"), "utf8")) as GateOwner;
      if (lockOwnerAlive(owner) && !held.getStore()?.has(canonicalRoot(join(dataDir, "..")))) throw new OperationDeferredError("Database open deferred: cloud operation in progress");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  checkGate();
  const path = join(dir, `${process.pid}-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  try { checkGate(); } catch (error) { unlinkSync(path); throw error; }
  return () => { if (existsSync(path)) unlinkSync(path); };
}
/**
 * The owner of a handle file, read from its name as registerDatabaseHandle writes it. The name never
 * changes after creation, while the content can be empty mid-write or zero-filled after a crash.
 */
export function handleOwnerPid(name: string): number | undefined {
  const match = /^(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/.exec(name);
  return match ? Number(match[1]) : undefined;
}
export function assertNoDatabaseHandles(root: string): void {
  const dir = join(root, ".code-butler", ".cloud-handles");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    // Only files this code registered hold a handle; anything else in the folder is not ours to judge.
    const pid = handleOwnerPid(name);
    if (pid === undefined) continue;
    if (alive(pid)) throw new OperationDeferredError("Cloud restore deferred: close or restart existing Butler database sessions");
    try { unlinkSync(join(dir, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
