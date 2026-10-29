import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitExecutable } from "../git-executable.js";
import { EncryptionError } from "../cloud/crypto-helper.js";
import { atomicJson, atomicWrite, readJson, serverUrl, stateDirectory, UUID } from "../cloud/state.js";
import { secretsResourceId } from "../cloud/resource-identity.js";
import { globalConfigDir } from "../config.js";
import { isSensitiveGitPath } from "../sources/sensitive-path.js";
import { assertCheckoutReady, checkoutCandidates, checkoutNeedsRepair } from "../cloud/checkout-path.js";

export interface SecretBinding {
  version: 1 | 2;
  server: string;
  vaultId: string;
  /** Version 2 uses the account vault and a deterministic child resource. */
  parentProjectId?: string;
  resourceId?: string;
  legacyVaultId?: string;
  migration?: "pending" | "conflict" | "review-required";
  checkoutId: string;
  enabled: boolean;
  status: "disabled" | "recovery-required" | "approval-required" | "ready" | "syncing" | "synced" | "conflict" | "error" | "migration-required";
  phase?: string;
  revision: number;
  lastSync?: string;
  error?: string;
  warnings?: string[];
}
const bindingPath = (root: string) => join(stateDirectory(root), "secrets-binding.json");
export const legacySecretCacheDirectory = (root: string) => join(stateDirectory(root), "secrets-cache");
export const accountSecretCacheDirectory = (root: string) => join(stateDirectory(root), "secrets-account-cache");
export const secretCacheDirectory = (root: string) => secretBinding(root)?.version === 2 ? accountSecretCacheDirectory(root) : legacySecretCacheDirectory(root);
export function secretBinding(root: string): SecretBinding | undefined {
  const value = readJson<SecretBinding>(bindingPath(root)) ?? checkoutCandidates(root).find(c => c.secrets)?.secrets as SecretBinding | undefined;
  if (!value) return undefined;
  if (![1, 2].includes(value.version) || !UUID.safeParse(value.vaultId).success || !UUID.safeParse(value.checkoutId).success
    || typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new EncryptionError("verification-failed");
  if (value.version === 2 && (!UUID.safeParse(value.parentProjectId).success || !UUID.safeParse(value.resourceId).success
    || value.resourceId !== secretsResourceId(value.parentProjectId!))) throw new EncryptionError("verification-failed");
  return checkoutNeedsRepair(root) ? { ...value, status: "error", error: "Connection needs review. Repair saved checkout states before syncing secrets." } : value;
}
export function saveSecretBinding(root: string, value: SecretBinding): void { assertCheckoutReady(root); atomicJson(bindingPath(root), value); }
export function selectedSecretServer(): string {
  const selection = readJson<{ server?: string }>(join(globalConfigDir(), "cloud", "account.json"));
  if (!selection?.server) throw new EncryptionError("authentication-required");
  return serverUrl(selection.server);
}
/** Check the index without opening any secret value, then add a root-anchored ignore rule. */
export function ensureSecretsGitGuard(root: string): void {
  try {
    const tracked = execFileSync(gitExecutable(), ["ls-files", "-z", "--cached"], { cwd: root, maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
      .toString("utf8").split("\0").some(path => path && isSensitiveGitPath(path) && path.split("/")[0]?.toLowerCase() === "secrets");
    if (tracked) throw new Error("Secret files are tracked by Git. Remove them from the index and rotate any exposed credentials before enabling sync.");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Secret files are tracked")) throw error;
    // A project without Git still receives the ignore rule for future initialization.
    if ((error as { status?: number }).status !== 128) throw error;
  }
  const path = join(root, ".gitignore");
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error("The project .gitignore is not a regular file.");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (/^\/?secrets\/\s*$/m.test(existing)) return;
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  atomicWrite(path, `${existing}${existing && !existing.endsWith("\n") ? newline : ""}/secrets/${newline}`);
}
