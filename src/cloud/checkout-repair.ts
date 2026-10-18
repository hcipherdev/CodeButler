import { existsSync, mkdirSync, readdirSync, readFileSync, lstatSync, unlinkSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { globalConfigDir } from "../config.js";
import { atomicJson, atomicWrite, readJson, sha256, canonicalRoot } from "./state.js";
import { checkoutCandidates, checkoutDirectory, checkoutRepairPath, type CheckoutRepairRecord, type CheckoutCandidate } from "./checkout-path.js";
import { withProjectGateSync } from "./gate.js";

export interface CheckoutRepairReview {
  root: string; fingerprint: string; recommended?: string;
  candidates: Array<{ key: string; projectId?: string; label?: string; server?: string; enabled?: boolean; secretsEnabled?: boolean; revision?: number; lastSync?: string }>;
}
const keySchema = z.string().regex(/^[a-f0-9]{64}$/);
const repairSchema = z.object({ version: z.literal(1), root: z.string(), phase: z.enum(["prepared", "complete"]), candidates: z.array(keySchema).min(1), selected: keySchema, backup: z.string(), files: z.array(z.string().min(1)), hashes: z.record(z.string(), keySchema), sources: z.record(z.string(), keySchema), fingerprint: keySchema }).strict();
function validateRecord(record: CheckoutRepairRecord, root: string): void {
  repairSchema.parse(record);
  const backupRelative = relative(resolve(globalConfigDir(), "cloud", "checkout-recovery-backups"), resolve(record.backup));
  if (record.root !== root || !/^[a-f0-9-]{36}$/.test(backupRelative) || !record.candidates.includes(record.selected)) throw new Error("Invalid checkout recovery record.");
  if (record.files.some(path => !record.candidates.includes(record.sources[path] ?? ""))) throw new Error("Invalid checkout recovery source.");
}
function archiveAliases(record: CheckoutRepairRecord, target: string): void {
  for (const key of record.candidates) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid saved checkout key.");
    const directory = join(globalConfigDir(), "cloud", "checkouts", key);
    if (directory === target || !existsSync(directory)) continue;
    atomicJson(join(directory, "archived-connection.json"), { backup: record.backup, canonical: target, selected: record.selected });
    for (const name of ["binding.json", "secrets-binding.json"]) if (existsSync(join(directory, name))) unlinkSync(join(directory, name));
  }
}
function files(directory: string, prefix = ""): string[] {
  if (!existsSync(directory)) return [];
  if (!prefix && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())) throw new Error("Checkout repair requires a regular saved-state directory.");
  return readdirSync(join(directory, prefix)).sort().flatMap(name => {
    // Scratch captures have no journal references. Leave them in their original directory.
    if (!prefix && (name === ".code-butler" || /^capture-(?:\d+-)?[a-f0-9-]{36}\.sqlite(?:-wal|-shm)?$/i.test(name))) return [];
    const path = join(prefix, name), stat = lstatSync(join(directory, path));
    if (stat.isSymbolicLink()) throw new Error("Checkout repair refuses symbolic links in saved state.");
    return stat.isDirectory() ? files(directory, path) : [path];
  });
}
function fingerprint(root: string): string {
  return sha256(JSON.stringify(checkoutCandidates(root).map(c => [c.key, files(c.directory).map(path => [path, sha256(readFileSync(join(c.directory, path)))])])));
}
/** Memory and secrets are independent resources. Unbound v1 caches are archived, never imported. */
function complementaryState(candidates: CheckoutCandidate[]): { selected: CheckoutCandidate; secrets?: CheckoutCandidate } | undefined {
  const memory = candidates.filter(c => c.binding), secrets = candidates.filter(c => c.secrets);
  if (memory.length > 1 || secrets.length > 1) return undefined;
  const selected = memory[0] ?? secrets[0];
  if (!selected) return undefined;
  const secretPath = (path: string) => path === "secrets-binding.json" || /^secrets-cache[\\/]/.test(path);
  const unboundLegacy = (path: string) => /^memory-local\.sqlite(?:$|[.-])/.test(path) || ["coordinator.json","timing.json","snapshot-timing.json","archived-connection.json"].includes(path);
  if (candidates.some(c => c !== selected && files(c.directory).some(path => !secretPath(path) && !unboundLegacy(path)))) return undefined;
  return { selected, ...(secrets[0] && secrets[0] !== selected ? { secrets: secrets[0] } : {}) };
}
export function reviewCheckoutRepair(root: string): CheckoutRepairReview {
  const canonical = canonicalRoot(root), candidates = checkoutCandidates(root);
  return { root: canonical, fingerprint: fingerprint(root), ...(candidates.some(c => c.directory === checkoutDirectory(root) && c.binding) ? { recommended: checkoutDirectory(root).split(/[\\/]/).at(-1)! } : {}), candidates: candidates.map(c => ({ key: c.key, ...(c.binding ? { projectId: c.binding.projectId, label: c.binding.label, server: c.binding.server, enabled: c.binding.enabled, revision: c.binding.revision, lastSync: c.binding.lastSync } : {}), ...(c.secrets ? { secretsEnabled: c.secrets.enabled === true } : {}) })) };
}
/** Runs after the old watcher is stopped; gates also reject active foreground operations. */
export function migrateCheckout(root: string, selection?: { key: string; fingerprint: string }): void {
  const canonical = canonicalRoot(root), recordPath = checkoutRepairPath(root);
  const control = join(globalConfigDir(), "cloud", "checkout-migration"); mkdirSync(control, { recursive: true });
  withProjectGateSync(control, () => {
    const initial = readJson<CheckoutRepairRecord>(recordPath);
    if (initial) validateRecord(initial, canonical);
    if (initial?.phase === "complete" && initial.candidates.every(key => key === checkoutDirectory(root).split(/[\\/]/).at(-1) || !existsSync(join(globalConfigDir(),"cloud","checkouts",key,"binding.json")) && !existsSync(join(globalConfigDir(),"cloud","checkouts",key,"secrets-binding.json")))) return;
    const candidates = checkoutCandidates(root);
    const automatic = complementaryState(candidates);
    if (!initial && !selection && (!automatic || candidates.length === 1 && automatic.selected.directory === checkoutDirectory(root))) return;
    const gates = [...new Set([checkoutDirectory(root), ...candidates.map(c => c.directory), ...(initial?.candidates.map(key => join(globalConfigDir(),"cloud","checkouts",key)) ?? [])])].sort();
    const enter = (i: number): void => {
      if (i < gates.length) { mkdirSync(gates[i]!, { recursive: true }); return withProjectGateSync(gates[i]!, () => enter(i + 1), "Checkout repair"); }
      return withProjectGateSync(canonical, () => {
        let record = readJson<CheckoutRepairRecord>(recordPath);
        if (record) validateRecord(record, canonical);
        if (record?.phase === "complete") { archiveAliases(record, checkoutDirectory(root)); return; }
        if (!record) {
          const review = reviewCheckoutRepair(root);
          if (selection && selection.fingerprint !== review.fingerprint) throw new Error("Saved connections changed since the review. Reload connection repair.");
          const selected = candidates.find(c => c.key === (selection?.key ?? automatic?.selected.key));
          if (!selected || (!selected.binding && !selected.secrets) || (!selection && !automatic)) throw new Error("Select a saved connection after reviewing its cloud project.");
          if (!selected.binding && candidates.some(c => c.binding)) throw new Error("Select the intended memory connection; independent secrets settings will be preserved with it.");
          if (automatic && selected !== automatic.selected) throw new Error("Restore this folder's complete memory connection and its independent secrets settings together.");
          const backup = join(globalConfigDir(), "cloud", "checkout-recovery-backups", randomUUID()); mkdirSync(backup, { recursive: true });
          const backupFiles = (directory: string, key: string) => { for (const path of files(directory)) atomicWrite(join(backup,key,path),readFileSync(join(directory,path))); };
          for (const c of candidates) backupFiles(c.directory, c.key);
          // Preserve unbound canonical metadata as well; it may contain pending work.
          const target = checkoutDirectory(root), targetKey = target.split(/[\\/]/).at(-1)!;
          if (!candidates.some(c => c.directory === target) && files(target).length) backupFiles(target, targetKey);
          const sources = Object.fromEntries(files(selected.directory).map(path => [path, selected.key]));
          const secretStates = candidates.filter(c => c.secrets);
          const independentSecrets = secretStates.length === 1 && secretStates[0] !== selected ? secretStates[0] : undefined;
          if (independentSecrets) for (const path of files(independentSecrets.directory).filter(path => path === "secrets-binding.json" || /^secrets-cache[\\/]/.test(path))) sources[path] = independentSecrets.key;
          const paths = Object.keys(sources), hashes = Object.fromEntries(paths.map(path => [path, sha256(readFileSync(join(backup, sources[path]!, path)))]));
          record = { version: 1, root: canonical, phase: "prepared", candidates: candidates.map(c => c.key), selected: selected.key, backup, files: paths, sources, hashes, fingerprint: review.fingerprint };
          atomicJson(recordPath, record);
        }
        validateRecord(record, canonical);
        const target = checkoutDirectory(root);
        for (const path of record.files) {
          const source = join(record.backup, record.sources[path]!);
          const rel = relative(source, resolve(source, path));
          if (isAbsolute(path) || isAbsolute(rel) || rel.startsWith("..") || !rel) throw new Error("Invalid saved checkout path.");
          if (!lstatSync(join(source, path)).isFile() || sha256(readFileSync(join(source,path))) !== record.hashes[path]) throw new Error("Saved checkout backup failed verification.");
        }
        const expected = new Set(record.files);
        for (const path of files(target)) if (!expected.has(path)) unlinkSync(join(target, path));
        for (const path of record.files) {
          atomicWrite(join(target, path), readFileSync(join(record.backup, record.sources[path]!, path)));
        }
        // The complete record quarantines all unselected aliases, retaining their backups.
        const complete: CheckoutRepairRecord = { ...record, phase: "complete" };
        atomicJson(recordPath, complete);
        archiveAliases(complete, target);
      }, "Repair project connection");
    };
    enter(0);
  }, "Migrate checkout bindings");
}
export function migrateRegisteredCheckouts(): void {
  const registry = join(globalConfigDir(), "watch", "projects");
  if (!existsSync(registry)) return;
  for (const file of readdirSync(registry).filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
    const project = readJson<{ root: string }>(join(registry, file));
    if (project?.root && existsSync(project.root)) migrateCheckout(project.root);
  }
}
export function hasIncompleteCheckoutRepairs(): boolean {
  const directory = join(globalConfigDir(), "cloud", "checkout-repairs");
  if (!existsSync(directory)) return false;
  return readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).some(name => {
    try { return readJson<CheckoutRepairRecord>(join(directory, name))?.phase !== "complete"; }
    catch { return true; }
  });
}
