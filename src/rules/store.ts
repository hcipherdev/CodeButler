import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { z } from "zod";
import { openConfiguredMemoryStore } from "../storage/open-configured-store.js";
import { projectOperation } from "../cloud/client.js";
import { atomicJson, atomicWrite, readJson, stateDirectory } from "../cloud/state.js";
import { requestAutomaticSync } from "../cloud/sync-owner.js";
import { globalRulesRoot, rulesDir } from "./identity.js";
import { parseRuleFile, ruleIdSchema, serializeRule, type Rule, type RuleInput } from "./format.js";
import { contentHash, filesRevision, decodeRulesFiles, encodeRulesFiles, conflictsIn, stateHash, type RuleFiles } from "./merge.js";

export class StaleRuleError extends Error { constructor() { super("Rules changed since they were read. Reload before applying your edit."); this.name = "StaleRuleError"; } }
export function assertSafe(path: string): void {
  let cursor = resolve(path);
  for (;;) {
    try { if (lstatSync(cursor).isSymbolicLink()) throw new Error("Rules paths must not contain symlinks"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
export function prepareGlobalRulesDirectory(root = globalRulesRoot()): void {
  assertSafe(rulesDir(root)); mkdirSync(root, { recursive: true });
}
export function ensureGlobalRulesRoot(root = globalRulesRoot()): void {
  prepareGlobalRulesDirectory(root); mkdirSync(rulesDir(root), { recursive: true });
  for (const file of ["memory.sqlite", "memory.sqlite-wal", "memory.sqlite-shm", "config.json", "config.local.json"]) assertSafe(join(root, ".code-butler", file));
  const store = openConfiguredMemoryStore(root); try { store.init(); } finally { store.close(); }
}
/** Exact bytes are shared by validation, hashing, merging and export. Reads never initialize storage. */
export function captureRulesFiles(root = globalRulesRoot()): RuleFiles {
  const directory = rulesDir(root); assertSafe(directory); const files: RuleFiles = new Map();
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), relative = `${prefix}/${name}`, stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("Rules paths must not contain symlinks");
      if (name.endsWith(".tmp")) continue;
      if (stat.isDirectory()) walk(path, relative);
      else if (stat.isFile()) { if (stat.size > 16 * 1024) throw new Error(`${relative}: file exceeds 16 KiB`); files.set(relative, readFileSync(path)); }
      else throw new Error("Rules paths must be regular files");
    }
  };
  walk(directory, "rules"); return files;
}
export interface ListedRule extends Rule { contentHash: string }
export function listRules(root = globalRulesRoot()) {
  const invalid: Array<{ file: string; error: string }> = []; const rules: ListedRule[] = [];
  let files: RuleFiles;
  try { files = captureRulesFiles(root); } catch (error) { return { rules, invalid: [{ file: "rules", error: String(error) }], conflicts: [] as ReturnType<typeof conflictsIn>, revision: contentHash(String(error)) }; }
  const conflictedIds = new Set([...files.keys()].flatMap(p => /^rules\/\.conflicts\/([a-z0-9-]+)\.json$/.exec(p)?.[1] ?? []));
  const caseCounts = new Map<string, number>();
  for (const path of files.keys()) caseCounts.set(path.toLowerCase(), (caseCounts.get(path.toLowerCase()) ?? 0) + 1);
  for (const [path, bytes] of files) {
    const match = /^rules\/([^/]+)\.md$/.exec(path); if (!match) continue;
    if (caseCounts.get(path.toLowerCase())! > 1) { invalid.push({ file: path, error: "Case-insensitive filename collision" }); continue; }
    const parsed = parseRuleFile(bytes, match[1]! + ".md");
    if (!parsed.ok) invalid.push({ file: path, error: parsed.error });
    else if (!conflictedIds.has(parsed.rule.id)) rules.push({ ...parsed.rule, contentHash: contentHash(bytes) });
  }
  let conflicts: ReturnType<typeof conflictsIn> = [];
  try { conflicts = conflictsIn(decodeRulesFiles(new Map([...files].filter(([path]) => !invalid.some(i => i.file === path))))); }
  catch (error) { invalid.push({ file: "rules", error: String(error) }); }
  return { rules: rules.sort((a, b) => a.id.localeCompare(b.id)), invalid, conflicts, revision: filesRevision(files) };
}
export function readRule(id: string, root = globalRulesRoot()): ListedRule | undefined { ruleIdSchema.parse(id); return listRules(root).rules.find(rule => rule.id === id); }
export function readRulePaths(root = globalRulesRoot()): Record<string, string> {
  const path = join(root, ".code-butler", "config.local.json"); assertSafe(path);
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8")) as { rulePaths?: unknown };
  return z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.string().min(1).max(1024).refine(path => isAbsolute(path) && !/[\u0000-\u001f]/.test(path), "Rule path bindings must be absolute local paths")).parse(value.rulePaths ?? {});
}
interface ApplyJournal { before: Record<string, string>; after: Record<string, string> }
const pack = (files: RuleFiles): Record<string, string> => Object.fromEntries([...files].map(([p, bytes]) => [p, bytes.toString("base64")]));
const unpack = (files: Record<string, string>): RuleFiles => new Map(Object.entries(files).map(([p, bytes]) => [p, Buffer.from(bytes, "base64")]));
/** Recovery never replaces a file that differs from both the journal's old and new bytes. */
export function recoverRulesApply(root = globalRulesRoot()): void {
  const path = join(stateDirectory(root), "rules-apply.json"), journal = readJson<ApplyJournal>(path); if (!journal) return;
  const before = unpack(journal.before), after = unpack(journal.after); decodeRulesFiles(before); decodeRulesFiles(after);
  const current = captureRulesFiles(root);
  for (const key of new Set([...before.keys(), ...after.keys(), ...current.keys()])) {
    const hash = (v: Buffer | undefined) => v ? contentHash(v) : "absent";
    if (hash(current.get(key)) !== hash(before.get(key)) && hash(current.get(key)) !== hash(after.get(key))) throw new Error("Rules recovery found an external edit; preserved recovery copies require manual review");
  }
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const destination = join(root, ".code-butler", key); assertSafe(destination);
    const actual = existsSync(destination) ? readFileSync(destination) : undefined;
    const same = (left: Buffer | undefined, right: Buffer | undefined) => left === undefined ? right === undefined : right !== undefined && left.equals(right);
    if (same(actual, after.get(key))) continue;
    if (!same(actual, before.get(key))) throw new Error("Rules recovery found an external edit; preserved recovery copies require manual review");
    if (after.has(key)) atomicWrite(destination, after.get(key)!); else if (existsSync(destination)) unlinkSync(destination);
  }
  renameSync(path, join(stateDirectory(root), `rules-recovery-${randomUUID()}.json`));
}
export function replaceRulesFiles(root: string, expectedRevision: string, files: RuleFiles): void {
  decodeRulesFiles(files); recoverRulesApply(root);
  const current = captureRulesFiles(root); if (filesRevision(current) !== expectedRevision) throw new StaleRuleError();
  if (filesRevision(files) === expectedRevision) return;
  atomicJson(join(stateDirectory(root), "rules-apply.json"), { before: pack(current), after: pack(files) } satisfies ApplyJournal);
  recoverRulesApply(root);
}
async function mutate<T>(work: (root: string, files: RuleFiles) => T, root = globalRulesRoot()): Promise<T> {
  assertSafe(rulesDir(root)); mkdirSync(root, { recursive: true });
  return projectOperation(root, () => { ensureGlobalRulesRoot(root); recoverRulesApply(root); const result = work(root, captureRulesFiles(root)); requestAutomaticSync(root); return result; }, { name: "Manual global rules edit" });
}
export async function createRule(input: Omit<RuleInput, "id" | "schemaVersion">, root = globalRulesRoot(), expectedRevision?: string): Promise<ListedRule> {
  return mutate((root, files) => {
    if (expectedRevision !== undefined && filesRevision(files) !== expectedRevision) throw new StaleRuleError();
    const id = `${input.title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60).replace(/-$/, "") || "rule"}-${randomUUID().slice(0, 8)}`;
    const bytes = Buffer.from(serializeRule({ ...input, id, schemaVersion: 1, updatedAt: new Date().toISOString() }));
    if (files.has(`rules/${id}.md`)) throw new StaleRuleError();
    const revision = filesRevision(files); files.set(`rules/${id}.md`, bytes); replaceRulesFiles(root, revision, files); return readRule(id, root)!;
  }, root);
}
export async function updateRule(id: string, patch: Partial<Omit<RuleInput, "id" | "schemaVersion">>, expectedHash: string, root = globalRulesRoot()): Promise<ListedRule> {
  return mutate((root, files) => {
    const current = readRule(id, root); if (!current || current.contentHash !== expectedHash) throw new StaleRuleError();
    const { contentHash: ignored, ...rule } = current; void ignored;
    const revision = filesRevision(files); files.set(`rules/${id}.md`, Buffer.from(serializeRule({ ...rule, ...patch, id, updatedAt: new Date().toISOString() })));
    replaceRulesFiles(root, revision, files); return readRule(id, root)!;
  }, root);
}
export const setRuleEnabled = (id: string, enabled: boolean, expectedHash: string, root = globalRulesRoot()): Promise<ListedRule> => updateRule(id, { enabled }, expectedHash, root);
export async function deleteRule(id: string, expectedHash: string, root = globalRulesRoot()): Promise<void> {
  ruleIdSchema.parse(id);
  return mutate((root, files) => { const path = `rules/${id}.md`, bytes = files.get(path); if (!bytes || contentHash(bytes) !== expectedHash) throw new StaleRuleError(); const revision = filesRevision(files); files.delete(path); replaceRulesFiles(root, revision, files); }, root);
}
export async function resolveRuleConflict(id: string, input: { conflictId: string; expectedStateHash: string; variant?: string; edited?: string }, root = globalRulesRoot()): Promise<void> {
  ruleIdSchema.parse(id);
  return mutate((root, files) => {
    const state = decodeRulesFiles(files), conflict = conflictsIn(state).find(c => c.id === id);
    if (!conflict || conflict.conflictId !== input.conflictId || stateHash(state.get(id)) !== input.expectedStateHash) throw new StaleRuleError();
    if ((input.edited !== undefined) === (input.variant !== undefined)) throw new Error("Choose one variant or an edited file");
    if (input.edited !== undefined) {
      const bytes = Buffer.from(input.edited), parsed = parseRuleFile(bytes, `${id}.md`); if (!parsed.ok) throw new Error(parsed.error);
      state.set(id, [{ bytes, hash: contentHash(bytes), devices: ["manual resolution"] }]);
    } else {
      const variant = state.get(id)!.find(v => v.hash === input.variant); if (!variant) throw new StaleRuleError();
      if (variant.hash === "deleted") state.delete(id); else state.set(id, [variant]);
    }
    replaceRulesFiles(root, filesRevision(files), encodeRulesFiles(state));
  }, root);
}
