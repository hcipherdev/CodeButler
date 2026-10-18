import { assertOrdinaryProject, isReservedProjectId } from "../rules/identity.js";
import { registerWatchedProject } from "../global-watch.js";
import { EncryptionError } from "./crypto-helper.js";
import { binding, saveBinding, type Binding } from "./state.js";
import { assertBindingIdentity, projectRemote } from "./project-identity.js";
import { catalogAccount, cachedProjectCatalog } from "./project-catalog.js";
import { connectionOperation, connectCloudProject, selectedCloudClient, type ConnectProjectOptions } from "./project-connections.js";
import { requestAutomaticSync } from "./sync-owner.js";

/** Resuming a known binding does not create a project or require an online catalog. */
export async function setEncryptedCloudSyncEnabled(root: string, enabled: boolean, options: ConnectProjectOptions = {}): Promise<Binding | undefined> {
  assertOrdinaryProject(root);
  return connectionOperation(root, async () => {
    const current = binding(root);
    if (current && isReservedProjectId(current.projectId, current.vaultId)) throw new Error("Use the resource's dedicated sync controls");
    if (!enabled) {
      if (!current) return undefined;
      const next = { ...current, enabled: false, status: current.status === "detached" ? "detached" : current.status === "deleted" ? "deleted" : "disabled" };
      saveBinding(root, next); return next;
    }
    if (current?.status === "deleted") throw new Error("This cloud memory was deleted. Start a separate identity explicitly.");
    if (current && current.status !== "detached" && !options.projectId && !options.approveRemote && !options.createNew) {
      if (current.encryptionVersion !== 2) throw new EncryptionError("upgrade-required");
      assertBindingIdentity(root, current, true);
      const client = options.client ?? selectedCloudClient(), local = await catalogAccount(client, false);
      if (client.server !== current.server || local.descriptor!.vaultId !== current.vaultId) throw new EncryptionError("authentication-required");
      if (current.projectIdentity && (await cachedProjectCatalog(client)).catalog.entries[current.projectIdentity]?.state === "deleted") {
        saveBinding(root, { ...current, enabled: false, status: "deleted" });
        throw new Error("This cloud memory was deleted. Start a separate identity explicitly.");
      }
      const remote = projectRemote(root) ?? "no-origin";
      if (current.remoteHints?.length && !current.remoteHints.includes(remote)) return connectCloudProject(root, { ...options, enabled: true });
      const next = { ...current, enabled: true, status: current.status === "conflict" ? "conflict" : "ready" };
      saveBinding(root, next); registerWatchedProject(root); requestAutomaticSync(root); return next;
    }
    return connectCloudProject(root, { ...options, enabled: true });
  });
}
