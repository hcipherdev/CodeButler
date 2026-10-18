import { existsSync, lstatSync, realpathSync, rmSync, mkdirSync } from "node:fs";
import { assertOrdinaryProject, isReservedProjectId } from "../rules/identity.js";
import { purgeRetrieval } from "../retrieval/privacy.js";
import { join, resolve } from "node:path";
import { AccountClient } from "../cloud/account-client.js";
import { assertNoDatabaseHandles, withProjectGate } from "../cloud/gate.js";
import { markProjectRemoved } from "../cloud/removal-state.js";
import { clearAutomaticConnection, REMOVED_LOCALLY_STATUS } from "../cloud/auto-connect.js";
import { binding, saveBinding, stateDirectory, UUID, type Binding } from "../cloud/state.js";
import { unregisterWatchedProject } from "../global-watch.js";
import { updateProjectCatalog } from "../cloud/project-catalog.js";

export type RemovalMode = "list" | "local" | "everywhere";

export async function deleteCloudProject(state: Binding): Promise<void> {
  if (state.kind === "global-rules" || isReservedProjectId(state.projectId, state.vaultId)) throw new Error("Global rules cannot be removed as a project");
  if (state.encryptionVersion !== 2) throw new Error("This cloud project must be upgraded before it can be deleted from the desktop.");
  const client = new AccountClient(state.server);
  const security = await client.refreshVault();
  if (security.descriptor?.vaultId !== state.vaultId || !security.projects[state.projectId]) {
    throw new Error("Sign in to the account and enrolled device that owns this cloud project.");
  }
  const result = await client.request<{ deleted: boolean }>(`/v2/projects/${UUID.parse(state.projectId)}`, "DELETE");
  if (result.deleted !== true) throw new Error("The server did not confirm project deletion.");
  try {
    await updateProjectCatalog(client, catalog => {
      for (const entry of Object.values(catalog.entries)) if (entry.projectId === state.projectId) entry.state = "deleted";
    });
  } catch { /* Signed deletion receipts override catalog state on every fresh read. */ }
}

/** Only this literal child is deleted; never follow a junction to another folder. */
function memoryDirectory(root: string): string {
  const directory = join(root, ".code-butler");
  if (existsSync(directory)) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || resolve(realpathSync(directory)).toLowerCase() !== resolve(directory).toLowerCase()) {
      throw new Error("The .code-butler path is not a normal project directory. Remove it manually after checking its target.");
    }
  }
  return directory;
}

export async function removeDesktopProject(root: string, mode: RemovalMode, removeCloud = deleteCloudProject): Promise<void> {
  assertOrdinaryProject(root);
  if (mode === "list") { unregisterWatchedProject(root); return; }
  memoryDirectory(root);
  const checkout = stateDirectory(root);
  mkdirSync(checkout, { recursive: true });
  // Match encrypted sync's lock order: checkout coordinator, then local project.
  await withProjectGate(checkout, () => withProjectGate(root, async () => {
    const directory = memoryDirectory(root);
    assertNoDatabaseHandles(root);
    const cloud = binding(root);
    if (mode === "everywhere" && cloud) {
      // Keep retry credentials and all local memory if the server is unavailable.
      try { await removeCloud(cloud); }
      catch { throw new Error("Online deletion was not confirmed. Local memory and the project list were kept. Check your connection, cloud login and server version, then retry."); }
    }
    // A local removal is not a pause: re-adding the folder reconnects it automatically.
    if (cloud) saveBinding(root, { ...cloud, enabled: false, status: mode === "everywhere" ? "deleted" : REMOVED_LOCALLY_STATUS });
    clearAutomaticConnection(root);
    // Persist outside the deleted folder so queued operations cannot recreate it.
    markProjectRemoved(root);
    purgeRetrieval(root);
    rmSync(directory, { recursive: true, force: true });
    unregisterWatchedProject(root);
  }, { allowRemoved: true }));
}
