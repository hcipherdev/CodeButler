import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AccountClient } from "./account-client.js";
import { catalogAccount, readProjectCatalog, type CatalogView } from "./project-catalog.js";
import { binding, canonicalRoot, sha256, stateDirectory, UUID, atomicJson } from "./state.js";
import { assertCheckoutReady } from "./checkout-path.js";
import { readProjectIdentity, projectRemote, PROJECT_IDENTITY_FILE } from "./project-identity.js";
import { canonical, type SignedDocument } from "./identity-protocol.js";
import { databaseFingerprint, materializeSnapshot, bundleResolver } from "./snapshot.js";
import { projectTrust } from "./vault-client.js";
import { EncryptedTransport } from "./encrypted-client.js";
import { assertOrdinaryProject, isReservedProjectId } from "../rules/identity.js";

const pinSchema = z.object({ revision: z.number().int().nonnegative(), commitment: z.string().regex(/^(?:[a-f0-9]{64})?$/) }).strict();
const recordSchema = z.object({
  kind: z.literal("project-link-review"), version: z.literal(1), intent: z.enum(["recover", "share-remote"]), nonce: UUID,
  expiresAt: z.number().int(), root: z.string().min(1).max(4096), server: z.string().max(2048), accountId: UUID, vaultId: UUID,
  projectId: UUID, markerIdentity: UUID.optional(), markerFingerprint: z.string().length(64), remote: z.string().max(512), bindingFingerprint: z.string().length(64),
  localFingerprint: z.string().length(64), catalogFingerprint: z.string().length(64), head: pinSchema
}).strict();
export const linkReviewSchema = z.object({ record: recordSchema, signature: z.string().length(88) }).strict();
export type LinkReview = SignedDocument<z.infer<typeof recordSchema>>;
export interface LinkConfirmation { review: LinkReview; typedProjectId: string }
export interface ProjectLinkReview {
  review: LinkReview; projectId: string; label: string; identity?: string; root: string; remote: string;
  summary: string; memories: number; candidates: number; revision: number;
}
export class LinkReviewRequiredError extends Error {
  constructor() { super("Recover an existing connection using its exact cloud project ID and a reviewed confirmation. Unrelated cloud projects cannot be selected through Enable sync."); }
}
export function localLinkFingerprint(root: string): string {
  const path = join(root, ".code-butler", "memory.sqlite");
  const storedFiles = (dir: string): unknown[] => !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).map(f => {
    if (f.isSymbolicLink() || (!f.isDirectory() && !f.isFile())) throw new Error("Recovery review refuses linked memory files.");
    return [f.name, f.isDirectory() ? storedFiles(join(dir,f.name)) : sha256(readFileSync(join(dir,f.name)))];
  });
  const meta = ["config.json", "project-summary.md"].map(name => { const file = join(root, ".code-butler", name); return [name, existsSync(file) ? sha256(readFileSync(file)) : ""]; });
  return sha256(canonical([existsSync(path) ? databaseFingerprint(path) : "", meta, storedFiles(join(root,".code-butler","decisions")), storedFiles(join(root,".code-butler","imports"))]));
}
function context(root: string) {
  const markerIdentity = readProjectIdentity(root)?.projectIdentity;
  return { ...(markerIdentity ? { markerIdentity } : {}), markerFingerprint: sha256(markerIdentity ? readFileSync(join(root, PROJECT_IDENTITY_FILE)) : "absent"), remote: projectRemote(root) ?? "no-origin", bindingFingerprint: sha256(canonical(binding(root) ?? null)), localFingerprint: localLinkFingerprint(root) };
}
/** A marker or this account's saved binding is proof; a matching remote alone is not. */
export function verifiedLink(root: string, projectId: string, client: AccountClient, vaultId: string, view: CatalogView): boolean {
  const saved = binding(root), marker = readProjectIdentity(root);
  const known = Object.entries(view.catalog.entries).find(([,e]) => e.projectId === projectId);
  if (marker && known && marker.projectIdentity !== known[0]) throw new Error("The selected cloud memory belongs to another portable project identity.");
  const bound = !!saved && !["deleted","detached"].includes(saved.status) && saved.server === client.server && saved.vaultId === vaultId && saved.projectId === projectId;
  if (marker && view.catalog.entries[marker.projectIdentity] && view.catalog.entries[marker.projectIdentity]!.projectId !== projectId) throw new Error("This portable identity is already connected to another cloud project.");
  return bound || (!!marker && known?.[0] === marker.projectIdentity);
}
export function checkLinkRemote(root: string, projectId: string, view: CatalogView, sharing: boolean): void {
  const entry = Object.entries(view.catalog.entries).find(([,e]) => e.projectId === projectId);
  const remote = projectRemote(root) ?? "no-origin";
  if (entry?.[1].remoteHints.length && !entry[1].remoteHints.includes(remote)) {
    if (!sharing || readProjectIdentity(root)?.projectIdentity !== entry[0]) throw new Error("This cloud memory is associated with another Git repository. Use separate memory for this folder.");
  }
}
export async function reviewProjectLink(root: string, projectId: string, intent: "recover" | "share-remote", client: AccountClient): Promise<ProjectLinkReview> {
  assertOrdinaryProject(root); assertCheckoutReady(root); projectId = UUID.parse(projectId);
  const before = context(root), status = await catalogAccount(client), view = await readProjectCatalog(client);
  const target = view.projects.find(p => p.id === projectId), known = Object.entries(view.catalog.entries).find(([,e]) => e.projectId === projectId);
  if (!target || known?.[1].state === "deleted" || isReservedProjectId(projectId, status.descriptor!.vaultId)) throw new Error("The selected cloud project is unavailable to this account.");
  const verified = verifiedLink(root, projectId, client, status.descriptor!.vaultId, view);
  if (intent === "share-remote" && (!verified || !before.markerIdentity || known?.[0] !== before.markerIdentity)) throw new Error("Publish a matching portable identity before reviewing shared fork memory.");
  checkLinkRemote(root, projectId, view, intent === "share-remote");
  const saved = binding(root);
  if (saved && !["detached","deleted"].includes(saved.status) && saved.server === client.server && saved.vaultId === status.descriptor!.vaultId && saved.projectId !== projectId) throw new Error("This folder already has another connection. Review its saved bindings or start separate memory first.");
  const transport = new EncryptedTransport(client, projectTrust(status, projectId)), cloud = await transport.pull();
  if (canonical(before) !== canonical(context(root))) throw new Error("Local memory changed during the review. Reload the recovery review.");
  let summary = "No cloud summary has been published.", memories = 0, candidates = 0;
  if (cloud) {
    const files = materializeSnapshot(cloud.bundle.manifest, bundleResolver(cloud.bundle.blocks)).files;
    summary = files.find(f => f.path === "project-summary.md")?.data.toString("utf8").slice(0,12000) ?? summary;
    // The existing snapshot verifier already validates its database; counts use the same bounded payload.
    const { snapshotContentCounts } = await import("./project-review.js");
    const counts = snapshotContentCounts(cloud.bundle); memories = counts.memories; candidates = counts.candidates;
  }
  const record: LinkReview["record"] = { kind: "project-link-review", version: 1, intent, nonce: randomUUID(), expiresAt: Date.now()+10*60_000, root: canonicalRoot(root), server: client.server, accountId: status.descriptor!.accountId, vaultId: status.descriptor!.vaultId, projectId, ...before, catalogFingerprint: sha256(canonical(view.catalog)), head: cloud?.pin ?? {revision:0,commitment:""} };
  const review = await client.security.signDocument(record);
  return { review, projectId, label: known?.[1].label ?? (saved?.projectId === projectId ? saved.label : undefined) ?? projectId, ...(known ? {identity:known[0]} : {}), root:record.root, remote:record.remote, summary, memories, candidates, revision:record.head.revision };
}
export async function assertReviewedLink(root: string, projectId: string, confirmation: LinkConfirmation | undefined, client: AccountClient, view: CatalogView): Promise<"recover" | "share-remote"> {
  if (!confirmation) throw new LinkReviewRequiredError();
  const review = linkReviewSchema.parse(confirmation.review), record = review.record, status = await catalogAccount(client,false);
  await client.security.verifyDocument(review, status.device!.signingKey);
  if (confirmation.typedProjectId !== projectId || record.projectId !== projectId || record.root !== canonicalRoot(root) || record.server !== client.server || record.vaultId !== status.descriptor!.vaultId || record.accountId !== status.descriptor!.accountId || record.expiresAt < Date.now() || record.expiresAt > Date.now()+10*60_000 || existsSync(join(stateDirectory(root),"link-reviews",`${record.nonce}.json`))) throw new Error("The recovery review is stale or its project ID was not confirmed. Reload it before connecting.");
  const now = context(root);
  if (canonical(now) !== canonical({ ...(record.markerIdentity ? { markerIdentity: record.markerIdentity } : {}), markerFingerprint: record.markerFingerprint, remote: record.remote, bindingFingerprint: record.bindingFingerprint, localFingerprint:record.localFingerprint }) || record.catalogFingerprint !== sha256(canonical(view.catalog))) throw new Error("The account, repository or local memory changed since the review. Reload it before connecting.");
  const head = await new EncryptedTransport(client, projectTrust(status, projectId)).head();
  if (canonical(head) !== canonical(record.head)) throw new Error("Cloud memory changed since the review. Reload it before connecting.");
  const active = await catalogAccount(client, false);
  if (active.descriptor!.accountId !== record.accountId || active.descriptor!.vaultId !== record.vaultId || canonical(context(root)) !== canonical(now)) throw new Error("The account or repository changed since the review. Reload it before connecting.");
  return record.intent;
}
export function consumeLinkReview(root: string, confirmation: LinkConfirmation): void {
  atomicJson(join(stateDirectory(root),"link-reviews",`${confirmation.review.record.nonce}.json`), { consumedAt: new Date().toISOString(), projectId: confirmation.review.record.projectId });
}
