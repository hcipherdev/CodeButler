import { existsSync, lstatSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { canonicalCheckoutRoot } from "../cloud/checkout-path.js";
import { projectOperation } from "../cloud/client.js";
import { readProjectIdentity } from "../cloud/project-identity.js";
import { atomicWrite } from "../cloud/state.js";
import { requestAutomaticSync } from "../cloud/sync-owner.js";
import { ruleIdSchema, ttlMs, ttlSchema, verificationSubjects } from "./format.js";
import { globalRulesRoot } from "./identity.js";
import { contentHash, decodeRulesFiles, filesRevision } from "./merge.js";
import { assertSafe, captureRulesFiles, listRules } from "./store.js";
import {
  ATTESTATION_FILE_BYTES, attestationEntrySchema, decodeAttestationFile, encodeAttestationFiles, mergeAttestations,
  ruleBodyHash, subjectId, subjectSchema, validAttestation, type AttestationEntry, type AttestationFiles, type AttestationState
} from "./attestation-ledger.js";

/** Kept beside rules/, never inside it: agents record observations here but never touch rule files. */
export const attestationsDir = (root = globalRulesRoot()): string => join(root, ".code-butler", "attestations");
export const USER_ATTESTATION_TTL = "90d";

export function captureAttestationFiles(root = globalRulesRoot()): AttestationFiles {
  const directory = attestationsDir(root); assertSafe(directory);
  const files: AttestationFiles = new Map();
  if (!existsSync(directory)) return files;
  for (const name of readdirSync(directory).sort()) {
    if (name.endsWith(".tmp")) continue;
    const path = join(directory, name), stat = lstatSync(path);
    if (!stat.isFile()) throw new Error("Attestation paths must be regular files");
    if (stat.size > ATTESTATION_FILE_BYTES) throw new Error(`attestations/${name}: file exceeds 64 KiB`);
    files.set(`attestations/${name}`, readFileSync(path));
  }
  return files;
}
/** Retrieval never fails because of the ledger: an unreadable file only costs the full rule body. */
export function readAttestationState(root = globalRulesRoot()): { state: AttestationState; revision: string; invalid: Array<{ file: string; error: string }> } {
  const state: AttestationState = new Map(), invalid: Array<{ file: string; error: string }> = [];
  let files: AttestationFiles;
  try { files = captureAttestationFiles(root); } catch (error) { return { state, revision: contentHash(String(error)), invalid: [{ file: "attestations", error: String(error) }] }; }
  for (const [path, bytes] of files) {
    try { const [id, entries] = decodeAttestationFile(path, bytes); if (entries.length) state.set(id, entries); }
    catch (error) { invalid.push({ file: path, error: error instanceof z.ZodError ? error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") : String(error) }); }
  }
  return { state, revision: filesRevision(files), invalid };
}
/** Writes changed files and removes files absent from `files`. Merges are monotone, so a rerun after interruption is safe. */
export function writeAttestationFiles(root: string, files: AttestationFiles): boolean {
  const current = captureAttestationFiles(root); let changed = false;
  for (const [path, bytes] of files) {
    if (current.get(path)?.equals(bytes)) continue;
    const destination = join(root, ".code-butler", path); assertSafe(destination); atomicWrite(destination, bytes); changed = true;
  }
  for (const path of current.keys()) if (!files.has(path)) { unlinkSync(join(root, ".code-butler", path)); changed = true; }
  return changed;
}
/** Rules that may still hold results, including conflicted ones awaiting resolution. */
export function liveRuleIds(root = globalRulesRoot()): Set<string> {
  try { return new Set(decodeRulesFiles(captureRulesFiles(root)).keys()); }
  catch { return new Set(listRules(root).rules.map(rule => rule.id)); }
}
export function projectSubject(projectRoot: string): { kind: "project"; key: string; label: string } {
  const identity = readProjectIdentity(projectRoot)?.projectIdentity;
  return { kind: "project", key: identity ?? `local:${contentHash(canonicalCheckoutRoot(projectRoot))}`, label: basename(projectRoot).slice(0, 120) || "project" };
}

export const recordInputSchema = z.object({
  ruleId: ruleIdSchema, ruleBodyHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  subject: z.object({ kind: z.enum(verificationSubjects), key: z.string().trim().min(1).max(128).optional(), label: z.string().trim().min(1).max(120).optional() }).strict(),
  outcome: z.enum(["satisfied", "not_satisfied", "exempt", "declined"]),
  evidence: z.string().trim().min(1).max(1024).optional(), ttl: ttlSchema.optional()
}).strict();
export type RecordAttestationInput = z.input<typeof recordInputSchema>;
export const agentRecordInputSchema = recordInputSchema.omit({ ttl: true }).extend({
  ruleBodyHash: z.string().regex(/^[a-f0-9]{64}$/), outcome: z.enum(["satisfied", "not_satisfied"]), evidence: z.string().trim().min(1).max(1024)
}).strict();
export const RECORD_RULE_ATTESTATION_DESCRIPTION = "Record the outcome of a global rule's check for one subject, only after actually running that check. Only rules whose get_applicable_rules entry includes verification accept results; pass that entry's bodyHash. For ssh-host, key is the server host-key fingerprint (for example from `ssh-keygen -l -F <host>` or `ssh-keyscan -t ed25519 <host> | ssh-keygen -lf -`) and label is a display name such as user@host. Project subjects are derived automatically; omit key. Evidence briefly states what was observed, without secrets or raw logs. Agents cannot record exemptions; ask the user to run code-butler rules attest. This writes only the verification ledger, never rule files.";
export interface AttestationOptions { by: "agent" | "user"; projectRoot?: string; root?: string; now?: Date }

function resolveSubject(subject: RecordAttestationInput["subject"], projectRoot: string | undefined) {
  if (subject.kind !== "project") return subjectSchema.parse(subject);
  if (!projectRoot) throw new Error("Project results are recorded from within a project");
  const derived = projectSubject(projectRoot);
  return subjectSchema.parse({ ...derived, ...(subject.label ? { label: subject.label } : {}) });
}
async function updateLedger(root: string, ruleId: string, now: Date, change: (entries: AttestationEntry[]) => AttestationEntry): Promise<AttestationEntry> {
  return projectOperation(root, () => {
    const path = `attestations/${ruleId}.json`, file = join(root, ".code-butler", path); assertSafe(file);
    const entries = existsSync(file) ? decodeAttestationFile(path, readFileSync(file))[1] : [];
    const entry = attestationEntrySchema.parse(change(entries));
    const merged = mergeAttestations([new Map([[ruleId, entries]]), new Map([[ruleId, [entry]]])], undefined, now);
    const bytes = encodeAttestationFiles(merged).get(path);
    if (bytes) atomicWrite(file, bytes); else if (existsSync(file)) unlinkSync(file);
    requestAutomaticSync(root);
    return entry;
  }, { name: "Record global rule verification" });
}
/** A strictly later timestamp guarantees the new result supersedes the stored one despite clock skew. */
const after = (now: Date, prior: AttestationEntry | undefined): Date => prior && Date.parse(prior.checkedAt) >= now.getTime() ? new Date(Date.parse(prior.checkedAt) + 1) : now;

/**
 * Agents may record satisfied/not_satisfied after running a rule's check; only the
 * user may record exempt or declined. The rule itself must opt in via verification.
 */
export async function recordAttestation(raw: RecordAttestationInput, options: AttestationOptions): Promise<{ ruleId: string; entry: AttestationEntry }> {
  const input = recordInputSchema.parse(raw), root = options.root ?? globalRulesRoot(), now = options.now ?? new Date();
  if (options.by === "agent") {
    if (input.outcome !== "satisfied" && input.outcome !== "not_satisfied") throw new Error("Only the user can record exempt or declined results");
    if (!input.ruleBodyHash) throw new Error("Pass the bodyHash returned by get_applicable_rules for the rule you checked");
    if (input.ttl) throw new Error("Agent results use the rule's verification ttl");
  }
  const subject = resolveSubject(input.subject, options.projectRoot);
  const rule = listRules(root).rules.find(candidate => candidate.id === input.ruleId);
  if (!rule) throw new Error("Rule missing, invalid, or conflicted");
  if (!rule.enabled) throw new Error("Rule is disabled");
  if (!rule.verification) throw new Error("This rule does not accept recorded results. The user can opt it in with a verification: map.");
  if (rule.verification.subject !== subject.kind) throw new Error(`This rule records ${rule.verification.subject} results`);
  const bodyHash = ruleBodyHash(rule);
  if (input.ruleBodyHash && input.ruleBodyHash !== bodyHash) throw new Error("The rule changed since it was read. Fetch it again and re-run its check.");
  const entry = await updateLedger(root, rule.id, now, entries => {
    const prior = entries.find(candidate => subjectId(candidate.subject) === subjectId(subject));
    if (options.by === "agent" && prior?.recordedBy === "user" && (prior.outcome === "exempt" || prior.outcome === "declined")) throw new Error(`The user marked this subject ${prior.outcome}; nothing was recorded`);
    const checkedAt = after(now, prior);
    const expires = input.outcome === "satisfied" || input.outcome === "not_satisfied"
      ? { expiresAt: new Date(checkedAt.getTime() + ttlMs(options.by === "agent" ? rule.verification!.ttl : input.ttl ?? USER_ATTESTATION_TTL)).toISOString() } : {};
    const label = subject.label ?? prior?.subject.label;
    return { subject: { ...subject, ...(label ? { label } : {}) }, outcome: input.outcome, recordedBy: options.by, ruleBodyHash: bodyHash,
      checkedAt: checkedAt.toISOString(), ...expires, ...(input.evidence ? { evidence: input.evidence } : {}) };
  });
  return { ruleId: rule.id, entry };
}
/** User-only: a tombstone that syncs, so the result does not return from another device. */
export async function revokeAttestation(ruleId: string, subject: { kind: typeof verificationSubjects[number]; key?: string }, options: Omit<AttestationOptions, "by"> = {}): Promise<AttestationEntry> {
  const id = ruleIdSchema.parse(ruleId), root = options.root ?? globalRulesRoot(), now = options.now ?? new Date();
  const resolved = resolveSubject(subject, options.projectRoot);
  return updateLedger(root, id, now, entries => {
    const prior = entries.find(candidate => subjectId(candidate.subject) === subjectId(resolved));
    if (!prior || prior.outcome === "revoked") throw new Error("No recorded result for this subject");
    return { subject: prior.subject, outcome: "revoked", recordedBy: "user", ruleBodyHash: prior.ruleBodyHash, checkedAt: after(now, prior).toISOString() };
  });
}
export function listAttestations(root = globalRulesRoot(), ruleId?: string, now = new Date()) {
  const { state, invalid } = readAttestationState(root), rules = new Map(listRules(root).rules.map(rule => [rule.id, rule]));
  const results = [...state].filter(([id]) => !ruleId || id === ruleId).flatMap(([id, entries]) => entries.filter(entry => entry.outcome !== "revoked").map(entry => {
    const rule = rules.get(id);
    return { ruleId: id, ...entry, valid: Boolean(rule?.enabled && rule.verification && validAttestation(entry, ruleBodyHash(rule), now)) };
  }));
  return { attestations: results, invalid };
}
