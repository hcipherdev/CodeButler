import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildRulesCatalog, getApplicableRules, GLOBAL_RULES_INSTRUCTIONS } from "../rules/match.js";
import { recordAttestation, type RecordAttestationInput } from "../rules/attestations.js";
import { startCloudScheduler, type cloudSync } from "../cloud/client.js";
import { registerProjectMemoryHandlers, readCurrentProjectInfo, type ProjectMemoryToolHandlers } from "../mcp/tools.js";
import { readProjectSetupStatus } from "../project-setup.js";
import { openConfiguredMemoryStore } from "../storage/open-configured-store.js";
import type { MemoryStore } from "../storage/store.js";
import type { ProjectMemoryServer, ProjectMemoryServerOptions } from "../server.js";
import { readAgentContext } from "../project-summary/agent-guidance.js";
import { readProjectBrief } from "../project-summary/service.js";
import { readPublishedSummary, readPublishedHealth, closeRetrievalReaders, withPublishedIndex } from "./index.js";
import { callCanonicalTool, requestRetrievalRefresh, scheduleRetrieval, stopRetrievalWorkers } from "./worker.js";
import { loadProjectConfig } from "../config.js";
import { findPublishedMemories, searchPublishedMemory } from "./search.js";
import { memoryHistory, memoryMovement, type KnowledgeSnapshot } from "../memory/events.js";
import { readHandbook, readHandbookTopic } from "../memory/topics.js";
export async function createPublishedMemoryServer(root: string, options: ProjectMemoryServerOptions): Promise<ProjectMemoryServer> {
    (await import("../rules/identity.js")).assertOrdinaryProject(root);
    const server = new McpServer({ name: "project-memory", version: "1.0.0" }, { instructions: GLOBAL_RULES_INSTRUCTIONS });
    let closing = false;
    let inspectionStore: MemoryStore | undefined;
    const pending = new Set<Promise<unknown>>();
    let enrichmentTimer: NodeJS.Timeout | undefined;
    const enrich = () => {
        if (closing || readProjectSetupStatus(root).summaryQuality !== "local") return;
        const enrichment = callCanonicalTool(root, "__enrich_project_summary", {});
        pending.add(enrichment);
        void enrichment.catch(error => {
            if (!closing) console.error(`Code Butler summary enrichment failed: ${error instanceof Error ? error.message : String(error)}`);
        }).finally(() => pending.delete(enrichment));
    };
    const call = async (name: string, input: Record<string, unknown> = {}) => {
        if (closing)
            throw new Error("MCP server is shutting down");
        if (name === "current_project") return readCurrentProjectInfo(root, options.startupMetadata);
        if (name === "get_applicable_rules") return getApplicableRules(root, input);
        if (name === "record_rule_attestation") return recordAttestation(input as RecordAttestationInput, { by: "agent", projectRoot: root });
        if (name === "summarize_project_brief")
            return { ...readProjectBrief(root), ...readAgentContext(root), setup: readProjectSetupStatus(root), globalRules: buildRulesCatalog(root) };
        scheduleRetrieval(root);
        if(["get_memory_history","read_project_handbook","summarize_memory_movement"].includes(name))return withPublishedIndex(root,(db,p)=>{
            if(p.format!==3)throw new Error("Memory index is preparing; retry shortly");
            const row=db.prepare("select payload from memory_knowledge where id=1").get() as {payload:string}|undefined;
            if(!row)throw new Error("Memory index is preparing; retry shortly");
            const data=JSON.parse(row.payload) as KnowledgeSnapshot;
            if(name==="get_memory_history")return memoryHistory(data,String(input.id),String(input.category),input);
            if(name==="summarize_memory_movement")return memoryMovement(data,input);
            const filter={...input,reach:(input.reach??"project") as "project"};
            return input.topicId?readHandbookTopic(data,String(input.topicId),filter,input.offset as number|undefined,input.limit as number|undefined):readHandbook(data,filter);
        });
        // Agents phrase queries as loose keywords; the desktop keeps exact-phrase filtering.
        if (name === "find_memories")
            return findPublishedMemories(root, { ...input, match: "terms" });
        if (name === "search_project_memory")
            return searchPublishedMemory(root, { ...input as { query: string }, match: "terms" });
        if (name === "summarize_project_state") {
            const page = readPublishedSummary(root);
            return { ...page.summary, freshness: page.freshness };
        }
        if (name === "summarize_memory_health")
            return withPublishedIndex(root, () => ({ ...readPublishedHealth(root) as object, freshness: readPublishedSummary(root).freshness }));
        const result = await callCanonicalTool(root, name, input, server.server.getClientVersion());
        if (name === "sync_project_memory" || /^(remember_|update_|resolve_|apply_|revert_|delete_|prune_|refresh_)/.test(name))
            await requestRetrievalRefresh(root, true);
        return result;
    };
    const handlers = new Proxy({} as ProjectMemoryToolHandlers, { get(_target, name) {
            return (input: Record<string, unknown>) => {
                const operation = call(String(name), input);
                pending.add(operation);
                void operation.finally(() => pending.delete(operation)).catch(() => { });
                return operation;
            };
        } });
    registerProjectMemoryHandlers(server, handlers);
    const startup = async () => {
        if (options.autoInit !== false) {
            try {
                await callCanonicalTool(root, "__project_setup", {});
                console.error(`Code Butler project setup ${readProjectSetupStatus(root).status}: ${root}`);
            } catch (error) { console.error(`Code Butler project setup failed: ${error instanceof Error ? error.message : String(error)}`); }
        }
        if (closing) return;
        try { await requestRetrievalRefresh(root, true, loadProjectConfig(root).sync.autoSyncOnServerStart); }
        finally {
            if (!closing && options.autoInit !== false && readProjectSetupStatus(root).status === "ready") {
                enrich();
                if (!enrichmentTimer) { enrichmentTimer = setInterval(enrich, 60_000); enrichmentTimer.unref(); }
            }
        }
    };
    if (!options.deferStartupSync) await startup();
    return { server, cloudManaged: true,
        // Legacy programmatic inspection is explicit; normal MCP reads never access this getter.
        get store() { if (!inspectionStore) {
            inspectionStore = openConfiguredMemoryStore(root);
            inspectionStore.init();
        } return inspectionStore; },
        ...(options.deferStartupSync ? { startupSync: () => {
            const operation = startup(); pending.add(operation);
            void operation.finally(() => pending.delete(operation)).catch(() => {});
            return operation;
        } } : {}),
        drain: async () => { closing = true; clearInterval(enrichmentTimer); await stopRetrievalWorkers(); await Promise.allSettled([...pending]); inspectionStore?.close(); closeRetrievalReaders(root); },
        stopCloud: startCloudScheduler(root, console.error, {
            ...options.cloudSchedulerOptions,
            sync: options.cloudSchedulerOptions?.sync ?? (async (project) => await callCanonicalTool(project, "__cloud_sync", {}) as Awaited<ReturnType<typeof cloudSync>>)
        })
    };
}
