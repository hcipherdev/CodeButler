import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, join } from "node:path";
import { globalConfigDir } from "../config.js";
import { listWatchedProjects, recordWatchedCloudConnection, registerWatchedProject } from "../global-watch.js";
import { assertOrdinaryProject, isReservedProjectId } from "../rules/identity.js";
import { openConfiguredMemoryStore } from "../storage/open-configured-store.js";
import { hasStoredProjectContent } from "../storage/project-content.js";
import { AccountClient } from "./account-client.js";
import { projectOperation } from "./client.js";
import { EncryptionError } from "./crypto-helper.js";
import { catalogAccount, readProjectCatalog, cachedProjectCatalog, reserveCatalogProject, activateCatalogProject, requireCatalogCapabilities, type CatalogView, type CatalogEntry } from "./project-catalog.js";
import { assertBindingIdentity, ensureProjectIdentity, identityCommitStatus, projectRemote, readProjectIdentity } from "./project-identity.js";
import { binding, saveBinding, readJson, atomicJson, serverUrl, stateDirectory, type Binding } from "./state.js";
import { createEncryptedProject } from "./vault-client.js";
import { captureSnapshot } from "./snapshot.js";
import { requestAutomaticSync } from "./sync-owner.js";
import { withProjectGate } from "./gate.js";
import { assertCheckoutReady, checkoutNeedsRepair } from "./checkout-path.js";
import { reviewCheckoutRepair, type CheckoutRepairReview } from "./checkout-repair.js";
import { verifiedLink, checkLinkRemote, assertReviewedLink, consumeLinkReview, LinkReviewRequiredError, type LinkConfirmation } from "./project-link-review.js";

export interface CloudProjectItem { id: string; identity?: string; label: string; state: CatalogEntry["state"]; remoteHints: string[]; folders: Array<{ root: string; available: boolean }> }
export interface CloudProjectList { projects: CloudProjectItem[]; stale: boolean; checkedAt?: string; problem?: string }
export interface ProjectConnectionInspection {
  marker: "missing" | "uncommitted" | "committed";
  identity?: string; remote?: string;
  recognition: "existing" | "remote-changed" | "unlinked" | "legacy" | "deleted" | "unavailable" | "conflict" | "account-changed" | "repair-required";
  projectId?: string; label?: string; populated: boolean; problem?: string;
  provenance: "local-binding" | "portable-marker" | "none";
  repair?: CheckoutRepairReview;
  suggestions: CloudProjectItem[];
  /** Only verified targets for this folder; the account inventory is a separate API. */
  projects: CloudProjectItem[];
}
export interface ConnectProjectOptions { projectId?: string; createNew?: boolean; approveRemote?: boolean; label?: string; enabled?: boolean; client?: AccountClient; confirmation?: LinkConfirmation }

export function selectedCloudClient(): AccountClient {
  const selected = readJson<{ server: string }>(join(globalConfigDir(), "cloud", "account.json"));
  if (!selected?.server) throw new EncryptionError("authentication-required");
  return new AccountClient(serverUrl(selected.server));
}

/** Initialization metadata is scaffolding; every authored/imported memory counts. */
export function hasProjectMemory(root: string): boolean {
  const path = join(root, ".code-butler", "memory.sqlite");
  if (existsSync(path)) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      if (hasStoredProjectContent(db)) return true;
    } finally { db.close(); }
  }
  const containsFiles = (path: string): boolean => existsSync(path) && readdirSync(path, { withFileTypes: true }).some(f => f.isFile() || f.isSymbolicLink() || (f.isDirectory() && containsFiles(join(path, f.name))));
  return ["decisions", "imports"].some(dir => containsFiles(join(root, ".code-butler", dir)));
}

export async function cloudProjectList(refresh = false, suppliedClient?: AccountClient): Promise<CloudProjectList> {
  const client = suppliedClient ?? selectedCloudClient(), status = await catalogAccount(client, false);
  let view: CatalogView;
  try { view = refresh ? await readProjectCatalog(client) : await cachedProjectCatalog(client); }
  catch (error) {
    if (error instanceof EncryptionError && ["verification-failed", "authentication-required", "revoked", "enrollment-required", "upgrade-required"].includes(error.state)) throw error;
    view = await cachedProjectCatalog(client); view.error = error instanceof Error ? error.message : "Cloud catalog unavailable";
  }
  const entries = new Map<string, CloudProjectItem>();
  for (const [identity, entry] of Object.entries(view.catalog.entries)) entries.set(entry.projectId, { id: entry.projectId, identity, label: entry.label, state: entry.state, remoteHints: entry.remoteHints, folders: [] });
  for (const project of view.projects) if (!entries.has(project.id)) entries.set(project.id, { id: project.id, label: project.id, state: "active", remoteHints: [], folders: [] });
  for (const local of listWatchedProjects()) {
    let connection = local.cloud;
    if (existsSync(local.root)) {
      const state = binding(local.root);
      if (state) connection = { server: state.server, vaultId: state.vaultId, projectId: state.projectId, ...(state.projectIdentity ? { projectIdentity: state.projectIdentity } : {}) };
    }
    if (connection?.server !== client.server || connection.vaultId !== status.descriptor!.vaultId) continue;
    const item = entries.get(connection.projectId);
    if (item) item.folders.push({ root: local.root, available: existsSync(join(local.root, ".code-butler", "config.json")) });
  }
  return { projects: [...entries.values()], stale: view.stale, ...(view.checkedAt ? { checkedAt: view.checkedAt } : {}), ...(view.error ? { problem: view.error } : {}) };
}

export async function inspectProjectConnection(root: string, refresh = false, suppliedClient?: AccountClient): Promise<ProjectConnectionInspection> {
  assertOrdinaryProject(root);
  let result: ProjectConnectionInspection = { marker: "missing", recognition: "unlinked", populated: hasProjectMemory(root), provenance: "none", projects: [], suggestions: [] };
  try {
    if (checkoutNeedsRepair(root)) return { ...result, recognition: "repair-required", problem: "Connection needs review. Saved checkout states must be repaired before syncing or creating cloud memory.", repair: reviewCheckoutRepair(root) };
    const marker = readProjectIdentity(root), saved = binding(root), remote = projectRemote(root);
    const current = saved && !["detached", "deleted"].includes(saved.status) ? saved : undefined;
    result = { ...result, marker: identityCommitStatus(root), ...(marker ? { identity: marker.projectIdentity } : {}), ...(remote ? { remote } : {}) };
    if (current) {
      result.projectId = current.projectId; assertBindingIdentity(root, current, true);
      const client = suppliedClient ?? selectedCloudClient(), account = await catalogAccount(client, false);
      if (current.server !== client.server || current.vaultId !== account.descriptor!.vaultId) {
        result.recognition = "account-changed"; result.problem = "This folder is connected to another account. Choose a connection for the signed-in account explicitly.";
        return result;
      }
    }
    const list = await cloudProjectList(refresh, suppliedClient);
    result.suggestions = list.projects.filter(p => p.state !== "deleted" && !!remote && p.remoteHints.includes(remote));
    if (list.stale && refresh) { result.recognition = "unavailable"; result.problem = list.problem ?? "Cloud catalog is stale. Reconnect online before selecting a connection."; return result; }
    const match = marker ? list.projects.find(p => p.identity === marker.projectIdentity) : current ? list.projects.find(p => p.id === current.projectId) : undefined;
    if (match) {
      result.projectId = match.id; result.label = match.label;
      result.provenance = current?.projectId === match.id ? "local-binding" : "portable-marker";
      result.projects = match.state === "deleted" ? [] : [match];
      result.recognition = match.state === "deleted" ? "deleted" : match.remoteHints.length && !match.remoteHints.includes(remote ?? "no-origin") ? "remote-changed" : "existing";
    } else if (current) { result.recognition = "legacy"; result.projectId = current.projectId; result.label = current.label ?? current.projectId; result.provenance = "local-binding"; }
    if (list.stale) result.problem = "Showing the last verified catalog. Butler will verify the connection online before enabling sync.";
  } catch (error) { const message = error instanceof Error ? error.message : "Connection unavailable"; result.recognition = /Git remote changed/.test(message) ? "remote-changed" : /identity/.test(message) ? "conflict" : "unavailable"; result.problem = message; }
  return result;
}

async function retryCreate(client: AccountClient, id: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { if (await createEncryptedProject(client, id) !== id) throw new EncryptionError("verification-failed"); return; }
    catch (error) { if (!(error instanceof EncryptionError) || error.state !== "conflict" || attempt === 4) throw error; }
  }
}

/** A connection change owns both coordinator and local mutation gates in that order. */
export function connectionOperation<T>(root: string, work: () => T | Promise<T>): Promise<T> {
  assertCheckoutReady(root);
  const directory = stateDirectory(root); mkdirSync(directory, { recursive: true, mode: 0o700 });
  return withProjectGate(directory, () => projectOperation(root, () => { assertCheckoutReady(root); return work(); }));
}

export async function connectCloudProject(root: string, options: ConnectProjectOptions = {}): Promise<Binding> {
  assertOrdinaryProject(root);
  return connectionOperation(root, async () => {
    const client = options.client ?? selectedCloudClient();
    await requireCatalogCapabilities(client);
    const status = await catalogAccount(client), vaultId = status.descriptor!.vaultId;
    const current = binding(root), remote = projectRemote(root);
    if (current && current.status !== "detached" && current.status !== "deleted") {
      const sameAccount = current.server === client.server && current.vaultId === vaultId;
      assertBindingIdentity(root, current, true);
      if (!sameAccount && !options.projectId && !options.createNew) throw new Error("Choose a connection for the signed-in account explicitly before replacing this folder's connection.");
      if (sameAccount && options.projectId && current.projectId !== options.projectId) throw new Error("This folder already has a different cloud connection. Start a separate identity explicitly before relinking.");
    }
    const view = await readProjectCatalog(client);
    const existingMarker = readProjectIdentity(root);
    const markerEntry = existingMarker ? view.catalog.entries[existingMarker.projectIdentity] : undefined;
    const requested = options.projectId ?? (current && current.server === client.server && current.vaultId === vaultId && !["detached", "deleted"].includes(current.status) ? current.projectId : undefined) ?? markerEntry?.projectId;
    const known = requested ? Object.entries(view.catalog.entries).find(([, entry]) => entry.projectId === requested) : undefined;
    if (known?.[1].state === "deleted") throw new Error("This cloud memory was deleted. Start a separate project identity explicitly.");
    if (requested && (isReservedProjectId(requested, vaultId) || (!view.projects.some(p => p.id === requested) && known?.[1].state !== "pending"))) throw new Error("The selected cloud project is unavailable to this account");
    if (!existingMarker && !requested && !options.createNew) throw new Error("Choose an existing cloud project or explicitly create new cloud memory.");
    if (!markerEntry && !requested && !options.createNew) throw new Error("Choose an existing cloud project or explicitly create new cloud memory.");
    if (markerEntry?.state === "deleted" || current?.status === "deleted") throw new Error("This cloud memory was deleted. Start a separate identity explicitly.");
    let reviewed = false;
    if (requested) {
      const verified = verifiedLink(root, requested, client, vaultId, view);
      const changedRemote = !!known?.[1].remoteHints.length && !known[1].remoteHints.includes(remote ?? "no-origin");
      if (!verified || options.approveRemote || changedRemote || options.confirmation) {
        if (changedRemote && !options.approveRemote) throw new LinkReviewRequiredError();
        const intent = await assertReviewedLink(root, requested, options.confirmation, client, view);
        if (intent !== (options.approveRemote ? "share-remote" : "recover")) throw new Error("Review the intended connection action before confirming it.");
        if (intent === "share-remote" && (!verified || !existingMarker || known?.[0] !== existingMarker.projectIdentity)) throw new Error("Fork sharing requires a verified matching portable identity.");
        reviewed = true;
      }
      checkLinkRemote(root, requested, view, options.approveRemote ?? false);
      if (current?.remoteHints?.length && !current.remoteHints.includes(remote ?? "no-origin") && !options.approveRemote) throw new LinkReviewRequiredError();
    }
    // All identity, account, remote and signed review checks precede any marker/catalog mutation.
    if (reviewed) consumeLinkReview(root, options.confirmation!);
    let marker = requested && !existingMarker ? undefined : ensureProjectIdentity(root, known?.[0]);
    const label = options.label ?? (requested === current?.projectId && current?.server === client.server && current.vaultId === vaultId ? current.label : undefined) ?? basename(root);
    const entry = await reserveCatalogProject(client, marker?.projectIdentity ?? known?.[0] ?? randomUUID(), label, remote ?? "no-origin", requested, options.approveRemote);
    marker = ensureProjectIdentity(root, entry.projectIdentity);
    const recheck = async () => {
      const active = await catalogAccount(client, false);
      if (active.descriptor!.vaultId !== vaultId) throw new EncryptionError("authentication-required");
      if (readProjectIdentity(root)?.projectIdentity !== marker!.projectIdentity) throw new Error("The project identity changed during setup. Inspect the connection again.");
    };
    await recheck();
    await retryCreate(client, entry.projectId);
    await client.request(`/v2/projects/${entry.projectId}/head`);
    await recheck();
    const store = openConfiguredMemoryStore(root); try { store.init(); } finally { store.close(); }
    const same = current?.projectId === entry.projectId && current.vaultId === vaultId && current.server === client.server && current.status !== "detached";
    const checkoutId = same && current?.checkoutId ? current.checkoutId : randomUUID();
    const captured = await captureSnapshot(root, entry.projectId, 0, checkoutId);
    const enabled = options.enabled ?? (same ? current!.enabled : false);
    const next: Binding = same ? { ...current!, projectIdentity: marker.projectIdentity, enabled, status: enabled ? current!.status === "conflict" ? "conflict" : "ready" : "disabled" } : {
      encryptionVersion: 2, projectIdentity: marker.projectIdentity, projectId: entry.projectId, label: entry.label,
      server: client.server, vaultId, checkoutId, enabled, revision: 0,
      fingerprint: hasProjectMemory(root) ? "" : captured.snapshot.fingerprint, status: enabled ? "ready" : "disabled"
    };
    next.label = entry.label; next.remoteHints = [...entry.remoteHints];
    if (current && !same) atomicJson(join(stateDirectory(root), "previous-bindings", `${randomUUID()}.json`), current);
    saveBinding(root, next); recordWatchedCloudConnection(root, next);
    try { await activateCatalogProject(client, marker.projectIdentity, entry.projectId); }
    catch { atomicJson(join(stateDirectory(root), "catalog-maintenance.json"), { projectIdentity: marker.projectIdentity, projectId: entry.projectId, server: client.server, vaultId }); }
    if (next.enabled) { registerWatchedProject(root); requestAutomaticSync(root); }
    return next;
  });
}

/** Catalog repair is independent of memory publication, including paused bindings. */
export async function retryCatalogMaintenance(root: string, suppliedClient?: AccountClient): Promise<void> {
  const path = join(stateDirectory(root), "catalog-maintenance.json");
  if (!existsSync(path)) return;
  return connectionOperation(root, async () => {
    const pending = readJson<{ projectIdentity: string; projectId: string; server: string; vaultId: string; retryAfter?: number }>(path);
    if (!pending || (pending.retryAfter ?? 0) > Date.now()) return;
    const current = binding(root);
    if (!current || current.projectId !== pending.projectId || current.projectIdentity !== pending.projectIdentity || current.server !== pending.server || current.vaultId !== pending.vaultId) { unlinkSync(path); return; }
    try {
      const client = suppliedClient ?? selectedCloudClient(), account = await catalogAccount(client, false);
      if (client.server !== pending.server || account.descriptor!.vaultId !== pending.vaultId) { atomicJson(path, { ...pending, retryAfter: Date.now() + 60_000 }); return; }
      await activateCatalogProject(client, pending.projectIdentity, pending.projectId);
      unlinkSync(path);
    } catch { atomicJson(path, { ...pending, retryAfter: Date.now() + 60_000 }); }
  });
}

export async function makeProjectPortable(root: string, approveRemote = false, suppliedClient?: AccountClient): Promise<Binding> {
  const current = binding(root);
  if (!current || ["deleted", "detached"].includes(current.status)) throw new Error("Connect this folder to existing cloud memory first");
  return connectCloudProject(root, { projectId: current.projectId, enabled: current.enabled, approveRemote, ...(suppliedClient ? { client: suppliedClient } : {}) });
}

export async function separateProjectIdentity(root: string): Promise<{ identity: string }> {
  assertOrdinaryProject(root);
  return connectionOperation(root, () => {
    const current = binding(root);
    if (current) { atomicJson(join(stateDirectory(root), "previous-bindings", `${randomUUID()}.json`), current); saveBinding(root, { ...current, enabled: false, status: "detached" }); }
    const marker = ensureProjectIdentity(root, undefined, true);
    return { identity: marker.projectIdentity };
  });
}
