import type { MemoryStore } from "../storage/store.js";
import type { MemoryType, MemoryStatementFields } from "../types.js";
import { rememberProjectMemory } from "./remember.js";
import { deviceLayer, parseLayer } from "./layer.js";
import { isPeerLayer } from "./peer-layer.js";
import { normalizeScope } from "./scope.js";
export interface WorkingCandidateInput {
    id: string;
    type: MemoryType;
    text: string;
    title?: string;
    reason?: string;
    fields?: MemoryStatementFields;
    destination: "project" | "device" | "branch";
}
/** Conversion leaves working context intact and records source lineage on its manual source. */
export function createWorkingCandidate(store: MemoryStore, input: WorkingCandidateInput, now = new Date().toISOString()) {
    const memory = store.readTemporaryMemory(input.id);
    if (!memory || memory.expiresAt <= now)
        throw new Error("Working context has expired or is unavailable");
    if (isPeerLayer(store, memory.layer))
        throw new Error("Another device's working context is read-only");
    const current = parseLayer(memory.layer);
    const layer = input.destination === "project" ? "core" : input.destination === "device" ? deviceLayer() :
        current.kind === "branch" ? memory.layer! : undefined;
    if (!layer)
        throw new Error("This working context has no branch destination; choose project or device");
    const result = rememberProjectMemory(store, {
        type: input.type, text: input.text, ...(input.title ? { title: input.title } : {}),
        reason: input.reason ?? "Kept from working context for candidate review.", relatedFiles: memory.relatedFiles,
        scope: normalizeScope(memory.scope), layer, promote: false, statement: { fields: input.fields }
    }, { actor: "desktop", now: () => new Date(now), identitySalt: "working:" + memory.id, sourceEvidence: memory.evidence, sourceTemporaryId: memory.id });
    return { ...result, workingMemoryId: memory.id };
}
