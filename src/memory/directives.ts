import type { MemoryType } from "../types.js";

export interface ParsedMemoryDirective {
  type: MemoryType;
  text: string;
  typed: boolean;
}

const TYPE_LABEL_PATTERN = [
  "decision",
  "constraint",
  "constrain",
  "bug\\s*fix",
  "rejected\\s+approach",
  "project\\s+rule",
  "rule",
  "requirement"
].join("|");

const MEMORY_DESTINATION_PATTERN = String.raw`(?:\s+(?:in|to|for)\s+(?:the\s+)?(?:code\s+butler\s+)?(?:project\s+)?memory)?`;

const DIRECTIVE_PATTERNS = [
  new RegExp(
    String.raw`^(?:please\s+)?(?:remember|save|note)\s+(?:this(?:\s+|(?=\s*:)))?as\s+(?:a\s+|an\s+)?(?<type>${TYPE_LABEL_PATTERN})\s*:\s*(?<text>.+)$`,
    "i"
  ),
  new RegExp(
    String.raw`^(?:please\s+)?(?:remember|save|note)\s+(?:this(?:\s+|(?=\s*:)))?(?<type>${TYPE_LABEL_PATTERN})?${MEMORY_DESTINATION_PATTERN}\s*:\s*(?<text>.+)$`,
    "i"
  )
];

export function parseMemoryDirective(line: string): ParsedMemoryDirective | undefined {
  const normalized = stripSpeakerPrefix(line).trim();
  if (!normalized || startsAsQuote(normalized)) return undefined;

  for (const pattern of DIRECTIVE_PATTERNS) {
    const match = normalized.match(pattern);
    const text = match?.groups?.text;
    if (!text) continue;
    const typeLabel = normalizeTypeLabel(match.groups?.type);
    return {
      type: directiveType(typeLabel),
      text: cleanMemoryText(text),
      typed: typeLabel !== undefined
    };
  }

  return undefined;
}

export function cleanMemoryText(value: string): string {
  return value.trim().replace(/^["'`]+|["'`]+$/g, "");
}

export function titleFromMemoryText(value: string): string {
  const firstLine = cleanMemoryText(value).split(/\r?\n/)[0] ?? "";
  const firstSentence = firstLine.split(/(?<=[.!?])\s+/)[0] ?? firstLine;
  const trimmed = firstSentence.replace(/[.!?:;]+$/g, "").trim();
  const title = trimmed.length > 90 ? `${trimmed.slice(0, 87).trim()}...` : trimmed;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export function slugMemoryText(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "memory"
  );
}

function stripSpeakerPrefix(line: string): string {
  return line.replace(/^(?:user|human):\s*/i, "");
}

function startsAsQuote(value: string): boolean {
  return /^[>"'`]/.test(value);
}

function normalizeTypeLabel(label: string | undefined): string | undefined {
  return label?.toLowerCase().replace(/\s+/g, " ").trim();
}

function directiveType(label: string | undefined): MemoryType {
  if (label === "decision") return "decision";
  if (label === "bug fix") return "bug_fix";
  if (label === "rejected approach") return "rejected_approach";
  if (label === "constraint" || label === "constrain" || label === "project rule" || label === "rule" || label === "requirement") {
    return "constraint";
  }
  return "constraint";
}
