import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { stateDirectory } from "../cloud/state.js";
import type { MemoryStore } from "../storage/store.js";
import { installationDeviceId } from "./origin.js";

/**
 * When a memory was last used or needed attention, so candidate expiry
 * (src/memory/automatic-promotion.ts) never discards one that is still in use. Reads note
 * usage in a checkout file rather than the database, so a search never waits on a sync's
 * write lock; sync ingests the file into memory_usage, which syncs with the memory's layer.
 */
export type MemoryUsageKind = "used" | "correction_proposed";
export interface MemoryUsageRef { category: "candidate" | "promoted"; id: string; layer: string }

const FILE = "memory-usage.jsonl";
const INGESTING = /^memory-usage\.[0-9a-f-]+\.ingesting$/;
/** Noted this process lifetime, so a busy agent appends each memory once a day. */
const noted = new Set<string>();

export function usageDay(at: Date | string = new Date()): string {
  return (typeof at === "string" ? at : at.toISOString()).slice(0, 10);
}

/** Never throws: usage is a hint, and a failed note must not fail the read that made it. */
export function noteMemoryUsage(root: string, refs: readonly MemoryUsageRef[], now: Date = new Date()): void {
  const day = usageDay(now);
  const lines = refs.flatMap((ref) => {
    const key = `${root}\0${day}\0${ref.category}\0${ref.id}`;
    if (noted.has(key)) return [];
    noted.add(key);
    return [JSON.stringify({ category: ref.category, id: ref.id, layer: ref.layer, day })];
  });
  if (lines.length === 0) return;
  try {
    mkdirSync(stateDirectory(root), { recursive: true });
    appendFileSync(join(stateDirectory(root), FILE), `${lines.join("\n")}\n`);
  } catch { /* Usage is best effort. */ }
}

/**
 * Moves noted usage into memory_usage. The file is renamed before it is read, so notes
 * appended meanwhile land in a fresh file; a rename left by an interrupted run is picked up.
 */
export function ingestMemoryUsage(store: MemoryStore, root: string): number {
  const directory = stateDirectory(root);
  try { renameSync(join(directory, FILE), join(directory, `memory-usage.${process.pid}-${Date.now()}.ingesting`)); }
  catch { /* Nothing noted since the last run. */ }
  let pending: string[];
  try { pending = readdirSync(directory).filter((name) => INGESTING.test(name)); } catch { return 0; }
  let recorded = 0;
  for (const name of pending) {
    const path = join(directory, name);
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { category?: unknown; id?: unknown; layer?: unknown; day?: unknown };
        if ((entry.category !== "candidate" && entry.category !== "promoted") || typeof entry.id !== "string" ||
          typeof entry.layer !== "string" || typeof entry.day !== "string") continue;
        recorded += recordMemoryAttention(store, { category: entry.category, id: entry.id, layer: entry.layer }, "used", entry.day);
      } catch { /* A torn line from a crashed writer. */ }
    }
    unlinkSync(path);
  }
  return recorded;
}

/** Records one attention row; returns 1 when it was new. */
export function recordMemoryAttention(store: MemoryStore, ref: MemoryUsageRef, kind: MemoryUsageKind, day: string = usageDay()): number {
  const deviceId = installationDeviceId();
  const id = `usage-${createHash("sha256").update(`${kind}:${ref.category}:${ref.id}:${day}:${deviceId}`).digest("hex").slice(0, 32)}`;
  return Number(store.db.prepare(
    "insert or ignore into memory_usage (id, memory_id, category, layer, kind, day, device_id) values (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, ref.id, ref.category, ref.layer, kind, day, deviceId).changes);
}

/** The latest day any device used the memory or an AI review proposed a correction to it. */
export function lastAttentionDay(store: MemoryStore, category: MemoryUsageRef["category"], id: string): string | undefined {
  const row = store.db.prepare("select max(day) as day from memory_usage where memory_id = ? and category = ?")
    .get(id, category) as { day: string | null } | undefined;
  return row?.day ?? undefined;
}
