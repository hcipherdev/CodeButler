import { createHash } from "node:crypto";
import { relative, resolve, isAbsolute } from "node:path";
import { globalConfigDir } from "../config.js";

/** A reserved UUIDv8, derived identically in Node and the native helper. */
export function projectCatalogId(vaultId: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(vaultId)) throw new Error("Invalid vault id");
  const bytes = createHash("sha256").update(`code-butler/project-catalog\0${vaultId.toLowerCase()}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 128;
  bytes[8] = (bytes[8]! & 63) | 128;
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function isProjectCatalogId(id: string, vaultId: string): boolean {
  try { return id === projectCatalogId(vaultId); } catch { return false; }
}

/** A secrets stream is a child resource, never another user project slot. */
export function secretsResourceId(parentProjectId: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(parentProjectId)) throw new Error("Invalid project id");
  const bytes = createHash("sha256").update(`code-butler/project-secrets\0${parentProjectId.toLowerCase()}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 128; bytes[8] = (bytes[8]! & 63) | 128;
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function secretsParentProjectId(resourceId: string, projectIds: Iterable<string>): string | undefined {
  for (const id of projectIds) if (secretsResourceId(id) === resourceId) return id;
  return undefined;
}
export function isSecretsResourceId(resourceId: string, projectIds: Iterable<string>): boolean {
  return secretsParentProjectId(resourceId, projectIds) !== undefined;
}

export function classifyAccountResource(id: string, vaultId: string, projectIds: Iterable<string>): "project" | "project-catalog" | "global-rules" | "secrets" {
  if (isProjectCatalogId(id, vaultId)) return "project-catalog";
  // Keep this computation here to avoid a dependency cycle with rules/identity.
  const bytes = createHash("sha1").update(Buffer.from(vaultId.replace(/-/g, ""), "hex")).update("code-butler/global-rules").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const h = bytes.toString("hex"), rules = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  if (id === rules) return "global-rules";
  const ordinary = [...projectIds].filter(parent => parent !== rules && !isProjectCatalogId(parent, vaultId));
  if (isSecretsResourceId(id, ordinary)) return "secrets";
  return "project";
}

export function isProjectCatalogRoot(root: string): boolean {
  const rel = relative(resolve(globalConfigDir(), "cloud", "catalogs"), resolve(root));
  return !rel || (rel !== ".." && !rel.startsWith(`..\\`) && !rel.startsWith("../") && !isAbsolute(rel));
}
