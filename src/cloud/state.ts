import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, fsyncSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { canonicalCheckoutRoot, checkoutDirectory, checkoutCandidates, checkoutNeedsRepair, assertCheckoutReady } from "./checkout-path.js";
import { globalConfigDir } from "../config.js";

export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export function syncDirectory(path: string): void {
  let fd: number | undefined;
  try { fd = openSync(path, "r"); fsyncSync(fd); }
  catch (error) { if (process.platform !== "win32") throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
/** `syncParent: false` lets a caller writing many files into one directory fsync it once afterwards. */
export function atomicWrite(path: string, value: string | Uint8Array, syncParent = true): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  if (syncParent) syncDirectory(dirname(path));
}
export function atomicJson(path: string, value: unknown): void { atomicWrite(path, JSON.stringify(value)); }
export function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export const canonicalRoot = canonicalCheckoutRoot;
export const stateDirectory = checkoutDirectory;
export interface Connection { server: string; secret: string; vaultId: string }
export interface Binding {
  kind?: "project" | "global-rules" | "project-catalog";
  projectIdentity?: string;
  remoteHints?: string[];
  storage?: import("./storage-diagnostics.js").StorageReport;
  retryAfter?: number;
  encryptionVersion?: 2;
  label?: string;
  projectId: string; server: string; vaultId: string; enabled: boolean;
  revision: number; fingerprint: string; status: string; checkoutId?: string; lastSync?: string;
  syncCondition?: import("./condition.js").CloudSyncCondition;
  syncError?: string;
  pending?: { uploadId: string; fingerprint: string; parentRevision: number };
  /** Why a conflict waits for a person; absent on conflicts recorded before merging became automatic. */
  conflictReason?: "large-deletion" | "policy";
  /** The latest merge published from this checkout, for the desktop to report. */
  lastMerge?: { at: string; automatic: boolean; adopted: number; deleted: number; flagged: number; backup?: string };
  /** When this checkout last published a cloud revision; spaces out unattended publishes. */
  lastPublishedAt?: string;
}
export interface CloudSyncTimings {
  recordedAt: string;
  totalMs: number;
  snapshotMs: number;
  encryptionMs: number;
  networkMs: number;
  uploadedBytes: number;
  downloadedBytes: number;
}
export const connectionPath = (): string => join(globalConfigDir(), "cloud", "connection.json");
export function connection(): Connection {
  const value = readJson<Connection>(connectionPath());
  if (!value) throw new Error("Run code-butler cloud connect first");
  return value;
}
export function binding(root: string): Binding | undefined {
  const saved = readJson<Binding>(join(stateDirectory(root), "binding.json")) ?? checkoutCandidates(root).find(c => c.binding)?.binding;
  return saved && checkoutNeedsRepair(root) ? { ...saved, status: "connection-repair-required", syncError: "Connection needs review. Multiple or legacy checkout states must be repaired before syncing." } : saved;
}
export function saveBinding(root: string, value: Binding): void { assertCheckoutReady(root); atomicJson(join(stateDirectory(root), "binding.json"), value); }
export const UUID = z.string().uuid();
export function ensureCheckoutId(root: string, value: Binding): Binding & { checkoutId: string } {
  const checkoutId = value.checkoutId ? UUID.parse(value.checkoutId) : randomUUID();
  if (checkoutId === value.checkoutId) return value as Binding & { checkoutId: string };
  const next = { ...value, checkoutId };
  saveBinding(root, next);
  return next;
}
export function serverUrl(raw: string): string {
  const url = new URL(raw);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))) throw new Error("Use an HTTPS server origin (HTTP allowed only on localhost)");
  return url.origin;
}
