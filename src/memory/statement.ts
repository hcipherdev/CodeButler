import { z } from "zod";
import type { MemoryStatement, MemoryStatementFields, MemoryType } from "../types.js";
const field = z.string().trim().max(20000).optional();
export const memoryStatementFieldsSchema = z.object({
    choice: field, rationale: field, alternatives: field, requirement: field, appliesWhen: field,
    symptom: field, cause: field, fix: field, tried: field, droppedBecause: field, revisitIf: field
}).strict();
export const memoryStatementInputSchema = z.object({ fields: memoryStatementFieldsSchema.optional() }).strict();
export const memoryStatementSchema = z.object({
    version: z.literal(1), text: z.string().trim().min(1).max(20000),
    fields: memoryStatementFieldsSchema,
    origin: z.enum(["human", "submitted", "deterministic", "extracted", "ai_wording_accepted"])
}).strict();
export const statementFieldsByType: Record<MemoryType, Array<keyof MemoryStatementFields>> = {
    decision: ["choice", "rationale", "alternatives"],
    constraint: ["requirement", "appliesWhen", "rationale"],
    bug_fix: ["symptom", "cause", "fix"],
    rejected_approach: ["tried", "droppedBecause", "revisitIf"]
};
export function createStatement(text: string, type: MemoryType, origin: MemoryStatement["origin"], fields: MemoryStatementFields = {}): MemoryStatement {
    const normalized: MemoryStatementFields = {};
    for (const key of statementFieldsByType[type]) {
        const value = fields[key];
        if (typeof value === "string" && value.trim())
            normalized[key] = value.trim();
    }
    return memoryStatementSchema.parse({ version: 1, text: text.trim(), fields: normalized, origin });
}
/** Unknown extractor slots are omitted; author identity is assigned by the caller. */
export function parseStatement(value: unknown, type: MemoryType, origin?: MemoryStatement["origin"]): MemoryStatement | undefined {
    if (typeof value === "string") {
        try {
            return parseStatement(JSON.parse(value), type, origin);
        }
        catch {
            return undefined;
        }
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || typeof record.text !== "string" || !record.text.trim())
        return undefined;
    const fields = record.fields && typeof record.fields === "object" && !Array.isArray(record.fields)
        ? record.fields as MemoryStatementFields : {};
    const authored = origin ?? record.origin;
    if (!["human", "submitted", "deterministic", "extracted", "ai_wording_accepted"].includes(String(authored)))
        return undefined;
    try {
        return createStatement(record.text, type, authored as MemoryStatement["origin"], fields);
    }
    catch {
        return undefined;
    }
}
type Claim = {
    type: MemoryType;
    summary: string;
    statement?: MemoryStatement | undefined;
    dedupeKey?: string | undefined;
};
export function claimText(memory: Pick<Claim, "summary" | "statement">): string {
    return memory.statement?.text ?? memory.summary;
}
export function resolveStatement(memory: Claim): MemoryStatement & {
    derived: boolean;
} {
    if (memory.statement)
        return { ...memory.statement, derived: false };
    return { version: 1, text: memory.summary, fields: {}, origin: "deterministic", derived: true };
}
/** Detect known extraction placeholders, not missing rationale or short valid requirements. */
export function assessClaim(memory: Claim): "meaningful" | "missing_claim" {
    const text = claimText(memory).trim();
    // "Documentation includes <heading>." is the retired docs extractor's shape; a longer
    // statement that merely starts with those words is a real claim.
    const docsPlaceholder = /^Documentation includes\b/i.test(text) &&
        (memory.dedupeKey?.startsWith("deterministic:docs:") || !/[.!?]\s+\S/.test(text));
    return !text || docsPlaceholder || /^Captured from\b/i.test(text) ||
        /^Test expectation:\s*(?:test\d*|[\w./\\-]+\.(?:test|spec)\.[\w]+)\.?$/i.test(text)
        ? "missing_claim" : "meaningful";
}
/** One builder serves embedding enqueueing, validation, and statement-aware search. */
export function memoryContentText(memory: {
    title: string;
    summary: string;
    reason: string;
    statement?: MemoryStatement | undefined;
}): string {
    return [memory.title, claimText(memory), memory.reason,
        ...Object.values(memory.statement?.fields ?? {})].filter(Boolean).join("\n\n");
}
export const STATEMENT_EXTRACTION_GUIDANCE = " You may include statement:{version:1,text,fields,origin:'extracted'}. Its text is the same plain-language claim as summary. " +
    "Include only fields explicitly supported by the evidence: decisions choice/rationale/alternatives; " +
    "constraints requirement/appliesWhen/rationale; bug fixes symptom/cause/fix (symptom and fix are required for a bug fix); rejected approaches tried/droppedBecause/revisitIf. " +
    "Omit unstated fields; extraction provenance is not the project's rationale. Never broaden applicability or change modality.";
