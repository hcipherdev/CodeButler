import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, realpathSync, openSync, closeSync, fsyncSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { globalConfigDir } from "../config.js";

export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export function syncDirectory(path: string): void {
  let fd: number | undefined;
  try { fd = openSync(path, "r"); fsyncSync(fd); }
  catch (error) { if (process.platform !== "win32") throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function atomicWrite(path: string, value: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}
export function atomicJson(path: string, value: unknown): void { atomicWrite(path, JSON.stringify(value)); }
export function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export function canonicalRoot(root: string): string { return realpathSync(resolve(root)); }
export function stateDirectory(root: string): string { return join(globalConfigDir(), "cloud", "checkouts", sha256(canonicalRoot(root))); }
export interface Connection { server: string; secret: string; vaultId: string }
export interface Binding {
  projectId: string; server: string; vaultId: string; enabled: boolean;
  revision: number; fingerprint: string; status: string; checkoutId?: string; lastSync?: string;
  pending?: { uploadId: string; fingerprint: string; parentRevision: number };
}
export const connectionPath = (): string => join(globalConfigDir(), "cloud", "connection.json");
export function connection(): Connection {
  const value = readJson<Connection>(connectionPath());
  if (!value) throw new Error("Run code-butler cloud connect first");
  return value;
}
export function binding(root: string): Binding | undefined { return readJson<Binding>(join(stateDirectory(root), "binding.json")); }
export function saveBinding(root: string, value: Binding): void { atomicJson(join(stateDirectory(root), "binding.json"), value); }
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
