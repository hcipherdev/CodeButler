import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { globalConfigDir } from "../config.js";
import type { Binding } from "./state.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export function normalizeWindowsRoot(path: string): string {
  return path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\(?=[a-z]:\\)/i, "").replace(/^[a-z](?=:)/, c => c.toUpperCase());
}
export function canonicalCheckoutRoot(root: string): string {
  return process.platform === "win32" ? normalizeWindowsRoot(realpathSync.native(resolve(root))) : realpathSync(resolve(root));
}
export const checkoutDirectory = (root: string) => join(globalConfigDir(), "cloud", "checkouts", digest(canonicalCheckoutRoot(root)));
export const checkoutRepairPath = (root: string) => join(globalConfigDir(), "cloud", "checkout-repairs", `${digest(canonicalCheckoutRoot(root))}.json`);
export interface CheckoutCandidate { key: string; directory: string; binding?: Binding; secrets?: Record<string, unknown> }
export interface CheckoutRepairRecord { version: 1; root: string; phase: "prepared" | "complete"; candidates: string[]; selected: string; backup: string; files: string[]; hashes: Record<string, string>; sources: Record<string, string>; fingerprint: string }
function json<T>(path: string): T | undefined { if (!existsSync(path)) return undefined; return JSON.parse(readFileSync(path, "utf8")) as T; }

/** Only paths resolving to this very directory may contribute legacy checkout keys. */
export function checkoutCandidates(root: string): CheckoutCandidate[] {
  const canonical = canonicalCheckoutRoot(root), spellings = new Set([canonical, resolve(root)]);
  const registry = join(globalConfigDir(), "watch", "projects");
  if (existsSync(registry)) for (const name of readdirSync(registry).filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
    const record = json<{ root: string; previousRoots?: string[] }>(join(registry, name));
    for (const path of record ? [record.root, ...(record.previousRoots ?? [])] : []) {
      if (typeof path === "string") try { if (canonicalCheckoutRoot(path) === canonical) spellings.add(resolve(path)); } catch { /* Missing folders are never guessed from names. */ }
    }
  }
  for (const path of [...spellings]) {
    try { spellings.add(realpathSync(path)); } catch { /* Only verified aliases above are used. */ }
    if (process.platform === "win32") {
      spellings.add(path.replace(/^[a-z](?=:)/i, c => c.toUpperCase()));
      spellings.add(path.replace(/^[a-z](?=:)/i, c => c.toLowerCase()));
    }
  }
  const record = json<CheckoutRepairRecord>(checkoutRepairPath(root));
  // A completed migration owns these aliases, even though the original backups remain.
  if (record?.phase === "complete") return candidate(checkoutDirectory(root));
  const keys = [...new Set([...spellings].map(digest).concat(record?.phase === "prepared" ? record.candidates.filter(k => /^[a-f0-9]{64}$/.test(k)) : []))];
  return keys.flatMap(key => candidate(join(globalConfigDir(), "cloud", "checkouts", key)));
}
function candidate(directory: string): CheckoutCandidate[] {
  const binding = json<Binding>(join(directory, "binding.json")), secrets = json<Record<string, unknown>>(join(directory, "secrets-binding.json"));
  const hasState = existsSync(directory) && readdirSync(directory).some(n => n !== ".code-butler" && n !== "archived-connection.json" && !/^capture-(?:\d+-)?[a-f0-9-]{36}\.sqlite(?:-wal|-shm)?$/i.test(n));
  return binding || secrets || hasState ? [{ key: directory.split(/[\\/]/).at(-1)!, directory, ...(binding ? { binding } : {}), ...(secrets ? { secrets } : {}) }] : [];
}
export function checkoutNeedsRepair(root: string): boolean {
  const record = json<CheckoutRepairRecord>(checkoutRepairPath(root));
  if (record?.phase === "prepared") return true;
  const candidates = checkoutCandidates(root);
  return candidates.length > 1 || (candidates.length === 1 && candidates[0]!.directory !== checkoutDirectory(root));
}
export class CheckoutRepairRequiredError extends Error {
  constructor() { super("Connection needs review. Restore this folder's saved connection before syncing or creating cloud memory."); }
}
export function assertCheckoutReady(root: string): void { if (checkoutNeedsRepair(root)) throw new CheckoutRepairRequiredError(); }
