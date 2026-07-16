import type { PrivacyConfig, RedactionPatternConfig } from "../types.js";
import {
  redactSensitiveText,
  type RedactionMatch,
  type RedactionResult
} from "./redaction.js";

export interface CompiledRedactionRule {
  readonly name: string;
  readonly source: string;
  readonly flags: string;
}

export interface RedactionPolicy {
  rules: readonly CompiledRedactionRule[];
}

const SUPPORTED_FLAGS = new Set(["g", "i", "m", "s", "u"]);
const MAX_PATTERN_LENGTH = 512;
const SAFE_RULE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const REDACTION_MARKER = /\[REDACTED:[A-Z_]+\]/g;

export function createRedactionPolicy(config: PrivacyConfig): RedactionPolicy {
  const rules = Object.freeze((config.redactionPatterns ?? []).map((rule, index) => Object.freeze(compileRule(rule, index))));
  return Object.freeze({ rules });
}

export function redactWithPolicy(input: string, policy: RedactionPolicy): RedactionResult {
  const builtIn = redactSensitiveText(input);
  const redactions: RedactionMatch[] = [...builtIn.redactions];
  let text = builtIn.text;
  for (const rule of policy.rules) {
    text = replaceOutsideMarkers(text, rule, redactions);
  }
  return { text, redactions };
}

function replaceOutsideMarkers(text: string, rule: CompiledRedactionRule, redactions: RedactionMatch[]): string {
  let cursor = 0;
  let result = "";
  REDACTION_MARKER.lastIndex = 0;
  for (const marker of text.matchAll(REDACTION_MARKER)) {
    const index = marker.index;
    result += replaceSegment(text.slice(cursor, index), rule, redactions);
    result += marker[0];
    cursor = index + marker[0].length;
  }
  return result + replaceSegment(text.slice(cursor), rule, redactions);
}

function replaceSegment(segment: string, rule: CompiledRedactionRule, redactions: RedactionMatch[]): string {
  return segment.replace(new RegExp(rule.source, rule.flags), () => {
    redactions.push({ type: "configured_pattern", ruleName: rule.name });
    return "[REDACTED:PROJECT_PATTERN]";
  });
}

export function validateRedactionPattern(input: RedactionPatternConfig, index: number): void {
  const prefix = `privacy.redactionPatterns[${index}]`;
  if (typeof input.name !== "string" || !SAFE_RULE_NAME.test(input.name.trim())) {
    throw new Error(`${prefix}.name must use safe characters and be at most 64 characters`);
  }
  if (typeof input.pattern !== "string" || input.pattern.length === 0 || input.pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`${prefix}.pattern must be a nonempty string of at most ${MAX_PATTERN_LENGTH} characters`);
  }
  if (input.kind !== "literal" && input.kind !== "regex") {
    throw new Error(`${prefix}.kind must be literal or regex`);
  }
  if (input.kind === "literal" && input.flags !== undefined) {
    throw new Error(`${prefix}.flags are only valid for regex rules`);
  }
  if (input.flags !== undefined) {
    if (typeof input.flags !== "string" || [...input.flags].some((flag) => !SUPPORTED_FLAGS.has(flag))) {
      throw new Error(`${prefix}.flags contains unsupported flags`);
    }
    if (new Set(input.flags).size !== input.flags.length) {
      throw new Error(`${prefix}.flags contains duplicate flags`);
    }
  }
  if (input.kind !== "literal") {
    if (/\(\?(?:[=!]|<[=!])|\\[1-9]|\\k</.test(input.pattern)) {
      throw new Error(`${prefix}.pattern uses unsupported lookaround or backreferences`);
    }
    if (/\([^)]*(?:\*|\+|\{\d*,?\d*\})[^)]*\)(?:\*|\+|\{)/.test(input.pattern)) {
      throw new Error(`${prefix}.pattern contains unsafe nested repetition`);
    }
    if (hasQuantifiedGroup(input.pattern)) {
      throw new Error(`${prefix}.pattern contains unsafe quantified groups`);
    }
    if (countUnboundedRepetitions(input.pattern) > 1) {
      throw new Error(`${prefix}.pattern contains repeated unbounded repetition`);
    }
    try {
      const expression = new RegExp(input.pattern, normalizeFlags(input.flags));
      if (expression.test("")) throw new Error("empty-match");
    } catch {
      try {
        const expression = new RegExp(input.pattern, normalizeFlags(input.flags));
        if (expression.test("")) throw new Error(`${prefix}.pattern must not match empty text`);
      } catch (error) {
        if (error instanceof Error && error.message === `${prefix}.pattern must not match empty text`) throw error;
      }
      throw new Error(`${prefix}.pattern must be a valid regular expression`);
    }
  }
}

function hasQuantifiedGroup(pattern: string): boolean {
  let inCharacterClass = false;
  let previousWasGroupClose = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\") {
      index += 1;
      previousWasGroupClose = false;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      previousWasGroupClose = false;
      continue;
    }
    if (character === "]" && inCharacterClass) {
      inCharacterClass = false;
      previousWasGroupClose = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (previousWasGroupClose && (character === "*" || character === "+" || character === "{")) return true;
    previousWasGroupClose = character === ")";
  }
  return false;
}

function countUnboundedRepetitions(pattern: string): number {
  let count = 0;
  let inCharacterClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      continue;
    }
    if (character === "]" && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (character === "*" || character === "+") {
      count += 1;
      continue;
    }
    if (character !== "{") continue;
    const close = pattern.indexOf("}", index + 1);
    if (close < 0) continue;
    const range = pattern.slice(index + 1, close);
    if (/^\d+,\s*$/.test(range)) count += 1;
    index = close;
  }
  return count;
}

function compileRule(input: RedactionPatternConfig, index: number): CompiledRedactionRule {
  validateRedactionPattern(input, index);
  const source = input.kind === "literal" ? escapeRegExp(input.pattern) : input.pattern;
  return {
    name: input.name.trim(),
    source,
    flags: normalizeFlags(input.flags)
  };
}

function normalizeFlags(flags = ""): string {
  return flags.includes("g") ? flags : `${flags}g`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
