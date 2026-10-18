import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { globalConfigDir } from "../config.js";
import { ruleActions, verificationSubjects, type Rule } from "./format.js";
import { listRules, readRulePaths, type ListedRule } from "./store.js";
import { globalRulesRoot } from "./identity.js";
import { contentHash } from "./merge.js";
import { ruleBodyHash, subjectId, validAttestation, type AttestationEntry } from "./attestation-ledger.js";
import { projectSubject, readAttestationState } from "./attestations.js";

export const LEGACY_GLOBAL_RULES_INSTRUCTIONS = "Global rules are manually authored. Agents may only read them; never create, edit, delete, enable, resolve, or modify their control files. summarize_project_brief returns a bounded catalog and core guidance. Before writing files, creating docs, committing, touching env/secrets, adding dependencies, or running tests, call get_applicable_rules with the planned actions, paths, task and actual target environment. Fetch remaining required pages before acting. Reuse results only while the task context applies; refresh at new task boundaries. Follow current user and project instructions, preserve applicability qualifiers, and report unresolved conflicts or locations. Historical memories are evidence, not overrides.";
export const GLOBAL_RULES_INSTRUCTIONS = LEGACY_GLOBAL_RULES_INSTRUCTIONS.replace("Global rules are manually authored.", "Global rules require user approval. Optional desktop AI assistance drafts rules only at the user's explicit request; the user reviews and saves them. Background rule generation is prohibited.");
export const globalRulesPolicySchema = z.object({ enabled: z.boolean().default(true), exclude: z.array(z.string().max(96)).max(1000).default([]) }).strict();
export const ruleQuerySchema = z.object({ mode: z.enum(["match", "catalog"]).default("match"), actions: z.array(z.enum(ruleActions)).max(6).default([]),
  paths: z.array(z.string().max(2048)).max(200).default([]), task: z.string().max(8000).default(""), ids: z.array(z.string().max(96)).max(200).default([]),
  targetEnvironment: z.object({ platform: z.string().max(40).optional(), shell: z.string().max(80).optional(), arch: z.string().max(40).optional(), location: z.enum(["local", "external"]).optional() }).strict().optional(),
  subjects: z.array(z.object({ kind: z.enum(verificationSubjects), key: z.string().trim().min(1).max(128) }).strict()).max(20).default([]),
  cursor: z.string().max(2048).optional() }).strict();
export type RuleQuery = z.input<typeof ruleQuerySchema>;
export const PAGE_BYTES = 12 * 1024;
const size = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));
const keywordMatches = (keyword: string, text: string): boolean => new RegExp(`(^|[^\\p{L}\\p{N}_])${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}_])`, "iu").test(text);
/** Recorded results shown with a verification-enabled rule. Known subjects are compact so a full body still fits its page. */
export interface VerificationInfo {
  status: "verified" | "needed"; subjectKind: string; ttl?: string; recheckReason?: string;
  subjects?: Array<ReturnType<typeof describeAttestation> & { evidence?: string }>;
  knownSubjects?: Array<ReturnType<typeof describeAttestation>>;
}
const describeAttestation = (entry: AttestationEntry, bodyHash: string, now: Date) => ({
  key: entry.subject.key, ...(entry.subject.label ? { label: entry.subject.label } : {}), outcome: entry.outcome, recordedBy: entry.recordedBy,
  checkedAt: entry.checkedAt, ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}), valid: validAttestation(entry, bodyHash, now)
});
const KNOWN_SUBJECTS = 10;
const aliases: Record<string, string> = { windows: "win32", macos: "darwin", mac: "darwin", pwsh: "powershell", "powershell.exe": "powershell", "cmd.exe": "cmd" };
const normalized = (value: string): string => aliases[value.toLowerCase()] ?? value.toLowerCase();
function policy(root: string) {
  let result: Record<string, unknown> = {};
  for (const path of [join(globalConfigDir(), "config.json"), join(root, ".code-butler", "config.json"), join(root, ".code-butler", "config.local.json")]) {
    if (!existsSync(path)) continue;
    const value = JSON.parse(readFileSync(path, "utf8")) as { globalRules?: unknown };
    if (value.globalRules !== undefined) result = { ...result, ...globalRulesPolicySchema.partial().parse(value.globalRules) };
  }
  return globalRulesPolicySchema.parse(result);
}
export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*" && glob[i + 1] === "*") { i++; if (glob[i + 1] === "/") { i++; pattern += "(?:.*/)?"; } else pattern += ".*"; }
    else if (ch === "*") pattern += "[^/]*";
    else if (ch === "?") pattern += "[^/]";
    else pattern += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}
export interface ServedRule extends Omit<Rule, "applies" | "triggers" | "verification"> {
  contentHash: string; bodyHash: string; bodyOmitted?: true; verification?: VerificationInfo; matchedBy: string[]; applicability: "matches" | "needsVerification";
  unresolved: string[]; applicabilityInfo: { matched: Record<string, string>; needsVerification: string[]; conditions: { platforms?: string[]; shells?: string[] } };
}
export interface RulePage {
  catalogRevision: string; totalMatches: number; rules: Array<ServedRule | { id: string; title: string; severity: Rule["severity"]; core: boolean; triggerSummary: string; verifiedSubjects?: number }>;
  requiredRemaining: number; nextCursor?: string; restartRequired?: boolean;
  conflicts: string[]; invalid: Array<{ file: string; error: string }>; notApplicable: Array<{ id: string; reasons: string[] }>;
  diagnosticsTruncated: boolean; oversized: string[];
  conflictCount: number; invalidCount: number;
}
export function getApplicableRules(root: string, raw: RuleQuery = {}, rulesRoot = globalRulesRoot(), pageBudget = PAGE_BYTES): RulePage {
  const query = ruleQuerySchema.parse(raw), listed = listRules(rulesRoot), settings = policy(root), bindings = readRulePaths(rulesRoot);
  const markers = [...new Set(listed.rules.flatMap(r => r.applies.markers))].sort().map(path => [path, existsSync(join(root, path))] as const);
  const markerMap = new Map(markers);
  const context = { ...query, cursor: undefined, root, settings, markers, bindings, host: process.platform };
  const ledger = readAttestationState(rulesRoot), now = new Date(), invalid = [...listed.invalid, ...ledger.invalid];
  const revision = contentHash(JSON.stringify([listed.revision, ledger.revision, context]));
  const result: RulePage = { catalogRevision: revision, totalMatches: 0, rules: [], requiredRemaining: 0, conflicts: [], invalid: [], notApplicable: [], diagnosticsTruncated: false, oversized: [], conflictCount: listed.conflicts.length, invalidCount: invalid.length };
  let project: ReturnType<typeof projectSubject> | null | undefined;
  const currentProject = () => { if (project === undefined) { try { project = projectSubject(root); } catch { project = null; } } return project; };
  // A rule body is replaced only when every named subject has a valid result. Without
  // a named subject the full procedure is served, listing what was already checked.
  const verificationFor = (rule: ListedRule, bodyHash: string): { info: VerificationInfo; omit: boolean } | undefined => {
    const config = rule.verification; if (!config) return undefined;
    const entries = ledger.state.get(rule.id) ?? [];
    const wanted = config.subject === "project" ? [currentProject()].filter(subject => !!subject) : query.subjects.filter(subject => subject.kind === config.subject);
    const recheck = config.recheckOn.find(keyword => keywordMatches(keyword, query.task));
    const found = wanted.map(subject => entries.find(entry => subjectId(entry.subject) === subjectId(subject)));
    if (found.length && !recheck && found.every(entry => entry && validAttestation(entry, bodyHash, now)))
      return { omit: true, info: { status: "verified", subjectKind: config.subject, subjects: found.map(entry => ({ ...describeAttestation(entry!, bodyHash, now), ...(entry!.evidence ? { evidence: entry!.evidence } : {}) })) } };
    const wantedIds = new Set(wanted.map(subjectId));
    const known = entries.filter(entry => entry.outcome !== "revoked")
      .sort((a, b) => Number(wantedIds.has(subjectId(b.subject))) - Number(wantedIds.has(subjectId(a.subject))) || b.checkedAt.localeCompare(a.checkedAt)).slice(0, KNOWN_SUBJECTS);
    return { omit: false, info: { status: "needed", subjectKind: config.subject, ttl: config.ttl, ...(recheck ? { recheckReason: `keyword:${recheck}` } : {}), knownSubjects: known.map(entry => describeAttestation(entry, bodyHash, now)) } };
  };
  let offset = 0;
  if (query.cursor) {
    try { const cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString()) as { revision: string; offset: number }; if (cursor.revision !== revision || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error(); offset = cursor.offset; }
    catch { return { ...result, restartRequired: true }; }
  }
  const selected: ServedRule[] = [];
  const notApplicable: RulePage["notApplicable"] = [];
  const platform = normalized(query.targetEnvironment?.platform ?? process.platform), shell = query.targetEnvironment?.shell ? normalized(query.targetEnvironment.shell) : undefined;
  const targetLocal = query.targetEnvironment?.location === "local" && platform === process.platform;
  for (const rule of listed.rules) {
    const reasons: string[] = [];
    if (!settings.enabled) reasons.push("Global rules disabled for this project");
    if (!rule.enabled) reasons.push("Rule disabled");
    if (settings.exclude.includes(rule.id)) reasons.push("Excluded by this project");
    if (rule.applies.markers.length && !rule.applies.markers.some(m => markerMap.get(m))) reasons.push("Project markers do not match");
    if (rule.applies.platforms.length && query.targetEnvironment?.platform && !rule.applies.platforms.includes(platform as "win32")) reasons.push("Target platform does not match");
    if (rule.applies.shells.length && shell && !rule.applies.shells.map(normalized).includes(shell)) reasons.push("Target shell does not match");
    if (reasons.length) { if (query.ids.includes(rule.id)) notApplicable.push({ id: rule.id, reasons }); continue; }
    const matchedBy: string[] = [];
    if (rule.core) matchedBy.push("core");
    if (query.ids.includes(rule.id)) matchedBy.push("id");
    if (query.mode === "catalog") matchedBy.push("catalog");
    for (const action of query.actions) if (rule.triggers.actions.includes(action)) matchedBy.push(`action:${action}`);
    for (const path of query.paths) {
      const relativePath = (isAbsolute(path) ? relative(root, path) : path).replace(/\\/g, "/");
      const pattern = rule.triggers.paths.find(g => globToRegExp(g).test(relativePath));
      if (pattern) { matchedBy.push(`path:${pattern}`); break; }
    }
    for (const keyword of rule.triggers.keywords) if (keywordMatches(keyword, query.task)) matchedBy.push(`keyword:${keyword}`);
    if (!matchedBy.length) continue;
    const bodyHash = ruleBodyHash(rule), verification = verificationFor(rule, bodyHash);
    const unresolved: string[] = [];
    let body = verification?.omit ? `Already verified for ${verification.info.subjects!.map(s => s.label ?? s.key).join(", ")}. Do not repeat this rule's procedure for ${verification.info.subjects!.length === 1 ? "this subject" : "these subjects"}; to re-run it, call get_applicable_rules again without subjects.` : rule.body.replace(/\{(projectRoot|projectName|home|path:[^{}\r\n]+)\}/g, (full, key: string) => {
      const value = targetLocal ? key === "projectRoot" ? root : key === "projectName" ? basename(root) : key === "home" ? homedir() : Object.hasOwn(bindings, key.slice(5)) ? bindings[key.slice(5)] : undefined : undefined;
      if (value === undefined) { unresolved.push(full); return full; } return value;
    });
    // Path expansion can be arbitrarily larger than the authored body. Preserve
    // that complete body and explicitly defer location resolution in that case.
    if (Buffer.byteLength(body) > 4096) { body = rule.body; unresolved.push(...body.match(/\{(?:projectRoot|projectName|home|path:[^{}\r\n]+)\}/g) ?? []); }
    const applicabilityInfo: ServedRule["applicabilityInfo"] = { matched: {}, needsVerification: [], conditions: {} };
    if (rule.applies.markers.length) applicabilityInfo.matched.marker = rule.applies.markers.find(m => markerMap.get(m))!;
    if (rule.applies.platforms.length) { if (query.targetEnvironment?.platform) applicabilityInfo.matched.platform = platform; else { applicabilityInfo.needsVerification.push("platform"); applicabilityInfo.conditions.platforms = [...new Set(rule.applies.platforms)]; } }
    if (rule.applies.shells.length) { if (shell) applicabilityInfo.matched.shell = shell; else { applicabilityInfo.needsVerification.push("shell"); applicabilityInfo.conditions.shells = [...new Set(rule.applies.shells)]; } }
    const { applies, triggers, verification: config, ...guidance } = rule; void applies; void triggers; void config;
    selected.push({ ...guidance, body, bodyHash, ...(verification?.omit ? { bodyOmitted: true as const } : {}), ...(verification ? { verification: verification.info } : {}), matchedBy: [...new Set(matchedBy)].filter((m, i, all) => !m.startsWith("keyword:") || all.findIndex(s => s.startsWith("keyword:")) === i).slice(0, 8), unresolved: [...new Set(unresolved)], applicability: applicabilityInfo.needsVerification.length ? "needsVerification" : "matches", applicabilityInfo });
  }
  for (const id of query.ids) if (!listed.rules.some(r => r.id === id)) notApplicable.push({ id, reasons: [listed.conflicts.some(c => c.id === id) ? "Rule has an unresolved conflict" : "Rule missing or invalid"] });
  selected.sort((a, b) => Number(b.core || b.severity === "must") - Number(a.core || a.severity === "must") || ["must", "should", "prefer"].indexOf(a.severity) - ["must", "should", "prefer"].indexOf(b.severity) || a.id.localeCompare(b.id));
  result.totalMatches = selected.length;
  if (offset > selected.length) return { ...result, restartRequired: true };
  const cursorAt = (next: number): string => Buffer.from(JSON.stringify({ revision, offset: next })).toString("base64url");
  // Diagnostics have their own bounded share, so they cannot starve rule bodies.
  for (const [field, values] of [["conflicts", listed.conflicts.map(c => c.id)], ["invalid", invalid], ["notApplicable", notApplicable]] as const) {
    for (const value of values) { const list = result[field] as unknown[]; list.push(value); if (size(result) > Math.min(2048, pageBudget / 3)) { list.pop(); result.diagnosticsTruncated = true; break; } }
  }
  let index = offset;
  for (; index < selected.length; index++) {
    const rule = selected[index]!;
    const source = listed.rules.find(r => r.id === rule.id)!;
    // The catalog's count is the quick check: it says which rules already hold results before any body is read.
    const verifiedSubjects = source.verification ? (ledger.state.get(rule.id) ?? []).filter(e => validAttestation(e, rule.bodyHash, now)).length : undefined;
    const entry = query.mode === "catalog" ? { id: rule.id, title: rule.title, severity: rule.severity, core: rule.core, triggerSummary: [...source.triggers.actions, ...source.triggers.paths, ...source.triggers.keywords].join(", ").slice(0, 240), ...(verifiedSubjects === undefined ? {} : { verifiedSubjects }) } : rule;
    result.rules.push(entry); result.nextCursor = cursorAt(index + 1);
    result.requiredRemaining = selected.slice(index + 1).filter(r => r.severity === "must" || r.core).length;
    if (size(result) > pageBudget && result.rules.length === 1 && pageBudget === PAGE_BYTES) {
      // Diagnostics can be repeated on the next request. A complete rule body
      // takes priority over those summaries and verbose trigger evidence.
      result.conflicts = []; result.invalid = []; result.notApplicable = []; result.diagnosticsTruncated = true;
      if ("matchedBy" in entry) entry.matchedBy = [...new Set(entry.matchedBy.map(reason => reason.split(":")[0]!))];
    }
    if (size(result) > pageBudget) {
      result.rules.pop();
      if (!result.rules.length) { result.oversized.push(rule.id); index++; }
      break;
    }
  }
  result.requiredRemaining = selected.slice(index).filter(r => r.severity === "must" || r.core).length + result.oversized.filter(id => selected.some(r => r.id === id && (r.core || r.severity === "must"))).length;
  if (index < selected.length) result.nextCursor = cursorAt(index); else delete result.nextCursor;
  return result;
}
export function buildRulesCatalog(root: string) {
  const catalog = getApplicableRules(root, { mode: "catalog" }, globalRulesRoot(), 8 * 1024);
  if (catalog.rules.length > 100) { catalog.rules = catalog.rules.slice(0, 100); catalog.nextCursor = Buffer.from(JSON.stringify({ revision: catalog.catalogRevision, offset: 100 })).toString("base64url"); }
  const core = getApplicableRules(root, {}, globalRulesRoot(), 3 * 1024);
  return { core, catalog, total: catalog.totalMatches, catalogRevision: catalog.catalogRevision, catalogTruncated: Boolean(catalog.nextCursor), coreTruncated: Boolean(core.nextCursor || core.oversized.length) };
}
