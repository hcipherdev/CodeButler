import { createHash } from "node:crypto";
import { z } from "zod";
import type { Applicability, MemoryScope, TargetEnvironment } from "../types.js";
import type { StorageContentPolicy } from "../storage/content-policy.js";

const values = z.array(z.string().trim().min(1).max(100)).min(1).max(32);
export const memoryScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project") }).strict(),
  z.object({ kind: z.literal("unspecified") }).strict(),
  z.object({ kind: z.literal("conditional"), platforms: values.optional(), architectures: values.optional(), shells: values.optional(), condition: z.string().trim().min(1).max(4000).optional() }).strict()
]).refine(s => s.kind !== "conditional" || !!(s.platforms || s.architectures || s.shells || s.condition), "Conditional scope requires a condition");
export const targetEnvironmentSchema = z.object({
  platform: z.string().trim().min(1).optional(), arch: z.string().trim().min(1).optional(), shell: z.string().trim().min(1).optional()
}).strict();

const aliases: Record<string, string> = { macos: "darwin", mac: "darwin", "os x": "darwin", windows: "win32", win: "win32", amd64: "x64", x86_64: "x64", aarch64: "arm64", pwsh: "powershell", "powershell.exe": "powershell", "cmd.exe": "cmd" };
function normalizeValue(value: string): string { const v = value.trim().toLowerCase(); return aliases[v] ?? v; }
export function normalizeScope(value: unknown): MemoryScope {
  if (value === undefined) return { kind: "unspecified" };
  const parsed = memoryScopeSchema.parse(value);
  if (parsed.kind !== "conditional") return parsed;
  const result: MemoryScope = { kind: "conditional" };
  for (const field of ["platforms", "architectures", "shells"] as const) {
    if (parsed[field]) result[field] = [...new Set(parsed[field].map(normalizeValue))].sort();
  }
  if (parsed.condition) result.condition = parsed.condition;
  return result;
}
export function parseScope(raw: string | null | undefined): MemoryScope { return normalizeScope(raw == null ? undefined : JSON.parse(raw)); }
export function scopeKey(scope: MemoryScope | undefined): string {
  const normalized = normalizeScope(scope);
  return normalized.kind === "unspecified" ? "unspecified" : createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
export function sanitizeScope(policy: StorageContentPolicy, scope: unknown): MemoryScope {
  const normalized = normalizeScope(scope);
  if (normalized.kind !== "conditional") return normalized;
  return normalizeScope({ ...normalized,
    ...(normalized.platforms ? { platforms: normalized.platforms.map(policy.text) } : {}),
    ...(normalized.architectures ? { architectures: normalized.architectures.map(policy.text) } : {}),
    ...(normalized.shells ? { shells: normalized.shells.map(policy.text) } : {}),
    ...(normalized.condition ? { condition: policy.text(normalized.condition) } : {})
  });
}

/** Only explicit leading qualifiers; never infer scope from the machine or path. */
export function inferScope(text: string): MemoryScope {
  const match = /^\s*([^:\n]{1,300}):/.exec(text);
  if (!match) return { kind: "unspecified" };
  const label = match[1]!.trim();
  if (/^project[- ]wide$/i.test(label)) return { kind: "project" };
  const platform = /^(macos|mac|windows|linux|darwin|win32) only$/i.exec(label);
  if (platform) return normalizeScope({ kind: "conditional", platforms: [platform[1]!] });
  const architecture = /^(arm64|aarch64|x64|amd64|x86_64|ia32) only$/i.exec(label);
  if (architecture) return normalizeScope({ kind: "conditional", architectures: [architecture[1]!] });
  const shell = /^in (powershell|pwsh|bash|zsh|cmd|fish|sh)$/i.exec(label);
  if (shell) return normalizeScope({ kind: "conditional", shells: [shell[1]!] });
  if (/\bOR\b/i.test(label) && /windows|linux|macos|powershell|bash/i.test(label)) return { kind: "conditional", condition: label };
  return { kind: "unspecified" };
}

export function assessApplicability(scope: MemoryScope | undefined, target?: TargetEnvironment): Applicability {
  const s = normalizeScope(scope);
  const raw = target === undefined ? { platform: process.platform, arch: process.arch } : targetEnvironmentSchema.parse(target);
  const environment: TargetEnvironment = {};
  for (const key of ["platform", "arch", "shell"] as const) if (raw[key]) environment[key] = normalizeValue(raw[key]);
  const source = target === undefined ? "butler_host_default" as const : "explicit" as const;
  const reasons: string[] = [];
  let mismatch = false;
  if (s.kind === "project") return { status: "project_wide", environment, source, reasons: ["Explicitly scoped to the whole project."] };
  if (s.kind === "unspecified") reasons.push("Applicability has not been established.");
  else {
    for (const [field, key] of [["platforms", "platform"], ["architectures", "arch"], ["shells", "shell"]] as const) {
      const allowed = s[field]; if (!allowed) continue;
      if (!environment[key]) reasons.push(`Target ${key} is unknown.`);
      else if (!allowed.includes(environment[key]!)) { mismatch = true; reasons.push(`Target ${key} ${environment[key]} differs from required ${allowed.join(" or ")}.`); }
    }
    if (s.condition) reasons.push(`Verify condition: ${s.condition}`);
  }
  if (source === "butler_host_default") reasons.push("Butler's host is provisional; verify the actual execution environment.");
  return { status: mismatch ? "mismatch" : reasons.length ? "needs_verification" : "matches", environment, source, reasons };
}
export function scopeLabel(scope: MemoryScope | undefined): string {
  const s = normalizeScope(scope);
  if (s.kind !== "conditional") return s.kind === "project" ? "Project-wide" : "Scope unspecified; verify applicability";
  return `Conditional: ${[s.platforms?.join(" or "), s.architectures?.join(" or "), s.shells?.join(" or "), s.condition].filter(Boolean).join("; ")}`;
}
export function scopesDisjoint(a: MemoryScope | undefined, b: MemoryScope | undefined): boolean {
  const left = normalizeScope(a), right = normalizeScope(b);
  if (left.kind !== "conditional" || right.kind !== "conditional") return false;
  return (["platforms", "architectures", "shells"] as const).some(k => left[k] && right[k] && !left[k]!.some(v => right[k]!.includes(v)));
}

/** Decorate returned memory projections, never raw sources or stored records. */
export function withApplicability<T>(value: T, target?: TargetEnvironment): T {
  if (Array.isArray(value)) return value.map(item => withApplicability(item, target)) as T;
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const result = Object.fromEntries(Object.entries(record).map(([k, v]) => [k, k === "scope" || k === "origin" || k === "applicability" ? v : withApplicability(v, target)]));
  if (record.scope && typeof record.scope === "object" && "kind" in record.scope) result.applicability = assessApplicability(normalizeScope(record.scope), target);
  return result as T;
}

export const SCOPE_GUIDANCE = " Preserve each memory's scope qualifiers. Before applying conditional or unspecified operational advice, verify its conditions against the actual execution environment. Mismatched memories remain historical evidence, not applicable instructions.";
export const SCOPE_EXTRACTION_GUIDANCE = ' Return optional scope as {"kind":"project"}, {"kind":"unspecified"}, or {"kind":"conditional","platforms":["win32"],"architectures":["x64"],"shells":["powershell"],"condition":"other requirements"}. Conditional fields are optional but at least one is required. Lists mean OR within a field and AND across fields. Only assign scope when supported by supplied evidence; ambiguous or absent scope is unspecified. Never infer scope from origin, paths, or absence of platform words. Keep complex OR combinations in condition text rather than flattening them. Preserve qualifiers in the summary.';
