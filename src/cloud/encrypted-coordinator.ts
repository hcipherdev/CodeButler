import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { globalConfigDir, loadProjectConfig } from "../config.js";
import { openConfiguredMemoryStore } from "../storage/open-configured-store.js";
import { CURRENT_SCHEMA_VERSION } from "../storage/migrations.js";
import { AccountClient } from "./account-client.js";
import { NativeSecurity } from "./native-security.js";
import { projectOperation, applyCoreMerge, localCloudChangeStamp } from "./client.js";
import { automaticMergeHold, memoryChanges, MergeHeldError } from "./merge.js";
import { automaticSyncStatus } from "./sync-owner.js";
import { EncryptionError } from "./crypto-helper.js";
import { EncryptedTransport, type PreparedPublication } from "./encrypted-client.js";
import { EMPTY_PIN, commitment, type RevisionPin } from "./encrypted-protocol.js";
import { openSnapshot, rebasePartitions, type EncryptedBundle, type VerifiedSnapshot } from "./encrypted-snapshot.js";
import { withProjectGate } from "./gate.js";
import { assertCheckoutReady } from "./checkout-path.js";
import { applySnapshot, bundleResolver, captureFingerprint, captureSnapshot, materializeSnapshot, type SnapshotBundle } from "./snapshot.js";
import { atomicJson, atomicWrite, binding, ensureCheckoutId, readJson, saveBinding, sha256, stateDirectory, type Binding, type CloudSyncTimings } from "./state.js";
import { projectTrust } from "./vault-client.js";
import { recordCloudSyncError } from "./condition.js";
import { syncProgressWriter } from "./sync-progress.js";
import { assertRulesBinding } from "../rules/identity.js";
import { assertBindingIdentity, ProjectLinkChangedError } from "./project-identity.js";
import { encodeBundle } from "./snapshot.js";
import { randomUUID } from "node:crypto";

export interface MemoryReviewSummary { memories: number; candidates: number; sources: number }
export interface SyncReview { projectId: string; localFingerprint: string; remote: RevisionPin; canMerge: boolean; firstConnection?: boolean; localSummary?: MemoryReviewSummary; cloudSummary?: MemoryReviewSummary }



interface CacheRef { hash: string; pin: RevisionPin; epoch?: number; membership?: string }
/**
 * `merge` marks a pending upload that carries a merge, which is redone rather than dropped when
 * the cloud moves on; `"automatic"` merges are redone under the same deletion hold. `summary`
 * travels with the upload so a merge published by a later run is still reported.
 */
interface SyncJournal { fingerprint: string; applied?: CacheRef; remote?: CacheRef; pending?: CacheRef & { merge?: true | "automatic"; summary?: Binding["lastMerge"] } }
export function saveEncryptedCache(directory: string, bundle: EncryptedBundle): CacheRef {
  const bytes = gzipSync(Buffer.from(JSON.stringify({ envelope: bundle.envelope,
    ...( "receipt" in bundle ? { receipt: bundle.receipt } : {}),
    objects:Object.fromEntries([...bundle.objects].map(([id,b])=>[id,b.toString("base64")]))})));
  const hash = sha256(bytes), path = join(directory,`${hash}.encrypted.gz`);
  if (!existsSync(path) || sha256(readFileSync(path)) !== hash) atomicWrite(path,bytes);
  return {hash,pin:{revision:bundle.envelope.revision,commitment:commitment(bundle.envelope)},epoch:bundle.envelope.epoch,membership:bundle.envelope.membership};
}
export async function pruneEncryptedCaches(directory: string, security: AccountClient["security"]): Promise<number> {
  // The native vault owns every sync journal. If it cannot enumerate the full
  // reference set, leave all caches intact rather than guessing from one checkout.
  const securities: AccountClient["security"][] = [security];
  const securityRoot = join(globalConfigDir(), "cloud", "security");
  if (security.directory && existsSync(securityRoot)) for (const name of readdirSync(securityRoot)) {
    const path = join(securityRoot, name);
    if (/^[a-f0-9]{64}$/.test(name) && statSync(path).isDirectory() && path !== security.directory)
      securities.push(new NativeSecurity(path));
  }
  const retained = new Set<string>();
  const rulesIntentPath = join(directory, "rules-sync-apply.json");
  if (existsSync(rulesIntentPath)) {
    try { const intent = JSON.parse(readFileSync(rulesIntentPath, "utf8")) as { accepted?: { hash: string } }; if (intent.accepted) retained.add(intent.accepted.hash); }
    catch { return 0; }
  }
  for (const vault of securities) {
    const refs = await vault.invoke<string[]>("sync-list-cache-refs", {});
    if (!Array.isArray(refs) || refs.some(ref => !/^[a-f0-9]{64}$/.test(ref))) return 0;
    for (const ref of refs) retained.add(ref);
  }
  let removed = 0;
  for (const name of readdirSync(directory)) {
    if (!/^[a-f0-9]{64}\.encrypted\.gz$/.test(name) || retained.has(name.slice(0, 64))) continue;
    const path = join(directory, name);
    // A newly written cache might still be in the process of journal publication.
    if (Date.now() - statSync(path).mtimeMs < 60 * 60_000) continue;
    unlinkSync(path); removed++;
  }
  return removed;
}
export function readEncryptedCache(directory: string, ref: CacheRef): PreparedPublication {
  if (!/^[a-f0-9]{64}$/.test(ref.hash)) throw new EncryptionError("verification-failed");
  const bytes = readFileSync(join(directory,`${ref.hash}.encrypted.gz`));
  if (sha256(bytes)!==ref.hash) throw new EncryptionError("verification-failed");
  const parsed = JSON.parse(gunzipSync(bytes,{maxOutputLength:256*1024*1024}).toString()) as PreparedPublication & {objects:Record<string,string>};
  return {...parsed,objects:new Map(Object.entries(parsed.objects).map(([id,b])=>[id,Buffer.from(b,"base64")]))};
}
export async function encryptedCloudSync(root: string, keep?: "local" | "cloud" | "merge", suppliedClient?: AccountClient, review?: SyncReview): Promise<Binding | undefined> {
  assertCheckoutReady(root);
  const initial = binding(root);
  if (!initial?.enabled) {
    if (review) throw new Error("The connection changed since the review. Reload before applying a choice.");
    return initial;
  }
  assertRulesBinding(root, initial);
  if (initial.kind === "global-rules") {
    if (keep) throw new Error("Resolve individual rules through the manual rules editor");
    return (await import("../rules/sync.js")).encryptedRulesSync(root, suppliedClient ?? new AccountClient(initial.server));
  }
  const directory = stateDirectory(root); atomicJson(join(directory,"coordinator.json"),{version:2});
  const client = suppliedClient ?? new AccountClient(initial.server);
  const progress = syncProgressWriter(root);
  let ownsGate = false;
  const started = performance.now();
  const networkBefore = { ...client.networkTiming };
  let snapshotMs = 0, encryptionMs = 0;
  const measuredCapture = async (...args: Parameters<typeof captureSnapshot>) => {
    const since = performance.now();
    // Project memory publishes format v4; global rules and the project catalog keep v3.
    try { return await captureSnapshot(args[0], args[1], args[2], args[3], args[4], { ...args[5], rowStream: true }); }
    finally { snapshotMs += performance.now() - since; }
  };
  // Checks that only ask whether local memory moved skip the encoding a publishable capture needs.
  const measuredFingerprint = async () => {
    const since = performance.now();
    try { return await captureFingerprint(root); }
    finally { snapshotMs += performance.now() - since; }
  };
  try {
    return await withProjectGate(directory,async () => {
      ownsGate = true; progress.phase("checking");
      assertCheckoutReady(root);
      let state = ensureCheckoutId(root,binding(root)!);
      if (!state.enabled) {
        if (review) throw new Error("The connection changed since the review. Reload before applying a choice.");
        return state;
      }
      if (review && review.projectId !== state.projectId) throw new Error("The connection changed since the review. Reload before applying a choice.");
      assertBindingIdentity(root, state);
      if (state.server !== client.server || state.projectId !== initial.projectId || state.vaultId !== initial.vaultId) throw new EncryptionError("conflict");
      const selected = readJson<{ server: string }>(join(globalConfigDir(), "cloud", "account.json"));
      if (!suppliedClient && selected && selected.server !== state.server) throw new EncryptionError("authentication-required");
      const localAccount = await client.security.status(), tokens = await client.authSecurity.invoke<{ accountId: string } | null>("tokens-read");
      if (!tokens || tokens.accountId !== localAccount.descriptor?.accountId || localAccount.descriptor.vaultId !== state.vaultId) throw new EncryptionError("authentication-required");
      let journal = await client.security.invoke<SyncJournal | null>("sync-read",{checkoutId:state.checkoutId}) ?? {fingerprint:state.fingerprint};
      try { await pruneEncryptedCaches(directory, client.security); } catch { /* Old native helpers leave caches untouched. */ }
      const { shareLocalLayers: share, conflictPolicy } = loadProjectConfig(root).sync;
      const persist = async (pin:RevisionPin) => {
        await client.security.invoke("sync-save",{checkoutId:state.checkoutId,projectId:state.projectId,pin,value:journal});
        if(state.status==="synced"){delete state.retryAfter;state.syncCondition="synced";delete state.syncError;delete state.conflictReason;}
        state.fingerprint = journal.fingerprint; state.revision = journal.applied?.pin.revision ?? 0;
        state.lastSync = new Date().toISOString(); saveBinding(root,state);
      };
      try {state.storage={...await client.request<import("./protocol-types.js").StorageUsageReport>(`/v2/projects/${state.projectId}/storage`),checkedAt:new Date().toISOString()};}catch{/* Old servers and offline diagnostics must not block sync. */}
      // The cloud revision a merge being redone was built on: its own changes are already local.
      let mergeBase: VerifiedSnapshot | undefined, automatic = false, carried: Binding["lastMerge"];
      for(let attempt=0;attempt<3;attempt++) {
        let merged: true | "automatic" | undefined, mergeSummary: Binding["lastMerge"];
        const status = await client.refreshVault();
        if (status.descriptor?.vaultId !== state.vaultId) throw new EncryptionError("authentication-required");
        assertBindingIdentity(root, state);
        const trust = projectTrust(status,state.projectId), transport = new EncryptedTransport(client,trust);
        const verifyReviewedHead = async () => {
          if (!review) return;
          const head = await transport.head();
          if (head.revision !== review.remote.revision || head.commitment !== review.remote.commitment) throw new Error("Cloud memory changed since the review. Reload the conflict before applying a choice.");
        };
        const completed = automaticSyncStatus(root);
        if (!keep && state.status === "synced" && !journal.pending && journal.applied?.epoch === trust.epoch &&
            journal.applied.membership === trust.membership && completed.lastLocalStamp === localCloudChangeStamp(root)) {
          const head = await transport.head();
          if (head.revision === journal.applied.pin.revision && head.commitment === journal.applied.pin.commitment) {
            await persist(head); return state;
          }
        }
        const decode = async (ref:CacheRef | undefined) => ref ? openSnapshot(client.security,trust,readEncryptedCache(directory,ref),undefined,ref.pin) : undefined;
        const ancestor = await decode(journal.applied), cached = await decode(journal.remote ?? journal.applied);
        let remote = await transport.pull(cached);
        const pin = remote?.pin ?? EMPTY_PIN;
        if (remote) journal.remote = saveEncryptedCache(directory,remote);
        // Persist accepted trust even when applying is deferred by a local conflict.
        await persist(pin);
        if (journal.pending && !review) {
          const prepared = readEncryptedCache(directory,journal.pending);
          const summary = journal.pending.summary;
          if (remote?.pin.commitment === journal.pending.pin.commitment) {
            if (summary) state.lastMerge = summary;
            state.lastPublishedAt = new Date().toISOString();
            const { merge: _merge, summary: _summary, ...published } = journal.pending;
            journal.applied = published; journal.fingerprint = remote.bundle.manifest.fingerprint; delete journal.pending;
            state.status="synced"; await persist(pin); continue;
          }
          if (prepared.envelope.parentCommitment === (remote?.pin.commitment ?? null) && prepared.envelope.membership === trust.membership && prepared.envelope.epoch === trust.epoch) {
            try {
              remote = await transport.publish(prepared,remote,progress.upload);
              journal.applied = saveEncryptedCache(directory,remote); journal.remote=journal.applied; journal.fingerprint=remote.bundle.manifest.fingerprint; delete journal.pending;
              if (summary) state.lastMerge = summary;
              state.lastPublishedAt = new Date().toISOString();
              state.status="synced"; await persist(remote.pin); continue;
            } catch(error) { if (!(error instanceof EncryptionError) || error.state!=="conflict") throw error; continue; }
          }
          // Preserve the file for reconciliation; its pointer ceases to be a pending upload.
          const redo = journal.pending.merge; carried = summary;
          delete journal.pending; await persist(pin);
          // A chosen merge is already applied locally; redo it on the newer cloud revision instead of reporting a conflict.
          if (redo && remote && !keep) {
            keep = "merge"; automatic = redo === "automatic";
            mergeBase = cached?.pin.commitment === prepared.envelope.parentCommitment ? cached : ancestor;
          }
        }
        await projectOperation(root,() => {
          const store=openConfiguredMemoryStore(root); try {store.init();} finally {store.close();}
        }, { name: "Prepare cloud snapshot" });
        let local = await measuredCapture(root,state.projectId,remote?.pin.revision ?? 0,state.checkoutId,share);
        if (review) {
          if (review.projectId !== state.projectId || review.localFingerprint !== local.snapshot.fingerprint || review.remote.revision !== pin.revision || review.remote.commitment !== pin.commitment) throw new Error("Memory changed since the review. Reload the conflict before applying a choice.");
          await projectOperation(root, async () => {
            assertBindingIdentity(root, state);
            await verifyReviewedHead();
            const current = await measuredCapture(root, state.projectId, pin.revision, state.checkoutId, share);
            if (current.snapshot.fingerprint !== review!.localFingerprint) throw new Error("Memory changed since the review. Reload the conflict before applying a choice.");
            const backup = join(root, ".code-butler", "backups", "reconnect", randomUUID());
            atomicWrite(join(root, ".code-butler", "backups", "reconnect", ".gitignore"), Buffer.from("*\n"));
            const complete = share === "all" ? current : await measuredCapture(root, state.projectId, pin.revision, state.checkoutId, "all");
            atomicWrite(`${backup}-local.snapshot.gz`, encodeBundle({ manifest: complete.snapshot, blocks: complete.blocks }));
            if (remote) atomicWrite(`${backup}-cloud.snapshot.gz`, encodeBundle(remote.bundle));
          });
          delete journal.pending;
        }
        const localChanged = local.snapshot.fingerprint !== journal.fingerprint;
        const remoteCoreChanged = remote && remote.bundle.manifest.fingerprint !== journal.fingerprint;
        const diverged = !keep && localChanged && remoteCoreChanged && local.snapshot.fingerprint !== remote!.bundle.manifest.fingerprint;
        // Both sides changed: the three-way merge settles disjoint edits and flags competing ones per memory.
        if (diverged && conflictPolicy === "merge") { keep = "merge"; automatic = true; }
        if (keep === "merge") {
          // No ancestor means a first connection; the merge then treats each side's rows as additions.
          if (!remote) throw new EncryptionError("conflict");
          progress.phase("merging");
          let result: ReturnType<typeof applyCoreMerge>;
          try {
            result = await projectOperation(root,async () => {
              assertBindingIdentity(root, state);
              await verifyReviewedHead();
              if(await measuredFingerprint()!==local.snapshot.fingerprint) throw new EncryptionError("conflict");
              // Unattended merges keep their pre-merge backup and wait for a person before a large deletion.
              return applyCoreMerge(root,remote!.bundle,(mergeBase ?? ancestor)?.bundle,automatic ? { hold: automaticMergeHold, keepBackup: true } : {});
            });
          } catch (error) {
            if (!(error instanceof MergeHeldError)) throw error;
            state.status="conflict"; state.conflictReason=error.reason; await persist(pin); return state;
          }
          const changes = memoryChanges(result);
          // A redone merge reports both passes; the first backup is the one taken before any merge.
          mergeSummary = { at: new Date().toISOString(), automatic,
            adopted: changes.adopted + (carried?.adopted ?? 0), deleted: changes.deleted + (carried?.deleted ?? 0), flagged: changes.flagged + (carried?.flagged ?? 0),
            ...(carried?.backup ?? result.backup ? { backup: carried?.backup ?? result.backup } : {}) };
          carried = undefined;
          merged = automatic ? "automatic" : true; mergeBase = undefined; automatic = false;
          keep="local"; local=await measuredCapture(root,state.projectId,pin.revision,state.checkoutId,share);
        } else if (diverged) {
          state.status="conflict"; state.conflictReason="policy"; await persist(pin); return state;
        } else if (remote && (keep === "cloud" || (!localChanged && (remoteCoreChanged || remote.pin.commitment !== journal.applied?.pin.commitment)))) {
          progress.phase("applying");
          await projectOperation(root,async () => {
            assertBindingIdentity(root, state);
            await verifyReviewedHead();
            if(await measuredFingerprint()!==local.snapshot.fingerprint) throw new EncryptionError("conflict");
            if(!binding(root)?.enabled) throw new EncryptionError("conflict");
            applySnapshot(root,materializeSnapshot(remote!.bundle.manifest,bundleResolver(remote!.bundle.blocks)));
            const upgraded = remote!.bundle.manifest.schemaVersion < CURRENT_SCHEMA_VERSION;
            journal.fingerprint=upgraded ? remote!.bundle.manifest.fingerprint : await measuredFingerprint();
            journal.applied=journal.remote!;
            state.status=upgraded ? "ready" : "synced"; await persist(pin);
          }, { name: "Cloud restore" });
          review = undefined;
          keep=remote.bundle.manifest.schemaVersion < CURRENT_SCHEMA_VERSION ? "local" : undefined;
          continue;
        }
        let bundle:SnapshotBundle={manifest:local.snapshot,blocks:local.blocks};
        if(remote) bundle=rebasePartitions(bundle,remote,true);
        progress.phase("encrypting");
        const encryptionStarted = performance.now();
        let prepared: PreparedPublication | undefined;
        try { prepared=await transport.prepare(bundle,remote); }
        finally { encryptionMs += performance.now() - encryptionStarted; }
        if(!prepared) {
          journal.fingerprint=local.snapshot.fingerprint;
          if(journal.remote) journal.applied=journal.remote;
          state.status="synced"; await persist(pin); return state;
        }
        journal.pending={...saveEncryptedCache(directory,prepared),...(merged?{merge:merged,summary:mergeSummary}:{})}; await persist(pin);
        try {
          const published=await transport.publish(prepared,remote,progress.upload);
          journal.applied=saveEncryptedCache(directory,published); journal.remote=journal.applied; journal.fingerprint=local.snapshot.fingerprint; delete journal.pending;
          if (mergeSummary) state.lastMerge = mergeSummary;
          state.lastPublishedAt = new Date().toISOString();
          state.status="synced"; await persist(published.pin); return state;
        } catch(error) {
          if(!(error instanceof EncryptionError) || error.state!=="conflict") throw error;
          if (review) throw new Error("Cloud memory changed since the review. Reload the conflict before applying a choice.");
          // Keeping "local" would overwrite the newer cloud core; the marked pending upload is merged onto it next pass.
          if (merged) keep = undefined;
        }
      }
      throw new EncryptionError("conflict");
    }, { name: review ? "Applying memory choice" : keep ? "Resolving cloud conflict" : "Cloud sync" });
  } catch(error) {
    const current=binding(root);
    if (current && current.projectId === initial.projectId && current.vaultId === initial.vaultId && current.server === initial.server && current.checkoutId === initial.checkoutId) {
      if (error instanceof ProjectLinkChangedError) current.enabled = false;
      recordCloudSyncError(root,current,error);
      if(error instanceof EncryptionError && error.state==="storage-full") { current.retryAfter=Date.now()+300000; saveBinding(root,current); }
    }
    throw error;
  } finally {
    const timings: CloudSyncTimings = {
      recordedAt: new Date().toISOString(), totalMs: Math.round(performance.now() - started),
      snapshotMs: Math.round(snapshotMs), encryptionMs: Math.round(encryptionMs),
      networkMs: Math.round(client.networkTiming.milliseconds - networkBefore.milliseconds),
      uploadedBytes: client.networkTiming.uploadedBytes - networkBefore.uploadedBytes,
      downloadedBytes: client.networkTiming.downloadedBytes - networkBefore.downloadedBytes
    };
    try { atomicJson(join(directory, "timing.json"), timings); } catch { /* Diagnostics never mask a sync result. */ }
    // Only the gate holder may clear progress; a deferred caller must not erase a running sync's.
    if (ownsGate) progress.clear();
  }
}
