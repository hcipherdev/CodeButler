import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { globalConfigDir } from "../config.js";
import { isProjectCatalogId, isProjectCatalogRoot } from "../cloud/resource-identity.js";
import { canonicalCheckoutRoot } from "../cloud/checkout-path.js";

export const globalRulesRoot = (): string => join(globalConfigDir(), "global");
export const rulesDir = (root = globalRulesRoot()): string => join(root, ".code-butler", "rules");
const canonical = (path: string): string => existsSync(path) ? canonicalCheckoutRoot(path) : resolve(path);
export const isGlobalRulesRoot = (root: string): boolean => canonical(root) === canonical(globalRulesRoot());
export function assertOrdinaryProject(root: string): void {
  if (isProjectCatalogRoot(root)) throw new Error("The account catalog cannot be used as project memory");
  const rel = relative(canonical(globalRulesRoot()), canonical(root));
  if (!rel || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel))) throw new Error("Global rules are manually maintained and cannot be used as project memory");
}
export function globalRulesProjectId(vaultId: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(vaultId)) throw new Error("Invalid vault id");
  const bytes = createHash("sha1").update(Buffer.from(vaultId.replace(/-/g, ""), "hex")).update("code-butler/global-rules").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const isReservedProjectId = (id: string, vaultId: string): boolean => isProjectCatalogId(id, vaultId) || (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(vaultId) && id === globalRulesProjectId(vaultId));
export function assertRulesBinding(root: string, value: { projectId: string; vaultId: string; kind?: "project" | "global-rules" | "project-catalog" }): void {
  if (isProjectCatalogId(value.projectId, value.vaultId) || value.kind === "project-catalog" || isProjectCatalogRoot(root)) throw new Error("Use account catalog controls for this resource");
  const reserved = isReservedProjectId(value.projectId, value.vaultId);
  if (reserved || value.kind === "global-rules" || isGlobalRulesRoot(root)) {
    if (!reserved || value.kind !== "global-rules" || !isGlobalRulesRoot(root)) throw new Error("Reserved global rules binding does not match this root");
  }
}
