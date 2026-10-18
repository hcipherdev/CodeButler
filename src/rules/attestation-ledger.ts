import { z } from "zod";
import { redactSensitiveText } from "../privacy/redaction.js";
import { ruleIdSchema, verificationSubjects, type Rule } from "./format.js";
import { contentHash } from "./merge.js";

/**
 * Recorded verification results for global rules, one file per rule. These are
 * observations about subjects, never instructions: they only let a valid result
 * stand in for a rule body that the user opted into verification.
 */
export const ATTESTATION_FILE_BYTES = 64 * 1024;
const DAY = 86_400_000;
/** Expired results linger briefly so devices converge before dropping them. */
const EXPIRED_GRACE_MS = 30 * DAY;
/** Longer than the 365d maximum TTL, so a pruned tombstone can only revive an expired result. */
const TOMBSTONE_MS = 400 * DAY;
export const attestationOutcomes = ["satisfied", "not_satisfied", "exempt", "declined", "revoked"] as const;
export type AttestationOutcome = typeof attestationOutcomes[number];
const AGENT_OUTCOMES: readonly AttestationOutcome[] = ["satisfied", "not_satisfied"];
const EXPIRING_OUTCOMES: readonly AttestationOutcome[] = ["satisfied", "not_satisfied"];
const keyFormats: Record<typeof verificationSubjects[number], RegExp> = {
  "ssh-host": /^SHA256:[A-Za-z0-9+/]{43}$/,
  project: /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|local:[0-9a-f]{64})$/
};
const KEY_HINTS: Record<typeof verificationSubjects[number], string> = {
  "ssh-host": "Use the server host-key fingerprint, such as SHA256:<43 base64 characters> from ssh-keygen -l",
  project: "Project subjects are derived from the project identity"
};
const timestamp = z.string().datetime({ offset: true });
const noSecret = (value: string): boolean => !redactSensitiveText(value).redactions.length;
export const subjectSchema = z.object({
  kind: z.enum(verificationSubjects), key: z.string().min(1).max(128),
  label: z.string().trim().min(1).max(120).refine(noSecret, "Label contains a recognized secret").optional()
}).strict().superRefine((subject, ctx) => {
  if (!keyFormats[subject.kind].test(subject.key)) ctx.addIssue({ code: "custom", path: ["key"], message: KEY_HINTS[subject.kind] });
});
export type AttestationSubject = z.infer<typeof subjectSchema>;
export const attestationEntrySchema = z.object({
  subject: subjectSchema, outcome: z.enum(attestationOutcomes), recordedBy: z.enum(["agent", "user"]),
  ruleBodyHash: z.string().regex(/^[a-f0-9]{64}$/), checkedAt: timestamp, expiresAt: timestamp.optional(),
  evidence: z.string().trim().min(1).max(1024).refine(noSecret, "Evidence contains a recognized secret; describe the result without it").optional()
}).strict().superRefine((entry, ctx) => {
  if (entry.recordedBy === "agent" && !AGENT_OUTCOMES.includes(entry.outcome)) ctx.addIssue({ code: "custom", path: ["outcome"], message: "Only the user can record exempt, declined, or revoked results" });
  if (EXPIRING_OUTCOMES.includes(entry.outcome) !== (entry.expiresAt !== undefined)) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Only satisfied and not_satisfied results expire" });
});
export type AttestationEntry = z.infer<typeof attestationEntrySchema>;
const fileSchema = z.object({ schemaVersion: z.literal(1), ruleId: ruleIdSchema, entries: z.array(attestationEntrySchema).max(1000) }).strict();
/** Published path → exact bytes, like RuleFiles. */
export type AttestationFiles = Map<string, Buffer>;
/** Rule id → one entry per subject. */
export type AttestationState = Map<string, AttestationEntry[]>;

export const ruleBodyHash = (rule: Pick<Rule, "body">): string => contentHash(rule.body);
export const subjectId = (subject: Pick<AttestationSubject, "kind" | "key">): string => `${subject.kind}:${subject.key}`;
export const attestationPath = (ruleId: string): string => `attestations/${ruleIdSchema.parse(ruleId)}.json`;
/** Fixed key order makes equal states produce equal bytes on every device. */
function canonicalEntry(entry: AttestationEntry): AttestationEntry {
  const subject = { kind: entry.subject.kind, key: entry.subject.key, ...(entry.subject.label ? { label: entry.subject.label } : {}) };
  return { subject, outcome: entry.outcome, recordedBy: entry.recordedBy, ruleBodyHash: entry.ruleBodyHash, checkedAt: entry.checkedAt,
    ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}), ...(entry.evidence ? { evidence: entry.evidence } : {}) };
}
const entryHash = (entry: AttestationEntry): string => contentHash(JSON.stringify(canonicalEntry(entry)));

export function decodeAttestationFile(path: string, bytes: Buffer): [string, AttestationEntry[]] {
  const match = /^attestations\/([a-z0-9-]+)\.json$/.exec(path); if (!match) throw new Error(`Unsupported attestation file: ${path}`);
  if (bytes.length > ATTESTATION_FILE_BYTES) throw new Error(`${path}: file exceeds 64 KiB`);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (redactSensitiveText(text).redactions.length) throw new Error(`${path}: contains a recognized secret`);
  const file = fileSchema.parse(JSON.parse(text));
  if (file.ruleId !== match[1]) throw new Error(`${path}: rule id must match its filename`);
  const seen = new Set<string>();
  for (const entry of file.entries) { const id = subjectId(entry.subject); if (seen.has(id)) throw new Error(`${path}: duplicate subject ${id}`); seen.add(id); }
  return [file.ruleId, file.entries.map(canonicalEntry)];
}
export function decodeAttestationFiles(files: AttestationFiles): AttestationState {
  const state: AttestationState = new Map();
  for (const [path, bytes] of files) { const [id, entries] = decodeAttestationFile(path, bytes); if (entries.length) state.set(id, entries); }
  return state;
}
export function encodeAttestationFiles(state: AttestationState): AttestationFiles {
  const files: AttestationFiles = new Map();
  for (const [id, entries] of [...state].sort(([a], [b]) => a.localeCompare(b))) {
    if (!entries.length) continue;
    const sorted = entries.map(canonicalEntry).sort((a, b) => subjectId(a.subject).localeCompare(subjectId(b.subject)));
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, ruleId: id, entries: sorted }));
    if (bytes.length > ATTESTATION_FILE_BYTES) throw new Error(`Recorded results for ${id} exceed 64 KiB; revoke results for subjects you no longer use`);
    files.set(attestationPath(id), bytes);
  }
  decodeAttestationFiles(files); return files;
}
const newer = (a: AttestationEntry, b: AttestationEntry): AttestationEntry => {
  const order = Date.parse(a.checkedAt) - Date.parse(b.checkedAt);
  return order > 0 || (order === 0 && entryHash(a) > entryHash(b)) ? a : b;
};
/**
 * Pure, direction-independent merge: last writer wins per subject, with revoked
 * entries as tombstones. Pruning depends only on `now`, so devices converge.
 * Rules absent from `liveRuleIds` drop their results.
 */
export function mergeAttestations(states: AttestationState[], liveRuleIds: ReadonlySet<string> | undefined, now: Date): AttestationState {
  const merged: AttestationState = new Map(), time = now.getTime();
  for (const id of new Set(states.flatMap(state => [...state.keys()]))) {
    if (liveRuleIds && !liveRuleIds.has(id)) continue;
    const winners = new Map<string, AttestationEntry>();
    for (const state of states) for (const entry of state.get(id) ?? []) {
      const key = subjectId(entry.subject), prior = winners.get(key);
      winners.set(key, prior ? newer(prior, entry) : entry);
    }
    const kept = [...winners.values()].filter(entry =>
      entry.outcome === "revoked" ? Date.parse(entry.checkedAt) + TOMBSTONE_MS >= time
        : !entry.expiresAt || Date.parse(entry.expiresAt) + EXPIRED_GRACE_MS >= time);
    if (kept.length) merged.set(id, kept.map(canonicalEntry).sort((a, b) => subjectId(a.subject).localeCompare(subjectId(b.subject))));
  }
  return merged;
}
/** Exemptions describe the subject, so they survive rule edits; satisfied results are tied to the body they checked. */
export function validAttestation(entry: AttestationEntry, bodyHash: string, now: Date): boolean {
  if (entry.outcome === "exempt" || entry.outcome === "declined") return true;
  return entry.outcome === "satisfied" && entry.ruleBodyHash === bodyHash && Date.parse(entry.expiresAt!) > now.getTime();
}
