import { createHash } from "node:crypto";
import { z } from "zod";
import { parseRuleFile, ruleIdSchema, RULE_FILE_BYTES } from "./format.js";
import { redactSensitiveText } from "../privacy/redaction.js";

export const contentHash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export type RuleFiles = Map<string, Buffer>;
export interface RuleVariant { hash: string; bytes?: Buffer; devices: string[] }
export type RuleState = RuleVariant[];
export type RulesState = Map<string, RuleState>;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const conflictSchema = z.object({ schemaVersion: z.literal(1), id: ruleIdSchema, conflictId: hashSchema,
  variants: z.array(z.object({ hash: z.union([hashSchema, z.literal("deleted")]), devices: z.array(z.string().max(100)).max(64) }).strict()).min(2).max(64) }).strict();
export interface RuleConflict { id: string; conflictId: string; variants: Array<{ hash: string; devices: string[] }> }
export const stateHash = (state: RuleState | undefined): string => contentHash(JSON.stringify((state ?? []).map(v => v.hash).sort()));
export const filesRevision = (files: RuleFiles): string => contentHash(JSON.stringify([...files].map(([p, b]) => [p, contentHash(b)]).sort(([a], [b]) => a!.localeCompare(b!))));
const variantPath = (id: string, hash: string): string => `rules/.conflicts/variants/${id}/${hash}.md`;
function combine(...states: Array<RuleState | undefined>): RuleState {
  const variants = new Map<string, RuleVariant>();
  for (const state of states) for (const v of state ?? [{ hash: "deleted", devices: [] }]) {
    const prior = variants.get(v.hash);
    variants.set(v.hash, { ...v, devices: [...new Set([...(prior?.devices ?? []), ...v.devices])].sort() });
  }
  return [...variants.values()].sort((a, b) => a.hash.localeCompare(b.hash));
}
export function decodeRulesFiles(files: RuleFiles, device = "local"): RulesState {
  const result: RulesState = new Map(), used = new Set<string>();
  const collision = new Set<string>();
  for (const [path, bytes] of files) {
    if (collision.has(path.toLowerCase())) throw new Error("Case-insensitive rules path collision"); collision.add(path.toLowerCase());
    const normal = /^rules\/([a-z0-9-]+)\.md$/.exec(path);
    if (normal) {
      const parsed = parseRuleFile(bytes, `${normal[1]}.md`); if (!parsed.ok) throw new Error(`${path}: ${parsed.error}`);
      result.set(parsed.rule.id, [{ hash: contentHash(bytes), bytes, devices: [device] }]); used.add(path);
    }
  }
  for (const [path, bytes] of files) {
    const match = /^rules\/\.conflicts\/([a-z0-9-]+)\.json$/.exec(path); if (!match) continue;
    if (bytes.length > RULE_FILE_BYTES) throw new Error("Conflict manifest exceeds 16 KiB");
    if (redactSensitiveText(bytes.toString("utf8")).redactions.length) throw new Error("Conflict metadata contains a recognized secret");
    const record = conflictSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (record.id !== match[1] || result.has(record.id)) throw new Error("Conflicted rule must be resolved explicitly before restoring its active file");
    const variants: RuleVariant[] = record.variants.map(v => {
      if (v.hash === "deleted") return v;
      const path = variantPath(record.id, v.hash), data = files.get(path);
      if (!data || contentHash(data) !== v.hash) throw new Error("Missing or damaged conflict variant");
      const parsed = parseRuleFile(data, `${record.id}.md`); if (!parsed.ok) throw new Error(parsed.error);
      used.add(path); return { ...v, bytes: data };
    });
    const canonical = combine(variants);
    if (canonical.length !== variants.length || record.conflictId !== conflictId(record.id, canonical)) throw new Error("Invalid conflict identity");
    result.set(record.id, canonical); used.add(path);
  }
  for (const path of files.keys()) if (!used.has(path)) throw new Error(`Unsupported or orphaned rules file: ${path}`);
  return result;
}
export const conflictId = (id: string, variants: RuleState): string => contentHash(JSON.stringify([id, variants.map(v => v.hash).sort()]));
export function conflictsIn(state: RulesState): RuleConflict[] {
  return [...state].filter(([, variants]) => variants.length > 1).map(([id, variants]) => ({ id, conflictId: conflictId(id, variants), variants: variants.map(({ hash, devices }) => ({ hash, devices })) })).sort((a, b) => a.id.localeCompare(b.id));
}
export function encodeRulesFiles(state: RulesState): RuleFiles {
  const files: RuleFiles = new Map();
  for (const [id, raw] of [...state].sort(([a], [b]) => a.localeCompare(b))) {
    ruleIdSchema.parse(id); const variants = combine(raw);
    if (variants.length === 1) { const v = variants[0]!; if (v.hash !== "deleted") { if (!v.bytes) throw new Error("Missing rule bytes"); files.set(`rules/${id}.md`, v.bytes); } continue; }
    const record = { schemaVersion: 1, id, conflictId: conflictId(id, variants), variants: variants.map(({ hash, devices }) => ({ hash, devices })) };
    const bytes = Buffer.from(JSON.stringify(record)); if (bytes.length > RULE_FILE_BYTES) throw new Error("Conflict manifest exceeds 16 KiB; resolve variants before continuing sync");
    files.set(`rules/.conflicts/${id}.json`, bytes);
    for (const v of variants) if (v.hash !== "deleted") { if (!v.bytes) throw new Error("Missing conflict bytes"); files.set(variantPath(id, v.hash), v.bytes); }
  }
  decodeRulesFiles(files); return files;
}
/** Pure, direction-independent merge. Never feed an unpublished result back as local input. */
export function mergeRules(base: RulesState, local: RulesState, remote: RulesState): RulesState {
  const merged: RulesState = new Map();
  for (const id of new Set([...base.keys(), ...local.keys(), ...remote.keys()])) {
    const b = base.get(id), l = local.get(id), r = remote.get(id);
    let value: RuleState | undefined;
    if (stateHash(l) === stateHash(r)) value = l && combine(l, r);
    else if (stateHash(l) === stateHash(b)) value = r;
    else if (stateHash(r) === stateHash(b)) value = l;
    else value = combine(l, r);
    if (value && !(value.length === 1 && value[0]!.hash === "deleted")) merged.set(id, value);
  }
  return merged;
}
