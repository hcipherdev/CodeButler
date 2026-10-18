import type { MemoryStore } from "../storage/store.js";
import type { MemorySearchResult } from "../types.js";
import { assessClaim } from "../memory/statement.js";
import { presentMemory, presentMemoryMarkdown } from "../memory/presentation.js";
export function selectSummaryMemories(store: MemoryStore): MemorySearchResult[] {
    const ids = store.listMemories({ layer: "core", lifecycleStatus: "current", qualityStatus: "active", limit: null })
        .filter(memory => (memory.type === "decision" || memory.type === "constraint") && assessClaim(memory) === "meaningful")
        .map(memory => memory.id);
    return store.readMemorySearchResultsByIds(ids, { lifecycleStatus: "current" })
        .sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}
export function renderMemorySections(memories: MemorySearchResult[]): {
    decisions: string;
    constraints: string;
} {
    const render = (type: string) => memories.filter(m => m.type === type && m.kind === "promoted" &&
        m.layer === "core" && m.lifecycleStatus === "current" && m.qualityStatus === "active" && assessClaim(m) === "meaningful")
        .map(m => presentMemoryMarkdown(presentMemory(m), { link: "memory:" + encodeURIComponent(m.id), label: m.id })).join("\n");
    return { decisions: render("decision") || "No current project decisions have been recorded.",
        constraints: render("constraint") || "No current project constraints have been recorded." };
}
const headings = ["What this is", "How it's built", "Where things stand", "Open risks and questions", "How to verify changes"] as const;
const aliases: Record<string, string> = {
    "project purpose": "What this is", "purpose": "What this is",
    "architecture": "How it's built", "current status": "Where things stand",
    "known risks": "Open risks and questions", "verification commands": "How to verify changes"
};
/** Accept older provider documents while owning all memory-backed sections ourselves. */
export function assembleHumanSummary(memories: MemorySearchResult[], markdown: string): string {
    const sections = new Map<string, string[]>();
    let heading: string | undefined;
    let sawHeading = false;
    const intro: string[] = [];
    for (const line of markdown.trim().split(/\r?\n/)) {
        const match = line.match(/^#{1,2}\s+(.+?)\s*$/);
        if (match) {
            sawHeading = true;
            const normalized = match[1]!.toLowerCase();
            heading = headings.find(h => h.toLowerCase() === normalized) ?? aliases[normalized];
            if (heading && !sections.has(heading))
                sections.set(heading, []);
            continue;
        }
        if (heading)
            sections.get(heading)!.push(line);
        else if (!sawHeading)
            intro.push(line);
    }
    const knowledge = renderMemorySections(memories);
    const content = (key: string, fallback: string) => sections.get(key)?.join("\n").trim() || fallback;
    return [
        "# Project summary", "",
        "## What this is", content("What this is", intro.join("\n").trim() || "Project knowledge collected from the repository and recorded memories."), "",
        "## How it's built", content("How it's built", "Architecture details have not been recorded yet."), "",
        "## Where things stand", content("Where things stand", "Current project status has not been recorded yet."), "",
        "## Key decisions", knowledge.decisions, "",
        "## Project constraints", knowledge.constraints, "",
        "## Open risks and questions", content("Open risks and questions", "No open risks or questions have been recorded."), "",
        "## How to verify changes", content("How to verify changes", "Use the project's documented build and test commands.")
    ].join("\n");
}
