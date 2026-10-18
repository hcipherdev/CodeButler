import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicJson, binding, readJson, stateDirectory, type Binding } from "./state.js";
import { readProjectIdentity } from "./project-identity.js";
import { connectionOperation, inspectProjectConnection } from "./project-connections.js";
import { setEncryptedCloudSyncEnabled } from "./sync-toggle.js";
import { AutomaticAccountChangedError, captureAutomaticAccount, type AutomaticAccountContext } from "./automatic-account.js";

export type AutomaticSetupState = "enabled" | "paused" | "pending" | "review-required" | "local-only";
export interface AutomaticProjectSetup { root: string; state: AutomaticSetupState; reason?: string }
interface PendingConnection { version: 1; projectIdentity: string; state: "pending" | "review-required" | "paused"; account?: { server: string; accountId: string }; retryAfter?: number; reason?: string }
export interface AutomaticConnectionOptions {
  ready?: boolean;
  account?: { server: string; accountId: string };
  force?: boolean;
  inspect?: typeof inspectProjectConnection;
  enable?: typeof setEncryptedCloudSyncEnabled;
  captureAccount?: typeof captureAutomaticAccount;
}
const intentPath = (root: string) => join(stateDirectory(root), "automatic-connection.json");
/** Binding status left by "remove local memory"; unlike a manual pause, re-adding the folder resumes it. */
export const REMOVED_LOCALLY_STATUS = "removed";
const resumesAfterRemoval = (current: Binding | undefined): boolean => current !== undefined && !current.enabled && current.status === REMOVED_LOCALLY_STATUS;
/** The identity automatic setup must keep seeing: the portable marker, else a locally removed binding's identity. */
function expectedIdentity(root: string): string | undefined {
  const current = binding(root);
  return readProjectIdentity(root)?.projectIdentity ?? (resumesAfterRemoval(current) ? current?.projectIdentity : undefined);
}
export function clearAutomaticConnection(root: string): void { clear(root); }
function clear(root: string): void {
  try { unlinkSync(intentPath(root)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
export function pendingAutomaticConnection(root: string): boolean { return readJson<PendingConnection>(intentPath(root))?.state === "pending"; }
export function hasAutomaticConnectionIntent(root: string): boolean { return readJson<PendingConnection>(intentPath(root)) !== undefined; }
export function pauseAutomaticConnection(root: string): void {
  const prior = readJson<PendingConnection>(intentPath(root));
  if (prior) { const { reason: _reason, retryAfter: _retryAfter, ...intent } = prior; atomicJson(intentPath(root), { ...intent, state: "paused" }); }
}

/** Newly added portable folders, and folders re-added after local removal, acquire automatic setup intent. Pauses remain authoritative. */
export function queueAutomaticConnection(root: string, account?: AutomaticConnectionOptions["account"]): AutomaticProjectSetup {
  const current = binding(root);
  if (current && !resumesAfterRemoval(current)) return { root, state: current.enabled ? "enabled" : "paused" };
  const prior = readJson<PendingConnection>(intentPath(root));
  if (prior) return { root, state: prior.state, ...(prior.reason ? { reason: prior.reason } : {}) };
  let projectIdentity;
  try { projectIdentity = expectedIdentity(root); }
  catch (error) { return { root, state: "review-required", reason: error instanceof Error ? error.message : "Review the portable project identity." }; }
  // A legacy binding without a recorded identity has nothing to verify against; it stays manually resumable.
  if (!projectIdentity) return { root, state: current ? "paused" : "local-only" };
  atomicJson(intentPath(root), { version: 1, projectIdentity, state: "pending", ...(account ? { account } : {}) } satisfies PendingConnection);
  return { root, state: "pending" };
}

/** Revalidation uses the current encrypted catalog; it never guesses or creates replacement memory. */
export async function retryAutomaticConnection(root: string, options: AutomaticConnectionOptions = {}): Promise<AutomaticProjectSetup> {
  return connectionOperation(root, () => retryAutomaticConnectionLocked(root, options));
}
async function retryAutomaticConnectionLocked(root: string, options: AutomaticConnectionOptions): Promise<AutomaticProjectSetup> {
  const pending = readJson<PendingConnection>(intentPath(root));
  const current = binding(root);
  if (current && !resumesAfterRemoval(current)) { if (pending) clear(root); return { root, state: current.enabled ? "enabled" : "paused" }; }
  if (!pending) return { root, state: "local-only" };
  if (pending.state !== "pending") return { root, state: pending.state, ...(pending.reason ? { reason: pending.reason } : {}) };
  const superseded = (latest: PendingConnection | undefined): AutomaticProjectSetup | undefined => {
    if (!latest) return { root, state: "local-only" };
    if (latest.state !== "pending") return { root, state: latest.state, ...(latest.reason ? { reason: latest.reason } : {}) };
    if (latest.projectIdentity !== pending.projectIdentity || latest.account?.server !== pending.account?.server || latest.account?.accountId !== pending.account?.accountId) return { root, state: "review-required", reason: "This folder's automatic connection changed during setup. Review its connection." };
    return undefined;
  };
  const save = (state: PendingConnection["state"], reason: string): AutomaticProjectSetup => {
    const latest = readJson<PendingConnection>(intentPath(root)), changed = superseded(latest);
    if (changed) return changed;
    atomicJson(intentPath(root), { ...latest!, state, reason, ...(state === "pending" ? { retryAfter: Date.now() + 60_000 } : {}) });
    return { root, state, reason };
  };
  if (pending.account && options.account && (pending.account.server !== options.account.server || pending.account.accountId !== options.account.accountId)) return save("review-required", "This folder was added for another account. Review its connection.");
  if (!pending.account && options.account) { pending.account = options.account; atomicJson(intentPath(root), pending); }
  if (options.ready === false) return save("pending", "Encrypted sync will start when this computer is enrolled and connected.");
  if (!options.force && (pending.retryAfter ?? 0) > Date.now()) return { root, state: "pending", ...(pending.reason ? { reason: pending.reason } : {}) };
  try {
    const expected = pending.account ?? options.account;
    const context: AutomaticAccountContext | undefined = expected ? await (options.captureAccount ?? captureAutomaticAccount)(expected) : undefined;
    await context?.assertCurrent();
    if (expectedIdentity(root) !== pending.projectIdentity) return save("review-required", "The project identity changed during automatic setup. Review its connection.");
    const inspected = context ? await (options.inspect ?? inspectProjectConnection)(root, true, context.client) : await (options.inspect ?? inspectProjectConnection)(root, true);
    const changed = superseded(readJson<PendingConnection>(intentPath(root)));
    if (changed) return changed;
    if (inspected.recognition === "unavailable") return save("pending", inspected.problem ?? "Waiting for a verified cloud connection.");
    if (inspected.recognition === "unlinked") { clear(root); return { root, state: "local-only" }; }
    if (inspected.recognition !== "existing") return save("review-required", inspected.problem ?? "Review this folder's cloud connection before syncing.");
    await context?.assertCurrent();
    const changedAfterAccountCheck = superseded(readJson<PendingConnection>(intentPath(root)));
    if (changedAfterAccountCheck) return changedAfterAccountCheck;
    if (expectedIdentity(root) !== pending.projectIdentity) return save("review-required", "The project identity changed during automatic setup. Review its connection.");
    const state = context ? await (options.enable ?? setEncryptedCloudSyncEnabled)(root, true, { client: context.client }) : await (options.enable ?? setEncryptedCloudSyncEnabled)(root, true);
    if (context && state && (state.server !== context.client.server || state.vaultId !== context.vaultId)) throw new AutomaticAccountChangedError();
    const changedAfterEnable = superseded(readJson<PendingConnection>(intentPath(root)));
    if (changedAfterEnable) {
      // A pause made during remote setup must take effect before releasing the sync gate.
      await setEncryptedCloudSyncEnabled(root, false);
      return changedAfterEnable;
    }
    clear(root);
    return { root, state: state?.enabled ? "enabled" : "pending" };
  } catch (error) { return save(error instanceof AutomaticAccountChangedError ? "review-required" : "pending", error instanceof Error ? error.message : "Cloud setup will retry when connected."); }
}
