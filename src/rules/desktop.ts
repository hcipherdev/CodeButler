import { z } from "zod";
import { ruleSchema, ruleIdSchema, verificationSchema } from "./format.js";
import { captureRulesFiles, createRule, deleteRule, listRules, resolveRuleConflict, setRuleEnabled, updateRule, StaleRuleError } from "./store.js";
import { decodeRulesFiles, stateHash } from "./merge.js";
import { rulesDir } from "./identity.js";
import { globalRulesSyncStatus, setGlobalRulesSyncEnabled, syncGlobalRules } from "./sync.js";
import { descriptionSchema, draftGlobalRule, ruleAssistanceStatus, type RuleAssistanceDependencies } from "./assistance.js";

const version = z.literal(1), hash = z.string().regex(/^[a-f0-9]{64}$/);
const input = ruleSchema.omit({ id: true, schemaVersion: true, updatedAt: true });
export const rulesRequestSchemas = [
  z.object({ version, action: z.literal("rules.assistance.status") }).strict(),
  z.object({ version, action: z.literal("rules.draft"), description: descriptionSchema }).strict(),
  z.object({ version, action: z.literal("rules.list") }).strict(),
  z.object({ version, action: z.literal("rules.create"), input, expectedRevision: hash }).strict(),
  z.object({ version, action: z.literal("rules.update"), id: ruleIdSchema, patch: input.partial().extend({ verification: verificationSchema.nullable().optional() }), expectedHash: hash }).strict(),
  z.object({ version, action: z.literal("rules.delete"), id: ruleIdSchema, expectedHash: hash }).strict(),
  z.object({ version, action: z.literal("rules.set-enabled"), id: ruleIdSchema, enabled: z.boolean(), expectedHash: hash }).strict(),
  z.object({ version, action: z.literal("rules.resolve-conflict"), id: ruleIdSchema, conflictId: hash, expectedStateHash: hash, variant: z.string().max(64).optional(), edited: z.string().max(16384).optional() }).strict(),
  z.object({ version, action: z.literal("rules.sync.status") }).strict(),
  z.object({ version, action: z.literal("rules.sync.set-enabled"), enabled: z.boolean(), expectedHash: hash.nullable(), confirmed: z.boolean().optional() }).strict(),
  z.object({ version, action: z.literal("rules.sync.now") }).strict()
] as const;
export type RulesDesktopRequest = z.infer<ReturnType<typeof rulesDesktopSchema>>;
function rulesDesktopSchema() { return z.discriminatedUnion("action", rulesRequestSchemas); }
export function rulesDesktopList() {
  const listed = listRules();
  let state: ReturnType<typeof decodeRulesFiles> = new Map();
  try { state = decodeRulesFiles(captureRulesFiles()); } catch { /* invalid files are already reported */ }
  return { ...listed, path: rulesDir(), conflicts: listed.conflicts.map(c => ({ ...c, expectedStateHash: stateHash(state.get(c.id)), variants: (state.get(c.id) ?? []).map(v => ({ hash: v.hash, devices: v.devices, text: v.bytes?.toString("utf8") ?? null })) })) };
}
export type RulesDesktopResult = ReturnType<typeof rulesDesktopList> | Awaited<ReturnType<typeof createRule>> | ReturnType<typeof globalRulesSyncStatus> | ReturnType<typeof ruleAssistanceStatus> | Awaited<ReturnType<typeof draftGlobalRule>> | { ok: true };
export interface RulesDesktopDependencies extends RuleAssistanceDependencies { setRulesSyncEnabled?: typeof setGlobalRulesSyncEnabled; syncRules?: typeof syncGlobalRules }
export async function handleRulesDesktopRequest(request: RulesDesktopRequest, options: RulesDesktopDependencies = {}): Promise<RulesDesktopResult> {
  switch (request.action) {
    case "rules.assistance.status": return ruleAssistanceStatus();
    case "rules.draft": return draftGlobalRule(request.description, options);
    case "rules.list": return rulesDesktopList();
    case "rules.create": return createRule(request.input, undefined, request.expectedRevision);
    case "rules.update": {
      // An omitted verification keeps the saved setting; null removes it.
      const { verification, ...fields } = request.patch;
      return updateRule(request.id, { ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)), ...(verification === undefined ? {} : { verification: verification ?? undefined }) }, request.expectedHash);
    }
    case "rules.delete": await deleteRule(request.id, request.expectedHash); return { ok: true };
    case "rules.set-enabled": return setRuleEnabled(request.id, request.enabled, request.expectedHash);
    case "rules.resolve-conflict": await resolveRuleConflict(request.id, { conflictId: request.conflictId, expectedStateHash: request.expectedStateHash, ...(request.variant === undefined ? {} : { variant: request.variant }), ...(request.edited === undefined ? {} : { edited: request.edited }) }); return { ok: true };
    case "rules.sync.status": return globalRulesSyncStatus();
    case "rules.sync.now": return (options.syncRules ?? syncGlobalRules)();
    case "rules.sync.set-enabled":
      if (!request.confirmed) throw new Error("Confirm the cloud sync change first");
      await (options.setRulesSyncEnabled ?? setGlobalRulesSyncEnabled)(request.enabled, undefined, request.expectedHash); return globalRulesSyncStatus();
  }
}
export { StaleRuleError };
