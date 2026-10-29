import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { stateDirectory } from "../cloud/state.js";
import { loadProjectConfig } from "../config.js";
import { MEMORY_QUALITY_POLICY_VERSION } from "../memory/quality-cache.js";
export function retrievalEnabled(): boolean { return process.env.CODE_BUTLER_RETRIEVAL_ENGINE === "published"; }
export function retrievalPaths(root: string) {
    const directory = process.env.VITEST ? join(root, ".code-butler", "retrieval") : join(stateDirectory(root), "retrieval");
    let file = "index.sqlite";
    try {
        const current = readFileSync(join(directory, "active"), "utf8");
        if (/^index-[a-f0-9-]+\.sqlite$/.test(current))
            file = current;
    }
    catch { /* First publication. */ }
    return { directory, database: join(directory, file), epoch: join(directory, "epoch"), status: join(directory, "status.json") };
}
export function activateRetrieval(root: string, file: string): void {
    if (!/^index-[a-f0-9-]+\.sqlite$/.test(file))
        throw new Error("Invalid index filename");
    const directory = retrievalPaths(root).directory;
    const temporary = join(directory, `active-${randomUUID()}`);
    writeFileSync(temporary, file);
    renameSync(temporary, join(directory, "active"));
}
export function retrievalEpoch(root: string): string {
    const path = retrievalPaths(root).epoch;
    return existsSync(path) ? readFileSync(path, "utf8") : "initial";
}
export function revokeRetrieval(root: string): void {
    const paths = retrievalPaths(root);
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.epoch, randomUUID(), { mode: 0o600 });
}
/** Bump when published index contents change shape, forcing one full republication. 2: generated-only commits leave raw search. */
export const RETRIEVAL_INDEX_VERSION = 2;
export function retrievalPolicy(root: string, qualityVersion = MEMORY_QUALITY_POLICY_VERSION, indexVersion = RETRIEVAL_INDEX_VERSION): string {
    const config = loadProjectConfig(root);
    // Version 1 predates the index version and hashed only quality and privacy.
    const parts = indexVersion === 1 ? [qualityVersion, config.privacy] : [qualityVersion, config.privacy, indexVersion];
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
export function retrievalPrivacyPolicy(root: string): string { return createHash("sha256").update(JSON.stringify(loadProjectConfig(root).privacy)).digest("hex"); }
