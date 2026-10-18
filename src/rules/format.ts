import { z } from "zod";
import { redactSensitiveText } from "../privacy/redaction.js";

export const RULE_BODY_BYTES = 4 * 1024;
export const RULE_FILE_BYTES = 16 * 1024;
export const ruleActions = ["write_file", "create_doc", "commit", "read_secrets", "run_tests", "add_dependency"] as const;
export const ruleIdSchema = z.string().max(96).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).refine(id => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id), "Reserved filename");
const strings = z.array(z.string().min(1).max(240)).max(32);
export const verificationSubjects = ["ssh-host", "project"] as const;
export const ttlSchema = z.string().regex(/^[1-9]\d{0,2}d$/, "Use a whole number of days such as 30d").refine(value => Number.parseInt(value, 10) <= 365, "Use at most 365d");
export const ttlMs = (ttl: string): number => Number.parseInt(ttl, 10) * 86_400_000;
/** User-authored opt-in: recorded check results for a subject may stand in for the rule body until they expire. */
export const verificationSchema = z.object({ subject: z.enum(verificationSubjects), ttl: ttlSchema.default("30d"), recheckOn: strings.default([]) }).strict();
export const ruleSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]), id: ruleIdSchema, title: z.string().trim().min(1).max(200),
  severity: z.enum(["must", "should", "prefer"]).default("should"), enabled: z.boolean().default(true), core: z.boolean().default(false),
  applies: z.object({ markers: strings.default([]), platforms: z.array(z.enum(["win32", "darwin", "linux"])).default([]), shells: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/, "Use a shell name such as powershell, bash, or cmd")).max(32).default([]) }).strict().default({}),
  triggers: z.object({ actions: z.array(z.enum(ruleActions)).default([]), paths: strings.default([]), keywords: strings.default([]) }).strict().default({}),
  verification: verificationSchema.optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(), body: z.string().min(1)
}).strict();
export type Rule = z.infer<typeof ruleSchema>;
export type RuleInput = z.input<typeof ruleSchema>;
export type ParsedRule = { ok: true; rule: Rule } | { ok: false; file: string; error: string };

function unComment(line: string): string {
  let quote = "", escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && ch === "\\") { escaped = true; continue; }
    if (quote) { if (ch === quote) { if (quote === "'" && line[i + 1] === "'") { i++; continue; } quote = ""; } }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i).trimEnd();
  }
  if (quote) throw new Error("Unterminated quoted value");
  return line.trimEnd();
}
function scalar(raw: string): unknown {
  const value = raw.trim();
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) throw new Error("Invalid single-quoted value");
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) throw new Error("Inline list must end with ]");
    const inner = value.slice(1, -1); if (!inner.trim()) return [];
    const parts: string[] = []; let quote = "", start = 0, escape = false;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]!;
      if (escape) { escape = false; continue; }
      if (quote === '"' && ch === "\\") { escape = true; continue; }
      if (quote) { if (ch === quote) { if (quote === "'" && inner[i + 1] === "'") { i++; continue; } quote = ""; } }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ",") { parts.push(inner.slice(start, i)); start = i + 1; }
    }
    parts.push(inner.slice(start));
    return parts.map(part => { const result = scalar(part); if (typeof result !== "string") throw new Error("List entries must be strings"); return result; });
  }
  if (!value || /^[!&*{|>\]}]/.test(value) || value.includes(": ")) throw new Error("Unsupported YAML value; quote scalars and use inline lists");
  if (value === "true" || value === "false") return value === "true";
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
export function validateRule(input: unknown): Rule {
  const rule = ruleSchema.parse(input);
  // Version 2 exists only to carry verification, so older clients reject what they cannot honor.
  if ((rule.schemaVersion === 2) !== Boolean(rule.verification)) throw new Error("schemaVersion 2 is required for, and only allowed with, verification");
  const containsControl = (value: unknown): boolean => typeof value === "string" ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) : value !== null && typeof value === "object" && Object.values(value).some(containsControl);
  if (containsControl(rule)) throw new Error("Unsupported control character in rule");
  if (Buffer.byteLength(rule.body) > RULE_BODY_BYTES) throw new Error("Rule body exceeds 4 KiB");
  if (redactSensitiveText(JSON.stringify(rule)).redactions.length) throw new Error("Rule contains a recognized secret; store its location instead");
  for (const marker of rule.applies.markers) if (marker.includes("\\") || marker.startsWith("/") || marker.split("/").some(p => !p || p === ".." || p === ".") || marker.includes(":")) throw new Error("Markers must be project-relative paths");
  return rule;
}
export function parseRuleFile(bytes: Buffer | string, filename: string): ParsedRule {
  try {
    if ((typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.length) > RULE_FILE_BYTES) throw new Error("Rule file exceeds 16 KiB");
    const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (redactSensitiveText(text).redactions.length) throw new Error("Rule contains a recognized secret; store its location instead");
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
    if (!match) throw new Error("Expected --- frontmatter followed by a Markdown body");
    const values: Record<string, unknown> = Object.create(null); let nested: Record<string, unknown> | undefined;
    for (const original of match[1]!.split(/\r?\n/)) {
      const line = unComment(original); if (!line.trim()) continue;
      const field = /^( {0}| {2})([A-Za-z][A-Za-z0-9]*):(?:\s+(.*))?$/.exec(line);
      if (!field) throw new Error("Use key: value entries with two spaces for nested fields");
      const [, indent, key, raw] = field; const target = indent ? nested : values;
      if (!target) throw new Error("Nested fields require applies:, triggers:, or verification:");
      if (Object.hasOwn(target, key!)) throw new Error(`Duplicate field: ${key}`);
      if (!indent && (key === "applies" || key === "triggers" || key === "verification") && raw === undefined) { nested = Object.create(null) as Record<string, unknown>; values[key] = nested; }
      else { target[key!] = scalar(raw ?? ""); if (!indent) nested = undefined; }
    }
    const id = ruleIdSchema.parse(filename.replace(/\.md$/, ""));
    if (values.id !== undefined && values.id !== id) throw new Error("Rule id must match its filename");
    return { ok: true, rule: validateRule({ ...values, id, body: match[2]! }) };
  } catch (error) { return { ok: false, file: filename, error: error instanceof z.ZodError ? error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") : error instanceof Error ? error.message : "Invalid rule" }; }
}
export function serializeRule(input: RuleInput): string {
  const r = validateRule({ ...input, schemaVersion: input.verification ? 2 : 1 }), q = JSON.stringify;
  const text = ["---", `schemaVersion: ${r.schemaVersion}`, `id: ${r.id}`, `title: ${q(r.title)}`, `severity: ${r.severity}`, `enabled: ${r.enabled}`, `core: ${r.core}`, "applies:",
    ...Object.entries(r.applies).map(([k, v]) => `  ${k}: ${q(v)}`), "triggers:", ...Object.entries(r.triggers).map(([k, v]) => `  ${k}: ${q(v)}`),
    ...(r.verification ? ["verification:", ...Object.entries(r.verification).map(([k, v]) => `  ${k}: ${q(v)}`)] : []),
    ...(r.updatedAt ? [`updatedAt: ${r.updatedAt}`] : []), "---", r.body].join("\n");
  if (Buffer.byteLength(text) > RULE_FILE_BYTES) throw new Error("Rule file exceeds 16 KiB");
  return text;
}
