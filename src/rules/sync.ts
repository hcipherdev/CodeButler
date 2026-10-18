import { randomUUID } from "node:crypto";
import { classifyAccountResource } from "../cloud/resource-identity.js";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { globalConfigDir } from "../config.js";
import { AccountClient } from "../cloud/account-client.js";
import { EncryptedTransport } from "../cloud/encrypted-client.js";
import { openSnapshot, type VerifiedSnapshot } from "../cloud/encrypted-snapshot.js";
import { EMPTY_PIN, encodeEnvelope, MAX_ENVELOPE } from "../cloud/encrypted-protocol.js";
import { EncryptionError } from "../cloud/crypto-helper.js";
import { createEncryptedProject, projectTrust } from "../cloud/vault-client.js";
import { withProjectGate } from "../cloud/gate.js";
import { projectOperation, localCloudChangeStamp } from "../cloud/client.js";
import { activeGlobalWatcher, automaticSyncStatus, AutomaticSyncOwner, requestAutomaticSync } from "../cloud/sync-owner.js";
import { atomicJson, binding, ensureCheckoutId, readJson, saveBinding, stateDirectory, type Binding } from "../cloud/state.js";
import { readEncryptedCache, saveEncryptedCache } from "../cloud/encrypted-coordinator.js";
import { assertRulesBinding, globalRulesProjectId, globalRulesRoot } from "./identity.js";
import { captureRulesFiles, ensureGlobalRulesRoot, prepareGlobalRulesDirectory, listRules, recoverRulesApply, replaceRulesFiles, StaleRuleError } from "./store.js";
import { contentHash, decodeRulesFiles, encodeRulesFiles, filesRevision, mergeRules, type RuleFiles } from "./merge.js";
import { attestationFilesFromBundle, captureGlobalRulesSnapshot, rulesFilesFromBundle, withRulesFiles } from "./snapshot.js";
import { decodeAttestationFiles, encodeAttestationFiles, mergeAttestations } from "./attestation-ledger.js";
import { captureAttestationFiles, writeAttestationFiles } from "./attestations.js";

type CacheRef = ReturnType<typeof saveEncryptedCache>;
interface Journal { fingerprint: string; applied?: CacheRef; remote?: CacheRef; pending?: CacheRef }
interface ApplyIntent { local: Record<string, string>; accepted?: CacheRef }
const pack = (files: RuleFiles): Record<string, string> => Object.fromEntries([...files].map(([p, b]) => [p, b.toString("base64")]));
const unpack = (value: Record<string, string>): RuleFiles => new Map(Object.entries(value).map(([p, b]) => [p, Buffer.from(b, "base64")]));
export function globalRulesSyncStatus() {
  const root = globalRulesRoot();
  const state = existsSync(root) ? binding(root) : undefined;
  const queue = existsSync(root) ? automaticSyncStatus(root) : null, conflicts = listRules(root).conflicts.length;
  const outcome = !state?.enabled ? "disabled" : queue?.runningSince ? "running" : state.status === "error" ? "failed" : queue?.pending ? "queued" : conflicts ? "conflicted" : state.status === "synced" ? "completed" : "ready";
  return { binding: state ?? null, controlHash: syncControlHash(state), queue, conflicts, outcome };
}
function syncControlHash(state: Binding | undefined): string | null { return state ? contentHash(JSON.stringify([state.server, state.vaultId, state.projectId, state.enabled, state.kind])) : null; }
export async function setGlobalRulesSyncEnabled(enabled: boolean, client?: AccountClient, expectedHash?: string | null): Promise<Binding | undefined> {
  const root = globalRulesRoot();
  if (!enabled && !existsSync(root)) return undefined;
  // The operation gate also covers first-time scaffold creation.
  prepareGlobalRulesDirectory(root);
  mkdirSync(stateDirectory(root), { recursive: true });
  return withProjectGate(stateDirectory(root), () => projectOperation(root, async () => {
    ensureGlobalRulesRoot(root);
    const prior = binding(root);
    if (expectedHash !== undefined && syncControlHash(prior) !== expectedHash) throw new StaleRuleError();
    if (!enabled) { if (prior) saveBinding(root, { ...prior, enabled: false, status: "disabled" }); return prior ? { ...prior, enabled: false, status: "disabled" } : undefined; }
    const selected = readJson<{ server: string }>(join(globalConfigDir(), "cloud", "account.json"));
    const server = client?.server ?? selected?.server ?? prior?.server;
    if (!server) throw new Error("Sign in and enroll this device before enabling rules sync");
    const account = client ?? new AccountClient(server), status = await account.refreshVault();
    if (!status.descriptor) throw new Error("Enroll this device before enabling rules sync");
    const vaultId = status.descriptor.vaultId, id = globalRulesProjectId(vaultId);
    if (prior && (prior.vaultId !== vaultId || prior.server !== server)) throw new Error("Global rules belong to another account; automatic rebinding is disabled");
    const resources = Object.keys(status.projects);
    if (!status.projects[id] && resources.filter(project => ["project", "global-rules"].includes(classifyAccountResource(project, vaultId, resources))).length >= 10) throw new Error("Vault is full: global rules require one project slot");
    // Concurrent first enablement converges after refreshing membership.
    if (!status.projects[id]) try { await createEncryptedProject(account, id); } catch (error) { if (!(await account.refreshVault()).projects[id]) throw error; }
    const next: Binding = prior ? { ...prior, enabled: true, status: "ready" } : { kind: "global-rules", encryptionVersion: 2, label: "Global rules", projectId: id, vaultId, server, enabled: true, revision: 0, fingerprint: "", checkoutId: randomUUID(), status: "ready" };
    assertRulesBinding(root, next); saveBinding(root, next); requestAutomaticSync(root); return next;
  }, { name: "Configure global rules sync" }));
}

/** Dedicated rules branch of the encrypted coordinator. Uses its transport, pins and native journals. */
export async function encryptedRulesSync(root: string, client: AccountClient): Promise<Binding | undefined> {
  const initial = binding(root); if (!initial?.enabled) return initial; assertRulesBinding(root, initial);
  return withProjectGate(stateDirectory(root), async () => {
    const state = ensureCheckoutId(root, binding(root)!); if (!state.enabled) return state;
    const directory = stateDirectory(root), intentPath = join(directory, "rules-sync-apply.json");
    let journal = await client.security.invoke<Journal | null>("sync-read", { checkoutId: state.checkoutId }) ?? { fingerprint: state.fingerprint };
    const persist = async (pin = journal.applied?.pin ?? EMPTY_PIN) => {
      await client.security.invoke("sync-save", { checkoutId: state.checkoutId, projectId: state.projectId, pin, value: journal });
      state.fingerprint = journal.fingerprint; state.revision = journal.applied?.pin.revision ?? 0; state.lastSync = new Date().toISOString(); saveBinding(root, state);
    };
    try {
      if (!journal.applied && !readJson<ApplyIntent>(intentPath)?.accepted && (state.revision > 0 || journal.fingerprint !== "")) throw new Error("Rules sync base is missing; restore its local sync history before retrying");
      await projectOperation(root, () => { ensureGlobalRulesRoot(root); recoverRulesApply(root); });
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!binding(root)?.enabled) return binding(root);
        const status = await client.refreshVault();
        if (status.descriptor?.vaultId !== state.vaultId) throw new Error("Global rules vault changed");
        const trust = projectTrust(status, state.projectId), transport = new EncryptedTransport(client, trust);
        const observedOn = (snapshot: VerifiedSnapshot): string => {
          const device = trust.records.flatMap(r => r.record.devices).find(d => d.signingKey === snapshot.envelope.writer);
          return `${(device?.label ?? "Device").slice(0, 60)} [${device?.id.slice(0, 8) ?? snapshot.envelope.writer.slice(0, 8)}] revision ${snapshot.pin.revision}`;
        };
        const localDevice = `${(status.device?.label ?? "Device").slice(0, 60)} [${status.device?.id.slice(0, 8) ?? "local"}] local edit`;
        const decoded = new Map<string, Promise<VerifiedSnapshot>>();
        const decode = async (ref: CacheRef | undefined) => {
          if (!ref) return undefined;
          if (!decoded.has(ref.hash)) decoded.set(ref.hash, openSnapshot(client.security, trust, readEncryptedCache(directory, ref), undefined, ref.pin));
          return decoded.get(ref.hash)!;
        };
        const applyAccepted = async (accepted: VerifiedSnapshot, original: RuleFiles) => {
          const ref = saveEncryptedCache(directory, accepted);
          atomicJson(intentPath, { local: pack(original), accepted: ref } satisfies ApplyIntent);
          await projectOperation(root, () => {
            recoverRulesApply(root);
            const current = captureRulesFiles(root), currentRevision = filesRevision(current);
            const merged = mergeRules(decodeRulesFiles(original), decodeRulesFiles(current, localDevice), decodeRulesFiles(rulesFilesFromBundle(accepted.bundle), observedOn(accepted)));
            replaceRulesFiles(root, currentRevision, encodeRulesFiles(merged));
            // Recorded results merge without a base, so results recorded here meanwhile are kept and republished.
            const acceptedResults = attestationFilesFromBundle(accepted.bundle);
            const results = encodeAttestationFiles(mergeAttestations([decodeAttestationFiles(captureAttestationFiles(root)), decodeAttestationFiles(acceptedResults)], new Set(merged.keys()), new Date()));
            writeAttestationFiles(root, results);
            if (filesRevision(results) !== filesRevision(acceptedResults)) requestAutomaticSync(root);
          }, { name: "Apply synchronized global rules" });
          journal.applied = ref; journal.remote = ref; journal.fingerprint = accepted.bundle.manifest.fingerprint; delete journal.pending;
          state.status = listRules(root).conflicts.length ? "conflict" : "synced"; delete state.syncError;
          await persist(accepted.pin); if (existsSync(intentPath)) unlinkSync(intentPath);
          const candidatePath = join(directory, "rules-candidate.json"); if (existsSync(candidatePath)) unlinkSync(candidatePath);
        };
        const recovery = readJson<ApplyIntent>(intentPath);
        if (recovery?.accepted) { await applyAccepted((await decode(recovery.accepted))!, unpack(recovery.local)); continue; }
        if (!journal.applied && (state.revision > 0 || journal.fingerprint !== "")) throw new Error("Rules sync base is missing; restore its local sync history before retrying");
        const ancestor = await decode(journal.applied), cached = await decode(journal.remote ?? journal.applied);
        const remote = await transport.pull(cached);
        if (remote) { journal.remote = saveEncryptedCache(directory, remote); await persist(remote.pin); }
        if (journal.pending) {
          const pending = readEncryptedCache(directory, journal.pending);
          if (remote?.pin.commitment === journal.pending.pin.commitment) {
            if (!recovery) throw new Error("Rules publication recovery data is missing");
            await applyAccepted(remote, unpack(recovery.local)); continue;
          }
          if (pending.envelope.parentCommitment === (remote?.pin.commitment ?? null) && pending.envelope.epoch === trust.epoch && pending.envelope.membership === trust.membership && recovery) {
            try { const accepted = await transport.publish(pending, remote); await applyAccepted(accepted, unpack(recovery.local)); return state; }
            catch (error) { if (!(error instanceof EncryptionError) || error.state !== "conflict") throw error; continue; }
          }
          delete journal.pending; await persist(remote?.pin ?? EMPTY_PIN);
        }
        const local = await captureGlobalRulesSnapshot(root, state.projectId, remote?.pin.revision ?? 0, state.checkoutId);
        const localFiles = rulesFilesFromBundle(local);
        const merged = mergeRules(ancestor ? decodeRulesFiles(rulesFilesFromBundle(ancestor.bundle)) : new Map(), decodeRulesFiles(localFiles, localDevice), remote ? decodeRulesFiles(rulesFilesFromBundle(remote.bundle), observedOn(remote)) : new Map());
        // Retain the staged variants even when encoding or a transport size check fails.
        atomicJson(join(directory, "rules-candidate.json"), Object.fromEntries([...merged].map(([id, variants]) => [id, variants.map(v => ({ ...v, ...(v.bytes ? { bytes: v.bytes.toString("base64") } : {}) }))])));
        const results = mergeAttestations([decodeAttestationFiles(attestationFilesFromBundle(local)), remote ? decodeAttestationFiles(attestationFilesFromBundle(remote.bundle)) : new Map()], new Set(merged.keys()), new Date());
        const candidate = withRulesFiles(local, encodeRulesFiles(merged), encodeAttestationFiles(results));
        const prepared = await transport.prepare(candidate, remote);
        if (!prepared) { if (remote) await applyAccepted(remote, localFiles); return state; }
        if (encodeEnvelope(prepared.envelope).length > MAX_ENVELOPE) throw new Error("Rules manifest exceeds the encrypted transport limit; staged variants are retained. Reduce the collection and retry.");
        atomicJson(intentPath, { local: pack(localFiles) } satisfies ApplyIntent);
        journal.pending = saveEncryptedCache(directory, prepared); await persist(remote?.pin ?? EMPTY_PIN);
        try {
          const accepted = await transport.publish(prepared, remote); await applyAccepted(accepted, localFiles); return state;
        } catch (error) {
          if (!(error instanceof EncryptionError) || error.state !== "conflict") throw error;
          // Local files are still the user's bytes. Recompute against the latest remote.
          delete journal.pending; await persist(remote?.pin ?? EMPTY_PIN);
        }
      }
      throw new Error("Rules changed repeatedly during sync; queued for retry");
    } catch (error) { state.status = "error"; state.syncError = error instanceof Error ? error.message : "Rules sync failed"; saveBinding(root, state); throw error; }
  });
}
export async function syncGlobalRules(options: { background?: boolean; client?: AccountClient; waitMs?: number } = {}) {
  const root = globalRulesRoot(); if (!existsSync(root) || !binding(root)?.enabled) return globalRulesSyncStatus();
  if (!options.background && activeGlobalWatcher(root)) {
    requestAutomaticSync(root); const deadline = Date.now() + (options.waitMs ?? 15_000);
    while (Date.now() < deadline) { const status = globalRulesSyncStatus(); if (!status.binding?.enabled || (!status.queue?.pending && !status.queue?.runningSince)) return status; await delay(250); }
    return { ...globalRulesSyncStatus(), queued: true };
  }
  const owner = new AutomaticSyncOwner(root, options.background ? "watcher" : "mcp");
  if (!owner.acquire()) { requestAutomaticSync(root); return { ...globalRulesSyncStatus(), queued: true }; }
  const token = owner.beginRun();
  try { const state = binding(root)!; await encryptedRulesSync(root, options.client ?? new AccountClient(state.server)); owner.completeRun(token, localCloudChangeStamp(root)); }
  finally { owner.endRun(); owner.release(); }
  return globalRulesSyncStatus();
}
