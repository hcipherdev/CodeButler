import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { globalConfigDir } from "../config.js";
import { openConfiguredMemoryStore } from "../storage/open-configured-store.js";
import { validateEmptyDatabase } from "../rules/snapshot.js";
import { isReservedProjectId } from "../rules/identity.js";
import { AccountClient } from "./account-client.js";
import { EncryptionError } from "./crypto-helper.js";
import { EncryptedTransport } from "./encrypted-client.js";
import { openSnapshot, type VerifiedSnapshot } from "./encrypted-snapshot.js";
import { saveEncryptedCache, readEncryptedCache } from "./encrypted-coordinator.js";
import { withProjectGate } from "./gate.js";
import { createEncryptedProject, projectTrust } from "./vault-client.js";
import { documentHash, verifyDocument, type SignedDocument } from "./identity-protocol.js";
import { captureSnapshot, bundleResolver, materializeSnapshot, type SnapshotBundle, type SnapshotSegment } from "./snapshot.js";
import { projectCatalogId, secretsResourceId, classifyAccountResource } from "./resource-identity.js";
import { sha256, stateDirectory } from "./state.js";
import { EMPTY_PIN } from "./encrypted-protocol.js";
import type { SecurityStatus } from "./native-security.js";

const entrySchema = z.object({ projectId: z.string().uuid(), label: z.string().trim().min(1).max(100), remoteHints: z.array(z.string().max(512)).max(16), state: z.enum(["pending", "active", "deleted"]),
  secrets: z.object({ resourceId: z.string().uuid(), legacyVaultIds: z.array(z.string().uuid()).max(10).optional() }).strict().optional() }).strict();
const catalogSchema = z.object({ version: z.literal(1), entries: z.record(z.string().uuid(), entrySchema) }).strict();
export type CatalogEntry = z.infer<typeof entrySchema>;
export type CatalogReservation = CatalogEntry & { projectIdentity: string };
export type ProjectCatalog = z.infer<typeof catalogSchema>;
export interface CatalogView { catalog: ProjectCatalog; checkedAt?: string; stale: boolean; error?: string; projects: Array<{ id: string }> }
type CacheRef = ReturnType<typeof saveEncryptedCache>;
interface CatalogJournal { checkoutId: string; applied?: CacheRef; pending?: CacheRef }
const empty = (): ProjectCatalog => ({ version: 1, entries: {} });

export function validateCatalog(value: unknown, vaultId: string): ProjectCatalog {
  const catalog = catalogSchema.parse(value), seen = new Set<string>();
  if (Object.keys(catalog.entries).length > 1000) throw new Error("Account catalog is too large");
  for (const entry of Object.values(catalog.entries)) {
    if (isReservedProjectId(entry.projectId, vaultId) || seen.has(entry.projectId)) throw new EncryptionError("verification-failed");
    seen.add(entry.projectId);
    if (entry.secrets && entry.secrets.resourceId !== secretsResourceId(entry.projectId)) throw new EncryptionError("verification-failed");
    if (entry.remoteHints.some(h => /[\s@?#\\]/.test(h) || h.includes("://") || h.startsWith("/"))) throw new EncryptionError("verification-failed");
  }
  return catalog;
}

export async function catalogAccount(client: AccountClient, refresh = true): Promise<SecurityStatus> {
  const tokens = await client.authSecurity.invoke<{ accountId: string } | null>("tokens-read");
  const status = refresh ? await client.refreshVault() : await client.security.status();
  if (!tokens) throw new EncryptionError("authentication-required");
  if (!status.descriptor) throw new EncryptionError("enrollment-required");
  if (tokens.accountId !== status.descriptor.accountId) throw new EncryptionError("authentication-required");
  return status;
}

export async function requireCatalogCapabilities(client: AccountClient): Promise<void> {
  const capabilities = await client.capabilities();
  if (capabilities.projectCatalog !== 1) throw new EncryptionError("upgrade-required");
  await requireNativeCatalogCapability(client);
}

async function requireNativeCatalogCapability(client: AccountClient): Promise<void> {
  try { if ((await client.security.invoke<{ projectCatalog: number }>("capabilities")).projectCatalog !== 1) throw new Error(); }
  catch { throw new EncryptionError("upgrade-required"); }
}

function rootFor(client: AccountClient, vaultId: string): string {
  return join(globalConfigDir(), "cloud", "catalogs", sha256(client.server), vaultId);
}

export function catalogFromBundle(bundle: SnapshotBundle, vaultId: string): ProjectCatalog {
  if (bundle.manifest.projectId !== projectCatalogId(vaultId) || bundle.manifest.segments.some(s => s.kind === "partition")) throw new EncryptionError("verification-failed");
  const catalog = empty(); let version = false, database = false, config = false;
  for (const file of materializeSnapshot(bundle.manifest, bundleResolver(bundle.blocks)).files) {
    if (file.path === "memory.sqlite") { validateEmptyDatabase(file.data, "Project catalog"); database = true; }
    else if (file.path === "config.json") { if (file.data.toString().trim() !== "{}") throw new EncryptionError("verification-failed"); config = true; }
    else if (file.path === "catalog.json") { z.object({ version: z.literal(1) }).strict().parse(JSON.parse(file.data.toString())); version = true; }
    else if (/^catalog\/[a-f0-9-]{36}\.json$/.test(file.path)) catalog.entries[file.path.slice(8, -5)] = entrySchema.parse(JSON.parse(file.data.toString()));
    else throw new EncryptionError("verification-failed");
  }
  if (!version || !database || !config) throw new EncryptionError("verification-failed");
  return validateCatalog(catalog, vaultId);
}

async function catalogBundle(root: string, id: string, revision: number, checkoutId: string, catalog: ProjectCatalog): Promise<SnapshotBundle> {
  const store = openConfiguredMemoryStore(root); try { store.init(); } finally { store.close(); }
  const captured = await captureSnapshot(root, id, revision, checkoutId, "none");
  const core = captured.snapshot.segments.find(s => s.kind === "core")!;
  validateEmptyDatabase(materializeSnapshot(captured.snapshot, hash => captured.blocks.get(hash)!).files.find(f => f.path === "memory.sqlite")!.data, "Project catalog");
  const segments: SnapshotSegment[] = [core], blocks = new Map<string, Buffer>();
  for (const hash of core.blocks) blocks.set(hash, captured.blocks.get(hash)!);
  const files: Array<[string, unknown]> = [["config.json", {}], ["catalog.json", { version: 1 }], ...Object.entries(catalog.entries).map(([identity, entry]): [string, unknown] => [`catalog/${identity}.json`, entry])];
  for (const [path, value] of files) {
    const bytes = Buffer.from(JSON.stringify(value)), hash = sha256(bytes);
    if (bytes.length > 64 * 1024) throw new Error("Catalog entry is too large");
    blocks.set(hash, bytes); segments.push({ id: `file:${path}`, kind: "file", fingerprint: hash, blocks: [hash], bytes: bytes.length });
  }
  const pathOf = (s: SnapshotSegment) => s.kind === "core" ? "memory.sqlite" : s.id.slice(5);
  segments.sort((a, b) => pathOf(a).localeCompare(pathOf(b)));
  const fingerprint = sha256(JSON.stringify(segments.map(s => [pathOf(s), s.fingerprint])));
  return { manifest: { ...captured.snapshot, fingerprint, segments }, blocks };
}

async function pullCatalog(client: AccountClient, status: SecurityStatus, root: string): Promise<{ remote?: VerifiedSnapshot; catalog: ProjectCatalog; journal: CatalogJournal; transport: EncryptedTransport }> {
  const id = projectCatalogId(status.descriptor!.vaultId), directory = stateDirectory(root);
  mkdirSync(directory, { recursive: true });
  const key = join(root, "checkout-id.json");
  const { readJson, atomicJson } = await import("./state.js");
  let checkoutId = readJson<{ id: string }>(key)?.id;
  if (!checkoutId) { checkoutId = randomUUID(); atomicJson(key, { id: checkoutId }); }
  const journal = await client.security.invoke<CatalogJournal | null>("sync-read", { checkoutId }) ?? { checkoutId };
  const trust = projectTrust(status, id), transport = new EncryptedTransport(client, trust);
  const previous = journal.applied ? await openSnapshot(client.security, trust, readEncryptedCache(directory, journal.applied), undefined, journal.applied.pin) : undefined;
  const remote = await transport.pull(previous);
  if (remote) {
    journal.applied = saveEncryptedCache(directory, remote); delete journal.pending;
    await client.security.invoke("sync-save", { checkoutId, projectId: id, pin: remote.pin, value: journal });
  }
  return { ...(remote ? { remote } : {}), catalog: remote ? catalogFromBundle(remote.bundle, status.descriptor!.vaultId) : empty(), journal, transport };
}

/** Verify deletion receipts independently; omission from a listing is not deletion. */
export async function deletedCatalogProjects(client: AccountClient, status: SecurityStatus): Promise<Set<string>> {
  const receipts = await client.request<Array<{ id: string; membership: string; proof: SignedDocument<Record<string, unknown>> }>>("/v2/projects/deleted");
  const deleted = new Set<string>();
  for (const receipt of receipts) {
    const record = status.records.find(r => documentHash(r) === receipt.membership), p = receipt.proof?.record;
    const device = record?.record.devices.find(d => d.id === p?.deviceId);
    if (!p || !record?.record.projects[receipt.id] || !device || p.kind !== "proof" || p.accountId !== status.descriptor!.accountId || p.method !== "DELETE" || p.path !== `/v2/projects/${receipt.id}` || p.bodyHash !== sha256(Buffer.alloc(0))) throw new EncryptionError("verification-failed");
    verifyDocument(receipt.proof, device.signingKey); deleted.add(receipt.id);
  }
  return deleted;
}

async function cacheCatalog(client: AccountClient, status: SecurityStatus, catalog: ProjectCatalog, projects: Array<{ id: string }>): Promise<CatalogView> {
  const checkedAt = new Date().toISOString();
  await client.security.invoke("catalog-cache-save", { vaultId: status.descriptor!.vaultId, checkedAt, value: { catalog, projects } });
  return { catalog, projects, checkedAt, stale: false };
}

export async function cachedProjectCatalog(client: AccountClient): Promise<CatalogView> {
  await requireNativeCatalogCapability(client);
  const status = await catalogAccount(client, false);
  const cached = await client.security.invoke<{ value: { catalog: unknown; projects: Array<{ id: string }> }; checkedAt: string } | null>("catalog-cache-read");
  return cached ? { catalog: validateCatalog(cached.value.catalog, status.descriptor!.vaultId), projects: cached.value.projects, checkedAt: cached.checkedAt, stale: true } : { catalog: empty(), projects: [], stale: true };
}

export async function readProjectCatalog(client: AccountClient): Promise<CatalogView> {
  await requireCatalogCapabilities(client);
  const status = await catalogAccount(client), vaultId = status.descriptor!.vaultId;
  const projects = z.array(z.object({ id: z.string().uuid() }).passthrough()).parse(await client.request("/v2/projects"));
  const deleted = await deletedCatalogProjects(client, status);
  let catalog = empty();
  if (status.projects[projectCatalogId(vaultId)]) {
    const root = rootFor(client, vaultId); mkdirSync(root, { recursive: true });
    catalog = await withProjectGate(root, async () => (await pullCatalog(client, status, root)).catalog);
  }
  for (const entry of Object.values(catalog.entries)) {
    if (deleted.has(entry.projectId)) entry.state = "deleted";
    else if (entry.state === "active" && !projects.some(p => p.id === entry.projectId)) throw new EncryptionError("verification-failed");
  }
  return cacheCatalog(client, status, catalog, projects.filter(p => classifyAccountResource(p.id, vaultId, Object.keys(status.projects)) === "project"));
}

/** Edits are replayed against the latest verified document after every CAS conflict. */
export async function updateProjectCatalog<T>(client: AccountClient, edit: (catalog: ProjectCatalog) => T): Promise<T> {
  await requireCatalogCapabilities(client);
  let status = await catalogAccount(client);
  const vaultId = status.descriptor!.vaultId, id = projectCatalogId(vaultId), root = rootFor(client, vaultId);
  mkdirSync(root, { recursive: true });
  return withProjectGate(root, async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        status = await catalogAccount(client);
        if (status.descriptor!.vaultId !== vaultId) throw new EncryptionError("authentication-required");
        if (!status.projects[id]) { await createEncryptedProject(client, id); status = await catalogAccount(client); }
        const { remote, catalog, journal, transport } = await pullCatalog(client, status, root);
        const deleted = await deletedCatalogProjects(client, status);
        for (const entry of Object.values(catalog.entries)) if (deleted.has(entry.projectId)) entry.state = "deleted";
        const result = edit(catalog);
        for (const entry of Object.values(catalog.entries)) if (deleted.has(entry.projectId)) entry.state = "deleted";
        validateCatalog(catalog, vaultId);
        const bundle = await catalogBundle(root, id, remote?.pin.revision ?? 0, journal.checkoutId, catalog);
        const prepared = await transport.prepare(bundle, remote);
        if (prepared) {
          journal.pending = saveEncryptedCache(stateDirectory(root), prepared);
          await client.security.invoke("sync-save", { checkoutId: journal.checkoutId, projectId: id, pin: remote?.pin ?? EMPTY_PIN, value: journal });
          const published = await transport.publish(prepared, remote);
          journal.applied = saveEncryptedCache(stateDirectory(root), published); delete journal.pending;
          await client.security.invoke("sync-save", { checkoutId: journal.checkoutId, projectId: id, pin: published.pin, value: journal });
        }
        const projects = await client.request<Array<{ id: string }>>("/v2/projects");
        await cacheCatalog(client, status, catalog, projects.filter(p => classifyAccountResource(p.id, vaultId, Object.keys(status.projects)) === "project"));
        return result;
      } catch (error) { if (!(error instanceof EncryptionError) || error.state !== "conflict" || attempt === 4) throw error; }
    }
    throw new EncryptionError("conflict");
  });
}

export async function reserveCatalogProject(client: AccountClient, identity: string, label: string, remote: string | undefined, existingId?: string, approveRemote = false): Promise<CatalogReservation> {
  const candidate = existingId ?? randomUUID();
  return updateProjectCatalog(client, catalog => {
    // Existing devices publishing the same legacy project must converge on
    // one identity even when neither has received the other's catalog yet.
    const known = existingId ? Object.entries(catalog.entries).find(([, e]) => e.projectId === existingId) : undefined;
    if (known && known[0] !== identity && catalog.entries[identity]) throw new Error("The repository identity already belongs to another cloud project");
    const projectIdentity = known?.[0] ?? identity, current = catalog.entries[projectIdentity];
    if (current?.state === "deleted") throw new Error("This cloud memory was deleted. Start a separate project identity explicitly.");
    if (current && existingId && current.projectId !== existingId) throw new Error("The repository identity already belongs to another cloud project");
    if (remote && current?.remoteHints.length && !current.remoteHints.includes(remote) && !approveRemote) throw new Error("The Git remote changed. Choose whether to continue existing memory or start a separate identity.");
    const entry = current ?? { projectId: candidate, label: label.trim().slice(0, 100) || "Project", remoteHints: [], state: existingId ? "active" as const : "pending" as const };
    if (remote && !entry.remoteHints.includes(remote)) entry.remoteHints.push(remote);
    catalog.entries[projectIdentity] = entry;
    return { ...entry, remoteHints: [...entry.remoteHints], projectIdentity };
  });
}

export async function activateCatalogProject(client: AccountClient, identity: string, id: string): Promise<void> {
  await updateProjectCatalog(client, catalog => {
    const entry = catalog.entries[identity];
    if (!entry || entry.projectId !== id || entry.state === "deleted") throw new EncryptionError("conflict");
    entry.state = "active";
  });
}
