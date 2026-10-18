import { AccountClient } from "../cloud/account-client.js";
import { EncryptionError } from "../cloud/crypto-helper.js";
import { binding, type Binding } from "../cloud/state.js";
import { assertBindingIdentity, readProjectIdentity } from "../cloud/project-identity.js";
import { readProjectCatalog, updateProjectCatalog } from "../cloud/project-catalog.js";
import { classifyAccountResource, secretsResourceId } from "../cloud/resource-identity.js";
import { createEncryptedProject } from "../cloud/vault-client.js";
import type { SecurityStatus } from "../cloud/native-security.js";
import { selectedSecretServer } from "./state.js";

export interface SecretAccountContext { account: AccountClient; parent: Binding & { projectIdentity: string }; status: SecurityStatus; resourceId: string }
/** Secrets never creates, guesses, or rebinds an ordinary cloud project. */
export async function verifiedSecretAccount(root: string, capturedAccount?: AccountClient): Promise<SecretAccountContext> {
  const parent = binding(root), marker = readProjectIdentity(root), server = selectedSecretServer();
  if (!parent || parent.encryptionVersion !== 2 || !parent.projectIdentity || !marker || marker.projectIdentity !== parent.projectIdentity
    || ["detached", "deleted", "connection-repair-required"].includes(parent.status)) throw new Error("Connect this folder to its existing cloud project before enabling secrets sync.");
  assertBindingIdentity(root,parent);
  const account = capturedAccount ?? new AccountClient(server);
  if (account.server !== server) throw new EncryptionError("authentication-required");
  const status = await account.refreshVault();
  if (server !== parent.server || !status.descriptor || status.descriptor.vaultId !== parent.vaultId) throw new EncryptionError("authentication-required");
  if (classifyAccountResource(parent.projectId,parent.vaultId,Object.keys(status.projects)) !== "project" || !status.projects[parent.projectId]) throw new EncryptionError("verification-failed");
  const view = await readProjectCatalog(account), entry = view.catalog.entries[parent.projectIdentity];
  if (!entry || entry.projectId !== parent.projectId || entry.state !== "active") throw new EncryptionError("verification-failed");
  if ((await account.capabilities() as { accountSecrets?: number }).accountSecrets !== 1
    || (await account.security.invoke<{ accountSecrets?: number }>("capabilities")).accountSecrets !== 1) throw new EncryptionError("upgrade-required");
  return { account, parent: parent as Binding & { projectIdentity: string }, status, resourceId: secretsResourceId(parent.projectId) };
}
export async function ensureAccountSecrets(context: SecretAccountContext, legacyVaultId?: string): Promise<void> {
  await createEncryptedProject(context.account,context.resourceId);
  context.status = await context.account.refreshVault();
  await updateProjectCatalog(context.account,catalog => {
    const entry = catalog.entries[context.parent.projectIdentity];
    if (!entry || entry.projectId !== context.parent.projectId || entry.state !== "active") throw new EncryptionError("conflict");
    const legacyVaultIds = [...new Set([...(entry.secrets?.legacyVaultIds ?? []),...(legacyVaultId ? [legacyVaultId] : [])])];
    entry.secrets = { resourceId: context.resourceId, ...(legacyVaultIds.length ? { legacyVaultIds } : {}) };
  });
}
