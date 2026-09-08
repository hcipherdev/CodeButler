import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalRoot } from "./state.js";

const held = new AsyncLocalStorage<Set<string>>();
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export async function withProjectGate<T>(root: string, work: () => Promise<T> | T): Promise<T> {
  root = canonicalRoot(root);
  if (held.getStore()?.has(root)) return work();
  const dir = join(root, ".code-butler"); mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".cloud-operation.lock");
  const token = randomUUID(); const owner = join(dir, `.cloud-owner-${token}`);
  writeFileSync(owner, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
  const deadline = Date.now() + 15000;
  try {
    while (true) {
      try { linkSync(owner, lock); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const value = JSON.parse(readFileSync(lock, "utf8")) as { pid: number; token: string };
          if (Number.isInteger(value.pid) && !alive(value.pid)) {
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
        if (Date.now() > deadline) throw new Error("Cloud operation deferred: another local Butler operation is active");
        await delay(50);
      }
    }
    try { return await held.run(new Set([...(held.getStore() ?? []), root]), work); }
    finally {
      if (JSON.parse(readFileSync(lock, "utf8")).token === token) unlinkSync(lock);
    }
  } finally { unlinkSync(owner); }
}
// Track even local-only MCP processes so enabling sync cannot replace their open DB.
export function registerDatabaseHandle(dataDir: string): () => void {
  const dir = join(dataDir, ".cloud-handles"); mkdirSync(dir, { recursive: true });
  const checkGate = () => {
    try {
      const owner = JSON.parse(readFileSync(join(dataDir, ".cloud-operation.lock"), "utf8")) as { pid: number };
      if (alive(owner.pid) && !held.getStore()?.has(canonicalRoot(join(dataDir, "..")))) throw new Error("Database open deferred: cloud operation in progress");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  checkGate();
  const path = join(dir, `${process.pid}-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  try { checkGate(); } catch (error) { unlinkSync(path); throw error; }
  return () => { if (existsSync(path)) unlinkSync(path); };
}
export function assertNoDatabaseHandles(root: string): void {
  const dir = join(root, ".code-butler", ".cloud-handles");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      const { pid } = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
      if (alive(pid)) throw new Error("Cloud restore deferred: close or restart existing Butler database sessions");
      unlinkSync(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
