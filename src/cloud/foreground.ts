import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicJson, canonicalRoot } from "./state.js";

const LEASE_MS = 45_000;
const RENEW_MS = 10_000;
const ID = /^[a-f0-9-]{36}$/i;

interface ForegroundIntent {
  id: string;
  requestedAt: number;
  expiresAt: number;
}

function directory(root: string): string { return join(canonicalRoot(root), ".code-butler", ".foreground-intents"); }

function intentPath(root: string, id: string): string {
  if (!ID.test(id)) throw new Error("Invalid foreground operation ID");
  return join(directory(root), `${id}.json`);
}

export function activeForegroundIntent(root: string): ForegroundIntent | undefined {
  let dir: string;
  try { dir = directory(root); } catch { return undefined; }
  if (!existsSync(dir)) return undefined;
  let first: ForegroundIntent | undefined;
  const now = Date.now();
  let names: string[];
  try { names = readdirSync(dir); } catch { return undefined; }
  for (const name of names) {
    if (!ID.test(name.replace(/\.json$/, "")) || !name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as ForegroundIntent;
      if (value.id !== name.slice(0, -5) || !Number.isFinite(value.requestedAt) || !Number.isFinite(value.expiresAt) || value.expiresAt <= now) {
        try { unlinkSync(path); } catch { /* A concurrent owner may already have removed it. */ }
        continue;
      }
      if (!first || value.requestedAt < first.requestedAt) first = value;
    } catch {
      // A concurrent renewal is atomic; malformed abandoned records may be discarded.
      try { unlinkSync(path); } catch { /* A concurrent owner may already have removed it. */ }
    }
  }
  return first;
}

export function renewForegroundIntent(root: string, id: string): void {
  const path = intentPath(root, id);
  mkdirSync(directory(root), { recursive: true });
  const now = Date.now();
  let requestedAt = now;
  try {
    const previous = JSON.parse(readFileSync(path, "utf8")) as ForegroundIntent;
    if (previous.id === id && previous.expiresAt > now && Number.isFinite(previous.requestedAt)) requestedAt = previous.requestedAt;
  } catch { /* First renewal. */ }
  atomicJson(path, { id, requestedAt, expiresAt: now + LEASE_MS });
}

export function releaseForegroundIntent(root: string, id: string): void {
  let path: string;
  try { path = intentPath(root, id); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function beginForegroundIntent(root: string, id = randomUUID()): { id: string; release: () => void } {
  renewForegroundIntent(root, id);
  const timer = setInterval(() => {
    try { renewForegroundIntent(root, id); }
    catch { /* An unavailable project leaves the intent to expire. */ }
  }, RENEW_MS);
  timer.unref();
  let released = false;
  return {
    id,
    release: () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      releaseForegroundIntent(root, id);
    }
  };
}
