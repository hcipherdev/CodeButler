import type { MemoryPresentation, MemoryScope, MemorySearchResult, MemoryStatementFields, MemoryType } from "../types.js";
import { parseLayer } from "./layer.js";
import { assessClaim, resolveStatement } from "./statement.js";
const slots: Record<MemoryType, Array<[
    keyof MemoryStatementFields,
    string
]>> = {
    decision: [["choice", "We chose"], ["rationale", "Because"], ["alternatives", "Instead of"]],
    constraint: [["requirement", "Requirement"], ["appliesWhen", "Applies when"], ["rationale", "Why"]],
    bug_fix: [["symptom", "Symptom"], ["cause", "Cause"], ["fix", "Fix"]],
    rejected_approach: [["tried", "Tried"], ["droppedBecause", "Dropped because"], ["revisitIf", "Revisit if"]]
};
export function sharingLabel(layer?: string, peer = false): string {
    const parsed = parseLayer(layer);
    if (parsed.kind === "core")
        return "Whole project";
    if (parsed.kind === "device")
        return peer ? "Another device" : "This device";
    return `${parsed.branch}${parsed.deviceId ? peer ? " · another device" : " · this device" : " · branch memory"}`;
}
export function applicabilityLabel(scope?: MemoryScope): string {
    if (!scope || scope.kind === "unspecified")
        return "Applicability not established";
    if (scope.kind === "project")
        return "Project-wide";
    const platforms: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };
    return [scope.platforms?.map(p => platforms[p] ?? p).join(", "), scope.architectures?.join(", "),
        scope.shells?.join(", "), scope.condition].filter(Boolean).join(" · ") || "Conditional";
}
export function presentMemory(memory: MemorySearchResult, peer = false): MemoryPresentation {
    const statement = resolveStatement(memory);
    const ordered = slots[memory.type];
    return {
        headline: memory.title, text: statement.text,
        slots: ordered.flatMap(([key, label]) => statement.fields[key] ? [{ label, value: statement.fields[key]! }] : []),
        missing: ordered.filter(([key]) => !statement.fields[key]).map(([, label]) => `${label} not recorded`),
        sharing: sharingLabel(memory.layer, peer), applies: applicabilityLabel(memory.scope),
        state: memory.kind === "candidate" ? "Candidate" : memory.lifecycleStatus === "superseded" ? "Replaced" :
            memory.lifecycleStatus === "retracted" ? "Withdrawn" : "Current",
        verified: (memory.displayStatus ?? memory.trust?.displayStatus) === "human_verified",
        claim: assessClaim(memory), derived: statement.derived
    };
}
const escapeMarkdown = (text: string) => text.replace(/[\\`*_[\]<>]/g, "\\$&").replace(/\s*\r?\n\s*/g, " ");
export function presentMemoryMarkdown(p: MemoryPresentation, options: {
    link?: string;
    label?: string;
} = {}): string {
    const details = p.slots.filter(s => s.value !== p.text).map(s => `${s.label.toLowerCase()}: ${escapeMarkdown(s.value)}`);
    const applies = p.applies === "Project-wide" ? "" : ` — applies when: ${escapeMarkdown(p.applies)}`;
    const link = options.link ? ` ([${escapeMarkdown(options.label ?? "View memory")}](${options.link}))` : "";
    return `- ${escapeMarkdown(p.text)}${details.length ? ` (${details.join("; ")})` : ""}${applies}${link}`;
}
